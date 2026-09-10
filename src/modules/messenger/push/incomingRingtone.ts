/**
 * JS bridge for BravoRingtoneModule — plays the DEVICE-DEFAULT ringtone
 * (RingtoneManager.TYPE_RINGTONE) for an incoming call, WhatsApp-style.
 *
 * Why this exists (call-UI parity plan §4 / docs/planning/CALL_UI_WHATSAPP_PARITY.md):
 *   - the notifee channel `sound: 'default'` plays the short NOTIFICATION
 *     chime, not the user's ringtone;
 *   - our Telecom ConnectionService is selfManaged, so the OS never rings
 *     for us — the app owns ring audio.
 *
 * Contract:
 *   - start is bounded NATIVELY (the module auto-stops after RING_TIMEOUT_MS)
 *     because the killed-app headless JS context that starts the ring can die
 *     before any JS stop fires — see PUSH-B5.
 *   - stop is called from the single dismiss funnel (dismissCallNotif), which
 *     every exit path already routes through: accept, decline, remote hangup,
 *     slim killed-app tap handler.
 *   - Missing native module (old APK / iOS / tests) degrades to a silent
 *     no-op — the notification card + vibration still work.
 */
import {NativeModules, Platform} from 'react-native';

/** Must match the ring notification's `timeoutAfter` (PUSH-B5, 45s). */
export const RING_TIMEOUT_MS = 45_000;

interface BravoRingtoneNative {
  start(callId: string, timeoutMs: number): void;
  stop(callId: string | null): void;
}

function native(): BravoRingtoneNative | null {
  if (Platform.OS !== 'android') {return null;}
  const mod = (NativeModules as Record<string, unknown>).BravoRingtone as BravoRingtoneNative | undefined;
  return mod ?? null;
}

type RingListener = () => void;

let activeRing: {callId: string; at: number} | null = null;
const ringListeners = new Set<RingListener>();

function notifyRingListeners(): void {
  for (const l of [...ringListeners]) {
    try { l(); } catch { /* a bad listener must never break the ring path */ }
  }
}

/**
 * NA-06 — true while BravoRingtoneModule is looping the device-default
 * ringtone for `callId`. Self-expires at RING_TIMEOUT_MS because the native
 * guardian auto-stops there without calling back into JS.
 */
export function isNativeRingActive(callId: string): boolean {
  if (!activeRing || activeRing.callId !== callId) {return false;}
  if (Date.now() - activeRing.at >= RING_TIMEOUT_MS) {
    activeRing = null;
    return false;
  }
  return true;
}

/**
 * NA-06 — drive an in-app ringtone that YIELDS to the native device-default
 * ring. `onOwn(true)` = the in-app surface should make noise; `onOwn(false)` =
 * the native ring owns this call. Fires immediately with the current verdict
 * and again on every ownership flip. Returns an unsubscribe.
 */
export function bindInAppRingOwnership(
  callId: string | undefined,
  onOwn: (owns: boolean) => void,
): () => void {
  let owns: boolean | null = null;
  const apply = () => {
    const next = !(callId && isNativeRingActive(callId));
    if (next === owns) {return;}
    owns = next;
    onOwn(next);
  };
  apply();
  ringListeners.add(apply);
  return () => { ringListeners.delete(apply); };
}

export function startIncomingRingtone(callId: string): void {
  try {
    const mod = native();
    if (!mod) {return;}
    mod.start(callId, RING_TIMEOUT_MS);
    activeRing = {callId, at: Date.now()};
    console.log('[bravo.ring] start call=' + callId);
    notifyRingListeners();
  } catch (e) {
    console.warn('[bravo.ring] start failed:', (e as Error).message);
  }
}

/** callId null = stop whatever is ringing (defensive sweep on logout/teardown). */
export function stopIncomingRingtone(callId: string | null, reason: string): void {
  const wasActive = activeRing !== null && (callId === null || activeRing.callId === callId);
  if (wasActive) {activeRing = null;}
  try {
    const mod = native();
    if (!mod) {return;}
    mod.stop(callId);
    console.log('[bravo.ring] stop reason=' + reason + ' call=' + (callId ?? 'any'));
  } catch (e) {
    console.warn('[bravo.ring] stop failed:', (e as Error).message);
  } finally {
    if (wasActive) {notifyRingListeners();}
  }
}
