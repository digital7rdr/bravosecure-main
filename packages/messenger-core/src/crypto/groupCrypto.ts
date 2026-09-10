/**
 * AES-256-GCM helpers for the group master key. Per the architecture
 * spec, group state and group message bodies are encrypted with a
 * symmetric master key shared via pairwise Signal sessions.
 *
 * The master key is a base64-encoded 32-byte secret; it lives in
 * GroupState.masterKeyB64 and is delivered through admin messages
 * when a group is created or rekeyed. Knowing the master key is
 * synonymous with group membership — never put it on the wire outside
 * a sealed Signal envelope.
 *
 * Outputs `{c, i}` rather than concatenated bytes so the JSON
 * representation stays human-debuggable in test fixtures.
 */

import {fromBase64, toBase64} from './encoding';
import {CryptoError} from './errors';

const IV_LEN = 12;            // GCM standard
const KEY_LEN_BYTES = 32;     // AES-256

/**
 * Audit P1-G7 — AES-GCM IV birthday risk on a single master key.
 *
 * With a 96-bit RANDOM IV (rather than counter-based), the per-key
 * collision probability hits 2^-32 at roughly 2^32 (~4.3B) encryptions.
 * Closing P0-G3 (rekey-on-add) means the master key already rotates on
 * every membership change, so a real-world group hits the bound only
 * under sustained ~4B-message flow without ANY membership churn —
 * implausible at our scale (group max ~100 members, ~1k msg/day each).
 *
 * Defence-in-depth path if the bound ever bites: periodic time-based
 * rekey (e.g. weekly cron), tracked separately as part of the P1
 * follow-up backlog. NOT changed here because the rekey is a member
 * action and inventing one without explicit admin intent would obscure
 * the threat model — better to document the bound and add a deliberate
 * rotation policy when message volume warrants it.
 */
// (no code change — note retained inline so future readers see the rationale)

export interface GroupCiphertext {
  /** base64 ciphertext (includes auth tag suffix per WebCrypto convention) */
  c: string;
  /** base64 12-byte IV */
  i: string;
}

/**
 * Audit P0-G2 — bounded LRU for imported CryptoKeys.
 *
 * The original cache was unbounded and had no explicit dispose path,
 * so a long-running session in many groups (or many rekeys) leaked an
 * imported key per (group × epoch). Worse, the cross-epoch replay
 * defence relied on the old key being gone — but it sat in cache
 * for the entire process lifetime, widening the replay window from
 * "until next GC" to "until process restart".
 *
 * Fix has two halves:
 *   1. `MAX_CACHED_KEYS` — LRU eviction so the cache can't grow without
 *      bound. 64 is enough for any realistic user (active groups +
 *      a few historical epochs cached for in-flight pre-rekey frames)
 *      while keeping eviction pressure off for normal flows.
 *   2. `disposeGroupKey(keyB64)` — explicit removal called from
 *      `applyAdminAction(rekey)` and `removeGroupState` so a rotated
 *      or departed group's master key is reaped immediately, not
 *      eventually.
 *
 * Cache is keyed on the base64 string (cheap equality, matches the
 * GroupState field). LRU order is tracked by insertion order in the
 * underlying Map: each access promotes the entry by re-setting it,
 * and the oldest key gets evicted when we exceed the cap. This is the
 * classical JS Map-as-LRU trick — no third-party dependency, no
 * subtle ordering bugs.
 */
const MAX_CACHED_KEYS = 64;
const keyCache = new Map<string, Promise<CryptoKey>>();

