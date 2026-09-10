/**
 * EXECUTABLE coverage for `runtime/keychain.ts` beyond the two functions
 * `keychainRetry.test.ts` / `mirrorKeyOwner.test.ts` already pin.
 *
 * The load-bearing rule in this file is B-15b: a transient Android-Keystore
 * miss (a falsy read OR a throw) used to be read as "no key", and the caller
 * then MINTED A FRESH KEY OVER THE REAL ONE — permanently orphaning the
 * user's SQLCipher DB ("my chat history disappeared"). Every read that can
 * trigger a mint, a "fresh install" verdict, or a migration decision must
 * therefore go through `readKeychainWithRetry`, and a genuine fresh install
 * must STILL mint. Both halves are pinned here for every remaining reader:
 *
 *   hasDbKey                    — the fresh-install probe that routes a user
 *                                 into (or past) the BackupRestore screen.
 *   loadCompartmentDbKey        — the "compartments provisioned?" probe.
 *   loadLegacyDbKey             — the legacy-migration read.
 *   getOrCreateGroupWrapKey     — P0-S5 group-key wrap secret.
 *   getOrCreateMerkleSeqHmacKey — P1-N12 Merkle-seq HMAC secret.
 *
 * Also pinned: the strict-write FALLBACK (a device with no screen lock must
 * still boot the messenger) and per-compartment service isolation (P0-S5
 * residual — one keystore entry must never yield another compartment).
 *
 * The mock keychain can simulate BOTH failure shapes the real one produces:
 * `flakyMisses` (returns false) and `flakyThrows` (rejects). `keychainRetry`
 * only ever exercised the first.
 */

jest.mock('react-native-keychain', () => {
  const state = {
    store:       new Map<string, string>(),
    /** service -> forced falsy reads before a real read succeeds */
    flakyMisses: new Map<string, number>(),
    /** service -> forced throwing reads before a real read succeeds */
    flakyThrows: new Map<string, number>(),
    /** service -> forced throwing writes (used to drive the strict->fallback path) */
    strictWriteFails: new Set<string>(),
    setCalls:    [] as Array<{account: string; service: string; password: string; accessible?: string; securityLevel?: string}>,
    resetCalls:  [] as string[],
    getCalls:    [] as string[],
  };
  return {
    __esModule: true,
    __state: state,
    SECURITY_LEVEL: {SECURE_HARDWARE: 'sh', SECURE_SOFTWARE: 'ss'},
    ACCESSIBLE: {
      WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'passcode-set-this-device-only',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY:     'unlocked-this-device-only',
    },
    setGenericPassword: async (
      account: string,
      password: string,
      opts: {service: string; accessible?: string; securityLevel?: string},
    ) => {
      if (state.strictWriteFails.has(opts.service) && opts.securityLevel === 'sh') {
        throw new Error('keystore lock screen required');
      }
      state.store.set(opts.service, password);
      state.setCalls.push({
        account,
        service:       opts.service,
        password,
        accessible:    opts.accessible,
        securityLevel: opts.securityLevel,
      });
      return true;
    },
    getGenericPassword: async (opts: {service: string}) => {
      state.getCalls.push(opts.service);
      const throwsLeft = state.flakyThrows.get(opts.service) ?? 0;
      if (throwsLeft > 0) {
        state.flakyThrows.set(opts.service, throwsLeft - 1);
        throw new Error('keystore unavailable');
      }
      const missesLeft = state.flakyMisses.get(opts.service) ?? 0;
      if (missesLeft > 0) {
        state.flakyMisses.set(opts.service, missesLeft - 1);
        return false;
      }
      const password = state.store.get(opts.service);
      return password ? {username: 'x', password, service: opts.service} : false;
    },
    resetGenericPassword: async (opts: {service: string}) => {
      state.resetCalls.push(opts.service);
      state.store.delete(opts.service);
      return true;
    },
  };
});

interface MockState {
  store: Map<string, string>;
  flakyMisses: Map<string, number>;
  flakyThrows: Map<string, number>;
  strictWriteFails: Set<string>;
  setCalls: Array<{account: string; service: string; password: string; accessible?: string; securityLevel?: string}>;
  resetCalls: string[];
  getCalls: string[];
}
const mock = (jest.requireMock('react-native-keychain') as {__state: MockState}).__state;

