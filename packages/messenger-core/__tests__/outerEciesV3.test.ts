import {
  SessionManager,
  wrapOuter, unwrapOuter,
  sealPayload,
} from '@bravo/messenger-core';
import {makeParty} from './fixtures';

/**
 * Audit P0-1 — outer ECIES v3 (cert in AAD).
 *
 * Pins the wire-format upgrade that closes the forged-outer-envelope
 * ratchet-wipe attack. v2's AAD only covered `eph_pub || recipient_pub`,
 * leaving the inner `s: {u, d}` (sender address) unauthenticated by the
 * outer GCM tag — any authenticated submitter could mint a wrap naming
 * any victim's peer, trip DecryptError on receive, and the legacy
 * catch-block would then wipe the legitimate session via closeSession +
 * bundle refetch.
 *
 * v3 binds the cert bytes into the outer AAD so:
 *   - A relay-side tamper of the cert breaks the GCM tag → CryptoError.
 *   - Receivers DERIVE the trusted peer from authority-attested cert
 *     claims, not from the inner `s` field. Inner `s` is preserved for
 *     v2-receiver back-compat decode but is not load-bearing on v3.
 *
 * Tests in this file are intentionally LOW-LEVEL — they exercise the
 * wire-format primitives directly. The runtime-level "cert pre-verify
 * blocks the wipe path" assertion is pinned in
 * `src/modules/messenger/__tests__/sessionWipeProtection.test.ts`
 * (behavioural defence, still in effect for v2-only peers).
 */

describe('audit P0-1 — outer ECIES v3 (cert in AAD)', () => {
  const FAKE_CERT = 'eyJhbGciOiJYRWQyNTUxOSIsInR5cCI6IkJTQyJ9.eyJ0ZXN0IjoxfQ.fakesig';
  const FAKE_CERT_2 = 'eyJhbGciOiJYRWQyNTUxOSIsInR5cCI6IkJTQyJ9.eyJ0ZXN0IjoyfQ.fakesi2';

  it('round-trips a v3 wrap and surfaces senderCert + wireVersion', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT,
    });

    const bobIdentity = await bob.store.getIdentityKeyPair();
    const recovered = await unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     wire,
    });

    expect(recovered.wireVersion).toBe(3);
    expect(recovered.senderCert).toBe(FAKE_CERT);
    expect(recovered.sender.userId).toBe('alice');
    expect(recovered.ciphertext.body).toBe(innerCt.body);
  });

  it('falls back to v2 when cert is omitted (legacy back-compat path)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      // no cert → v2 wire
    });

    const bobIdentity = await bob.store.getIdentityKeyPair();
    const recovered = await unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     wire,
    });

    expect(recovered.wireVersion).toBe(2);
    expect(recovered.senderCert).toBeUndefined();
    expect(recovered.sender.userId).toBe('alice');
  });

  it('v3 rejects when cert bytes in wire are tampered (GCM AAD mismatch)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT,
    });

    // Tamper a single cert byte in the wire (cert starts at offset
    // 1 + 32 + 2 = 35). Decode base64, mutate, re-encode.
    const raw = Buffer.from(wire, 'base64');
    raw[35] = raw[35] ^ 0xff;
    const tampered = raw.toString('base64');

    const bobIdentity = await bob.store.getIdentityKeyPair();
    await expect(unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     tampered,
    })).rejects.toThrow(/outer sealed authentication failed/);
  });

  it('v3 wire shape is distinct per cert (the cert truly binds into the wire)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const w1 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT,
    });
    const w2 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT_2,
    });
    // Decoded wires differ in the cert region — sanity-check by
    // looking for FAKE_CERT_2 substring after base64-decoding.
    const raw1 = Buffer.from(w1, 'base64').toString('utf-8');
    const raw2 = Buffer.from(w2, 'base64').toString('utf-8');
    // The cert is embedded raw UTF-8; FAKE_CERT/_2 differ in last char.
    expect(raw1.includes(FAKE_CERT)).toBe(true);
    expect(raw2.includes(FAKE_CERT_2)).toBe(true);
    expect(raw1.includes(FAKE_CERT_2)).toBe(false);
  });

  it('v3 wire starts with version byte 0x03; v2 wire starts with 0x02', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const v3 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT,
    });
    const v2 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
    });
    expect(Buffer.from(v3, 'base64')[0]).toBe(0x03);
    expect(Buffer.from(v2, 'base64')[0]).toBe(0x02);
  });

  it('EXPO_PUBLIC_OUTER_WIRE_V2=true forces v2 even with cert (rollback knob)', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    // Use bracket access + concatenation so the test source doesn't
    // contain the literal `process.env.EXPO_PUBLIC_*` token that
    // babel-preset-expo's auto-virtual-env-import plugin scans for —
    // touching the var at the source level pulls in
    // `node_modules/expo/virtual/env.js`, an ESM module the
    // messenger-crypto Jest project doesn't transform.
    const envKey = 'EXPO_PUBLIC_' + 'OUTER_WIRE_V2';
    const envRef = process.env as Record<string, string | undefined>;
    envRef[envKey] = 'true';
    try {
      const wire = await wrapOuter({
        recipientIdentityKeyB64: bob.bundle.identityKey,
        sender:                  alice.address,
        ciphertext:              innerCt,
        cert:                    FAKE_CERT,
      });
      expect(Buffer.from(wire, 'base64')[0]).toBe(0x02);
    } finally {
      delete envRef[envKey];
    }
  });

  it('empty cert falls back to v2 (not an error — empty equals "no cert")', async () => {
    // Documented behaviour: `!!params.cert` selects v3 vs v2. An empty
    // string degrades to v2 silently — matching the back-compat path
    // for callers that legitimately have no cert (unit tests of the
    // raw wire shape). Production code passes a non-empty cert; any
    // accidental empty cert is loud-failed at the cert-issuance layer
    // upstream (`certCache.get()` throws on missing cert).
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const wire = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    '',
    });
    // Empty string → v2 fallback; wire begins with 0x02.
    expect(Buffer.from(wire, 'base64')[0]).toBe(0x02);
  });

  it('unwrap rejects unsupported wire versions', async () => {
    const alice = await makeParty({userId: 'alice', deviceId: 1});
    const bob   = await makeParty({userId: 'bob',   deviceId: 1});
    const aliceMgr = new SessionManager(alice.store);

    await aliceMgr.initOutgoingSession(bob.bundle);
    const innerCt = await aliceMgr.encrypt(bob.address, sealPayload('cert', 'hi'));

    const v3 = await wrapOuter({
      recipientIdentityKeyB64: bob.bundle.identityKey,
      sender:                  alice.address,
      ciphertext:              innerCt,
      cert:                    FAKE_CERT,
    });
    // Flip version byte to a value we don't support (e.g. 0x09).
    const raw = Buffer.from(v3, 'base64');
    raw[0] = 0x09;
    const bogus = raw.toString('base64');
    const bobIdentity = await bob.store.getIdentityKeyPair();
    await expect(unwrapOuter({
      ownIdentityPrivKey: bobIdentity.privKey,
      ownIdentityPubKey:  bobIdentity.pubKey,
      outerSealedB64:     bogus,
    })).rejects.toThrow(/unsupported outer sealed version/);
  });
});
