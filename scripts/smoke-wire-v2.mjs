#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Live wire-shape smoke for the Sealed Sender v2 outer ECIES change.
 *
 * Hits the running messenger-service on :3100 with a real outerSealed
 * blob produced by the same crypto code the RN client uses, then pulls
 * it back through the live HTTP API and verifies:
 *
 *   1. POST /envelopes with the new shape is accepted (DTO validates)
 *   2. The stored Redis row contains `outerSealed` and NO sender field
 *   3. GET /envelopes returns `outerSealed` only (no `ciphertext`,
 *      no `senderAddressHint`)
 *   4. The wire blob round-trips through real client unwrap → libsignal
 *      decrypt to recover the original plaintext byte-for-byte
 *   5. POST /envelopes/{id}/ack hard-deletes
 *   6. Empty `outerSealed` is rejected with bad_request
 *   7. Oversized `outerSealed` (above the 700 KB cap) is rejected
 *
 * Auth: mints two test JWTs locally with the shared dev secret. Skips
 * auth-service entirely — the X3DH bundle exchange happens in-process
 * because we control both ends.
 *
 * Run: node /e/tmp/smoke-wire.mjs
 */

import {SignJWT} from 'jose';
import {randomUUID, webcrypto} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  SessionBuilder, SessionCipher, SignalProtocolAddress, KeyHelper,
} from '@privacyresearch/libsignal-protocol-typescript';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';

const MSG_BASE = 'http://127.0.0.1:3100';

function redisGet(key) {
  const out = execFileSync('redis-cli', ['get', key], {encoding: 'utf8'}).trim();
  return out.length === 0 ? null : out;
}
function redisExists(key) {
  return execFileSync('redis-cli', ['exists', key], {encoding: 'utf8'}).trim() === '1';
}

// Match `apps/messenger-service/.env`
const JWT_SECRET   = 'dev-access-secret-do-not-use-in-prod-xxxxxxxxxxxxxxxx';
const JWT_ISSUER   = 'auth-service';
const JWT_AUDIENCE = 'bravo-api';
const SIGNAL_DEVICE_ID = 1;

const subtle = webcrypto.subtle;
const curve  = new AsyncCurve25519Wrapper();

