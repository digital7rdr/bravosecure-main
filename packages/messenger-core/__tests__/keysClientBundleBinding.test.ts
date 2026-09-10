import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {
  KeysHttpClient,
  KeysHttpError,
  signBundleBinding,
  type BundleAuthoritySig,
} from '@bravo/messenger-core';

/**
 * Audit P0-I2 — client-side wire-level verification.
 *
 * The server-side signing was already wired in commit 1f677e0; the
 * gap the audit flagged is that mobile + ops-console clients never
 * verified the signature before trusting the fetched bundle. These
 * tests cover the verification path inside `KeysHttpClient`:
 *
 *   - signature good + freshness window inside default → pass
 *   - server omits `authoritySig` → reject in strict mode (default)
 *   - server omits `authoritySig` + rollback flag → accept
 *   - tampered identityKey on the wire → reject
 *   - signature minted by a different key → reject
 *   - expired signedAtMs → reject
 *   - client without a pinned pubkey → no-op (legacy harness path)
 */

const curve = new AsyncCurve25519Wrapper();

async function makeAuthorityKeypair(seed = 13): Promise<{privB64: string; pubB64: string}> {
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {priv[i] = (i * seed + 7) & 0xff;}
  const privAb = priv.buffer.slice(priv.byteOffset, priv.byteOffset + priv.byteLength);
  const kp = await curve.keyPair(privAb);
  return {
    privB64: Buffer.from(priv).toString('base64'),
    pubB64:  Buffer.from(new Uint8Array(kp.pubKey)).toString('base64'),
  };
}

interface WireBundle {
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekey:   {keyId: number; publicKey: string} | null;
  authoritySig?:   BundleAuthoritySig | null;
}

async function makeWireBundle(opts: {
  authorityPrivB64: string;
  userId:           string;
  signedAtMs?:      number;
}): Promise<WireBundle> {
  const identityKey     = Buffer.alloc(32, 0xaa).toString('base64');
  const signedPrekey    = Buffer.alloc(32, 0xbb).toString('base64');
  const signedPrekeySig = Buffer.alloc(64, 0xcc).toString('base64');
  const signedPrekeyId  = 7;
  const signedAtMs      = opts.signedAtMs ?? Date.now();
  const authoritySig = await signBundleBinding({
    privateKeyB64:   opts.authorityPrivB64,
    userId:          opts.userId,
    identityKey,
    signedPrekeyId,
    signedPrekey,
    signedPrekeySig,
    signedAtMs,
  });
  return {
    registrationId:  42,
    identityKey,
    signedPrekeyId,
    signedPrekey,
    signedPrekeySig,
    oneTimePrekey:   null,
    authoritySig,
  };
}

function installFetchMock(payload: WireBundle, headers: Record<string, string> = {}): void {
  (globalThis as {fetch: unknown}).fetch = jest.fn(async () => ({
    ok:     true,
    status: 200,
    headers: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null,
    },
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch;
}

describe('audit P0-I2 — KeysHttpClient verifies authority binding before returning bundle', () => {
  const opts = {
    baseUrl:  'http://test.local',
    getToken: async () => 'tok',
  };

  it('passes a freshly-signed bundle through when pubkey + sig are aligned', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({authorityPrivB64: auth.privB64, userId: 'alice'});
    installFetchMock(wire);
    const client = new KeysHttpClient({...opts, authorityPubKeyB64: auth.pubB64});

    const bundle = await client.fetchPeerBundle('alice');
    expect(bundle.identityKey).toBe(wire.identityKey);
    expect(bundle.address).toEqual({userId: 'alice', deviceId: 1});

    const out = await client.fetchPeerBundleWithPoolSize('alice');
    expect(out.bundle.identityKey).toBe(wire.identityKey);
  });

  it('rejects when the server omits authoritySig in strict mode (default)', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({authorityPrivB64: auth.privB64, userId: 'alice'});
    delete wire.authoritySig;
    installFetchMock(wire);
    const client = new KeysHttpClient({...opts, authorityPubKeyB64: auth.pubB64});

    await expect(client.fetchPeerBundle('alice')).rejects.toBeInstanceOf(KeysHttpError);
    await expect(client.fetchPeerBundle('alice')).rejects.toMatchObject({
      status:  495,
      message: 'bundle_authority_sig_missing',
    });
  });

  it('accepts missing authoritySig when requireBundleBinding=false (rollback)', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({authorityPrivB64: auth.privB64, userId: 'alice'});
    delete wire.authoritySig;
    installFetchMock(wire);
    const client = new KeysHttpClient({
      ...opts,
      authorityPubKeyB64:   auth.pubB64,
      requireBundleBinding: false,
    });

    const bundle = await client.fetchPeerBundle('alice');
    expect(bundle.identityKey).toBe(wire.identityKey);
  });

  it('rejects a bundle whose identityKey was swapped on the wire', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({authorityPrivB64: auth.privB64, userId: 'alice'});
    wire.identityKey = Buffer.alloc(32, 0xee).toString('base64'); // swap AFTER signing
    installFetchMock(wire);
    const client = new KeysHttpClient({...opts, authorityPubKeyB64: auth.pubB64});

    await expect(client.fetchPeerBundle('alice')).rejects.toMatchObject({
      status:  495,
      message: expect.stringContaining('bundle_authority_sig_invalid'),
    });
  });

  it('rejects a bundle signed by a different authority key (MITM)', async () => {
    const realAuth     = await makeAuthorityKeypair(13);
    const attackerAuth = await makeAuthorityKeypair(31);
    // Server-side: a malicious keys-service signs the bundle with its OWN key.
    const wire = await makeWireBundle({
      authorityPrivB64: attackerAuth.privB64,
      userId:           'alice',
    });
    installFetchMock(wire);
    // Client-side: clients have the real pubkey pinned at build time.
    const client = new KeysHttpClient({...opts, authorityPubKeyB64: realAuth.pubB64});

    await expect(client.fetchPeerBundle('alice')).rejects.toMatchObject({
      status:  495,
      message: expect.stringContaining('bundle_authority_sig_invalid'),
    });
  });

  it('rejects a bundle whose authority signature is older than the freshness window', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({
      authorityPrivB64: auth.privB64,
      userId:           'alice',
      signedAtMs:       Date.now() - 30 * 24 * 60 * 60 * 1000, // 30d ago
    });
    installFetchMock(wire);
    const client = new KeysHttpClient({
      ...opts,
      authorityPubKeyB64:    auth.pubB64,
      bundleBindingMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7d cap
    });

    await expect(client.fetchPeerBundle('alice')).rejects.toMatchObject({
      status:  495,
      message: expect.stringContaining('expired'),
    });
  });

  it('is a no-op when no authorityPubKeyB64 is configured (legacy harness)', async () => {
    const auth = await makeAuthorityKeypair();
    const wire = await makeWireBundle({authorityPrivB64: auth.privB64, userId: 'alice'});
    delete wire.authoritySig; // no sig on the wire either
    installFetchMock(wire);
    const client = new KeysHttpClient(opts); // no pubkey pinned

    const bundle = await client.fetchPeerBundle('alice');
    expect(bundle.identityKey).toBe(wire.identityKey);
  });
});