import {
  ALL_COMPARTMENTS,
  destroyCompartmentDbKey,
  destroyDbKey,
  destroyGroupWrapKey,
  destroyMerkleSeqHmacKey,
  getOrCreateCompartmentDbKey,
  getOrCreateGroupWrapKey,
  getOrCreateMerkleSeqHmacKey,
  hasDbKey,
  loadCompartmentDbKey,
  loadLegacyDbKey,
} from '../runtime/keychain';

const USER      = 'owner@bravo.test';
const KEY64     = 'a'.repeat(64);
const LEGACY_SVC = `bravo.messenger.dbkey.${USER}`;
const SVC = {
  id:  `bravo.messenger.dbkey.id.${USER}`,
  rt:  `bravo.messenger.dbkey.rt.${USER}`,
  msg: `bravo.messenger.dbkey.msg.${USER}`,
} as const;
const WRAP_SVC   = `bravo.messenger.groupwrap.${USER}`;
const MERKLE_SVC = `bravo.messenger.merkleseq.${USER}`;

let warnSpy: jest.SpyInstance;

/**
 * `readKeychainWithRetry` sleeps 120/240/360ms between attempts, so the
 * miss paths below (which are the WHOLE point of this suite) would cost
 * ~0.7s of real wall-clock EACH. Fake timers keep the retry loop itself
 * honest — every backoff still has to elapse — while costing nothing.
 * Only the loop's own `setTimeout` is faked; nothing else in this file
 * schedules work.
 */
async function fast<T>(run: () => Promise<T>): Promise<T> {
  const p = run();
  // Comfortably past 120+240+360, applied to every awaiting read in flight.
  await jest.advanceTimersByTimeAsync(5000);
  return p;
}

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mock.store.clear();
  mock.flakyMisses.clear();
  mock.flakyThrows.clear();
  mock.strictWriteFails.clear();
  mock.setCalls.length = 0;
  mock.resetCalls.length = 0;
  mock.getCalls.length = 0;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('hasDbKey — the FRESH-INSTALL verdict (B-15b)', () => {
  it('answers yes from the LEGACY entry alone, without reading the compartments', async () => {
    mock.store.set(LEGACY_SVC, KEY64);

    await expect(fast(() => hasDbKey(USER))).resolves.toBe(true);
    // Short-circuits: a legacy hit must not cost a second keystore read.
    expect(mock.getCalls).toEqual([LEGACY_SVC]);
  });

  it('answers yes from the RT compartment when only the compartments were provisioned', async () => {
    mock.store.set(SVC.rt, KEY64);

    await expect(fast(() => hasDbKey(USER))).resolves.toBe(true);
    expect(mock.getCalls).toContain(SVC.rt);
  });

  it('a transient miss on the legacy entry does NOT get reported as a fresh install', async () => {
    // This is the landmine: hasDbKey === false routes the user into the
    // BackupRestore/installIdentity path, which writes a BRAND-NEW identity
    // over a device that already had one.
    mock.store.set(LEGACY_SVC, KEY64);
    mock.flakyMisses.set(LEGACY_SVC, 3);

    await expect(fast(() => hasDbKey(USER))).resolves.toBe(true);
  });

  it('a THROWING keystore read is retried too, not just a falsy one', async () => {
    mock.store.set(SVC.rt, KEY64);
    mock.flakyThrows.set(SVC.rt, 3);

    await expect(fast(() => hasDbKey(USER))).resolves.toBe(true);
  });

  it('a genuinely empty keystore still answers no (fresh install must still work)', async () => {
    await expect(fast(() => hasDbKey(USER))).resolves.toBe(false);
    // Both compartments were consulted before concluding "fresh".
    expect(mock.getCalls).toContain(LEGACY_SVC);
    expect(mock.getCalls).toContain(SVC.rt);
    // A probe must NEVER mint.
    expect(mock.setCalls).toHaveLength(0);
  });

  it('a truncated / non-key value is not accepted as a key by either lookup', async () => {
    mock.store.set(LEGACY_SVC, 'short');
    mock.store.set(SVC.rt, 'also-short');

    await expect(fast(() => hasDbKey(USER))).resolves.toBe(false);
  });
});

