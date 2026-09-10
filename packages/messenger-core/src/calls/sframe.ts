/* eslint-disable no-bitwise -- binary protocol: header packing + counter encoding require bitwise ops */
/**
 * SFrame (RFC 9605-style) end-to-end encryption for SFU group calls.
 *
 * Threat model
 * ------------
 * The mediasoup SFU sits between every participant and routes RTP
 * packets without inspecting their payload. Today the SFU terminates
 * DTLS, which means it holds SRTP keys and CAN decrypt media. SFrame
 * adds a second cipher layer ON TOP of the RTP payload bytes BEFORE
 * libwebrtc encrypts them with SRTP — the SFU sees and forwards
 * SFrame-ciphertext-inside-SRTP-ciphertext, never plaintext media.
 *
 * Key schedule
 * ------------
 *   sframeBaseKey  = HKDF-SHA256(
 *                      ikm  = groupMasterKey (32 B),
 *                      salt = utf8("bravo-sframe-v1"),
 *                      info = utf8("epoch=") || epoch_be32,
 *                      L    = 32)
 *
 *   per-frame
 *   frameKey       = HKDF-SHA256(
 *                      ikm  = sframeBaseKey,
 *                      salt = utf8(participantTag),
 *                      info = kindByte || counter_be64,
 *                      L    = 32)
 *
 *   nonce          = HKDF-SHA256(
 *                      ikm  = sframeBaseKey,
 *                      salt = utf8("nonce"),
 *                      info = utf8(participantTag) || kindByte || counter_be64,
 *                      L    = 12)
 *
 * Frame layout (prepended to the RTP payload before encryption)
 * -------------------------------------------------------------
 *   | version(1) | kind(1) | counter(2 BE) | ciphertext || gcm-tag |
 *      0x01       a=1,v=2     0..65535
 *
 * Counter wraps via epoch rotation (admin rekey bumps `epoch` → fresh
 * sframeBaseKey → all counters reset). Receivers detect epoch change
 * by the version byte staying constant but decryption failing under
 * the current epoch's base key; the call layer then re-derives with
 * the next epoch.
 *
 * AAD binds the 4-byte header verbatim — so swapping `kind` (replay
 * an audio frame as video) or rolling the counter back fails the
 * GCM tag check.
 *
 * Replay defense
 * --------------
 * Receivers track a 64-bit high-water counter + 1024-bit sliding
 * window per `(participantTag, kind)`. The window is wide enough to
 * absorb out-of-order arrivals (~10 s at 100 fps audio) while
 * rejecting captured-frame replay.
 *
 * The cipher is platform-agnostic: it uses `globalThis.crypto.subtle`
 * which exists in Node 18+ (tests), in the browser, and in
 * react-native via the existing crypto polyfill. No native crypto
 * dependency is added.
 */

import {fromBase64} from '../crypto/encoding';
import {CryptoError} from '../crypto/errors';

/**
 * Wire version. Bump on incompatible header / AAD changes.
 *
 * v2 (BS-CTR widening): the counter is no longer a fixed 16-bit field.
 * Per RFC 9605 §4.2 the CTR is a compact variable-length unsigned
 * integer (up to 64-bit), encoded with the minimum number of bytes.
 * v1's 2-byte counter capped a call at ~65 536 frames (~11 min audio /
 * ~36 min video) before encryptFrame threw 'counter exhausted'; v2
 * removes that cap. The version byte changes so a v1 peer rejects v2
 * frames cleanly (unsupported version) rather than mis-parsing them.
 */
export const SFRAME_VERSION = 0x02;

/**
 * MINIMUM frame header size in bytes — version(1) + kind(1) + config(1).
 * The actual header is `SFRAME_HEADER_MIN_LEN + <counter byte count>`,
 * where the counter byte count (0..8) is carried in the config byte.
 * Use `parseFrameHeader(...).headerLen` for the real length of a given
 * frame; this constant is only the floor (counter == 0).
 */
export const SFRAME_HEADER_MIN_LEN = 3;

/**
 * Back-compat alias. Several call sites historically used
 * SFRAME_HEADER_LEN as "bytes before the ciphertext"; with a variable
 * header that meaning moves to ParsedFrameHeader.headerLen. Kept as the
 * minimum so length sanity-checks (frame >= header + tag) still hold.
 */
