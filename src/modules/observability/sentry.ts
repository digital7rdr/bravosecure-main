/**
 * Audit fix 5.4 — mobile Sentry shim.
 *
 * Mirrors the auth-service `SentryService` pattern: a thin abstraction
 * so the rest of the app can call `captureException` / `addBreadcrumb`
 * without importing `@sentry/react-native` directly. If the SDK isn't
 * installed (CI builds, local development, minimal release variants)
 * the shim falls back to console logging only.
 *
 * Deploy-time:
 *   1. `npm install @sentry/react-native`
 *   2. Run the install wizard or add the postinstall hook so the
 *      native module link gets wired into `android/` and `ios/`.
 *   3. Set `EXPO_PUBLIC_SENTRY_DSN` in EAS / app.config.ts.
 *   4. The shim auto-initializes on first import; no other call sites
 *      need to change.
 *
 * Why the indirection:
 *   - The SDK pulls in a native dependency. Devs running `npm test` on
 *     Windows without the iOS pod chain shouldn't have their tests
 *     break for an observability dep.
 *   - Future swap to OpenTelemetry-only doesn't require touching call
 *     sites.
 */

type SentryRn = {
  init: (opts: {dsn: string; environment?: string; tracesSampleRate?: number; enableNative?: boolean}) => void;
  captureException: (e: unknown, ctx?: Record<string, unknown>) => void;
  addBreadcrumb: (b: {category?: string; message?: string; data?: Record<string, unknown>; level?: 'info' | 'warning' | 'error'}) => void;
  setUser: (u: {id?: string; role?: string} | null) => void;
};

let sdk: SentryRn | null = null;
let enabled = false;
let bootLogged = false;

function lazyInit(): void {
  if (bootLogged) {return;}
  bootLogged = true;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    if (__DEV__) {console.log('[sentry] disabled (no EXPO_PUBLIC_SENTRY_DSN)');}
    return;
  }
  try {

    const mod: SentryRn = require('@sentry/react-native');
    mod.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      tracesSampleRate: 0.05,
    });
    sdk = mod;
    enabled = true;
    if (__DEV__) {console.log('[sentry] enabled');}
  } catch (e) {
    if (__DEV__) {console.warn('[sentry] install missing — ' + (e as Error).message);}
  }
}

export function captureException(e: unknown, ctx?: Record<string, unknown>): void {
  lazyInit();
  if (enabled && sdk) {
    try { sdk.captureException(e, ctx); } catch { /* swallow */ }
  }
}

export function addBreadcrumb(b: {category?: string; message: string; data?: Record<string, unknown>; level?: 'info' | 'warning' | 'error'}): void {
  lazyInit();
  if (enabled && sdk) {
    try { sdk.addBreadcrumb(b); } catch { /* swallow */ }
  }
}

export function setSentryUser(u: {id: string; role?: string} | null): void {
  lazyInit();
  if (enabled && sdk) {
    try { sdk.setUser(u); } catch { /* swallow */ }
  }
}

export function isSentryEnabled(): boolean {
  lazyInit();
  return enabled;
}
