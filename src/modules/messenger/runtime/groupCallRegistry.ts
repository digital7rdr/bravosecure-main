/**
 * Active GROUP-call registry — singleton that owns a mediasoup SFU
 * call's lifecycle so the call survives `GroupCallScreen` unmount.
 *
 * Mirrors `callRegistry.ts` for 1:1 calls. Lifting the room handle +
 * local stream + transport refs out of the React hook lets the user
 * minimize the group call (FloatingCallOverlay), navigate elsewhere,
 * and come back without the room being torn down.
 *
 * The registry holds REFS only — it doesn't manage cleanup. `endActive`
 * is the only path that disposes the underlying mediasoup objects;
 * everything else is read/patch.
 */
import {logCallSm, logCallSmQuiet, logCallTransition, shortCallId} from './callDiag';
import type {MediaStream, MediaStreamTrack} from 'react-native-webrtc';
import type {RemoteTile, GroupCallState, AudioLevelMap} from '../webrtc/useGroupCall';

/**
 * WI-1.5 — identity of ONE group-call session. `roomId` is the key every writer
 * cites; `gen` distinguishes two sessions in the same room (a re-create after
 * `room_not_found`, a rejoin that superseded an earlier attempt) and is what
 * the Phase-3 per-attempt generation will check against.
 */
export interface GroupCallKey {
  roomId: string;
  gen:    number;
}

/**
 * What `endActiveGroupCall` did — the group mirror of `EndCallOutcome`.
 *
 *  • `'ended'`   — the slot is quiet as far as this caller is concerned. That
 *                  covers "there was nothing to close" and "a newer call took
 *                  the slot mid-teardown, and owns the audio session and FGS
 *                  now" as well as the ordinary case, so it does NOT mean
 *                  "I stopped a call". Do not read it as one.
 *  • `'ending'`  — a teardown for it was already in flight; we awaited that one.
 *  • `'refused'` — the slot holds a DIFFERENT room. A caller whose next step
 *                  assumes the group call is gone must handle this, or it
 *                  proceeds with the call still fully live.
 *
 * `void` was the original shape and it is what made a stale-key drop invisible:
 * "await the teardown, then navigate" silently became "navigate now".
 */
export type GroupEndOutcome = 'ended' | 'ending' | 'refused';

export interface ActiveGroupCallState {
  roomId:           string;
  /** WI-1.5 — minted by `setActiveGroupCall`. Never patchable. */
  gen:              number;
  /**
   * WI-1.6 — set for the whole of `endActiveGroupCall`, i.e. while `leave()` is
   * still closing the transports. Busy guards MUST treat this as busy: the slot
   * used to be nulled BEFORE the await, so every guard saw "no call" while the
   * mediasoup transports were still tearing down and admitted a boot that raced
   * `sfu.join` (the `transport_id_in_use` class). Not an adoptable state and
   * not a resumable one.
   */
  ending?:          boolean;
  conversationId:   string;
  conversationName: string;
  callType:         'voice' | 'video';
  /** True when this user is the room host — drives moderation UI. */
  isHost:           boolean;
  /** Server-issued opaque tag for this client's participant slot. */
  selfTag:          string | null;
  state:            GroupCallState;
  localStream:      MediaStream | null;
  remoteTiles:      RemoteTile[];
  /** participantTag → identity, populated as identity envelopes arrive. */
  identityByTag:    Record<string, {displayName: string; userId?: string}>;
  /**
   * Live audio level per participantTag (0..1). Mirrored from the
   * useGroupCall hook's state on every meaningful change so the
   * minimized FloatingCallOverlay can compute "who's talking now"
   * without taking another ref to the hook.
   */
  audioLevels:      AudioLevelMap;
  audioTrack:       MediaStreamTrack | null;
  videoTrack:       MediaStreamTrack | null;
  isMuted:          boolean;
  isVideoOff:       boolean;
  isMinimized:      boolean;
  /**
   * When true, the screen unmount path should NOT run leave() — the user
   * is just navigating away while the call continues. The floating
   * overlay's end button or the leave-on-last-out path clears it.
   */
  keepAlive:        boolean;
  /** Bound by the hook so the overlay's hangup button can tear down. */
  leave:            (() => Promise<void>) | null;
  /** Bound by the hook so the overlay can toggle audio. */
  toggleMute:       (() => void) | null;
  /**
   * Bound by the hook so the overlay can toggle video. Kept in sync
   * via the same registry-mirror effect as `leave` and `toggleMute`
   * so the overlay always invokes the freshest closure (each useCallback
   * remint captures the current localStream — without sync, a stale
   * binding would acquire a fresh camera but never splice it into the
   * live MediaStream the overlay is rendering).
   */
  toggleVideo:      (() => Promise<void>) | null;
  /** Wall-clock when state first became 'joined' — drives the duration timer. */
  joinedAtMs:       number | null;
  /**
   * userId → expiresAtMs map for the host's outbound invite countdowns.
   * Lives on the registry so the timing survives GroupCallScreen
   * minimize → restore (the screen unmounts and re-mounts; without this
   * the countdown would reset to 0 every restore). Optional so existing
   * callers don't break — undefined means "no invites in flight".
   */
  inviteRingExpiry?: Record<string, number>;
}

