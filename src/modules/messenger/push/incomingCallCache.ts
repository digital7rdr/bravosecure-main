/**
 * In-memory cache of inbound calls that have been reported to the
 * system call UI (CallKit on iOS, Telecom on Android) but not yet
 * answered or hung up.
 *
 * Why this exists:
 *   When the user taps Accept / End from the system UI (lock-screen
 *   call screen, Telecom incoming-call sheet), the bridge fires an
 *   event that only carries the `callUUID`. Bravo's accept / decline
 *   flows need the full payload — caller name, callKind, conversation
 *   id, optional SDP — to navigate to the right screen and send the
 *   right `call.hangup` / `call.answer` frame to the peer.
 *
 *   Notifee-driven Accept/Decline taps already have the payload (it
 *   lives in the notification's `data` block). For Telecom-driven
 *   events we need a separate cache, populated by the same handler
 *   that displays the system UI and consumed by the event handlers.
 *
 * Lifetime:
 *   Entry added when reportIncomingCall fires (FCM bg handler or
 *   in-app `setIncomingCallHandler` in MainNavigator).
 *   Entry removed when:
 *     - User accepts: handler navigates → CallScreen, then clears.
 *     - User declines: handler sends call.hangup → clears.
 *     - Peer hangs up first: callDispatcher routes the inbound
 *       call.hangup → bridge clears via clearByCallId.
 *     - 60s TTL elapses (defensive — guards against orphaned entries
 *       if a path forgets to clear; a real ring is < 30s anyway).
 */

export interface CachedIncomingCall {
  callId:         string;
  callerName:     string;
  /** 'voice' | 'video' | 'group-voice' | 'group-video' */
  kind:           string;
  fromUserId?:    string;
  remoteDeviceId?: number;
  /** For 1:1 with WS-delivered offer; absent on FCM-only paths. */
  incomingSdp?:   string;
  /** For group calls. */
  roomId?:        string;
  /** P1-BR-1 — per-recipient SFU room token echoed to sfu.join on group accept. */
  roomToken?:     string;
  /** B-336 fan-out id. Round 2 R2-2 — the tombstone identity for GROUP rings:
   *  roomIds are reused across fan-outs, so a per-callId tombstone must not
   *  outlive the one fan-out it consumed. */
  ringId?:        string;
  conversationId?: string;
  cachedAtMs:     number;
}

// WI-4.8 — both lifetimes live in callDeadlines (Tier A, no imports) with
// their ordering asserted: PAYLOAD > RING_TIMEOUT + NAV_READY_WAIT (a
// last-second answer on a cold navigator still hydrates), TOMBSTONE > PAYLOAD
// (a delayed rewake can't slip between "consumed" and "expired").
import {INCOMING_PAYLOAD_TTL_MS, INCOMING_TOMBSTONE_TTL_MS} from '../webrtc/callDeadlines';

/**
 * Once a callId has been consumed (accepted / declined / peer-hung-up)
 * we record it in a tombstone set so a buggy/duplicate-retrying caller
 * resending the SAME callId can't repopulate the slot with stale SDP.
 * Without this a user who declined call X and then a millisecond later
 * received another wake for callId=X (caller's retry) would see the
 * stale incoming-offer payload from the first attempt — and CallScreen
 * would try to apply outdated remote SDP on accept.
 */
const cache = new Map<string, CachedIncomingCall>();
const tombstones = new Map<string, {at: number; ringId?: string}>();
// R2-1 — rooms whose ring THIS DEVICE consumed by ENDING its own group call.
// A stale queued notifee event for that room must not re-join it, but a fresh
// fan-out must never be blocked — so any successful seed SELF-HEALS the
// marker. Same lifetime as a tombstone.
const consumedGroupRooms = new Map<string, number>();

