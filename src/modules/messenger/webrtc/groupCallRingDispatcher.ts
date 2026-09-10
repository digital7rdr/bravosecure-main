/**
 * Multi-subscriber dispatcher for INCOMING group-call ring frames.
 *
 * Two callers want notifications:
 *   1. The navigation root — on `sfu.ring.incoming`, navigates to the
 *      ring screen so the user can accept/decline.
 *   2. The IncomingGroupCallScreen — on `sfu.ring.cancelled` /
 *      `sfu.ring.declined` for its own roomId, dismisses itself.
 *
 * A single-handler dispatcher couldn't serve both, so this is a tiny
 * pub-sub. Handlers receive ALL ring frames; they're expected to
 * filter by event + roomId themselves.
 */

export interface GroupCallRingPayload {
  roomId:         string;
  conversationId: string;
  callType:       'voice' | 'video';
  from:           {userId: string; deviceId: number};
  callerName:     string;
  // Audit P0-C2 / row #5 — per-recipient HMAC room-access token.
  // Recipient echoes back in sfu.join.roomToken AND sfu.ring.decline.
  // Empty / undefined on dev servers without SFU_ROOM_TOKEN_SECRET.
  roomToken?:     string;
  roomTokenExp?:  number;
  /**
   * B-336 — identifies ONE ring fan-out. The server mints it per `sfu.ring`
   * and repeats it on every copy of that same fan-out (WS frame, FCM wake,
   * queued reconnect replay), so the dedup below can tell a REPLAY of one
   * ring from a genuinely NEW ring for the same room (mid-call "Add" /
   * host Re-ring). Absent on a pre-B-336 relay → dedup falls back to roomId,
   * i.e. exactly the old behaviour.
   */
  ringId?:        string;
  /**
   * B-479 — set by the server ONLY on a reconnect replay out of the
   * pending-ring queue, never on the live fan-out. A replayed ring is acked
   * once this client owns it, and that ack is what lets the server drop the
   * queued copy. Before this, the server deleted the queue entry the moment it
   * emitted, so the replay had exactly one chance to land — and a socket
   * coming up mid backup-restore (which the restore flow does twice, while its
   * own suppression flag is still armed) burned it.
   */
  replayed?:      boolean;
}

export interface GroupCallRingHandler {
  /**
   * WI-3.6 — return TRUE when this handler actually PRESENTED the ring (or
   * parked it for later consumption). Anything else — a suppressing branch, a
   * silent navigation drop, a handler that isn't the one responsible for
   * presenting — must return nothing.
   *
   * The dedup marker is burned on that verdict, so a handler that lies here
   * costs the user the ring: both the server's reconnect replay and the FCM
   * rescue copy are suppressed for the whole TTL.
   */
  onIncoming: (ring: GroupCallRingPayload) => boolean | void;
  /** WI-6.7 — `ringId` names the cancelled fan-out; absent from old relays. */
  onCancel:   (data: {roomId: string; conversationId: string; ringId?: string}) => void;
  onDecline:  (data: {roomId: string; conversationId: string; from: {userId: string; deviceId: number}}) => void;
}

let handlers: GroupCallRingHandler[] = [];

/**
 * B-479 — how this client tells the server it has taken responsibility for a
 * REPLAYED ring, so the queued copy can go.
 *
 * Registered by the runtime, which owns the transport; the dispatcher owns the
 * decision, because "we own this ring" is the same judgement it already makes
 * to burn the dedup marker. Kept as a registration rather than a return value
 * so the FCM rescue lane acks for free too — a ring the push lane surfaced is
 * just as owned as one the socket delivered.
 */
let ackSender: ((roomId: string, roomToken?: string, ringId?: string) => void) | null = null;

export function setGroupRingAckSender(
  fn: ((roomId: string, roomToken?: string, ringId?: string) => void) | null,
): void {
  ackSender = fn;
}

/**
 * Tell the server we own this ring. Only for REPLAYS: a live frame's queued
 * artifacts include the days-long missed-call marker, and clearing that the
 * moment a ring is shown would cost the user their missed-call record for a
 * call they never answered.
 */
function ackReplayedRing(d: GroupCallRingPayload | undefined): void {
  if (!d?.replayed || !d.roomId || !ackSender) {return;}
  // B-566 round 2 — the ack owns THIS replayed fan-out; ring-scoped settle.
  try { ackSender(d.roomId, d.roomToken, d.ringId); }
  catch { /* transport gone — the ring stays queued, which is the safe way to fail */ }
}

/**
 * Register a handler. Returns an unregister function. Multiple
 * handlers may be registered simultaneously — every registered handler
 * receives every dispatched frame.
 */
export function setGroupCallRingHandler(h: GroupCallRingHandler | null): () => void {
  // A null registration is a no-op; return a shared no-op disposer so
  // the contract is explicit ("nothing was registered, nothing to undo")
  // rather than handing back a closure that captures null and silently
  // unregisters nothing.
  if (!h) {return () => {};}
  handlers = handlers.concat(h);
  return () => {
    handlers = handlers.filter(x => x !== h);
  };
}

