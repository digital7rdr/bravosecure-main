/**
 * useGroupCall — EXECUTABLE coverage of the LIVE-call surface: the control
 * callbacks the screen calls (mute, camera, moderation, invite, re-ring,
 * offscreen-video policy, leave) and the server-pushed `sfu.*` frames routed
 * through the REAL sfuDispatcher.
 *
 * Companion to groupCallHookBoot.test.ts; same edge-fake set, same rule —
 * only mediasoup-client / react-native-webrtc / HTTP / WS / native FrameCryptor
 * are faked. The dispatcher, identity registry, call registry, layout helpers
 * and the messenger store are the real modules.
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

import {ctl, FakeWs, FakeDevice, defaultAck, type AckHandler} from './helpers/groupCallFakes';
import {useGroupCall, clearAllLiveSfuHandles} from '../webrtc/useGroupCall';
import type {GroupCallHandle, GroupCallOptions} from '../webrtc/useGroupCall';
import {dispatchSfuFrame} from '../webrtc/sfuDispatcher';
import {setActiveGroupCall, getActiveGroupCall} from '../runtime/groupCallRegistry';
import {clearGroupCallRejoinHandler} from '../webrtc/groupCallRejoinHub';
import {useMessengerStore} from '../store/messengerStore';
import {clearRoomIdentities} from '../webrtc/groupCallIdentityRegistry';

const CONVO = 'convo-live';
const ROOM = 'ROOM_HOST';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function seedGroup(extra: Record<string, unknown> = {}): void {
  useMessengerStore.setState((s: Record<string, unknown>) => ({
    ...s,
    groups: {
      ...(s.groups as Record<string, unknown>),
      [CONVO]: {
        id:           CONVO,
        name:         'Live Group',
        owner:        'someone-else',
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
  ws: FakeWs;
  unmount: () => void;
}

const baseOpts = (over: Partial<GroupCallOptions> = {}): GroupCallOptions => ({
  conversationId:   CONVO,
  callType:         'voice',
  direction:        'outgoing',
  roomId:           ROOM,
  roomToken:        'TOK',
  recipientUserIds: ['bob', 'carol'],
  ownDisplayName:   'Me',
  callerName:       'Me',
  ...over,
});

/**
 * Mount a call that is already JOINED. `roomId` is supplied so no room is
 * created; the ack handler answers the whole sfu.* protocol.
 */
async function mountJoined(
  over: Partial<GroupCallOptions> = {},
  joinResp: Record<string, unknown> = {},
  ack?: AckHandler,
): Promise<Rig> {
  ctl.liveWs = new FakeWs(ack ?? defaultAck(joinResp));
  const ws = ctl.liveWs;
  let latest: GroupCallHandle | null = null;
  const opts = baseOpts(over);
  const Probe = (): null => { latest = useGroupCall(opts); return null; };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(14);
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

/** Run a handle callback inside act() and let its async tail settle. */
async function run(fn: () => unknown): Promise<void> {
  await TestRenderer.act(async () => { await fn(); });
  await flush(3);
}

function frame(event: string, data: Record<string, unknown>): void {
  dispatchSfuFrame({event, data: {roomId: ROOM, ...data}});
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
  useMessengerStore.setState((s: Record<string, unknown>) => ({...s, messages: {}}) as never);
});

afterEach(() => {
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  jest.restoreAllMocks();
});

// ── local controls ───────────────────────────────────────────────────

describe('useGroupCall — local mute', () => {
  it('CALL-24: mute disables the local track AND pauses the audio producer server-side', async () => {
    const rig = await mountJoined();
    expect(rig.handle().isMuted).toBe(false);

    await run(() => rig.handle().toggleMute());

    expect(rig.handle().isMuted).toBe(true);
    expect(getActiveGroupCall()!.isMuted).toBe(true);
    const paused = rig.ws.eventsNamed('sfu.producer.pause');
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({roomId: ROOM, producerId: 'prod_audio_1'});
    // the LOCAL capture is silenced too
    const audio = (getActiveGroupCall()!.audioTrack as unknown as {enabled: boolean});
    expect(audio.enabled).toBe(false);

    await teardown(rig);
  });

  it('un-muting resumes the same producer and clears the flag', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().toggleMute());
    await run(() => rig.handle().toggleMute());

    expect(rig.handle().isMuted).toBe(false);
    expect(rig.ws.eventsNamed('sfu.producer.resume')).toHaveLength(1);
    expect((getActiveGroupCall()!.audioTrack as unknown as {enabled: boolean}).enabled).toBe(true);
    await teardown(rig);
  });
});

