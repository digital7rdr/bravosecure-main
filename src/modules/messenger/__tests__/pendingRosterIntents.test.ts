/**
 * Audit P1-5 / P1-6 — durable client→server roster reconciliation.
 *
 * Verifies:
 *  - a failed server roster write is durably QUEUED (not lost) and retried by
 *    flushRosterIntents until it lands (fixing the /conversations/mine
 *    resurrection vector);
 *  - a successful write never queues;
 *  - locally-derived (non-UUID) group ids are skipped (no server roster);
 *  - the Home-sync guard keeps LOCAL participants authoritative while a write
 *    is pending (participants not overwritten), and skips re-creating a left
 *    group whose self-removal is still pending;
 *  - the queue is owner-scoped + durable across an in-memory reset.
 */
import {
  writeServerRosterOrQueue,
  flushRosterIntents,
  hasPendingRosterIntent,
  loadPendingRosterIntents,
  resolveRosterOverwrite,
  isServerBackedConversationId,
  _resetPendingRosterIntentsForTests,
} from '../runtime/pendingRosterIntents';

const CONV = '11111111-1111-4111-8111-111111111111';
const OWNER = 'owner-a';

const mockApi = {
  addMember: jest.fn(),
  removeMember: jest.fn(),
};

jest.mock('@services/api', () => ({
  conversationApi: {
    addMember: (...a: unknown[]) => mockApi.addMember(...a),
    removeMember: (...a: unknown[]) => mockApi.removeMember(...a),
  },
}));

// In-memory AsyncStorage that PERSISTS across an in-memory cache reset (so we
// can prove the queue is durable), cleared per-test. `mock`-prefixed so the
// jest.mock factory may reference it.
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null),
    setItem: (k: string, v: string) => { mockStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { mockStore.delete(k); return Promise.resolve(); },
  },
}));

