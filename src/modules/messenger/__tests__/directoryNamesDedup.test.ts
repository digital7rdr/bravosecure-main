/**
 * AUDIT-2026-08-13 F7 — the directory resolver's duplicate-fetch window.
 *
 * `attempted` is stamped only after a flush RESOLVES, so between the
 * flush draining `pending` and the response landing, a re-render's
 * ensureDirectoryNames() re-queued the same ids and fired a duplicate
 * /users/profiles fetch. Pinned: ids on the wire are skipped; a FAILED
 * flush still frees them (the retry-on-recovery contract).
 */
const mockGetProfiles = jest.fn();

jest.mock('@bravo/messenger-core', () => ({
  UsersHttpClient: jest.fn().mockImplementation(() => ({
    getProfilesByIds: (...a: unknown[]) => mockGetProfiles(...a),
  })),
}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'http://test'}));
jest.mock('@services/api', () => ({
  tokenStore: {get: () => 'tok'},
  refreshAccessTokenShared: jest.fn(),
}));

import {ensureDirectoryNames, _resetDirectoryNamesForTests} from '../contacts/directoryNames';

describe('AUDIT F7 — one fetch per id per session, even across the in-flight window', () => {
  beforeEach(() => {
    _resetDirectoryNamesForTests();
    mockGetProfiles.mockReset();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a re-queue while the batch is ON THE WIRE does not fire a second fetch', async () => {
    let resolveFetch!: (v: unknown) => void;
    mockGetProfiles.mockReturnValue(new Promise(r => { resolveFetch = r; }));
    ensureDirectoryNames(['u1', 'u2']);
    await jest.advanceTimersByTimeAsync(300); // flush fires, fetch hangs
    expect(mockGetProfiles).toHaveBeenCalledTimes(1);
    // The re-render storm during the request:
    ensureDirectoryNames(['u1']);
    ensureDirectoryNames(['u2', 'u1']);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockGetProfiles).toHaveBeenCalledTimes(1); // the F7 pin
    resolveFetch([{userId: 'u1', displayName: 'Alice', avatarUrl: null}]);
    await jest.advanceTimersByTimeAsync(1);
    // Resolved ids are attempted-for-the-session:
    ensureDirectoryNames(['u1', 'u2']);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockGetProfiles).toHaveBeenCalledTimes(1);
  });

  it('a FAILED flush frees the ids — the retry-on-recovery contract survives the fix', async () => {
    mockGetProfiles.mockRejectedValueOnce(new Error('offline'));
    ensureDirectoryNames(['u1']);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockGetProfiles).toHaveBeenCalledTimes(1);
    mockGetProfiles.mockResolvedValueOnce([]);
    ensureDirectoryNames(['u1']);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockGetProfiles).toHaveBeenCalledTimes(2); // retried once recovered
  });

  it('a NEW id arriving mid-flight still gets its own batch (no starvation)', async () => {
    let resolveFetch!: (v: unknown) => void;
    mockGetProfiles.mockReturnValueOnce(new Promise(r => { resolveFetch = r; }));
    mockGetProfiles.mockResolvedValueOnce([]);
    ensureDirectoryNames(['u1']);
    await jest.advanceTimersByTimeAsync(300);
    ensureDirectoryNames(['u-new']); // not in flight — must not be swallowed
    await jest.advanceTimersByTimeAsync(300);
    expect(mockGetProfiles).toHaveBeenCalledTimes(2);
    expect(mockGetProfiles.mock.calls[1][0]).toEqual(['u-new']);
    resolveFetch([]);
  });
});