describe('useGroupCall — camera', () => {
  it('toggleVideo OFF releases the camera, pauses (not closes) the producer and keeps audio', async () => {
    const rig = await mountJoined({callType: 'video'});
    expect(rig.handle().isVideoOff).toBe(false);

    await run(() => rig.handle().toggleVideo());

    expect(rig.handle().isVideoOff).toBe(true);
    expect(rig.ws.eventsNamed('sfu.producer.pause')).toHaveLength(1);
    expect(rig.ws.eventsNamed('sfu.producer.pause')[0]).toMatchObject({producerId: 'prod_video_2'});
    // the producer stays alive — the SFrame transform must survive
    const vp = FakeDevice.instances[0].sendTx!.produceCalls;
    expect(vp).toHaveLength(2);
    // local stream keeps the mic, loses the camera
    const tracks = (rig.handle().localStream as unknown as {getTracks: () => Array<{kind: string}>}).getTracks();
    expect(tracks.map(t => t.kind)).toEqual(['audio']);
    await teardown(rig);
  });

  it('toggleVideo ON re-acquires the camera and resumes the producer (no re-produce)', async () => {
    const rig = await mountJoined({callType: 'video'});
    await run(() => rig.handle().toggleVideo());
    await run(() => rig.handle().toggleVideo());

    expect(rig.handle().isVideoOff).toBe(false);
    expect(rig.ws.eventsNamed('sfu.producer.resume')).toHaveLength(1);
    // still only the two boot produces — the ON path replaceTracks
    expect(FakeDevice.instances[0].sendTx!.produceCalls).toHaveLength(2);
    const tracks = (rig.handle().localStream as unknown as {getTracks: () => Array<{kind: string}>}).getTracks();
    expect(tracks.map(t => t.kind).sort()).toEqual(['audio', 'video']);
    await teardown(rig);
  });

  it('toggleVideo ON surfaces a store error when the camera cannot be acquired', async () => {
    const rig = await mountJoined({callType: 'video'});
    await run(() => rig.handle().toggleVideo());
    ctl.getUserMediaThrows = true;
    await run(() => rig.handle().toggleVideo());

    expect(rig.handle().isVideoOff).toBe(true);
    expect(useMessengerStore.getState().error).toMatch(/Camera unavailable/);
    await teardown(rig);
  });

  it('switchCamera flips the lens and rebuilds the local stream', async () => {
    const rig = await mountJoined({callType: 'video'});
    expect(rig.handle().isFrontCamera).toBe(true);

    let result: boolean | undefined;
    await run(async () => { result = await rig.handle().switchCamera(); });

    expect(result).toBe(true);
    expect(rig.handle().isFrontCamera).toBe(false);
    expect(ctl.recoveredFacings).toEqual(['environment']);
    await teardown(rig);
  });

  it('switchCamera resolves false on a voice call — there is no video track', async () => {
    const rig = await mountJoined({callType: 'voice'});
    let result: boolean | undefined;
    await run(async () => { result = await rig.handle().switchCamera(); });
    expect(result).toBe(false);
    expect(rig.handle().isFrontCamera).toBe(true);
    await teardown(rig);
  });

  it('switchCamera resolves false and keeps the lens when acquisition returns nothing', async () => {
    const rig = await mountJoined({callType: 'video'});
    ctl.recoverCameraReturnsNull = true;
    let result: boolean | undefined;
    await run(async () => { result = await rig.handle().switchCamera(); });
    expect(result).toBe(false);
    expect(rig.handle().isFrontCamera).toBe(true);
    await teardown(rig);
  });
});

