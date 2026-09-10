/**
 * Regression — B-123: camera flip in a group call killed video entirely.
 *
 * recoverGroupCamera() called `currentTrack.stop()` after
 * `producer.replaceTrack({track})`. But mediasoup ALREADY stops the previous
 * track — Producer.replaceTrack() -> destroyTrack() -> track.stop(), because
 * produce() defaults stopTracks:true. The second stop tore down capture state
 * the just-opened camera depended on and BOTH cameras closed:
 *
 *   CameraCapturer: Stop capture      <- mediasoup destroyTrack()
 *   CameraCapturer: Stop capture      <- the redundant stop
 *   Camera device closed  (camera 1)
 *   Camera device closed  (camera 0)  <- the NEW camera, 200ms after opening
 *
 * after which the producer sent zero bytes (trace: dec:0/rx:0/B:0).
 *
 * It hid on the B-20 resume path this helper was built for, because there the
 * old track is already ended so the extra stop is a no-op. It only bites when
 * the old track is LIVE — a camera flip.
 */

// `mock` prefix is required: jest.mock factories may not reference
// out-of-scope variables unless they are named mock*.
const mockGetUserMedia = jest.fn();
// peerConnectionFactory imports exactly these two runtime modules; stub both so
// the helper can be exercised without the native WebRTC/RN module graph.
jest.mock('react-native', () => ({
  Platform: {OS: 'android', select: (o: Record<string, unknown>) => o.android},
  PermissionsAndroid: {request: jest.fn(), RESULTS: {GRANTED: 'granted'}, PERMISSIONS: {}},
}));
jest.mock('react-native-webrtc', () => ({
  mediaDevices: {getUserMedia: (...a: unknown[]) => mockGetUserMedia(...a)},
  RTCPeerConnection: class {},
  RTCView: () => null,
  MediaStream: class {},
}));

type FakeTrack = {
  id: string;
  kind: 'video';
  readyState: 'live' | 'ended';
  stopCalls: number;
  stop: () => void;
};

function makeTrack(id: string): FakeTrack {
  const t: FakeTrack = {
    id,
    kind: 'video',
    readyState: 'live',
    stopCalls: 0,
    // Mirrors react-native-webrtc: stop() sets readyState synchronously.
    stop() { t.stopCalls += 1; t.readyState = 'ended'; },
  };
  return t;
}

/** Producer that stops its held track on replaceTrack, exactly as mediasoup does. */
function makeProducer(held: FakeTrack) {
  return {
    _track: held,
    async replaceTrack({track}: {track: FakeTrack}) {
      this._track.stop();     // destroyTrack(), stopTracks:true
      this._track = track;
    },
  };
}

describe('B-123 — recoverGroupCamera must not double-stop the old track', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetUserMedia.mockReset();
  });

  async function run(oldTrack: FakeTrack, passed: FakeTrack | null) {
    const newTrack = makeTrack('new');
    mockGetUserMedia.mockResolvedValue({getVideoTracks: () => [newTrack]});
    const {recoverGroupCamera} = require('../webrtc/peerConnectionFactory');
    const producer = makeProducer(oldTrack);
    const returned = await recoverGroupCamera({
      producer: producer as never,
      facing: 'environment',
      currentTrack: passed as never,
    });
    return {returned, newTrack, producer};
  }

  it('stops the live old track exactly ONCE (mediasoup owns it)', async () => {
    const oldTrack = makeTrack('old');
    await run(oldTrack, oldTrack);
    expect(oldTrack.stopCalls).toBe(1);
    expect(oldTrack.readyState).toBe('ended');
  });

  it('never stops the newly acquired track', async () => {
    const oldTrack = makeTrack('old');
    const {newTrack} = await run(oldTrack, oldTrack);
    expect(newTrack.stopCalls).toBe(0);
    expect(newTrack.readyState).toBe('live');
  });

  it('still installs the new track on the producer', async () => {
    const oldTrack = makeTrack('old');
    const {returned, newTrack, producer} = await run(oldTrack, oldTrack);
    expect(returned).toBe(newTrack);
    expect(producer._track).toBe(newTrack);
  });

  it('stops a foreign track the producer did not hold (no camera leak)', async () => {
    // Safety net: caller passed something the producer was not using, so
    // mediasoup stopped a different track and this one would otherwise leak.
    const held = makeTrack('held');
    const foreign = makeTrack('foreign');
    await run(held, foreign);
    expect(held.stopCalls).toBe(1);     // mediasoup
    expect(foreign.stopCalls).toBe(1);  // our safety net
  });

  it('tolerates a null currentTrack', async () => {
    const oldTrack = makeTrack('old');
    const {returned, newTrack} = await run(oldTrack, null);
    expect(returned).toBe(newTrack);
  });
});
