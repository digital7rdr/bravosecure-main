import {GroupMasterKeyStore} from '../store/groupMasterKeyStore';
import type {DbHandle} from '../crypto/db';

/**
 * Audit P0-S3 / P0-S5 — at-rest persistence for group master keys.
 *
 * GroupMasterKeyStore wraps each group's master key under a per-user
 * AES-GCM "wrap secret" before writing it to the SQLCipher
 * group_master_keys table. The wrap secret lives in a SEPARATE
 * keychain entry from the SQLCipher DB key — so a single-keychain
 * extraction recovers EITHER:
 *   - the SQLCipher DB key but not the wrap (wrapped_key blobs are
 *     readable but indistinguishable from random bytes), OR
 *   - the wrap secret but not the SQLCipher DB key (no rows to
 *     unwrap).
 *
 * These tests exercise the round-trip + the cross-wrap-key isolation.
 */

interface Row {
  group_id:    string;
  wrapped_key: Uint8Array;
  iv:          Uint8Array;
  updated_at:  number;
}

function makeStubDb(): DbHandle {
  const rows = new Map<string, Row>();
  const db = {
    async execute(sql: string, params: unknown[] = []): Promise<unknown> {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('CREATE TABLE')) {return {rows: []};}
      if (s.startsWith('INSERT OR REPLACE INTO group_master_keys')) {
        const [gid, wrapped, iv, ts] =
          params as [string, Uint8Array, Uint8Array, number];
        rows.set(gid, {
          group_id:    gid,
          wrapped_key: new Uint8Array(wrapped),
          iv:          new Uint8Array(iv),
          updated_at:  ts,
        });
        return {rowsAffected: 1};
      }
      if (s.startsWith('SELECT wrapped_key, iv FROM group_master_keys WHERE')) {
        const [gid] = params as [string];
        const r = rows.get(gid);
        return {rows: r ? [{wrapped_key: r.wrapped_key, iv: r.iv}] : []};
      }
      if (s.startsWith('SELECT group_id, wrapped_key, iv FROM group_master_keys')) {
        return {rows: Array.from(rows.values()).map(r => ({
          group_id: r.group_id, wrapped_key: r.wrapped_key, iv: r.iv,
        }))};
      }
      if (s.startsWith('DELETE FROM group_master_keys WHERE')) {
        const [gid] = params as [string];
        rows.delete(gid);
        return {rowsAffected: 1};
      }
      if (s.startsWith('DELETE FROM group_master_keys')) {
        const n = rows.size;
        rows.clear();
        return {rowsAffected: n};
      }
      throw new Error('unmocked SQL: ' + s);
    },
  } as unknown as DbHandle;
  return db;
}

function randomKeyB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

describe('GroupMasterKeyStore — audit P0-S3 / P0-S5', () => {
  it('round-trips a wrapped master key', async () => {
    const wrap = randomKeyB64();
    const store = new GroupMasterKeyStore(makeStubDb(), wrap);
    const master = randomKeyB64();
    await store.setKey('g-1', master);
    const back = await store.getKey('g-1');
    expect(back).toBe(master);
  });

  it('returns undefined for an unknown groupId', async () => {
    const store = new GroupMasterKeyStore(makeStubDb(), randomKeyB64());
    expect(await store.getKey('never-stored')).toBeUndefined();
  });

  it('unwrap fails closed when the wrap secret was rotated under the same row', async () => {
    // Simulates a one-shot SQLCipher key extraction without the
    // separate wrap-key compartment: the attacker can read the row
    // but the GCM tag check fails because the wrap key differs.
    const db = makeStubDb();
    const writer = new GroupMasterKeyStore(db, randomKeyB64());
    await writer.setKey('g-1', randomKeyB64());
    // Attacker holds a different wrap secret.
    const attacker = new GroupMasterKeyStore(db, randomKeyB64());
    expect(await attacker.getKey('g-1')).toBeUndefined();
  });

  it('two distinct sets produce different IVs (GCM nonce reuse defence)', async () => {
    // We can't directly inspect IVs from the public API, but we CAN
    // assert that re-writing the SAME plaintext produces a DIFFERENT
    // wrapped_key on disk — which would only be true if the IV was
    // fresh (GCM with fixed key + fixed IV = byte-identical ciphertext).
    const db = makeStubDb();
    const stash: Array<{wrapped: Uint8Array; iv: Uint8Array}> = [];
    const wrappedDb = {
      async execute(sql: string, params: unknown[] = []): Promise<unknown> {
        const out = await (db as unknown as {execute: (s: string, p: unknown[]) => Promise<unknown>}).execute(sql, params);
        if (sql.replace(/\s+/g, ' ').trim().startsWith('INSERT OR REPLACE INTO group_master_keys')) {
          const [, wrapped, iv] = params as [string, Uint8Array, Uint8Array, number];
          stash.push({wrapped: new Uint8Array(wrapped), iv: new Uint8Array(iv)});
        }
        return out;
      },
    } as unknown as DbHandle;
    const store = new GroupMasterKeyStore(wrappedDb, randomKeyB64());
    const master = randomKeyB64();
    await store.setKey('g-1', master);
    await store.setKey('g-1', master);
    expect(stash).toHaveLength(2);
    // IVs MUST differ (we generate fresh 12-byte random IVs per write)
    expect(stash[0].iv).not.toEqual(stash[1].iv);
    // Ciphertexts MUST differ as a consequence
    expect(stash[0].wrapped).not.toEqual(stash[1].wrapped);
  });

  it('loadAll surfaces every wrapped row to the warm path', async () => {
    const wrap = randomKeyB64();
    const store = new GroupMasterKeyStore(makeStubDb(), wrap);
    const a = randomKeyB64();
    const b = randomKeyB64();
    const c = randomKeyB64();
    await store.setKey('g-a', a);
    await store.setKey('g-b', b);
    await store.setKey('g-c', c);
    const all = await store.loadAll();
    expect(all).toEqual({'g-a': a, 'g-b': b, 'g-c': c});
  });

  it('deleteKey purges one row but leaves others intact', async () => {
    const wrap = randomKeyB64();
    const store = new GroupMasterKeyStore(makeStubDb(), wrap);
    const a = randomKeyB64();
    const b = randomKeyB64();
    await store.setKey('g-a', a);
    await store.setKey('g-b', b);
    await store.deleteKey('g-a');
    expect(await store.getKey('g-a')).toBeUndefined();
    expect(await store.getKey('g-b')).toBe(b);
  });

  it('deleteAll wipes the entire table — used by the logout wipe path', async () => {
    const wrap = randomKeyB64();
    const store = new GroupMasterKeyStore(makeStubDb(), wrap);
    await store.setKey('g-a', randomKeyB64());
    await store.setKey('g-b', randomKeyB64());
    await store.deleteAll();
    expect(await store.loadAll()).toEqual({});
  });

  it('rejects a wrap key that is not 32 bytes', async () => {
    const tooShort = Buffer.from('short').toString('base64');
    const store = new GroupMasterKeyStore(makeStubDb(), tooShort);
    await expect(store.setKey('g-1', randomKeyB64())).rejects.toThrow(
      /group wrap key must be 32 bytes/,
    );
  });

  it('setKey + getKey for empty groupId is a no-op (defensive)', async () => {
    const store = new GroupMasterKeyStore(makeStubDb(), randomKeyB64());
    await store.setKey('', randomKeyB64());
    expect(await store.getKey('')).toBeUndefined();
  });
});
