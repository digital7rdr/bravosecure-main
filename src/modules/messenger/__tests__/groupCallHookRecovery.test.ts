/**
 * useGroupCall — EXECUTABLE coverage of the RECOVERY surface:
 *   • minimize → restore (the BS-LEAK / F6 / L14 adopt path and its
 *     dead-transport refusal, BS-RECONNECT-MIN),
 *   • WS reconnect → sfu.join rejoin (B-05 / B-101 LC-4),
 *   • the ICE connectionstatechange machine (B-108 / B-101 LC-5),
 *   • the AppState background camera pause (B-101 LC-12/13),
 *   • the module-level history-bubble + handle-stash exports.
 *
 * Same edge-fake rule as the sibling suites: only mediasoup-client,
 * react-native-webrtc, HTTP, WS and the native FrameCryptor are faked.
 */
import * as React from 'react';
/**
 * react-test-renderer ships no type declarations and @types/react-test-renderer
 * is not installed, so a typed import statement would add a TS7016 to the repo's tsc
 * baseline. A require() keeps the module untyped at the boundary and typed here.
 */
interface TestRendererInstance { unmount: () => void; }
interface TestRendererModule {
  create: (element: unknown) => TestRendererInstance;
  act: (cb: () => unknown) => Promise<void>;
}

const TestRenderer = require('react-test-renderer') as TestRendererModule;

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// An AppState that a test can actually drive. The project-wide react-native
// stub returns a no-op subscription, so the background/foreground camera rules
// would be unreachable. Everything else mirrors the stub.
jest.mock('react-native', () => {
  const listeners: Array<(s: string) => void> = [];
  return {
    __esModule: true,
    Platform: {OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default, Version: 34},
    AppState: {
      currentState: 'active',
      addEventListener: (_t: string, h: (s: string) => void) => {
        listeners.push(h);
        return {remove: () => { const i = listeners.indexOf(h); if (i >= 0) { listeners.splice(i, 1); } }};
      },
      __emit: (s: string) => { for (const h of [...listeners]) { h(s); } },
    },
    DeviceEventEmitter: {
      addListener: () => ({remove: () => {}}),
      emit: () => {},
      removeAllListeners: () => {},
    },
    NativeModules: {},
    PermissionsAndroid: {
      PERMISSIONS: {}, RESULTS: {GRANTED: 'granted'},
      request: async () => 'granted', check: async () => true,
    },
  };
});

jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://relay.test'}));
jest.mock('react-native-webrtc', () => require('./helpers/groupCallFakes').webrtcModule());
jest.mock('mediasoup-client', () => ({
  __esModule: true,
  Device: require('./helpers/groupCallFakes').FakeDevice,
}));
jest.mock('@/services/api', () => require('./helpers/groupCallFakes').apiModule());
jest.mock('../../observability/crashlytics', () => ({
  __esModule: true,
  log: () => {},
  recordError: () => {},
  setUserId: () => {},
}));
jest.mock('../webrtc/peerConnectionFactory', () =>
  require('./helpers/groupCallFakes').peerConnectionFactoryModule());
jest.mock('../webrtc/frameCryptorOrchestrator', () =>
  require('./helpers/groupCallFakes').frameCryptorModule());
jest.mock('../runtime/transportRegistry', () =>
  require('./helpers/groupCallFakes').transportRegistryModule());
jest.mock('../runtime/runtime', () => require('./helpers/groupCallFakes').runtimeModule());

import {AppState} from 'react-native';
import {ctl, FakeWs, FakeDevice, defaultAck, type AckHandler} from './helpers/groupCallFakes';
import {
  useGroupCall, clearAllLiveSfuHandles, appendMissedGroupCallBubble,
} from '../webrtc/useGroupCall';
import type {GroupCallHandle, GroupCallOptions} from '../webrtc/useGroupCall';
import {
  setActiveGroupCall, getActiveGroupCall, patchActiveGroupCall,
} from '../runtime/groupCallRegistry';
import {clearGroupCallRejoinHandler} from '../webrtc/groupCallRejoinHub';
import {useMessengerStore} from '../store/messengerStore';
import {clearRoomIdentities} from '../webrtc/groupCallIdentityRegistry';