describe('pendingRosterIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    _resetPendingRosterIntentsForTests();
    mockApi.addMember.mockResolvedValue({data: {}});
    mockApi.removeMember.mockResolvedValue({data: {ok: true}});
  });

  it('is server-backed only for UUID conversation ids', () => {
    expect(isServerBackedConversationId(CONV)).toBe(true);
    expect(isServerBackedConversationId('lb-grp:abc')).toBe(false);
    // createGroupChat mints a 64-hex salt-derived id — not a server roster.
    expect(isServerBackedConversationId('a'.repeat(64))).toBe(false);
  });

  it('writes the server roster on success and does NOT queue', async () => {
    const res = await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    expect(mockApi.removeMember).toHaveBeenCalledWith(CONV, 'u-9');
    expect(res).toEqual({ok: true, queued: false, skipped: false});
    expect(hasPendingRosterIntent(CONV)).toBe(false);
  });

  it('durably QUEUES a failed server write (remove) — the split-brain retry path', async () => {
    mockApi.removeMember.mockRejectedValueOnce(new Error('offline'));
    const res = await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    expect(res.queued).toBe(true);
    expect(hasPendingRosterIntent(CONV)).toBe(true);
  });

  it('durably QUEUES a failed add write (P1-6)', async () => {
    mockApi.addMember.mockRejectedValueOnce(new Error('5xx'));
    const res = await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-2', action: 'add', ownerKey: OWNER,
    });
    expect(res.queued).toBe(true);
    expect(hasPendingRosterIntent(CONV)).toBe(true);
  });

  it('skips (no API call, no queue) for a locally-derived non-UUID group', async () => {
    const res = await writeServerRosterOrQueue({
      conversationId: 'lb-grp:local', memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    expect(res).toEqual({ok: true, queued: false, skipped: true});
    expect(mockApi.removeMember).not.toHaveBeenCalled();
    expect(hasPendingRosterIntent('lb-grp:local')).toBe(false);
  });

  it('flush APPLIES a queued intent and clears it once the write succeeds', async () => {
    mockApi.removeMember.mockRejectedValueOnce(new Error('offline'));
    await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    expect(hasPendingRosterIntent(CONV)).toBe(true);

    // Now the network is back — flush drains the queue to the server.
    const r = await flushRosterIntents(OWNER);
    expect(mockApi.removeMember).toHaveBeenLastCalledWith(CONV, 'u-9');
    expect(r).toEqual({flushed: 1, remaining: 0});
    expect(hasPendingRosterIntent(CONV)).toBe(false);
  });

  it('flush LEAVES a still-failing intent pending (at-least-once)', async () => {
    mockApi.removeMember.mockRejectedValue(new Error('still offline'));
    await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    const r = await flushRosterIntents(OWNER);
    expect(r).toEqual({flushed: 0, remaining: 1});
    expect(hasPendingRosterIntent(CONV)).toBe(true);
  });

  it('latest action per (conversation, member) wins — a queued add cancelled by a later remove', async () => {
    mockApi.addMember.mockRejectedValueOnce(new Error('offline'));
    mockApi.removeMember.mockRejectedValueOnce(new Error('offline'));
    await writeServerRosterOrQueue({conversationId: CONV, memberUserId: 'u-2', action: 'add', ownerKey: OWNER});
    await writeServerRosterOrQueue({conversationId: CONV, memberUserId: 'u-2', action: 'remove', ownerKey: OWNER});

    const queue = await loadPendingRosterIntents(OWNER);
    const forMember = queue.filter(i => i.memberUserId === 'u-2');
    expect(forMember).toHaveLength(1);
    expect(forMember[0].action).toBe('remove');

    // A subsequent flush issues exactly ONE (remove) write, not two contradictory ones.
    // Clear the call history from the two failed write attempts above first.
    mockApi.addMember.mockClear();
    mockApi.removeMember.mockClear();
    mockApi.removeMember.mockResolvedValueOnce({data: {ok: true}});
    await flushRosterIntents(OWNER);
    expect(mockApi.addMember).not.toHaveBeenCalled();
    expect(mockApi.removeMember).toHaveBeenCalledTimes(1);
    expect(mockApi.removeMember).toHaveBeenCalledWith(CONV, 'u-2');
  });

  it('is owner-scoped and durable across an in-memory reset', async () => {
    mockApi.removeMember.mockRejectedValueOnce(new Error('offline'));
    await writeServerRosterOrQueue({
      conversationId: CONV, memberUserId: 'u-9', action: 'remove', ownerKey: OWNER,
    });
    // Simulate a fresh process / hot-reload: drop the in-memory cache only.
    _resetPendingRosterIntentsForTests();
    expect(hasPendingRosterIntent(CONV)).toBe(false); // not loaded yet

    const reloaded = await loadPendingRosterIntents(OWNER);
    expect(reloaded).toHaveLength(1);
    expect(hasPendingRosterIntent(CONV)).toBe(true);

    // A DIFFERENT owner must never inherit account A's pending writes.
    const otherOwner = await loadPendingRosterIntents('owner-b');
    expect(otherOwner).toEqual([]);
    expect(hasPendingRosterIntent(CONV)).toBe(false);
  });

  describe('resolveRosterOverwrite (Home-sync guard)', () => {
    it('overwrites with the server roster when no write is pending', () => {
      expect(resolveRosterOverwrite({
        hasPending: false, existingParticipants: ['self', 'stale'], serverParticipants: ['self', 'x'],
      })).toEqual({skip: false, participants: ['self', 'x']});
    });

    it('keeps LOCAL participants (does not overwrite) while a write is pending', () => {
      // P1-5 removed / P1-6 added — local participants already reflect the crypto change.
      expect(resolveRosterOverwrite({
        hasPending: true, existingParticipants: ['self', 'kept'], serverParticipants: ['self', 'kept', 'resurrected'],
      })).toEqual({skip: false, participants: ['self', 'kept']});
    });

    it('skips re-creating a left group whose self-removal is still pending', () => {
      expect(resolveRosterOverwrite({
        hasPending: true, existingParticipants: undefined, serverParticipants: ['self', 'other'],
      })).toEqual({skip: true, participants: ['self', 'other']});
    });

    it('GF-4 — crypto membership wins over a stale server roster (added member kept)', () => {
      expect(resolveRosterOverwrite({
        hasPending: false,
        existingParticipants: ['self', 'alice', 'carol'],
        serverParticipants:   ['self', 'alice'],
        cryptoMembers:        ['self', 'alice', 'carol'],
      })).toEqual({skip: false, participants: ['self', 'alice', 'carol']});
    });

    it('GF-4 — crypto membership wins over a stale server roster (removed member NOT resurrected)', () => {
      expect(resolveRosterOverwrite({
        hasPending: false,
        existingParticipants: ['self', 'alice'],
        serverParticipants:   ['self', 'alice', 'removed'],
        cryptoMembers:        ['self', 'alice'],
      })).toEqual({skip: false, participants: ['self', 'alice']});
    });

    it('GF-4 — falls back to the server roster with no local group state', () => {
      expect(resolveRosterOverwrite({
        hasPending: false,
        existingParticipants: ['self'],
        serverParticipants:   ['self', 'x'],
        cryptoMembers:        undefined,
      })).toEqual({skip: false, participants: ['self', 'x']});
    });

    it('GF-4 — an empty crypto member map never blanks the roster', () => {
      expect(resolveRosterOverwrite({
        hasPending: false,
        existingParticipants: ['self', 'x'],
        serverParticipants:   ['self', 'x'],
        cryptoMembers:        [],
      })).toEqual({skip: false, participants: ['self', 'x']});
    });

    it('GF-4 — a pending self-removal still skips re-creating the left group', () => {
      expect(resolveRosterOverwrite({
        hasPending: true,
        existingParticipants: undefined,
        serverParticipants:   ['self', 'other'],
        cryptoMembers:        undefined,
      })).toEqual({skip: true, participants: ['self', 'other']});
    });
  });
});
