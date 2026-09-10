import type {SessionAddress, CallOfferAuth} from '@bravo/messenger-core';
import type {CallSignalling} from './signallingClient';
import {PeerConnectionWrapper, type IceServerConfig} from './peerConnection';
import {CallRingState, DEFAULT_RING_TIMEOUT_MS, type RingExpireEvent} from './callRingState';
// WI-2.3 — the two watchdog constants below are RE-EXPORTED from here (their
// long-standing public names, read by `answerDeliveryStall.test.ts`); these two
// are private statics, so they are aliased on import instead.
import {
  RECONNECT_BUDGET_MS as DEADLINE_RECONNECT_BUDGET_MS,
  RESTART_RETRY_MS    as DEADLINE_RESTART_RETRY_MS,
  CONNECTING_WATCHDOG_MS,
  ANSWER_DELIVERY_WATCHDOG_MS,
} from './callDeadlines';
import type {CallDescriptor, CallKind, CallState, HangupReason, IceCandidateInit, PeerConnectionFactory} from './types';
import {logCallTransition, logCallLat, endCallLatLane, type CallDiagField, type CallLatLane} from '../runtime/callDiag';

/**
 * Orchestrates a single 1:1 call from start to finish.
 *
 *   caller:   startOutgoing() → state: 'calling' → on answer → 'connecting' → iceConnected → verifyDtlsSrtp → 'connected'
 *   callee:   handleIncomingOffer(offer) → state: 'ringing' → accept() → 'connecting' → (same as above)
 *
 * The controller does NOT create local/remote media tracks — that's
 * native-module territory. Host app (RN CallScreen) passes streams in
 * via `addLocalTrack` and subscribes to `ontrack` for remote media.
 */
export interface CallControllerOptions {
  signalling: CallSignalling;
  pcFactory:  PeerConnectionFactory;
  iceServers: IceServerConfig[];
  /** Called on every state transition so the UI can re-render. */
  onState:    (state: CallState) => void;
  /** Optional — called after DTLS-SRTP is verified, carries the cipher name. */
  onSecured?: (info: {dtlsState: string; srtpCipher: string}) => void;
  /**
   * Optional hook fired AFTER the underlying RTCPeerConnection is built
   * AND, for incoming calls, after the remote offer has been applied.
   * Hosts plug local-track wiring here (addTrack + ontrack) so we can
   * follow the spec-correct order:
   *   - caller:   buildPc → attachLocalMedia → createOffer
   *   - answerer: buildPc → setRemoteOffer → attachLocalMedia → createAnswer
   * Without this hook, hosts had to wrap the pcFactory and inject
   * addTrack before either side-description was set, which sometimes
   * produced duplicate/mis-ordered transceivers on the answerer side.
   *
   * MUST return a Promise the controller awaits — `replaceTrack` (the
   * spec-correct way to attach to existing transceivers) is async,
   * and if we don't wait, createOffer/createAnswer can fire before
   * the senders are fully bound and produce SDP missing our outgoing
   * media (recvonly answer).
   */
  attachLocalMedia?: (pc: import('./types').PeerConnectionLike) => Promise<void> | void;

  /**
   * Mid-call renegotiation hook — fired when a peer-initiated
   * `call.reoffer` arrives AFTER setRemoteDescription has applied the
   * new offer but BEFORE we createAnswer. Host can opt-in to acquire
   * its own video and addTrack here so the answer SDP carries an
   * outgoing video m-line too (two-way video). If omitted, or if the
   * host throws, the call still completes the renegotiation but with
   * one-way video (peer sends video, we receive only).
   *
   * Order matters for the same reason as `attachLocalMedia` on initial
   * accept: createAnswer MUST run after every sender is bound or the
   * answer comes out recvonly and our outgoing media never reaches
   * the peer.
   */
  onRemoteRenegotiation?: (pc: import('./types').PeerConnectionLike) => Promise<void> | void;

  /**
   * Audit S7 — produce the caller-identity auth block bound to this
   * outgoing offer. Called by `startOutgoing` AFTER createOffer succeeds
   * but BEFORE the offer is shipped, so the same callId / from / to /
   * kind on the wire is hashed into the signed AAD.
   *
   * Optional: if omitted the offer ships without an auth block (legacy
   * fallback). Production callers MUST provide this; the no-op fallback
   * exists only to keep older test fixtures + the loopback runtime
   * compiling.
   */
  buildOfferAuth?: (params: {
    callId: string;
    from:   SessionAddress;
    to:     SessionAddress;
    kind:   CallKind;
  }) => Promise<CallOfferAuth>;

  /**
   * Audit P0-C5 — fires when a ringing call (outgoing or incoming) times
   * out without being answered. The host wires this to the missed-call
   * sink — write a `missed_call_outgoing` / `missed_call_incoming` row,
   * pop the call screen, dismiss the CallKit / FCM ring. The controller
   * has already cleaned up its own state (state→ended, pc closed, hangup
   * sent over signalling) by the time this callback fires.
   *
   * Optional: hosts that don't care about the missed-call surface
   * (loopback tests, dev fixtures) can omit it — the controller still
   * tears the call down on timeout.
   */
  onMissedCall?: (info: {
    callId:    string;
    peer:      SessionAddress;
    direction: 'incoming' | 'outgoing';
    kind:      CallKind;
  }) => void;

  /**
   * Audit P0-C5 — override the ring timeout for tests / aggressive
   * deployments. Defaults to DEFAULT_RING_TIMEOUT_MS (45 s).
   */
  ringTimeoutMs?: number;

  /**
   * B-62 — override the post-accept/answer 'connecting' watchdog for
   * tests. Defaults to CONNECTING_WATCHDOG_MS (20 s).
   */
  connectingWatchdogMs?: number;
}

/**
 * B-62 — a call that enters 'connecting' (answer sent / answer received)
 * but never reaches 'connected' has NO other timer: the ring timer is
 * cancelled at accept and the reconnect budget only arms after a first
 * connect. On the tester's device both notification-answered calls sat in
 * 'connecting' forever (FGS notification unclearable, caller rang out).
 * 20 s covers slow TURN/ICE on cellular with margin; ICE-connected cancels.
 */
export {CONNECTING_WATCHDOG_MS} from './callDeadlines';

/**
 * ANSWER-STALL — the watchdog budget that covers the answer-DELIVERY window.
 *
 * The signalling layer retries `call.answer` across a WS reconnect for its own
 * setup budget (CALL_SETUP_SEND_BUDGET_MS, 40s in signallingClient). This value
 * MUST exceed that, or the connecting watchdog kills a call whose answer is
 * still being legitimately retried — which is what made "answer from the
 * notification" stall on "Answering…" with no audio: the socket was still
 * coming up when the 20s clock expired.
 *
 * Once the frame actually reaches the socket, NA-05 re-arms the short
 * CONNECTING_WATCHDOG_MS clock, so a genuinely stuck ICE negotiation is still
 * caught in 20s. This longer budget only ever applies while delivery is pending.
 */
export {ANSWER_DELIVERY_WATCHDOG_MS} from './callDeadlines';

/**
 * WI-2.1 — the legal transition table.
 *
 * Terminal absorption was the ONLY enforced rule before this; every other
 * transition was reachable, and one illegal one was live on the dominant
 * outgoing path (`connected → connecting`, see `setState`).
 *
 * `calling → connected` AND `ringing → connected` are both in the table
 * because both are genuinely reachable —
 * and that was TRACED rather than assumed: for the caller, ICE can only
 * connect once the answer's remote description has been applied, which
 * `handleAnswer` does BEFORE it writes 'connecting'. So a fast ICE + DTLS
 * completes while the state is still 'calling'.
 *
 * REVIEW CORRECTION — an earlier version of this comment claimed `ringing` had
 * no such row because "the callee builds its PeerConnection inside accept()".
 * That is not what the code does: `acceptInner` builds the PC and applies the
 * local description well before it writes 'connecting', with the remote
 * candidates already drained. The callee window is the same class as the
 * caller's, just narrower. Omitting the row did not lose the call (the DTLS
 * poll and the watchdog's ICE re-probe both promote) but it stalled it, and a
 * table that rejects a reachable transition is a table that lies.
 *
 * `ended` / `failed` map to nothing: absorption is enforced ahead of this
 * table so a terminal self-transition stays silent.
 *
 * SPEC CORRECTION — the spec lists `idle → calling | ringing` only. That is
 * wrong and the B-108 pin proved it: `onIceFailed()` on a controller that
 * never connected must fail fast (the B-41 initial-connect class), and it
 * runs while the state is still `idle`. More generally `end()` is reachable
 * from every teardown path, including a cancel during boot, before the call
 * has started. A terminal transition must therefore be legal from EVERY
 * non-terminal state — otherwise the table would strand a dying call in a
 * live state, which is strictly worse than the regression it prevents.
 */
const LEGAL_TRANSITIONS: Record<CallState, readonly CallState[]> = {
  idle:         ['calling', 'ringing', 'ended', 'failed'],
  calling:      ['connecting', 'connected', 'ended', 'failed'],
  ringing:      ['connecting', 'connected', 'ended', 'failed'],
  connecting:   ['connected', 'reconnecting', 'ended', 'failed'],
  connected:    ['reconnecting', 'ended', 'failed'],
  reconnecting: ['connected', 'ended', 'failed'],
  ended:        [],
  failed:       [],
};

export class CallController {
  private state: CallState = 'idle';
  /**
   * WI-2.2 — the callId this instance was claimed for, or null while unused.
   * Deliberately NOT cleared by `end()`: an instance is spent once it has run
   * a call. Also the identity WI-2.5's offer-replay carve-out matches on.
   */
  private claimedCallId: string | null = null;
  private descriptor: CallDescriptor | null = null;
  private pc: PeerConnectionWrapper | null = null;
  // Set to true the moment end() runs. The DTLS-poll loop in
  // onIceConnected() can stay alive for up to 6s after the user hits
  // hangup (24 × 250ms iterations); without this flag every iteration
  // would still touch this.pc — by then closed and nulled — and risk
  // dereferencing freed native state. Each loop iteration checks
  // cancelled at the TOP and returns cleanly.
  private cancelled = false;
  // Tracks the unregister fns returned by signalling.on* so end() can
  // detach ITS handlers without affecting any other controller (or
  // future controller) that's wired up to the same CallSignalling.
  // Required because signalling now supports multiple subscribers
  // (Fix #17): without explicit unregister, a stale controller would
  // keep firing on every incoming frame for the rest of the session.
  private signallingUnsubs: Array<() => void> = [];

  // Trickle-ICE candidates can arrive BEFORE the WebRTC engine is
  // ready to apply them. Two windows where this happens:
  //
  //  1. Answerer pre-accept: offer arrives, candidates start trickling,
  //     but pc doesn't exist until the user taps Accept (we build it
  //     in accept()). Candidates arriving in this window have nowhere
  //     to land.
  //
  //  2. Offerer post-answer-arrival: the answerer's candidates start
  //     trickling immediately after they sendAnswer(). On our side
  //     handleAnswer() kicks off acceptAnswer() which is async, but the
  //     candidate frames keep arriving on the same WS — they race
  //     setRemoteDescription(answer). addIceCandidate throws "Cannot
  //     add ICE candidate before remote description has been set" and
  //     the silent .catch() eats it. The candidate is gone forever.
  //
  // Symptom of (2) when iceTransportPolicy='relay' is set: the offerer
  // never tells its TurnPort which peer addresses to bind, so coturn's
  // CreatePermission step is skipped. coturn then drops every outbound
  // packet from the offerer's relay (no permitted peer). Coturn logs
  // show `peer rp=<some>` (answerer's STUN reaches us via answerer's
  // permission) but `peer sp=0` (we send nothing because we never
  // permitted the answerer's address ourselves). Same-network calls
  // mask this because host candidates connect first and ICE doesn't
  // need the relay path. With relay-only transport policy the failure
  // is total.
  //
  // Fix: queue candidates until the ENGINE is ready (pc exists AND
  // setRemoteDescription has resolved), regardless of role. Drain the
  // queue at the exact moment the engine becomes ready.
  private pendingIce: Array<{candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null}> = [];
  private remoteDescriptionApplied = false;