async function importKey(keyB64: string): Promise<CryptoKey> {
  const cached = keyCache.get(keyB64);
  if (cached) {
    // Promote — re-set to move to the end of the iteration order.
    keyCache.delete(keyB64);
    keyCache.set(keyB64, cached);
    return cached;
  }
  const promise = (async () => {
    const raw = fromBase64(keyB64);
    if (raw.byteLength !== KEY_LEN_BYTES) {
      throw new CryptoError(`group key must be ${KEY_LEN_BYTES} bytes; got ${raw.byteLength}`);
    }
    return crypto.subtle.importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  })();
  keyCache.set(keyB64, promise);
  // Drop on rejection so a transient subtle.importKey failure doesn't
  // pin a permanent rejected-promise in the cache.
  promise.catch(() => keyCache.delete(keyB64));
  // LRU eviction — drop the least-recently-used entry when we exceed
  // the cap. The Map's iteration order IS LRU because every cache hit
  // above re-inserts the key at the tail.
  if (keyCache.size > MAX_CACHED_KEYS) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) {keyCache.delete(oldest);}
  }
  return promise;
}

/**
 * Audit P0-G2 — explicit dispose. Called from the runtime whenever a
 * group's master key becomes irrelevant: on `applyAdminAction(rekey)`
 * with the previous key, and on `removeGroupState` to wipe the
 * departing group entirely. Idempotent.
 *
 * Why this matters beyond memory hygiene: without explicit dispose, a
 * removed member's old key sits in the receiver's keyCache until the
 * process restarts. If P0-G1's epoch-AAD check is bypassed or buggy,
 * a relay replay of pre-rekey ciphertext would `groupDecrypt` cleanly
 * because the local cache still has the old `CryptoKey`. Disposing on
 * rekey narrows that replay window from "process lifetime" to "the
 * tick between rekey landing and dispose firing" — which the runtime
 * synchronises atomically with the GroupState update.
 */
export function disposeGroupKey(masterKeyB64: string): void {
  keyCache.delete(masterKeyB64);
}

/**
 * Audit P0-G2 — wipe every cached key. Useful on sign-out / account
 * switch so the new identity's runtime starts cold. Not called from
 * the rekey hot path (that would needlessly invalidate other groups);
 * exposed so the auth boundary can scrub all group cryptographic
 * state in one call.
 */
export function disposeAllGroupKeys(): void {
  keyCache.clear();
}

/** Test-only — returns whether a key is currently cached. */
export function _isGroupKeyCached(masterKeyB64: string): boolean {
  return keyCache.has(masterKeyB64);
}

/** Test-only — returns the current cache size for cap assertions. */
export function _groupKeyCacheSize(): number {
  return keyCache.size;
}

/**
 * Encrypt `plaintext` (utf-8 string) with the group master key. Each
 * call mints a fresh random IV — never reuse one. Returns base64
 * fields suitable for embedding in a sealed payload body.
 */
export async function groupEncrypt(masterKeyB64: string, plaintext: string): Promise<GroupCiphertext> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const data = new TextEncoder().encode(plaintext);
  // toPlainAb-equivalent: wrap into a fresh ArrayBuffer for the
  // BufferSource type narrowing some RN environments require.
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
  const dataBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv: new Uint8Array(ivBuf)}, key, new Uint8Array(dataBuf));
  return {c: toBase64(ct), i: toBase64(ivBuf)};
}

export async function groupDecrypt(masterKeyB64: string, ciphertext: GroupCiphertext): Promise<string> {
  const key = await importKey(masterKeyB64);
  const iv = fromBase64(ciphertext.i);
  const ct = fromBase64(ciphertext.c);
  try {
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(iv)}, key, new Uint8Array(ct));
    return new TextDecoder().decode(pt);
  } catch (e) {
    throw new CryptoError('group decrypt failed (wrong key or tampered ciphertext)', e);
  }
}

/**
 * Type guard — distinguishes a master-key-encrypted group payload
 * from a legacy plaintext envelope. Used at receive time so a fleet
 * with mixed clients still interoperates.
 */
export function isGroupCiphertext(x: unknown): x is GroupCiphertext {
  if (!x || typeof x !== 'object') {return false;}
  const o = x as Record<string, unknown>;
  return typeof o.c === 'string' && typeof o.i === 'string';
}