const emitAppState = (s: string): void =>
  (AppState as unknown as {__emit: (v: string) => void}).__emit(s);

const CONVO = 'convo-recovery';
const ROOM = 'ROOM_RECOVER';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function seedGroup(): void {
  useMessengerStore.setState((s: Record<string, unknown>) => ({
    ...s,
    groups: {
      ...(s.groups as Record<string, unknown>),
      [CONVO]: {
        id: CONVO, name: 'Recovery Group', owner: 'someone-else',
        epoch: 1, masterKeyB64: MASTER_KEY, members: {me: {}, bob: {}},
      },
    },
    _ownUserId: 'me', _ownAuthUserId: 'me',
  }) as never);
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {

    await TestRenderer.act(async () => {
      await new Promise<void>(r => setTimeout(r, 0));
    });
  }
}

interface Rig {
  handle: () => GroupCallHandle;
  unmount: () => void;
}

const baseOpts = (over: Partial<GroupCallOptions> = {}): GroupCallOptions => ({
  conversationId:   CONVO,
  callType:         'video',
  direction:        'incoming',
  roomId:           ROOM,
  roomToken:        'TOK',
  hostUserId:       'bob',
  recipientUserIds: ['bob'],
  ownDisplayName:   'Me',
  callerName:       'Bob',
  ...over,
});

async function mount(opts: GroupCallOptions): Promise<Rig> {
  let latest: GroupCallHandle | null = null;
  const Probe = (): null => { latest = useGroupCall(opts); return null; };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(14);
  return {
    handle: () => latest as GroupCallHandle,
    unmount: () => { TestRenderer.act(() => { renderer?.unmount(); }); },
  };
}

async function run(fn: () => unknown): Promise<void> {
  await TestRenderer.act(async () => { await fn(); });
  await flush(3);
}

const joinerAck = (): AckHandler => defaultAck({isHost: false, participantTag: 'TAG_ME'});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ctl.reset();
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  clearRoomIdentities(ROOM);
  seedGroup();
  useMessengerStore.setState((s: Record<string, unknown>) => ({...s, messages: {}}) as never);
});

afterEach(() => {
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  jest.restoreAllMocks();
});

// ── minimize → restore ───────────────────────────────────────────────

