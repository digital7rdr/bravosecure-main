/**
 * B-687 — Merkle leaf cache, SHADOW MODE.
 *
 * The steady-state after-flush commit page-walks the ENTIRE server backup
 * and re-hashes every row, 5s after every flush burst. The leaf cache
 * captures leaves at flush time from the EXACT uploaded bytes so a future
 * flip can sign from the cache without the walk. This suite pins:
 *
 *   1. pgTimestamptzText — the make-or-break transform. The leaf hash
 *      covers msg_created_at AS THE SERVER RETURNS IT (Postgres to_json:
 *      `+00:00`, trailing fractional zeros stripped), while the client
 *      uploads Date.toISOString() form. Cache leaves computed over the
 *      untransformed string mismatch the walk on EVERY row.
 *   2. Cache CRUD + the dirty flag (raise-first; replace brackets itself).
 *   3. clearFlushedForOwner purges the cache (I5 — inside the function,
 *      so no caller can miss it).
 *   4. commitMerkleRoot's shadow block: epoch-gated compare + rebuild —
 *      observational ONLY (the shipped commit is byte-identical either way).
 *   5. The flush-site ordering in messageMirror.ts (source scan): dirty
 *      raised BEFORE putMessages; leaves upserted after the ledger write;
 *      a prior failure's dirty flag is never cleared by a later batch.
 */
import {webcrypto} from 'node:crypto';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));

jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));

// Stateful fake backup server: pages of rows for the walk, accepts commits.
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    meta?: Record<string, unknown>;
    constructor(kind: string, msg: string, meta?: Record<string, unknown>) {
      super(msg); this.name = 'BackupError'; this.kind = kind; this.meta = meta;
    }
  }
  let serverRows: Array<{message_id: string; msg_created_at: string; ciphertext: string}> = [];
  let onWalkPage: (() => void) | null = null;
  return {
    __esModule: true,
    BackupError,
    __setServerRows: (rows: typeof serverRows) => { serverRows = rows; },
    __setOnWalkPage: (fn: (() => void) | null) => { onWalkPage = fn; },
    backupClient: {
      getMessages: jest.fn(async (_ts?: string, _limit?: number, _id?: string) => {
        onWalkPage?.();
        // Single page — tests keep row counts < 1000.
        const out = _ts === undefined ? serverRows : [];
        return {messages: out};
      }),
      putMerkleCommit: jest.fn(async () => ({ok: true})),
      getMerkleCommit: jest.fn(async () => null),
      getSessions: async () => null,
    },
  };
});

import {
  pgTimestamptzText, leavesFromWireRows, upsertLeaves, replaceLeafCache,
  loadLeafCache, clearLeafCacheForOwner, setLeafCacheDirty,
  readLeafCacheDirty, _setLeafCacheDbForTests,
} from '../backup/merkleLeafCache';
import {computeLeaf, computeRootFromLeaves} from '../backup/backupMerkle';
import {commitMerkleRoot, _resetLeafCacheAuditForTests} from '../backup/merkleCommit';
import {clearFlushedForOwner, _setLedgerDbForTests, bumpFlushEpoch} from '../backup/mirrorLedger';
import {toB64} from '../backup/backupCrypto';

const backupClientMock = jest.requireMock('../backup/backupClient') as {
  __setServerRows: (rows: Array<{message_id: string; msg_created_at: string; ciphertext: string}>) => void;
  __setOnWalkPage: (fn: (() => void) | null) => void;
  backupClient: {putMerkleCommit: jest.Mock};
};
const asyncStorageMock = jest.requireMock('@react-native-async-storage/async-storage') as {
  __store: Map<string, string>;
};

const OWNER = 'owner-1';

