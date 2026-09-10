/**
 * `crypto/db.ts` — `openCryptoDb` / `openSecondaryDb` / `openCompartmentedDb`
 * and the forward-only migration ladder, executed against a REAL SQLite engine.
 *
 * Why this file exists
 * --------------------
 * `db.ts` is one of only three mobile-specific files the crypto barrel still
 * exports (`export {openCryptoDb} from './db'` — everything else in
 * `src/modules/messenger/crypto/` is shadowed by `export * from
 * '@bravo/messenger-core'`). So this IS production code. Yet `runMigrations`
 * — ~190 lines that rewrite a user's outbox table in place and add eleven
 * columns to `messages` — had never been executed by any test. The only db.ts
 * coverage was `compartmentedDbHardening.test.ts`, which stops at the key
 * validator and the HMAC gate.
 *
 * A migration bug is unrecoverable in the field: it runs once, on a real user's
 * data, at boot, before anything can observe it. The specific hazard the source
 * warns about twice is ORDERING —
 *
 *     "This ALTER must stay AFTER the fromVersion < 7 rebuild: that rebuild
 *      copies a hard-coded column list into outbox_v7 and would drop a
 *      DDL-added column on a v6 -> v15 upgrade."
 *
 * — and nothing enforced it. The v6→v19 test below is that enforcement.
 *
 * How it runs
 * -----------
 * `node:sqlite` (built into Node 22, no new dependency) stands behind a
 * jest.mock of the op-sqlite native binding — the same technique
 * `sqlMessageStoreEngine.test.ts` established. The schema is always the REAL
 * exported `DDL`, never a copy (the B-129 drift class).
 *
 * The mock fakes exactly one thing beyond the binding shape: the SQLCipher-only
 * PRAGMAs (`cipher_memory_security`, `cipher_use_hmac`) and `ATTACH … KEY`,
 * which plain SQLite does not implement. Those are edges, and faking them is
 * what lets every other statement be real.
 *
 * The LEGACY table shapes seeded below are historical snapshots of schema v3 /
 * v6. They cannot drift, because those versions are frozen in the past — the
 * CURRENT schema always comes from the real `DDL` export.
 */

import {DatabaseSync} from 'node:sqlite';

interface ExecResult {rows?: Array<Record<string, unknown>>}

const mockState = {
  engines:  new Map<string, DatabaseSync>(),
  /** Every `open()` call, in order — proves what was opened and with which key. */
  opens:    [] as Array<{name: string; encryptionKey: string; location?: string}>,
  /** Every statement that reached a handle, in order — used for ordering pins. */
  sql:      [] as string[],
  /** What `PRAGMA [schema.]cipher_use_hmac` reports. Keyed by schema ('main'|'id'|'msg'). */
  hmac:     {} as Record<string, Array<Record<string, unknown>>>,
};

function mockHmacRowsFor(sql: string): Array<Record<string, unknown>> {
  const m = /PRAGMA\s+(?:(\w+)\.)?cipher_use_hmac/i.exec(sql);
  const schema = m?.[1] ?? 'main';
  return mockState.hmac[schema] ?? [{cipher_use_hmac: 1}];
}

function mockEngineFor(name: string): DatabaseSync {
  let e = mockState.engines.get(name);
  if (!e) {
    e = new DatabaseSync(':memory:');
    mockState.engines.set(name, e);
  }
  return e;
}

function mockOpen(opts: {name: string; encryptionKey: string; location?: string}) {
  mockState.opens.push({...opts});
  const raw = mockEngineFor(opts.name);
  return {
    async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
      const trimmed = sql.trim();
      mockState.sql.push(trimmed);
      if (/^PRAGMA/i.test(trimmed)) {
        if (/cipher_use_hmac/i.test(trimmed)) {return {rows: mockHmacRowsFor(trimmed)};}
        // cipher_memory_security is SQLCipher-only; WAL/busy_timeout/synchronous
        // are real but meaningless on :memory:. Apply best-effort, report nothing.
        try {raw.exec(trimmed);} catch {/* not a SQLCipher build */}
        return {rows: []};
      }
      // ATTACH … KEY is SQLCipher syntax; plain SQLite rejects the KEY clause.
      if (/^ATTACH\s+DATABASE/i.test(trimmed)) {return {rows: []};}
      if (/^SELECT/i.test(trimmed)) {
        const stmt = raw.prepare(trimmed);
        return {rows: stmt.all(...(params as never[])) as Array<Record<string, unknown>>};
      }
      if (params.length) {
        raw.prepare(trimmed).run(...(params.map(p => (p === undefined ? null : p)) as never[]));
      } else {
        raw.exec(trimmed);
      }
      return {rows: []};
    },
    close() { /* engine intentionally outlives the handle — same file on re-open */ },
  };
}

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (o: {name: string; encryptionKey: string; location?: string}) => mockOpen(o),
}));

