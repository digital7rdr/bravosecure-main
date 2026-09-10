/**
 * Mirrors two group-call camera decisions:
 *
 * 1. GroupCallScreen's `cameraOn` — the self-preview/button must key on
 *    the LIVE local video track, not the static `callType` route param.
 *    An audio call upgraded mid-call has a video track while callType
 *    stays 'voice'; the old `isVideo && !isVideoOff` gate hid the
 *    user's own preview even though peers received the video.
 *
 * 2. useGroupCall.toggleVideo's producer pause/resume — disabling the
 *    track alone leaves peers staring at the last decoded frame;
 *    pausing the producer stops RTP so their 'mute' listener swaps in
 *    the avatar placeholder.
 */

import {
  cameraOn, shouldMirrorTile, applyProducerPaused, applyProducerPausedFrame,
} from '../webrtc/groupCallLayout';
import {
  RING_CHANNEL_VIBRATION, RING_NOTIF_VIBRATION, isValidNotifeeVibration,
} from '../push/callVibration';

type CallType = 'voice' | 'video';

// The pre-fix gate, kept as documentation of the bug: GroupCallScreen
// keyed the self-preview on the static callType route param.
function legacyGate(callType: CallType, isVideoOff: boolean): boolean {
  return callType === 'video' && !isVideoOff;
}

interface ProducerSim { kind: string; closed: boolean; paused: boolean }
function applyToggle(producers: ProducerSim[], trackNowEnabled: boolean): void {
  const vp = producers.find(p => p.kind === 'video' && !p.closed);
  if (!vp) {return;}
  vp.paused = !trackNowEnabled;
}

describe('group call camera toggle', () => {
  it('audio call upgraded mid-call shows the self preview (the reported bug)', () => {
    // callType stays 'voice' after the upgrade — old gate hid the preview:
    expect(legacyGate('voice', false)).toBe(false);
    // live gate keys on the actual track:
    expect(cameraOn(false, 1)).toBe(true);
  });

  it('camera off hides the self preview regardless of call type', () => {
    expect(cameraOn(true, 1)).toBe(false);
    expect(cameraOn(true, 0)).toBe(false);
  });

  it('no local video track means no preview even when isVideoOff=false', () => {
    expect(cameraOn(false, 0)).toBe(false);
  });

  it('disabling the track pauses the live video producer (stops RTP for peers)', () => {
    const producers: ProducerSim[] = [
      {kind: 'audio', closed: false, paused: false},
      {kind: 'video', closed: false, paused: false},
    ];
    applyToggle(producers, false);
    expect(producers[1].paused).toBe(true);
    expect(producers[0].paused).toBe(false);
  });

  it('re-enabling the track resumes the producer', () => {
    const producers: ProducerSim[] = [{kind: 'video', closed: false, paused: true}];
    applyToggle(producers, true);
    expect(producers[0].paused).toBe(false);
  });

  it('a closed video producer is never touched', () => {
    const producers: ProducerSim[] = [{kind: 'video', closed: true, paused: false}];
    applyToggle(producers, false);
    expect(producers[0].paused).toBe(false);
  });
});

// Authoritative pause application — the sfu.producer-paused/-resumed
// push handler and the reconcile snapshot sync both route through
// applyProducerPaused so a missed frame self-heals on the next tick.
describe('applyProducerPaused', () => {
  const tiles = [
    {producerId: 'p1', paused: false},
    {producerId: 'p2', paused: false},
  ];

  it('pauses only the matching producer', () => {
    const next = applyProducerPaused(tiles, 'p1', true);
    expect(next[0].paused).toBe(true);
    expect(next[1].paused).toBe(false);
  });

  it('returns the SAME array reference when nothing changes (no wasted render)', () => {
    expect(applyProducerPaused(tiles, 'p1', false)).toBe(tiles);
    expect(applyProducerPaused(tiles, 'unknown', true)).toBe(tiles);
  });

  it('resumes a paused tile', () => {
    const paused = [{producerId: 'p1', paused: true}];
    expect(applyProducerPaused(paused, 'p1', false)[0].paused).toBe(false);
  });

  it('treats an absent paused flag as unpaused', () => {
    const bare = [{producerId: 'p1'}];
    expect(applyProducerPaused(bare, 'p1', false)).toBe(bare);
    expect(applyProducerPaused(bare, 'p1', true)[0].paused).toBe(true);
  });
});

