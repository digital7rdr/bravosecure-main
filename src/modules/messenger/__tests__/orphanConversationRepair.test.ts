/**
 * B-703 MR-2 / MR-3 — "I can see the message in the notification but not in the
 * chat."
 *
 * Messages are durable: the receive txn commits them to SQLCipher and acks the
 * relay, so the envelope is gone from the server. The conversation row is not —
 * it rides the vault's 500 ms trailing debounce, and `onRehydrateStorage`
 * REPLACES the whole map. Lose it (frozen headless VM, or an ingest that beat
 * rehydration) and `hydrateMessages` never mints one back: it only patches rows
 * that already exist. The thread is invisible and the banner's tap lands on the
 * home screen.
 *
 * The repair re-derives the row from the messages that survived. These cases
 * pin BOTH directions: it must restore a real thread, and it must refuse the
 * things the live minter refuses — resurrecting the wrong thread is worse than
 * the bug.
 */
// The tombstone store persists through AsyncStorage and refuses to arm its
// owner cache without it — same in-memory double the tombstone suite uses.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    jest.fn(async (k: string) => store.get(k) ?? null),
      setItem:    jest.fn(async (k: string, v: string) => { store.set(k, v); }),
      removeItem: jest.fn(async (k: string) => { store.delete(k); }),
      __store: store,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  repairOrphanConversationRows,
  directPlaceholderConversation,
} from '../store/messengerStore';
import {
  loadConversationTombstones,
  rememberDeletedConversation,
  isConversationTombstoned,
  _resetConversationTombstonesForTests,
} from '../backup/conversationTombstones';
import type {LocalConversation, LocalMessage} from '../store/types';

const OLD = '2026-08-01T10:00:00.000Z';
const NEW = '2026-08-02T10:00:00.000Z';

function msg(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', conversation_id: 'c', sender_id: 'peer-1', type: 'text',
    content: 'hi', status: 'delivered', is_encrypted: true, created_at: NEW,
    peer: {userId: 'peer-1', deviceId: 1}, ...over,
  } as LocalMessage;
}

interface S {
  conversations: Record<string, LocalConversation>;
  conversationOrder: string[];
  messages: Record<string, LocalMessage[]>;
  groups: Record<string, unknown>;
  _ownUserId?: string | null;
}

const state = (over: Partial<S> = {}): S => ({
  conversations: {}, conversationOrder: [], messages: {}, groups: {},
  _ownUserId: 'me', ...over,
}) as S;

beforeEach(async () => {
  _resetConversationTombstonesForTests();
  // Clear the BACKING STORE too, not just the cache: rememberDeletedConversation
  // persists, and re-arming from a dirty store re-applied an earlier case's
  // tombstone to every later one — which made the twin-row case pass for free
  // (caught by mutating its guard and seeing nothing go red).
  (AsyncStorage as unknown as {__store: Map<string, string>}).__store.clear();
  // rememberDeletedConversation no-ops until the owner cache is armed.
  await loadConversationTombstones('owner-1');
});