  // Hard cap on the queue. A buggy/malicious peer flooding ICE before
  // we can apply remoteDescription would otherwise grow this array
  // unbounded for up to 30s (dispatcher TTL) at ~200 bytes per
  // candidate. 64 is well above any realistic ICE round (typical full
  // gather: 4-12 candidates per side). When full we drop OLDEST so a
  // fresh, possibly-better candidate can still land.
  private static readonly MAX_PENDING_ICE = 64;
  private enqueueIce(c: {candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null}): void {
    if (this.pendingIce.length >= CallController.MAX_PENDING_ICE) {
      this.pendingIce.shift();
    }
    this.pendingIce.push(c);
  }

  // ── OUTBOUND ICE gate (B-273) ───────────────────────────────────────
  // `pendingIce` above holds candidates we RECEIVED too early. This holds
  // the ones we would SEND too early, which is a different bug with the
  // same shape.
  //
  // createOffer() also applies the local description, so the engine starts
  // gathering — and firing onicecandidate — the instant it returns. But the
  // offer frame is not sent until AFTER `await buildOfferAuth(...)`, which
  // can take hundreds of ms (it may fetch a sender cert). Every candidate
  // gathered in that gap went out ahead of the offer, and the relay drops
  // ICE for a callId it has not seen an offer for yet
  // (`authorizeCallFrame` → silent `ignore`). Staging logs show it plainly:
  // three ICE frames, then OFFER, on every single outgoing call. The lost
  // ones are the FIRST gathered — host and server-reflexive, i.e. exactly
  // the candidates that make a same-network or easy-NAT call connect fast.
  //
  // So: hold outbound candidates until our first signalling frame for this
  // call is on the wire, then flush in gathering order. Trickle ICE is
  // order-insensitive, so deferring costs nothing.
  private outboundSignalled = false;
  private outboundIce: Array<{candidate: string; sdpMid: string | null; sdpMLineIndex: number | null}> = [];

  /** Called immediately after the first outbound offer/answer frame. */
  private openOutboundIceGate(callId: string, peer: SessionAddress): void {
    if (this.outboundSignalled) {return;}
    this.outboundSignalled = true;
    const queued = this.outboundIce.splice(0);
    this.lat('ice:gate-open', {held: queued.length});
    for (const c of queued) {
      this.opts.signalling.sendIce(callId, peer, c as IceCandidateInit, this.restartInFlight);
    }
  }

  // [CALLLAT] (audit Step 0) — one-shot latch for the first locally gathered
  // candidate, and the lane/id derivation every marker in this file shares.
  // The lane is LATCHED when the call is claimed (review round 2): `end()`
  // nulls the descriptor before its terminal setState, so deriving the lane
  // from the descriptor mislabelled every incoming call's closing rows as
  // the caller lane and never closed the answerer's clock.
  private latFirstLocalCandidate = false;
  private latLane: CallLatLane = '1to1-out';
  private lat(step: string, fields: Record<string, CallDiagField> = {}): void {
    logCallLat(this.latLane, this.descriptor?.callId ?? this.claimedCallId, step, fields);
  }

  // ── ICE-restart (weak-network recovery) state ───────────────────────
  // When iceConnectionState transitions to 'disconnected' mid-call we
  // start a 30s budget timer and (if we're the offerer) fire a fresh
  // offer with iceRestart=true. We piggyback on the existing
  // call.reoffer / call.reanswer signalling — the SDP itself carries
  // the iceRestart marker, so the peer's handleReOffer applies it
  // without any new protocol frames.
  //
  // - restartInFlight: single-flight guard so a flurry of
  //   disconnected events doesn't fire N parallel reoffers.
  // - restartBudgetTimer: 30s ceiling. If ICE doesn't reach 'connected'
  //   inside the window we end('failed').
  // - lastDisconnectAt: for diagnostics only — log how long the gap
  //   actually was on recovery.
  private restartInFlight     = false;
  private restartBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDisconnectAt    = 0;
  // B-108 — has this call EVER reached ICE connected? Gates onIceFailed:
  // a mid-call 'failed' routes into the reconnect machinery, while an
  // initial-connect failure (never connected — bad TURN creds, B-41
  // class) keeps the instant fail-fast.
  private everConnected       = false;
  private static readonly RECONNECT_BUDGET_MS = DEADLINE_RECONNECT_BUDGET_MS;
  // P2-BR-6 — wall-clock deadline for the reconnect budget. RN timers
  // freeze while the app is backgrounded, so a plain setTimeout would
  // "flush-expire" the instant the user taps back in and end('failed') a
  // call that was fine. Tracking the deadline as a timestamp lets the
  // timer honour a foreground-granted extension (notifyForeground) instead
  // of failing on the frozen-then-flushed fire.
  private restartBudgetDeadline = 0;
  // Screen-sleep survival: a single ICE-restart reoffer is lost if the peer
  // is briefly asleep / backgrounded when it arrives (no reanswer ever comes
  // back, the call then waits out the budget and dies — the "WhatsApp keeps
  // the call, we drop it on screen-off" report). Re-send the restart reoffer
  // on this interval for as long as we're 'reconnecting', so whenever the
  // peer wakes within the budget the next reoffer reaches them and they
  // reanswer. Cleared the instant ICE recovers, on hard-fail, and on teardown.
  private restartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RESTART_RETRY_MS = DEADLINE_RESTART_RETRY_MS;

  // ── Audit P0-C5 — ring timeout / missed-call state machine ────────
  // Armed AFTER call.offer ships (caller) OR AFTER handleIncomingOffer
  // runs (callee). Cancelled when the call advances out of the ringing
  // window (answer received / accept tapped / decline / hangup /
  // connect). On expiry the controller emits hangup, ends the call,
  // and fires `onMissedCall` so the host can record the row.
  private readonly ringState: CallRingState;

  // ── B-62 — 'connecting' watchdog ───────────────────────────────────
  // Armed by setState('connecting'), cleared on any transition out of
  // it (and in end()). Fires hangup('failed') so the peer/server learn
  // the call is dead and every teardown path (FGS, notif, InCallManager)
  // runs instead of the call wedging in 'connecting' forever.
  private connectingWatchdog: ReturnType<typeof setTimeout> | null = null;

  // ── Mid-call renegotiation state ───────────────────────────────────
  // Lock against concurrent renegotiations from the same side. Tap the
  // Camera button once → this becomes a Promise; tap again before it
  // resolves → returns the existing Promise so the second tap is a
  // no-op. Cleared in finally{} of renegotiateLocal regardless of
  // success / failure / timeout.
  private renegotiationInFlight: Promise<void> | null = null;
  // Resolver for the in-flight renegotiation promise — fires when the
  // peer's `call.reanswer` lands and setRemoteDescription resolves.
  // Stamped at the start of renegotiateLocal, cleared in finally.
  private reAnswerResolve: ((sdp: string) => void) | null = null;
  private reAnswerReject:  ((err: Error) => void)        | null = null;

  constructor(private readonly opts: CallControllerOptions) {
    // Audit P0-C5 — ring timeout. Default 45 s; tests can shorten via
    // opts.ringTimeoutMs. The expire path emits hangup, ends the call,
    // and surfaces the missed-call record to the host.
    this.ringState = new CallRingState({
      onExpire:  (e: RingExpireEvent) => this.handleRingExpire(e),
      timeoutMs: opts.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS,
    });
    // Wire signalling handlers — these fire regardless of who we are
    // in the call. Filtering by callId keeps us from crossing streams.
    // Capture each on*'s returned unregister so end() can cleanly
    // detach our handlers (Fix #17/#18): without this a dead
    // controller's handlers would keep firing on every frame for the
    // remainder of the CallSignalling's lifetime, racing the live
    // controller's handlers and corrupting state.
    this.signallingUnsubs.push(
      opts.signalling.onAnswer(({callId, from, sdp}) => {
        if (!this.descriptor || this.descriptor.callId !== callId) {return;}
        // Audit P1-N5 — the caller targeted `descriptor.peer` with
        // call.offer; the answer MUST come from that same address.
        // A relay that delivers an answer with the matching callId
        // from an attacker (Mallory)'s deviceId would otherwise bind
        // DTLS-SRTP to Mallory because `acceptAnswer(sdp)` runs
        // without any identity check on `from`. The relay stamps
        // `from` from the WS auth context, so this is the authentic
        // identity of whoever submitted the answer frame. We reject
        // mismatched answers silently rather than throwing — a slow
        // race in the dispatcher's queue could legitimately deliver
        // a stale frame here, and we don't want to surface that as a
        // call-state error.
        if (
          from.userId !== this.descriptor.peer.userId ||
          from.deviceId !== this.descriptor.peer.deviceId
        ) {
          console.warn(
            `[bravo.callController] DROP call.answer cid=${callId.slice(0, 8)} ` +
            `from=${from.userId}/${from.deviceId} expected=${this.descriptor.peer.userId}/${this.descriptor.peer.deviceId}`,
          );
          return;
        }
        void this.handleAnswer(sdp);
      }),
    );
    this.signallingUnsubs.push(
      opts.signalling.onIce(({callId, from, candidate, sdpMid, sdpMLineIndex}) => {
        if (!this.descriptor || this.descriptor.callId !== callId) {return;}
        // Audit P1-N5 — refuse ICE candidates that don't come from
        // the negotiated peer. A relay could otherwise stitch the
        // attacker's candidate set onto our PC and the offerer would
        // happily try to connect to it during the candidate-gather
        // window.
        if (
          from.userId !== this.descriptor.peer.userId ||
          from.deviceId !== this.descriptor.peer.deviceId
        ) {
          return;
        }
        if (this.cancelled) {return;}
        if (this.pc && this.remoteDescriptionApplied) {
          // Even past the gate, addIceCandidate can still throw if the
          // PC entered an unexpected state (mid-renegotiation, the engine
          // is between setRemote calls, or RN-WebRTC's internal state
          // hasn't fully synced after setRemoteDescription resolves on
          // some Android builds). Re-queue on failure instead of dropping
          // the candidate. The queue is drained again on the NEXT
          // setRemoteDescription resolution; if none comes, the queue
          // is cleared in end() so we don't leak.
          void this.pc.addIce(candidate, sdpMid, sdpMLineIndex).catch(() => {
            // Don't re-queue if end() already ran while addIce was in
            // flight — pendingIce was just cleared and re-pushing a
            // single phantom candidate leaves it sitting for the NEXT
            // call on this controller instance to silently apply.
            if (this.cancelled) {return;}
            this.enqueueIce({candidate, sdpMid, sdpMLineIndex});
          });
        } else {
          this.enqueueIce({candidate, sdpMid, sdpMLineIndex});
        }
      }),
    );
    this.signallingUnsubs.push(
      opts.signalling.onHangup(({callId, reason}) => {
        if (!this.descriptor || this.descriptor.callId !== callId) {return;}
        // Audit P0-C5 — if the call hung up while we were ringing, the
        // user didn't see / answer it. Record a missed_call_incoming
        // (or _outgoing for caller-side "Cancelled by them") then end.
        // The ring-state cancel runs first so handleRingExpire can't
        // double-fire.
        const wasRinging =
          this.state === 'ringing' || this.state === 'calling';
        const snapshot = wasRinging ? {...this.descriptor} : null;
        this.ringState.cancel(callId);
        this.end(reason === 'failed' ? 'failed' : 'ended');
        if (snapshot) {
          try {
            this.opts.onMissedCall?.({
              callId:    snapshot.callId,
              peer:      snapshot.peer,
              direction: snapshot.direction,
              kind:      snapshot.kind,
            });
          } catch (e) {
            console.warn(`[bravo.callController] onMissedCall threw: ${(e as Error).message}`);
          }
        }
      }),
    );
    // Mid-call renegotiation — peer's `call.reoffer` arrives here.
    // Same callId-mismatch guard as the rest, then handed off to the
    // async handler. Errors caught at the boundary so a one-off
    // renegotiation failure can't bubble up and crash the dispatcher.
    this.signallingUnsubs.push(
      opts.signalling.onReOffer(({callId, from, sdp}) => {
        if (!this.descriptor || this.descriptor.callId !== callId) {return;}
        // Audit P1-N5 — peer-identity gate for the mid-call upgrade
        // path. A reoffer claiming our peer's callId but coming from
        // a different deviceId would otherwise switch the negotiated
        // media to the attacker's tracks.
        if (
          from.userId !== this.descriptor.peer.userId ||
          from.deviceId !== this.descriptor.peer.deviceId
        ) {
          console.warn(`[bravo.callController] DROP call.reoffer cid=${callId.slice(0, 8)} from=${from.userId}/${from.deviceId}`);
          return;
        }
        void this.handleReOffer(sdp).catch(e => {
          console.warn(`[bravo.callController] handleReOffer threw: ${(e as Error).message}`);
        });
      }),
    );
    this.signallingUnsubs.push(
      opts.signalling.onReAnswer(({callId, from, sdp}) => {
        if (!this.descriptor || this.descriptor.callId !== callId) {return;}
        // Audit P1-N5 — same peer-identity gate on the reanswer path.
        if (
          from.userId !== this.descriptor.peer.userId ||
          from.deviceId !== this.descriptor.peer.deviceId
        ) {
          console.warn(`[bravo.callController] DROP call.reanswer cid=${callId.slice(0, 8)} from=${from.userId}/${from.deviceId}`);
          return;
        }
        void this.handleReAnswer(sdp).catch(e => {
          console.warn(`[bravo.callController] handleReAnswer threw: ${(e as Error).message}`);
        });
      }),
    );
  }

