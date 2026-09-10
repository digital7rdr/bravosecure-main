/**
 * B-94 — persistent mirror-flush ledger + pending-commit flag.
 *
 * Why this module exists: the backup mirror's dedup (`seenIds` in
 * messageMirror.ts) is in-memory only, so every boot the catch-up sweep
 * re-enqueued the ENTIRE local store. Each re-mirror re-encrypts the row
 * with a fresh AES-GCM IV — new server bytes for the same message_id —
 * and the signed Merkle commit only trails the uploads. Every app launch
 * therefore rewrote the whole server row set and re-opened the "rows
 * uploaded but commit still pending" kill-window; a kill inside it left
 * the server bytes ahead of the last signed root at EQUAL row count,
 * which the restore verifier deliberately hard-fails (`root_mismatch`,
 * P2-B-1) and which a fresh-install restore can never repair (B-81's
 * repair correctly refuses without local history). That is the recurring
 * B-45r3 / B-50 / B-81 / B-94 failure class.
 *
 * Two persistent pieces close it:
 *
 *   1. `mirror_flushed` (SQLCipher, schema v14) — (owner, message_id) →
 *      version hash of the last row version that SUCCESSFULLY uploaded.
 *      The boot sweep hydrates the in-memory dedup from it, so an idle
 *      boot uploads nothing and the server bytes only change when a row
 *      genuinely changed.
 *   2. `bravo:backup:merkle-pending:<owner>` (AsyncStorage) — set after
 *      every successful row flush, cleared only after a signed commit
 *      ships with no interleaved flush (see the flush-epoch guard). A
 *      session killed inside the window leaves the flag set; the next
 *      boot sweep sees it and fires a walk-and-sign commit even when it
 *      uploaded nothing, healing the drift BEFORE any restore elsewhere
 *      can dead-end on it.
 *
 * Storage notes: versions are 32-bit FNV-1a hashes of the serialized
 * message (no plaintext, no key material); the pending flag is a bare
 * boolean. Every function here is best-effort — a missing DB or a failed
 * write degrades to the pre-B-94 behaviour (re-upload + re-commit),
 * never to data loss.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {DbHandle} from '../crypto/db';

const PENDING_KEY_PREFIX = 'bravo:backup:merkle-pending:';
/** SQLite's default max bind-parameter count is 999; 4 params per row. */
const UPSERT_CHUNK = 100;

export interface FlushedEntry {
  messageId: string;
  version:   string;
}

let testDb: DbHandle | null | undefined;
/** Test seam — pass a fake DbHandle, or null to simulate "no DB". */
export function _setLedgerDbForTests(db: DbHandle | null | undefined): void {
  testDb = db;
}

function ledgerDb(): DbHandle | null {
  if (testDb !== undefined) {return testDb;}
  try {
    const {getOwnCryptoStore} = require('../runtime/runtime') as typeof import('../runtime/runtime');
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as typeof import('../crypto/sqlCipherStore');
    const store = getOwnCryptoStore();
    if (store && store instanceof SqlCipherProtocolStore) {
      return store.getDb();
    }
  } catch { /* runtime not booted / native store unavailable — degrade */ }
  return null;
}

/**
 * Read the full flushed-version map for an owner. Empty map when the DB
 * is unavailable — callers then behave exactly like the pre-B-94 sweep.
 */
export async function loadFlushedVersions(ownerUserId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ownerUserId) {return out;}
  const db = ledgerDb();
  if (!db) {return out;}
  try {
    const res = await db.execute(
      'SELECT message_id, version FROM mirror_flushed WHERE owner_user_id = ?',
      [ownerUserId],
    );
    for (const row of (res.rows ?? []) as Array<{message_id: string; version: string}>) {
      out.set(row.message_id, row.version);
    }
  } catch (e) {
    console.warn('[backup.ledger] load failed:', (e as Error).message);
    out.clear();
  }
  return out;
}

/**
 * Record versions that just SUCCEEDED an upload (or, on the restore
 * path, versions the server verifiably already holds). Chunked
 * multi-VALUES upserts in autocommit mode — deliberately NO explicit
 * BEGIN/COMMIT: this connection is shared with the receive transaction
 * (`runWithRatchetTxn`) and a nested BEGIN throws (audit P0-1 class).
 * A ledger row lost to an ambient rollback is benign: the row is
 * re-uploaded on the next sweep.
 */
