/**
 * Jest mock for `react-native-argon2`.
 *
 * The real library shells out to a native Android/iOS Argon2id
 * implementation; under Jest we only have Node, so we substitute a
 * deterministic stub. The stub uses sha256(saltBytes || pin) as the
 * "hash" — NOT a real KDF, but deterministic enough for the vault-store
 * unit tests to verify the setupPin -> verifyPin round-trip without
 * invoking native code.
 *
 * B-456 — THIS MOCK USED TO LIE, AND THAT LIE HID A TOTAL VAULT OUTAGE.
 * It returned `{rawHash, encoded}` and echoed the caller's salt STRING
 * straight back into the PHC output. The real module does neither:
 *
 *   1. RESULT SHAPE is `{rawHash, encodedHash}` —
 *      android/src/main/java/com/poowf/argon2/RNArgon2Module.java:90-92
 *      (`resultMap.putString("encodedHash", ...)`), ios/RNArgon2.swift:51-54,
 *      and index.d.ts:12-15. Reading `.encoded` yields `undefined`, so the
 *      store persisted nothing and every unlock failed — while this mock
 *      kept the suite green.
 *   2. THE SALT IS BYTES, NOT TEXT. The native side turns the salt string
 *      into bytes per `saltEncoding` (RNArgon2Module.java:67-68,
 *      RNArgon2.swift:21-27: 'hex' -> hex-decode, otherwise UTF-8) and the
 *      argon2 reference encoder embeds *unpadded base64 of those bytes* in
 *      the PHC string. So what you pass in is NOT what you read back out of
 *      the encoded hash. This mock now reproduces that transformation, which
 *      is the only reason the create->verify round-trip test is honest.
 *
 * Signature mirrors the runtime library's positional form:
 *   argon2(password: string, salt: string, options?: Argon2Options)
 */
import {createHash} from 'node:crypto';

interface Argon2Options {
  iterations?: number;
  memory?: number;
  parallelism?: number;
  hashLength?: number;
  mode?: 'argon2i' | 'argon2d' | 'argon2id';
  /** index.d.ts:8 — 'utf8' is the default, for backward compatibility. */
  saltEncoding?: 'utf8' | 'hex';
}

/** index.d.ts:11-15 — the real shape. `encoded` does not exist. */
interface Argon2Result {
  rawHash: string;
  encodedHash: string;
}

/**
 * RNArgon2Module.java:34-61 (`hexStringToByteArray`) + :67-68, mirrored by
 * RNArgon2.swift:21-33. A 'hex' salt is decoded to bytes and REJECTED when
 * malformed; anything else is consumed as raw UTF-8 bytes of the string.
 */
function toSaltBytes(salt: string, encoding: 'utf8' | 'hex'): Buffer {
  if (encoding.toLowerCase() === 'hex') {
    if (!salt) {throw new Error('Hex salt cannot be null or empty');}
    if (salt.length % 2 !== 0) {throw new Error(`Hex salt must have even length, got: ${salt.length}`);}
    if (!/^[0-9a-fA-F]+$/.test(salt)) {throw new Error('Invalid hex character in salt');}
    return Buffer.from(salt, 'hex');
  }
  return Buffer.from(salt, 'utf8');
}

/** The argon2 reference encoder emits base64 WITHOUT '=' padding. */
function phcB64(b: Buffer): string {
  return b.toString('base64').replace(/[=]+$/, '');
}

export default async function argon2(
  password: string,
  salt: string,
  options?: Argon2Options,
): Promise<Argon2Result> {
  // Defaults match the native modules, not our call site: RNArgon2Module.java:70-74.
  const iter = options?.iterations ?? 2;
  const mem  = options?.memory ?? 32 * 1024;
  const par  = options?.parallelism ?? 1;
  const mode = options?.mode ?? 'argon2id';
  const saltBytes = toSaltBytes(salt, options?.saltEncoding ?? 'utf8');

  // Deterministic stand-in: sha256(saltBytes || password). Not a KDF, just
  // a stable digest so a round-trip either matches or provably does not.
  const digest = createHash('sha256').update(saltBytes).update(Buffer.from(password, 'utf8')).digest();
  const rawHash = digest.toString('hex');
  const encodedHash =
    `$${mode}$v=19$m=${mem},t=${iter},p=${par}$${phcB64(saltBytes)}$${phcB64(digest)}`;
  return {rawHash, encodedHash};
}
