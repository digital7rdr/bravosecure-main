/**
 * B-304 — the messenger-crypto "moving flake" is a leaked debounce timer.
 *
 * `ensureDirectoryNames` arms a 300ms debounced flush. A suite that
 * finishes faster than that leaves the timer armed; it fires after Jest
 * has torn the environment down, `flush()` reaches for a module, and the
 * resulting error is attributed to whatever unrelated suite happens to be
 * running. That is why the failure MOVES and why the accused suite always
 * passes in isolation — and why CLAUDE.md told sessions for weeks to
 * "run it twice". sqa.md records 18 occasions where a red run was waved
 * through as this flake.
 *
 * The fix is a registry: a module holding teardown-unsafe state adds its
 * own cleanup to `globalThis.__bravoTestCleanups` at load time, and
 * `jest.setup.messenger-crypto.js` drains it in a global afterEach.
 *
 * This suite pins BOTH halves, because either alone fails silently:
 * the registration (delete the line in directoryNames.ts and the timer
 * leaks again) and the drain (delete setupFilesAfterEach and nothing
 * calls it). Both were mutation-proven RED before landing.
 */

// @utils/constants reads process.env.EXPO_PUBLIC_* — babel-preset-expo
// rewrites that into an `expo/virtual/env` import the node project cannot
// transform. Mock the one constant this module needs (same pattern as
// phoneNormalize.test.ts, B-153).
jest.mock('@utils/constants', () => ({API_BASE_URL: 'http://test.invalid'}));

// The module builds a UsersHttpClient lazily; never let a test reach the
// network even if a timer does survive.
jest.mock('@services/api', () => ({
  tokenStore: {get: () => 'test-token'},
  refreshAccessTokenShared: async () => 'test-token',
}));

import {ensureDirectoryNames, _resetDirectoryNamesForTests} from '../contacts/directoryNames';

type CleanupRegistry = Set<() => void>;
function registry(): CleanupRegistry | undefined {
  return (globalThis as {__bravoTestCleanups?: CleanupRegistry}).__bravoTestCleanups;
}

describe('B-304 — directoryNames cannot leak a timer past teardown', () => {
  it('the messenger-crypto project installs the cleanup registry', () => {
    // Guards the setup wiring itself: if setupFilesAfterEnv is dropped
    // from package.json, no module can register and the leak returns
    // with no other test noticing.
    expect(registry()).toBeInstanceOf(Set);
  });

  it('directoryNames registers its own cleanup when the module loads', () => {
    // Guards the one line at the bottom of directoryNames.ts. Asserting
    // the registry is non-empty is not enough — a future module could
    // satisfy that while this one silently stopped registering.
    const reg = registry();
    expect(reg).toBeDefined();
    expect(reg!.has(_resetDirectoryNamesForTests)).toBe(true);
  });

  it('draining the registry clears an armed debounce timer', () => {
    const cleared: unknown[] = [];
    const realClearTimeout = globalThis.clearTimeout;
    // Spy rather than fake timers: the point is that the REAL handle the
    // module is holding gets cleared, which fake timers would hide.
    (globalThis as {clearTimeout: typeof clearTimeout}).clearTimeout = ((h: unknown) => {
      cleared.push(h);
      return (realClearTimeout as (x: unknown) => void)(h);
    }) as typeof clearTimeout;

    try {
      ensureDirectoryNames(['b-304-user-id']);
      // Arming is a precondition, not the assertion — if ensureDirectoryNames
      // stops using a timer this test should be revisited, not silently pass.
      for (const cleanup of registry()!) {cleanup();}
      expect(cleared.length).toBeGreaterThan(0);
    } finally {
      (globalThis as {clearTimeout: typeof clearTimeout}).clearTimeout = realClearTimeout;
      _resetDirectoryNamesForTests();
    }
  });

  it('a queued lookup does not survive into the next test', () => {
    // The end-to-end contract: this test arms the timer and ends. The
    // global afterEach must clear it. If it does not, the 300ms flush
    // fires into a torn-down environment and some LATER suite goes red.
    ensureDirectoryNames(['b-304-orphan-id']);
    expect(true).toBe(true);
  });

  it('the previous test left nothing armed', () => {
    // Re-arming the SAME id proves the session cache was reset too: if
    // `attempted`/`pending` had survived, ensureDirectoryNames would
    // dedupe this id away and never arm a timer at all.
    const cleared: unknown[] = [];
    const realClearTimeout = globalThis.clearTimeout;
    (globalThis as {clearTimeout: typeof clearTimeout}).clearTimeout = ((h: unknown) => {
      cleared.push(h);
      return (realClearTimeout as (x: unknown) => void)(h);
    }) as typeof clearTimeout;
    try {
      ensureDirectoryNames(['b-304-orphan-id']);
      for (const cleanup of registry()!) {cleanup();}
      expect(cleared.length).toBeGreaterThan(0);
    } finally {
      (globalThis as {clearTimeout: typeof clearTimeout}).clearTimeout = realClearTimeout;
      _resetDirectoryNamesForTests();
    }
  });
});
