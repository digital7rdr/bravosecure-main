import type {
  CallId,
  CallControlAuth,
  CallOfferAuth,
  SessionAddress,
  ServerCallOffer,
  ServerCallAnswer,
  ServerCallIce,
  ServerCallHangup,
  ServerCallMediaState,
  ServerCallReOffer,
  ServerCallReAnswer,
  ServerFrame,
  TransportClient,
} from '@bravo/messenger-core';
import type {HangupReason, IceCandidateInit, CallKind} from './types';
import {logCallLat} from '../runtime/callDiag';

// [CALLLAT] (audit Step 0) — the instant a setup frame reaches socket.emit,
// with how long it waited for an open transport. Only the two frames that
// gate the peer's ICE (offer → callee, answer → caller) are waterfall rows.
function latSetupFrameEmitted(event: string, callId: string | undefined, waitMs: number): void {
  if (event === 'call.offer') {
    logCallLat('1to1-out', callId, 'offer:emitted', {waitMs});
  } else if (event === 'call.answer') {
    logCallLat('1to1-in', callId, 'answer:emitted', {waitMs});
  }
}

/**
 * Call-oriented wrapper over the app's WebSocket transport.
 *
 * Doesn't own the transport — borrows it. Multiple CallSignalling
 * instances CAN coexist against the same transport (e.g. if the app
 * wanted to support simultaneous calls) because each subscribes only
 * to frames that match its own callId set.
 *
 * The gateway is a pure relay for call.* frames (see M8 server), so
 * offer/answer/ICE pass through verbatim — no store, no tampering.
 */
/**
 * NA-05 — how long a call-setup frame may wait for the transport.
 *
 * The SN-05 value (12s) was chosen to stay INSIDE the 20s connecting watchdog
 * and the 45s ring timeout. That was backwards: giving up at 12s abandons the
 * frame while the call is still alive, and nothing ever re-sends it. A WS
 * outage of 12-20s therefore produced "callee answered → Call failed at 20s
 * while the caller kept ringing".
 *
 * The real gate is TERMINALITY, not the clock: `cancelledCalls` is now marked
 * by the controller's end() as well as sendHangup, so a hung-up / peer-hungup /
 * watchdog-killed call abandons its pending setup frame on the next 100ms tick.
 * This ceiling is only a leak-stop for the case where the call is somehow never
 * torn down; it sits just under the 45s ring window so a delivered-late offer
 * still gets the callee a few seconds of ring.
 */
import {CALL_SETUP_SEND_BUDGET_MS, ICE_WAIT_OPEN_MS} from './callDeadlines';

export class CallSignalling {
  // Multi-subscriber arrays. Older code used a single-slot `xHandler`
  // setter, which silently overwrote when a stale CallController
  // (e.g. from a previous mount that hadn't fully torn down) was still
  // wired up — the new instance would clobber the old one's handler,
  // and frames the old controller still cared about for cleanup would
  // be dropped. Switching to arrays makes registration additive and
  // returns an explicit unregister fn so a controller's end() can
  // remove ITS handler without touching anyone else's.
  private offerHandlers:      Array<(f: ServerCallOffer['data'])      => void> = [];
  private answerHandlers:     Array<(f: ServerCallAnswer['data'])     => void> = [];
  private iceHandlers:        Array<(f: ServerCallIce['data'])        => void> = [];
  private hangupHandlers:     Array<(f: ServerCallHangup['data'])     => void> = [];
  /**
   * BS-021 — peer media-state advisory handlers. Receivers register
   * via `onMediaState(...)`; sender path is `sendMediaState(...)`.
   */
  private mediaStateHandlers: Array<(f: ServerCallMediaState['data']) => void> = [];
  /** WI-1.4 — owner → its currently-installed media-state handler. */
  private mediaStateOwners = new Map<string, (f: ServerCallMediaState['data']) => void>();
  /**
   * Mid-call SDP renegotiation handlers — voice→video upgrade. Same
   * multi-subscriber pattern as the rest. Routed by callId on the
   * controller side so a stale handler from a previous call can't
   * react to a fresh upgrade on a different call.
   */
  private reOfferHandlers:    Array<(f: ServerCallReOffer['data'])    => void> = [];
  private reAnswerHandlers:   Array<(f: ServerCallReAnswer['data'])   => void> = [];

