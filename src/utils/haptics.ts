import {Vibration} from 'react-native';

/**
 * MX-08 — semantic haptics seam. One place to swap in a real haptics
 * engine (react-native-haptic-feedback / expo-haptics impactLight etc.)
 * without touching call sites; until that dependency ships this maps to
 * short Vibration pulses tuned for Android (the shipping platform).
 * Known limit: iOS ignores Vibration durations entirely (fixed ~400 ms
 * buzz) — acceptable while iOS is unshipped, and precisely why the seam
 * exists.
 */
export const haptics = {
  /** Light key-press feedback: send, swipe-arm, queue start. */
  tap:    () => Vibration.vibrate(8),
  /** Subtle selection change: copy, retry, jump, pick. */
  select: () => Vibration.vibrate(6),
  /** Medium impact: long-press menu, reaction set. */
  impact: () => Vibration.vibrate(12),
  /** Heavy attention: destructive confirms. */
  heavy:  () => Vibration.vibrate(18),
};