let active: ActiveGroupCallState | null = null;
let listeners: Array<(s: ActiveGroupCallState | null) => void> = [];
/** WI-1.5 — monotonic generation source, mirroring `callRegistry`. */
let genCounter = 0;
/**
 * WI-1.6 — the in-flight `leave()`. Exposed so the next boot can AWAIT the
 * previous teardown instead of racing `sfu.join` against transports that are
 * still closing. Same role `staleLeavePromise` already plays in `useGroupCall`.
 */
let leaveInFlight: Promise<void> | null = null;

function notify(): void {
  // Fix #15: snapshot before iterating — a listener can splice the
  // array via its disposer during the callback, and iterating the
  // live array would then skip later entries.
  const snapshot = [...listeners];
  for (const l of snapshot) {
    try { l(active); } catch { /* one bad listener mustn't block the rest */ }
  }
}

export function getActiveGroupCall(): ActiveGroupCallState | null {
  return active;
}

/**
 * B-33 (Defect A) — duration-timer source of truth. The GroupCallScreen timer
 * must derive from the registry's persistent `joinedAtMs` (which survives a
 * minimize→restore / unmount→remount), NOT a local useState counter that
 * resets to 0 on every remount. Mirrors FloatingCallOverlay's anchor. A
 * null/absent anchor (not yet joined) reads 0; a future timestamp clamps to 0.
 */
export function groupCallElapsedSeconds(
  joinedAtMs: number | null | undefined,
  nowMs: number,
): number {
  if (!joinedAtMs) {return 0;}
  return Math.max(0, Math.round((nowMs - joinedAtMs) / 1000));
}

/**
 * B-33 (Defect B) — non-destructive roster seed for a same-room SFU rejoin.
 * When the hook falls through to the fresh-boot path for a room that is STILL
 * in the registry (e.g. a local track ended so the adopt gate failed), seed
 * the new registry snapshot from the prior entry so the user doesn't see an
 * empty grid while live consume re-attaches. A genuinely different room (or no
 * prior call) starts empty. The subsequent consume / identity-envelope flow
 * overwrites with live data either way — this only changes the INITIAL seed.
 */
export function seedRosterForRepublish(
  prior: ActiveGroupCallState | null,
  roomId: string,
  selfTag: string,
  ownDisplayName: string,
): Pick<ActiveGroupCallState, 'remoteTiles' | 'identityByTag'> {
  const sameRoom = !!prior && prior.roomId === roomId;
  return {
    remoteTiles: sameRoom ? prior!.remoteTiles : [],
    identityByTag: sameRoom
      ? {...prior!.identityByTag, [selfTag]: {displayName: ownDisplayName}}
      : {[selfTag]: {displayName: ownDisplayName}},
  };
}

