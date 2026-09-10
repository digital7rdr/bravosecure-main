/**
 * Active-call registry — singleton that owns a 1:1 call's lifecycle so
 * the call survives CallScreen unmount. The previous design created the
 * RTCPeerConnection + media stream inside the useCall hook, so any
 * navigation away from CallScreen tore the call down. To support
 * Messenger-style minimization we lift those refs here, and have
 * CallScreen + useCall consult the registry on mount: if an active
 * call already exists they REUSE its state instead of starting fresh.
 *
 * The registry keeps no React state — it's a tiny pub/sub. Any view
 * that wants to render minimized-call UI subscribes via
 * `onActiveCallChange` (mirrors the transport-registry pattern used
 * elsewhere in this module).
 */
import {logCallSm, logCallSmQuiet, shortCallId} from './callDiag';
import type {CallController} from '../webrtc/callController';
import type {CallSignalling} from '../webrtc/signallingClient';
import type {CallKind, CallState} from '../webrtc/types';
import type {SessionAddress} from '@bravo/messenger-core';
import type {MediaStream, MediaStreamTrack} from '../webrtc/peerConnectionFactory';

/**
 * WI-1.1 — identity of ONE call session in this registry.
 *
 * `callId` alone is not an identity: minimize→restore, a permission-dialog
 * remount, and a notification-driven re-navigate all produce several hook
 * instances for the SAME callId, and a re-used/replayed callId is
 * indistinguishable from the live one. `gen` is minted per `setActiveCall`
 * from a module-monotonic counter, so a continuation of an older session can
 * be told apart from the session that currently owns the slot.
 */
export interface CallKey {
  callId: string;
  gen:    number;
}

/**
 * How a writer names the call it intends to mutate.
 *
 * A full `CallKey` is REQUIRED wherever the writer can know the generation
 * (anything that adopted or registered the call). A bare `callId` string is
 * the weaker form, accepted only where the generation is genuinely unknowable
 * to the caller — the dispatcher's zombie-end, the FGS notification action, a
 * screen holding nothing but a route param. It still has to match the live
 * call's id, so it can never mutate a DIFFERENT call; it just cannot tell two
 * generations of the same id apart.
 */
export type CallRef = CallKey | string;

/**
 * What `endActiveCall` did.
 *
 *  • `'ended'`   — this call was torn down by THIS call to endActiveCall.
 *  • `'ending'`  — this exact call is already being torn down by an outer frame
 *                  (the re-entry from `useCall.onState`). The teardown is
 *                  covered; a caller with its own fallback must NOT run it.
 *  • `'refused'` — the registry does not own this call. A caller with its own
 *                  fallback teardown SHOULD run it.
 *
 * The `'ending'` case is the one that matters: `'refused'` alone would conflate
 * "somebody else's call" with "my own teardown, already in flight".
 */
export type EndCallOutcome = 'ended' | 'ending' | 'refused';

export interface ActiveCallState {
  callId:           string;
  /** WI-1.1 — minted by `setActiveCall`; see `CallKey`. Never patchable. */
  gen:              number;
  conversationId:   string;
  peer:             SessionAddress;
  peerName:         string;
  kind:             CallKind;
  direction:        'incoming' | 'outgoing';
  /** Set after the user accepts/dials and the controller is built. */
  controller:       CallController | null;
  signalling:       CallSignalling | null;
  unregister:       (() => void) | null;
  localStream:      MediaStream | null;
  remoteStream:     MediaStream | null;
  audioTrack:       MediaStreamTrack | null;
  videoTrack:       MediaStreamTrack | null;
  state:            CallState;
  isMinimized:      boolean;
  /**
   * Audit CALL-N11 (2026-07-02): local + remote media toggle state, persisted
   * so a minimize→restore rehydrates them instead of resetting to defaults.
   * Without these: a locally-muted mic rendered as unmuted after restore
   * (peer hears nothing, user sees nothing wrong); the peer's camera-off
   * placeholder was replaced by a frozen RTCView; and restoring with the
   * local camera off drove toggleVideo down the full SDP-upgrade path, adding
   * a DUPLICATE video m-line. `facing` keeps PiP mirroring / next-flip
   * direction correct after restoring a rear-camera call.
   */
  isMuted?:         boolean;
  isVideoOff?:      boolean;
  remoteVideoOff?:  boolean;
  remoteMuted?:     boolean;
  facing?:          'user' | 'environment';
  /**
   * When true, CallScreen unmount should NOT tear down the controller
   * or local media — the user is just navigating away while the call
   * continues. Cleared by the floating overlay's hangup or by a
   * controller state transition to 'ended' / 'failed'.
   */
  keepAlive:        boolean;
  /**
   * Wall-clock when the controller transitioned to 'connected'. Used
   * by CallScreen's duration timer so minimizing the call (which
   * unmounts CallScreen) doesn't reset the elapsed counter to 0 on
   * restore — it just re-derives elapsed = Date.now() - connectedAtMs.
   */
  connectedAtMs:    number | null;
}

