import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {randomBytes, randomUUID} from 'node:crypto';
import {SessionManager} from '@bravo/messenger-core';
import {sealPayload, unsealPayload, verifySealedAad, SEALED_AAD_SKEW_MS, SEALED_AAD_FUTURE_MS, SEALED_AAD_MAX_AGE_MS} from '@bravo/messenger-core';
import {verifySenderCert} from '@bravo/messenger-core';
import {toBase64} from '@bravo/messenger-core';
import {CryptoError} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

/**
 * Sealed Sender end-to-end:
 *
 *   Alice crafts:   seal(cert, plaintext) → wrapped JSON
 *                  ↓ SessionCipher.encrypt
 *                  ciphertext (opaque)
 *                  ↓ wire
 *   Bob receives:  SessionCipher.decrypt → wrapped JSON
 *                  ↓ unseal
 *                  {cert, body}
 *                  ↓ verifySenderCert
 *                  authenticated claims
 *
 * Cert signing primitive: XEd25519 over Curve25519, the same wrapper
 * libsignal uses for SignedPreKey signatures. The auth-service issuer
 * (apps/auth-service/src/sender-cert) uses an identical wire format.
 */

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeys() {
  const seed = randomBytes(32);
  const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength);
  const kp = await curve.keyPair(seedAb);
  return {
    privKey:  kp.privKey,
    pubKeyB64: Buffer.from(kp.pubKey).toString('base64'),
  };
}

function b64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

interface MintParams {
  sub: string;
  signalDeviceId: number;
  identityKey: string;
  /** Seconds from now until expiry. Default 3600. Negative for an already-expired cert. */
  expiresInSec?: number;
  jti?: string;
  iss?: string;
}