/**
 * B-08 — decide whether an incoming `sfu.ring.incoming` frame should
 * trigger a navigation to IncomingGroupCallScreen.
 *
 * Why: the server fans the ring to every recipient's userRoom, and a
 * duplicate ring (server re-fan-out, the host's own ring echoing back,
 * or a presence/ring race) used to navigate unconditionally — unmounting
 * an in-progress GroupCallScreen whose unmount cleanup then called
 * leaveInternal(), aborting the very join in progress. Suppress the
 * navigation when the user is already in/joining THIS room (active call
 * registry) or already sitting on the ring/call screen for it. A
 * genuinely distinct room (different roomId) must still ring.
 */
export function shouldNavigateForRing(
  ringRoomId:          string,
  activeRoomId:        string | null,
  currentRouteName:    string | undefined,
  currentRouteRoomId:  string | undefined,
): boolean {
  if (activeRoomId && activeRoomId === ringRoomId) {return false;}
  if (
    (currentRouteName === 'GroupCallScreen' ||
      currentRouteName === 'IncomingGroupCallScreen') &&
    currentRouteRoomId === ringRoomId
  ) {
    return false;
  }
  return true;
}

/**
 * B-341 — one tick of the invite-ring countdown. Pure so the ticker rule is
 * unit-testable: the screen's interval must run a bump+prune pass whenever the
 * map is NON-EMPTY. The previous gate ("some entry still in the future") is
 * exactly the bug — an all-expired map needs one final tick to prune, and
 * skipping it froze the UI on a permanent disabled "Ringing… 1s" row (the last
 * nowTick bump always lands inside the final second, so ceil() renders 1).
 * Returns null only when the map is empty (ticker idles); otherwise the pruned
 * map to store (may equal the input's entries when nothing expired).
 */
export function inviteRingTickPlan(
  expiry: Record<string, number>,
  now: number,
): {next: Record<string, number>} | null {
  const entries = Object.entries(expiry);
  if (entries.length === 0) {return null;}
  const next: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (v > now) {next[k] = v;}
  }
  return {next};
}

/** What a caller hands `setActiveGroupCall`; `gen`/`ending` are registry-owned. */
export type ActiveGroupCallSeed = Omit<ActiveGroupCallState, 'gen' | 'ending'>;

/**
 * The one gate every keyed group write goes through. Returns the live entry
 * when `roomId` owns it, else null after recording why.
 */
function claimActiveGroup(roomId: string | null | undefined, op: string): ActiveGroupCallState | null {
  const cur = active;
  // Same split as the 1:1 registry, by OP. A dropped patch/minimize is routine
  // (a write before the room exists, a write after the call is gone). A dropped
  // RENAME never is: `renameActiveGroupCallRoom`'s whole hazard is that keying
  // it wrong is SILENT and strands the entry on a reaped room, after which
  // `launchCall`'s busy guard blocks calls in OTHER conversations. That needs a
  // release-visible line. `stale-room` is an anomaly for any op.
  const drop = op === 'rename' ? logCallSm : logCallSmQuiet;
  if (!roomId) {
    drop(`group.${op}.dropped`, {why: 'no-room', liveRoom: shortCallId(cur?.roomId), liveGen: cur?.gen ?? null});
    return null;
  }
  if (!cur) {
    drop(`group.${op}.dropped`, {why: 'no-active', room: shortCallId(roomId)});
    return null;
  }
  if (cur.roomId !== roomId) {
    logCallSm(`group.${op}.dropped`, {
      why: 'stale-room', room: shortCallId(roomId), liveRoom: shortCallId(cur.roomId), liveGen: cur.gen,
    });
    return null;
  }
  return cur;
}

export function setActiveGroupCall(next: ActiveGroupCallSeed | null): GroupCallKey | null {
  if (!next) {
    if (active) {logCallSm('group.cleared', {room: shortCallId(active.roomId), gen: active.gen});}
    active = null;
    notify();
    return null;
  }
  const gen = ++genCounter;
  active = {...next, gen};
  logCallSm('group.set', {room: shortCallId(next.roomId), gen, type: next.callType, state: next.state});
  notify();
  return {roomId: next.roomId, gen};
}

