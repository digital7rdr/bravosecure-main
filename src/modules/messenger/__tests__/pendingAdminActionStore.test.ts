/**
 * Bug-hunt #5 follow-through — durable stash for admin actions that
 * arrived out-of-epoch order.
 *
 * Same mock pattern as `pendingGroupEnvelopeStore.test.ts`.
 */

import {
  PendingAdminActionStore,
  PENDING_ADMIN_MAX_PER_GROUP,
  PENDING_ADMIN_ACTIONS_RETENTION_MS,
} from '../store/pendingAdminActionStore';

interface Row {
  id:             number;
  group_id:       string;
  action_epoch:   number;
  sender_user_id: string;
  action_json:    string;
  received_at_ms: number;
  attempts:       number;
}

function makeMockDb() {
  const rows: Row[] = [];
  let nextId = 1;
  const execute = async (
    sql: string,
    params?: unknown[],
  ): Promise<{rows?: unknown[]; rowsAffected?: number}> => {
    if (/^INSERT INTO pending_admin_actions/.test(sql)) {
      const p = params as [string, number, string, string, number];
      rows.push({
        id:             nextId++,
        group_id:       p[0],
        action_epoch:   p[1],
        sender_user_id: p[2],
        action_json:    p[3],
        received_at_ms: p[4],
        attempts:       0,
      });
      return {rowsAffected: 1};
    }
    if (
      /^DELETE FROM pending_admin_actions/.test(sql) &&
      /SELECT id/.test(sql) &&
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
        const idx = rows.findIndex(x => x.id === r.id);
        if (idx >= 0) {rows.splice(idx, 1);}
      }
      return {rowsAffected: toDelete.length};
    }
    if (
      /^DELETE FROM pending_admin_actions/.test(sql) &&
      /SELECT id/.test(sql) &&
      /ORDER BY/.test(sql)
    ) {
      const cap = (params as unknown[])[0] as number;
      const sorted = rows.slice().sort((a, b) => a.received_at_ms - b.received_at_ms);
      const overflow = Math.max(0, sorted.length - cap);
      const toDelete = sorted.slice(0, overflow);
      for (const r of toDelete) {
        const idx = rows.findIndex(x => x.id === r.id);
        if (idx >= 0) {rows.splice(idx, 1);}
      }
      return {rowsAffected: toDelete.length};
    }
    if (/^SELECT id, group_id, action_epoch/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      const matched = rows
        .filter(r => r.group_id === groupId)
        .sort((a, b) => a.action_epoch - b.action_epoch || a.received_at_ms - b.received_at_ms);
      return {rows: matched.map(r => ({...r}))};
    }
    if (/^DELETE FROM pending_admin_actions WHERE id = \?/.test(sql)) {
      const id = (params as unknown[])[0] as number;
      const idx = rows.findIndex(r => r.id === id);
      if (idx >= 0) {rows.splice(idx, 1); return {rowsAffected: 1};}
      return {rowsAffected: 0};
    }
    if (/^UPDATE pending_admin_actions/.test(sql)) {
      const id = (params as unknown[])[0] as number;
      const row = rows.find(r => r.id === id);
      if (row) {row.attempts += 1;}
      return {rowsAffected: row ? 1 : 0};
    }
    if (/^SELECT attempts FROM pending_admin_actions/.test(sql)) {
      const id = (params as unknown[])[0] as number;
      const row = rows.find(r => r.id === id);
      return {rows: row ? [{attempts: row.attempts}] : []};
    }
    if (/^DELETE FROM pending_admin_actions WHERE received_at_ms < \?/.test(sql)) {
      const cutoff = (params as unknown[])[0] as number;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].received_at_ms < cutoff) {rows.splice(i, 1);}
      }
      return {rowsAffected: before - rows.length};
    }
    if (/^SELECT COUNT\(\*\) AS n FROM pending_admin_actions/.test(sql)) {
      return {rows: [{n: rows.length}]};
    }
    return {rows: []};
  };
  return {db: {execute}, rows};
}

describe('bug-hunt #3.D — PendingAdminActionStore', () => {
  it('stash + listForGroup round-trips', async () => {
    const {db, rows} = makeMockDb();

    const store = new PendingAdminActionStore(db as any);
    await store.stash({
      groupId:      'g-1',
      actionEpoch:  3,
      senderUserId: 'alice',
      action:       {type: 'rekey', newMasterKeyB64: 'k', atEpoch: 3},
      receivedAtMs: 1000,
    });
    expect(rows).toHaveLength(1);
    const got = await store.listForGroup('g-1');
    expect(got[0].actionEpoch).toBe(3);
    expect(JSON.parse(got[0].actionJson)).toEqual({
      type: 'rekey', newMasterKeyB64: 'k', atEpoch: 3,
    });
  });

  it('listForGroup returns actions sorted by action_epoch (then received_at_ms)', async () => {
    const {db} = makeMockDb();

    const store = new PendingAdminActionStore(db as any);
    await store.stash({groupId: 'g-1', actionEpoch: 5, senderUserId: 'a', action: {type: 'rekey'}, receivedAtMs: 1000});
    await store.stash({groupId: 'g-1', actionEpoch: 3, senderUserId: 'a', action: {type: 'add'}, receivedAtMs: 1500});
    await store.stash({groupId: 'g-1', actionEpoch: 4, senderUserId: 'a', action: {type: 'remove'}, receivedAtMs: 2000});
    const got = await store.listForGroup('g-1');
    expect(got.map(r => r.actionEpoch)).toEqual([3, 4, 5]);
  });

  it('delete + bumpAttempts work as expected', async () => {
    const {db} = makeMockDb();

    const store = new PendingAdminActionStore(db as any);
    await store.stash({groupId: 'g-1', actionEpoch: 1, senderUserId: 'a', action: {type: 'rekey'}, receivedAtMs: 1000});
    const [row] = await store.listForGroup('g-1');
    expect(await store.bumpAttempts(row.id)).toBe(1);
    expect(await store.bumpAttempts(row.id)).toBe(2);
    await store.delete(row.id);
    expect(await store._size()).toBe(0);
  });

  it('per-group cap evicts oldest', async () => {
    const {db} = makeMockDb();

    const store = new PendingAdminActionStore(db as any);
    for (let i = 0; i < PENDING_ADMIN_MAX_PER_GROUP + 3; i++) {
      await store.stash({
        groupId: 'g-1', actionEpoch: i, senderUserId: 'a',
        action: {type: 'rekey'}, receivedAtMs: 1000 + i,
      });
    }
    expect(await store._size()).toBe(PENDING_ADMIN_MAX_PER_GROUP);
  });

  it('prune deletes rows older than RETENTION_MS', async () => {
    const {db} = makeMockDb();

    const store = new PendingAdminActionStore(db as any);
    const now = 1_000_000_000_000;
    await store.stash({groupId: 'g-1', actionEpoch: 1, senderUserId: 'a', action: {type: 'rekey'}, receivedAtMs: now - 1000});
    await store.stash({groupId: 'g-1', actionEpoch: 2, senderUserId: 'a', action: {type: 'rekey'}, receivedAtMs: now - PENDING_ADMIN_ACTIONS_RETENTION_MS - 1});
    const deleted = await store.prune(now);
    expect(deleted).toBe(1);
    expect(await store._size()).toBe(1);
  });
});
