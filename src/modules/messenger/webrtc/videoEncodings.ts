import {Platform} from 'react-native';

/**
 * Video send encodings for the group-call (SFU) producer.
 *
 * Android keeps 3-layer simulcast: the SFU drops to a lower layer per
 * receiver when a downlink tanks, so one slow viewer can't freeze the call.
 *
 * iOS sends a SINGLE encoding — B-121. Symptom: an iPhone's video tile showed
 * "Video unavailable" on Android while its AUDIO decoded fine, and the reverse
 * direction (Android -> iOS video) worked.
 *
 * WHAT IS ESTABLISHED: dropping iOS to one encoding fixes it. Verified on
 * device 2026-07-19 (iPhone 11 -> Pixel 7a, staging) as a single-variable
 * change — the identical build with 3-layer simulcast failed, this one works.
 *
 * WHAT IS NOT: *why*. The plausible mechanism is that with simulcast the
 * RtpSender carries three SSRCs while the FrameCryptor attaches per-sender, so
 * some layers reach the peer undecryptable — but that was never observed, only
 * inferred, and BravoFrameCryptor.swift attaches one cryptor per sender in a
 * way that may well cover every layer. A codec-specific cause (H264 header
 * parsing on the iOS encode path) fits the same evidence. Do not repeat the
 * mechanism above as fact; it is a hypothesis.
 *
 * Cost on iOS: no per-receiver layer adaptation — every viewer gets the one
 * stream, so a slow viewer can't be served a cheaper layer. Correct video
 * beats adaptive-but-undecodable video, but this is a real regression worth
 * reversing once the mechanism is pinned down. To diagnose, build with
 * EXPO_PUBLIC_GROUPCALL_FILELOG=1 and read the [bravo.groupcall.decode]
 * dec/rx/B counters out of the trace file: B:0 means nothing was forwarded,
 * while B>0 with dec:0 means it arrived and would not decode.
 */
export const VIDEO_ENCODINGS = Platform.OS === 'ios'
  ? [{maxBitrate: 700_000, maxFramerate: 30}]
  : [
      {rid: 'r0', maxBitrate:  150_000, scaleResolutionDownBy: 4, maxFramerate: 15},
      {rid: 'r1', maxBitrate:  500_000, scaleResolutionDownBy: 2, maxFramerate: 24},
      {rid: 'r2', maxBitrate: 1_200_000,                          maxFramerate: 30},
    ];

/**
 * Fresh copy per producer.
 *
 * Why: mediasoup-client mutates the array it is handed — ReactNative106
 * `send()` assigns `encoding.rid = rN` when length > 1 — and it is passed
 * straight into `addTransceiver({sendEncodings})`. Today that write is
 * idempotent (it re-assigns the r0/r1/r2 already declared below) so sharing
 * one module-level array across every call is harmless, but it makes
 * process-wide state depend on a guard inside a third-party lib. Handing out
 * a copy keeps a mutation confined to the producer that caused it.
 *
 * Not Object.freeze(): the Android path REQUIRES that rid write to succeed,
 * so freezing would throw in strict mode rather than protect anything.
 */
export function videoEncodings(): Array<Record<string, unknown>> {
  return VIDEO_ENCODINGS.map(e => ({...e}));
}
