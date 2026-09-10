/**
 * SYNC-7 — the behavioural core: durable three-tier reaction application
 * (store window → SQLCipher lookup → pending stash) and the drain that
 * replays stashed reactions when their target lands.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

jest.mock('../runtime/blockedPeers', () => ({
  isPeerBlocked: jest.fn(() => false),
}));

import {
  applyReaction,
  drainPendingReactionsFor,
  sweepPendingReactions,
  setPendingReactionStore,
} from '../runtime/pendingReactionApply';
import {isPeerBlocked} from '../runtime/blockedPeers';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import type {PendingReactionRow} from '../store/pendingReactionStore';

const CONV = 'g-sync7';

function msg(id: string, over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: CONV,
    sender_id: 'alice',
    type: 'text',
    content: 'hello',
    status: 'delivered',
    is_encrypted: true,
    created_at: new Date(1_800_000_000_000).toISOString(),
    peer: {userId: 'alice', deviceId: 1},
    ...over,
  } as LocalMessage;
}

/** In-memory stand-in for the SQLCipher-backed stash. */
function makeFakeStash() {
  const rows: PendingReactionRow[] = [];
  return {
    rows,
    stash: async (r: PendingReactionRow) => {
      const i = rows.findIndex(x =>
        x.conversationId === r.conversationId &&
        x.targetMsgId === r.targetMsgId &&
        x.fromUserId === r.fromUserId);
      if (i >= 0) {rows.splice(i, 1, r);} else {rows.push(r);}
    },
    listForTarget: async (c: string, t: string) =>
      rows.filter(r => r.conversationId === c && r.targetMsgId === t),
    listAll: async () => [...rows],
    deleteForTarget: async (c: string, t: string) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].conversationId === c && rows[i].targetMsgId === t) {rows.splice(i, 1);}
      }
    },
    prune: async () => 0,
  };
}

function makeFakeSqlMessages() {
  const disk = new Map<string, LocalMessage>();
  return {
    disk,
    upsert: jest.fn(async (m: LocalMessage) => { disk.set(m.id, m); }),
    upsertCoalesced: jest.fn((m: LocalMessage) => { disk.set(m.id, m); }),
    findReactionTarget: jest.fn(async (_c: string, t: string) => disk.get(t) ?? null),
  };
}

