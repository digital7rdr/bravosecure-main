#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * End-to-end smoke test for the messenger stack.
 *
 *   1. Simulates two clients (Alice + Bob) as pure Node processes, no RN.
 *   2. Bootstraps each: installIdentity → upload bundle → fetch cert.
 *   3. Alice fetches Bob's bundle, initializes an outgoing session.
 *   4. Alice seals + encrypts + submits via POST /envelopes.
 *   5. Bob pulls via GET /envelopes, decrypts, unseals, verifies cert.
 *   6. Prints PASS/FAIL.
 *
 * Prereqs: auth-service + messenger-service + Redis running.
 *   docker compose up redis messenger-service
 *   (+ your usual auth-service dev stack on port 3001)
 *
 * Environment:
 *   AUTH_BASE_URL           default http://127.0.0.1:3001
 *   MESSENGER_BASE_URL      default http://127.0.0.1:3100
 *   ALICE_JWT / BOB_JWT     required — access tokens for two users
 *   SENDER_CERT_PUBLIC_KEY_PEM  required — Ed25519 SPKI PEM
 *
 * Usage:
 *   node scripts/e2e-messenger-smoke.mjs
 */

import 'node:crypto';
import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  KeyHelper,
} from '@privacyresearch/libsignal-protocol-typescript';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';

const AUTH      = process.env.AUTH_BASE_URL      ?? 'http://127.0.0.1:3001';
const MSG       = process.env.MESSENGER_BASE_URL ?? 'http://127.0.0.1:3100';
const ALICE_JWT = process.env.ALICE_JWT;
const BOB_JWT   = process.env.BOB_JWT;
const PUB_B64   = process.env.SENDER_CERT_PUBLIC_KEY_B64 ?? '';
const SIGNAL_DEVICE_ID = 1;

if (!ALICE_JWT || !BOB_JWT || !PUB_B64) {
  console.error('ERR: set ALICE_JWT, BOB_JWT, SENDER_CERT_PUBLIC_KEY_B64');
  process.exit(2);
}

const curve = new AsyncCurve25519Wrapper();

// ─── In-memory Signal protocol store (per-client) ───────────────────
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

const toB64 = buf => Buffer.from(new Uint8Array(buf)).toString('base64');
const fromB64 = b64 => {
  const u = Buffer.from(b64, 'base64');
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
};

async function installAndUpload(name, jwt) {
  const store = makeStore();
  const regId = KeyHelper.generateRegistrationId();
  const id    = await KeyHelper.generateIdentityKeyPair();
  await store.setOwnIdentity(regId, id);
  const spk = await KeyHelper.generateSignedPreKey(id, 1);
  await store.storeSignedPreKey(1, spk.keyPair, spk.signature);
  const opks = [];
  for (let i = 1; i <= 10; i++) {
    const pk = await KeyHelper.generatePreKey(i);
    await store.storePreKey(pk.keyId, pk.keyPair);
    opks.push({keyId: pk.keyId, publicKey: toB64(pk.keyPair.pubKey)});
  }
  // Upload bundle
  const upRes = await fetch(`${AUTH}/auth/keys/upload`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`},
    body: JSON.stringify({
      registrationId:  regId,
      identityKey:     toB64(id.pubKey),
      signedPrekeyId:  1,
      signedPrekey:    toB64(spk.keyPair.pubKey),
      signedPrekeySig: toB64(spk.signature),
      oneTimePrekeys:  opks,
    }),
  });
  if (!upRes.ok) throw new Error(`${name} upload failed: ${upRes.status} ${await upRes.text()}`);

  // Fetch sender cert
  const certRes = await fetch(`${AUTH}/sender-cert`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`},
    body: JSON.stringify({
      senderSignalDeviceId: SIGNAL_DEVICE_ID,
      senderIdentityKey:    toB64(id.pubKey),
    }),
  });
  if (!certRes.ok) throw new Error(`${name} cert failed: ${certRes.status} ${await certRes.text()}`);
  const {cert} = await certRes.json();
  return {name, store, cert, identityKeyB64: toB64(id.pubKey)};
}

async function fetchPeerBundle(userId, jwt) {
  const res = await fetch(`${AUTH}/auth/keys/${encodeURIComponent(userId)}`, {
    headers: {Authorization: `Bearer ${jwt}`},
  });
  if (!res.ok) throw new Error(`fetch bundle ${userId} failed: ${res.status}`);
  const b = await res.json();
  return {
    registrationId: b.registrationId,
    identityKey:    fromB64(b.identityKey),
    signedPreKey: {
      keyId:     b.signedPrekeyId,
      publicKey: fromB64(b.signedPrekey),
      signature: fromB64(b.signedPrekeySig),
    },
    preKey: b.oneTimePrekey ? {
      keyId: b.oneTimePrekey.keyId, publicKey: fromB64(b.oneTimePrekey.publicKey),
    } : undefined,
  };
}

