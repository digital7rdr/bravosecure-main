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

import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {outgoingTick} from '@/modules/messenger/runtime/messageTicks';
import type {LocalMessage} from '@/modules/messenger/store/types';

/**
 * B-131 — the conversation list showed a DOUBLE (read) tick for a message the
 * chat screen correctly showed as a SINGLE tick.
 *
 * Two independent defects, and the fix needs both:
 *
 *   1. WRONG SOURCE. The list rendered its tick from `unread_count === 0` —
 *      which means "*I* have no unread incoming messages", and says nothing
 *      whatsoever about whether the PEER read MY message. Any conversation with
 *      a cleared badge drew a blue double tick, forever, regardless of status.
 *
 *   2. STALE SOURCE. `updateMessageStatus` only mutated `s.messages[cid]`; the
 *      conversation row's `last_message` is a snapshot taken at append time, so
 *      simply pointing the list at `last_message.status` would have frozen the
 *      tick at 'sending'/'sent' and never advanced it.
 *
 * The tick rule now lives in ONE place (`runtime/messageTicks.ts`) that both
 * surfaces import, so the two can no longer disagree.
 */

const CID = 'direct:user-peer';

function ownMsg(id: string, status: LocalMessage['status']): LocalMessage {
  return {
    id,
    conversation_id: CID,
    sender_id: 'self',
    type: 'text',
    content: 'hi',
    status,
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer: {userId: 'user-peer', deviceId: 1},
  } as unknown as LocalMessage;
}

function incomingMsg(id: string): LocalMessage {
  return {...ownMsg(id, 'delivered'), sender_id: 'user-peer'} as LocalMessage;
}

describe('B-131 — one tick rule, shared by the chat bubble and the list row', () => {
  it('an unread outgoing message is a SINGLE tick, not a double', () => {
    expect(outgoingTick(ownMsg('m', 'sent'))).toBe('single');
  });

  it('delivered is a double tick; read is the distinct read state', () => {
    expect(outgoingTick(ownMsg('m', 'delivered'))).toBe('double');
    expect(outgoingTick(ownMsg('m', 'read'))).toBe('double-read');
  });

  it('an in-flight message is pending, never a tick', () => {
    expect(outgoingTick(ownMsg('m', 'sending'))).toBe('pending');
  });

  it('failed and undelivered never render as delivered', () => {
    // 'undelivered' means the recipient's device destroyed the envelope. A
    // tick of any kind here would be a lie.
    expect(outgoingTick(ownMsg('m', 'failed'))).toBe('failed');
    expect(outgoingTick(ownMsg('m', 'undelivered'))).toBe('failed');
  });

  it('an INCOMING last message shows no tick at all', () => {
    // Ticks are about your own outgoing messages. The old list drew one for
    // every conversation with a cleared badge, including chats where the last
    // message was theirs.
    expect(outgoingTick(incomingMsg('m'))).toBe('none');
  });

  it('a missing message shows no tick', () => {
    expect(outgoingTick(undefined)).toBe('none');
  });
});

describe('B-131 — the list row must not be driven by unread_count', () => {
  beforeEach(() => {
    useMessengerStore.setState(s => ({
      ...s,
      conversations: {}, conversationOrder: [], messages: {}, groups: {},
      _ownUserId: 'user-me', activeConversationId: null,
    }));
    // An OWN message cannot shadow-create a row (that guard is deliberate), so
    // the conversation has to exist first — as it always does in the real app.
    useMessengerStore.getState().upsertConversation({
      id: CID, type: 'direct', participants: ['user-me', 'user-peer'],
      unread_count: 0, is_muted: false,
      created_at: new Date().toISOString(),
      peer: {userId: 'user-peer', deviceId: 1},
    } as never);
  });

  it('THE BUG: an unread-by-peer message must not read as a double tick', () => {
    // This is the reported case end to end: I send, the peer has not read it,
    // and my own unread_count is 0 because none of THEIR messages are waiting.
    useMessengerStore.getState().appendMessage(CID, ownMsg('m1', 'sent'));

    const convo = useMessengerStore.getState().conversations[CID];
    expect(convo.unread_count).toBe(0);            // the old (wrong) signal
    expect(outgoingTick(convo.last_message)).toBe('single');  // the real answer
  });

  it('last_message.status ADVANCES with the message — the list cannot go stale', () => {
    // Without this the list would freeze at the append-time status and show a
    // single tick forever, which is the same class of bug pointing the other way.
    useMessengerStore.getState().appendMessage(CID, ownMsg('m2', 'sent'));
    useMessengerStore.getState().updateMessageStatus(CID, 'm2', 'read');

    const convo = useMessengerStore.getState().conversations[CID];
    expect(convo.last_message?.status).toBe('read');
    expect(outgoingTick(convo.last_message)).toBe('double-read');
  });

  it('a status update to an OLDER message does not rewrite the last_message tick', () => {
    useMessengerStore.getState().appendMessage(CID, ownMsg('old', 'sent'));
    useMessengerStore.getState().appendMessage(CID, ownMsg('newest', 'sent'));
    useMessengerStore.getState().updateMessageStatus(CID, 'old', 'read');

    const convo = useMessengerStore.getState().conversations[CID];
    expect(convo.last_message?.id).toBe('newest');
    expect(outgoingTick(convo.last_message)).toBe('single');
  });
});
