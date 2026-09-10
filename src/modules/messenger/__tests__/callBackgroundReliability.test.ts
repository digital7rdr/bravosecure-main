/**
 * Wave 3 background-reliability regressions for the 1:1 CallController.
 *
 * P1-BR-6 (B-60/B-61) — a HUNG native getStats() inside the DTLS-verify
 * poll used to wedge the call at 'connecting' forever (audio flowed, the
 * timer never armed, the status never flipped). The fix:
 *   (a) races each verifyDtlsSrtp() against a 1 s timeout — a timeout is a
 *       FAILED iteration (budget advances) and emits a `dtls-poll-hung` log;
 *   (b) promotes to 'connected' RIGHT off the ICE connected/completed event
 *       so a stats-layer stall can no longer withhold the state;
 *   (c) DTLS-SRTP verification still runs UNCONDITIONALLY as a follow-up
 *       gate and end('failed')s the call on GENUINE verification failure.
 *
 * P2-BR-6 — the mid-call ICE-restart reconnect budget is now paused on
 * background and re-probed/extended on foreground, so a frozen RN timer
 * can't flush-expire the instant the user taps back into the call.
 *
 * These drive the REAL CallController against a mock PC (same harness style
 * as callIceRestartRetry.test.ts), not a re-implementation.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

const PEER_BOB = {userId: 'bob', deviceId: 1};

type StatsMode = 'ok' | 'hung' | 'fail';

interface TrackedPeer extends PeerConnectionLike {
  signalingState:     string;
  iceConnectionState: string;
  statsMode:          StatsMode;
  restartOffers:      number;
  rollbacks:          number;
}

function okStats(): Map<string, StatsReport> {
  return new Map<string, StatsReport>([
    ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', selectedCandidatePairId: 'cp', remoteCertificateId: 'cr'}],
    ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
  ]);
}
function failStats(): Map<string, StatsReport> {
  // DTLS never reaches 'connected' — a GENUINE verification failure.
  return new Map<string, StatsReport>([
    ['t0', {type: 'transport', dtlsState: 'failed', srtpCipher: 'AEAD_AES_128_GCM', selectedCandidatePairId: 'cp', remoteCertificateId: 'cr'}],
    ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
  ]);
}

function fakePeer(): TrackedPeer {
  const p: TrackedPeer = {
    signalingState:     'stable',
    iceConnectionState: 'new',
    statsMode:          'ok',
    restartOffers:      0,
    rollbacks:          0,
    createOffer: (async (opts?: {iceRestart?: boolean}) => {
      if (opts?.iceRestart) {p.restartOffers += 1;}
      return {type: 'offer' as const, sdp: sdp(opts?.iceRestart ? `restart-${p.restartOffers}` : 'offer')};
    }) as PeerConnectionLike['createOffer'],
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription: (async (desc: {type: string}) => {
      if (desc.type === 'rollback') { p.rollbacks += 1; p.signalingState = 'stable'; return; }
      if (desc.type === 'offer')    { p.signalingState = 'have-local-offer'; return; }
      if (desc.type === 'answer')   { p.signalingState = 'stable'; }
    }) as PeerConnectionLike['setLocalDescription'],
    setRemoteDescription: async (desc: {type: 'offer' | 'answer'; sdp: string}) => {
      p.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    },
    addIceCandidate: async () => {},
    addTrack:        () => {},
    close:           () => {},
    getStats: (async () => {
      if (p.statsMode === 'hung') {return new Promise<never>(() => { /* never settles */ });}
      if (p.statsMode === 'fail') {return failStats();}
      return okStats();
    }) as PeerConnectionLike['getStats'],
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
  return p;
}

function build() {
  const sent: ClientFrame[] = [];
  const transport = {state: 'connected', send: (f: ClientFrame) => { sent.push(f); }} as unknown as TransportClient;
  const signalling = new CallSignalling(transport);
  const peer = fakePeer();
  const pcFactory: PeerConnectionFactory = () => peer;
  const states: string[] = [];
  const secured: unknown[] = [];
  const controller = new CallController({
    signalling, pcFactory, iceServers: [],
    onState:   s => states.push(s),
    onSecured: i => secured.push(i),
  });
  return {controller, signalling, sent, states, secured, peer};
}

const flush = async (n = 12) => { for (let i = 0; i < n; i++) {await Promise.resolve();} };
const reoffers = (sent: ClientFrame[]) => sent.filter(f => f.event === 'call.reoffer');

/** startOutgoing → answer applied → ICE 'connected' fired (poll begins). */
async function driveToIceConnected(b: ReturnType<typeof build>, callId: string) {
  await b.controller.startOutgoing({callId, peer: PEER_BOB, kind: 'voice'});
  await flush();
  b.signalling.ingest({event: 'call.answer', data: {callId, from: PEER_BOB, sdp: sdp('ans')}});
  await flush();
  expect(b.controller.currentState).toBe('connecting');
  b.peer.iceConnectionState = 'connected';
  b.peer.oniceconnectionstatechange?.('connected');
  await flush();
}