async function main() {
  console.log('→ Bootstrapping Alice');
  const alice = await installAndUpload('alice', ALICE_JWT);
  console.log('→ Bootstrapping Bob');
  const bob   = await installAndUpload('bob',   BOB_JWT);

  console.log('→ Alice fetches Bob bundle + initializes session');
  const bobBundle = await fetchPeerBundle(extractSub(BOB_JWT), ALICE_JWT);
  const aliceToBob = new SignalProtocolAddress(extractSub(BOB_JWT), SIGNAL_DEVICE_ID);
  await new SessionBuilder(alice.store, aliceToBob).processPreKey(bobBundle);

  console.log('→ Alice seals + encrypts + outer-wraps + submits');
  const sealed = JSON.stringify({v: 1, cert: alice.cert, body: 'hello bob — sealed'});
  const aliceCipher = new SessionCipher(alice.store, aliceToBob);
  const ct = await aliceCipher.encrypt(Buffer.from(sealed, 'utf8'));
  const ctBody = typeof ct.body === 'string' ? ct.body : toB64(ct.body);
  const outerSealed = await wrapOuterEcies({
    recipientIdentityKeyB64: bobBundle.identityKey instanceof Uint8Array
      ? toB64(bobBundle.identityKey)
      : Buffer.from(new Uint8Array(bobBundle.identityKey)).toString('base64'),
    sender:     {userId: extractSub(ALICE_JWT), deviceId: SIGNAL_DEVICE_ID},
    ciphertext: {type: ct.type, body: ctBody},
  });

  const submitRes = await fetch(`${MSG}/envelopes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ALICE_JWT}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
    body: JSON.stringify({
      recipient: {userId: extractSub(BOB_JWT), deviceId: SIGNAL_DEVICE_ID},
      outerSealed,
    }),
  });
  if (!submitRes.ok) throw new Error(`submit failed: ${submitRes.status} ${await submitRes.text()}`);
  const {envelopeId} = await submitRes.json();
  console.log('  submitted envelope', envelopeId);

  console.log('→ Bob pulls + decrypts + verifies cert');
  const pullRes = await fetch(`${MSG}/envelopes`, {
    headers: {
      Authorization: `Bearer ${BOB_JWT}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
  });
  if (!pullRes.ok) throw new Error(`pull failed: ${pullRes.status}`);
  const {envelopes} = await pullRes.json();
  if (envelopes.length === 0) throw new Error('no envelopes pulled — relay empty');
  const env = envelopes.find(e => e.envelopeId === envelopeId);
  if (!env) throw new Error('submitted envelope not found in pull');
  if (!env.outerSealed) throw new Error('relay returned envelope without outerSealed (Sealed Sender v2)');

  const bobIdentity = await bob.store.getIdentityKeyPair();
  const unwrapped = await unwrapOuterEcies({
    ownIdentityPrivKey: bobIdentity.privKey,
    ownIdentityPubKey:  bobIdentity.pubKey,
    outerSealedB64:     env.outerSealed,
  });
  if (unwrapped.sender.userId !== extractSub(ALICE_JWT)) {
    throw new Error(`outer wrap sender mismatch: ${unwrapped.sender.userId}`);
  }

  const bobFromAlice = new SignalProtocolAddress(extractSub(ALICE_JWT), SIGNAL_DEVICE_ID);
  const bobCipher = new SessionCipher(bob.store, bobFromAlice);
  const plainBuf = unwrapped.ciphertext.type === 3
    ? await bobCipher.decryptPreKeyWhisperMessage(unwrapped.ciphertext.body, 'binary')
    : await bobCipher.decryptWhisperMessage(unwrapped.ciphertext.body, 'binary');
  const plain = Buffer.from(new Uint8Array(plainBuf)).toString('utf8');
  const {cert, body} = JSON.parse(plain);
  if (body !== 'hello bob — sealed') throw new Error(`body mismatch: ${body}`);

  // XEd25519 cert verify — wire format: header.payload.sig (all base64).
  const parts = cert.split('.');
  if (parts.length !== 3) throw new Error(`cert wrong segment count: ${parts.length}`);
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
  if (header.alg !== 'XEd25519' || header.typ !== 'BSC') {
    throw new Error(`cert unexpected header alg=${header.alg} typ=${header.typ}`);
  }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  if (payload.iss !== 'auth-service') throw new Error(`cert wrong issuer: ${payload.iss}`);
  const sig    = Buffer.from(sigB64, 'base64');
  const pubBuf = Buffer.from(PUB_B64, 'base64');
  const msg    = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  // verify returns truthy for INVALID — falsy means good.
  const invalid = await curve.verify(ab(pubBuf), ab(msg), ab(sig));
  if (invalid) throw new Error('cert signature verification failed');
  if (payload.senderUserId !== extractSub(ALICE_JWT)) {
    throw new Error(`cert sub mismatch: ${payload.senderUserId}`);
  }
  if (payload.senderIdentityKey !== alice.identityKeyB64) {
    throw new Error('cert identity key mismatch with Alice uploaded bundle');
  }

  console.log('→ Bob acks');
  const ackRes = await fetch(`${MSG}/envelopes/${envelopeId}/ack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BOB_JWT}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
  });
  if (ackRes.status !== 204) throw new Error(`ack failed: ${ackRes.status}`);

  console.log('→ Confirm envelope gone after ack');
  const pull2 = await fetch(`${MSG}/envelopes`, {
    headers: {
      Authorization: `Bearer ${BOB_JWT}`,
      'X-Signal-Device-Id': String(SIGNAL_DEVICE_ID),
    },
  });
  const {envelopes: after} = await pull2.json();
  if (after.find(e => e.envelopeId === envelopeId)) {
    throw new Error('envelope still present after ack');
  }
  console.log('PASS');
}

function extractSub(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!payload.sub) throw new Error('JWT has no sub');
  return payload.sub;
}

// ─── Sealed Sender v2 outer ECIES helpers ───────────────────────────
// Byte-for-byte mirror of `src/modules/messenger/crypto/outerEcies.ts`
// so this script can verify a server roundtrip end-to-end without
// importing the RN-flavored module.

import {webcrypto} from 'node:crypto';
const subtle = webcrypto.subtle;
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

async function wrapOuterEcies({recipientIdentityKeyB64, sender, ciphertext}) {
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

async function unwrapOuterEcies({ownIdentityPrivKey, ownIdentityPubKey, outerSealedB64}) {
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
  return {
    sender:     {userId: inner.s.u, deviceId: inner.s.d},
    ciphertext: {type: inner.c.t, body: inner.c.b},
  };
}

main().catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
