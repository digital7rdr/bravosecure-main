/**
 * CallController — EXECUTABLE coverage for the resilience branches the
 * existing suites never reach.
 *
 * Everything here drives the REAL controller against a mock RTCPeerConnection
 * (same shape as callIceRestartRetry.test.ts). No source scanning, no mirrors.
 *
 * What it pins, and why each one matters:
 *
 *  • P2-BR-6 — notifyForeground / notifyBackground. RN freezes JS timers in
 *    the background, so a plain 30 s reconnect budget "flush-expires" the
 *    instant the user taps back in and kills a call that was fine. These two
 *    methods were 100 % uncovered.
 *  • The reconnect budget itself (armBudgetTimer): exhaustion must end the
 *    call, and a wall-clock deadline that was EXTENDED must re-arm instead of
 *    failing on the frozen-then-flushed fire.
 *  • Trickle-ICE inbound queue: candidates that arrive before the engine can
 *    take them must be QUEUED (not dropped — the coturn `peer sp=0` class),
 *    capped at 64 dropping the OLDEST, drained in order, and re-queued when
 *    `addIceCandidate` rejects.
 *  • B-273 outbound gate cap — the held queue is bounded the same way.
 *  • The terminal-state guard in setState: RN-WebRTC drains native events for
 *    ~50-200 ms AFTER close(), and those stale callbacks must not drag an
 *    ended call back to 'connected'.
 *  • P1-BR-6 — a DTLS-SRTP verification that never succeeds (including a
 *    native getStats() that never settles) must still END the call, not wedge
 *    it forever.
 *  • The best-effort boundaries: a host `onMissedCall` / `onRemoteRenegotiation`
 *    that throws, a `buildOfferAuth` that rejects, a peer reoffer whose
 *    setRemoteDescription rejects — none may take the controller down.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;
const videoSdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nx-label=${label}\r\n`;

const PEER_BOB = {userId: 'bob', deviceId: 1};

/** RECONNECT_BUDGET_MS / RESTART_RETRY_MS mirror the private class constants. */
const BUDGET_MS = 30_000;

function fakeTransport() {
  const sent: ClientFrame[] = [];
  return {
    sent,
    transport: {
      state: 'connected',
      send: (f: ClientFrame) => { sent.push(f); },
    } as unknown as TransportClient,
  };
}

interface TrackedPeer extends PeerConnectionLike {
  signalingState:     string;
  iceConnectionState: string;
  /** Every candidate handed to addIceCandidate, in application order. */
  applied:            string[];
  /** Candidate strings whose FIRST addIceCandidate must reject. */
  failOnce:           Set<string>;
  /** Reject setRemoteDescription for this description type. */
  rejectRemote:       'offer' | 'answer' | null;
  statsMode:          'ok' | 'throw' | 'hang';
  /** How many times the DTLS-SRTP probe actually hit the engine. */
  statsCalls:         number;
}