describe('useGroupCall — offscreen video bandwidth policy', () => {
  const joinWithVideoPeer = {
    isHost: false,
    participantTag: 'TAG_ME',
    existingProducers: [{producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'}],
  };

  it('pauses the consumer of a tag that scrolled offscreen and resumes it on return', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, joinWithVideoPeer);
    expect(rig.handle().remoteTiles).toHaveLength(1);
    const cid = rig.handle().remoteTiles[0].consumerId;

    await run(() => rig.handle().setHiddenVideoTags(['TAG_BOB']));
    expect(rig.ws.eventsNamed('sfu.consumer.pause')).toEqual([{roomId: ROOM, consumerId: cid}]);

    await run(() => rig.handle().setHiddenVideoTags([]));
    // one resume from the boot consume + one from the un-hide
    expect(rig.ws.eventsNamed('sfu.consumer.resume').filter(e => e.consumerId === cid)).toHaveLength(2);
    await teardown(rig);
  });

  it('is a no-op when the hidden set has not changed', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, joinWithVideoPeer);
    await run(() => rig.handle().setHiddenVideoTags(['TAG_BOB']));
    const after = rig.ws.eventsNamed('sfu.consumer.pause').length;
    await run(() => rig.handle().setHiddenVideoTags(['TAG_BOB']));
    expect(rig.ws.eventsNamed('sfu.consumer.pause')).toHaveLength(after);
    await teardown(rig);
  });

  it('never pauses AUDIO consumers — only video', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, {
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}],
    });
    await run(() => rig.handle().setHiddenVideoTags(['TAG_BOB']));
    expect(rig.ws.eventsNamed('sfu.consumer.pause')).toHaveLength(0);
    await teardown(rig);
  });
});

// ── host moderation ──────────────────────────────────────────────────

describe('useGroupCall — host moderation', () => {
  it('muteParticipant sends sfu.mute-target and records who THIS host muted', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().muteParticipant('TAG_BOB'));

    expect(rig.ws.eventsNamed('sfu.mute-target')).toEqual([
      {roomId: ROOM, targetTag: 'TAG_BOB', unmute: false},
    ]);
    expect(rig.handle().hostMutedTags).toEqual(['TAG_BOB']);
    await teardown(rig);
  });

  it('un-muting drops the tag again so the UI stops offering Unmute', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().muteParticipant('TAG_BOB'));
    await run(() => rig.handle().muteParticipant('TAG_BOB', true));

    expect(rig.ws.eventsNamed('sfu.mute-target')[1]).toMatchObject({unmute: true});
    expect(rig.handle().hostMutedTags).toEqual([]);
    await teardown(rig);
  });

  it('a failed mute-target does not pretend the participant is muted', async () => {
    const ack = defaultAck();
    const rig = await mountJoined({}, {}, (event, data) => {
      if (event === 'sfu.mute-target') { return new Error('not_host'); }
      return ack(event, data);
    });
    await run(() => rig.handle().muteParticipant('TAG_BOB'));
    expect(rig.handle().hostMutedTags).toEqual([]);
    await teardown(rig);
  });

  it('kickParticipant sends sfu.kick for the target tag', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().kickParticipant('TAG_CAROL'));
    expect(rig.ws.eventsNamed('sfu.kick')).toEqual([{roomId: ROOM, targetTag: 'TAG_CAROL'}]);
    await teardown(rig);
  });
});

describe('useGroupCall — invite / re-ring', () => {
  it('B-300: keys the invitee (widened roster) BEFORE ringing them', async () => {
    const rig = await mountJoined();
    ctl.ensureKeyCalls.length = 0;
    await run(() => rig.handle().inviteUsers(['dave']));

    expect(ctl.ensureKeyCalls).toHaveLength(1);
    expect((ctl.ensureKeyCalls[0].recipientUserIds as string[]).sort())
      .toEqual(['bob', 'carol', 'dave']);
    const rings = rig.ws.eventsNamed('sfu.ring');
    expect(rings[rings.length - 1]).toMatchObject({recipientUserIds: ['dave']});
    await teardown(rig);
  });

  it('B-300: a keying failure ABORTS the invite — the invitee is never rung', async () => {
    const rig = await mountJoined();
    const ringsBefore = rig.ws.eventsNamed('sfu.ring').length;
    ctl.ensureKeyThrows = new Error('no key');

    await expect(rig.handle().inviteUsers(['dave'])).rejects.toThrow(/Could not share the call key/);
    await flush(2);
    expect(rig.ws.eventsNamed('sfu.ring')).toHaveLength(ringsBefore);
    await teardown(rig);
  });

  it('inviting nobody is a silent no-op', async () => {
    const rig = await mountJoined();
    ctl.ensureKeyCalls.length = 0;
    await run(() => rig.handle().inviteUsers([]));
    expect(ctl.ensureKeyCalls).toHaveLength(0);
    await teardown(rig);
  });

  it('reRing re-dials only the named users and marks them re-rung', async () => {
    const rig = await mountJoined();
    const before = rig.handle().ringStartedAt;
    await run(() => rig.handle().reRing(['carol']));

    const rings = rig.ws.eventsNamed('sfu.ring');
    expect(rings[rings.length - 1]).toMatchObject({roomId: ROOM, recipientUserIds: ['carol']});
    expect(Array.from(rig.handle().reRungUserIds)).toEqual(['carol']);
    expect(rig.handle().ringStartedAt).not.toBe(before);
    await teardown(rig);
  });

  it('reRing with an empty list never touches the wire', async () => {
    const rig = await mountJoined();
    const before = rig.ws.eventsNamed('sfu.ring').length;
    await run(() => rig.handle().reRing([]));
    expect(rig.ws.eventsNamed('sfu.ring')).toHaveLength(before);
    await teardown(rig);
  });
});