import {openCryptoDb, openSecondaryDb, openCompartmentedDb, DDL} from '../crypto/db';
import {StoreError} from '@bravo/messenger-core';

const KEY = 'a'.repeat(64);
const HEX = (c: string) => c.repeat(64);

/** Column names of `table` in the engine backing `file`. */
function columnsOf(file: string, table: string): string[] {
  const raw = mockState.engines.get(file);
  if (!raw) {throw new Error(`no engine for ${file}`);}
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>)
    .map(r => r.name);
}

function pkColumnsOf(file: string, table: string): string[] {
  const raw = mockState.engines.get(file)!;
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string; pk: number}>)
    .filter(r => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(r => r.name);
}

function query<T = Record<string, unknown>>(file: string, sql: string): T[] {
  return mockState.engines.get(file)!.prepare(sql).all() as T[];
}

function seed(file: string, statements: string[]): void {
  const raw = mockEngineFor(file);
  for (const s of statements) {raw.exec(s);}
}

/**
 * Historical snapshot of the `messages` table as it existed at schema v3 —
 * before media_object_key (v4), call_meta_json (v5), media_key/media_iv (v12),
 * envelope_ids_json/receipts_json (v17) and the v18/v19 additions. Only the
 * columns the DDL's own indexes need are included; the point is what is ABSENT.
 */
const LEGACY_V3_MESSAGES = `CREATE TABLE messages (
  id              TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT,
  status          TEXT NOT NULL,
  is_encrypted    INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  peer_user_id    TEXT NOT NULL,
  peer_device_id  INTEGER NOT NULL,
  envelope_id     TEXT,
  PRIMARY KEY (conversation_id, id)
)`;

/** Historical snapshot of `outbox` at schema v6 — single-column PK, no soft_attempts. */
const LEGACY_V6_OUTBOX = `CREATE TABLE outbox (
  client_msg_id   TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  peer_user_id    TEXT NOT NULL,
  peer_device_id  INTEGER NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
)`;

const SCHEMA_VERSION_TABLE = 'CREATE TABLE schema_version (version INTEGER PRIMARY KEY)';

beforeEach(() => {
  for (const e of mockState.engines.values()) {e.close();}
  mockState.engines.clear();
  mockState.opens = [];
  mockState.sql   = [];
  mockState.hmac  = {};
});

