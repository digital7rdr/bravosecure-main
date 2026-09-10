/**
 * frameCryptorTransport — JS bridge to libwebrtc's FrameCryptor.
 *
 * Replaces the earlier sframeTransport.ts (deleted) which piped each
 * encoded frame through TransformStream + RTCRtpScriptTransform. That
 * approach required the createEncodedStreams API which Jitsi 124.x
 * doesn't expose; this layer instead runs the cipher inside libwebrtc
 * via the FrameCryptor classes that ship with
 * io.getstream:stream-webrtc-android (see
 * docs/ARCHITECTURE_AMENDMENT_SFRAME.md for the architecture
 * amendment that mandates frame-level E2E on top of SRTP).
 *
 * Threat model
 * ------------
 * Group calls route via a mediasoup SFU. DTLS-SRTP terminates at the
 * SFU, so the server holds SRTP keys. FrameCryptor adds AES-256-GCM
 * BEFORE SRTP and AFTER decoding: the SFU only ever sees
 * frame-ciphertext-inside-SRTP-ciphertext. Keys come from the group
 * master key (already distributed via pairwise Signal sessions per
 * CLAUDE.md) and never leave the device.
 *
 * Surface
 * -------
 *   isAvailable()                             → patches applied & lib usable
 *   createKeyProvider()                       → opaque providerId
 *   setKey(providerId, pid, idx, keyB64)      → push key for participant
 *   attachSender(providerId, sender, pid)     → cryptorId (encrypt path)
 *   attachReceiver(providerId, recv, pid)     → cryptorId (decrypt path)
 *   setCryptorEnabled(cryptorId, on)
 *   setCryptorKeyIndex(cryptorId, idx)
 *   disposeCryptor(cryptorId)
 *   disposeKeyProvider(providerId)
 *
 * Refusal contract: every call MUST be configured for E2E. If
 * `isAvailable()` returns false the caller (useGroupCall) refuses to
 * start the call. No silent fallback to plaintext-on-SFU.
 */

import {NativeModules, Platform} from 'react-native';

// ---------------------------------------------------------------
// Native module typing — the Kotlin side is BravoFrameCryptor (see
// android/app/src/main/java/com/bravosecure/app/BravoFrameCryptorModule.kt).
// iOS is not implemented in this round; on iOS isAvailable() returns false
// and useGroupCall refuses, exactly the same as if the patch isn't applied.
// ---------------------------------------------------------------
interface BravoFrameCryptorNative {
  isAvailable(): boolean;
  createKeyProvider(ratchetWindowSize: number, failureTolerance: number, keyRingSize: number): Promise<string>;
  setKey(keyProviderId: string, participantId: string, index: number, keyBase64: string): Promise<boolean>;
  ratchetKey(keyProviderId: string, participantId: string, index: number): Promise<string | null>;
  attachSenderCryptor(keyProviderId: string, peerConnectionId: number, senderId: string, participantId: string): Promise<string>;
  attachReceiverCryptor(keyProviderId: string, peerConnectionId: number, receiverId: string, participantId: string): Promise<string>;
  setCryptorEnabled(cryptorId: string, enabled: boolean): Promise<void>;
  setCryptorKeyIndex(cryptorId: string, index: number): Promise<void>;
  disposeCryptor(cryptorId: string): Promise<void>;
  disposeKeyProvider(keyProviderId: string): Promise<void>;
}

const Native = (NativeModules as {BravoFrameCryptor?: BravoFrameCryptorNative}).BravoFrameCryptor;

/**
 * True iff the native FrameCryptor module is present AND its runtime class
 * probe passes. B-111-B: the old `Platform.OS !== 'android'` short-circuit
 * is gone — iOS now ships BravoFrameCryptor.swift (via
 * plugins/withBravoFrameCryptor + the @livekit/react-native-webrtc alias).
 * FAIL-CLOSED is unchanged: a missing module, a build without the
 * framework, or a false probe all return false here, and useGroupCall's S6
 * kill site + the B-111-A entry gates refuse the call exactly as before.
 */
