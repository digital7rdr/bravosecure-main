/**
 * AUDIT-2026-08-13 #20 — SqlCipherProtocolStore on a REAL SQLite engine.
 *
 * The existing coverage runs on SQL-string-matching stub DBs, where a
 * changed SQL text silently returns `{rows: []}` and the suite passes
 * vacuously. This suite runs the REAL exported DDL on node:sqlite
 * (sqlMessageStoreEngine pattern) and pins the crypto-store semantics
 * that only an engine can prove: the saveIdentity UPSERT + rotation-log
 * atomicity, the P0-I3 verification auto-clear on key flip, one-time
 * prekey consumption, and BLOB round-trip fidelity.
 *
 * Scope: storage semantics only; SQLCipher page encryption is native
 * and covered by on-device checks (MESSAGE_LOOP.md §8).
 */

jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {DatabaseSync} from 'node:sqlite';
import {IdentityDirection} from '@bravo/messenger-core';
import {DDL} from '../crypto/db';
import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';

interface ExecResult {rows?: unknown[]}

function makeEngineDb(): {db: {execute(sql: string, params?: unknown[]): Promise<ExecResult>}; raw: DatabaseSync} {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    db: {
      async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
        const trimmed = sql.trim();
        const isRead = /^\s*(SELECT|PRAGMA)/i.test(trimmed);
        const stmt = raw.prepare(trimmed);
        const bound = params.map(p => {
          if (p === undefined) {return null;}
          if (p instanceof ArrayBuffer) {return new Uint8Array(p);}
          return p;
        }) as never[];
        if (isRead) {
          return {rows: stmt.all(...bound) as unknown[]};
        }
        // Faithful to op-sqlite's QueryResult (edge review): rowsAffected
        // is REQUIRED there and six production consumers read it — an
        // adapter dropping it makes their green a fiction (measured:
        // markPeerVerified returned false for a SUCCESSFUL update).
        const r = stmt.run(...bound);
        return {rows: [], rowsAffected: Number(r.changes), insertId: Number(r.lastInsertRowid)};
      },
    },
  };
}

function applySchema(raw: DatabaseSync): void {
  for (const stmt of DDL) {
    try {
      raw.exec(stmt);
    } catch (e) {
      if (!/duplicate column name|already exists/i.test((e as Error).message)) {throw e;}
    }
  }
}

function boot(): {store: SqlCipherProtocolStore; raw: DatabaseSync} {
  const {db, raw} = makeEngineDb();
  applySchema(raw);
  return {store: new SqlCipherProtocolStore(db as never), raw};
}

const ab = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

const KEY_A = ab(1, 2, 3, 4);
const KEY_B = ab(9, 9, 9, 9);

afterEach(() => {
  delete (process.env as Record<string, string | undefined>).EXPO_PUBLIC_STRICT_IDENTITY_TRUST;
});

