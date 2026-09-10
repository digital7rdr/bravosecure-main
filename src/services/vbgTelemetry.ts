/**
 * VBG encrypted-telemetry loop (BE-7.1) — app-wide (audit H-3).
 *
 * Why: the 3s ping loop used to live in a VBGHomeScreen effect, so "live
 * monitoring" silently stopped the moment the principal left the dashboard.
 * This service runs the loop for the whole app session (foreground) once a
 * per-device telemetry key is enrolled — same lifecycle idiom as
 * `onDutyHeartbeat`. Each tick reads a GPS fix, AES-256-GCM-seals it (AAD
 * bound to the signed-in user — audit M-5) and POSTs /vbg/telemetry.
 *
 * Backgrounding still suspends JS timers — true background survival needs the
 * FOREGROUND_SERVICE_LOCATION service (see onDutyHeartbeat's keep-alive note);
 * this closes the "dashboard-only" gap, not the background one.
 */
import {AppState} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {vbgApi} from './api';
import {useAuthStore} from '@store/authStore';
import {hasTelemetryKey, sealTelemetry, telemetryAad} from '@/modules/vbg/telemetryCrypto';

const TICK_MS = 3_000;
const FIX_TIMEOUT_MS = 8_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function pushOnce(): Promise<void> {
  if (inFlight) {return;} // slow fix / POST still running — skip, don't pile up
  if (AppState.currentState !== 'active') {return;} // foreground only
  inFlight = true;
  try {
    const fix = await new Promise<{lat: number; lng: number; heading?: number; speed?: number; recordedAt: string} | null>(resolve => {
      Geolocation.getCurrentPosition(
        pos => resolve({
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          heading: pos.coords.heading ?? undefined, speed: pos.coords.speed ?? undefined,
          recordedAt: new Date(pos.timestamp).toISOString(),
        }),
        () => resolve(null),
        {enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 2_000},
      );
    });
    if (!fix) {return;}
    const userId = useAuthStore.getState().user?.id;
    const sealed = await sealTelemetry(fix, userId ? telemetryAad(userId) : undefined);
    if (sealed) {await vbgApi.telemetry(sealed);}
  } catch {
    // Transient fix / network / auth errors — next tick retries.
  } finally {
    inFlight = false;
  }
}

/**
 * Start the loop if (and only if) a telemetry key is enrolled. Idempotent —
 * safe to call from every VBG surface and from app bootstrap.
 */
export async function ensureVbgTelemetry(): Promise<void> {
  if (timer !== null) {return;}
  try {
    if (!(await hasTelemetryKey())) {return;}
  } catch {
    return;
  }
  if (timer !== null) {return;} // re-check: parallel ensure could have won
  void pushOnce();
  timer = setInterval(() => { void pushOnce(); }, TICK_MS);
}

/** Stop the loop (logout / key rotation). Idempotent. */
export function stopVbgTelemetry(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  inFlight = false;
}

export function isVbgTelemetryRunning(): boolean {
  return timer !== null;
}
