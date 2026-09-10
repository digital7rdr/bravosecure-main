/**
 * checkServerSeqAnchor — pure server-seq comparison helper.
 *
 * NOTE (BS-BACKUP-ROLLBACK): this helper is NO LONGER WIRED into
 * verifyMerkleCommit's production path. The original Audit P0-B3 gate
 * fed it `commitSeq` (Merkle-commit counter) vs `serverSeq` (session-
 * snapshot counter) — two UNRELATED monotonic counters that advance at
 * different rates, so it produced false-positive `server_rollback`
 * failures on healthy backups (observed live: commit=2 vs sessions=6 on
 * an account that had just backed up). verifyMerkleCommit now relies on
 * the commit signature (covers `seq`) + the like-for-like local
 * COMMIT-seq rollback check instead. See the long comment in
 * merkleCommit.ts where the gate used to be.
 *
 * The tests below still assert the helper's PURE behaviour (it's
 * exported + retained for any future like-for-like server-anchored
 * commit-seq gate), but its result no longer fails a restore.
 */

// The module under test pulls in @react-native-async-storage/async-storage
// + react-native-keychain at import time via the surrounding
// `merkleCommit.ts` file. They're not relevant to the pure helper, but
// jest-Node still resolves them. Provide minimal mocks.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('react-native-keychain', () => ({
  __esModule: true,
  SECURITY_LEVEL: {SECURE_HARDWARE: 'sh', SECURE_SOFTWARE: 'ss'},
  ACCESSIBLE: {
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'a',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY:     'b',
  },
  setGenericPassword: async () => true,
  getGenericPassword: async () => false,
  resetGenericPassword: async () => true,
}));

// backupClient is reached transitively. Stub it so the import doesn't
// pull in the constants module.
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) {
      super(msg); this.name = 'BackupError'; this.kind = kind;
    }
  }
  return {
    __esModule: true,
    backupClient: {getSessions: async () => null, getMerkleCommit: async () => null},
    BackupError,
  };
});

import {checkServerSeqAnchor} from '../backup/merkleCommit';

describe('Audit P0-B3 — server-anchored Merkle seq anchor', () => {
  it('rejects when server sessions seq is HIGHER than commit seq (replay)', () => {
    const v = checkServerSeqAnchor({commitSeq: 5, serverSeq: 9});
    expect(v.ok).toBe(false);
    if (!v.ok) {expect(v.reason).toBe('server_rollback');}
  });

  it('accepts when commit seq equals server sessions seq', () => {
    const v = checkServerSeqAnchor({commitSeq: 9, serverSeq: 9});
    expect(v.ok).toBe(true);
  });

  it('accepts when commit seq is GREATER than server sessions seq', () => {
    const v = checkServerSeqAnchor({commitSeq: 10, serverSeq: 9});
    expect(v.ok).toBe(true);
  });

  it('degrades to legacy local-only mode when server returns null', () => {
    // Pre-Sprint-6 server / endpoint not deployed — degrade rather than
    // refuse the restore wholesale. The local-only seq check still
    // fires inside verifyMerkleCommit for the cached-device case.
    const v = checkServerSeqAnchor({commitSeq: 1, serverSeq: null});
    expect(v.ok).toBe(true);
  });

  it('treats non-finite server seq as no-anchor', () => {
    const v = checkServerSeqAnchor({commitSeq: 1, serverSeq: NaN});
    expect(v.ok).toBe(true);
  });
});
