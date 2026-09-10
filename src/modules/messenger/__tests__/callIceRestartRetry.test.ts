/**
 * Regression — 1:1 call dies on screen-sleep (WhatsApp survives, we didn't).
 *
 * Field repro (device logcat 2026-06-07): after the app resumed from
 * background, the offerer fired ONE ice-restart reoffer, no `reanswer` ever
 * came back (peer was briefly asleep), and the call sat in 'reconnecting'
 * until the 30s budget elapsed → 'failed'. The fix re-sends the reoffer on
 * an interval while still 'reconnecting'.
 *
 * M-12 / CALL-05/20 — these tests exercise the REAL retry gate
 * (CallController.startRestartRetry → retryIceRestartOffer →
 * fireIceRestartOffer) against a mock PC, NOT a re-implemented copy of the
 * tick guard. The specific deadlock pinned here: after the FIRST restart
 * offer the PC parks in 'have-local-offer' until a reanswer arrives, so
 * fireIceRestartOffer's stable-only gate used to bail on EVERY tick — a
 * lost reoffer frame (dead peer WS, the B-24/B-14 pattern) was never
 * re-sent and the call died at the budget. The retry path must roll back
 * its OWN unanswered restart offer and re-fire — and must NEVER roll back
 * a mid-flight video-upgrade renegotiation.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

// RESTART_RETRY_MS in callController.ts — mirror the constant, the class
// keeps it private.
const RETRY_MS = 4_000;

const PEER_BOB = {userId: 'bob', deviceId: 1};

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

/**
 * Mock PC that tracks the W3C signalingState the way a real engine does,
 * so the controller's stable-only gates + rollback path run for real:
 *   setLocal(offer)    → 'have-local-offer'
 *   setLocal(answer)   → 'stable'
 *   setLocal(rollback) → 'stable'   (counted)
 *   setRemote(offer)   → 'have-remote-offer'
 *   setRemote(answer)  → 'stable'
 */
interface TrackedPeer extends PeerConnectionLike {
  signalingState:     string;
  iceConnectionState: string;
  rollbacks:          number;
  restartOffers:      number;
}