// applyProducerPausedFrame — the pause/resume push handler routes here.
// Producer-id match is primary; the (participantTag, kind) fallback is the
// device-verified fix for a freeze where the broadcast producerId didn't
// match the consumed tile's id, so the camera-off flip was silently dropped
// and the peer tile stayed frozen on its last decoded frame.
describe('applyProducerPausedFrame (pid-primary, tag-fallback)', () => {
  const tiles = [
    {producerId: 'pAudio', participantTag: 'alice', kind: 'audio' as const, paused: false},
    {producerId: 'pVideo', participantTag: 'alice', kind: 'video' as const, paused: false},
    {producerId: 'pBob',   participantTag: 'bob',   kind: 'video' as const, paused: false},
  ];

  it('matches by producerId when it lines up', () => {
    const {tiles: next, matchedBy} = applyProducerPausedFrame(
      tiles, {producerId: 'pVideo', participantTag: 'alice', kind: 'video'}, true);
    expect(matchedBy).toBe('pid');
    expect(next.find(t => t.producerId === 'pVideo')?.paused).toBe(true);
    expect(next.find(t => t.producerId === 'pBob')?.paused).toBe(false);
  });

  it('falls back to (participantTag, kind) when the producerId has drifted', () => {
    // Server broadcasts a producerId the consumer never stored (re-produce /
    // simulcast / reconnect) — pid match misses, tag match saves the flip.
    const {tiles: next, matchedBy} = applyProducerPausedFrame(
      tiles, {producerId: 'STALE-ID', participantTag: 'alice', kind: 'video'}, true);
    expect(matchedBy).toBe('tag');
    expect(next.find(t => t.producerId === 'pVideo')?.paused).toBe(true);
    // The fallback must not touch alice's AUDIO tile or bob's video.
    expect(next.find(t => t.producerId === 'pAudio')?.paused).toBe(false);
    expect(next.find(t => t.producerId === 'pBob')?.paused).toBe(false);
  });

  it('returns the same reference + none when neither id nor (tag,kind) match', () => {
    const r = applyProducerPausedFrame(
      tiles, {producerId: 'STALE-ID', participantTag: 'nobody', kind: 'video'}, true);
    expect(r.matchedBy).toBe('none');
    expect(r.tiles).toBe(tiles);
  });

  it('is idempotent — re-pausing an already-paused tile is a no-op', () => {
    const paused = [{producerId: 'pVideo', participantTag: 'alice', kind: 'video' as const, paused: true}];
    const r = applyProducerPausedFrame(paused, {producerId: 'pVideo', participantTag: 'alice', kind: 'video'}, true);
    expect(r.matchedBy).toBe('none');
    expect(r.tiles).toBe(paused);
  });

  it('resume via tag fallback clears the paused flag', () => {
    const paused = [{producerId: 'pVideo', participantTag: 'alice', kind: 'video' as const, paused: true}];
    const {tiles: next, matchedBy} = applyProducerPausedFrame(
      paused, {producerId: 'STALE-ID', participantTag: 'alice', kind: 'video'}, false);
    expect(matchedBy).toBe('tag');
    expect(next[0].paused).toBe(false);
  });
});

// B-27 — the ring channel/notification vibration patterns must satisfy
// notifee's validation (even count, every value strictly positive) or
// createChannel/displayNotification THROW and the phone never rings.
describe('incoming-call vibration patterns (B-27)', () => {
  it('channel pattern is valid for notifee', () => {
    expect(isValidNotifeeVibration(RING_CHANNEL_VIBRATION)).toBe(true);
  });

  it('display pattern is valid for notifee', () => {
    expect(isValidNotifeeVibration(RING_NOTIF_VIBRATION)).toBe(true);
  });

  it('the old leading-zero patterns are correctly classified invalid (the bug)', () => {
    expect(isValidNotifeeVibration([0, 800, 1200, 800])).toBe(false);
    expect(isValidNotifeeVibration([0, 1000, 500, 1000, 500, 1000])).toBe(false);
    expect(isValidNotifeeVibration([300, 800, 1200])).toBe(false); // odd count
  });
});

// Mirrors the framesDecoded freeze watchdog in useGroupCall's stats poll:
// no progress for 3 ticks after frames have flowed → paused; progress
// again → live. Never fires before the first decoded frame (that window
// belongs to the keyframe path, not the freeze path).
interface WatchSim { frames: number; stale: number; everDecoded: boolean }
function watchTick(w: WatchSim, frames: number): {w: WatchSim; flip: boolean | null} {
  if (frames > w.frames) {
    const flip = w.stale >= 3 && w.everDecoded ? false : null;
    return {w: {frames, stale: 0, everDecoded: frames > 0}, flip};
  }
  const stale = w.stale + 1;
  const flip = stale === 3 && w.everDecoded ? true : null;
  return {w: {frames: w.frames, stale, everDecoded: w.everDecoded}, flip};
}

