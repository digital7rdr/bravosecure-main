/**
 * P1-9 / P1-BR-3 — durable "headless-deferred actions" queue. Actions taken from
 * a notification while the process was killed (inline Reply / Mark-read / call
 * Decline) must survive the headless VM and drain once the runtime is ready, and
 * be cleared ONLY on successful dispatch. Also covers the decline HTTP sender +
 * its client-side throttle.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
// NOT `{virtual: true}` — B-161. `@utils/constants` is a REAL module (babel
// alias), and marking the mock virtual registers the factory under the literal
// specifier while the real import still resolves to the file on disk. Which one
// wins then depends on resolution order, so this suite failed intermittently
// with the production fallback URL (`https://msg.bravosecure.com`) instead of
// the mock — one of the "moving failures" B-126 has been chasing.
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

import {
  enqueuePendingAction,
  loadPendingActions,
  removePendingAction,
  sendCallDecline,
  _resetDeclineThrottleForTests,
} from '../push/pendingActions';

beforeEach(() => {
  mockStore.clear();
  _resetDeclineThrottleForTests();
  (global as {fetch?: unknown}).fetch = undefined;
});

describe('pending-actions queue', () => {
  it('enqueues and loads an entry tagged with its bucket', async () => {
    await enqueuePendingAction({t: 'reply', convId: 'c1', text: 'hi'});
    const loaded = await loadPendingActions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({t: 'reply', convId: 'c1', text: 'hi'});
    expect(loaded[0].id).toBeTruthy();
    expect(loaded[0].__key).toContain('_global');
  });

  it('removes only the drained entry (success-only clear)', async () => {
    await enqueuePendingAction({t: 'reply', convId: 'c1', text: 'a'});
    await enqueuePendingAction({t: 'read',  convId: 'c2'});
    const loaded = await loadPendingActions();
    expect(loaded).toHaveLength(2);
    await removePendingAction(loaded.find(e => e.t === 'reply')!);
    const after = await loadPendingActions();
    expect(after).toHaveLength(1);
    expect(after[0].t).toBe('read');
  });

  it('merges the owner bucket AND the global bucket at drain', async () => {
    await enqueuePendingAction({t: 'read', convId: 'g-owned'}, 'owner-1');
    await enqueuePendingAction({t: 'read', convId: 'g-global'}); // no owner → global
    const loaded = await loadPendingActions('owner-1');
    const convIds = loaded.map(e => (e as {convId: string}).convId).sort();
    expect(convIds).toEqual(['g-global', 'g-owned']);
  });

  it('sweeps entries older than 7 days on load', async () => {
    // Seed a stale entry directly (ts far in the past).
    const key = 'bravo:pending-actions:v1:_global';
    mockStore.set(key, JSON.stringify([{t: 'read', id: 'old', convId: 'c', ts: Date.now() - 8 * 24 * 3600 * 1000}]));
    const loaded = await loadPendingActions();
    expect(loaded).toHaveLength(0);
    // The stale bucket was rewritten empty (removed).
    expect(mockStore.get(key)).toBeUndefined();
  });
});

describe('sendCallDecline', () => {
  beforeEach(() => { mockStore.set('auth:access_token', 'access-xyz'); });

  it('POSTs to /calls/:id/decline with auth + device headers and the body', async () => {
    const fetchMock = jest.fn(async () => ({ok: true, status: 200}));
    (global as {fetch?: unknown}).fetch = fetchMock as unknown as typeof fetch;
    const ok = await sendCallDecline({callId: 'call-9', peerUserId: 'peer-1', kind: 'direct'});
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://msg.test/calls/call-9/decline');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-xyz');
    expect((init.headers as Record<string, string>)['X-Signal-Device-Id']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({peerUserId: 'peer-1', kind: 'direct'});
  });

  it('returns false on a non-ok response so the caller keeps it queued', async () => {
    (global as {fetch?: unknown}).fetch = jest.fn(async () => ({ok: false, status: 500})) as unknown as typeof fetch;
    await expect(sendCallDecline({callId: 'c', kind: 'group', roomId: 'r'})).resolves.toBe(false);
  });

  it('throttles to 10 sends per 10s window (11th is refused, left queued)', async () => {
    (global as {fetch?: unknown}).fetch = jest.fn(async () => ({ok: true, status: 200})) as unknown as typeof fetch;
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) { results.push(await sendCallDecline({callId: `c${i}`, kind: 'direct', peerUserId: 'p'})); }
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results[10]).toBe(false);
  });

  it('returns false (leaves queued) when there is no access token', async () => {
    mockStore.delete('auth:access_token');
    (global as {fetch?: unknown}).fetch = jest.fn(async () => ({ok: true, status: 200})) as unknown as typeof fetch;
    await expect(sendCallDecline({callId: 'c', kind: 'direct', peerUserId: 'p'})).resolves.toBe(false);
  });
});