/**
 * Mutate the live group call — ONLY when `roomId` still owns the slot.
 *
 * Before WI-1.5 exactly ONE of 30 call sites checked. Every frame handler,
 * consume/reconcile write, camera write and identity write from a superseded
 * room wrote straight into whatever call was active.
 */
export function patchActiveGroupCall(
  roomId: string | null | undefined,
  patch: Partial<Omit<ActiveGroupCallState, 'roomId' | 'gen' | 'ending'>>,
): boolean {
  const cur = claimActiveGroup(roomId, 'patch');
  if (!cur) {return false;}
  // WI-7.1 — transition record for a state-carrying patch. HONEST SCOPE
  // (review round 3): no production writer patches `state` today — live
  // milestones re-REGISTER (`group.set` logs state) or end (`group.end`),
  // and the intermediate React-state transitions are recorded by
  // useGroupCall's setState funnel. This line exists so a FUTURE writer
  // that does patch state cannot bypass the lane. Same-state stays silent.
  if (patch.state !== undefined && patch.state !== cur.state) {
    logCallTransition({
      callId: cur.roomId, gen: cur.gen,
      prev: cur.state, next: patch.state, event: 'patch', source: 'groupRegistry',
    });
  }
  // Identity re-pinned after the spread — same reasoning as the 1:1 registry:
  // most writers reach this through an untyped lazy `require()`.
  active = {...cur, ...patch, roomId: cur.roomId, gen: cur.gen, ending: cur.ending};
  notify();
  return true;
}

/**
 * The ONE legitimate room-id rewrite: an outgoing create that hit
 * `room_not_found` on `sfu.join` re-creates the room, and the registry entry
 * has to follow. It is a separate call precisely because `patchActiveGroupCall`
 * must never be able to change identity — and because keying it wrong is
 * silent: `leaveInternal` only tears down when `reg.roomId === rid`, so a
 * stranded id leaves `launchCall`'s busy guard blocking calls in OTHER
 * conversations with "Call in progress".
 */
export function renameActiveGroupCallRoom(fromRoomId: string | null | undefined, toRoomId: string): boolean {
  const cur = claimActiveGroup(fromRoomId, 'rename');
  if (!cur) {return false;}
  logCallSm('group.rename', {room: shortCallId(fromRoomId), next: shortCallId(toRoomId), gen: cur.gen});
  active = {...cur, roomId: toRoomId};
  notify();
  return true;
}

export function setGroupCallMinimized(roomId: string | null | undefined, min: boolean): boolean {
  const cur = claimActiveGroup(roomId, 'minimize');
  if (!cur) {return false;}
  active = {...cur, isMinimized: min, keepAlive: min};
  notify();
  return true;
}

export function onActiveGroupCallChange(cb: (s: ActiveGroupCallState | null) => void): () => void {
  listeners.push(cb);
  try { cb(active); } catch { /* ignore */ }
  return () => { listeners = listeners.filter(l => l !== cb); };
}

/**
 * Hard-end the group call — invokes the bound leave() (which sends
 * sfu.leave and tears the mediasoup objects down) then clears the slot.
 * Safe to call multiple times.
 */
/**
 * RoomId-keyed audio-session-started flag — see callRegistry.ts.
 *
 * NOTE the seam: registry IDENTITY is `gen`, but this side-table is keyed by
 * `roomId`. They answer different questions, and conflating them is where a bug
 * landed once already — the teardown's hand-off branch decides ownership by
 * `gen` and must still decide this delete by `roomId`. A stranded flag makes a
 * later call on the same room skip `InCallManager.start()` AND the foreground
 * service, silently.
 */
const audioSessionStartedFor = new Set<string>();

export function markGroupAudioSessionStarted(roomId: string): boolean {
  if (audioSessionStartedFor.has(roomId)) {return false;}
  audioSessionStartedFor.add(roomId);
  return true;
}

export function clearGroupAudioSessionStarted(roomId: string): void {
  audioSessionStartedFor.delete(roomId);
}

/**
 * WI-1.6 — the leave still in flight, or null. A booting call awaits this
 * before `sfu.join` so it cannot open transports against a room the previous
 * call has not finished closing.
 */
