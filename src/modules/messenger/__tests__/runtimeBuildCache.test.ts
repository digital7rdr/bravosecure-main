/**
 * P1-2 — an offline/failed cold boot must NOT brick the messenger for the
 * process lifetime. `getMessengerRuntime` used to cache the promise returned by
 * `buildRuntime` unconditionally; when the build REJECTED (bare-fetch
 * `publishOwnBundle` throwing offline, or a transient auth-service 5xx) the
 * rejected promise stayed cached forever — zero history, no sends, until a
 * force-kill. The fix clears the cached singleton on rejection so the next call
 * retries a fresh build.
 *
 * We drive `buildRuntime` to reject via the production-mode-without-config path,
 * which throws BEFORE any native store / transport init — so this stays a pure
 * node unit test. The heavy RN/native imports pulled in transitively by
 * runtime.ts are stubbed below.
 */

jest.mock('react-native', () => ({Platform: {OS: 'test'}}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    jest.fn(async () => null),
    setItem:    jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));
jest.mock('../runtime/keychain', () => ({getOrCreateDbKey: jest.fn(async () => 'deadbeefdeadbeef')}));
// crypto/index re-exports the native op-sqlite store — stub it so importing
// runtime.ts stays node-safe. The names are only USED inside functions the
// no-config reject path never reaches.
jest.mock('../crypto', () => ({}));

import {getMessengerRuntime, _resetMessengerRuntime} from '../runtime/runtime';

describe('getMessengerRuntime — P1-2 does not cache a rejected build', () => {
  beforeEach(() => { _resetMessengerRuntime(); });

  it('clears the cached promise when the build rejects so the next call RETRIES', async () => {
    const p1 = getMessengerRuntime('production'); // no config → buildRuntime rejects pre-native-init
    await expect(p1).rejects.toThrow(/configureMessengerRuntime/);

    const p2 = getMessengerRuntime('production');
    // A cached REJECTED promise would be the SAME object (the pre-fix brick);
    // the fix cleared the singleton so this is a fresh build attempt.
    expect(p2).not.toBe(p1);
    await expect(p2).rejects.toThrow(/configureMessengerRuntime/);
  });

  it('shares ONE in-flight promise across concurrent calls (no premature clear)', async () => {
    const a = getMessengerRuntime('production');
    const b = getMessengerRuntime('production');
    expect(b).toBe(a); // both callers coalesce onto the single in-flight build
    await expect(a).rejects.toThrow(); // drain to avoid an unhandled rejection
  });
});
