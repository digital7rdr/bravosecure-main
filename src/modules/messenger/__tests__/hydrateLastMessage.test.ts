/**
 * B-78 — hydrateMessages must repopulate `conversation.last_message` from the
 * freshest hydrated row. Persist strips the body (MSG-10), so after a restart or
 * a backup restore the conversation carries no last_message; without this the
 * home list showed no preview/timestamp and ordered by the stale conversation
 * `created_at`, sinking an actively-used chat below empty ones (Jack-at-the-end).
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

function msg(id: string, iso: string): LocalMessage {
  return {
    id, conversation_id: 'c1', sender_id: 'peer', type: 'text', content: `body-${id}`,
    status: 'delivered', is_encrypted: true, created_at: iso,
    peer: {userId: 'peer', deviceId: 1},
  } as unknown as LocalMessage;
}

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id, type: 'direct', name: id, created_at: '2026-06-01T00:00:00.000Z',
    unread_count: 0, peer: {userId: 'peer', deviceId: 1}, session_state: 'established',
    ...over,
  } as unknown as LocalConversation;
}

describe('hydrateMessages (B-78) — seeds conversation.last_message from SQLCipher', () => {
  beforeEach(() => {
    useMessengerStore.setState({conversations: {}, conversationOrder: [], messages: {}} as never);
  });

  it('sets last_message to the newest hydrated row when the conversation had none', () => {
    useMessengerStore.setState({conversations: {c1: convo('c1')}} as never);
    useMessengerStore.getState().hydrateMessages({
      c1: [msg('m1', '2026-07-10T09:14:00.000Z'), msg('m2', '2026-07-10T23:52:00.000Z')],
    });
    const lm = useMessengerStore.getState().conversations.c1.last_message;
    expect(lm?.id).toBe('m2'); // newest
    expect(lm?.created_at).toBe('2026-07-10T23:52:00.000Z');
  });

  it('only moves last_message forward in time (a stale/capped page never regresses it)', () => {
    useMessengerStore.setState({
      conversations: {c1: convo('c1', {last_message: msg('recent', '2026-07-11T12:00:00.000Z')})},
    } as never);
    useMessengerStore.getState().hydrateMessages({c1: [msg('old', '2026-06-27T10:00:00.000Z')]});
    expect(useMessengerStore.getState().conversations.c1.last_message?.id).toBe('recent');
  });

  it('does not throw when messages arrive for a conversation not yet in the store', () => {
    expect(() =>
      useMessengerStore.getState().hydrateMessages({unknown: [msg('m', '2026-07-01T00:00:00.000Z')]}),
    ).not.toThrow();
    expect(useMessengerStore.getState().messages.unknown).toHaveLength(1);
  });
});