export const SFRAME_HEADER_LEN = SFRAME_HEADER_MIN_LEN;

/** Max counter byte count carried in the config byte (64-bit ceiling). */
const SFRAME_MAX_CTR_BYTES = 8;

/** GCM auth-tag length in bytes — full 128-bit tag. */
export const SFRAME_TAG_LEN = 16;

/** Replay window width in bits. Frames > windowSize before the high-water mark are rejected. */
export const SFRAME_REPLAY_WINDOW_BITS = 1024;

/** Media kind byte. */
export const SFRAME_KIND_AUDIO = 0x01;
export const SFRAME_KIND_VIDEO = 0x02;

export type MediaKind = 'audio' | 'video';

function kindByte(kind: MediaKind): number {
  return kind === 'audio' ? SFRAME_KIND_AUDIO : SFRAME_KIND_VIDEO;
}

function byteToKind(b: number): MediaKind {
  if (b === SFRAME_KIND_AUDIO) {return 'audio';}
  if (b === SFRAME_KIND_VIDEO) {return 'video';}
  throw new CryptoError(`sframe: unknown kind byte 0x${b.toString(16)}`);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) {n += p.byteLength;}
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {out.set(p, off); off += p.byteLength;}
  return out;
}

function be32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function be64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  const mask = 0xffn;
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(v & mask);
    v >>= 8n;
  }
  return b;
}

/**
 * HKDF-SHA256, returning `length` bytes. Uses WebCrypto, which is
 * available in Node 18+ (test env) and react-native via polyfill.
 */
async function hkdf(
  ikm:    Uint8Array,
  salt:   Uint8Array,
  info:   Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // Import IKM as raw HKDF key material. The casts to BufferSource
  // here and on deriveBits are needed because lib.dom.d.ts's
  // BufferSource type doesn't structurally accept Uint8Array<ArrayBufferLike>
  // — runtime accepts both identically.
  const key = await crypto.subtle.importKey('raw', ikm as unknown as ArrayBuffer, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, info: info as unknown as ArrayBuffer},
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive the per-epoch SFrame base key from a group master key.
 * Both peers compute identically; the SFU sees neither input.
 */
export async function deriveSframeBaseKey(
  masterKeyB64: string,
  epoch:        number,
): Promise<Uint8Array> {
  const ikm = new Uint8Array(fromBase64(masterKeyB64));
  if (ikm.byteLength !== 32) {
    throw new CryptoError(`sframe: master key must be 32 bytes; got ${ikm.byteLength}`);
  }
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
    throw new CryptoError(`sframe: epoch must be uint32; got ${epoch}`);
  }
  const salt = utf8('bravo-sframe-v1');
  const info = concat(utf8('epoch='), be32(epoch));
  return hkdf(ikm, salt, info, 32);
}

/**
 * Derive the per-frame AEAD key + nonce. Inputs are the SFrame base
 * key + the per-frame metadata the AAD binds.
 */
