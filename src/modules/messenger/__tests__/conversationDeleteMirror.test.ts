/**
 * B-594 — the WRITE half of the fresh-install-restore fix.
 *
 * The restore side (restoreStreamingWalk) proves a `deleted:true` row is
 * skipped. This proves the other half the bug-regression contract requires:
 * the single delete choke point `removeConversation` actually SHIPS that flag,
 * so it can reach the backup and survive a reinstall. Without this pin, the
 * delete→mirror seam could regress green (the restore test would still pass
 * against a fixture, while real deletes stopped writing the flag).
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

const mockMirrorConversation = jest.fn();
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  mirrorConversation: mockMirrorConversation,
  markDirty: jest.fn(),
  mirrorRemoval: jest.fn(),
}));

import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';

const OWN = 'self-uuid';
const CID = '9d1c2f3a-0000-4000-8000-0000000000de';

function convo(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    kind: 'direct',
    name: 'Alice',
    peer: {userId: 'alice-uuid', deviceId: 1},
    ...over,
  } as LocalConversation;
}

describe('B-594 — removeConversation ships deleted:true to the backup mirror', () => {
  beforeEach(() => {
    mockMirrorConversation.mockClear();
    useMessengerStore.setState({_ownUserId: OWN, conversations: {}, messages: {}, conversationOrder: []});
  });

  it('mirrors the deleted conversation with {deleted: true}, owner-scoped, after the commit', () => {
    useMessengerStore.getState().upsertConversation(convo(CID));
    // upsert alone does not live-mirror here (no mirrorBootstrap subscription),
    // so the ONLY call the spy sees is the delete tombstone.
    mockMirrorConversation.mockClear();

    useMessengerStore.getState().removeConversation(CID);

    expect(mockMirrorConversation).toHaveBeenCalledTimes(1);
    const [owner, conv, third, opts] = mockMirrorConversation.mock.calls[0];
    expect(owner).toBe(OWN);
    expect((conv as LocalConversation).id).toBe(CID);
    expect(third).toBeUndefined();
    expect(opts).toEqual({deleted: true});
    // and the row is gone from the store (the eviction still happened).
    expect(useMessengerStore.getState().conversations[CID]).toBeUndefined();
  });

  it('does NOT mirror a delete of a conversation that was never present (nothing to tombstone)', () => {
    useMessengerStore.getState().removeConversation('not-there');
    expect(mockMirrorConversation).not.toHaveBeenCalled();
  });
});