describe('it restores the thread the message belongs to', () => {
  it('a 1:1 slot with messages and no row gets one back', () => {
    const s = state({messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1'})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(1);

    const c = s.conversations['direct:peer-1'];
    expect(c).toBeDefined();
    expect(c.type).toBe('direct');
    expect(c.peer?.userId).toBe('peer-1');
    // The `Bravo · ` prefix is load-bearing: useRegisteredNames only backfills
    // a real contact name over THAT placeholder shape (W15).
    expect(c.name).toBe(directPlaceholderConversation('x', 'peer-1', c.peer, NEW).name);
    expect(c.last_message?.id).toBe('m1');
    expect(s.conversationOrder).toContain('direct:peer-1');
  });

  it('a group this device holds key material for is rebuilt FROM that group state', () => {
    const s = state({
      messages: {'grp-uuid': [msg({conversation_id: 'grp-uuid'})]},
      groups: {
        'grp-uuid': {
          name: 'Ops Squad', masterKeyB64: 'k',
          members: {'peer-1': {deviceId: 1}, 'peer-2': {deviceId: 1}, 'peer-3': {deviceId: 1}},
        },
      },
    });
    expect(repairOrphanConversationRows(s as never)).toBe(1);

    const c = s.conversations['grp-uuid'];
    expect(c.type).toBe('group');
    // The name and roster are RIGHT THERE in GroupState; 'Group chat' with one
    // participant would not just look wrong, it would SEND wrong — the fan-out
    // targets `participants`, nothing re-syncs a repaired row at boot, and the
    // banner tap now lands in this thread. A reply would miss two of three.
    expect(c.name).toBe('Ops Squad');
    expect(c.participants).toEqual(['peer-1', 'peer-2', 'peer-3']);
    expect(c.unread_count).toBe(0);
    expect(c.session_state).toBe('fresh');
    expect(s.conversationOrder).toContain('grp-uuid');
  });

  it('a group whose state carries no roster still renders (falls back to the sender)', () => {
    const s = state({
      messages: {'grp-uuid': [msg({conversation_id: 'grp-uuid'})]},
      groups: {'grp-uuid': {masterKeyB64: 'k'}},
    });
    expect(repairOrphanConversationRows(s as never)).toBe(1);
    expect(s.conversations['grp-uuid'].name).toBe('Group chat');
    expect(s.conversations['grp-uuid'].participants).toEqual(['peer-1']);
  });

  it('is idempotent — a second pass repairs nothing and disturbs nothing', () => {
    const s = state({messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1'})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(1);
    const snapshot = JSON.stringify(s.conversations);
    expect(repairOrphanConversationRows(s as never)).toBe(0);
    expect(JSON.stringify(s.conversations)).toBe(snapshot);
    expect(s.conversationOrder.filter(id => id === 'direct:peer-1')).toHaveLength(1);
  });

  it('leaves an existing row completely alone', () => {
    const existing = {id: 'direct:peer-1', type: 'direct', name: 'Real Name'} as LocalConversation;
    const s = state({
      conversations: {'direct:peer-1': existing},
      messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1'})]},
    });
    expect(repairOrphanConversationRows(s as never)).toBe(0);
    expect(s.conversations['direct:peer-1'].name).toBe('Real Name');
  });
});

describe('it refuses what the live minter refuses', () => {
  it('B-594 — a DELETED thread stays deleted, whatever the rows on disk say', () => {
    rememberDeletedConversation('direct:peer-1', Date.parse(NEW) + 60_000);
    const s = state({messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1', created_at: OLD})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(0);
    expect(s.conversations['direct:peer-1']).toBeUndefined();
  });

  it('B-594 — even rows NEWER than the delete are left to the live path', () => {
    // A genuinely new arrival is lifted by the receive path, which then mints
    // the row itself. A tombstone still standing at boot therefore means the
    // rows are pre-delete residue — a restore handing back what was deleted.
    rememberDeletedConversation('direct:peer-1', Date.parse(OLD));
    const s = state({messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1', created_at: NEW})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('the repair NEVER clears a tombstone — it has no side effects on delete state', () => {
    // `suppressResurrection` (the live/replay discriminator) clears the
    // tombstone outside a replay bracket. Using it here would make a boot
    // repair quietly erase the user's delete.
    rememberDeletedConversation('direct:peer-1', Date.parse(OLD));
    const s = state({messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1', created_at: NEW})]}});
    repairOrphanConversationRows(s as never);
    expect(isConversationTombstoned('direct:peer-1')).toBe(true);
    // ...and a second boot still refuses.
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('B-124 — direct:<self> is never a chat', () => {
    const s = state({messages: {'direct:me': [msg({conversation_id: 'direct:me'})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('B-106 — an ad-hoc call group keeps its messages but grows no chat row', () => {
    const s = state({
      messages: {'call-grp': [msg({conversation_id: 'call-grp'})]},
      groups: {'call-grp': {name: 'Call'}},
    });
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('B-106 — a GROUP id with no key material at all is refused', () => {
    // The restore suppresses an ad-hoc call slot from the SERVER listing
    // (name + is_custom_name), which this repair cannot see — so at the next
    // boot the only thing distinguishing that ghost from a real group is
    // whether this device holds group state for it. Minting "Group chat" here
    // would resurrect exactly what the restore refused.
    const s = state({messages: {'ghost-uuid': [msg({conversation_id: 'ghost-uuid'})]}});
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('no synthetic TWIN when the peer already has a server-UUID row', () => {
    // The home list would show the same peer twice; ChatScreen already unions
    // both slots, so the messages are reachable through the real row.
    const s = state({
      conversations: {
        'srv-uuid': {id: 'srv-uuid', type: 'direct', peer: {userId: 'peer-1', deviceId: 1}} as LocalConversation,
      },
      messages: {'direct:peer-1': [msg({conversation_id: 'direct:peer-1'})]},
    });
    expect(repairOrphanConversationRows(s as never)).toBe(0);
  });

  it('an empty message list is not a thread', () => {
    const s = state({messages: {'direct:peer-1': []}});
    expect(repairOrphanConversationRows(s as never)).toBe(0);
    expect(s.conversationOrder).toHaveLength(0);
  });
});

describe('it runs at exactly ONE site, and that site is the right one', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'src', 'modules', 'messenger', 'store', 'messengerStore.ts'),
    'utf8',
  ) as string;

  it('hydrateMessages repairs after merging the SQL rows — this is THE site (MR-2 and MR-3)', () => {
    const at = src.indexOf('hydrateMessages: (map, bypassCap)');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('prependOlderMessages:', at));
    // Gated on the RESTORE bracket, not on `bypassCap`: the streaming batch
    // paint passes bypassCap=false (it wants the cap), so a bypassCap test
    // skipped only the final one-shot hydrate and let the repair run on every
    // painted batch — where a placeholder blocks the restored real row.
    expect(body).toContain('isRestoreWriteThroughSuppressed() ? 0 : repairOrphanConversationRows(s)');
  });

  it('onRehydrateStorage does NOT repair — that site is unreachable and unsafe', () => {
    // It could only fire if a prior set() had populated `messages` (not
    // persisted) — and that same set() auto-freezes conversations /
    // conversationOrder, so the writes would throw. A throw there skips
    // zustand's hasHydrated flag and its finish-hydration listeners for the
    // process lifetime. The tombstone cache is unarmed that early too, so the
    // B-594 guard would be inert.
    const at = src.indexOf('state.conversations     = slice.conversations');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('rehydrated:', at));
    expect(body).not.toContain('repairOrphanConversationRows(state');
  });

});
