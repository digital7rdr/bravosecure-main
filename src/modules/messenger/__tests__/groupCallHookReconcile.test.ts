/**
 * useGroupCall — EXECUTABLE coverage of the BS-MEDIA / B-17 reconcile tick.
 *
 * The tick asks the SFU for its authoritative producer list and repairs the
 * local view: it consumes producers whose `sfu.new-producer` frame was missed,
 * re-applies the authoritative pause state, re-asserts OUR OWN camera intent
 * (GC-01), and prunes phantom tiles — but only after PRUNE_MISS_THRESHOLD
 * consecutive snapshots, so a partial fetch can never evict a live
 * participant (B-17).
 *
 * The tick runs once immediately on entering `joined` and every 4s after, so
 * the debounce cases below are the ones that must spend real time.
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

import {ctl, FakeWs, defaultAck, type AckHandler} from './helpers/groupCallFakes';
import {useGroupCall, clearAllLiveSfuHandles} from '../webrtc/useGroupCall';
import type {GroupCallHandle, GroupCallOptions} from '../webrtc/useGroupCall';
import {setActiveGroupCall} from '../runtime/groupCallRegistry';
import {clearGroupCallRejoinHandler} from '../webrtc/groupCallRejoinHub';
import {useMessengerStore} from '../store/messengerStore';
import {clearRoomIdentities} from '../webrtc/groupCallIdentityRegistry';

const CONVO = 'convo-reconcile';
const ROOM = 'ROOM_RECONCILE';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

type Snapshot = Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean}>;

function seedGroup(): void {
  useMessengerStore.setState((s: Record<string, unknown>) => ({
    ...s,
    groups: {
      ...(s.groups as Record<string, unknown>),
      [CONVO]: {
        id: CONVO, name: 'Reconcile Group', owner: 'someone-else',
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

/** Real-time wait inside act(), so interval-driven work commits properly. */
async function waitMs(ms: number): Promise<void> {
  await TestRenderer.act(async () => {
    await new Promise<void>(r => setTimeout(r, ms));
  });
  await flush(2);
}

const baseOpts = (over: Partial<GroupCallOptions> = {}): GroupCallOptions => ({
  conversationId:   CONVO,
  callType:         'voice',
  direction:        'incoming',
  roomId:           ROOM,
  roomToken:        'TOK',
  hostUserId:       'bob',
  recipientUserIds: ['bob'],
  ownDisplayName:   'Me',
  callerName:       'Bob',
  ...over,
});

interface Rig {
  handle: () => GroupCallHandle;
  ws: FakeWs;
  unmount: () => void;
}

/**
 * Mount a joined call whose `sfu.producers` snapshot is read from `snapshot`
 * at every tick, so a test can move the server's truth mid-call.
 */
async function mountWithSnapshot(
  snapshot: () => Snapshot,
  joinResp: Record<string, unknown> = {},
  over: Partial<GroupCallOptions> = {},
): Promise<Rig> {
  const inner: AckHandler = defaultAck({isHost: false, participantTag: 'TAG_ME', ...joinResp});
  ctl.liveWs = new FakeWs((event, data) => {
    if (event === 'sfu.producers') { return {producers: snapshot()}; }
    return inner(event, data);
  });
  const ws = ctl.liveWs;
  let latest: GroupCallHandle | null = null;
  const opts = baseOpts(over);
  const Probe = (): null => { latest = useGroupCall(opts); return null; };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(16);
  return {
    handle: () => latest as GroupCallHandle,
    ws,
    unmount: () => { TestRenderer.act(() => { renderer?.unmount(); }); },
  };
}

async function teardown(rig: Rig): Promise<void> {
  rig.unmount();
  await flush(3);
}

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
});

afterEach(() => {
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  jest.restoreAllMocks();
});

