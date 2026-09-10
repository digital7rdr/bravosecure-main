/**
 * B-20 (group) — `recoverGroupCamera` re-acquires the camera (keeping the
 * CURRENT facing) and `producer.replaceTrack({track})`s it onto the EXISTING
 * mediasoup video producer, so a mid-call camera theft heals on resume with
 * the SAME RTCRtpSender (SFrame transform intact) and no SDP renegotiation.
 * getUserMedia is mocked; this pins the producer-replace + facing + stop rules
 * that BlueStacks can't exercise (it reports the stolen track as 'live').
 */

jest.mock('react-native', () => ({
  Platform:           {OS: 'android', Version: 31},
  PermissionsAndroid: {PERMISSIONS: {RECORD_AUDIO: 'a', CAMERA: 'c'}, requestMultiple: jest.fn(async () => ({}))},
}));

const mockGetUserMedia = jest.fn();
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class {},
  mediaDevices:      {getUserMedia: (...a: unknown[]) => mockGetUserMedia(...a)},
  RTCView:           () => null,
}));

import {recoverGroupCamera} from '../webrtc/peerConnectionFactory';

type FakeTrack = {kind: 'audio' | 'video'; id: string; readyState: string; stop: jest.Mock};
function track(kind: 'audio' | 'video', id: string, readyState = 'live'): FakeTrack {
  return {kind, id, readyState, stop: jest.fn()};
}
/**
 * B-123 — this fake now models what mediasoup ACTUALLY does:
 * Producer.replaceTrack() -> destroyTrack() -> heldTrack.stop(), because
 * produce() defaults stopTracks:true. The previous fake resolved without
 * touching the held track, so the helper's own (redundant) stop was the only
 * thing satisfying the "old track released" assertion below — which hid a real
 * double-stop that closed BOTH cameras on a live camera flip.
 */
function fakeProducer(held?: FakeTrack) {
  const p = {
    held,
    replaceTrack: jest.fn(async ({track: incoming}: {track: FakeTrack}) => {
      p.held?.stop();
      p.held = incoming;
      return undefined;
    }),
  };
  return p;
}
function freshStreamWith(videoTrack: FakeTrack | null) {
  return {getVideoTracks: () => (videoTrack ? [videoTrack] : [])};
}

beforeEach(() => { mockGetUserMedia.mockReset(); });

describe('recoverGroupCamera — B-20 group camera-loss recovery', () => {
  test('no producer → returns null and never opens the camera', async () => {
    const out = await recoverGroupCamera({producer: null, facing: 'user', currentTrack: null});
    expect(out).toBeNull();
    expect(mockGetUserMedia).not.toHaveBeenCalled();
  });

  test('replaceTrack({track}) onto the existing producer, keeping facing; stops the dead track', async () => {
    const dead = track('video', 'old', 'ended');
    const producer = fakeProducer(dead);
    const newTrack = track('video', 'new');
    mockGetUserMedia.mockResolvedValue(freshStreamWith(newTrack));

    const out = await recoverGroupCamera({producer: producer as never, facing: 'environment', currentTrack: dead as never});

    // GCV-1 — same facing (not flipped), audio off, AND the pinned 480p geometry.
    expect(mockGetUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: 'environment',
        width:      {ideal: 640,  max: 1280},
        height:     {ideal: 480,  max: 720},
        frameRate:  {ideal: 30,   max: 30},
      },
    });
    // Swapped onto the SAME producer (object form) — keeps the SFrame transform, no reneg.
    expect(producer.replaceTrack).toHaveBeenCalledWith({track: newTrack});
    // Old (stolen) track released so the privacy light goes off — B-123: by
    // mediasoup's destroyTrack(), and EXACTLY once. A second stop from this
    // helper tore down the freshly opened camera too.
    expect(dead.stop).toHaveBeenCalledTimes(1);
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(out).toBe(newTrack);
  });

  test('getUserMedia returns no video track → returns null (no replaceTrack, no crash)', async () => {
    const dead = track('video', 'old', 'ended');
    const producer = fakeProducer();
    mockGetUserMedia.mockResolvedValue(freshStreamWith(null));
    const out = await recoverGroupCamera({producer: producer as never, facing: 'user', currentTrack: dead as never});
    expect(out).toBeNull();
    expect(producer.replaceTrack).not.toHaveBeenCalled();
  });
});
