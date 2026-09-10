/**
 * B-687 — persistent Merkle leaf cache (SHADOW MODE).
 *
 * Why: the steady-state after-flush Merkle commit page-walks the ENTIRE
 * server backup and re-hashes every row, 5s after every flush burst —
 * O(history) network + CPU per burst, forever. The M-12 leaves path in
 * commitMerkleRoot can sign from pre-hashed leaves without a walk, but it
 * needs a complete, accurate local leaf set. This module maintains that
 * set, captured at flush time from the EXACT bytes uploaded.
 *
 * SHADOW CONTRACT (current state): the cache is OBSERVATIONAL ONLY. The
 * commit path still walks the server (authoritative, byte-untouched) and
 * merely compares the cache root against the walk root, logging
 * `[backup.merkle.shadow]` counts. Flipping to cache-authoritative commits
 * is a SEPARATE future change, gated on device soak showing zero
 * epoch-clean divergences (see DEAD_PHONE_SMOOTHNESS_PLAN.md W2).
 *
 * The make-or-break subtlety (partner-audit finding, 2026-08-28): the leaf
 * hash covers `msg_created_at` AS THE SERVER RETURNS IT. The column is
 * TIMESTAMPTZ and PostgREST serializes via Postgres `to_json`, which emits
 * `2026-08-28T12:34:56.789+00:00` with trailing fractional zeros stripped —
 * while the client uploads `Date.toISOString()` form (`…789Z`). So flush-time
 * leaves MUST transform the timestamp through `pgTimestamptzText` below, and
 * every walk-based commit rewrites the cache from server-returned strings
 * when they diverge (self-healing — including against a future Postgres/
 * PostgREST format change, which the shadow log would surface immediately).
 *
 * Dirty flag (I2-style raise-first, house pattern of setMerkleCommitPending):
 * raised BEFORE putMessages, cleared only after the covering leaf upsert
 * succeeds. A kill between upload and leaf write leaves the flag raised, so
 * a flipped commit path must never trust the cache in that state — it falls
 * back to the walk (I8 direction: degrade to walk, never skip).
 *
 * I9: rows hold message ids, timestamp strings, and sha256 digests of
 * ciphertext — no plaintext, no key material. Log lines carry counts only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {DbHandle} from '../crypto/db';
import {computeLeaf, type MerkleLeaf} from './backupMerkle';
import {toB64, fromB64} from './backupCrypto';

const DIRTY_KEY_PREFIX = 'bravo:backup:merkle-leafcache-dirty:';
/** SQLite's default max bind-parameter count is 999; 4 params per row. */
const UPSERT_CHUNK = 100;

let testDb: DbHandle | null | undefined;
/** Test seam — pass a fake DbHandle, or null to simulate "no DB". */
export function _setLeafCacheDbForTests(db: DbHandle | null | undefined): void {
  testDb = db;
}

function cacheDb(): DbHandle | null {
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
 * Deterministic client-side reproduction of the string PostgREST returns
 * for a TIMESTAMPTZ the client uploaded as `Date.toISOString()`:
 * Postgres `to_json` output — UTC offset spelled `+00:00`, trailing
 * fractional zeros stripped, the dot dropped when the fraction is zero.
 *
 * ONLY the canonical forms are transformed. Anything else passes through
 * unchanged — the shadow compare exists precisely to surface stragglers,
 * and guessing at exotic inputs would hide them instead.
 */
export function pgTimestamptzText(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|\+00:00)$/.exec(ts);
  if (!m) {return ts;}
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac ? `${m[1]}.${frac}+00:00` : `${m[1]}+00:00`;
}

/**
 * Leaves for a just-uploaded wire batch: the exact base64 ciphertext that
 * went to the server, with the timestamp transformed to the form the
 * server will return (the leaf hash covers that returned form).
 */
export function leavesFromWireRows(
  rows: ReadonlyArray<{message_id: string; msg_created_at: string; ciphertext: string}>,
): MerkleLeaf[] {
  return rows.map(r => computeLeaf({
    message_id:     r.message_id,
    msg_created_at: pgTimestamptzText(r.msg_created_at),
    ciphertext:     r.ciphertext,
  }));
}