// Mirrors GroupCallScreen's camera-driven speaker auto-follow: video on →
// loudspeaker (only when the user hasn't explicitly picked a route);
// video off → undo ONLY our own auto-switch, never the user's choice.
type Route = 'EARPIECE' | 'SPEAKER_PHONE' | 'BLUETOOTH';
interface RouteSim { route: Route; userPick: Route | null; autoSpeaker: boolean }
function onCameraTransition(sim: RouteSim, cameraNowOn: boolean, isVideoStart: boolean): RouteSim {
  if (isVideoStart) {return sim;}
  if (cameraNowOn) {
    if (!sim.userPick && sim.route === 'EARPIECE') {
      return {...sim, route: 'SPEAKER_PHONE', autoSpeaker: true};
    }
    return sim;
  }
  if (sim.autoSpeaker && !sim.userPick) {
    return {...sim, route: 'EARPIECE', autoSpeaker: false};
  }
  return sim;
}

describe('camera-driven speaker auto-follow', () => {
  it('audio call, default earpiece: camera on → loudspeaker, camera off → earpiece', () => {
    let s: RouteSim = {route: 'EARPIECE', userPick: null, autoSpeaker: false};
    s = onCameraTransition(s, true, false);
    expect(s.route).toBe('SPEAKER_PHONE');
    s = onCameraTransition(s, false, false);
    expect(s.route).toBe('EARPIECE');
  });

  it('user enabled speaker during audio: camera on is a no-op, camera off KEEPS the speaker', () => {
    let s: RouteSim = {route: 'SPEAKER_PHONE', userPick: 'SPEAKER_PHONE', autoSpeaker: false};
    s = onCameraTransition(s, true, false);
    expect(s.route).toBe('SPEAKER_PHONE');
    s = onCameraTransition(s, false, false);
    expect(s.route).toBe('SPEAKER_PHONE'); // the user chose it — stays
  });

  it('user on bluetooth: camera transitions never touch the route', () => {
    let s: RouteSim = {route: 'BLUETOOTH', userPick: 'BLUETOOTH', autoSpeaker: false};
    s = onCameraTransition(s, true, false);
    expect(s.route).toBe('BLUETOOTH');
    s = onCameraTransition(s, false, false);
    expect(s.route).toBe('BLUETOOTH');
  });

  it('video-started call: no auto behaviour at all', () => {
    let s: RouteSim = {route: 'SPEAKER_PHONE', userPick: null, autoSpeaker: false};
    s = onCameraTransition(s, false, true);
    expect(s.route).toBe('SPEAKER_PHONE');
  });
});

describe('video freeze watchdog', () => {
  it('flips to paused after 3 stale ticks once frames have flowed', () => {
    let s: WatchSim = {frames: -1, stale: 0, everDecoded: false};
    let r = watchTick(s, 10); s = r.w;          // frames flowing
    r = watchTick(s, 25); s = r.w;
    r = watchTick(s, 25); s = r.w; expect(r.flip).toBeNull();   // stale 1
    r = watchTick(s, 25); s = r.w; expect(r.flip).toBeNull();   // stale 2
    r = watchTick(s, 25); expect(r.flip).toBe(true);            // stale 3 → paused
  });

  it('flips back to live when frames resume', () => {
    let s: WatchSim = {frames: 25, stale: 4, everDecoded: true};
    const r = watchTick(s, 26);
    expect(r.flip).toBe(false); // unpause
  });

  it('never fires before the first decoded frame (keyframe wait is not a freeze)', () => {
    let s: WatchSim = {frames: -1, stale: 0, everDecoded: false};
    let r = watchTick(s, 0); s = r.w;
    for (let i = 0; i < 6; i++) { r = watchTick(s, 0); s = r.w; expect(r.flip).toBeNull(); }
  });
});

describe('GCV-4 — self-tile selfie mirror follows the lens', () => {
  it('mirrors the self tile on the front lens', () => {
    expect(shouldMirrorTile(true, true)).toBe(true);
  });

  it('does NOT mirror the self tile after flipping to the rear lens (the reported bug)', () => {
    // Pre-fix GroupCallScreen used `mirror={isSelf}` — true regardless of lens.
    expect(shouldMirrorTile(true, false)).toBe(false);
  });

  it('never mirrors a remote tile, on either lens', () => {
    expect(shouldMirrorTile(false, true)).toBe(false);
    expect(shouldMirrorTile(false, false)).toBe(false);
  });
});
