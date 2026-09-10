/**
 * Jest mock for `@react-native-firebase/analytics` (messenger-crypto).
 * See firebase-crashlytics.ts — same rationale, same no-op posture.
 */
const api = {
  setUserId:                     async () => {},
  logEvent:                      async () => {},
  setAnalyticsCollectionEnabled: async () => {},
  setUserProperty:               async () => {},
};
export default function analytics() { return api; }

// ── Modular surface (B-702) ─────────────────────────────────────────
export function getAnalytics() { return api; }
export async function logEvent() { /* no-op */ }
export async function setUserId() { /* no-op */ }
export async function setAnalyticsCollectionEnabled() { /* no-op */ }
export async function setUserProperty() { /* no-op */ }