export function groupLeaveInFlight(): Promise<void> | null { return leaveInFlight; }

/** Fix #8's bound. A wedged `leave()` must not hold a new call hostage. */
const LEAVE_BOUND_MS = 3_000;

/**
 * Hard-end the group call.
 *
 * WI-1.5 — `roomId` is the weak (id-only) ref: supply it wherever the caller
 * knows which room it means, and the teardown is REFUSED if the slot has moved
 * on. Omitting it means "end whatever is live" — the honest contract for a
 * caller that genuinely names no room, which today is signOut alone (the
 * foreground-service action and the self-removed eject both read the live
 * entry's id first). Omission is NOT a convenience: an unkeyed End from a stale
 * surface tears down the call that took the slot.
 *
 * Check the outcome if your next step assumes the call is gone.
 *
 * NEVER call this from inside `leave()`. Three branches (`!active`, refused,
 * already-ending) await `leaveInFlight`, so a re-entry from within the teardown
 * would await its own promise and stall until the 3 s bound broke the cycle.
 * Nothing in `leaveInternal`'s call graph does today; keep it that way.
 */
/**
 * B-595 — every EXTERNAL artifact a group call leaves behind, cleared in one
 * place, keyed on the room.
 *
 * Extracted because the registry teardown was not the only lane that ends a
 * call. `sfu.room.ended` (the HOST hangs up) and `sfu.kicked` call
 * `leaveInternal` directly, which nulls the slot itself and never routes
 * through `endActiveGroupCall` — so every OTHER participant, the ones who did
 * not press anything, kept the ring card and the Telecom notification. That is
 * the founder's symptom for everyone except the person who ended the call, and
 * the first fix draft missed it entirely by wiring only the teardown.
 *
 * IDEMPOTENT and safe to call from a stale instance: every leaf is keyed on
 * THIS room, so it can never touch a different call's artifacts.
 *
 * ⚠️ The payload is DROPPED, never tombstoned (B-502). The gateway reuses a
 * roomId across re-rings while the room still has participants, and the FCM
 * lanes refuse a tombstoned id — so tombstoning here makes a member who left a
 * live call unreachable on the killed-app lane. Ending MY call is not a verdict
 * on the room's future rings; decline and cancel are, and those lanes still
 * tombstone.
 */
export function clearGroupCallArtifacts(roomId: string): void {
  try {
    const cn = require('../push/callNotification') as typeof import('../push/callNotification');
    void cn.dismissCallNotif(roomId);
  } catch { /* notifee unavailable (tests / headless) */ }
  /**
   * END THE TELECOM CONNECTION. Both group ring lanes raise one —
   * `reportIncomingCall({callId: roomId})` in `fcmBootstrap` (backgrounded) and
   * `fcmHeadless` (killed) — and RNCallKeep's connection service posts its OWN
   * ongoing "Bravo Secure call in progress" card that only `reportEnded`
   * removes. It had ZERO group call sites: the 1:1 registry ends its
   * connection, the group registry never did.
   *
   * ANDROID ONLY, deliberately. A roomId is 16 random bytes hex — NOT a
   * formatted UUID — and on iOS `[[NSUUID alloc] initWithUUIDString:]` returns
   * nil for it, which reaches CXProvider as a nil uuid from a native bridge
   * method. That throws in ObjC, where this JS try/catch cannot reach it.
   * Android's module warns and returns on an unknown uuid, so it is safe there.
   * The ring lanes that raise the connection are themselves Android-only
   * (`showIncomingCallNotif` returns early off Android), so nothing is lost.
   */
  try {
    const {Platform} = require('react-native') as typeof import('react-native');
    if (Platform.OS === 'android') {
      const bridge = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
      bridge.reportEnded(roomId, 'remoteEnded');
    }
  } catch { /* bridge unavailable (tests / headless) */ }
  try {
    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    cache.dropIncomingCallPayload(roomId);
  } catch { /* cache unavailable */ }
  try {
    const fb = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    fb.notifyCallEnded(roomId);
  } catch { /* push layer not booted (cold WS-only path) */ }
}

