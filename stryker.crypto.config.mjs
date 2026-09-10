// Stryker mutation testing config — scoped to messenger/crypto only.
//
// Why scoped: mutation testing is expensive (10-100x slower than unit tests).
// We focus on the highest-stakes code: crypto primitives, key management,
// session establishment. A passing test that doesn't catch a flipped `>` to
// `>=` in a constant-time compare is a security bug waiting to happen.
//
// Run locally:  npm run mutation:crypto
// Run in CI:    .github/workflows/mutation.yml (weekly)

export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    config: {
      // Use the messenger-crypto Jest project config.
      preset: undefined,
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/modules/messenger/__tests__/**/*.test.ts',
        // AUDIT #7 — core's own suites are the natural killers for the core
        // mutants added to `mutate` below (mirrors the messenger-crypto
        // jest project's two test roots).
        '<rootDir>/packages/messenger-core/__tests__/**/*.test.ts',
      ],
      transform: {
        '^.+\\.(ts|tsx|js|jsx)$': [
          'babel-jest',
          {
            presets: [
              ['@babel/preset-env', {targets: {node: 'current'}}],
              '@babel/preset-typescript',
            ],
          },
        ],
      },
      transformIgnorePatterns: ['/node_modules/(?!(@noble/hashes)/)'],
      // AUDIT #7 rev-3 — this block MUST mirror the messenger-crypto jest
      // project's mapper. Two independently-measured failures without it:
      // (1) `enableFindRelatedTests` selects killers via jest-resolve, NOT
      // babel — without the @bravo alias every core mutant resolved to ZERO
      // related tests (0 vs 152 measured), so the added core mutate glob was
      // a no-op; (2) the perTest dry-run imports suites that hit
      // expo/virtual/env etc. (B-153 mechanism) and aborted the whole run
      // before mutating anything — pre-existing, fixed by the same block.
      moduleNameMapper: {
        '^expo/virtual/env$': '<rootDir>/src/modules/messenger/__tests__/__mocks__/expo-virtual-env.ts',
        '^react-native-argon2$': '<rootDir>/src/modules/messenger/__tests__/__mocks__/react-native-argon2.ts',
        '^react-native-quick-crypto$': '<rootDir>/src/modules/messenger/__tests__/__mocks__/react-native-quick-crypto.ts',
        '^@bravo/messenger-core$': '<rootDir>/packages/messenger-core/src',
        '^@bravo/messenger-core/(.*)$': '<rootDir>/packages/messenger-core/src/$1',
      },
      setupFiles: ['<rootDir>/packages/messenger-core/__tests__/setup.ts'],
    },
    enableFindRelatedTests: true,
  },
  mutate: [
    // AUDIT-2026-08-13 #7 — the crypto primitives (sealPayload, senderCert,
    // outerEcies, SessionManager, groupCrypto, identity/rotation) live in
    // messenger-core; the mobile files under src/modules/messenger/crypto are
    // tombstone re-exports + RN-specific stores. Without the core glob this
    // gate would go green mutating only SQLCipher storage and polyfills while
    // every primitive escaped mutation (edge-reviewer catch).
    'packages/messenger-core/src/crypto/**/*.ts',
    'src/modules/messenger/crypto/**/*.ts',
    '!src/modules/messenger/crypto/**/*.test.ts',
    '!src/modules/messenger/crypto/**/*.spec.ts',
  ],
  thresholds: {high: 80, low: 60, break: 50},
  timeoutMS: 15000,
  concurrency: 4,
  coverageAnalysis: 'perTest',
  htmlReporter: {fileName: 'reports/mutation/index.html'},
  jsonReporter: {fileName: 'reports/mutation/mutation.json'},
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
