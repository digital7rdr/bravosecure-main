/**
 * Warm-start FIX-01 — the keychain-backed session store.
 *
 * The cases that matter are all failure modes: a device where the keystore
 * refuses a write, a transient read miss (which would read as "signed out"),
 * and the one-shot migration off plaintext AsyncStorage, which must never
 * delete the old copy before the new one is proven readable.
 */
const mockKc = {
  store: null as string | null,
  getGenericPassword: jest.fn(),
  setGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
};

jest.mock('react-native-keychain', () => ({
  __esModule: true,
  ACCESSIBLE: {AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly'},
  getGenericPassword: (...a: unknown[]) => mockKc.getGenericPassword(...a),
  setGenericPassword: (...a: unknown[]) => mockKc.setGenericPassword(...a),
  resetGenericPassword: (...a: unknown[]) => mockKc.resetGenericPassword(...a),
}));

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
  },
}));

import {tokenVault} from '@services/tokenVault';

const ACCESS = 'auth:access_token';
const REFRESH = 'auth:refresh_token';

/** Default keychain behaviour: a real store backed by `mockKc.store`. */
function wireKeychain(): void {
  mockKc.getGenericPassword.mockImplementation(async () =>
    mockKc.store ? {username: 'bravo-session', password: mockKc.store} : false);
  mockKc.setGenericPassword.mockImplementation(async (_u: string, p: string) => { mockKc.store = p; return true; });
  mockKc.resetGenericPassword.mockImplementation(async () => { mockKc.store = null; return true; });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKc.store = null;
  Object.keys(asyncStore).forEach(k => { delete asyncStore[k]; });
  tokenVault.__resetCacheForTests();
  wireKeychain();
});

describe('tokenVault — reads', () => {
  it('returns null on a device with nothing stored anywhere', async () => {
    expect(await tokenVault.getAccess()).toBeNull();
    expect(await tokenVault.getRefresh()).toBeNull();
  });

  it('reads back what set() wrote, through the keychain', async () => {
    await tokenVault.set('acc-1', 'ref-1');
    tokenVault.__resetCacheForTests();
    expect(await tokenVault.getAccess()).toBe('acc-1');
    expect(await tokenVault.getRefresh()).toBe('ref-1');
    expect(mockKc.setGenericPassword).toHaveBeenCalledWith(
      'bravo-session', expect.any(String),
      expect.objectContaining({accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly'}),
    );
  });

  it('hits the keychain once per process, not once per request', async () => {
    await tokenVault.set('acc-1', 'ref-1');
    tokenVault.__resetCacheForTests();
    mockKc.getGenericPassword.mockClear();

    for (let i = 0; i < 25; i++) { await tokenVault.getAccess(); }

    // The axios request interceptor reads on EVERY authed call; a keystore
    // round-trip each time would show up as send latency.
    expect(mockKc.getGenericPassword).toHaveBeenCalledTimes(1);
  });

  it('coalesces a cold-boot stampede into a single load', async () => {
    await tokenVault.set('acc-1', 'ref-1');
    tokenVault.__resetCacheForTests();
    mockKc.getGenericPassword.mockClear();

    const all = await Promise.all(Array.from({length: 10}, () => tokenVault.getAccess()));

    expect(all.every(v => v === 'acc-1')).toBe(true);
    expect(mockKc.getGenericPassword).toHaveBeenCalledTimes(1);
  });

  it('survives a transient keystore miss instead of reading as signed-out', async () => {
    mockKc.store = JSON.stringify({a: 'acc-1', r: 'ref-1'});
    let calls = 0;
    mockKc.getGenericPassword.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {return false;}          // B-15b class: false miss
      if (calls === 2) {throw new Error('keystore busy');}
      return {username: 'bravo-session', password: mockKc.store};
    });

    expect(await tokenVault.getAccess()).toBe('acc-1');
  });

  it('treats a corrupt keychain blob as empty rather than throwing', async () => {
    mockKc.store = 'not json';
    expect(await tokenVault.getAccess()).toBeNull();
  });
});

