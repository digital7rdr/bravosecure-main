/**
 * SYNC-7 — durable pending-reaction stash. In-memory mock of exactly the SQL
 * the store emits (same approach as pendingGroupEnvelopeStore.test.ts).
 */

import {
  PendingReactionStore,
  PENDING_REACTION_MAX_PER_CONVERSATION,
  PENDING_REACTION_MAX_GLOBAL,
  PENDING_REACTIONS_RETENTION_MS,
} from '../store/pendingReactionStore';

interface Row {
  rowid: number;
  conversation_id: string;
  target_msg_id: string;
  from_user_id: string;
  emoji: string;
  removed: number;
  received_at_ms: number;
}

function makeMockDb() {
  const rows: Row[] = [];
  let nextRowid = 1;
  const execute = async (sql: string, params: unknown[] = []): Promise<{rows?: unknown[]; rowsAffected?: number}> => {
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    if (trimmed.startsWith('INSERT OR REPLACE INTO pending_reactions')) {
      const [conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms] =
        params as [string, string, string, string, number, number];
      const i = rows.findIndex(r =>
        r.conversation_id === conversation_id &&
        r.target_msg_id === target_msg_id &&
        r.from_user_id === from_user_id);
      const row: Row = {rowid: nextRowid++, conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms};
      if (i >= 0) {rows.splice(i, 1, row);} else {rows.push(row);}
      return {rowsAffected: 1};
    }
    if (trimmed.startsWith('DELETE FROM pending_reactions WHERE rowid IN')) {
      const perConvo = trimmed.includes('WHERE conversation_id = ?');
      let victims: Row[];
      if (perConvo) {
        const [convId, , cap] = params as [string, string, number];
        const pool = rows.filter(r => r.conversation_id === convId)
          .sort((a, b) => a.received_at_ms - b.received_at_ms);
        victims = pool.slice(0, Math.max(0, pool.length - cap));
      } else {
        const [cap] = params as [number];
        const pool = [...rows].sort((a, b) => a.received_at_ms - b.received_at_ms);
        victims = pool.slice(0, Math.max(0, pool.length - cap));
      }
      for (const v of victims) {
        const i = rows.findIndex(r => r.rowid === v.rowid);
        if (i >= 0) {rows.splice(i, 1);}
      }
      return {rowsAffected: victims.length};
    }
    if (trimmed.startsWith('SELECT conversation_id, target_msg_id')) {
      const byTarget = trimmed.includes('WHERE conversation_id = ? AND target_msg_id = ?');
      const matched = (byTarget
        ? rows.filter(r => r.conversation_id === params[0] && r.target_msg_id === params[1])
        : [...rows]
      ).sort((a, b) => a.received_at_ms - b.received_at_ms);
      return {rows: matched.map(r => ({...r}))};
    }
    if (trimmed.startsWith('DELETE FROM pending_reactions WHERE conversation_id = ? AND target_msg_id = ?')) {
      const [convId, target] = params as [string, string];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].conversation_id === convId && rows[i].target_msg_id === target) {rows.splice(i, 1);}
      }
      return {rowsAffected: 0};
    }
    if (trimmed.startsWith('DELETE FROM pending_reactions WHERE received_at_ms < ?')) {
      const [cutoff] = params as [number];
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].received_at_ms < cutoff) {rows.splice(i, 1); n++;}
      }
      return {rowsAffected: n};
    }
    if (trimmed.startsWith('SELECT COUNT(*) AS n FROM pending_reactions')) {
      return {rows: [{n: rows.length}]};
    }
    throw new Error(`unhandled SQL: ${trimmed}`);
  };
  return {db: {execute}, rows};
}

const row = (over: Partial<{conversationId: string; targetMsgId: string; fromUserId: string; emoji: string; removed: boolean; receivedAtMs: number}> = {}) => ({
  conversationId: over.conversationId ?? 'c1',
  targetMsgId:    over.targetMsgId ?? 't1',
  fromUserId:     over.fromUserId ?? 'alice',
  emoji:          over.emoji ?? '👍',
  removed:        over.removed ?? false,
  receivedAtMs:   over.receivedAtMs ?? 1000,
});

describe('SYNC-7 — PendingReactionStore', () => {
  test('stash → listForTarget round-trips, removed as boolean', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    await store.stash(row({removed: true}));
    const [r] = await store.listForTarget('c1', 't1');
    expect(r).toEqual(row({removed: true}));
  });

  test('same (chat, target, reactor) twice → one row, newest emoji wins', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    await store.stash(row({emoji: '👍', receivedAtMs: 1000}));
    await store.stash(row({emoji: '❤️', receivedAtMs: 2000}));
    const rows = await store.listForTarget('c1', 't1');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('❤️');
  });

  test('different reactors on the same target → independent rows', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    await store.stash(row({fromUserId: 'alice'}));
    await store.stash(row({fromUserId: 'bob', emoji: '🎉'}));
    expect(await store.listForTarget('c1', 't1')).toHaveLength(2);
  });

  test('per-conversation cap evicts the oldest', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    for (let i = 0; i <= PENDING_REACTION_MAX_PER_CONVERSATION; i++) {
      await store.stash(row({targetMsgId: `t${i}`, receivedAtMs: i}));
    }
    expect(await store._size()).toBe(PENDING_REACTION_MAX_PER_CONVERSATION);
    // The oldest (receivedAtMs 0) was the one evicted.
    expect(await store.listForTarget('c1', 't0')).toHaveLength(0);
  });

  test('global cap evicts across conversations', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    const perConvo = 200; // below the per-convo cap so only the global cap binds
    const convos = Math.ceil((PENDING_REACTION_MAX_GLOBAL + perConvo) / perConvo);
    let ts = 0;
    for (let c = 0; c < convos; c++) {
      for (let i = 0; i < perConvo; i++) {
        await store.stash(row({conversationId: `c${c}`, targetMsgId: `t${i}`, receivedAtMs: ts++}));
      }
    }
    expect(await store._size()).toBe(PENDING_REACTION_MAX_GLOBAL);
  });

  test('prune deletes only rows past retention', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    const now = 10_000_000_000_000;
    await store.stash(row({targetMsgId: 'old', receivedAtMs: now - PENDING_REACTIONS_RETENTION_MS - 1}));
    await store.stash(row({targetMsgId: 'young', receivedAtMs: now - PENDING_REACTIONS_RETENTION_MS + 1}));
    const pruned = await store.prune(now);
    expect(pruned).toBe(1);
    expect(await store.listForTarget('c1', 'young')).toHaveLength(1);
    expect(await store.listForTarget('c1', 'old')).toHaveLength(0);
  });

  test('deleteForTarget removes only that target', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    await store.stash(row({targetMsgId: 't1'}));
    await store.stash(row({targetMsgId: 't2'}));
    await store.deleteForTarget('c1', 't1');
    expect(await store.listForTarget('c1', 't1')).toHaveLength(0);
    expect(await store.listForTarget('c1', 't2')).toHaveLength(1);
  });

  test('listAll returns everything oldest-first (boot sweep order)', async () => {
    const {db} = makeMockDb();
    const store = new PendingReactionStore(db as never);
    await store.stash(row({targetMsgId: 'b', receivedAtMs: 2000}));
    await store.stash(row({targetMsgId: 'a', receivedAtMs: 1000}));
    const all = await store.listAll();
    expect(all.map(r => r.targetMsgId)).toEqual(['a', 'b']);
  });
});