/** Upsert a flush batch's leaves. Best-effort; false = not recorded. */
export async function upsertLeaves(ownerUserId: string, leaves: readonly MerkleLeaf[]): Promise<boolean> {
  if (!ownerUserId || leaves.length === 0) {return true;}
  const db = cacheDb();
  if (!db) {return false;}
  try {
    for (let i = 0; i < leaves.length; i += UPSERT_CHUNK) {
      const chunk = leaves.slice(i, i + UPSERT_CHUNK);
      const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const params: string[] = [];
      for (const l of chunk) {
        params.push(ownerUserId, l.message_id, l.msg_created_at, toB64(l.leaf));
      }
      await db.execute(
        `INSERT OR REPLACE INTO merkle_leaves (owner_user_id, message_id, ts_str, leaf_b64) VALUES ${values}`,
        params,
      );
    }
    return true;
  } catch (e) {
    console.warn('[backup.leafcache] upsert failed:', (e as Error).message);
    return false;
  }
}

/**
 * Replace the owner's whole cache with walk-derived leaves (server truth).
 * No transaction on purpose (shared connection — the nested-BEGIN trap,
 * see recordFlushedVersions), so the dirty flag brackets the replace:
 * raised before the DELETE, cleared only after every insert lands. A kill
 * mid-replace leaves dirty set and the partial cache untrusted.
 */
export async function replaceLeafCache(ownerUserId: string, leaves: readonly MerkleLeaf[]): Promise<boolean> {
  if (!ownerUserId) {return false;}
  const db = cacheDb();
  if (!db) {return false;}
  try {
    await setLeafCacheDirty(ownerUserId);
    await db.execute('DELETE FROM merkle_leaves WHERE owner_user_id = ?', [ownerUserId]);
    if (!(await upsertLeaves(ownerUserId, leaves))) {return false;}
    await clearLeafCacheDirty(ownerUserId);
    return true;
  } catch (e) {
    console.warn('[backup.leafcache] replace failed:', (e as Error).message);
    return false;
  }
}

/**
 * Load the owner's cached leaves. `null` = cache unavailable/errored
 * (distinct from a genuinely empty cache).
 */
export async function loadLeafCache(ownerUserId: string): Promise<MerkleLeaf[] | null> {
  if (!ownerUserId) {return null;}
  const db = cacheDb();
  if (!db) {return null;}
  try {
    const res = await db.execute(
      'SELECT message_id, ts_str, leaf_b64 FROM merkle_leaves WHERE owner_user_id = ?',
      [ownerUserId],
    );
    const out: MerkleLeaf[] = [];
    for (const row of (res.rows ?? []) as Array<{message_id: string; ts_str: string; leaf_b64: string}>) {
      out.push({
        message_id:     row.message_id,
        msg_created_at: row.ts_str,
        leaf:           new Uint8Array(fromB64(row.leaf_b64)),
      });
    }
    return out;
  } catch (e) {
    console.warn('[backup.leafcache] load failed:', (e as Error).message);
    return null;
  }
}

/**
 * Purge the owner's cache and raise dirty. Called from
 * clearFlushedForOwner (I5 — every ledger purge implies the server set is
 * about to change out from under the cache; the next walk rebuilds it).
 */
export async function clearLeafCacheForOwner(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  try { await setLeafCacheDirty(ownerUserId); } catch { /* best-effort */ }
  const db = cacheDb();
  if (!db) {return;}
  try {
    await db.execute('DELETE FROM merkle_leaves WHERE owner_user_id = ?', [ownerUserId]);
  } catch (e) {
    console.warn('[backup.leafcache] clear failed:', (e as Error).message);
  }
}

/** Raise BEFORE putMessages (I2-style); the cache is untrusted while set. */
export async function setLeafCacheDirty(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  try {
    await AsyncStorage.setItem(`${DIRTY_KEY_PREFIX}${ownerUserId}`, '1');
  } catch { /* best-effort — a stuck flag only costs walk fallbacks */ }
}

export async function clearLeafCacheDirty(ownerUserId: string): Promise<void> {
  if (!ownerUserId) {return;}
  try {
    await AsyncStorage.removeItem(`${DIRTY_KEY_PREFIX}${ownerUserId}`);
  } catch { /* best-effort */ }
}

export async function readLeafCacheDirty(ownerUserId: string): Promise<boolean> {
  if (!ownerUserId) {return true;}
  try {
    return (await AsyncStorage.getItem(`${DIRTY_KEY_PREFIX}${ownerUserId}`)) === '1';
  } catch {
    // Unreadable flag = untrusted cache — the safe direction.
    return true;
  }
}
