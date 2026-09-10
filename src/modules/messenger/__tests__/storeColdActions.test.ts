/**
 * messengerStore actions that no test had ever EXECUTED: `clearMessages`,
 * `setConversationMuted`, `setConversationPinned`, `patchMessageMedia`,
 * `updateMessageCiphertext`, the connection/ready/error/banner setters, the
 * undecryptable-drop counter (including its 512-entry eviction), and the
 * "nothing to do" guard branch of nearly every mutator.
 *
 * The guard branches matter as much as the happy paths here: every one of these
 * actions is called from a screen with an id the store may no longer hold (a
 * chat deleted while a receipt was in flight, a media upload finishing after
 * the bubble was retracted). A missing guard is a crash inside an immer
 * producer, which takes the whole JS thread with it.
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
import type {LocalConversation, LocalMessage} from '../store/types';

const PEER = 'alice-uuid';

function msg(over: Partial<LocalMessage> & {id: string}): LocalMessage {
  return {
    conversation_id: 'c1',
    sender_id:       PEER,
    type:            'text',
    content:         'hi',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      '2026-08-01T10:00:00.000Z',
    peer:            {userId: PEER, deviceId: 1},
    ...over,
  } as LocalMessage;
}

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          id,
    participants:  [PEER],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

const st = () => useMessengerStore.getState();

beforeEach(() => {
  st().reset();
});

describe('clearMessages — "clear chat" keeps the row, drops the bubbles', () => {
  it('empties the list and clears the preview + badge, leaving the conversation', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    st().appendMessage('c1', msg({id: 'm2', conversation_id: 'c1', created_at: '2026-08-01T11:00:00.000Z'}));
    expect(st().conversations.c1?.unread_count).toBe(2);

    st().clearMessages('c1');

    // An EMPTY array, not a deleted key: the runtime's write-through subscriber
    // reads `[]` and issues the SQLCipher DELETE, so the clear survives restart.
    expect(st().messages.c1).toEqual([]);
    expect(st().conversations.c1).toBeDefined();
    expect(st().conversations.c1?.last_message).toBeUndefined();
    expect(st().conversations.c1?.unread_count).toBe(0);
  });

  it('is a no-op for a conversation that has no message list at all', () => {
    st().upsertConversation(convo('c1'));
    st().clearMessages('c1');
    // Must NOT mint an empty list — that would make the subscriber issue a
    // DELETE for a chat whose history is still only on disk.
    expect(st().messages.c1).toBeUndefined();
  });

  it('clears the bubbles of one chat without touching a sibling', () => {
    st().upsertConversation(convo('c1'));
    st().upsertConversation(convo('c2'));
    st().appendMessage('c1', msg({id: 'a', conversation_id: 'c1'}));
    st().appendMessage('c2', msg({id: 'b', conversation_id: 'c2'}));

    st().clearMessages('c1');

    expect(st().messages.c1).toEqual([]);
    expect(st().messages.c2?.map(m => m.id)).toEqual(['b']);
  });
});

describe('setConversationMuted', () => {
  it('flips the flag, and a muted chat stops bumping its unread badge', () => {
    st().upsertConversation(convo('c1'));
    st().setConversationMuted('c1', true);
    expect(st().conversations.c1?.is_muted).toBe(true);

    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    // BS-MUTE-UNREAD — the message still lands and still becomes the preview.
    expect(st().messages.c1).toHaveLength(1);
    expect(st().conversations.c1?.last_message?.id).toBe('m1');
    expect(st().conversations.c1?.unread_count).toBe(0);

    st().setConversationMuted('c1', false);
    st().appendMessage('c1', msg({id: 'm2', conversation_id: 'c1', created_at: '2026-08-01T12:00:00.000Z'}));
    expect(st().conversations.c1?.unread_count).toBe(1);
  });

  it('is a no-op (not a crash) for an unknown conversation id', () => {
    expect(() => st().setConversationMuted('ghost', true)).not.toThrow();
    expect(st().conversations.ghost).toBeUndefined();
  });
});

describe('setConversationPinned — pinned rows form a prefix of conversationOrder', () => {
  const pinnedPrefixLength = () => {
    const {conversationOrder, conversations} = st();
    let n = 0;
    while (n < conversationOrder.length && conversations[conversationOrder[n]]?.is_pinned) {n++;}
    return n;
  };

  it('moves a pinned chat to the head of the list', () => {
    st().upsertConversation(convo('a'));
    st().upsertConversation(convo('b'));
    st().upsertConversation(convo('c'));   // order: c, b, a (unshift)

    st().setConversationPinned('a', true);

    expect(st().conversations.a?.is_pinned).toBe(true);
    expect(st().conversationOrder[0]).toBe('a');
    expect(st().conversationOrder.slice(1).sort()).toEqual(['b', 'c']);
  });

  it('a second pin goes ABOVE the first, and every pin stays above every unpinned row', () => {
    st().upsertConversation(convo('a'));
    st().upsertConversation(convo('b'));
    st().upsertConversation(convo('c'));

    st().setConversationPinned('a', true);
    st().setConversationPinned('b', true);

    expect(st().conversationOrder[0]).toBe('b');
    expect(st().conversationOrder[1]).toBe('a');
    expect(pinnedPrefixLength()).toBe(2);
  });

  it('unpinning drops the row to the top of the UNPINNED block, not to the head', () => {
    st().upsertConversation(convo('a'));
    st().upsertConversation(convo('b'));
    st().upsertConversation(convo('c'));
    st().setConversationPinned('a', true);
    st().setConversationPinned('b', true);

    st().setConversationPinned('a', false);

    expect(st().conversations.a?.is_pinned).toBe(false);
    // b is the only pin left → it leads; a now heads the unpinned block.
    expect(st().conversationOrder[0]).toBe('b');
    expect(st().conversationOrder[1]).toBe('a');
    expect(pinnedPrefixLength()).toBe(1);
  });

  it('is a no-op for an unknown id and leaves conversationOrder untouched', () => {
    st().upsertConversation(convo('a'));
    const before = [...st().conversationOrder];
    st().setConversationPinned('ghost', true);
    expect(st().conversationOrder).toEqual(before);
  });

  it('MSG-12 — an inbound message to an unpinned chat lands BELOW the pinned prefix', () => {
    st().upsertConversation(convo('pinned'));
    st().upsertConversation(convo('a'));
    st().upsertConversation(convo('b'));
    st().setConversationPinned('pinned', true);
    expect(st().conversationOrder[0]).toBe('pinned');

    // 'b' is currently last; a new message must promote it to index 1, not 0.
    const last = st().conversationOrder[st().conversationOrder.length - 1];
    st().appendMessage(last, msg({id: 'in', conversation_id: last, created_at: '2026-08-09T10:00:00.000Z'}));

    expect(st().conversationOrder[0]).toBe('pinned');
    expect(st().conversationOrder[1]).toBe(last);
  });
});

describe('patchMessageMedia — post-upload stamping of an optimistic bubble', () => {
  const seed = () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({
      id: 'm1', conversation_id: 'c1', sender_id: 'self', type: 'text', content: '',
    }));
  };

  it('stamps every attachment field the upload produced', () => {
    seed();
    st().patchMessageMedia('c1', 'm1', {
      type:             'image',
      media_mime:       'image/jpeg',
      media_object_key: 'r2/abc',
      media_key:        'KEYB64',
      media_iv:         'IVB64',
      media_meta:       {name: 'photo.jpg', width: 100, height: 200},
    });

    const m = st().messages.c1?.[0];
    expect(m?.type).toBe('image');
    expect(m?.media_mime).toBe('image/jpeg');
    expect(m?.media_object_key).toBe('r2/abc');
    expect(m?.media_key).toBe('KEYB64');
    expect(m?.media_iv).toBe('IVB64');
    expect(m?.media_meta?.name).toBe('photo.jpg');
  });

  it('patches ONLY the fields present — an omitted field is left alone, not cleared', () => {
    seed();
    st().patchMessageMedia('c1', 'm1', {type: 'file', media_key: 'K1', media_iv: 'IV1'});
    // A second patch that carries only the object key (the upload's last stage)
    // must not wipe the key/iv the first patch stored — losing them makes the
    // attachment permanently undecryptable.
    st().patchMessageMedia('c1', 'm1', {media_object_key: 'r2/final'});

    const m = st().messages.c1?.[0];
    expect(m?.media_object_key).toBe('r2/final');
    expect(m?.media_key).toBe('K1');
    expect(m?.media_iv).toBe('IV1');
    expect(m?.type).toBe('file');
  });

  it('is a no-op when the bubble is gone (upload finished after a retract)', () => {
    seed();
    st().removeMessage('c1', 'm1');
    expect(() => st().patchMessageMedia('c1', 'm1', {media_object_key: 'r2/x'})).not.toThrow();
    expect(st().messages.c1).toEqual([]);
  });

  it('is a no-op for an unknown conversation id', () => {
    expect(() => st().patchMessageMedia('ghost', 'm1', {type: 'image'})).not.toThrow();
  });
});

describe('updateMessageCiphertext', () => {
  it('attaches the ciphertext to the right row and no other', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    st().appendMessage('c1', msg({id: 'm2', conversation_id: 'c1', created_at: '2026-08-01T11:00:00.000Z'}));

    st().updateMessageCiphertext('c1', 'm2', {type: 3, body: 'BODY'} as never);

    expect(st().messages.c1?.find(m => m.id === 'm1')?.ciphertext).toBeUndefined();
    expect(st().messages.c1?.find(m => m.id === 'm2')?.ciphertext).toEqual({type: 3, body: 'BODY'});
  });

  it('is a no-op for a missing message or conversation', () => {
    expect(() => st().updateMessageCiphertext('ghost', 'm1', undefined)).not.toThrow();
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    expect(() => st().updateMessageCiphertext('c1', 'nope', undefined)).not.toThrow();
  });
});

describe('guard branches — every mutator survives an id the store no longer holds', () => {
  it('removeMessage on a conversation with no list does not create one', () => {
    st().removeMessage('ghost', 'm1');
    expect(st().messages.ghost).toBeUndefined();
  });

  it('updateMessageRetractToken / updateMessageEnvelopeId no-op on a missing row', () => {
    st().upsertConversation(convo('c1'));
    expect(() => st().updateMessageRetractToken('c1', 'nope', 'TOK')).not.toThrow();
    expect(() => st().updateMessageEnvelopeId('c1', 'nope', 'ENV')).not.toThrow();
    expect(st().messages.c1).toBeUndefined();
  });

  it('applyDeleteForEveryone / applyMessageEdit no-op on a missing row', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    st().applyDeleteForEveryone('c1', 'nope');
    st().applyMessageEdit('c1', 'nope', 'new body', 123);
    expect(st().messages.c1?.[0]?.content).toBe('hi');
    expect(st().messages.c1?.[0]?.deleted_for_all).toBeUndefined();
  });

  it('updateMessageStatusBulk no-ops on an unknown conversation and on an empty id list', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1', sender_id: 'self', status: 'sent'}));

    st().updateMessageStatusBulk('ghost', ['m1'], 'read');
    st().updateMessageStatusBulk('c1', [], 'read');

    expect(st().messages.c1?.[0]?.status).toBe('sent');
  });

  it('recordReadReceipts no-ops on an unknown conversation, an empty id list and an empty userId', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1', sender_id: 'self', status: 'sent'}));

    st().recordReadReceipts('ghost', ['m1'], PEER, 1);
    st().recordReadReceipts('c1', [], PEER, 1);
    st().recordReadReceipts('c1', ['m1'], '', 1);

    expect(st().messages.c1?.[0]?.status).toBe('sent');
    expect(st().messages.c1?.[0]?.receipts).toBeUndefined();
  });

  it('recordReadReceipts skips rows that are not in the requested id set', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1', sender_id: 'self', status: 'sent'}));
    st().appendMessage('c1', msg({id: 'm2', conversation_id: 'c1', sender_id: 'self', status: 'sent', created_at: '2026-08-01T11:00:00.000Z'}));

    st().recordReadReceipts('c1', ['m2'], PEER, 1);

    expect(st().messages.c1?.find(m => m.id === 'm1')?.status).toBe('sent');
    expect(st().messages.c1?.find(m => m.id === 'm2')?.status).toBe('read');
  });

  it('recordDeliveredReceipt no-ops on a missing row, an empty userId and an INBOUND row', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'inbound', conversation_id: 'c1', sender_id: PEER, status: 'sent'}));

    st().recordDeliveredReceipt('c1', 'nope', PEER, 1);
    st().recordDeliveredReceipt('c1', 'inbound', '', 1);
    // A delivery ack for a message WE received is meaningless — the receipts map
    // must stay untouched so it can never drive our own tick.
    st().recordDeliveredReceipt('c1', 'inbound', PEER, 1);

    expect(st().messages.c1?.[0]?.receipts).toBeUndefined();
    expect(st().messages.c1?.[0]?.status).toBe('sent');
  });

  it('setDraft ignores a blank conversation id', () => {
    st().setDraft('', 'text that belongs nowhere');
    expect(st().drafts['']).toBeUndefined();
    expect(Object.keys(st().drafts)).toHaveLength(0);
  });

  it('prependOlderMessages no-ops on an empty page and on a page of pure duplicates', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'm1', conversation_id: 'c1'}));
    const before = st().messages.c1;

    st().prependOlderMessages('c1', []);
    expect(st().messages.c1).toBe(before);

    st().prependOlderMessages('c1', [msg({id: 'm1', conversation_id: 'c1'})]);
    expect(st().messages.c1).toHaveLength(1);
  });

  it('prependOlderMessages splices an older page in front and keeps the order stable', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'new', conversation_id: 'c1', created_at: '2026-08-01T20:00:00.000Z'}));

    st().prependOlderMessages('c1', [
      msg({id: 'b', conversation_id: 'c1', created_at: '2026-08-01T09:00:00.000Z'}),
      msg({id: 'a', conversation_id: 'c1', created_at: '2026-08-01T09:00:00.000Z'}),
    ]);

    // P1-N20 — equal timestamps break the tie on `id`, deterministically.
    expect(st().messages.c1?.map(m => m.id)).toEqual(['a', 'b', 'new']);
  });
});

describe('OM-06 — which message may take over the conversation preview', () => {
  it('a late OLDER inbound row does not regress the preview, but still bumps the badge', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'newer', conversation_id: 'c1', created_at: '2026-08-01T12:00:00.000Z'}));
    // A stashed no_key group message draining with its real send-time.
    st().appendMessage('c1', msg({id: 'older', conversation_id: 'c1', created_at: '2026-08-01T08:00:00.000Z'}));

    expect(st().conversations.c1?.last_message?.id).toBe('newer');
    // It IS an unseen message — it just isn't the newest.
    expect(st().conversations.c1?.unread_count).toBe(2);
  });

  it('our OWN send always takes the preview, even against a peer clock skewed into the future', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'skewed', conversation_id: 'c1', created_at: '2099-01-01T00:00:00.000Z'}));

    st().appendMessage('c1', msg({
      id: 'mine', conversation_id: 'c1', sender_id: 'self', created_at: '2026-08-01T10:00:00.000Z',
    }));

    // A peer must not be able to freeze our preview by lying about the time.
    expect(st().conversations.c1?.last_message?.id).toBe('mine');
  });

  it('an UNPARSEABLE timestamp falls through to "accept" so a malformed row cannot wedge the preview', () => {
    st().upsertConversation(convo('c1'));
    st().appendMessage('c1', msg({id: 'bad', conversation_id: 'c1', created_at: 'not-a-date'}));
    expect(st().conversations.c1?.last_message?.id).toBe('bad');

    // …and the next real message still takes over rather than being compared
    // against garbage and rejected forever.
    st().appendMessage('c1', msg({id: 'good', conversation_id: 'c1', created_at: '2026-08-01T10:00:00.000Z'}));
    expect(st().conversations.c1?.last_message?.id).toBe('good');
  });
});

describe('connection / lifecycle setters', () => {
  it('setConnection, setReady, setError and setRecoveryBanner each write their own slice', () => {
    st().setConnection('reconnecting');
    st().setReady(true);
    st().setError('boom');
    st().setRecoveryBanner('restoring…');

    expect(st().connection).toBe('reconnecting');
    expect(st().ready).toBe(true);
    expect(st().error).toBe('boom');
    expect(st().recoveryBanner).toBe('restoring…');

    st().setError(null);
    st().setRecoveryBanner(null);
    st().setConnection('device_evicted');
    expect(st().error).toBeNull();
    expect(st().recoveryBanner).toBeNull();
    expect(st().connection).toBe('device_evicted');
  });
});

describe('undecryptableDropCount — B-46 one drop per envelope', () => {
  it('counts an envelope once, however many times the same id is reported', () => {
    const id = `env-${Math.random()}`;
    const before = st().undecryptableDropCount;
    st().noteUndecryptableDrop(id);
    st().noteUndecryptableDrop(id);
    st().noteUndecryptableDrop(id);
    // WS-deliver and HTTP-drain racing on one envelope is ONE drop.
    expect(st().undecryptableDropCount).toBe(before + 1);
  });

  it('ignores a blank envelope id entirely', () => {
    const before = st().undecryptableDropCount;
    st().noteUndecryptableDrop('');
    expect(st().undecryptableDropCount).toBe(before);
  });

  it('clearUndecryptableDrops zeroes the badge', () => {
    st().noteUndecryptableDrop(`env-${Math.random()}`);
    expect(st().undecryptableDropCount).toBeGreaterThan(0);
    st().clearUndecryptableDrops();
    expect(st().undecryptableDropCount).toBe(0);
  });

  it('evicts the oldest id past the 512 cap, so the dedup set cannot grow unbounded', () => {
    st().clearUndecryptableDrops();
    const tag = `cap-${Math.random()}`;
    const first = `${tag}-0`;
    for (let i = 0; i < 600; i++) {st().noteUndecryptableDrop(`${tag}-${i}`);}
    const afterFill = st().undecryptableDropCount;
    expect(afterFill).toBe(600);

    // The earliest ids have been evicted from the dedup set, so re-reporting
    // one counts again. That is the deliberate trade: a bounded set, at the
    // cost of double-counting an envelope seen 512+ drops ago.
    st().noteUndecryptableDrop(first);
    expect(st().undecryptableDropCount).toBe(afterFill + 1);

    // …while a RECENT id is still deduped.
    st().noteUndecryptableDrop(`${tag}-599`);
    expect(st().undecryptableDropCount).toBe(afterFill + 1);
  });
});
