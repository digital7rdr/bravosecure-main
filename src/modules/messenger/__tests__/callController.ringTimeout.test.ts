/**
 * Audit P0-C5 — CallController integration: ring timeout drives missed-
 * call. End-to-end wiring test, complementing the unit test for
 * `CallRingState` (callRingState.test.ts) which only covers the timer.
 *
 * Outgoing scenario:
 *  - startOutgoing → call.offer sent → 45 s pass with no answer
 *  - controller emits call.hangup with reason 'ended'
 *  - host's onMissedCall fires with direction='outgoing'
 *  - call state ends terminal
 *
 * Incoming scenario:
 *  - handleIncomingOffer → state=ringing → 45 s pass with no accept
 *  - controller emits call.hangup
 *  - host's onMissedCall fires with direction='incoming'
 *
 * Cancel scenarios:
 *  - answer arriving cancels caller-side timer (no missed-call)
 *  - accept() cancels callee-side timer (no missed-call)
 *  - decline() cancels callee-side timer (no missed-call)
 *  - hangup() cancels timer (no missed-call)
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

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

function fakePeer(): PeerConnectionLike {
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

function build(opts: {ringTimeoutMs?: number; onMissedCall?: jest.Mock} = {}) {
  const {sent, transport} = fakeTransport();
  const signalling = new CallSignalling(transport);
  const pcFactory: PeerConnectionFactory = () => fakePeer();
  const states: string[] = [];
  const onMissedCall = opts.onMissedCall ?? jest.fn();
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState:       s => states.push(s),
    onMissedCall,
    ringTimeoutMs: opts.ringTimeoutMs ?? 1000,
  });
  return {controller, signalling, sent, states, onMissedCall};
}

describe('Audit P0-C5 — CallController ring timeout integration', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('caller-side: 45 s with no answer → hangup emitted + missed_call_outgoing', async () => {
    const {controller, sent, states, onMissedCall} = build({ringTimeoutMs: 1000});
    await controller.startOutgoing({callId: 'c-ring-1', peer: PEER_BOB, kind: 'voice'});
    // Flush the per-callId queue's chained microtasks for the offer.
    for (let i = 0; i < 6; i++) {await Promise.resolve();}
    expect(sent[0]?.event).toBe('call.offer');

    // Advance past the timeout.
    jest.advanceTimersByTime(1000);
    // Hangup is enqueued through CallSignalling.waitOpenThenSend which
    // chains off the offer's microtask queue. Flush both the controller's
    // sync end() path and the queue's then-chain.
    for (let i = 0; i < 8; i++) {await Promise.resolve();}

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect((hangup as {data: {reason: string}}).data.reason).toBe('ended');

    expect(onMissedCall).toHaveBeenCalledWith({
      callId:    'c-ring-1',
      peer:      PEER_BOB,
      direction: 'outgoing',
      kind:      'voice',
    });
    expect(states).toContain('ended');
    controller.hangup();
  });

  it('callee-side: 45 s with no accept → hangup emitted + missed_call_incoming', async () => {
    const {controller, sent, states, onMissedCall} = build({ringTimeoutMs: 1000});
    controller.handleIncomingOffer({callId: 'c-ring-2', from: PEER_BOB, sdp: sdp('inb'), kind: 'video'});
    expect(states).toContain('ringing');

    jest.advanceTimersByTime(1000);
    await Promise.resolve(); await Promise.resolve();

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect(onMissedCall).toHaveBeenCalledWith({
      callId:    'c-ring-2',
      peer:      PEER_BOB,
      direction: 'incoming',
      kind:      'video',
    });
    expect(states).toContain('ended');
    controller.hangup();
  });

  it('answer arriving before timeout cancels timer — no missed-call', async () => {
    const {controller, signalling, sent, onMissedCall} = build({ringTimeoutMs: 1000});
    await controller.startOutgoing({callId: 'c-cancel-1', peer: PEER_BOB, kind: 'voice'});
    await Promise.resolve(); await Promise.resolve();
    expect(sent[0]?.event).toBe('call.offer');

    // Answer arrives at 500 ms.
    jest.advanceTimersByTime(500);
    signalling.ingest({event: 'call.answer', data: {callId: 'c-cancel-1', from: PEER_BOB, sdp: sdp('ans')}});
    await Promise.resolve(); await Promise.resolve();

    // Run well past the original 1000 ms deadline.
    jest.advanceTimersByTime(5000);
    expect(onMissedCall).not.toHaveBeenCalled();
    controller.hangup();
  });

  it('accept() before timeout cancels timer — no missed-call', async () => {
    const {controller, onMissedCall} = build({ringTimeoutMs: 1000});
    controller.handleIncomingOffer({callId: 'c-cancel-2', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    jest.advanceTimersByTime(5000);
    expect(onMissedCall).not.toHaveBeenCalled();
    controller.hangup();
  });

  it('decline() before timeout cancels timer — no missed-call', async () => {
    const {controller, onMissedCall, sent} = build({ringTimeoutMs: 1000});
    controller.handleIncomingOffer({callId: 'c-cancel-3', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    controller.decline();
    // Flush the per-callId queue's chained microtasks for the hangup.
    for (let i = 0; i < 4; i++) {await Promise.resolve();}
    jest.advanceTimersByTime(5000);
    expect(onMissedCall).not.toHaveBeenCalled();
    const hangup = sent.find(f => f.event === 'call.hangup');
    expect((hangup as {data: {reason: string}}).data.reason).toBe('declined');
  });

  it('hangup() before timeout cancels timer — no missed-call', async () => {
    const {controller, onMissedCall} = build({ringTimeoutMs: 1000});
    await controller.startOutgoing({callId: 'c-cancel-4', peer: PEER_BOB, kind: 'voice'});
    await Promise.resolve(); await Promise.resolve();
    controller.hangup();
    jest.advanceTimersByTime(5000);
    expect(onMissedCall).not.toHaveBeenCalled();
  });

  it('peer-hangup while ringing fires missed_call_incoming (caller cancelled)', async () => {
    const {controller, signalling, onMissedCall, states} = build({ringTimeoutMs: 5000});
    controller.handleIncomingOffer({callId: 'c-peer-h', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    expect(states).toContain('ringing');
    // Peer cancels before we accept.
    signalling.ingest({event: 'call.hangup', data: {callId: 'c-peer-h', from: PEER_BOB, reason: 'ended'}});
    await Promise.resolve();
    expect(onMissedCall).toHaveBeenCalledWith({
      callId:    'c-peer-h',
      peer:      PEER_BOB,
      direction: 'incoming',
      kind:      'voice',
    });
    expect(states).toContain('ended');
  });
});