describe('P1-BR-6 — DTLS-verify poll no longer wedges the call', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  const loggedIncludes = (spy: jest.SpyInstance, needle: string): boolean =>
    spy.mock.calls.some(args => args.some(a => typeof a === 'string' && a.includes(needle)));

  it('promotes to connected off the ICE event even when getStats() hangs, and logs dtls-poll-hung', async () => {
    const b = build();
    b.peer.statsMode = 'hung';                       // native getStats never settles
    await driveToIceConnected(b, 'c-brg-1');

    // (b) Immediate promotion — the timer/status no longer wait on stats.
    expect(b.controller.currentState).toBe('connected');
    expect(b.states).toContain('connected');

    // (a) After the 1 s per-iteration ceiling, the hung probe is surfaced.
    jest.advanceTimersByTime(1000);
    await flush();
    expect(loggedIncludes(logSpy, 'dtls-poll-hung')).toBe(true);
    // The stall did NOT knock the call back out of 'connected'.
    expect(b.controller.currentState).toBe('connected');

    b.controller.hangup();
  });

  it('normal getStats — still connects AND fires onSecured (verification unchanged on the happy path)', async () => {
    const b = build();
    b.peer.statsMode = 'ok';
    await driveToIceConnected(b, 'c-brg-2');
    await flush();
    expect(b.controller.currentState).toBe('connected');
    expect(b.secured.length).toBeGreaterThan(0);      // DTLS-SRTP confirmed
    b.controller.hangup();
  });

  it('GENUINE DTLS verification failure still end("failed")s the call after the budget', async () => {
    const b = build();
    b.peer.statsMode = 'fail';                         // dtlsState=failed forever
    await driveToIceConnected(b, 'c-brg-3');
    // Promoted first (media path proved ICE) …
    expect(b.controller.currentState).toBe('connected');

    // … then the unconditional verify gate exhausts its 24×250 ms budget
    // and fails the call. Advance timers + flush per iteration.
    for (let i = 0; i < 30; i++) {
      await flush();
      jest.advanceTimersByTime(250);
    }
    await flush(30);

    expect(b.controller.currentState).toBe('failed');
    expect(b.states).toContain('failed');
    expect(b.secured.length).toBe(0);                 // never secured
  });
});

describe('P2-BR-6 — mid-call reconnect budget survives a background/resume', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  async function driveToReconnecting(b: ReturnType<typeof build>, callId: string) {
    await b.controller.startOutgoing({callId, peer: PEER_BOB, kind: 'voice'});
    await flush();
    b.signalling.ingest({event: 'call.answer', data: {callId, from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    b.peer.iceConnectionState = 'disconnected';
    b.peer.oniceconnectionstatechange?.('disconnected');
    await flush();
    expect(b.controller.currentState).toBe('reconnecting');
  }

  it('notifyBackground pauses the budget so a frozen 30 s timer cannot flush-fail on resume', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-brg-4');

    // App backgrounds mid-reconnect → pause the budget + retry loop.
    (b.controller as unknown as {notifyBackground: () => void}).notifyBackground();

    // Simulate the long frozen stint. Without the pause the 30 s budget
    // timer would fire here and end('failed').
    jest.advanceTimersByTime(120_000);
    await flush();

    expect(b.controller.currentState).toBe('reconnecting');   // NOT failed
    b.controller.hangup();
  });

  it('notifyForeground recovers immediately when ICE already healed while backgrounded', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-brg-5');
    (b.controller as unknown as {notifyBackground: () => void}).notifyBackground();

    // Native ICE recovered while JS was frozen; on resume we re-probe it.
    b.peer.iceConnectionState = 'connected';
    (b.controller as unknown as {notifyForeground: () => void}).notifyForeground();
    await flush();

    expect(b.controller.currentState).toBe('connected');
    b.controller.hangup();
  });

  it('notifyForeground re-drives the ICE restart with a fresh window when still disconnected', async () => {
    const b = build();
    await driveToReconnecting(b, 'c-brg-6');
    const before = reoffers(b.sent).length;
    (b.controller as unknown as {notifyBackground: () => void}).notifyBackground();

    // Still down on resume → extend the budget + re-send a restart reoffer,
    // rather than flush-failing.
    (b.controller as unknown as {notifyForeground: () => void}).notifyForeground();
    await flush();

    expect(b.controller.currentState).toBe('reconnecting');
    expect(reoffers(b.sent).length).toBeGreaterThan(before);
    b.controller.hangup();
  });
});
