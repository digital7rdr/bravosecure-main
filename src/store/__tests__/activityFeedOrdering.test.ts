/**
 * B-706 A-1 — the Activity feed must render NEWEST FIRST.
 *
 * The server returns `ORDER BY created_at DESC` (newest first) and the client looped that
 * page calling `append()`, which PREPENDS. Each prepend reversed the page, so after a cold
 * sync the feed rendered OLDEST FIRST: the founder's screenshot was his own account with
 * July rows on top and his newest (5 days old) below the fold, every visible row "50d".
 *
 * Unlike `activitySync.test.ts` — which mocks `append` with a `jest.fn()` and therefore
 * cannot see ordering at all (that is exactly why this shipped) — this suite wires the REAL
 * store to the REAL sync so the rendered order is what is asserted.
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
  decodeAccessTokenClaims: (t: string | null | undefined) =>
    (t?.startsWith('token-') ? {sub: t.slice('token-'.length), role: 'client'} : null),
}));
jest.mock('@services/tokenVault', () => ({
  tokenVault: {getAccess: jest.fn(async () => 'token-founder')},
}));

import {syncActivityFromServer} from '@store/activitySync';
import {useActivityStore, recordActivity} from '@store/activityStore';

const mockFetch = jest.fn();
(global as unknown as {fetch: unknown}).fetch = mockFetch;

/** The nine rows from the founder's 2026-08-30 screenshot, as the server sends them
 *  (newest first) — real kinds and real relative ages from the live DB. */
const SERVER_PAGE_DESC = [
  {id: 'u-9', kind: 'booking-approved',  eventClass: 'booking', createdAt: '2026-08-25T11:16:02.090Z', read: false},
  {id: 'u-8', kind: 'booking-completed', eventClass: 'booking', createdAt: '2026-08-20T10:00:00.000Z', read: false},
  {id: 'u-7', kind: 'crew-assigned',     eventClass: 'booking', createdAt: '2026-08-01T10:00:00.000Z', read: false},
  {id: 'u-6', kind: 'provider-accepted', eventClass: 'booking', createdAt: '2026-07-15T10:00:00.000Z', read: false},
  {id: 'u-5', kind: 'no-provider',       eventClass: 'booking', createdAt: '2026-07-10T12:00:00.000Z', read: false},
  {id: 'u-4', kind: 'booking-approved',  eventClass: 'booking', createdAt: '2026-07-10T11:00:00.000Z', read: false},
  {id: 'u-3', kind: 'booking-approved',  eventClass: 'booking', createdAt: '2026-07-10T10:00:00.000Z', read: false},
  {id: 'u-2', kind: 'booking-approved',  eventClass: 'booking', createdAt: '2026-07-10T09:00:00.000Z', read: false},
  {id: 'u-1', kind: 'booking-approved',  eventClass: 'booking', createdAt: '2026-07-09T15:40:11.522Z', read: false},
];

function respondWith(rows: unknown[]) {
  mockFetch.mockResolvedValueOnce({ok: true, json: async () => ({notifications: rows})});
}
function renderedIds(): string[] {
  return useActivityStore.getState().rows.map(r => r.id);
}
function renderedTs(): number[] {
  return useActivityStore.getState().rows.map(r => new Date(r.ts).getTime());
}

describe('B-706 A-1 — the activity feed renders newest-first', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockAsyncStore)) {delete mockAsyncStore[k];}
    mockFetch.mockReset();
    useActivityStore.setState({rows: [], ownerKey: null});
  });

  it('puts the NEWEST server row at the top after a cold sync', async () => {
    respondWith(SERVER_PAGE_DESC);
    await syncActivityFromServer();

    // The founder's symptom: the top row was 'u-1' (2026-07-09, "50d"), not 'u-9'.
    expect(renderedIds()[0]).toBe('u-9');
    expect(renderedIds()).toEqual(['u-9', 'u-8', 'u-7', 'u-6', 'u-5', 'u-4', 'u-3', 'u-2', 'u-1']);
  });

  it('is monotonically descending by ts — no row is older than the row above it', async () => {
    respondWith(SERVER_PAGE_DESC);
    await syncActivityFromServer();

    const ts = renderedTs();
    expect(ts.length).toBe(9);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
    }
  });

  it('keeps a live FCM row above older backfilled rows (the mixed-feed steady state)', async () => {
    // A live wake lands first (correctly prepended today), then a backfill arrives.
    recordActivity({
      id: 'live-1', eventClass: 'booking', kind: 'booking-approved',
      title: 'Booking approved', ts: '2026-08-28T09:00:00.000Z',
    });
    respondWith(SERVER_PAGE_DESC);
    await syncActivityFromServer();

    const ids = renderedIds();
    // u-9 (08-25) is older than live-1 (08-28); every other server row is older still.
    expect(ids[0]).toBe('live-1');
    expect(ids[1]).toBe('u-9');
    expect(ids[ids.length - 1]).toBe('u-1');
  });

  it('keeps newest-first across a SECOND incremental sync', async () => {
    respondWith(SERVER_PAGE_DESC);
    await syncActivityFromServer();

    respondWith([
      {id: 'u-11', kind: 'crew-assigned',    eventClass: 'booking', createdAt: '2026-08-29T10:00:00.000Z', read: false},
      {id: 'u-10', kind: 'booking-approved', eventClass: 'booking', createdAt: '2026-08-26T10:00:00.000Z', read: false},
    ]);
    await syncActivityFromServer();

    expect(renderedIds().slice(0, 3)).toEqual(['u-11', 'u-10', 'u-9']);
    const ts = renderedTs();
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeLessThanOrEqual(ts[i - 1]);
    }
  });
});