export function isAvailable(): boolean {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {return false;}
  if (!Native) {return false;}
  try {
    return Native.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Defaults for the per-call key provider. Conservative knobs:
 *  - ratchetWindowSize 8  — how many ratchet steps a stale receiver will
 *    try before giving up; large enough to absorb a couple of admin
 *    rotations the receiver might have missed, small enough that a
 *    malicious peer can't trick us into ratcheting unboundedly.
 *  - failureTolerance -1 — never auto-disable on consecutive failures.
 *    We surface the failures via the call UI rather than silently
 *    drop into plaintext mode.
 *  - keyRingSize 16        — number of past indices kept addressable so
 *    in-flight frames at the moment of rekey still decrypt.
 */
const RATCHET_WINDOW_SIZE = 8;
const FAILURE_TOLERANCE   = -1;
const KEY_RING_SIZE       = 16;

export async function createKeyProvider(): Promise<string> {
  ensureAvailable();
  return Native!.createKeyProvider(RATCHET_WINDOW_SIZE, FAILURE_TOLERANCE, KEY_RING_SIZE);
}

export async function setKey(
  keyProviderId: string,
  participantId: string,
  index:         number,
  keyBase64:     string,
): Promise<boolean> {
  ensureAvailable();
  return Native!.setKey(keyProviderId, participantId, index, keyBase64);
}

/**
 * Attach an encrypt cryptor to the local RtpSender of a mediasoup
 * Producer. Resolves with a cryptor id used by setEnabled / setKeyIndex
 * / dispose. Throws if isAvailable() is false (caller MUST treat as
 * "refuse to start unencrypted").
 *
 * `sender` is the underlying rn-webrtc RTCRtpSender exposed by
 * mediasoup-client as `producer.rtpSender`. We extract its `id` and the
 * containing PC's `_pcId` (rn-webrtc-private numeric id) and hand both
 * to the native module so it can resolve the Java RtpSender via our
 * patch-package accessors on WebRTCModule.
 *
 * `peerConnectionId` is the rn-webrtc-private numeric handle for the
 * mediasoup transport's underlying RTCPeerConnection. We accept it as
 * an explicit parameter rather than re-deriving from `sender` because
 * mediasoup-client doesn't surface a back-ref from rtpSender→pc.
 */
export async function attachSender(
  keyProviderId: string,
  sender: {id: string},
  peerConnectionId: number,
  participantId: string,
): Promise<string> {
  ensureAvailable();
  return Native!.attachSenderCryptor(keyProviderId, peerConnectionId, sender.id, participantId);
}

export async function attachReceiver(
  keyProviderId: string,
  receiver: {id: string},
  peerConnectionId: number,
  participantId: string,
): Promise<string> {
  ensureAvailable();
  return Native!.attachReceiverCryptor(keyProviderId, peerConnectionId, receiver.id, participantId);
}

export async function setCryptorEnabled(cryptorId: string, enabled: boolean): Promise<void> {
  ensureAvailable();
  return Native!.setCryptorEnabled(cryptorId, enabled);
}

export async function setCryptorKeyIndex(cryptorId: string, index: number): Promise<void> {
  ensureAvailable();
  return Native!.setCryptorKeyIndex(cryptorId, index);
}

export async function disposeCryptor(cryptorId: string): Promise<void> {
  if (!Native) {return;}
  // Idempotent on the native side; we don't gate on isAvailable() because
  // cleanup must succeed even if isAvailable went false mid-call.
  try {await Native.disposeCryptor(cryptorId);} catch { /* best effort */ }
}

export async function disposeKeyProvider(keyProviderId: string): Promise<void> {
  if (!Native) {return;}
  try {await Native.disposeKeyProvider(keyProviderId);} catch { /* best effort */ }
}

function ensureAvailable(): void {
  if (!isAvailable()) {
    throw new Error(
      'frameCryptorTransport: native FrameCryptor module unavailable — patch-package not applied? — refusing to start unencrypted group call',
    );
  }
}

/**
 * Read the numeric `_pcId` rn-webrtc assigns to every RTCPeerConnection.
 * Centralised here so the field-name dependency on rn-webrtc internals
 * is documented in one place; if rn-webrtc renames it, only this
 * function changes.
 *
 * mediasoup-client exposes the underlying PC as `transport.handler._pc`
 * — pass that here.
 */
export function getPeerConnectionNumericId(pc: unknown): number | null {
  if (!pc || typeof pc !== 'object') {return null;}
  const id = (pc as {_pcId?: unknown})._pcId;
  return typeof id === 'number' ? id : null;
}
