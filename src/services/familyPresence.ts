/**
 * Family last-location reporter (Linked Members, founder spec 2026-08-04).
 *
 * While the signed-in user is an ACTIVE, non-held family member, their device
 * reports its last fix to the plan owner's Linked Members screen — foreground
 * only (same lifecycle idiom as `vbgTelemetry`), every ~10 minutes plus on
 * each return to foreground.
 *
 * Privacy posture:
 *  - Membership is confirmed BEFORE any coordinate leaves the device — a
 *    non-member's fix is never read or sent, and a negative answer backs off
 *    for hours.
 *  - The permission check is silent (`PermissionsAndroid.check`) — this
 *    service never prompts; location permission is asked in-context by the
 *    onboarding/mission flows.
 *  - The server re-enforces membership + hold + `location_scope='never'`
 *    (Settings → Location) on every report; `reported:false` re-arms the
 *    backoff (covers mid-session revoke/hold/opt-out).
 */
import {AppState, PermissionsAndroid, Platform} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {familyApi} from './api';
import {useAuthStore} from '@store/authStore';

const TICK_MS = 10 * 60_000;
const NOT_MEMBER_BACKOFF_MS = 6 * 60 * 60_000;
const FIX_TIMEOUT_MS = 12_000;

let timer: ReturnType<typeof setInterval> | null = null;
let appStateSub: {remove: () => void} | null = null;
let inFlight = false;
let lastSentAt = 0;
let notMemberUntil = 0;
let knownMember = false;       // in-memory only — re-verified each cold start
let lastUserId: string | null = null;

async function hasLocationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {return true;} // iOS authorization is requested at onboarding
  try {
    const FINE   = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    const COARSE = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
    return (await PermissionsAndroid.check(FINE)) || (await PermissionsAndroid.check(COARSE));
  } catch {
    return false;
  }
}

async function pushOnce(): Promise<void> {
  if (inFlight) {return;}
  if (AppState.currentState !== 'active') {return;}
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {return;}
  if (userId !== lastUserId) {
    // Account switch — forget the previous account's membership answer and
    // timers. MUST run before the backoff/throttle gates below, or a prior
    // account's 6h negative backoff silences the new member for hours.
    lastUserId = userId;
    knownMember = false;
    notMemberUntil = 0;
    lastSentAt = 0;
  }
  const now = Date.now();
  if (now < notMemberUntil) {return;}
  if (now - lastSentAt < TICK_MS - 5_000) {return;} // foreground bursts stay throttled
  inFlight = true;
  try {
    if (!knownMember) {
      const {data} = await familyApi.membership();
      const m = data.membership;
      const heldMs = m?.heldUntil ? new Date(m.heldUntil).getTime() - Date.now() : NaN;
      const held = Number.isFinite(heldMs) && heldMs > 0;
      if (!m || held) {
        // A hold has a known end — wake shortly after it lifts instead of
        // going dark for the flat window (owner lifts early → next tick).
        notMemberUntil = Date.now() + (held
          ? Math.max(60_000, Math.min(NOT_MEMBER_BACKOFF_MS, heldMs))
          : NOT_MEMBER_BACKOFF_MS);
        return;
      }
      knownMember = true;
    }
    if (!(await hasLocationPermission())) {return;}
    const fix = await new Promise<{lat: number; lng: number; accuracyM: number | null} | null>(resolve => {
      Geolocation.getCurrentPosition(
        pos => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        }),
        () => resolve(null),
        {enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 60_000},
      );
    });
    if (!fix) {return;}
    const {data} = await familyApi.reportLocation(fix);
    lastSentAt = Date.now();
    if (!data.reported) {
      // Revoked / held / opted out since the membership check — back off.
      knownMember = false;
      notMemberUntil = Date.now() + NOT_MEMBER_BACKOFF_MS;
    }
  } catch {
    // Transient network/auth errors — next tick retries.
  } finally {
    inFlight = false;
  }
}

/** Start the reporter. Idempotent — safe from app bootstrap and any screen. */
export function ensureFamilyPresence(): void {
  if (timer !== null) {return;}
  void pushOnce();
  timer = setInterval(() => { void pushOnce(); }, TICK_MS);
  appStateSub = AppState.addEventListener('change', st => {
    if (st === 'active') {void pushOnce();}
  });
}

/** Stop + reset (logout / account switch). Idempotent. */
export function stopFamilyPresence(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  appStateSub?.remove();
  appStateSub = null;
  inFlight = false;
  lastSentAt = 0;
  notMemberUntil = 0;
  knownMember = false;
}
