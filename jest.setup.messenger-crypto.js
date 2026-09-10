/**
 * Setup for the `messenger-crypto` jest project — runs AFTER the test
 * framework is installed, so it can register a global `afterEach`.
 *
 * B-304 — kills the "moving flake" class (supersedes the B-126 / B-153
 * workaround of running the suite twice).
 *
 * The mechanism, per sqa.md B-304: a suite transitively calls
 * `ensureDirectoryNames`, which arms a 300ms debounced `setTimeout`
 * (`contacts/directoryNames.ts:98`). A suite that finishes in under
 * 300ms leaves that timer armed. It fires AFTER the environment is torn
 * down, `flush()` calls `getClient()`, and touching the Babel-interop
 * accessor for `API_BASE_URL` loads a module into a dead environment:
 *
 *   ReferenceError: You are trying to `import` a file after the Jest
 *   environment has been torn down.
 *
 * Jest attributes that to whichever suite happens to be RUNNING when the
 * orphan fires — never the suite that armed it. That is why the failure
 * MOVES, and why the bystander always passes in isolation.
 *
 * WHY A REGISTRY AND NOT A DIRECT IMPORT. Two cheaper-looking designs
 * were measured first and are both worse:
 *
 *  1. `afterEach(() => require('.../directoryNames')._reset...())`.
 *     Correct, but it drags `@utils/constants` and `messengerStore` into
 *     ALL 429 suites: run time 82.8s -> 101.2s. That 19s of extra load
 *     starves `safetyNumber.test.ts` (5200 awaited SHA-256 iterations,
 *     already on a raised 60s budget) until it times out — i.e. the fix
 *     manufactures the class of failure it is meant to remove.
 *  2. A generic sweep of every timer armed during a test. Worse still:
 *     Jest schedules its own per-test timeout machinery on the same
 *     global timers, so sweeping them took the run from 1 red suite to
 *     3 and cost 25s. Reset the module that owns the timer; never touch
 *     the timer primitives.
 *
 * The registry inverts the dependency: a module that owns teardown-
 * unsafe state registers its own cleanup AT LOAD TIME, so only suites
 * that actually load it pay anything. Adding the next such module is one
 * guarded line there and no change here.
 */

/** @type {Set<() => void>} */
const cleanups = new Set();

// Must exist before the test file is imported, so a module can register
// itself while it is being loaded. setupFilesAfterEnv runs first.
globalThis.__bravoTestCleanups = cleanups;

afterEach(() => {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // A cleanup must never fail the test that merely ran before it.
    }
  }
});
