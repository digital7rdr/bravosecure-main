/**
 * BUG-J (audit 2026-07-23) — identityBackup zeroization contract.
 *
 * restoreBackup declares zero-on-throw for the password-derived wrap key
 * (the B-45 contract), but the `getIdentityBundle` await sat OUTSIDE the
 * per-branch fills: a 403 verify-token expiry, a 30s abort, or a 5xx
 * left the 32-byte argon2-derived key live in the heap. One finally now
 * owns the fill; this drives the exact leak path and asserts the raw
 * key is zeroed when the throw surfaces.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
}));

const mockCaptured: {raw: Uint8Array | null} = {raw: null};
jest.mock('../backup/backupCrypto', () => {
  const actual = jest.requireActual('../backup/backupCrypto') as Record<string, unknown>;
  return {
    ...actual,
    __esModule: true,
    deriveMasterKeyAndRaw: async (...args: unknown[]) => {
      const fn = actual.deriveMasterKeyAndRaw as (...a: unknown[]) => Promise<{key: CryptoKey; raw: Uint8Array}>;
      const res = await fn(...args);
      mockCaptured.raw = res.raw;
      return res;
    },
  };
});

jest.mock('../backup/backupClient', () => {
  const actual = jest.requireActual('../backup/backupClient') as {BackupError: unknown};
  return {
    __esModule: true,
    BackupError: actual.BackupError,
    backupClient: {
      getIdentityHeader: jest.fn(),
      verify: jest.fn(),
      getIdentityBundle: jest.fn(),
    },
  };
});

import {restoreBackup} from '../backup/identityBackup';
import {DEFAULT_KDF_PARAMS, toB64, randomBytes} from '../backup/backupCrypto';
import {BackupError, backupClient} from '../backup/backupClient';

const mockClient = backupClient as unknown as {
  getIdentityHeader: jest.Mock;
  verify: jest.Mock;
  getIdentityBundle: jest.Mock;
};

describe('BUG-J — derived wrap key zeroed on every restore throw path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptured.raw = null;
    mockClient.getIdentityHeader.mockResolvedValue({
      userId: 'owner-1',
      verifierMissing: false,
      verifyNonce: 'nonce-1',
      verifyNonceTtlSec: 60,
      salt: toB64(randomBytes(DEFAULT_KDF_PARAMS.saltBytes)),
      kdfParams: DEFAULT_KDF_PARAMS,
      failedAttempts: 0,
      lockedUntil: null,
    });
    mockClient.verify.mockResolvedValue({verifyToken: 'tok-1', verifyTokenTtlSec: 30});
  });

  it('zeroes the derived raw key when getIdentityBundle throws (the leak lane)', async () => {
    mockClient.getIdentityBundle.mockRejectedValue(
      new (BackupError as new (k: string, m: string) => Error)('verify_required', 'verify_required'),
    );
    await expect(restoreBackup({} as never, 'correct-password')).rejects.toMatchObject({kind: 'verify_required'});
    expect(mockCaptured.raw).not.toBeNull();
    expect(Array.from(mockCaptured.raw as Uint8Array).every(b => b === 0)).toBe(true);
  });

  it('zeroes the derived raw key on a wrong-password verify reject (existing lane still holds)', async () => {
    mockClient.verify.mockRejectedValue(
      new (BackupError as new (k: string, m: string) => Error)('unauthorized', 'wrong_password'),
    );
    await expect(restoreBackup({} as never, 'wrong-password')).rejects.toMatchObject({message: 'wrong_password'});
    expect(Array.from(mockCaptured.raw as Uint8Array).every(b => b === 0)).toBe(true);
  });
});