/**
 * Round 2 fix: drop every registered handler. Wired into authStore.signOut
 * so a logout doesn't keep a closure into MainNavigator's incoming-ring
 * handler alive — without this, an `sfu.ring.incoming` frame that
 * arrives during the logout transition would surface a ringing UI on
 * the next user's login screen.
 */
export function clearAllGroupCallRingHandlers(): void {
  handlers = [];
  // The sender closes over the previous user's transport.
  ackSender = null;
  // Finding #8(b) — drop the per-roomId ring-dedup markers too so the next
  // user's identical-roomId ring (astronomically unlikely, but) isn't
  // silently suppressed by the prior session's state.
  seenIncomingRoomIds.clear();
  // B-306 — and the parked ring: a ring parked for the previous user must
  // never surface after the next sign-in (same reasoning as the handlers).
  try {
    const {clearPendingGroupRing} = require('./pendingGroupRing') as typeof import('./pendingGroupRing');
    clearPendingGroupRing();
  } catch { /* module unavailable in stripped test harnesses — fine */ }
}

/**
 * Server-frame events this dispatcher handles. Single source of truth lives
 * in `callFrameRouter` (B-602) so the runtime's depsReady-buffer bypass and
 * this dispatch routing can never drift; re-exported here for the existing
 * `require('./groupCallRingDispatcher').GROUP_RING_FRAME_EVENTS` consumer.
 */
export {GROUP_RING_FRAME_EVENTS} from '../runtime/callFrameRouter';

// Finding #8(b) — `sfu.ring.incoming` can now REPLAY on reconnect (the
// server re-fans a still-pending ring after a WS reopen). Dedup so a
// replayed ring doesn't re-fire onIncoming (which would resurrect a
// ring surface the user already dismissed / declined).
//
// B-336 — the key is (roomId, ringId), NOT roomId alone. Keying on the room
// meant a recipient who simply never answered kept the marker for the whole
// TTL, so every DELIBERATE re-ring inside that minute — mid-call "Add", the
// host's Re-ring — was swallowed while the relay believed it had rung them
// (device log: `dedup-suppressed room=9afc41c7` 33 s after the first ring).
// A replay of ONE fan-out repeats its ringId, so replay suppression is
// unchanged; a new fan-out mints a new ringId and rings. No ringId (old
// relay) → the key degrades to roomId, i.e. exactly the old behaviour.
const seenIncomingRoomIds = new Map<string, number>();
const RING_DEDUP_TTL_MS = 60_000;

/** Marker key for one ring FAN-OUT. See B-336 above for why ringId matters. */
function ringDedupKey(roomId: string, ringId?: string): string {
  return ringId ? `${roomId}:${ringId}` : roomId;
}

/**
 * WI-3.6 — read-only. The mark is a SEPARATE step now.
 *
 * These used to be one function, and the write fired the moment the read
 * missed. That is what made B-306's fix incomplete: it moved the mark behind
 * "at least one handler exists", on the reasoning that "with at least one
 * handler the ring is always either surfaced or parked". That claim is false.
 * Downstream of the mark, `onIncoming` can still decline — restore mode is
 * active, navigation isn't ready, the route already shows this room, the
 * shell-aware navigate silently drops — and `IncomingGroupCallScreen`
 * registers an `onIncoming` that is a literal no-op yet still satisfies
 * `handlers.length > 0`. Every one of those burned the room's one chance, so
 * the server's reconnect replay AND the FCM rescue copy were both suppressed
 * for the full TTL and the user simply never saw the call.
 */
function ringRecentlySeen(roomId: string, ringId?: string): boolean {
  const now = Date.now();
  // GC expired markers so the map can't grow unbounded across a session.
  for (const [rid, at] of seenIncomingRoomIds) {
    if (now - at > RING_DEDUP_TTL_MS) {seenIncomingRoomIds.delete(rid);}
  }
  const prev = seenIncomingRoomIds.get(ringDedupKey(roomId, ringId));
  return prev !== undefined && now - prev <= RING_DEDUP_TTL_MS;
}

/** Burn the marker — ONLY once a handler has actually presented or parked. */
function markRingSeen(roomId: string, ringId?: string): void {
  seenIncomingRoomIds.set(ringDedupKey(roomId, ringId), Date.now());
}

/**
 * B-336 — cancel/decline re-arm the ROOM, so they must drop every fan-out
 * marker for it, not just the bare-roomId one (keys are now `roomId:ringId`).
 *
 * B-481 exported this as `clearGroupRingDedup`: a parked ring that expires
 * UNCONSUMED was presented to nobody, so the room must become ring-eligible
 * again rather than staying suppressed for the remainder of the 60 s window.
 * The park TTL (45 s) is deliberately shorter than the dedup TTL, so without
 * this there is a 15 s hole in which the user has a missed-call bubble, no
 * ring, and a host Re-ring that the dispatcher swallows.
 */