  constructor(private readonly transport: TransportClient) {}

  /**
   * WI-5.3 (transport G5) — resolve the LIVE transport per send instead of
   * riding the constructor capture forever. After `disposeLiveRuntime()` →
   * rebuild, the captured instance is a closed corpse whose send() throws;
   * every frame from a call surviving the rebuild (restore, account-switch
   * teardown races) was thrown-and-swallowed while `getLiveTransport()` held
   * a healthy replacement. The constructor param stays as the fallback: the
   * registry is empty in unit tests (and before the runtime boots), and
   * falling back preserves the old behaviour exactly there.
   */
  private liveTransport(): TransportClient {
    try {
      const {getLiveTransport} = require('../runtime/transportRegistry') as
        typeof import('../runtime/transportRegistry');
      const live = getLiveTransport();
      if (live) {return live;}
    } catch { /* registry unavailable (tests / early boot) — fall back */ }
    return this.transport;
  }

  /**
   * Plug into the transport's onFrame — the host app owns the single
   * subscription and routes call.* frames here. Call this once from
   * the place that constructs the transport.
   */
  ingest(frame: ServerFrame): void {
    // Snapshot the handler list before iterating: a handler is allowed
    // to call its own unregister() (controller.end on hangup), which
    // splices the array. Iterating the live array would skip the next
    // handler in that case.
    switch (frame.event) {
      case 'call.offer':        for (const h of this.offerHandlers.slice())      {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.answer':       for (const h of this.answerHandlers.slice())     {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.ice':          for (const h of this.iceHandlers.slice())        {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.hangup':       for (const h of this.hangupHandlers.slice())     {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.media-state':  for (const h of this.mediaStateHandlers.slice()) {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.reoffer':      for (const h of this.reOfferHandlers.slice())    {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.reanswer':     for (const h of this.reAnswerHandlers.slice())   {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      default:
        // Non-call frame — transport delegates these elsewhere.
        return;
    }
  }

  onOffer (h: (f: ServerCallOffer['data'])  => void): () => void {
    this.offerHandlers.push(h);
    return () => { this.offerHandlers = this.offerHandlers.filter(x => x !== h); };
  }
  onAnswer(h: (f: ServerCallAnswer['data']) => void): () => void {
    this.answerHandlers.push(h);
    return () => { this.answerHandlers = this.answerHandlers.filter(x => x !== h); };
  }
  onIce   (h: (f: ServerCallIce['data'])    => void): () => void {
    this.iceHandlers.push(h);
    return () => { this.iceHandlers = this.iceHandlers.filter(x => x !== h); };
  }
  onHangup(h: (f: ServerCallHangup['data']) => void): () => void {
    this.hangupHandlers.push(h);
    return () => { this.hangupHandlers = this.hangupHandlers.filter(x => x !== h); };
  }
  /**
   * BS-021 — receive peer-mute / peer-camera-off advisories. Returns an
   * unregister fn so the receiving hook (useCall) can remove its
   * handler on unmount without touching anyone else's.
   */
  onMediaState(h: (f: ServerCallMediaState['data']) => void): () => void {
    this.mediaStateHandlers.push(h);
    return () => { this.mediaStateHandlers = this.mediaStateHandlers.filter(x => x !== h); };
  }
  /**
   * WI-1.4 — registration that REPLACES the previous handler for the same
   * owner.
   *
   * `onMediaState` is additive, which is right for genuinely independent
   * subscribers but wrong for the one that keeps coming back: every
   * minimize→restore adopts the SAME `CallSignalling` and binds a fresh
   * advisory handler for the same call, and nothing ever removed the previous
   * mount's. After N restores a single peer camera toggle ran N handlers, each
   * writing into a dead React tree and each firing its own registry patch (so
   * N notify storms per advisory), and the composed unregister chain grew with
   * it.
   *
   * Ownership is the fix: N registrations under one owner leave exactly ONE
   * live handler. The returned disposer is identity-guarded, so an older
   * mount's late teardown cannot remove the handler that replaced it.
   */
  onMediaStateOwned(owner: string, h: (f: ServerCallMediaState['data']) => void): () => void {
    const prev = this.mediaStateOwners.get(owner);
    if (prev) {
      this.mediaStateHandlers = this.mediaStateHandlers.filter(x => x !== prev);
    }
    this.mediaStateOwners.set(owner, h);
    this.mediaStateHandlers.push(h);
    return () => {
      if (this.mediaStateOwners.get(owner) === h) { this.mediaStateOwners.delete(owner); }
      this.mediaStateHandlers = this.mediaStateHandlers.filter(x => x !== h);
    };
  }
  /** Test/diagnostic probe for the WI-1.4 one-live-handler invariant. */
  mediaStateHandlerCount(): number { return this.mediaStateHandlers.length; }
  /**
   * Mid-call renegotiation — the controller subscribes to react to a
   * peer-initiated voice→video upgrade. callId match is enforced on
   * the controller side.
   */
  onReOffer(h: (f: ServerCallReOffer['data']) => void): () => void {
    this.reOfferHandlers.push(h);
    return () => { this.reOfferHandlers = this.reOfferHandlers.filter(x => x !== h); };
  }
  onReAnswer(h: (f: ServerCallReAnswer['data']) => void): () => void {
    this.reAnswerHandlers.push(h);
    return () => { this.reAnswerHandlers = this.reAnswerHandlers.filter(x => x !== h); };
  }

  /**
   * All send paths funnel through here so a closed-transport throw
   * ("transport not open") cannot escape into a React unmount cleanup
   * and corrupt the fiber tree. CallScreen tearing down after the
   * peer hung up is the worst-case path: the WS already closed, our
   * cleanup calls controller.hangup() → sendHangup() → transport.send()
   * → throws → React's commit phase explodes → app freezes.
   *
   * Best-effort semantics are correct for call.* frames: if the
   * transport is gone the peer either already saw the hangup (because
   * they triggered it) or will time out on their own after the
   * heartbeat window. Either way, dropping the local ack is fine.
   *
   * Tagged for logcat: [bravo.signalling].
   */
  private safeSend(event: string, data: unknown): void {
    this.trySend(event, data);
  }

  /**
   * SN-05 — same best-effort semantics as `safeSend`, but REPORTS whether the
   * frame actually reached the socket. `waitOpenThenSend` needs the truth:
   * silently swallowing the throw is what let call setup frames vanish while
   * the caller believed they had been sent.
   */
  private trySend(event: string, data: unknown): boolean {
    try {
      this.liveTransport().send({event, data} as Parameters<TransportClient['send']>[0]);
      return true;
    } catch (e) {
      console.warn(`[bravo.signalling] ${event} dropped — transport closed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Wait briefly for the WS to come up, then send. Used for OFFER only —
   * if we drop the initial offer the call is dead on arrival (peer
   * never rings). Common path: user opens chat right after restore /
   * cold-start, taps Call before the WS reconnect handshake finishes.
   * The transport's onStateChange would normally drain this in 1-2s.
   *
   * timeoutMs is a hard cap. After timeout we fall back to safeSend
   * which logs + drops; the caller's CallScreen state machine will
   * surface "Connecting…" → "Could not connect" so the user can retry.
   */
  private async waitOpenThenSend(
    event: string,
    data: unknown,
    timeoutMs = 4000,
    callId?: CallId,
  ): Promise<boolean> {
    // SN-05 — retry until the frame ACTUALLY reaches socket.emit.
    //
    // Two defects lived here. First, the loop gated on the transport's
    // `state` LABEL, then called safeSend, which swallows the
    // 'transport not open' throw — so whenever the label led `socket.connected`
    // the frame was dropped while this method reported success. Second, the
    // hard 4s cap then fell through to one more best-effort send whose
    // comment claimed "socket.io buffers+flushes". It does not: the wrapper's
    // connected-guard throws BEFORE socket.emit is reached, so nothing is ever
    // buffered (pinned by transportBestEffort.test.ts). A dropped call.offer
    // leaves the caller on "Calling…" for the full 45s ring timeout with the
    // callee never ringing; a dropped call.answer wedges the callee until the
    // 20s connecting watchdog. `trySend` reports real success so the loop can
    // keep trying across a reconnect instead of failing silently.
    const t0 = Date.now();
    for (;;) {
      // A call the user already cancelled must not hold the per-callId queue
      // (hangup chains behind offer) — bail so End takes effect immediately.
      if (callId !== undefined && this.cancelledCalls.has(callId)) {
        console.warn(`[bravo.signalling] ${event} — call ${callId} cancelled before send; dropping`);
        return false;
      }
      // Gate on the state label as before — ordering guarantees depend on not
      // emitting into a transport that reports itself down. The change is that
      // a send which THROWS anyway (label leading `socket.connected`) no longer
      // counts as delivered: we keep looping until it genuinely lands.
      const s = (this.liveTransport() as unknown as {state?: string}).state;
      if (s === 'connected' && this.trySend(event, data)) {
        latSetupFrameEmitted(event, callId, Date.now() - t0);
        return true;
      }
      if (Date.now() - t0 >= timeoutMs) {break;}
      await new Promise(r => setTimeout(r, 100));
    }
    // Budget exhausted. One final unconditional attempt: the state label can
    // trail a socket that is in fact usable, and this costs nothing when it is
    // not. NOTE — the pre-SN-05 comment here claimed socket.io would buffer
    // and flush this frame on reconnect. It does not: TransportClient.send()
    // throws on `!socket.connected` BEFORE socket.emit is reached, so nothing
    // is ever queued (pinned by transportBestEffort.test.ts). That false
    // premise is why a dropped offer/answer looked survivable; the retry loop
    // above is what actually delivers these frames now.
    if (!this.trySend(event, data)) {
      console.warn(`[bravo.signalling] ${event} — transport never opened within ${timeoutMs}ms; frame dropped`);
      return false;
    }
    latSetupFrameEmitted(event, callId, Date.now() - t0);
    return true;
  }

  // Per-callId send queue. Without this, sendOffer (queued via
  // waitOpenThenSend on a slow transport) would race sendHangup
  // (immediate fire-and-drop) — the user could dial then instantly
  // cancel, see hangup silently dropped because the WS hadn't opened
  // yet, then watch the offer fly out 2s later when the WS came up.
  // Peer rings forever for a call we cancelled. Fix: every call.* frame
  // for a given callId chains off the previous send for that callId so
  // hangup always lands AFTER offer (or after answer, on the answerer).
  private callIdQueues = new Map<CallId, Promise<unknown>>();
  /**
   * SN-05 — callIds the user has already hung up. `waitOpenThenSend` checks
   * this so a setup frame waiting on a reconnect cannot hold the per-callId
   * queue (hangup chains behind offer) and delay End by the whole budget.
   */
  private cancelledCalls = new Set<CallId>();
  private enqueueForCall<T>(callId: CallId, work: () => Promise<T>): Promise<T> {
    const prev = this.callIdQueues.get(callId) ?? Promise.resolve();
    const next = prev.catch(() => {/* don't propagate prior failures */}).then(work);
    // Track the latest tail so we can chain again. Clean up when this
    // tail resolves AND nothing newer was chained.
    this.callIdQueues.set(callId, next);
    void next.finally(() => {
      if (this.callIdQueues.get(callId) === next) {
        this.callIdQueues.delete(callId);
        // SN-05 — the queue for this call has drained; drop its cancellation
        // marker so the set cannot grow for the life of the process.
        this.cancelledCalls.delete(callId);
      }
    });
    return next;
  }

  /**
   * B-273 — returns when the offer has actually reached `socket.emit`, not
   * when it was queued. The controller needs that edge: the relay drops
   * `call.ice` for a callId it has not seen an offer for, so outbound
   * candidates must be held until this resolves. Callers that don't care may
   * still ignore the result.
   */
  sendOffer(callId: CallId, to: SessionAddress, sdp: string, kind: CallKind, auth?: CallOfferAuth): Promise<boolean> {
    // Audit S7 — caller-identity binding rides on the same frame; relay
    // passes it through verbatim. Omitting `auth` ships an unsigned
    // offer (rollout window only — receivers fail-closed once telemetry
    // is clean).
    return this.enqueueForCall(callId, () =>
      this.waitOpenThenSend(
        'call.offer',
        auth ? {callId, to, sdp, kind, auth} : {callId, to, sdp, kind},
        CALL_SETUP_SEND_BUDGET_MS, callId,
      ));
  }
  sendAnswer(callId: CallId, to: SessionAddress, sdp: string, auth?: CallControlAuth): Promise<boolean> {
    // Same wait-open semantics as offer — accepting an incoming call
    // right after waking the device is the mirror case where the WS
    // may still be reconnecting.
    //
    // Audit P1-C3 — answerer-identity binding rides on the same frame;
    // relay passes it through verbatim. Omitting `auth` ships an
    // unsigned answer (rollout window only — receivers fail-closed once
    // telemetry is clean).
    //
    // NA-05 — resolves true only when the frame actually reached socket.emit.
    // The controller starts its connecting watchdog off this, not off accept().
    return this.enqueueForCall(callId, () =>
      this.waitOpenThenSend(
        'call.answer',
        auth ? {callId, to, sdp, auth} : {callId, to, sdp},
        CALL_SETUP_SEND_BUDGET_MS, callId,
      ));
  }
  /**
   * Mid-call renegotiation send paths. Use waitOpenThenSend like the
   * initial offer/answer: the user might tap Camera right as the WS
   * is recovering from a brief drop, and we don't want to silently
   * drop the upgrade. The controller's watchdog still reverts the
   * local addTrack if the round-trip never completes.
   */
  sendReOffer(callId: CallId, to: SessionAddress, sdp: string): void {
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.reoffer', {callId, to, sdp}));
  }
  sendReAnswer(callId: CallId, to: SessionAddress, sdp: string): void {
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.reanswer', {callId, to, sdp}));
  }
  /**
   * WI-5.6 (transport G2/G3) — per-call buffer for trickle ICE produced
   * while the socket is down. The transport's send() THROWS before socket.io
   * could ever buffer, so "fire-and-forget" meant every candidate during a
   * 1–3 s WS blip was silently lost — no server replay lane exists, and the
   * handshake stranded. Bounded exactly like the two sibling ICE queues
   * (drop-OLDEST at 64; see CallController.MAX_PENDING_ICE's rationale).
   */
  private static readonly MAX_BUFFERED_ICE = 64;
  private outboundIceBuffers = new Map<CallId, Array<Record<string, unknown>>>();

  private drainIceBuffer(callId: CallId): Promise<void> {
    return this.enqueueForCall(callId, async () => {
      // Round 1 P2 — ONE deadline for the whole drain, not per candidate.
      // This drain shares the per-callId queue with reOffer/reAnswer/
      // mediaState; per-candidate budgets on a flapping socket could hold a
      // chained reanswer past the peer's ~8 s rollback watchdog. A socket
      // down longer than the window is the ICE-restart path's problem, and
      // stale candidates would only chase a dead handshake.
      const deadline = Date.now() + ICE_WAIT_OPEN_MS;
      for (;;) {
        const buf = this.outboundIceBuffers.get(callId);
        const next = buf?.shift();
        if (next === undefined) {
          this.outboundIceBuffers.delete(callId);
          return;
        }
        const remaining = Math.max(0, deadline - Date.now());
        const ok = remaining > 0 && await this.waitOpenThenSend('call.ice', next, remaining, callId);
        if (!ok) {
          const dropped = (this.outboundIceBuffers.get(callId)?.length ?? 0);
          this.outboundIceBuffers.delete(callId);
          if (dropped > 0) {
            console.warn(`[bravo.signalling] call.ice buffer dropped ${dropped} candidate(s) — socket never opened within ${ICE_WAIT_OPEN_MS}ms`);
          }
          return;
        }
      }
    });
  }

  sendIce(callId: CallId, to: SessionAddress, cand: IceCandidateInit, duringRestart = false): void {
    const payload = {
      callId, to,
      candidate: cand.candidate,
      sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex,
    };
    // BS-CALL2 — during an ICE-restart (screen-off Doze, Wi-Fi↔cellular
    // handover) the restart re-offer has NOT yet been applied by the peer,
    // so these candidates are NOT late; wait for the WS like reOffer does.
    if (duringRestart) {
      void this.enqueueForCall(callId, () => this.waitOpenThenSend('call.ice', payload));
      return;
    }
    // Normal trickle: the immediate path stays first — zero added latency
    // while the socket is healthy, and the peer's dispatcher already queues
    // pre-remote-description ICE. Only a FAILED send buffers (WI-5.6): the
    // candidate is not late, the socket is just briefly down.
    if (this.trySend('call.ice', payload)) {return;}
    let buf = this.outboundIceBuffers.get(callId);
    if (!buf) {
      buf = [];
      this.outboundIceBuffers.set(callId, buf);
    }
    if (buf.length >= CallSignalling.MAX_BUFFERED_ICE) {
      buf.shift(); // drop-OLDEST — a fresh, possibly-better candidate still lands
    }
    buf.push(payload);
    // One drainer is scheduled per buffer FILL (a drain that raced a late
    // push chains a second, harmless pass behind itself on the per-callId
    // queue). Ordering note, honestly: candidates that succeeded on the
    // immediate path can overtake buffered older ones — trickle ICE is
    // order-insensitive by design (see CallController's queue rationale), so
    // only the buffered subset is kept in order.
    if (buf.length === 1) {
      void this.drainIceBuffer(callId);
    }
  }
  /**
   * Hangup MUST chain after any pending offer/answer for the same
   * callId. The rapid-hangup regression we shipped: user taps Call →
   * sendOffer goes into waitOpenThenSend (transport reconnecting); user
   * instantly taps End → sendHangup used safeSend (drops because WS
   * still down) → 2s later WS opens → offer flushes → peer rings
   * forever for a cancelled call. With per-callId queueing, the
   * hangup is enqueued BEHIND the offer; when the WS opens the offer
   * sends, then immediately the hangup. Peer gets a one-tick ring,
   * not an unanswerable forever-call. Short timeout (1500ms) because
   * if the WS hasn't opened by then the call wasn't going anywhere
   * anyway and we don't want to block the controller's end() path.
   */
  sendHangup(callId: CallId, to: SessionAddress, reason: HangupReason): void {
    // SN-05 — mark BEFORE enqueuing so a setup frame still waiting on a
    // reconnect bails on its next tick instead of holding this queue for the
    // full budget. Strictly better than the old one-tick-ring outcome: a
    // cancelled call now never rings the peer at all.
    this.cancelledCalls.add(callId);
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.hangup', {callId, to, reason}, 1500));
  }
  /**
   * NA-05 — abandon a setup frame that is still waiting on a reconnect.
   *
   * `sendHangup` already marks the call, but a controller can go terminal
   * WITHOUT sending one (peer hangup, ICE hard-fail, sign-out teardown). With
   * the setup budget now spanning the whole ring window, an unmarked call
   * could ship an offer/answer for a call that is already dead. Guarded on an
   * live queue so the marker set cannot grow for the life of the process —
   * `enqueueForCall`'s drain handler is what removes it.
   *
   * Note this cannot suppress `call.hangup`: that send deliberately does not
   * pass `callId` into `waitOpenThenSend`, so it is not cancellable.
   */
  cancelPending(callId: CallId): void {
    // WI-5.6 — a cancelled call must not keep draining buffered candidates.
    this.outboundIceBuffers.delete(callId);
    if (!this.callIdQueues.has(callId)) {return;}
    this.cancelledCalls.add(callId);
  }
  /**
   * BS-021 — emit peer-mute / peer-camera-off advisory to the active
   * peer. Best-effort like the rest of the call.* sends: a closed
   * transport drops the frame silently (the call would already be
   * tearing down anyway). Receiver flips a placeholder in the remote
   * tile so the user can distinguish a frozen feed from an intentional
   * disable.
   */
  sendMediaState(callId: CallId, to: SessionAddress, cameraOff: boolean, micOff: boolean, auth?: CallControlAuth): void {
    // Audit P1-C2 — sender-identity binding optional during the rollout
    // window. Relay forwards verbatim; receivers fail-closed when the
    // gate flips on.
    //
    // O-A (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — this used to be a bare
    // safeSend: a frame dropped during a WS blip left the receiver's
    // `remoteVideoOff` stale FOREVER (the "Camera off" placeholder is
    // checked BEFORE remoteHasVideo, so it masked live video, and
    // nothing reconciles the flag). Ride the same per-callId queue +
    // wait-open as reoffer/reanswer so a toggle during a reconnect still
    // lands — and lands in order relative to the upgrade frames it
    // annotates.
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.media-state', auth
        ? {callId, to, cameraOff, micOff, auth}
        : {callId, to, cameraOff, micOff}));
  }
}