let active: ActiveCallState | null = null;
let listeners: Array<(state: ActiveCallState | null) => void> = [];
/** WI-1.1 — monotonic generation source. Never reset; wrap is not reachable. */
let genCounter = 0;
/**
 * WI-1.2 — re-entrancy guard for `endActiveCall`. `controller.hangup()` calls
 * back into `useCall.onState` SYNCHRONOUSLY, which ends the call again; without
 * this the whole teardown (unregister / audio stop / CallKit report / notif
 * dismiss / FGS stop / listener notify) ran twice. Purely synchronous, so it is
 * not the banned "boolean in-flight latch" (nothing can be lost while it holds).
 */
let endInProgress = false;
/** Which call the in-flight teardown belongs to — see `EndCallOutcome`. */
let endingKey: CallKey | null = null;

function refCallId(ref: CallRef): string {
  return typeof ref === 'string' ? ref : ref.callId;
}
function refGen(ref: CallRef): number | null {
  return typeof ref === 'string' ? null : ref.gen;
}
function refMatches(ref: CallRef, cur: ActiveCallState): boolean {
  if (typeof ref === 'string') {return ref === cur.callId;}
  return ref.callId === cur.callId && ref.gen === cur.gen;
}

/**
 * The one gate every keyed write goes through. Returns the live entry when the
 * ref owns it, else null after recording WHY — a dropped write is exactly the
 * event you need in the log when reading a teardown race backwards.
 */
function claimActive(ref: CallRef | null, op: string): ActiveCallState | null {
  const cur = active;
  // A dropped PATCH with no key / no active call is expected on every call
  // (writes that land before `setActiveCall` mints the key; writes after the
  // slot is gone), so it goes to the dev-only channel. A dropped END never is:
  // "End landed nowhere" is exactly the evidence you grep a release logcat for.
  // And `stale-key` is an anomaly for any op.
  const drop = op === 'end' ? logCallSm : logCallSmQuiet;
  if (!ref) {
    drop(`registry.${op}.dropped`, {why: 'no-key', liveCid: shortCallId(cur?.callId), liveGen: cur?.gen ?? null});
    return null;
  }
  if (!cur) {
    drop(`registry.${op}.dropped`, {why: 'no-active', cid: shortCallId(refCallId(ref)), gen: refGen(ref)});
    return null;
  }
  if (!refMatches(ref, cur)) {
    logCallSm(`registry.${op}.dropped`, {
      why:     'stale-key',
      cid:     shortCallId(refCallId(ref)),
      gen:     refGen(ref),
      liveCid: shortCallId(cur.callId),
      liveGen: cur.gen,
    });
    return null;
  }
  return cur;
}

function notify(): void {
  // Fix #15: snapshot before iterating. A listener can mutate the
  // `listeners` array via its returned-disposer (e.g. an overlay
  // unsubscribing itself on call.end). Iterating the live array
  // would skip subsequent entries when an earlier listener splices.
  const snapshot = [...listeners];
  for (const l of snapshot) {
    try { l(active); } catch { /* one listener's failure must not block the others */ }
  }
}

export function getActiveCall(): ActiveCallState | null {
  return active;
}

