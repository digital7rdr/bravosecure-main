/**
 * B-273 — outbound ICE raced ahead of the offer, and the relay dropped it.
 * B-274 — accept() could resolve without answering, stranding "Answering…".
 *
 * Both were found from staging relay logs on 2026-07-26, on a call the founder
 * placed. The server saw, on every outgoing call:
 *
 *     [CALL] ICE   from=88d34848 → 3165d0e1 cid=f5ac6445   (x3)
 *     [CALL] OFFER from=88d34848 → 3165d0e1 cid=f5ac6445
 *
 * ICE BEFORE the offer. `handleCallIce` runs `authorizeCallFrame`, which
 * silently ignores frames for a callId it has no session for — and the session
 * is created by the offer. So those three candidates were discarded by the
 * relay, every time. They are the FIRST gathered, i.e. host + server-reflexive:
 * exactly the ones that let an easy-NAT call connect without touching TURN.
 *
 * Cause: `createOffer()` also applies the local description, so gathering (and
 * `onicecandidate`) starts the moment it returns — but the offer frame is not
 * sent until after `await buildOfferAuth(...)`, which can take hundreds of ms.
 *
 * And on the same call the callee showed "Answering…" forever while sending no
 * answer, no ICE, and no hangup — the signature of accept() taking one of its
 * bare `if (cancelled || !pc || pc.isClosed()) return;` exits, which resolve
 * the promise normally.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

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
    getStats: async () => new Map<string, StatsReport>(),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

const PEER_BOB = {userId: 'bob', deviceId: 1};

function build(opts: {
  buildOfferAuth?: CallController['opts']['buildOfferAuth'];
  attachLocalMedia?: (pc: PeerConnectionLike) => Promise<void> | void;
} = {}) {
  const sent: ClientFrame[] = [];
  const t = {state: 'connected', send: (f: ClientFrame) => { sent.push(f); }};
  const signalling = new CallSignalling(t as unknown as TransportClient);
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
    connectingWatchdogMs: 60_000,
    ...(opts.buildOfferAuth    ? {buildOfferAuth:    opts.buildOfferAuth}    : {}),
    ...(opts.attachLocalMedia  ? {attachLocalMedia:  opts.attachLocalMedia}  : {}),
  } as ConstructorParameters<typeof CallController>[0]);
  liveControllers.push(controller);
  return {controller, sent, states, peers};
}

// Timer-leak hygiene: a test that ends with the controller in 'connecting'
// (e.g. the accept() success case) leaves a REAL connecting-watchdog armed.
// jest keeps the worker process alive across suites, so that timer fires
// ~20-60s later INSIDE WHICHEVER SUITE the worker is then running —
// "Cannot log after tests are done" poisoning an unrelated file (the
// documented B-126/B-304 moving-flake mechanism). Hang everything up before
// leaving each test; hangup on an already-terminal controller is a no-op.
const liveControllers: CallController[] = [];
afterEach(() => {
  for (const c of liveControllers) {
    try { c.hangup('ended'); } catch { /* already terminal */ }
  }
  liveControllers.length = 0;
});

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) {await Promise.resolve();}
};

const fireCandidate = (p: MutablePeer, label: string): void => {
  (p.onicecandidate as ((e: unknown) => void) | null)?.({
    candidate: {candidate: `candidate:${label} 1 udp 2130706431 10.0.0.1 5000 typ host`,
      sdpMid: '0', sdpMLineIndex: 0},
  });
};

const events = (sent: ClientFrame[]): string[] => sent.map(f => (f as {event: string}).event);

