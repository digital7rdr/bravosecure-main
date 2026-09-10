import {KeysHttpClient, KeysHttpError} from '../src/transport/keysClient';

/**
 * White-box coverage for the X3DH keys HTTP client: field translation on
 * upload, peer-bundle shaping (with/without one-time pre-key), the pool-size
 * header path, the 401→refresh→retry path, and the P0-I2 authority-binding
 * verify branches (no-pin skip / strict-missing / invalid-sig).
 */

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {lower[k.toLowerCase()] = v;}
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: {get: (k: string) => lower[k.toLowerCase()] ?? null},
  };
}
const token = async () => 'tok';

const BUNDLE = {
  registrationId: 11,
  identityKey: 'idk',
  signedPrekeyId: 5,
  signedPrekey: 'spk',
  signedPrekeySig: 'sig',
  oneTimePrekey: {keyId: 9, publicKey: 'opk'},
};

describe('KeysHttpClient.uploadBundle', () => {
  it('translates the internal shape into the server DTO', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {ok: true, oneTimeKeysStored: 2, poolSize: 2}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    await c.uploadBundle({
      registrationId: 1,
      identityKey: 'idk',
      signedPreKey: {keyId: 5, publicKey: 'spk', signature: 'sig'},
      oneTimePreKeys: [{keyId: 9, publicKey: 'opk'}],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      registrationId: 1, identityKey: 'idk',
      signedPrekeyId: 5, signedPrekey: 'spk', signedPrekeySig: 'sig',
      oneTimePrekeys: [{keyId: 9, publicKey: 'opk'}],
    });
  });
});

describe('KeysHttpClient.fetchPeerBundle', () => {
  it('maps the server response and attaches preKey when an OTPK is present', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const b = await c.fetchPeerBundle('alice');
    expect(b.address).toEqual({userId: 'alice', deviceId: 1});
    expect(b.signedPreKey).toEqual({keyId: 5, publicKey: 'spk', signature: 'sig'});
    expect(b.preKey).toEqual({keyId: 9, publicKey: 'opk'});
  });

  it('omits preKey when the pool is empty (oneTimePrekey null)', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {...BUNDLE, oneTimePrekey: null}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const b = await c.fetchPeerBundle('alice');
    expect(b.preKey).toBeUndefined();
  });

  it('throws KeysHttpError with the server message on non-ok', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, {message: 'no_such_user'}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const err = await c.fetchPeerBundle('ghost').catch(e => e);
    expect(err).toBeInstanceOf(KeysHttpError);
    expect(err.message).toBe('no_such_user');
  });

  it('throws 401 when no token is available', async () => {
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: async () => null});
    await expect(c.fetchPeerBundle('a')).rejects.toMatchObject({status: 401, message: 'no_token'});
  });
});

describe('KeysHttpClient.fetchPeerBundleWithPoolSize', () => {
  it('parses the X-Pre-Key-Count header', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE, {'X-Pre-Key-Count': '42'}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const {bundle, poolSize} = await c.fetchPeerBundleWithPoolSize('alice');
    expect(poolSize).toBe(42);
    expect(bundle.preKey).toEqual({keyId: 9, publicKey: 'opk'});
  });

  it('returns null poolSize when the header is absent', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    expect((await c.fetchPeerBundleWithPoolSize('alice')).poolSize).toBeNull();
  });

  it('retries once after refreshToken on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, BUNDLE, {'X-Pre-Key-Count': '7'}));
    const refreshToken = jest.fn(async () => {});
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token, refreshToken});
    const {poolSize} = await c.fetchPeerBundleWithPoolSize('alice');
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(poolSize).toBe(7);
  });
});

describe('KeysHttpClient — P0-I2 authority binding (verifyOrThrow)', () => {
  it('skips verification entirely when no authority key is pinned', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE)); // no authoritySig
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    await expect(c.fetchPeerBundle('alice')).resolves.toBeDefined();
  });

  it('strict mode (default) rejects a bundle missing the authority signature', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE)); // authoritySig absent
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token, authorityPubKeyB64: 'AAAA'});
    const err = await c.fetchPeerBundle('alice').catch(e => e);
    expect(err).toBeInstanceOf(KeysHttpError);
    expect(err.status).toBe(495);
    expect(err.message).toBe('bundle_authority_sig_missing');
  });

  it('non-strict mode accepts a bundle missing the authority signature', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, BUNDLE));
    const c = new KeysHttpClient({
      baseUrl: 'http://h', getToken: token, authorityPubKeyB64: 'AAAA', requireBundleBinding: false,
    });
    await expect(c.fetchPeerBundle('alice')).resolves.toBeDefined();
  });

  it('rejects when the authority signature fails to verify', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {
      ...BUNDLE,
      authoritySig: {sig: 'bogus', signedAtMs: 1, signedPrekeyId: 5},
    }));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token, authorityPubKeyB64: 'AAAA'});
    const err = await c.fetchPeerBundle('alice').catch(e => e);
    expect(err).toBeInstanceOf(KeysHttpError);
    expect(err.status).toBe(495);
    expect(err.message).toMatch(/bundle_authority_sig_invalid/);
  });
});
