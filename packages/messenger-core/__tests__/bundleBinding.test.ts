import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {
  verifyBundleBinding,
  signBundleBinding,
  bundleBindingSigningInput,
  BUNDLE_BINDING_VERSION,
  CryptoError,
  type BundleAuthoritySig,
  type PreKeyBundle,
} from '@bravo/messenger-core';

/**
 * Audit P0-I2 — authority-signed binding over the keys-service bundle.
 *
 * The auth-service signs `(userId, identityKey, signedPreKey, signedAt)`
 * with its Curve25519 authority private key (same key that signs sender
 * certs). Clients verify the signature before trusting any new peer
 * identity learned from a bundle fetch. Closes the cold-start residual
 * of the P0-1 ratchet-wipe attack: a malicious keys-service can no
 * longer substitute identity end-to-end because the substitution would
 * require an authority-key forge.
 */

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeypair(): Promise<{
  privB64: string;
  pubB64:  string;
}> {
  // Curve25519 priv is any random 32 bytes; the wrapper derives pub
  // from priv via keyPair(). We sign with priv, verify with pub.
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {priv[i] = (i * 31 + 7) & 0xff;}
  const privAb = priv.buffer.slice(priv.byteOffset, priv.byteOffset + priv.byteLength);
  const kp = await curve.keyPair(privAb);
  return {
    privB64: Buffer.from(priv).toString('base64'),
    pubB64:  Buffer.from(new Uint8Array(kp.pubKey)).toString('base64'),
  };
}

function makeBundle(overrides: Partial<PreKeyBundle> = {}): PreKeyBundle {
  return {
    registrationId: 42,
    address:        {userId: 'alice', deviceId: 1},
    identityKey:    Buffer.alloc(32, 0xaa).toString('base64'),
    signedPreKey: {
      keyId:     1,
      publicKey: Buffer.alloc(32, 0xbb).toString('base64'),
      signature: Buffer.alloc(64, 0xcc).toString('base64'),
    },
    ...overrides,
  };
}

describe('audit P0-I2 — bundle authority binding', () => {
  it('round-trips a signature produced by signBundleBinding through verifyBundleBinding', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const sig = await signBundleBinding({
      privateKeyB64:   auth.privB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      Date.now(),
    });
    const {signedAtMs} = await verifyBundleBinding({
      bundle,
      authoritySig:       sig,
      authorityPubKeyB64: auth.pubB64,
    });
    expect(signedAtMs).toBe(sig.signedAtMs);
  });

  it('rejects a signature with a tampered identityKey', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const sig = await signBundleBinding({
      privateKeyB64:   auth.privB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      Date.now(),
    });
    // Swap the identityKey AFTER signing — the verify side
    // re-derives the canonical bytes from the bundle, so any mutation
    // of any covered field breaks the signature.
    const tampered = {...bundle, identityKey: Buffer.alloc(32, 0xee).toString('base64')};
    await expect(verifyBundleBinding({
      bundle:             tampered,
      authoritySig:       sig,
      authorityPubKeyB64: auth.pubB64,
    })).rejects.toThrow(CryptoError);
  });

  it('rejects a signature with a tampered signedPreKey signature field', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const sig = await signBundleBinding({
      privateKeyB64:   auth.privB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      Date.now(),
    });
    const tampered = {
      ...bundle,
      signedPreKey: {...bundle.signedPreKey, signature: Buffer.alloc(64, 0xfe).toString('base64')},
    };
    await expect(verifyBundleBinding({
      bundle:             tampered,
      authoritySig:       sig,
      authorityPubKeyB64: auth.pubB64,
    })).rejects.toThrow(CryptoError);
  });

  it('rejects a signature minted by a different authority key', async () => {
    const goodAuth = await makeAuthorityKeypair();
    // Different priv → different pub. Use byte pattern to ensure distinct.
    const otherPriv = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {otherPriv[i] = (i * 17 + 3) & 0xff;}
    const otherPrivB64 = Buffer.from(otherPriv).toString('base64');

    const bundle = makeBundle();
    const sig = await signBundleBinding({
      privateKeyB64:   otherPrivB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      Date.now(),
    });
    await expect(verifyBundleBinding({
      bundle,
      authoritySig:       sig,
      authorityPubKeyB64: goodAuth.pubB64,
    })).rejects.toThrow(CryptoError);
  });

  it('rejects a signature whose signedAtMs is in the future beyond clock skew', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const futureMs = Date.now() + 10 * 60 * 1000; // 10 min future
    const sig = await signBundleBinding({
      privateKeyB64:   auth.privB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      futureMs,
    });
    await expect(verifyBundleBinding({
      bundle,
      authoritySig:       sig,
      authorityPubKeyB64: auth.pubB64,
      clockSkewMs:        60_000, // 1min skew; 10min future exceeds it
    })).rejects.toThrow(/in future/);
  });

  it('rejects a signature older than the freshness window', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d ago
    const sig = await signBundleBinding({
      privateKeyB64:   auth.privB64,
      userId:          bundle.address.userId,
      identityKey:     bundle.identityKey,
      signedPrekeyId:  bundle.signedPreKey.keyId,
      signedPrekey:    bundle.signedPreKey.publicKey,
      signedPrekeySig: bundle.signedPreKey.signature,
      signedAtMs:      oldMs,
    });
    await expect(verifyBundleBinding({
      bundle,
      authoritySig:       sig,
      authorityPubKeyB64: auth.pubB64,
      maxAgeMs:           7 * 24 * 60 * 60 * 1000, // 7d window
    })).rejects.toThrow(/expired/);
  });

  it('rejects a signature with wrong byte length (defense-in-depth)', async () => {
    const auth = await makeAuthorityKeypair();
    const bundle = makeBundle();
    const badSig: BundleAuthoritySig = {
      sig:        Buffer.alloc(32).toString('base64'), // 32 not 64
      signedAtMs: Date.now(),
    };
    await expect(verifyBundleBinding({
      bundle,
      authoritySig:       badSig,
      authorityPubKeyB64: auth.pubB64,
    })).rejects.toThrow(/wrong length/);
  });

  it('canonical signing input is stable and version-prefixed', () => {
    const bytes = bundleBindingSigningInput({
      userId:          'alice',
      identityKey:     'ikey',
      signedPrekeyId:  3,
      signedPrekey:    'spk',
      signedPrekeySig: 'spkSig',
      signedAtMs:      1700000000000,
    });
    const text = Buffer.from(bytes).toString('utf8');
    expect(text.startsWith(BUNDLE_BINDING_VERSION + '\n')).toBe(true);
    // Field order is fixed; check anchors at each line.
    expect(text).toContain('\nuserId=alice\n');
    expect(text).toContain('\nidentityKey=ikey\n');
    expect(text).toContain('\nsignedPrekeyId=3\n');
    expect(text).toContain('\nsignedPrekey=spk\n');
    expect(text).toContain('\nsignedPrekeySig=spkSig\n');
    expect(text.endsWith('\nsignedAtMs=1700000000000')).toBe(true);
  });
});