/** In-memory DbHandle understanding exactly the SQL this feature issues. */
function makeFakeDb() {
  const leaves = new Map<string, {owner: string; id: string; ts: string; leaf: string}>();
  const flushed = new Map<string, {owner: string; id: string}>();
  const executed: string[] = [];
  const handle = {
    execute: async (sql: string, params: Array<string | number> = []) => {
      executed.push(sql.split('(')[0].trim());
      if (sql.startsWith('INSERT OR REPLACE INTO merkle_leaves')) {
        for (let i = 0; i < params.length; i += 4) {
          const [owner, id, ts, leaf] = params.slice(i, i + 4) as string[];
          leaves.set(`${owner}:${id}`, {owner, id, ts, leaf});
        }
        return {rows: []};
      }
      if (sql.startsWith('DELETE FROM merkle_leaves')) {
        for (const k of [...leaves.keys()]) {
          if (leaves.get(k)!.owner === params[0]) {leaves.delete(k);}
        }
        return {rows: []};
      }
      if (sql.startsWith('SELECT message_id, ts_str, leaf_b64 FROM merkle_leaves')) {
        return {rows: [...leaves.values()]
          .filter(r => r.owner === params[0])
          .map(r => ({message_id: r.id, ts_str: r.ts, leaf_b64: r.leaf}))};
      }
      if (sql.startsWith('INSERT OR REPLACE INTO mirror_flushed')) {
        for (let i = 0; i < params.length; i += 4) {
          const [owner, id] = params.slice(i, i + 4) as string[];
          flushed.set(`${owner}:${id}`, {owner, id});
        }
        return {rows: []};
      }
      if (sql.startsWith('DELETE FROM mirror_flushed')) {
        for (const k of [...flushed.keys()]) {
          if (flushed.get(k)!.owner === params[0]) {flushed.delete(k);}
        }
        return {rows: []};
      }
      if (sql.startsWith('SELECT message_id, version FROM mirror_flushed')) {
        return {rows: []};
      }
      throw new Error(`fake db: unexpected sql: ${sql}`);
    },
  };
  return {handle: handle as never, leaves, flushed, executed};
}

function wireRow(id: string, ts: string, ct: string) {
  return {message_id: id, msg_created_at: ts, ciphertext: ct};
}

beforeAll(() => {
  // merkleLeafCache/backupCrypto use TextEncoder + atob/btoa shims via
  // backupCrypto; node has TextEncoder globally. Ensure webcrypto presence
  // for any transitive subtle use.
  (globalThis as {crypto?: unknown}).crypto ??= webcrypto;
});

beforeEach(() => {
  asyncStorageMock.__store.clear();
  backupClientMock.__setServerRows([]);
  backupClientMock.__setOnWalkPage(null);
  backupClientMock.backupClient.putMerkleCommit.mockClear();
  (backupClientMock.backupClient as unknown as {getMessages: jest.Mock}).getMessages.mockClear();
  _setLeafCacheDbForTests(undefined);
  _setLedgerDbForTests(undefined);
  _resetLeafCacheAuditForTests();
});

describe('pgTimestamptzText — the to_json round-trip transform', () => {
  it.each([
    ['2026-08-28T12:34:56.789Z',      '2026-08-28T12:34:56.789+00:00'],
    ['2026-08-28T12:34:56.780Z',      '2026-08-28T12:34:56.78+00:00'],
    ['2026-08-28T12:34:56.700Z',      '2026-08-28T12:34:56.7+00:00'],
    ['2026-08-28T12:34:56.000Z',      '2026-08-28T12:34:56+00:00'],
    ['2026-08-28T12:34:56Z',          '2026-08-28T12:34:56+00:00'],
    // Already server-form: idempotent.
    ['2026-08-28T12:34:56.78+00:00',  '2026-08-28T12:34:56.78+00:00'],
    ['2026-08-28T12:34:56+00:00',     '2026-08-28T12:34:56+00:00'],
  ])('%s → %s', (input, expected) => {
    expect(pgTimestamptzText(input)).toBe(expected);
  });

  it('passes non-canonical forms through UNCHANGED (shadow surfaces them)', () => {
    for (const odd of ['2026-08-28 12:34:56', 'not-a-date', '2026-08-28T12:34:56.789+06:00', '']) {
      expect(pgTimestamptzText(odd)).toBe(odd);
    }
  });

  it('leavesFromWireRows equals computeLeaf over the SERVER-form row', () => {
    const clientRow = wireRow('m1', '2026-08-28T12:34:56.780Z', 'Y2lwaGVy');
    const serverRow = wireRow('m1', '2026-08-28T12:34:56.78+00:00', 'Y2lwaGVy');
    const [fromWire] = leavesFromWireRows([clientRow]);
    const fromServer = computeLeaf(serverRow);
    expect(toB64(fromWire.leaf)).toBe(toB64(fromServer.leaf));
    expect(fromWire.msg_created_at).toBe(serverRow.msg_created_at);
  });
});

