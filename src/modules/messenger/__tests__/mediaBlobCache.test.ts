/**
 * MediaBlobCache — first behavioural coverage of the ciphertext LRU.
 *
 * mediaBlobCachePurge.test.ts pins only the ExpirySweeper wiring with
 * purgeBlob mocked; the class itself (Audit fixes #22 eviction mutex and
 * #23 per-blob cap, plus the M11 raise to 50 MB) was never instantiated
 * by a test. `DbHandle` is a type-only import, so a tiny in-memory table
 * that answers the six SQL shapes the class emits is enough to run the
 * real logic under node.
 */

import {MediaBlobCache} from '../media/mediaBlobCache';

type Row = {
  ciphertext: number[];
  mime: string | null;
  size: number;
  created: number;
  accessed: number;
};

/** Minimal media_blobs table speaking the exact SQL this class uses. */
class FakeDb {
  rows = new Map<string, Row>();

  async execute(sql: string, params: unknown[] = []): Promise<{rows: unknown[]}> {
    if (sql.startsWith('SELECT ciphertext')) {
      const r = this.rows.get(params[0] as string);
      // op-sqlite hands BLOBs back as number[] sometimes — emulate that
      // so toUint8Array's array fallback is exercised.
      return {rows: r ? [{ciphertext: r.ciphertext, size: r.size}] : []};
    }
    if (sql.startsWith('UPDATE media_blobs SET last_accessed')) {
      const r = this.rows.get(params[1] as string);
      if (r) {r.accessed = params[0] as number;}
      return {rows: []};
    }
    if (sql.startsWith('INSERT OR REPLACE')) {
      const [key, ct, mime, size, created, accessed] = params as
        [string, Uint8Array, string | null, number, number, number];
      this.rows.set(key, {ciphertext: Array.from(ct), mime, size, created, accessed});
      return {rows: []};
    }
    if (sql.startsWith('DELETE FROM media_blobs WHERE')) {
      this.rows.delete(params[0] as string);
      return {rows: []};
    }
    if (sql.startsWith('DELETE FROM media_blobs')) {
      this.rows.clear();
      return {rows: []};
    }
    if (sql.includes('SUM(size)')) {
      let total = 0;
      for (const r of this.rows.values()) {total += r.size;}
      return {rows: [{total}]};
    }
    if (sql.includes('ORDER BY last_accessed')) {
      const list = [...this.rows.entries()]
        .sort((a, b) => a[1].accessed - b[1].accessed)
        .map(([object_key, r]) => ({object_key, size: r.size}));
      return {rows: list};
    }
    throw new Error(`FakeDb: unhandled SQL: ${sql}`);
  }
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

let clock: number;
let nowSpy: jest.SpyInstance<number, []>;

beforeEach(() => {
  clock = 1_000;
  // Every Date.now() call ticks so last_accessed ordering is total.
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
});

afterEach(() => nowSpy.mockRestore());

const make = (maxBytes?: number) => {
  const db = new FakeDb();
  return {db, cache: new MediaBlobCache(db as never, maxBytes ? {maxBytes} : {})};
};

describe('round trip', () => {
  it('put → get returns the ciphertext bytes', async () => {
    const {cache} = make();
    await cache.put('k1', bytes(16), 'image/jpeg', 16);
    expect(await cache.get('k1')).toEqual(bytes(16));
  });

  it('a miss is null, not a throw', async () => {
    const {cache} = make();
    expect(await cache.get('nope')).toBeNull();
  });

  it('remove deletes exactly one key; wipe clears everything', async () => {
    const {cache} = make();
    await cache.put('k1', bytes(4), null, 4);
    await cache.put('k2', bytes(4), null, 4);
    await cache.remove('k1');
    expect(await cache.get('k1')).toBeNull();
    expect(await cache.get('k2')).not.toBeNull();
    await cache.wipe();
    expect(await cache.get('k2')).toBeNull();
  });
});

describe('LRU eviction (Audit fix #22 shape)', () => {
  it('evicts the least-recently-ACCESSED row, not the oldest-created', async () => {
    const {cache} = make(100);
    await cache.put('a', bytes(40), null, 40);
    await cache.put('b', bytes(40), null, 40);
    await cache.get('a');                       // touch a → b is now LRU
    await cache.put('c', bytes(40), null, 40);  // 120 > 100 → evict b
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
  });

  it('evicts several rows when one is not enough', async () => {
    const {cache, db} = make(50);
    await cache.put('a', bytes(20), null, 20);
    await cache.put('b', bytes(20), null, 20);
    await cache.put('big', bytes(50), null, 50); // 90 > 50 → free 40 → a AND b go
    expect(db.rows.has('a')).toBe(false);
    expect(db.rows.has('b')).toBe(false);
    expect(db.rows.has('big')).toBe(true);
  });

  it('no eviction while under the cap', async () => {
    const {db, cache} = make(100);
    await cache.put('a', bytes(30), null, 30);
    await cache.put('b', bytes(30), null, 30);
    expect(db.rows.size).toBe(2);
  });

  it('concurrent puts settle under the cap without double-evicting (mutex)', async () => {
    const {db, cache} = make(100);
    await cache.put('a', bytes(60), null, 60);
    await Promise.all([
      cache.put('b', bytes(60), null, 60),
      cache.put('c', bytes(60), null, 60),
    ]);
    let total = 0;
    for (const r of db.rows.values()) {total += r.size;}
    expect(total).toBeLessThanOrEqual(100);
    // The newest row must have survived its own put.
    expect(db.rows.has('c')).toBe(true);
  });
});

describe('per-blob cap (Audit fix #23, raised to 50 MB by M11)', () => {
  const MB = 1024 * 1024;

  it('stores a blob at exactly 50 MB', async () => {
    const {db, cache} = make(500 * MB);
    await cache.put('edge', bytes(1), null, 50 * MB);
    expect(db.rows.has('edge')).toBe(true);
  });

  it('silently skips a blob over 50 MB', async () => {
    const {db, cache} = make(500 * MB);
    await cache.put('huge', bytes(1), null, 50 * MB + 1);
    expect(db.rows.has('huge')).toBe(false);
  });

  it('FIXED: an oversize re-put invalidates the previous smaller entry', async () => {
    // Flipped from DOCUMENTS: put(K, small) then put(K, oversize) used to
    // early-return without invalidating K, so the cache kept serving the
    // stale smaller bytes. The over-cap skip now deletes any existing row
    // for the key first.
    const {db, cache} = make(500 * MB);
    await cache.put('k', bytes(8, 1), null, 8);
    await cache.put('k', bytes(8, 2), null, 50 * MB + 1);
    expect(await cache.get('k')).toBeNull();
    expect(db.rows.has('k')).toBe(false);
  });

  it('an oversize put with NO existing entry stays a silent skip', () => {
    // The invalidation must not turn into an unconditional delete round-trip
    // failure path — a fresh oversize key simply is not cached.
    const {db, cache} = make(500 * MB);
    return (async () => {
      await cache.put('other', bytes(4), null, 4);
      await cache.put('huge2', bytes(1), null, 50 * MB + 1);
      expect(db.rows.has('huge2')).toBe(false);
      expect(db.rows.has('other')).toBe(true);
    })();
  });
});
