/**
 * Audit fix 5.1 — `useMissionEvents` subscribes the screen to the live
 * messenger gateway's `mission:<id>` room so status / team / telemetry
 * frames arrive via push instead of polling.
 *
 * Backwards-compatible: the polling loops in LiveTrackingScreen and
 * OpsRoomReviewScreen stay in place as a fallback when:
 *   - the transport isn't open yet (initial cold boot, post-logout)
 *   - the gateway pod is down / Redis publish missed
 *   - the user is on a stale build that doesn't know about the room
 *
 * Consumer usage:
 *   const transport = useLiveTransport();
 *   useMissionEvents(transport, missionId, {
 *     onStatus:    (status) => reloadMission(),
 *     onTeam:      ()       => reloadTeam(),
 *     onTelemetry: (fix)    => setVehicle(fix),
 *   });
 *
 * The hook resubscribes after a WS reconnect (the registry fires
 * `onTransport` again on state changes).
 */
import {useEffect, useRef} from 'react';
import type {TransportClient, ServerFrame} from '@bravo/messenger-core';

export interface MissionEventHandlers {
  onStatus?:    (status: string | undefined, extra: {sosAcked?: boolean; ackedBy?: string}) => void;
  onTeam?:      () => void;
  // B-89 MG-01/14 — the server frame now also carries heading/speed/
  // accuracy/eta so consumers can rotate markers + draw a confidence
  // circle without a REST round-trip. All optional (older servers).
  onTelemetry?: (fix: {
    lat: number; lng: number; recordedAt: string;
    heading_deg?: number; speed_kph?: number; accuracy_m?: number; eta_minutes?: number;
  }) => void;
}

export function useMissionEvents(
  transport: TransportClient | null,
  missionId: string | undefined,
  handlers: MissionEventHandlers,
): void {
  // Pin handlers in a ref so the subscription effect doesn't re-fire on
  // every render (handlers are typically inline closures).
  const handlersRef = useRef<MissionEventHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!transport || !missionId) {return;}

    // Hook the transport's frame dispatcher. The transport's `onAny`
    // already routes to `opts.onFrame`; we layer on top by wrapping
    // the socket's `onAny` directly. The internal socket is private
    // — fall back to a re-broadcast via the `addFrameListener`
    // helper if we ever expose one. For now we patch via the public
    // `emitWithAck`-adjacent path: just subscribe and bail if the
    // transport doesn't expose a frame-listener method.
    const listener = (frame: ServerFrame): void => {
      // Defensive: the union doesn't always carry a `missionId` field
      // (presence / call frames don't). Narrow on event + presence of
      // missionId on `data`.
      const data = frame.data as {missionId?: string} | undefined;
      if (!data || data.missionId !== missionId) {return;}
      switch (frame.event) {
        case 'mission.status': {
          const d = frame.data as {status?: string; sosAcked?: boolean; ackedBy?: string};
          handlersRef.current.onStatus?.(d.status, {sosAcked: d.sosAcked, ackedBy: d.ackedBy});
          break;
        }
        case 'mission.team': {
          handlersRef.current.onTeam?.();
          break;
        }
        case 'mission.telemetry': {
          const d = frame.data as {
            lat: number; lng: number; recordedAt: string;
            heading_deg?: number; speed_kph?: number; accuracy_m?: number; eta_minutes?: number;
          };
          handlersRef.current.onTelemetry?.({
            lat: d.lat, lng: d.lng, recordedAt: d.recordedAt,
            heading_deg: d.heading_deg, speed_kph: d.speed_kph,
            accuracy_m: d.accuracy_m, eta_minutes: d.eta_minutes,
          });
          break;
        }
        default:
          break;
      }
    };

    // Subscribe + register the listener. The transport exposes
    // `subscribeMission` + `addFrameListener`; if a transport build
    // is missing the listener API (older mock) the subscription
    // still happens — events just fall through to onFrame.
    // Best-effort: subscribing on a closed transport must never throw up into React (it
    // would escape this effect into the app ErrorBoundary and crash the app). The transport
    // re-subscribes on the next reconnect, and the polling fallback covers the gap.
    try { transport.subscribeMission(missionId); } catch { /* transport not open — polling covers it */ }
    const tWithListeners = transport as TransportClient & {
      addFrameListener?: (fn: (frame: ServerFrame) => void) => () => void;
    };
    const unsubscribeListener = tWithListeners.addFrameListener?.(listener);

    return () => {
      // Best-effort unsubscribe. If the transport is already closed
      // the send no-ops — see TransportClient.send.
      try { transport.unsubscribeMission(missionId); } catch { /* ignore */ }
      if (unsubscribeListener) {unsubscribeListener();}
    };
  }, [transport, missionId]);
}
