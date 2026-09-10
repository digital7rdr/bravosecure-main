/**
 * B-425 — in-call playback volume floor.
 *
 * Android keeps a SEPARATE `STREAM_VOICE_CALL` volume index per output device.
 * On the founder's Pixel 6a the remembered index for "realme Buds Wireless 3"
 * is 7 of 15 (~47%), and it is re-applied every time audio routes to it —
 * measured across one call (2026-08-12):
 *
 *   15:54:48.394  level_changed STREAM_VOICE_CALL 7    <- 0.5s after SCO connect
 *   15:55:12.807  level_changed STREAM_VOICE_CALL 15   <- BT dropped -> earpiece
 *   15:55:36.848  level_changed STREAM_VOICE_CALL 7    <- BT reconnected mid-call
 *
 * That is a second, independent cause of "the receiver's voice is too quiet",
 * on top of the echo-canceller half-duplexing (B-420).
 *
 * THIS IS A FLOOR, NOT A FORCE. The brief's §12 forbids "simply increasing
 * volume globally", and it is right to: slamming the stream to max would
 * override a deliberate user preference, permanently rewrite the per-device
 * index Android is correctly remembering, and risk hurting someone. So:
 *
 *   1. Only ever RAISE, and only when the level is below `FLOOR_FRACTION`.
 *      A level at or above the floor is left exactly alone.
 *   2. Remember what was there and RESTORE it when the call ends, so the
 *      user's own setting survives the call.
 *   3. Never fight the user. If the index is not what we last set, they moved
 *      it (hardware keys) — stand down for the rest of the call and restore
 *      nothing, because the current value is now their choice.
 *
 * Android-only: iOS gives apps no way to set the call volume (it is hardware
 * keys only), so every entry point here is a no-op there by construction —
 * the native module simply does not exist.
 */

/**
 * Minimum fraction of max the call stream may sit at. 0.7 lifts the measured
 * 7/15 to 11/15 — clearly audible without being the reflexive "slam it to
 * max". Deliberately not 1.0: the point is a usable floor, not loudness.
 */
export const FLOOR_FRACTION = 0.7;

/**
 * The index to raise to, or null to leave the stream alone.
 *
 * Pure so the policy is unit-testable without a device; the native module is a
 * dumb get/set accessor and holds no policy.
 */
export function volumeFloorTarget(
  current: number,
  max: number,
  floorFraction: number = FLOOR_FRACTION,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {return null;}
  if (current < 0) {return null;}
  // Math.ceil so the result is never fractionally under the floor.
  const target = Math.min(max, Math.ceil(max * floorFraction));
  // Only ever raise. `>=` also covers a device already at max.
  return current >= target ? null : target;
}

interface VolumeNative {
  getVoiceCallVolume: () => Promise<{current: number; max: number}>;
  setVoiceCallVolume: (index: number) => void;
}

function nativeModule(): VolumeNative | null {
  try {
    const {NativeModules, Platform} = require('react-native') as typeof import('react-native');
    if (Platform.OS !== 'android') {return null;}
    return (NativeModules as {BravoCallVolume?: VolumeNative}).BravoCallVolume ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-call state. Module-scoped rather than a hook ref because BOTH call
 * stacks (1:1 CallScreen and group GroupCallScreen) drive it and there is
 * exactly ONE device volume — the same reason `callAudioSession` arbitrates
 * the shared InCallManager session. Two hand-copies of this would drift, which
 * is this repo's recurring root cause.
 */
let originalIndex: number | null = null;   // what we found before raising
let appliedIndex: number | null = null;    // what we last set
let suspended = false;                     // user took over — stand down

/**
 * Raise the call stream to the floor if it is below it. Safe to call on every
 * route change: the per-device index means the value only becomes knowable
 * AFTER the route lands, so this is driven from the device-change event.
 */
export async function applyCallVolumeFloor(): Promise<void> {
  if (suspended) {return;}
  const native = nativeModule();
  if (!native) {return;}
  try {
    const {current, max} = await native.getVoiceCallVolume();
    // The user moved the slider since our last apply — their value wins for
    // the rest of the call, and we must not restore over it later either.
    if (appliedIndex !== null && current !== appliedIndex) {
      suspended = true;
      originalIndex = null;
      console.warn(`[bravo.callvolume] user changed volume to ${current} — standing down for this call`);
      return;
    }
    const target = volumeFloorTarget(current, max);
    if (target === null) {return;}
    // Only capture the ORIGINAL once, so a mid-call route change (which can
    // re-enter here at the new device's low index) does not overwrite the
    // value we owe the user back.
    if (originalIndex === null) {originalIndex = current;}
    native.setVoiceCallVolume(target);
    appliedIndex = target;
    console.warn(`[bravo.callvolume] raised call volume ${current} -> ${target} of ${max} (B-425 floor)`);
  } catch {
    // Native missing or the platform refused — the call is still perfectly
    // usable at the user's own level. Never throw into a call path.
  }
}

/**
 * Give the user's setting back at the end of the call. No-op when we never
 * raised, or when they took the slider themselves.
 */
export function restoreCallVolume(): void {
  const native = nativeModule();
  const restoreTo = originalIndex;
  const wasApplied = appliedIndex;
  originalIndex = null;
  appliedIndex = null;
  suspended = false;
  if (!native || restoreTo === null || wasApplied === null) {return;}
  try {
    native.setVoiceCallVolume(restoreTo);
    console.warn(`[bravo.callvolume] restored call volume to ${restoreTo}`);
  } catch { /* best-effort */ }
}

/** Test-only — the module-scoped per-call state is shared by both call stacks. */
export function __resetCallVolumeStateForTests(): void {
  originalIndex = null;
  appliedIndex = null;
  suspended = false;
}
