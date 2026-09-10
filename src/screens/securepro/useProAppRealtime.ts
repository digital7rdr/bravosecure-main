/**
 * Realtime Pro-application updates over the existing messenger gateway.
 *
 * auth-service publishes `proapp.status` / `proapp.message` on the same
 * Redis `mission:events` lane the mission screens use; the gateway re-emits
 * to the `mission:<applicationId>` room (any unguessable-UUID key works —
 * the application id IS the room key). Push-over-poll like LiveTracking:
 * the status screen keeps its poll as fallback, this hook just collapses
 * the latency to instant when the socket is up.
 */
import {useEffect, useRef, useState} from 'react';
import type {TransportClient, ServerFrame} from '@bravo/messenger-core';
import {getLiveTransport, onTransport} from '@/modules/messenger/runtime/transportRegistry';

export function useProAppRealtime(applicationId: string | undefined, onEvent: () => void): void {
  const [transport, setTransport] = useState<TransportClient | null>(() => getLiveTransport());
  useEffect(() => onTransport(setTransport), []);

  // Pin the callback so the subscription doesn't re-fire per render.
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!transport || !applicationId) {return;}
    const listener = (frame: ServerFrame): void => {
      const data = frame.data as {missionId?: string} | undefined;
      if (!data || data.missionId !== applicationId) {return;}
      // ServerFrame's event union predates the proapp.* lane — the gateway
      // re-emits arbitrary event names, so widen for the comparison.
      const event = frame.event as string;
      if (event === 'proapp.status' || event === 'proapp.message') {
        cbRef.current();
      }
    };
    try { transport.subscribeMission(applicationId); } catch { /* transport closed — polling covers it */ }
    const t = transport as TransportClient & {
      addFrameListener?: (fn: (f: ServerFrame) => void) => () => void;
    };
    const unsubscribe = t.addFrameListener?.(listener);
    return () => {
      try { transport.unsubscribeMission(applicationId); } catch { /* ignore */ }
      if (unsubscribe) {unsubscribe();}
    };
  }, [transport, applicationId]);
}