async function deriveFrameMaterial(
  baseKey:        Uint8Array,
  participantTag: string,
  kind:           MediaKind,
  counter:        bigint,
): Promise<{key: CryptoKey; nonce: Uint8Array}> {
  const tagBytes = utf8(participantTag);
  const kb       = new Uint8Array([kindByte(kind)]);
  const ctr      = be64(counter);
  const keyBytes = await hkdf(baseKey, tagBytes, concat(kb, ctr), 32);
  const nonce    = await hkdf(baseKey, utf8('nonce'), concat(tagBytes, kb, ctr), 12);
  const key      = await crypto.subtle.importKey(
    'raw', keyBytes as unknown as ArrayBuffer, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
  return {key, nonce};
}

/**
 * Encode a non-negative counter as the minimum number of big-endian
 * bytes (RFC 9605 §4.2 "minimum number of bytes required"). 0 → []
 * (zero bytes), 1 → [0x01], 256 → [0x01,0x00], up to 8 bytes.
 */
function minBytesBE(counter: bigint): Uint8Array {
  if (counter === 0n) {return new Uint8Array(0);}
  const tmp: number[] = [];
  let v = counter;
  while (v > 0n) {
    tmp.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(tmp);
}

/**
 * Build the SFrame v2 header:
 *   | version(1) | kind(1) | config(1 = #ctr bytes) | ctr[0..8 BE] |
 * The config byte is the count of trailing counter bytes (0..8), so a
 * peer can parse the header length without a fixed field. The counter
 * is the RFC 9605 compact integer (minimum bytes, big-endian).
 */
function buildHeader(kind: MediaKind, counter: bigint): Uint8Array {
  if (counter < 0n || counter > 0xffffffffffffffffn) {
    throw new CryptoError(`sframe: counter out of 64-bit range; got ${counter}`);
  }
  const ctr = minBytesBE(counter);
  // minBytesBE never exceeds 8 for a 64-bit value, but assert the
  // invariant so a future range change can't silently overflow config.
  if (ctr.byteLength > SFRAME_MAX_CTR_BYTES) {
    throw new CryptoError(`sframe: counter needs ${ctr.byteLength} bytes (> ${SFRAME_MAX_CTR_BYTES})`);
  }
  const h = new Uint8Array(SFRAME_HEADER_MIN_LEN + ctr.byteLength);
  h[0] = SFRAME_VERSION;
  h[1] = kindByte(kind);
  h[2] = ctr.byteLength;
  h.set(ctr, SFRAME_HEADER_MIN_LEN);
  return h;
}

export interface ParsedFrameHeader {
  version: number;
  kind:    MediaKind;
  /**
   * Counter as a JS number. Safe for the entire realistic call domain
   * (2^53 frames ≈ 2.8 million years at 100 fps). For the rare frame
   * whose counter exceeds Number.MAX_SAFE_INTEGER, use `counterBig`.
   */
  counter: number;
  /** Exact 64-bit counter — authoritative for key/nonce derivation. */
  counterBig: bigint;
  /** Total header length in bytes (version+kind+config + counter bytes). */
  headerLen: number;
}

export function parseFrameHeader(frame: Uint8Array): ParsedFrameHeader {
  // Need at least the fixed prefix to read the config byte.
  if (frame.byteLength < SFRAME_HEADER_MIN_LEN + SFRAME_TAG_LEN) {
    throw new CryptoError(`sframe: frame too short (${frame.byteLength} B)`);
  }
  const version = frame[0];
  if (version !== SFRAME_VERSION) {
    throw new CryptoError(`sframe: unsupported version 0x${version.toString(16)}`);
  }
  const kind     = byteToKind(frame[1]);
  const ctrBytes = frame[2];
  if (ctrBytes > SFRAME_MAX_CTR_BYTES) {
    throw new CryptoError(`sframe: counter length ${ctrBytes} exceeds ${SFRAME_MAX_CTR_BYTES}`);
  }
  const headerLen = SFRAME_HEADER_MIN_LEN + ctrBytes;
  // Re-check length now that we know the real header size: the frame
  // must hold the full header AND the GCM tag.
  if (frame.byteLength < headerLen + SFRAME_TAG_LEN) {
    throw new CryptoError(`sframe: frame too short for header (${frame.byteLength} B, need >= ${headerLen + SFRAME_TAG_LEN})`);
  }
  let counterBig = 0n;
  for (let i = 0; i < ctrBytes; i++) {
    counterBig = (counterBig << 8n) | BigInt(frame[SFRAME_HEADER_MIN_LEN + i]);
  }
  const counter = counterBig <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(counterBig)
    : Number.MAX_SAFE_INTEGER;
  return {version, kind, counter, counterBig, headerLen};
}

/**
 * SFrame sender. One instance per (call, kind) tuple — the counter is
 * mutable and must NOT be shared across producers.
 */
export class SframeSender {
  private counter = 0;
  /**
   * Tracks the most recent epoch we wrapped under. The producer
   * doesn't drive epoch rotation itself (the group admin layer does);
   * we just record what we used so the receive side can verify both
   * sides agree.
   */
  private epoch:    number;
  private baseKey:  Uint8Array;
  private readonly participantTag: string;
  private readonly kind: MediaKind;

  constructor(args: {
    baseKey:        Uint8Array;
    epoch:          number;
    participantTag: string;
    kind:           MediaKind;
  }) {
    this.baseKey        = args.baseKey;
    this.epoch          = args.epoch;
    this.participantTag = args.participantTag;
    this.kind           = args.kind;
  }

  /**
   * Rotate to a freshly-derived base key (admin rekey). Resets the
   * counter so receivers don't reject the first post-rotation frame
   * as out-of-order. Callers MUST broadcast the epoch change through
   * the group admin channel BEFORE rotating the sender, otherwise
   * peers will fail to decrypt for the round-trip.
   */
  rotate(newBaseKey: Uint8Array, newEpoch: number): void {
    this.baseKey = newBaseKey;
    this.epoch   = newEpoch;
    this.counter = 0;
  }

  get currentEpoch(): number { return this.epoch; }
  get currentCounter(): number { return this.counter; }

  /**
   * Encrypt one RTP payload. The returned bytes are header || GCM
   * ciphertext, ready to slot back into the encoded-frame `data`.
   */
  async encryptFrame(payload: Uint8Array): Promise<Uint8Array> {
    // v2: 64-bit counter (RFC 9605 compact encoding). The only hard
    // ceiling is Number.MAX_SAFE_INTEGER for the JS sender counter —
    // ~9e15 frames ≈ 2.8 million years at 100 fps. A rekey resets it
    // long before that; the guard is purely a correctness backstop
    // against silent precision loss, NOT a per-call cap.
    if (this.counter >= Number.MAX_SAFE_INTEGER) {
      throw new CryptoError(
        'sframe: counter exhausted (>= 2^53) — admin rekey must rotate the epoch',
      );
    }
    const counter      = BigInt(this.counter);
    const header       = buildHeader(this.kind, counter);
    const {key, nonce} = await deriveFrameMaterial(
      this.baseKey, this.participantTag, this.kind, counter,
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        {name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, additionalData: header as unknown as ArrayBuffer, tagLength: SFRAME_TAG_LEN * 8},
        key, payload as unknown as ArrayBuffer,
      ),
    );
    this.counter += 1;
    return concat(header, ct);
  }
}

/**
 * Sliding-window replay detector. Per-(participantTag, kind).
 *
 * Standard SRTP-style approach: track the highest counter seen
 * (`high`), and a bitmap of the last `width` counters indexed from
 * `high` downward. Reject:
 *   - any counter that is set in the bitmap (replay), or
 *   - any counter older than `high - width + 1` (too old).
 */
export class ReplayWindow {
  private high = -1;
  private readonly bits: Uint8Array;

  constructor(private readonly width: number = SFRAME_REPLAY_WINDOW_BITS) {
    if (width <= 0 || width % 8 !== 0) {
      throw new CryptoError('sframe: replay window width must be a positive multiple of 8');
    }
    this.bits = new Uint8Array(width / 8);
  }

  /**
   * Non-mutating freshness check — true when `counter` would be accepted
   * by observe(). Callers MUST verify the frame's AEAD tag between
   * isFresh() and observe(): advancing the window on an unverified header
   * would let one forged high-counter frame slide the window past every
   * genuine in-flight counter and wedge the stream.
   */
  isFresh(counter: number): boolean {
    if (counter < 0) {return false;}
    if (this.high < 0) {return true;}
    if (counter > this.high) {return true;}
    const offset = this.high - counter;
    if (offset >= this.width) {return false;}
    return !this.getBit(offset);
  }

  /**
   * Check + record one counter. Returns true if the counter is fresh
   * (caller should accept the frame). Returns false if it's a replay
   * or below the window (caller MUST drop the frame).
   */
  observe(counter: number): boolean {
    if (counter < 0) {return false;}
    if (this.high < 0) {
      this.high = counter;
      this.setBit(0);
      return true;
    }
    if (counter > this.high) {
      // Advance — shift the bitmap right by (counter - high) bits.
      const shift = counter - this.high;
      this.shiftRight(shift);
      this.high = counter;
      this.setBit(0);
      return true;
    }
    // counter <= high — check window membership.
    const offset = this.high - counter;
    if (offset >= this.width) {return false;}
    if (this.getBit(offset)) {return false;}
    this.setBit(offset);
    return true;
  }

  private setBit(offset: number): void {
    this.bits[offset >>> 3] |= 1 << (offset & 7);
  }

  private getBit(offset: number): boolean {
    return (this.bits[offset >>> 3] & (1 << (offset & 7))) !== 0;
  }

  private shiftRight(by: number): void {
    if (by >= this.width) {this.bits.fill(0); return;}
    // Shift the bitmap so bit 0 becomes the new high, bit N becomes
    // the old (N - by). We rebuild from the end backwards.
    const byteShift = by >>> 3;
    const bitShift  = by & 7;
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const src1 = i - byteShift >= 0 ? this.bits[i - byteShift] : 0;
      const src2 = i - byteShift - 1 >= 0 ? this.bits[i - byteShift - 1] : 0;
      this.bits[i] = bitShift === 0
        ? src1
        : ((src1 << bitShift) | (src2 >>> (8 - bitShift))) & 0xff;
    }
  }
}

