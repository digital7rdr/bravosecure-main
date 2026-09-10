/**
 * On-duty location heartbeat (BUILD_RUNBOOK Step 5).
 *
 * Why: the dispatch matchmaker (Step 6) can only rank agencies it can locate.
 * The existing watcher in AgentDashboardScreen reports location ONLY during a
 * live mission and ONLY in the foreground (P0 / LB16) — so a freshly-online
 * agency with no active mission reports nothing and never gets offered jobs.
 * This heartbeat is gated on DUTY, not on a mission: while the agency is
 * "Online" it PATCHes /agents/me/location on a timer so the dispatch pool sees
 * a fresh `agents.last_location_at`.
 *
 * BACKGROUND NOTE (device-verify required): a bare setInterval is suspended when
 * the app is backgrounded. True background survival needs this loop to run under
 * an Android foreground service (FOREGROUND_SERVICE_LOCATION) — either notifee's
 * registerForegroundService or a native module like CallForegroundService. That
 * native wiring + an on-device smoke test is the remaining piece; the manifest
 * permissions are in place and acquire/releaseKeepAlive() below are the
 * integration point. In the foreground this already closes the "only during a
 * mission" gap (LB16). Do not assume background "just works" without the service.
 */
import Geolocation from 'react-native-geolocation-service';
import {agentApi} from './api';

/** Staleness cutoff: an on-duty agency is "locatable" only if its last fix is
 *  newer than this. Mirrors the dispatch ranking query's freshness filter. */
export const LOCATION_FRESH_MINUTES = 5;

const HEARTBEAT_INTERVAL_MS = 45_000; // ~45s — within the 30–60s window
const FIX_TIMEOUT_MS = 15_000;

/** True when an on-duty agency has pushed a fix newer than LOCATION_FRESH_MINUTES. */
export function isLocatable(
  onDuty: boolean,
  lastPushAt: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (!onDuty || lastPushAt === null) {
    return false;
  }
  return nowMs - lastPushAt < LOCATION_FRESH_MINUTES * 60_000;
}

interface Fix {
  lat: number;
  lng: number;
  // Step 23 anti-fraud — report fix quality so the server can gate spoofed positions.
  accuracy_m?: number;
  speed_kph?: number;
  is_mocked?: boolean;
}

function getFix(): Promise<Fix | null> {
  return new Promise(resolve => {
    Geolocation.getCurrentPosition(
      p => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy_m: p.coords.accuracy ?? undefined,
        // coords.speed is m/s (or null/-1 when unknown) — convert to km/h.
        speed_kph: typeof p.coords.speed === 'number' && p.coords.speed >= 0
          ? Math.round(p.coords.speed * 3.6) : undefined,
        // Android exposes a mocked flag on the position; iOS omits it (undefined).
        is_mocked: (p as {mocked?: boolean}).mocked === true ? true : undefined,
      }),
      () => resolve(null),
      {enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS},
    );
  });
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastPushAt: number | null = null;
let onPushCb: ((at: number) => void) | null = null;
let inFlight = false;

async function pushOnce(): Promise<void> {
  if (inFlight) {
    return; // a slow fix / PATCH is still running — skip this tick, don't pile up
  }
  inFlight = true;
  try {
    const fix = await getFix();
    if (fix) {
      await agentApi.updateLocation(fix.lat, fix.lng, {
        accuracy_m: fix.accuracy_m, speed_kph: fix.speed_kph, is_mocked: fix.is_mocked,
      });
      lastPushAt = Date.now();
      onPushCb?.(lastPushAt);
    }
  } catch {
    // Swallow transient fix / network errors — the next tick retries (mirrors
    // the existing mission watcher's fire-and-forget reporting). lastPushAt is
    // left unchanged so a failed push never reports a phantom fresh fix.
  } finally {
    inFlight = false;
  }
}

/** Start the on-duty heartbeat. Idempotent — a second start() while running
 *  only refreshes the onPush callback, it does NOT spawn a second timer. */
export function startOnDutyHeartbeat(opts?: {onPush?: (at: number) => void}): void {
  if (opts?.onPush) {
    onPushCb = opts.onPush;
  }
  if (timer !== null) {
    return;
  }
  acquireKeepAlive();
  void pushOnce(); // immediate first fix the moment we go Online
  timer = setInterval(() => {
    void pushOnce();
  }, HEARTBEAT_INTERVAL_MS);
}

/** Stop the heartbeat. Idempotent. */
export function stopOnDutyHeartbeat(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  // Forget the last duty session so getLastPushAt() can't report an old fix as
  // fresh, and drop the screen's onPush ref for a clean teardown.
  lastPushAt = null;
  onPushCb = null;
  inFlight = false;
  releaseKeepAlive();
}

export function isHeartbeatRunning(): boolean {
  return timer !== null;
}

export function getLastPushAt(): number | null {
  return lastPushAt;
}

// ── Background keep-alive (foreground service) ──────────────────────────────
// Integration point for the Android foreground service that keeps the JS timer
// alive while backgrounded (FOREGROUND_SERVICE_LOCATION). Intentionally guarded
// no-ops until that native service is wired + device-tested — start/stop must
// NEVER throw, so the foreground heartbeat keeps working regardless.
function acquireKeepAlive(): void {
  /* TODO(step5-followup): start FOREGROUND_SERVICE_LOCATION foreground service. */
}
function releaseKeepAlive(): void {
  /* TODO(step5-followup): stop the foreground service. */
}
