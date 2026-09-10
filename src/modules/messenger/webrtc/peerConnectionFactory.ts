/**
 * Real RTCPeerConnection factory using `react-native-webrtc`.
 *
 * The WebRTC stack in this module was designed factory-first so the
 * tests could inject a fake. This file wires the production factory.
 *
 * All native imports live here; the orchestrator (CallController) and
 * everything above it stay dependency-free so unit tests keep running
 * in node-jest without a native module.
 */
import {Platform, PermissionsAndroid} from 'react-native';
import {
  RTCPeerConnection,
  mediaDevices,
  type MediaStream,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import type {PeerConnectionFactory, PeerConnectionLike} from './types';

export const rtcPeerConnectionFactory: PeerConnectionFactory =
  (cfg) => new RTCPeerConnection(cfg) as unknown as PeerConnectionLike;

/**
 * GCV-1 — the single source of truth for LOCAL capture geometry.
 *
 * Why: `@livekit/react-native-webrtc` normalizes a video constraint with no
 * width AND no height to its own 1280x720 default (RTCUtil DEFAULT_VIDEO_CONSTRAINTS),
 * so every re-acquisition that passed `{facingMode}` alone silently re-opened the
 * camera at 16:9 while boot captured 4:3. With objectFit 'cover' that flips the
 * self-tile crop mid-call ("zoomed" self view) and de-tunes the group simulcast ladder.
 */
export function localVideoConstraints(facing: 'user' | 'environment'): {
  facingMode: 'user' | 'environment';
  width:     {ideal: number; max: number};
  height:    {ideal: number; max: number};
  frameRate: {ideal: number; max: number};
} {
  return {
    facingMode: facing,
    width:      {ideal: 640,  max: 1280},
    height:     {ideal: 480,  max: 720},
    frameRate:  {ideal: 30,   max: 30},
  };
}

/**
 * Acquire local audio (always) + video (if requested) tracks. Camera
 * defaults to the front-facing lens — the call UI exposes a flip
 * button that swaps the video track in place.
 */
export async function getLocalMedia(opts: {video: boolean}): Promise<{
  stream: MediaStream;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
}> {
  // Round 7 / WebRTC audit fix W3 — request Android runtime permissions
  // BEFORE calling getUserMedia. Previously the two ran in parallel:
  // mediaDevices.getUserMedia({video:true}) opened the camera while
  // PermissionsAndroid was still showing the prompt. On a first-tap
  // video call this raced — the OS rejected the camera because
  // permission hadn't resolved yet, the call landed in 'failed', and
  // the user had to retry to get past the prompt. Awaiting the prompt
  // up front makes the second-tap-required pattern go away.
  if (Platform.OS === 'android') {
    const need: Array<keyof typeof PermissionsAndroid.PERMISSIONS> = ['RECORD_AUDIO'];
    if (opts.video) {need.push('CAMERA');}
    try {
      const perms = need.map(k => PermissionsAndroid.PERMISSIONS[k]);
      // B-340 — a pending prompt must be VISIBLE in a release log. The await
      // below correctly blocks until the user answers, but every log around it
      // was console.log (stripped in release), so an unanswered dialog on an
      // unattended device read as "accepted the call but never joined the
      // room" — four silent boot attempts across two rooms on 2026-07-30.
      // check() first so an already-granted set stays warn-silent.
      // Fail SAFE: if check() throws (unsupported API), treat everything as
      // pending so the prompt below still runs — Step 2.3 only skips the
      // prompt when check() PROVED every permission is already granted, never
      // when the probe itself failed (else a first-ever call would hit
      // getUserMedia ungranted → the racing "device not available" B-340 error).
      let pending: string[] = perms.map(String);
      try {
        const checks = await Promise.all(perms.map(p => PermissionsAndroid.check(p)));
        pending = perms.filter((_, i) => !checks[i]).map(String);
      } catch { /* check unsupported — pending stays "all", so we prompt */ }
      // Audit Step 2.3 — only PROMPT when something is actually missing. The
      // second and later calls (perms already granted) used to await a
      // no-op `requestMultiple` round-trip on the accept critical path; skip
      // it. The prompt path (first call ever) and its B-340 warns are unchanged.
      if (pending.length > 0) {
        console.warn(`[CALLDIAG] [bravo.callmedia] waiting on permission prompt (${pending.join(', ')}) — media boot is paused until the user answers (B-340)`);
        // requestMultiple resolves AFTER the user has dismissed every dialog,
        // including denials — getUserMedia then surfaces a proper "permission
        // denied" rather than the racing-prompt "device not available" error.
        const res = await PermissionsAndroid.requestMultiple(perms);
        const grantedVal = PermissionsAndroid.RESULTS?.GRANTED ?? 'granted';
        const denied = Object.entries(res ?? {})
          .filter(([, v]) => v !== grantedVal)
          .map(([k]) => k);
        console.warn(denied.length > 0
          ? `[CALLDIAG] [bravo.callmedia] permission prompt answered — denied: ${denied.join(', ')}`
          : '[CALLDIAG] [bravo.callmedia] permission prompt answered — granted');
      }
    } catch {
      // PermissionsAndroid throws on unsupported APIs only; let
      // getUserMedia surface the actual error.
    }
  }

  // Bias the camera toward 480p@30 as the IDEAL, not the floor. Without
  // explicit constraints RN-WebRTC defaults to whatever the camera's
  // top mode is (often 1080p@30 on modern phones) — that pegs the
  // encoder at ~2 Mbps and freezes hard the moment the link drops to
  // 3G speeds. 480p is what WhatsApp/FaceTime ship as the "good cell"
  // baseline; the encoder still down-scales to 240p on bad links via
  // the maintain-framerate policy set in useCall.attachLocalMedia.
  // Tag for logcat: [bravo.callquality].
  const constraints: Record<string, unknown> = {
    // BS-CALL-ECHO (reverted) — use the bare `audio: true` constraint.
    // Why: the detailed object form (echoCancellation:true + a legacy
    // `mandatory: { goog* }` block) was added to force AEC on for the few
    // answerers who opened the mic without it. But mixing the spec-style
    // booleans with the legacy goog `mandatory` object trips a constraint-
    // parse path in react-native-webrtc on many Android builds, which then
    // falls back to opening the mic with NO audio-processing module at all
    // — AEC OFF for EVERYONE. That's the regression where the caller hears
    // their own voice looped back. Plain `audio: true` lets the platform
    // apply its default APM (AEC + NS + AGC), which is what worked before.
    // If the original answerer-no-AEC edge case resurfaces, fix it with the
    // spec booleans ONLY (no `mandatory` goog block), not this mixed shape.
    audio: true,
    video: opts.video ? localVideoConstraints('user') : false,
  };
  // B-342 — bounded acquisition. RN-WebRTC serialises camera opens, so a
  // camera still held by a previous call's teardown queues this call BEHIND
  // it: measured 2026-07-30 as three consecutive accepts silently stalled
  // (one for 36 s) between "transport acquired" and step=2. On timeout the
  // boot fails VISIBLY instead of hanging; a late-resolving stream is
  // stopped so it releases the camera instead of clogging the queue further.
  const MEDIA_ACQUIRE_TIMEOUT_MS = 15_000;
  let timedOut = false;
  const stream = await new Promise<MediaStream>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[CALLDIAG] [bravo.callmedia] getUserMedia did not resolve within ${MEDIA_ACQUIRE_TIMEOUT_MS / 1000}s — camera/mic likely still held by a previous call; failing this boot (B-342)`);
      reject(new Error('local_media_timeout'));
    }, MEDIA_ACQUIRE_TIMEOUT_MS);
    mediaDevices.getUserMedia(constraints).then(
      (s) => {
        if (timedOut) {
          try { (s as MediaStream).getTracks().forEach(t => t.stop()); } catch { /* best-effort release */ }
          return;
        }
        clearTimeout(timer);
        resolve(s as MediaStream);
      },
      (e) => { clearTimeout(timer); if (!timedOut) {reject(e);} },
    );
  });
  const tracks = stream.getTracks();
  const audioTrack = tracks.find(t => t.kind === 'audio') ?? null;
  const videoTrack = tracks.find(t => t.kind === 'video') ?? null;
  console.log(`[bravo.callquality] getLocalMedia video=${opts.video} tracks=${tracks.map(t => t.kind).join(',')}`);
  return {stream, audioTrack, videoTrack};
}

/**
 * Swap the camera in place by stopping the existing video track and
 * acquiring a new one with the opposite facing mode. The new track
 * is added to the same RTCRtpSender so the SDP doesn't have to
 * renegotiate — only the source upstream of the encoder changes.
 *
 * Optional `localStream` parameter: if provided, the helper will
 * remove the previous video track from the stream and add the new one
 * before returning. This keeps any RTCView pinned to that stream
 * showing the live camera instead of the now-stopped previous track.
 * Without it, callers had to rebuild the MediaStream by hand AND set
 * a new state, which was easy to forget and produced the "PiP frozen
 * on last frame" symptom.
 */
export async function flipCamera(args: {
  pc: PeerConnectionLike;
  currentTrack: MediaStreamTrack | null;
  facing: 'user' | 'environment';
  localStream?: MediaStream;
}): Promise<MediaStreamTrack | null> {
  const next = args.facing === 'user' ? 'environment' : 'user';
  const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(next)});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}

  // Replace the sender's track if present — keeps SDP / SRTP untouched.
  const senders = (args.pc as unknown as {getSenders?: () => Array<{track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack) => Promise<void>}>}).getSenders?.() ?? [];
  const videoSender = senders.find(s => s.track?.kind === 'video');
  if (videoSender) {await videoSender.replaceTrack(newTrack);}

  // Splice the new track into the local MediaStream so RTCView
  // attached to that stream picks up the new camera without the
  // caller having to rebuild the stream by hand. Order: add new
  // track first, then stop+remove the old one — minimises the
  // window where the stream has zero video tracks.
  if (args.localStream) {
    try {
      args.localStream.addTrack(newTrack);
      const oldVideo = args.localStream.getVideoTracks().find(t => t.id !== newTrack.id);
      if (oldVideo) { try { args.localStream.removeTrack(oldVideo); } catch { /* ignore */ } }
    } catch { /* RN-WebRTC quirks — fall through to caller-managed stream */ }
  }

  if (args.currentTrack) {try { args.currentTrack.stop(); } catch { /* ignore */ }}
  return newTrack;
}

/**
 * B-20 — re-acquire the camera after another app grabbed it mid-call.
 *
 * When the OS hands the camera to a foreground camera app, our capture
 * track ends or mutes; on return the encoder keeps "sending" null frames
 * (the magenta/black tile) and there is no `onCameraDisconnected` to hook.
 * Same mechanism as `flipCamera` (acquire a fresh track + `replaceTrack`
 * onto the EXISTING video sender, so SDP/SRTP — and any FrameCryptor
 * transform attached to that sender — stay untouched) but KEEPS the
 * current facing instead of flipping it.
 *
 * Returns the new track (caller updates its ref + local PiP stream), or
 * null when there is no video sender (audio-only call) or acquisition
 * fails (e.g. the other app is still holding the camera — the resume
 * handler simply retries on the next foreground).
 */
export async function recoverCamera(args: {
  pc: PeerConnectionLike;
  facing: 'user' | 'environment';
  currentTrack: MediaStreamTrack | null;
  localStream?: MediaStream;
}): Promise<MediaStreamTrack | null> {
  // Only meaningful when a video sender exists. A dead/muted capture
  // track keeps its `kind: 'video'` so the sender is still findable.
  const senders = (args.pc as unknown as {getSenders?: () => Array<{track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack) => Promise<void>}>}).getSenders?.() ?? [];
  const videoSender = senders.find(s => s.track?.kind === 'video');
  if (!videoSender) {return null;}

  const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(args.facing)});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}

  await videoSender.replaceTrack(newTrack);

  if (args.localStream) {
    try {
      args.localStream.addTrack(newTrack);
      const oldVideo = args.localStream.getVideoTracks().find(t => t.id !== newTrack.id);
      if (oldVideo) { try { args.localStream.removeTrack(oldVideo); } catch { /* ignore */ } }
    } catch { /* RN-WebRTC quirks — caller rebuilds the stream from state */ }
  }

  if (args.currentTrack) {try { args.currentTrack.stop(); } catch { /* ignore */ }}
  return newTrack;
}

/**
 * B-20 (group) — re-acquire the camera after another app grabbed it mid
 * group-call. Same intent as `recoverCamera`, but the group path sends
 * through a mediasoup Producer, not a raw RTCRtpSender.
 *
 * `producer.replaceTrack({track})` swaps the source upstream of the
 * encoder while keeping the SAME underlying RTCRtpSender — so the SFrame
 * FrameCryptor transform attached to that sender stays in place and the
 * recovered video remains E2E-encrypted. Do NOT close + recreate the
 * producer here: that path (useGroupCall.toggleVideo's fresh-camera
 * branch) must re-attach the encryptor and risks a plaintext-video window
 * — a security stop-condition.
 *
 * Returns the new track (caller updates its ref + local PiP stream), or
 * null when there is no producer or acquisition fails (e.g. the other app
 * is still holding the camera — the resume handler retries on the next
 * foreground).
 */
export async function recoverGroupCamera(args: {
  producer: {replaceTrack: (a: {track: MediaStreamTrack}) => Promise<void>} | null;
  facing: 'user' | 'environment';
  currentTrack: MediaStreamTrack | null;
}): Promise<MediaStreamTrack | null> {
  if (!args.producer) {return null;}
  const fresh = await mediaDevices.getUserMedia({audio: false, video: localVideoConstraints(args.facing)});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}
  // Keeps the same RTCRtpSender → same SFrame transform → still encrypted.
  //
  // B-123 — do NOT stop args.currentTrack here. mediasoup's replaceTrack
  // already destroys the previous track: Producer.replaceTrack() calls
  // destroyTrack(), which calls track.stop() because produce() defaults
  // stopTracks:true (mediasoup-client Producer.js). Stopping it a second
  // time tore down capture state the just-opened camera depends on, and
  // BOTH cameras closed — logcat showed two "CameraCapturer: Stop capture"
  // then "Camera device closed" for camera 1 AND camera 0, after which the
  // producer sent zero bytes (trace: dec:0/rx:0/B:0).
  //
  // It was invisible on the B-20 resume path this helper was written for,
  // because there the old track is already ended and the second stop is a
  // no-op. It only bites when the old track is LIVE — i.e. a camera flip.
  //
  // NOTE the contrast with flipCamera() above: that one replaces on a RAW
  // RTCRtpSender, which does NOT stop the old track, so its stop() is
  // required. Only the mediasoup-producer path double-stops.
  await args.producer.replaceTrack({track: newTrack});
  // Safety net, NOT the normal path: if the caller passed a track the producer
  // was not actually holding, mediasoup stopped a different one and this would
  // leak a camera. track.stop() sets readyState synchronously, so a still-live
  // track here proves mediasoup did not own it.
  if (
    args.currentTrack
    && args.currentTrack !== newTrack
    && args.currentTrack.readyState !== 'ended'
  ) {
    try { args.currentTrack.stop(); } catch { /* ignore */ }
  }
  return newTrack;
}

export type {MediaStream, MediaStreamTrack} from 'react-native-webrtc';
export {RTCView} from 'react-native-webrtc';
