/**
 * Audit P1-B2 — restore resumes across cold start.
 *
 * Pre-fix: a kill / OS-doze / OOM mid-restore left the local SQL store
 * partially populated and AsyncStorage empty of any cursor record. On
 * relaunch the restore began from cursor=0 and walked every page the
 * client had ALREADY paged in. With 100K-message backups this meant
 * restore latency doubled (or worse) under any interruption.
 *
 * Fix: persist a {cursorTs, cursorId} pair to AsyncStorage at the END
 * of every successful page upsert. On the next restore-attempt, the
 * cursor seeds the paging loop so we pick up where we left off.
 *
 * Clear the record on successful completion so a fresh restore on a
 * different account doesn't inherit the stale tail.
 */
import {
  RESTORE_CURSOR_KEY_PREFIX,
  ARCHIVE_CURSOR_KEY_PREFIX,
  readRestoreCursor,
  writeRestoreCursor,
  clearRestoreCursor,
  markRestoreIncomplete,
  isRestoreIncomplete,
  markArchiveReplayIncomplete,
  clearArchiveReplayIncomplete,
  isArchiveReplayIncomplete,
  readArchiveCursor,
  writeArchiveCursor,
  clearArchiveCursor,
  clearRestoreState,
} from '../backup/restoreResume';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

describe('Audit P1-B2 — restore cursor persistence', () => {
  beforeEach(async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.clear();
  });

  it('writes and reads back a per-user cursor', async () => {
    await writeRestoreCursor('user-1', {cursorTs: '2026-01-15T10:00:00.000Z', cursorId: 'm-100'});
    const cur = await readRestoreCursor('user-1');
    expect(cur).toEqual({cursorTs: '2026-01-15T10:00:00.000Z', cursorId: 'm-100'});
  });

  it('returns null when no cursor was ever written', async () => {
    const cur = await readRestoreCursor('user-new');
    expect(cur).toBeNull();
  });

  it('per-user isolation — one user does not see another\'s cursor', async () => {
    await writeRestoreCursor('alice', {cursorTs: '2026-01-15T10:00:00.000Z', cursorId: 'a-1'});
    await writeRestoreCursor('bob',   {cursorTs: '2026-02-01T11:00:00.000Z', cursorId: 'b-1'});
    expect(await readRestoreCursor('alice')).toEqual({cursorTs: '2026-01-15T10:00:00.000Z', cursorId: 'a-1'});
    expect(await readRestoreCursor('bob')).toEqual({cursorTs: '2026-02-01T11:00:00.000Z', cursorId: 'b-1'});
  });

  it('clearRestoreCursor removes the entry so the next attempt starts fresh', async () => {
    await writeRestoreCursor('user-1', {cursorTs: 't', cursorId: 'id'});
    await clearRestoreCursor('user-1');
    expect(await readRestoreCursor('user-1')).toBeNull();
  });

  it('rejects a malformed stored value (defensive)', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(`${RESTORE_CURSOR_KEY_PREFIX}user-1`, 'not-json');
    expect(await readRestoreCursor('user-1')).toBeNull();
  });

  it('rejects a value missing the cursorId field', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(`${RESTORE_CURSOR_KEY_PREFIX}user-1`, JSON.stringify({cursorTs: 't'}));
    expect(await readRestoreCursor('user-1')).toBeNull();
  });

  it('no-op writes when userId is empty', async () => {
    await writeRestoreCursor('', {cursorTs: 't', cursorId: 'id'});
    expect(await readRestoreCursor('')).toBeNull();
  });
});

// P1-B-1 — the sealed-archive drain has its own per-owner incomplete
// marker + (timestampMs, envelopeId) tuple cursor, so a killed/errored
// drain is detected at boot and resumes instead of silently abandoning
// the un-replayed tail.
describe('P1-B-1 — archive-replay marker + cursor', () => {
  beforeEach(async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.clear();
  });

  it('marker round-trips per owner', async () => {
    expect(await isArchiveReplayIncomplete('alice')).toBe(false);
    await markArchiveReplayIncomplete('alice');
    expect(await isArchiveReplayIncomplete('alice')).toBe(true);
    expect(await isArchiveReplayIncomplete('bob')).toBe(false);
    await clearArchiveReplayIncomplete('alice');
    expect(await isArchiveReplayIncomplete('alice')).toBe(false);
  });

  it('cursor round-trips per owner', async () => {
    await writeArchiveCursor('alice', {cursorMs: 1700000000000, cursorId: 'env-9'});
    expect(await readArchiveCursor('alice')).toEqual({cursorMs: 1700000000000, cursorId: 'env-9'});
    expect(await readArchiveCursor('bob')).toBeNull();
    await clearArchiveCursor('alice');
    expect(await readArchiveCursor('alice')).toBeNull();
  });

  it('rejects malformed archive cursor values', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(`${ARCHIVE_CURSOR_KEY_PREFIX}u1`, 'not-json');
    expect(await readArchiveCursor('u1')).toBeNull();
    await AsyncStorage.setItem(`${ARCHIVE_CURSOR_KEY_PREFIX}u1`, JSON.stringify({cursorMs: 'NaN', cursorId: 'x'}));
    expect(await readArchiveCursor('u1')).toBeNull();
    await AsyncStorage.setItem(`${ARCHIVE_CURSOR_KEY_PREFIX}u1`, JSON.stringify({cursorMs: 5}));
    expect(await readArchiveCursor('u1')).toBeNull();
  });

  it('clearRestoreState (M-17) clears BOTH restore and archive resume state', async () => {
    await writeRestoreCursor('u1', {cursorTs: 't', cursorId: 'id'});
    await markRestoreIncomplete('u1');
    await writeArchiveCursor('u1', {cursorMs: 42, cursorId: 'e-1'});
    await markArchiveReplayIncomplete('u1');
    await clearRestoreState('u1');
    expect(await readRestoreCursor('u1')).toBeNull();
    expect(await isRestoreIncomplete('u1')).toBe(false);
    expect(await readArchiveCursor('u1')).toBeNull();
    expect(await isArchiveReplayIncomplete('u1')).toBe(false);
  });
});
