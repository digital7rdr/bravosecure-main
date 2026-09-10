/**
 * B-306 — the parked-group-ring mailbox.
 *
 * A group ring that arrives while a 1:1 call owns the screen must not be
 * navigated over it: CallScreen's ended auto-dismiss is a delayed goBack that
 * pops WHATEVER is on top, so a ring screen pushed in that window is popped
 * ~50 ms later — and the ring dispatcher's dedup swallows the replay, so the
 * loser of that race is unrecoverable (device-proven, 2026-07-27 two-device
 * run 3: no ringtone, no answer button, frozen 1:1 screen).
 *
 * Instead MainNavigator PARKS the ring here, and CallScreen consumes it at
 * its own dismissal moment — the single actor that already owns that
 * navigation. See pendingGroupRing.test.ts for the pinned semantics.
 *
 * Why a plain module and not the store: the payload is transient routing
 * state with a sub-minute lifetime; persisting it (or exposing it to
 * subscribers) would only add re-render pressure to a screen that is mid-
 * teardown.
 */
import type {GroupCallRingPayload} from './groupCallRingDispatcher';

/**
 * Matches the server's ring window (the host's 30 s ring + grace). A parked
 * ring older than this is dead — the host side has timed out, and consuming
 * it would walk the user into a room where nobody is ringing them.
 */
const PARKED_RING_TTL_MS = 45_000;

let parked: {ring: GroupCallRingPayload; parkedAt: number} | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

/**
 * B-321 residual — the parked ring truly expired UNCONSUMED: the user never
 * saw it, so drop the same "Missed group call" bubble the B-12 path
 * (IncomingGroupCallScreen) writes, through the shared helper → store
 * appendMessage (B-134). stableId keyed by roomId keeps this idempotent with
 * the server's `sfu.ring.missed` replay marker. Consumes and clears
 * (cancel / sign-out) never route here — expiry only.
 */
function expireUnconsumed(): void {
  const p = parked;
  parked = null;
  cancelExpiryTimer();
  if (!p) {return;}
  // B-481 — this ring was presented to NOBODY, so the room must not stay
  // dedup-suppressed. The park TTL is 45 s and the dedup marker lives 60 s, so
  // without this there is a 15 s hole where the user has a missed-call bubble,
  // no ring, and a host Re-ring the dispatcher swallows. Lazily required to
  // keep the runtime dependency one-directional (the dispatcher requires THIS
  // module, not the other way round).
  try {
    const {clearGroupRingDedup} =
      require('./groupCallRingDispatcher') as typeof import('./groupCallRingDispatcher');
    clearGroupRingDedup(p.ring.roomId);
  } catch { /* dispatcher unavailable (stripped harness) — best-effort */ }
  if (!p.ring.conversationId) {return;}
  try {
    const {appendMissedGroupCallBubble} =
      require('./useGroupCall') as typeof import('./useGroupCall');
    appendMissedGroupCallBubble({
      conversationId: p.ring.conversationId,
      callType:       p.ring.callType,
      stableId:       `missed-group-${p.ring.roomId}`,
      at:             p.parkedAt + PARKED_RING_TTL_MS,
    });
  } catch { /* store / hook module unavailable (stripped harness) — best-effort */ }
}

/**
 * The age of the last ring taken out of the mailbox, so a caller that has to
 * put it BACK can preserve it. See `reparkGroupRing`.
 */
let lastConsumed: {roomId: string; parkedAt: number} | null = null;

/** Arm the sweep for whatever time this ring has left. */
function armExpiry(parkedAt: number): void {
  cancelExpiryTimer();
  // Why: without a sweep the TTL was only checked lazily, so a ring nobody
  // ever peeked/consumed died with no missed-call record (B-321 residual).
  // +1 ms keeps the sweep on the strict `>` side of fresh()'s comparison.
  const remaining = PARKED_RING_TTL_MS - (Date.now() - parkedAt);
  expiryTimer = setTimeout(expireUnconsumed, Math.max(0, remaining) + 1);
}

/**
 * B-481 — a room whose parked ring was displaced (or whose park died) was shown
 * to nobody, so the dispatcher must let a later copy through instead of
 * suppressing it for the rest of the 60 s dedup window. Lazily required to keep
 * the runtime dependency one-directional.
 */
