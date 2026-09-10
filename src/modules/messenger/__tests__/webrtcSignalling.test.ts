import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

/**
 * Unit test — exercises the signalling state machine WITHOUT any
 * native WebRTC module. Proves:
 *   - outgoing startOutgoing → offer sent → answer arrives → connecting → ice connected → verifyDtlsSrtp → connected
 *   - incoming offer → ringing → accept → answer sent → connecting
 *   - busy handling: second incoming while in-call rejects with 'busy'
 *   - DTLS-SRTP verification rejects a transport report with
 *     dtlsState !== 'connected' or srtpCipher missing
 */

function fakeTransport() {
  const sent: ClientFrame[] = [];
  return {
    sent,
    transport: {
      // CallSignalling.waitOpenThenSend short-circuits when state ===
      // 'connected'. Without this stub it would poll for 4s and drop
      // every send with the "transport never opened" warning.
      state: 'connected',
      send: (f: ClientFrame) => { sent.push(f); },
    } as unknown as TransportClient,
  };
}

// Audit P0-N3 — pinned-fingerprint tests require the fake SDPs to
// carry a valid `a=fingerprint:` line AND the fake getStats to report
// a matching certificate stat. Wrap every test SDP with this constant
// fingerprint so the assertion in verifyDtlsSrtp finds a match.
const BOB_FP_HEX = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
function sdpWithFp(label: string): string {
  return `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${BOB_FP_HEX}\r\nx-label=${label}\r\n`;
}

