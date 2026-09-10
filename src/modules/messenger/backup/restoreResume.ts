/**
 * Audit P1-B2 — restore cursor persistence for cold-start resume.
 *
 * Walking 100K messages takes minutes. When the OS kills the process
 * mid-restore (Doze, OOM, user kill from recents) the partial SQL
 * upserts survive but the in-memory cursor doesn't, so the next
 * relaunch starts the paging loop from scratch and pulls every page
 * the previous attempt already wrote.
 *
 * This module persists a {cursorTs, cursorId} pair to AsyncStorage at
 * the end of each successful page upsert. {@link restoreAllMessages}
 * reads it on entry and seeds the paging loop with the stored cursor.
 * The record is cleared on successful completion so a fresh account
 * restore later (different password, different identity) doesn't pick
 * up stale paging state.
 *
 * AsyncStorage is the right tier for this:
 *   • SQLCipher would force the restore loop to round-trip through the
 *     encrypted store on every flush — fine for messages, expensive
 *     for a 16-byte cursor written every page.
 *   • Keychain is wrong for a frequently-written value.
 *   • The cursor leaks nothing sensitive (it's an ISO timestamp + a
 *     UUID-ish message id). The actual message ciphertexts stay in the
 *     SQLCipher store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const RESTORE_CURSOR_KEY_PREFIX = 'bravo:backup:restore-cursor:';
// H-2 — a durable "a restore was started but not confirmed complete"
// marker. Set at the top of restoreAllMessages and cleared only on full
// success (integrity-verified + written). Boot consults it to re-enter
// the restore flow when a restore was interrupted, instead of landing
// the user on a partial/empty history.
export const RESTORE_INCOMPLETE_KEY_PREFIX = 'bravo:backup:restore-incomplete:';
// P1-B-1 — the sealed-archive replay runs AFTER restoreAllMessages has
// cleared the H-2 marker, so a kill/error mid-drain used to be invisible
// on the next boot (the archive was never re-pulled). These keys give the
// drain its own per-owner incomplete marker + (timestampMs, envelopeId)
// tuple cursor, mirroring the message-restore pair above.
export const ARCHIVE_REPLAY_INCOMPLETE_KEY_PREFIX = 'bravo:backup:archive-replay-incomplete:';
export const ARCHIVE_CURSOR_KEY_PREFIX = 'bravo:backup:archive-cursor:';

export interface RestoreCursor {
  cursorTs: string;
  cursorId: string;
}

export interface ArchiveCursor {
  cursorMs: number;
  cursorId: string;
}

export async function readRestoreCursor(userId: string): Promise<RestoreCursor | null> {
  if (!userId) {return null;}
  try {
    const raw = await AsyncStorage.getItem(`${RESTORE_CURSOR_KEY_PREFIX}${userId}`);
    if (!raw) {return null;}
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {return null;}
    const o = parsed as {cursorTs?: unknown; cursorId?: unknown};
    if (typeof o.cursorTs !== 'string' || typeof o.cursorId !== 'string') {return null;}
    if (o.cursorTs.length === 0 || o.cursorId.length === 0) {return null;}
    return {cursorTs: o.cursorTs, cursorId: o.cursorId};
  } catch {
    return null;
  }
}

export async function writeRestoreCursor(userId: string, c: RestoreCursor): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.setItem(
      `${RESTORE_CURSOR_KEY_PREFIX}${userId}`,
      JSON.stringify({cursorTs: c.cursorTs, cursorId: c.cursorId}),
    );
  } catch {
    /* best-effort — losing the resume hint is a UX regression, not a
       correctness one (next restore starts from 0 like the pre-P1-B2
       behaviour). */
  }
}

export async function clearRestoreCursor(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.removeItem(`${RESTORE_CURSOR_KEY_PREFIX}${userId}`);
  } catch {
    /* swallow — same rationale as writeRestoreCursor. */
  }
}

// ─── H-2 — restore-incomplete marker ─────────────────────────────────

export async function markRestoreIncomplete(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.setItem(`${RESTORE_INCOMPLETE_KEY_PREFIX}${userId}`, '1');
  } catch { /* best-effort */ }
}

export async function clearRestoreIncomplete(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.removeItem(`${RESTORE_INCOMPLETE_KEY_PREFIX}${userId}`);
  } catch { /* best-effort */ }
}

export async function isRestoreIncomplete(userId: string): Promise<boolean> {
  if (!userId) {return false;}
  try {
    return (await AsyncStorage.getItem(`${RESTORE_INCOMPLETE_KEY_PREFIX}${userId}`)) === '1';
  } catch {
    return false;
  }
}

// ─── P1-B-1 — sealed-archive replay marker + cursor ──────────────────

export async function markArchiveReplayIncomplete(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.setItem(`${ARCHIVE_REPLAY_INCOMPLETE_KEY_PREFIX}${userId}`, '1');
  } catch { /* best-effort */ }
}

export async function clearArchiveReplayIncomplete(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.removeItem(`${ARCHIVE_REPLAY_INCOMPLETE_KEY_PREFIX}${userId}`);
  } catch { /* best-effort */ }
}

export async function isArchiveReplayIncomplete(userId: string): Promise<boolean> {
  if (!userId) {return false;}
  try {
    return (await AsyncStorage.getItem(`${ARCHIVE_REPLAY_INCOMPLETE_KEY_PREFIX}${userId}`)) === '1';
  } catch {
    return false;
  }
}

export async function readArchiveCursor(userId: string): Promise<ArchiveCursor | null> {
  if (!userId) {return null;}
  try {
    const raw = await AsyncStorage.getItem(`${ARCHIVE_CURSOR_KEY_PREFIX}${userId}`);
    if (!raw) {return null;}
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {return null;}
    const o = parsed as {cursorMs?: unknown; cursorId?: unknown};
    if (typeof o.cursorMs !== 'number' || !Number.isFinite(o.cursorMs)) {return null;}
    if (typeof o.cursorId !== 'string' || o.cursorId.length === 0) {return null;}
    return {cursorMs: o.cursorMs, cursorId: o.cursorId};
  } catch {
    return null;
  }
}

export async function writeArchiveCursor(userId: string, c: ArchiveCursor): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.setItem(
      `${ARCHIVE_CURSOR_KEY_PREFIX}${userId}`,
      JSON.stringify({cursorMs: c.cursorMs, cursorId: c.cursorId}),
    );
  } catch { /* best-effort — same rationale as writeRestoreCursor */ }
}

export async function clearArchiveCursor(userId: string): Promise<void> {
  if (!userId) {return;}
  try {
    await AsyncStorage.removeItem(`${ARCHIVE_CURSOR_KEY_PREFIX}${userId}`);
  } catch { /* swallow */ }
}

/**
 * M-17 — clear ALL restore paging/resume state for a user. Called on the
 * "forgot password → wipe" flow and at fresh backup setup so a stale
 * cursor from an old/aborted restore can't make a later restore silently
 * skip rows at/before that cursor.
 */
export async function clearRestoreState(userId: string): Promise<void> {
  await clearRestoreCursor(userId);
  await clearRestoreIncomplete(userId);
  await clearArchiveCursor(userId);
  await clearArchiveReplayIncomplete(userId);
}
