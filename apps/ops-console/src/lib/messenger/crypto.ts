/**
 * WebCrypto wrappers — PBKDF2 passphrase derivation + AES-GCM 256
 * field-level encryption for the IndexedDB protocol store.
 *
 * Design notes:
 *  - PBKDF2(SHA-256) over a random 16-byte salt. Salt is persisted
 *    alongside the wrapped data; the passphrase never is.
 *  - Each wrapped row gets a fresh 12-byte IV. We store {iv, ct} as a
 *    single Uint8Array: [iv (12)] + [ciphertext + GCM tag].
 *  - GCM tag failure on unwrap → WrongPassphraseError. The auth tag is
 *    a clean signal so the unlock dialog can distinguish "wrong
 *    passphrase" from "data corrupted".
 *
 * Audit P0-W6 — iteration count raised from 200_000 to 600_000 to match
 * OWASP 2024 guidance for PBKDF2-SHA256. The audit's preferred fix was
 * Argon2id WASM, but adding a WASM build pipeline to Next.js is out of
 * scope for this commit; bumping to 600k closes most of the gap against
 * commodity GPU attackers while we evaluate `@noble/hashes/argon2` for
 * the follow-up. The minimum-passphrase-length floor + an entropy-class
 * gate (see `assertPassphraseStrength`) layers brute-force resistance
 * on top of the KDF.
 */

import {WrongPassphraseError} from './errors';

const PBKDF2_ITERS = 600_000;
const KEY_LENGTH_BITS = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

/**
 * Audit P0-W6 — minimum passphrase floor. 12 chars + at least three of
 * {upper, lower, digit, special}. Tightened from the previous 8-char
 * threshold; covered in `assertPassphraseStrength` so the unlock /
 * setup dialog can short-circuit before running the KDF on a guess
 * that would never have survived a real attacker.
 */
const MIN_PASSPHRASE_LENGTH = 12;
const MIN_PASSPHRASE_CLASSES = 3;

export type WrapKey = CryptoKey;

/**
 * Audit P0-W6 — passphrase strength gate. Throws `WeakPassphraseError`
 * (a subclass of WrongPassphraseError so the unlock dialog's existing
 * error UX still triggers) when the input is below the minimum length
 * OR uses fewer than three character classes. Called from setup,
 * change-passphrase, and the unlock path so an attacker can't
 * downgrade past the gate by editing a stored canary.
 *
 * No zxcvbn dictionary lookup — we don't ship the dictionary bundle on
 * ops-console yet. The class+length heuristic is the floor; the
 * follow-up to wire zxcvbn is tracked.
 */
export class WeakPassphraseError extends WrongPassphraseError {
  public readonly reason: 'too_short' | 'too_simple';
  constructor(reason: 'too_short' | 'too_simple') {
    super();
    this.reason = reason;
    this.message = `passphrase_${reason}`;
    this.name = 'WeakPassphraseError';
  }
}

export function assertPassphraseStrength(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError('too_short');
  }
  let classes = 0;
  if (/[a-z]/.test(passphrase)) classes++;
  if (/[A-Z]/.test(passphrase)) classes++;
  if (/[0-9]/.test(passphrase)) classes++;
  if (/[^a-zA-Z0-9]/.test(passphrase)) classes++;
  if (classes < MIN_PASSPHRASE_CLASSES) {
    throw new WeakPassphraseError('too_simple');
  }
}

// Audit OPS-MSG-08 — single source of truth for the unlock dialog so its
// hint/disable logic matches the real gate (12 chars + 3 classes) instead
// of the stale 8-char floor it advertised.
export {MIN_PASSPHRASE_LENGTH, MIN_PASSPHRASE_CLASSES};

/** Non-throwing variant of assertPassphraseStrength for live UI hints. */
export function checkPassphraseStrength(passphrase: string): 'ok' | 'too_short' | 'too_simple' {
  try {
    assertPassphraseStrength(passphrase);
    return 'ok';
  } catch (e) {
    return e instanceof WeakPassphraseError ? e.reason : 'too_short';
  }
}

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<WrapKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    {name: 'PBKDF2'},
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256'},
    baseKey,
    {name: 'AES-GCM', length: KEY_LENGTH_BITS},
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap a plaintext blob with the derived key. Output: iv ‖ ciphertext. */
export async function wrap(key: WrapKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    plaintext,
  );
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LENGTH);
  return out;
}

/** Inverse of wrap(). Throws WrongPassphraseError on tag failure. */
export async function unwrap(key: WrapKey, payload: Uint8Array): Promise<Uint8Array> {
  if (payload.byteLength <= IV_LENGTH) throw new WrongPassphraseError();
  const iv = payload.subarray(0, IV_LENGTH);
  const ct = payload.subarray(IV_LENGTH);
  try {
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new WrongPassphraseError();
  }
}

/* ── String / blob convenience helpers ──────────────────────────── */

export async function wrapString(key: WrapKey, s: string): Promise<Uint8Array> {
  return wrap(key, new TextEncoder().encode(s));
}

export async function unwrapString(key: WrapKey, payload: Uint8Array): Promise<string> {
  const pt = await unwrap(key, payload);
  return new TextDecoder().decode(pt);
}

export async function wrapBuffer(key: WrapKey, buf: ArrayBuffer): Promise<Uint8Array> {
  return wrap(key, new Uint8Array(buf));
}

export async function unwrapBuffer(key: WrapKey, payload: Uint8Array): Promise<ArrayBuffer> {
  const pt = await unwrap(key, payload);
  // Copy into a fresh ArrayBuffer (libsignal expects ArrayBuffer, not
  // ArrayBufferLike — TS narrows the .buffer of a typed array up since
  // it could be a SharedArrayBuffer in some runtimes).
  const out = new ArrayBuffer(pt.byteLength);
  new Uint8Array(out).set(pt);
  return out;
}

export async function wrapNumber(key: WrapKey, n: number): Promise<Uint8Array> {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return wrap(key, new Uint8Array(buf));
}

export async function unwrapNumber(key: WrapKey, payload: Uint8Array): Promise<number> {
  const pt = await unwrap(key, payload);
  return new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getFloat64(0);
}