function fakePeer(): TrackedPeer {
  const p: TrackedPeer = {
    signalingState:     'stable',
    iceConnectionState: 'new',
    applied:            [],
    failOnce:           new Set<string>(),
    rejectRemote:       null,
    statsMode:          'ok',
    statsCalls:         0,
    createOffer: (async (opts?: {iceRestart?: boolean}) =>
      ({type: 'offer' as const, sdp: sdp(opts?.iceRestart ? 'restart' : 'offer')})) as PeerConnectionLike['createOffer'],
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription: (async (desc: {type: string}) => {
      if (desc.type === 'rollback') { p.signalingState = 'stable'; return; }
      if (desc.type === 'offer')    { p.signalingState = 'have-local-offer'; return; }
      if (desc.type === 'answer')   { p.signalingState = 'stable'; }
    }) as PeerConnectionLike['setLocalDescription'],
    setRemoteDescription: async (desc: {type: 'offer' | 'answer'; sdp: string}) => {
      if (p.rejectRemote === desc.type) { throw new Error(`setRemoteDescription(${desc.type}) rejected`); }
      p.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    addIceCandidate: async (c: {candidate: string}) => {
      if (p.failOnce.has(c.candidate)) {
        p.failOnce.delete(c.candidate);
        throw new Error('Cannot add ICE candidate before remote description has been set');
      }
      p.applied.push(c.candidate);
    },
    addTrack: () => {},
    close:    () => {},
    getStats: async () => {
      p.statsCalls += 1;
      if (p.statsMode === 'throw') { throw new Error('getStats exploded'); }
      if (p.statsMode === 'hang')  { return new Promise(() => { /* never settles */ }); }
      return new Map<string, StatsReport>([
        ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
        ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
      ]);
    },
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
  return p;
}

interface BuildOpts {
  onMissedCall?:          (info: unknown) => void;
  onRemoteRenegotiation?: (pc: unknown) => Promise<void> | void;
  buildOfferAuth?:        CallControllerCtor['buildOfferAuth'];
  attachLocalMedia?:      (pc: unknown) => Promise<void> | void;
  ringTimeoutMs?:         number;
}
type CallControllerCtor = ConstructorParameters<typeof CallController>[0];

function build(opts: BuildOpts = {}) {
  const {sent, transport} = fakeTransport();
  const signalling = new CallSignalling(transport);
  const peer = fakePeer();
  const pcFactory: PeerConnectionFactory = () => peer;
  const states: string[] = [];
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState: s => states.push(s),
    ...(opts.onMissedCall          ? {onMissedCall: opts.onMissedCall as CallControllerCtor['onMissedCall']} : {}),
    ...(opts.onRemoteRenegotiation ? {onRemoteRenegotiation: opts.onRemoteRenegotiation as CallControllerCtor['onRemoteRenegotiation']} : {}),
    ...(opts.buildOfferAuth        ? {buildOfferAuth: opts.buildOfferAuth} : {}),
    ...(opts.attachLocalMedia      ? {attachLocalMedia: opts.attachLocalMedia as CallControllerCtor['attachLocalMedia']} : {}),
    ...(opts.ringTimeoutMs         ? {ringTimeoutMs: opts.ringTimeoutMs} : {}),
  });
  return {controller, signalling, sent, states, peer};
}

type Rig = ReturnType<typeof build>;

const flush = async (n = 14) => { for (let i = 0; i < n; i++) { await Promise.resolve(); } };

const ice = (n: number) => `candidate:${n} 1 udp 2113937151 10.0.0.${n} 5000 typ host`;

function ingestIce(rig: Rig, callId: string, candidate: string) {
  rig.signalling.ingest({
    event: 'call.ice',
    data:  {callId, from: PEER_BOB, candidate, sdpMid: '0', sdpMLineIndex: 0},
  });
}

/** Callee: incoming offer → accept → answer sent → ICE connected → 'connected'. */
async function driveIncomingToConnected(rig: Rig, callId: string, kind: 'voice' | 'video' = 'voice') {
  rig.controller.handleIncomingOffer({callId, from: PEER_BOB, sdp: sdp('inb'), kind});
  await rig.controller.accept();
  await flush();
  rig.peer.iceConnectionState = 'connected';
  rig.peer.oniceconnectionstatechange?.('connected');
  await flush();
}

