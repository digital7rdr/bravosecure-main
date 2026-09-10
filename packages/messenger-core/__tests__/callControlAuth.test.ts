/**
 * Audit P1-C2 + P1-C3 — caller-identity binding for call.media-state
 * (P1-C2) and call.answer (P1-C3).
 *
 * Mirror of the S7 (`callOfferAuth.test.ts`) shape — same threat model:
 *   • positive round-trip
 *   • body tamper → body_mismatch
 *   • from-mismatch / to-mismatch
 *   • cert↔aad sender identity mismatch
 *   • stale / future / sig_invalid
 *   • kind binding (an answer sig cannot be replayed as a media-state)
 */

import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {randomBytes, randomUUID} from 'node:crypto';
import {toBase64} from '../src/crypto/encoding';
import {
  signCallControlAuth,
  verifyCallControlAuth,
  callControlBodyHash,
  CALL_CONTROL_AAD_SKEW_MS,
} from '../src/crypto/callControlAuth';

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeys() {
  const seed = randomBytes(32);
  const kp = await curve.keyPair(seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength));
  return {privKey: kp.privKey, pubKeyB64: toBase64(kp.pubKey)};
}
async function makeIdentityKeys() {
  const seed = randomBytes(32);
  const kp = await curve.keyPair(seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength));
  return {privKey: kp.privKey, pubKey: kp.pubKey, pubKeyB64: toBase64(kp.pubKey)};
}

function b64Json(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
}

