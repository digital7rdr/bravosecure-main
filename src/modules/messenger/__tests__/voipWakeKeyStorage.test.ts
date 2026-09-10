/**
 * VoIP wake key STORAGE + the nonce LRU's real backing store — the half of
 * push/voipWakeVerify.ts that voipWakeVerify.test.ts stubs out.
 *
 * That suite injects `_setVoipWakeKeyLoaderForTests` / `_setVoipNoncePersistenceForTests`
 * so it can test the verdict logic in pure Node, which means the code that
 * actually TALKS to the keychain and to AsyncStorage — the code a real device
 * runs — never executed. What that leaves unpinned is security-relevant:
 *
 *   • Audit P1-N11 — the wake key must be stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 *     The previous `AFTER_FIRST_UNLOCK` policy let any process on a booted-but-
 *     locked device read the key and forge signed wakes, and let it ride iCloud
 *     Keychain off the device. A regression here is invisible to every other test.
 *   • Logout must actually reset the keychain entry, or the next user on this
 *     device inherits the previous user's key and fails every verification.
 *   • Rank 10 — the persisted nonce set is the ONLY thing closing the cross-cold-
 *     start replay window; a malformed/corrupt file must fail SAFE (drop the set)
 *     and never throw into the wake path.
 *   • The LRU cap and the retain-window prune both decide when a nonce becomes
 *     replayable again.
 */
import {randomBytes} from 'node:crypto';

const mockKeychain = {
  setGenericPassword:   jest.fn(async () => true),
  getGenericPassword:   jest.fn(async () => false as unknown),
  resetGenericPassword: jest.fn(async () => true),
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK:             'AccessibleAfterFirstUnlock',
  },
};
jest.mock('react-native-keychain', () => mockKeychain);

const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
  },
}));

import {
  computeVoipSig,
  verifyVoipWake,
  storeVoipWakeKey,
  clearVoipWakeKey,
  _resetNonceLruForTests,
  _setVoipWakeKeyLoaderForTests,
  _setVoipNoncePersistenceForTests,
} from '../push/voipWakeVerify';

const NONCE_STORAGE_KEY = 'bravo-voip-wake-nonces';
const RETAIN_MS = 5 * 60 * 1000;

function genWakeKey(): string {
  return randomBytes(32).toString('base64');
}

/** A wake that verifies against `key` at wall-clock `nowMs`. */
function signedWake(key: string, callId: string, nonce: string, nowMs: number) {
  const exp = Math.floor(nowMs / 1000) + 300;
  return {kind: 'voip-wake' as const, callId, nonce, exp, sig: computeVoipSig(key, {kind: 'voip-wake', callId, nonce, exp})};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStore.clear();
  _resetNonceLruForTests();
  mockKeychain.getGenericPassword.mockImplementation(async () => false as unknown);
});

afterEach(() => {
  _setVoipWakeKeyLoaderForTests(null);
  _setVoipNoncePersistenceForTests(null);
});

