/**
 * sqa.md bug register — this suite pins: B-182.
 *
 * BUG-U transient fetch failures propagate instead of faking no_snapshot = B-182.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BUG-U (audit 2026-07-23) — httpSnapshotTransport.fetchLatest.
 *
 * The fetch side used to swallow EVERY BackupError as "no snapshot", so
 * one transient 30s timeout during a fresh-install restore silently
 * skipped the whole Phase-2 ratchet recovery — every message encrypted
 * under the old chains before peers re-handshook was permanently lost,
 * with nothing but a console line. Now only "backend genuinely has no
 * snapshot" (`service_disabled` / `no_backup`) maps to null; transient
 * failures propagate so the caller's retry loop runs. The upload side's
 * M-16/F9 split (already correct) is pinned alongside.
 */

jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      getSessions: jest.fn(),
      putSessions: jest.fn(),
    },
  };
});

import {makeHttpSnapshotTransport} from '../backup/httpSnapshotTransport';
import {backupClient, BackupError} from '../backup/backupClient';

const getSessions = backupClient.getSessions as jest.Mock;
const putSessions = backupClient.putSessions as jest.Mock;

describe('BUG-U — snapshot transport failure semantics', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('fetchLatest returns the snapshot row when present, null when absent', async () => {
    const t = makeHttpSnapshotTransport();
    getSessions.mockResolvedValueOnce({blob: 'b64', seq: 7});
    await expect(t.fetchLatest()).resolves.toEqual({blob: 'b64', seq: 7});
    getSessions.mockResolvedValueOnce(null);
    await expect(t.fetchLatest()).resolves.toBeNull();
  });

  it('fetchLatest maps ONLY service_disabled / no_backup to null', async () => {
    const t = makeHttpSnapshotTransport();
    getSessions.mockRejectedValueOnce(new BackupError('service_disabled', 'sd'));
    await expect(t.fetchLatest()).resolves.toBeNull();
    getSessions.mockRejectedValueOnce(new BackupError('no_backup', 'nb'));
    await expect(t.fetchLatest()).resolves.toBeNull();
  });

  it('fetchLatest PROPAGATES transient failures instead of faking no_snapshot', async () => {
    const t = makeHttpSnapshotTransport();
    for (const kind of ['network', 'server', 'unauthorized', 'locked'] as const) {
      getSessions.mockRejectedValueOnce(new BackupError(kind, kind));
      await expect(t.fetchLatest()).rejects.toMatchObject({kind});
    }
    // Non-BackupError (programming bug) also re-throws.
    getSessions.mockRejectedValueOnce(new TypeError('boom'));
    await expect(t.fetchLatest()).rejects.toThrow('boom');
  });

  it('upload swallows only the no-backend cases and propagates the rest (M-16/F9)', async () => {
    const t = makeHttpSnapshotTransport();
    putSessions.mockRejectedValueOnce(new BackupError('service_disabled', 'sd'));
    await expect(t.upload({blob: 'x', seq: 1})).resolves.toEqual({ok: true});
    putSessions.mockRejectedValueOnce(new BackupError('network', 'net'));
    await expect(t.upload({blob: 'x', seq: 1})).rejects.toMatchObject({kind: 'network'});
  });
});
