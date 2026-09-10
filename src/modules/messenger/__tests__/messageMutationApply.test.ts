/**
 * Store actions + the three-tier applier for edit / delete-for-everyone.
 *
 * What this pins, beyond "it works":
 *  - the tombstone strips EVERY field that could still render or re-fetch the
 *    retracted content, and the in-memory and on-disk strip lists agree (two
 *    copies of that list is how a field gets retracted in memory and left on
 *    disk);
 *  - the chat-list preview follows the body, or a deleted message keeps
 *    rendering in the most visible surface in the app;
 *  - an unresolvable target STASHES rather than drops, and a replay is
 *    re-gated so a peer blocked in the meantime cannot get through.
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

import {useMessengerStore} from '../store/messengerStore';
import {
  applyMessageMutation,
  applyMutationInWindow,
  drainPendingMutationsFor,
  setPendingMutationStore,
} from '../runtime/messageMutationApply';
import {_resetBlockedPeersForTests} from '../runtime/blockedPeers';
import type {LocalConversation, LocalMessage} from '../store/types';
import type {PendingMutationRow, PendingMutationStore} from '../store/pendingMutationStore';

const CONV = 'g-1';
const PEER = 'u-peer';

function msg(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id:              'm1',
    conversation_id: CONV,
    sender_id:       PEER,
    type:            'text',
    content:         'original body',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      '2026-07-25T10:00:00.000Z',
    peer:            {userId: PEER, deviceId: 1},
    ...over,
  } as LocalMessage;
}

function convo(): LocalConversation {
  return {
    id: CONV, name: 'Group', type: 'group', participants: [PEER, 'u-me'],
    unread_count: 0, session_state: 'established', peer: {userId: PEER, deviceId: 1},
  } as unknown as LocalConversation;
}

function seed(messages: LocalMessage[]): void {
  useMessengerStore.setState({
    conversations: {[CONV]: {...convo(), last_message: messages[messages.length - 1]}},
    messages:      {[CONV]: messages},
    conversationOrder: [CONV],
  } as never);
}

function row(id = 'm1'): LocalMessage {
  return useMessengerStore.getState().messages[CONV].find(m => m.id === id)!;
}

/** In-memory PendingMutationStore double — the SQL surface is pinned elsewhere. */
function fakeStash() {
  const rows: PendingMutationRow[] = [];
  return {
    rows,
    store: {
      stash:           async (r: PendingMutationRow) => { rows.push(r); },
      listForTarget:   async (c: string, t: string) =>
        rows.filter(r => r.conversationId === c && r.targetMsgId === t),
      listAll:         async () => rows,
      deleteForTarget: async (c: string, t: string) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].conversationId === c && rows[i].targetMsgId === t) {rows.splice(i, 1);}
        }
      },
      prune: async () => 0,
      _size: async () => rows.length,
    } as unknown as PendingMutationStore,
  };
}

beforeEach(() => {
  _resetBlockedPeersForTests();
  setPendingMutationStore(null);
  useMessengerStore.setState({conversations: {}, messages: {}, conversationOrder: []} as never);
});

describe('applyMessageEdit — store action', () => {
  it('replaces the body and stamps edited_at', () => {
    seed([msg()]);
    useMessengerStore.getState().applyMessageEdit(CONV, 'm1', 'corrected', 555);
    expect(row().content).toBe('corrected');
    expect(row().edited_at).toBe(555);
  });

  it('CLEARS mentions when the edit no longer has any', () => {
    // Otherwise the old highlight survives against a body that no longer
    // contains the name.
    seed([msg({mentions: [{userId: 'u-a', label: 'Alice'}]})]);
    useMessengerStore.getState().applyMessageEdit(CONV, 'm1', 'no names now', 555);
    expect(row().mentions).toBeUndefined();
  });

  it('replaces mentions when the edit has new ones', () => {
    seed([msg({mentions: [{userId: 'u-a', label: 'Alice'}]})]);
    useMessengerStore.getState()
      .applyMessageEdit(CONV, 'm1', 'hi @Bob', 555, [{userId: 'u-b', label: 'Bob'}]);
    expect(row().mentions).toEqual([{userId: 'u-b', label: 'Bob'}]);
  });

  it('updates the chat-list preview when the edited row IS the preview', () => {
    seed([msg()]);
    useMessengerStore.getState().applyMessageEdit(CONV, 'm1', 'corrected', 555);
    expect(useMessengerStore.getState().conversations[CONV].last_message?.content).toBe('corrected');
  });

  it('does NOT promote an older edited message over a newer one', () => {
    const older = msg({id: 'm1', created_at: '2026-07-25T10:00:00.000Z'});
    const newer = msg({id: 'm2', created_at: '2026-07-25T11:00:00.000Z', content: 'newest'});
    seed([older, newer]);
    useMessengerStore.getState().applyMessageEdit(CONV, 'm1', 'edited old', 555);
    expect(useMessengerStore.getState().conversations[CONV].last_message?.id).toBe('m2');
    expect(useMessengerStore.getState().conversations[CONV].last_message?.content).toBe('newest');
  });

  it('is a no-op for an unknown id', () => {
    seed([msg()]);
    expect(() => useMessengerStore.getState().applyMessageEdit(CONV, 'nope', 'x', 1)).not.toThrow();
    expect(row().content).toBe('original body');
  });
});