export async function recordFlushedVersions(
  ownerUserId: string,
  entries: readonly FlushedEntry[],
): Promise<boolean> {
  if (!ownerUserId || entries.length === 0) {return true;}
  const db = ledgerDb();
  if (!db) {return false;}
  const now = Date.now();
  try {
    for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
      const chunk = entries.slice(i, i + UPSERT_CHUNK);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const params: Array<string | number> = [];
      for (const e of chunk) {
        params.push(ownerUserId, e.messageId, e.version, now);
      }
      await db.execute(
        `INSERT OR REPLACE INTO mirror_flushed (owner_user_id, message_id, version, updated_at) VALUES ${values}`,
        params,
      );
    }
    return true;
  } catch (e) {
    console.warn('[backup.ledger] record failed:', (e as Error).message);
    return false;
  }
}

/**
 * Purge the owner's ledger. Used by the B-81 repair flow BEFORE its full
 * re-upload: repair exists precisely because the server bytes can no
 * longer be trusted to match what the ledger claims was flushed, so
 * every row must ship again and the ledger must not short-circuit that.
 */
export async function clearFlushedForOwner(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  // B-687 — every ledger purge implies the server row set is about to be
  // rewritten (repair, wipe, rotate), so the Merkle leaf cache is stale by
  // the same token. Purged HERE, not at call sites, so no I5 caller can
  // miss it (the audit-#12 per-caller-purge class). The purge also raises
  // the cache-dirty flag; the next walk-based commit rebuilds the cache.
  try {
    const {clearLeafCacheForOwner} = require('./merkleLeafCache') as typeof import('./merkleLeafCache');
    await clearLeafCacheForOwner(ownerUserId);
  } catch { /* best-effort — a stale cache is caught by the shadow compare */ }
  const db = ledgerDb();
  if (!db) {return;}
  try {
    await db.execute('DELETE FROM mirror_flushed WHERE owner_user_id = ?', [ownerUserId]);
  } catch (e) {
    console.warn('[backup.ledger] clear failed:', (e as Error).message);
  }
}

/**
 * Flush epoch — bumped by messageMirror on every successful row flush.
 * commitMerkleRoot snapshots it before its server walk and clears the
 * pending flag only if no flush landed since; otherwise the flag stays
 * set and the follow-up commit (scheduled by that very flush) or the
 * next boot sweep re-signs. Lives here (not in messageMirror) so
 * merkleCommit.ts can import it without pulling react-native into the
 * merkle test environment.
 */
let flushEpoch = 0;
export function bumpFlushEpoch(): void { flushEpoch += 1; }
export function getFlushEpoch(): number { return flushEpoch; }

/** Set after every successful row flush: a signed commit is now owed. */
export async function setMerkleCommitPending(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  try {
    await AsyncStorage.setItem(`${PENDING_KEY_PREFIX}${ownerUserId}`, '1');
  } catch { /* best-effort — an unset flag just skips the boot heal */ }
}

export async function readMerkleCommitPending(ownerUserId: string): Promise<boolean> {
  if (!ownerUserId) {return false;}
  try {
    return (await AsyncStorage.getItem(`${PENDING_KEY_PREFIX}${ownerUserId}`)) === '1';
  } catch {
    return false;
  }
}

/**
 * Clear the pending flag — but only when no flush landed after
 * `epochAtCommitStart` was captured. Without the guard, this race sets
 * up the exact drift the flag exists to heal: flush A → commit walk
 * starts → flush B lands (sets flag) → commit ships (covering pre-B
 * bytes) and blindly clears the flag → kill → server ahead of the
 * signed root with nothing left to heal it.
 */
export async function clearMerkleCommitPendingIfNoFlushSince(
  ownerUserId: string,
  epochAtCommitStart: number,
): Promise<void> {
  if (!ownerUserId) {return;}
  if (getFlushEpoch() !== epochAtCommitStart) {return;}
  try {
    await AsyncStorage.removeItem(`${PENDING_KEY_PREFIX}${ownerUserId}`);
  } catch { /* best-effort — a stale flag only costs one extra commit */ }
}