describe('tokenVault — migration off plaintext AsyncStorage', () => {
  it('moves legacy tokens into the keychain and deletes the plaintext copy', async () => {
    asyncStore[ACCESS] = 'legacy-acc';
    asyncStore[REFRESH] = 'legacy-ref';

    expect(await tokenVault.getAccess()).toBe('legacy-acc');
    expect(await tokenVault.getRefresh()).toBe('legacy-ref');

    expect(mockKc.store).toBe(JSON.stringify({a: 'legacy-acc', r: 'legacy-ref'}));
    expect(asyncStore[ACCESS]).toBeUndefined();
    expect(asyncStore[REFRESH]).toBeUndefined();
  });

  it('does NOT delete the plaintext copy when the keychain write fails', async () => {
    asyncStore[ACCESS] = 'legacy-acc';
    asyncStore[REFRESH] = 'legacy-ref';
    mockKc.setGenericPassword.mockRejectedValue(new Error('keystore lock screen required'));

    // The user stays signed in off the legacy copy — deleting first would
    // strand them with no session and no way back.
    expect(await tokenVault.getAccess()).toBe('legacy-acc');
    expect(asyncStore[ACCESS]).toBe('legacy-acc');
  });

  it('does not delete the plaintext copy when the readback disagrees', async () => {
    asyncStore[ACCESS] = 'legacy-acc';
    asyncStore[REFRESH] = 'legacy-ref';
    mockKc.setGenericPassword.mockImplementation(async () => true);   // pretends success, stores nothing
    mockKc.getGenericPassword.mockImplementation(async () => false);

    expect(await tokenVault.getAccess()).toBe('legacy-acc');
    expect(asyncStore[ACCESS]).toBe('legacy-acc');
  });

  it('with BOTH stores populated, legacy wins and re-migration self-heals (audit round 2)', async () => {
    // The invariant this pins: legacy keys present ⇒ legacy is at least as new
    // as the keychain. The only reachable both-populated states are a failed
    // rotation write (legacy NEWER) and a migration whose final delete blipped
    // (legacy EQUAL) — in neither may the keychain pair win. The original
    // assertion here ("keychain wins over a stale legacy leftover") described
    // a state that cannot arise, and enforcing it re-installed rotated-out
    // tokens after one keystore write failure.
    mockKc.store = JSON.stringify({a: 'kc-acc', r: 'kc-ref'});
    asyncStore[ACCESS] = 'newer-legacy';
    asyncStore[REFRESH] = 'newer-legacy-r';

    expect(await tokenVault.getAccess()).toBe('newer-legacy');
    // And the newer pair has been healed into the keychain, legacy swept.
    expect(mockKc.store).toBe(JSON.stringify({a: 'newer-legacy', r: 'newer-legacy-r'}));
    expect(asyncStore[ACCESS]).toBeUndefined();
  });
});

describe('tokenVault — writes and teardown', () => {
  it('set() makes the new token visible immediately to concurrent readers', async () => {
    await tokenVault.set('old', 'old-r');
    await tokenVault.set('new', 'new-r');
    // Serving the old token after a refresh is a guaranteed 401 + retry storm.
    expect(await tokenVault.getAccess()).toBe('new');
  });

  it('set() falls back to legacy storage if the keychain refuses the write', async () => {
    mockKc.setGenericPassword.mockRejectedValue(new Error('no keystore'));
    await tokenVault.set('acc-1', 'ref-1');
    expect(asyncStore[ACCESS]).toBe('acc-1');
    expect(await tokenVault.getAccess()).toBe('acc-1');
  });

  it('clear() wipes the keychain, the legacy keys, and the cache', async () => {
    await tokenVault.set('acc-1', 'ref-1');
    asyncStore[ACCESS] = 'leftover';

    await tokenVault.clear();

    expect(mockKc.resetGenericPassword).toHaveBeenCalled();
    expect(asyncStore[ACCESS]).toBeUndefined();
    expect(await tokenVault.getAccess()).toBeNull();
  });

  it('clear() still wipes plaintext when the keychain reset throws', async () => {
    asyncStore[ACCESS] = 'leftover';
    asyncStore[REFRESH] = 'leftover-r';
    mockKc.resetGenericPassword.mockRejectedValue(new Error('boom'));

    await tokenVault.clear();

    expect(asyncStore[ACCESS]).toBeUndefined();
    expect(asyncStore[REFRESH]).toBeUndefined();
  });
});

/**
 * Audit findings on the first cut of FIX-01 — two stale-load races, both the
 * same shape: an async load that resolves AFTER the world has moved on must
 * not install its stale answer into the cache.
 *
 *   (a) a load in flight when clear() runs (signOut) resolved afterwards and
 *       re-cached the SIGNED-OUT user's tokens for the rest of the process;
 *   (b) a load in flight when set() runs (login / refresh rotation) resolved
 *       afterwards and overwrote the FRESH tokens with the previous ones —
 *       a guaranteed 401 + retry storm on every later request.
 */
