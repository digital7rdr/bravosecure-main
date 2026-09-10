/**
 * AUDIT-2026-08-13 B-6 — putIdentity's rotation wipe is ATOMIC.
 *
 * The sequential path was wipe-THEN-upsert across five PostgREST calls;
 * a failure between them stranded the OLD identity over a WIPED mirror,
 * and an abandoned setup left the owner's mirror_flushed ledger claiming
 * everything was flushed (BACKUP_LOOP I1) — a silently EMPTY backup.
 * The fix routes through ONE Postgres function (rpc), falling back to
 * the legacy path ONLY when the migration is absent.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ConfigService} from '@nestjs/config';
import {HttpException} from '@nestjs/common';
import {BackupService} from './backup.service';

const MIGRATION = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations',
  '20260814190000_put_identity_rotation_atomic.sql');
const SERVICE = join(__dirname, 'backup.service.ts');

type RpcResult = {data: unknown; error: {code?: string; message: string} | null};

function makeClient(opts: {
  rpc?: jest.Mock<Promise<RpcResult>, [string, Record<string, unknown>]>;
}) {
  const writes: string[] = [];
  const from = (table: string) => ({
    select: () => ({eq: () => ({maybeSingle: async () => ({data: null, error: null})})}),
    upsert: async () => { writes.push(`upsert:${table}`); return {error: null}; },
    delete: () => ({eq: async () => { writes.push(`delete:${table}`); return {error: null}; }}),
  });
  return {client: {from, ...(opts.rpc ? {rpc: opts.rpc} : {})}, writes};
}

function makeService(client: unknown): BackupService {
  const cfg = new ConfigService({
    backup: {
      supabaseUrl: 'http://test', supabaseServiceRoleKey: 'svc',
      maxFailedAttempts: 3, lockoutSeconds: 3600, maxMessageBatchSize: 500,
    },
  });
  const svc = new BackupService(cfg as never, {client: {}} as never);
  (svc as never as {client: unknown}).client = client;
  return svc;
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const payload = {
  wrappedMasterKey:      b64('master-key-bytes'),
  salt:                  b64('salt-bytes'),
  kdfParams:             {algo: 'argon2id'},
  wrappedIdentityBundle: b64('bundle-bytes'),
  verifierKey:           b64('verifier-bytes'),
};
const USER = '11111111-2222-3333-4444-555555555555';

describe('AUDIT B-6 — the atomic rpc path', () => {
  beforeEach(() => {
    (BackupService as never as {warnedAtomicRpcMissing: boolean}).warnedAtomicRpcMissing = false;
  });

  it('one rpc call carries every decoded field; ZERO table writes ride beside it', async () => {
    const rpc = jest.fn().mockResolvedValue({data: {had_existing: true, rotated: true}, error: null});
    const {client, writes} = makeClient({rpc});
    await expect(makeService(client).putIdentity(USER, payload)).resolves.toEqual({ok: true});
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe('put_identity_rotation_atomic');
    expect(args).toEqual({
      p_user_id:                 USER,
      p_wrapped_master_key:      '\\x' + Buffer.from('master-key-bytes').toString('hex'),
      p_salt:                    '\\x' + Buffer.from('salt-bytes').toString('hex'),
      p_kdf_params:              {algo: 'argon2id'},
      p_wrapped_identity_bundle: '\\x' + Buffer.from('bundle-bytes').toString('hex'),
      p_verifier_key:            '\\x' + Buffer.from('verifier-bytes').toString('hex'),
    });
    // The atomicity pin: the service performs NO sequential writes when
    // the rpc handles it — wipes and upsert live inside the function.
    expect(writes).toEqual([]);
  });

  it('an rpc failure that is NOT missing-function surfaces 502 and NEVER falls back', async () => {
    // Falling back on a live-but-failing function would re-open the
    // exact non-atomic windows this item closes; the client retries the
    // ATOMIC path instead.
    const rpc = jest.fn().mockResolvedValue({data: null, error: {code: '40001', message: 'serialization failure'}});
    const {client, writes} = makeClient({rpc});
    await expect(makeService(client).putIdentity(USER, payload)).rejects.toThrow(HttpException);
    expect(writes).toEqual([]);
  });

  it('missing function (migration not applied) falls back to the legacy sequential path', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: {code: 'PGRST202', message: 'Could not find the function public.put_identity_rotation_atomic'},
    });
    const {client, writes} = makeClient({rpc});
    await expect(makeService(client).putIdentity(USER, payload)).resolves.toEqual({ok: true});
    // No existing row in the fake → first-seen upsert, no wipes.
    expect(writes).toEqual(['upsert:identity_backups']);
  });

  it('F2: each missing-code classifies ALONE — bare 42883, phraseless PGRST202 (clauses individually pinned)', async () => {
    // The critic mutation-proved the old disjunction: dropping any one
    // clause survived because the single fixture satisfied all of them.
    for (const error of [
      {code: '42883', message: 'function does not exist'},          // no phrase
      {code: 'PGRST202', message: 'no candidate matched the call'}, // no phrase
    ]) {
      const rpc = jest.fn().mockResolvedValue({data: null, error});
      const {client, writes} = makeClient({rpc});
      await expect(makeService(client).putIdentity(USER, payload)).resolves.toEqual({ok: true});
      expect(writes).toEqual(['upsert:identity_backups']);
    }
  });

  it('F2/P4: a live function whose ERROR TEXT contains the phrase must NOT fall back (code-gated only)', async () => {
    // A P0001 raised INSIDE a healthy function ("Could not find the
    // function it depends on") is a live failure — falling back re-opens
    // the windowed path. The old message-regex admitted exactly this.
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: {code: 'P0001', message: 'Could not find the function it depends on: helper_x'},
    });
    const {client, writes} = makeClient({rpc});
    await expect(makeService(client).putIdentity(USER, payload)).rejects.toThrow(HttpException);
    expect(writes).toEqual([]);
  });

  it('F4: {error: null, data: null} (the postgrest 404→204 rewrite) is NOT success — 502, zero writes, no ledger purge signal', async () => {
    const rpc = jest.fn().mockResolvedValue({data: null, error: null});
    const {client, writes} = makeClient({rpc});
    await expect(makeService(client).putIdentity(USER, payload)).rejects.toThrow(HttpException);
    expect(writes).toEqual([]);
  });

  it('a client with no rpc surface (legacy stub) uses the sequential path unchanged', async () => {
    const {client, writes} = makeClient({});
    await expect(makeService(client).putIdentity(USER, payload)).resolves.toEqual({ok: true});
    expect(writes).toEqual(['upsert:identity_backups']);
  });

  it('decode-before-write: a malformed field 400s with ZERO writes (the wipe-then-throw window is dead)', async () => {
    // Pre-B-6, salt/bundle/verifier decoded AFTER the rotation wipes —
    // a rotation request with one bad field wiped the mirror, then 400'd.
    // (decodeB64 is permissive on garbage CHARS — Buffer.from strips
    // them — so the throwing shapes are non-string/empty fields.)
    const {client, writes} = makeClient({});
    await expect(
      makeService(client).putIdentity(USER, {...payload, salt: ''}),
    ).rejects.toThrow(/invalid_salt/);
    expect(writes).toEqual([]);
  });
});

describe('AUDIT B-6 --- the rpc CONTRACT is read from the .sql, never from spec literals (edge MUST-FIX)', () => {
  // A typo in a p_* name makes PostgREST resolve a DIFFERENT (missing)
  // function -> PGRST202 -> classified missing -> PERMANENT silent
  // fallback to the windowed sequential path behind one warn line. The
  // service and a literals-only spec can share the typo and stay green;
  // only reading the migration breaks the same-wrong-reading-twice loop.
  const sql = readFileSync(MIGRATION, 'utf8');
  const svc = readFileSync(SERVICE, 'utf8');

  it('EVERY service rpc call site matches the function signature (names + order)', () => {
    // Two call sites exist: putIdentity itself and the F3 boot probe. A
    // typo in EITHER is the silent-fallback (or lying-probe) failure
    // mode, so all of them are held to the SQL.
    const sig = sql.match(/CREATE OR REPLACE FUNCTION public\.put_identity_rotation_atomic\(([\s\S]*?)\)\s*RETURNS/);
    expect(sig).not.toBeNull();
    const sqlParams = sig![1].split(',').map(s => s.trim().split(/\s+/)[0]);
    expect(sqlParams).toHaveLength(6); // anti-vacuous
    const calls = [...svc.matchAll(/rpc\('put_identity_rotation_atomic',\s*\{([\s\S]*?)\}\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2); // putIdentity + boot probe
    for (const c of calls) {
      const svcArgs = [...c[1].matchAll(/(p_[a-z_]+)\s*:/g)].map(m => m[1]);
      expect(svcArgs).toEqual(sqlParams);
    }
  });

  it('REVOKE/GRANT target the exact overload the CREATE declares', () => {
    // A type-list drift makes GRANT EXECUTE hit a non-existent overload:
    // service_role gets no EXECUTE -> permission error -> 502 forever
    // (correctly NOT fallback --- but the function never runs either).
    const sig = sql.match(/CREATE OR REPLACE FUNCTION public\.put_identity_rotation_atomic\(([\s\S]*?)\)\s*RETURNS/);
    const types = sig![1].split(',').map(s => s.trim().split(/\s+/).slice(1).join(' ')).join(', ');
    const grants = [...sql.matchAll(/put_identity_rotation_atomic\(([^)]*)\)/g)].slice(1);
    expect(grants.length).toBeGreaterThanOrEqual(2); // REVOKE + GRANT
    for (const g of grants) {
      expect(g[1].trim()).toBe(types);
    }
  });
});

describe('AUDIT B-6 --- the SQL body is source-pinned (edge MUST-FIX: three mutants survived every behavioral test)', () => {
  // Node has no Postgres --- the function body never EXECUTES in any
  // gate, so its decisions must be pinned in the text (the inverted-
  // Lua-gate lesson: pin the DECISION, not just the shape around it).
  const sql = readFileSync(MIGRATION, 'utf8');

  it('the rotation gate uses IS DISTINCT FROM (a bare = never rotates a legacy NULL row: stale mirror under a new key)', () => {
    expect(sql).toMatch(/v_existing_key\s+IS DISTINCT FROM\s+p_wrapped_master_key/);
  });

  it('lock -> gate -> all four wipes -> upsert, in that order', () => {
    const lock = sql.indexOf('FOR UPDATE');
    const gate = sql.indexOf('IF v_rotated THEN');
    const wipes = ['messages_backup', 'conversation_backups', 'backup_session_snapshots', 'backup_merkle_commits']
      .map(t => sql.indexOf(`DELETE FROM public.${t}`));
    const upsert = sql.indexOf('INSERT INTO public.identity_backups');
    expect(lock).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(lock);
    for (const w of wipes) {
      expect(w).toBeGreaterThan(gate);
      expect(upsert).toBeGreaterThan(w);
    }
  });
});
