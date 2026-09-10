/**
 * B-15b — read-hardening regression for the SQLCipher key landmine.
 *
 * `Keychain.getGenericPassword` can transiently return `false` (Android Keystore
 * miss under load / cold boot; MIUI/StrongBox flakiness) even when a real entry
 * exists. A single such miss used to make getOrCreateDbKey MINT a fresh key over
 * the real one → the on-disk SQLCipher DB became permanently undecryptable
 * ("my chat history disappeared"). These tests pin the contract: a flaky
 * miss-then-hit returns the REAL key and NEVER writes (no mint-over), while a
 * genuine fresh install still mints exactly one new key.
 */

jest.mock('react-native-keychain', () => {
  const state = {
    store: new Map<string, string>(),
    // service -> number of forced `false` returns before a real read succeeds
    flakyMisses: new Map<string, number>(),
    setCalls: [] as Array<{service: string; password: string}>,
  };
  return {
    __esModule: true,
    __state: state,
    SECURITY_LEVEL: {SECURE_HARDWARE: 'sh', SECURE_SOFTWARE: 'ss'},
    ACCESSIBLE: {
      WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'a',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'b',
    },
    setGenericPassword: async (_account: string, password: string, opts: {service: string}) => {
      state.store.set(opts.service, password);
      state.setCalls.push({service: opts.service, password});
      return true;
    },
    getGenericPassword: async (opts: {service: string}) => {
      const remaining = state.flakyMisses.get(opts.service) ?? 0;
      if (remaining > 0) {
        state.flakyMisses.set(opts.service, remaining - 1);
        return false; // simulate a transient keystore miss
      }
      const password = state.store.get(opts.service);
      return password ? {username: 'x', password, service: opts.service} : false;
    },
    resetGenericPassword: async (opts: {service: string}) => {
      state.store.delete(opts.service);
      return true;
    },
  };
});

interface MockState {
  store: Map<string, string>;
  flakyMisses: Map<string, number>;
  setCalls: Array<{service: string; password: string}>;
}
const mock = (jest.requireMock('react-native-keychain') as {__state: MockState}).__state;

import {getOrCreateDbKey, getOrCreateCompartmentDbKey} from '../runtime/keychain';

const USER = 'flaky@bravo.test';
const REAL_KEY = 'a'.repeat(64); // 64-hex = 32 bytes, passes the length gate
const DB_SERVICE = `bravo.messenger.dbkey.${USER}`;
const RT_SERVICE = `bravo.messenger.dbkey.rt.${USER}`;

beforeEach(() => {
  mock.store.clear();
  mock.flakyMisses.clear();
  mock.setCalls.length = 0;
});

describe('getOrCreateDbKey — flaky-read hardening (B-15b)', () => {
  it('returns the REAL key after a single transient miss, and does NOT mint', async () => {
    mock.store.set(DB_SERVICE, REAL_KEY);
    mock.flakyMisses.set(DB_SERVICE, 1); // first read misses, retry hits

    const got = await getOrCreateDbKey(USER);

    expect(got).toBe(REAL_KEY);
    expect(mock.setCalls.filter(c => c.service === DB_SERVICE)).toHaveLength(0);
    expect(mock.store.get(DB_SERVICE)).toBe(REAL_KEY); // unchanged
  });

  it('survives 3 consecutive transient misses and still recovers the real key', async () => {
    mock.store.set(DB_SERVICE, REAL_KEY);
    mock.flakyMisses.set(DB_SERVICE, 3); // misses on attempts 1-3, hit on 4

    const got = await getOrCreateDbKey(USER);

    expect(got).toBe(REAL_KEY);
    expect(mock.setCalls).toHaveLength(0);
  });

  it('mints exactly one new key on a genuine fresh install (no entry)', async () => {
    const got = await getOrCreateDbKey(USER);

    expect(got).toMatch(/^[0-9a-f]{64}$/); // freshly minted 32-byte hex
    const writes = mock.setCalls.filter(c => c.service === DB_SERVICE);
    expect(writes).toHaveLength(1);
    expect(writes[0].password).toBe(got);
  });
});

describe('getOrCreateCompartmentDbKey — flaky-read hardening (B-15b)', () => {
  it('returns the REAL compartment key after a transient miss without minting', async () => {
    mock.store.set(RT_SERVICE, REAL_KEY);
    mock.flakyMisses.set(RT_SERVICE, 2);

    const got = await getOrCreateCompartmentDbKey(USER, 'rt');

    expect(got).toBe(REAL_KEY);
    expect(mock.setCalls.filter(c => c.service === RT_SERVICE)).toHaveLength(0);
  });
});
