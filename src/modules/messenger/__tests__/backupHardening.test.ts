/**
 * Coverage for the audit-remediation hardening helpers:
 *   • M-1 — assertKdfParamsWithinBounds (reject OOM/DoS/tamper params)
 *   • Finding 9 — humanizeBackupError (no raw codes shown to users)
 */
import {
  assertKdfParamsWithinBounds, DEFAULT_KDF_PARAMS, type KdfParams,
  aesGcmEncrypt, aesGcmDecrypt, backupAad, generateMasterKey,
} from '../backup/backupCrypto';
import {humanizeBackupError} from '../backup/backupErrorCopy';

describe('assertKdfParamsWithinBounds (M-1)', () => {
  const legacy: KdfParams = {
    algo: 'argon2id', memoryKib: 64 * 1024, iterations: 3,
    parallelism: 1, saltBytes: 16, derivedKeyBytes: 32,
  };

  it('accepts the current default params', () => {
    expect(() => assertKdfParamsWithinBounds(DEFAULT_KDF_PARAMS)).not.toThrow();
  });

  it('accepts legacy (64 MiB / 3-iter) params so old backups still restore', () => {
    expect(() => assertKdfParamsWithinBounds(legacy)).not.toThrow();
  });

  it('rejects an absurd memory cost (8 GiB) that would crash native argon2', () => {
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, memoryKib: 8 * 1024 * 1024}))
      .toThrow(/kdf_memory_out_of_range/);
  });

  it('rejects zero / non-integer iterations', () => {
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, iterations: 0}))
      .toThrow(/kdf_iterations_out_of_range/);
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, iterations: Number.NaN}))
      .toThrow(/kdf_iterations_out_of_range/);
  });

  it('rejects a wrong derived-key length', () => {
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, derivedKeyBytes: 16}))
      .toThrow(/kdf_derived_key_bytes_invalid/);
  });

  it('rejects an unsupported algorithm', () => {
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, algo: 'pbkdf2' as unknown as 'argon2id'}))
      .toThrow(/kdf_algo_unsupported/);
  });

  it('rejects out-of-range parallelism', () => {
    expect(() => assertKdfParamsWithinBounds({...DEFAULT_KDF_PARAMS, parallelism: 99}))
      .toThrow(/kdf_parallelism_out_of_range/);
  });
});

describe('AES-GCM AAD context-binding (M-3)', () => {
  const enc = new TextEncoder();
  const pt = enc.encode('the quick brown fox');

  it('round-trips when encrypt + decrypt use the same AAD', async () => {
    const {key} = await generateMasterKey();
    const aad = backupAad('msg', 'owner-1', 'msg-abc');
    const blob = await aesGcmEncrypt(key, pt, aad);
    const out = await aesGcmDecrypt(key, blob, aad);
    expect(new TextDecoder().decode(out)).toBe('the quick brown fox');
  });

  it('REJECTS a blob decrypted under a DIFFERENT AAD (mix-and-match swap)', async () => {
    const {key} = await generateMasterKey();
    const blob = await aesGcmEncrypt(key, pt, backupAad('msg', 'owner-1', 'msg-abc'));
    // Same key, wrong context — the swap the audit describes.
    await expect(aesGcmDecrypt(key, blob, backupAad('msg', 'owner-1', 'msg-XYZ')))
      .rejects.toThrow();
  });

  it('legacy blob (encrypted WITHOUT AAD) still decrypts when AAD is supplied (fallback)', async () => {
    const {key} = await generateMasterKey();
    const legacy = await aesGcmEncrypt(key, pt);                 // no AAD (old writer)
    const out = await aesGcmDecrypt(key, legacy, backupAad('msg', 'owner-1', 'msg-abc'));
    expect(new TextDecoder().decode(out)).toBe('the quick brown fox');
  });

  it('an AAD-bound blob cannot be read with NO AAD (context stripped)', async () => {
    const {key} = await generateMasterKey();
    const blob = await aesGcmEncrypt(key, pt, backupAad('msg', 'owner-1', 'msg-abc'));
    await expect(aesGcmDecrypt(key, blob)).rejects.toThrow();
  });
});

describe('humanizeBackupError (finding 9)', () => {
  it('maps known internal codes to human copy', () => {
    expect(humanizeBackupError('messenger_not_ready')).toMatch(/starting up/i);
    expect(humanizeBackupError('not_logged_in')).toMatch(/signed in/i);
    expect(humanizeBackupError('probe_failed_retry')).toMatch(/connection/i);
    expect(humanizeBackupError('verifier_missing')).toMatch(/re-secured|re-secure/i);
  });

  it('maps prefixed codes (e.g. "setup_failed: <detail>")', () => {
    expect(humanizeBackupError('setup_failed: boom')).toMatch(/setup failed/i);
    expect(humanizeBackupError('Restore failed: root_mismatch')).toMatch(/restore failed/i);
  });

  it('BKRES-27 — a known code inside a wrapped message wins over the generic prefix', () => {
    const nonceCopy = 'That took too long — please try again.';
    expect(humanizeBackupError('nonce_expired')).toBe(nonceCopy);
    // The screens wrap BackupError kinds as 'Restore failed: <kind>' —
    // the dedicated copy must still win over the generic restore line.
    expect(humanizeBackupError('Restore failed: nonce_expired')).toBe(nonceCopy);
    expect(humanizeBackupError('setup_failed: nonce_expired')).toBe(nonceCopy);
    // Unknown detail still falls back to the prefix copy (regression).
    expect(humanizeBackupError('Restore failed: some_new_kind')).toMatch(/restore failed/i);
  });

  it('passes an already-human sentence through unchanged', () => {
    const sentence = 'Wrong password. Please try again.';
    expect(humanizeBackupError(sentence)).toBe(sentence);
  });

  it('never leaks an unknown short code — falls back to a generic message', () => {
    const out = humanizeBackupError('weird_token_xyz');
    expect(out).not.toContain('weird_token_xyz');
    expect(out).toMatch(/something went wrong/i);
  });

  it('returns empty string for empty/nullish input', () => {
    expect(humanizeBackupError('')).toBe('');
    expect(humanizeBackupError(null)).toBe('');
    expect(humanizeBackupError(undefined)).toBe('');
  });
});
