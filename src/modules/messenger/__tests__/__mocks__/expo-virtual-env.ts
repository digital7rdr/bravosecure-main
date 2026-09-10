/**
 * B-153 — Jest stub for `expo/virtual/env`.
 *
 * `babel-preset-expo` (loaded via the root `babel.config.js`) rewrites
 * `process.env.EXPO_PUBLIC_*` reads into an import from the virtual
 * module `expo/virtual/env`. That file ships as untranspiled ESM
 * (`export const env = process.env;`) and lives in `node_modules`, which
 * the `messenger-crypto` project deliberately does NOT transform
 * (`transformIgnorePatterns` allows only `@noble/hashes`). Any test that
 * transitively imports `@utils/constants` therefore died at load with
 * `SyntaxError: Unexpected token 'export'`.
 *
 * It presented as a FLAKE rather than a hard failure because babel's
 * inline-env-vars pass emits the import only when it does not already
 * have a literal value to inline, and jest's on-disk transform cache
 * let earlier runs' output survive — so the same suite passed alone and
 * failed inside a full run, and the failing suite moved between runs.
 *
 * Mapped by `moduleNameMapper`, so the import resolves to this CommonJS-
 * transpilable file instead. Semantics are identical to the real module.
 */

export const env = process.env;
