/**
 * B-412 [NOTIFHEALTH] — one release-visible warn line on boot summarizing the
 * four states that make a device silently miss message banners: notification
 * permission, the bravo-messages channel, push-token registration freshness,
 * and battery-optimization exemption. Turns the next "no banner arrived"
 * report into a 30-second log read (style precedent: [NOTIFLAT]/[LAGDIAG];
 * console.warn survives release builds — console.log does not).
 *
 * Fail-soft everywhere: a probe must never break boot, and an unreadable
 * input reports '?' rather than being omitted (absence would read as healthy).
 */
import {Platform} from 'react-native';

export async function logNotifHealth(): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  // The bootstrap's server register is fire-and-forget (NA-03), so at the
  // instant startFcmBootstrap resolves `registered` is almost always still
  // false — logging then would stamp reg=NO on every healthy cold boot and
  // send the next investigation down a false trail (edge-case review #1).
  // Wait for the flip, bounded: a REAL registration failure still logs
  // reg=NO after the window.
  try {
    const {getPushRegisterHealth} = require('./fcmBootstrap') as typeof import('./fcmBootstrap');
    const deadline = Date.now() + 30_000;
    while (!getPushRegisterHealth().registered && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1_000));
    }
  } catch { /* reported as reg=? below */ }
  const parts: string[] = [];
  try {
    const notifee = (require('@notifee/react-native') as {default: {
      getNotificationSettings(): Promise<{authorizationStatus: number}>;
      getChannel(id: string): Promise<{blocked?: boolean} | null>;
    }}).default;
    // authorizationStatus: 1 = AUTHORIZED, 0 = DENIED (notifee enum).
    const settings = await notifee.getNotificationSettings();
    parts.push(`perm=${settings.authorizationStatus === 1 ? 'ok' : `denied(${settings.authorizationStatus})`}`);
    const ch = await notifee.getChannel('bravo-messages');
    parts.push(`msgChannel=${ch ? (ch.blocked ? 'BLOCKED' : 'ok') : 'missing'}`);
  } catch { parts.push('perm=? msgChannel=?'); }
  try {
    const {getPushRegisterHealth} = require('./fcmBootstrap') as typeof import('./fcmBootstrap');
    const h = getPushRegisterHealth();
    parts.push(`reg=${h.registered ? 'ok' : 'NO'}`);
    if (h.lastAssertAgoMs !== null) {parts.push(`assertAgo=${Math.round(h.lastAssertAgoMs / 60_000)}m`);}
  } catch { parts.push('reg=?'); }
  try {
    const {isIgnoringBatteryOptimizations} = require('./batteryOptimization') as typeof import('./batteryOptimization');
    parts.push(`batteryExempt=${(await isIgnoringBatteryOptimizations()) ? 'ok' : 'NO'}`);
  } catch { parts.push('batteryExempt=?'); }
  console.warn('[NOTIFHEALTH]', parts.join(' '));
}