/** Caller: startOutgoing → answer applied → ICE connected → 'connected'. */
async function driveOutgoingToConnected(rig: Rig, callId: string) {
  await rig.controller.startOutgoing({callId, peer: PEER_BOB, kind: 'voice'});
  await flush();
  rig.signalling.ingest({event: 'call.answer', data: {callId, from: PEER_BOB, sdp: sdp('ans')}});
  await flush();
  rig.peer.iceConnectionState = 'connected';
  rig.peer.oniceconnectionstatechange?.('connected');
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
describe('P2-BR-6 — background/foreground must not flush-kill a reconnect', () => {
  async function toReconnecting(rig: Rig, callId: string) {
    // Callee side on purpose: the offerer drives ICE restarts, and this
    // suite is about the BUDGET, not the restart machinery.
    await driveIncomingToConnected(rig, callId);
    expect(rig.controller.currentState).toBe('connected');
    rig.peer.iceConnectionState = 'disconnected';
    rig.peer.oniceconnectionstatechange?.('disconnected');
    await flush();
    expect(rig.controller.currentState).toBe('reconnecting');
  }

  it('the reconnect budget ENDS the call when it genuinely runs out', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-1');
    jest.advanceTimersByTime(BUDGET_MS - 1);
    await flush();
    expect(rig.controller.currentState).toBe('reconnecting');
    jest.advanceTimersByTime(2);
    await flush();
    expect(rig.controller.currentState).toBe('failed');
    expect(rig.states).toContain('failed');
  });

  it('notifyBackground PAUSES the budget — a long background stint cannot expire it', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-2');
    rig.controller.notifyBackground();
    // Four times the budget while backgrounded.
    jest.advanceTimersByTime(BUDGET_MS * 4);
    await flush();
    expect(rig.controller.currentState).toBe('reconnecting');
  });

  it('notifyForeground grants a FRESH window after a pause instead of failing on resume', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-3');
    rig.controller.notifyBackground();
    jest.advanceTimersByTime(BUDGET_MS * 2);
    rig.controller.notifyForeground();
    await flush();
    // Still alive, and the clock restarted from the resume.
    jest.advanceTimersByTime(BUDGET_MS - 1_000);
    await flush();
    expect(rig.controller.currentState).toBe('reconnecting');
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(rig.controller.currentState).toBe('failed');
  });

  it('an armed-but-late budget timer RE-ARMS for the extended deadline (the flush-expire bug)', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-4');
    // No notifyBackground — the timer stays armed, as it would if the OS
    // froze it rather than the app pausing it. Resume extends the DEADLINE.
    jest.advanceTimersByTime(BUDGET_MS - 5_000);
    rig.controller.notifyForeground();
    await flush();
    // The original timer now fires; remaining > 0, so it must re-arm.
    jest.advanceTimersByTime(6_000);
    await flush();
    expect(rig.controller.currentState).toBe('reconnecting');
    // ...and still end once the EXTENDED deadline passes.
    jest.advanceTimersByTime(BUDGET_MS);
    await flush();
    expect(rig.controller.currentState).toBe('failed');
  });

  it('notifyForeground PROMOTES when ICE quietly recovered while we were away', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-5');
    rig.peer.iceConnectionState = 'connected';  // healed in the background
    rig.controller.notifyForeground();
    await flush();
    expect(rig.controller.currentState).toBe('connected');
    // The budget must be gone with it — no delayed fail.
    jest.advanceTimersByTime(BUDGET_MS * 2);
    await flush();
    expect(rig.controller.currentState).toBe('connected');
  });

  it('both notifications are inert outside a reconnect', async () => {
    const rig = build();
    await driveIncomingToConnected(rig, 'c-budget-6');
    const before = rig.states.length;
    rig.controller.notifyBackground();
    rig.controller.notifyForeground();
    await flush();
    expect(rig.states.length).toBe(before);
    expect(rig.controller.currentState).toBe('connected');
  });

  it('notifyForeground is inert after teardown', async () => {
    const rig = build();
    await toReconnecting(rig, 'c-budget-7');
    rig.controller.hangup('ended');
    await flush();
    expect(rig.controller.currentState).toBe('ended');
    rig.controller.notifyForeground();
    await flush();
    expect(rig.controller.currentState).toBe('ended');
  });

  it('the offerer re-drives its ICE restart on resume', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-budget-8');
    rig.peer.iceConnectionState = 'disconnected';
    rig.peer.oniceconnectionstatechange?.('disconnected');
    await flush();
    const before = rig.sent.filter(f => f.event === 'call.reoffer').length;
    expect(before).toBeGreaterThan(0);
    rig.controller.notifyBackground();
    rig.controller.notifyForeground();
    await flush(30);
    expect(rig.sent.filter(f => f.event === 'call.reoffer').length).toBeGreaterThan(before);
    rig.controller.hangup('ended');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('inbound trickle-ICE — queue, cap, drain, re-queue', () => {
  it('candidates that arrive while the callee is still ringing are QUEUED, then drained IN ORDER', async () => {
    const rig = build();
    rig.controller.handleIncomingOffer({callId: 'c-ice-1', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    // No pc exists yet — these have nowhere to land and must not be dropped.
    ingestIce(rig, 'c-ice-1', ice(1));
    ingestIce(rig, 'c-ice-1', ice(2));
    ingestIce(rig, 'c-ice-1', ice(3));
    await flush();
    expect(rig.peer.applied).toEqual([]);

    await rig.controller.accept();
    await flush();
    expect(rig.peer.applied).toEqual([ice(1), ice(2), ice(3)]);
    rig.controller.hangup('ended');
  });

  it('the pre-engine queue is capped at 64, dropping the OLDEST so a fresher candidate still lands', async () => {
    const rig = build();
    rig.controller.handleIncomingOffer({callId: 'c-ice-2', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    for (let i = 1; i <= 70; i++) { ingestIce(rig, 'c-ice-2', ice(i)); }
    await flush();
    await rig.controller.accept();
    await flush();
    expect(rig.peer.applied).toHaveLength(64);
    // Oldest six dropped; the newest survived.
    expect(rig.peer.applied[0]).toBe(ice(7));
    expect(rig.peer.applied[63]).toBe(ice(70));
    rig.controller.hangup('ended');
  });

  it('once the remote description is applied, candidates go STRAIGHT to the engine', async () => {
    const rig = build();
    rig.controller.handleIncomingOffer({callId: 'c-ice-3', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await rig.controller.accept();
    await flush();
    ingestIce(rig, 'c-ice-3', ice(9));
    await flush();
    expect(rig.peer.applied).toEqual([ice(9)]);
    rig.controller.hangup('ended');
  });

  it('an addIceCandidate rejection RE-QUEUES the candidate instead of losing it forever', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-ice-4', peer: PEER_BOB, kind: 'voice'});
    await flush();
    rig.signalling.ingest({event: 'call.answer', data: {callId: 'c-ice-4', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    // Engine is ready, but this one throws (mid-renegotiation / RN-Android
    // state lag) — the pre-fix `.catch()` swallowed it and the candidate was
    // gone forever, leaving coturn with no permitted peer (sp=0).
    rig.peer.failOnce.add(ice(42));
    ingestIce(rig, 'c-ice-4', ice(42));
    await flush();
    expect(rig.peer.applied).toEqual([]);
    // A redelivered answer drains the queue again — the candidate is still there.
    rig.signalling.ingest({event: 'call.answer', data: {callId: 'c-ice-4', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    expect(rig.peer.applied).toEqual([ice(42)]);
    rig.controller.hangup('ended');
  });

  it('ICE for a foreign callId never reaches the engine', async () => {
    const rig = build();
    rig.controller.handleIncomingOffer({callId: 'c-ice-5', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    ingestIce(rig, 'someone-elses-call', ice(1));
    await rig.controller.accept();
    await flush();
    expect(rig.peer.applied).toEqual([]);
    rig.controller.hangup('ended');
  });

  it('teardown clears the queue so the NEXT call on this controller cannot replay it', async () => {
    const rig = build();
    rig.controller.handleIncomingOffer({callId: 'c-ice-6', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    ingestIce(rig, 'c-ice-6', ice(1));
    await flush();
    rig.controller.hangup('ended');
    await flush();
    expect(rig.peer.applied).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('B-273 — the outbound ICE gate is bounded too', () => {
  it('holds candidates until the offer is on the wire and never buffers more than 64', async () => {
    let releaseAuth: (() => void) | null = null;
    const authGate = new Promise<void>(r => { releaseAuth = r; });
    const rig = build({
      buildOfferAuth: async () => {
        await authGate;
        return {senderCert: 'x', sig: 'y'} as never;
      },
    });
    const start = rig.controller.startOutgoing({callId: 'c-out-1', peer: PEER_BOB, kind: 'voice'});
    await flush();
    // Gathering fires while buildOfferAuth is still in flight — the relay
    // drops ICE for a callId whose offer it has not seen, so these are held.
    for (let i = 1; i <= 70; i++) {
      rig.peer.onicecandidate?.({candidate: {candidate: ice(i), sdpMid: '0', sdpMLineIndex: 0}});
    }
    expect(rig.sent.filter(f => f.event === 'call.ice')).toHaveLength(0);

    releaseAuth!();
    await start;
    await flush(40);

    const iceFrames = rig.sent.filter(f => f.event === 'call.ice');
    expect(rig.sent[0].event).toBe('call.offer');
    expect(iceFrames).toHaveLength(64);
    expect((iceFrames[0] as {data: {candidate: string}}).data.candidate).toBe(ice(7));
    expect((iceFrames[63] as {data: {candidate: string}}).data.candidate).toBe(ice(70));
    rig.controller.hangup('ended');
  });

  it('the end-of-candidates sentinel is never put on the wire', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-out-2', peer: PEER_BOB, kind: 'voice'});
    await flush(30);
    rig.peer.onicecandidate?.({candidate: null});
    rig.peer.onicecandidate?.({} as {candidate?: null});
    await flush();
    expect(rig.sent.filter(f => f.event === 'call.ice')).toHaveLength(0);
    rig.controller.hangup('ended');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('terminal-state guard — a dead controller must stay dead', () => {
  it('a native ICE event draining AFTER close() cannot resurrect an ended call', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-term-1');
    // RN-WebRTC keeps firing queued events for ~50-200 ms past close(); grab
    // the handler the way a stale native callback holds it.
    const staleIceHandler = rig.peer.oniceconnectionstatechange!;
    rig.controller.hangup('ended');
    await flush();
    expect(rig.controller.currentState).toBe('ended');
    const statesAtEnd = [...rig.states];

    rig.peer.iceConnectionState = 'connected';
    staleIceHandler('connected');
    await flush();

    expect(rig.controller.currentState).toBe('ended');
    expect(rig.states).toEqual(statesAtEnd);
  });

  it('a stale ICE "failed" event after teardown does not re-enter the reconnect machinery', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-term-2');
    const staleIceHandler = rig.peer.oniceconnectionstatechange!;
    rig.controller.hangup('ended');
    await flush();
    const sentAtEnd = rig.sent.length;

    rig.peer.iceConnectionState = 'failed';
    staleIceHandler('failed');
    jest.advanceTimersByTime(BUDGET_MS * 2);
    await flush();

    expect(rig.controller.currentState).toBe('ended');
    expect(rig.sent).toHaveLength(sentAtEnd);
  });

  it('end() is idempotent — a second hangup emits no second state, no second frame', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-term-3');
    rig.controller.hangup('ended');
    await flush();
    const states = [...rig.states];
    const sent   = rig.sent.length;
    rig.controller.hangup('failed');
    rig.controller.hangup('ended');
    await flush();
    expect(rig.states).toEqual(states);
    expect(rig.sent).toHaveLength(sent);
    expect(rig.controller.currentCall).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('P1-BR-6 — DTLS-SRTP verification is a real gate, and it always terminates', () => {
  /** Run the 24×250 ms poll (plus its per-iteration 1 s timeout) to exhaustion. */
  async function burnPoll(ms = 40_000) {
    for (let i = 0; i < 200; i++) {
      await flush(4);
      jest.advanceTimersByTime(ms / 200);
    }
    await flush(20);
  }

  it('ICE promotes the call, but a verification that never succeeds still FAILS it', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-dtls-1', peer: PEER_BOB, kind: 'voice'});
    await flush();
    rig.signalling.ingest({event: 'call.answer', data: {callId: 'c-dtls-1', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    rig.peer.statsMode = 'throw';
    rig.peer.iceConnectionState = 'connected';
    rig.peer.oniceconnectionstatechange?.('connected');
    await flush();
    // Promoted straight off the ICE event (B-60/B-61) so the UI is not held
    // hostage by the stats layer...
    expect(rig.controller.currentState).toBe('connected');
    // ...but the follow-up gate is unconditional.
    await burnPoll(10_000);
    expect(rig.controller.currentState).toBe('failed');
  });

  it('a native getStats() that NEVER settles cannot wedge the poll (dtls-poll-hung)', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-dtls-2', peer: PEER_BOB, kind: 'voice'});
    await flush();
    rig.signalling.ingest({event: 'call.answer', data: {callId: 'c-dtls-2', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    rig.peer.statsMode = 'hang';
    rig.peer.iceConnectionState = 'connected';
    rig.peer.oniceconnectionstatechange?.('connected');
    await flush();
    await burnPoll(40_000);
    expect(rig.controller.currentState).toBe('failed');
  });

  it('a hangup during the poll stops it — no post-teardown state churn', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-dtls-3', peer: PEER_BOB, kind: 'voice'});
    await flush();
    rig.signalling.ingest({event: 'call.answer', data: {callId: 'c-dtls-3', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    rig.peer.statsMode = 'throw';
    rig.peer.iceConnectionState = 'connected';
    rig.peer.oniceconnectionstatechange?.('connected');
    await flush();
    rig.controller.hangup('ended');
    await flush();
    const states = [...rig.states];
    await burnPoll(10_000);
    expect(rig.states).toEqual(states);
    expect(rig.controller.currentState).toBe('ended');
  });

  it('once verified, ICE oscillation does NOT re-run the poll (the dtlsVerified latch)', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-dtls-4');
    expect(rig.controller.currentState).toBe('connected');
    const probes = rig.peer.statsCalls;
    expect(probes).toBe(1);
    const states = [...rig.states];

    // ICE flaps connected → checking → connected on a weak network. The
    // engine fires the event repeatedly during candidate selection; a
    // re-verification here could flip a WORKING call to 'failed'.
    rig.peer.oniceconnectionstatechange?.('connected');
    rig.peer.oniceconnectionstatechange?.('connected');
    await flush(30);

    expect(rig.peer.statsCalls).toBe(probes);
    expect(rig.states).toEqual(states);
    expect(rig.controller.currentState).toBe('connected');
    rig.controller.hangup('ended');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('host callbacks are best-effort — a throwing host never takes the call down', () => {
  it('a throwing onMissedCall on ring expiry still leaves the call terminal', async () => {
    const onMissedCall = jest.fn(() => { throw new Error('host blew up'); });
    const rig = build({onMissedCall, ringTimeoutMs: 500});
    rig.controller.handleIncomingOffer({callId: 'c-host-1', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    expect(() => { jest.advanceTimersByTime(500); }).not.toThrow();
    await flush();
    expect(onMissedCall).toHaveBeenCalledTimes(1);
    expect(rig.controller.currentState).toBe('ended');
    expect(rig.sent.some(f => f.event === 'call.hangup')).toBe(true);
  });

  it('a throwing onMissedCall on a peer hangup mid-ring still leaves the call terminal', async () => {
    const onMissedCall = jest.fn(() => { throw new Error('host blew up'); });
    const rig = build({onMissedCall, ringTimeoutMs: 5_000});
    rig.controller.handleIncomingOffer({callId: 'c-host-2', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    expect(() => {
      rig.signalling.ingest({event: 'call.hangup', data: {callId: 'c-host-2', from: PEER_BOB, reason: 'ended'}});
    }).not.toThrow();
    await flush();
    expect(onMissedCall).toHaveBeenCalledTimes(1);
    expect(rig.controller.currentState).toBe('ended');
  });

  it('a rejecting buildOfferAuth still ships the offer (a cert blip must not wedge a dial)', async () => {
    const rig = build({buildOfferAuth: async () => { throw new Error('sender cert fetch failed'); }});
    await rig.controller.startOutgoing({callId: 'c-host-3', peer: PEER_BOB, kind: 'voice'});
    await flush(30);
    const offer = rig.sent.find(f => f.event === 'call.offer') as {data: Record<string, unknown>} | undefined;
    expect(offer).toBeDefined();
    expect(offer!.data.auth).toBeUndefined();
    expect(rig.controller.currentState).toBe('calling');
    rig.controller.hangup('ended');
  });

  it('a throwing onRemoteRenegotiation still completes the renegotiation one-way', async () => {
    const onRemoteRenegotiation = jest.fn(() => { throw new Error('camera denied'); });
    const rig = build({onRemoteRenegotiation});
    await driveIncomingToConnected(rig, 'c-host-4');
    rig.signalling.ingest({event: 'call.reoffer', data: {callId: 'c-host-4', from: PEER_BOB, sdp: videoSdp('up')}});
    await flush(30);
    expect(onRemoteRenegotiation).toHaveBeenCalledTimes(1);
    // The peer still gets an answer — one-way video beats a dead upgrade.
    expect(rig.sent.some(f => f.event === 'call.reanswer')).toBe(true);
    expect(rig.controller.currentState).toBe('connected');
    rig.controller.hangup('ended');
  });

  it('a reoffer whose setRemoteDescription REJECTS is contained — the call survives', async () => {
    const rig = build();
    await driveIncomingToConnected(rig, 'c-host-5');
    rig.peer.rejectRemote = 'offer';
    expect(() => {
      rig.signalling.ingest({event: 'call.reoffer', data: {callId: 'c-host-5', from: PEER_BOB, sdp: videoSdp('up')}});
    }).not.toThrow();
    await flush(30);
    expect(rig.sent.some(f => f.event === 'call.reanswer')).toBe(false);
    expect(rig.controller.currentState).toBe('connected');
    rig.controller.hangup('ended');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('call.reanswer routing', () => {
  it('a stray reanswer with no awaiter is dropped, not applied', async () => {
    const rig = build();
    await driveIncomingToConnected(rig, 'c-ra-1');
    const remoteApplied = rig.peer.signalingState;
    expect(() => {
      rig.signalling.ingest({event: 'call.reanswer', data: {callId: 'c-ra-1', from: PEER_BOB, sdp: sdp('stray')}});
    }).not.toThrow();
    await flush();
    expect(rig.peer.signalingState).toBe(remoteApplied);
    expect(rig.controller.currentState).toBe('connected');
    rig.controller.hangup('ended');
  });

  it('an ICE-restart reanswer IS applied directly (no awaiter exists on that path)', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-ra-2');
    rig.peer.iceConnectionState = 'disconnected';
    rig.peer.oniceconnectionstatechange?.('disconnected');
    await flush(30);
    expect(rig.sent.some(f => f.event === 'call.reoffer')).toBe(true);
    expect(rig.peer.signalingState).toBe('have-local-offer');

    rig.signalling.ingest({event: 'call.reanswer', data: {callId: 'c-ra-2', from: PEER_BOB, sdp: sdp('restart-ans')}});
    await flush(30);
    // setRemoteDescription(answer) ran — the engine learned the new ufrag.
    expect(rig.peer.signalingState).toBe('stable');
    expect(rig.controller.currentState).toBe('reconnecting');
    rig.controller.hangup('ended');
  });

  it('an ICE-restart reanswer that REJECTS does not end the call — the budget stays the authority', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-ra-3');
    rig.peer.iceConnectionState = 'disconnected';
    rig.peer.oniceconnectionstatechange?.('disconnected');
    await flush(30);
    rig.peer.rejectRemote = 'answer';
    rig.signalling.ingest({event: 'call.reanswer', data: {callId: 'c-ra-3', from: PEER_BOB, sdp: sdp('bad')}});
    await flush(30);
    expect(rig.controller.currentState).toBe('reconnecting');
    // ...and the budget is still what kills it.
    jest.advanceTimersByTime(BUDGET_MS + 1_000);
    await flush(30);
    expect(rig.controller.currentState).toBe('failed');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('ICE recovery from a hard failure (B-108)', () => {
  it('an ever-connected call that ICE-FAILS routes into reconnect and re-fires a restart offer', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-b108-1');
    const before = rig.sent.filter(f => f.event === 'call.reoffer').length;
    rig.peer.iceConnectionState = 'failed';
    rig.peer.oniceconnectionstatechange?.('failed');
    await flush(30);
    expect(rig.controller.currentState).toBe('reconnecting');
    expect(rig.sent.filter(f => f.event === 'call.reoffer').length).toBeGreaterThan(before);
    rig.controller.hangup('ended');
  });

  it('a call that NEVER connected fails fast on ICE failure (B-41 class, no fake 30 s reconnect)', async () => {
    const rig = build();
    await rig.controller.startOutgoing({callId: 'c-b108-2', peer: PEER_BOB, kind: 'voice'});
    await flush();
    rig.peer.iceConnectionState = 'failed';
    rig.peer.oniceconnectionstatechange?.('failed');
    await flush(30);
    expect(rig.controller.currentState).toBe('failed');
  });

  it('recovery clears the budget — a late timer cannot fail a healed call', async () => {
    const rig = build();
    await driveOutgoingToConnected(rig, 'c-b108-3');
    rig.peer.iceConnectionState = 'disconnected';
    rig.peer.oniceconnectionstatechange?.('disconnected');
    await flush(30);
    expect(rig.controller.currentState).toBe('reconnecting');
    rig.peer.iceConnectionState = 'connected';
    rig.peer.oniceconnectionstatechange?.('connected');
    await flush(30);
    expect(rig.controller.currentState).toBe('connected');
    jest.advanceTimersByTime(BUDGET_MS * 3);
    await flush(30);
    expect(rig.controller.currentState).toBe('connected');
    rig.controller.hangup('ended');
  });
});