/**
 * Audit CALL-N15 (2026-07-02): callIds whose slot was cleared recently. The
 * overlay's restore navigates with the OLD callId; if the call ends between
 * the overlay's getActiveCall() check and useCall's boot effect, the boot
 * finds no call to adopt and would fall through to a FRESH startOutgoing —
 * silently re-dialing the peer. A fresh dial always mints a NEW callId, so
 * "this callId ended moments ago" is a reliable ghost-redial marker.
 */
const recentlyEnded = new Map<string, number>();
import {RECENTLY_ENDED_WINDOW_MS} from '../webrtc/callDeadlines';

export function wasRecentlyEnded(callId: string): boolean {
  const at = recentlyEnded.get(callId);
  if (at === undefined) {return false;}
  if (Date.now() - at > RECENTLY_ENDED_WINDOW_MS) { recentlyEnded.delete(callId); return false; }
  return true;
}

/**
 * Record a death this registry did NOT perform.
 *
 * For the one path that legitimately kills a call without owning the slot:
 * `useCall`'s adopt-mirror, when the registry has moved on to a different call
 * and ours is hung up through its own controller. Without it that call — the
 * one the code has just flagged as an anomaly, and therefore the one most
 * likely to leave a full-screen ring behind — gives CALL-N15's ghost-redial
 * guard and FIX-14's stale-ring sweep no signal at all.
 */
export function noteCallEnded(callId: string, why: string): void {
  logCallSm('registry.noted-end', {cid: shortCallId(callId), why});
  markRecentlyEnded(callId);
}

/** CALL-N15 — mark a callId dead for the ghost-redial window. */
function markRecentlyEnded(callId: string): void {
  const now = Date.now();
  for (const [id, at] of recentlyEnded) { if (now - at > RECENTLY_ENDED_WINDOW_MS) {recentlyEnded.delete(id);} }
  recentlyEnded.set(callId, now);
}

/**
 * What a caller hands `setActiveCall`. `gen` is minted here, never supplied —
 * accepting one would let a writer forge an identity.
 */
export type ActiveCallSeed = Omit<ActiveCallState, 'gen'>;

/**
 * Replace the active-call slot. Pass `null` to clear (call ended). The
 * caller is responsible for tearing down any controller / streams BEFORE
 * clearing if they want clean shutdown — the registry only holds refs.
 *
 * WI-1.1 — returns the freshly-minted `CallKey`. The booting hook MUST keep it:
 * it is the only thing that lets that instance's callbacks prove, later, that
 * the slot is still theirs. Adoption does NOT come through here (an adopted
 * instance inherits the existing gen — adoption is a continuation, not a new
 * call), which is exactly why the counter can be bumped unconditionally.
 */
export function setActiveCall(next: ActiveCallSeed | null): CallKey | null {
  // CALL-N15 — record the outgoing slot's callId on clear/replace so a
  // stale restore navigation can't ghost-redial it. Prune opportunistically.
  if (active && active.callId !== next?.callId) {
    markRecentlyEnded(active.callId);
  }
  if (!next) {
    // Only report a clear that actually cleared something — `setActiveCall(null)`
    // is used as an idempotent reset and logging every no-op would drown the lane.
    if (active) {logCallSm('registry.cleared', {cid: shortCallId(active.callId), gen: active.gen});}
    active = null;
    notify();
    return null;
  }
  const gen = ++genCounter;
  active = {...next, gen};
  logCallSm('registry.set', {
    cid: shortCallId(next.callId), gen, dir: next.direction, kind: next.kind, state: next.state,
  });
  notify();
  return {callId: next.callId, gen};
}

/**
 * Mutate the live call — ONLY when `ref` still owns the slot.
 *
 * `callId` and `gen` are excluded from the patch type: identity is minted by
 * `setActiveCall` and a write that could rewrite it would defeat the point.
 * Returns whether the write landed, so a caller with a fallback can branch.
 */
