import '@/modules/messenger/crypto/polyfills';
import 'expo-dev-client';
import 'react-native-url-polyfill/auto';
import 'react-native-gesture-handler';

// Register react-native-webrtc as browser-style globals
// (RTCPeerConnection, MediaStream, MediaStreamTrack, …) so any library
// that assumes these exist on globalThis can find them. Critically:
// mediasoup-client's ReactNative106 handler does `new RTCPeerConnection()`
// without importing it — without this call, group calls boot-fail with
// `Property 'RTCPeerConnection' doesn't exist`. Must run BEFORE any
// component or hook that touches mediasoup-client mounts.
import {registerGlobals as registerWebRTCGlobals} from 'react-native-webrtc';
registerWebRTCGlobals();

import {AppRegistry} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import App from './App';
import {initCrashlytics, recordError as crashlyticsRecord} from './src/modules/observability';
import {installGroupCallFileLog} from './src/modules/observability/fileLog';
import {handleHeadlessFcm} from './src/modules/messenger/push/fcmHeadless';
import {installSlimNotifeeBgHandler} from './src/modules/messenger/push/callNotification';
import {registerMissionForegroundService} from './src/modules/agent/missionForegroundService';

// Diagnostic: mirror call/group-key console lines to a pullable file
// (no-op unless EXPO_PUBLIC_GROUPCALL_FILELOG=1). Install before
// anything else logs so the joiner's group-create:recv trace is whole.
installGroupCallFileLog();

// Boot Crashlytics + Analytics as early as possible. Must be after the
// react-native runtime is up (AppRegistry import above) but before App
// mounts so any startup error is captured.
initCrashlytics();

// ── FCM background/quit-state handler — registered at BUNDLE ENTRY (before login) ──
// This is the fix for "messages/calls only arrive when the app is open". RNFirebase's native
// messaging service (merged into the manifest) wakes a HEADLESS JS context for a killed app and
// runs THIS bundle entry — but the handler is only used if `setBackgroundMessageHandler` was
// called during that eval. Previously it was registered lazily AFTER login (fcmBootstrap), so a
// killed app had no handler and the data-only wake was dropped (no banner, no ring).
//
// `handleHeadlessFcm` is SLIM BY DESIGN: it ONLY draws the notifee message banner / full-screen
// call ring (notifee + Keychain HMAC verify). It NEVER boots the messenger runtime, SQLCipher, or
// the WS — that 2nd-VM contention with the foreground app is exactly why the old
// `registerHeadlessTask` path was removed. When the app is warm + logged in, fcmBootstrap
// re-registers a richer handler (same path) that additionally pulls + decrypts envelopes.
messaging().setBackgroundMessageHandler(handleHeadlessFcm);
// Register a SLIM notifee background-event handler at bundle entry too, so a KILLED app's
// notification taps (e.g. tapping/declining an incoming-call notif) are handled — without it,
// notifee logs "no background event handler has been set" and the call notif lingers after a tap.
installSlimNotifeeBgHandler();
// B-89 MG-03 — notifee requires the foreground-service runner to be registered at
// bundle entry; the mission-tracking FGS (CPO GPS with the screen off) starts/stops
// from useLeadTelemetry at go-live.
registerMissionForegroundService();

// ── Global error tags for logcat ──────────────────────────────────
// We tag every unhandled JS error + unhandled-rejection under the
// `[bravo.unhandled]` prefix so a developer can grep `adb logcat |
// grep bravo.unhandled` and see exactly what blew up. Without this,
// errors surface as raw stack dumps inside ReactNativeJS lines and
// it's hard to disentangle them from normal JS log noise.
//
// We DO NOT swallow the error — `isFatal=true` cases still tear the
// app down with the standard red-box / native crash. We just stamp
// a greppable line right before the runtime's own handler runs.
if (typeof ErrorUtils !== 'undefined' && ErrorUtils.setGlobalHandler) {
  const prev = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((err, isFatal) => {
    try {
      // eslint-disable-next-line no-console
      console.error(
        `[bravo.unhandled] fatal=${!!isFatal} ${err?.name ?? 'Error'}: ${err?.message}\n${err?.stack ?? ''}`,
      );
      crashlyticsRecord(err, {kind: 'global-handler', fatal: !!isFatal});
    } catch {
      /* ignore — we never want the tag to crash error reporting */
    }
    if (typeof prev === 'function') prev(err, isFatal);
  });
}
if (typeof globalThis !== 'undefined' && typeof globalThis.process === 'object') {
  // RN polyfills `process` for libraries; rely on it for unhandled
  // rejections. We attach in addition to (not instead of) any handler
  // already wired by the bridge.
  try {
    globalThis.process.on?.('unhandledRejection', reason => {
      // eslint-disable-next-line no-console
      console.warn('[bravo.unhandled] rejection:', reason?.message ?? reason);
      crashlyticsRecord(reason instanceof Error ? reason : new Error(String(reason)), {
        kind: 'unhandled-rejection',
      });
    });
  } catch {
    /* ignore */
  }
}

AppRegistry.registerComponent('main', () => App);
