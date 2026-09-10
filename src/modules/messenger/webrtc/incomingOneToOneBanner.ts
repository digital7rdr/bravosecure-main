/**
 * Tiny pub/sub for "an incoming 1:1 call.offer arrived while a group
 * call is already on screen". Used to show a WhatsApp-style banner
 * over GroupCallScreen instead of the default behaviour (full-screen
 * navigate to CallScreen, which would tear down the user's existing
 * group call without their consent).
 *
 * MainNavigator's incoming-call handler routes here when
 * `getActiveGroupCall() != null`; GroupCallScreen subscribes and
 * renders the banner. Accept = endActiveGroupCall() + navigate to
 * CallScreen with the queued SDP. Decline = send call.hangup back to
 * the offerer + clear the slot.
 *
 * Holds at most ONE pending banner — a second offer arriving while
 * the first is still pending REPLACES the first (we hangup the older
 * one). This mirrors WhatsApp: only the latest incoming ring is shown,
 * and historical ones never linger.
 */
import type {ServerCallOffer} from '@bravo/messenger-core';

export type PendingOneToOne = ServerCallOffer['data'];

let pending: PendingOneToOne | null = null;
let listeners: Array<(p: PendingOneToOne | null) => void> = [];

function notify(): void {
  for (const cb of listeners) {
    try { cb(pending); } catch { /* one bad listener mustn't block the others */ }
  }
}

export function getPendingOneToOne(): PendingOneToOne | null {
  return pending;
}

export function setPendingOneToOne(next: PendingOneToOne | null): void {
  pending = next;
  notify();
}

export function clearPendingOneToOne(): void {
  if (pending === null) {return;}
  pending = null;
  notify();
}

export function onPendingOneToOneChange(
  cb: (p: PendingOneToOne | null) => void,
): () => void {
  listeners.push(cb);
  // Fire once with current state so subscribers paint immediately.
  try { cb(pending); } catch { /* ignore */ }
  return () => { listeners = listeners.filter(l => l !== cb); };
}
