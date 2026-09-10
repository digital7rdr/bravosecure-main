/**
 * Per-participant AES-256 key derivation for libwebrtc FrameCryptor.
 *
 * Replaces the deleted in-tree SFrame cipher (sframe.ts +
 * groupCallEncryption.ts). The cipher itself now runs natively inside
 * libwebrtc via stream-webrtc-android's FrameCryptor classes
 * (see docs/ARCHITECTURE_AMENDMENT_SFRAME.md); JS owns only key
 * derivation and rotation.
 *
 * Key schedule (per call, per participant, per epoch)
 * ---------------------------------------------------
 *   participantKey = HKDF-SHA256(
 *                      ikm  = groupMasterKey (32 B, base64-decoded),
 *                      salt = utf8("bravo-fc-v1"),
 *                      info = utf8("epoch=") || epoch_be32
 *                              || utf8("|p=") || utf8(participantTag),
 *                      L    = 32 bytes)
 *
 *   keyIndex = epoch & 0x0F   (lower 4 bits of epoch; key ring size 16)
 *
 * Rationale
 * ---------
 *  - Domain separation from the legacy in-tree SFrame schedule via the
 *    "bravo-fc-v1" salt. A receiver running pre-amendment software
 *    cannot decrypt post-amendment frames (and vice versa) — both
 *    sides fail closed, no ambiguity.
 *  - Per-participant binding (participantTag in the info) means a
 *    leaked single-participant key only exposes that participant's
 *    media — matches Signal's group-call key model.
 *  - epoch_be32 in the info means a rekey on member-removal yields a
 *    fresh key; the SFU has no way to recover the old key from the
 *    new one.
 *  - Stable derivation: same (master, epoch, participantTag) → same
 *    key on any device. A late-joining peer can re-derive every
 *    existing participant's key locally from its own copy of the
 *    group master key — no key-distribution round trip per join.
 */

import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {fromBase64, toBase64} from '../crypto/encoding';

/** HKDF salt — bump on incompatible schedule changes. */
const HKDF_SALT = new TextEncoder().encode('bravo-fc-v1');

/** Number of key indices the native key provider keeps addressable. */
export const KEY_RING_SIZE = 16;

/** Output key length — AES-256. */
const KEY_LEN = 32;

/**
 * Convert an epoch to its native FrameCryptor key index. We use the
 * lower 4 bits so the index always falls inside the 16-slot key ring.
 * Epoch wrap (every 16 rotations) is a non-issue in practice — a group
 * would have to be rotated >16 times during a single call, which only
 * happens under adversarial join/leave churn.
 */
export function epochToKeyIndex(epoch: number): number {
  // Bitwise is intentional — `| 0` coerces to a 32-bit int and `&` clamps
  // into the ring. Equivalent arithmetic would be `Math.trunc(...) %
  // KEY_RING_SIZE`, but a power-of-two ring is the natural fit and the
  // bitwise form generates a single CPU op.
  return Math.max(0, epoch | 0) & (KEY_RING_SIZE - 1);
}

/**
 * Derive a participant's AES-256 key for a given epoch.
 *
 * @param masterKeyB64    group master key (base64, 32 bytes after decode)
 * @param epoch           current group epoch
 * @param participantTag  SFU-assigned opaque tag of the participant
 * @returns base64-encoded 32-byte key suitable for FrameCryptorKeyProvider.setKey
 */
export async function deriveParticipantKey(
  masterKeyB64:   string,
  epoch:          number,
  participantTag: string,
): Promise<string> {
  const ikmBuf = fromBase64(masterKeyB64);
  if (ikmBuf.byteLength !== 32) {
    throw new Error(`deriveParticipantKey: expected 32-byte master key, got ${ikmBuf.byteLength}`);
  }

  // HKDF info: "epoch=" || epoch_be32 || "|p=" || participantTag
  const epochBytes = new Uint8Array(4);
  // `>>> 0` coerces to unsigned 32-bit so DataView accepts negative
  // epochs (which we treat as 0 elsewhere but defend against in case
  // upstream state desyncs).
  new DataView(epochBytes.buffer).setUint32(0, epoch >>> 0, false);
  const tagBytes = new TextEncoder().encode(participantTag);
  const epochPrefix = new TextEncoder().encode('epoch=');
  const pPrefix     = new TextEncoder().encode('|p=');
  const info = new Uint8Array(epochPrefix.length + 4 + pPrefix.length + tagBytes.length);
  let o = 0;
  info.set(epochPrefix, o); o += epochPrefix.length;
  info.set(epochBytes,  o); o += 4;
  info.set(pPrefix,     o); o += pPrefix.length;
  info.set(tagBytes,    o);

  // BS-FC-HKDF — use @noble/hashes HKDF (pure JS) rather than WebCrypto
  // `crypto.subtle`. On-device (React Native / Hermes) `subtle.importKey`
  // for HKDF is NOT implemented, so the previous code threw
  // '"subtle.importKey()" is not implemented for HKDF' and EVERY group
  // call failed at FrameCryptor init. The Node test env DOES have subtle,
  // which is why the unit tests passed but real devices failed. @noble is
  // the same pure-JS HKDF the rest of the app uses on-device (see
  // crypto/outerEcies.ts) and bundles cleanly under Metro. RFC 5869
  // HKDF-SHA256 is byte-identical to the WebCrypto output, so the key
  // schedule and existing test vectors are unchanged.
  const ikm = new Uint8Array(ikmBuf);
  const out = hkdf(sha256, ikm, HKDF_SALT, info, KEY_LEN);

  return toBase64(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

/**
 * Source of group state — same shape as the deleted GroupKeySource so
 * existing callers compile unchanged. Re-exported here so callers don't
 * have to keep a stale import to the deleted groupCallEncryption module.
 */
export interface GroupKeySource {
  current(conversationId: string): {masterKeyB64: string; epoch: number} | null;
  subscribe(
    conversationId: string,
    listener:       (next: {masterKeyB64: string; epoch: number}) => void,
  ): () => void;
}
