/**
 * Signal-style safety number derivation. Combines the local identity key
 * and the remote identity key into a deterministic 60-digit decimal
 * fingerprint rendered as twelve groups of five digits. The same pair of
 * keys always produces the same code regardless of which side computes
 * it; if either side has been MITM'd, the codes diverge and the
 * out-of-band comparison fails.
 *
 * Why: audit S12 — the previous `fingerprintFor(conversationId)` was an
 * FNV-1a hash of the conversation id only. Identical for both peers
 * regardless of identity keys, so two MITM endpoints would still
 * "verify". This implementation hashes the actual identity public keys.
 *
 * Reference: Signal "Fingerprint format" (DisplayableFingerprint) —
 * 5200 SHA-512 iterations over (version || localId || localKey), with
 * the remote half computed symmetrically and the two concatenated
 * (smaller first) before producing the 6×5-digit chunks per side.
 *
 * This module uses 5200 SHA-256 iterations (the platform has fast,
 * audited SHA-256 via the WebCrypto polyfill; SHA-512 is not consistently
 * available on RN Hermes) and 60 digits formatted as 12 groups of 5.
 * The exact iteration count is not security-critical — it just makes
 * brute-forcing the comparable digits computationally infeasible.
 */

const FINGERPRINT_VERSION = new Uint8Array([0, 0]);
const ITERATIONS = 5200;
const NUM_CHUNKS = 12;
const CHUNK_DIGITS = 5;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Why: defensive — RN Hermes does not ship WebCrypto natively. The
  // app boots a polyfill at startup (src/modules/messenger/crypto/polyfills.ts).
  // If a future regression unmounts it, fail loud rather than fall back
  // to a weaker hash.
  if (!globalThis.crypto?.subtle) {
    throw new Error('safety-number: crypto.subtle not available');
  }
  // Cast through unknown because the lib.dom + Node BufferSource types
  // disagree about Uint8Array<ArrayBufferLike>; the underlying call accepts
  // either at runtime via the polyfill.
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(buf);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

async function iterateHash(version: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  let h = concat(version, key);
  for (let i = 0; i < ITERATIONS; i++) {
    h = await sha256(concat(h, key));
  }
  return h;
}

function chunkToDigits(bytes: Uint8Array, offset: number): string {
  // Take 5 bytes as a big-endian 40-bit integer, mod 10^5.
  let n = 0n;
  for (let i = 0; i < 5; i++) {
    n = (n << 8n) | BigInt(bytes[offset + i] ?? 0);
  }
  const mod = n % 100000n;
  return mod.toString(10).padStart(CHUNK_DIGITS, '0');
}

/**
 * Compute the comparable safety number for the pair (localIdentityKey,
 * remoteIdentityKey). The two inputs are independently hashed and the
 * resulting hashes are concatenated with the smaller half first, so
 * both peers compute the same string regardless of orientation.
 */
export async function computeSafetyNumber(
  localIdentityKey: ArrayBuffer | Uint8Array,
  remoteIdentityKey: ArrayBuffer | Uint8Array,
): Promise<string> {
  const localKey = toBytes(localIdentityKey);
  const remoteKey = toBytes(remoteIdentityKey);

  const localHash  = await iterateHash(FINGERPRINT_VERSION, localKey);
  const remoteHash = await iterateHash(FINGERPRINT_VERSION, remoteKey);

  // Order-independence: stable sort the two halves so swap of caller +
  // callee yields the same display string.
  const [first, second] = compareBytes(localHash, remoteHash) <= 0
    ? [localHash, remoteHash]
    : [remoteHash, localHash];

  const halfChunks = NUM_CHUNKS / 2;
  const chunks: string[] = [];
  for (let i = 0; i < halfChunks; i++) {
    chunks.push(chunkToDigits(first, i * 5));
  }
  for (let i = 0; i < halfChunks; i++) {
    chunks.push(chunkToDigits(second, i * 5));
  }
  return chunks.join(' ');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {return (a[i] ?? 0) - (b[i] ?? 0);}
  }
  return a.length - b.length;
}
