/**
 * useGroupCall — EXECUTABLE boot / refusal coverage.
 *
 * `src/modules/messenger/webrtc/useGroupCall.ts` is 5,104 lines and had zero
 * executed statements. This suite renders the REAL hook under
 * react-test-renderer (node env) with fakes ONLY at the true edges —
 * mediasoup-client, react-native-webrtc, the HTTP client, the WS transport
 * registry, the messenger runtime, getUserMedia and the native FrameCryptor.
 * Everything else (sfuDispatcher, groupCallIdentityRegistry, groupCallRegistry,
 * groupCallLayout, groupCallProducerBuffer, messengerStore, callKeyRegistry) is
 * the REAL module, so the wiring between them is genuinely exercised.
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

// React only treats `act()` as authoritative when this flag is set; without it
// every setState logs "The current testing environment is not configured to
// support act(...)" and the suite crawls.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

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

import {
  ctl, FakeWs, FakeDevice, FakeOrchestrator, defaultAck,
  type AckHandler,
} from './helpers/groupCallFakes';
import {useGroupCall, clearAllLiveSfuHandles} from '../webrtc/useGroupCall';
import type {GroupCallHandle, GroupCallOptions} from '../webrtc/useGroupCall';
import {setActiveGroupCall, getActiveGroupCall} from '../runtime/groupCallRegistry';
import {clearGroupCallRejoinHandler} from '../webrtc/groupCallRejoinHub';
import {useMessengerStore} from '../store/messengerStore';
import {clearRoomIdentities} from '../webrtc/groupCallIdentityRegistry';

const CONVO = 'convo-abc';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function seedGroup(id = CONVO, extra: Record<string, unknown> = {}): void {
  useMessengerStore.setState((s: Record<string, unknown>) => ({
    ...s,
    groups: {
      ...(s.groups as Record<string, unknown>),
      [id]: {
        id,
        name:         'Test Group',
        owner:        'me',
        epoch:        1,
        masterKeyB64: MASTER_KEY,
        members:      {me: {}, bob: {}, carol: {}},
        ...extra,
      },
    },
    _ownUserId:     'me',
    _ownAuthUserId: 'me',
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
  ws: FakeWs;
}

async function mountHook(opts: GroupCallOptions, ack: AckHandler = defaultAck()): Promise<Rig> {
  ctl.liveWs = new FakeWs(ack);
  const ws = ctl.liveWs;
  let latest: GroupCallHandle | null = null;
  const Probe = (): null => {
    latest = useGroupCall(opts);
    return null;
  };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(14);
  return {
    handle: () => {
      if (!latest) { throw new Error('hook never rendered'); }
      return latest;
    },
    unmount: () => { TestRenderer.act(() => { renderer?.unmount(); }); },
    ws,
  };
}

/** Unmount + let the teardown's async tail settle while console is still muted. */
async function teardown(rig: {unmount: () => void}): Promise<void> {
  rig.unmount();
  await flush(3);
}

/** Mount without a WS (the transport-missing path needs no rig). */
async function mountBare(opts: GroupCallOptions): Promise<{handle: () => GroupCallHandle; unmount: () => void}> {
  let latest: GroupCallHandle | null = null;
  const Probe = (): null => { latest = useGroupCall(opts); return null; };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(10);
  return {
    handle: () => latest as GroupCallHandle,
    unmount: () => { TestRenderer.act(() => { renderer?.unmount(); }); },
  };
}

const baseOpts = (over: Partial<GroupCallOptions> = {}): GroupCallOptions => ({
  conversationId:   CONVO,
  callType:         'voice',
  direction:        'outgoing',
  recipientUserIds: ['bob', 'carol'],
  ownDisplayName:   'Me',
  callerName:       'Me',
  ...over,
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ctl.reset();
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  clearRoomIdentities('ROOM_CREATED_1');
  clearRoomIdentities('ROOM_HOST');
  seedGroup();
});

afterEach(() => {
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  jest.restoreAllMocks();
});

