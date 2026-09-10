/**
 * SQLCipher-backed media blob cache.
 *
 * Stores the *already-encrypted* bytes (R2 ciphertext) keyed by R2
 * object key, so a re-view of the same image / voice note doesn't
 * round-trip the storage operator again. The per-file AES-256-CBC
 * decryption key STILL lives in the sealed envelope only — this
 * cache never sees plaintext. Combined with SQLCipher's page-level
 * encryption, on-disk recovery yields nothing without the keychain
 * key.
 *
 * Eviction is opportunistic LRU: every put() that pushes us over
 * `maxBytes` deletes oldest-accessed rows until we're back under
 * the cap. Safe default: 200 MB total — fine for hundreds of
 * voice notes, dozens of photos.
 */

import type {DbHandle} from '../crypto/db';

export interface MediaBlobCacheOptions {
  /** Max total bytes across all cached blobs. Default 200 MB. */
  maxBytes?: number;
}

// BlobRow shape kept inline at the read sites — the previous standalone
// interface drifted out of sync as we added size-tracking columns.

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/**
 * Audit fix #23 — per-blob cap. A single huge file shouldn't be allowed
 * to push everything else out of the cache.
 *
 * Media-parity M11 (2026-07-03): raised 25 → 50 MB (the upload cap).
 * At 25 MB every larger video was NEVER cached, so each re-open paid a
 * full R2 re-download — and after the server's 30-day object lifetime
 * the video became permanently unopenable even though the device had
 * fetched it many times. The LRU (200 MB total) still bounds disk.
 */
const PER_BLOB_MAX_BYTES = 50 * 1024 * 1024;

export class MediaBlobCache {
  private readonly maxBytes: number;
  /**
   * Audit fix #22 — eviction mutex. The previous evictIfFull was a
   * read-then-decide-then-write pair; two concurrent put()s could
   * both observe `total > maxBytes` and both delete the same victim
   * rows, doubling the eviction and corrupting the size accounting.
   * Worse, two concurrent puts of new rows could let total drift
   * permanently above maxBytes if one's evict ran before the other's
   * insert. A simple Promise chain on a per-instance mutex serialises
   * eviction so SUM(size) is read consistently inside one critical
   * section.
   */
  private evictChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: DbHandle, opts: MediaBlobCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Return the cached ciphertext for `objectKey`, or null on miss. */
  async get(objectKey: string): Promise<Uint8Array | null> {
    const result = await this.db.execute(
      'SELECT ciphertext, size FROM media_blobs WHERE object_key = ?',
      [objectKey],
    );
    const rows = (result.rows ?? []) as Array<{ciphertext: unknown}>;
    if (rows.length === 0) {return null;}
    // Touch last_accessed so LRU eviction doesn't pick this row.
    await this.db.execute(
      'UPDATE media_blobs SET last_accessed = ? WHERE object_key = ?',
      [Date.now(), objectKey],
    );
    return toUint8Array(rows[0].ciphertext);
  }

  /** Insert or replace a blob; evict if total exceeds the cap. */
  async put(objectKey: string, ciphertext: Uint8Array, mimeType: string | null, size: number): Promise<void> {
    // Audit fix #23 — skip caching anything over the per-blob cap.
    // 25 MB ≈ a 5-minute 1080p clip; anything larger should stream
    // off R2 each time rather than evict 25 small voice notes per
    // play.
    if (size > PER_BLOB_MAX_BYTES) {
      // Why: an over-cap re-put must not leave a previous smaller entry
      // serving stale bytes for the same key — drop it before skipping.
      await this.remove(objectKey);
      return;
    }
    const now = Date.now();
    await this.db.execute(
      `INSERT OR REPLACE INTO media_blobs
         (object_key, ciphertext, mime_type, size, created_at, last_accessed)
         VALUES (?,?,?,?,?,?)`,
      [objectKey, ciphertext, mimeType, size, now, now],
    );
    await this.evictIfFull();
  }

  /** Remove the row for `objectKey` if present. */
  async remove(objectKey: string): Promise<void> {
    await this.db.execute('DELETE FROM media_blobs WHERE object_key = ?', [objectKey]);
  }

  /** Drop everything — used by the destructive "wipe identity" flow. */
  async wipe(): Promise<void> {
    await this.db.execute('DELETE FROM media_blobs');
  }

  /**
   * If total cached bytes exceeds the cap, delete least-recently-used
   * rows until we're back under. Coarse-grained: one statement reads
   * `SUM(size)` then a second one deletes the oldest rows. For Phase
   * 1 user volumes this is fine; if cache pressure becomes a hot
   * path, switch to a maintenance background sweep.
   *
   * Audit fix #22 — serialise through `evictChain` so concurrent
   * put() calls don't double-evict. The chain `.catch(() => undefined)`
   * keeps a single failure from poisoning future evictions.
   */
  private async evictIfFull(): Promise<void> {
    const work = this.evictChain.catch(() => undefined).then(async () => {
      const sumRes = await this.db.execute('SELECT COALESCE(SUM(size), 0) AS total FROM media_blobs');
      const total = ((sumRes.rows ?? [])[0] as {total: number} | undefined)?.total ?? 0;
      if (total <= this.maxBytes) {return;}
      let toFree = total - this.maxBytes;
      const lruRes = await this.db.execute(
        'SELECT object_key, size FROM media_blobs ORDER BY last_accessed ASC',
      );
      const rows = (lruRes.rows ?? []) as Array<{object_key: string; size: number}>;
      for (const r of rows) {
        if (toFree <= 0) {break;}
        await this.db.execute('DELETE FROM media_blobs WHERE object_key = ?', [r.object_key]);
        toFree -= r.size;
      }
    });
    this.evictChain = work;
    await work;
  }
}

function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) {return v;}
  if (v instanceof ArrayBuffer) {return new Uint8Array(v);}
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  // Fallback: op-sqlite sometimes hands back number[] for BLOBs.
  if (Array.isArray(v)) {return Uint8Array.from(v as number[]);}
  throw new Error('media_blobs.ciphertext is not bytes-like');
}