describe('openCryptoDb — fresh install', () => {
  it('applies the real DDL and stamps the CURRENT schema version', async () => {
    await openCryptoDb({name: 'fresh.db', encryptionKey: KEY});
    const rows = query<{version: number}>('fresh.db', 'SELECT version FROM schema_version');
    expect(rows).toHaveLength(1);
    // Not hard-coded: the stamped version must equal the number of the newest
    // documented migration branch, and must be > the last shipped one we know of.
    expect(rows[0].version).toBeGreaterThanOrEqual(19);
  });

  it('creates every table the DDL declares', async () => {
    await openCryptoDb({name: 'fresh.db', encryptionKey: KEY});
    const declared = new Set<string>();
    for (const stmt of DDL) {
      const m = /CREATE TABLE IF NOT EXISTS (\w+)/i.exec(stmt);
      if (m) {declared.add(m[1]);}
    }
    const actual = new Set(
      query<{name: string}>('fresh.db', "SELECT name FROM sqlite_master WHERE type='table'")
        .map(r => r.name),
    );
    expect(declared.size).toBeGreaterThan(10);
    for (const t of declared) {expect(actual.has(t)).toBe(true);}
  });

  it('swallows the DDL block`s idempotent ALTERs instead of throwing on a fresh file', async () => {
    // The DDL carries `ALTER TABLE messages ADD COLUMN mentions_json TEXT` for
    // pre-v18 installs. On a fresh file the CREATE already declared the column,
    // so every one of those ALTERs raises "duplicate column name" — the loop's
    // swallow branch is the only reason a first boot works at all.
    const alters = DDL.filter(s => /^\s*ALTER\b/i.test(s));
    expect(alters.length).toBeGreaterThan(0);
    await expect(openCryptoDb({name: 'fresh.db', encryptionKey: KEY})).resolves.toBeDefined();
  });

  it('runs the SQLCipher hardening PRAGMAs BEFORE any other statement on the connection', async () => {
    // cipher_memory_security is rejected once the page cache has been touched,
    // so its position is a correctness requirement, not a style preference.
    await openCryptoDb({name: 'fresh.db', encryptionKey: KEY});
    expect(mockState.sql[0]).toMatch(/^PRAGMA cipher_memory_security=ON$/i);
    // B-650 — cap SQLCipher's own log level at ERROR immediately after: with
    // memory_security ON, every allocation's failed mlock() (Android's tiny
    // RLIMIT_MEMLOCK) logged a WARN — measured ~200+/s on device, 80-87% of
    // the whole logcat buffer. Verbosity only; the security posture above is
    // untouched and real cipher errors still log.
    expect(mockState.sql[1]).toMatch(/^PRAGMA cipher_log_level=ERROR$/i);
    expect(mockState.sql[2]).toMatch(/^PRAGMA cipher_use_hmac$/i);
    const firstDdl = mockState.sql.findIndex(s => /^CREATE\b/i.test(s));
    const wal      = mockState.sql.findIndex(s => /journal_mode=WAL/i.test(s));
    expect(wal).toBeGreaterThan(1);
    expect(firstDdl).toBeGreaterThan(wal);
  });

  it('is idempotent — a second open neither re-stamps nor re-migrates', async () => {
    await openCryptoDb({name: 'fresh.db', encryptionKey: KEY});
    mockState.sql = [];
    await expect(openCryptoDb({name: 'fresh.db', encryptionKey: KEY})).resolves.toBeDefined();
    // current === SCHEMA_VERSION, so the version row must NOT be rewritten.
    expect(mockState.sql.some(s => /^DELETE FROM schema_version/i.test(s))).toBe(false);
    expect(query('fresh.db', 'SELECT version FROM schema_version')).toHaveLength(1);
  });
});

describe('openCryptoDb — encryption-key gate', () => {
  it('rejects an empty key BEFORE touching the file', async () => {
    await expect(openCryptoDb({name: 'x.db', encryptionKey: ''}))
      .rejects.toBeInstanceOf(StoreError);
    // The critical half: nothing was opened, so a bad caller cannot leave a
    // half-initialised SQLCipher file behind.
    expect(mockState.opens).toHaveLength(0);
  });

  it('rejects a 31-char key and accepts 32 (the documented boundary)', async () => {
    await expect(openCryptoDb({name: 'a.db', encryptionKey: 'k'.repeat(31)}))
      .rejects.toThrow(/encryption key must be >= 32 chars/);
    await expect(openCryptoDb({name: 'b.db', encryptionKey: 'k'.repeat(32)}))
      .resolves.toBeDefined();
  });

  it('openSecondaryDb enforces the same gate and also does not open', async () => {
    await expect(openSecondaryDb({name: 'x.db', encryptionKey: 'short'}))
      .rejects.toBeInstanceOf(StoreError);
    expect(mockState.opens).toHaveLength(0);
  });
});

describe('openCryptoDb — cipher_use_hmac fail-loud gate', () => {
  it('refuses to open when the PRAGMA reports OFF', async () => {
    mockState.hmac.main = [{cipher_use_hmac: 0}];
    await expect(openCryptoDb({name: 'h.db', encryptionKey: KEY}))
      .rejects.toThrow(/cipher_use_hmac is OFF/);
  });

  it('refuses to open when the PRAGMA returns no rows (not a SQLCipher build)', async () => {
    mockState.hmac.main = [];
    await expect(openCryptoDb({name: 'h.db', encryptionKey: KEY}))
      .rejects.toThrow(/returned no rows/);
  });

  it.each([
    ['numeric 1',  1],
    ['string "1"', '1'],
    ['boolean',    true],
    ['string ON',  'ON'],
    ['string on',  'on'],
  ])('accepts %s as enabled (SQLCipher reporting modes differ)', async (_l, v) => {
    mockState.hmac.main = [{cipher_use_hmac: v}];
    await expect(openCryptoDb({name: 'h.db', encryptionKey: KEY})).resolves.toBeDefined();
  });

  it.each([
    ['numeric 0',   0],
    ['string "0"',  '0'],
    ['string OFF',  'OFF'],
    ['boolean false', false],
  ])('rejects %s as disabled', async (_l, v) => {
    mockState.hmac.main = [{cipher_use_hmac: v}];
    await expect(openCryptoDb({name: 'h.db', encryptionKey: KEY}))
      .rejects.toThrow(/cipher_use_hmac is OFF/);
  });

  it('reads the value positionally, not by column name', async () => {
    // The source comment says "the column name varies between SQLCipher
    // reporting modes; accept any column whose value resolves to 1".
    mockState.hmac.main = [{'PRAGMA cipher_use_hmac': 1}];
    await expect(openCryptoDb({name: 'h.db', encryptionKey: KEY})).resolves.toBeDefined();
  });
});