export async function endActiveGroupCall(roomId?: string): Promise<GroupEndOutcome> {
  if (!active) {
    // Nothing of ours to end, but a previous leave may still be closing — let
    // the caller's `await` mean "the room is quiet" either way.
    if (leaveInFlight) { try { await leaveInFlight; } catch { /* swallow */ } }
    return 'ended';
  }
  if (roomId !== undefined && active.roomId !== roomId) {
    logCallSm('group.end.dropped', {
      why: 'stale-room', room: shortCallId(roomId),
      liveRoom: shortCallId(active.roomId), liveGen: active.gen,
    });
    // Await anyway: a caller that said `await endActiveGroupCall(...)` must not
    // resume while some OTHER leave is still closing transports, or "await the
    // teardown, then navigate" silently becomes "navigate now".
    if (leaveInFlight) { try { await leaveInFlight; } catch { /* swallow */ } }
    return 'refused';
  }
  if (active.ending) {
    // Already tearing down; join that teardown rather than starting a second.
    logCallSm('group.end.already-ending', {room: shortCallId(active.roomId), gen: active.gen});
    if (leaveInFlight) { try { await leaveInFlight; } catch { /* swallow */ } }
    return 'ending';
  }
  const entry = active;
  const leave = entry.leave;
  logCallSm('group.end', {room: shortCallId(entry.roomId), gen: entry.gen, state: entry.state});

  // WI-4.5 — this is the single point every OWNED teardown passes exactly
  // once (all three refusal branches returned above), so the ring artifacts
  // are cleaned here: the notification card + native ringtone, the incoming
  // payload, and the accept latch. The latch clear is load-bearing for
  // WI-4.6: the group navigate sites re-assert autoAccept from it, so
  // leaving it set would auto-join a future re-ring of the same room with
  // zero user action. All three are synchronous leaf calls placed BEFORE the
  // gate construction below — they cannot reorder the WI-1.6 teardown steps.
  //
  // Review round 1 (P1) — the payload is DROPPED, not tombstoned. The
  // gateway reuses a roomId across re-rings while the room has participants
  // (B-334/B-336 Add-member), and the FCM lanes refuse a tombstoned id — so
  // tombstoning here made a member who left a live call silently
  // unreachable on a killed app's only lane for the tombstone TTL. Ending
  // MY call is not a verdict on the room's future rings; decline and cancel
  // are, and those lanes still tombstone.
  clearGroupCallArtifacts(entry.roomId);

  // The teardown body is gated so `leaveInFlight` is published BEFORE anything
  // can observe the `ending` flag. Two re-entries would otherwise find a null
  // handle and return a resolved promise without awaiting — one from `notify()`
  // below, one from `leaveInternal`'s synchronous prefix (it clears the rejoin
  // handler, setState('left') and drops the frame subscription before its first
  // await). Both defeat `acceptIncomingOneToOne`'s "Fix #15: AWAIT
  // endActiveGroupCall before navigating".
  let startTeardown!: () => void;
  const gate = new Promise<void>(resolve => { startTeardown = resolve; });

  const run = (async (): Promise<void> => {
    await gate;
    // WI-1.6 step 3+4 — perform the leave under the existing ≤3 s bound.
    if (leave) {
      // The bound's timer is CLEARED when leave() wins. Left dangling it keeps
      // a 3 s closure alive per end (retaining `entry` and `leave`), and under
      // Jest it fires after teardown and logs into a dead environment — the
      // B-304 "moving flake" shape this repo has already lost a session to.
      let bound: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          leave(),
          new Promise<void>(res => { bound = setTimeout(res, LEAVE_BOUND_MS); }),
        ]);
      } catch { /* swallow — teardown proceeds regardless */ }
      finally { if (bound !== null) {clearTimeout(bound);} }
    }
    // WI-1.6 step 5 — hand off only to a genuinely NEWER call.
    //
    // The test to apply is "did somebody else claim the slot", NOT "is the slot
    // still literally ours". `leave()` IS `useGroupCall`'s `leaveInternal`,
    // whose own Fix #14 tail nulls the registry when it still points at our
    // room — so on the DOMINANT path `active` is already null by the time we
    // resume here. Reading that as "superseded" skipped the audio-session and
    // foreground-service stops below, re-opening both the CALL-N5 mirror
    // ("no call audio", device pinned in MODE_IN_COMMUNICATION) and B-256
    // (a stranded "Bravo Secure call · Hang up" notification) on every end
    // with no screen mounted to clean up after us.
    // Identity is `gen` ALONE. It is globally monotonic, so `gen === entry.gen`
    // already means "this IS our entry" — and comparing roomId as well would
    // read a `renameActiveGroupCallRoom` (which preserves gen and changes the
    // room) as a successor, leaving `ending: true` stuck forever with no way
    // back: launchCall permanently reports the previous call still hanging up,
    // the overlay stays hidden, and the adopt gate refuses.
    const successor = active;
    if (successor && successor.gen !== entry.gen) {
      logCallSm('group.end.slot-taken', {
        room: shortCallId(entry.roomId), gen: entry.gen,
        liveRoom: shortCallId(successor.roomId), liveGen: successor.gen,
      });
      // That call owns the audio session and the FGS now — leave them alone.
      //
      // The started-flag is a DIFFERENT question: ownership is by `gen`, but
      // the flag is keyed by `roomId`. A same-room successor inherited our
      // flag and must keep it (deleting would re-arm it under a live call). A
      // different-room successor did not, so ours would sit in the set forever
      // — and nothing else clears it, since this teardown running is precisely
      // the case where no `GroupCallScreen` cleanup will. A later call landing
      // on that roomId would then get `markGroupAudioSessionStarted` = false,
      // and the audio effect early-returns: no InCallManager.start, no
      // foreground service, no route setup, and no cleanup registered — a
      // silent call with no audio whose capture Android 14 kills on screen-off.
      if (successor.roomId !== entry.roomId) { audioSessionStartedFor.delete(entry.roomId); }
      return;
    }
    audioSessionStartedFor.delete(entry.roomId);
    if (successor) {
      active = null;
      // WI-1.6 step 6 — listeners see the null only now, once the room really
      // is closed. (If `leave()` already nulled it, it already notified.)
      notify();
    }
  // Stop the shared InCallManager session — the mirror of CALL-N5, which
  // landed in endActiveCall on 2026-07-02 and was never carried across to the
  // group stack. GroupCallScreen's audio-effect cleanup is the ONLY other
  // place that stops it, and that cleanup cannot run while the screen is
  // unmounted (call minimized). So ending a MINIMIZED group call from the
  // floating overlay left the device pinned in MODE_IN_COMMUNICATION: routing
  // stuck on the earpiece, media volume inert, and the next call starting on
  // top of a session that was never torn down — reported as "no call audio".
  // Arbitrated so it can't stop a live 1:1 call's session; see
  // callAudioSession.ts.
  try {
    const {stopSharedAudioSession} = require('./callAudioSession') as typeof import('./callAudioSession');
    stopSharedAudioSession('group');
  } catch { /* native module missing on iOS — fine */ }
  // Drop the foreground service. Same reasoning as endActiveCall in
  // callRegistry.ts — the floating overlay's End button is the path
  // that hits us while CallScreen's unmount cleanup is skipping
  // because keepAlive is true.

  try {

    const {stopCallForegroundService} = require('./callForegroundService') as typeof import('./callForegroundService');
    stopCallForegroundService('group');
  } catch { /* native module missing on iOS — fine */ }
  })();

  leaveInFlight = run;
  // WI-1.6 step 1+2 — only NOW mark ending and notify. The slot used to be
  // nulled here, so every busy guard saw "no call" for the whole duration of
  // leave() and admitted a boot that raced sfu.join against closing transports.
  active = {...entry, ending: true};
  notify();
  startTeardown();

  try {
    await run;
  } finally {
    // Only the owner clears the handle — a later end that overlapped must not
    // drop a newer leave's promise.
    if (leaveInFlight === run) {leaveInFlight = null;}
  }
  return 'ended';
}
