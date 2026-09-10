/**
 * useCall — EXECUTABLE coverage for the 1:1 call hook (611 statements, 0 %
 * before this file). The hook is rendered for real with the REAL
 * `CallController` + `CallSignalling` + `callRegistry` underneath; only the
 * native edges are mocked (react-native-webrtc, the media factory, the
 * dispatcher, the push/CallKit surfaces, the runtime signer).
 *
 * The bugs this pins are the ones the log keeps re-opening:
 *
 *  • B-319 — a notification answer that lands BEFORE iceServers resolve has no
 *    controller. `accept()` used to resolve silently, CallScreen latched the
 *    accept as done, and the callee sat on "Answering…" forever. It must
 *    resolve FALSE, and it must not burn the accept-dedupe or answer the CXCall.
 *  • B-102 A2 — `decline()` must report whether a live controller handled it,
 *    and the incoming-SDP guard must be a STICKY key, not a tombstone: a later
 *    params replace WITHOUT the SDP may not tear a live boot down.
 *  • CALL-N1 — the adopt branch runs BEFORE the incoming-SDP guard, so a
 *    minimized INCOMING call restores instead of stranding on a dead ring.
 *  • CALL-N15 — a stale restore must not ghost-redial a call that just ended.
 *  • A9 — a RINGING incoming call must not light the camera/mic or the privacy
 *    LED; acquisition is deferred to accept().
 *  • "End does not end" — hangup() during the boot window has no controller and
 *    must still force the registry teardown.
 *  • CALL-N8 — an ENDED (released) video track is camera-OFF on the wire, even
 *    though stop() leaves `.enabled` true.
 *  • CALL-N9 — flip must not silently re-activate a released camera.
 *  • The 'ended'/'failed' teardown must stop the local tracks IMMEDIATELY
 *    (the mic/camera LED stayed lit for 30 s+ on every rapid-hangup run).
 *
 * NOTE on mock shape: every jest.mock factory here delegates LAZILY into a
 * module-scope holder. The factories for top-level imports (react-native-webrtc,
 * peerConnectionFactory, callDispatcher) run during the import phase, which is
 * BEFORE this file's own consts are initialised — referencing them eagerly is a
 * TDZ ReferenceError, not a mock.
 */

import {act, renderHook} from '@testing-library/react-native';

// ── native edges ────────────────────────────────────────────────────
jest.mock('react-native-webrtc', () => {
  class MockMediaStream {
    private tracks: Array<{kind: string}>;
    public readonly id = `ms-${Math.random().toString(36).slice(2, 8)}`;
    constructor(tracks: Array<{kind: string}> = []) { this.tracks = [...tracks]; }
    getTracks()      { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: {kind: string})    { this.tracks.push(t); }
    removeTrack(t: {kind: string}) { this.tracks = this.tracks.filter(x => x !== t); }
  }
  return {
    __esModule: true,
    RTCView: 'RTCView',
    MediaStream: MockMediaStream,
    mediaDevices: {getUserMedia: jest.fn()},
  };
});

jest.mock('@modules/messenger/webrtc/peerConnectionFactory', () => ({
  __esModule: true,
  rtcPeerConnectionFactory: () => mockNewPc(),
  getLocalMedia: (opts: {video: boolean}) => mockGetLocalMedia(opts),
  flipCamera:    (args: unknown) => mockFlipCamera(args as never),
  recoverCamera: (args: unknown) => mockRecoverCamera(args as never),
}));

jest.mock('@modules/messenger/webrtc/callDispatcher', () => ({
  __esModule: true,
  registerSignalling: (...a: unknown[]) => mockRegisterSignalling(...(a as [string, unknown])),
}));

jest.mock('@modules/messenger/push/callKitBridge', () => ({
  __esModule: true,
  reportOutgoingCall: (...a: unknown[]) => mockBridge.reportOutgoingCall(...a),
  reportConnected:    (...a: unknown[]) => mockBridge.reportConnected(...a),
  reportEnded:        (...a: unknown[]) => mockBridge.reportEnded(...a),
  reportAnswered:     (...a: unknown[]) => mockBridge.reportAnswered(...a),
  reportMuteChange:   (...a: unknown[]) => mockBridge.reportMuteChange(...a),
}));

jest.mock('@modules/messenger/push/callNotification', () => ({
  __esModule: true,
  dismissCallNotif: (...a: unknown[]) => mockNotif.dismissCallNotif(...a),
}));

jest.mock('@modules/messenger/push/incomingCallCache', () => ({
  __esModule: true,
  clearIncomingCallPayload: (...a: unknown[]) => mockCache.clearIncomingCallPayload(...a),
}));

jest.mock('@modules/messenger/push/fcmBootstrap', () => ({
  __esModule: true,
  markCallAccepted: (...a: unknown[]) => mockFcm.markCallAccepted(...a),
  notifyCallEnded:  (...a: unknown[]) => mockFcm.notifyCallEnded(...a),
}));

jest.mock('@modules/messenger/runtime', () => ({
  __esModule: true,
  getMessengerRuntime: async () => ({
    signCallOfferAuth: async () => ({senderCert: 'sc', sig: 'sg'}),
  }),
}));

jest.mock('@modules/messenger/runtime/callAudioSession', () => ({
  __esModule: true,
  stopSharedAudioSession: (...a: unknown[]) => mockAudioSession.stopSharedAudioSession(...a),
  otherStackHasLiveCall:  () => false,
}));

// ── SUT + real collaborators ────────────────────────────────────────
import {useCall, type UseCallOptions} from '@modules/messenger/webrtc/useCall';
import * as registry from '@modules/messenger/runtime/callRegistry';
import type {TransportClient} from '@bravo/messenger-core';

/**
 * WI-1.1 — the live entry's own key. These tests act as "the surface that owns
 * whatever call is on screen" (the overlay, the product switch), which is
 * exactly the shape that reads the key synchronously at the moment it acts.
 * Falls back to a sentinel id so a test that expects the op to be REFUSED gets
 * a refusal rather than a crash.
 */
const liveKey = (): registry.CallRef => {
  const live = registry.getActiveCall();
  return live ? {callId: live.callId, gen: live.gen} : '__no-live-call__';
};

// ── fakes (initialised AFTER the imports above, hence the lazy factories) ──
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

class FakeTrack {
  public enabled = true;
  public readyState: 'live' | 'ended' = 'live';
  public stopCalls = 0;
  constructor(public readonly kind: 'audio' | 'video', public readonly id: string) {}
  stop() { this.stopCalls += 1; this.readyState = 'ended'; }
}