function clearRoomDedup(roomId: string, onlyRingId?: string): void {
  // WI-6.7 — a cancel that NAMES its fan-out re-arms only that ring's marker
  // (plus the legacy bare-roomId key, which belongs to no identifiable ring).
  // Wiping the room's every marker on a stale cancel would re-arm a NEWER
  // ring's dedup and let its replay/FCM copy re-present a ring the user is
  // already looking at.
  if (onlyRingId) {
    seenIncomingRoomIds.delete(roomId);
    seenIncomingRoomIds.delete(ringDedupKey(roomId, onlyRingId));
    return;
  }
  seenIncomingRoomIds.delete(roomId);
  const prefix = `${roomId}:`;
  for (const key of seenIncomingRoomIds.keys()) {
    if (key.startsWith(prefix)) {seenIncomingRoomIds.delete(key);}
  }
}

/**
 * B-481 — drop every dedup marker for a room. Called when a parked ring
 * expires unconsumed: nobody saw it, so the next copy must be allowed through.
 */
export function clearGroupRingDedup(roomId: string): void {
  clearRoomDedup(roomId);
}

export function dispatchGroupRingFrame(frame: {event: string; data?: unknown}): boolean {
  // B-306 — the dedup marker means PRESENTED (or parked), not merely seen.
  // This used to run "even with zero handlers so the marker is set before any
  // handler could re-register mid-replay" — which burned the room's one
  // chance on a frame nobody handled: a ring landing in a handler gap (boot,
  // sign-in transition) was marked, and the server's reconnect replay was
  // then swallowed for good. With at least one handler the ring is always
  // either surfaced or parked (pendingGroupRing), so marking is correct
  // exactly when handlers exist.
  if (frame.event === 'sfu.ring.incoming') {
    const d = frame.data as {roomId?: string; ringId?: string} | undefined;
    const rid = d?.roomId;
    if (rid && handlers.length > 0 && ringRecentlySeen(rid, d?.ringId)) {
      console.warn('[CALLDIAG] [ring.dispatch] dedup-suppressed room=', rid.slice(0, 8), 'ring=', d?.ringId?.slice(0, 8) ?? '-');
      // Suppressed BECAUSE we already have it — that is ownership, not a
      // decline, so the server's queued copy has done its job and must be
      // acked. Without this the replay would be re-emitted on every reconnect
      // until the 45 s window closed, and would then land as a spurious missed
      // call for a ring the user actually saw.
      ackReplayedRing(frame.data as GroupCallRingPayload | undefined);
      return true;
    }
  } else if (frame.event === 'sfu.ring.cancelled' || frame.event === 'sfu.ring.declined') {
    const d = frame.data as {roomId?: string; ringId?: string} | undefined;
    // WI-6.7 — cancels carry the fan-out they cancel; scope the re-arm to it.
    if (d?.roomId) {clearRoomDedup(d.roomId, frame.event === 'sfu.ring.cancelled' ? d.ringId : undefined);}
  }
  if (handlers.length === 0) {
    // AC-6 — release builds strip console.log, and this exact silence cost a
    // device session: a ring with no visible outcome and no trail.
    if (frame.event === 'sfu.ring.incoming') {
      const rid = (frame.data as {roomId?: string} | undefined)?.roomId;
      console.warn('[CALLDIAG] [ring.dispatch] NO HANDLERS for room=', rid?.slice(0, 8), '— replay stays eligible');
    }
    return false;
  }
  if (frame.event === 'sfu.ring.incoming') {
    const rid = (frame.data as {roomId?: string} | undefined)?.roomId;
    console.warn('[CALLDIAG] [ring.dispatch] incoming room=', rid?.slice(0, 8), 'handlers=', handlers.length);
  }
  // WI-3.6 — did anyone actually take responsibility for this ring?
  let presented = false;
  for (const h of handlers) {
    try {
      switch (frame.event) {
        case 'sfu.ring.incoming':
          if (h.onIncoming(frame.data as GroupCallRingPayload) === true) {presented = true;}
          break;
        case 'sfu.ring.cancelled':
          h.onCancel(frame.data as {roomId: string; conversationId: string; ringId?: string});
          break;
        case 'sfu.ring.declined':
          h.onDecline(frame.data as {
            roomId: string; conversationId: string;
            from: {userId: string; deviceId: number};
          });
          break;
      }
    } catch { /* one bad handler must not block the others */ }
  }
  // WI-3.6 — burn the dedup marker only now, and only if the ring was really
  // surfaced or parked. A ring that every handler declined stays REPLAYABLE,
  // which is the whole point: the reconnect replay and the FCM rescue copy are
  // the two lanes that recover it.
  if (frame.event === 'sfu.ring.incoming') {
    const d = frame.data as {roomId?: string; ringId?: string} | undefined;
    if (d?.roomId && presented) {
      markRingSeen(d.roomId, d.ringId);
      ackReplayedRing(d as GroupCallRingPayload);
    } else if (d?.roomId) {
      console.warn('[CALLDIAG] [ring.dispatch] not presented room=', d.roomId.slice(0, 8), '— replay stays eligible');
    }
  }
  return true;
}