function releaseSupersededRoom(roomId: string): void {
  try {
    const {clearGroupRingDedup} =
      require('./groupCallRingDispatcher') as typeof import('./groupCallRingDispatcher');
    clearGroupRingDedup(roomId);
  } catch { /* dispatcher unavailable (stripped harness) — best-effort */ }
}

/** Latest wins — a newer concurrent ring is the live intent. */
export function parkGroupRing(ring: GroupCallRingPayload): void {
  // A displaced ring is a SUPERSEDE, not an expiry: the newer ring is the live
  // intent and the replaced one deliberately gets no missed-call bubble (pinned
  // by pendingGroupRingExpiryBubble.test.ts). But it was still presented to
  // nobody, so its room must not stay dedup-suppressed for the remainder of the
  // 60 s window — that is the B-481 contract, and the overwrite was the one
  // unconsumed-death path that skipped it.
  if (parked && parked.ring.roomId !== ring.roomId) {releaseSupersededRoom(parked.ring.roomId);}
  parked = {ring, parkedAt: Date.now()};
  armExpiry(parked.parkedAt);
}

/**
 * Put a ring BACK after a consume that could not present it.
 *
 * Distinct from `parkGroupRing` because the TTL measures AGE SINCE THE HOST
 * RANG — its doc block above says a ring older than the window is dead and
 * consuming it "would walk the user into a room where nobody is ringing them".
 * A re-park that stamped `Date.now()` would reset that clock, so a ring could
 * be handed to the user minutes after the host gave up. Preserve the original
 * age; if it has already run out, expire it properly rather than re-arming.
 */
export function reparkGroupRing(ring: GroupCallRingPayload): void {
  const parkedAt = lastConsumed && lastConsumed.roomId === ring.roomId
    ? lastConsumed.parkedAt
    : Date.now();
  if (Date.now() - parkedAt > PARKED_RING_TTL_MS) {
    // Already dead. Route through the single expiry path so it still gets its
    // missed-call bubble and re-arms the room.
    parked = {ring, parkedAt};
    cancelExpiryTimer();
    expireUnconsumed();
    return;
  }
  if (parked && parked.ring.roomId !== ring.roomId) {releaseSupersededRoom(parked.ring.roomId);}
  parked = {ring, parkedAt};
  armExpiry(parkedAt);
}

function fresh(): GroupCallRingPayload | null {
  if (!parked) {return null;}
  if (Date.now() - parked.parkedAt > PARKED_RING_TTL_MS) {
    // Backstop for suspended timers (Android backgrounds the JS clock): the
    // lazy check found the corpse first — same single expiry path.
    expireUnconsumed();
    return null;
  }
  return parked.ring;
}

/** Non-destructive read (UI badges, diagnostics). */
export function peekPendingGroupRing(): GroupCallRingPayload | null {
  return fresh();
}

/** Exactly-once: returns the parked ring and clears it. */
export function consumePendingGroupRing(): GroupCallRingPayload | null {
  const age = parked?.parkedAt ?? null;
  const r = fresh();
  parked = null;
  cancelExpiryTimer();
  // Remember the age so a caller that fails to present it can put it back
  // without resetting the clock (see reparkGroupRing).
  lastConsumed = r && age !== null ? {roomId: r.roomId, parkedAt: age} : null;
  return r;
}

/**
 * `sfu.ring.cancelled` for a specific room, or unconditional on sign-out.
 * roomId-scoped so a cancel for room A never discards a parked ring for B.
 *
 * WI-6.7 — `onlyRingId` names the fan-out the cancel is for. When both the
 * cancel and the parked ring carry one and they differ, the parked ring is a
 * NEWER fan-out for the same room and survives. Either side lacking a ringId
 * falls back to the roomId-wide clear.
 */
export function clearPendingGroupRing(roomId?: string, onlyRingId?: string): void {
  if (!parked) {return;}
  if (roomId !== undefined && parked.ring.roomId !== roomId) {return;}
  if (roomId !== undefined && onlyRingId && parked.ring.ringId && parked.ring.ringId !== onlyRingId) {return;}
  parked = null;
  cancelExpiryTimer();
}

export function _resetPendingGroupRingForTest(): void {
  parked = null;
  lastConsumed = null;
  cancelExpiryTimer();
}