describe('runMigrations — schema v3 install upgrading to current', () => {
  const FILE = 'legacy3.db';

  beforeEach(() => {
    seed(FILE, [
      SCHEMA_VERSION_TABLE,
      'INSERT INTO schema_version (version) VALUES (3)',
      LEGACY_V3_MESSAGES,
      `INSERT INTO messages
         (id, conversation_id, sender_id, type, content, status, is_encrypted,
          created_at, peer_user_id, peer_device_id, envelope_id)
       VALUES ('m1','c1','u1','text','hello from v3','sent',1,'2024-01-01','u2',1,'env-1')`,
    ]);
  });

  it.each([
    ['media_object_key',    4],
    ['call_meta_json',      5],
    ['media_key',          12],
    ['media_iv',           12],
    ['envelope_ids_json',  17],
    ['receipts_json',      17],
    ['mentions_json',      18],
    ['edited_at',          18],
    ['deleted_for_all',    18],
    ['retract_tokens_json', 19],
    ['is_forwarded',       19],
  ])('adds messages.%s (schema v%i) to the legacy table', async (col) => {
    expect(columnsOf(FILE, 'messages')).not.toContain(col);
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    expect(columnsOf(FILE, 'messages')).toContain(col);
  });

  it('advances the stamped version to current', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const [row] = query<{version: number}>(FILE, 'SELECT version FROM schema_version');
    expect(row.version).toBeGreaterThanOrEqual(19);
    // Exactly one row — the migration DELETEs before INSERTing.
    expect(query(FILE, 'SELECT version FROM schema_version')).toHaveLength(1);
  });

  it('is FORWARD-ONLY — the pre-existing row survives with its content intact', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const rows = query<{id: string; content: string; envelope_id: string}>(
      FILE, 'SELECT id, content, envelope_id FROM messages',
    );
    expect(rows).toEqual([{id: 'm1', content: 'hello from v3', envelope_id: 'env-1'}]);
  });

  it('creates the tables introduced after v3 (seen_envelopes, group_master_keys, drafts)', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const tables = new Set(
      query<{name: string}>(FILE, "SELECT name FROM sqlite_master WHERE type='table'")
        .map(r => r.name),
    );
    for (const t of ['seen_envelopes', 'group_master_keys', 'drafts', 'pending_mutations']) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it('re-running the upgrade on an already-migrated file is a no-op, not a throw', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    await expect(openCryptoDb({name: FILE, encryptionKey: KEY})).resolves.toBeDefined();
    expect(query(FILE, 'SELECT * FROM messages')).toHaveLength(1);
  });
});