  /**
   * Drain queued ICE candidates into the engine. Called after each
   * setRemoteDescription resolves (setRemoteOffer on the answerer,
   * acceptAnswer on the offerer). Safe to call multiple times — the
   * queue is spliced out so a second call sees an empty array.
   */
  private async drainPendingIce(): Promise<void> {
    if (!this.pc) {return;}
    const queued = this.pendingIce.splice(0);
    for (const c of queued) {
      // Mid-loop teardown: end() can null this.pc between iterations.
      // Without this check the next addIce throws on null and the
      // surrounding try in callers swallows it as "ICE drain failed",
      // but more importantly leaves any not-yet-applied candidates in
      // the local `queued` const — they're lost.
      if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
      try { await this.pc.addIce(c.candidate, c.sdpMid, c.sdpMLineIndex); } catch { /* ignore */ }
    }
  }

  get currentState():    CallState { return this.state; }
  get currentCall(): CallDescriptor | null { return this.descriptor; }

  /**
   * WI-2.2 — claim this instance for exactly one call lifecycle.
   *
   * Kept separate from `descriptor` because `end()` nulls that (so a used,
   * torn-down instance would look fresh) and separate from `state` because a
   * terminal instance reads 'ended', not 'idle'. Survives teardown by design:
   * that is the whole point.
   */
  private claimForOneCall(src: string, callId: string): void {
    if (this.claimedCallId !== null) {
      throw new Error(
        `CallController: one controller = one call (${src} cid=${callId.slice(0, 8)} on an instance already used for ${this.claimedCallId.slice(0, 8)})`,
      );
    }
    this.claimedCallId = callId;
  }

  /** Initiate an outgoing call. */
  async startOutgoing(params: {callId: string; peer: SessionAddress; kind: CallKind}): Promise<void> {
    // WI-2.2 — one controller = one call. `state !== 'idle'` LOOKED like a
    // reuse guard but terminal absorption already made reuse impossible, so
    // all it really did was mislead: a second call on a used instance would
    // have inherited `everConnected = true` and granted a FRESH call the 30 s
    // mid-call reconnect budget on its first TURN failure (the B-41 class),
    // plus the old descriptor, timers and PC state. `claimed` is checked
    // instead of `state` because a terminal instance reads 'ended', not 'idle'.
    this.claimForOneCall('startOutgoing', params.callId);
    this.descriptor = {...params, direction: 'outgoing'};
    this.latLane = '1to1-out';
    this.setState('calling', 'startOutgoing');
    this.pc = this.buildPc(params.callId, params.peer);
    this.lat('pc:built');
    // Caller order: addTrack BEFORE createOffer so the offer SDP
    // includes our sendrecv m-lines. Await — host's attachLocalMedia
    // may use replaceTrack (async) and we MUST NOT createOffer until
    // every sender is bound, otherwise the offer comes out missing
    // our media.
    await this.opts.attachLocalMedia?.(this.pc.raw);
    // Rapid-hangup guard: user can tap End during attachLocalMedia
    // (camera permission prompt + replaceTrack on cellular = seconds).
    // end() will have nulled this.pc — calling pc.createOffer() then
    // throws TypeError on null and the IIFE in useCall flips state to
    // 'failed' on top of the already-set 'ended', producing a "Call
    // failed" toast for what was a clean cancel.
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    this.lat('media:attached');
    const offer = await this.pc.createOffer();
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    this.lat('offer:created', {sdpLen: offer.sdp.length});
    // Audit S7 — bind the outgoing offer to the caller's verified
    // identity. The host wires `buildOfferAuth` through the runtime
    // (which has access to the cached sender cert + identity priv key).
    // If the build fails we still ship the offer without the auth block
    // — the relay accepts unsigned offers during the rollout window and
    // the callee fails-closed at the boundary it's configured for. We
    // do NOT raise here because a transient cert-fetch failure shouldn't
    // wedge an outgoing call; the callee surfaces the rejection if its
    // policy is strict.
    let auth: CallOfferAuth | undefined;
    if (this.opts.buildOfferAuth) {
      try {
        // `from` is supplied by the host's signer (knows ownAddress);
        // we hand the host only the per-call fields so the controller
        // doesn't need to learn about identity wiring.
        auth = await this.opts.buildOfferAuth({
          callId: params.callId,
          from:   {userId: '', deviceId: 0}, // replaced by signer
          to:     params.peer,
          kind:   params.kind,
        });
      } catch (e) {
        console.warn('[callController.startOutgoing] buildOfferAuth failed; shipping offer without auth:', (e as Error).message);
      }
    }
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    this.lat('offer:auth', {signed: !!auth});
    const offerSent = this.opts.signalling.sendOffer(params.callId, params.peer, offer.sdp, params.kind, auth);
    // B-273 — flush only once the offer has REACHED THE SOCKET. sendOffer
    // goes through waitOpenThenSend (it may wait out a reconnect), while
    // sendIce takes an immediate path — so releasing on return would still
    // put candidates ahead of the offer and the relay would drop them.
    void Promise.resolve(offerSent)
      .catch(() => false)
      .then(() => this.openOutboundIceGate(params.callId, params.peer));
    // Audit P0-C5 — arm caller-side ring timeout. Cancelled by
    // handleAnswer / hangup / end. On expiry the controller emits
    // hangup and the host records a missed_call_outgoing row.
    this.ringState.armOutgoing(params.callId);
  }

  /** Feed an incoming offer — moves state to 'ringing'. UI calls accept()/decline(). */
  handleIncomingOffer(offer: {callId: string; from: SessionAddress; sdp: string; kind: CallKind}): void {
    // WI-2.5 — same-callId carve-out, BEFORE the busy bounce. A replayed
    // offer for the call we are already handling is a duplicate to ignore,
    // never a second caller: bouncing it answers `busy` to the very peer we
    // are ringing for and kills the call the replay exists to rescue.
    if (this.claimedCallId === offer.callId) {
      console.warn(`[CALLSM] offer-replay ignored cid=${offer.callId.slice(0, 8)} state=${this.state}`);
      return;
    }
    if (this.state !== 'idle') {
      // Busy — tell the caller.
      this.opts.signalling.sendHangup(offer.callId, offer.from, 'busy');
      return;
    }
    // WI-2.2 — one controller = one call. Defence in depth only: a claimed
    // instance has already left 'idle' and terminal absorption means it never
    // returns, so the busy bounce above always fires first and this is
    // unreachable today. Kept so the invariant does not depend on that bounce
    // continuing to exist.
    this.claimForOneCall('handleIncomingOffer', offer.callId);
    this.descriptor = {
      callId:    offer.callId,
      peer:      offer.from,
      kind:      offer.kind,
      direction: 'incoming',
    };
    this.latLane = '1to1-in';
    this.setState('ringing', 'handleIncomingOffer');
    // Stash the offer until the user accepts. We keep it on the pc
    // wrapper via a pending-offer side channel to avoid bloating state.
    this.pendingOfferSdp = offer.sdp;
    // Audit P0-C5 — arm callee-side ring timeout. Cancelled by
    // accept / decline / hangup / peer-hangup. On expiry the controller
    // emits hangup so the caller stops ringing, and the host records a
    // missed_call_incoming row.
    this.ringState.armIncoming(offer.callId);
  }

  private pendingOfferSdp: string | null = null;

  /**
   * B-274 — "he answered and it stuck on Answering…".
   *
   * The body below has four bare `if (cancelled || !pc || pc.isClosed())
   * return;` exits. Those are correct for a rapid hangup DURING accept, but
   * they resolve the promise normally, so a non-cancel reason for hitting one
   * left the callee having sent NO answer, NO ICE and NO hangup — the caller
   * rings out and the callee stares at "Answering…" until something else
   * kills it. Staging logs show exactly that shape: OFFER delivered OK, then
   * silence from the callee, then the CALLER giving up.
   *
   * A throw was no better: the manual (in-app) accept path awaits this with
   * no catch, so it surfaced as an unhandled rejection and the call still
   * just sat there. Only the autoAccept path handled failure.
   *
   * So accept() now has exactly two honest outcomes: an answer went out, or
   * the call is terminated as failed and the caller is told. Cancellation is
   * the one silent case, because there the user already ended it.
   */
  async accept(): Promise<void> {
    if (this.state !== 'ringing' || !this.descriptor || !this.pendingOfferSdp) {
      throw new Error('no incoming call to accept');
    }
    try {
      await this.acceptInner();
    } catch (e) {
      console.warn('[WEBRTC] accept threw — ending call as failed:', (e as Error)?.message ?? e);
      if (!this.cancelled) {
        try { this.hangup('failed'); } catch { /* already terminal */ }
      }
      throw e;
    }
    // Still 'ringing' means acceptInner bailed at a guard before
    // setState('connecting') — no answer was sent. Do not leave it hanging.
    if (!this.cancelled && this.state === 'ringing') {
      console.warn('[WEBRTC] accept returned without sending an answer — ending call as failed');
      try { this.hangup('failed'); } catch { /* already terminal */ }
    }
  }