describe('useGroupCall — minimize then restore', () => {
  /** Boot a call, minimize it (keepAlive), and unmount the screen. */
  async function bootThenMinimize(): Promise<{ws: FakeWs; first: Rig}> {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const first = await mount(baseOpts());
    expect(first.handle().state).toBe('joined');
    await run(() => patchActiveGroupCall(getActiveGroupCall()?.roomId ?? null, {isMinimized: true, keepAlive: true}));
    first.unmount();
    await flush(3);
    return {ws, first};
  }

  it('keepAlive means the unmount does NOT tear the call down', async () => {
    const {ws} = await bootThenMinimize();
    expect(getActiveGroupCall()).not.toBeNull();
    expect(getActiveGroupCall()!.roomId).toBe(ROOM);
    expect(ws.eventsNamed('sfu.leave')).toHaveLength(0);
    expect(FakeDevice.instances[0].sendTx!.closed).toBe(false);
  });

  it('the restored hook ADOPTS the live call instead of building a second pipeline', async () => {
    const {ws} = await bootThenMinimize();
    const joinsBefore = ws.eventsNamed('sfu.join').length;

    const second = await mount(baseOpts());

    expect(second.handle().state).toBe('joined');
    expect(second.handle().selfTag).toBe('TAG_ME');
    expect(second.handle().roomId).toBe(ROOM);
    // no second sfu.join, no second mediasoup Device, no second camera grab
    expect(ws.eventsNamed('sfu.join')).toHaveLength(joinsBefore);
    expect(FakeDevice.instances).toHaveLength(1);
    expect(ctl.acquired).toHaveLength(1);
    // and the restore clears the minimize flag so the bubble hides
    expect(getActiveGroupCall()!.isMinimized).toBe(false);

    second.unmount();
    await flush(3);
  });

  it('BS-LEAK: ending the call AFTER a restore actually closes the original transports', async () => {
    const {ws} = await bootThenMinimize();
    const dev = FakeDevice.instances[0];
    const localAudio = getActiveGroupCall()!.audioTrack as unknown as {stopped: boolean};

    const second = await mount(baseOpts());
    await run(() => second.handle().leave());

    expect(dev.sendTx!.closed).toBe(true);
    expect(dev.recvTx!.closed).toBe(true);
    expect(localAudio.stopped).toBe(true);
    expect(getActiveGroupCall()).toBeNull();
    expect(ws.eventsNamed('sfu.leave')).toEqual([{roomId: ROOM}]);

    second.unmount();
    await flush(3);
  });

  it('BS-RECONNECT-MIN: a restore with DEAD transports refuses to adopt and boots fresh', async () => {
    const {ws} = await bootThenMinimize();
    // A WS reconnect while minimized leaves the server-side transports gone.
    FakeDevice.instances[0].sendTx!.connectionState = 'failed';
    const joinsBefore = ws.eventsNamed('sfu.join').length;

    const second = await mount(baseOpts());

    expect(ws.eventsNamed('sfu.join').length).toBeGreaterThan(joinsBefore);
    expect(FakeDevice.instances.length).toBeGreaterThan(1);
    expect(second.handle().state).toBe('joined');

    second.unmount();
    await flush(3);
  });

  it('a DIFFERENT room in the registry is torn down before the new call joins (B-343)', async () => {
    const {ws} = await bootThenMinimize();
    const oldDev = FakeDevice.instances[0];

    const second = await mount(baseOpts({roomId: 'ROOM_OTHER'}));
    await flush(4);

    // the stale room's media is released…
    expect(oldDev.sendTx!.closed).toBe(true);
    // …and we genuinely joined the new one
    expect(ws.eventsNamed('sfu.join').some(e => e.roomId === 'ROOM_OTHER')).toBe(true);
    expect(second.handle().roomId).toBe('ROOM_OTHER');

    second.unmount();
    await flush(3);
  });

  it('restore keeps processing peer camera toggles (GC-03)', async () => {
    ctl.liveWs = new FakeWs(defaultAck({
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'}],
    }));
    const first = await mount(baseOpts());
    expect(first.handle().remoteTiles).toHaveLength(1);
    await run(() => patchActiveGroupCall(getActiveGroupCall()?.roomId ?? null, {isMinimized: true, keepAlive: true}));
    first.unmount();
    await flush(3);

    const second = await mount(baseOpts());
    expect(second.handle().remoteTiles).toHaveLength(1);

    const {dispatchSfuFrame} = require('../webrtc/sfuDispatcher') as
      typeof import('../webrtc/sfuDispatcher');
    await run(() => dispatchSfuFrame({
      event: 'sfu.producer-paused',
      data: {roomId: ROOM, producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'},
    }));

    expect(second.handle().remoteTiles[0].paused).toBe(true);
    second.unmount();
    await flush(3);
  });
});

// ── WS reconnect → rejoin ────────────────────────────────────────────

describe('useGroupCall — WS reconnect', () => {
  it('B-05: a socket reopen re-issues sfu.join rather than an ICE restart', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    expect(ws.eventsNamed('sfu.join')).toHaveLength(1);

    await run(() => ws.fireReconnect());

    expect(ws.eventsNamed('sfu.join')).toHaveLength(2);
    expect(ws.eventsNamed('sfu.join')[1]).toEqual({roomId: ROOM, roomToken: 'TOK'});
    expect(ws.eventsNamed('sfu.transport.restartIce')).toHaveLength(0);
    expect(rig.handle().state).toBe('joined');

    rig.unmount();
    await flush(3);
  });

  it('a socket reopen AFTER the call ended never resurrects it', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    await run(() => rig.handle().leave());
    const joins = ws.eventsNamed('sfu.join').length;

    await run(() => ws.fireReconnect());

    expect(ws.eventsNamed('sfu.join')).toHaveLength(joins);
    rig.unmount();
    await flush(3);
  });

  it('F7: an expired room token is re-minted and the join retried once', async () => {
    let joins = 0;
    const inner = joinerAck();
    ctl.liveWs = new FakeWs((event, data) => {
      if (event === 'sfu.join') {
        joins += 1;
        if (joins === 2) { return new Error('room_token_invalid'); }
      }
      return inner(event, data);
    });
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());

    await run(() => ws.fireReconnect());

    // the re-mint endpoint was hit and a third join carried the fresh token
    expect(ctl.httpCalls.some(c => c.url.includes('/sfu/rooms/by-conversation/'))).toBe(true);
    expect(ws.eventsNamed('sfu.join')).toHaveLength(3);
    expect(ws.eventsNamed('sfu.join')[2]).toEqual({roomId: ROOM, roomToken: 'REMINTED'});

    rig.unmount();
    await flush(3);
  });
});