describe('AUDIT #20 — crypto store on the real engine', () => {
  it('identity reads fail LOUD before initialization (no silent zero-key)', async () => {
    const {store} = boot();
    await expect(store.getIdentityKeyPair()).rejects.toThrow('identity not initialized');
    await expect(store.getLocalRegistrationId()).rejects.toThrow('identity not initialized');
  });

  it('saveIdentity: first-seen inserts without a rotation row; re-assert preserves first_seen', async () => {
    const {store, raw} = boot();
    expect(await store.saveIdentity('peer.1', KEY_A)).toBe(false); // first-seen
    const firstSeen = (raw.prepare('SELECT first_seen FROM trusted_identities').get() as {first_seen: number}).first_seen;
    await new Promise(r => setTimeout(r, 5));
    expect(await store.saveIdentity('peer.1', KEY_A)).toBe(false); // re-assert
    const after = (raw.prepare('SELECT first_seen FROM trusted_identities').get() as {first_seen: number}).first_seen;
    expect(after).toBe(firstSeen); // safety-number diff UI depends on this
    const rotations = raw.prepare('SELECT COUNT(*) AS n FROM identity_rotations').get() as {n: number};
    expect(rotations.n).toBe(0);
  });

  it('saveIdentity on a KEY FLIP: returns true, writes the rotation row as HASHES, clears verification (P0-I3)', async () => {
    const {store, raw} = boot();
    await store.saveIdentity('peer.1', KEY_A);
    // Return contract exercisable now the adapter carries rowsAffected
    // (edge: it returned false for a successful UPDATE under the old
    // rows-only adapter).
    await expect(store.markPeerVerified('peer.1', 'a'.repeat(64))).resolves.toBe(true);
    expect(await store.saveIdentity('peer.1', KEY_B)).toBe(true);
    // The forensic row exists and holds hashes, never raw key bytes.
    const rot = raw.prepare('SELECT old_key_sha256, new_key_sha256 FROM identity_rotations').get() as
      {old_key_sha256: string; new_key_sha256: string};
    expect(rot.old_key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rot.new_key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rot.old_key_sha256).not.toBe(rot.new_key_sha256);
    // P0-I3 — the green checkmark must not survive a rotation.
    const v = await store.getPeerVerification('peer.1');
    expect(v?.verifiedAtMs ?? null).toBeNull();
  });

  it('isTrustedIdentity: receive-path TOFU by default; strict flag turns a flip into a rejection', async () => {
    const {store} = boot();
    await store.saveIdentity('peer.1', KEY_A);
    // Default (flag off): receiving always trusts — the sender cert is the anchor.
    expect(await store.isTrustedIdentity('peer.1', KEY_B, IdentityDirection.Receiving)).toBe(true);
    // Sending is ALWAYS strict, flag or no flag.
    expect(await store.isTrustedIdentity('peer.1', KEY_B, IdentityDirection.Sending)).toBe(false);
    expect(await store.isTrustedIdentity('peer.1', KEY_A, IdentityDirection.Sending)).toBe(true);
    // Cold contact stays TOFU-true in every mode.
    expect(await store.isTrustedIdentity('peer.new', KEY_B, IdentityDirection.Sending)).toBe(true);
    // Strict mode: the literal string 'true' only.
    (process.env as Record<string, string | undefined>).EXPO_PUBLIC_STRICT_IDENTITY_TRUST = 'TRUE';
    expect(await store.isTrustedIdentity('peer.1', KEY_B, IdentityDirection.Receiving)).toBe(true); // non-canonical → off
    (process.env as Record<string, string | undefined>).EXPO_PUBLIC_STRICT_IDENTITY_TRUST = 'true';
    expect(await store.isTrustedIdentity('peer.1', KEY_B, IdentityDirection.Receiving)).toBe(false);
    expect(await store.isTrustedIdentity('peer.1', KEY_A, IdentityDirection.Receiving)).toBe(true);
  });

  it('prekeys are ONE-TIME: store → load round-trips bytes, remove consumes permanently', async () => {
    const {store} = boot();
    await store.storePreKey(7, {pubKey: KEY_A, privKey: KEY_B});
    const loaded = await store.loadPreKey(7);
    expect(loaded).toBeDefined();
    expect(Array.from(new Uint8Array(loaded!.pubKey))).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(loaded!.privKey))).toEqual([9, 9, 9, 9]);
    await store.removePreKey(7);
    expect(await store.loadPreKey(7)).toBeUndefined();
  });

  it('sessions round-trip and removeAllSessions is PREFIX-scoped (every device of one peer, nobody else)', async () => {
    const {store} = boot();
    await store.storeSession('peer-a.1', 'record-a1');
    await store.storeSession('peer-a.2', 'record-a2');
    await store.storeSession('peer-b.1', 'record-b1');
    expect(await store.loadSession('peer-a.1')).toBe('record-a1');
    await store.removeAllSessions('peer-a');
    expect(await store.loadSession('peer-a.1')).toBeUndefined();
    expect(await store.loadSession('peer-a.2')).toBeUndefined();
    expect(await store.loadSession('peer-b.1')).toBe('record-b1');
  });

  it('storeSession is an upsert: a ratchet advance replaces the record in place', async () => {
    const {store, raw} = boot();
    await store.storeSession('peer-a.1', 'record-v1');
    await store.storeSession('peer-a.1', 'record-v2');
    expect(await store.loadSession('peer-a.1')).toBe('record-v2');
    const n = (raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {n: number}).n;
    expect(n).toBe(1);
  });

  it('signed prekeys: store, list, remove — and removal only hits the named id', async () => {
    const {store} = boot();
    // Engine nuance, worth recording: node:sqlite binds a ZERO-LENGTH
    // blob as NULL (op-sqlite stores an empty blob), so the
    // signature-omitted path can't be exercised faithfully here — both
    // rows carry real signatures.
    await store.storeSignedPreKey(1, {pubKey: KEY_A, privKey: KEY_B}, ab(5, 6));
    await store.storeSignedPreKey(2, {pubKey: KEY_B, privKey: KEY_A}, ab(7, 8));
    expect((await store.listSignedPreKeys()).map(k => k.keyId).sort()).toEqual([1, 2]);
    await store.removeSignedPreKey(1);
    expect((await store.listSignedPreKeys()).map(k => k.keyId)).toEqual([2]);
    expect(await store.loadSignedPreKey(2)).toBeDefined();
    expect(await store.loadSignedPreKey(1)).toBeUndefined();
  });
});
