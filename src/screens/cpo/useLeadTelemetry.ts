/**
 * LM-C5 (foreground half) — the LEAD's GPS push previously ran ONLY while the
 * live-tracker's lead-console overlay was mounted, so the mission dot froze the
 * moment the lead left that modal. This hook streams the same telemetry while
 * the Mission tab (the screen a lead actually keeps open) is mounted.
 *
 * Module-level guard: at most ONE watcher per app instance — if the lead opens
 * the console overlay (which runs its own watcher) the duplicate rows are
 * harmless (append-only telemetry), but two instances of THIS hook (tab
 * remounts) never stack.
 *
 * B-89 MG-03 — the LM-C5 "native half" is now real: while this hook is
 * active it holds the mission FOREGROUND SERVICE (persistent "Mission
 * tracking active" notification), which keeps the process at foreground
 * priority so this watcher + heartbeat keep ticking with the screen off /
 * app backgrounded. Service stops when the mission leaves the active set
 * or the hook unmounts.
 */
import {useEffect} from 'react';
import Geolocation, {type GeoPosition} from 'react-native-geolocation-service';
import {agentApi} from '@services/api';
import {startMissionTracking, stopMissionTracking} from '@/modules/agent/missionForegroundService';

const PUSH_MIN_INTERVAL_MS = 5_000;
// B-80 — heartbeat cadence. `watchPosition` with `distanceFilter` only fires
// when the device MOVES, so a stationary lead (parked at pickup, waiting, or a
// tester/emulator whose GPS never moves) pushed one fix then went silent and the
// ops live map froze with a stale position + `updated_at`. A periodic one-shot
// fix keeps the mission LIVE (dot holds position but never goes stale/dropped).
const HEARTBEAT_MS = 15_000;
let activeWatch: {missionId: string; watchId: number} | null = null;

export function useLeadTelemetry(missionId: string | null, isLead: boolean, status: string): void {
  const active = !!missionId && isLead &&
    ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'].includes(status.toUpperCase());
  useEffect(() => {
    if (!active || !missionId) {return undefined;}
    if (activeWatch?.missionId === missionId) {return undefined;} // already streaming
    let lastPush = 0;
    // Shared push — throttled so the movement stream and the heartbeat can't
    // double-fire within PUSH_MIN_INTERVAL_MS. The heartbeat cadence sits well
    // above the throttle, so a stationary lead still refreshes every ~15s.
    const pushSample = (pos: GeoPosition) => {
      const now = Date.now();
      if (now - lastPush < PUSH_MIN_INTERVAL_MS) {return;}
      lastPush = now;
      void agentApi.pushTelemetry(missionId, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        heading_deg: Number.isFinite(pos.coords.heading) && (pos.coords.heading ?? -1) >= 0
          ? pos.coords.heading as number : undefined,
        speed_kph: Number.isFinite(pos.coords.speed) && (pos.coords.speed ?? -1) >= 0
          ? Math.round((pos.coords.speed as number) * 3.6) : undefined,
        accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : undefined,
      }).catch(() => undefined); // offline — the next fix retries
    };
    let watchId: number | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      // MG-03 — hold the foreground service for the lifetime of this
      // watcher so backgrounding the app doesn't freeze the mission dot.
      void startMissionTracking(missionId);
      // Movement stream — responsive updates as the lead drives.
      watchId = Geolocation.watchPosition(
        pushSample,
        () => undefined, // denied/unavailable — the console overlay path still works
        {enableHighAccuracy: true, distanceFilter: 15, interval: PUSH_MIN_INTERVAL_MS, fastestInterval: PUSH_MIN_INTERVAL_MS},
      );
      activeWatch = {missionId, watchId};
      // Heartbeat — one-shot fix on a timer so a stationary lead keeps the ops
      // map fresh (B-80). `maximumAge` lets a cached fix satisfy it cheaply.
      heartbeat = setInterval(() => {
        Geolocation.getCurrentPosition(
          pushSample,
          () => undefined,
          {enableHighAccuracy: true, timeout: 8_000, maximumAge: HEARTBEAT_MS},
        );
      }, HEARTBEAT_MS);
    } catch { /* geolocation unavailable */ }
    return () => {
      if (heartbeat) {clearInterval(heartbeat);}
      if (watchId !== null) {
        try { Geolocation.clearWatch(watchId); } catch { /* already cleared */ }
        if (activeWatch?.watchId === watchId) {activeWatch = null;}
      }
      // MG-03 — release the foreground service with the watcher (mission
      // ended, lead role lost, or the tab really unmounted).
      void stopMissionTracking();
    };
  }, [active, missionId]);
}