// ── server-pushed frames (through the real dispatcher) ───────────────

describe('useGroupCall — sfu frames', () => {
  it('B-06: a live sfu.new-producer is consumed and rendered as its own tile', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'},
      {isHost: false, participantTag: 'TAG_ME'});
    expect(rig.handle().remoteTiles).toHaveLength(0);

    await run(() => frame('sfu.new-producer', {
      producerId: 'p_video_late', participantTag: 'TAG_LATE', kind: 'video',
    }));

    expect(rig.handle().remoteTiles).toHaveLength(1);
    expect(rig.handle().remoteTiles[0]).toMatchObject({
      participantTag: 'TAG_LATE', producerId: 'p_video_late', kind: 'video',
    });
    await teardown(rig);
  });

  it('the same producerId announced twice yields exactly one tile', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'},
      {isHost: false, participantTag: 'TAG_ME'});
    await run(() => frame('sfu.new-producer', {
      producerId: 'p_audio_dupe', participantTag: 'TAG_DUPE', kind: 'audio',
    }));
    await run(() => frame('sfu.new-producer', {
      producerId: 'p_audio_dupe', participantTag: 'TAG_DUPE', kind: 'audio',
    }));
    expect(rig.handle().remoteTiles).toHaveLength(1);
    await teardown(rig);
  });

  it('BS-027: participant.left drops the tile, closes the consumer and stops its track', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, {
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}],
    });
    expect(rig.handle().remoteTiles).toHaveLength(1);
    const consumer = FakeDevice.instances[0].recvTx!.consumers[0];

    await run(() => frame('sfu.participant.left', {participantTag: 'TAG_BOB'}));

    expect(rig.handle().remoteTiles).toHaveLength(0);
    expect(consumer.closed).toBe(true);
    expect(consumer.track.stopped).toBe(true);
    expect(rig.handle().identityByTag).not.toHaveProperty('TAG_BOB');
    await teardown(rig);
  });

  it('producer-paused/-resumed flips the tile between camera-off and live', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, {
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video'}],
    });
    expect(rig.handle().remoteTiles[0].paused).toBe(false);

    await run(() => frame('sfu.producer-paused', {
      producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video',
    }));
    expect(rig.handle().remoteTiles[0].paused).toBe(true);
    expect(getActiveGroupCall()!.remoteTiles[0].paused).toBe(true);

    await run(() => frame('sfu.producer-resumed', {
      producerId: 'p_video_bob', participantTag: 'TAG_BOB', kind: 'video',
    }));
    expect(rig.handle().remoteTiles[0].paused).toBe(false);
    await teardown(rig);
  });

  it('GC-08: a host mute silences our mic and persists to the registry; unmute restores it', async () => {
    const rig = await mountJoined();
    await run(() => frame('sfu.muted', {}));
    expect(rig.handle().isMuted).toBe(true);
    expect(getActiveGroupCall()!.isMuted).toBe(true);
    expect((getActiveGroupCall()!.audioTrack as unknown as {enabled: boolean}).enabled).toBe(false);

    await run(() => frame('sfu.unmuted', {}));
    expect(rig.handle().isMuted).toBe(false);
    expect((getActiveGroupCall()!.audioTrack as unknown as {enabled: boolean}).enabled).toBe(true);
    await teardown(rig);
  });

  it('sfu.kicked tears the call down into the kicked state', async () => {
    const rig = await mountJoined();
    await run(() => frame('sfu.kicked', {}));
    expect(rig.handle().state).toBe('kicked');
    expect(getActiveGroupCall()).toBeNull();
    await teardown(rig);
  });

  it('sfu.room.ended tears down WITHOUT a redundant sfu.leave round-trip', async () => {
    const rig = await mountJoined();
    const leavesBefore = rig.ws.eventsNamed('sfu.leave').length;
    await run(() => frame('sfu.room.ended', {reason: 'host-left'}));

    expect(rig.handle().state).toBe('ended-by-host');
    expect(rig.ws.eventsNamed('sfu.leave')).toHaveLength(leavesBefore);
    expect(getActiveGroupCall()).toBeNull();
    await teardown(rig);
  });

  it('a worker_died room.ended is handled by the same graceful teardown', async () => {
    const rig = await mountJoined();
    await run(() => frame('sfu.room.ended', {reason: 'worker_died'}));
    expect(rig.handle().state).toBe('ended-by-host');
    await teardown(rig);
  });
});

