/**
 * Jest mock for `@react-native-firebase/crashlytics` (messenger-crypto).
 *
 * The real package is ESM that the node project does not transform, and
 * `observability/crashlytics.ts` imports it at module scope — which put
 * it in productionRuntime's import chain via runtime/senderCertAdmit.ts.
 *
 * Every method is a no-op that RECORDS nothing. Crash reporting is a
 * side-effect surface: a test must never be able to assert on it through
 * this stub, or the assertion pins the mock rather than the product.
 *
 * B-702 — the wrapper migrated to the RNFB modular API, so this stub now
 * carries the named modular exports alongside the legacy default.
 */
const api = {
  setAttribute:                    async () => {},
  setAttributes:                   async () => {},
  setUserId:                       async () => {},
  log:                             () => {},
  recordError:                     () => {},
  setCrashlyticsCollectionEnabled: async () => {},
  crash:                           () => {},
};
export default function crashlytics() { return api; }

// ── Modular surface (B-702) ─────────────────────────────────────────
export function getCrashlytics() { return api; }
export function log() { /* no-op */ }
export function recordError() { /* no-op */ }
export function crash() { /* no-op */ }
export async function setAttribute() { /* no-op */ }
export async function setUserId() { /* no-op */ }
export async function setCrashlyticsCollectionEnabled() { /* no-op */ }
