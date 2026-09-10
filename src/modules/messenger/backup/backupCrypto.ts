/**
 * backupCrypto — password-derived wrap/unwrap for the encrypted backup.
 *
 * Design (matches the WhatsApp Encrypted Backup model):
 *
 *   password ─[argon2id, salt, mem, iters]─▶ derived_key (32B)
 *                                             │
 *                  ┌──────────────────────────┘
 *                  ▼
 *      AES-256-GCM(master_key, derived_key)  ← wrapped_master_key (server-stored)
 *
 *   master_key (32B) ─┬─ AES-256-GCM(identity_bundle_json) ── wrapped_identity_bundle
 *                     └─ AES-256-GCM(message_payload_json) ── per-message ciphertext
 *
 * Why two layers:
 *   • Rotating the password only re-wraps a 32-byte master key, not the
 *     entire backup payload. Match WhatsApp's vault-key indirection.
 *   • Server only ever sees the WRAPPED master key + WRAPPED payloads.
 *     Without the password it cannot unwrap either.
 *
 * Why argon2id:
 *   • Memory-hard KDF — defeats GPU/ASIC offline cracking that PBKDF2
 *     can't, since each guess must allocate `mem` MiB of RAM.
 *   • The OWASP-recommended default for password storage as of 2024+.
 *     WhatsApp uses argon2 in their HSM-backed vault for the same reason.
 *   • react-native-argon2 wraps the reference C implementation on both
 *     iOS (Objective-C bridge) and Android (JNI), so we get native
 *     speed without the WASM startup cost.
 *
 * Tuning (audit P0-B1, 2026-05-25 hardening):
 *   • mem=256 MiB, iters=4, parallelism=1 — matches the OWASP 2024
 *     password-storage cheat sheet "argon2id m=46 MiB t=1" base bumped
 *     to the WhatsApp encrypted-backup parameter set (m=256 MiB, t=4).
 *     Pixel-6-class hardware lands the derive at ~2.4 s; the screen
 *     shows the existing "Verifying password" progress so the latency
 *     is covered. The previous (64 MiB, 3-iter) profile was estimated
 *     at ~$2.5K cloud-GPU cost for a 6-char password, well under the
 *     Signal recovery-code floor.
 *   • Old backups created under the legacy (64 MiB, 3-iter) profile
 *     still decrypt: kdf_params is stored opaquely server-side with
 *     the bundle, so restore honours whatever params were used at
 *     setup time. New backups upgrade transparently.
 */
import argon2 from 'react-native-argon2';
import {hkdf} from '@noble/hashes/hkdf.js';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';

const SALT_BYTES = 16;
const IV_BYTES   = 12;                  // GCM standard
const KEY_BYTES  = 32;                  // AES-256

// Audit P0-B1 — bumped from (64 MiB, 3 iters) to (256 MiB, 4 iters).
// See module docblock above for the cost/UX justification + the legacy
// read path (deriveMasterKey honours the stored bundle params, so a
// pre-bump backup still restores).
const ARGON_MEM_KIB     = 256 * 1024;   // 256 MiB
const ARGON_ITERATIONS  = 4;
const ARGON_PARALLELISM = 1;

export interface KdfParams {
  algo:            'argon2id';
  memoryKib:       number;
  iterations:      number;
  parallelism:     number;
  saltBytes:       number;
  derivedKeyBytes: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algo:            'argon2id',
  memoryKib:       ARGON_MEM_KIB,
  iterations:      ARGON_ITERATIONS,
  parallelism:     ARGON_PARALLELISM,
  saltBytes:       SALT_BYTES,
  derivedKeyBytes: KEY_BYTES,
};

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  (globalThis.crypto as Crypto).getRandomValues(buf);
  return buf;
}

export function toB64(bytes: Uint8Array): string {
  // RN's Buffer is the @craftzdog polyfill installed in crypto/polyfills.
  // base64 round-trip is the canonical wire format for our REST API.

  const {Buffer} = require('@craftzdog/react-native-buffer') as typeof import('@craftzdog/react-native-buffer');
  return Buffer.from(bytes).toString('base64');
}