describe('useGroupCall — producer reconcile', () => {
  it('BS-MEDIA: consumes a producer whose sfu.new-producer frame was missed', async () => {
    // The join ack advertises NO existing producers — the peer's announcement
    // was lost — but the authoritative snapshot knows about them.
    const rig = await mountWithSnapshot(() => [
      {producerId: 'p_audio_ghost', participantTag: 'TAG_GHOST', kind: 'audio'},
    ]);

    expect(rig.handle().state).toBe('joined');
    expect(rig.handle().remoteTiles).toHaveLength(1);
    expect(rig.handle().remoteTiles[0]).toMatchObject({
      producerId: 'p_audio_ghost', participantTag: 'TAG_GHOST',
    });
    await teardown(rig);
  });

  it('re-applies the authoritative pause state when a producer-paused frame is lost', async () => {
    const rig = await mountWithSnapshot(
      () => [{producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video', paused: true}],
      {existingProducers: [{producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'}]},
    );

    // The consume snapshot said producerPaused:false, so only the reconcile
    // could have flipped this.
    expect(rig.handle().remoteTiles).toHaveLength(1);
    expect(rig.handle().remoteTiles[0].paused).toBe(true);
    await teardown(rig);
  });

  it('B-17: a tile missing from ONE snapshot is NOT pruned (partial fetches must not evict)', async () => {
    const rig = await mountWithSnapshot(
      () => [],
      {existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}]},
    );

    expect(rig.handle().remoteTiles).toHaveLength(1);
    await teardown(rig);
  });

  it('B-17: a tile absent from three consecutive snapshots is eventually pruned', async () => {
    const rig = await mountWithSnapshot(
      () => [],
      {existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}]},
    );
    expect(rig.handle().remoteTiles).toHaveLength(1);

    // ticks at t=0 (miss 1), t=4s (miss 2), t=8s (miss 3 → prune)
    await waitMs(9000);

    expect(rig.handle().remoteTiles).toHaveLength(0);
    await teardown(rig);
  }, 30000);

  it('a tile that reappears in the snapshot has its miss counter reset', async () => {
    let present = false;
    const rig = await mountWithSnapshot(
      () => (present
        ? [{producerId: 'p_audio_bob' as const, participantTag: 'TAG_BOB', kind: 'audio' as const}]
        : []),
      {existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}]},
    );
    expect(rig.handle().remoteTiles).toHaveLength(1);   // miss 1

    present = true;
    await waitMs(4500);                                  // miss counter cleared
    present = false;
    await waitMs(9000);                                  // misses 1..2 only by t≈13.5s

    expect(rig.handle().remoteTiles).toHaveLength(1);
    await teardown(rig);
  }, 40000);

  it('GC-01: re-asserts our own camera pause when the SFU snapshot disagrees', async () => {
    // Snapshot insists our video producer is live even though we turned the
    // camera off — the lost-pause case the re-assert exists for.
    const rig = await mountWithSnapshot(
      () => [{producerId: 'prod_video_2', participantTag: 'TAG_ME', kind: 'video', paused: false}],
      {},
      {callType: 'video'},
    );
    await TestRenderer.act(async () => { await rig.handle().toggleVideo(); });
    await flush(3);
    const pausesAfterToggle = rig.ws.eventsNamed('sfu.producer.pause')
      .filter(e => e.producerId === 'prod_video_2').length;
    expect(pausesAfterToggle).toBe(1);

    await waitMs(4500);

    expect(rig.ws.eventsNamed('sfu.producer.pause')
      .filter(e => e.producerId === 'prod_video_2').length).toBeGreaterThan(pausesAfterToggle);
    await teardown(rig);
  }, 30000);

  it('a failing sfu.producers snapshot never prunes anything', async () => {
    const inner = defaultAck({
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}],
    });
    ctl.liveWs = new FakeWs((event, data) => {
      if (event === 'sfu.producers') { return new Error('transport not open'); }
      return inner(event, data);
    });
    const ws = ctl.liveWs;
    const box: {handle: GroupCallHandle | null} = {handle: null};
    const opts = baseOpts();
    const Probe = (): null => { box.handle = useGroupCall(opts); return null; };
    let renderer: TestRendererInstance | null = null;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await flush(16);

    expect(box.handle!.remoteTiles).toHaveLength(1);
    await waitMs(9000);
    expect(box.handle!.remoteTiles).toHaveLength(1);
    expect(ws.eventsNamed('sfu.producers').length).toBeGreaterThan(1);

    TestRenderer.act(() => { renderer?.unmount(); });
    await flush(3);
  }, 30000);
});
