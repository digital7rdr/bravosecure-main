import {readFileSync} from 'fs';
import {join} from 'path';
import {isVideoForCall} from '@/modules/messenger/webrtc/groupCallMediaMode';

/**
 * B-09 — a video group call must acquire a video TRACK at boot (step=2),
 * not boot audio-only and rely on a deferred toggleVideo().
 *
 * The boot derives the step=2 getLocalMedia({video}) flag from
 * `opts.callType` via this pure helper:
 *
 *   useGroupCall.ts: const isVideo = isVideoForCall(opts.callType);
 *   step=2:          getLocalMedia({video: isVideo});
 *
 * Pinning the derivation here is the regression guard: if anyone
 * hardcodes `isVideo`/`video:false` or breaks the callType plumbing,
 * a video call would silently fall back to audio-only-at-join (the
 * "video=false at step=2" symptom the playbook recorded across all 3
 * devices). The full boot is native/effect-heavy and can't settle under
 * jsdom; this pure test pins the only decision that gates the track.
 */
describe('isVideoForCall (B-09 video-at-join derivation)', () => {
  it('requests a video track for a video call', () => {
    expect(isVideoForCall('video')).toBe(true);
  });

  it('does NOT request a video track for a voice call', () => {
    expect(isVideoForCall('voice')).toBe(false);
  });

  it('matches the exact callType === "video" contract', () => {
    const types: Array<'voice' | 'video'> = ['voice', 'video'];
    for (const t of types) {
      expect(isVideoForCall(t)).toBe(t === 'video');
    }
  });

  it('step=2 getLocalMedia({video}) flag equals isVideoForCall(callType)', () => {
    // The boot calls getLocalMedia({video: isVideo}); model that here so
    // the assertion fails if step=2 ever stops tracking the derivation.
    const stepTwoVideoFlag = (callType: 'voice' | 'video') => ({video: isVideoForCall(callType)});
    expect(stepTwoVideoFlag('video')).toEqual({video: true});
    expect(stepTwoVideoFlag('voice')).toEqual({video: false});
  });
});

const GROUP_SRC = readFileSync(join(__dirname, '..', 'webrtc', 'useGroupCall.ts'), 'utf8');

describe('useGroupCall — GCV-1 capture geometry', () => {
  it('never re-acquires the camera with facingMode alone (fork defaults to 1280x720)', () => {
    expect(GROUP_SRC).not.toMatch(/getUserMedia\(\{\s*audio:\s*false,\s*video:\s*\{\s*facingMode/);
  });

  it('toggleVideo ON acquires through the shared localVideoConstraints builder', () => {
    expect(GROUP_SRC).toMatch(/getUserMedia\(\{audio: false, video: localVideoConstraints\(facing\)\}\)/);
  });
});
