/**
 * Shared edge-fakes for the executable `useGroupCall` suites.
 *
 * NOT a test file (jest's testMatch is `__tests__/**\/*.test.ts`). It exists so
 * the `jest.mock` factories in the suites can `require()` these classes — a
 * factory may not close over out-of-scope test-file variables, but `require` is
 * on jest's allow-list.
 *
 * Everything here stands in for a genuine EDGE: the native WebRTC surface,
 * mediasoup-client, the HTTP client, the WS transport and the native
 * FrameCryptor. The messenger's own modules (dispatcher, registries, store,
 * layout) are deliberately NOT faked — the suites exercise the real ones.
 */

export type Cb = (...a: unknown[]) => void;

export class FakeTrack {
  kind: string;
  id: string;
  enabled = true;
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  stopped = false;
  constructor(kind: string, id: string) {
    this.kind = kind;
    this.id = id;
  }
  stop(): void { this.readyState = 'ended'; this.stopped = true; }
  _release(): void { /* RN-WebRTC extension */ }
}

export class FakeMediaStream {
  _tracks: FakeTrack[];
  id = `ms_${Math.random().toString(36).slice(2, 8)}`;
  constructor(tracks?: FakeTrack[]) { this._tracks = tracks ? [...tracks] : []; }
  addTrack(t: FakeTrack): void { this._tracks.push(t); }
  removeTrack(t: FakeTrack): void { this._tracks = this._tracks.filter(x => x !== t); }
  getTracks(): FakeTrack[] { return [...this._tracks]; }
  getAudioTracks(): FakeTrack[] { return this._tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks(): FakeTrack[] { return this._tracks.filter(t => t.kind === 'video'); }
  toURL(): string { return `stream://${this.id}`; }
  release(): void { /* noop */ }
}

export class FakeProducer {
  id: string;
  kind: string;
  track: FakeTrack | null;
  closed = false;
  paused = false;
  resumeCalls = 0;
  rtpSender = {id: 'sender'};
  private ls = new Map<string, Cb[]>();
  constructor(id: string, kind: string, track: FakeTrack | null) {
    this.id = id; this.kind = kind; this.track = track;
  }
  on(ev: string, cb: Cb): void { const a = this.ls.get(ev) ?? []; a.push(cb); this.ls.set(ev, a); }
  fire(ev: string, ...args: unknown[]): void { for (const cb of this.ls.get(ev) ?? []) { cb(...args); } }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.resumeCalls += 1; if (this.track) { this.track.enabled = true; } }
  close(): void { this.closed = true; }
  async replaceTrack({track}: {track: FakeTrack}): Promise<void> {
    this.track = track;
    // Producer.js re-applies the paused latch on replaceTrack — this is the
    // exact mechanism B-123 / clearBlankedPauseLatch exists to defeat.
    if (this.paused) { track.enabled = false; }
  }
  async getStats(): Promise<{forEach: (cb: Cb) => void}> { return {forEach: () => {}}; }
}