// ── ICE recovery ─────────────────────────────────────────────────────

describe('useGroupCall — ICE connection state machine', () => {
  it('a disconnected transport flips to reconnecting and issues restartIce', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    const sendTx = FakeDevice.instances[0].sendTx!;

    sendTx.connectionState = 'disconnected';
    await run(() => sendTx.fire('connectionstatechange', 'disconnected'));

    expect(rig.handle().state).toBe('reconnecting');
    expect(ws.eventsNamed('sfu.transport.restartIce')).toEqual([
      {roomId: ROOM, transportId: sendTx.id},
    ]);
    expect(sendTx.restartIceCalls).toBe(1);

    rig.unmount();
    await flush(3);
  });

  it('both transports going healthy again restores the joined state', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const rig = await mount(baseOpts());
    const dev = FakeDevice.instances[0];

    dev.sendTx!.connectionState = 'disconnected';
    await run(() => dev.sendTx!.fire('connectionstatechange', 'disconnected'));
    expect(rig.handle().state).toBe('reconnecting');

    dev.sendTx!.connectionState = 'connected';
    dev.recvTx!.connectionState = 'connected';
    await run(() => dev.sendTx!.fire('connectionstatechange', 'connected'));

    expect(rig.handle().state).toBe('joined');
    rig.unmount();
    await flush(3);
  });

  it('B-108: a mid-call transport failure is recoverable, not terminal', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const rig = await mount(baseOpts());
    const dev = FakeDevice.instances[0];

    dev.recvTx!.connectionState = 'failed';
    await run(() => dev.recvTx!.fire('connectionstatechange', 'failed'));

    expect(rig.handle().state).toBe('reconnecting');
    expect(dev.recvTx!.restartIceCalls).toBe(1);
    rig.unmount();
    await flush(3);
  });

  it('restartIce is skipped while the WS itself is down (B-05)', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    const sendTx = FakeDevice.instances[0].sendTx!;

    ws.state = 'disconnected';
    sendTx.connectionState = 'disconnected';
    await run(() => sendTx.fire('connectionstatechange', 'disconnected'));

    expect(rig.handle().state).toBe('reconnecting');
    expect(ws.eventsNamed('sfu.transport.restartIce')).toHaveLength(0);
    expect(sendTx.restartIceCalls).toBe(0);

    ws.state = 'connected';
    rig.unmount();
    await flush(3);
  });
});

// ── AppState (background camera policy) ──────────────────────────────