describe('loadCompartmentDbKey / loadLegacyDbKey — read-only probes', () => {
  it('return the stored key and never write', async () => {
    mock.store.set(SVC.msg, KEY64);
    mock.store.set(LEGACY_SVC, KEY64);

    await expect(fast(() => loadCompartmentDbKey(USER, 'msg'))).resolves.toBe(KEY64);
    await expect(fast(() => loadLegacyDbKey(USER))).resolves.toBe(KEY64);
    expect(mock.setCalls).toHaveLength(0);
  });

  it('survive a transient miss rather than reporting "not provisioned"', async () => {
    // A false negative here makes openCryptoDb re-run the legacy migration
    // against compartments that already exist.
    mock.store.set(SVC.id, KEY64);
    mock.flakyMisses.set(SVC.id, 2);

    await expect(fast(() => loadCompartmentDbKey(USER, 'id'))).resolves.toBe(KEY64);
  });

  it('return null for an absent entry, a short entry, and an empty userId', async () => {
    await expect(fast(() => loadCompartmentDbKey(USER, 'id'))).resolves.toBeNull();
    mock.store.set(SVC.id, 'too-short');
    await expect(fast(() => loadCompartmentDbKey(USER, 'id'))).resolves.toBeNull();

    await expect(fast(() => loadLegacyDbKey(USER))).resolves.toBeNull();
    await expect(fast(() => loadLegacyDbKey(''))).resolves.toBeNull();
    // An empty userId must not even reach the keystore — `bravo…dbkey.` is
    // a shared service name across every anonymous caller.
    const before = mock.getCalls.length;
    await expect(fast(() => loadCompartmentDbKey('', 'rt'))).resolves.toBeNull();
    expect(mock.getCalls.length).toBe(before);
  });
});

describe('per-compartment isolation (P0-S5 residual)', () => {
  it('mints THREE distinct keys under THREE distinct services', async () => {
    const keys = await fast(() => Promise.all(
      ALL_COMPARTMENTS.map(c => getOrCreateCompartmentDbKey(USER, c)),
    ));

    expect(new Set(keys).size).toBe(3);
    for (const k of keys) {expect(k).toMatch(/^[0-9a-f]{64}$/);}
    expect(new Set(mock.setCalls.map(c => c.service))).toEqual(
      new Set([SVC.id, SVC.rt, SVC.msg]),
    );
    // The account label carries the compartment so a keystore dump is
    // attributable — and so the three entries are not interchangeable.
    expect(mock.setCalls.map(c => c.account).sort())
      .toEqual(['messenger-db-id', 'messenger-db-msg', 'messenger-db-rt']);
  });

  it('holding the RT key yields NOTHING for id/msg', async () => {
    mock.store.set(SVC.rt, KEY64);

    await expect(fast(() => loadCompartmentDbKey(USER, 'rt'))).resolves.toBe(KEY64);
    await expect(fast(() => loadCompartmentDbKey(USER, 'id'))).resolves.toBeNull();
    await expect(fast(() => loadCompartmentDbKey(USER, 'msg'))).resolves.toBeNull();
  });

  it('the compartment key is scoped per-user — a second account gets a different key', async () => {
    const a = await fast(() => getOrCreateCompartmentDbKey('alice@x.test', 'rt'));
    const b = await fast(() => getOrCreateCompartmentDbKey('bob@x.test', 'rt'));
    expect(a).not.toBe(b);
  });

  it('refuses to derive a compartment service from an empty userId', async () => {
    await expect(getOrCreateCompartmentDbKey('', 'rt')).rejects.toThrow(/userId/);
  });
});

