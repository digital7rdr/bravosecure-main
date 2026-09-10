/**
 * WI-3.1 — per-attempt generation for the group-call boot / rejoin lifecycle.
 *
 * `rejoinRoom` in `useGroupCall` is a long async function that closes dead
 * mediasoup objects, rebuilds both transports, re-produces the local tracks
 * and re-consumes every remote producer — across four `await` points. Nothing
 * stopped a SECOND rejoin from starting while the first was still in flight
 * (the WS can bounce again mid-rejoin; the hub's stuck-claim takeover exists
 * precisely to let a second one start). Two attempts then interleave:
 *
 *   • the loser's `consumedProducerIdsRef.clear()` erases the winner's record
 *     of what it has already consumed → every producer is consumed twice and
 *     mediasoup throws "consumer already exists";
 *   • the loser's `producersRef.current.push(p)` appends producers bound to a
 *     transport it is about to close;
 *   • the loser's `sendTxRef.current = reSendTx` re-points the live refs at a
 *     transport built against the dead socket;
 *   • the loser's terminal `setState` lands after the winner's — `failed` over
 *     a joined call, or `joined` over a failed one, in either order.
 *
 * The remedy is an attempt generation: each attempt takes a number when it
 * starts, and every write it performs AFTER an await is conditional on that
 * number still being the newest one for the room.
 *
 * WHY THE COUNTER IS MODULE-LEVEL AND ROOM-KEYED rather than a `useRef`:
 * `rejoinRoom` is stashed into `liveSfuHandlesByRoom` and ADOPTED by the hook
 * instance that mounts after a minimize→restore, so the adopted closure still
 * reads the ORIGINAL instance's refs. A restored instance bumping its own ref
 * would be comparing against a counter the adopted closure never sees. The
 * hook already reached this conclusion for the rejoin in-flight guard, which
 * lives in `groupCallRejoinHub` for exactly this reason — see its header: a
 * per-instance ref "could not see a rejoin still in flight from the hook
 * instance that owned the call before this restore".
 *
 * Pure and dependency-free apart from the diagnostic lane, so the whole
 * decision is unit-testable without the mediasoup graph.
 */
import {logCallSm, logCallSmQuiet, shortCallId} from '../runtime/callDiag';
import {GROUP_REBUILD_MARK_CEILING_MS} from './callDeadlines';

/** Why an attempt must stop. `proceed` is the only verdict that may write. */
export type AttemptVerdict = 'proceed' | 'superseded' | 'leaving' | 'cancelled';

export interface AttemptSnapshot {
  /** The room this attempt belongs to. */
  roomId:    string;
  /** The generation this attempt was issued at (from `beginAttempt`). */
  gen:       number;
  /** The hook instance unmounted (boot effect's `cancelled` flag). */
  cancelled: boolean;
  /** A teardown is in flight (`isLeavingRef.current`). */
  leaving:   boolean;
}

const genByRoom = new Map<string, number>();

/**
 * Start a new attempt for `roomId` and return its generation. Every attempt
 * issued earlier for the same room is superseded from this moment.
 */
export function beginAttempt(roomId: string): number {
  const next = (genByRoom.get(roomId) ?? 0) + 1;
  genByRoom.set(roomId, next);
  return next;
}

/** The newest generation issued for `roomId`; 0 when the room is unknown. */
export function currentAttempt(roomId: string): number {
  return genByRoom.get(roomId) ?? 0;
}

/**
 * Forget a room's counter — call from real teardown.
 *
 * Restarting the sequence at 1 for a room that is re-entered later is safe
 * because the clear happens at teardown, after which every surviving attempt
 * from the previous call also carries `leaving`/`cancelled` and is refused on
 * that ground regardless of its number.
 */
export function clearRoomAttempts(roomId: string): void {
  genByRoom.delete(roomId);
  rejoinActiveByRoom.delete(roomId);
}

/**
 * WI-3.2 - "a rejoin is rebuilding this room right now".
 *
 * The reconcile tick, `attemptConsume` and the early-producer buffer all read
 * this and stand down while it holds, because a rejoin closes every consumer
 * and both transports before rebuilding them: anything that consumes during
 * that window lands on a half-built `reRecvTx` and re-inserts tiles the rejoin
 * has just cleared.
 *
 * Room-keyed and module-level for the same reason as the counter above - the
 * readers live on a DIFFERENT hook instance from the writer after a
 * minimize/restore (`consumeMissingAfterRestore` is a `useCallback` on the
 * restored instance; `rejoinRoom` is the adopted boot closure).
 *
 * It carries a wall-clock stamp and expires, and is NOT a boolean latch:
 * `rejoinRoom` can ride an ack that never settles, and a latch that only
 * cleared on settlement would disable reconcile for the rest of the call.
 * Its ceiling is deliberately SHORTER than the hub's takeover window - see
 * GROUP_REBUILD_MARK_CEILING_MS for why the two cannot share a number.
 */