describe('useGroupCall — background / foreground camera', () => {
  it('B-101 LC-12/13: backgrounding pauses the camera producer and blanks the track', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts({callType: 'video'}));
    expect(rig.handle().state).toBe('joined');

    await run(() => emitAppState('background'));

    expect(ws.eventsNamed('sfu.producer.pause')).toEqual([
      {roomId: ROOM, producerId: 'prod_video_2'},
    ]);
    rig.unmount();
    await flush(3);
  });

  it('returning to the foreground resumes exactly what the background pause took', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts({callType: 'video'}));

    await run(() => emitAppState('background'));
    await run(() => emitAppState('active'));

    expect(ws.eventsNamed('sfu.producer.resume')).toEqual([
      {roomId: ROOM, producerId: 'prod_video_2'},
    ]);
    rig.unmount();
    await flush(3);
  });

  it("GC-7: iOS 'inactive' is NOT treated as background — no camera churn", async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts({callType: 'video'}));

    await run(() => emitAppState('inactive'));

    expect(ws.eventsNamed('sfu.producer.pause')).toHaveLength(0);
    rig.unmount();
    await flush(3);
  });

  it('a user-intended camera-off is respected — backgrounding does not re-signal', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts({callType: 'video'}));
    await run(() => rig.handle().toggleVideo());       // user turns camera OFF
    const pausesAfterToggle = ws.eventsNamed('sfu.producer.pause').length;

    await run(() => emitAppState('background'));

    expect(ws.eventsNamed('sfu.producer.pause')).toHaveLength(pausesAfterToggle);
    rig.unmount();
    await flush(3);
  });

  it('a voice call ignores AppState entirely — there is no camera to pause', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts({callType: 'voice'}));

    await run(() => emitAppState('background'));
    await run(() => emitAppState('active'));

    expect(ws.eventsNamed('sfu.producer.pause')).toHaveLength(0);
    expect(ws.eventsNamed('sfu.producer.resume')).toHaveLength(0);
    rig.unmount();
    await flush(3);
  });
});

// ── module-level exports ─────────────────────────────────────────────

describe('appendMissedGroupCallBubble', () => {
  const read = (): Array<Record<string, unknown>> =>
    ((useMessengerStore.getState().messages as Record<string, unknown[]>)[CONVO] ?? []) as
      Array<Record<string, unknown>>;

  it('B-12: writes an incoming/missed group call_meta row into the conversation', () => {
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'video'});
    const msgs = read();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      conversation_id: CONVO,
      sender_id:       'self',
      type:            'call',
      is_encrypted:    true,
      call_meta: {kind: 'video', direction: 'incoming', outcome: 'missed', duration: 0, groupCall: true},
    });
    expect(msgs[0].peer).toEqual({userId: 'group-call', deviceId: 0});
  });

  it('Finding #8(a): a stableId makes a replayed sfu.ring.missed idempotent', () => {
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'voice', stableId: 'missed-group-R1'});
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'voice', stableId: 'missed-group-R1'});
    const msgs = read();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('missed-group-R1');
  });

  it('without a stableId each dismissal is a distinct row', () => {
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'voice'});
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'voice'});
    const msgs = read();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).not.toBe(msgs[1].id);
    expect(String(msgs[0].id)).toMatch(/^gc_/);
  });

  it('honours the server timestamp so the calls log orders correctly', () => {
    const at = Date.parse('2026-01-02T03:04:05.000Z');
    appendMissedGroupCallBubble({conversationId: CONVO, callType: 'voice', stableId: 'm1', at});
    expect(read()[0].created_at).toBe(new Date(at).toISOString());
  });
});

describe('clearAllLiveSfuHandles', () => {
  /**
   * The differential half of the BS-LEAK test above: WITH the stash a restored
   * hook's teardown closes the original mediasoup transports; once the stash is
   * wiped (the logout reset) the same restore degrades to the documented
   * "surface-only adopt" — it still adopts the call, but its teardown owns no
   * handles. Pinning both halves is what makes the stash's purpose testable.
   */
  it('wipes the stash, degrading a later restore to a surface-only adopt', async () => {
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const first = await mount(baseOpts());
    await run(() => patchActiveGroupCall(getActiveGroupCall()?.roomId ?? null, {isMinimized: true, keepAlive: true}));
    first.unmount();
    await flush(3);
    const dev = FakeDevice.instances[0];
    expect(dev.sendTx!.closed).toBe(false);

    clearAllLiveSfuHandles();
    const joinsBefore = ws.eventsNamed('sfu.join').length;

    const second = await mount(baseOpts());
    // the surface is still adopted — no second join, no second Device
    expect(ws.eventsNamed('sfu.join')).toHaveLength(joinsBefore);
    expect(FakeDevice.instances).toHaveLength(1);

    await run(() => second.handle().leave());
    // …but with no stashed handles the restored hook cannot close them.
    expect(dev.sendTx!.closed).toBe(false);
    expect(dev.recvTx!.closed).toBe(false);

    second.unmount();
    await flush(3);
  });
});