describe('runMigrations — schema v6 outbox rebuild (audit P0-N4) and the ORDERING invariant', () => {
  const FILE = 'legacy6.db';

  beforeEach(() => {
    seed(FILE, [
      SCHEMA_VERSION_TABLE,
      'INSERT INTO schema_version (version) VALUES (6)',
      LEGACY_V6_OUTBOX,
      `INSERT INTO outbox (client_msg_id, conversation_id, message_id, peer_user_id,
                           peer_device_id, payload, attempts, next_retry_at, created_at, status)
       VALUES ('cm1','c1','m1','u2',1,'{"p":1}',2,1000,900,'pending')`,
      `INSERT INTO outbox (client_msg_id, conversation_id, message_id, peer_user_id,
                           peer_device_id, payload, attempts, next_retry_at, created_at, status)
       VALUES ('cm2','c1','m2','u3',1,'{"p":2}',0,1100,950,'sending')`,
    ]);
  });

  it('widens the primary key to (client_msg_id, peer_user_id, peer_device_id)', async () => {
    expect(pkColumnsOf(FILE, 'outbox')).toEqual(['client_msg_id']);
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    expect(pkColumnsOf(FILE, 'outbox')).toEqual(['client_msg_id', 'peer_user_id', 'peer_device_id']);
  });

  it('copies every legacy row through the rebuild, preserving attempts', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const rows = query<{client_msg_id: string; attempts: number; status: string}>(
      FILE, 'SELECT client_msg_id, attempts, status FROM outbox ORDER BY client_msg_id',
    );
    expect(rows).toEqual([
      {client_msg_id: 'cm1', attempts: 2, status: 'pending'},
      {client_msg_id: 'cm2', attempts: 0, status: 'sending'},
    ]);
  });

  it('KEEPS soft_attempts after the rebuild — the stated migration-ordering hazard', async () => {
    // The v7 rebuild copies a HARD-CODED column list into outbox_v7. If the v15
    // ALTER ever runs before it, soft_attempts is silently dropped on every
    // v6-era install and the no-budget retry path freezes at the 1s backoff slot
    // (XO-3 / OM-07). This is the tripwire for that reordering.
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    expect(columnsOf(FILE, 'outbox')).toContain('soft_attempts');
    const [row] = query<{soft_attempts: number}>(
      FILE, "SELECT soft_attempts FROM outbox WHERE client_msg_id='cm1'",
    );
    expect(row.soft_attempts).toBe(0);
  });

  it('leaves no outbox_v7 scaffold behind', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const names = query<{name: string}>(
      FILE, "SELECT name FROM sqlite_master WHERE type='table'",
    ).map(r => r.name);
    expect(names).not.toContain('outbox_v7');
    expect(names).toContain('outbox');
  });

  it('restores idx_outbox_due, which the DROP TABLE took with it', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const idx = query<{name: string}>(
      FILE, "SELECT name FROM sqlite_master WHERE type='index'",
    ).map(r => r.name);
    expect(idx).toContain('idx_outbox_due');
  });

  it('the widened PK is what lets ONE message fan out to N peers (the whole point)', async () => {
    await openCryptoDb({name: FILE, encryptionKey: KEY});
    const raw = mockState.engines.get(FILE)!;
    // Same client_msg_id, different peer — impossible under the v6 PK.
    raw.exec(`INSERT INTO outbox (client_msg_id, conversation_id, message_id, peer_user_id,
                                  peer_device_id, payload, attempts, next_retry_at, created_at, status)
              VALUES ('cm1','c1','m1','u9',1,'{"p":9}',0,1000,900,'pending')`);
    expect(query(FILE, "SELECT 1 FROM outbox WHERE client_msg_id='cm1'")).toHaveLength(2);
    // …but the SAME peer twice is still rejected.
    expect(() => raw.exec(
      `INSERT INTO outbox (client_msg_id, conversation_id, message_id, peer_user_id,
                           peer_device_id, payload, attempts, next_retry_at, created_at, status)
       VALUES ('cm1','c1','m1','u9',1,'{"p":9}',0,1000,900,'pending')`,
    )).toThrow();
  });
});

describe('runMigrations — a post-rebuild install (v11) skips the v7 branch cleanly', () => {
  const FILE = 'legacy11.db';

  it('adds soft_attempts without touching the already-widened outbox', async () => {
    // Stand up the outbox from the REAL current DDL, then strip the column the
    // v15 migration is supposed to add — i.e. exactly a v11-era file.
    const modern = DDL.find(s => /CREATE TABLE IF NOT EXISTS outbox\b/i.test(s))!;
    seed(FILE, [
      SCHEMA_VERSION_TABLE,
      'INSERT INTO schema_version (version) VALUES (11)',
      modern.replace(/\n\s*soft_attempts[^\n]*\n/, '\n'),
    ]);
    expect(columnsOf(FILE, 'outbox')).not.toContain('soft_attempts');

    await openCryptoDb({name: FILE, encryptionKey: KEY});

    expect(columnsOf(FILE, 'outbox')).toContain('soft_attempts');
    expect(pkColumnsOf(FILE, 'outbox'))
      .toEqual(['client_msg_id', 'peer_user_id', 'peer_device_id']);
    expect(query<{version: number}>(FILE, 'SELECT version FROM schema_version')[0].version)
      .toBeGreaterThanOrEqual(19);
  });
});

