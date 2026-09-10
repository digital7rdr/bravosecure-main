/**
 * B-27 — notifee rejects any vibrationPattern value that isn't strictly
 * positive ("expected an array containing an even number of positive
 * values"). The Android-conventional leading 0 ("no delay") therefore
 * made createChannel throw on EVERY boot — the `bravo-incoming-call`
 * channel never existed on any device, so a backgrounded phone could
 * never ring for an incoming call.
 *
 * Kept free of react-native imports so the node-env test project can
 * assert validity against the REAL production values without mocking
 * the native modules.
 */
export const RING_CHANNEL_VIBRATION = [300, 800, 1200, 800];
export const RING_NOTIF_VIBRATION   = [300, 1000, 500, 1000, 500, 1000];

/** Mirrors notifee's createChannel/displayNotification validation rule. */
export function isValidNotifeeVibration(pattern: number[]): boolean {
  return pattern.length > 0
    && pattern.length % 2 === 0
    && pattern.every(v => Number.isFinite(v) && v > 0);
}
