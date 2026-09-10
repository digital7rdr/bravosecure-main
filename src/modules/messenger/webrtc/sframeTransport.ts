/**
 * SFrame transport for mediasoup-client producers + consumers.
 *
 * Wires the platform-agnostic `GroupCallEncryption` orchestrator into
 * libwebrtc's encoded-frame pipeline. Each local producer's outbound
 * frames are intercepted, run through `SframeSender.encryptFrame`, and
 * replaced with the SFrame envelope BEFORE libwebrtc hands them to the
 * SRTP layer. Each remote consumer's inbound frames are decrypted via
 * `SframeReceiver.decryptFrame` AFTER libwebrtc strips SRTP.
 *
 * Capability detection
 * --------------------
 * Two paths exist in the wild:
 *   1. `RTCRtpScriptTransform` (W3C spec, Safari + Firefox).
 *   2. `createEncodedStreams()` legacy method on the sender/receiver
 *      (Chromium / older RN-WebRTC patches).
 *
 * We probe for both at runtime; if neither is available we return
 * `null` from `attach*` and the caller MUST refuse to start the call.
 * There is no silent fallback: the security promise of the group call
 * is that the SFU cannot see plaintext media, and a build without
 * encoded transforms cannot keep that promise.
 *
 * Native (react-native-webrtc) status
 * -----------------------------------
 * The stock react-native-webrtc 124.x DOES NOT expose either API. The
 * patch-package + native module addition that wires
 * `RtpSenderInterface::SetEncoderToPacketizerFrameTransformer` and
 * `RtpReceiverInterface::SetDepacketizerToDecoderFrameTransformer`
 * through to JS is the open native task (see
 * `packages/messenger-core/src/calls/sframe.ts` header for protocol
 * details and `android/app/src/main/java/com/bravosecure/app/Sframe*`
 * for the bridge skeleton).
 *
 * Until the native bridge lands on a platform, `isAvailable()` returns
 * false on that platform and useGroupCall refuses to start.
 */

import type {SframeReceiver, SframeSender} from '@bravo/messenger-core';

/** Stand-in for the encoded frame the transform receives. */
interface EncodedFrameLike {
  data:      ArrayBuffer;
  timestamp?: number;
  type?:     'key' | 'delta';
}

/** Stand-in for the readable/writable transform pair. */
interface EncodedTransformStreams {
  readable: ReadableStream<EncodedFrameLike>;
  writable: WritableStream<EncodedFrameLike>;
}

interface MaybeTransformableSender {
  transform?: unknown;
  createEncodedStreams?: () => EncodedTransformStreams;
}
interface MaybeTransformableReceiver {
  transform?: unknown;
  createEncodedStreams?: () => EncodedTransformStreams;
}

/**
 * Returns true iff the running JS engine + WebRTC stack supports
 * frame transforms. The caller MUST treat false as "refuse to start
 * an unencrypted group call".
 */
export function encodedTransformsAvailable(): boolean {
  // RTCRtpScriptTransform (W3C, spec'd).
  const hasScriptTransform =
    typeof (globalThis as {RTCRtpScriptTransform?: unknown}).RTCRtpScriptTransform === 'function';
  if (hasScriptTransform) {return true;}

  // Legacy createEncodedStreams() — Chromium-only API. We probe by
  // looking for the method on a fresh RTCPeerConnection's
  // transceiver. Most native runtimes won't expose this; we only
  // accept it as a positive signal.
  const PC = (globalThis as {RTCPeerConnection?: unknown}).RTCPeerConnection as
    | (new () => unknown)
    | undefined;
  if (!PC) {return false;}
  try {
    const pc = new PC() as {
      addTransceiver?: (kind: string) => {sender?: MaybeTransformableSender};
      close?: () => void;
    };
    const tx = pc.addTransceiver?.('audio');
    const hasEncodedStreams =
      typeof tx?.sender?.createEncodedStreams === 'function';
    try {pc.close?.();} catch { /* ignore */ }
    return hasEncodedStreams;
  } catch {
    return false;
  }
}

/**
 * Pipe the local producer's RTPSender through an SFrame encrypt
 * transform. Returns a teardown fn the caller invokes on producer
 * close. Throws if the platform doesn't expose either transform API
 * — caller treats throw as "refuse to send unencrypted".
 */
export async function attachSframeToSender(
  sender:   MaybeTransformableSender,
  sframe:   SframeSender,
): Promise<() => void> {
  if (typeof sender.createEncodedStreams !== 'function') {
    throw new Error(
      'sframeTransport: this RTCRtpSender does not expose createEncodedStreams — refusing to send plaintext media',
    );
  }
  const {readable, writable} = sender.createEncodedStreams();
  const abort = new AbortController();
  const piped = readable
    .pipeThrough(
      new TransformStream<EncodedFrameLike, EncodedFrameLike>({
        async transform(frame, controller) {
          const ct = await sframe.encryptFrame(new Uint8Array(frame.data));
          // We replace `data` in-place — the timestamp/type metadata
          // is passed through unchanged because the SFU reads them
          // from the unencrypted RTP header, not the payload.
          controller.enqueue({
            ...frame,
            data: ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer,
          });
        },
      }),
      {signal: abort.signal},
    )
    .pipeTo(writable, {signal: abort.signal})
    .catch((err: Error) => {
      if (err.name !== 'AbortError') {
        console.warn('[sframeTransport] sender pipe ended:', err.message);
      }
    });
  void piped; // keep linter happy; the promise is the long-lived pipe
  return () => abort.abort();
}

/**
 * Pipe the remote consumer's RTPReceiver through an SFrame decrypt
 * transform. Returns a teardown fn. Throws on missing platform support
 * (same refusal contract as the sender path).
 */
export async function attachSframeToReceiver(
  receiver: MaybeTransformableReceiver,
  sframe:   SframeReceiver,
): Promise<() => void> {
  if (typeof receiver.createEncodedStreams !== 'function') {
    throw new Error(
      'sframeTransport: this RTCRtpReceiver does not expose createEncodedStreams — refusing to render plaintext media',
    );
  }
  const {readable, writable} = receiver.createEncodedStreams();
  const abort = new AbortController();
  const piped = readable
    .pipeThrough(
      new TransformStream<EncodedFrameLike, EncodedFrameLike>({
        async transform(frame, controller) {
          try {
            const pt = await sframe.decryptFrame(new Uint8Array(frame.data));
            controller.enqueue({
              ...frame,
              data: pt.buffer.slice(pt.byteOffset, pt.byteOffset + pt.byteLength) as ArrayBuffer,
            });
          } catch (e) {
            // Drop tampered / replayed frames silently. The decoder
            // will surface the gap as a freeze, which is the correct
            // observable behaviour — we MUST NOT pass plaintext-or-
            // garbage downstream because the SFU or an attacker
            // could inject crafted payloads here.
            console.warn('[sframeTransport] recv drop:', (e as Error).message);
          }
        },
      }),
      {signal: abort.signal},
    )
    .pipeTo(writable, {signal: abort.signal})
    .catch((err: Error) => {
      if (err.name !== 'AbortError') {
        console.warn('[sframeTransport] receiver pipe ended:', err.message);
      }
    });
  void piped;
  return () => abort.abort();
}