async function mintCert(privKey: ArrayBuffer, p: MintParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (p.expiresInSec ?? 3600);
  const payload = {
    senderUserId:         p.sub,
    senderSignalDeviceId: p.signalDeviceId,
    senderIdentityKey:    p.identityKey,
    iat: now,
    exp,
    iss: p.iss ?? 'auth-service',
    jti: p.jti ?? randomUUID(),
  };
  const headerB64  = b64Json({alg: 'XEd25519', typ: 'BSC'});
  const payloadB64 = b64Json(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sigAb = await curve.sign(
    privKey,
    signingInput.buffer.slice(signingInput.byteOffset, signingInput.byteOffset + signingInput.byteLength),
  );
  const sigB64 = Buffer.from(sigAb).toString('base64');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

describe('Sealed Sender — client roundtrip', () => {
  it('wraps plaintext + cert, round-trips through Signal, verifies cert on the other side', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const bobMgr   = new SessionManager(bob.store);

    const auth = await makeAuthorityKeys();
    const aliceIdentity = await alice.store.getIdentityKeyPair();
    const aliceIdentityKeyB64 = toBase64(aliceIdentity.pubKey);
    const cert = await mintCert(auth.privKey, {
      sub:            'alice',
      signalDeviceId: 1,
      identityKey:    aliceIdentityKeyB64,
    });

    await aliceMgr.initOutgoingSession(bob.bundle);
    const wrapped = sealPayload(cert, 'meet at DIFC 14:00');
    const ct = await aliceMgr.encrypt(bob.address, wrapped);

    const recovered = await bobMgr.decrypt(alice.address, ct);
    const {cert: extractedCert, body} = unsealPayload(recovered);
    expect(body).toBe('meet at DIFC 14:00');

    const claims = await verifySenderCert({
      cert:                 extractedCert,
      authorityPubKeyB64:   auth.pubKeyB64,
      expectedIdentityKey:  aliceIdentityKeyB64,
    });
    expect(claims.senderUserId).toBe('alice');
    expect(claims.senderSignalDeviceId).toBe(1);
    expect(claims.senderIdentityKey).toBe(aliceIdentityKeyB64);
  });

  it('rejects a cert signed by a different authority', async () => {
    const attacker = await makeAuthorityKeys();
    const real     = await makeAuthorityKeys();

    const forgedCert = await mintCert(attacker.privKey, {
      sub: 'alice', signalDeviceId: 1, identityKey: 'AAAA',
    });

    await expect(
      verifySenderCert({cert: forgedCert, authorityPubKeyB64: real.pubKeyB64}),
    ).rejects.toThrow(/signature invalid/);
  });

  it('rejects an expired cert', async () => {
    const auth = await makeAuthorityKeys();
    const expired = await mintCert(auth.privKey, {
      sub: 'alice', signalDeviceId: 1, identityKey: 'AAAA', expiresInSec: -1,
    });
    await expect(
      verifySenderCert({cert: expired, authorityPubKeyB64: auth.pubKeyB64, clockToleranceSec: 0}),
    ).rejects.toThrow(/expired/);
  });

  it('rejects when the cert names a different identity key than the peer used', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);
    const bobMgr   = new SessionManager(bob.store);

    const auth = await makeAuthorityKeys();
    const cert = await mintCert(auth.privKey, {
      sub: 'alice', signalDeviceId: 1, identityKey: 'NotAlicesRealIdentityKeyBase64=',
    });

    await aliceMgr.initOutgoingSession(bob.bundle);
    const ct = await aliceMgr.encrypt(bob.address, sealPayload(cert, 'spoofed'));
    const recovered = await bobMgr.decrypt(alice.address, ct);
    const {cert: extractedCert} = unsealPayload(recovered);

    const aliceIdentity = await alice.store.getIdentityKeyPair();
    await expect(
      verifySenderCert({
        cert:                extractedCert,
        authorityPubKeyB64:  auth.pubKeyB64,
        expectedIdentityKey: toBase64(aliceIdentity.pubKey),
      }),
    ).rejects.toThrow(/identity key mismatch/);
  });

  it('round-trips an attachment (incl. the kind render hint) through seal/unseal', () => {
    // Encrypted-media send path: the per-file AES key + IV + the new
    // `kind` render hint travel in-band inside the sealed payload. Assert
    // they survive the wire so the recipient can decrypt + render the
    // right bubble (image/audio/video) instead of a generic file.
    const attachment = {
      objectKey: 'att/123e4567-e89b-12d3-a456-426614174000',
      keyB64:    Buffer.alloc(32, 7).toString('base64'),
      ivB64:     Buffer.alloc(16, 9).toString('base64'),
      mimeType:  'image/jpeg',
      size:      4096,
      kind:      'image' as const,
    };
    const wire = sealPayload('cert.cert.cert', 'caption', {attachment});
    const sealed = unsealPayload(wire);
    expect(sealed.attachment?.objectKey).toBe(attachment.objectKey);
    expect(sealed.attachment?.keyB64).toBe(attachment.keyB64);
    expect(sealed.attachment?.ivB64).toBe(attachment.ivB64);
    expect(sealed.attachment?.mimeType).toBe('image/jpeg');
    expect((sealed.attachment as {kind?: string} | undefined)?.kind).toBe('image');
    expect(sealed.body).toBe('caption');
  });

  it('rejects malformed sealed JSON', () => {
    expect(() => unsealPayload('{not json')).toThrow(CryptoError);
    expect(() => unsealPayload('"string-not-object"')).toThrow(CryptoError);
    expect(() => unsealPayload('{"v":99,"cert":"x","body":"y"}')).toThrow(/unsupported sealed version/);
  });

  it('rejects a cert whose jti is in the caller-supplied revocation list', async () => {
    const auth = await makeAuthorityKeys();
    const revoked = 'bffffffe-0000-4000-a000-000000000000';
    const cert = await mintCert(auth.privKey, {
      sub: 'alice', signalDeviceId: 1, identityKey: 'AAAA', jti: revoked,
    });
    await expect(
      verifySenderCert({
        cert,
        authorityPubKeyB64: auth.pubKeyB64,
        revokedJtis:        new Set([revoked]),
      }),
    ).rejects.toThrow(/sender cert revoked/);
  });

  it('accepts a cert whose jti is NOT in the revocation list', async () => {
    const auth = await makeAuthorityKeys();
    const cert = await mintCert(auth.privKey, {
      sub: 'alice', signalDeviceId: 1, identityKey: 'AAAA', jti: '11111111-0000-4000-a000-000000000000',
    });
    const claims = await verifySenderCert({
      cert,
      authorityPubKeyB64: auth.pubKeyB64,
      revokedJtis:        new Set(['99999999-0000-4000-a000-000000000000']),
    });
    expect(claims.jti).toBe('11111111-0000-4000-a000-000000000000');
  });
});

/**
 * Round 5 / Security S1 — sealed-sender AAD binding.
 *
 * The aad field stamps the intended recipient + sender clock into the
 * libsignal-authenticated wrapper. Receiver verifies; mismatches mean
 * the ciphertext was sealed for someone else (replay) or sat stale
 * for >15 minutes (offline-capture-and-resend). Legacy v1/v2 senders
 * omit aad — receiver accepts (back-compat) until rollout completes.
 */
