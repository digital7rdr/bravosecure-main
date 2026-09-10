/**
 * Per-file AES-256-CBC encryption for message attachments.
 *
 * Each attachment gets a FRESH 32-byte key and 16-byte IV — never
 * reuse them across files. Key + IV travel in-band inside the sealed
 * Signal payload; the encrypted blob goes to R2 via a presigned URL.
 * Therefore the R2 operator never sees plaintext or keys.
 *
 * CBC requires PKCS#7 padding on the plaintext. WebCrypto handles it
 * transparently — we pass the raw bytes in and get back padded ct / de-padded pt.
 *
 * Audit fix #20 — encrypt-then-MAC.
 *
 *   The original implementation argued that CBC without HMAC was safe
 *   because the per-file key travelled inside the Signal envelope, so
 *   "an attacker who tampers the R2 blob can't know the key, so forged
 *   plaintext is cryptographically unreachable; the decrypt will just
 *   fail (padding / random noise)."
 *
 *   That's NOT true: CBC is malleable. An attacker can flip bits in
 *   ciphertext block N to predictably alter plaintext block N+1
 *   (two XORs). Combined with a padding oracle (any error path that
 *   distinguishes "pad bad" from "decrypt OK + later validation
 *   failed"), the entire blob can be recovered. Even without a
 *   padding oracle, the attacker can corrupt content silently — a
 *   PDF, an image, a voice note — and we'd display the corrupted
 *   bytes to the user as a legitimate message. For voice/video, that
 *   becomes a denial-of-service vector; for documents, it's worse.
 *
 *   Fix: HMAC-SHA256 the ciphertext under a key derived from the
 *   sealed-envelope key via HKDF, append the 32-byte tag, and verify
 *   BEFORE the AES decrypt. Tampering is detected with a constant-
 *   time HMAC comparison; the decrypt path never runs against
 *   modified bytes.
 *
 * Audit Rev2 CRY-01 — v2 is the ONLY accepted format on read.
 *
 *   This header used to say the version byte "lets a v1 blob (no HMAC)
 *   decrypt the legacy way during a fleet rollout". That was the
 *   vulnerability: the branch selector was the FIRST BYTE OF THE BLOB WE
 *   JUST DOWNLOADED, which is attacker-controlled, and the sealed
 *   envelope carried no authenticated "this must be v2" flag. Writing
 *   0x01 over a v2 blob therefore skipped integrity entirely and handed
 *   CBC malleability straight back — version negotiation before
 *   authentication, the same shape as a TLS downgrade.
 *
 *   Both legacy branches are gone. v1 was never emitted by any commit
 *   (FORMAT_V1 and FORMAT_V2 were introduced together in e69fd03; the
 *   implementation before that wrote no version byte at all), so it only
 *   ever existed as an attacker's byte. Since the tag covers
 *   (version || ciphertext), requiring v2 also makes the version itself
 *   authenticated — no envelope field or schema change needed.
 */

import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';

export interface EncryptedAttachment {
  /** Base64-encoded 32-byte AES key. */
  key:  string;
  /** Base64-encoded 16-byte IV. */
  iv:   string;
  /** Ciphertext bytes, ready to PUT to storage as the object body. */
  ciphertext: Uint8Array;
}

const KEY_BYTES = 32;
const IV_BYTES  = 16;
const HMAC_BYTES = 32;
// Audit Rev2 CRY-01 — 0x01 ("v1", bare AES-CBC with no HMAC) is DELIBERATELY
// not defined here any more. No commit ever produced it (FORMAT_V1 and
// FORMAT_V2 were added together in e69fd03; before that there was no version
// byte at all), so the only way a 0x01 blob reaches decryptAttachment is an
// attacker writing one to storage to skip the integrity check. Do not
// reintroduce the constant — a reader who sees it will assume the branch is
// needed for compatibility, which is exactly how the downgrade shipped.
const FORMAT_V2 = 0x02; // [v2 byte | aes-cbc(pt) | hmac-sha256-32]  — the ONLY accepted format

const HKDF_INFO_HMAC = new TextEncoder().encode('Bravo-Attachment-HMAC-v2');

