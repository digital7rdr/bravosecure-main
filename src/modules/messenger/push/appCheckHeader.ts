/**
 * AUDIT-2026-08-13 #6 (client half) — mint the X-Firebase-AppCheck header
 * for the five App-Check-guarded push routes (/push/register*,
 * /push/unregister*, /push/token-health).
 *
 * FAIL-SOFT BY DESIGN: until the Firebase console has an attestation
 * provider configured (Play Integrity / App Attest — operator setup, not
 * code), `getToken` rejects and this returns `{}` — requests are then
 * byte-identical to the pre-#6 client, and the server's warn-only mode
 * admits them. Once the console is configured, tokens flow with NO
 * further client change, the server's warn-log goes quiet, and the
 * operator can flip APP_CHECK_MODE=enforce (the flip checklist lives in
 * app-check.guard.ts and REMAINING_TODO).
 *
 * Never throws: a push registration must not fail because attestation
 * infrastructure is missing — the guard's own design doc makes the same
 * call server-side (a guard misconfig must never take messaging down).
 */
// The RNFB module is required LAZILY inside the fail-soft boundary: its
// dist ships ES modules the messenger-crypto babel chain cannot parse
// (the B-153 `expo/virtual/env` class), and a build without the native
// module must degrade to {} rather than crash at import time. The
// NAMESPACED api (firebase.appCheck()) is used because the modular d.ts
// does not export ReactNativeFirebaseAppCheckProvider (only the Module
// factory does).
type AppCheckInstance = ReturnType<typeof import('@react-native-firebase/app-check')['firebase']['appCheck']>;

let appCheckInit: Promise<AppCheckInstance> | null = null;

function ensureInit(): Promise<AppCheckInstance> {
  if (!appCheckInit) {
    appCheckInit = (async () => {
      const {firebase} = require('@react-native-firebase/app-check') as typeof import('@react-native-firebase/app-check');
      const ac = firebase.appCheck();
      const provider = ac.newReactNativeFirebaseAppCheckProvider();
      provider.configure({
        android: {provider: 'playIntegrity'},
        apple:   {provider: 'appAttestWithDeviceCheckFallback'},
      });
      await ac.initializeAppCheck({provider, isTokenAutoRefreshEnabled: true});
      return ac;
    })();
    // A failed init must not poison every later attempt with the same
    // rejected promise — clear so the next call retries fresh.
    appCheckInit.catch(() => { appCheckInit = null; });
  }
  return appCheckInit;
}

/**
 * Returns `{'X-Firebase-AppCheck': <token>}` when attestation is
 * available, `{}` otherwise. Spread into the request headers.
 */
export async function appCheckHeader(): Promise<Record<string, string>> {
  try {
    const ac = await ensureInit();
    const result = await ac.getToken(false);
    return result?.token ? {'X-Firebase-AppCheck': result.token} : {};
  } catch {
    return {};
  }
}