describe('Sealed Sender — AAD binding (Round 5 / S1)', () => {
  it('round-trips aad through seal/unseal at wire version 3', () => {
    const wire = sealPayload('cert.cert.cert', 'hi', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const parsed = unsealPayload(wire);
    expect(parsed.v).toBe(3);
    expect(parsed.aad).toEqual({to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000});
  });

  it('verifySealedAad accepts when recipient and ts match', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1, now: 1_700_000_001_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.aad?.to.userId).toBe('bob');}
  });

  it('verifySealedAad rejects when recipient userId does not match', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'mallory', selfDeviceId: 1, now: 1_700_000_001_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('recipient_mismatch');}
  });

  // Audit MSG-01 — stale bound is the 30-day relay dwell, not ±15min.
  it('verifySealedAad ACCEPTS a message within the relay dwell (offline backlog no longer dropped)', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
      now: 1_700_000_000_000 + SEALED_AAD_MAX_AGE_MS - 1_000,
    });
    expect(r.ok).toBe(true);
  });

  it('verifySealedAad rejects stale ts beyond the relay-dwell window', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
      now: 1_700_000_000_000 + SEALED_AAD_MAX_AGE_MS + 1_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('stale');}
  });

  it('verifySealedAad rejects future ts beyond the FUTURE bound (24h)', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
      now: 1_700_000_000_000 - SEALED_AAD_FUTURE_MS - 1_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('future');}
  });

  // Audit MEDIUM-1 — a mildly-future ts (fast-clock sender) is now ACCEPTED,
  // not silently dropped-and-acked-off-relay.
  it('MEDIUM-1 — verifySealedAad ACCEPTS a mildly-future ts within the 24h window', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
      now: 1_700_000_000_000 - SEALED_AAD_SKEW_MS - 1_000,
    });
    expect(r.ok).toBe(true);
  });

  // Audit P0-N1 — DEFAULT is fail-closed. A future call site that
  // forgets `requireAad` inherits the safe path. Regression-lock for
  // the 2026-05-23 audit row.
  it('audit P0-N1 — verifySealedAad rejects missing aad by DEFAULT (no requireAad param)', () => {
    const wire = sealPayload('cert.cert.cert', 'x'); // no aad
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('missing');}
  });

  // Audit S10 — explicit requireAad:true matches the default.
  it('verifySealedAad rejects missing aad when requireAad is explicitly set', () => {
    const wire = sealPayload('cert.cert.cert', 'x'); // no aad
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1, requireAad: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('missing');}
  });

  // Audit P0-N1 — the rollout escape hatch (`requireAad: false`)
  // still works for productionRuntime's SEALED_AAD_LEGACY branch.
  it('audit P0-N1 — verifySealedAad accepts missing aad ONLY with explicit requireAad:false (legacy)', () => {
    const wire = sealPayload('cert.cert.cert', 'x'); // no aad
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1, requireAad: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.aad).toBeUndefined();}
  });

  it('strips aad fields injected on a v2 envelope (forces v3 to claim aad)', () => {
    // Sender stamps v=2 manually but tries to add aad — receiver MUST
    // strip it because v2 isn't supposed to carry the binding. Without
    // this strip a malicious peer could claim an aad they don't actually
    // bind in the ratchet.
    const forged = JSON.stringify({
      v:    2,
      cert: 'cert.cert.cert',
      body: 'x',
      aad:  {to: {userId: 'mallory', deviceId: 1}, ts: 0},
    });
    const sealed = unsealPayload(forged);
    expect(sealed.aad).toBeUndefined();
  });

  it('rejects a v3 envelope with malformed aad shape', () => {
    const malformed = JSON.stringify({
      v:    3,
      cert: 'cert.cert.cert',
      body: 'x',
      aad:  {to: 'not-an-object', ts: 'not-a-number'},
    });
    expect(() => unsealPayload(malformed)).toThrow(/sealed payload shape invalid/);
  });

  // Audit P0-N3 / P0-3 — deviceId=0 wildcard is no longer accepted.
  it('audit P0-N3 — rejects aad.to.deviceId=0 as malformed (was wildcard)', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 0}, ts: 1_700_000_000_000},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      sealed, selfUserId: 'bob', selfDeviceId: 1, now: 1_700_000_001_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
  });
});

// Audit P0-N2 — extended AAD bindings (sender / conversationId /
// groupId / epoch). Mirror of the package-side suite.

describe('Sealed Sender — extended AAD (P0-N2)', () => {
  const okBase = {
    selfUserId: 'bob', selfDeviceId: 1, now: 1_700_000_001_000,
  };
  const ts = 1_700_000_000_000;

  it('round-trips extended AAD fields through seal/unseal', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {
        to:             {userId: 'bob', deviceId: 1}, ts,
        sender:         {userId: 'alice', deviceId: 1},
        conversationId: 'group-42',
        groupId:        'group-42',
        epoch:          7,
      },
    });
    const sealed = unsealPayload(wire);
    expect(sealed.aad?.sender?.userId).toBe('alice');
    expect(sealed.aad?.conversationId).toBe('group-42');
    expect(sealed.aad?.groupId).toBe('group-42');
    expect(sealed.aad?.epoch).toBe(7);
  });

  it('rejects when expectedSender mismatches', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts, sender: {userId: 'alice', deviceId: 1}},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      ...okBase, sealed, expectedSender: {userId: 'mallory', deviceId: 1},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('sender_mismatch');}
  });

  it('rejects when conversationId mismatches (1:1 ↔ group replay)', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts, conversationId: 'direct:alice'},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      ...okBase, sealed, expectedConversationId: 'group-42',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('conversation_mismatch');}
  });

  it('rejects when aad.epoch is older than expectedEpoch', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts, epoch: 3},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({
      ...okBase, sealed, expectedEpoch: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('epoch_stale');}
  });

  it('back-compat — passes when AAD omits extensions and caller omits expected*', () => {
    const wire = sealPayload('cert.cert.cert', 'x', {
      aad: {to: {userId: 'bob', deviceId: 1}, ts},
    });
    const sealed = unsealPayload(wire);
    const r = verifySealedAad({...okBase, sealed});
    expect(r.ok).toBe(true);
  });
});
