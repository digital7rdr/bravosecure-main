/**
 * GCV-1 — every local capture site must go through the shared
 * `localVideoConstraints` builder. A video constraint with no width AND no
 * height is normalized by @livekit/react-native-webrtc to its own 1280x720
 * default, which silently flips capture from 4:3 to 16:9 mid-call.
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

import {readFileSync} from 'fs';
import {join} from 'path';
import {
  flipCamera,
  getLocalMedia,
  localVideoConstraints,
  recoverCamera,
  recoverGroupCamera,
} from '../webrtc/peerConnectionFactory';

const FACTORY_SRC = readFileSync(join(__dirname, '..', 'webrtc', 'peerConnectionFactory.ts'), 'utf8');

type FakeTrack = {kind: 'audio' | 'video'; id: string; readyState: string; stop: jest.Mock};
function track(kind: 'audio' | 'video', id: string, readyState = 'live'): FakeTrack {
  return {kind, id, readyState, stop: jest.fn()};
}
function fakePc(senders: Array<{track: FakeTrack | null; replaceTrack: jest.Mock}>) {
  return {getSenders: () => senders} as never;
}
function streamWith(videoTrack: FakeTrack | null) {
  return {
    getVideoTracks: () => (videoTrack ? [videoTrack] : []),
    getTracks:      () => (videoTrack ? [videoTrack] : []),
  };
}

beforeEach(() => { mockGetUserMedia.mockReset(); });

describe('localVideoConstraints — GCV-1 pinned capture geometry', () => {
  test('always carries width/height/frameRate for both lenses', () => {
    for (const facing of ['user', 'environment'] as const) {
      const c = localVideoConstraints(facing);
      expect(c.facingMode).toBe(facing);
      expect(c.width).toEqual({ideal: 640, max: 1280});
      expect(c.height).toEqual({ideal: 480, max: 720});
      expect(c.frameRate).toEqual({ideal: 30, max: 30});
    }
  });

  test('never hits the fork 1280x720 default branch', () => {
    // Mirrors @livekit/react-native-webrtc RTCUtil.normalizeMediaConstraints:
    //   if (!c.height && !c.width) { c.height = 720; c.width = 1280; }
    const extractNumber = (c: Record<string, unknown>, prop: string): number | undefined => {
      const v = c[prop] as number | Record<string, number> | undefined;
      if (typeof v === 'number') {return v;}
      if (v && typeof v === 'object') {
        for (const k of ['exact', 'ideal', 'max', 'min']) {if (v[k]) {return v[k];}}
      }
      return undefined;
    };
    const c = localVideoConstraints('user') as unknown as Record<string, unknown>;
    expect(extractNumber(c, 'width')).toBe(640);
    expect(extractNumber(c, 'height')).toBe(480);
  });

  test('aspect ratio is 4:3', () => {
    const c = localVideoConstraints('user');
    expect(c.width.ideal / c.height.ideal).toBeCloseTo(4 / 3, 5);
  });

  test('no capture site in peerConnectionFactory passes facingMode alone', () => {
    expect(FACTORY_SRC).not.toMatch(/video: \{facingMode/);
  });
});

describe('capture sites use the shared builder', () => {
  test('getLocalMedia({video:true}) boots through localVideoConstraints', async () => {
    mockGetUserMedia.mockResolvedValue(streamWith(track('video', 'v1')));
    await getLocalMedia({video: true});
    expect(mockGetUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({video: localVideoConstraints('user')}),
    );
  });

  test('getLocalMedia({video:false}) still opens no camera', async () => {
    mockGetUserMedia.mockResolvedValue(streamWith(null));
    await getLocalMedia({video: false});
    expect(mockGetUserMedia).toHaveBeenCalledWith(expect.objectContaining({video: false}));
  });

  test('flipCamera acquires the OPPOSITE lens with the pinned geometry', async () => {
    const old = track('video', 'old');
    const pc = fakePc([{track: old, replaceTrack: jest.fn(async () => undefined)}]);
    mockGetUserMedia.mockResolvedValue(streamWith(track('video', 'new')));
    await flipCamera({pc, currentTrack: old as never, facing: 'user'});
    expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: localVideoConstraints('environment')});
  });

  test('recoverCamera acquires the SAME lens with the pinned geometry', async () => {
    const dead = track('video', 'old', 'ended');
    const pc = fakePc([{track: dead, replaceTrack: jest.fn(async () => undefined)}]);
    mockGetUserMedia.mockResolvedValue(streamWith(track('video', 'new')));
    await recoverCamera({pc, facing: 'user', currentTrack: dead as never});
    expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: localVideoConstraints('user')});
  });

  test('recoverGroupCamera acquires the SAME lens with the pinned geometry', async () => {
    const dead = track('video', 'old', 'ended');
    mockGetUserMedia.mockResolvedValue(streamWith(track('video', 'new')));
    await recoverGroupCamera({
      producer:     {replaceTrack: jest.fn(async () => undefined)},
      facing:       'user',
      currentTrack: dead as never,
    });
    expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: localVideoConstraints('user')});
  });
});