export function fromB64(b64: string): Uint8Array {

  const {Buffer} = require('@craftzdog/react-native-buffer') as typeof import('@craftzdog/react-native-buffer');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Derive a 32-byte AES key from password + salt using argon2id.
 *
 * react-native-argon2 takes salt as a hex string (or utf8 — we use
 * hex so binary salts round-trip without encoding ambiguity), and
 * returns the raw hash as a hex string. We re-import that as a
 * non-extractable AES-GCM CryptoKey so the rest of the module talks
 * a single Web Crypto language.
 */
export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<CryptoKey> {
  const {key, raw} = await deriveMasterKeyAndRaw(password, salt, params);
  // Callers that only need the wrap key never see the raw derived bytes.
  raw.fill(0);
  return key;
}

/**
 * Same argon2id derive as `deriveMasterKey`, but also returns the raw
 * 32-byte derived key. The P0-1 verify flow needs those bytes to derive
 * the verifier key (`deriveVerifierKey`) — the CryptoKey alone is
 * non-extractable. Callers MUST zero the returned `raw` once done.
 */
export async function deriveMasterKeyAndRaw(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<{key: CryptoKey; raw: Uint8Array}> {
  if (params.algo !== 'argon2id') {
    throw new Error(`unsupported_kdf:${params.algo}`);
  }
  const saltHex = bytesToHex(salt);
  const result = await argon2(password, saltHex, {
    mode:        'argon2id',
    memory:      params.memoryKib,
    iterations:  params.iterations,
    parallelism: params.parallelism,
    hashLength:  params.derivedKeyBytes,
    saltEncoding: 'hex',
  });
  const rawKey = hexToBytes(result.rawHash);
  if (rawKey.length !== params.derivedKeyBytes) {
    throw new Error(`argon2_unexpected_length:${rawKey.length}`);
  }
  const subtle = (globalThis.crypto as Crypto).subtle;
  // WebCrypto copies key material on import, so zeroing rawKey later
  // does not affect the returned CryptoKey.
  const key = await subtle.importKey(
    'raw',
    rawKey.buffer as ArrayBuffer,
    {name: 'AES-GCM'},
    false,
    ['encrypt', 'decrypt'],
  );
  return {key, raw: rawKey};
}

/**
 * M-1 — validate server-supplied KDF params BEFORE feeding them to
 * native argon2. The params live in the plaintext, unauthenticated,
 * server-stored bundle header; a corrupted or malicious value like
 * `memoryKib: 8_388_608` (8 GiB) crashes the native allocation, and
 * `iterations: 0` is undefined behaviour. We accept the full legacy →
 * current range (64 MiB/3 … 256 MiB/4) but reject anything that would
 * brick or DoS the restore. Throws with a distinct message so restore
 * reports "backup corrupted", not "wrong password".
 */
export function assertKdfParamsWithinBounds(p: KdfParams): void {
  if (!p || p.algo !== 'argon2id') {
    throw new Error(`kdf_algo_unsupported:${p?.algo}`);
  }
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  if (!int(p.memoryKib)  || p.memoryKib < 8 * 1024 || p.memoryKib > 1024 * 1024) {
    throw new Error(`kdf_memory_out_of_range:${p.memoryKib}`);
  }
  if (!int(p.iterations) || p.iterations < 1 || p.iterations > 10) {
    throw new Error(`kdf_iterations_out_of_range:${p.iterations}`);
  }
  if (!int(p.parallelism) || p.parallelism < 1 || p.parallelism > 4) {
    throw new Error(`kdf_parallelism_out_of_range:${p.parallelism}`);
  }
  if (p.derivedKeyBytes !== KEY_BYTES) {
    throw new Error(`kdf_derived_key_bytes_invalid:${p.derivedKeyBytes}`);
  }
  if (!int(p.saltBytes) || p.saltBytes < 8 || p.saltBytes > 64) {
    throw new Error(`kdf_salt_bytes_invalid:${p.saltBytes}`);
  }
}

/**
 * Wrap the bytes with the given key using AES-256-GCM. Returns the
 * IV-prefixed ciphertext as a single Uint8Array (12-byte IV || GCM
 * ciphertext+tag). Self-contained format — the server stores it
 * opaquely and the client unwraps with the same key + format.
 */
export async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as Crypto).subtle;
  const iv = randomBytes(IV_BYTES);
  // L-13 — `plaintext.buffer` is the whole backing ArrayBuffer, which is
  // only equal to the intended bytes when the view spans it exactly. A
  // subarray input would otherwise encrypt (and leak) adjacent bytes.
  // Slice to the exact view when it doesn't already span its buffer.
  const ptBuf = (plaintext.byteOffset === 0 && plaintext.byteLength === plaintext.buffer.byteLength)
    ? plaintext.buffer
    : plaintext.slice().buffer;
  // M-3 — optional AAD context-binding. When present, the GCM tag covers
  // the AAD, so a server that swaps this ciphertext into a different
  // logical slot (different message_id / conversation) produces a tag
  // that no longer verifies under the correct-context AAD.
  const params: {name: string; iv: ArrayBuffer; additionalData?: ArrayBuffer} = {name: 'AES-GCM', iv: iv.buffer as ArrayBuffer};
  if (aad && aad.length > 0) {params.additionalData = aadBuf(aad);}
  const ct = await subtle.encrypt(params, key, ptBuf as ArrayBuffer);
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(IV_BYTES + ctBytes.length);
  out.set(iv, 0);
  out.set(ctBytes, IV_BYTES);
  return out;
}