// Why: WI-4.8 — `onEnd`'s branch order relies on "an in-app-answered call
// keeps its cached payload for the whole call"; a wall-clock TTL cannot honour
// that, so the LIVE call's entry is exempt from expiry. Lazy require: in a
// headless VM the registries are empty modules and the probe just returns
// false, which is the correct answer there.
function isLiveCall(callId: string): boolean {
  try {
    const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
    if (reg.getActiveCall()?.callId === callId) {return true;}
  } catch { /* registry unavailable — no exemption */ }
  try {
    const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
    if (groupReg.getActiveGroupCall()?.roomId === callId) {return true;}
  } catch { /* registry unavailable — no exemption */ }
  return false;
}

function gc(now: number): void {
  for (const [id, entry] of cache) {
    if (now - entry.cachedAtMs > INCOMING_PAYLOAD_TTL_MS && !isLiveCall(id)) {cache.delete(id);}
  }
  for (const [id, t] of tombstones) {
    if (now - t.at > INCOMING_TOMBSTONE_TTL_MS) {tombstones.delete(id);}
  }
  for (const [id, t] of consumedGroupRooms) {
    if (now - t > INCOMING_TOMBSTONE_TTL_MS) {consumedGroupRooms.delete(id);}
  }
}

// Why: NA-01 — the WS `call.offer` and the FCM voip-wake both seed the same
// callId while the app is backgrounded, and the wake carries no SDP / device
// id / conversationId. A plain replace erased what the offer had already
// delivered, so the answer tap hydrated an empty payload and stalled.
function mergeIncoming(
  prev: CachedIncomingCall,
  next: Omit<CachedIncomingCall, 'cachedAtMs'>,
  now: number,
): CachedIncomingCall {
  // The offer frame is the only writer that carries SDP; when the incoming
  // payload has none it is the (unsigned, display-only) push wake, so its
  // label/kind must not overwrite the authoritative ones.
  const pushOverOffer = !!prev.incomingSdp && !next.incomingSdp;
  return {
    callId:         next.callId,
    callerName:     pushOverOffer ? prev.callerName : (next.callerName || prev.callerName),
    kind:           pushOverOffer ? prev.kind       : (next.kind       || prev.kind),
    fromUserId:     next.fromUserId     ?? prev.fromUserId,
    remoteDeviceId: next.remoteDeviceId ?? prev.remoteDeviceId,
    incomingSdp:    next.incomingSdp    ?? prev.incomingSdp,
    roomId:         next.roomId         ?? prev.roomId,
    roomToken:      next.roomToken      ?? prev.roomToken,
    ringId:         next.ringId         ?? prev.ringId,
    conversationId: next.conversationId ?? prev.conversationId,
    cachedAtMs:     now,
  };
}

export function setIncomingCallPayload(p: Omit<CachedIncomingCall, 'cachedAtMs'>): boolean {
  const now = Date.now();
  gc(now);
  // Refuse to repopulate a tombstoned slot. Caller should regenerate
  // callId on retry. Returning false lets the FCM bg handler log the
  // collision and skip the re-display path.
  //
  // R2-2 — EXCEPT a group re-ring: the gateway reuses the roomId as the
  // callId across fan-outs, so the tombstone remembers WHICH fan-out it
  // consumed (the B-336 ringId). A seed carrying a DIFFERENT ringId is a new
  // fan-out — a genuine re-ring after a decline/cancel — and it supersedes
  // the consumed one entirely (the tombstone is deleted so the card this
  // seed draws survives the stale-card gate). A seed with the SAME ringId,
  // or none at all (1:1, pre-B-336 relay), stays refused: fail closed.
  const tomb = tombstones.get(p.callId);
  if (tomb) {
    // Round 3 (F1) — a GROUP seed CARRYING a ringId proves a B-336-capable
    // relay. On such an id, a tombstone WITHOUT a captured ringId can only be
    // a WS/foreground consumption (those lanes never seed the cache, so the
    // clear had no entry to read the identity from) — the seed is therefore a
    // different fan-out by construction and supersedes. The one case this
    // loosens — a duplicate wake of the SAME fan-out after a foreground
    // decline — re-rings once, bounded by the 45 s card timeout and the
    // per-callId notifee dedup.
    //
    // F1-R4 — the kind gate makes "a 1:1 tombstone is never superseded" a
    // property of THIS GUARD, not of the server's habit of omitting ringId on
    // the 1:1 lane: ringId rides unsigned, every 1:1 tombstone lacks one, and
    // without the gate a smuggled ringId would delete a 1:1 tombstone and
    // disarm its consumers (the WI-4.7 accept gate, the dead-offer watchdog,
    // the offer-replay guard).
    const isGroupSeed = p.kind === 'group-voice' || p.kind === 'group-video';
    const newFanOut = isGroupSeed && p.ringId !== undefined && p.ringId !== tomb.ringId;
    if (!newFanOut) {
      console.warn(`[incomingCallCache] reject set for tombstoned callId=${p.callId.slice(0, 8)}`);
      return false;
    }
    console.warn(`[incomingCallCache] new fan-out supersedes consumed ring callId=${p.callId.slice(0, 8)}`);
    tombstones.delete(p.callId);
  }
  // R2-1 — any successful seed proves a live fan-out; the consumed-room
  // marker from an earlier END must not outlive it.
  consumedGroupRooms.delete(p.callId);
  const prev = cache.get(p.callId);
  cache.set(p.callId, prev ? mergeIncoming(prev, p, now) : {...p, cachedAtMs: now});
  return true;
}

