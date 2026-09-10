/**
 * B-706 A-3 / A-2 — a cleared notification must STAY cleared.
 *
 * The founder's report was "I delete the notification, again it came back." Two mechanisms
 * combined to guarantee it:
 *
 *   A-3  `Clear` was a local `set({rows: []})`. The server had no delete surface at all,
 *        so it never learned, and the next sync handed the rows back.
 *   A-2  `created_at` is a microsecond column but the API can only emit the millisecond a
 *        JS `Date` holds, so `created_at > $since` matched the newest row against its own
 *        truncated cursor on EVERY sync — measured at 500/500 live rows. The row the user
 *        just deleted was therefore the one guaranteed to return, unread.
 *
 * The server now stamps `dismissed_at` and filters it. This suite pins the CLIENT half:
 * a local tombstone ledger, which is what survives an offline Clear, a failed dismiss POST,
 * and an old server that does not know the column yet.
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
jest.mock('@services/jwtClaims', () => ({
  decodeAccessTokenClaims: () => ({sub: 'founder', role: 'client'}),
}));
jest.mock('@services/tokenVault', () => ({
  tokenVault: {getAccess: jest.fn(async () => 'token-founder')},
}));

import {syncActivityFromServer, clearActivitySynced} from '@store/activitySync';
import {useActivityStore} from '@store/activityStore';

const mockFetch = jest.fn();
(global as unknown as {fetch: unknown}).fetch = mockFetch;

const ROW = {
  id: 'srv-uuid-1', kind: 'booking-approved', eventClass: 'booking',
  createdAt: '2026-08-25T11:16:02.090Z', read: false,
};

function respondWithRows(rows: unknown[]) {
  mockFetch.mockResolvedValueOnce({ok: true, json: async () => ({notifications: rows})});
}
function okPost() {
  mockFetch.mockResolvedValueOnce({ok: true, status: 200, json: async () => ({ok: true})});
}
const ids = () => useActivityStore.getState().rows.map(r => r.id);

describe('B-706 A-3 — Clear is durable', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockAsyncStore)) {delete mockAsyncStore[k];}
    mockFetch.mockReset();
    useActivityStore.setState({rows: [], ownerKey: null, dismissedIds: []});
  });

  it('a cleared row is NOT re-added by the very next sync (the founder repro)', async () => {
    respondWithRows([ROW]);
    await syncActivityFromServer();
    expect(ids()).toEqual(['srv-uuid-1']);

    okPost();
    await clearActivitySynced();
    expect(ids()).toEqual([]);

    // A-2: the ms-truncated watermark hands the same row straight back.
    respondWithRows([ROW]);
    await syncActivityFromServer();
    expect(ids()).toEqual([]);              // ← was ['srv-uuid-1'] before the fix
  });

  it('tells the SERVER, so a reinstall or a second device does not resurrect it', async () => {
    useActivityStore.setState({rows: [
      {id: 'a', eventClass: 'booking', kind: 'k', title: 't', ts: '2026-08-01T00:00:00.000Z', read: true},
    ], dismissedIds: []});
    okPost();
    await clearActivitySynced();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/me/notifications/dismiss');
    expect(init.method).toBe('POST');
    // `{all:true}`, never `{ids}` — local ids are a mix of FCM eventIds and server
    // uuids, and the server's uuid filter would silently drop every eventId.
    expect(JSON.parse(String(init.body))).toEqual({all: true});
  });

  it('an OFFLINE clear still sticks — the tombstone does not depend on the POST', async () => {
    respondWithRows([ROW]);
    await syncActivityFromServer();

    mockFetch.mockRejectedValueOnce(new Error('offline'));
    await clearActivitySynced();
    expect(ids()).toEqual([]);

    respondWithRows([ROW]);
    await syncActivityFromServer();
    expect(ids()).toEqual([]);
  });

  it('a genuinely NEW notification still arrives after a clear', async () => {
    respondWithRows([ROW]);
    await syncActivityFromServer();
    okPost();
    await clearActivitySynced();

    respondWithRows([
      ROW, // still suppressed
      {id: 'srv-uuid-2', kind: 'crew-assigned', eventClass: 'booking',
       createdAt: '2026-08-29T10:00:00.000Z', read: false},
    ]);
    await syncActivityFromServer();
    expect(ids()).toEqual(['srv-uuid-2']);
  });

  it('remove(id) tombstones just that row', () => {
    useActivityStore.setState({rows: [], dismissedIds: []});
    useActivityStore.getState().append({id: 'x', eventClass: 'booking', kind: 'k', title: 'X'});
    useActivityStore.getState().append({id: 'y', eventClass: 'booking', kind: 'k', title: 'Y'});
    useActivityStore.getState().remove('x');

    expect(ids()).toEqual(['y']);
    useActivityStore.getState().append({id: 'x', eventClass: 'booking', kind: 'k', title: 'X'});
    expect(ids()).toEqual(['y']);
  });

  it('a DIFFERENT identity on the device inherits no tombstones', () => {
    useActivityStore.setState({rows: [], ownerKey: 'user-A', dismissedIds: ['shared-id']});
    useActivityStore.getState().setOwner('user-B');
    expect(useActivityStore.getState().dismissedIds).toEqual([]);

    useActivityStore.getState().append({id: 'shared-id', eventClass: 'booking', kind: 'k', title: 'B row'});
    expect(ids()).toEqual(['shared-id']);
  });

  /**
   * Caught by the self-diff pass, not by any suite — the exact class the founder's
   * standing rule exists for. `clear()` grew tombstones, and `authStore.signOut` called
   * `clear()`. Signing out and back in on the SAME account would then have suppressed the
   * user's entire history forever, because `setOwner` only drops the ledger when the
   * identity CHANGES. A privacy wipe is not a user deletion.
   */
  it('SIGN-OUT wipes without tombstoning — the same account signing back in sees its feed', async () => {
    respondWithRows([ROW]);
    await syncActivityFromServer();
    expect(ids()).toEqual(['srv-uuid-1']);

    // What authStore.signOut does.
    useActivityStore.getState().wipeLocal();
    expect(ids()).toEqual([]);
    expect(useActivityStore.getState().dismissedIds).toEqual([]);

    // Same identity signs back in; resetActivitySyncWatermark cleared the cursor, so the
    // full inbox is re-fetched. It must come back.
    useActivityStore.getState().setOwner('same-user');
    respondWithRows([ROW]);
    await syncActivityFromServer();
    expect(ids()).toEqual(['srv-uuid-1']);
  });

  it('the ledger is FIFO-capped so it cannot grow without bound', () => {
    useActivityStore.setState({rows: [], dismissedIds: []});
    const many = Array.from({length: 600}, (_, i) => ({
      id: `n${i}`, eventClass: 'booking' as const, kind: 'k', title: 'T',
      ts: new Date(1_800_000_000_000 + i * 1000).toISOString(),
    }));
    useActivityStore.getState().appendMany(many);
    useActivityStore.getState().clear();

    const ledger = useActivityStore.getState().dismissedIds;
    expect(ledger.length).toBeLessThanOrEqual(500);
    // MAX_ROWS caps the feed at 200, so only what was actually held gets tombstoned.
    expect(ledger.length).toBeGreaterThan(0);
  });
});