export async function aesGcmDecrypt(key: CryptoKey, blob: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (blob.length < IV_BYTES + 16) {throw new Error('aes_gcm_blob_too_short');}
  const subtle = (globalThis.crypto as Crypto).subtle;
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  const ivBuf = iv.slice().buffer as ArrayBuffer;
  const ctBuf = ct.slice().buffer as ArrayBuffer;
  if (aad && aad.length > 0) {
    try {
      const params: {name: string; iv: ArrayBuffer; additionalData: ArrayBuffer} =
        {name: 'AES-GCM', iv: ivBuf, additionalData: aadBuf(aad)};
      const pt = await subtle.decrypt(params, key, ctBuf);
      return new Uint8Array(pt);
    } catch {
      // M-3 — a blob written BEFORE AAD context-binding shipped has no
      // AAD, so fall back to a plain decrypt. A NEW (AAD-bound) blob served
      // in the WRONG context fails HERE (correct-context AAD mismatch) AND
      // fails the fallback (the tag covers the absent AAD), so a
      // mix-and-match swap is rejected rather than silently accepted.
    }
  }
  const pt = await subtle.decrypt({name: 'AES-GCM', iv: ivBuf}, key, ctBuf);
  return new Uint8Array(pt);
}

/** Normalize an AAD view to an exact-length ArrayBuffer (subarray-safe). */
function aadBuf(aad: Uint8Array): ArrayBuffer {
  return (aad.byteOffset === 0 && aad.byteLength === aad.buffer.byteLength)
    ? aad.buffer as ArrayBuffer
    : aad.slice().buffer as ArrayBuffer;
}

/**
 * M-3 — build AAD bytes binding a ciphertext to its logical context
 * (purpose + owner + object id). Null-separated; the id parts are UUIDs /
 * message ids that never contain a NUL byte, so the join is unambiguous.
 * Domain-tagged so AAD from one backup surface can't be replayed on
 * another.
 */
export function backupAad(purpose: string, ...parts: string[]): Uint8Array {
  return new TextEncoder().encode(['bravo-backup-aad-v1', purpose, ...parts].join(' '));
}

/**
 * Generate a fresh 32-byte master key + import as a CryptoKey suitable
 * for AES-GCM. The raw bytes are kept around briefly so we can wrap
 * them with the password-derived key before discarding.
 */
export async function generateMasterKey(): Promise<{key: CryptoKey; raw: Uint8Array}> {
  const raw = randomBytes(KEY_BYTES);
  const subtle = (globalThis.crypto as Crypto).subtle;
  const key = await subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    {name: 'AES-GCM'},
    true,
    ['encrypt', 'decrypt'],
  );
  return {key, raw};
}

/**
 * Round 5 / Security S7 — generate a fresh 32-byte random subkey for
 * a single mirror row. Returns both the imported CryptoKey + the raw
 * bytes (so we can wrap them with the master key for storage).
 */
export async function generateSubkey(): Promise<{key: CryptoKey; raw: Uint8Array}> {
  const raw = randomBytes(KEY_BYTES);
  const subtle = (globalThis.crypto as Crypto).subtle;
  const key = await subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    {name: 'AES-GCM'},
    true,
    ['encrypt', 'decrypt'],
  );
  return {key, raw};
}

