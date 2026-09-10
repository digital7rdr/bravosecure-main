/**
 * Base64 <-> ArrayBuffer helpers used at every boundary between
 * libsignal (ArrayBuffer) and our wire format / SQL store (string).
 * Relies on the global Buffer polyfill — wired up in polyfills.ts for RN,
 * available natively under Node for tests.
 */

export function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

export function fromBase64(b64: string): ArrayBuffer {
  const u8 = Buffer.from(b64, 'base64');
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export function utf8ToBuffer(s: string): ArrayBuffer {
  const u8 = Buffer.from(s, 'utf8');
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export function bufferToUtf8(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString('utf8');
}

export function addressKey(userId: string, deviceId: number): string {
  return `${userId}.${deviceId}`;
}
