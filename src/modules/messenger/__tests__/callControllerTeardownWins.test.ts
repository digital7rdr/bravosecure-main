/**
 * B-307 — teardown WINS the race against ICE-restart, quietly and terminally.
 *
 * Device trace (OPPO, 2026-07-27 run 3, the receiver of a B-301 escalation):
 *
 *   14:23:00.696  iceConnectionState=disconnected      ← host retired the 1:1 on join
 *   14:23:00.699  InCallManager stop()                 ← hangup frame processed, end()
 *   14:23:01.206  [bravo.callController] ice-restart threw:
 *                 "Failed to set local offer sdp: Called in wrong state: closed"
 *
 * The controller had (correctly) kicked an ICE restart on 'disconnected';
 * the peer's hangup then closed the PC underneath the in-flight
 * createRestartOffer. With B-301, this interleaving is the NORMAL receiver
 * experience of an escalation — the 1:1's media dies a beat before its
 * hangup frame — so it must be deterministic:
 *
 *  1. a hangup arriving in ANY restart phase lands the controller in
 *     'ended', and nothing ever resurrects 'reconnecting' after it;
 *  2. the restart retry loop is fully disarmed by teardown — advancing the
 *     clock must produce no further reoffer frames for a dead call;
 *  3. the in-flight restart's throw is SUPPRESSED once the call is
 *     terminal — it is the expected outcome of losing the race, and the
 *     noisy warn sent this session's diagnosis chasing a controller bug
 *     that wasn't one.
 *
 * Why the noise matters more than usual: while 'reconnecting' the UI shows
 * the full-screen ReconnectingOverlay and the back button MINIMIZES instead
 * of popping — a state wedge here is a frozen screen the user cannot leave.
 */
import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

const PEER_BOB = {userId: 'bob', deviceId: 1};

interface FakePeer extends PeerConnectionLike {
  iceConnectionState: string;
  signalingState: string;
  /** Test hook — makes the NEXT createOffer hang until released. */
  _stallNextOffer: () => {releaseWithClosedThrow: () => void};
}

function fakePeer(): FakePeer {
  let stallArmed = false;
  let pendingReject: ((e: Error) => void) | null = null;
  const peer: FakePeer = {
    iceConnectionState: 'new',
    signalingState:     'stable',
    // The RESTART offer is the only one called with {iceRestart: true}
    // (PeerConnectionWrapper.createRestartOffer) — the stall gates on that so
    // the call's ORIGINAL offer proceeds normally.
    createOffer: async (opts?: {iceRestart?: boolean}) => {
      if (opts?.iceRestart === true && stallArmed) {
        return new Promise((_res, rej) => { pendingReject = rej; });
      }
      return {type: 'offer', sdp: sdp('offer')};
    },
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => { peer.signalingState = 'closed'; },
    getStats: async () => new Map<string, StatsReport>([
      ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
      ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
    _stallNextOffer: () => {
      stallArmed = true;
      return {
        releaseWithClosedThrow: () => {
          pendingReject?.(new Error('Failed to set local offer sdp: Called in wrong state: closed'));
          pendingReject = null;
          stallArmed = false;
        },
      };
    },
  };
  return peer;
}

function build() {
  const sent: ClientFrame[] = [];
  const transport = {
    state: 'connected',
    send: (f: ClientFrame) => { sent.push(f); },
  } as unknown as TransportClient;
  const signalling = new CallSignalling(transport);
  const peer = fakePeer();
  const pcFactory: PeerConnectionFactory = () => peer;
  const states: string[] = [];
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState:       s => states.push(s),
    onMissedCall:  jest.fn(),
    ringTimeoutMs: 60_000,
  });
  return {controller, signalling, sent, states, peer};
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) { await Promise.resolve(); }
}

/** Drive an outgoing call to 'connected', then to 'reconnecting'. */
async function driveToReconnecting(h: ReturnType<typeof build>, callId: string): Promise<void> {
  await h.controller.startOutgoing({callId, peer: PEER_BOB, kind: 'voice'});
  await flush();
  h.signalling.ingest({event: 'call.answer', data: {callId, from: PEER_BOB, sdp: sdp('ans')}});
  await flush();
  h.peer.iceConnectionState = 'connected';
  h.peer.oniceconnectionstatechange?.('connected');
  await flush();
  expect(h.states).toContain('connected');
  h.peer.iceConnectionState = 'disconnected';
  h.peer.oniceconnectionstatechange?.('disconnected');
  await flush();
  expect(h.states).toContain('reconnecting');
}

describe('B-307 — teardown wins', () => {
  let warns: string[];
  beforeEach(() => {
    jest.useFakeTimers();
    warns = [];
    jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a hangup during "reconnecting" lands ended — and stays there', async () => {
    const h = build();
    await driveToReconnecting(h, 'c-b307-1');

    h.signalling.ingest({event: 'call.hangup', data: {callId: 'c-b307-1', from: PEER_BOB, reason: 'ended'}});
    await flush();
    expect(h.states[h.states.length - 1]).toBe('ended');

    // The restart retry loop must be disarmed: advancing well past several
    // retry ticks may not resurrect 'reconnecting' or ship reoffers for a
    // dead call.
    const reoffersBefore = h.sent.filter(f => f.event === 'call.reoffer').length;
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(h.states[h.states.length - 1]).toBe('ended');
    expect(h.sent.filter(f => f.event === 'call.reoffer').length).toBe(reoffersBefore);
  });

  it('an in-flight restart that loses to teardown is SUPPRESSED, not warned', async () => {
    const h = build();
    // Arm the stall BEFORE disconnect so the restart's createOffer hangs.
    const gate = h.peer._stallNextOffer();
    await driveToReconnecting(h, 'c-b307-2');

    // Teardown lands while the restart offer is still being created…
    h.signalling.ingest({event: 'call.hangup', data: {callId: 'c-b307-2', from: PEER_BOB, reason: 'ended'}});
    await flush();
    expect(h.states[h.states.length - 1]).toBe('ended');

    // …then the engine rejects the stalled offer exactly the way the closed
    // PC does on device.
    warns.length = 0;
    gate.releaseWithClosedThrow();
    await flush();

    expect(h.states[h.states.length - 1]).toBe('ended');
    // The run-3 noise: "[bravo.callController] cid=… ice-restart threw: …".
    expect(warns.some(w => w.includes('ice-restart') && w.includes('threw'))).toBe(false);
  });
});