describe('cache CRUD + dirty flag', () => {
  it('upsert → load round-trips leaves; replace supersedes; clear purges', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    const a = computeLeaf(wireRow('a', '2026-01-01T00:00:00+00:00', 'AAAA'));
    const b = computeLeaf(wireRow('b', '2026-01-02T00:00:00+00:00', 'BBBB'));
    expect(await upsertLeaves(OWNER, [a])).toBe(true);
    let loaded = await loadLeafCache(OWNER);
    expect(loaded?.map(l => l.message_id)).toEqual(['a']);
    expect(toB64(loaded![0].leaf)).toBe(toB64(a.leaf));

    expect(await replaceLeafCache(OWNER, [b])).toBe(true);
    loaded = await loadLeafCache(OWNER);
    expect(loaded?.map(l => l.message_id)).toEqual(['b']);
    // A successful replace ends CLEAN (it bracketed itself with the flag).
    expect(await readLeafCacheDirty(OWNER)).toBe(false);

    await clearLeafCacheForOwner(OWNER);
    expect(await loadLeafCache(OWNER)).toEqual([]);
    // A purge leaves the cache UNTRUSTED until a walk rebuilds it.
    expect(await readLeafCacheDirty(OWNER)).toBe(true);
  });

  it('no DB → load returns null (distinct from empty), upsert reports false', async () => {
    _setLeafCacheDbForTests(null);
    const a = computeLeaf(wireRow('a', '2026-01-01T00:00:00+00:00', 'AAAA'));
    expect(await loadLeafCache(OWNER)).toBeNull();
    expect(await upsertLeaves(OWNER, [a])).toBe(false);
  });

  it('an unreadable dirty flag reads as DIRTY (untrusted — the safe direction)', async () => {
    expect(await readLeafCacheDirty('')).toBe(true);
  });

  it('I5 — clearFlushedForOwner purges the leaf cache from INSIDE the ledger', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    _setLedgerDbForTests(db.handle);
    await upsertLeaves(OWNER, [computeLeaf(wireRow('a', '2026-01-01T00:00:00+00:00', 'AAAA'))]);
    await clearFlushedForOwner(OWNER);
    expect(await loadLeafCache(OWNER)).toEqual([]);
    expect(await readLeafCacheDirty(OWNER)).toBe(true);
    // The purge ran through the leaf-cache DELETE, not some sibling path.
    expect(db.executed).toContain('DELETE FROM merkle_leaves WHERE owner_user_id = ?');
  });
});

