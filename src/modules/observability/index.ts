export {
  initCrashlytics,
  recordError,
  log,
  setUser,
  setAttribute,
  trackEvent,
  setCollectionEnabled,
  devForceCrash,
} from './crashlytics';
export {ErrorBoundary} from './ErrorBoundary';
export {withScreenErrorBoundary} from './withScreenErrorBoundary';
export {TestCrashButton} from './TestCrashButton';
// Audit fix 5.4 — Sentry shim (lives alongside crashlytics; both can
// be active. Crashlytics is the Firebase-backed crash reporter the app
// has shipped with; Sentry covers structured ops breadcrumbs + the
// audit-failure alert path).
export {
  captureException,
  addBreadcrumb,
  setSentryUser,
  isSentryEnabled,
} from './sentry';