describe('useGroupCall — outgoing host boot reaches joined', () => {
  it('creates the room, joins, produces audio and rings the recipients', async () => {
    const rig = await mountHook(baseOpts());

    expect(rig.handle().state).toBe('joined');
    expect(rig.handle().roomId).toBe('ROOM_CREATED_1');
    expect(rig.handle().isHost).toBe(true);
    expect(rig.handle().selfTag).toBe('TAG_SELF');

    const create = ctl.httpCalls.find(c => c.url.endsWith('/sfu/rooms'));
    expect(create).toBeDefined();
    expect(JSON.parse(String(create!.init!.body))).toEqual({conversationId: CONVO});

    // the join echoes the host token minted by the create response
    expect(rig.ws.eventsNamed('sfu.join')[0]).toEqual({roomId: 'ROOM_CREATED_1', roomToken: 'HTOK'});

    // a VOICE call produces audio only
    expect(rig.ws.eventsNamed('sfu.produce').map(p => p.kind)).toEqual(['audio']);

    // B-342 — the ring is issued with the full dial list
    expect(rig.ws.eventsNamed('sfu.ring')[0]).toMatchObject({
      roomId: 'ROOM_CREATED_1', conversationId: CONVO, recipientUserIds: ['bob', 'carol'],
    });
    expect(rig.handle().ringStartedAt).toEqual(expect.any(Number));

    await teardown(rig);
  });

  it('B-09: a video call acquires the camera at boot and produces a video track', async () => {
    const rig = await mountHook(baseOpts({callType: 'video'}));

    expect(ctl.acquired).toEqual([{video: true}]);
    expect(rig.ws.eventsNamed('sfu.produce').map(p => p.kind)).toEqual(['audio', 'video']);
    expect(rig.handle().localStream).not.toBeNull();
    await teardown(rig);
  });

  it('a voice call does NOT open the camera', async () => {
    const rig = await mountHook(baseOpts({callType: 'voice'}));
    expect(ctl.acquired).toEqual([{video: false}]);
    await teardown(rig);
  });

  it('publishes the live call to the registry so the floating overlay can adopt it', async () => {
    const rig = await mountHook(baseOpts());
    const reg = getActiveGroupCall();
    expect(reg).not.toBeNull();
    expect(reg!.roomId).toBe('ROOM_CREATED_1');
    expect(reg!.conversationId).toBe(CONVO);
    expect(typeof reg!.leave).toBe('function');
    expect(typeof reg!.toggleMute).toBe('function');
    await teardown(rig);
  });

  it('broadcasts our tag→displayName identity to the dialed members (step 10)', async () => {
    const rig = await mountHook(baseOpts());
    const boot = ctl.presenceBroadcasts.find(p => p.payload.participantTag === 'TAG_SELF');
    expect(boot).toBeDefined();
    expect(boot!.payload).toMatchObject({
      roomId: 'ROOM_CREATED_1', displayName: 'Me', callType: 'voice',
    });
    await teardown(rig);
  });

  it('Step 3a.2 — reaches JOINED even while the presence broadcast is still in flight (void, not awaited)', async () => {
    // Presence hangs forever; the boot must still reach 'joined'.
    let releasePresence!: () => void;
    ctl.presenceGate = new Promise<void>(r => { releasePresence = r; });
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('joined');                         // did NOT wait on presence
    expect(ctl.presenceBroadcasts.some(p => p.payload.participantTag === 'TAG_SELF')).toBe(true); // still fired
    releasePresence();
    await teardown(rig);
  });

  it('B-10: keys the FrameCryptor off the id ensureCallGroupKey actually minted under', async () => {
    ctl.ensureKeyImpl = async () => ({keyConversationId: 'direct:me'});
    const rig = await mountHook(baseOpts());
    expect(ctl.ensureKeyCalls[0]).toMatchObject({
      conversationId: CONVO, recipientUserIds: ['bob', 'carol'],
    });
    expect(FakeOrchestrator.instances[0].opts).toMatchObject({
      conversationId: 'direct:me', selfTag: 'TAG_SELF',
    });
    await teardown(rig);
  });

  it('loads the mediasoup Device with the router capabilities the server returned', async () => {
    const rig = await mountHook(baseOpts());
    expect(FakeDevice.instances).toHaveLength(1);
    expect(FakeDevice.instances[0].loaded).toBe(true);
    expect(FakeDevice.instances[0].loadedCaps).toEqual({codecs: []});
    // both transports are opened and their DTLS connect is proxied over the WS
    expect(FakeDevice.instances[0].sendTx).not.toBeNull();
    expect(FakeDevice.instances[0].recvTx).not.toBeNull();
    expect(rig.ws.eventsNamed('sfu.transport.connect').length).toBeGreaterThanOrEqual(1);
    await teardown(rig);
  });

  it('falls back to STUN-only when the TURN endpoint rejects, without failing the call', async () => {
    ctl.turnStatus = 401;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('joined');
    await teardown(rig);
  });
});

