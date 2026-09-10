/**
 * First executable coverage for `src/modules/messenger/transport/keysClient.ts`
 * — the mobile-local KeysHttpClient that `vault/vaultOps.ts` imports directly.
 *
 * The module's whole job is FIELD-NAME TRANSLATION between our internal
 * camelCase `PreKeyBundle` and auth-service's legacy `signedPrekey` /
 * `oneTimePrekeys` casing. A silent drift there is not a crash — it is a
 * bundle the server stores with empty columns and an X3DH that fails for
 * every future peer. So the wire body is asserted key-by-key in BOTH
 * directions (legacy names present, internal names absent).
 *
 * Also pinned: the Fix #19 refresh-on-401 retry on both request paths, the
 * `X-Pre-Key-Count` header parse (including the case-fallback and the
 * non-numeric guard), the Phase-1 `deviceId: 1` hardcode, and the
 * never-throws contract of `mintActionToken`.
 *
 * WHY THE BARREL IS MOCKED: `keysClient.ts` imports `fetchWithTimeout` from
 * `@bravo/messenger-core`, which does NOT export it — see the companion
 * suite `transportKeysClientFetchBinding.test.ts`, which pins that live
 * defect. Supplying a working `fetchWithTimeout` here is what lets the
 * module's own logic actually execute, so this suite stays useful (and
 * keeps guarding the translation) once the import is repaired.
 */

const mockFetchWithTimeout = jest.fn(
  (input: string, init?: RequestInit): Promise<Response> =>
    (global as unknown as {fetch: (i: string, x?: RequestInit) => Promise<Response>}).fetch(input, init),
);
jest.mock('@bravo/messenger-core', () => ({
  __esModule: true,
  fetchWithTimeout: (input: string, init?: RequestInit) => mockFetchWithTimeout(input, init),
}));

import {KeysHttpClient, KeysHttpError} from '../transport/keysClient';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  mockFetchWithTimeout.mockClear();
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

/**
 * Minimal Response stand-in. `caseSensitiveHeaders` deliberately does NOT
 * lower-case lookups, so a test can prove the client's uppercase fallback
 * (`?? res.headers.get('X-Pre-Key-Count')`) is load-bearing.
 */
