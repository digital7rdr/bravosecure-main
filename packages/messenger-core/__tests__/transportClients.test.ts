import {SenderCertClient, SenderCertHttpError} from '../src/transport/senderCertClient';
import {UsersHttpClient, UsersHttpError} from '../src/transport/usersClient';
import {RelayHttpClient, RelayHttpError} from '../src/transport/relayClient';

/**
 * White-box coverage for the auth-service/relay HTTP clients: happy path,
 * no-token 401, refresh-on-401 retry (Fix #19), error-body parsing, the
 * 204 path, query-string building, and the chunking loop.
 */

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

function reply(status: number, body: unknown, headers?: Record<string, string>) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const base = {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => text,
  };
  if (!headers) {return base;}
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {...base, headers: {get: (n: string) => lower[n.toLowerCase()] ?? null}};
}
const token = async () => 'tok';
const noToken = async () => null;

describe('SenderCertClient', () => {
  it('issueCert posts and returns the parsed cert', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {cert: 'c', expiresAt: 99}));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    const out = await c.issueCert({senderSignalDeviceId: 1, senderIdentityKey: 'k'});
    expect(out).toEqual({cert: 'c', expiresAt: 99});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://h/sender-cert');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('issueCert throws 401 when no token', async () => {
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: noToken});
    await expect(c.issueCert({senderSignalDeviceId: 1, senderIdentityKey: 'k'})).rejects.toMatchObject({
      status: 401,
      message: 'no_token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issueCert retries once after refreshToken on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, {cert: 'c2', expiresAt: 1}));
    const refreshToken = jest.fn(async () => {});
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token, refreshToken});
    const out = await c.issueCert({senderSignalDeviceId: 1, senderIdentityKey: 'k'});
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(out.cert).toBe('c2');
  });

  it('issueCert surfaces the server message on error', async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {message: 'boom'}));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    const err = await c.issueCert({senderSignalDeviceId: 1, senderIdentityKey: 'k'}).catch(e => e);
    expect(err).toBeInstanceOf(SenderCertHttpError);
    expect(err.message).toMatch(/boom/);
    expect(err.status).toBe(500);
  });

  it('revokeCert treats 404 as backendMissing', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, ''));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    expect(await c.revokeCert('j')).toEqual({revoked: false, backendMissing: true});
  });

  it('revokeCert returns revoked on ok and throws on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, ''));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    expect(await c.revokeCert('j')).toEqual({revoked: true, backendMissing: false});
    fetchMock.mockResolvedValueOnce(reply(503, 'down'));
    await expect(c.revokeCert('j')).rejects.toThrow(/down/);
  });

  it('revokeCert throws 401 with no token', async () => {
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: noToken});
    await expect(c.revokeCert('j')).rejects.toMatchObject({status: 401});
  });

  it('fetchRevocationList filters non-string jtis and defaults asOf', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {jtis: ['a', 2, 'b', null]}));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    const out = await c.fetchRevocationList();
    expect(out.jtis).toEqual(['a', 'b']);
    expect(typeof out.asOf).toBe('number');
  });

  it('fetchRevocationList tolerates a missing jtis array', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {asOf: 5}));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    expect(await c.fetchRevocationList()).toEqual({jtis: [], asOf: 5});
  });

  it('fetchRevocationList throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(reply(429, {message: 'slow down'}));
    const c = new SenderCertClient({baseUrl: 'http://h', getToken: token});
    await expect(c.fetchRevocationList()).rejects.toThrow(/slow down/);
  });
});

