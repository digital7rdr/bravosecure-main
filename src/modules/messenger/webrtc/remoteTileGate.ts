/**
 * O-E / O-F (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the 1:1 remote-tile
 * mount decision, extracted to a pure function so CallScreen and
 * FloatingCallOverlay render the SAME truth and the four states are
 * unit-testable.
 *
 * Why: the CALL-N2 gate (placeholder / avatar / video / nothing) was
 * fixed inline in CallScreen but never applied to the minimized overlay,
 * which kept rendering a black card whenever the peer was audio-only or
 * camera-off. And the remount key only flipped on the audio↔video
 * boolean (B-16's second half was never done), so a REPLACED remote
 * video track with an unchanged stream id kept the same key and the
 * native SurfaceView never rebound.
 *
 * Decision order matters and mirrors CallScreen's audited gate:
 *   1. `remoteVideoOff` (an explicit peer advisory) wins — placeholder.
 *   2. no live remote video track → avatar (when audio is flowing) or
 *      nothing (still ringing / no stream / dead handle).
 *   3. live video + valid URL → mount, keyed by the TRACK id.
 */

export type RemoteTileDecision =
  | {kind: 'camera-off'}
  | {kind: 'avatar'}
  | {kind: 'none'}
  | {kind: 'video'; streamURL: string; remountKey: string};

export function resolveRemoteTile(args: {
  remoteVideoOff:  boolean;
  remoteHasVideo:  boolean;
  hasRemoteStream: boolean;
  streamURL:       string | null;
  /** Remote video track id — drives the O-F remount key. */
  videoTrackId?:   string | null;
}): RemoteTileDecision {
  if (args.remoteVideoOff) {return {kind: 'camera-off'};}
  if (!args.remoteHasVideo) {
    return args.hasRemoteStream ? {kind: 'avatar'} : {kind: 'none'};
  }
  if (!args.streamURL) {return {kind: 'none'};}
  return {
    kind: 'video',
    streamURL: args.streamURL,
    // O-F (B-16 second half) — key by the remote video TRACK id, not
    // just the audio↔video boolean: a replaced track with an unchanged
    // stream id keeps the same streamURL, and without a key change the
    // SurfaceView keeps rendering the dead track (black).
    remountKey: `video-${args.videoTrackId ?? 'track'}`,
  };
}