// ─── tiny color helpers ─────────────────────────────────────────────
const ok   = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[31m✗\x1b[0m ${m}`); process.exit(1); };
const step = (m) => console.log(`\n\x1b[36m→\x1b[0m ${m}`);

// ─── JWT minting ────────────────────────────────────────────────────
async function mintAccessJwt(userId) {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return await new SignJWT({device_id: 'dev-device', role: 'user'})
    .setProtectedHeader({alg: 'HS256'})
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

// ─── In-memory libsignal store ──────────────────────────────────────
function makeStore() {
  const s = {
    ownIdentity: null, registrationId: null,
    preKeys: new Map(), signedPreKeys: new Map(),
    sessions: new Map(), identities: new Map(),
  };
  return {
    raw: s,
    async getIdentityKeyPair() { return s.ownIdentity; },
    async getLocalRegistrationId() { return s.registrationId; },
    async isTrustedIdentity() { return true; },
    async saveIdentity(id, key) {
      const prior = s.identities.get(id);
      s.identities.set(id, key);
      return !!prior;
    },
    async loadIdentityKey(id) { return s.identities.get(id); },
    async loadPreKey(kid) { return s.preKeys.get(kid); },
    async storePreKey(kid, kp) { s.preKeys.set(kid, kp); },
    async removePreKey(kid) { s.preKeys.delete(kid); },
    async loadSignedPreKey(kid) { return s.signedPreKeys.get(kid); },
    async storeSignedPreKey(kid, kp, sig) { s.signedPreKeys.set(kid, {...kp, signature: sig}); },
    async loadSession(id) { return s.sessions.get(id); },
    async storeSession(id, rec) { s.sessions.set(id, rec); },
    async removeSession(id) { s.sessions.delete(id); },
    async removeAllSessions() {},
    async setOwnIdentity(regId, keyPair) {
      s.registrationId = regId;
      s.ownIdentity = keyPair;
    },
  };
}

async function bootstrapClient() {
  const store = makeStore();
  const regId    = KeyHelper.generateRegistrationId();
  const identity = await KeyHelper.generateIdentityKeyPair();
  await store.setOwnIdentity(regId, identity);
  const spk = await KeyHelper.generateSignedPreKey(identity, 1);
  await store.storeSignedPreKey(1, spk.keyPair, spk.signature);
  const opk = await KeyHelper.generatePreKey(1);
  await store.storePreKey(1, opk.keyPair);
  return {
    store,
    regId,
    identity,
    spk,
    opk,
    identityKey:    identity.pubKey,                  // ArrayBuffer (33 bytes, type-tagged)
    identityKeyB64: Buffer.from(new Uint8Array(identity.pubKey)).toString('base64'),
  };
}

// ─── Sealed Sender v2 outer ECIES — mirror of crypto/outerEcies.ts ──
const VERSION_BYTE = 0x02;
const HKDF_INFO    = new TextEncoder().encode('Bravo-SealedSender-v2');

function stripIdentityType(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u.byteLength === 33 && u[0] === 0x05 ? u.subarray(1) : u;
}
function ab(u) { const o = new ArrayBuffer(u.byteLength); new Uint8Array(o).set(u); return o; }
function concat(a, b) { const o = new Uint8Array(a.byteLength + b.byteLength); o.set(a, 0); o.set(b, a.byteLength); return o; }
async function hmac(key, data) {
  const k = await subtle.importKey('raw', ab(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, ab(data)));
}
async function deriveOuterKey(ephPub, recipientPub, dh) {
  const salt = new Uint8Array(await subtle.digest('SHA-256', ab(concat(ephPub, recipientPub))));
  const prk  = await hmac(salt, dh);
  const okm  = await hmac(prk, concat(HKDF_INFO, new Uint8Array([0x01])));
  return subtle.importKey('raw', ab(okm.subarray(0, 32)), {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function wrapOuter({recipientIdentityKeyB64, sender, ciphertext}) {
  const recipient = stripIdentityType(Buffer.from(recipientIdentityKeyB64, 'base64'));
  const ephPriv   = webcrypto.getRandomValues(new Uint8Array(32));
  const ephKp     = await curve.keyPair(ab(ephPriv));
  const ephPub    = new Uint8Array(ephKp.pubKey);
  const dh        = await curve.sharedSecret(ab(recipient), ephKp.privKey);
  const aesKey    = await deriveOuterKey(ephPub, recipient, new Uint8Array(dh));
  const inner     = JSON.stringify({s: {u: sender.userId, d: sender.deviceId}, c: {t: ciphertext.type, b: ciphertext.body}});
  const iv        = webcrypto.getRandomValues(new Uint8Array(12));
  const aad       = concat(ephPub, recipient);
  const ct        = new Uint8Array(await subtle.encrypt(
    {name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad)}, aesKey, ab(new TextEncoder().encode(inner))));
  const wire = new Uint8Array(1 + 32 + 12 + ct.byteLength);
  wire[0] = VERSION_BYTE;
  wire.set(ephPub, 1);
  wire.set(iv, 33);
  wire.set(ct, 45);
  return Buffer.from(wire).toString('base64');
}
async function unwrapOuter({ownIdentityPrivKey, ownIdentityPubKey, outerSealedB64}) {
  const wire = new Uint8Array(Buffer.from(outerSealedB64, 'base64'));
  if (wire.byteLength < 45 + 16) throw new Error('outer too short');
  if (wire[0] !== VERSION_BYTE)  throw new Error(`outer wrong version ${wire[0]}`);
  const ephPub = wire.subarray(1, 33);
  const iv     = wire.subarray(33, 45);
  const ct     = wire.subarray(45);
  const recipientPub  = stripIdentityType(new Uint8Array(ownIdentityPubKey));
  const recipientPriv = stripIdentityType(new Uint8Array(ownIdentityPrivKey));
  const dh     = await curve.sharedSecret(ab(ephPub), ab(recipientPriv));
  const aesKey = await deriveOuterKey(ephPub, recipientPub, new Uint8Array(dh));
  const aad    = concat(ephPub, recipientPub);
  const ptAb   = await subtle.decrypt(
    {name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad)}, aesKey, ab(ct));
  const inner  = JSON.parse(new TextDecoder().decode(new Uint8Array(ptAb)));
  return {sender: {userId: inner.s.u, deviceId: inner.s.d}, ciphertext: {type: inner.c.t, body: inner.c.b}};
}

// ─── HTTP helpers ────────────────────────────────────────────────────
async function postEnvelope(jwt, body) {
  return await fetch(`${MSG_BASE}/envelopes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${jwt}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
    body: JSON.stringify(body),
  });
}
async function pullEnvelopes(jwt) {
  const r = await fetch(`${MSG_BASE}/envelopes`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
  });
  if (!r.ok) throw new Error(`pull failed ${r.status}: ${await r.text()}`);
  return r.json();
}
async function ackEnvelope(jwt, envelopeId) {
  return await fetch(`${MSG_BASE}/envelopes/${envelopeId}/ack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
  });
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  step('Boot two test identities + JWTs');
  const aliceUserId = `alice-${randomUUID().slice(0, 8)}`;
  const bobUserId   = `bob-${randomUUID().slice(0, 8)}`;
  const aliceJwt = await mintAccessJwt(aliceUserId);
  const bobJwt   = await mintAccessJwt(bobUserId);
  const alice = await bootstrapClient();
  const bob   = await bootstrapClient();
  ok(`alice=${aliceUserId} bob=${bobUserId} (both 32-byte X25519 identities)`);

  step('Alice initOutgoingSession with Bob via in-process X3DH');
  const aliceToBob = new SignalProtocolAddress(bobUserId, SIGNAL_DEVICE_ID);
  await new SessionBuilder(alice.store, aliceToBob).processPreKey({
    registrationId: bob.regId,
    identityKey:    bob.identityKey,
    signedPreKey: {
      keyId:     1,
      publicKey: bob.spk.keyPair.pubKey,
      signature: bob.spk.signature,
    },
    preKey: {keyId: 1, publicKey: bob.opk.keyPair.pubKey},
  });
  ok('X3DH session established');

  step('Alice seal → encrypt → outerWrap → POST /envelopes');
  const plaintext = 'live-smoke-' + randomUUID();
  // Skip the full sealed-cert envelope and just push raw plaintext as the
  // libsignal SessionCipher input — the relay never inspects this layer
  // and the smoke is about the OUTER wire shape, not cert verification.
  const aliceCipher = new SessionCipher(alice.store, aliceToBob);
  const ptBytes = new TextEncoder().encode(plaintext);
  const ptAb = ab(ptBytes);
  const ct = await aliceCipher.encrypt(ptAb);
  const ctBody = typeof ct.body === 'string' ? ct.body : Buffer.from(ct.body).toString('base64');
  const outerSealed = await wrapOuter({
    recipientIdentityKeyB64: bob.identityKeyB64,
    sender:     {userId: aliceUserId, deviceId: SIGNAL_DEVICE_ID},
    ciphertext: {type: ct.type, body: ctBody},
  });

  const submitRes = await postEnvelope(aliceJwt, {
    recipient:   {userId: bobUserId, deviceId: SIGNAL_DEVICE_ID},
    outerSealed,
    clientMsgId: randomUUID(),
  });
  if (submitRes.status !== 202) {
    fail(`submit returned ${submitRes.status}: ${await submitRes.text()}`);
  }
  const submitBody = await submitRes.json();
  if (!submitBody.envelopeId) fail('submit response missing envelopeId');
  if (!submitBody.retractToken) fail('submit response missing retractToken');
  ok(`envelope ${submitBody.envelopeId} accepted (deliveredNow=${submitBody.deliveredNow})`);

  step('Inspect Redis row directly — confirm no sender field anywhere');
  const raw = redisGet(`env:${submitBody.envelopeId}`);
  if (!raw) fail('Redis row missing for envelope id');
  const stored = JSON.parse(raw);
  const forbiddenFields = ['senderAddressHint', 'sender', 'senderUserId', 'submitterUserId', 'ciphertext'];
  for (const k of forbiddenFields) {
    if (k in stored) fail(`Redis row leaks "${k}": ${JSON.stringify(stored[k])}`);
  }
  if (typeof stored.outerSealed !== 'string' || stored.outerSealed.length < 60) {
    fail(`Redis row missing outerSealed (got ${typeof stored.outerSealed} len=${stored.outerSealed?.length})`);
  }
  if (stored.outerSealed !== outerSealed) {
    fail('Redis row outerSealed differs from submitted');
  }
  ok(`Redis row clean — outerSealed=${stored.outerSealed.slice(0, 40)}... (no sender fields)`);

  step('Bob GET /envelopes pulls the sealed envelope');
  const pulled = await pullEnvelopes(bobJwt);
  const env = pulled.envelopes.find(e => e.envelopeId === submitBody.envelopeId);
  if (!env) fail('Bob did not receive the envelope on pull');
  for (const k of forbiddenFields) {
    if (k in env) fail(`pull response leaks "${k}"`);
  }
  if (typeof env.outerSealed !== 'string') fail('pull response missing outerSealed');
  ok('pull response shape clean');

  step('Bob unwrap → libsignal decrypt → byte equality');
  const unwrapped = await unwrapOuter({
    ownIdentityPrivKey: bob.identity.privKey,
    ownIdentityPubKey:  bob.identity.pubKey,
    outerSealedB64:     env.outerSealed,
  });
  if (unwrapped.sender.userId !== aliceUserId) {
    fail(`outer wrap sender mismatch: ${unwrapped.sender.userId}`);
  }
  const bobFromAlice = new SignalProtocolAddress(aliceUserId, SIGNAL_DEVICE_ID);
  const bobCipher = new SessionCipher(bob.store, bobFromAlice);
  const plainBuf = unwrapped.ciphertext.type === 3
    ? await bobCipher.decryptPreKeyWhisperMessage(unwrapped.ciphertext.body, 'binary')
    : await bobCipher.decryptWhisperMessage(unwrapped.ciphertext.body, 'binary');
  const recovered = Buffer.from(new Uint8Array(plainBuf)).toString('utf8');
  if (recovered !== plaintext) fail(`plaintext mismatch: got "${recovered}"`);
  ok(`recovered plaintext byte-for-byte: "${recovered}"`);

  step('Bob ACK + verify hard-delete');
  const ackRes = await ackEnvelope(bobJwt, env.envelopeId);
  if (ackRes.status !== 204) fail(`ack returned ${ackRes.status}`);
  if (redisExists(`env:${submitBody.envelopeId}`)) fail('Redis row still present after ACK');
  ok('Redis row hard-deleted');

  step('DTO validation — empty outerSealed → 400');
  const emptyRes = await postEnvelope(aliceJwt, {
    recipient: {userId: bobUserId, deviceId: SIGNAL_DEVICE_ID},
    outerSealed: '',
    clientMsgId: randomUUID(),
  });
  if (emptyRes.status !== 400) fail(`expected 400 on empty outerSealed, got ${emptyRes.status}`);
  ok('empty outerSealed rejected with 400');

  step('DTO validation — oversize outerSealed → 400');
  const tooBig = 'A'.repeat(800_000);
  const bigRes = await postEnvelope(aliceJwt, {
    recipient: {userId: bobUserId, deviceId: SIGNAL_DEVICE_ID},
    outerSealed: tooBig,
    clientMsgId: randomUUID(),
  });
  if (bigRes.status !== 400 && bigRes.status !== 413) {
    fail(`expected 400/413 on oversized outerSealed, got ${bigRes.status}`);
  }
  ok(`oversize outerSealed rejected with ${bigRes.status}`);

  step('Disappearing-message TTL — past deadline → 400');
  const pastRes = await postEnvelope(aliceJwt, {
    recipient: {userId: bobUserId, deviceId: SIGNAL_DEVICE_ID},
    outerSealed,
    clientMsgId: randomUUID(),
    expiresAtSec: Math.floor(Date.now() / 1000) - 60,
  });
  if (pastRes.status !== 400) fail(`expected 400 on past expiresAtSec, got ${pastRes.status}`);
  ok('past expiresAtSec rejected with 400');

  console.log('\n\x1b[32mPASS\x1b[0m — Sealed Sender v2 wire end-to-end');
}

main().catch(e => { console.error('\nFAIL:', e); process.exit(1); });
