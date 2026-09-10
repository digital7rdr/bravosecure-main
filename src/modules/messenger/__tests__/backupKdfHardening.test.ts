/**
 * Audit P0-B1 — Backup KDF hardening.
 *
 * 1. DEFAULT_KDF_PARAMS must meet the OWASP-2024 / Signal-floor profile
 *    (argon2id, mem >= 256 MiB, iters >= 4, parallelism 1). The previous
 *    profile (64 MiB, 3 iters) cracked at ~$2500 in cloud-GPU for a
 *    6-char password — under the Signal recovery-code floor and below
 *    the WhatsApp encrypted-backup parameter set.
 * 2. MIN_BACKUP_PASSWORD_CHARS is raised to 10 (Signal's documented floor
 *    for user-chosen passwords). The setup screen consumes the exported
 *    constant; bumping it here is the only knob.
 * 3. Restore MUST decrypt under the legacy 64 MiB / 3-iter / 6-char
 *    profile. The server stores `kdf_params` opaquely with the bundle,
 *    so an old backup ships its old params and the client must honour
 *    them on the way back. This is the "legacy read path" the audit
 *    plan calls for.
 */
import {
  DEFAULT_KDF_PARAMS,
  deriveMasterKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
  generateMasterKey,
  toB64,
  fromB64,
  type KdfParams,
} from '../backup/backupCrypto';
import {MIN_BACKUP_PASSWORD_CHARS} from '../backup/backupPolicy';

// react-native-argon2 is a native module — stub with a deterministic
// CPU-only fallback so the messenger-crypto Jest project (Node-only) can
// run this suite without crashing on require.
jest.mock('react-native-argon2', () => {
  const {createHash} = require('crypto') as typeof import('crypto');
  return {
    __esModule: true,
    default: async (password: string, saltHex: string, opts: {hashLength: number}) => {
      // NOTE: This stub is for test-suite use only — it is NOT argon2id.
      // We chain SHA-256 to get a deterministic byte string at the
      // requested length so the round-trip property is testable.
      let buf = createHash('sha256').update(password + ':' + saltHex).digest();
      while (buf.length < opts.hashLength) {
        buf = Buffer.concat([buf, createHash('sha256').update(buf).digest()]);
      }
      return {rawHash: buf.subarray(0, opts.hashLength).toString('hex')};
    },
  };
});

describe('Audit P0-B1 — backup KDF hardening', () => {
  it('DEFAULT_KDF_PARAMS meets the OWASP-2024 floor (mem>=256MiB, iters>=4)', () => {
    expect(DEFAULT_KDF_PARAMS.algo).toBe('argon2id');
    expect(DEFAULT_KDF_PARAMS.memoryKib).toBeGreaterThanOrEqual(256 * 1024);
    expect(DEFAULT_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_KDF_PARAMS.parallelism).toBe(1);
    expect(DEFAULT_KDF_PARAMS.derivedKeyBytes).toBe(32);
  });

  it('MIN_BACKUP_PASSWORD_CHARS is exactly 4 — founder decision 2026-08-27; any drift is a NEW decision', () => {
    // Was >= 10 (P0-B1 Signal floor). Deliberately lowered on instruction —
    // see backupPolicy.ts for the recorded tradeoff. Pinned EXACTLY so neither
    // a silent re-hardening nor a further weakening ships unnoticed.
    expect(MIN_BACKUP_PASSWORD_CHARS).toBe(4);
  });

  it('round-trips encrypt/decrypt under the new params', async () => {
    const salt = new Uint8Array(16); salt.fill(7);
    const key = await deriveMasterKey('correct horse battery staple', salt, DEFAULT_KDF_PARAMS);
    const {key: master, raw} = await generateMasterKey();
    const wrappedMaster = await aesGcmEncrypt(key, raw);

    // Roundtrip through the wire shape: ship wrappedMaster + salt + params,
    // then unwrap.
    const wrappedB64 = toB64(wrappedMaster);
    const restoredKey = await deriveMasterKey('correct horse battery staple', salt, DEFAULT_KDF_PARAMS);
    const recovered = await aesGcmDecrypt(restoredKey, fromB64(wrappedB64));
    expect(Buffer.from(recovered)).toEqual(Buffer.from(raw));
    void master;
  });

  it('legacy 64 MiB / 3-iter params still round-trip on restore', async () => {
    // The bundle header carries the kdfParams that were used at setup.
    // A backup created under the old defaults must still unwrap.
    const legacyParams: KdfParams = {
      algo:            'argon2id',
      memoryKib:       64 * 1024,
      iterations:      3,
      parallelism:     1,
      saltBytes:       16,
      derivedKeyBytes: 32,
    };
    const salt = new Uint8Array(16); salt.fill(9);
    const legacyKey = await deriveMasterKey('legacypass', salt, legacyParams);
    const {raw} = await generateMasterKey();
    const wrapped = await aesGcmEncrypt(legacyKey, raw);
    const re = await deriveMasterKey('legacypass', salt, legacyParams);
    const recovered = await aesGcmDecrypt(re, wrapped);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(raw));
  });
});