  private async acceptInner(): Promise<void> {
    if (!this.descriptor || !this.pendingOfferSdp) {return;}
    // B-274 diagnostics — WARN, not log, on purpose. Release builds strip
    // console.log (babel-plugin-transform-remove-console keeps warn/error), so
    // the answer path was invisible on exactly the builds QA runs. Each step
    // below is a place accept() can stop without sending anything; the last
    // CALLDIAG line in logcat names the one that stopped it. No SDP bodies and
    // no ICE candidate strings — those carry addresses.
    const dtag = `[CALLDIAG] cid=${this.descriptor.callId.slice(0, 8)} kind=${this.descriptor.kind}`;
    console.warn(`${dtag} accept:begin`);
    // Audit P0-C5 — user picked up; clear the missed-call timer before
    // any async work so a slow setRemote/getUserMedia path can't race
    // the expiry and mark the answered call as missed.
    this.ringState.cancel(this.descriptor.callId);
    this.pc = this.buildPc(this.descriptor.callId, this.descriptor.peer);
    this.lat('pc:built');
    // Spec-correct answerer order: setRemote → addTrack → createAnswer.
    // The previous combined acceptOffer() did setRemote+createAnswer in
    // a single shot, which forced the host to add tracks BEFORE
    // setRemoteDescription via the wrapped pcFactory. RN-WebRTC then
    // sometimes produced duplicated transceivers and an answer that
    // didn't line up with the offer's m-lines — DTLS would never
    // complete and the call hung in 'connecting'.
    await this.pc.setRemoteOffer(this.pendingOfferSdp);
    console.warn(`${dtag} accept:remote-offer-applied`);
    this.lat('remote-offer:applied');
    // Rapid-hangup guard: rejecting/hanging-up during accept's awaits is
    // common (slow Android getUserMedia for the answerer). Each await
    // re-checks cancelled — without these, the next pc.* call throws on
    // null and we leak partial state into a 'failed' transition over an
    // already-'ended' state.
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    this.pendingOfferSdp = null;
    // Engine now has the offer's transceivers AND a remote description,
    // so it can accept ICE candidates. Flip the gate and drain anything
    // that trickled in before this point. Doing this BEFORE attachLocal-
    // Media so the engine starts CreatePermission'ing peer relays
    // immediately, in parallel with our local-track setup.
    this.remoteDescriptionApplied = true;
    const pendingIceN = this.pendingIce.length;
    await this.drainPendingIce();
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    this.lat('pending-ice:drained', {n: pendingIceN});
    // Now that the engine has the offer's transceivers, attach our
    // local tracks. Spec says replaceTrack on the recvonly transceivers
    // extends them to sendrecv in-place — exactly what we want. Await
    // because replaceTrack is async; firing it without await means
    // createAnswer below can run with senders still in 'pending track'
    // state, producing a recvonly answer (no media flows back).
    await this.opts.attachLocalMedia?.(this.pc.raw);
    console.warn(`${dtag} accept:local-media-attached`);
    this.lat('media:attached');
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    const answer = await this.pc.createAnswerAndApply();
    console.warn(`${dtag} accept:answer-created sdpLen=${answer.sdp.length}`);
    this.lat('answer:created', {sdpLen: answer.sdp.length});
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    const answerCallId = this.descriptor.callId;
    const delivered = this.opts.signalling.sendAnswer(answerCallId, this.descriptor.peer, answer.sdp);
    // B-273 — same gate on the answerer side: createAnswerAndApply() starts
    // gathering, and those candidates must not precede our answer on the
    // wire. sendAnswer already resolves at socket.emit, so chain on it.
    const answerPeer = this.descriptor.peer;
    void delivered
      .catch(() => false)
      .then(() => this.openOutboundIceGate(answerCallId, answerPeer));
    this.setState('connecting', 'acceptInner');
    // Why: NA-05 — the answer can ride a WS reconnect for several seconds. The
    // connecting watchdog measures "peer has our answer and ICE still has not
    // come up", so its clock must start when the frame reaches the socket, not
    // when the user tapped Accept.
    //
    // ANSWER-STALL — setState('connecting') above arms the SHORT watchdog
    // immediately, and two timers then contradicted each other: the signalling
    // layer retries the answer across a WS reconnect for CALL_SETUP_SEND_BUDGET
    // (40s), while this watchdog killed the call at 20s. Answering from a
    // notification tap is exactly the case where the socket is still coming up,
    // so the watchdog fired while the answer was STILL being legitimately
    // retried: the caller never got an answer, no media path was ever
    // negotiated, and the callee sat on "Answering…" until the call died.
    //
    // Hold the watchdog open for the whole delivery window, then let the
    // NA-05 re-arm below restart the real (short) clock from the moment the
    // frame actually reaches the socket.
    this.armConnectingWatchdog(ANSWER_DELIVERY_WATCHDOG_MS);
    void delivered
      .then(ok => {
        if (this.state !== 'connecting') {return;}
        if (this.descriptor?.callId !== answerCallId) {return;}
        console.warn(`[CALLDIAG] call.answer delivered=${ok} cid=${answerCallId.slice(0, 8)}`);
        if (!ok) {
          // The answer never reached the socket inside its budget. Nothing used
          // to happen here, so the call sat in 'connecting' behind an
          // "Answering…" label until a watchdog it could not influence expired.
          // Fail it explicitly so every teardown path runs and the caller stops
          // ringing instead of waiting on an answer that will never arrive.
          console.warn('[WEBRTC] call.answer never reached the socket — ending call as failed');
          this.hangup('failed');
          return;
        }
        this.armConnectingWatchdog();
      })
      .catch(() => { /* best-effort — a watchdog is armed either way */ });
  }

  decline(): void {
    if (this.state !== 'ringing' || !this.descriptor) {return;}
    // Audit P0-C5 — user actively declined; not a missed call.
    this.ringState.cancel(this.descriptor.callId);
    this.opts.signalling.sendHangup(this.descriptor.callId, this.descriptor.peer, 'declined');
    this.end('ended');
  }

  hangup(reason: HangupReason = 'ended'): void {
    if (!this.descriptor || this.state === 'ended' || this.state === 'failed') {return;}
    // Audit P0-C5 — caller cancelled before pickup OR ended an in-
    // progress call. Cancel the ring timer regardless of which case;
    // a stale-callId cancel is a no-op in CallRingState.
    this.ringState.cancel(this.descriptor.callId);
    this.opts.signalling.sendHangup(this.descriptor.callId, this.descriptor.peer, reason);
    this.end(reason === 'failed' ? 'failed' : 'ended');
  }

  /**
   * Phase 6 round 2 (critic advisory / edge R1) — end WITHOUT the wire
   * hangup. A REMOTE-sourced end (the answered-elsewhere ring collapse, a
   * call.sync ended/unknown verdict) is by definition already known to the
   * far side; sending call.hangup from here is at best a dropped frame and
   * at worst — while the server session is still ACTIVE for the live winner
   * under the shared deviceId — an AUTHORIZED kill of that call (the sender
   * is a participant). Same shape as the inbound-hangup lane: cancel the
   * ring timer first so handleRingExpire can't double-fire, then the silent
   * teardown. Deliberately no onMissedCall — a remote-verdict end is never
   * a missed call.
   */
  endSilently(reason: HangupReason = 'ended'): void {
    if (!this.descriptor || this.state === 'ended' || this.state === 'failed') {return;}
    this.ringState.cancel(this.descriptor.callId);
    this.end(reason === 'failed' ? 'failed' : 'ended');
  }

  private async handleAnswer(sdp: string): Promise<void> {
    // Rapid-hangup guard: the dispatcher fires this from onAnswer after
    // a callId match, but end() can run between the dispatcher tick and
    // this handler's first line. Without these checks we'd dereference
    // a null pc OR worse, flip state ended→connecting via setState
    // below and the UI is stuck on "Connecting…" forever on a torn-
    // down call.
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    if ((this.state as string) === 'ended' || (this.state as string) === 'failed') {return;}
    // Audit P0-C5 — answer received, ring timer is satisfied. Cancel
    // before any await so a slow acceptAnswer can't race the expiry.
    if (this.descriptor) {this.ringState.cancel(this.descriptor.callId);}
    await this.pc.acceptAnswer(sdp);
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    if ((this.state as string) === 'ended' || (this.state as string) === 'failed') {return;}
    this.lat('answer:applied');
    // Engine now has the answer's remote description — ICE candidates
    // can finally land. Flip the gate and drain the queue. Critical for
    // the OFFERER side: candidate frames on the wire start arriving
    // immediately after the answerer sends them, but acceptAnswer is
    // async — without this gate they'd race and addIceCandidate would
    // throw "Cannot add ICE candidate before remote description". The
    // .catch in the onIce handler used to swallow the throw silently,
    // leaving the offerer's TurnPort with no permitted peers. coturn
    // would then drop every outbound packet from our relay and the
    // call would sit silent until hangup — exactly the cross-network
    // failure mode we hit with iceTransportPolicy:'relay'.
    this.remoteDescriptionApplied = true;
    const pendingIceN = this.pendingIce.length;
    await this.drainPendingIce();
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    if ((this.state as string) === 'ended' || (this.state as string) === 'failed') {return;}
    this.lat('pending-ice:drained', {n: pendingIceN});
    this.setState('connecting', 'handleAnswer');
  }

  // ── Mid-call renegotiation API ────────────────────────────────────
  // Spec-correct voice→video upgrade. The host (useCall) acquires the
  // new video track and addTracks it to the PC inside `prepare`, then
  // we createOffer / setLocal / send `call.reoffer`. The peer applies
  // the offer, optionally adds its own video, createAnswer / send
  // `call.reanswer`. We `setRemoteDescription(answer)` and resolve.
  //
  //   Initiator:  upgradeToVideo (host-facing)
  //                 → renegotiateLocal (controller-internal lock + steps)
  //   Responder:  handleReOffer (incoming `call.reoffer` from signalling)
  //   Glare:      if both sides fire reoffer simultaneously, the side
  //               whose signalingState is non-'stable' rejects the
  //               incoming reoffer; that side's watchdog rolls back
  //               the half-applied addTrack and the call stays voice
  //               until either side retries.