describe('applyDeleteForEveryone — store action', () => {
  const MEDIA = msg({
    type: 'image', content: 'caption',
    media_mime: 'image/jpeg', media_object_key: 'att/abc',
    media_key: 'k', media_iv: 'iv',
    media_meta: {name: 'p.jpg', width: 10, height: 10},
    reactions: {'u-a': '👍'},
    mentions: [{userId: 'u-a', label: 'Alice'}],
    reply_to_msg_id: 'm0', reply_to_preview: 'quoted text',
    expires_at: Date.now() + 60_000,
  });

  it('strips every field that could still render or re-fetch the content', () => {
    seed([MEDIA]);
    useMessengerStore.getState().applyDeleteForEveryone(CONV, 'm1');
    const r = row();
    expect(r.deleted_for_all).toBe(true);
    expect(r.content).toBe('');
    expect(r.type).toBe('text');
    // media_object_key in particular: leaving it lets the attachment renderer
    // re-download and decrypt the blob the author just retracted.
    for (const f of ['media_mime', 'media_object_key', 'media_key', 'media_iv', 'media_meta',
                     'reactions', 'mentions', 'reply_to_msg_id', 'reply_to_preview', 'expires_at'] as const) {
      expect(r[f]).toBeUndefined();
    }
  });

  it('KEEPS the row — replies to it and the run-grouping must stay coherent', () => {
    seed([MEDIA]);
    useMessengerStore.getState().applyDeleteForEveryone(CONV, 'm1');
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
    expect(row().id).toBe('m1');
    expect(row().created_at).toBe('2026-07-25T10:00:00.000Z');
    expect(row().sender_id).toBe(PEER);
  });

  it('clears the chat-list preview body — the most visible leak if missed', () => {
    seed([MEDIA]);
    useMessengerStore.getState().applyDeleteForEveryone(CONV, 'm1');
    const last = useMessengerStore.getState().conversations[CONV].last_message;
    expect(last?.content).toBe('');
    expect(last?.deleted_for_all).toBe(true);
  });
});

describe('applyMutationInWindow — the M9 read-back', () => {
  it('returns the row AS COMMITTED, not the pre-patch object', () => {
    seed([msg()]);
    const patched = applyMutationInWindow(CONV, 'm1', {kind: 'edit', body: 'v2', editedAt: 9});
    expect(patched?.content).toBe('v2');
    expect(patched?.edited_at).toBe(9);
  });

  it('resolves a target by reply_to_msg_id as well as by id', () => {
    // The sender-chosen opaque id is what both reactions and replies key off.
    seed([msg({id: 'local-1', reply_to_msg_id: 'wire-1'})]);
    const patched = applyMutationInWindow(CONV, 'wire-1', {kind: 'delete', deletedAt: 1});
    expect(patched?.deleted_for_all).toBe(true);
  });

  it('returns null for an unknown target', () => {
    seed([msg()]);
    expect(applyMutationInWindow(CONV, 'unknown', {kind: 'delete', deletedAt: 1})).toBeNull();
  });
});