function fakePeerConnection(overrides: Partial<PeerConnectionLike> = {}): PeerConnectionLike {
  const pc: PeerConnectionLike = {
    createOffer:  async () => ({type: 'offer',  sdp: sdpWithFp('fake-offer-sdp')}),
    createAnswer: async () => ({type: 'answer', sdp: sdpWithFp('fake-answer-sdp')}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => new Map<string, StatsReport>([
      ['t0',  {type: 'transport',  dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cert-remote'}],
      ['cert-remote', {type: 'certificate', id: 'cert-remote', fingerprint: BOB_FP_HEX, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
    ...overrides,
  };
  return pc;
}

describe('Call signalling + controller', () => {
  it('outgoing offer → answer → ICE connected → DTLS verified', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pcFactory: PeerConnectionFactory = () => fakePeerConnection();
    const states: string[] = [];
    const secured: unknown[] = [];

    const controller = new CallController({
      signalling,
      pcFactory,
      iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
      onState:    s => states.push(s),
      onSecured:  i => secured.push(i),
    });

    await controller.startOutgoing({callId: 'c1', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    expect(states).toContain('calling');
    // signallingClient now per-callId-queues every send (so sendHangup
    // can serialize behind sendOffer; otherwise rapid hangup races the
    // offer flush). The queue ALWAYS defers via Promise.resolve(), so
    // even the fast "transport already open" path is one microtask
    // late. Flush before observing `sent`.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent[0].event).toBe('call.offer');

    // Simulate answer arriving via the signalling layer
    signalling.ingest({event: 'call.answer', data: {callId: 'c1', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('ans')}});
    // handleAnswer is async — chain is: setRemoteDescription (wrapper +
    // inner awaits) → drainPendingIce → setState('connecting'). Two
    // Promise.resolve() ticks aren't enough; flush the microtask queue
    // through a setImmediate-style yield instead.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(states).toContain('connecting');

    // Simulate ICE connected — drives verifyDtlsSrtp
    await controller.onIceConnected();
    expect(states).toContain('connected');
    expect(secured[0]).toEqual({dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM'});
  });

  it('incoming offer → ringing → accept → answer sent', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const controller = new CallController({
      signalling,
      pcFactory:  () => fakePeerConnection(),
      iceServers: [],
      onState:    () => {},
    });

    controller.handleIncomingOffer({
      callId: 'c2', from: {userId: 'alice', deviceId: 1}, sdp: sdpWithFp('offer-sdp'), kind: 'video',
    });
    expect(controller.currentState).toBe('ringing');
    await controller.accept();
    expect(controller.currentState).toBe('connecting');
    // Flush per-callId queue (see explanatory comment in the first
    // test).
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent.find(f => f.event === 'call.answer')).toBeTruthy();
  });

  it('CALLS-1to1 — sends OFFER best-effort when transport state never reaches connected (state-machine lag)', async () => {
    // Regression: the WS state label can lag a socket that is in fact
    // usable. The old waitOpenThenSend DROPPED the offer/answer on timeout,
    // so the callee never rang and the caller stayed stuck on "Answering…".
    // It must send best-effort rather than drop.
    //
    // NA-05 — the call-setup budget is now CALL_SETUP_SEND_BUDGET_MS (40s,
    // the ring window), not 12s, so drive past that before asserting. (The original
    // rationale here cited socket.io buffering emits on reconnect; that is
    // false for this wrapper — send() throws on !socket.connected before
    // socket.emit is reached. The retry loop is what actually delivers.)
    jest.useFakeTimers();
    try {
      const sent: ClientFrame[] = [];
      const transport = {
        state: 'reconnecting', // never flips to 'connected'
        send: (f: ClientFrame) => { sent.push(f); },
      } as unknown as TransportClient;
      const signalling = new CallSignalling(transport);

      signalling.sendOffer('cBE1', {userId: 'bob', deviceId: 1}, sdpWithFp('o'), 'voice');
      // Not yet: the offer must still be waiting at the OLD 4s cap.
      await jest.advanceTimersByTimeAsync(4200);
      expect(sent.find(f => f.event === 'call.offer')).toBeUndefined();
      // Drive past the NA-05 wait-open budget, flushing the async poll loop.
      await jest.advanceTimersByTimeAsync(36_500);

      expect(sent.find(f => f.event === 'call.offer')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a second incoming offer while already in a call with busy', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const controller = new CallController({
      signalling, pcFactory: () => fakePeerConnection(), iceServers: [], onState: () => {},
    });

    controller.handleIncomingOffer({
      callId: 'c3', from: {userId: 'alice', deviceId: 1}, sdp: sdpWithFp('o'), kind: 'voice',
    });
    await controller.accept();

    controller.handleIncomingOffer({
      callId: 'c4', from: {userId: 'mallory', deviceId: 1}, sdp: sdpWithFp('o'), kind: 'voice',
    });
    // sendHangup now queues per-callId — the busy hangup goes into the
    // c4 queue, which is fresh, so it flushes after one microtask.
    await new Promise(resolve => setTimeout(resolve, 0));
    const hangup = sent.find(f => f.event === 'call.hangup' && f.data.callId === 'c4');
    expect(hangup).toBeTruthy();
    if (hangup && hangup.event === 'call.hangup') {expect(hangup.data.reason).toBe('busy');}
  });

  it('verifyDtlsSrtp rejects a not-yet-negotiated transport', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const badPc = fakePeerConnection({
      getStats: async () => new Map<string, StatsReport>([
        ['t0', {type: 'transport', dtlsState: 'connecting'}],
      ]),
    });
    const controller = new CallController({
      signalling, pcFactory: () => badPc, iceServers: [], onState: () => {},
    });
    await controller.startOutgoing({callId: 'c5', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    signalling.ingest({event: 'call.answer', data: {callId: 'c5', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('ans')}});
    await Promise.resolve(); await Promise.resolve();
    await expect(controller.onIceConnected()).rejects.toThrow(/DTLS-SRTP not negotiated|DTLS not connected|SRTP cipher missing/);
  });

  it('hangup from peer ends the call locally', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const controller = new CallController({
      signalling, pcFactory: () => fakePeerConnection(), iceServers: [], onState: () => {},
    });
    await controller.startOutgoing({callId: 'c6', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    signalling.ingest({event: 'call.hangup', data: {callId: 'c6', from: {userId: 'bob', deviceId: 1}, reason: 'declined'}});
    expect(controller.currentState).toBe('ended');
  });

  // ── Mid-call renegotiation (voice→video upgrade) ────────────────────

  /**
   * Helper: drive the controller into 'connected' so the renegotiation
   * preconditions (state === 'connected') pass.
   */
  async function driveToConnected(controller: CallController, signalling: CallSignalling, callId: string, peer: {userId: string; deviceId: number}): Promise<void> {
    await controller.startOutgoing({callId, peer, kind: 'voice'});
    signalling.ingest({event: 'call.answer', data: {callId, from: peer, sdp: sdpWithFp('init-ans')}});
    await new Promise(r => setTimeout(r, 0));
    await controller.onIceConnected();
  }

  it('upgradeToVideo: sends call.reoffer, awaits call.reanswer, resolves on success', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    let setRemoteCalls = 0;
    const pc = fakePeerConnection({
      createOffer:  async () => ({type: 'offer', sdp: sdpWithFp('reoffer-sdp')}),
      setRemoteDescription: async () => { setRemoteCalls++; },
    });
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });

    await driveToConnected(controller, signalling, 'cup1', {userId: 'bob', deviceId: 1});

    const prepareCalls: Array<unknown> = [];
    const upgradePromise = controller.upgradeToVideo({
      prepare: (recvPc) => { prepareCalls.push(recvPc); },
      watchdogMs: 1000,
    });
    // Let the controller send its reoffer.
    await new Promise(r => setTimeout(r, 0));
    expect(prepareCalls).toHaveLength(1);
    const reoffer = sent.find(f => f.event === 'call.reoffer');
    expect(reoffer).toBeTruthy();
    if (reoffer && reoffer.event === 'call.reoffer') {
      expect(reoffer.data.callId).toBe('cup1');
      expect(reoffer.data.sdp).toBe(sdpWithFp('reoffer-sdp'));
    }

    // Simulate the peer's reanswer arriving.
    signalling.ingest({event: 'call.reanswer', data: {callId: 'cup1', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('reans-sdp')}});
    await upgradePromise;
    // setRemoteDescription called twice: once for the initial answer in
    // driveToConnected, once for the reanswer here.
    expect(setRemoteCalls).toBe(2);
  });

  it('upgradeToVideo: rejects when call is not in connected state', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const controller = new CallController({
      signalling, pcFactory: () => fakePeerConnection(), iceServers: [], onState: () => {},
    });
    await controller.startOutgoing({callId: 'cup2', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    // State is 'calling' — not 'connected'. Upgrade must reject.
    await expect(controller.upgradeToVideo({
      prepare: () => {},
      watchdogMs: 50,
    })).rejects.toThrow(/must be connected/);
  });

  it('upgradeToVideo: watchdog fires when peer never replies with reanswer', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });

    await driveToConnected(controller, signalling, 'cup3', {userId: 'bob', deviceId: 1});

    // No one ever ingests a reanswer — watchdog should fire.
    await expect(controller.upgradeToVideo({
      prepare: () => {},
      watchdogMs: 30,
    })).rejects.toThrow(/no reanswer within/);
  });

  it('upgradeToVideo: coalesces concurrent calls — second tap returns the in-flight promise', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    let prepareInvocations = 0;
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    await driveToConnected(controller, signalling, 'cup4', {userId: 'bob', deviceId: 1});

    const opts = {prepare: () => { prepareInvocations++; }, watchdogMs: 1000};
    const p1 = controller.upgradeToVideo(opts);
    const p2 = controller.upgradeToVideo(opts);
    expect(p1).toBe(p2);
    // Resolve the in-flight via reanswer.
    await new Promise(r => setTimeout(r, 0));
    signalling.ingest({event: 'call.reanswer', data: {callId: 'cup4', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('reans')}});
    await p1;
    expect(prepareInvocations).toBe(1);
  });

  it('upgradeToVideo: hangup mid-renegotiation rejects the in-flight promise', async () => {
    const {transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    await driveToConnected(controller, signalling, 'cup5', {userId: 'bob', deviceId: 1});

    const upgradePromise = controller.upgradeToVideo({
      prepare: () => {},
      watchdogMs: 1000,
    });
    // Let the reoffer ship + the await reanswer arm.
    await new Promise(r => setTimeout(r, 0));
    // Simulate peer hangup.
    signalling.ingest({event: 'call.hangup', data: {callId: 'cup5', from: {userId: 'bob', deviceId: 1}, reason: 'ended'}});
    await expect(upgradePromise).rejects.toThrow(/mid-renegotiation/);
  });

  it('handleReOffer: peer-initiated upgrade — applies remote offer, sends back call.reanswer', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    let setRemoteCount = 0;
    const pc = fakePeerConnection({
      createAnswer: async () => ({type: 'answer', sdp: sdpWithFp('reanswer-from-us')}),
      setRemoteDescription: async () => { setRemoteCount++; },
    });
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    let onRemoteRenegotiationFired = 0;
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
      onRemoteRenegotiation: () => { onRemoteRenegotiationFired++; },
    });
    await driveToConnected(controller, signalling, 'cup6', {userId: 'bob', deviceId: 1});

    // Peer fires a VIDEO-UPGRADE reoffer — the SDP carries an m=video
    // section (audit CALL-N3: onRemoteRenegotiation only fires for a real
    // video offer, not a plain ICE-restart reoffer).
    signalling.ingest({event: 'call.reoffer', data: {callId: 'cup6', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('peer-reoffer') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'}});
    // handleReOffer is async — flush the microtask queue.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(onRemoteRenegotiationFired).toBe(1);
    // setRemoteDescription called twice: initial answer + reoffer.
    expect(setRemoteCount).toBe(2);
    // We sent back a reanswer.
    const reanswer = sent.find(f => f.event === 'call.reanswer');
    expect(reanswer).toBeTruthy();
    if (reanswer && reanswer.event === 'call.reanswer') {
      expect(reanswer.data.sdp).toBe(sdpWithFp('reanswer-from-us'));
    }
  });

  it('CALL-N3: an ICE-restart reoffer with NO m=video does NOT fire onRemoteRenegotiation (but still reanswers)', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    let setRemoteCount = 0;
    const pc = fakePeerConnection({
      createAnswer: async () => ({type: 'answer', sdp: sdpWithFp('reanswer-restart')}),
      setRemoteDescription: async () => { setRemoteCount++; },
    });
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    let onRemoteRenegotiationFired = 0;
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
      onRemoteRenegotiation: () => { onRemoteRenegotiationFired++; },
    });
    await driveToConnected(controller, signalling, 'cup6b', {userId: 'bob', deviceId: 1});

    // Voice-call ICE-restart reoffer — audio-only SDP, no m=video.
    signalling.ingest({event: 'call.reoffer', data: {callId: 'cup6b', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('ice-restart-reoffer')}});
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Must NOT be treated as a video upgrade...
    expect(onRemoteRenegotiationFired).toBe(0);
    // ...but the reoffer is still applied and a reanswer sent (completes the restart).
    expect(setRemoteCount).toBe(2);
    expect(sent.find(f => f.event === 'call.reanswer')).toBeTruthy();
  });

  it('handleReOffer: ignored when call is not connected', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    // Start a call but never drive it to connected.
    await controller.startOutgoing({callId: 'cup7', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    signalling.ingest({event: 'call.reoffer', data: {callId: 'cup7', from: {userId: 'bob', deviceId: 1}, sdp: 'peer-reoffer'}});
    await new Promise(r => setTimeout(r, 0));
    // Should NOT have sent a reanswer back.
    expect(sent.find(f => f.event === 'call.reanswer')).toBeUndefined();
  });

  it('handleReOffer: ignored under signaling glare (signalingState !== stable)', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'have-local-offer';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    await driveToConnected(controller, signalling, 'cup8', {userId: 'bob', deviceId: 1});
    signalling.ingest({event: 'call.reoffer', data: {callId: 'cup8', from: {userId: 'bob', deviceId: 1}, sdp: 'peer-reoffer'}});
    await new Promise(r => setTimeout(r, 0));
    expect(sent.find(f => f.event === 'call.reanswer')).toBeUndefined();
  });

  it('callId mismatch: reoffer / reanswer for a different call are silently dropped', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    await driveToConnected(controller, signalling, 'cup9', {userId: 'bob', deviceId: 1});

    // Frame for the WRONG callId — must not trigger a reanswer.
    signalling.ingest({event: 'call.reoffer', data: {callId: 'wrong-id', from: {userId: 'bob', deviceId: 1}, sdp: 'foo'}});
    signalling.ingest({event: 'call.reanswer', data: {callId: 'wrong-id', from: {userId: 'bob', deviceId: 1}, sdp: 'foo'}});
    await new Promise(r => setTimeout(r, 0));
    expect(sent.find(f => f.event === 'call.reanswer')).toBeUndefined();
  });

  // Audit P1-N5 — a call.answer addressed to our call but coming from
  // a different peer (mallory injecting via a compromised gateway with
  // our offer's callId) MUST NOT bind DTLS-SRTP to mallory. Before the
  // P1-N5 gate, the controller only checked callId match and would
  // happily acceptAnswer(sdp) from any sender.
  it('audit P1-N5 — drops call.answer whose `from` does not match the offer peer', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const states: string[] = [];
    const controller = new CallController({
      signalling, pcFactory: () => fakePeerConnection(), iceServers: [],
      onState: s => states.push(s),
    });
    await controller.startOutgoing({callId: 'cP1N5', peer: {userId: 'bob', deviceId: 1}, kind: 'voice'});
    await new Promise(r => setTimeout(r, 0));
    expect(sent[0].event).toBe('call.offer');

    // Mallory injects an answer with the matching callId but a
    // different `from`. Controller must drop it.
    signalling.ingest({event: 'call.answer', data: {callId: 'cP1N5', from: {userId: 'mallory', deviceId: 1}, sdp: sdpWithFp('mallory-ans')}});
    await new Promise(r => setTimeout(r, 0));
    expect(states).not.toContain('connecting');

    // Legitimate answer from bob — must now advance the state machine.
    signalling.ingest({event: 'call.answer', data: {callId: 'cP1N5', from: {userId: 'bob', deviceId: 1}, sdp: sdpWithFp('bob-ans')}});
    await new Promise(r => setTimeout(r, 0));
    expect(states).toContain('connecting');
  });

  it('audit P1-N5 — drops call.ice / call.reoffer / call.reanswer from the wrong peer', async () => {
    const {sent, transport} = fakeTransport();
    const signalling = new CallSignalling(transport);
    const pc = fakePeerConnection();
    (pc as unknown as {signalingState: string}).signalingState = 'stable';
    let iceApplied = 0;
    const origAddIce = pc.addIceCandidate;
    pc.addIceCandidate = (async (c: Parameters<typeof origAddIce>[0]) => {
      iceApplied += 1;
      await origAddIce.call(pc, c);
    }) as typeof pc.addIceCandidate;
    const controller = new CallController({
      signalling, pcFactory: () => pc, iceServers: [], onState: () => {},
    });
    await driveToConnected(controller, signalling, 'cP1N5b', {userId: 'bob', deviceId: 1});
    const beforeIce = iceApplied;
    // Mallory's ICE candidate for our callId — dropped.
    signalling.ingest({event: 'call.ice', data: {callId: 'cP1N5b', from: {userId: 'mallory', deviceId: 1}, candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host', sdpMid: '0', sdpMLineIndex: 0}});
    await new Promise(r => setTimeout(r, 0));
    expect(iceApplied).toBe(beforeIce);

    // Mallory's reoffer / reanswer — dropped.
    signalling.ingest({event: 'call.reoffer', data: {callId: 'cP1N5b', from: {userId: 'mallory', deviceId: 1}, sdp: 'foo'}});
    signalling.ingest({event: 'call.reanswer', data: {callId: 'cP1N5b', from: {userId: 'mallory', deviceId: 1}, sdp: 'foo'}});
    await new Promise(r => setTimeout(r, 0));
    expect(sent.find(f => f.event === 'call.reanswer')).toBeUndefined();
  });
});

// O-A (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — media-state advisories are
// the ONLY thing that clears/sets the peer's "Camera off" placeholder,
// and the receiver has no reconcile: one dropped frame used to leave the
// placeholder masking LIVE video forever. sendMediaState must therefore
// ride the same per-callId queue + wait-open path as reoffer/reanswer —
// pinned here so it can never silently regress to a bare safeSend.
describe('O-A — media-state delivery reliability', () => {
  it('a toggle during a transport blip is DELIVERED once the socket recovers (was dropped)', async () => {
    jest.useFakeTimers();
    try {
      const sent: ClientFrame[] = [];
      const transport = {
        state: 'reconnecting',
        send: (f: ClientFrame) => { sent.push(f); },
      } as unknown as {state: string; send: (f: ClientFrame) => void};
      const signalling = new CallSignalling(transport as unknown as TransportClient);

      signalling.sendMediaState('cOA1', {userId: 'bob', deviceId: 1}, /*cameraOff*/ true, false);
      await jest.advanceTimersByTimeAsync(300);
      expect(sent.find(f => f.event === 'call.media-state')).toBeUndefined(); // still waiting

      transport.state = 'connected'; // WS recovered
      await jest.advanceTimersByTimeAsync(300);
      const frame = sent.find(f => f.event === 'call.media-state');
      expect(frame).toBeTruthy();
      expect((frame as unknown as {data: {cameraOff: boolean}}).data.cameraOff).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('media-state stays ORDERED behind a pending reoffer on the same callId', async () => {
    jest.useFakeTimers();
    try {
      const sent: ClientFrame[] = [];
      const transport = {
        state: 'reconnecting',
        send: (f: ClientFrame) => { sent.push(f); },
      } as unknown as {state: string; send: (f: ClientFrame) => void};
      const signalling = new CallSignalling(transport as unknown as TransportClient);

      // Upgrade reoffer queued during the blip, then the camera toggle
      // advisory. If media-state bypassed the queue it would arrive
      // FIRST after recovery and the peer would apply a stale ordering.
      signalling.sendReOffer('cOA2', {userId: 'bob', deviceId: 1}, sdpWithFp('upgrade'));
      signalling.sendMediaState('cOA2', {userId: 'bob', deviceId: 1}, false, false);

      transport.state = 'connected';
      await jest.advanceTimersByTimeAsync(500);

      const events = sent.map(f => f.event);
      const reofferIdx = events.indexOf('call.reoffer');
      const mediaIdx   = events.indexOf('call.media-state');
      expect(reofferIdx).toBeGreaterThanOrEqual(0);
      expect(mediaIdx).toBeGreaterThan(reofferIdx);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to best-effort after the wait-open timeout (never throws)', async () => {
    jest.useFakeTimers();
    try {
      const sent: ClientFrame[] = [];
      const transport = {
        state: 'reconnecting', // never recovers
        send: (f: ClientFrame) => { sent.push(f); },
      } as unknown as TransportClient;
      const signalling = new CallSignalling(transport);

      signalling.sendMediaState('cOA3', {userId: 'bob', deviceId: 1}, true, true);
      await jest.advanceTimersByTimeAsync(4200);
      // Same posture as offers: after the cap it best-effort sends
      // (socket.io buffers + flushes on reconnect) rather than dropping.
      expect(sent.find(f => f.event === 'call.media-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