describe('getOrCreateGroupWrapKey / getOrCreateMerkleSeqHmacKey', () => {
  it('mint a 32-byte base64 secret and are idempotent on a second call', async () => {
    const first = await fast(() => getOrCreateGroupWrapKey(USER));
    expect(Buffer.from(first, 'base64')).toHaveLength(32);

    const second = await fast(() => getOrCreateGroupWrapKey(USER));
    expect(second).toBe(first);
    // Idempotent means exactly ONE write — a second mint would make every
    // already-wrapped group_master_keys row undecryptable.
    expect(mock.setCalls.filter(c => c.service === WRAP_SVC)).toHaveLength(1);
  });

  it('do NOT mint over a real secret after a transient miss (B-15b)', async () => {
    const stored = Buffer.alloc(32, 9).toString('base64');
    mock.store.set(WRAP_SVC, stored);
    mock.flakyMisses.set(WRAP_SVC, 2);

    await expect(fast(() => getOrCreateGroupWrapKey(USER))).resolves.toBe(stored);
    expect(mock.setCalls).toHaveLength(0);
  });

  it('the merkle-seq HMAC key lives in its OWN service, distinct from the group-wrap one', async () => {
    const wrap   = await fast(() => getOrCreateGroupWrapKey(USER));
    const merkle = await fast(() => getOrCreateMerkleSeqHmacKey(USER));

    expect(merkle).not.toBe(wrap);
    expect(Buffer.from(merkle, 'base64')).toHaveLength(32);
    const services = mock.setCalls.map(c => c.service);
    expect(services).toContain(WRAP_SVC);
    expect(services).toContain(MERKLE_SVC);
  });

  it('survive a throwing keystore on the merkle read without re-minting', async () => {
    const stored = Buffer.alloc(32, 3).toString('base64');
    mock.store.set(MERKLE_SVC, stored);
    mock.flakyThrows.set(MERKLE_SVC, 3);

    await expect(fast(() => getOrCreateMerkleSeqHmacKey(USER))).resolves.toBe(stored);
    expect(mock.setCalls).toHaveLength(0);
  });

  it('both refuse an empty userId rather than writing a shared global entry', async () => {
    await expect(getOrCreateGroupWrapKey('')).rejects.toThrow(/userId/);
    await expect(getOrCreateMerkleSeqHmacKey('')).rejects.toThrow(/userId/);
    expect(mock.setCalls).toHaveLength(0);
  });
});

describe('write policy — strict options with an observable fallback (P0-S2)', () => {
  it('writes hardware-backed + passcode-gated when the device allows it', async () => {
    await fast(() => getOrCreateCompartmentDbKey(USER, 'rt'));

    const write = mock.setCalls.find(c => c.service === SVC.rt)!;
    expect(write.accessible).toBe('passcode-set-this-device-only');
    expect(write.securityLevel).toBe('sh');
  });

  it('falls back to WHEN_UNLOCKED_THIS_DEVICE_ONLY (and warns) on a no-screen-lock device', async () => {
    // A hard failure here would lock the user out of the messenger before
    // they have even set a passcode.
    mock.strictWriteFails.add(SVC.rt);

    const key = await fast(() => getOrCreateCompartmentDbKey(USER, 'rt'));

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const writes = mock.setCalls.filter(c => c.service === SVC.rt);
    expect(writes).toHaveLength(1);              // the strict attempt threw before recording
    expect(writes[0].accessible).toBe('unlocked-this-device-only');
    expect(writes[0].securityLevel).toBeUndefined();
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('strict-options write failed');
    // The fallback must still return the key that was actually stored.
    expect(mock.store.get(SVC.rt)).toBe(key);
  });
});

describe('destroy* — the wipe surface', () => {
  it('each destroy targets exactly its own service and leaves the others alone', async () => {
    mock.store.set(LEGACY_SVC, KEY64);
    mock.store.set(SVC.id, KEY64);
    mock.store.set(SVC.rt, KEY64);
    mock.store.set(WRAP_SVC, 'w');
    mock.store.set(MERKLE_SVC, 'm');

    await destroyCompartmentDbKey(USER, 'id');
    expect(mock.store.has(SVC.id)).toBe(false);
    expect(mock.store.has(SVC.rt)).toBe(true);

    await destroyDbKey(USER);
    expect(mock.store.has(LEGACY_SVC)).toBe(false);

    await destroyGroupWrapKey(USER);
    await destroyMerkleSeqHmacKey(USER);
    expect(mock.store.has(WRAP_SVC)).toBe(false);
    expect(mock.store.has(MERKLE_SVC)).toBe(false);
    expect(mock.store.has(SVC.rt)).toBe(true);
  });

  it('an empty userId destroys NOTHING — never the unscoped service', async () => {
    await destroyCompartmentDbKey('', 'rt');
    await destroyGroupWrapKey('');
    await destroyMerkleSeqHmacKey('');
    expect(mock.resetCalls).toHaveLength(0);
  });
});
