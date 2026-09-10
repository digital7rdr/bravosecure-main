/**
 * Realtime protection-session updates over the existing messenger gateway.
 * Room key = the protection SESSION id (any unguessable-UUID key works). The
 * backend broadcasts `psession.status` / `psession.location` / `psession.sos`
 * as TRIGGERS-TO-REFETCH (payloads carry no coordinates, §9); this hook
 * collapses poll latency to instant when the socket is up, and the caller's
 * poll stays as the fallback. Mirrors useProAppRealtime.
 */
import {useEffect, useRef, useState} from 'react';
import type {TransportClient, ServerFrame} from '@bravo/messenger-core';
import {getLiveTransport, onTransport} from '@/modules/messenger/runtime/transportRegistry';

export function useProtectionSessionRealtime(sessionId: string | undefined, onEvent: () => void): void {
  const [transport, setTransport] = useState<TransportClient | null>(() => getLiveTransport());
  useEffect(() => onTransport(setTransport), []);

  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!transport || !sessionId) {return;}
    const listener = (frame: ServerFrame): void => {
      const data = frame.data as {missionId?: string} | undefined;
      if (!data || data.missionId !== sessionId) {return;}
      const event = frame.event as string;
      if (event === 'psession.status' || event === 'psession.location'
          || event === 'psession.sos' || event === 'psession.note') {
        cbRef.current();
      }
    };
    try { transport.subscribeMission(sessionId); } catch { /* transport closed — polling covers it */ }
    const t = transport as TransportClient & {
      addFrameListener?: (fn: (f: ServerFrame) => void) => () => void;
    };
    const unsubscribe = t.addFrameListener?.(listener);
    return () => {
      try { transport.unsubscribeMission(sessionId); } catch { /* ignore */ }
      if (unsubscribe) {unsubscribe();}
    };
  }, [transport, sessionId]);
}
