/**
 * Base64 / UTF-8 / ArrayBuffer helpers — pure browser implementations.
 * Mirrors `packages/messenger-core/src/crypto/encoding.ts` (the LIVE
 * source; the old mobile `crypto/encoding.ts` pointer is a tombstone
 * re-export since AUDIT-2026-08-13 #7) so the libsignal-typescript layer
 * that's shared between the two ports sees identical helpers.
 */

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.byteLength; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

export function utf8ToBuffer(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

export function bufferToUtf8(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new TextDecoder().decode(u8);
}

export function addressKey(userId: string, deviceId: number): string {
  return `${userId}.${deviceId}`;
}