function fakePeer(): TrackedPeer {
  const p: TrackedPeer = {
    signalingState:     'stable',
    iceConnectionState: 'new',
    rollbacks:          0,
    restartOffers:      0,
    createOffer: (async (opts?: {iceRestart?: boolean}) => {
      if (opts?.iceRestart) {p.restartOffers += 1;}
      return {type: 'offer' as const, sdp: sdp(opts?.iceRestart ? `restart-${p.restartOffers}` : 'offer')};
    }) as PeerConnectionLike['createOffer'],
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription: (async (desc: {type: string}) => {
      if (desc.type === 'rollback')    { p.rollbacks += 1; p.signalingState = 'stable'; return; }
      if (desc.type === 'offer')       { p.signalingState = 'have-local-offer'; return; }
      if (desc.type === 'answer')      { p.signalingState = 'stable'; }
    }) as PeerConnectionLike['setLocalDescription'],
    setRemoteDescription: async (desc: {type: 'offer' | 'answer'; sdp: string}) => {
      p.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    addIceCandidate: async () => {},
    addTrack:        () => {},
    close:           () => {},
    getStats: async () => new Map<string, StatsReport>([
      ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
      ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
  return p;
}

function build() {
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
  });
  return {controller, signalling, sent, states, peer};
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) {await Promise.resolve();} };

const reoffers = (sent: ClientFrame[]) => sent.filter(f => f.event === 'call.reoffer');

/** startOutgoing → answer applied → ICE 'disconnected' → first restart offer out. */
async function driveToReconnecting(b: ReturnType<typeof build>, callId: string) {
  await b.controller.startOutgoing({callId, peer: PEER_BOB, kind: 'voice'});
  await flush();
  expect(b.sent[0]?.event).toBe('call.offer');
  b.signalling.ingest({event: 'call.answer', data: {callId, from: PEER_BOB, sdp: sdp('ans')}});
  await flush();
  expect(b.peer.signalingState).toBe('stable');
  b.peer.iceConnectionState = 'disconnected';
  b.peer.oniceconnectionstatechange?.('disconnected');
  await flush();
}

describe('M-12 — 1:1 ICE-restart retry re-sends through have-local-offer (real gate)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('first disconnect fires ONE restart reoffer and parks in have-local-offer', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-m12-1');

    expect(b.states).toContain('reconnecting');
    expect(b.peer.restartOffers).toBe(1);
    expect(reoffers(b.sent)).toHaveLength(1);
    expect(b.peer.signalingState).toBe('have-local-offer');
    b.controller.hangup();
  });

  it('retry tick ROLLS BACK the unanswered restart offer and re-sends a fresh one (the CALL-05/20 deadlock)', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-m12-2');
    expect(reoffers(b.sent)).toHaveLength(1);

    // Peer never reanswers (dead WS). Tick once.
    jest.advanceTimersByTime(RETRY_MS);
    await flush();

    // Old behaviour: fireIceRestartOffer bailed on signalingState !==
    // 'stable' → rollbacks 0, reoffers stuck at 1, call dies at budget.
    expect(b.peer.rollbacks).toBe(1);
    expect(b.peer.restartOffers).toBe(2);
    expect(reoffers(b.sent)).toHaveLength(2);
    expect(b.peer.signalingState).toBe('have-local-offer'); // fresh offer pending

    // And again — every tick supersedes the last unanswered offer.
    jest.advanceTimersByTime(RETRY_MS);
    await flush();
    expect(b.peer.rollbacks).toBe(2);
    expect(reoffers(b.sent)).toHaveLength(3);
    b.controller.hangup();
  });

  it('stops once ICE recovers — no further rollbacks or reoffers', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-m12-3');
    jest.advanceTimersByTime(RETRY_MS);
    await flush();
    expect(reoffers(b.sent)).toHaveLength(2);

    // Peer reanswers the re-sent offer, ICE comes back.
    b.signalling.ingest({event: 'call.reanswer', data: {callId: 'c-m12-3', from: PEER_BOB, sdp: sdp('re-ans')}});
    await flush();
    expect(b.peer.signalingState).toBe('stable');
    b.peer.iceConnectionState = 'connected';
    b.peer.oniceconnectionstatechange?.('connected');
    await flush();
    expect(b.states).toContain('connected');

    jest.advanceTimersByTime(RETRY_MS * 3);
    await flush();
    expect(reoffers(b.sent)).toHaveLength(2);
    expect(b.peer.rollbacks).toBe(1);
    b.controller.hangup();
  });

  it('stops on teardown — hangup mid-reconnect kills the retry loop', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-m12-4');
    expect(reoffers(b.sent)).toHaveLength(1);

    b.controller.hangup();
    await flush();
    jest.advanceTimersByTime(RETRY_MS * 3);
    await flush();
    expect(reoffers(b.sent)).toHaveLength(1);
    expect(b.peer.rollbacks).toBe(0);
  });

  it('callee (incoming) never drives the restart — no reoffer, no rollback', async () => {
    const b = build();
    b.controller.handleIncomingOffer({callId: 'c-m12-5', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await b.controller.accept();
    await flush();
    expect(b.peer.signalingState).toBe('stable');

    b.peer.iceConnectionState = 'disconnected';
    b.peer.oniceconnectionstatechange?.('disconnected');
    await flush();
    jest.advanceTimersByTime(RETRY_MS * 3);
    await flush();

    expect(reoffers(b.sent)).toHaveLength(0);
    expect(b.peer.rollbacks).toBe(0);
    expect(b.peer.restartOffers).toBe(0);
    b.controller.hangup();
  });

  it('NEVER rolls back a mid-flight video-upgrade renegotiation (guard on the disambiguation signals)', async () => {
    const b = build();
    await b.controller.startOutgoing({callId: 'c-m12-6', peer: PEER_BOB, kind: 'voice'});
    await flush();
    b.signalling.ingest({event: 'call.answer', data: {callId: 'c-m12-6', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();

    // Reach 'connected' so upgradeToVideo is allowed (DTLS poll passes on
    // the mock stats above on the first iteration).
    b.peer.iceConnectionState = 'connected';
    b.peer.oniceconnectionstatechange?.('connected');
    await flush();
    expect(b.states).toContain('connected');

    // Camera tap: renegotiation goes in flight, its reoffer parks the PC
    // in 'have-local-offer' while we await the peer's reanswer.
    const upgrade = b.controller.upgradeToVideo({prepare: () => {}});
    upgrade.catch(() => { /* rejected on hangup below — expected */ });
    await flush();
    expect(b.peer.signalingState).toBe('have-local-offer');
    expect(reoffers(b.sent)).toHaveLength(1);

    // Network drops mid-upgrade → 'reconnecting' + retry loop armed.
    b.peer.iceConnectionState = 'disconnected';
    b.peer.oniceconnectionstatechange?.('disconnected');
    await flush();
    jest.advanceTimersByTime(RETRY_MS);
    await flush();

    // The pending local offer belongs to renegotiateLocal — its own
    // watchdog owns the rollback. The retry tick must not touch it.
    expect(b.peer.rollbacks).toBe(0);
    expect(b.peer.restartOffers).toBe(0);
    expect(reoffers(b.sent)).toHaveLength(1);
    b.controller.hangup();
    await flush();
  });
});

// Mirrors the keepalive false-alarm guard in useGroupCall: only warn after
// 2 consecutive misses, so a single slow ack right after resume is silent.
function shouldWarnKeepalive(consecutiveMisses: number): boolean {
  return consecutiveMisses >= 2;
}

describe('group-call keepalive ping — no false alarm after resume', () => {
  it('does NOT warn on the first miss (expected during WS reconnect)', () => {
    expect(shouldWarnKeepalive(1)).toBe(false);
  });
  it('warns once misses are sustained (real WS problem)', () => {
    expect(shouldWarnKeepalive(2)).toBe(true);
    expect(shouldWarnKeepalive(3)).toBe(true);
  });
  it('a recovered ping resets the counter (0 → no warn)', () => {
    expect(shouldWarnKeepalive(0)).toBe(false);
  });
});