function reply(
  status: number,
  body?: unknown,
  opts: {headers?: Record<string, string>; caseSensitiveHeaders?: boolean} = {},
): Response {
  const text =
    body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const bag = opts.headers ?? {};
  const lower = Object.fromEntries(Object.entries(bag).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-text-${status}`,
    headers: {
      get: (n: string) => (opts.caseSensitiveHeaders ? bag[n] : lower[n.toLowerCase()]) ?? null,
    },
    text: async () => text,
  } as unknown as Response;
}

const BASE = 'https://auth.example.test';

interface Call {
  url: string;
  init: {method?: string; headers?: Record<string, string>; body?: string};
}
const callAt = (n: number): Call => {
  const [url, init] = fetchMock.mock.calls[n] as [string, Call['init']];
  return {url, init: init ?? {}};
};
const bodyAt = (n: number): Record<string, unknown> =>
  JSON.parse(callAt(n).init.body as string) as Record<string, unknown>;

function newClient(over: Partial<ConstructorParameters<typeof KeysHttpClient>[0]> = {}) {
  return new KeysHttpClient({
    baseUrl:  BASE,
    getToken: async () => 'tok-1',
    ...over,
  });
}

const UPLOAD_PARAMS = {
  registrationId: 4242,
  identityKey:    'IDK-b64',
  signedPreKey:   {keyId: 7, publicKey: 'SPK-b64', signature: 'SIG-b64'},
  oneTimePreKeys: [
    {keyId: 1, publicKey: 'OPK-1'},
    {keyId: 2, publicKey: 'OPK-2'},
  ],
};

const SERVER_BUNDLE = {
  registrationId:  99,
  identityKey:     'peer-IDK',
  signedPrekeyId:  3,
  signedPrekey:    'peer-SPK',
  signedPrekeySig: 'peer-SIG',
  oneTimePrekey:   {keyId: 55, publicKey: 'peer-OPK'},
};

describe('KeysHttpClient.uploadBundle — internal → legacy field translation', () => {
  it('POSTs the auth-service casing, and leaks NONE of the internal names', async () => {
    fetchMock.mockResolvedValue(reply(200, {ok: true, oneTimeKeysStored: 2, poolSize: 2}));

    await newClient().uploadBundle(UPLOAD_PARAMS);

    const {url, init} = callAt(0);
    expect(url).toBe(`${BASE}/auth/keys/upload`);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer tok-1');
    expect(init.headers?.['Content-Type']).toBe('application/json');

    const body = bodyAt(0);
    expect(body).toEqual({
      registrationId:  4242,
      identityKey:     'IDK-b64',
      signedPrekeyId:  7,
      signedPrekey:    'SPK-b64',
      signedPrekeySig: 'SIG-b64',
      oneTimePrekeys:  [
        {keyId: 1, publicKey: 'OPK-1'},
        {keyId: 2, publicKey: 'OPK-2'},
      ],
    });
    // The internal shape must not survive the boundary — auth-service would
    // silently store nulls for a `signedPreKey` object it does not know.
    expect(body).not.toHaveProperty('signedPreKey');
    expect(body).not.toHaveProperty('oneTimePreKeys');
    expect(body).not.toHaveProperty('preKey');
  });

  it('omits `oneTimePrekeys` from the wire when no OPK batch is supplied (append-only refill)', async () => {
    fetchMock.mockResolvedValue(reply(200, {ok: true, oneTimeKeysStored: 0, poolSize: 10}));

    await newClient().uploadBundle({
      registrationId: 1,
      identityKey:    'k',
      signedPreKey:   {keyId: 1, publicKey: 'p', signature: 's'},
    });

    expect(Object.keys(bodyAt(0))).not.toContain('oneTimePrekeys');
  });

  it('passes the server identity-rotation fields back to the caller (Handoff §4.5-1)', async () => {
    fetchMock.mockResolvedValue(reply(200, {
      ok: true, oneTimeKeysStored: 2, poolSize: 2,
      identityRotated: true, previousIdentityKey: 'OLD-IDK',
    }));

    await expect(newClient().uploadBundle(UPLOAD_PARAMS)).resolves.toMatchObject({
      identityRotated:     true,
      previousIdentityKey: 'OLD-IDK',
    });
  });

  it('surfaces a server rejection as KeysHttpError carrying status and message', async () => {
    fetchMock.mockResolvedValue(reply(409, {message: 'registration_id_conflict'}));

    const err = await newClient().uploadBundle(UPLOAD_PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeysHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({name: 'KeysHttpError', status: 409, message: 'registration_id_conflict'});
  });
});

describe('KeysHttpClient.mintActionToken — best-effort, never throws', () => {
  it('POSTs /auth/biometric/assert with the documented placeholder attestation', async () => {
    fetchMock.mockResolvedValue(reply(200, {actionToken: 'act-1'}));

    await expect(newClient().mintActionToken('recipient_purge')).resolves.toEqual({actionToken: 'act-1'});

    expect(callAt(0).url).toBe(`${BASE}/auth/biometric/assert`);
    expect(callAt(0).init.method).toBe('POST');
    expect(bodyAt(0)).toEqual({
      attestationToken: 'attestation-unavailable',
      platform:         'android',
      purpose:          'recipient_purge',
    });
  });

  it('forwards a real attestation token when the caller has one', async () => {
    fetchMock.mockResolvedValue(reply(200, {actionToken: 'act-2'}));

    await newClient().mintActionToken('vault-access', 'play-integrity-blob');

    expect(bodyAt(0)).toMatchObject({attestationToken: 'play-integrity-blob', purpose: 'vault-access'});
  });

  /**
   * RE-POINTED for B-697 (2026-08-29): these four used to pin "collapse to
   * null", and that collapse is exactly what hid the founder's real failure
   * for three builds (the request never reached the server and the dialog
   * could not say why). The never-THROWS property they guarded is unchanged;
   * every non-tier/attestation failure now resolves to
   * `{denied:'other', detail}` naming the failing leg — ids/status/short
   * message only, never a token.
   */
  it('an empty 200 resolves to denied:"other" with a named detail — never a throw (B-697)', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await expect(newClient().mintActionToken('vault-access'))
      .resolves.toEqual({denied: 'other', detail: 'empty_mint_response'});
  });

  it('a rejected placeholder attestation carries its status+message (B-697)', async () => {
    fetchMock.mockResolvedValue(reply(401, {message: 'attestation_invalid'}));
    await expect(newClient().mintActionToken('vault-access'))
      .resolves.toEqual({denied: 'other', detail: 'http_401:attestation_invalid'});
  });

  it('a network failure resolves (never rejects) and names the error (B-697)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(newClient().mintActionToken('vault-access'))
      .resolves.toEqual({denied: 'other', detail: 'TypeError:Network request failed'});
  });

  it('a missing access token is named as such, with no request sent (B-697)', async () => {
    await expect(newClient({getToken: async () => null}).mintActionToken('vault-access'))
      .resolves.toEqual({denied: 'other', detail: 'http_401:no_token'});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * B-591 — WHY was the proof refused? Collapsing every failure to null made a
   * lapsed Pro read as "the server declined the MFA challenge". The server's
   * two refusals travel in DIFFERENT body shapes, and only pinning both keeps
   * that true: `ForbiddenException('tier_insufficient')` arrives as a
   * `message` field, while `ForbiddenException({error: 'attestation_failed'})`
   * has NO message — the client falls back to the RAW body text, which still
   * carries the token. A future global exception filter that normalises error
   * bodies would silently break the second branch; this is the test that
   * notices.
   */
  it('maps tier_insufficient to denied:"tier" (B-591)', async () => {
    fetchMock.mockResolvedValue(reply(403, {message: 'tier_insufficient', statusCode: 403}));
    await expect(newClient().mintActionToken('vault-access')).resolves.toEqual({denied: 'tier'});
  });

  it('maps attestation_failed to denied:"attestation" even with NO message field', async () => {
    fetchMock.mockResolvedValue(reply(403, {error: 'attestation_failed', detail: 'verdict:none'}));
    await expect(newClient().mintActionToken('vault-access')).resolves.toEqual({denied: 'attestation'});
  });
});

describe('KeysHttpClient.fetchPeerBundle — legacy → internal translation', () => {
  it('GETs the peer path and rebuilds the internal PreKeyBundle shape', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE));

    const bundle = await newClient().fetchPeerBundle('peer-1');

    expect(callAt(0).url).toBe(`${BASE}/auth/keys/peer-1`);
    expect(callAt(0).init.method).toBe('GET');
    expect(callAt(0).init.body).toBeUndefined();
    expect(bundle).toEqual({
      registrationId: 99,
      // Phase-1: auth-service holds ONE identity per user, so deviceId is
      // hardcoded. If multi-device ever lands, this assertion is the alarm.
      address:        {userId: 'peer-1', deviceId: 1},
      identityKey:    'peer-IDK',
      signedPreKey:   {keyId: 3, publicKey: 'peer-SPK', signature: 'peer-SIG'},
      preKey:         {keyId: 55, publicKey: 'peer-OPK'},
    });
  });

  it('leaves `preKey` UNSET when the peer pool is exhausted (oneTimePrekey: null)', async () => {
    fetchMock.mockResolvedValue(reply(200, {...SERVER_BUNDLE, oneTimePrekey: null}));

    const bundle = await newClient().fetchPeerBundle('peer-1');

    // X3DH must fall back to the signed pre-key; an all-undefined `preKey`
    // object would be handed to libsignal as if a real OPK existed.
    expect('preKey' in bundle).toBe(false);
    expect(bundle.signedPreKey).toEqual({keyId: 3, publicKey: 'peer-SPK', signature: 'peer-SIG'});
  });

  it('percent-encodes the userId into the path', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE));

    await newClient().fetchPeerBundle('a/b?c');

    expect(callAt(0).url).toBe(`${BASE}/auth/keys/a%2Fb%3Fc`);
  });

  it('throws KeysHttpError(404) for an unknown peer instead of returning a half-built bundle', async () => {
    fetchMock.mockResolvedValue(reply(404, {message: 'no_bundle'}));

    await expect(newClient().fetchPeerBundle('ghost')).rejects.toMatchObject({
      name: 'KeysHttpError', status: 404, message: 'no_bundle',
    });
  });
});

describe('KeysHttpClient.fetchPeerBundleWithPoolSize — X-Pre-Key-Count parsing', () => {
  it('reads the pool size from the lower-cased header and returns it beside the bundle', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE, {headers: {'x-pre-key-count': '17'}}));

    const {bundle, poolSize} = await newClient().fetchPeerBundleWithPoolSize('peer-1');

    expect(poolSize).toBe(17);
    expect(bundle.address).toEqual({userId: 'peer-1', deviceId: 1});
    expect(bundle.preKey).toEqual({keyId: 55, publicKey: 'peer-OPK'});
  });

  it('falls back to the canonical-cased header name when the bag is case-SENSITIVE', async () => {
    fetchMock.mockResolvedValue(
      reply(200, SERVER_BUNDLE, {headers: {'X-Pre-Key-Count': '4'}, caseSensitiveHeaders: true}),
    );

    await expect(newClient().fetchPeerBundleWithPoolSize('peer-1')).resolves.toMatchObject({poolSize: 4});
  });

  it('reports poolSize null when the server does not send the header (pool above threshold)', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE));

    await expect(newClient().fetchPeerBundleWithPoolSize('peer-1')).resolves.toMatchObject({poolSize: null});
  });

  it('reports poolSize null — never NaN — for an unparseable header value', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE, {headers: {'x-pre-key-count': 'unknown'}}));

    const {poolSize} = await newClient().fetchPeerBundleWithPoolSize('peer-1');
    // A NaN here would make the caller's `poolSize < threshold` refill check
    // silently false forever.
    expect(poolSize).toBeNull();
    expect(Number.isNaN(poolSize as number)).toBe(false);
  });

  it('treats a zero pool as the number 0, not as "absent"', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE, {headers: {'x-pre-key-count': '0'}}));

    await expect(newClient().fetchPeerBundleWithPoolSize('peer-1')).resolves.toMatchObject({poolSize: 0});
  });

  it('sends only the Authorization header — no method, no body, no Content-Type', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE));

    await newClient().fetchPeerBundleWithPoolSize('peer-1');

    const {init} = callAt(0);
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({Authorization: 'Bearer tok-1'});
  });

  it('throws KeysHttpError(401, no_token) without a network call when getToken returns null', async () => {
    await expect(newClient({getToken: async () => null}).fetchPeerBundleWithPoolSize('p')).rejects.toMatchObject({
      name: 'KeysHttpError', status: 401, message: 'no_token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to statusText when the failure body carries no message', async () => {
    fetchMock.mockResolvedValue(reply(500, {}));

    await expect(newClient().fetchPeerBundleWithPoolSize('p')).rejects.toMatchObject({
      status: 500, message: 'status-text-500',
    });
  });

  it('falls back to statusText when the failure body is entirely empty (no parse attempted)', async () => {
    fetchMock.mockResolvedValue(reply(503));

    await expect(newClient().fetchPeerBundleWithPoolSize('p')).rejects.toMatchObject({
      name: 'KeysHttpError', status: 503, message: 'status-text-503',
    });
  });

  it('leaves `preKey` UNSET when the peer pool is exhausted', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {...SERVER_BUNDLE, oneTimePrekey: null}, {headers: {'x-pre-key-count': '0'}}),
    );

    const {bundle, poolSize} = await newClient().fetchPeerBundleWithPoolSize('peer-1');

    expect('preKey' in bundle).toBe(false);
    expect(poolSize).toBe(0);
  });

  /**
   * DOCUMENTED DIVERGENCE — `fetchPeerBundleWithPoolSize` parses with a raw
   * `JSON.parse`, while `request()` uses `safeJson`. A gateway that answers
   * 502 with an HTML body therefore surfaces as a SyntaxError from this
   * method but as a KeysHttpError(502) from every other one, so a caller
   * that catches `KeysHttpError` misses it. Pinned as CURRENT behaviour; if
   * the parse is unified on `safeJson`, this assertion becomes
   * `rejects.toMatchObject({name: 'KeysHttpError', status: 502})`.
   */
  it('DOCUMENTS: a non-JSON error body escapes as SyntaxError, not KeysHttpError', async () => {
    fetchMock.mockResolvedValue(reply(502, '<html>bad gateway</html>'));

    const err = await newClient().fetchPeerBundleWithPoolSize('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err).not.toBeInstanceOf(KeysHttpError);
  });
});

describe('KeysHttpClient — Fix #19 refresh-on-401', () => {
  it('refreshes once and retries uploadBundle with the freshly read token', async () => {
    const tokens = ['stale', 'fresh'];
    const getToken = jest.fn(async () => tokens.shift() ?? 'fresh');
    const refreshToken = jest.fn(async () => undefined);
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, {ok: true, oneTimeKeysStored: 2, poolSize: 2}));

    await expect(newClient({getToken, refreshToken}).uploadBundle(UPLOAD_PARAMS)).resolves.toMatchObject({ok: true});

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callAt(0).init.headers?.Authorization).toBe('Bearer stale');
    expect(callAt(1).init.headers?.Authorization).toBe('Bearer fresh');
    // The retry must resend the same translated body, not an empty one.
    expect(bodyAt(1)).toEqual(bodyAt(0));
  });

  it('refreshes once and retries fetchPeerBundleWithPoolSize too (its own retry loop)', async () => {
    const refreshToken = jest.fn(async () => undefined);
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, SERVER_BUNDLE, {headers: {'x-pre-key-count': '9'}}));

    await expect(newClient({refreshToken}).fetchPeerBundleWithPoolSize('peer-1'))
      .resolves.toMatchObject({poolSize: 9});

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when no refreshToken hook is wired', async () => {
    fetchMock.mockResolvedValue(reply(401, {message: 'expired'}));

    await expect(newClient().fetchPeerBundle('p')).rejects.toMatchObject({status: 401});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries at most once — a second 401 throws instead of looping', async () => {
    const refreshToken = jest.fn(async () => undefined);
    fetchMock.mockResolvedValue(reply(401, {message: 'expired'}));

    await expect(newClient({refreshToken}).fetchPeerBundle('p')).rejects.toMatchObject({status: 401});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('falls through to the original 401 when the refresh itself rejects', async () => {
    const refreshToken = jest.fn(async () => { throw new Error('refresh down'); });
    fetchMock.mockResolvedValue(reply(401, {message: 'session_expired'}));

    await expect(newClient({refreshToken}).fetchPeerBundle('p')).rejects.toMatchObject({
      status: 401, message: 'session_expired',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not run the refresh path for a non-401 failure', async () => {
    const refreshToken = jest.fn(async () => undefined);
    fetchMock.mockResolvedValue(reply(500, 'boom'));

    await expect(newClient({refreshToken}).fetchPeerBundle('p')).rejects.toMatchObject({
      status: 500, message: 'boom',
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe('KeysHttpClient — request plumbing', () => {
  it('routes every request through fetchWithTimeout, never bare fetch (SN-01 deadline)', async () => {
    fetchMock.mockResolvedValue(reply(200, SERVER_BUNDLE));

    await newClient().fetchPeerBundle('peer-1');
    await newClient().fetchPeerBundleWithPoolSize('peer-1');

    // An unbounded request on RN/OkHttp hangs for minutes on a black-holed
    // connection and stalls every queued retry behind it.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(mockFetchWithTimeout.mock.calls.length).toBe(fetchMock.mock.calls.length);
  });

  it('resolves {} for a 2xx with an empty body rather than throwing', async () => {
    fetchMock.mockResolvedValue(reply(200));

    await expect(newClient().uploadBundle(UPLOAD_PARAMS)).resolves.toEqual({});
  });

  it('uses the raw body text as the error message when the failure body is not JSON', async () => {
    fetchMock.mockResolvedValue(reply(503, 'upstream connect error'));

    await expect(newClient().fetchPeerBundle('p')).rejects.toMatchObject({
      status: 503, message: 'upstream connect error',
    });
  });

  it('uses statusText when the failure body is entirely empty', async () => {
    fetchMock.mockResolvedValue(reply(504));

    await expect(newClient().fetchPeerBundle('p')).rejects.toMatchObject({
      status: 504, message: 'status-text-504',
    });
  });
});