describe('commitMerkleRoot shadow block — observational, epoch-gated', () => {
  const PRIV = new Uint8Array(32).buffer;
  const SERVER_ROWS = [
    wireRow('m1', '2026-08-28T10:00:00.5+00:00', 'Y3Qx'),
    wireRow('m2', '2026-08-28T11:00:00+00:00',   'Y3Qy'),
  ];
  // What the CLIENT would have uploaded for those rows (toISOString forms).
  const CLIENT_ROWS = [
    wireRow('m1', '2026-08-28T10:00:00.500Z', 'Y3Qx'),
    wireRow('m2', '2026-08-28T11:00:00.000Z', 'Y3Qy'),
  ];

  function warnLines(spy: jest.SpyInstance): string[] {
    return spy.mock.calls.map(args => args.map(String).join(' '));
  }

  it('a flush-seeded cache MATCHES the walk (the whole point) and is not rewritten', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(res?.rowCount).toBe(2);
      const lines = warnLines(warn);
      expect(lines.some(l => l.includes('[backup.merkle.shadow] match=true cacheRows=2 walkRows=2'))).toBe(true);
      expect(lines.some(l => l.includes('cache rebuilt from walk'))).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('a divergent cache logs match=false and is REBUILT from the walk', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    // Cache computed WITHOUT the transform — the exact bug class the
    // partner audit predicted: mismatch on every row.
    await upsertLeaves(OWNER, CLIENT_ROWS.map(computeLeaf));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      const lines = warnLines(warn);
      expect(lines.some(l => l.includes('[backup.merkle.shadow] match=false'))).toBe(true);
      expect(lines.some(l => l.includes('cache rebuilt from walk'))).toBe(true);
      // The rebuilt cache now reduces to the walk's own root.
      const rebuilt = await loadLeafCache(OWNER);
      const walkRoot = computeRootFromLeaves(SERVER_ROWS.map(computeLeaf));
      expect(toB64(computeRootFromLeaves(rebuilt!))).toBe(toB64(walkRoot));
      expect(await readLeafCacheDirty(OWNER)).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('a dirty cache is UNUSABLE (no match line) and is rebuilt', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    await setLeafCacheDirty(OWNER);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      const lines = warnLines(warn);
      expect(lines.some(l => l.includes('[backup.merkle.shadow] unusable dirty=true'))).toBe(true);
      expect(lines.some(l => l.includes('match='))).toBe(false);
      expect(lines.some(l => l.includes('cache rebuilt from walk'))).toBe(true);
      expect(await readLeafCacheDirty(OWNER)).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('a flush landing MID-WALK suppresses the whole shadow block (no compare, no rewrite)', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, CLIENT_ROWS.map(computeLeaf)); // divergent on purpose
    backupClientMock.__setOnWalkPage(() => bumpFlushEpoch());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      const lines = warnLines(warn);
      expect(lines.some(l => l.includes('[backup.merkle.shadow]'))).toBe(false);
      // The divergent cache was NOT clobbered by the stale walk snapshot.
      const cached = await loadLeafCache(OWNER);
      expect(toB64(computeRootFromLeaves(cached!)))
        .toBe(toB64(computeRootFromLeaves(CLIENT_ROWS.map(computeLeaf))));
    } finally { warn.mockRestore(); }
  });

  it('the SHIPPED commit is byte-identical with and without a cache (observational pin)', async () => {
    backupClientMock.__setServerRows(SERVER_ROWS);
    const put = backupClientMock.backupClient.putMerkleCommit;
    _setLeafCacheDbForTests(null); // no cache at all
    await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
    const withoutCache = put.mock.calls.at(-1)![0] as {rootB64: string; rowCount: number};

    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
    const withCache = put.mock.calls.at(-1)![0] as {rootB64: string; rowCount: number};

    expect(withCache.rootB64).toBe(withoutCache.rootB64);
    expect(withCache.rowCount).toBe(withoutCache.rowCount);
  });
});

describe('flush-site ordering (source scan — messageMirror.ts)', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'backup', 'messageMirror.ts'), 'utf8',
  );

  it('dirty is read-then-raised BEFORE putMessages; leaves land AFTER the ledger write', () => {
    const iRead   = src.indexOf('leafCacheWasDirty = await readLeafCacheDirty(ownerId)');
    const iRaise  = src.indexOf('await setLeafCacheDirty(ownerId)');
    const iPut    = src.indexOf('await backupClient.putMessages(rows)');
    const iRecord = src.indexOf('await recordFlushedVersions(');
    const iUpsert = src.indexOf('await upsertLeaves(ownerId, leavesFromWireRows(rows))');
    for (const idx of [iRead, iRaise, iPut, iRecord, iUpsert]) {
      expect(idx).toBeGreaterThan(-1);
    }
    expect(iRead).toBeLessThan(iRaise);
    expect(iRaise).toBeLessThan(iPut);
    expect(iPut).toBeLessThan(iRecord);
    expect(iRecord).toBeLessThan(iUpsert);
  });

  it('a later batch cannot clear a PRIOR failure\'s dirty flag', () => {
    expect(src).toMatch(/&& !leafCacheWasDirty/);
  });

  it('the leaf write sits INSIDE the session-generation guard (stale flushes skip it)', () => {
    const iGenGuard = src.indexOf('flush landed after session change — bookkeeping skipped');
    const iUpsert   = src.indexOf('await upsertLeaves(ownerId, leavesFromWireRows(rows))');
    expect(iGenGuard).toBeGreaterThan(-1);
    expect(iGenGuard).toBeLessThan(iUpsert);
  });
});