export function patchActiveCall(
  ref: CallRef | null,
  patch: Partial<Omit<ActiveCallState, 'callId' | 'gen'>>,
): boolean {
  const cur = claimActive(ref, 'patch');
  if (!cur) {return false;}
  // Identity is re-pinned AFTER the spread, not just excluded from the patch
  // type: almost every writer in this module reaches the registry through an
  // untyped lazy `require()`, so the type alone is not the guard it looks like.
  active = {...cur, ...patch, callId: cur.callId, gen: cur.gen};
  notify();
  return true;
}

export function setMinimized(ref: CallRef | null, min: boolean): boolean {
  const cur = claimActive(ref, 'minimize');
  if (!cur) {return false;}
  active = {...cur, isMinimized: min, keepAlive: min};
  notify();
  return true;
}

export function onActiveCallChange(cb: (state: ActiveCallState | null) => void): () => void {
  listeners.push(cb);
  // Fire once so subscribers get current state on register — same
  // contract as transportRegistry.
  try { cb(active); } catch { /* ignore */ }
  return () => { listeners = listeners.filter(l => l !== cb); };
}

/**
 * Hard-end the call: hang up via controller, stop local tracks, clear
 * the slot. Safe to call multiple times. Used by the floating overlay's
 * end button and by the controller's 'ended' / 'failed' state.
 */
/**
 * Call-id-keyed flag for "this call's audio session has been started
 * via InCallManager.start()". Survives across CallScreen remounts (the
 * permission-prompt remount in particular: when the OS pops a mic/cam
 * permission dialog, RN reports a quick activity-pause-resume cycle
 * which re-mounts the screen). A useRef-based guard inside the screen
 * resets to `false` on each fresh mount, so the second mount calls
 * InCallManager.start() AGAIN — but it had already been stopped by
 * the first mount's cleanup, so the session ends up dead. This module-
 * scoped record outlives the screen's lifecycle and lets us answer
 * "have we already started for THIS callId?" correctly.
 */
const audioSessionStartedFor = new Set<string>();

export function markAudioSessionStarted(callId: string): boolean {
  if (audioSessionStartedFor.has(callId)) {return false;}
  audioSessionStartedFor.add(callId);
  return true;
}

export function clearAudioSessionStarted(callId: string): void {
  audioSessionStartedFor.delete(callId);
}

/**
 * Source of the end. 'local' means the user pressed End (this device
 * or via floating-overlay button), 'remote' means peer/server ended,
 * 'failed' means ICE/DTLS gave up. Used to map to CallKit/Telecom's
 * end-reason taxonomy so iOS Recents shows the right glyph (locally
 * declined vs. remote ended).
 *
 * WI-1.1 / WI-1.2 — `reason` and `source` are REQUIRED, deliberately. They used
 * to default, and with `ref` now leading the argument list an un-migrated
 * `endActiveCall('ended')` would have silently type-checked as "end the call
 * whose id is the literal 'ended'" — a no-op that reads as wired. Making both
 * mandatory turns every missed call site into a compile error instead.
 *
 * Returns an `EndCallOutcome` so a caller with its own fallback teardown can
 * tell "I handled it" and "it is already being handled" from "the slot was not
 * mine". Only the last of the three means the fallback should run.
 */