/**
 * Round 5 / Security S7 — re-import a freshly-unwrapped subkey for
 * decrypting a single mirror row.
 */
export async function importSubkey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {throw new Error(`subkey_wrong_length:${raw.length}`);}
  const subtle = (globalThis.crypto as Crypto).subtle;
  return subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    {name: 'AES-GCM'},
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Re-import a previously-wrapped master key. After unwrapping the
 * blob with the derived key, we land back at raw bytes; this helper
 * turns them into a CryptoKey for use across the app session.
 */
export async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {throw new Error(`master_key_wrong_length:${raw.length}`);}
  const subtle = (globalThis.crypto as Crypto).subtle;
  return subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    {name: 'AES-GCM'},
    true,
    ['encrypt', 'decrypt'],
  );
}

// ── P0-1 verifier-key / proof contract ────────────────────────────
// Server-enforced backup verification. Contracts pinned by:
//   • supabase/migrations/20260524000000_backup_verifier_key.sql
//   • apps/messenger-service/src/backup/backup.service.spec.ts
// Drift between client and server here = universal /verify rejection.

const VERIFIER_HKDF_INFO = 'bravo-backup-verifier-v1';
const VERIFY_DOMAIN_TAG  = 'bravo-backup-verify-v1';

/**
 * HKDF-SHA256(derivedKey, info="bravo-backup-verifier-v1", L=32). Empty
 * salt — see migration COMMENT. One-way: server stores the verifier
 * key but cannot recover the wrap key.
 *
 * Why @noble instead of `subtle`: react-native-quick-crypto (0.7.17)
 * ships with `case 'HKDF'` commented out in both `subtle.importKey`
 * and `subtle.deriveBits`, so on-device this threw
 * `"subtle.importKey()" is not implemented for HKDF` and killed every
 * backup setup/restore (B-45). Same pure-JS path media/aesCbc.ts uses.
 * RFC 5869 with an absent salt is byte-identical to WebCrypto's
 * `salt: new ArrayBuffer(0)` — pinned by backupVerifyProof.test.ts.
 */
export async function deriveVerifierKey(derivedKey: Uint8Array): Promise<Uint8Array> {
  if (derivedKey.length !== KEY_BYTES) {
    throw new Error(`verifier_key_wrong_length:${derivedKey.length}`);
  }
  return hkdf(sha256, derivedKey, undefined, new TextEncoder().encode(VERIFIER_HKDF_INFO), KEY_BYTES);
}

/**
 * HMAC-SHA256(verifierKey, "bravo-backup-verify-v1" || ":" || userId
 * || ":" || nonce). Byte-for-byte identical to the server recompute in
 * backup.service.ts; drift here breaks every legitimate /verify.
 *
 * Why @noble instead of `subtle` (B-45 round 2): the previous
 * `subtle.sign('HMAC', …)` string form hit the polyfills HMAC shim,
 * whose hash-name parser returns '' for string-form algorithms →
 * quick-crypto `createHmac('')` → native "Invalid Hash Algorithm!" —
 * the "Restore failed" crash on every on-device unlock. Same pure-JS
 * HMAC merkleCommit/ratchetSnapshotScheduler already use; the
 * byte contract is pinned by backupVerifyProof.test.ts.
 */
export async function computeVerifyProof(
  verifierKey: Uint8Array,
  userId: string,
  nonce: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const tag    = enc.encode(VERIFY_DOMAIN_TAG);
  const sep    = enc.encode(':');
  const uidB   = enc.encode(userId);
  const nonceB = enc.encode(nonce);
  const msg = new Uint8Array(tag.length + 1 + uidB.length + 1 + nonceB.length);
  let off = 0;
  msg.set(tag,    off); off += tag.length;
  msg.set(sep,    off); off += 1;
  msg.set(uidB,   off); off += uidB.length;
  msg.set(sep,    off); off += 1;
  msg.set(nonceB, off);
  return hmac(sha256, verifierKey, msg);
}


function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {s += bytes[i].toString(16).padStart(2, '0');}
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {throw new Error('hex_odd_length');}
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {out[i] = parseInt(clean.substr(i * 2, 2), 16);}
  return out;
}
