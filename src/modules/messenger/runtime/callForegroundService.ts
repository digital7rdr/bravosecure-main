/**
 * JS bridge to the native CallForegroundService (Kotlin).
 *
 * Why: Android 14+ kills mic/camera capture seconds after the activity
 * loses window focus (screen off, app backgrounded). Without a
 * foreground service holding the right typed permissions, calls
 * silently die when the user locks the phone. WhatsApp/Signal/Telegram
 * all run a foreground service for active calls — this is parity.
 *
 * Lifecycle:
 *   • startCallForegroundService({kind, peer}) — call on call mount
 *     (after the user accepts / after outgoing offer is sent). Posts
 *     the persistent notification + flips the service to FOREGROUND
 *     with FOREGROUND_SERVICE_TYPE_MICROPHONE (+ CAMERA when video).
 *   • stopCallForegroundService() — call on call unmount, but ONLY
 *     when the call is truly ending (not minimized). The
 *     FloatingCallOverlay path keeps the call alive across navigation,
 *     so we leave the service running until the registry actually
 *     clears.
 *
 * iOS is a no-op — CallKit-style background execution lives in a
 * separate path (out of scope for this fix).
 */
import {DeviceEventEmitter, NativeModules, Platform} from 'react-native';

interface CallForegroundNative {
  start: (opts: {kind: 'voice' | 'video'; peer: string}) => void;
  stop:  () => void;
  /** Optional — absent on binaries built before NA-04. */
  bringCallUiToForeground?: () => void;
}

const native: CallForegroundNative | null =
  Platform.OS === 'android' && (NativeModules as Record<string, unknown>).BravoCallForeground
    ? (NativeModules as unknown as {BravoCallForeground: CallForegroundNative}).BravoCallForeground
    : null;

let active = false;

// B-64: the FGS notification's "Hang up" action. The native side has already
// stopped the service + dismissed the notification (so a dead JS runtime can
// never strand it); here we end the call for real — send call.hangup, stop
// InCallManager, clear the registry slot. Lazy requires: callRegistry
// require()s this module, a static import would cycle.
if (native) {
  DeviceEventEmitter.addListener('bravoCallFgHangup', () => {
    active = false;
    console.log('[bravo.callfg] hangup action from FGS notification');
    try {
      const reg = require('./callRegistry') as typeof import('./callRegistry');
      // WI-1.1 — the FGS notification action names no call at all, so it reads
      // the live entry's own key at press time. That is "end what is on screen
      // now", which is exactly the button's contract, and the synchronous read
      // means there is no window for the slot to change under it.
      const live = reg.getActiveCall();
      if (live) {reg.endActiveCall({callId: live.callId, gen: live.gen}, 'ended', 'local');}
    } catch (e) {
      console.warn('[bravo.callfg] 1:1 hangup handling failed:', (e as Error).message);
    }
    try {
      // WI-1.5 — the notification action names no room, so it reads the live
      // entry's own id synchronously. That is "end what is on screen now",
      // which is exactly the button's contract.
      const greg = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
      const liveGroup = greg.getActiveGroupCall();
      if (liveGroup) {void greg.endActiveGroupCall(liveGroup.roomId);}
    } catch (e) {
      console.warn('[bravo.callfg] group hangup handling failed:', (e as Error).message);
    }
  });
}

export function startCallForegroundService(opts: {kind: 'voice' | 'video'; peer: string}): void {
  if (!native) {
    console.log('[bravo.callfg] native module unavailable (iOS or unbuilt) — no-op');
    return;
  }
  try {
    native.start(opts);
    active = true;
    console.log(`[bravo.callfg] service started kind=${opts.kind} peer=${opts.peer}`);
  } catch (e) {
    // Caught: missing notification permission on API 33+, etc.
    // We never throw out of this path — the call should still proceed
    // even if the OS is going to suspend it later.
    console.warn('[bravo.callfg] start failed:', (e as Error).message);
  }
}

/**
 * Stop the call foreground service and drop its notification.
 *
 * B-256 — two defects lived in the old three-line version, and together they
 * stranded the "Bravo Secure video call · Hang up" notification in the shade
 * after the call had ended.
 *
 * 1. IT TRUSTED A JS FLAG. `if (!active) return` meant the native service was
 *    only ever told to stop when this module happened to believe it was
 *    running. `active` is module state: it is false after a JS reload, false
 *    if `start` threw after the notification was already posted, and — the
 *    common one — already false because some earlier teardown path cleared it.
 *    Every one of those leaves a live notification that nothing will ever
 *    dismiss. The native stop is idempotent, so asking twice costs nothing
 *    while not asking costs a permanent notification. The flag is now
 *    telemetry only.
 *
 * 2. IT WAS NOT ARBITRATED. There is ONE service for TWO call stacks (1:1 and
 *    group), exactly like the InCallManager session. B-243 taught that lesson
 *    and fixed the audio session; the foreground service sitting directly
 *    below it in both registries kept the unconditional stop. So a stale 1:1
 *    teardown tore the notification off a LIVE group call, and the reverse.
 *
 * `owner` is the stack whose call is ending. Omit it only from a path that
 * genuinely owns every call (app teardown) — the default force-stops.
 */
export function stopCallForegroundService(owner?: 'direct' | 'group'): void {
  if (!native) {return;}
  if (owner) {
    try {
      const {otherStackHasLiveCall} = require('./callAudioSession') as typeof import('./callAudioSession');
      if (otherStackHasLiveCall(owner)) {
        console.log(`[bravo.callfg] stop skipped — the ${owner === 'direct' ? 'group' : '1:1'} stack still owns a live call`);
        return;
      }
    } catch { /* cannot prove the other stack is busy — stopping is safer */ }
  }
  try {
    native.stop();
    active = false;
    console.log('[bravo.callfg] service stopped');
  } catch (e) {
    console.warn('[bravo.callfg] stop failed:', (e as Error).message);
  }
}

/**
 * NA-04 — surface the call UI after a system-UI (Telecom / lock-screen /
 * headset) Answer. Two jobs: the launch intent carries EXTRA_CALL_LAUNCH so
 * MainActivity turns the screen on and renders over the keyguard, and resuming
 * the activity makes the subsequent startForegroundService a FOREGROUND start
 * — which is what grants the microphone/camera FGS types instead of falling
 * through CallForegroundService's ladder to a typeless (mute) service.
 *
 * Returns false when the native method is missing (pre-NA-04 binary) so the
 * caller can fall back to CallKeep's backToForeground().
 */
export function bringCallUiToForeground(): boolean {
  if (!native?.bringCallUiToForeground) {return false;}
  try {
    native.bringCallUiToForeground();
    console.log('[bravo.callfg] call UI brought to foreground');
    return true;
  } catch (e) {
    console.warn('[bravo.callfg] bringCallUiToForeground failed:', (e as Error).message);
    return false;
  }
}

export function isCallForegroundActive(): boolean {
  return active;
}