describe('the persistence backend a REAL process boots with', () => {
  // The module ships TWO byte-identical AsyncStorage backends: the initial
  // `noncePersistence` literal, and the copy `_setVoipNoncePersistenceForTests(null)`
  // installs. Every other test in the tree calls that setter, so the literal a
  // real device actually runs is never executed — a divergence between the two
  // copies would be invisible. Load a virgin module and touch neither setter.
  it('hydrates the replay window from AsyncStorage without any test seam', async () => {
    const now = Date.now();
    const key = genWakeKey();
    mockAsyncStore.set(NONCE_STORAGE_KEY, JSON.stringify([['alice:cold-nonce', now - 30_000]]));

    let virgin!: typeof import('../push/voipWakeVerify');
    jest.isolateModules(() => { virgin = require('../push/voipWakeVerify'); });
    mockKeychain.getGenericPassword.mockImplementation(async () => ({username: 'u:1', password: key}));

    const replay = await virgin.verifyVoipWake({
      selfUserId: 'alice',
      fields: signedWake(key, 'c-cold', 'cold-nonce', now),
      now,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {expect(replay.reason).toBe('replay');}

    // …and the same backend writes accepted nonces back out.
    const fresh = await virgin.verifyVoipWake({
      selfUserId: 'alice',
      fields: signedWake(key, 'c-cold-2', 'fresh-nonce', now),
      now,
    });
    expect(fresh.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(mockAsyncStore.get(NONCE_STORAGE_KEY)!)).toContainEqual(['alice:fresh-nonce', now]);
  });
});

describe('wake-key keychain lifecycle', () => {
  it('audit P1-N11 — stores the key WHEN_UNLOCKED_THIS_DEVICE_ONLY, never AFTER_FIRST_UNLOCK', async () => {
    await storeVoipWakeKey('user-7', 1, 'a2V5LWJ5dGVz');

    expect(mockKeychain.setGenericPassword).toHaveBeenCalledTimes(1);
    const [account, secret, opts] = mockKeychain.setGenericPassword.mock.calls[0] as unknown as
      [string, string, {service: string; accessible: string}];
    // The account key is what pairs a stored key with a (user, device) — the
    // same shape registerVoipToken writes with deviceId '1'.
    expect(account).toBe('user-7:1');
    expect(secret).toBe('a2V5LWJ5dGVz');
    expect(opts.service).toBe('bravo-voip-wake-key');
    expect(opts.accessible).toBe(mockKeychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
    expect(opts.accessible).not.toBe(mockKeychain.ACCESSIBLE.AFTER_FIRST_UNLOCK);
  });

  it('accepts a string deviceId without mangling the account key', async () => {
    await storeVoipWakeKey('user-7', '1', 'k');
    expect((mockKeychain.setGenericPassword.mock.calls[0] as unknown as string[])[0]).toBe('user-7:1');
  });

  it('logout resets the keychain entry for the wake-key service', async () => {
    await clearVoipWakeKey();
    expect(mockKeychain.resetGenericPassword).toHaveBeenCalledWith({service: 'bravo-voip-wake-key'});
  });

  it('a keychain that throws on reset does not fail logout', async () => {
    mockKeychain.resetGenericPassword.mockImplementationOnce(async () => { throw new Error('no entry'); });
    await expect(clearVoipWakeKey()).resolves.toBeUndefined();
  });
});

describe('the production wake-key loader (keychain-backed default)', () => {
  it('verifies a wake against the key read back out of the keychain', async () => {
    const key = genWakeKey();
    mockKeychain.getGenericPassword.mockImplementation(async () => ({username: 'u:1', password: key}));
    _setVoipWakeKeyLoaderForTests(null); // restore the real Keychain path
    _setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});

    const now = Date.now();
    const r = await verifyVoipWake({selfUserId: 'u', fields: signedWake(key, 'c-1', 'n-1', now), now});

    expect(mockKeychain.getGenericPassword).toHaveBeenCalledWith({service: 'bravo-voip-wake-key'});
    expect(r.ok).toBe(true);
  });

  it('treats the `false` no-entry return as "no key" and rejects fail-closed', async () => {
    // react-native-keychain returns `false` (not null) when nothing is stored.
    mockKeychain.getGenericPassword.mockImplementation(async () => false as unknown);
    _setVoipWakeKeyLoaderForTests(null);

    const now = Date.now();
    const r = await verifyVoipWake({selfUserId: 'u', fields: signedWake(genWakeKey(), 'c-2', 'n-2', now), now});

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('no_key');}
  });

  it('a throwing keychain degrades to no_key instead of blowing up the wake path', async () => {
    mockKeychain.getGenericPassword.mockImplementation(async () => { throw new Error('locked'); });
    _setVoipWakeKeyLoaderForTests(null);

    const now = Date.now();
    const r = await verifyVoipWake({selfUserId: 'u', fields: signedWake(genWakeKey(), 'c-3', 'n-3', now), now});

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('no_key');}
  });
});

