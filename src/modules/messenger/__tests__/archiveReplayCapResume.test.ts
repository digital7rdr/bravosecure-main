/**
 * sqa.md bug register — this suite pins: B-181.
 *
 * BUG-S page-cap hit reports incomplete and keeps marker+cursor = B-181.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BUG-S (audit 2026-07-23) — drainSealedArchive page-cap honesty.
 *
 * Exhausting the 1000-page cap used to fall through to the marker/cursor
 * clear, declaring a TRUNCATED drain "durable-complete" and permanently
 * abandoning the un-replayed tail (the archive expires within 30 days).
 * The drain now reports `incomplete: true` and leaves the resume state
 * armed — mirroring restoreAllMessages' L-10.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

const mockGetSealedArchive = jest.fn();
jest.mock('../backup/backupClient', () => ({
  __esModule: true,
  backupClient: {
    getSealedArchive: (...a: unknown[]) => mockGetSealedArchive(...a),
  },
}));

import {drainSealedArchive} from '../backup/archiveReplay';
import {
  isArchiveReplayIncomplete, readArchiveCursor, clearArchiveCursor,
  clearArchiveReplayIncomplete,
} from '../backup/restoreResume';

const OWNER = 'owner-1';

describe('BUG-S — sealed-archive drain page-cap', () => {
  beforeEach(async () => {
    mockGetSealedArchive.mockReset();
    await clearArchiveCursor(OWNER);
    await clearArchiveReplayIncomplete(OWNER);
  });

  it('a cap-hit walk reports incomplete and keeps marker + cursor armed', async () => {
    // Never-empty pages: one envelope per page, monotonically advancing.
    let n = 0;
    mockGetSealedArchive.mockImplementation(async () => {
      n += 1;
      return {envelopes: [{envelopeId: `env-${n}`, outerSealed: 'b64', timestampMs: n}]};
    });
    const res = await drainSealedArchive(OWNER, async () => true);
    expect(res.incomplete).toBe(true);
    expect(res.replayed).toBe(1000);
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(true);
    const cursor = await readArchiveCursor(OWNER);
    expect(cursor?.cursorMs).toBe(1000);

    // The NEXT drain resumes from the persisted cursor…
    mockGetSealedArchive.mockImplementation(async (sinceMs?: unknown) => {
      expect(sinceMs).toBe(1000);
      return {envelopes: []};
    });
    const res2 = await drainSealedArchive(OWNER, async () => true);
    // …and a natural end finally disarms the resume state.
    expect(res2.incomplete).toBe(false);
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(false);
    expect(await readArchiveCursor(OWNER)).toBeNull();
  });

  it('a natural end on the first walk clears the resume state (unchanged behaviour)', async () => {
    mockGetSealedArchive
      .mockResolvedValueOnce({envelopes: [{envelopeId: 'e-1', outerSealed: 'b', timestampMs: 5}]})
      .mockResolvedValueOnce({envelopes: []});
    const res = await drainSealedArchive(OWNER, async () => true);
    expect(res).toEqual({replayed: 1, incomplete: false});
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(false);
  });
});