describe('useGroupCall — boot refusal paths', () => {
  it('goes unavailable when there is no live WS transport', async () => {
    ctl.liveWs = null;
    const rig = await mountBare(baseOpts());
    expect(rig.handle().state).toBe('unavailable');
    await teardown(rig);
  });

  it('P1-BR-1: an incoming call with no roomId refuses instead of minting a new room', async () => {
    const rig = await mountHook(baseOpts({direction: 'incoming', hostUserId: 'bob'}));
    expect(rig.handle().state).toBe('unavailable');
    expect(ctl.httpCalls.some(c => c.url.endsWith('/sfu/rooms'))).toBe(false);
    await teardown(rig);
  });

  it('P1-BR-1: an incoming roomId of only whitespace is treated as missing', async () => {
    const rig = await mountHook(baseOpts({direction: 'incoming', roomId: '   ', hostUserId: 'bob'}));
    expect(rig.handle().state).toBe('unavailable');
    expect(ctl.httpCalls.some(c => c.url.endsWith('/sfu/rooms'))).toBe(false);
    await teardown(rig);
  });

  it('S6/B-111: refuses BEFORE sfu.join when this build has no FrameCryptor', async () => {
    ctl.cryptorAvailable = false;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('failed');
    expect(rig.ws.eventsNamed('sfu.join')).toHaveLength(0);
    await teardown(rig);
  });

  it('fails closed when FrameCryptor init throws — never produces plaintext media', async () => {
    ctl.cryptorInitThrows = true;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('failed');
    expect(rig.ws.eventsNamed('sfu.produce')).toHaveLength(0);
    // and it releases the SFU slot it already claimed
    expect(rig.ws.eventsNamed('sfu.leave').length).toBeGreaterThan(0);
    await teardown(rig);
  });

  it('fails closed when the sender cryptor cannot attach to the RTPSender', async () => {
    ctl.senderAttachThrows = true;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('failed');
    await teardown(rig);
  });

  it('surfaces room_full from sfu.join as the `full` state, not a generic failure', async () => {
    const ack: AckHandler = (event) => {
      if (event === 'sfu.join') { return new Error('room_full'); }
      return {ok: true};
    };
    const rig = await mountHook(baseOpts(), ack);
    expect(rig.handle().state).toBe('full');
    await teardown(rig);
  });

  it('fails the boot when POST /sfu/rooms is rejected', async () => {
    ctl.roomCreateStatus = 500;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('failed');
    await teardown(rig);
  });

  it('fails the boot when the camera/mic permission is denied', async () => {
    ctl.mediaThrows = true;
    const rig = await mountHook(baseOpts());
    expect(rig.handle().state).toBe('failed');
    expect(rig.ws.eventsNamed('sfu.join')).toHaveLength(0);
    await teardown(rig);
  });

  it('re-creates the room ONCE when sfu.join reports room_not_found on an outgoing call', async () => {
    let joinAttempts = 0;
    const ack: AckHandler = (event, data) => {
      if (event === 'sfu.join') {
        joinAttempts += 1;
        if (joinAttempts === 1) { return new Error('room_not_found'); }
        return {
          routerRtpCapabilities: {codecs: []},
          sendTransport: {}, recvTransport: {},
          participantTag: 'TAG_SELF', isHost: true, existingProducers: [],
        };
      }
      if (event === 'sfu.produce') { return {producerId: `p_${data.kind}`}; }
      if (event === 'sfu.producers') { return {producers: []}; }
      return {ok: true};
    };
    const rig = await mountHook(baseOpts(), ack);
    expect(joinAttempts).toBe(2);
    expect(ctl.httpCalls.filter(c => c.url.endsWith('/sfu/rooms'))).toHaveLength(2);
    expect(rig.handle().state).toBe('joined');
    await teardown(rig);
  });

  it('P1-BR-1: an INCOMING room_not_found never mints a replacement room', async () => {
    let joinAttempts = 0;
    const ack: AckHandler = (event) => {
      if (event === 'sfu.join') { joinAttempts += 1; return new Error('room_not_found'); }
      return {ok: true};
    };
    const rig = await mountHook(
      baseOpts({direction: 'incoming', roomId: 'ROOM_HOST', roomToken: 'JTOK', hostUserId: 'bob'}),
      ack,
    );
    expect(joinAttempts).toBe(1);
    expect(ctl.httpCalls.some(c => c.url.endsWith('/sfu/rooms'))).toBe(false);
    expect(rig.handle().state).toBe('failed');
    await teardown(rig);
  });
});