export function endActiveCall(
  ref: CallRef,
  reason: 'ended' | 'failed',
  source: 'local' | 'remote',
  // Phase 6 round 3 — `silentWire` is an EXPLICIT opt-in, deliberately not
  // keyed on `source`: `source` is glyph-coupled (the reason×source →
  // CallKit endedReason map below), and three semantically-LOCAL live-call
  // ends (Telecom/system-UI End, logout) label themselves 'remote' purely
  // for the 'remoteEnded' glyph while RELYING on the wire hangup. Only a
  // caller acting on a verdict the FAR SIDE already issued (the
  // answered-elsewhere collapse, a call.sync ended/unknown) may set this.
  opts?: {silentWire?: boolean},
): EndCallOutcome {
  // WI-1.2 — checked BEFORE the slot lookup, and that ordering is the point.
  // The slot is dropped before `controller.hangup()` runs, so by the time the
  // synchronous `useCall.onState` terminal re-enters here it is already null:
  // `claimActive` alone cannot tell "I am inside my own teardown" from
  // "somebody else owns the slot". Without the distinction, that caller ran its
  // fallback CallKit/cache/notif teardown on EVERY end — a second `reportEnded`
  // with the wrong end-reason, which is first-write-wins at the bridge.
  if (endInProgress) {
    // Generation-aware: a weak (id-only) ref matches on id alone because it has
    // no generation to offer, but a full key must match BOTH. Otherwise a stale
    // generation of the same callId would be told "covered" and skip its own
    // fallback teardown.
    const g = refGen(ref);
    const sameCall = endingKey !== null
      && refCallId(ref) === endingKey.callId
      && (g === null || g === endingKey.gen);
    // Distinct event names: this branch sits ABOVE `claimActive`, so without
    // them a genuine stale-key end that happens to land mid-teardown would be
    // logged as a re-entry and a grep for `stale-key` would miss it.
    if (sameCall) {
      logCallSm('registry.end.reentered', {cid: shortCallId(refCallId(ref)), gen: g, reason, source});
      return 'ending';
    }
    logCallSm('registry.end.dropped', {
      why: 'stale-key', during: 'end',
      cid: shortCallId(refCallId(ref)), gen: g,
      liveCid: shortCallId(endingKey?.callId), liveGen: endingKey?.gen ?? null,
    });
    return 'refused';
  }
  const cur = claimActive(ref, 'end');
  if (!cur) {return 'refused';}
  endInProgress = true;
  endingKey     = {callId: cur.callId, gen: cur.gen};
  try {
    endActiveCallInner(cur, reason, source, opts);
    return 'ended';
  } finally {
    endInProgress = false;
    endingKey     = null;
  }
}