class FakePc {
  public signalingState = 'stable';
  public iceConnectionState = 'new';
  public added: FakeTrack[] = [];
  public closed = false;
  public oniceconnectionstatechange: ((s?: string) => void) | null = null;
  public onicecandidate: ((e: unknown) => void) | null = null;
  public ontrack: ((e: {streams: unknown[]}) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public onicegatheringstatechange: (() => void) | null = null;
  public statsMap = new Map<string, Record<string, unknown>>([
    ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
    ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
  ]);

  async createOffer()  { return {type: 'offer'  as const, sdp: sdp('offer')}; }
  async createAnswer() { return {type: 'answer' as const, sdp: sdp('answer')}; }
  async setLocalDescription(d: {type: string}) {
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: {type: string}) {
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  /** Set to make the NEXT addTrack throw (mid-call upgrade failure path). */
  public failAddTrack = false;
  addTrack(t: FakeTrack) {
    if (this.failAddTrack) { this.failAddTrack = false; throw new Error('addTrack rejected by engine'); }
    this.added.push(t);
    return {track: t};
  }
  getSenders() {
    return this.added.map(t => ({
      track: t,
      getParameters: () => ({encodings: [{}]}),
      setParameters: async () => {},
    }));
  }
  async getStats() { return this.statsMap; }
  close() { this.closed = true; }
}

/** Every RTCPeerConnection the controller built, newest last. */
const builtPcs: FakePc[] = [];
function mockNewPc(): FakePc { const pc = new FakePc(); builtPcs.push(pc); return pc; }

/** Controls what the next getLocalMedia() hands back. */
const media = {
  calls:     [] as Array<{video: boolean}>,
  failWith:  null as Error | null,
  last:      null as {stream: unknown; audioTrack: FakeTrack | null; videoTrack: FakeTrack | null} | null,
};

const mockGetLocalMedia = jest.fn(async (opts: {video: boolean}) => {
  media.calls.push(opts);
  if (media.failWith) { throw media.failWith; }
  const {MediaStream} = require('react-native-webrtc') as {MediaStream: new (t: unknown[]) => unknown};
  const audio = new FakeTrack('audio', `a-${media.calls.length}`);
  const video = opts.video ? new FakeTrack('video', `v-${media.calls.length}`) : null;
  const stream = new MediaStream(video ? [audio, video] : [audio]);
  media.last = {stream, audioTrack: audio, videoTrack: video};
  return media.last;
});
const mockRecoverCamera    = jest.fn(async (_args?: unknown) => null as FakeTrack | null);
const mockFlipCamera       = jest.fn(async (_args?: unknown) => null as FakeTrack | null);
const mockRegisterSignalling = jest.fn((_callId: string, _sig: unknown) => jest.fn());

const mockBridge = {
  reportOutgoingCall: jest.fn(),
  reportConnected:    jest.fn(),
  reportEnded:        jest.fn(),
  reportAnswered:     jest.fn(),
  reportMuteChange:   jest.fn(),
};
const mockNotif   = {dismissCallNotif: jest.fn(async (..._a: unknown[]) => {})};
const mockCache   = {clearIncomingCallPayload: jest.fn()};
const mockFcm     = {markCallAccepted: jest.fn(), notifyCallEnded: jest.fn()};
const mockAudioSession = {stopSharedAudioSession: jest.fn((..._a: unknown[]) => true)};

// ── harness ─────────────────────────────────────────────────────────
const PEER = {userId: 'bob', deviceId: 1};

let sent: Array<{event: string; data: Record<string, unknown>}>;
let transport: TransportClient;

function makeTransport(): TransportClient {
  sent = [];
  return {
    state: 'connected',
    send: (f: {event: string; data: Record<string, unknown>}) => { sent.push(f); },
  } as unknown as TransportClient;
}

let seq = 0;
const nextCallId = (tag: string) => `c-${tag}-${++seq}`;

function props(over: Partial<UseCallOptions> = {}): UseCallOptions {
  return {
    callId:    nextCallId('x'),
    peer:      PEER,
    kind:      'voice',
    direction: 'outgoing',
    transport,
    iceServers: [],
    ...over,
  };
}

function renderCall(over: Partial<UseCallOptions> = {}) {
  return renderHook((p: UseCallOptions) => useCall(p), {initialProps: props(over)});
}

const settle = async (n = 12) => {
  await act(async () => {
    for (let i = 0; i < n; i++) { await Promise.resolve(); }
  });
};

const frames = (event: string) => sent.filter(f => f.event === event);
const activeSignalling = () =>
  (registry.getActiveCall() as unknown as {signalling: {ingest: (f: unknown) => void}}).signalling;
const localTracks = (h: {localStream: unknown}) =>
  h.localStream as unknown as {getVideoTracks: () => FakeTrack[]; getAudioTracks: () => FakeTrack[]};

beforeEach(() => {
  jest.clearAllMocks();
  builtPcs.length = 0;
  media.calls = [];
  media.failWith = null;
  media.last = null;
  mockRecoverCamera.mockResolvedValue(null);
  mockFlipCamera.mockResolvedValue(null);
  mockRegisterSignalling.mockImplementation(() => jest.fn());
  registry.setActiveCall(null);
  transport = makeTransport();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // A controller left in 'ringing' keeps CallRingState's 45 s timer armed. It
  // fires long after this suite finishes and re-enters useCall's onState, which
  // `require()`s callRegistry into a torn-down environment ("You are trying to
  // `import` a file after the Jest environment has been torn down"). Jest blames
  // whichever suite is running at the time — the B-304 moving-flake shape.
  try { registry.endActiveCall(liveKey(), 'ended', 'local'); } catch { /* nothing live */ }
  registry.setActiveCall(null);
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
describe('boot guards — the hook must never signal on a placeholder', () => {
  it('does not dial while CallScreen is still holding the "demo" peer', async () => {
    const r = renderCall({peer: {userId: 'demo', deviceId: 0}});
    await settle();
    expect(r.result.current.controllerReady).toBe(false);
    expect(sent).toHaveLength(0);
    expect(mockGetLocalMedia).not.toHaveBeenCalled();
    expect(registry.getActiveCall()).toBeNull();
  });

  it('does not dial before the transport exists', async () => {
    const r = renderCall({transport: undefined as unknown as TransportClient});
    await settle();
    expect(r.result.current.controllerReady).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('an incoming call with no offer SDP yet stays a dead ring — no controller, no media', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: undefined});
    await settle();
    expect(r.result.current.state).toBe('ringing');   // seeded, but inert
    expect(r.result.current.controllerReady).toBe(false);
    expect(mockGetLocalMedia).not.toHaveBeenCalled();
    expect(builtPcs).toHaveLength(0);
  });

  it('B-102 A2 — the boot re-fires when the offer SDP finally lands (not a tombstone)', async () => {
    const callId = nextCallId('sticky');
    const base = props({callId, direction: 'incoming', incomingSdp: undefined});
    const r = renderHook((p: UseCallOptions) => useCall(p), {initialProps: base});
    await settle();
    expect(r.result.current.controllerReady).toBe(false);

    r.rerender({...base, incomingSdp: sdp('inb')});
    await settle();
    expect(r.result.current.controllerReady).toBe(true);
    expect(r.result.current.state).toBe('ringing');
  });

  it('B-102 A2 — a later params replace WITHOUT the SDP does not tear the live boot down', async () => {
    const callId = nextCallId('sticky2');
    const base = props({callId, direction: 'incoming', incomingSdp: sdp('inb')});
    const r = renderHook((p: UseCallOptions) => useCall(p), {initialProps: base});
    await settle();
    expect(r.result.current.controllerReady).toBe(true);
    const pcCount = builtPcs.length;

    r.rerender({...base, incomingSdp: undefined});
    await settle();
    expect(r.result.current.controllerReady).toBe(true);
    expect(r.result.current.state).toBe('ringing');
    expect(builtPcs).toHaveLength(pcCount);
    expect(frames('call.hangup')).toHaveLength(0);
  });

  it('CALL-N15 — a stale restore of a just-ended call does NOT ghost-redial', async () => {
    const callId = nextCallId('ghost');
    registry.setActiveCall({
      callId, conversationId: callId, peer: PEER, peerName: '', kind: 'voice',
      direction: 'outgoing', controller: null, signalling: null, unregister: null,
      localStream: null, remoteStream: null, audioTrack: null, videoTrack: null,
      state: 'connected', isMinimized: false, keepAlive: false, connectedAtMs: null,
    } as never);
    registry.setActiveCall(null);
    expect(registry.wasRecentlyEnded(callId)).toBe(true);

    const r = renderCall({callId});
    await settle(20);
    expect(r.result.current.state).toBe('ended');
    expect(frames('call.offer')).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('outgoing boot', () => {
  it('acquires local media, shows the system call UI, and dials', async () => {
    const callId = nextCallId('out');
    const r = renderCall({callId});
    await settle(30);

    expect(media.calls).toEqual([{video: false}]);
    expect(mockBridge.reportOutgoingCall).toHaveBeenCalledWith(
      expect.objectContaining({callId, kind: 'voice'}),
    );
    expect(frames('call.offer')).toHaveLength(1);
    expect(r.result.current.controllerReady).toBe(true);
    expect(r.result.current.localStream).not.toBeNull();

    const active = registry.getActiveCall();
    expect(active?.callId).toBe(callId);
    expect(active?.direction).toBe('outgoing');
    expect(active?.audioTrack).toBe(media.last!.audioTrack);
  });

  it('a video dial acquires the camera and binds BOTH tracks to the peer connection', async () => {
    const r = renderCall({kind: 'video'});
    await settle(30);
    expect(media.calls).toEqual([{video: true}]);
    expect(builtPcs).toHaveLength(1);
    expect(builtPcs[0].added.map(t => t.kind)).toEqual(['audio', 'video']);
    expect(r.result.current.state).toBe('calling');
  });

  it('a getUserMedia denial fails the call instead of hanging on "Calling…"', async () => {
    media.failWith = new Error('permission denied');
    const r = renderCall();
    await settle(30);
    expect(r.result.current.state).toBe('failed');
    expect(frames('call.offer')).toHaveLength(0);
  });

  it('registers with the dispatcher so inbound frames can reach this call', async () => {
    const callId = nextCallId('disp');
    renderCall({callId});
    await settle(30);
    expect(mockRegisterSignalling).toHaveBeenCalledTimes(1);
    expect(mockRegisterSignalling.mock.calls[0][0]).toBe(callId);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('A9 — a ringing incoming call must not light the camera or mic', () => {
  it('defers acquisition until accept()', async () => {
    const r = renderCall({direction: 'incoming', kind: 'video', incomingSdp: sdp('inb')});
    await settle(30);
    expect(r.result.current.state).toBe('ringing');
    expect(mockGetLocalMedia).not.toHaveBeenCalled();
    expect(registry.getActiveCall()?.audioTrack).toBeNull();

    await act(async () => { await r.result.current.accept(); });
    await settle(30);
    expect(media.calls).toEqual([{video: true}]);
    expect(frames('call.answer')).toHaveLength(1);
  });

  it('declining never acquires media at all', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: sdp('inb')});
    await settle(30);
    act(() => { expect(r.result.current.decline()).toBe(true); });
    await settle(30);
    expect(mockGetLocalMedia).not.toHaveBeenCalled();
    expect(frames('call.hangup')[0]?.data.reason).toBe('declined');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('B-319 / B-102 A2 — the null-controller window must be reported, not swallowed', () => {
  it('accept() resolves FALSE and touches neither the dedupe nor the CXCall', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: undefined});
    await settle();
    expect(r.result.current.controllerReady).toBe(false);

    let out: boolean | undefined;
    await act(async () => { out = await r.result.current.accept(); });
    expect(out).toBe(false);
    expect(mockFcm.markCallAccepted).not.toHaveBeenCalled();
    expect(mockBridge.reportAnswered).not.toHaveBeenCalled();
  });

  it('accept() with a live controller pre-latches the dedupe BEFORE answering the CXCall', async () => {
    const callId = nextCallId('acc');
    const r = renderCall({callId, direction: 'incoming', incomingSdp: sdp('inb')});
    await settle(30);

    let out: boolean | undefined;
    await act(async () => { out = await r.result.current.accept(); });
    await settle(30);

    expect(out).toBe(true);
    expect(mockFcm.markCallAccepted).toHaveBeenCalledWith(callId);
    expect(mockBridge.reportAnswered).toHaveBeenCalledWith(callId);
    // B-109 RC-3 — the latch must land FIRST; reportAnswered re-emits answerCall.
    expect(mockFcm.markCallAccepted.mock.invocationCallOrder[0])
      .toBeLessThan(mockBridge.reportAnswered.mock.invocationCallOrder[0]);
  });

  it('decline() returns false in the null-controller window so the caller runs its own teardown', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: undefined});
    await settle();
    let handled: boolean | undefined;
    act(() => { handled = r.result.current.decline(); });
    expect(handled).toBe(false);
    expect(frames('call.hangup')).toHaveLength(0);
  });

  it('"End does not end" — hangup() with no controller still forces OUR registry teardown', async () => {
    // The B-319 boot window, reproduced honestly: the registry entry is for
    // THIS call but carries no controller yet (`controller` is documented as
    // "set after the user accepts/dials"), so hangup() has nothing to hang up
    // and must fall through to the registry teardown.
    const callId = nextCallId('endboot');
    registry.setActiveCall({
      callId, conversationId: callId, peer: PEER, peerName: '', kind: 'voice',
      direction: 'incoming', controller: null, signalling: null, unregister: null,
      localStream: null, remoteStream: null, audioTrack: null, videoTrack: null,
      state: 'ringing', isMinimized: false, keepAlive: false, connectedAtMs: null,
    } as never);

    const r = renderCall({callId, direction: 'incoming', incomingSdp: undefined});
    await settle();
    act(() => { r.result.current.hangup(); });
    expect(registry.getActiveCall()).toBeNull();
  });

  it('WI-1.1 — that same fallback must NOT tear down a different call', async () => {
    // This scenario used to PASS by ending the foreign call, which is exactly
    // the defect WI-1.1 closes: a hook that never registered has no licence to
    // tear down whatever call happens to hold the slot.
    const foreignId = nextCallId('foreign');
    const controller = {hangup: jest.fn()};
    registry.setActiveCall({
      callId: foreignId, conversationId: foreignId, peer: PEER, peerName: '', kind: 'voice',
      direction: 'incoming', controller, signalling: null, unregister: null,
      localStream: null, remoteStream: null, audioTrack: null, videoTrack: null,
      state: 'connected', isMinimized: false, keepAlive: false, connectedAtMs: null,
    } as never);

    const r = renderCall({callId: nextCallId('other'), direction: 'incoming', incomingSdp: undefined});
    await settle();
    act(() => { r.result.current.hangup(); });

    expect(controller.hangup).not.toHaveBeenCalled();
    expect(registry.getActiveCall()?.callId).toBe(foreignId);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('terminal teardown — the mic/camera LED must go out immediately', () => {
  it('a peer hangup stops the local tracks, clears the registry and dismisses every ring surface', async () => {
    const callId = nextCallId('term');
    const r = renderCall({callId});
    await settle(30);
    const audio = media.last!.audioTrack!;
    expect(registry.getActiveCall()?.callId).toBe(callId);

    await act(async () => {
      activeSignalling().ingest({event: 'call.hangup', data: {callId, from: PEER, reason: 'ended'}});
      await Promise.resolve();
    });
    await settle(30);

    expect(r.result.current.state).toBe('ended');
    expect(audio.stopCalls).toBeGreaterThan(0);
    expect(registry.getActiveCall()).toBeNull();
    expect(mockBridge.reportEnded).toHaveBeenCalledWith(callId, 'remoteEnded');
    expect(mockCache.clearIncomingCallPayload).toHaveBeenCalledWith(callId);
    expect(mockNotif.dismissCallNotif).toHaveBeenCalledWith(callId);
    expect(mockFcm.notifyCallEnded).toHaveBeenCalledWith(callId);
    // WI-1.2 — EXACTLY once, end to end. The registry drops the slot before
    // `controller.hangup()`, so the re-entrant `onState` terminal could not
    // tell "my own teardown is in flight" from "the registry does not own
    // this call" and ran its fallback on every end. `reportEnded` is
    // first-write-wins at the bridge, so the duplicate could also stamp the
    // wrong end-reason on a locally-ended call.
    expect(mockBridge.reportEnded).toHaveBeenCalledTimes(1);
    expect(mockCache.clearIncomingCallPayload).toHaveBeenCalledTimes(1);
    expect(mockNotif.dismissCallNotif).toHaveBeenCalledTimes(1);
  });

  it('WI-1.2 — a LOCAL end reports to CallKit exactly once, with the local reason', async () => {
    // The path the remote-hangup test above cannot reach. Here `endActiveCall`
    // is entered from OUTSIDE (floating overlay End, the FGS action, CallScreen
    // End): it drops the slot, calls `controller.hangup()`, and `useCall.onState`
    // re-enters synchronously. That re-entry must be told "your teardown is
    // already in flight" — otherwise it runs its own CallKit/cache/notif
    // fallback and `reportEnded` fires twice. The bridge is first-write-wins,
    // so the duplicate ALSO wins with 'remoteEnded' on a call the user ended.
    const callId = nextCallId('localend');
    const r = renderCall({callId});
    await settle(30);
    expect(registry.getActiveCall()?.callId).toBe(callId);
    mockBridge.reportEnded.mockClear();

    await act(async () => { registry.endActiveCall(liveKey(), 'ended', 'local'); });
    await settle(30);

    expect(r.result.current.state).toBe('ended');
    expect(registry.getActiveCall()).toBeNull();
    expect(mockBridge.reportEnded).toHaveBeenCalledTimes(1);
    expect(mockBridge.reportEnded).toHaveBeenCalledWith(callId, 'declined');
  });

  it('unmounting a NON-minimized call hangs up and releases the tracks', async () => {
    const r = renderCall();
    await settle(30);
    const audio = media.last!.audioTrack!;
    await act(async () => { r.unmount(); });
    await settle(30);
    expect(audio.stopCalls).toBeGreaterThan(0);
    expect(frames('call.hangup')).toHaveLength(1);
  });

  it('unmounting a MINIMIZED call keeps the call alive (the floating overlay owns it)', async () => {
    const r = renderCall();
    await settle(30);
    const audio = media.last!.audioTrack!;
    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { r.unmount(); });
    await settle(30);
    expect(audio.stopCalls).toBe(0);
    expect(frames('call.hangup')).toHaveLength(0);
    expect(registry.getActiveCall()).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
describe('CALL-N1 — adopting a minimized call instead of starting a second one', () => {
  it('restores refs, media and state without building a second peer connection', async () => {
    const callId = nextCallId('adopt');
    const first = renderCall({callId});
    await settle(30);
    const pcCount    = builtPcs.length;
    const mediaCalls = media.calls.length;
    const stream     = first.result.current.localStream;

    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { first.unmount(); });

    // Restore navigates WITHOUT an incomingSdp — adoption must not need it.
    const second = renderCall({callId});
    await settle(30);

    expect(builtPcs).toHaveLength(pcCount);
    expect(media.calls).toHaveLength(mediaCalls);
    expect(second.result.current.controllerReady).toBe(true);
    expect(second.result.current.localStream).toBe(stream);
    expect(registry.getActiveCall()?.isMinimized).toBe(false);
    expect(registry.getActiveCall()?.keepAlive).toBe(false);
  });

  it('an adopted INCOMING call restores as ringing with LIVE controls (not a dead ring)', async () => {
    const callId = nextCallId('adopt-in');
    const first = renderCall({callId, direction: 'incoming', incomingSdp: sdp('inb')});
    await settle(30);
    expect(first.result.current.state).toBe('ringing');
    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { first.unmount(); });

    // The overlay's restore() navigates WITHOUT an incomingSdp — the adopt
    // branch must run BEFORE the incoming-SDP guard or Accept/Decline are dead.
    const second = renderCall({callId, direction: 'incoming'});
    await settle(30);
    expect(second.result.current.controllerReady).toBe(true);
    expect(second.result.current.state).toBe('ringing');

    // Decline reaches the live controller and tells the caller.
    act(() => { expect(second.result.current.decline()).toBe(true); });
    await settle(30);
    expect(frames('call.hangup')[0]?.data.reason).toBe('declined');
  });

  /**
   * DOCUMENTS A LIVE DEFECT (found while writing this suite; not fixed here).
   *
   * ACCEPTING a RINGING incoming call that was minimized and restored FAILS.
   *
   * Why: the controller is built by hook-instance #1, and its `attachLocalMedia`
   * closes over that instance's boot-effect `cancelled` flag. Instance #1's
   * cleanup sets `cancelled = true` UNCONDITIONALLY — before the keepAlive
   * branch (useCall.ts, boot-effect cleanup, first line). A9 defers the
   * answerer's getUserMedia to accept-time, so the restored instance's Accept
   * runs instance #1's `ensureLocalMedia`, which acquires the camera/mic and
   * THEN throws 'useCall: cancelled during media acquisition'. CallController
   * turns that into hangup('failed').
   *
   * Net effect on device: minimize a ringing call → restore → tap Accept →
   * privacy LED blinks and the call dies as "failed" instead of connecting.
   * The OUTGOING adopt path is unaffected because its media was memoised at
   * boot, so ensureLocalMedia returns before the guard.
   *
   * WHEN FIXED: this test must assert `accept()` RESOLVES TRUE and that exactly
   * one `call.answer` frame went out — flip the body to the commented form.
   */
  it('DOCUMENTS — accepting an adopted RINGING call currently fails instead of answering', async () => {
    const callId = nextCallId('adopt-accept');
    const first = renderCall({callId, direction: 'incoming', incomingSdp: sdp('inb')});
    await settle(30);
    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { first.unmount(); });

    const second = renderCall({callId, direction: 'incoming'});
    await settle(30);
    expect(second.result.current.controllerReady).toBe(true);

    await act(async () => {
      await expect(second.result.current.accept())
        .rejects.toThrow(/cancelled during media acquisition/);
    });
    await settle(30);

    // Current (broken) reality: no answer ever reached the caller, the camera
    // was opened for nothing, and the restored screen went terminal.
    expect(frames('call.answer')).toHaveLength(0);
    expect(media.calls).toEqual([{video: false}]);   // acquired, then thrown away
    expect(second.result.current.state).toBe('ended');
    expect(registry.getActiveCall()).toBeNull();
    // WHEN FIXED, the assertions above become:
    //   await expect(second.result.current.accept()).resolves.toBe(true);
    //   expect(frames('call.answer')).toHaveLength(1);
    //   expect(second.result.current.state).toBe('connecting');
  });

  it('WI-1.3 — a cleared slot ENDS the adopted screen and kills the orphan controller', async () => {
    // An empty registry IS the app's "there is no call". Reporting the
    // controller's still-live state here would strand the screen: the overlay
    // renders nothing without a registry entry, and End is a keyed no-op
    // against an empty slot. So the controller gets hung up and the screen
    // goes terminal — never "live call the registry has forgotten".
    const callId = nextCallId('adopt-orphan');
    const first = renderCall({callId});
    await settle(30);
    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { first.unmount(); });

    const second = renderCall({callId});
    await settle(30);
    expect(second.result.current.state).not.toBe('ended');

    // Clear the slot WITHOUT going through endActiveCall — the controller
    // stays live, which is the case the branch exists for.
    await act(async () => { registry.setActiveCall(null); });
    await settle(30);

    expect(second.result.current.state).toBe('ended');
    expect(frames('call.hangup').length).toBeGreaterThan(0);
  });

  it('the adopted hook mirrors registry state changes (L6 — restore must not freeze on stale state)', async () => {
    const callId = nextCallId('adopt-state');
    const first = renderCall({callId});
    await settle(30);
    act(() => { registry.setMinimized(liveKey(), true); });
    await act(async () => { first.unmount(); });

    const second = renderCall({callId});
    await settle(30);
    // The adopted controller's onState was bound to the PRIOR (unmounted)
    // instance, so only the registry mirror can drive THIS screen.
    act(() => { registry.patchActiveCall(liveKey(), {state: 'reconnecting'}); });
    expect(second.result.current.state).toBe('reconnecting');
    // Floating-overlay End: the slot clears and the restored screen must react.
    await act(async () => { registry.endActiveCall(liveKey(), 'ended', 'local'); });
    await settle(30);
    expect(second.result.current.state).toBe('ended');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('local media controls', () => {
  async function live(kind: 'voice' | 'video' = 'voice') {
    const callId = nextCallId('ctl');
    const r = renderCall({callId, kind});
    await settle(30);
    return {r, callId};
  }

  it('toggleMute flips the track, mirrors to the registry, the peer and the system UI', async () => {
    const {r, callId} = await live();
    const audio = media.last!.audioTrack!;

    act(() => { r.result.current.toggleMute(); });
    await settle();

    expect(audio.enabled).toBe(false);
    expect(r.result.current.isMuted).toBe(true);
    expect(registry.getActiveCall()?.isMuted).toBe(true);
    expect(mockBridge.reportMuteChange).toHaveBeenLastCalledWith(callId, true);
    const advisory = frames('call.media-state').at(-1)!;
    expect(advisory.data.micOff).toBe(true);
    // Voice call: no video track at all → camera reported off.
    expect(advisory.data.cameraOff).toBe(true);

    act(() => { r.result.current.toggleMute(); });
    await settle();
    expect(audio.enabled).toBe(true);
    expect(r.result.current.isMuted).toBe(false);
    expect(mockBridge.reportMuteChange).toHaveBeenLastCalledWith(callId, false);
  });

  it('toggleMute is a no-op before the mic exists', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: sdp('inb')});
    await settle(30);
    act(() => { r.result.current.toggleMute(); });
    expect(r.result.current.isMuted).toBe(false);
    expect(frames('call.media-state')).toHaveLength(0);
  });

  it('toggleVideo returns FALSE on a genuine voice call so the caller runs the SDP upgrade instead', async () => {
    const {r} = await live('voice');
    let out: boolean | undefined;
    act(() => { out = r.result.current.toggleVideo(); });
    expect(out).toBe(false);
    expect(r.result.current.isVideoOff).toBe(false);
  });

  it('toggleVideo OFF RELEASES the camera (privacy LED) and rebuilds the stream without video', async () => {
    const {r} = await live('video');
    const video = media.last!.videoTrack!;
    const audio = media.last!.audioTrack!;

    act(() => { expect(r.result.current.toggleVideo()).toBe(true); });
    await settle(30);

    expect(video.stopCalls).toBe(1);
    expect(video.readyState).toBe('ended');
    expect(r.result.current.isVideoOff).toBe(true);
    expect(localTracks(r.result.current).getVideoTracks()).toHaveLength(0);
    expect(localTracks(r.result.current).getAudioTracks()).toEqual([audio]);
    expect(registry.getActiveCall()?.isVideoOff).toBe(true);
    expect(registry.getActiveCall()?.videoTrack).toBeNull();
    expect(frames('call.media-state').at(-1)!.data.cameraOff).toBe(true);
  });

  it('toggleVideo ON re-acquires onto the existing sender and clears the released flag', async () => {
    const {r} = await live('video');
    act(() => { r.result.current.toggleVideo(); });
    await settle(30);

    const replacement = new FakeTrack('video', 'v-replacement');
    mockRecoverCamera.mockResolvedValueOnce(replacement);
    act(() => { expect(r.result.current.toggleVideo()).toBe(true); });
    await settle(30);

    expect(mockRecoverCamera).toHaveBeenCalledTimes(1);
    expect(r.result.current.isVideoOff).toBe(false);
    expect(localTracks(r.result.current).getVideoTracks()).toEqual([replacement]);
    expect(registry.getActiveCall()?.videoTrack).toBe(replacement as never);
    expect(frames('call.media-state').at(-1)!.data.cameraOff).toBe(false);
  });

  it('a failed re-acquire leaves the camera released so a retry tap can try again', async () => {
    const {r} = await live('video');
    act(() => { r.result.current.toggleVideo(); });
    await settle(30);
    mockRecoverCamera.mockResolvedValueOnce(null);
    act(() => { r.result.current.toggleVideo(); });
    await settle(30);
    expect(r.result.current.isVideoOff).toBe(true);
  });

  it('CALL-N8 — a RELEASED camera reports cameraOff even though stop() left .enabled true', async () => {
    const {r} = await live('video');
    const video = media.last!.videoTrack!;
    act(() => { r.result.current.toggleVideo(); });
    await settle(30);
    expect(video.enabled).toBe(true);          // stop() does not clear it
    expect(video.readyState).toBe('ended');

    act(() => { r.result.current.toggleMute(); });
    await settle();
    // The mute advisory must still say the camera is off, or the peer
    // un-hides its placeholder onto a frozen tile.
    expect(frames('call.media-state').at(-1)!.data.cameraOff).toBe(true);
  });

  it('CALL-N9 — flip is IGNORED while the camera is released (it would silently re-stream)', async () => {
    const {r} = await live('video');
    act(() => { r.result.current.toggleVideo(); });
    await settle(30);
    await act(async () => { await r.result.current.flipCamera(); });
    expect(mockFlipCamera).not.toHaveBeenCalled();
    expect(r.result.current.facing).toBe('user');
  });

  it('flipCamera swaps facing and rebuilds the stream so the PiP is not frozen', async () => {
    const {r} = await live('video');
    const flipped = new FakeTrack('video', 'v-back');
    mockFlipCamera.mockResolvedValueOnce(flipped);
    await act(async () => { await r.result.current.flipCamera(); });
    await settle();
    expect(r.result.current.facing).toBe('environment');
    expect(localTracks(r.result.current).getVideoTracks()).toEqual([flipped]);
    expect(registry.getActiveCall()?.facing).toBe('environment');
    expect(registry.getActiveCall()?.videoTrack).toBe(flipped as never);
  });
});

// ────────────────────────────────────────────────────────────────────
/** Drive an already-booted OUTGOING call all the way to 'connected'. */
async function connectOutgoing(callId: string) {
  await act(async () => {
    activeSignalling().ingest({event: 'call.answer', data: {callId, from: PEER, sdp: sdp('ans')}});
    await Promise.resolve();
  });
  await settle(30);
  const pc = builtPcs[builtPcs.length - 1];
  await act(async () => {
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.('connected');
    await Promise.resolve();
  });
  await settle(30);
  return pc;
}

describe('reaching connected', () => {
  it('flips the system UI to "In call", dismisses the ring notification and stamps the duration clock', async () => {
    const callId = nextCallId('conn');
    const r = renderCall({callId});
    await settle(30);
    await connectOutgoing(callId);

    expect(r.result.current.state).toBe('connected');
    expect(mockBridge.reportConnected).toHaveBeenCalledWith(callId);
    expect(mockNotif.dismissCallNotif).toHaveBeenCalledWith(callId);
    expect(typeof registry.getActiveCall()?.connectedAtMs).toBe('number');
    // DTLS-SRTP verification surfaced to the UI.
    expect(r.result.current.dtls).toEqual({dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM'});
  });

  it('B-16 — ontrack drives remoteHasVideo off the REAL track list, and mirrors to the registry', async () => {
    const callId = nextCallId('ontrack');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    const {MediaStream} = require('react-native-webrtc') as {MediaStream: new (t: unknown[]) => unknown};

    // Audio-only remote first — the tile must NOT claim video.
    await act(async () => {
      pc.ontrack?.({streams: [new MediaStream([new FakeTrack('audio', 'r-a')])]});
      await Promise.resolve();
    });
    expect(r.result.current.remoteStream).not.toBeNull();
    expect(r.result.current.remoteHasVideo).toBe(false);

    // Peer adds video mid-call — the flag flips so the RTCView remounts.
    await act(async () => {
      pc.ontrack?.({
        streams: [new MediaStream([new FakeTrack('audio', 'r-a2'), new FakeTrack('video', 'r-v')])],
      });
      await Promise.resolve();
    });
    expect(r.result.current.remoteHasVideo).toBe(true);
    expect(registry.getActiveCall()?.remoteStream).toBe(r.result.current.remoteStream);
  });

  it('P2-BR-6 host half — AppState transitions pause and resume the controller reconnect budget', async () => {
    const {AppState} = require('react-native') as typeof import('react-native');
    const handlers: Array<(s: string) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: (s: string) => void) => {
      handlers.push(h);
      return {remove: () => {}};
    }) as never);

    const callId = nextCallId('appstate');
    renderCall({callId});
    await settle(30);
    await connectOutgoing(callId);

    const controller = registry.getActiveCall()!.controller as unknown as {
      notifyBackground: () => void; notifyForeground: () => void;
    };
    const bg = jest.spyOn(controller, 'notifyBackground');
    const fg = jest.spyOn(controller, 'notifyForeground');

    expect(handlers.length).toBeGreaterThan(0);
    await act(async () => { handlers.forEach(h => h('background')); });
    expect(bg).toHaveBeenCalled();
    await act(async () => { handlers.forEach(h => h('active')); });
    expect(fg).toHaveBeenCalled();
  });
});

describe('upgradeToVideo', () => {
  it('acquires the camera, renegotiates, and tells the peer the camera is on', async () => {
    const callId = nextCallId('upg');
    const r = renderCall({callId});
    await settle(30);
    await connectOutgoing(callId);
    expect(r.result.current.isUpgrading).toBe(false);

    let pending!: Promise<void>;
    await act(async () => {
      pending = r.result.current.upgradeToVideo();
      await Promise.resolve();
    });
    await settle(30);

    // The local PiP shows immediately, before the SDP round-trip completes.
    expect(media.calls).toEqual([{video: false}, {video: true}]);
    expect(frames('call.reoffer')).toHaveLength(1);

    await act(async () => {
      activeSignalling().ingest({event: 'call.reanswer', data: {callId, from: PEER, sdp: sdp('reans')}});
      await pending;
    });
    await settle(30);

    expect(r.result.current.isUpgrading).toBe(false);
    expect(r.result.current.isVideoOff).toBe(false);
    expect(localTracks(r.result.current).getVideoTracks()).toHaveLength(1);
    expect(registry.getActiveCall()?.kind).toBe('video');
    expect(frames('call.media-state').at(-1)!.data.cameraOff).toBe(false);
  });

  it('O-D — a failed upgrade ROLLS BACK: camera released, stream restored, peer told', async () => {
    const callId = nextCallId('upgfail');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    const audio = media.last!.audioTrack!;

    pc.failAddTrack = true;   // prepare() throws inside the renegotiation lock
    await act(async () => {
      await expect(r.result.current.upgradeToVideo()).rejects.toThrow(/addTrack rejected/);
    });
    await settle(30);

    const acquiredVideo = media.last!.videoTrack!;
    expect(acquiredVideo.stopCalls).toBeGreaterThan(0);   // privacy LED off again
    expect(r.result.current.isUpgrading).toBe(false);
    expect(r.result.current.isVideoOff).toBe(false);
    expect(localTracks(r.result.current).getVideoTracks()).toHaveLength(0);
    expect(localTracks(r.result.current).getAudioTracks()).toEqual([audio]);
    // The peer may already have applied our reoffer — tell them it is dead so
    // they swap the black tile for an honest "Camera off" placeholder.
    expect(frames('call.media-state').at(-1)!.data.cameraOff).toBe(true);
    // The call itself survives as a voice call.
    expect(r.result.current.state).toBe('connected');
  });

  it('is a no-op when the call already has video (the Camera button stays idempotent)', async () => {
    const r = renderCall({kind: 'video'});
    await settle(30);
    await act(async () => { await r.result.current.upgradeToVideo(); });
    expect(media.calls).toHaveLength(1);
    expect(frames('call.reoffer')).toHaveLength(0);
  });

  it('refuses before a controller exists', async () => {
    const r = renderCall({direction: 'incoming', incomingSdp: undefined});
    await settle();
    await act(async () => {
      await expect(r.result.current.upgradeToVideo()).rejects.toThrow(/call not active/);
    });
  });

  it('refuses while the call is not connected', async () => {
    const r = renderCall();
    await settle(30);
    await act(async () => {
      await expect(r.result.current.upgradeToVideo()).rejects.toThrow(/must be connected/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
describe('B-20 — camera-loss recovery on resume', () => {
  let handlers: Array<(s: string) => void>;

  beforeEach(() => {
    handlers = [];
    const {AppState} = require('react-native') as typeof import('react-native');
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: (s: string) => void) => {
      handlers.push(h);
      return {remove: () => {}};
    }) as never);
  });

  const resume = async () => {
    await act(async () => {
      handlers.forEach(h => h('active'));
      for (let i = 0; i < 12; i++) { await Promise.resolve(); }
    });
    await settle(30);
  };

  it('re-acquires the camera when another app stole it (track ended) and refreshes the PiP', async () => {
    const callId = nextCallId('b20');
    const r = renderCall({callId, kind: 'video'});
    await settle(30);
    await connectOutgoing(callId);
    const stolen = media.last!.videoTrack!;
    const audio  = media.last!.audioTrack!;

    // The system Camera app grabbed the device: our capture track dies while
    // the encoder keeps "sending" null frames (black / magenta tile).
    stolen.readyState = 'ended';
    const replacement = new FakeTrack('video', 'v-recovered');
    mockRecoverCamera.mockResolvedValueOnce(replacement);

    await resume();

    expect(mockRecoverCamera).toHaveBeenCalledTimes(1);
    expect(localTracks(r.result.current).getVideoTracks()).toEqual([replacement]);
    expect(localTracks(r.result.current).getAudioTracks()).toEqual([audio]);
    expect(registry.getActiveCall()?.videoTrack).toBe(replacement as never);
  });

  it('leaves a HEALTHY track alone — resume must be a safe no-op', async () => {
    const callId = nextCallId('b20b');
    renderCall({callId, kind: 'video'});
    await settle(30);
    await connectOutgoing(callId);
    await resume();
    expect(mockRecoverCamera).not.toHaveBeenCalled();
  });

  it('respects a user-intended camera-off — resume must not re-light the LED', async () => {
    const callId = nextCallId('b20c');
    const r = renderCall({callId, kind: 'video'});
    await settle(30);
    await connectOutgoing(callId);
    act(() => { r.result.current.toggleVideo(); });     // user turned it off
    await settle(30);
    mockRecoverCamera.mockClear();

    await resume();
    expect(mockRecoverCamera).not.toHaveBeenCalled();
    expect(r.result.current.isVideoOff).toBe(true);
  });

  it('an audio-only call has nothing to recover', async () => {
    const callId = nextCallId('b20d');
    renderCall({callId});
    await settle(30);
    await connectOutgoing(callId);
    await resume();
    expect(mockRecoverCamera).not.toHaveBeenCalled();
  });

  it('a failed re-acquire (camera still held) is swallowed and does not break the call', async () => {
    const callId = nextCallId('b20e');
    const r = renderCall({callId, kind: 'video'});
    await settle(30);
    await connectOutgoing(callId);
    media.last!.videoTrack!.readyState = 'ended';
    mockRecoverCamera.mockRejectedValueOnce(new Error('camera still held'));

    await resume();
    expect(r.result.current.state).toBe('connected');

    // ...and the re-entrancy guard is released, so the NEXT resume retries.
    const replacement = new FakeTrack('video', 'v-second-try');
    mockRecoverCamera.mockResolvedValueOnce(replacement);
    await resume();
    expect(localTracks(r.result.current).getVideoTracks()).toEqual([replacement]);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('the 1 Hz stats poller', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.clearAllTimers(); jest.useRealTimers(); });

  const tick = async () => {
    await act(async () => {
      jest.advanceTimersByTime(1_000);
      for (let i = 0; i < 12; i++) { await Promise.resolve(); }
    });
  };

  it('samples RTT / jitter / loss / throughput / mic level off the engine', async () => {
    const callId = nextCallId('stats');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    expect(r.result.current.stats.rttMs).toBeNull();

    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['cp', {type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.042}],
      ['ia', {type: 'inbound-rtp', kind: 'audio', jitter: 0.011, packetsLost: 5, packetsReceived: 95, bytesReceived: 8_000}],
      ['ms', {type: 'media-source', kind: 'audio', audioLevel: 0.25}],
    ]);
    await tick();

    expect(r.result.current.stats.rttMs).toBe(42);
    expect(r.result.current.stats.jitterMs).toBe(11);
    expect(r.result.current.stats.packetLossPct).toBe(5);
    expect(r.result.current.stats.micLevel).toBe(0.25);
    expect(r.result.current.stats.bytesPerSecond).not.toBeNull();
  });

  it('clamps a mic level the engine reports out of range, and reports null when it reports none', async () => {
    const callId = nextCallId('stats2');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);

    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['os', {type: 'outbound-rtp', kind: 'audio', audioLevel: 4.2}],
    ]);
    await tick();
    expect(r.result.current.stats.micLevel).toBe(1);

    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['os', {type: 'outbound-rtp', kind: 'audio'}],
    ]);
    await tick();
    expect(r.result.current.stats.micLevel).toBeNull();
  });

  it('O-A — a STALE "camera off" placeholder is self-healed once inbound video frames advance', async () => {
    const callId = nextCallId('stats3');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);

    // Peer says camera off (advisory arrives), then the un-mute advisory is
    // LOST in a WS blip — nothing else reconciles the flag.
    await act(async () => {
      activeSignalling().ingest({
        event: 'call.media-state', data: {callId, from: PEER, cameraOff: true, micOff: false},
      });
      await Promise.resolve();
    });
    expect(r.result.current.remoteVideoOff).toBe(true);

    const withFrames = (n: number) => new Map<string, Record<string, unknown>>([
      ['iv', {type: 'inbound-rtp', kind: 'video', framesReceived: n}],
    ]);
    pc.statsMap = withFrames(10);
    await tick();
    expect(r.result.current.remoteVideoOff).toBe(true);   // first tick only baselines

    pc.statsMap = withFrames(40);                          // frames are clearly flowing
    await tick();
    expect(r.result.current.remoteVideoOff).toBe(false);
    expect(registry.getActiveCall()?.remoteVideoOff).toBe(false);
  });

  it('a one-frame trailing packet right after a genuine camera-off does NOT un-hide the placeholder', async () => {
    const callId = nextCallId('stats4');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    await act(async () => {
      activeSignalling().ingest({
        event: 'call.media-state', data: {callId, from: PEER, cameraOff: true, micOff: false},
      });
      await Promise.resolve();
    });

    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['iv', {type: 'inbound-rtp', kind: 'video', framesDecoded: 100}],
    ]);
    await tick();
    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['iv', {type: 'inbound-rtp', kind: 'video', framesDecoded: 101}],
    ]);
    await tick();
    expect(r.result.current.remoteVideoOff).toBe(true);
  });

  it('stops sampling and resets when the call leaves connected', async () => {
    const callId = nextCallId('stats5');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['cp', {type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.05}],
    ]);
    await tick();
    expect(r.result.current.stats.rttMs).toBe(50);

    await act(async () => {
      activeSignalling().ingest({event: 'call.hangup', data: {callId, from: PEER, reason: 'ended'}});
      await Promise.resolve();
    });
    await settle(30);
    expect(r.result.current.state).toBe('ended');
    expect(r.result.current.stats.rttMs).toBeNull();

    // A queued tick against a torn-down call must not throw or resample.
    await tick();
    expect(r.result.current.stats.rttMs).toBeNull();
  });

  it('a getStats() rejection keeps the LAST sample instead of blanking the HUD', async () => {
    const callId = nextCallId('stats6');
    const r = renderCall({callId});
    await settle(30);
    const pc = await connectOutgoing(callId);
    pc.statsMap = new Map<string, Record<string, unknown>>([
      ['cp', {type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.03}],
    ]);
    await tick();
    expect(r.result.current.stats.rttMs).toBe(30);

    jest.spyOn(pc, 'getStats').mockRejectedValue(new Error('native bridge busy'));
    await tick();
    expect(r.result.current.stats.rttMs).toBe(30);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('peer media-state advisories', () => {
  it('mirror the peer camera/mic into the hook AND persist for a later restore', async () => {
    const callId = nextCallId('adv');
    const r = renderCall({callId});
    await settle(30);

    await act(async () => {
      activeSignalling().ingest({
        event: 'call.media-state',
        data:  {callId, from: PEER, cameraOff: true, micOff: true},
      });
      await Promise.resolve();
    });

    expect(r.result.current.remoteVideoOff).toBe(true);
    expect(r.result.current.remoteMuted).toBe(true);
    expect(registry.getActiveCall()?.remoteVideoOff).toBe(true);
    expect(registry.getActiveCall()?.remoteMuted).toBe(true);
  });

  it('an advisory for a DIFFERENT call is ignored', async () => {
    const callId = nextCallId('adv2');
    const r = renderCall({callId});
    await settle(30);
    await act(async () => {
      activeSignalling().ingest({
        event: 'call.media-state',
        data:  {callId: 'someone-else', from: PEER, cameraOff: true, micOff: true},
      });
      await Promise.resolve();
    });
    expect(r.result.current.remoteVideoOff).toBe(false);
    expect(r.result.current.remoteMuted).toBe(false);
  });
});