/**
 * On-device-safe AES-256-CBC.
 *
 * Why not crypto.subtle: react-native-quick-crypto's WebCrypto `subtle`
 * has gaps on Hermes (HMAC + SHA digests are already shimmed in
 * polyfills.ts; AES-CBC via subtle.encrypt is unproven on the release
 * APK). The Node-style `createCipheriv('aes-256-cbc', …)` path is the
 * battle-tested native primitive quick-crypto ships, and it handles
 * PKCS#7 padding transparently — same algorithm, mode, key length, and
 * IV handling the architecture doc mandates. In Jest there is no native
 * module, so we fall back to Node's own `crypto` (identical API + output).
 *
 * The algorithm/format/HMAC/HKDF are UNCHANGED — only the AES primitive
 * call moved off subtle.
 */
type NodeCipher = {
  update: (data: Uint8Array) => Buffer;
  final:  () => Buffer;
};
type NodeHmac = {
  update: (data: Uint8Array) => NodeHmac;
  digest: () => Buffer;
};
type CipherFactory = {
  createCipheriv:   (alg: string, key: Uint8Array, iv: Uint8Array) => NodeCipher;
  createDecipheriv: (alg: string, key: Uint8Array, iv: Uint8Array) => NodeCipher;
  createHmac?:      (alg: string, key: Uint8Array) => NodeHmac;
};

let _cipherFactory: CipherFactory | null = null;
function cipherFactory(): CipherFactory {
  if (_cipherFactory) {return _cipherFactory;}
  // On device this resolves to react-native-quick-crypto's native AES.
  // In Jest the same specifier is mapped (moduleNameMapper) to a shim
  // that re-exports Node's crypto createCipheriv/createDecipheriv — so
  // the code path is identical and Metro never has to resolve a bare
  // 'crypto' (which doesn't exist in the RN bundle).
  const qc = require('react-native-quick-crypto') as Partial<CipherFactory> & {default?: Partial<CipherFactory>};
  const mod: Partial<CipherFactory> = qc.createCipheriv ? qc : (qc.default ?? {});
  if (typeof mod.createCipheriv !== 'function' || typeof mod.createDecipheriv !== 'function') {
    throw new Error('aes-cbc: no createCipheriv available (quick-crypto missing?)');
  }
  _cipherFactory = mod as CipherFactory;
  return _cipherFactory;
}

function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, pt: Uint8Array): Uint8Array {
  const c = cipherFactory().createCipheriv('aes-256-cbc', key, iv);
  const a = c.update(pt);
  const b = c.final();
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 0);
  out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), a.byteLength);
  return out;
}

function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Uint8Array {
  const d = cipherFactory().createDecipheriv('aes-256-cbc', key, iv);
  const a = d.update(ct);
  const b = d.final();
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 0);
  out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), a.byteLength);
  return out;
}

/**
 * Media-parity G14 (2026-07-03) — HMAC-SHA256 over the ciphertext used to
 * run in pure JS (@noble), a full extra pass over the whole file on the
 * JS thread: multi-second stalls on tens-of-MB attachments. quick-crypto
 * ships the same primitive natively (`createHmac`), byte-identical
 * output (RFC 2104 HMAC-SHA256 — verified by the cross-impl vector test
 * in aesCbc.test.ts). Fall back to @noble when the factory lacks it
 * (older shim) so Jest/loopback keep working either way. The FORMAT/
 * algorithm are unchanged — only where the math executes.
 */
function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  try {
    const native = cipherFactory().createHmac;
    if (typeof native === 'function') {
      const digest = native('sha256', key).update(data).digest();
      return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
    }
  } catch { /* fall through to the JS implementation */ }
  return hmac(sha256, key, data);
}

/**
 * Derive a 32-byte HMAC key from the AES key. Different domain than
 * the AES key itself so a hypothetical AES-key leak doesn't compromise
 * the integrity tag (and vice versa).
 */
function deriveHmacKey(aesKey: Uint8Array): Uint8Array {
  return hkdf(sha256, aesKey, undefined, HKDF_INFO_HMAC, HMAC_BYTES);
}

