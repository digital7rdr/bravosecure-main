/**
 * B-62 — 'connecting' watchdog. Both 2026-07-10 Pixel-7a failed answers
 * wedged in 'connecting' forever: the ring timer is cancelled at accept
 * and the reconnect budget only arms after a first connect, so a lost
 * call.answer left no timer at all. The watchdog (armed on the
 * 'connecting' transition) must end the call as failed — which drives
 * every teardown path (FGS notif, InCallManager, registry) — and must
 * NOT fire once the call reaches 'connected' or ends cleanly.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

function fakeTransport(initial = 'connected') {
  const sent: ClientFrame[] = [];
  // NA-05 — mirrors TransportClient.send(): throws when the socket is down, so
  // a frame queued during an outage is genuinely absent from the wire.
  const t = {
    state: initial,
    send: (f: ClientFrame) => {
      if (t.state !== 'connected') {throw new Error('transport not open');}
      sent.push(f);
    },
  };
  return {sent, t, transport: t as unknown as TransportClient};
}

type MutablePeer = PeerConnectionLike & {iceConnectionState?: string};

function fakePeer(): MutablePeer {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: sdp('offer')}),
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => new Map<string, StatsReport>([
      ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
      ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

const PEER_BOB = {userId: 'bob', deviceId: 1};

function build(opts: {connectingWatchdogMs?: number; transportState?: string} = {}) {
  const {sent, t, transport} = fakeTransport(opts.transportState ?? 'connected');
  const signalling = new CallSignalling(transport);
  const peers: MutablePeer[] = [];
  const pcFactory: PeerConnectionFactory = () => {
    const p = fakePeer();
    peers.push(p);
    return p;
  };
  const states: string[] = [];
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState:       s => states.push(s),
    onMissedCall:  jest.fn(),
    ringTimeoutMs: 60_000,
    connectingWatchdogMs: opts.connectingWatchdogMs ?? 1000,
  });
  return {controller, signalling, sent, states, peers, t};
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {await Promise.resolve();}
}

describe('B-62 — CallController connecting watchdog', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('callee stuck in connecting after accept() → hangup(failed) + state failed', async () => {
    const {controller, sent, states} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-1', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');
    expect(sent.find(f => f.event === 'call.answer')).toBeDefined();

    // No ICE ever connects. The watchdog must end the call.
    jest.advanceTimersByTime(1000);
    await flush();

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect((hangup as {data: {reason: string}}).data.reason).toBe('failed');
    expect(states).toContain('failed');
  });

  it('caller stuck in connecting after answer → watchdog fires', async () => {
    const {controller, signalling, sent, states} = build({connectingWatchdogMs: 1000});
    await controller.startOutgoing({callId: 'c-wd-2', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-wd-2', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    expect(states).toContain('connecting');

    jest.advanceTimersByTime(1000);
    await flush();

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect(states).toContain('failed');
  });

  it('ICE connected before the deadline cancels the watchdog', async () => {
    const {controller, sent, states, peers} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-3', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');

    // Simulate the ICE agent connecting at 500 ms.
    jest.advanceTimersByTime(500);
    const peer = peers[peers.length - 1];
    peer.iceConnectionState = 'connected';
    (peer.oniceconnectionstatechange as unknown as (() => void) | null)?.();
    await flush();
    expect(states).toContain('connected');

    // Run well past the original deadline — no failure, no hangup.
    jest.advanceTimersByTime(5000);
    await flush();
    expect(sent.find(f => f.event === 'call.hangup')).toBeUndefined();
    expect(states).not.toContain('failed');
    controller.hangup();
  });

  it('watchdog promotes instead of failing when ICE is connected but the event was missed', async () => {
    const {controller, sent, states, peers} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-5', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');

    // ICE agent connected, but the statechange event never fired (cold-answer
    // double-mount race) — the watchdog must promote, not kill a live call.
    const peer = peers[peers.length - 1];
    peer.iceConnectionState = 'connected';
    jest.advanceTimersByTime(1000);
    await flush();

    expect(states).toContain('connected');
    expect(sent.find(f => f.event === 'call.hangup')).toBeUndefined();
    expect(states).not.toContain('failed');
    controller.hangup();
  });

  it('NA-05 — the watchdog clock starts at answer-delivery, not at accept', async () => {
    const {controller, sent, states, t} = build({connectingWatchdogMs: 1000, transportState: 'reconnecting'});
    controller.handleIncomingOffer({callId: 'c-wd-6', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');

    // WS still down at 850 ms — the answer has not reached the socket, so the
    // call must not be killed yet.
    await jest.advanceTimersByTimeAsync(850);
    expect(sent.find(f => f.event === 'call.answer')).toBeUndefined();
    expect(states).not.toContain('failed');

    // Socket returns; the next poll tick (900 ms) lands the answer and re-arms.
    t.state = 'connected';
    await jest.advanceTimersByTimeAsync(100);
    expect(sent.find(f => f.event === 'call.answer')).toBeDefined();

    // The pre-fix watchdog would already have fired at 1000 ms. The re-armed
    // one gives a fresh 1000 ms from delivery.
    await jest.advanceTimersByTimeAsync(900);
    expect(states).not.toContain('failed');

    await jest.advanceTimersByTimeAsync(200);
    expect(states).toContain('failed');
    const hangup = sent.find(f => f.event === 'call.hangup');
    expect((hangup as {data: {reason: string}}).data.reason).toBe('failed');
  });

  it('NA-05 — peer hangup abandons an answer still queued on a down transport', async () => {
    const {controller, signalling, sent, t} = build({connectingWatchdogMs: 60_000, transportState: 'reconnecting'});
    controller.handleIncomingOffer({callId: 'c-wd-7', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();

    signalling.ingest({event: 'call.hangup', data: {callId: 'c-wd-7', from: PEER_BOB, reason: 'ended'}});
    await flush();

    t.state = 'connected';
    await jest.advanceTimersByTimeAsync(1000);
    expect(sent.find(f => f.event === 'call.answer')).toBeUndefined();
  });

  it('clean hangup before the deadline leaves no stray watchdog', async () => {
    const {controller, sent, states} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-4', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    controller.hangup();
    await flush();

    jest.advanceTimersByTime(5000);
    await flush();

    const hangups = sent.filter(f => f.event === 'call.hangup');
    expect(hangups).toHaveLength(1);
    expect((hangups[0] as {data: {reason: string}}).data.reason).toBe('ended');
    expect(states).not.toContain('failed');
  });
});
