/**
 * P1-T3 — read-receipts privacy cache. Asserts:
 *  - default is ON (uninitialised cache returns true)
 *  - load() reads AsyncStorage and caches the value
 *  - set() writes through to storage and updates the cache
 *  - cache survives storage failures (best-effort persistence)
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setItem: jest.fn((k: string, v: string) => { store[k] = v; return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { delete store[k]; return Promise.resolve(); }),
      // Test helper — not part of the real API.
      __reset: () => { store = {}; },
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadReadReceiptsEnabled,
  getReadReceiptsEnabledCached,
  setReadReceiptsEnabled,
  _resetPrivacyCacheForTests,
} from '../store/privacySettings';

beforeEach(() => {
  _resetPrivacyCacheForTests();
  (AsyncStorage as unknown as {__reset: () => void}).__reset();
});

describe('P1-T3 privacySettings — read-receipts cache', () => {
  test('uninitialised cache defaults to true (legacy behaviour)', () => {
    expect(getReadReceiptsEnabledCached()).toBe(true);
  });

  test('load() returns true when nothing is persisted', async () => {
    expect(await loadReadReceiptsEnabled()).toBe(true);
    expect(getReadReceiptsEnabledCached()).toBe(true);
  });

  test('load() returns false when persisted value is "false"', async () => {
    await AsyncStorage.setItem('messenger.privacy.readReceiptsEnabled', 'false');
    _resetPrivacyCacheForTests();
    expect(await loadReadReceiptsEnabled()).toBe(false);
    expect(getReadReceiptsEnabledCached()).toBe(false);
  });

  test('set(false) flips the cache AND persists', async () => {
    await setReadReceiptsEnabled(false);
    expect(getReadReceiptsEnabledCached()).toBe(false);
    const raw = await AsyncStorage.getItem('messenger.privacy.readReceiptsEnabled');
    expect(raw).toBe('false');
  });

  test('set(true) writes "true" back so the value round-trips through storage', async () => {
    await setReadReceiptsEnabled(false);
    await setReadReceiptsEnabled(true);
    expect(getReadReceiptsEnabledCached()).toBe(true);
    _resetPrivacyCacheForTests();
    expect(await loadReadReceiptsEnabled()).toBe(true);
  });

  test('storage failure during set() still updates the in-memory cache', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await setReadReceiptsEnabled(false);
    expect(getReadReceiptsEnabledCached()).toBe(false);
    spy.mockRestore();
  });

  test('storage failure during load() falls back to default (true)', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk corrupt'));
    expect(await loadReadReceiptsEnabled()).toBe(true);
    spy.mockRestore();
  });
});
