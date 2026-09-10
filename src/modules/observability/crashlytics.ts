/**
 * Crashlytics + Analytics wrapper.
 *
 * Why a wrapper instead of importing @react-native-firebase/* directly:
 *   - Keeps a single chokepoint for redaction. Crash reports must NOT
 *     contain plaintext message bodies, identity keys, or session
 *     fingerprints. Every `log()` and `recordError()` call passes
 *     through `redact()` here.
 *   - Lets unit tests stub the whole surface with one mock module.
 *   - Lets us no-op on web / dev / Jest without try/catch sprinkled
 *     across the codebase.
 *
 * Crashlytics is opt-out at runtime via `setEnabled(false)` — we leave
 * collection enabled by default but expose a hook so the Privacy screen
 * can flip it off without rebuilding.
 *
 * Native integration:
 *   - Android: gradle plugin in android/app/build.gradle uploads R8 +
 *     Hermes mapping files on every release build.
 *   - iOS:     handled by the @react-native-firebase/crashlytics
 *     CocoaPods script-phase added by the expo config plugin.
 */

// B-702 (2026-08-29) — MODULAR API, not the deprecated namespaced getters.
// Every `crashlytics()` / `analytics()` call logged a native init-check line
// AND an RNFB deprecation warn; during the B-701 redeliver churn (one
// breadcrumb per envelope pass) that flooded device logcat at ~5 lines/sec
// and materially slowed live debugging on the founder's phone. The modular
// functions hit the same native module without either log source, and the
// instances are resolved once and cached.
import {
  getCrashlytics,
  log as clLog,
  recordError as clRecordError,
  setAttribute as clSetAttribute,
  setUserId as clSetUserId,
  setCrashlyticsCollectionEnabled as clSetCollectionEnabled,
  crash as clCrash,
} from '@react-native-firebase/crashlytics';
import {
  getAnalytics,
  logEvent as anLogEvent,
  setUserId as anSetUserId,
  setAnalyticsCollectionEnabled as anSetCollectionEnabled,
} from '@react-native-firebase/analytics';
import type {FirebaseCrashlyticsTypes} from '@react-native-firebase/crashlytics';
import type {FirebaseAnalyticsTypes} from '@react-native-firebase/analytics';

// Resolved lazily (the default app may not be ready at module-eval on a cold
// start) and cached so the native lookup runs once per process, not per call.
let clInstance: FirebaseCrashlyticsTypes.Module | null = null;
let anInstance: FirebaseAnalyticsTypes.Module | null = null;
function cl(): FirebaseCrashlyticsTypes.Module {
  if (!clInstance) {clInstance = getCrashlytics();}
  return clInstance;
}
function an(): FirebaseAnalyticsTypes.Module {
  if (!anInstance) {anInstance = getAnalytics();}
  return anInstance;
}

// ── Redaction ──────────────────────────────────────────────────────
// Crashlytics breadcrumbs (`log`) and custom keys are visible in the
// Firebase console, which means anyone with project access can read
// them. NEVER pass plaintext message content, identity keys, signal
// session state, or auth tokens through this module.
//
// `redact()` is the last line of defense. The patterns here match the
// shapes that have shown up in past incidents (b64 keys, JWTs, PEM
// blocks, hex fingerprints). Add to this list when you find new ones.
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g, '<pem>'],
  [/[A-Fa-f0-9]{40,}/g, '<hex>'],
  [/[A-Za-z0-9+/]{43}=/g, '<b64-32>'], // base64-encoded 32-byte key
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <token>'],
];

function redact(input: string): string {
  let out = input;
  for (const [re, sub] of REDACT_PATTERNS) {
    out = out.replace(re, sub);
  }
  // Cap length — Firebase truncates anyway, but stack traces with raw
  // memory dumps can balloon and dominate the report.
  return out.length > 4000 ? out.slice(0, 4000) + '…<truncated>' : out;
}

// ── Initialization ─────────────────────────────────────────────────

let initialized = false;

