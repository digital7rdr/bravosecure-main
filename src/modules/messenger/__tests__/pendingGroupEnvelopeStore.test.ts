/**
 * Bug-hunt #3.A — durable stash for group envelopes that arrived
 * before the local master key.
 *
 * These tests use an in-memory DbHandle mock that emulates the subset
 * of SQLite semantics the store relies on:
 *   - INSERT OR REPLACE into pending_group_envelopes
 *   - DELETE … WHERE envelope_id IN (SELECT … ORDER BY received_at_ms ASC LIMIT N)
 *   - SELECT … WHERE group_id = ? ORDER BY received_at_ms ASC
 *   - UPDATE … SET attempts = attempts + 1
 *   - DELETE … WHERE received_at_ms < cutoff
 *
 * The mock is small and tightly coupled to the actual SQL the store
 * emits; if you change the store's SQL, you'll need to teach the mock
 * the new shape.
 */

import {
  PendingGroupEnvelopeStore,
  PENDING_GROUP_MAX_PER_GROUP,
  PENDING_GROUP_MAX_GLOBAL,
  PENDING_GROUP_ENVELOPES_RETENTION_MS,
} from '../store/pendingGroupEnvelopeStore';

interface Row {
  envelope_id:    string;
  group_id:       string;
  peer_user_id:   string;
  peer_device_id: number;
  sealed_json:    string;
  received_at_ms: number;
  attempts:       number;
}

function makeMockDb() {
  const rows: Row[] = [];
  const execute = async (
    sql: string,
    params?: unknown[],
  ): Promise<{rows?: unknown[]; rowsAffected?: number}> => {
    // INSERT OR REPLACE
    if (/^INSERT OR REPLACE INTO pending_group_envelopes/.test(sql)) {
      const p = params as [string, string, string, number, string, number];
      const existing = rows.findIndex(r => r.envelope_id === p[0]);
      const row: Row = {
        envelope_id:    p[0],
        group_id:       p[1],
        peer_user_id:   p[2],
        peer_device_id: p[3],
        sealed_json:    p[4],
        received_at_ms: p[5],
        attempts:       0,
      };
      if (existing >= 0) {rows.splice(existing, 1, row);}
      else               {rows.push(row);}
      return {rowsAffected: 1};
    }
    // Cap-enforcement DELETEs — both forms share the structural pattern
    // "delete oldest until count <= cap". The per-group cap binds
    // [group_id, group_id, CAP]; the global cap binds [CAP]. Detect
    // which is which by checking for the literal "WHERE group_id = ?"
    // substring (per-group) before the inner SELECT.
    if (
      /^DELETE FROM pending_group_envelopes/.test(sql) &&
      /SELECT envelope_id/.test(sql) &&
      /WHERE group_id = \?/.test(sql)
    ) {
      const groupId = (params as unknown[])[0] as string;
      const cap     = (params as unknown[])[2] as number;
      const groupRows = rows
        .filter(r => r.group_id === groupId)
        .sort((a, b) => a.received_at_ms - b.received_at_ms);
      const overflow = Math.max(0, groupRows.length - cap);
      const toDelete = groupRows.slice(0, overflow);
      for (const r of toDelete) {
        const idx = rows.findIndex(x => x.envelope_id === r.envelope_id);
        if (idx >= 0) {rows.splice(idx, 1);}
      }
      return {rowsAffected: toDelete.length};
    }
    if (
      /^DELETE FROM pending_group_envelopes/.test(sql) &&
      /SELECT envelope_id/.test(sql) &&
      /ORDER BY/.test(sql)
    ) {
      const cap = (params as unknown[])[0] as number;
      const sorted = rows.slice().sort((a, b) => a.received_at_ms - b.received_at_ms);
      const overflow = Math.max(0, sorted.length - cap);
      const toDelete = sorted.slice(0, overflow);
      for (const r of toDelete) {
        const idx = rows.findIndex(x => x.envelope_id === r.envelope_id);
        if (idx >= 0) {rows.splice(idx, 1);}
      }
      return {rowsAffected: toDelete.length};
    }
    // listForGroup
    if (/^SELECT envelope_id, group_id/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      const matched = rows
        .filter(r => r.group_id === groupId)
        .sort((a, b) => a.received_at_ms - b.received_at_ms);
      return {rows: matched.map(r => ({...r}))};
    }
    // delete by envelope_id
    if (/^DELETE FROM pending_group_envelopes WHERE envelope_id = \?/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const idx = rows.findIndex(r => r.envelope_id === envelopeId);
      if (idx >= 0) {rows.splice(idx, 1); return {rowsAffected: 1};}
      return {rowsAffected: 0};
    }
    // bumpAttempts UPDATE
    if (/^UPDATE pending_group_envelopes/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const row = rows.find(r => r.envelope_id === envelopeId);
      if (row) {row.attempts += 1;}
      return {rowsAffected: row ? 1 : 0};
    }
    // bumpAttempts SELECT attempts
    if (/^SELECT attempts FROM pending_group_envelopes/.test(sql)) {
      const envelopeId = (params as unknown[])[0] as string;
      const row = rows.find(r => r.envelope_id === envelopeId);
      return {rows: row ? [{attempts: row.attempts}] : []};
    }
    // prune
    if (/^DELETE FROM pending_group_envelopes WHERE received_at_ms < \?/.test(sql)) {
      const cutoff = (params as unknown[])[0] as number;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].received_at_ms < cutoff) {rows.splice(i, 1);}
      }
      return {rowsAffected: before - rows.length};
    }
    // size counts
    if (/^SELECT COUNT\(\*\) AS n FROM pending_group_envelopes WHERE group_id = \?/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      return {rows: [{n: rows.filter(r => r.group_id === groupId).length}]};
    }
    if (/^SELECT COUNT\(\*\) AS n FROM pending_group_envelopes/.test(sql)) {
      return {rows: [{n: rows.length}]};
    }
    return {rows: []};
  };
  return {db: {execute}, rows};
}