describe('applyMessageMutation — gating and tiers', () => {
  it('applies an authorised edit in-window', async () => {
    seed([msg()]);
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'edit', body: 'fixed', editedAt: 10}, sqlMessages: null,
    });
    expect(out).toMatchObject({kind: 'applied', wasInWindow: true});
    expect(row().content).toBe('fixed');
  });

  it('refuses a peer trying to delete OUR message, and leaves it untouched', async () => {
    seed([msg({sender_id: 'self', content: 'mine'})]);
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: null,
    });
    expect(out).toEqual({kind: 'dropped', reason: 'own-row'});
    expect(row().content).toBe('mine');
    expect(row().deleted_for_all).toBeUndefined();
  });

  it('refuses a peer trying to edit a third party\'s message', async () => {
    seed([msg({sender_id: 'u-other'})]);
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'edit', body: 'hijacked', editedAt: 10}, sqlMessages: null,
    });
    expect(out).toEqual({kind: 'dropped', reason: 'not-author'});
    expect(row().content).toBe('original body');
  });

  it('falls back to the ON-DISK tier for a target past the hydrated window', async () => {
    seed([]);
    const onDisk = msg({content: 'old body'});
    const upserts: LocalMessage[] = [];
    const sql = {
      findReactionTarget: async () => onDisk,
      upsert: async (m: LocalMessage) => { upserts.push(m); },
    } as never;
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'edit', body: 'new body', editedAt: 10}, sqlMessages: sql,
    });
    expect(out).toMatchObject({kind: 'applied', wasInWindow: false});
    expect(upserts).toHaveLength(1);
    expect(upserts[0].content).toBe('new body');
    expect(upserts[0].edited_at).toBe(10);
  });

  it('the on-disk tier is AUTHORISED too — it is not a bypass', async () => {
    seed([]);
    const sql = {
      findReactionTarget: async () => msg({sender_id: 'u-other'}),
      upsert: async () => { throw new Error('must not write'); },
    } as never;
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: sql,
    });
    expect(out).toEqual({kind: 'dropped', reason: 'not-author'});
  });

  it('the on-disk delete strips the SAME fields the in-memory one does', async () => {
    // Parity check: two copies of the strip list is how a field gets retracted
    // in memory and left on disk.
    const rich = msg({
      type: 'image', content: 'c', media_object_key: 'att/x', media_key: 'k', media_iv: 'iv',
      media_mime: 'image/jpeg', media_meta: {name: 'p.jpg'}, reactions: {'u-a': '👍'},
      mentions: [{userId: 'u-a', label: 'A'}], reply_to_msg_id: 'm0',
      reply_to_preview: 'q', expires_at: 1,
    });
    const upserts: LocalMessage[] = [];
    seed([]);
    await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10},
      sqlMessages: {
        findReactionTarget: async () => rich,
        upsert: async (m: LocalMessage) => { upserts.push(m); },
      } as never,
    });

    seed([rich]);
    useMessengerStore.getState().applyDeleteForEveryone(CONV, 'm1');
    const inMemory = row();

    for (const f of ['deleted_for_all', 'content', 'type', 'media_mime', 'media_object_key',
                     'media_key', 'media_iv', 'media_meta', 'reactions', 'mentions',
                     'reply_to_msg_id', 'reply_to_preview', 'expires_at'] as const) {
      expect({field: f, v: upserts[0][f]}).toEqual({field: f, v: inMemory[f]});
    }
  });
});

describe('stash + drain', () => {
  it('stashes a directive whose target we do not hold at all', async () => {
    const {rows, store} = fakeStash();
    setPendingMutationStore(store);
    seed([]);
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm-future', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: null,
    });
    expect(out).toEqual({kind: 'stashed'});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({kind: 'delete', targetMsgId: 'm-future', fromUserId: PEER});
  });

  it('replays the stashed delete when the target finally lands', async () => {
    const {store} = fakeStash();
    setPendingMutationStore(store);
    seed([]);
    await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: null,
    });
    // ...the group key arrives and the text drains in.
    seed([msg({content: 'the retracted text'})]);
    await drainPendingMutationsFor(CONV, 'm1', null);
    expect(row().deleted_for_all).toBe(true);
    expect(row().content).toBe('');
  });

  it('a delete in the stash WINS over an edit regardless of arrival order', async () => {
    const {store} = fakeStash();
    setPendingMutationStore(store);
    seed([]);
    // Delete stashed FIRST, edit second — the reverse of the desired apply order.
    await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 20}, sqlMessages: null,
    });
    await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'edit', body: 'resurrected!', editedAt: 30}, sqlMessages: null,
    });
    seed([msg()]);
    await drainPendingMutationsFor(CONV, 'm1', null);
    expect(row().deleted_for_all).toBe(true);
    expect(row().content).toBe('');
  });

  it('clears the stash after a drain so a later message cannot re-trigger it', async () => {
    const {rows, store} = fakeStash();
    setPendingMutationStore(store);
    seed([]);
    await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: null,
    });
    seed([msg()]);
    await drainPendingMutationsFor(CONV, 'm1', null);
    expect(rows).toHaveLength(0);
  });

  it('a directive with no stash store configured is reported, not silently swallowed', async () => {
    setPendingMutationStore(null);
    seed([]);
    const out = await applyMessageMutation({
      conversationId: CONV, targetMsgId: 'm1', fromUserId: PEER,
      directive: {kind: 'delete', deletedAt: 10}, sqlMessages: null,
    });
    expect(out).toEqual({kind: 'dropped', reason: 'no-stash-store'});
  });
});