describe('tokenVault — stale-load races (audit)', () => {
  it('a load that resolves after clear() must NOT resurrect the old session', async () => {
    mockKc.store = JSON.stringify({a: 'old-acc', r: 'old-ref'});
    // Hold the keychain read open so clear() lands mid-load.
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>(r => { releaseRead = r; });
    mockKc.getGenericPassword.mockImplementation(async () => {
      await gate;
      return mockKc.store ? {username: 'bravo-session', password: mockKc.store} : false;
    });

    const inFlight = tokenVault.getAccess();     // starts the load
    await tokenVault.clear();                    // signOut wins the race
    releaseRead();                               // stale load resolves NOW
    await inFlight;

    // The stale result may be returned to ITS caller, but it must not stick.
    expect(await tokenVault.getAccess()).toBeNull();
  });

  it('a load that resolves after set() must NOT overwrite the fresh tokens', async () => {
    mockKc.store = JSON.stringify({a: 'old-acc', r: 'old-ref'});
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>(r => { releaseRead = r; });
    mockKc.getGenericPassword.mockImplementation(async () => {
      await gate;
      return {username: 'bravo-session', password: JSON.stringify({a: 'old-acc', r: 'old-ref'})};
    });

    const inFlight = tokenVault.getAccess();
    await tokenVault.set('new-acc', 'new-ref');  // refresh rotation wins
    releaseRead();
    await inFlight;

    expect(await tokenVault.getAccess()).toBe('new-acc');
  });

  it('a read racing clear() itself cannot cache the not-yet-deleted keychain entry', async () => {
    mockKc.store = JSON.stringify({a: 'old-acc', r: 'old-ref'});
    // Make the keychain reset slow, so a get() lands while clear() is mid-wipe.
    let releaseReset: () => void = () => {};
    mockKc.resetGenericPassword.mockImplementation(async () => {
      await new Promise<void>(r => { releaseReset = r; });
      mockKc.store = null;
      return true;
    });

    const clearing = tokenVault.clear();
    const during = tokenVault.getAccess();       // fired by an in-flight request
    releaseReset();
    await clearing;
    await during;

    expect(await tokenVault.getAccess()).toBeNull();
  });
});

/**
 * Audit round 2 — the failed-keychain-write SHADOW.
 *
 * set()'s fallback writes the NEW pair to legacy AsyncStorage when the
 * keychain write fails — but the OLD pair is still sitting in the keychain,
 * and load() preferred the keychain unconditionally. The next cold read (or
 * next boot) therefore re-installed the rotated-OUT pair: every request 401s,
 * the interceptor refreshes with the stale refresh token, gets 401/403, and
 * force-signs the user out — all triggered by one transient keystore hiccup.
 *
 * The invariant that fixes it: WHENEVER legacy keys exist, they are at least
 * as new as the keychain (migration deletes legacy only after a verified
 * keychain write; the set() fallback writes legacy only when the keychain
 * write failed, i.e. the keychain holds the older pair). So legacy presence
 * must win, and the normal migration then self-heals the keychain.
 */
describe('tokenVault — failed-write shadow (audit round 2)', () => {
  it('the NEW pair wins over the stale keychain pair after a failed rotation write', async () => {
    await tokenVault.set('old-acc', 'old-ref');            // keychain holds OLD
    tokenVault.__resetCacheForTests();

    mockKc.setGenericPassword.mockRejectedValueOnce(new Error('keystore busy'));
    await tokenVault.set('new-acc', 'new-ref');            // falls back to legacy

    tokenVault.__resetCacheForTests();                     // cold read (next boot)
    expect(await tokenVault.getAccess()).toBe('new-acc');
    expect(await tokenVault.getRefresh()).toBe('new-ref');
  });

  it('the recovered rotation self-heals INTO the keychain and clears legacy', async () => {
    await tokenVault.set('old-acc', 'old-ref');
    tokenVault.__resetCacheForTests();
    mockKc.setGenericPassword.mockRejectedValueOnce(new Error('keystore busy'));
    await tokenVault.set('new-acc', 'new-ref');
    tokenVault.__resetCacheForTests();

    await tokenVault.getAccess();                          // keychain works again

    expect(mockKc.store).toBe(JSON.stringify({a: 'new-acc', r: 'new-ref'}));
    expect(asyncStore[ACCESS]).toBeUndefined();
  });
});