describe('useGroupCall — incoming joiner', () => {
  it('joins the host room with the ring-supplied token and never rings anyone', async () => {
    const rig = await mountHook(
      baseOpts({direction: 'incoming', roomId: 'ROOM_HOST', roomToken: 'JTOK', hostUserId: 'bob'}),
      defaultAck({isHost: false, participantTag: 'TAG_JOINER'}),
    );
    expect(rig.handle().state).toBe('joined');
    expect(rig.handle().isHost).toBe(false);
    expect(rig.ws.eventsNamed('sfu.join')[0]).toEqual({roomId: 'ROOM_HOST', roomToken: 'JTOK'});
    expect(rig.ws.eventsNamed('sfu.ring')).toHaveLength(0);
    await teardown(rig);
  });

  it('B-237-CW: the group OWNER re-broadcasts the key even when it is only JOINING', async () => {
    // owner === our own userId, real named group, we already hold the key.
    const rig = await mountHook(
      baseOpts({direction: 'incoming', roomId: 'ROOM_HOST', roomToken: 'JTOK', hostUserId: 'bob'}),
      defaultAck({isHost: false, participantTag: 'TAG_JOINER'}),
    );
    expect(ctl.ensureKeyCalls).toHaveLength(1);
    expect(ctl.ensureKeyCalls[0]).toMatchObject({conversationId: CONVO});
    await teardown(rig);
  });

  it('a NON-owner joiner never re-broadcasts the group key', async () => {
    seedGroup(CONVO, {owner: 'someone-else'});
    const rig = await mountHook(
      baseOpts({direction: 'incoming', roomId: 'ROOM_HOST', roomToken: 'JTOK', hostUserId: 'bob'}),
      defaultAck({isHost: false, participantTag: 'TAG_JOINER'}),
    );
    expect(rig.handle().state).toBe('joined');
    expect(ctl.ensureKeyCalls).toHaveLength(0);
    await teardown(rig);
  });

  it('B-13: consumes every existing producer and renders one tile each', async () => {
    const rig = await mountHook(
      baseOpts({direction: 'incoming', roomId: 'ROOM_HOST', roomToken: 'JTOK', hostUserId: 'bob'}),
      defaultAck({
        isHost: false,
        participantTag: 'TAG_JOINER',
        existingProducers: [
          {producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'},
          {producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'},
        ],
      }),
    );
    const tiles = rig.handle().remoteTiles;
    expect(tiles).toHaveLength(2);
    expect(tiles.map(t => t.producerId).sort()).toEqual(['p_audio_bob', 'p_video_bob']);
    expect(tiles.every(t => t.participantTag === 'TAG_BOB')).toBe(true);
    expect(rig.ws.eventsNamed('sfu.consumer.resume')).toHaveLength(2);
    await teardown(rig);
  });
});
