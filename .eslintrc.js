// Bravo Secure — ESLint Configuration
// Extends @react-native which bundles: @typescript-eslint, react, react-hooks, react-native rules.
'use strict';

module.exports = {
  root: true,
  extends: ['@react-native'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {jsx: true},
  },
  plugins: ['@typescript-eslint'],

  rules: {
    // ── TypeScript: catch real bugs ─────────────────────────────
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
    ],
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    // Options (audit-campaign commit 2026-08-14): the two classes where
    // `??` would be a BUG are excluded by policy rather than eaten as
    // warnings — boolean conditions (`a || b` with a nullable boolean
    // changes logic under `??` when a === false) and string fallbacks
    // (`p.title || 'Message'` must fall through on '' — wire payloads
    // can carry empty strings). Both options match typescript-eslint's
    // own later defaults/recommendations.
    '@typescript-eslint/prefer-nullish-coalescing': [
      'warn',
      {
        ignoreConditionalTests: true,
        ignorePrimitives: {string: true},
      },
    ],
    '@typescript-eslint/prefer-optional-chain': 'warn',
    '@typescript-eslint/consistent-type-imports': ['warn', {prefer: 'type-imports'}],

    // ── React / RN ──────────────────────────────────────────────
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // ── General correctness ─────────────────────────────────────
    'no-console': ['warn', {allow: ['warn', 'error']}],
    'no-unused-vars': 'off', // covered by @typescript-eslint/no-unused-vars
    eqeqeq: ['error', 'always'],
    'no-return-assign': 'error',
    'no-shadow': 'off', // @typescript-eslint version handles TS enums etc.
    '@typescript-eslint/no-shadow': 'error',

    // ── Style (non-blocking) ────────────────────────────────────
    'react-native/no-unused-styles': 'warn',
    'react-native/no-inline-styles': 'off', // we use inline styles intentionally
    'react-native/no-color-literals': 'off', // managed via design-system tokens
  },

  overrides: [
    {
      // Relax rules inside test files
      files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-console': 'off',
      },
    },
    {
      // Backend service (NestJS) — no React rules needed
      files: ['apps/**/*.ts'],
      rules: {
        'react-hooks/rules-of-hooks': 'off',
        'react-hooks/exhaustive-deps': 'off',
        'react-native/no-unused-styles': 'off',
      },
    },
    {
      // Messenger module + screens — relax stylistic rules that
      // produce hundreds of low-value warnings (no-void on
      // fire-and-forget promises, no-console on the [bravo.*]
      // logcat tags we explicitly use to debug calls/backups, etc.)
      // Real correctness rules stay on (no-floating-promises,
      // no-misused-promises, eqeqeq, no-shadow, …).
      //
      // Broadened beyond messenger to cover the rest of the mobile
      // screen tree (agent, booking, dashboard, ops, wallet, etc.).
      // Same patterns appear across these UI files: `void asyncFn()`
      // for fire-and-forget, conditional StyleSheet entries that
      // unused-styles flags as dead. The rule intent is identical —
      // relax style noise, keep real correctness.
      files: [
        'src/modules/messenger/**/*.{ts,tsx}',
        'src/modules/observability/**/*.{ts,tsx}',
        'src/screens/**/*.{ts,tsx}',
        'src/services/**/*.{ts,tsx}',
        'src/navigation/**/*.{ts,tsx}',
        // Same code class as src/modules/messenger — the platform-
        // agnostic crypto core uses the same `void promise` /
        // exhaustiveness idioms.
        'packages/messenger-core/src/**/*.{ts,tsx}',
      ],
      rules: {
        // We use `console.log('[bravo.*] ...')` extensively to make
        // call/audio/backup events visible in logcat. The default
        // 'no-console: warn' would drown out that signal.
        'no-console': 'off',
        // `void promise` is the idiomatic way to mark a fire-and-
        // forget Promise (matches @typescript-eslint/no-floating-
        // promises requirements). The base no-void rule fights it.
        'no-void': 'off',
        // Stylistic only — type-only imports save a few KB but the
        // diff churn isn't worth it across this many files.
        '@typescript-eslint/consistent-type-imports': 'off',
        // RN-WebRTC spec leaks `MediaStream`-style structures
        // through getSenders/getParameters and we narrow them with
        // typed casts; non-null assertions on those narrow casts
        // are intentional, not bugs.
        '@typescript-eslint/no-non-null-assertion': 'off',
        // Bitwise ops appear in the crypto path (HMAC compare,
        // byte-level tests) where bitwise IS the correct tool.
        'no-bitwise': 'off',
        // Hot styling churn — design system iterates fast and
        // unused-styles flags style entries that are conditionally
        // attached. Manual cleanup periodically; not a CI gate.
        'react-native/no-unused-styles': 'off',
      },
    },
  ],

  settings: {
    react: {version: 'detect'},
  },
};