export function getIncomingCallPayload(callId: string): CachedIncomingCall | null {
  gc(Date.now());
  return cache.get(callId) ?? null;
}

/**
 * Review round 1 (P1) — drop WITHOUT tombstoning. Group teardowns need this:
 * the gateway REUSES a roomId across re-rings while the room has participants
 * (B-334/B-336 Add-member re-invite), and the FCM lanes refuse to present a
 * tombstoned id — so tombstoning at group END made a member who left a live
 * call unreachable on the only lane a killed app has, for the whole tombstone
 * TTL. Ending a call is not a verdict about FUTURE rings of that room;
 * decline/cancel ARE, and they keep using `clearIncomingCallPayload`.
 */
export function dropIncomingCallPayload(callId: string): void {
  cache.delete(callId);
  // R2-1 — mark the room so a STALE queued card event cannot re-join the call
  // this device just left. Any fresh seed (a new fan-out arriving on the FCM
  // lanes) deletes the marker.
  //
  // B-595 — reached from THREE callers now, all through
  // `clearGroupCallArtifacts`: the registry teardown, `leaveInternal`'s tail
  // (the host-ended / kicked lanes, which never touch the registry) and the
  // ring funnel. It was one when this comment was written.
  consumedGroupRooms.set(callId, Date.now());
}

/** R2-1 — read by the notifee stale-card gate; see dropIncomingCallPayload. */
export function isGroupRingConsumed(callId: string): boolean {
  gc(Date.now());
  return consumedGroupRooms.has(callId);
}

export function clearIncomingCallPayload(callId: string): void {
  // R2-2 — remember WHICH fan-out this tombstone consumed, so a later seed
  // for a genuinely new fan-out of the same (reused, group) id can supersede
  // it. Read before delete; absent for 1:1 and pre-B-336 relays.
  const ringId = cache.get(callId)?.ringId;
  cache.delete(callId);
  // Even when the entry was already gone, tombstone — covers the "peer hung
  // up before we saw the offer" race.
  tombstones.set(callId, {at: Date.now(), ringId});
}

/**
 * NA-02 — "this callId is terminal". Every cancel lane (WS `call.hangup`,
 * FCM `call-cancel`, Telecom end, decline, natural call end) routes through
 * `clearIncomingCallPayload`, which tombstones. A ring screen whose offer SDP
 * never arrived has no controller and no `callRegistry` entry, so this
 * tombstone is the only cross-lane "the call is dead" signal it can read.
 * Never set on accept — an in-app-answered call keeps its cached payload for
 * the whole call.
 */
export function isIncomingCallDead(callId: string): boolean {
  gc(Date.now());
  return tombstones.has(callId);
}

/** Test-only — drop everything. */
export function _resetIncomingCallCacheForTests(): void {
  consumedGroupRooms.clear();
  cache.clear();
  tombstones.clear();
}