describe('B-687 FLIP — audited sessions cache-sign; everything else walks', () => {
  const PRIV = new Uint8Array(32).buffer;
  const SERVER_ROWS = [
    {message_id: 'm1', msg_created_at: '2026-08-28T10:00:00.5+00:00', ciphertext: 'Y3Qx'},
    {message_id: 'm2', msg_created_at: '2026-08-28T11:00:00+00:00',   ciphertext: 'Y3Qy'},
  ];
  const CLIENT_ROWS = [
    {message_id: 'm1', msg_created_at: '2026-08-28T10:00:00.500Z', ciphertext: 'Y3Qx'},
    {message_id: 'm2', msg_created_at: '2026-08-28T11:00:00.000Z', ciphertext: 'Y3Qy'},
  ];
  const getMessages = () => (backupClientMock.backupClient as unknown as {getMessages: jest.Mock}).getMessages;
  const put = () => backupClientMock.backupClient.putMerkleCommit;

  it('first ambient commit WALKS and audits; second cache-signs with the identical root, no walk', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      const walkCalls = getMessages().mock.calls.length;
      expect(walkCalls).toBeGreaterThan(0);
      const first = put().mock.calls.at(-1)![0] as {rootB64: string; rowCount: number};

      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBe(walkCalls);   // NO second walk
      const second = put().mock.calls.at(-1)![0] as {rootB64: string; rowCount: number};
      expect(second.rootB64).toBe(first.rootB64);
      expect(second.rowCount).toBe(first.rowCount);
      const lines = warn.mock.calls.map(a => a.map(String).join(' '));
      expect(lines.some(l => l.includes('[backup.merkle.flip] cache-signed rows=2'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('an UN-audited owner walks even with a clean populated cache', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBeGreaterThan(0);
      const lines = warn.mock.calls.map(a => a.map(String).join(' '));
      // The first commit must never claim the fast path.
      expect(lines.filter(l => l.includes('cache-signed')).length).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('a dirty cache after the audit falls back to the walk (I8 direction)', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});  // audits
      await setLeafCacheDirty(OWNER);
      const walkCalls = getMessages().mock.calls.length;
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBeGreaterThan(walkCalls); // walked again
    } finally { warn.mockRestore(); }
  });

  it('the REBUILD audit path also arms the flip', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, CLIENT_ROWS.map(computeLeaf));   // divergent → rebuild
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      const walkCalls = getMessages().mock.calls.length;
      const first = put().mock.calls.at(-1)![0] as {rootB64: string};
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBe(walkCalls);
      const second = put().mock.calls.at(-1)![0] as {rootB64: string};
      expect(second.rootB64).toBe(first.rootB64);
    } finally { warn.mockRestore(); }
  });

  it('a mid-walk flush blocks the audit — the next commit still walks', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    backupClientMock.__setOnWalkPage(() => bumpFlushEpoch());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});  // epoch-raced: no audit
      const walkCalls = getMessages().mock.calls.length;
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBeGreaterThan(walkCalls);
    } finally { warn.mockRestore(); }
  });

  it('a RESTORE-heal leaves commit (p.leaves) neither audits nor flips the ambient path', async () => {
    const db = makeFakeDb();
    _setLeafCacheDbForTests(db.handle);
    backupClientMock.__setServerRows(SERVER_ROWS);
    await upsertLeaves(OWNER, leavesFromWireRows(CLIENT_ROWS));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER, leaves: SERVER_ROWS.map(computeLeaf)});
      expect(getMessages().mock.calls.length).toBe(0);       // leaves path never walks
      await commitMerkleRoot({identityPrivKey: PRIV, userId: OWNER});
      expect(getMessages().mock.calls.length).toBeGreaterThan(0);  // ambient still walks first
    } finally { warn.mockRestore(); }
  });
});
