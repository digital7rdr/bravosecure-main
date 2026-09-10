/**
 * First executable coverage for `src/modules/messenger/transport/usersClient.ts`
 * (the mobile-local UsersHttpClient — the copy `transport/index.ts` re-exports).
 *
 * Everything here runs the REAL client against a mocked `global.fetch`, so the
 * assertions are about wire shape and control flow, not source text:
 *
 *   - the request contract: method, path, Authorization, the Content-Type that
 *     must appear ONLY when there is a body, and the JSON body itself;
 *   - Fix #19 refresh-on-401 — fires once, re-reads getToken (a retry that
 *     replays the STALE token is the bug this exists to prevent), never loops,
 *     and falls through to the original 401 when the refresh itself throws;
 *   - the error-message ladder (parsed `.message` → raw text → statusText);
 *   - the empty-input short-circuits and the 500-id chunking loop in
 *     `getProfilesByIds`, including Set dedupe across the chunk boundary.
 */

import {
  UsersHttpClient,
  UsersHttpError,
  type Me,
} from '../transport/usersClient';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

/** Minimal Response stand-in — only the members the client actually touches. */
function reply(status: number, body?: unknown): Response {
  const text =
    body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-text-${status}`,
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
  return {url, init};
};
const bodyAt = (n: number): unknown => JSON.parse(callAt(n).init.body as string);

function newClient(over: Partial<ConstructorParameters<typeof UsersHttpClient>[0]> = {}) {
  return new UsersHttpClient({
    baseUrl:  BASE,
    getToken: async () => 'tok-1',
    ...over,
  });
}

const ME: Me = {
  id:                  'u-1',
  displayName:         'Bow Rani',
  phoneE164:           '+8801700000000',
  email:               'bow@example.test',
  bio:                 null,
  avatarUrl:           null,
  lastSeenVisible:     true,
  readReceiptsEnabled: true,
};

describe('UsersHttpClient — request contract', () => {
  it('POSTs /users/lookup with the phones body, bearer token and JSON content-type', async () => {
    fetchMock.mockResolvedValue(reply(200, {matches: [{phone: '+1555', userId: 'u-9', displayName: 'N', avatarUrl: null}]}));

    const out = await newClient().lookup(['+1555', '+1666']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const {url, init} = callAt(0);
    expect(url).toBe(`${BASE}/users/lookup`);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer tok-1');
    expect(init.headers?.['Content-Type']).toBe('application/json');
    expect(bodyAt(0)).toEqual({phones: ['+1555', '+1666']});
    expect(out).toEqual([{phone: '+1555', userId: 'u-9', displayName: 'N', avatarUrl: null}]);
  });

  it('omits Content-Type and body entirely on a bodyless GET', async () => {
    fetchMock.mockResolvedValue(reply(200, ME));

    await newClient().me();

    const {url, init} = callAt(0);
    expect(url).toBe(`${BASE}/users/me`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    // A Content-Type on a bodyless request is what makes some gateways
    // reject the call outright; the client must not emit one.
    expect(Object.keys(init.headers ?? {})).toEqual(['Authorization']);
  });

  it('PATCHes /users/me with the patch object verbatim', async () => {
    fetchMock.mockResolvedValue(reply(200, ME));

    await newClient().updateMe({displayName: 'New Name', avatarUrl: null});

    expect(callAt(0).url).toBe(`${BASE}/users/me`);
    expect(callAt(0).init.method).toBe('PATCH');
    expect(bodyAt(0)).toEqual({displayName: 'New Name', avatarUrl: null});
  });

  it('PATCHes the privacy sub-resource, not /users/me', async () => {
    fetchMock.mockResolvedValue(reply(200, ME));

    await newClient().updatePrivacy({lastSeenVisible: false});

    expect(callAt(0).url).toBe(`${BASE}/users/me/privacy`);
    expect(callAt(0).init.method).toBe('PATCH');
    expect(bodyAt(0)).toEqual({lastSeenVisible: false});
  });

  it('POSTs a block and DELETEs an unblock with the userId percent-encoded into the path', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    const c = newClient();

    await c.block('u-2');
    expect(callAt(0).url).toBe(`${BASE}/users/block`);
    expect(callAt(0).init.method).toBe('POST');
    expect(bodyAt(0)).toEqual({userId: 'u-2'});

    // A raw id would break the path (or worse, escape the segment).
    await c.unblock('a/b?c#d');
    expect(callAt(1).url).toBe(`${BASE}/users/block/a%2Fb%3Fc%23d`);
    expect(callAt(1).init.method).toBe('DELETE');
    expect(callAt(1).init.body).toBeUndefined();
  });

  it('GETs /users/blocked and unwraps the blocked list', async () => {
    fetchMock.mockResolvedValue(reply(200, {blocked: [{userId: 'u-3', displayName: 'B', avatarUrl: null}]}));

    await expect(newClient().listBlocked()).resolves.toEqual([
      {userId: 'u-3', displayName: 'B', avatarUrl: null},
    ]);
  });
});

describe('UsersHttpClient — empty-input short circuits', () => {
  it('lookup([]) resolves empty WITHOUT touching the network (rate limit is 20/hr)', async () => {
    await expect(newClient().lookup([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getProfilesByIds([]) resolves empty WITHOUT touching the network', async () => {
    await expect(newClient().getProfilesByIds([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getProfilesByIds with only duplicates still issues exactly one request', async () => {
    fetchMock.mockResolvedValue(reply(200, {profiles: []}));

    await newClient().getProfilesByIds(['u-1', 'u-1', 'u-1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyAt(0)).toEqual({userIds: ['u-1']});
  });
});

describe('UsersHttpClient — response unwrapping tolerates a thin server', () => {
  it('lookup returns [] when the server omits `matches`', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await expect(newClient().lookup(['+1'])).resolves.toEqual([]);
  });

  it('getProfilesByIds returns [] when the server omits `profiles`', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await expect(newClient().getProfilesByIds(['u-1'])).resolves.toEqual([]);
  });

  it('listBlocked returns [] when the server omits `blocked`', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await expect(newClient().listBlocked()).resolves.toEqual([]);
  });

  it('a 200 with an EMPTY body resolves to {} rather than throwing on JSON.parse', async () => {
    fetchMock.mockResolvedValue(reply(200));
    await expect(newClient().me()).resolves.toEqual({});
  });

  it('a 200 with unparseable JSON resolves to {} (safeJson swallows the parse error)', async () => {
    fetchMock.mockResolvedValue(reply(200, '<html>gateway</html>'));
    await expect(newClient().me()).resolves.toEqual({});
  });
});

describe('UsersHttpClient — getProfilesByIds chunking (server caps at 500)', () => {
  it('splits 1200 unique ids into 500 / 500 / 200 and concatenates the results in order', async () => {
    const ids = Array.from({length: 1200}, (_, i) => `u-${i}`);
    fetchMock.mockImplementation(async (_url: string, init: {body: string}) => {
      const {userIds} = JSON.parse(init.body) as {userIds: string[]};
      return reply(200, {profiles: userIds.map(u => ({userId: u, displayName: u, avatarUrl: null}))});
    });

    const out = await newClient().getProfilesByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((bodyAt(0) as {userIds: string[]}).userIds).toHaveLength(500);
    expect((bodyAt(1) as {userIds: string[]}).userIds).toHaveLength(500);
    expect((bodyAt(2) as {userIds: string[]}).userIds).toHaveLength(200);
    expect(out).toHaveLength(1200);
    expect(out[0].userId).toBe('u-0');
    expect(out[1199].userId).toBe('u-1199');
  });

  it('dedupes BEFORE chunking — 600 slots holding 500 unique ids is one request, not two', async () => {
    const ids = [
      ...Array.from({length: 500}, (_, i) => `u-${i}`),
      ...Array.from({length: 100}, (_, i) => `u-${i}`), // repeats
    ];
    fetchMock.mockResolvedValue(reply(200, {profiles: []}));

    await newClient().getProfilesByIds(ids);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((bodyAt(0) as {userIds: string[]}).userIds).toHaveLength(500);
  });
});

describe('UsersHttpClient — auth failures and Fix #19 refresh-on-401', () => {
  it('throws UsersHttpError(401, no_token) and never calls fetch when getToken resolves null', async () => {
    const c = newClient({getToken: async () => null});

    await expect(c.me()).rejects.toMatchObject({
      name:    'UsersHttpError',
      status:  401,
      message: 'no_token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('UsersHttpError is a real Error subclass carrying the status', async () => {
    fetchMock.mockResolvedValue(reply(403, {message: 'forbidden'}));
    const err = await newClient().me().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UsersHttpError);
    expect((err as UsersHttpError).status).toBe(403);
  });

  it('on 401 refreshes once and retries with the FRESHLY read token', async () => {
    const tokens = ['stale', 'fresh'];
    const getToken = jest.fn(async () => tokens.shift() ?? 'fresh');
    const refreshToken = jest.fn(async () => undefined);
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, ME));

    await expect(newClient({getToken, refreshToken}).me()).resolves.toMatchObject({id: 'u-1'});

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callAt(0).init.headers?.Authorization).toBe('Bearer stale');
    // The whole point of Fix #19: the retry must NOT replay the stale token.
    expect(callAt(1).init.headers?.Authorization).toBe('Bearer fresh');
  });

  it('does NOT retry a 401 when no refreshToken hook is wired', async () => {
    fetchMock.mockResolvedValue(reply(401, {message: 'expired'}));

    await expect(newClient().me()).rejects.toMatchObject({status: 401, message: 'expired'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries at most ONCE — a second 401 after refresh throws instead of looping', async () => {
    const refreshToken = jest.fn(async () => undefined);
    fetchMock.mockResolvedValue(reply(401, {message: 'still expired'}));

    await expect(newClient({refreshToken}).me()).rejects.toMatchObject({status: 401});
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through to the ORIGINAL 401 when the refresh itself rejects', async () => {
    const refreshToken = jest.fn(async () => { throw new Error('refresh endpoint down'); });
    fetchMock.mockResolvedValue(reply(401, {message: 'session_expired'}));

    await expect(newClient({refreshToken}).me()).rejects.toMatchObject({
      name:    'UsersHttpError',
      status:  401,
      message: 'session_expired',
    });
    // The refresh threw, so the retry send() never happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not run the refresh path for a non-401 failure', async () => {
    const refreshToken = jest.fn(async () => undefined);
    fetchMock.mockResolvedValue(reply(500, {message: 'boom'}));

    await expect(newClient({refreshToken}).me()).rejects.toMatchObject({status: 500});
    expect(refreshToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a transport-level fetch rejection untouched (no wrapping, no retry)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));

    await expect(newClient().me()).rejects.toThrow('Network request failed');
    await expect(newClient().me()).rejects.not.toBeInstanceOf(UsersHttpError);
  });
});

describe('UsersHttpClient — error-message ladder', () => {
  it('prefers the parsed JSON `message` field', async () => {
    fetchMock.mockResolvedValue(reply(409, {message: 'already_blocked', code: 'CONFLICT'}));
    await expect(newClient().block('u-2')).rejects.toMatchObject({
      status:  409,
      message: 'already_blocked',
    });
  });

  it('falls back to the raw body text when the response is not JSON', async () => {
    fetchMock.mockResolvedValue(reply(502, 'upstream connect error'));
    await expect(newClient().me()).rejects.toMatchObject({
      status:  502,
      message: 'upstream connect error',
    });
  });

  it('falls back to statusText when the failure body is empty', async () => {
    fetchMock.mockResolvedValue(reply(503));
    await expect(newClient().me()).rejects.toMatchObject({
      status:  503,
      message: 'status-text-503',
    });
  });

  it('falls back to the body text when the JSON body carries no `message` key', async () => {
    fetchMock.mockResolvedValue(reply(400, {error: 'bad_request'}));
    await expect(newClient().me()).rejects.toMatchObject({
      status:  400,
      message: '{"error":"bad_request"}',
    });
  });
});