// ── teardown ─────────────────────────────────────────────────────────

describe('useGroupCall — leave', () => {
  it('closes producers, consumers and transports, stops the mic and clears the registry', async () => {
    const rig = await mountJoined({direction: 'incoming', hostUserId: 'bob'}, {
      isHost: false,
      participantTag: 'TAG_ME',
      existingProducers: [{producerId: 'p_audio_bob', participantTag: 'TAG_BOB', kind: 'audio'}],
    });
    const dev = FakeDevice.instances[0];
    const consumer = dev.recvTx!.consumers[0];
    const localAudio = getActiveGroupCall()!.audioTrack as unknown as {stopped: boolean};

    await run(() => rig.handle().leave());

    expect(rig.handle().state).toBe('left');
    expect(rig.handle().remoteTiles).toEqual([]);
    expect(rig.handle().localStream).toBeNull();
    expect(consumer.closed).toBe(true);
    expect(dev.sendTx!.closed).toBe(true);
    expect(dev.recvTx!.closed).toBe(true);
    expect(localAudio.stopped).toBe(true);
    expect(getActiveGroupCall()).toBeNull();
    expect(rig.ws.eventsNamed('sfu.leave')).toEqual([{roomId: ROOM}]);
    await teardown(rig);
  });

  it('is idempotent — a second leave does not re-send sfu.leave', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().leave());
    const after = rig.ws.eventsNamed('sfu.leave').length;
    await run(() => rig.handle().leave());
    expect(rig.ws.eventsNamed('sfu.leave')).toHaveLength(after);
    await teardown(rig);
  });

  it('B-12: a host hanging up mid-ring cancels the ring for everyone still ringing', async () => {
    const rig = await mountJoined({}, {isHost: true, participantTag: 'TAG_SELF'});
    await run(() => rig.handle().leave());

    expect(rig.ws.eventsNamed('sfu.ring.cancel')).toEqual([{
      roomId:           ROOM,
      conversationId:   CONVO,
      recipientUserIds: ['bob', 'carol'],
      roomToken:        'TOK',
    }]);
    await teardown(rig);
  });

  it('a NON-host leaving never cancels the host ring', async () => {
    const rig = await mountJoined(
      {direction: 'incoming', hostUserId: 'bob'},
      {isHost: false, participantTag: 'TAG_ME'},
    );
    await run(() => rig.handle().leave());
    expect(rig.ws.eventsNamed('sfu.ring.cancel')).toHaveLength(0);
    await teardown(rig);
  });

  it('appends a group call-history bubble to the conversation on hangup', async () => {
    const rig = await mountJoined();
    // the bubble is gated on a >=2s call, so age the start stamp
    const realNow = Date.now;
    const t0 = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => t0 + 9000);
    await run(() => rig.handle().leave());
    (Date.now as unknown as {mockRestore: () => void}).mockRestore();

    const msgs = (useMessengerStore.getState().messages as Record<string, unknown[]>)[CONVO] ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: 'call',
      sender_id: 'self',
      call_meta: {kind: 'voice', direction: 'outgoing', outcome: 'answered', groupCall: true},
    });
    await teardown(rig);
  });

  it('a sub-2s hangup leaves no history bubble', async () => {
    const rig = await mountJoined();
    await run(() => rig.handle().leave());
    const msgs = (useMessengerStore.getState().messages as Record<string, unknown[]>)[CONVO] ?? [];
    expect(msgs).toHaveLength(0);
    await teardown(rig);
  });
});