describe('bug-hunt #3 — PendingGroupEnvelopeStore', () => {
  it('stash + listForGroup round-trips a payload', async () => {
    const {db, rows} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({
      envelopeId:   'env-1',
      groupId:      'g-1',
      peerUserId:   'alice',
      peerDeviceId: 1,
      sealed:       {body: 'ciphertext', group: {groupId: 'g-1'}},
      receivedAtMs: 1000,
    });
    expect(rows).toHaveLength(1);
    const got = await store.listForGroup('g-1');
    expect(got).toHaveLength(1);
    expect(got[0].envelopeId).toBe('env-1');
    expect(JSON.parse(got[0].sealedJson)).toEqual({
      body: 'ciphertext', group: {groupId: 'g-1'},
    });
  });

  it('stash is idempotent on same envelopeId (INSERT OR REPLACE)', async () => {
    const {db, rows} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({
      envelopeId: 'env-1', groupId: 'g-1', peerUserId: 'alice', peerDeviceId: 1,
      sealed: {v: 1}, receivedAtMs: 1000,
    });
    await store.stash({
      envelopeId: 'env-1', groupId: 'g-1', peerUserId: 'alice', peerDeviceId: 1,
      sealed: {v: 2}, receivedAtMs: 2000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].received_at_ms).toBe(2000);
  });

  it('listForGroup returns oldest first', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({envelopeId: 'env-b', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 2000});
    await store.stash({envelopeId: 'env-a', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 1000});
    await store.stash({envelopeId: 'env-c', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 3000});
    const rows = await store.listForGroup('g-1');
    expect(rows.map(r => r.envelopeId)).toEqual(['env-a', 'env-b', 'env-c']);
  });

  it('listForGroup is per-group (other groups not returned)', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({envelopeId: 'env-1', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 1000});
    await store.stash({envelopeId: 'env-2', groupId: 'g-2', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 2000});
    const g1 = await store.listForGroup('g-1');
    const g2 = await store.listForGroup('g-2');
    expect(g1.map(r => r.envelopeId)).toEqual(['env-1']);
    expect(g2.map(r => r.envelopeId)).toEqual(['env-2']);
  });

  it('delete removes one row by envelopeId', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({envelopeId: 'env-1', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 1000});
    await store.stash({envelopeId: 'env-2', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 2000});
    await store.delete('env-1');
    const left = await store.listForGroup('g-1');
    expect(left.map(r => r.envelopeId)).toEqual(['env-2']);
  });

  it('bumpAttempts increments and returns the new value', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    await store.stash({envelopeId: 'env-1', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1, sealed: {}, receivedAtMs: 1000});
    expect(await store.bumpAttempts('env-1')).toBe(1);
    expect(await store.bumpAttempts('env-1')).toBe(2);
    expect(await store.bumpAttempts('env-1')).toBe(3);
  });

  it('per-group cap evicts oldest entries when exceeded', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    // Fill past the cap.
    for (let i = 0; i < PENDING_GROUP_MAX_PER_GROUP + 5; i++) {
      await store.stash({
        envelopeId:   `env-${i}`,
        groupId:      'g-1',
        peerUserId:   'a', peerDeviceId: 1,
        sealed:       {},
        receivedAtMs: 1000 + i,
      });
    }
    const size = await store._sizeForGroup('g-1');
    expect(size).toBe(PENDING_GROUP_MAX_PER_GROUP);
    const rows = await store.listForGroup('g-1');
    // Oldest 5 (env-0..env-4) should have been evicted.
    expect(rows[0].envelopeId).toBe('env-5');
  });

  it('global cap evicts oldest across groups when exceeded', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    // Spread across enough groups that the per-group cap never triggers
    // (each group stays well under PENDING_GROUP_MAX_PER_GROUP) but the
    // global cap does. With MAX_GLOBAL=2048 and MAX_PER_GROUP=256, we
    // need at least ceil(2048/256) = 8 distinct groups. Use 16 groups
    // so each holds ~128 rows when the global cap fires.
    const NUM_GROUPS = 16;
    const N = PENDING_GROUP_MAX_GLOBAL + 4;
    for (let i = 0; i < N; i++) {
      await store.stash({
        envelopeId:   `env-${i}`,
        groupId:      `g-${i % NUM_GROUPS}`,
        peerUserId:   'a', peerDeviceId: 1,
        sealed:       {},
        receivedAtMs: 1000 + i,
      });
    }
    expect(await store._size()).toBe(PENDING_GROUP_MAX_GLOBAL);
  });

  it('prune deletes rows older than RETENTION_MS', async () => {
    const {db} = makeMockDb();

    const store = new PendingGroupEnvelopeStore(db as any);
    const now = 1_000_000_000_000;
    await store.stash({
      envelopeId: 'fresh', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1,
      sealed: {}, receivedAtMs: now - 1000,
    });
    await store.stash({
      envelopeId: 'ancient', groupId: 'g-1', peerUserId: 'a', peerDeviceId: 1,
      sealed: {}, receivedAtMs: now - PENDING_GROUP_ENVELOPES_RETENTION_MS - 1,
    });
    const deleted = await store.prune(now);
    expect(deleted).toBe(1);
    const left = await store.listForGroup('g-1');
    expect(left.map(r => r.envelopeId)).toEqual(['fresh']);
  });
});