  /**
   * Public API for the host. Acquires lock, validates state, runs
   * `prepare(pc)` (host wires addTrack + setParameters here), then
   * createOffer → setLocal → sendReOffer → await reanswer → setRemote.
   *
   * Returns a Promise that resolves when the renegotiation has fully
   * completed (peer's reanswer applied) and rejects on
   *   - lock contention      (already in flight on this side)
   *   - bad state             (call not 'connected', or pc closed)
   *   - signaling glare       (signalingState != 'stable' at start)
   *   - prepare() throws      (camera permission denied, addTrack failed)
   *   - watchdog timeout       (no reanswer within watchdogMs, default 10s)
   *   - peer hangup            (end() during renegotiation)
   *
   * On any rejection the host MUST roll back its local changes (stop
   * the new track, remove sender) — the controller does not own those
   * resources. The PC's local m-line for the new track stays in the
   * SDP until the next renegotiation; this is harmless (it's a
   * sendrecv slot the encoder isn't producing for) but cosmetically
   * the offerer's getSenders() will still show the dead sender. Host
   * can call `removeTrack(sender)` to clean it up — that doesn't
   * itself trigger renegotiation in our state machine.
   */
  upgradeToVideo(opts: {
    /** Called inside the lock, after state validation, before createOffer. */
    prepare:    (pc: import('./types').PeerConnectionLike) => Promise<void> | void;
    /** Watchdog — defaults to 10s. Long enough for a slow cellular RTT, short enough that the user notices a hung peer. */
    watchdogMs?: number;
  }): Promise<void> {
    // Coalesce concurrent calls: if a renegotiation is already in
    // flight, return its Promise so the caller awaits the same outcome.
    // The Camera button can fire twice on a fast double-tap; without
    // this we'd run prepare() twice (acquire camera twice, addTrack
    // twice) and confuse the peer with two parallel reoffers.
    //
    // Intentionally NOT an `async` function — async would wrap the
    // returned Promise in a fresh Promise.resolve(), so two consecutive
    // calls would produce two distinct promise objects even though
    // they're chained off the same underlying renegotiation. Returning
    // the cached promise directly keeps `===` identity true so callers
    // (and tests) can assert "same in-flight handle".
    if (this.renegotiationInFlight) {return this.renegotiationInFlight;}
    this.renegotiationInFlight = this.renegotiateLocal(opts).finally(() => {
      this.renegotiationInFlight = null;
    });
    return this.renegotiationInFlight;
  }

  private async renegotiateLocal(opts: {
    prepare:     (pc: import('./types').PeerConnectionLike) => Promise<void> | void;
    watchdogMs?: number;
  }): Promise<void> {
    if (!this.pc) {throw new Error('renegotiate: no peer connection');}
    if (this.pc.isClosed()) {throw new Error('renegotiate: peer connection closed');}
    if (this.state !== 'connected') {throw new Error(`renegotiate: call must be connected (got ${this.state})`);}
    if (!this.descriptor) {throw new Error('renegotiate: no descriptor');}

    // Glare avoidance — only renegotiate from a stable signaling state.
    // If we're already mid-renegotiation (signalingState !== 'stable'),
    // bail. Without this, RN-WebRTC's setLocalDescription would throw
    // an InvalidStateError that we'd then have to unwind anyway.
    const sigState = (this.pc.raw as {signalingState?: string}).signalingState;
    if (sigState && sigState !== 'stable') {
      throw new Error(`renegotiate: signaling state is ${sigState}, expected stable`);
    }

    const cid = this.descriptor.callId;
    const peer = this.descriptor.peer;
    const tag = `[bravo.renegotiate] cid=${cid.slice(0, 8)} role=initiator`;
    console.log(`${tag} begin`);

    // Run the host's prepare BEFORE createOffer so the new sendrecv
    // transceiver is bound by the time the SDP is generated. Same
    // ordering invariant as the initial outgoing path.
    await opts.prepare(this.pc.raw);
    if (this.cancelled || this.pc.isClosed()) {
      throw new Error('renegotiate: cancelled during prepare');
    }
    console.log(`${tag} prepare-done, creating reoffer`);

    // createOffer() on the wrapper does setLocalDescription(offer) too.
    const offer = await this.pc.createOffer();
    if (this.cancelled || this.pc.isClosed()) {
      throw new Error('renegotiate: cancelled after createOffer');
    }
    console.log(`${tag} reoffer ready, sdpLen=${offer.sdp.length} — sending`);

    // Set up the reanswer-arrival promise BEFORE we send, so a peer
    // on a fast LAN that replies before our await can't race us.
    const watchdogMs = opts.watchdogMs ?? 10_000;
    const reAnswerPromise = new Promise<string>((resolve, reject) => {
      this.reAnswerResolve = resolve;
      this.reAnswerReject  = reject;
    });

    this.opts.signalling.sendReOffer(cid, peer, offer.sdp);
    this.lat('reoffer:sent', {restart: false, sdpLen: offer.sdp.length});

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    try {
      const sdp = await new Promise<string>((resolve, reject) => {
        watchdog = setTimeout(() => {
          reject(new Error(`renegotiate: no reanswer within ${watchdogMs}ms (peer may not support call.reoffer)`));
        }, watchdogMs);
        reAnswerPromise.then(resolve, reject);
      });
      console.log(`${tag} reanswer received, sdpLen=${sdp.length} — applying`);
      // Re-check we weren't torn down while waiting.
      if (this.cancelled || !this.pc || this.pc.isClosed()) {
        throw new Error('renegotiate: cancelled before reanswer apply');
      }
      await this.pc.acceptAnswer(sdp);
      console.log(`${tag} reanswer applied — renegotiation complete`);
      // remoteDescriptionApplied stays true; ICE was already flowing,
      // candidates that arrived during the renegotiation window land
      // normally because the original remote desc was never invalidated.
    } catch (e) {
      // Watchdog timeout / cancellation / acceptAnswer-throw all land
      // here. Without rolling back, the local PC stays in
      // `have-local-offer` and EVERY future Camera tap rejects at the
      // top of renegotiateLocal with "signaling state is
      // have-local-offer, expected stable". User-visible symptom:
      // first audio→video upgrade fails (peer didn't reply); second
      // upgrade fails differently ("Try again — both sides tried to
      // change the call at the same time") — exactly the BS-021
      // sequence reported. Roll back so the next attempt starts from
      // 'stable'. Best-effort: a roll-back failure (PC closed, engine
      // doesn't support it) is non-fatal — the original error is what
      // the host needs to see.
      if (this.pc && !this.pc.isClosed()) {
        try {
          await this.pc.rollbackLocalDescription();
          console.log(`${tag} rolled back local description after renegotiation failure`);
        } catch (rbErr) {
          console.warn(`${tag} rollback failed (non-fatal): ${(rbErr as Error).message}`);
        }
      }
      throw e;
    } finally {
      if (watchdog) {clearTimeout(watchdog);}
      this.reAnswerResolve = null;
      this.reAnswerReject  = null;
    }
  }

  /**
   * Incoming `call.reoffer` from the peer — they tapped Camera on
   * their side. Apply the new offer, optionally let the host attach
   * its own video (onRemoteRenegotiation), createAnswer, send back.
   *
   * Glare handling: if WE have a renegotiation in flight (our
   * signalingState is non-stable), reject the peer's reoffer by
   * sending a watchdog-triggering no-op — actually simpler: just
   * skip it. Their watchdog rolls back. We then complete our own
   * renegotiation. After that completes both sides are in stable +
   * we have video; whoever wanted to add a track later can retry.
   */
  private async handleReOffer(sdp: string): Promise<void> {
    if (!this.pc) {return;}
    if (this.pc.isClosed()) {return;}
    this.lat('reoffer:received', {sdpLen: sdp.length});
    // Audit CALL-N4 (2026-07-02): also accept a reoffer while 'reconnecting'.
    // A real network handover (Wi-Fi↔cellular) drops the callee's ICE to
    // 'disconnected' → state 'reconnecting'; the offerer's ICE-restart
    // reoffer then arrived here and was IGNORED because state !== 'connected',
    // so recovery only worked in the narrow race where the reoffer landed
    // before the callee noticed. The glare check below still guards
    // mid-renegotiation collisions.
    if (this.state !== 'connected' && this.state !== 'reconnecting') {
      console.warn(`[bravo.callController] handleReOffer ignored — state=${this.state}`);
      return;
    }

    const sigState = (this.pc.raw as {signalingState?: string}).signalingState;
    if (sigState && sigState !== 'stable') {
      console.warn(`[bravo.callController] handleReOffer ignored — signalingState=${sigState} (glare; peer's watchdog will roll back)`);
      return;
    }

    if (!this.descriptor) {return;}
    const cid = this.descriptor.callId;
    const peer = this.descriptor.peer;
    const tag = `[bravo.renegotiate] cid=${cid.slice(0, 8)} role=responder`;
    console.log(`${tag} reoffer received, sdpLen=${sdp.length} — applying`);

    // Audit CALL-N3 (2026-07-02): ICE-restart reoffers ride this SAME
    // `call.reoffer` channel as a genuine audio→video upgrade. The old code
    // fired onRemoteRenegotiation (→ "peer turned on video" alert + switch to
    // the video layout) after ANY reoffer, so every ICE restart on a VOICE
    // call flipped the UI to a black video layout with a false prompt. A real
    // video-upgrade offer carries a `m=video` section; an ICE-restart reoffer
    // for a voice call does not (it re-offers the same audio-only m-lines). So
    // only treat the reoffer as a video upgrade when the SDP carries video.
    const peerAddedVideo = /(^|\r?\n)m=video/i.test(sdp);

    // Apply the remote reoffer. The peer's new sendrecv video
    // transceiver appears as recvonly on our side until we addTrack
    // (in onRemoteRenegotiation, if the host opts in).
    await this.pc.setRemoteOffer(sdp);
    if (this.cancelled || this.pc.isClosed()) {return;}
    console.log(`${tag} remote-reoffer applied (peerAddedVideo=${peerAddedVideo})`);

    // Let the host opt in to two-way video — ONLY when the peer genuinely
    // offered video. For an ICE-restart (or audio-only) reoffer we still
    // createAnswer below (needed to complete the restart) but must NOT signal
    // a video upgrade. If they throw or omit, we still createAnswer with a
    // recvonly video m-line so the peer sees video flow one way.
    if (peerAddedVideo) {
      try {
        await this.opts.onRemoteRenegotiation?.(this.pc.raw);
      } catch (e) {
        console.warn(`[bravo.callController] onRemoteRenegotiation threw — proceeding with one-way video: ${(e as Error).message}`);
      }
    }
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}