/**
 * SFrame receiver — one per (call, participantTag, kind). Holds the
 * replay window and the current epoch's base key.
 */
export class SframeReceiver {
  private baseKey: Uint8Array;
  private epoch:   number;
  private readonly participantTag: string;
  private readonly kind: MediaKind;
  private readonly window: ReplayWindow;

  constructor(args: {
    baseKey:        Uint8Array;
    epoch:          number;
    participantTag: string;
    kind:           MediaKind;
  }) {
    this.baseKey        = args.baseKey;
    this.epoch          = args.epoch;
    this.participantTag = args.participantTag;
    this.kind           = args.kind;
    this.window         = new ReplayWindow();
  }

  rotate(newBaseKey: Uint8Array, newEpoch: number): void {
    this.baseKey = newBaseKey;
    this.epoch   = newEpoch;
    // Reset the window: post-rotation counters restart at 0.
    (this.window as unknown as {high: number}).high = -1;
    (this.window as unknown as {bits: Uint8Array}).bits.fill(0);
  }

  get currentEpoch(): number { return this.epoch; }

  /**
   * Decrypt one SFrame envelope. Returns the original RTP payload.
   * Throws on malformed header, replay, wrong kind, or AEAD tag
   * failure (any of which mean the SFU or an attacker tampered).
   */
  async decryptFrame(envelope: Uint8Array): Promise<Uint8Array> {
    const header = parseFrameHeader(envelope);
    if (header.kind !== this.kind) {
      throw new CryptoError(
        `sframe: receiver kind=${this.kind} but frame kind=${header.kind}`,
      );
    }
    // Check-only here — the window is committed AFTER the AEAD verify
    // below. Pre-fix, observe() advanced the high-water mark on the
    // UNVERIFIED header, so a single forged high-counter frame (tag fails,
    // frame dropped) shifted the window past every genuine in-flight
    // counter and permanently wedged the stream. Ordering fix only — the
    // crypto primitives are untouched.
    if (!this.window.isFresh(header.counter)) {
      throw new CryptoError(`sframe: replay/out-of-window counter=${header.counter}`);
    }
    // Derive from the authoritative 64-bit counter (counterBig), not the
    // possibly-saturated `counter` number — otherwise a frame past 2^53
    // would derive the wrong key/nonce and fail the tag.
    const {key, nonce} = await deriveFrameMaterial(
      this.baseKey, this.participantTag, this.kind, header.counterBig,
    );
    // AAD + ciphertext split on the ACTUAL (variable) header length.
    // Using the old fixed SFRAME_HEADER_LEN here would bind the wrong
    // bytes as AAD and slice the counter bytes into the ciphertext,
    // breaking every frame whose counter needs >0 bytes.
    const aad = envelope.subarray(0, header.headerLen);
    const ct  = envelope.subarray(header.headerLen);
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, additionalData: aad as unknown as ArrayBuffer, tagLength: SFRAME_TAG_LEN * 8},
        key, ct as unknown as ArrayBuffer,
      );
    } catch (e) {
      throw new CryptoError('sframe: AEAD tag verification failed', e);
    }
    // Commit the replay window only now that the frame proved authentic.
    this.window.observe(header.counter);
    return new Uint8Array(pt);
  }
}
