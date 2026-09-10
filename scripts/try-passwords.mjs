#!/usr/bin/env node
/**
 * Brute-force a candidate list of likely typos against the user's
 * backup bundle WITHOUT touching the server's failedAttempts counter.
 * This script downloads the bundle ONCE, then tries each candidate
 * locally. Server only sees one fetch.
 */
import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import argon2 from 'argon2';

const [, , accessToken, msgBaseUrl, ...candidates] = process.argv;
if (!accessToken || !msgBaseUrl || candidates.length === 0) {
  console.error('Usage: node scripts/try-passwords.mjs <token> <msgBase> <pwd1> [pwd2 ...]');
  process.exit(2);
}

const fromB64 = (s) => Buffer.from(s, 'base64');

async function main() {
  const res = await fetch(`${msgBaseUrl}/backup/identity/bundle`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'X-Signal-Device-Id': '1' },
  });
  if (!res.ok) {
    console.error(`Bundle fetch failed: ${res.status}`);
    process.exit(1);
  }
  const bundle = await res.json();
  const salt = fromB64(bundle.salt);
  const wrapped = fromB64(bundle.wrappedMasterKey);
  const params = bundle.kdfParams;

  console.log(`Bundle salt (b64): ${bundle.salt}`);
  console.log(`Bundle salt (hex): ${salt.toString('hex')}`);
  console.log(`Trying ${candidates.length} candidates...`);

  for (const pwd of candidates) {
    process.stdout.write(`  ${JSON.stringify(pwd).padEnd(20)} ... `);
    const derived = await argon2.hash(pwd, {
      type: argon2.argon2id,
      memoryCost: params.memoryKib,
      timeCost: params.iterations,
      parallelism: params.parallelism,
      hashLength: params.derivedKeyBytes,
      salt,
      raw: true,
    });
    const aesKey = await webcrypto.subtle.importKey(
      'raw', derived, { name: 'AES-GCM' }, false, ['decrypt'],
    );
    try {
      await webcrypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.subarray(0, 12) },
        aesKey,
        wrapped.subarray(12),
      );
      console.log('MATCH ✓');
      console.log('');
      console.log('========================================');
      console.log(`PASSWORD FOUND: ${JSON.stringify(pwd)}`);
      console.log('========================================');
      return;
    } catch {
      console.log('no');
    }
  }
  console.log('');
  console.log('No candidate matched.');
}

main().catch(e => { console.error(e); process.exit(1); });
