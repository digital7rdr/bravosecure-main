/**
 * Optimistic Block flow — audit S3 follow-up.
 *
 * The ChatInfoScreen.blockPeer handler:
 *   1. snapshots the conversation,
 *   2. calls removeConversation + navigation.goBack synchronously,
 *   3. fires usersClient.block(peerId) in the background,
 *   4. on failure: upsertConversation(snapshot) restores the row +
 *      pushes the error into setError() for the global banner.
 *
 * These tests verify the store-side contract that makes that flow safe:
 * remove → upsert restores by value, and a failure path retains the
 * snapshot fields intact (no field loss across the round-trip).
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
  type:          'direct',
  name:          'Alice',
  participants:  ['self', 'alice'],
  unread_count:  3,
  is_muted:      false,
  created_at:    new Date().toISOString(),
  peer:          {userId: 'alice', deviceId: 1},
  session_state: 'fresh',
  default_ttl_sec: 3600,
  ...overrides,
});

beforeEach(() => {
  // Wipe the persisted slice between tests.
  useMessengerStore.setState({
    conversations: {},
    messages:      {},
  });
});

describe('Optimistic block: remove + upsert-on-failure', () => {
  it('removes the conversation immediately and is gone from state', () => {
    const conv = makeConversation('c1');
    useMessengerStore.getState().upsertConversation(conv);
    expect(useMessengerStore.getState().conversations.c1).toBeDefined();

    useMessengerStore.getState().removeConversation('c1');
    expect(useMessengerStore.getState().conversations.c1).toBeUndefined();
  });

  it('restores all snapshot fields exactly when upserted back after failure', () => {
    const conv = makeConversation('c1', {unread_count: 7, default_ttl_sec: 86400});
    useMessengerStore.getState().upsertConversation(conv);
    const snapshot = useMessengerStore.getState().conversations.c1!;

    // Simulate the failure path: remove first, then restore.
    useMessengerStore.getState().removeConversation('c1');
    useMessengerStore.getState().upsertConversation(snapshot);

    const restored = useMessengerStore.getState().conversations.c1!;
    expect(restored).toBeDefined();
    expect(restored.unread_count).toBe(7);
    expect(restored.default_ttl_sec).toBe(86400);
    expect(restored.peer.userId).toBe('alice');
    expect(restored.name).toBe('Alice');
  });

  it('does not touch other conversations during the round-trip', () => {
    const alice = makeConversation('c1', {name: 'Alice'});
    const bob   = makeConversation('c2', {name: 'Bob', peer: {userId: 'bob', deviceId: 1}});
    useMessengerStore.getState().upsertConversation(alice);
    useMessengerStore.getState().upsertConversation(bob);

    const snapshot = useMessengerStore.getState().conversations.c1!;
    useMessengerStore.getState().removeConversation('c1');
    useMessengerStore.getState().upsertConversation(snapshot);

    expect(useMessengerStore.getState().conversations.c2?.name).toBe('Bob');
  });

  it('end-to-end happy path: remove only (server succeeded)', async () => {
    // When the block HTTP call resolves successfully, no restore is
    // performed — the conversation stays gone.
    const conv = makeConversation('c1');
    useMessengerStore.getState().upsertConversation(conv);

    const mockBlock = jest.fn().mockResolvedValue(undefined);
    const snapshot = useMessengerStore.getState().conversations.c1!;
    useMessengerStore.getState().removeConversation('c1');
    await mockBlock(conv.peer.userId);

    expect(mockBlock).toHaveBeenCalledWith('alice');
    expect(useMessengerStore.getState().conversations.c1).toBeUndefined();
    // Snapshot retained locally but never re-inserted.
    expect(snapshot.id).toBe('c1');
  });

  it('end-to-end failure path: restore conversation when block rejects', async () => {
    const conv = makeConversation('c1');
    useMessengerStore.getState().upsertConversation(conv);

    const mockBlock = jest.fn().mockRejectedValue(new Error('network down'));
    const snapshot = useMessengerStore.getState().conversations.c1!;
    useMessengerStore.getState().removeConversation('c1');
    try {
      await mockBlock(conv.peer.userId);
      throw new Error('block was supposed to reject');
    } catch (e) {
      useMessengerStore.getState().upsertConversation(snapshot);
      useMessengerStore.getState().setError(`Block failed: ${(e as Error).message}`);
    }

    expect(useMessengerStore.getState().conversations.c1).toBeDefined();
    expect(useMessengerStore.getState().conversations.c1?.unread_count).toBe(3);
    expect(useMessengerStore.getState().error).toMatch(/Block failed: network down/);
  });
});
