/**
 * B-09 — pure derivation of the step=2 video-acquisition flag from the
 * call type. A video group call must acquire a video TRACK at boot (so
 * the local camera is live the instant we join), not boot audio-only and
 * rely on a deferred toggleVideo().
 *
 * Why a standalone helper: useGroupCall.ts transitively imports
 * react-native-webrtc, so it isn't importable from the node-environment
 * messenger-crypto test project. Extracting the one decision that gates
 * the track keeps it unit-testable and gives a regression guard against
 * anyone hardcoding `video:false` at step=2 (the "video=false at step=2
 * across all 3 devices" symptom).
 *
 * The video track is only PRODUCED at step=8, after the SFrame group
 * encryptor is ready (step=3b) — acquiring the track here never exposes
 * plaintext video on the wire.
 */
export function isVideoForCall(callType: 'voice' | 'video'): boolean {
  return callType === 'video';
}