export class FakeConsumer {
  id: string;
  producerId: string;
  kind: string;
  track: FakeTrack;
  closed = false;
  paused = false;
  rtpReceiver: {id: string; playoutDelayHint?: number} = {id: 'receiver'};
  private ls = new Map<string, Cb[]>();
  constructor(id: string, producerId: string, kind: string) {
    this.id = id; this.producerId = producerId; this.kind = kind;
    this.track = new FakeTrack(kind, `${id}_track`);
  }
  on(ev: string, cb: Cb): void { const a = this.ls.get(ev) ?? []; a.push(cb); this.ls.set(ev, a); }
  fire(ev: string, ...args: unknown[]): void { for (const cb of this.ls.get(ev) ?? []) { cb(...args); } }
  close(): void { this.closed = true; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
}

export class FakeTransport {
  id: string;
  closed = false;
  connectionState = 'new';
  handler = {_pc: {}};
  produceCalls: Array<Record<string, unknown>> = [];
  consumers: FakeConsumer[] = [];
  restartIceCalls = 0;
  private ls = new Map<string, Cb[]>();
  private didConnect = false;
  constructor(id: string) { this.id = id; }
  on(ev: string, cb: Cb): void { const a = this.ls.get(ev) ?? []; a.push(cb); this.ls.set(ev, a); }
  /** Drive a mediasoup transport event from a test (e.g. ICE state change). */
  fire(ev: string, ...args: unknown[]): void { for (const cb of this.ls.get(ev) ?? []) { cb(...args); } }
  private async runConnect(): Promise<void> {
    if (this.didConnect) { return; }
    const cbs = this.ls.get('connect') ?? [];
    this.didConnect = true;
    if (cbs.length === 0) { return; }
    await new Promise<void>((res, rej) => {
      cbs[0]({dtlsParameters: {role: 'auto'}}, () => res(), (e: Error) => rej(e));
    });
  }
  async produce(params: Record<string, unknown>): Promise<FakeProducer> {
    this.produceCalls.push(params);
    await this.runConnect();
    const track = params.track as FakeTrack;
    const cbs = this.ls.get('produce') ?? [];
    const id = await new Promise<string>((res, rej) => {
      cbs[0](
        {kind: track.kind, rtpParameters: {}},
        (r: {id: string}) => res(r.id),
        (e: Error) => rej(e),
      );
    });
    const p = new FakeProducer(id, track.kind, track);
    // mediasoup derives the producer's initial paused flag from the track's
    // `enabled` AT CONSTRUCTION — GC-06 blanking therefore births every
    // producer "paused" (B-123).
    p.paused = track.enabled === false;
    return p;
  }
  async consume(params: {id: string; producerId: string; kind: string}): Promise<FakeConsumer> {
    await this.runConnect();
    const c = new FakeConsumer(params.id, params.producerId, params.kind);
    this.consumers.push(c);
    return c;
  }
  async restartIce(): Promise<void> { this.restartIceCalls += 1; }
  async getStats(): Promise<{forEach: (cb: Cb) => void}> { return {forEach: () => {}}; }
  close(): void { this.closed = true; }
}

export class FakeDevice {
  static instances: FakeDevice[] = [];
  loaded = false;
  loadedCaps: unknown = null;
  rtpCapabilities = {codecs: [{mimeType: 'audio/opus'}]};
  sendTx: FakeTransport | null = null;
  recvTx: FakeTransport | null = null;
  private n = 0;
  constructor(_o?: unknown) { FakeDevice.instances.push(this); }
  async load({routerRtpCapabilities}: {routerRtpCapabilities: unknown}): Promise<void> {
    this.loaded = true;
    this.loadedCaps = routerRtpCapabilities;
  }
  createSendTransport(_p: unknown): FakeTransport {
    this.n += 1;
    this.sendTx = new FakeTransport(`sendtx_${this.n}`);
    return this.sendTx;
  }
  createRecvTransport(_p: unknown): FakeTransport {
    this.n += 1;
    this.recvTx = new FakeTransport(`recvtx_${this.n}`);
    return this.recvTx;
  }
}

export type AckHandler = (event: string, data: Record<string, unknown>) => unknown;

export class FakeWs {
  state = 'connected';
  sent: Array<{event: string; data: Record<string, unknown>}> = [];
  reconnectCbs: Array<() => void> = [];
  ack: AckHandler;
  constructor(ack: AckHandler) { this.ack = ack; }
  async emitWithAck<T>(event: string, data: Record<string, unknown>): Promise<T> {
    this.sent.push({event, data});
    const r = this.ack(event, data);
    if (r instanceof Error) { throw r; }
    return r as T;
  }
  onReconnect(fn: () => void): () => void {
    this.reconnectCbs.push(fn);
    return () => { this.reconnectCbs = this.reconnectCbs.filter(f => f !== fn); };
  }
  fireReconnect(): void { for (const f of [...this.reconnectCbs]) { f(); } }
  eventsNamed(name: string): Array<Record<string, unknown>> {
    return this.sent.filter(s => s.event === name).map(s => s.data);
  }
}

export class FakeOrchestrator {
  static instances: FakeOrchestrator[] = [];
  opts: Record<string, unknown>;
  inited = false;
  disposed = false;
  constructor(o: Record<string, unknown>) {
    this.opts = o;
    FakeOrchestrator.instances.push(this);
  }
  async init(): Promise<void> {
    if (ctl.cryptorInitThrows) { throw new Error('cryptor init boom'); }
    this.inited = true;
  }
  async attachSenderCryptor(_s: unknown, _pc: unknown, kind: string): Promise<() => void> {
    if (ctl.senderAttachThrows) { throw new Error('sender attach unavailable'); }
    return () => { ctl.detachers.push(`send:${kind}`); };
  }
  async attachReceiverCryptor(_r: unknown, _pc: unknown, tag: string): Promise<() => void> {
    if (ctl.receiverAttachThrows) { throw new Error('receiver attach unavailable'); }
    return () => { ctl.detachers.push(`recv:${tag}`); };
  }
  dispose(): void { this.disposed = true; }
  close(): void { this.disposed = true; }
}

/**
 * Mutable control plane shared by the suites and the `jest.mock` factories.
 * `reset()` restores the "everything works" configuration.
 */
export const ctl = {
  // http
  httpCalls:        [] as Array<{url: string; init?: Record<string, unknown>}>,
  roomCreateStatus: 200,
  roomCreateBody:   {roomId: 'ROOM_CREATED_1', hostRoomToken: 'HTOK'} as Record<string, unknown>,
  turnStatus:       200,
  // media
  mediaThrows:        false,
  acquired:           [] as Array<{video: boolean}>,
  getUserMediaThrows: false,
  getUserMediaEmpty:  false,
  getUserMediaCalls:  0,
  recoverCameraReturnsNull: false,
  recoveredFacings:   [] as string[],
  // cryptor
  cryptorAvailable:     true,
  cryptorInitThrows:    false,
  senderAttachThrows:   false,
  receiverAttachThrows: false,
  detachers:            [] as string[],
  // transport
  liveWs: null as FakeWs | null,
  // runtime
  presenceBroadcasts: [] as Array<{targets: string[]; payload: Record<string, unknown>}>,
  ensureKeyCalls:     [] as Array<Record<string, unknown>>,
  resyncCalls:        [] as string[],
  ensureKeyImpl: (async (a: Record<string, unknown>) => ({keyConversationId: a.conversationId as string})) as
    (a: Record<string, unknown>) => Promise<{keyConversationId: string}>,
  ensureKeyThrows: null as Error | null,
  // Audit Step 3a.2 — when set, presence hangs on this until resolved, so a
  // test can prove setState('joined') no longer awaits the broadcast.
  presenceGate: null as Promise<void> | null,

  reset(): void {
    ctl.httpCalls.length = 0;
    ctl.roomCreateStatus = 200;
    ctl.roomCreateBody = {roomId: 'ROOM_CREATED_1', hostRoomToken: 'HTOK'};
    ctl.turnStatus = 200;
    ctl.mediaThrows = false;
    ctl.acquired.length = 0;
    ctl.getUserMediaThrows = false;
    ctl.getUserMediaEmpty = false;
    ctl.getUserMediaCalls = 0;
    ctl.recoverCameraReturnsNull = false;
    ctl.recoveredFacings.length = 0;
    ctl.cryptorAvailable = true;
    ctl.cryptorInitThrows = false;
    ctl.senderAttachThrows = false;
    ctl.receiverAttachThrows = false;
    ctl.detachers.length = 0;
    ctl.liveWs = null;
    ctl.presenceBroadcasts.length = 0;
    ctl.ensureKeyCalls.length = 0;
    ctl.resyncCalls.length = 0;
    ctl.ensureKeyThrows = null;
    ctl.ensureKeyImpl = async (a) => ({keyConversationId: a.conversationId as string});
    ctl.presenceGate = null;
    FakeDevice.instances.length = 0;
    FakeOrchestrator.instances.length = 0;
  },
};

/** The `react-native-webrtc` module shape the messenger consumes. */
export function webrtcModule(): Record<string, unknown> {
  return {
    __esModule: true,
    MediaStream: FakeMediaStream,
    mediaDevices: {
      getUserMedia: async (c?: {video?: unknown}) => {
        if (ctl.getUserMediaThrows) { throw new Error('camera busy'); }
        if (ctl.getUserMediaEmpty) { return new FakeMediaStream(); }
        ctl.getUserMediaCalls += 1;
        return new FakeMediaStream(
          c?.video ? [new FakeTrack('video', `gum_video_${ctl.getUserMediaCalls}`)] : [],
        );
      },
    },
    RTCPeerConnection: class {},
  };
}

/** The `@/services/api` surface useGroupCall lazily requires. */
export function apiModule(): Record<string, unknown> {
  return {
    __esModule: true,
    fetchWithRefresh: async (url: string, init?: Record<string, unknown>) => {
      ctl.httpCalls.push({url, init});
      if (url.includes('/webrtc/turn-credentials')) {
        return {
          ok:     ctl.turnStatus === 200,
          status: ctl.turnStatus,
          json:   async () => ({urls: ['turn:turn.test:3478'], username: 'u', credential: 'c'}),
        };
      }
      if (url.includes('/sfu/rooms/by-conversation/')) {
        return {ok: true, status: 200, json: async () => ({roomToken: 'REMINTED'})};
      }
      return {
        ok:     ctl.roomCreateStatus === 200,
        status: ctl.roomCreateStatus,
        json:   async () => ctl.roomCreateBody,
      };
    },
  };
}

/** The `peerConnectionFactory` seam (camera/mic acquisition). */
export function peerConnectionFactoryModule(): Record<string, unknown> {
  return {
    __esModule: true,
    localVideoConstraints: (facing: string) => ({video: {facingMode: facing}}),
    getLocalMedia: async ({video}: {video: boolean}) => {
      ctl.acquired.push({video});
      if (ctl.mediaThrows) { throw new Error('permission denied'); }
      const audioTrack = new FakeTrack('audio', 'local_audio');
      const videoTrack = video ? new FakeTrack('video', 'local_video') : null;
      const stream = new FakeMediaStream(videoTrack ? [audioTrack, videoTrack] : [audioTrack]);
      return {stream, audioTrack, videoTrack};
    },
    recoverGroupCamera: async (args: {facing: string}) => {
      if (ctl.recoverCameraReturnsNull) { return null; }
      ctl.recoveredFacings.push(args.facing);
      return new FakeTrack('video', `recovered_${args.facing}`);
    },
  };
}

/** The native FrameCryptor availability gate + orchestrator. */
export function frameCryptorModule(): Record<string, unknown> {
  return {
    __esModule: true,
    FrameCryptorOrchestrator: FakeOrchestrator,
    frameCryptorOrchestratorAvailable: () => ctl.cryptorAvailable,
  };
}

/** The WS transport registry. */
export function transportRegistryModule(): Record<string, unknown> {
  return {
    __esModule: true,
    getLiveTransport: () => ctl.liveWs,
    waitForLiveTransport: async () => ctl.liveWs,
    setLiveTransport: () => {},
  };
}

/** The messenger runtime singleton (key fan-out + presence). */
export function runtimeModule(): Record<string, unknown> {
  return {
    __esModule: true,
    getMessengerRuntime: async () => ({
      broadcastGroupCallPresence: async (targets: string[], payload: Record<string, unknown>) => {
        ctl.presenceBroadcasts.push({targets, payload});
        if (ctl.presenceGate) { await ctl.presenceGate; }
      },
      ensureCallGroupKey: async (a: Record<string, unknown>) => {
        ctl.ensureKeyCalls.push(a);
        if (ctl.ensureKeyThrows) { throw ctl.ensureKeyThrows; }
        return ctl.ensureKeyImpl(a);
      },
      requestGroupKeyResync: async (id: string) => { ctl.resyncCalls.push(id); },
    }),
  };
}

/**
 * Default `sfu.*` ack behaviour: a healthy server. `joinResp` overrides
 * individual fields of the `sfu.join` response.
 */
export function defaultAck(joinResp: Record<string, unknown> = {}): AckHandler {
  let consumerN = 0;
  let producerN = 0;
  return (event, data) => {
    switch (event) {
      case 'sfu.join':
        return {
          routerRtpCapabilities: {codecs: []},
          sendTransport:         {id: 'stx', iceParameters: {}, iceCandidates: [], dtlsParameters: {}},
          recvTransport:         {id: 'rtx', iceParameters: {}, iceCandidates: [], dtlsParameters: {}},
          participantTag:        'TAG_SELF',
          isHost:                true,
          existingProducers:     [],
          ...joinResp,
        };
      case 'sfu.produce':
        producerN += 1;
        return {producerId: `prod_${data.kind}_${producerN}`};
      case 'sfu.consume': {
        consumerN += 1;
        const pid = String(data.producerId);
        return {
          consumerId:     `cons_${consumerN}`,
          producerId:     pid,
          kind:           pid.includes('video') ? 'video' : 'audio',
          rtpParameters:  {},
          participantTag: 'peer',
          producerPaused: false,
        };
      }
      case 'sfu.producers':
        return {producers: []};
      case 'sfu.transport.restartIce':
        return {iceParameters: {ufrag: 'x'}};
      default:
        return {ok: true};
    }
  };
}
