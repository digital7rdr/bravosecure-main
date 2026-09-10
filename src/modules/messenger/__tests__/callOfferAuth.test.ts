/**
 * Audit S7 — caller-identity binding for `call.offer`.
 *
 * Pinning down the verifier's behaviour:
 *
 *   • Positive — a properly signed offer + matching wire frame round-trips.
 *   • Tamper   — flipping any AAD field after signing → sig_invalid.
 *   • Replay   — wrong receiver in `aad.to`         → to_mismatch.
 *   • Spoof    — attacker swaps the wire `from` but cert is still alice's
 *                → from_mismatch (cert↔aad).
 *   • Forge    — attacker mints their own auth-service key → cert_invalid.
 *   • Freshness— offer older than the skew window → stale.
 *   • Wrong cb — claim a userId in AAD that the cert doesn't attest →
 *                sender_identity_mismatch.
 *   • Missing  — auth block absent on the wire → missing.
 */
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {randomBytes, randomUUID} from 'node:crypto';
import {toBase64} from '@bravo/messenger-core';
import {
  signCallOfferAuth,
  verifyCallOfferAuth,
  CALL_OFFER_AAD_SKEW_MS,
} from '@bravo/messenger-core';

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeys(): Promise<{privKey: ArrayBuffer; pubKeyB64: string}> {
  const seed = randomBytes(32);
  const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength);
  const kp = await curve.keyPair(seedAb);
  return {privKey: kp.privKey, pubKeyB64: toBase64(kp.pubKey)};
}

async function makeIdentityKeys(): Promise<{privKey: ArrayBuffer; pubKey: ArrayBuffer; pubKeyB64: string}> {
  const seed = randomBytes(32);
  const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength);
  const kp = await curve.keyPair(seedAb);
  return {privKey: kp.privKey, pubKey: kp.pubKey, pubKeyB64: toBase64(kp.pubKey)};
}

function b64Json(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
}

interface MintCertParams {
  authorityPriv: ArrayBuffer;
  sub:           string;
  signalDeviceId: number;
  identityKeyB64: string;
  expiresInSec?: number;
  iss?:          string;
}

async function mintCert(p: MintCertParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    senderUserId:         p.sub,
    senderSignalDeviceId: p.signalDeviceId,
    senderIdentityKey:    p.identityKeyB64,
    iat: now,
    exp: now + (p.expiresInSec ?? 3600),
    iss: p.iss ?? 'auth-service',
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

describe('callOfferAuth — caller-identity binding for call.offer (S7)', () => {
  it('round-trips: signed offer + matching wire frame → ok', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice',
      signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.senderUserId).toBe('alice');
      expect(r.claims.senderSignalDeviceId).toBe(1);
    }
  });

  it('rejects when AAD callId is tampered after signing (sig over canonical bytes)', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    // Attacker swaps the callId in the AAD body but keeps the same sig.
    const tampered = {...auth, aad: {...auth.aad, callId: 'cid-evil'}};
    const r = await verifyCallOfferAuth({
      auth: tampered,
      wire: {callId: 'cid-evil', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'sig_invalid'});
  });

  it('rejects when wire callId disagrees with AAD callId (binding check)', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    // Relay stitches alice's valid auth onto a different outer call.
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-other', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'callId_mismatch'});
  });

  it('rejects replay against the wrong receiver (to_mismatch)', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    // Carol receives an offer that was minted for Bob.
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'carol', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'to_mismatch'});
  });

  it('rejects when the wire `from` disagrees with the AAD `from` (spoofed wire frame)', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    // Compromised relay rewrites the outer `from` to mallory but keeps
    // alice's auth block — the cert↔aad sender check catches it.
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'mallory', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'from_mismatch'});
  });

  it('rejects a cert signed by a forged authority', async () => {
    const realAuthority = await makeAuthorityKeys();
    const fakeAuthority = await makeAuthorityKeys();
    const aliceId = await makeIdentityKeys();
    const forgedCert = await mintCert({
      authorityPriv:  fakeAuthority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert: forgedCert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: realAuthority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'cert_invalid'});
  });

  it('rejects when the AAD claims an identity the cert does not attest', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    // Mallory builds a perfectly valid signature with HER OWN priv key,
    // claims to be alice in the AAD, but presents alice's cert. Cert
    // claims sub=alice, AAD says from=mallory → sender_identity_mismatch.
    const malloryId = await makeIdentityKeys();
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: malloryId.privKey, // wrong key — doesn't matter, we reject before sig
      callId: 'cid-1',
      from:   {userId: 'mallory', deviceId: 1},
      to:     {userId: 'bob',     deviceId: 1},
      kind:   'voice',
    });
    const r = await verifyCallOfferAuth({
      auth,
      // Wire-from is set to mallory too — would otherwise pass from_mismatch.
      wire: {callId: 'cid-1', from: {userId: 'mallory', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'sender_identity_mismatch'});
  });

  it('rejects a stale offer (older than the skew window)', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const offerTs = Date.now() - (CALL_OFFER_AAD_SKEW_MS + 60_000);
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
      now:    offerTs,
    });
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'stale'});
  });

  it('rejects an offer whose wire kind disagrees with AAD kind', async () => {
    const authority = await makeAuthorityKeys();
    const aliceId   = await makeIdentityKeys();
    const cert = await mintCert({
      authorityPriv:  authority.privKey,
      sub:            'alice', signalDeviceId: 1,
      identityKeyB64: aliceId.pubKeyB64,
    });
    const auth = await signCallOfferAuth({
      cert,
      identityPrivKey: aliceId.privKey,
      callId: 'cid-1',
      from:   {userId: 'alice', deviceId: 1},
      to:     {userId: 'bob',   deviceId: 1},
      kind:   'voice',
    });
    // Relay rewrites the outer kind from voice → video to push the
    // recipient toward a camera-up ringing experience the caller never
    // authorised.
    const r = await verifyCallOfferAuth({
      auth,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'video'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'kind_mismatch'});
  });

  it('rejects a missing auth block (forces fail-closed when caller passes empty)', async () => {
    const authority = await makeAuthorityKeys();
    // Cast through unknown — the verifier handles bogus shapes gracefully.
    const r = await verifyCallOfferAuth({

      auth: undefined as any,
      wire: {callId: 'cid-1', from: {userId: 'alice', deviceId: 1}, kind: 'voice'},
      self: {userId: 'bob', deviceId: 1},
      authorityPubKeyB64: authority.pubKeyB64,
    });
    expect(r).toEqual({ok: false, reason: 'missing'});
  });
});
