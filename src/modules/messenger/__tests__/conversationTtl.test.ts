/**
 * Unit tests for conversation-level disappearing-message TTL.
 *
 * Covers:
 *   - setConversationTtl writes onto the right conversation
 *   - null TTL turns the feature off
 *   - setting TTL on a missing conversation is a no-op (doesn't crash)
 *   - TTL is isolated per conversation
 *   - TTL survives upsertConversation replacing other fields (caller has to
 *     pass default_ttl_sec through, so we assert the replace semantics)
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
import type {LocalConversation} from '../store/types';

const makeConversation = (id: string, overrides: Partial<LocalConversation> = {}): LocalConversation => ({
  id,
  type:          'group',
  name:          `Group ${id}`,
  participants:  ['self', 'alice'],
  unread_count:  0,
  is_muted:      false,
  created_at:    new Date().toISOString(),
  peer:          {userId: 'alice', deviceId: 1},
  session_state: 'fresh',
  ...overrides,
});

describe('setConversationTtl — conversation-level disappearing messages', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('writes the TTL onto the right conversation', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(makeConversation('c1'));
    s.setConversationTtl('c1', 3600);
    expect(useMessengerStore.getState().conversations.c1?.default_ttl_sec).toBe(3600);
  });

  it('null clears the TTL (feature off)', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(makeConversation('c1'));
    s.setConversationTtl('c1', 3600);
    s.setConversationTtl('c1', null);
    expect(useMessengerStore.getState().conversations.c1?.default_ttl_sec).toBeNull();
  });

  it('setting TTL on a missing conversation is a no-op', () => {
    expect(() => useMessengerStore.getState().setConversationTtl('nope', 60)).not.toThrow();
    expect(useMessengerStore.getState().conversations.nope).toBeUndefined();
  });

  it('TTL is isolated per conversation', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(makeConversation('c1'));
    s.upsertConversation(makeConversation('c2'));

    s.setConversationTtl('c1', 3600);
    s.setConversationTtl('c2', 7 * 24 * 3600);

    expect(useMessengerStore.getState().conversations.c1?.default_ttl_sec).toBe(3600);
    expect(useMessengerStore.getState().conversations.c2?.default_ttl_sec).toBe(7 * 24 * 3600);
  });

  it('upsertConversation replaces the conversation — TTL must be carried in by caller', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(makeConversation('c1'));
    s.setConversationTtl('c1', 3600);

    // Caller-driven replace that forgets to carry default_ttl_sec wipes it.
    // This is intentional — the replace semantics of upsertConversation are
    // "whole-record write"; it's the UI layer's job to preserve TTL on edits.
    s.upsertConversation(makeConversation('c1', {name: 'Renamed'}));
    expect(useMessengerStore.getState().conversations.c1?.default_ttl_sec).toBeUndefined();

    // When the caller DOES carry the TTL through, it survives.
    s.setConversationTtl('c1', 60);
    s.upsertConversation(makeConversation('c1', {name: 'Renamed again', default_ttl_sec: 60}));
    expect(useMessengerStore.getState().conversations.c1?.default_ttl_sec).toBe(60);
  });
});