describe('openSecondaryDb', () => {
  it('opens a working handle WITHOUT re-running the schema bootstrap', async () => {
    await openSecondaryDb({name: 'secondary.db', encryptionKey: KEY});
    // The DDL never ran on this virgin file — that is the entire contract.
    expect(mockState.sql.some(s => /^CREATE TABLE/i.test(s))).toBe(false);
    expect(() => query('secondary.db', 'SELECT version FROM schema_version'))
      .toThrow(/no such table/i);
  });

  it('mirrors the hardening PRAGMAs in the same order as the primary', async () => {
    await openSecondaryDb({name: 'secondary.db', encryptionKey: KEY});
    expect(mockState.sql[0]).toMatch(/^PRAGMA cipher_memory_security=ON$/i);
    // B-650 — the log cap rides on every handle, same slot as the primary.
    expect(mockState.sql[1]).toMatch(/^PRAGMA cipher_log_level=ERROR$/i);
    expect(mockState.sql[2]).toMatch(/^PRAGMA cipher_use_hmac$/i);
    expect(mockState.sql.filter(s => /journal_mode=WAL|busy_timeout|synchronous/i.test(s)))
      .toHaveLength(3);
  });

  it('applies the same fail-loud HMAC gate as the primary handle', async () => {
    mockState.hmac.main = [{cipher_use_hmac: 0}];
    await expect(openSecondaryDb({name: 'secondary.db', encryptionKey: KEY}))
      .rejects.toThrow(/cipher_use_hmac is OFF/);
  });

  it('opens the SAME file name as the primary by default (WAL sharing, not a new DB)', async () => {
    await openCryptoDb({encryptionKey: KEY});
    await openSecondaryDb({encryptionKey: KEY});
    expect(mockState.opens.map(o => o.name)).toEqual(['messenger-crypto.db', 'messenger-crypto.db']);
    // Same key too — a mismatch would silently produce an unreadable handle.
    expect(new Set(mockState.opens.map(o => o.encryptionKey)).size).toBe(1);
  });
});

describe('openCompartmentedDb — the three-file split', () => {
  const KEYS = {id: HEX('1'), rt: HEX('2'), msg: HEX('3')};

  it('opens rt as the primary and ATTACHes id then msg, in that order', async () => {
    await openCompartmentedDb({keys: KEYS, baseName: 'cmp'});
    // Exactly one native open — id and msg arrive through ATTACH.
    expect(mockState.opens).toEqual([
      {name: 'cmp-rt.db', encryptionKey: KEYS.rt, location: 'documents'},
    ]);
    const attaches = mockState.sql.filter(s => /^ATTACH DATABASE/i.test(s));
    expect(attaches).toHaveLength(2);
    expect(attaches[0]).toContain("'cmp-id.db' AS id");
    expect(attaches[1]).toContain("'cmp-msg.db' AS msg");
  });

  it('checks cipher_use_hmac on the primary AND on each attached schema', async () => {
    await openCompartmentedDb({keys: KEYS, baseName: 'cmp'});
    const checks = mockState.sql.filter(s => /cipher_use_hmac/i.test(s));
    expect(checks).toEqual([
      'PRAGMA cipher_use_hmac',
      'PRAGMA id.cipher_use_hmac',
      'PRAGMA msg.cipher_use_hmac',
    ]);
  });

  it('refuses when an ATTACHED compartment reports HMAC off, naming which one', async () => {
    mockState.hmac.msg = [{cipher_use_hmac: 0}];
    await expect(openCompartmentedDb({keys: KEYS, baseName: 'cmp'}))
      .rejects.toThrow(/cipher_use_hmac is OFF on attached 'msg'/);
  });

  it('validates all three keys BEFORE opening anything — no partial compartment', async () => {
    await expect(openCompartmentedDb({keys: {...KEYS, msg: 'nope'}, baseName: 'cmp'}))
      .rejects.toThrow(/compartment key 'msg' must be 64-char hex/);
    expect(mockState.opens).toHaveLength(0);
  });

  it('defaults the base name to "messenger" when the caller omits it', async () => {
    await openCompartmentedDb({keys: KEYS});
    expect(mockState.opens[0].name).toBe('messenger-rt.db');
    expect(mockState.sql.filter(s => /^ATTACH/i.test(s))[0]).toContain("'messenger-id.db'");
  });

  it('tolerates an attached PRAGMA that returns no rows (early-return branch)', async () => {
    // Deliberate asymmetry with the primary, which throws on no-rows: an ATTACH
    // that reports nothing is treated as "cannot tell", not as "unauthenticated".
    mockState.hmac.id = [];
    await expect(openCompartmentedDb({keys: KEYS, baseName: 'cmp'})).resolves.toBeDefined();
  });
});
