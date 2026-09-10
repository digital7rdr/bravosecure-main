import {useEffect, useState} from 'react';
import {onRtt, getRtt} from '@modules/messenger/runtime/rttRegistry';

/**
 * Subscribes to the live WebSocket round-trip time published by the
 * messenger runtime. Returns null until the first pong lands.
 *
 * The runtime pings every 4s, so a steady call site updates roughly
 * once per second of UX time. Use the chip variant when you want
 * dimensional feedback (color tier) instead of the raw number.
 */
export function useTransportRtt(): number | null {
  const [rtt, setRtt] = useState<number | null>(() => getRtt().rttMs);
  useEffect(() => onRtt(setRtt), []);
  return rtt;
}
