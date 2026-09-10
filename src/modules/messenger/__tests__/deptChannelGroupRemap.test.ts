/**
 * B-206 — an owner "reactivating" a keyless department channel re-mints its
 * group conversation id (resetGroup + a fresh createGroupChat). The message
 * BODIES are stored plaintext and never move, but they stay filed under the
 * OLD id while every device navigates to the NEW id — so the whole history
 * looks WIPED for everyone.
 *
 * The fix migrates the history onto the new id. This suite pins the store half
 * (the in-memory fold + the persisted channel→group map that lets any device
 * detect the change and migrate exactly once, even across a restart). The
 * SQLite remap is `sqlMessageStore.remapConversation` (covered separately; it
 * needs a real DB handle).
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage, LocalConversation} from '../store/types';

const CH = 'channel-uuid';
const OLD = 'group-old-id';
const NEW = 'group-new-id';

function groupConv(id: string): LocalConversation {
  return {
    id, type: 'group', name: 'Ops', participants: ['a', 'b'],
    peer: {userId: 'b', deviceId: 1}, session_state: 'fresh',
    unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
  } as unknown as LocalConversation;
}
function msg(id: string, conv: string, ts: string): LocalMessage {
  return {
    id, conversation_id: conv, sender_id: 'b', body: 'hi',
    created_at: ts, status: 'delivered', peer: {userId: 'b', deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => { useMessengerStore.getState().reset(); });

describe('B-206 — dept channel group-id remap', () => {
  it('folds the orphaned history onto the new group id', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv(OLD));
    s.appendMessage(OLD, msg('m1', OLD, '2026-07-24T00:00:00.000Z'));
    s.appendMessage(OLD, msg('m2', OLD, '2026-07-24T00:01:00.000Z'));
    s.upsertConversation(groupConv(NEW)); // the fresh re-provisioned group

    s.migrateConversationMessages(OLD, NEW);

    const st = useMessengerStore.getState();
    expect(st.messages[NEW]?.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(st.messages[NEW]?.every(m => m.conversation_id === NEW)).toBe(true);
    // The orphaned old slot is gone — no dead duplicate thread in the list.
    expect(st.messages[OLD]).toBeUndefined();
    expect(st.conversations[OLD]).toBeUndefined();
  });

  it('dedupes by id and envelope_id (a re-delivered row does not double)', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv(NEW));
    // NEW already holds m2 (arrived under the new id after the reset).
    s.appendMessage(NEW, msg('m2', NEW, '2026-07-24T00:01:00.000Z'));
    s.upsertConversation(groupConv(OLD));
    s.appendMessage(OLD, msg('m1', OLD, '2026-07-24T00:00:00.000Z'));
    s.appendMessage(OLD, msg('m2', OLD, '2026-07-24T00:01:00.000Z'));

    s.migrateConversationMessages(OLD, NEW);

    const ids = useMessengerStore.getState().messages[NEW]?.map(m => m.id);
    expect(ids).toEqual(['m1', 'm2']); // m2 not duplicated, sorted by time
  });

  it('the channel→group map detects a change exactly once', () => {
    const s = useMessengerStore.getState();
    // First sighting: no previous mapping.
    expect(s.deptChannelGroup(CH)).toBeNull();
    s.setDeptChannelGroup(CH, OLD);
    expect(s.deptChannelGroup(CH)).toBe(OLD);

    // After the owner reactivates, the resolved id is NEW → the caller sees the
    // old id and migrates, then records NEW.
    expect(useMessengerStore.getState().deptChannelGroup(CH)).toBe(OLD);
    s.setDeptChannelGroup(CH, NEW);
    expect(useMessengerStore.getState().deptChannelGroup(CH)).toBe(NEW);
  });

  it('the map is persisted in the owner vault (survives a restart)', () => {
    const s = useMessengerStore.getState();
    s.setOwner('boss@example.com', 'a-uuid');
    s.setDeptChannelGroup(CH, OLD);
    // Switching owner snapshots the vault; switching back restores the map, so
    // a device that restarts still knows the old id to migrate from.
    s.setOwner('other@example.com', 'b-uuid');
    expect(useMessengerStore.getState().deptChannelGroup(CH)).toBeNull();
    useMessengerStore.getState().setOwner('boss@example.com', 'a-uuid');
    expect(useMessengerStore.getState().deptChannelGroup(CH)).toBe(OLD);
  });

  /**
   * Scope v2 Phase 4, R5-B1 — the ADDITIVE dept-conversation registry must be
   * restored per owner, not merely snapshotted.
   *
   * It was written into `vaultByOwner` and never read back, so an account
   * switch left the incoming owner holding the PREVIOUS owner's ids
   * (accumulating on every switch) while DROPPING any id that lives only here —
   * the old conversation after a B-206 remap, or a channel recorded from the
   * server that this device never opened. `isDepartmentConversation` then
   * stopped refusing those, which is exactly the leak the registry exists to
   * prevent, reintroduced by switching account.
   */
  it('the dept-conversation registry is per-owner, and survives a switch back', () => {
    const s = useMessengerStore.getState();
    s.setOwner('boss@example.com', 'a-uuid');
    s.setDeptChannelGroup(CH, OLD);
    expect(useMessengerStore.getState().deptConversationIds[OLD]).toBe(true);

    // Switch away: the incoming owner must NOT inherit the previous owner's ids.
    s.setOwner('other@example.com', 'b-uuid');
    expect(useMessengerStore.getState().deptConversationIds[OLD]).toBeUndefined();

    // Switch back: the ids return, so the vault still refuses those files.
    useMessengerStore.getState().setOwner('boss@example.com', 'a-uuid');
    expect(useMessengerStore.getState().deptConversationIds[OLD]).toBe(true);
  });

  it('the registry keeps the OLD id after a remap moves the pointer', () => {
    const s = useMessengerStore.getState();
    s.setOwner('boss@example.com', 'a-uuid');
    s.setDeptChannelGroup(CH, OLD);
    s.setDeptChannelGroup(CH, NEW);          // B-206 remap moves the POINTER
    const st = useMessengerStore.getState();
    expect(st.deptChannelGroup(CH)).toBe(NEW);
    // …and the registry keeps BOTH, so files still filed under OLD stay refused.
    expect(st.deptConversationIds[OLD]).toBe(true);
    expect(st.deptConversationIds[NEW]).toBe(true);
  });

  it('migrate is a no-op for equal / empty ids', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv(NEW));
    s.appendMessage(NEW, msg('m1', NEW, '2026-07-24T00:00:00.000Z'));
    s.migrateConversationMessages(NEW, NEW);
    s.migrateConversationMessages('', NEW);
    expect(useMessengerStore.getState().messages[NEW]?.map(m => m.id)).toEqual(['m1']);
  });
});