    const answer = await this.pc.createAnswerAndApply();
    if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
    console.log(`${tag} reanswer ready, sdpLen=${answer.sdp.length} — sending`);
    this.opts.signalling.sendReAnswer(cid, peer, answer.sdp);
    this.lat('reanswer:sent', {sdpLen: answer.sdp.length});
    console.log(`${tag} renegotiation complete`);
  }

  /**
   * Incoming `call.reanswer` from the peer — they accepted our reoffer.
   * Resolve the awaiter set up in renegotiateLocal so its setRemote /
   * resolve chain runs. If no renegotiation is in flight (e.g. the
   * dispatcher delivered a stray reanswer after our watchdog fired)
   * just log and drop.
   */
  private async handleReAnswer(sdp: string): Promise<void> {
    // ICE-restart path: no awaiter is set (we fire-and-forget the
    // reoffer and let the engine drive recovery off the wire). Apply
    // the answer directly so the engine learns the peer's new ICE
    // ufrag/pwd and resumes connectivity checks.
    if (this.restartInFlight) {
      if (!this.pc || this.pc.isClosed()) {
        console.warn('[bravo.callController] handleReAnswer (ice-restart) — pc gone');
        return;
      }
      try {
        await this.pc.acceptAnswer(sdp);
        console.log('[bravo.callController] ice-restart reanswer applied');
        this.lat('reanswer:applied', {restart: true});
        // restartInFlight stays true until iceConnectionState flips
        // back to 'connected' — that handler clears it.
      } catch (e) {
        console.warn(`[bravo.callController] ice-restart acceptAnswer threw: ${(e as Error).message}`);
        // Don't end — let the budget timer decide.
      }
      return;
    }
    if (!this.reAnswerResolve) {
      console.warn('[bravo.callController] handleReAnswer with no awaiter — stray frame, dropping');
      return;
    }
    this.lat('reanswer:received', {sdpLen: sdp.length});
    this.reAnswerResolve(sdp);
  }

  /**
   * Call this from the host once `iceConnectionState === 'connected'`.
   * Runs the DTLS-SRTP verification and transitions to 'connected'.
   */
  /**
   * Called when iceConnectionState reaches 'connected' or 'completed'.
   * Polls for DTLS-SRTP because the engine fires the ICE event before
   * the DTLS handshake finishes — without a poll, getStats lookups race
   * the handshake and we'd end('failed') a call that's about to succeed.
   *
   * Idempotency:
   *  - Skip if already 'connected' (ICE may oscillate connected→checking
   *    →connected on flaky networks; we don't want to re-verify and risk
   *    flipping a working call to 'failed').
   *  - Skip if a poll is already in flight (the engine fires
   *    iceConnectionStateChange repeatedly during candidate selection).
   */
  private dtlsPolling = false;
  // P1-BR-6 — set true once verifyDtlsSrtp confirms DTLS-SRTP for this
  // call. Gates onIceConnected re-entry so ICE oscillation (connected→
  // checking→connected) doesn't re-run the whole poll after a success.
  // Reset in end() so a reused controller instance re-verifies its next
  // call. Promotion to 'connected' is NO LONGER gated on this — that now
  // happens directly off the ICE event so a stats-layer stall can't hold
  // the UI at 'connecting'; this only stops redundant verification work.
  private dtlsVerified = false;
  // P1-BR-6 — per-iteration ceiling on the DTLS-SRTP stats probe. A hung
  // native getStats() promise used to wedge the whole poll (and thus the
  // call) at 'connecting' forever; racing each probe against this timeout
  // turns a stall into a normal FAILED iteration so the 24-iteration
  // budget still advances and the follow-up gate resolves.
  private static readonly DTLS_VERIFY_TIMEOUT_MS = 1_000;

  async onIceConnected(): Promise<void> {
    if (!this.pc) {return;}
    // P1-BR-6 — concurrency + already-verified latch only. Promotion to
    // 'connected' is performed by the ICE event handler BEFORE this runs,
    // so a later ICE event still re-promotes even while a prior gate is
    // mid-flight; this guard just prevents two verification polls at once
    // and skips re-verifying a call we already confirmed.
    if (this.dtlsVerified) {return;}
    if (this.dtlsPolling) {return;}
    this.dtlsPolling = true;
    const dtag = `[WEBRTC] cid=${this.descriptor?.callId.slice(0, 8) ?? '?'} role=${this.descriptor?.direction ?? '?'}`;
    console.log(`${dtag} dtls-poll-begin`);
    try {
      let lastErr: unknown;
      for (let i = 0; i < 24; i++) {
        // Bail at the TOP of every iteration — between iterations the
        // user can hit hangup (sets cancelled + nulls pc + transitions
        // state to ended/failed) or the engine can ICE-fail. Without
        // these guards we'd keep polling a closed PC for up to 6s,
        // burning CPU and risking a deref of a freed native handle on
        // RN-WebRTC. `this.pc?.verifyDtlsSrtp()` (optional chain
        // below) covers the dereference if pc was nulled mid-iteration.
        if (this.cancelled) { console.log(`${dtag} dtls-poll-cancelled i=${i}`); return; }
        if (this.state === 'ended' || this.state === 'failed') { console.log(`${dtag} dtls-poll-stateexit i=${i} state=${this.state}`); return; }
        if (!this.pc) { console.log(`${dtag} dtls-poll-pcgone i=${i}`); return; }
        if (this.pc.isClosed()) { console.log(`${dtag} dtls-poll-pcclosed i=${i}`); return; }
        try {
          const info = await this.verifyDtlsWithTimeout(dtag);
          if (!info) {return;}
          this.dtlsVerified = true;
          console.log(`${dtag} dtls-verify-ok i=${i} state=${info.dtlsState} cipher=${info.srtpCipher}`);
          this.lat('dtls:ok', {i});
          // After the await we may have been cancelled — re-check before
          // emitting state transitions, otherwise we'd flip a freshly-
          // ended call back to 'connected'. Cast to string because TS
          // narrowed `this.state` based on the synchronous checks above
          // and doesn't know that `await` allows external mutation.
          const sNow = this.state as string;
          if (this.cancelled || sNow === 'ended' || sNow === 'failed') {return;}
          // Latency: cap NetEq jitter-buffer target at 150 ms on every
          // audio receiver as soon as we know media is flowing. Default
          // adaptive target grows to 300+ ms on weak networks, which
          // the user hears as echo / lag. Best-effort — older RN-WebRTC
          // builds ignore the property silently.
          try {
            const recvs = (this.pc?.raw as unknown as {
              getReceivers?: () => Array<{track?: {kind?: string}; playoutDelayHint?: number}>;
            }).getReceivers?.() ?? [];
            for (const r of recvs) {
              if (r.track?.kind === 'audio') {
                r.playoutDelayHint = 0.15;
              }
            }
          } catch { /* ignore unsupported runtimes */ }
          this.opts.onSecured?.(info);
          this.setState('connected', 'dtls-poll');
          return;
        } catch (e) {
          lastErr = e;
          if (i % 4 === 0) {
            // Every ~1s, log what verifyDtlsSrtp is rejecting on. Don't
            // log every iteration to avoid flooding logcat; one in four
            // is enough to see the progression (e.g., "no transport
            // report" → "DTLS not connected (state=connecting)" →
            // "DTLS not connected (state=connected)" finally success,
            // OR stuck on the same error for the full 6 seconds which
            // tells us where the actual failure is).
            console.log(`${dtag} dtls-verify-fail i=${i} reason=${(e as Error)?.message ?? e}`);
          }
          // 250ms × 24 = 6s total. Generous because slow networks can
          // push DTLS completion past the typical 1-2s window.
          await new Promise(r => setTimeout(r, 250));
        }
      }
      console.log(`${dtag} dtls-poll-exhausted final-reason=${(lastErr as Error)?.message ?? lastErr}`);
      throw lastErr;
    } finally {
      this.dtlsPolling = false;
    }
  }

  /**
   * P1-BR-6 — race verifyDtlsSrtp against a hard timeout. A never-settling
   * native getStats() promise is surfaced as a rejected iteration (so the
   * poll budget advances instead of hanging forever) AND emits the
   * `dtls-poll-hung` watchdog line the 2-device ADB trace greps for. No SDP
   * / key material / fingerprint is logged — only the hung marker.
   */
  private async verifyDtlsWithTimeout(dtag: string): Promise<{dtlsState: string; srtpCipher: string} | undefined> {
    const pc = this.pc;
    if (!pc) {return undefined;}
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        pc.verifyDtlsSrtp(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            console.log(`${dtag} dtls-poll-hung`);
            reject(new Error('dtls-verify-timeout'));
          }, CallController.DTLS_VERIFY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {clearTimeout(timer);}
    }
  }

  onIceFailed(): void {
    // B-108 — a mid-call ICE 'failed' is NOT terminal. On an Android
    // network switch (Wi-Fi→mobile) every candidate pair can fail before
    // the ICE-restart reoffer round-trips (the WS is down at the same
    // instant), and an ICE restart re-gathers with a fresh ufrag — it IS
    // the recovery mechanism. Route into the existing reconnect
    // machinery and let the wall-clock budget stay the ONLY terminal
    // authority (its expiry path + B-64 teardown are unchanged). A call
    // that never reached ICE connected keeps the instant fail-fast
    // (initial-connect failure — bad TURN creds must not fake-reconnect
    // for 30 s, B-41 class).
    if (this.cancelled || this.state === 'ended' || this.state === 'failed') {return;}
    if (this.everConnected || this.state === 'reconnecting') {
      if (this.state !== 'reconnecting') {
        this.lastDisconnectAt = Date.now();
        this.setState('reconnecting', 'onIceFailed');
        this.startRestartBudget();
      }
      // Force a FRESH restart offer — the in-flight latch may be holding
      // a reoffer whose candidates just hard-failed. If the budget was
      // paused by notifyBackground, we deliberately do NOT re-arm it here
      // (notifyForeground owns the resume grant).
      this.restartInFlight = false;
      if (this.descriptor?.direction === 'outgoing') {
        void this.fireIceRestartOffer().catch(e => {
          console.warn(`[bravo.callController] ice-restart-offer (failed path) threw: ${(e as Error).message}`);
        });
        this.startRestartRetry();
      }
      return;
    }
    this.clearRestartBudget();
    this.clearRestartRetry();
    this.restartInFlight = false;
    this.end('failed');
  }

  /**
   * iceConnectionState went 'disconnected'. Per W3C this is recoverable
   * (network blip, ICE consent freshness timeout, brief Wi-Fi blip).
   * Strategy:
   *  • flip to 'reconnecting' so the UI swaps to the overlay,
   *  • start a 30s hard budget — if we don't see 'connected' inside
   *    the window, end('failed'),
   *  • if we're the offerer AND no restart is in flight, fire a fresh
   *    offer with iceRestart=true so the engine reallocates ICE.
   * If the disconnect spontaneously heals (very common — Wi-Fi blip
   * comes back within 2-3s), the 'connected' branch above clears the
   * budget and flips back to 'connected'.
   */
  private onIceDisconnected(): void {
    if (this.cancelled) {return;}
    if (this.state === 'ended' || this.state === 'failed') {return;}
    if (this.state === 'reconnecting') {return;} // already handling

    this.lastDisconnectAt = Date.now();
    this.setState('reconnecting', 'onIceDisconnected');
    this.startRestartBudget();

    // Only the original offerer drives the restart — the callee just
    // waits for the new offer. This mirrors how reoffer/reanswer
    // already works (offerer side initiates).
    if (this.descriptor?.direction === 'outgoing') {
      if (!this.restartInFlight) {
        void this.fireIceRestartOffer().catch(e => {
          console.warn(`[bravo.callController] ice-restart-offer threw: ${(e as Error).message}`);
        });
      }
      // Keep re-sending the reoffer while we stay 'reconnecting' so a peer
      // that was asleep when the first one landed still recovers on wake.
      this.startRestartRetry();
    }
  }

  // Re-fire the ICE-restart reoffer every RESTART_RETRY_MS while still
  // 'reconnecting'. Each tick supersedes the prior (possibly-unanswered)
  // offer with a fresh one. Self-stops on recovery / fail / teardown via
  // clearRestartRetry, and is a no-op once state leaves 'reconnecting'.
  private startRestartRetry(): void {
    this.clearRestartRetry();
    this.restartRetryTimer = setInterval(() => {
      if (this.state !== 'reconnecting' || this.cancelled) {
        this.clearRestartRetry();
        return;
      }
      if (this.descriptor?.direction !== 'outgoing') {return;}
      void this.retryIceRestartOffer().catch(e => {
        console.warn(`[bravo.callController] ice-restart retry threw: ${(e as Error).message}`);
      });
    }, CallController.RESTART_RETRY_MS);
  }

  /**
   * One retry tick (CALL-05/20). After the FIRST restart offer ships,
   * the PC parks in 'have-local-offer' until the peer's reanswer
   * arrives — so fireIceRestartOffer's stable-only gate skipped EVERY
   * subsequent tick, a lost reoffer frame (peer WS dead, the B-24/B-14
   * field pattern) was never re-sent, and the call died at the 30s
   * budget. When the pending local description is OUR OWN unanswered
   * restart offer, roll it back to 'stable' first so a fresh restart
   * offer can ship.
   *
   * Disambiguation — never roll back someone else's pending offer:
   *  • restartInFlight is only left true by fireIceRestartOffer after
   *    it applied a restart offer, so it marks the pending local
   *    description as ours.
   *  • a mid-flight video-upgrade renegotiation (renegotiationInFlight
   *    / reAnswer awaiter set) is renegotiateLocal's offer — its own
   *    watchdog owns the rollback (see the catch at renegotiateLocal).
   *  • 'have-remote-offer' (glare) has no local description to roll
   *    back; fireIceRestartOffer's gate handles it as before.
   */
  private async retryIceRestartOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.isClosed()) {return;}
    const sigState = (pc.raw as {signalingState?: string}).signalingState;
    if (
      sigState === 'have-local-offer' &&
      this.restartInFlight &&
      !this.renegotiationInFlight &&
      !this.reAnswerResolve
    ) {
      try {
        await pc.rollbackLocalDescription();
        console.log('[bravo.callController] ice-restart retry — rolled back unanswered restart offer');
      } catch (e) {
        console.warn(`[bravo.callController] ice-restart retry rollback failed: ${(e as Error).message}`);
        // Keep restartInFlight set so the next tick retries the rollback.
        return;
      }
      if (this.cancelled || this.state !== 'reconnecting') {return;}
      if (!this.pc || this.pc.isClosed()) {return;}
    }
    // Supersede an in-flight-but-unanswered offer: reset the guard so a
    // fresh reoffer is generated. (On real recovery the ICE 'connected'
    // handler clears restartInFlight + this timer before we get here.)
    this.restartInFlight = false;
    console.log('[bravo.callController] ice-restart retry — re-sending reoffer');
    await this.fireIceRestartOffer();
  }

  private clearRestartRetry(): void {
    if (this.restartRetryTimer) {
      clearInterval(this.restartRetryTimer);
      this.restartRetryTimer = null;
    }
  }

  private startRestartBudget(): void {
    this.clearRestartBudget();
    this.restartBudgetDeadline = Date.now() + CallController.RECONNECT_BUDGET_MS;
    this.armBudgetTimer(CallController.RECONNECT_BUDGET_MS);
  }

  // P2-BR-6 — arm the budget timer against the wall-clock deadline. If the
  // timer was frozen in the background and fires late but the deadline was
  // meanwhile extended by a foreground resume, re-arm for the remaining
  // window instead of flush-failing the call the instant the user returns.
  private armBudgetTimer(ms: number): void {
    this.restartBudgetTimer = setTimeout(() => {
      this.restartBudgetTimer = null;
      if (this.state !== 'reconnecting') {return;}
      const remaining = this.restartBudgetDeadline - Date.now();
      if (remaining > 0) {
        this.armBudgetTimer(remaining);
        return;
      }
      console.warn(`[bravo.callController] reconnect budget exhausted (${CallController.RECONNECT_BUDGET_MS}ms) — ending call`);
      this.clearRestartRetry();
      this.end('failed');
    }, Math.max(0, ms));
  }

  private clearRestartBudget(): void {
    if (this.restartBudgetTimer) {
      clearTimeout(this.restartBudgetTimer);
      this.restartBudgetTimer = null;
    }
  }

  /**
   * P2-BR-6 — the host (useCall) calls this from its AppState-'active'
   * handler. While a mid-call ICE restart is in flight the RN reconnect
   * timers are frozen in the background; without this the frozen budget
   * flushes on resume and kills the call exactly as the user taps back in.
   * On resume we re-probe the live ICE state first: if it recovered while
   * we were away, promote; otherwise grant a FRESH grace window (and
   * re-drive the restart) so the reconnect gets a fair chance from
   * foreground time, not the flushed background clock.
   */
  notifyForeground(): void {
    if (this.cancelled) {return;}
    if (this.state !== 'reconnecting') {return;}
    const ice = (this.pc?.raw as {iceConnectionState?: string} | undefined)?.iceConnectionState;
    if (ice === 'connected' || ice === 'completed') {
      this.clearRestartBudget();
      this.clearRestartRetry();
      this.restartInFlight = false;
      const gap = this.lastDisconnectAt ? (Date.now() - this.lastDisconnectAt) : -1;
      console.log(`[bravo.callController] resume — ice already recovered gapMs=${gap}`);
      this.setState('connected', 'notifyForeground');
      return;
    }
    console.log('[bravo.callController] resume — extending reconnect budget + re-driving restart');
    this.restartBudgetDeadline = Date.now() + CallController.RECONNECT_BUDGET_MS;
    if (!this.restartBudgetTimer) {this.armBudgetTimer(CallController.RECONNECT_BUDGET_MS);}
    if (this.descriptor?.direction === 'outgoing') {
      this.startRestartRetry();
      void this.retryIceRestartOffer().catch(e => {
        console.warn(`[bravo.callController] resume ice-restart retry threw: ${(e as Error).message}`);
      });
    }
  }

  /**
   * P2-BR-6 — the host calls this on AppState 'background'/'inactive'. RN
   * freezes JS timers while backgrounded; pausing the reconnect budget +
   * retry loop here (rather than leaving a setTimeout armed) means nothing
   * flush-fires on resume. notifyForeground re-arms with a fresh window.
   * No-op unless we're mid-reconnect.
   */
  notifyBackground(): void {
    if (this.state !== 'reconnecting') {return;}
    this.clearRestartBudget();
    this.clearRestartRetry();
  }

  /**
   * Caller-side ICE restart. Generates a fresh offer with the
   * iceRestart marker, sends it through the existing reoffer channel,
   * and lets the callee's handleReOffer apply it. The receiver's engine
   * sees the new ice-ufrag and treats the offer as a restart per
   * RFC 5245 §9.1.1 — no special signalling required.
   */
  private async fireIceRestartOffer(): Promise<void> {
    if (!this.pc || this.pc.isClosed()) {return;}
    if (!this.descriptor) {return;}
    if (this.restartInFlight) {return;}
    this.restartInFlight = true;
    const cid = this.descriptor.callId;
    const peer = this.descriptor.peer;
    const tag = `[bravo.callController] cid=${cid.slice(0, 8)} ice-restart`;
    try {
      const sigState = (this.pc.raw as {signalingState?: string}).signalingState;
      if (sigState && sigState !== 'stable') {
        console.warn(`${tag} skipped — signalingState=${sigState}`);
        this.restartInFlight = false;
        return;
      }
      console.log(`${tag} creating restart offer`);
      const offer = await this.pc.createRestartOffer();
      if (this.cancelled || !this.pc || this.pc.isClosed()) {return;}
      console.log(`${tag} sending reoffer (iceRestart), sdpLen=${offer.sdp.length}`);
      this.opts.signalling.sendReOffer(cid, peer, offer.sdp);
      this.lat('reoffer:sent', {restart: true, sdpLen: offer.sdp.length});
      // We don't await a reanswer here — the engine drives recovery off
      // the wire. handleReAnswer below applies the SDP when it arrives.
      // If nothing arrives the budget timer ends the call.
    } catch (e) {
      // B-307 — teardown WINS. With B-301, the receiver of an escalation
      // sees ICE 'disconnected' a beat before the peer's hangup frame, so a
      // restart is routinely in flight when end() closes the PC — the engine
      // then rejects with "Called in wrong state: closed". That is the
      // EXPECTED outcome of losing the race, not a defect: stay quiet, touch
      // nothing (end() already cleared the restart machinery). The noisy
      // warn here sent a device session chasing a controller bug that
      // wasn't one.
      if (this.cancelled || this.state === 'ended' || this.state === 'failed') {
        return;
      }
      console.warn(`${tag} threw: ${(e as Error).message}`);
      this.restartInFlight = false;
    }
  }

  /**
   * Audit P0-C5 — ring timer expired without an answer / accept. Emits
   * hangup so the peer stops ringing, surfaces the missed-call record
   * to the host, then ends the call. Snapshot the descriptor BEFORE
   * `end()` runs because `end()` nulls it.
   */
  private handleRingExpire(e: RingExpireEvent): void {
    if (!this.descriptor || this.descriptor.callId !== e.callId) {return;}
    if (this.state === 'ended' || this.state === 'failed') {return;}
    const snapshot = {...this.descriptor};
    try {
      this.opts.signalling.sendHangup(snapshot.callId, snapshot.peer, 'ended');
    } catch (err) {
      console.warn(`[bravo.callController] ring-expire sendHangup threw: ${(err as Error).message}`);
    }
    this.end('ended');
    try {
      this.opts.onMissedCall?.({
        callId:    snapshot.callId,
        peer:      snapshot.peer,
        direction: e.direction,
        kind:      snapshot.kind,
      });
    } catch (err) {
      console.warn(`[bravo.callController] onMissedCall threw: ${(err as Error).message}`);
    }
  }

  private end(next: 'ended' | 'failed'): void {
    // Idempotent — multiple paths can hit end() (peer hangup + ICE
    // failed + user tap can race). Subsequent calls become no-ops so
    // we don't double-fire onState or double-detach handlers.
    if (this.state === 'ended' || this.state === 'failed') {return;}
    // Why: NA-05 — the setup budget now spans the whole ring window, and paths
    // like peer-hangup / ICE hard-fail reach here WITHOUT a sendHangup, so
    // nothing else would stop a queued offer/answer from shipping for a call
    // that is already dead.
    if (this.descriptor) {
      try { this.opts.signalling.cancelPending(this.descriptor.callId); }
      catch { /* best-effort */ }
    }
    // Flip cancelled FIRST so any in-flight async loop (the DTLS
    // polling in onIceConnected, in particular) bails before touching
    // pc / descriptor on its next iteration.
    this.cancelled = true;
    // Reject any in-flight renegotiation so the host's promise unwinds
    // (and its rollback path runs — stop the new track, etc.) instead
    // of hanging until the watchdog fires. Run BEFORE pc.close so the
    // host's catch handler can still introspect the PC if it wants to.
    if (this.reAnswerReject) {
      try { this.reAnswerReject(new Error(`renegotiate: call ${next} mid-renegotiation`)); }
      catch { /* ignore */ }
      this.reAnswerResolve = null;
      this.reAnswerReject  = null;
    }
    // Audit P0-C5 — clear any armed ring timer so a teardown mid-ring
    // doesn't fire a stray missed-call event after we've already gone
    // terminal.
    this.ringState.cancelAll();
    // Stop the ICE-restart budget timer + retry loop + clear the in-flight
    // flag so a fresh controller can run without inherited reconnect state.
    this.clearRestartBudget();
    this.clearRestartRetry();
    this.restartInFlight = false;
    // B-62 — a terminal call must never fire the connecting watchdog.
    if (this.connectingWatchdog) {
      clearTimeout(this.connectingWatchdog);
      this.connectingWatchdog = null;
    }
    this.pc?.close();
    this.pc = null;
    this.descriptor = null;
    this.pendingOfferSdp = null;
    // Reset the ICE gate + queue so a subsequent call (same controller
    // instance) starts with a clean slate. Without this, a stale flag
    // or stale candidates from a previous call could leak into the
    // next one and either drop fresh candidates or replay old ones.
    this.remoteDescriptionApplied = false;
    this.pendingIce.length = 0;
    // B-273 — the OUTBOUND gate is per-call too. A reused controller that
    // kept `outboundSignalled = true` would send the next call's first
    // candidates before its offer, which is the bug this gate exists for.
    this.outboundSignalled = false;
    this.outboundIce.length = 0;
    this.renegotiationInFlight = null;
    // P1-BR-6 — clear the verify latches so a reused controller instance
    // re-verifies DTLS-SRTP on its next call.
    this.dtlsVerified = false;
    this.dtlsPolling  = false;
    // Detach our signalling handlers — see signallingUnsubs comment at
    // declaration site. Run before setState so a synchronous
    // onState('ended') consumer can't ingest a frame and re-fire us.
    for (const u of this.signallingUnsubs.splice(0)) {
      try { u(); } catch { /* ignore */ }
    }
    this.setState(next, 'end');
  }

  private setState(next: CallState, src = 'unknown'): void {
    // Terminal-state guard. Once a call is 'ended' or 'failed' it must
    // STAY that way — no path can flip it back. Without this guard,
    // late-arriving asyncs (handleAnswer post-hangup, onIceConnected's
    // 6s DTLS poll resolving after end(), oniceconnectionstatechange
    // firing 'failed' on a closing pc) could drive us back to a non-
    // terminal state and leak the call into "Connecting…" forever on a
    // dead controller. Cheap, makes the rest of the codebase safer to
    // reason about.
    //
    // WI-2.1 keeps this as its own branch rather than folding it into the
    // table below: terminal absorption is the one rule that pre-dates the
    // table, it has its own long-standing log line, and a self-transition
    // (`ended`→`ended`) must stay silent.
    if (this.state === 'ended' || this.state === 'failed') {
      if (next !== this.state) {
        console.warn(`[bravo.callController] setState(${next}) ignored — already terminal (${this.state})`);
      }
      return;
    }
    // WI-2.1 — every other transition goes through the table. A rejected
    // transition changes NOTHING: not the state, and not the watchdog below.
    // The live case this closes is `connected → connecting`: `handleAnswer`
    // awaits `acceptAnswer` then `drainPendingIce` and only then writes
    // 'connecting', so when ICE completes during those awaits the late write
    // dragged a healthy call backwards AND re-armed the 20 s connecting
    // watchdog against it — hanging the call up as `failed` twenty seconds
    // into a working conversation.
    if (next !== this.state && !LEGAL_TRANSITIONS[this.state].includes(next)) {
      console.warn(`[CALLSM] illegal ${this.state}→${next} src=${src}`);
      return;
    }
    // WI-7.1 — the accepted-transition record (the rejected forms above and
    // in the terminal guard are long-standing and pinned; this completes the
    // lane so a release logcat reconstructs the whole lifecycle). Silent for
    // self-transitions — a re-assert is not a lifecycle event.
    if (next !== this.state) {
      logCallTransition({
        callId: this.descriptor?.callId ?? this.claimedCallId,
        prev: this.state, next, event: src, source: 'controller',
      });
      // [CALLLAT] — the accepted transition is a waterfall row too; a terminal
      // state closes the lane clock so a reused controller/callId starts fresh.
      this.lat(`state:${next}`, {src});
      if (next === 'ended' || next === 'failed') {
        endCallLatLane(this.latLane, this.descriptor?.callId ?? this.claimedCallId);
      }
    }
    this.state = next;
    // B-62 — arm/clear the 'connecting' watchdog on the transition itself
    // so BOTH paths into 'connecting' (callee accept → sendAnswer, caller
    // handleAnswer → acceptAnswer) are covered without per-call-site code.
    if (this.connectingWatchdog) {
      clearTimeout(this.connectingWatchdog);
      this.connectingWatchdog = null;
    }
    if (next === 'connecting') {
      this.armConnectingWatchdog();
    }
    this.opts.onState(next);
  }

  /**
   * B-62 watchdog arm, extracted so NA-05 can re-arm it the moment the
   * outgoing `call.answer` actually reaches the socket. Idempotent —
   * re-arming clears any previous handle first.
   */
  private armConnectingWatchdog(budgetMs?: number): void {
    if (this.connectingWatchdog) {
      clearTimeout(this.connectingWatchdog);
      this.connectingWatchdog = null;
    }
    const budget = budgetMs ?? this.opts.connectingWatchdogMs ?? CONNECTING_WATCHDOG_MS;
    this.connectingWatchdog = setTimeout(() => {
      this.connectingWatchdog = null;
      if (this.state !== 'connecting') {return;}
      // Defensive re-check before killing the call: if OUR pc's ICE agent
      // actually reached connected but the state-change event was missed
      // (the cold-answer path has a documented double-mount/registration
      // race), promote instead of hanging up a working media path.
      const ice = (this.pc?.raw as {iceConnectionState?: string} | undefined)?.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') {
        console.warn('[WEBRTC] connecting-watchdog: ICE already connected — promoting (missed event)');
        this.setState('connected', 'connecting-watchdog-probe');
        return;
      }
      console.warn(`[WEBRTC] connecting-watchdog fired after ${budget}ms — ending call as failed`);
      this.hangup('failed');
    }, budget);
  }

  private buildPc(callId: string, peer: SessionAddress): PeerConnectionWrapper {
    const w = new PeerConnectionWrapper({
      factory:    this.opts.pcFactory,
      iceServers: this.opts.iceServers,
    });
    // ── Diagnostic state-tracing ────────────────────────────
    // Logs every ICE / DTLS / signaling state transition with a
    // [WEBRTC] tag so logcat / Metro console can be grepped to figure
    // out exactly where a stuck call is stuck. The information is the
    // dispositive evidence for diagnosing "stuck on connecting" vs
    // "DTLS failed" vs "ICE never gathered" — without it, every fix
    // attempt is a guess. Cheap (one console.log per state change) and
    // safe to leave in until the call stack is fully stable.
    const role = this.descriptor?.direction ?? '?';
    const tag = `[WEBRTC] cid=${callId.slice(0, 8)} role=${role}`;
    const pc = w.raw as unknown as {
      iceConnectionState?: string;
      connectionState?:    string;
      signalingState?:     string;
      iceGatheringState?:  string;
      onconnectionstatechange?:    (() => void) | null;
      onsignalingstatechange?:     (() => void) | null;
      onicegatheringstatechange?:  (() => void) | null;
    };
    console.log(`${tag} pc-built`);
    pc.onconnectionstatechange = () => {
      console.log(`${tag} connectionState=${pc.connectionState}`);
    };
    pc.onsignalingstatechange = () => {
      console.log(`${tag} signalingState=${pc.signalingState}`);
    };
    pc.onicegatheringstatechange = () => {
      console.log(`${tag} iceGatheringState=${pc.iceGatheringState}`);
    };
    // Trickle ICE outward. The handler fires with an
    // RTCPeerConnectionIceEvent whose `.candidate` is the actual
    // RTCIceCandidate (or null on the end-of-candidates sentinel).
    // Treating the raw event as the candidate (the previous code) sent
    // {candidate: <object>, sdpMid: undefined} on the wire, which the
    // receiver's `addIceCandidate` cannot consume — every candidate
    // silently failed and ICE never connected.
    w.raw.onicecandidate = (event: {candidate?: {candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null} | null}) => {
      const candidate = event?.candidate;
      if (!candidate?.candidate) {
        console.log(`${tag} ice-cand=end-of-candidates`);
        return;
      }
      console.log(`${tag} ice-cand mid=${candidate.sdpMid ?? '?'} idx=${candidate.sdpMLineIndex ?? '?'} type=${candidate.candidate.split(' ')[7] ?? '?'}`);
      if (!this.latFirstLocalCandidate) {
        this.latFirstLocalCandidate = true;
        // Candidate TYPE is an enum (host/srflx/relay), never the address.
        this.lat('ice:first-local', {type: candidate.candidate.split(' ')[7] ?? '?'});
      }
      const out = {
        candidate:     candidate.candidate,
        sdpMid:        candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      };
      // B-273 — the relay silently drops ICE for a callId whose offer it
      // has not seen yet. Queue until our offer/answer is on the wire.
      if (!this.outboundSignalled) {
        if (this.outboundIce.length >= CallController.MAX_PENDING_ICE) {
          this.outboundIce.shift();
        }
        this.outboundIce.push(out);
        return;
      }
      this.opts.signalling.sendIce(callId, peer, out as IceCandidateInit, this.restartInFlight);
    };
    w.raw.oniceconnectionstatechange = () => {
      // The handler fires with an Event (or no arg in some impls) — the
      // current ICE state lives on the peer connection itself, not the
      // event. Reading `state` as the first arg (the previous code) made
      // the equality check always false, so the call never transitioned
      // to 'connected' and stayed in 'connecting' / 'answering' forever.
      const ice = (w.raw as unknown as {iceConnectionState: string}).iceConnectionState;
      console.warn(`[CALLDIAG] ${tag} iceConnectionState=${ice}`);
      this.lat(`ice:${ice}`);
      if (ice === 'connected' || ice === 'completed') {
        this.everConnected = true;
        // Recovery path — if a restart was in flight, clear it and flip
        // back from 'reconnecting' to 'connected' without re-running
        // the full DTLS poll (DTLS context survived the ICE restart).
        if (this.restartInFlight || this.state === 'reconnecting') {
          this.clearRestartBudget();
          this.clearRestartRetry();
          this.restartInFlight = false;
          const gap = this.lastDisconnectAt ? (Date.now() - this.lastDisconnectAt) : -1;
          console.log(`${tag} ice-restart-recovered gapMs=${gap}`);
          this.setState('connected', 'ice-connected');
          return;
        }
        // P1-BR-6 (B-60/B-61) — the ICE agent proved connectivity, so
        // promote to 'connected' RIGHT HERE (idempotent). This arms the
        // duration timer + flips the status even if the DTLS-SRTP stats
        // probe below stalls in the native bridge. Doing this in the ICE
        // event (not gated on the poll's latch) also means a later ICE
        // event still re-promotes. DTLS-SRTP verification still runs
        // UNCONDITIONALLY as a follow-up gate and end('failed')s the call
        // on GENUINE verification failure — only a stats-layer stall can
        // no longer withhold a state the media path already earned.
        if (this.state !== 'connected') {this.setState('connected', 'ice-completed');}
        void this.onIceConnected().catch((err) => {
          console.log(`${tag} onIceConnected-error msg=${(err as Error)?.message ?? err}`);
          this.end('failed');
        });
      } else if (ice === 'disconnected') {
        // Recoverable — give it a chance. Per W3C, 'disconnected' can
        // self-heal (transient packet loss) or progress to 'failed' for
        // a hard break. Start a 30s budget and, if we're the offerer,
        // fire an ICE restart reoffer. The callee just waits — the
        // offerer drives the restart.
        this.onIceDisconnected();
      } else if (ice === 'failed') {
        this.onIceFailed();
      }
    };
    return w;
  }
}