function endActiveCallInner(
  current: ActiveCallState,
  reason: 'ended' | 'failed',
  source: 'local' | 'remote',
  opts?: {silentWire?: boolean},
): void {
  const endedCallId = current.callId;
  logCallSm('registry.end', {
    cid: shortCallId(endedCallId), gen: current.gen, reason, source, state: current.state,
  });
  // WI-1.2(b) — CALL-N15 / FIX-14 record the death HERE. `setActiveCall` was
  // the only recorder, so the DOMINANT end path (this one, which nulls the
  // slot) never marked anything: the ghost-redial guard and the stale-ring
  // sweep both had no signal for a call that ended normally.
  markRecentlyEnded(endedCallId);
  // WI-1.2(a) — drop the slot BEFORE `controller.hangup()`. hangup fires
  // `useCall.onState('ended')` synchronously, which calls straight back into
  // endActiveCall; with the slot already empty that re-entry is refused, so
  // everything below runs exactly once.
  active = null;
  // Round 7 / WebRTC audit fix W7 — stop the local mic and camera
  // BEFORE calling controller.hangup. Previously the order was reversed,
  // so when a user pressed End there was a 50-200ms window where
  // hangup() was sending the call.hangup frame + tearing down the peer
  // connection while the mic and camera were still actively capturing.
  // On Android the camera LED was visibly on past the End tap. Stopping
  // tracks first releases the device immediately, well before the WS
  // round-trip for hangup completes.
  try { current.audioTrack?.stop(); } catch { /* ignore */ }
  try { current.videoTrack?.stop(); } catch { /* ignore */ }
  // Phase 6 rounds 2+3 (critic advisory / edge R1, re-keyed by critic round
  // 3) — a caller acting on a verdict the far side ALREADY ISSUED must not
  // send call.hangup: under the shared deviceId a still-live sibling
  // transport would relay an AUTHORIZED hangup into the winner's ACTIVE
  // session. The key is the EXPLICIT `silentWire` opt-in, NOT `source`:
  // 'remote' is glyph-coupled and three semantically-local live-call ends
  // (Telecom/system-UI End, logout) carry it while relying on the wire
  // hangup — keying on source silently killed the peer's "Call ended" for
  // all three (round-3 catch). Feature-detected so registry doubles that
  // only model hangup keep their pins.
  try {
    const ctl = current.controller as unknown as {
      endSilently?: (r: 'ended' | 'failed') => void;
      hangup?: (r: 'ended' | 'failed') => void;
    } | undefined | null;
    if (opts?.silentWire && typeof ctl?.endSilently === 'function') {
      ctl.endSilently(reason);
    } else {
      ctl?.hangup?.(reason);
    }
  } catch { /* ignore */ }
  try { current.unregister?.(); } catch { /* ignore */ }
  // Audit CALL-N5 (2026-07-02): stop the InCallManager audio session here.
  // CallScreen's audio-effect cleanup is the ONLY other place that stops it,
  // and that cleanup can't run while the screen is unmounted (call minimized).
  // So ending a minimized call from the floating overlay — or the peer
  // hanging up while minimized — used to leave the device pinned in
  // MODE_IN_COMMUNICATION (voice routing + proximity behaviour) indefinitely.
  // Idempotent; safe even when CallScreen already stopped it.
  //
  // Arbitrated since 2026-07-25: this used to stop unconditionally, so a stale
  // 1:1 teardown (a missed call cleaning up, a late call.hangup frame) killed
  // the shared session out from under a LIVE group call — joined the Ops Room,
  // tiles rendered, nobody audible. See callAudioSession.ts.
  const {stopSharedAudioSession} = require('./callAudioSession') as typeof import('./callAudioSession');
  stopSharedAudioSession('direct');
  audioSessionStartedFor.delete(endedCallId);
  // The slot was already dropped above (WI-1.2a); this is the single null
  // transition listeners see, in the same position it has always been.
  notify();
  // Drop CallKit/Telecom system UI + the cached incoming-call payload
  // so the system call sheet doesn't linger after a floating-overlay
  // End tap (the path that runs while keepAlive=true and CallScreen's
  // own onState=ended cleanup has already been skipped).
  try {

    const {reportEnded} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');

    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    // Map (reason × source) → CallKit endedReason. iOS Recents glyph
    // and Android call-log row depend on this being right:
    //   - reason='failed'                → 'failed'
    //   - source='local'                 → 'declined' (local hangup)
    //   - source='remote'                → 'remoteEnded'
    const endedReason: 'failed' | 'declined' | 'remoteEnded' =
      reason === 'failed' ? 'failed'
        : source === 'local' ? 'declined'
        : 'remoteEnded';
    reportEnded(endedCallId, endedReason);
    cache.clearIncomingCallPayload(endedCallId);
    // notifee is a separate surface from CallKit/Telecom — reportEnded
    // does NOT clear it. An FCM-woken call ended via the overlay would
    // otherwise leave the looping full-screen notifee ring up until TTL.
    try {
      const cn = require('../push/callNotification') as typeof import('../push/callNotification');
      void cn.dismissCallNotif(endedCallId);
    } catch { /* notifee unavailable (tests / iOS) */ }
  } catch { /* bridge inactive */ }
  // Stop the foreground service whenever the call's hard-ended (via
  // the floating overlay's end button, controller failure, or an
  // explicit hangup). CallScreen's unmount cleanup also calls stop()
  // but it skips when keepAlive is true — and the overlay's End is
  // exactly the path that runs while keepAlive is true. Without this
  // call, the FG notification would linger after the user ends a
  // minimized call.

  //
  // WI-1.2 — but only if the slot is still EMPTY. A listener notified above can
  // start a new call synchronously, and everything else after `notify()` is
  // keyed by the OLD callId and therefore harmless — this one is keyed by OWNER
  // ('direct'), so it would pull the service out from under the call that just
  // took the slot. That call's own end path will stop it later.
  // Read through the accessor: `active` was assigned null above, so TS narrows
  // it to `never` here — but a listener notified in between can genuinely have
  // repopulated it, which is the whole case this branch exists for.
  const slotNow = getActiveCall();
  if (slotNow) {
    logCallSm('registry.end.fgs-skipped', {
      cid: shortCallId(endedCallId), liveCid: shortCallId(slotNow.callId), liveGen: slotNow.gen,
    });
    return;
  }
  try {

    const {stopCallForegroundService} = require('./callForegroundService') as typeof import('./callForegroundService');
    stopCallForegroundService('direct');
  } catch { /* native module missing on iOS — fine */ }
}