describe('SYNC-7 — applyReaction / drainPendingReactionsFor', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
    setPendingReactionStore(null);
    (isPeerBlocked as jest.Mock).mockReturnValue(false);
  });

  it('M3 — a target in the store window is patched in the store AND persisted', async () => {
    const sql = makeFakeSqlMessages();
    useMessengerStore.getState().appendMessage(CONV, msg('m1'));
    await applyReaction(CONV, 'bob', 'm1', '👍', false, sql as never);
    expect(useMessengerStore.getState().messages[CONV]?.[0].reactions).toEqual({bob: '👍'});
    // The assertion that fails on the pre-fix code: the patch reaches SQL.
    expect(sql.upsertCoalesced).toHaveBeenCalledTimes(1);
    expect((sql.upsertCoalesced.mock.calls[0][0] as LocalMessage).reactions).toEqual({bob: '👍'});
  });

  it('M2 — a target on disk but outside the window is patched in SQL only', async () => {
    const sql = makeFakeSqlMessages();
    sql.disk.set('old-1', msg('old-1'));
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'bob', 'old-1', '🎉', false, sql as never);
    expect(sql.upsert).toHaveBeenCalledTimes(1);
    expect((sql.upsert.mock.calls[0][0] as LocalMessage).reactions).toEqual({bob: '🎉'});
    expect(useMessengerStore.getState().messages[CONV] ?? []).toHaveLength(0);
    expect(stash.rows).toHaveLength(0);
  });

  it('M1 — a reaction that beats its target is stashed, then drains when it lands', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);

    await applyReaction(CONV, 'bob', 'm2', '👍', false, sql as never, 123);
    expect(stash.rows).toEqual([{
      conversationId: CONV, targetMsgId: 'm2', fromUserId: 'bob',
      emoji: '👍', removed: false, receivedAtMs: 123,
    }]);
    expect(useMessengerStore.getState().messages[CONV] ?? []).toHaveLength(0);

    // The target lands (receive path appends + persists), then the drain hook.
    const target = msg('m2');
    useMessengerStore.getState().appendMessage(CONV, target);
    sql.disk.set('m2', target);
    await drainPendingReactionsFor(CONV, 'm2', sql as never);

    expect(useMessengerStore.getState().messages[CONV]?.[0].reactions).toEqual({bob: '👍'});
    const persisted = sql.upsert.mock.calls.map(c => c[0] as LocalMessage).find(m => m.id === 'm2');
    expect(persisted?.reactions).toEqual({bob: '👍'});
    expect(stash.rows).toHaveLength(0);
  });

  it('a peer blocked between stash and drain is skipped; the rest merge', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'mallory', 'm3', '💣', false, sql as never);
    await applyReaction(CONV, 'carol', 'm3', '🎉', false, sql as never);

    const target = msg('m3');
    useMessengerStore.getState().appendMessage(CONV, target);
    sql.disk.set('m3', target);
    (isPeerBlocked as jest.Mock).mockImplementation((uid: string) => uid === 'mallory');
    await drainPendingReactionsFor(CONV, 'm3', sql as never);

    expect(useMessengerStore.getState().messages[CONV]?.[0].reactions).toEqual({carol: '🎉'});
    expect(stash.rows).toHaveLength(0); // stash cleared either way
  });

  it('a stashed remove drains to a map without that reactor', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'bob', 'm4', '👍', true, sql as never);

    const target = msg('m4', {reactions: {bob: '👍', carol: '🎉'}});
    useMessengerStore.getState().appendMessage(CONV, target);
    sql.disk.set('m4', target);
    await drainPendingReactionsFor(CONV, 'm4', sql as never);
    expect(useMessengerStore.getState().messages[CONV]?.[0].reactions).toEqual({carol: '🎉'});
  });

  it('MM-05 window tier: reacting to a retracted message changes nothing and does not stash', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    useMessengerStore.getState().appendMessage(CONV, msg('del-1', {deleted_for_all: true, content: ''}));
    await applyReaction(CONV, 'bob', 'del-1', '👍', false, sql as never);
    expect(useMessengerStore.getState().messages[CONV]?.[0].reactions ?? {}).toEqual({});
    expect(stash.rows).toHaveLength(0);
  });

  it('MM-05 disk tier: a retracted on-disk target is neither patched nor stashed', async () => {
    const sql = makeFakeSqlMessages();
    sql.disk.set('del-2', msg('del-2', {deleted_for_all: true}));
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'bob', 'del-2', '🎉', false, sql as never);
    expect(sql.upsert).not.toHaveBeenCalled();
    expect(stash.rows).toHaveLength(0);
  });

  it('MM-05 drain: stashed reactions for a target that landed RETRACTED are discarded, not rendered', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'bob', 'del-3', '👍', false, sql as never, 5);
    expect(stash.rows).toHaveLength(1);
    sql.disk.set('del-3', msg('del-3', {deleted_for_all: true}));
    await drainPendingReactionsFor(CONV, 'del-3', sql as never);
    expect(stash.rows).toHaveLength(0);
    expect(sql.disk.get('del-3')!.reactions ?? {}).toEqual({});
  });

  it('boot sweep replays every stashed target that is now resolvable', async () => {
    const sql = makeFakeSqlMessages();
    const stash = makeFakeStash();
    setPendingReactionStore(stash as never);
    await applyReaction(CONV, 'bob', 'm5', '👍', false, sql as never);
    await applyReaction(CONV, 'bob', 'm6', '🎉', false, sql as never);
    // m5's target is on disk (restore landed it); m6's never arrived.
    sql.disk.set('m5', msg('m5'));
    await sweepPendingReactions(sql as never);
    const persisted = sql.upsert.mock.calls.map(c => c[0] as LocalMessage).find(m => m.id === 'm5');
    expect(persisted?.reactions).toEqual({bob: '👍'});
    expect(stash.rows.map(r => r.targetMsgId)).toEqual(['m6']); // still waiting
  });

  it('null stores never throw (loopback / pre-wiring safety)', async () => {
    setPendingReactionStore(null);
    await expect(applyReaction(CONV, 'bob', 'mX', '👍', false, null)).resolves.toBeUndefined();
    await expect(drainPendingReactionsFor(CONV, 'mX', null)).resolves.toBeUndefined();
    await expect(sweepPendingReactions(null)).resolves.toBeUndefined();
  });
});