describe('Rank 10 — the AsyncStorage-backed nonce persistence (production default)', () => {
  const key = genWakeKey();

  beforeEach(() => {
    _setVoipWakeKeyLoaderForTests(async () => key);
    _setVoipNoncePersistenceForTests(null); // exercise the REAL AsyncStorage backend
  });

  it('mirrors an accepted nonce into AsyncStorage under the wake-nonce key', async () => {
    const now = Date.now();
    const r = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-10', 'n-10', now), now});
    expect(r.ok).toBe(true);

    // The write is fire-and-forget (the ring must not wait on storage).
    await new Promise(resolve => setTimeout(resolve, 0));
    const raw = mockAsyncStore.get(NONCE_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toContainEqual(['alice:n-10', now]);
  });

  it('hydrates the persisted set on the first verify after a cold start and rejects the replay', async () => {
    const now = Date.now();
    mockAsyncStore.set(NONCE_STORAGE_KEY, JSON.stringify([['alice:n-11', now - 60_000]]));

    const r = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-11', 'n-11', now), now});

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('replay');}
  });

  it('drops malformed entries individually but keeps the well-formed ones', async () => {
    const now = Date.now();
    mockAsyncStore.set(NONCE_STORAGE_KEY, JSON.stringify([
      ['alice:bad-shape'],                 // wrong arity
      ['alice:bad-ts', 'not-a-number'],    // wrong value type
      [42, now],                           // wrong key type
      ['alice:good', now - 1000],
      'not-even-an-array',
    ]));

    const good = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-12', 'good', now), now});
    expect(good.ok).toBe(false);           // the one valid entry survived → replay

    const bad = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-13', 'bad-ts', now), now});
    expect(bad.ok).toBe(true);             // the malformed one was dropped, not resurrected
  });

  it('a corrupt file fails SAFE — the wake still verifies rather than throwing', async () => {
    const now = Date.now();
    mockAsyncStore.set(NONCE_STORAGE_KEY, '{not json at all');

    const r = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-14', 'n-14', now), now});
    expect(r.ok).toBe(true);
  });

  it('a JSON file that is not an array is ignored wholesale', async () => {
    const now = Date.now();
    mockAsyncStore.set(NONCE_STORAGE_KEY, JSON.stringify({'alice:n-15': now}));

    const r = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-15', 'n-15', now), now});
    expect(r.ok).toBe(true);
  });
});

describe('nonce LRU bounds', () => {
  const key = genWakeKey();

  beforeEach(() => {
    _setVoipWakeKeyLoaderForTests(async () => key);
    _setVoipNoncePersistenceForTests({load: async () => null, save: async () => {}});
  });

  it('the oldest nonce falls out of the 256-entry cap and becomes replayable again', async () => {
    const now = Date.now();
    for (let i = 0; i < 260; i++) {
      const r = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, `c-${i}`, `bulk-${i}`, now), now});
      expect(r.ok).toBe(true);
    }
    // The newest entries are still inside the window…
    const recent = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-259', 'bulk-259', now), now});
    expect(recent.ok).toBe(false);
    // …while the very first one was evicted by the cap (a bounded window is the
    // deliberate trade-off: the LRU cannot grow without limit in a headless VM).
    const evicted = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-0', 'bulk-0', now), now});
    expect(evicted.ok).toBe(true);
  });

  it('a nonce older than the 5-minute retain window is pruned, not held forever', async () => {
    const t0 = Date.now();
    const first = await verifyVoipWake({selfUserId: 'alice', fields: signedWake(key, 'c-p', 'prune-me', t0 + RETAIN_MS + 60_000), now: t0});
    expect(first.ok).toBe(true);

    // Same nonce, well past NONCE_RETAIN_MS — pruneNonces drops it first, so
    // this is no longer a replay.
    const later = t0 + RETAIN_MS + 1;
    const again = await verifyVoipWake({
      selfUserId: 'alice',
      fields: {...signedWake(key, 'c-p', 'prune-me', t0 + RETAIN_MS + 60_000)},
      now: later,
    });
    expect(again.ok).toBe(true);
  });

  it('rejects a wake whose callId is not a string (malformed, before any key read)', async () => {
    const loader = jest.fn(async () => key);
    _setVoipWakeKeyLoaderForTests(loader);
    const r = await verifyVoipWake({
      selfUserId: 'alice',
      fields: {kind: 'voip-wake', callId: 12345 as unknown as string, nonce: 'n', exp: Math.floor(Date.now() / 1000) + 30, sig: 'x'},
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('malformed');}
    // Fails before touching the keychain — a malformed wake costs nothing.
    expect(loader).not.toHaveBeenCalled();
  });
});