describe('B-273 — no ICE may leave before the offer that authorizes it', () => {
  it('candidates gathered during buildOfferAuth are HELD, then flushed after the offer', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const {controller, sent, peers} = build({
      buildOfferAuth: (async () => { await gate; return undefined; }) as never,
    });

    void controller.startOutgoing({callId: 'c-273', peer: PEER_BOB, kind: 'video'});
    await flush();

    // Mid-flight: the local description is applied and the engine is
    // gathering, but the offer frame has not been sent yet.
    expect(peers).toHaveLength(1);
    fireCandidate(peers[0], 'host-1');
    fireCandidate(peers[0], 'host-2');
    expect(events(sent)).not.toContain('call.offer');
    // THE BUG: without the gate these two are already on the wire, ahead of
    // the offer, and the relay discards them as an unknown callId.
    expect(events(sent)).not.toContain('call.ice');

    release();
    await flush();

    const order = events(sent);
    expect(order).toContain('call.offer');
    expect(order).toContain('call.ice');
    expect(order.indexOf('call.offer')).toBeLessThan(order.indexOf('call.ice'));
    expect(order.filter(e => e === 'call.ice')).toHaveLength(2);
  });

  it('candidates gathered AFTER the offer still go straight out', async () => {
    const {controller, sent, peers} = build();
    await controller.startOutgoing({callId: 'c-273b', peer: PEER_BOB, kind: 'voice'});
    await flush();
    const before = events(sent).filter(e => e === 'call.ice').length;
    fireCandidate(peers[0], 'srflx-1');
    expect(events(sent).filter(e => e === 'call.ice')).toHaveLength(before + 1);
  });

  it('the answerer holds its candidates until the ANSWER is sent', async () => {
    const {controller, sent, peers} = build();
    controller.handleIncomingOffer({callId: 'c-273c', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    const order = events(sent);
    expect(order).toContain('call.answer');
    fireCandidate(peers[0], 'host-a');
    const after = events(sent);
    expect(after.indexOf('call.answer')).toBeLessThan(after.lastIndexOf('call.ice'));
  });

  it('teardown closes the gate again, so a late candidate is not emitted', async () => {
    // A CallController never returns to 'idle' (startOutgoing throws
    // 'call already in progress' otherwise), so the reused-instance path the
    // teardown comment describes is not reachable from here. What IS
    // observable is the hygiene itself: after teardown the gate is shut and
    // the queue empty, so a candidate arriving late from the closed pc does
    // not go on the wire for a call that is already over.
    const {controller, sent, peers} = build();
    await controller.startOutgoing({callId: 'c-273d', peer: PEER_BOB, kind: 'voice'});
    await flush();
    controller.hangup('ended');
    await flush();

    const before = events(sent).filter(e => e === 'call.ice').length;
    fireCandidate(peers[0], 'host-after-teardown');
    expect(events(sent).filter(e => e === 'call.ice')).toHaveLength(before);
  });
});

describe('B-274 — accept() never resolves silently on a call it did not answer', () => {
  it('a camera/mic acquisition failure ENDS the call instead of stranding it', async () => {
    // The founder's two failed calls were both kind=video; the one that
    // succeeded that hour was audio-only. attachLocalMedia is where a video
    // answer acquires the camera, and it runs BEFORE createAnswer.
    const {controller, sent, states} = build({
      attachLocalMedia: async () => { throw new Error('camera unavailable'); },
    });
    controller.handleIncomingOffer({callId: 'c-274', from: PEER_BOB, sdp: sdp('inb'), kind: 'video'});

    await expect(controller.accept()).rejects.toThrow('camera unavailable');
    await flush();

    // THE BUG: previously this threw into a caller with no catch, so no
    // hangup was sent and the state stayed 'ringing' — the caller rang out
    // while the callee sat behind "Answering…".
    expect(events(sent)).toContain('call.hangup');
    expect(states).toContain('failed');
    // ...and it does not linger in a live state the UI would render as
    // "Answering…". The last transition is terminal.
    expect(states[states.length - 1]).toBe('failed');
  });

  it('a successful accept sends an answer and does NOT hang up', async () => {
    const {controller, sent, states} = build();
    controller.handleIncomingOffer({callId: 'c-274b', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(events(sent)).toContain('call.answer');
    expect(events(sent)).not.toContain('call.hangup');
    expect(states).toContain('connecting');
  });

  it('accepting when nothing is ringing still throws, and hangs nothing up', async () => {
    // Guard the guard: the pre-check must stay a plain throw. Routing it
    // through the new failure path would hang up an unrelated live call.
    const {controller, sent} = build();
    await expect(controller.accept()).rejects.toThrow('no incoming call to accept');
    expect(events(sent)).not.toContain('call.hangup');
  });
});