async function mintCert(p: {
  authorityPriv: ArrayBuffer;
  sub: string; signalDeviceId: number; identityKeyB64: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    senderUserId:         p.sub,
    senderSignalDeviceId: p.signalDeviceId,
    senderIdentityKey:    p.identityKeyB64,
    iat: now,
    exp: now + 3600,
    iss: 'auth-service',
    jti: randomUUID(),
  };
  const headerB64  = b64Json({alg: 'XEd25519', typ: 'BSC'});
  const payloadB64 = b64Json(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sigAb = await curve.sign(
    p.authorityPriv,
    signingInput.buffer.slice(signingInput.byteOffset, signingInput.byteOffset + signingInput.byteLength),
  );
  return `${headerB64}.${payloadB64}.${toBase64(sigAb)}`;
}

const ALICE = {userId: 'alice', deviceId: 1};
const BOB   = {userId: 'bob',   deviceId: 2};

describe('callControlAuth — P1-C2 + P1-C3 binding', () => {
  describe('call.media-state (P1-C2)', () => {
    it('positive round-trip — signed advisory verifies against wire frame', async () => {
      const authority = await makeAuthorityKeys();
      const alice = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: ALICE.userId,
        signalDeviceId: ALICE.deviceId, identityKeyB64: alice.pubKeyB64,
      });
      const auth = await signCallControlAuth({
        cert, identityPrivKey: alice.privKey,
        kind: 'call.media-state', callId: 'cid-1',
        from: ALICE, to: BOB,
        body: {cameraOff: true, micOff: false},
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.media-state', callId: 'cid-1', from: ALICE, body: {cameraOff: true, micOff: false}},
        self: BOB,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect(res.ok).toBe(true);
    });

    it('REJECTS tampered cameraOff bit (body_mismatch)', async () => {
      const authority = await makeAuthorityKeys();
      const alice = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: ALICE.userId,
        signalDeviceId: ALICE.deviceId, identityKeyB64: alice.pubKeyB64,
      });
      const auth = await signCallControlAuth({
        cert, identityPrivKey: alice.privKey,
        kind: 'call.media-state', callId: 'cid-2',
        from: ALICE, to: BOB,
        body: {cameraOff: false, micOff: false},
      });
      // Relay flips cameraOff to true to blank the receiver's tile.
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.media-state', callId: 'cid-2', from: ALICE, body: {cameraOff: true, micOff: false}},
        self: BOB,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect(res.ok).toBe(false);
      expect(res.ok || (res as {reason: string}).reason).toBe('body_mismatch');
    });

    it('REJECTS replay across calls (callId_mismatch)', async () => {
      const authority = await makeAuthorityKeys();
      const alice = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: ALICE.userId,
        signalDeviceId: ALICE.deviceId, identityKeyB64: alice.pubKeyB64,
      });
      const auth = await signCallControlAuth({
        cert, identityPrivKey: alice.privKey,
        kind: 'call.media-state', callId: 'cid-A',
        from: ALICE, to: BOB,
        body: {cameraOff: true, micOff: false},
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.media-state', callId: 'cid-DIFFERENT', from: ALICE, body: {cameraOff: true, micOff: false}},
        self: BOB,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('callId_mismatch');
    });
  });

  describe('call.answer (P1-C3)', () => {
    it('positive round-trip — signed SDP verifies', async () => {
      const authority = await makeAuthorityKeys();
      const bob = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: BOB.userId,
        signalDeviceId: BOB.deviceId, identityKeyB64: bob.pubKeyB64,
      });
      const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 AA:BB\r\n';
      const auth = await signCallControlAuth({
        cert, identityPrivKey: bob.privKey,
        kind: 'call.answer', callId: 'cid-call', from: BOB, to: ALICE,
        body: {sdp},
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.answer', callId: 'cid-call', from: BOB, body: {sdp}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect(res.ok).toBe(true);
    });

    it('REJECTS a swapped SDP (body_mismatch) — relay races DTLS to attacker', async () => {
      const authority = await makeAuthorityKeys();
      const bob = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: BOB.userId,
        signalDeviceId: BOB.deviceId, identityKeyB64: bob.pubKeyB64,
      });
      const sdpGood = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 AA:BB\r\n';
      const sdpEvil = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 99:AA\r\n';
      const auth = await signCallControlAuth({
        cert, identityPrivKey: bob.privKey,
        kind: 'call.answer', callId: 'cid-call', from: BOB, to: ALICE,
        body: {sdp: sdpGood},
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.answer', callId: 'cid-call', from: BOB, body: {sdp: sdpEvil}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('body_mismatch');
    });

    it('REJECTS a media-state sig replayed as a call.answer (kind_mismatch)', async () => {
      const authority = await makeAuthorityKeys();
      const bob = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: BOB.userId,
        signalDeviceId: BOB.deviceId, identityKeyB64: bob.pubKeyB64,
      });
      const auth = await signCallControlAuth({
        cert, identityPrivKey: bob.privKey,
        kind: 'call.media-state', callId: 'cid-call', from: BOB, to: ALICE,
        body: {cameraOff: false, micOff: false},
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.answer', callId: 'cid-call', from: BOB, body: {sdp: 'v=0\r\n'}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('kind_mismatch');
    });

    it('REJECTS spoofed `from` (from_mismatch — cert is bob, wire says alice)', async () => {
      const authority = await makeAuthorityKeys();
      const bob = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: BOB.userId,
        signalDeviceId: BOB.deviceId, identityKeyB64: bob.pubKeyB64,
      });
      const sdp = 'v=0\r\n';
      const auth = await signCallControlAuth({
        cert, identityPrivKey: bob.privKey,
        kind: 'call.answer', callId: 'cid-x', from: BOB, to: ALICE,
        body: {sdp},
      });
      // Wire frame claims `from = ALICE` even though the cert+aad name BOB.
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.answer', callId: 'cid-x', from: ALICE, body: {sdp}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('from_mismatch');
    });

    it('REJECTS stale signature (past skew window)', async () => {
      const authority = await makeAuthorityKeys();
      const bob = await makeIdentityKeys();
      const cert = await mintCert({
        authorityPriv: authority.privKey, sub: BOB.userId,
        signalDeviceId: BOB.deviceId, identityKeyB64: bob.pubKeyB64,
      });
      const sdp = 'v=0\r\n';
      const past = Date.now() - CALL_CONTROL_AAD_SKEW_MS - 1000;
      const auth = await signCallControlAuth({
        cert, identityPrivKey: bob.privKey,
        kind: 'call.answer', callId: 'cid-stale', from: BOB, to: ALICE,
        body: {sdp}, now: past,
      });
      const res = await verifyCallControlAuth({
        auth,
        wire: {kind: 'call.answer', callId: 'cid-stale', from: BOB, body: {sdp}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('stale');
    });

    it('missing auth block → reason="missing"', async () => {
      const authority = await makeAuthorityKeys();
      const res = await verifyCallControlAuth({
        // @ts-expect-error — test path for the legacy-frame case.
        auth: null,
        wire: {kind: 'call.answer', callId: 'cid', from: BOB, body: {sdp: 'v=0'}},
        self: ALICE,
        authorityPubKeyB64: authority.pubKeyB64,
      });
      expect((res as {reason?: string}).reason).toBe('missing');
    });
  });

  describe('callControlBodyHash — deterministic + kind-distinct', () => {
    it('same inputs → same hash', async () => {
      const a = await callControlBodyHash('call.answer', {sdp: 'foo'});
      const b = await callControlBodyHash('call.answer', {sdp: 'foo'});
      expect(a).toBe(b);
    });
    it('different sdp → different hash', async () => {
      const a = await callControlBodyHash('call.answer', {sdp: 'foo'});
      const b = await callControlBodyHash('call.answer', {sdp: 'bar'});
      expect(a).not.toBe(b);
    });
    it('media-state booleans contribute', async () => {
      const off = await callControlBodyHash('call.media-state', {cameraOff: true,  micOff: false});
      const on  = await callControlBodyHash('call.media-state', {cameraOff: false, micOff: false});
      expect(off).not.toBe(on);
    });
  });
});
