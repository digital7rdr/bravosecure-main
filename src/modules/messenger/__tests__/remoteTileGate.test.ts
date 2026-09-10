/**
 * O-E / O-F (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the shared 1:1
 * remote-tile mount decision. Pins the audited CALL-N2 gate order for
 * BOTH surfaces (CallScreen + the previously-ungated FloatingCallOverlay,
 * which rendered a black card for audio-only/camera-off peers), and the
 * B-16 second half: the remount key must carry the remote video TRACK id
 * so a replaced track with an unchanged stream id still rebinds the
 * native SurfaceView.
 */

import {resolveRemoteTile} from '../webrtc/remoteTileGate';

const LIVE = {
  remoteVideoOff:  false,
  remoteHasVideo:  true,
  hasRemoteStream: true,
  streamURL:       'stream://abc',
  videoTrackId:    'trk-1',
};

describe('resolveRemoteTile — gate order (CALL-N2)', () => {
  it('camera-off advisory wins over EVERYTHING (placeholder, never black/video)', () => {
    expect(resolveRemoteTile({...LIVE, remoteVideoOff: true}).kind).toBe('camera-off');
    // Even with no stream at all, an explicit advisory shows the placeholder.
    expect(resolveRemoteTile({
      remoteVideoOff: true, remoteHasVideo: false, hasRemoteStream: false, streamURL: null,
    }).kind).toBe('camera-off');
  });

  it('audio-only peer with flowing stream → avatar, never a black RTCView', () => {
    expect(resolveRemoteTile({...LIVE, remoteHasVideo: false}).kind).toBe('avatar');
  });

  it('ringing (no remote stream yet) → none (centre overlay handles it)', () => {
    expect(resolveRemoteTile({
      remoteVideoOff: false, remoteHasVideo: false, hasRemoteStream: false, streamURL: null,
    }).kind).toBe('none');
  });

  it('dead native stream handle (null URL) → none, not a blank RTCView', () => {
    expect(resolveRemoteTile({...LIVE, streamURL: null}).kind).toBe('none');
  });

  it('live video + valid URL → video with the URL', () => {
    const d = resolveRemoteTile(LIVE);
    expect(d.kind).toBe('video');
    if (d.kind === 'video') {
      expect(d.streamURL).toBe('stream://abc');
    }
  });
});

describe('resolveRemoteTile — O-F remount key (B-16 second half)', () => {
  it('a REPLACED remote video track (same stream id/URL) changes the key', () => {
    const before = resolveRemoteTile(LIVE);
    const after  = resolveRemoteTile({...LIVE, videoTrackId: 'trk-2'});
    expect(before.kind).toBe('video');
    expect(after.kind).toBe('video');
    if (before.kind === 'video' && after.kind === 'video') {
      expect(before.remountKey).not.toBe(after.remountKey);
    }
  });

  it('a stable track keeps a stable key (no spurious SurfaceView remounts)', () => {
    const a = resolveRemoteTile(LIVE);
    const b = resolveRemoteTile({...LIVE});
    if (a.kind === 'video' && b.kind === 'video') {
      expect(a.remountKey).toBe(b.remountKey);
    }
  });

  it('missing track id still yields a usable key', () => {
    const d = resolveRemoteTile({...LIVE, videoTrackId: null});
    if (d.kind === 'video') {
      expect(d.remountKey).toContain('video-');
    }
  });
});
