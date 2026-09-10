/**
 * Metro bundler config — customizes the Expo default.
 *
 * Why this exists: packages with separate Node/browser builds via
 * conditional exports (historically `jose`, which senderCert used before
 * it moved to AsyncCurve25519 in messenger-core — AUDIT-2026-08-13 #7
 * note: src/modules/messenger/crypto/senderCert.ts is now a tombstone
 * re-export and NO RN-bundled source imports `jose` today) would resolve
 * to the Node build, which imports `node:buffer` and crashes the RN
 * bundler. Do NOT remove the resolver override on the strength of the
 * jose example being stale — other transitive packages rely on the
 * browser-condition resolution now.
 *
 * Flipping on `unstable_enablePackageExports` + setting the condition
 * priority to `['react-native', 'browser', ...]` forces jose (and any
 * other package with similar exports) to resolve to the browser-safe
 * path that uses standard `Uint8Array` + WebCrypto.
 */

const {getDefaultConfig} = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = {
  ...config.resolver,
  unstable_enablePackageExports: true,
  unstable_conditionNames: ['react-native', 'browser', 'require'],
};

module.exports = config;
