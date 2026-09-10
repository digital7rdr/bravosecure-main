/**
 * Singleton dispatcher for server-pushed SFU frames.
 *
 * The messenger runtime owns the only `onFrame` subscription on the
 * WebSocket. SFU frames (`sfu.new-producer`, `sfu.participant.left`,
 * `sfu.participant.joined`) are forwarded here from the runtime's
 * frame loop; `useGroupCall` registers a handler keyed by roomId.
 *
 * Mirrors the pattern in `callDispatcher.ts` for 1:1 calls — keeps
 * the runtime → screen routing decoupled from the runtime's static
 * switch over `ServerFrame`.
 */

type SfuFrame = {event: string; data?: {roomId?: string; [k: string]: unknown}};
type Handler = (frame: SfuFrame) => void;

// BS-ROSTER — per-room handler SET, not a single slot. useGroupCall
// registers a handler from TWO places for the same roomId: the boot
// hook (owns recvTransport + the real consumeProducer, the ONLY handler
// that consumes sfu.new-producer) and the minimize→restore resume hook
// (an intentionally partial handler). With a single-slot Map, a remount
// (common on Android during permission prompts / navigation) had the
// second registration silently CLOBBER the first — sfu.new-producer
// frames then routed to the partial handler that can't consume them, so
// a peer's tile never appeared on that device. Symptom: the three
// devices in a group call disagreed on who was present (one sees 2
// peers, another sees 1). Fanning out to ALL live handlers for the room
// is strictly additive — the shared events (participant.left / kicked /
// room.ended) are already idempotent, and new-producer is only acted on
// by the boot handler. Mirrors the multi-subscriber pattern in
// signallingClient.ts (per-event arrays + explicit unregister).
const handlersByRoom = new Map<string, Set<Handler>>();

export function registerSfuHandler(roomId: string, handler: Handler): () => void {
  let set = handlersByRoom.get(roomId);
  if (!set) {
    set = new Set<Handler>();
    handlersByRoom.set(roomId, set);
  }
  set.add(handler);
  // A second live handler for the same room is now EXPECTED (boot +
  // resume coexist). Still log the count so a genuine double-mount of
  // the full GroupCallScreen — which would push the count past 2 —
  // stays diagnosable in field logs.
  if (set.size > 1) {
    console.log(`[bravo.sfuDispatcher] room now has ${set.size} handler(s) roomId=${roomId.slice(0, 8)}`);
  }
  return () => {
    const s = handlersByRoom.get(roomId);
    if (!s) {return;}
    s.delete(handler);
    // Drop the room key once its last handler unregisters so the map
    // doesn't accumulate empty sets across the session's calls.
    if (s.size === 0) {handlersByRoom.delete(roomId);}
  };
}

export function dispatchSfuFrame(frame: SfuFrame): boolean {
  const rid = frame.data?.roomId;
  if (typeof rid !== 'string') {return false;}
  const set = handlersByRoom.get(rid);
  if (!set || set.size === 0) {return false;}
  // Snapshot before iterating: a handler may unregister itself mid-
  // dispatch (sfu.kicked / sfu.room.ended both call leaveInternal,
  // which fires the cleanup), and mutating the Set under iteration
  // would skip the sibling handler. Same self-mutation guard
  // signallingClient.ingest uses (.slice()).
  for (const h of Array.from(set)) {
    try { h(frame); } catch { /* ignore — one bad handler must not block the others */ }
  }
  return true;
}

/**
 * Audit P0-C3 — feed the per-room observed-tag set from the
 * authoritative SFU broadcasts so a sealed `groupCallPresence` envelope
 * can only label a tag the SFU has actually announced for this room.
 * Wired into the runtime frame loop ALONGSIDE dispatchSfuFrame (it runs
 * for every SFU frame the runtime sees, regardless of which useGroupCall
 * handler — full or reduced/restore — is mounted). A kicked peer surfaces
 * to OTHER clients as `sfu.participant.left`, so that's the authoritative
 * drop signal (`sfu.kicked` is self-addressed to the kicked client).
 *
 * Pure routing on (event, roomId, participantTag) → registry mutation;
 * exported so the wiring is unit-testable without standing up the whole
 * runtime FrameDeps surface.
 */
export function recordSfuObservedTag(frame: SfuFrame): void {
  const evt = frame.event;
  const rid = frame.data?.roomId;
  const tag = (frame.data as {participantTag?: unknown} | undefined)?.participantTag;
  if (typeof rid !== 'string' || typeof tag !== 'string') {return;}

  const idReg = require('./groupCallIdentityRegistry') as typeof import('./groupCallIdentityRegistry');
  if (evt === 'sfu.participant.joined') {
    idReg.recordObservedTag(rid, tag);
  } else if (evt === 'sfu.participant.left') {
    idReg.forgetObservedTag(rid, tag);
  }
}

/** Server frame events this dispatcher handles. */
export const SFU_FRAME_EVENTS = new Set([
  'sfu.new-producer',
  'sfu.participant.joined',
  'sfu.participant.left',
  'sfu.transport.connected',
  /** Host moderation — addressed to the muted client. */
  'sfu.muted',
  /**
   * Audit SFU-08 — host UN-muted the target. The server emits this + unpauses
   * the producers (audio flows again) but it was NOT in this allowlist, so the
   * target's UI stayed stuck in "muted by host" forever. Now consumed by the
   * useGroupCall handler below.
   */
  'sfu.unmuted',
  /** Host moderation — addressed to the kicked client. */
  'sfu.kicked',
  /**
   * Host left the room — broadcast to every remaining participant.
   * They MUST tear down (close consumers/transports, drop UI) because
   * the server has already closed every other participant's resources
   * and deleted the room. Without handling this, peers continued
   * talking to each other in a hostless ghost room indefinitely.
   */
  'sfu.room.ended',
  /**
   * Peer toggled their camera/mic mid-call. The SFU (setProducerPaused)
   * pauses/resumes the producer and fans these to the room so peers swap
   * the tile to its avatar placeholder (paused) / back to live video
   * (resumed). These were MISSING from this set, so the runtime frame loop
   * dropped them before `dispatchSfuFrame` — `useGroupCall`'s handler
   * existed but never fired, leaving the remote tile FROZEN on the last
   * decoded frame after camera-off and stuck-off after the peer re-enabled
   * it (the "mobile shows the emulator's video as off / frozen" bug). The
   * server emits + broadcasts them correctly; this gate was the break.
   */
  'sfu.producer-paused',
  'sfu.producer-resumed',
  /**
   * KO-6 / B-567 — host authority moved after a failed host-claiming join
   * (the server's rollback handoff). The THIRD instance of this exact class
   * in this very set (SFU-08's `sfu.unmuted`, the producer-paused pair): the
   * useGroupCall handlers shipped while this allowlist silently dropped the
   * frame, so the real host never learned it held ring-cancel/call-key
   * authority. The routing pin now scans THIS set, not just the handlers.
   */
  'sfu.host-changed',
]);

/**
 * Round 2 fix: drop every per-room handler. Wired into authStore.signOut
 * so a logout doesn't leave a closure pinning the prior user's
 * useGroupCall hook (and its mediasoup Device + transports) reachable
 * through this map.
 */
export function clearAllSfuHandlers(): void {
  handlersByRoom.clear();
}