const rejoinActiveByRoom = new Map<string, {gen: number; at: number}>();

/** Mark this attempt as the one currently rebuilding `roomId`. */
export function markAttemptRunning(roomId: string, gen: number): void {
  rejoinActiveByRoom.set(roomId, {gen, at: Date.now()});
}

/**
 * Release the in-flight mark - ONLY if this attempt still owns it.
 *
 * The generation check is load-bearing: a superseded attempt's `finally` runs
 * while the winner is still mid-rebuild, and an unconditional clear would
 * re-open the reconcile tick onto exactly the half-built transports this
 * exists to protect. Phase 1's `endActiveGroupCall` shipped the unguarded
 * version of this same shape.
 */
export function endAttemptRunning(roomId: string, gen: number): void {
  const cur = rejoinActiveByRoom.get(roomId);
  if (!cur || cur.gen !== gen) {return;}
  rejoinActiveByRoom.delete(roomId);
}

/**
 * The generation of the rejoin currently rebuilding `roomId`, or null.
 *
 * Callers that are THEMSELVES part of a rejoin need this rather than the
 * boolean: `rejoinRoom` re-consumes every existing producer through the same
 * `consumeProducer` funnel that everyone else uses, so a blanket "stand down
 * while a rejoin runs" check would make the rejoin stand down from its own
 * work and rebuild a room with no remote tiles in it.
 */
export function runningAttemptGen(roomId: string): number | null {
  const cur = rejoinActiveByRoom.get(roomId);
  if (!cur) {return null;}
  if (Date.now() - cur.at >= GROUP_REBUILD_MARK_CEILING_MS) {
    // Expired: the ack can never arrive. Drop it rather than block the
    // reconcile backstop for the rest of the call.
    rejoinActiveByRoom.delete(roomId);
    return null;
  }
  return cur.gen;
}

/** True while a non-expired rejoin holds `roomId`. */
export function isAttemptRunning(roomId: string): boolean {
  return runningAttemptGen(roomId) !== null;
}

/** Drop every room's counter (logout / hard reset). */
export function clearAllAttempts(): void {
  genByRoom.clear();
  rejoinActiveByRoom.clear();
}

/**
 * The whole decision, in one place.
 *
 * Ordering is diagnostic rather than behavioural — all three non-proceed
 * verdicts abort — but `superseded` deliberately outranks the teardown flags:
 * it is the one that means a RACE actually happened, and reporting it as an
 * ordinary unmount would hide the very thing this work item exists to surface.
 *
 * The generation test is `!==`, not `<`. A generation NEWER than the counter
 * is impossible by construction, which is exactly why it must fail closed: a
 * `<` comparison would wave a corrupt caller straight through to the live
 * call's refs.
 */
export function attemptVerdict(s: AttemptSnapshot): AttemptVerdict {
  if (s.gen !== currentAttempt(s.roomId)) {return 'superseded';}
  if (s.leaving)   {return 'leaving';}
  if (s.cancelled) {return 'cancelled';}
  return 'proceed';
}

/** True only when this attempt is still the newest AND nothing is tearing down. */
export function attemptIsLive(s: AttemptSnapshot): boolean {
  return attemptVerdict(s) === 'proceed';
}

/**
 * Call-site helper: returns TRUE when the caller must abort, and leaves a
 * trail on the right channel.
 *
 * A superseded drop rides `console.warn`, which survives the release build's
 * console stripping — a lost rejoin race on a user's device has to be
 * diagnosable. Ordinary unmount/teardown drops fire on every normal hang-up
 * and stay on `log`, so they cannot bury the warns.
 */
export function abortStaleAttempt(where: string, s: AttemptSnapshot): boolean {
  const verdict = attemptVerdict(s);
  if (verdict === 'proceed') {return false;}
  const fields = {
    where,
    verdict,
    room: shortCallId(s.roomId),
    gen:  s.gen,
    cur:  currentAttempt(s.roomId),
  };
  if (verdict === 'superseded') {logCallSm('groupcall.attempt.drop', fields);}
  else                          {logCallSmQuiet('groupcall.attempt.drop', fields);}
  return true;
}
