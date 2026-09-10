/**
 * P1-B-1 — resumable sealed-envelope archive drain.
 *
 * The `sealed_envelope_archive` replay recovers every message received
 * while the client mirror was locked (the reinstall window). It used to
 * live inline in BackupRestoreScreen with three defects:
 *
 *   1. The H-2 restore-incomplete marker was cleared BEFORE the drain
 *      ran, so a kill mid-drain (Doze/OOM) left the next boot believing
 *      the restore completed — the archive was never re-pulled and those
 *      messages were permanently absent.
 *   2. Any drain error was caught, logged, and fell through to the
 *      SUCCESS overlay — fail-silent.
 *   3. The (timestampMs, envelopeId) tuple cursor was a loop local, so
 *      partial progress was always discarded.
 *
 * This module owns the loop: it arms a per-owner `archive-replay-
 * incomplete` marker before the first page, persists the tuple cursor
 * after every page (mirroring restoreResume's message cursor), and
 * clears marker + cursor only after the walk reaches a natural end.
 * Page-fetch errors PROPAGATE so the caller can surface a retry state;
 * the marker + cursor survive, and both the boot gate (RESTORE-RESUME)
 * and the next manual retry resume from the persisted cursor instead of
 * re-walking (or worse, skipping) the archive.
 *
 * Per-envelope replay failures are swallowed (a single poison envelope
 * must not wedge the drain forever) — EXCEPT transient local SQL failures
 * (db_closed/BUSY, AUDIT #11): those abort the drain with the resume
 * state intact, because skipping them advanced the cursor past a
 * perfectly good envelope and the archive expires in 30 days.
 */
import {backupClient} from './backupClient';
import {
  readArchiveCursor, writeArchiveCursor, clearArchiveCursor,
  markArchiveReplayIncomplete, clearArchiveReplayIncomplete,
} from './restoreResume';
import {isTransientSqlError} from '../runtime/receiveTransaction';

export interface ArchivedEnvelope {
  envelopeId:  string;
  outerSealed: string;
  timestampMs: number;
}

export async function drainSealedArchive(
  ownerUserId: string,
  replay: (env: ArchivedEnvelope) => Promise<boolean>,
  opts: {onProgress?: (replayed: number) => void} = {},
): Promise<{replayed: number; incomplete: boolean; transient?: boolean}> {
  // Arm the marker BEFORE the first fetch so a kill anywhere inside the
  // drain is detected on the next boot.
  await markArchiveReplayIncomplete(ownerUserId);
  const resume = await readArchiveCursor(ownerUserId);
  let cursorMs: number | undefined = resume?.cursorMs;
  let cursorId: string | undefined = resume?.cursorId;
  if (resume) {
    console.log(`[bravo.restore.archive] resuming from cursor ms=${resume.cursorMs} id=${resume.cursorId.slice(0, 8)}`);
  }
  let replayed = 0;
  // BUG-S (audit 2026-07-23) — mirror restoreAllMessages' L-10: only an
  // EMPTY page proves the archive is drained. Exhausting the page cap
  // used to fall through to the marker/cursor clear, declaring a
  // truncated drain "durable-complete" and permanently abandoning the
  // un-replayed tail.
  let reachedEnd = false;
  // Round 8 — tuple cursor (sinceMs, sinceId) + 1000-page cap. Short
  // pages don't break the loop; only an empty page confirms the end.
  for (let page = 0; page < 1000; page++) {
    const {envelopes} = await backupClient.getSealedArchive(cursorMs, 500, cursorId);
    if (envelopes.length === 0) {reachedEnd = true; break;}
    for (const env of envelopes) {
      try {
        const ok = await replay(env);
        if (ok) {replayed++;}
      } catch (e) {
        // AUDIT #11 rev-5 (edge) — a TRANSIENT local failure (db_closed
        // mid-rebuild, BUSY) says nothing about the envelope, but the
        // warn-skip below let the cursor advance PAST it and the sealed
        // archive expires in 30 days — permanent loss. Abort instead: the
        // incomplete marker + last durable cursor make the next drain
        // resume from this page (replays are dedup-idempotent).
        if (isTransientSqlError(e)) {
          console.warn(`[bravo.restore.archive] transient local failure at ${env.envelopeId.slice(0, 8)} — aborting drain to resume later: ${(e as Error).message}`);
          // `transient` distinguishes this abort from the page-cap
          // `incomplete` (critic rev-5): the caller's keep-draining loop
          // must BREAK here, not re-fetch the same page against the same
          // broken handle 20 times.
          return {replayed, incomplete: true, transient: true};
        }
        console.warn(`[bravo.restore.archive] replay skipped ${env.envelopeId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    const tail = envelopes[envelopes.length - 1];
    cursorMs = tail.timestampMs;
    cursorId = tail.envelopeId;
    await writeArchiveCursor(ownerUserId, {cursorMs, cursorId});
    try { opts.onProgress?.(replayed); } catch { /* observer fault — never abort */ }
  }
  if (!reachedEnd) {
    console.warn(`[bravo.restore.archive] page cap hit at ${replayed} replayed — drain INCOMPLETE, will resume`);
    return {replayed, incomplete: true};
  }
  // Natural end — the drain is durable-complete; disarm resume state.
  await clearArchiveCursor(ownerUserId);
  await clearArchiveReplayIncomplete(ownerUserId);
  return {replayed, incomplete: false};
}
