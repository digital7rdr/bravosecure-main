/**
 * MOB-6 — the activity-sync watermark must be PER USER. It used to be one global
 * AsyncStorage key, and the reset that was meant to clear it on sign-out had no
 * prod caller. So user B, signing in on a device where user A had synced, fetched
 * `/me/notifications?since=<A's newest ts>` and silently MISSED every notification
 * older than A's cursor. These tests pin that B never inherits A's watermark, and
 * that the reset purges every per-user key.
 */
const mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockAsyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockAsyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mockAsyncStore[k]; }),
    getAllKeys: jest.fn(async () => Object.keys(mockAsyncStore)),
    multiRemove: jest.fn(async (ks: string[]) => { ks.forEach(k => delete mockAsyncStore[k]); }),
  },
}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://api.test'}));
// token string is `token-<sub>`; decode returns that sub.
jest.mock('@services/jwtClaims', () => ({
  decodeAccessTokenClaims: (t: string | null | undefined) =>
    (t?.startsWith('token-') ? {sub: t.slice('token-'.length), role: 'client'} : null),
}));
let mockCurrentAccess: string | null = null;
jest.mock('@services/tokenVault', () => ({
  tokenVault: {getAccess: jest.fn(async () => mockCurrentAccess)},
}));
const mockAppend = jest.fn();
// B-706 A-1 — the sync now commits a whole page in ONE set() via appendMany.
// This mock forwards each row to mockAppend so the per-row assertions below keep
// meaning what they meant.
const mockAppendMany = jest.fn((rows: unknown[]) => {rows.forEach(r => mockAppend(r));});
jest.mock('@store/activityStore', () => ({
  useActivityStore: {getState: () => ({append: mockAppend, appendMany: mockAppendMany})},
}));

import {syncActivityFromServer, resetActivitySyncWatermark} from '@store/activitySync';

const WATERMARK_PREFIX = 'bravo:activity-sync-watermark';
const mockFetch = jest.fn();

(global as any).fetch = mockFetch;

function respondWith(rows: Array<{id: string; kind: string; eventClass: string; createdAt: string}>) {
  mockFetch.mockResolvedValueOnce({ok: true, json: async () => ({notifications: rows})});
}
function lastFetchUrl(): string {
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1][0] as string;
}

describe('MOB-6 — activity-sync watermark is per-user', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockAsyncStore)) {delete mockAsyncStore[k];}
    mockFetch.mockReset();
    mockAppend.mockReset();
    mockAppendMany.mockClear();
  });

  it('writes the cursor under a per-user key, not a global one', async () => {
    mockCurrentAccess = 'token-userA';
    respondWith([{id: 'n1', kind: 'booking-approved', eventClass: 'booking', createdAt: '2026-08-28T10:00:00Z'}]);
    await syncActivityFromServer();
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userA`]).toBe('2026-08-28T10:00:00Z');
    // The legacy global key is never written.
    expect(mockAsyncStore[WATERMARK_PREFIX]).toBeUndefined();
  });

  it('user B does NOT inherit user A\'s cursor — B fetches its full inbox', async () => {
    // A syncs and advances its cursor to 10:00.
    mockCurrentAccess = 'token-userA';
    respondWith([{id: 'a1', kind: 'booking-approved', eventClass: 'booking', createdAt: '2026-08-28T10:00:00Z'}]);
    await syncActivityFromServer();
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userA`]).toBe('2026-08-28T10:00:00Z');

    // B signs in on the SAME device. With the old global key B would fetch
    // ?since=2026-08-28T10:00:00Z and miss everything older. Per-user key => no since.
    mockCurrentAccess = 'token-userB';
    respondWith([{id: 'b1', kind: 'booking-approved', eventClass: 'booking', createdAt: '2026-08-27T09:00:00Z'}]);
    await syncActivityFromServer();
    const url = lastFetchUrl();
    expect(url).not.toContain('since=');
    // B still stores ITS own cursor separately; A's is untouched.
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userB`]).toBe('2026-08-27T09:00:00Z');
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userA`]).toBe('2026-08-28T10:00:00Z');
  });

  it('sends since= only when THIS user already has a cursor', async () => {
    mockCurrentAccess = 'token-userA';
    mockAsyncStore[`${WATERMARK_PREFIX}:userA`] = '2026-08-28T08:00:00Z';
    respondWith([{id: 'n2', kind: 'booking-approved', eventClass: 'booking', createdAt: '2026-08-28T11:00:00Z'}]);
    await syncActivityFromServer();
    expect(lastFetchUrl()).toContain(`since=${encodeURIComponent('2026-08-28T08:00:00Z')}`);
  });

  it('skips entirely when the token carries no usable sub (never crosses accounts)', async () => {
    mockCurrentAccess = 'not-a-bravo-token';
    await syncActivityFromServer();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reset purges every per-user watermark (and the legacy global key)', async () => {
    mockAsyncStore[`${WATERMARK_PREFIX}:userA`] = 'x';
    mockAsyncStore[`${WATERMARK_PREFIX}:userB`] = 'y';
    mockAsyncStore[WATERMARK_PREFIX] = 'legacy';
    mockAsyncStore['unrelated:key'] = 'keep';
    await resetActivitySyncWatermark();
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userA`]).toBeUndefined();
    expect(mockAsyncStore[`${WATERMARK_PREFIX}:userB`]).toBeUndefined();
    expect(mockAsyncStore[WATERMARK_PREFIX]).toBeUndefined();
    expect(mockAsyncStore['unrelated:key']).toBe('keep');
  });
});
