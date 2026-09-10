/**
 * Audit fix 5.5 — separate Jest project for real-DB integration tests.
 *
 * Run with `npm run test:integration` inside `apps/auth-service`.
 * Tests use the testcontainers harness (see `test/integration/harness.ts`)
 * which starts an ephemeral pg, applies every migration, and tears
 * down on teardown. ~30s warm-up so this is NOT part of the default
 * test runner.
 *
 * Skip behavior: when Docker is unreachable, the harness flips
 * `bootError`, every `describeIfDb` collapses to `describe.skip`, and
 * the suite passes with 0 assertions. CI without Docker still goes
 * green.
 */
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/integration/**/*.itest.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  // 60s default — testcontainers boot + migrations comfortably fits.
  testTimeout: 60_000,
  // Don't apply the coverage threshold from the unit project; this
  // suite is for integration assertions, not coverage growth.
  collectCoverage: false,
};
