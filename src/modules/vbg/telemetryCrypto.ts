import 'react-native-get-random-values';
import * as Keychain from 'react-native-keychain';

/**
 * VBG telemetry body crypto (client side) — AES-256-GCM, matching the
 * server's `apps/auth-service/src/vbg/telemetryCrypto.ts`.
 *
 * The per-device 32-byte key is issued by the server at enroll and kept in
 * the device keychain. Each fix is encrypted with a fresh random 12-byte
 * IV; wire form is base64( iv ‖ ciphertext ‖ tag ). Isolated to VBG
 * telemetry — does not touch the messenger/libsignal crypto.
 *
 * Uses Web Crypto subtle (provided by react-native-quick-crypto's polyfill,
 * already installed app-wide) so there's no new native dependency.
 */

const KEYCHAIN_SERVICE = 'bravo.vbg.telemetry-key';
const IV_LEN = 12;

function b64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {out[i] = bin.charCodeAt(i);}
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {bin += String.fromCharCode(bytes[i]);}
  return globalThis.btoa(bin);
}

/** Persist the server-issued key (called once, after enroll). */
export async function storeTelemetryKey(keyB64: string): Promise<void> {
  await Keychain.setGenericPassword('vbg-telemetry', keyB64, {
    service:    KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function hasTelemetryKey(): Promise<boolean> {
  const cred = await Keychain.getGenericPassword({service: KEYCHAIN_SERVICE});
  return cred !== false && !!cred.password;
}

async function loadKey(): Promise<CryptoKey | null> {
  const cred = await Keychain.getGenericPassword({service: KEYCHAIN_SERVICE});
  if (cred === false || !cred.password) {return null;}
  const raw = b64ToBytes(cred.password);
  if (raw.length !== 32) {return null;}
  // Copy into a fresh ArrayBuffer so the type is the strict BufferSource the
  // subtle typings want (Uint8Array<ArrayBufferLike> isn't assignable).
  const keyBuf = raw.slice().buffer;
  return crypto.subtle.importKey('raw', keyBuf, {name: 'AES-GCM'}, false, ['encrypt']);
}

/** GCM AAD binding a telemetry blob to its owner — mirrors the server (audit M-5). */
export function telemetryAad(userId: string): string {
  return `vbg1:${userId}`;
}

/**
 * Encrypt a telemetry fix → base64( iv ‖ ct ‖ tag ). Returns null when no
 * key is stored (caller skips the ping). AES-GCM appends the 16-byte tag to
 * the ciphertext, matching the server's decrypt layout. `aad` (when given)
 * binds the blob to the signed-in user; the server verifies AAD-first and
 * falls back to the legacy no-AAD envelope.
 */
export async function sealTelemetry(fix: {
  lat: number; lng: number; heading?: number; speed?: number; recordedAt?: string;
}, aad?: string): Promise<string | null> {
  const key = await loadKey();
  if (!key) {return null;}
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const pt = new TextEncoder().encode(JSON.stringify(fix));
  // RN tsconfig has no DOM lib, so AesGcmParams isn't a named type here.
  const params: {name: 'AES-GCM'; iv: ArrayBuffer; additionalData?: ArrayBuffer} =
    {name: 'AES-GCM', iv: iv.slice().buffer};
  if (aad) {params.additionalData = new TextEncoder().encode(aad).slice().buffer;}
  const ctBuf = await crypto.subtle.encrypt(
    params,
    key,
    pt.slice().buffer,
  );
  const ct = new Uint8Array(ctBuf); // includes the GCM tag at the end
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}
