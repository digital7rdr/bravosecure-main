#!/usr/bin/env node
/**
 * verify-backup-password.mjs
 *
 * Given an access token + backup password, fetch the user's identity
 * bundle from the relay and try to unwrap the masterKey using the SAME
 * argon2id KDF + AES-GCM as the client. Definitively answers "is the
 * password right" without forcing the user to burn their 5 server-side
 * lockout attempts on the device.
 *
 * Usage:
 *   BRAVO_ACCESS_TOKEN=<jwt> BRAVO_RELAY_URL=https://relay.example \
 *     node scripts/verify-backup-password.mjs
 *
 *   The backup password is read interactively (masked) so it never lands
 *   in shell history or the process list. The access token and relay base
 *   URL are read from the environment; argv is a documented fallback:
 *   node scripts/verify-backup-password.mjs <accessToken> <msgBaseUrl>
 *
 * If the unwrap succeeds we print the master key length + identity
 * bundle metadata (no sensitive bytes). If it fails the script prints
 * which step failed (HTTP fetch, argon2, or AES-GCM auth) so we know
 * whether to suspect server-side data corruption, KDF version drift,
 * or genuinely wrong password.
 *
 * Requires:
 *   npm i -D argon2  (native argon2 binding for Node)
 */

import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import argon2 from 'argon2';

// Token + relay URL come from the environment so they don't linger in
// shell history or the process list; argv remains a documented fallback.
const accessToken = process.env.BRAVO_ACCESS_TOKEN || process.argv[2];
const MSG_BASE = process.env.BRAVO_RELAY_URL || process.argv[3];
if (!accessToken) {
  console.error('Missing access token. Set BRAVO_ACCESS_TOKEN (preferred) or pass it as the first argument.');
  process.exit(2);
}
if (!MSG_BASE) {
  console.error('Missing relay base URL. Set BRAVO_RELAY_URL (preferred) or pass it as the second argument.');
  process.exit(2);
}

const fromB64 = (s) => Buffer.from(s, 'base64');

// Prompt for a secret on stdin without echoing keystrokes to the terminal.
function promptHidden(query) {
  return new Promise((resolve) => {
    let muted = false;
    const maskedOut = new Writable({
      write(chunk, encoding, cb) {
        if (!muted) { process.stdout.write(chunk, encoding); }
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: maskedOut, terminal: true });
    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // Everything typed after the prompt is rendered is suppressed.
    muted = true;
  });
}

async function main() {
  const password = await promptHidden('Backup password: ');
  if (!password) {
    console.error('No password entered.');
    process.exit(2);
  }

  // 1. Fetch the bundle. The relay's /backup/identity/bundle endpoint
  //    requires the standard JWT auth + the X-Signal-Device-Id header
  //    (Phase-1 single-device → "1").
  console.log('1. Fetching backup bundle from', MSG_BASE);
  const res = await fetch(`${MSG_BASE}/backup/identity/bundle`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Signal-Device-Id': '1',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`   FAIL: ${res.status} ${res.statusText}`);
    console.error(`   Body: ${body}`);
    process.exit(1);
  }
  const bundle = await res.json();
  console.log('   OK — got bundle');
  console.log(`     salt length        : ${fromB64(bundle.salt).length} bytes`);
  console.log(`     wrappedMasterKey   : ${fromB64(bundle.wrappedMasterKey).length} bytes`);
  console.log(`     wrappedIdentity    : ${fromB64(bundle.wrappedIdentityBundle).length} bytes`);
  console.log(`     kdfParams          : ${JSON.stringify(bundle.kdfParams)}`);

  // 2. Run argon2id with the SAME params the client uses. The Node
  //    `argon2` package's `hash` returns an encoded $argon2id$... string
  //    by default; pass `raw: true` to get the bytes directly.
  console.log('2. Deriving key with argon2id');
  const params = bundle.kdfParams;
  const saltBytes = fromB64(bundle.salt);
  const derivedRaw = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: params.memoryKib,
    timeCost: params.iterations,
    parallelism: params.parallelism,
    hashLength: params.derivedKeyBytes,
    salt: saltBytes,
    raw: true,
  });
  console.log(`   OK — derived key (${derivedRaw.length} bytes, contents withheld)`);

  // 3. Import as AES-GCM CryptoKey + try to unwrap the master key.
  //    The wrapped blob is 12-byte IV || GCM ciphertext+16-byte tag.
  console.log('3. Unwrapping master key with AES-GCM');
  const aesKey = await webcrypto.subtle.importKey(
    'raw',
    derivedRaw,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const wrapped = fromB64(bundle.wrappedMasterKey);
  const iv = wrapped.subarray(0, 12);
  const ct = wrapped.subarray(12);
  let masterRaw;
  try {
    const ptBuf = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    masterRaw = new Uint8Array(ptBuf);
  } catch {
    console.error('   FAIL — AES-GCM authentication failed.');
    console.error('     This is what the client surfaces as "wrong password."');
    console.error('     Either the password is wrong OR the bundle was written');
    console.error('     under a different KDF version than the one used here.');
    process.exit(1);
  }
  console.log(`   OK — unwrapped master key (${masterRaw.length} bytes)`);

  // 4. Try the second hop — unwrap the identity bundle with the master
  //    key. This proves the whole chain works end-to-end.
  console.log('4. Unwrapping identity envelope with master key');
  const masterKey = await webcrypto.subtle.importKey(
    'raw',
    masterRaw,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const wrappedId = fromB64(bundle.wrappedIdentityBundle);
  try {
    const idPt = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrappedId.subarray(0, 12) },
      masterKey,
      wrappedId.subarray(12),
    );
    const env = JSON.parse(Buffer.from(idPt).toString('utf8'));
    console.log(`   OK — identity envelope decoded (magic=${env.magic}, v=${env.v})`);
    if (env.identity) {
      console.log(`     registrationId     : ${env.identity.registrationId}`);
      console.log(`     identityKeyPair    : present`);
      console.log(`     signedPreKey       : ${env.identity.signedPreKey ? 'present' : 'MISSING'}`);
      console.log(`     preKeys count      : ${(env.identity.preKeys || []).length}`);
    }
  } catch {
    console.error('   FAIL — master key unwrapped but identity envelope auth failed.');
    console.error('     This would suggest bundle corruption (wrappedIdentity rewritten');
    console.error('     under a different masterKey than wrappedMasterKey was).');
    process.exit(1);
  }

  console.log('');
  console.log('========================================');
  console.log('PASSWORD IS CORRECT.');
  console.log('Bundle round-trip verified end-to-end.');
  console.log('If the device is rejecting it, the bug is client-side.');
  console.log('========================================');
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