describe('UsersHttpClient', () => {
  it('lookup short-circuits on an empty list (no fetch)', async () => {
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    expect(await c.lookup([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lookup returns matches', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {matches: [{phone: '+1', userId: 'u', displayName: 'D', avatarUrl: null}]}));
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    const out = await c.lookup(['+1']);
    expect(out[0].userId).toBe('u');
  });

  it('getProfilesByIds dedups and chunks at 500 (loop boundary)', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, {profiles: [{userId: 'a', displayName: 'A', avatarUrl: null}]}))
      .mockResolvedValueOnce(reply(200, {profiles: [{userId: 'b', displayName: 'B', avatarUrl: null}]}));
    const ids = Array.from({length: 600}, (_, i) => `id${i}`);
    ids.push('id0'); // duplicate — must be deduped before chunking
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    const out = await c.getProfilesByIds(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 600 unique -> [500,100]
    expect(out.map(p => p.userId)).toEqual(['a', 'b']);
  });

  it('getProfilesByIds short-circuits when empty', async () => {
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    expect(await c.getProfilesByIds([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('me / updateMe / privacy / block / unblock / listBlocked hit the right verbs+paths', async () => {
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    fetchMock.mockResolvedValueOnce(reply(200, {id: 'me'}));
    await c.me();
    fetchMock.mockResolvedValueOnce(reply(200, {id: 'me'}));
    await c.updateMe({displayName: 'X'});
    fetchMock.mockResolvedValueOnce(reply(200, {id: 'me'}));
    await c.updatePrivacy({lastSeenVisible: false});
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await c.block('u');
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await c.unblock('u');
    fetchMock.mockResolvedValueOnce(reply(200, {blocked: [{userId: 'u', displayName: 'D', avatarUrl: null}]}));
    expect(await c.listBlocked()).toHaveLength(1);
    const methods = fetchMock.mock.calls.map(call => call[1].method);
    expect(methods).toEqual(['GET', 'PATCH', 'PATCH', 'POST', 'DELETE', 'GET']);
  });

  it('propagates a non-ok error as UsersHttpError', async () => {
    fetchMock.mockResolvedValueOnce(reply(403, {message: 'forbidden'}));
    const c = new UsersHttpClient({baseUrl: 'http://h', getToken: token});
    await expect(c.me().catch(e => e)).resolves.toBeInstanceOf(UsersHttpError);
  });
});

describe('RelayHttpClient', () => {
  const base = {baseUrl: 'http://h', getToken: token, signalDeviceId: 7};

  it('send posts the envelope with the device-id header', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {envelopeId: 'e', deliveredNow: true}));
    const c = new RelayHttpClient(base);
    const out = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'blob'});
    expect(out.envelopeId).toBe('e');
    expect(fetchMock.mock.calls[0][1].headers['X-Signal-Device-Id']).toBe('7');
  });

  it('pull builds the query string from after/limit/bootstrap', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {envelopes: []}));
    const c = new RelayHttpClient(base);
    await c.pull({after: 10, limit: 50, bootstrap: true});
    expect(fetchMock.mock.calls[0][0]).toBe('http://h/envelopes?after=10&limit=50&bootstrap=1');
  });

  it('pull with no options omits the query string', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {envelopes: []}));
    const c = new RelayHttpClient(base);
    await c.pull();
    expect(fetchMock.mock.calls[0][0]).toBe('http://h/envelopes');
  });

  it('ack sends a body only when an ackToken is supplied', async () => {
    const c = new RelayHttpClient(base);
    fetchMock.mockResolvedValueOnce(reply(204, ''));
    await c.ack('e1');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    fetchMock.mockResolvedValueOnce(reply(204, ''));
    await c.ack('e1', 'tkn');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ackToken: 'tkn'});
  });

  it('returns undefined on a 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(reply(204, ''));
    const c = new RelayHttpClient(base);
    await expect(c.retract('rt')).resolves.toBeUndefined();
  });

  it('refreshes once and retries on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, {message: 'expired'}))
      .mockResolvedValueOnce(reply(200, {envelopeId: 'e', deliveredNow: false}));
    const refreshToken = jest.fn(async () => {});
    const c = new RelayHttpClient({...base, refreshToken});
    const out = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'});
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(out.envelopeId).toBe('e');
  });

  it('throws RelayHttpError carrying the server code', async () => {
    fetchMock.mockResolvedValueOnce(reply(409, {message: 'dup', code: 'duplicate'}));
    const c = new RelayHttpClient(base);
    const err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect(err.code).toBe('duplicate');
  });

  it('throws 401 with no token (no refresh configured)', async () => {
    const c = new RelayHttpClient({...base, getToken: noToken});
    await expect(c.pull()).rejects.toMatchObject({status: 401, message: 'no_token'});
  });

  it('purgeStaleRecipientQueue sends the MFA proof header when provided', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {purged: 3}));
    const c = new RelayHttpClient(base);
    const out = await c.purgeStaleRecipientQueue('oldId', 'mfa');
    expect(out.purged).toBe(3);
    expect(fetchMock.mock.calls[0][1].headers['X-Mfa-Proof']).toBe('mfa');
  });

  // XO-3 — the relay's throttler answers 429 with Retry-After; the durable
  // outbox reschedules on it instead of guessing a backoff against a full
  // bucket. A server that omits the header must yield undefined, not a throw.
  it('carries a delta-seconds Retry-After off a 429 as retryAfterMs', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(429, {message: 'ThrottlerException: Too Many Requests'}, {'Retry-After': '7'}),
    );
    const c = new RelayHttpClient(base);
    const err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
  });

  it('parses an HTTP-date Retry-After', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    fetchMock.mockResolvedValueOnce(reply(429, {message: 'slow'}, {'Retry-After': at}));
    const c = new RelayHttpClient(base);
    const err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
    expect(err.retryAfterMs).toBeGreaterThan(25_000);
    expect(err.retryAfterMs).toBeLessThan(31_000);
  });

  it('leaves retryAfterMs undefined for a garbage header, a 503, and a header-less fake', async () => {
    const c = new RelayHttpClient(base);
    fetchMock.mockResolvedValueOnce(reply(429, {message: 'slow'}, {'Retry-After': 'garbage'}));
    let err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect(err.retryAfterMs).toBeUndefined();

    fetchMock.mockResolvedValueOnce(reply(503, {message: 'down'}));
    err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBeUndefined();
  });

  // GF-1 — every submit in the mobile runtime shares ONE server bucket, so
  // they must share one client budget. pull/ack/retract are separate buckets
  // and must NOT be gated.
  it('routes send through sendGate and leaves the result untouched', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {envelopeId: 'e', deliveredNow: true}));
    let gated = 0;
    const sendGate = <T>(fn: () => Promise<T>): Promise<T> => { gated += 1; return fn(); };
    const c = new RelayHttpClient({...base, sendGate});
    const out = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'blob'});
    expect(gated).toBe(1);
    expect(out.envelopeId).toBe('e');
  });

  it('does not gate pull / ack / retract', async () => {
    let gated = 0;
    const sendGate = <T>(fn: () => Promise<T>): Promise<T> => { gated += 1; return fn(); };
    const c = new RelayHttpClient({...base, sendGate});
    fetchMock.mockResolvedValueOnce(reply(200, {envelopes: []}));
    await c.pull();
    fetchMock.mockResolvedValueOnce(reply(204, ''));
    await c.ack('e1');
    fetchMock.mockResolvedValueOnce(reply(204, ''));
    await c.retract('rt');
    expect(gated).toBe(0);
  });
});
