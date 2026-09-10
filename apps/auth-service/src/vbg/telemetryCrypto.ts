import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

/**
 * VBG telemetry body crypto — AES-256-GCM (BE-7 / spec "AES-256 payload").
 *
 * Self-contained, isolated to VBG telemetry. Does NOT touch libsignal,
 * sealed-sender, or any existing crypto. The principal's device encrypts
 * each GPS fix with a per-device key issued by the server at enroll; the
 * server (the trusted decryptor) decrypts to run the PostGIS geofence
 * check, then stores.
 *
 *   key:   32 bytes (AES-256), per-device, server-issued
 *   iv:    12 bytes, random per message (never reused with a key)
 *   tag:   16-byte GCM auth tag
 *   wire:  base64( iv ‖ ciphertext ‖ tag )
 */

const IV_LEN  = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function generateTelemetryKeyB64(): string {
  return randomBytes(KEY_LEN).toString('base64');
}

export function sealTelemetry(plaintext: string, keyB64: string, aad?: string): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== KEY_LEN) {throw new Error('telemetry key must be 32 bytes');}
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) {cipher.setAAD(Buffer.from(aad, 'utf8'));}
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypt a sealed blob. When `aad` is given, verify with it FIRST (binds the
 * blob to its owner — audit M-5) and fall back to a no-AAD verify so blobs
 * from already-deployed clients that seal without AAD keep working. Both
 * paths still verify the GCM tag; the fallback only relaxes the binding.
 */
export function openTelemetry(sealedB64: string, keyB64: string, aad?: string): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== KEY_LEN) {throw new Error('telemetry key must be 32 bytes');}
  const buf = Buffer.from(sealedB64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {throw new Error('sealed telemetry too short');}
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct  = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const open = (withAad: boolean): string => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (withAad && aad) {decipher.setAAD(Buffer.from(aad, 'utf8'));}
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  };
  if (!aad) {return open(false);}
  try { return open(true); } catch { return open(false); }
}