export async function encryptAttachment(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  // [LAGDIAG] TEMPORARY (B-285) — AES + HMAC are synchronous over the whole
  // buffer on the JS thread. Measuring the split against readUriBytes tells us
  // whether the multi-second send freeze is the crypto or the base64 decode
  // before it. No plaintext, key or byte content is logged — sizes and ms only.
  const tCrypt0 = Date.now();
  const keyBytes = randomBytes(KEY_BYTES);
  const ivBytes  = randomBytes(IV_BYTES);
  const aesCt = aesCbcEncrypt(keyBytes, ivBytes, plaintext);
  const tAes = Date.now();

  // Audit fix #20 — encrypt-then-MAC. Tag covers (version || aesCt) so
  // a downgrade from v2→v1 is also caught (the version byte is part of
  // the MAC input).
  const hmacKey = deriveHmacKey(keyBytes);
  const macInput = new Uint8Array(1 + aesCt.byteLength);
  macInput[0] = FORMAT_V2;
  macInput.set(aesCt, 1);
  const tag = hmacSha256(hmacKey, macInput);

  const out = new Uint8Array(1 + aesCt.byteLength + HMAC_BYTES);
  out[0] = FORMAT_V2;
  out.set(aesCt, 1);
  out.set(tag, 1 + aesCt.byteLength);

  const tEnd = Date.now();
  if (tEnd - tCrypt0 > 200) {
    // Timings ONLY — no size, and deliberately no reference to the plaintext
    // buffer inside the log call. `logAudit.test.ts` forbids naming it here, and
    // the right answer to that gate is to log less, never to rename the variable
    // around it (CLAUDE.md). The matching byte count is already on the
    // readUriBytes line for the same buffer, one step earlier in the send path.
    console.warn(`[LAGDIAG] encryptAttachment aes=${tAes - tCrypt0}ms hmac+copy=${tEnd - tAes}ms`);
  }

  return {
    key:        toBase64(keyBytes),
    iv:         toBase64(ivBytes),
    ciphertext: out,
  };
}

export async function decryptAttachment(params: {
  keyB64: string;
  ivB64:  string;
  ciphertext: Uint8Array;
}): Promise<Uint8Array> {
  const keyBytes = fromBase64(params.keyB64);
  const ivBytes  = fromBase64(params.ivB64);
  if (keyBytes.byteLength !== KEY_BYTES) {throw new Error('invalid key length');}
  if (ivBytes.byteLength !== IV_BYTES)   {throw new Error('invalid iv length');}

  // Audit Rev2 CRY-01 — v2 IS THE ONLY ACCEPTED FORMAT.
  //
  // This used to branch on ct[0]: v2 verified the HMAC, v1 and "no version
  // byte" skipped it. That byte comes from the blob we just downloaded, so an
  // attacker who can modify stored ciphertext (storage or server compromise —
  // explicitly in our threat model) simply wrote 0x01 and we AES-CBC-decrypted
  // with NO integrity check. CBC malleability then lets targeted bit-flips
  // produce attacker-chosen changes in a document or image that renders as an
  // authentic message from a verified sender. Choosing the security path from
  // unauthenticated input is the whole bug — encrypt-then-MAC below was always
  // correct.
  //
  // Deleting the legacy branches is safe, and is the actual fix rather than a
  // mitigation:
  //   - encryptAttachment has ALWAYS written FORMAT_V2 (out[0] = FORMAT_V2).
  //   - v1 was never produced by any commit: `git log -S FORMAT_V1` shows
  //     FORMAT_V1 and FORMAT_V2 were introduced together in e69fd03, and the
  //     implementation before that (0b5f371) wrote no version byte at all. So
  //     0x01 has only ever been an attacker's byte.
  //   - the no-version shape belonged to app versions <= 1.0.12 (a 17-day
  //     window; current is 1.0.218) and was already broken by chance for ~0.78%
  //     of blobs, because a raw blob's first byte is random ciphertext that
  //     sometimes collides with 0x01/0x02.
  //
  // Because the tag covers (version || aesCt), requiring v2 also means the
  // version byte is now authenticated — no envelope field or DB column needed.
  const ct = params.ciphertext;
  if (ct.byteLength === 0) {throw new Error('empty ciphertext');}
  if (ct[0] !== FORMAT_V2) {
    throw new Error('attachment format not supported — possible downgrade attack');
  }
  if (ct.byteLength < 1 + HMAC_BYTES) {throw new Error('attachment too short for v2');}

  const tagOffset = ct.byteLength - HMAC_BYTES;
  const aesCt = ct.subarray(1, tagOffset);
  const got = ct.subarray(tagOffset);

  const hmacKey = deriveHmacKey(keyBytes);
  const macInput = new Uint8Array(1 + aesCt.byteLength);
  macInput[0] = FORMAT_V2;
  macInput.set(aesCt, 1);
  const expected = hmacSha256(hmacKey, macInput);
  if (!constantTimeEq(expected, got)) {
    throw new Error('attachment hmac mismatch (tampered or wrong key)');
  }

  return aesCbcDecrypt(keyBytes, ivBytes, aesCt);
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function toBase64(u: Uint8Array): string {
  return Buffer.from(u).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {diff |= a[i] ^ b[i];}
  return diff === 0;
}