export function initCrashlytics(): void {
  if (initialized) {return;}
  initialized = true;

  try {
    // Tag the build so we can filter the dashboard by env.
    const env = process.env.EXPO_PUBLIC_API_BASE_URL?.includes('94-136-184-52')
      ? 'staging'
      : process.env.EXPO_PUBLIC_API_BASE_URL?.includes('127.0.0.1')
        ? 'local'
        : 'production';
    void clSetAttribute(cl(), 'env', env);
    clLog(cl(), `[bravo.observability] crashlytics ready env=${env}`);
  } catch (e) {
    // Crashlytics not available (web, Jest, or first launch before
    // google-services finished init). Silent no-op — we don't want
    // observability code to crash the app.
    if (__DEV__) {console.warn('[bravo.observability] init failed:', e);}
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record a non-fatal JS error. Use for caught exceptions where the
 * app continues running (e.g. failed-to-decrypt envelope, message
 * send retry exhausted). Fatal crashes (red box, native segfaults)
 * are recorded automatically by the SDK.
 */
export function recordError(err: unknown, context?: Record<string, string | number | boolean>): void {
  try {
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        void clSetAttribute(cl(), k, redact(String(v)));
      }
    }
    if (err instanceof Error) {
      const safe = new Error(redact(err.message));
      safe.name = err.name;
      safe.stack = err.stack ? redact(err.stack) : undefined;
      clRecordError(cl(), safe);
    } else {
      clRecordError(cl(), new Error(redact(String(err))));
    }
  } catch {
    /* never throw from observability */
  }
}

/**
 * Add a breadcrumb (visible in the timeline preceding a crash). Keep
 * messages short and structured: `[bravo.area] action key=value`.
 * NEVER pass user-generated content here.
 */
export function log(message: string): void {
  try {
    clLog(cl(), redact(message));
  } catch {
    /* never throw */
  }
  // Diagnostic: the deliver/receive path reports decrypt-failure reasons
  // (ws-handle-failed, ws-identity-rotation, identity-mismatch) via this
  // wrapper, not console — mirror them into the group-call trace file when
  // the diagnostic flag is set. No-op otherwise. Lazy require avoids any
  // import cycle and keeps this module dependency-light.
  try {
    const {mirrorToFile} = require('./fileLog') as typeof import('./fileLog');
    mirrorToFile('CRASH', message);
  } catch {
    /* fileLog unavailable — fine */
  }
}

/**
 * Stamp the current user id on subsequent reports. Use a hashed /
 * pseudonymous id, not a phone number or email.
 */
export function setUser(id: string | null): void {
  try {
    void clSetUserId(cl(), id ?? '');
    if (id) {void anSetUserId(an(), id);}
  } catch {
    /* never throw */
  }
}

/**
 * Tag a long-lived attribute on every subsequent crash report.
 * Examples: `app_screen`, `runtime_mode`, `network_kind`.
 */
export function setAttribute(key: string, value: string | number | boolean): void {
  try {
    void clSetAttribute(cl(), key, redact(String(value)));
  } catch {
    /* never throw */
  }
}

/**
 * Track a product event for Analytics. Strings are redacted but param
 * names are passed through as-is — stick to a fixed event taxonomy.
 */
export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  try {
    const cleaned: Record<string, string | number | boolean> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        cleaned[k] = typeof v === 'string' ? redact(v) : v;
      }
    }
    void anLogEvent(an(), name, cleaned);
  } catch {
    /* never throw */
  }
}

/**
 * Toggle collection at runtime — wired up to the Privacy screen.
 * Default is enabled (set in app.json).
 */
export async function setCollectionEnabled(enabled: boolean): Promise<void> {
  try {
    await clSetCollectionEnabled(cl(), enabled);
    await anSetCollectionEnabled(an(), enabled);
  } catch {
    /* never throw */
  }
}

/**
 * Test-only — force a native crash so you can verify the dashboard
 * receives reports end-to-end. NEVER call this from production code
 * paths; it's gated by __DEV__ and an explicit flag.
 */
export function devForceCrash(): void {
  if (!__DEV__) {return;}
  try {
    clCrash(cl());
  } catch {
    /* native crash() doesn't return; this catches the no-op path */
  }
}
