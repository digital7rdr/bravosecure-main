/**
 * B-342 (companion) — getUserMedia must not block a call boot forever.
 *
 * Measured on 2026-07-30: three consecutive accepts stalled silently between
 * "transport acquired" and step=2 because the camera was still held by the
 * previous call's teardown — RN-WebRTC queues camera opens, so each
 * abandoned boot clogged the line further; one boot sat 36 s in getUserMedia
 * before the queue unwound. Rule: media acquisition gets a bounded window;
 * on timeout the boot FAILS visibly (warn + throw) instead of hanging, and a
 * late-resolving stream is stopped so it releases the camera instead of
 * leaking it into the queue.
 */

const mockCheck = jest.fn(async () => true);
const mockRequestMultiple = jest.fn(async () => ({a: 'granted', c: 'granted'}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 31},
  PermissionsAndroid: {
    PERMISSIONS: {RECORD_AUDIO: 'a', CAMERA: 'c'},
    RESULTS: {GRANTED: 'granted'},
    check: (...args: unknown[]) => mockCheck(...(args as [])),
    requestMultiple: (...args: unknown[]) => mockRequestMultiple(...(args as [])),
  },
}));

const mockGetUserMedia = jest.fn();
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class {},
  mediaDevices: {getUserMedia: (...a: unknown[]) => mockGetUserMedia(...(a as []))},
  RTCView: () => null,
}));

import {getLocalMedia} from '../webrtc/peerConnectionFactory';

describe('B-342 — bounded getUserMedia', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetUserMedia.mockReset();
    mockCheck.mockResolvedValue(true);
    mockRequestMultiple.mockResolvedValue({a: 'granted', c: 'granted'});
  });
  afterEach(() => { jest.useRealTimers(); });

  test('a never-resolving getUserMedia rejects with a timeout instead of hanging', async () => {
    mockGetUserMedia.mockReturnValue(new Promise(() => { /* never */ }));
    const p = getLocalMedia({video: true});
    const settled = p.then(() => 'resolved', e => (e as Error).message);
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(settled).resolves.toMatch(/local_media_timeout/);
  });

  test('a stream resolving AFTER the timeout is stopped, releasing the camera', async () => {
    const stop = jest.fn();
    let lateResolve: (s: unknown) => void = () => {};
    mockGetUserMedia.mockReturnValue(new Promise(res => { lateResolve = res; }));
    const p = getLocalMedia({video: true}).catch(() => undefined);
    await jest.advanceTimersByTimeAsync(20_000);
    lateResolve({getTracks: () => [{kind: 'video', stop}]});
    await p;
    // allow the late-resolve handler microtask to run
    await Promise.resolve();
    expect(stop).toHaveBeenCalled();
  });

  test('a normally-resolving stream is unaffected', async () => {
    mockGetUserMedia.mockResolvedValue({getTracks: () => [{kind: 'audio'}]});
    const p = getLocalMedia({video: false});
    await jest.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(out.audioTrack).toEqual({kind: 'audio'});
  });
});
