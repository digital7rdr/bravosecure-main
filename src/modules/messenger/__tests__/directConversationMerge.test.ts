/**
 * B-18 — `upsertConversation` merges a stranded synthetic `direct:<peer>`
 * slot into the canonical server-UUID row when /conversations/mine syncs it.
 *
 * Field symptom (QA 1.0.49): an inbound 1:1 message that landed in the
 * synthetic slot BEFORE the UUID row synced stayed there — the home list
 * then showed TWO rows for one peer (the synthetic one stuck on
 * "(encrypted)") and the thread split-brained. The inbound-append reroute
 * only catches NEW messages once the UUID row exists; this migration covers
 * the history that accumulated first. Combined with the ChatScreen
 * read-merge (`directConversationSlots`) the 1:1 thread can no longer drop
 * a decrypted-but-unrendered message.
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

const PEER  = 'alice-uuid';
const SYNTH = `direct:${PEER}`;
const UUID  = 'conv-uuid-123';

function msg(overrides: Partial<LocalMessage>): LocalMessage {
  return {
    id:              overrides.id ?? 'm1',
    conversation_id: overrides.conversation_id ?? SYNTH,
    sender_id:       PEER,
    type:            'text',
    content:         'hi',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      overrides.created_at ?? '2026-06-09T12:00:00.000Z',
    peer:            {userId: PEER, deviceId: 1},
    ...overrides,
  };
}

function directRow(id: string, extra: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id,
    type:          'direct',
    name:          id.startsWith('direct:') ? `Bravo · ${PEER.slice(0, 8)}` : 'Alice',
    participants:  [PEER],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-06-09T11:00:00.000Z',
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    ...extra,
  } as LocalConversation;
}

beforeEach(() => {
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [], messages: {},
    activeConversationId: null,
  } as never, false);
});

describe('B-18 — upsertConversation merges synthetic direct slot into the UUID row', () => {
  test('inbound message stranded in the synthetic slot migrates to the UUID slot on sync', () => {
    const s = useMessengerStore.getState();
    // Cold inbound before sync: shadow-creates synthetic row + message.
    s.appendMessage(SYNTH, msg({id: 'in1', envelope_id: 'env-1', content: 'hello there'}));
    expect(useMessengerStore.getState().messages[SYNTH]).toHaveLength(1);

    // /conversations/mine sync arrives with the server-UUID row for the peer.
    useMessengerStore.getState().upsertConversation(directRow(UUID));

    const st = useMessengerStore.getState();
    expect(st.messages[UUID]).toHaveLength(1);
    expect(st.messages[UUID][0].id).toBe('in1');
    expect(st.messages[UUID][0].conversation_id).toBe(UUID);
    // Synthetic slot + row are gone — no duplicate home-list entry.
    expect(st.messages[SYNTH]).toBeUndefined();
    expect(st.conversations[SYNTH]).toBeUndefined();
    expect(st.conversationOrder).not.toContain(SYNTH);
    expect(st.conversationOrder).toContain(UUID);
  });

  test('UUID row inherits the freshest message as its preview (not "(encrypted)")', () => {
    const s = useMessengerStore.getState();
    s.appendMessage(SYNTH, msg({id: 'older', envelope_id: 'e1', content: 'first',  created_at: '2026-06-09T12:00:00.000Z'}));
    s.appendMessage(SYNTH, msg({id: 'newer', envelope_id: 'e2', content: 'latest', created_at: '2026-06-09T12:05:00.000Z'}));

    useMessengerStore.getState().upsertConversation(directRow(UUID));

    const row = useMessengerStore.getState().conversations[UUID];
    expect(row.last_message?.content).toBe('latest');
  });

  test('unread counts carry across the merge', () => {
    const s = useMessengerStore.getState();
    s.appendMessage(SYNTH, msg({id: 'in1', envelope_id: 'e1'}));   // sender !== self → unread +1
    s.appendMessage(SYNTH, msg({id: 'in2', envelope_id: 'e2'}));   // unread +1
    expect(useMessengerStore.getState().conversations[SYNTH].unread_count).toBe(2);

    useMessengerStore.getState().upsertConversation(directRow(UUID));
    expect(useMessengerStore.getState().conversations[UUID].unread_count).toBe(2);
  });

  test('messages already present in the UUID slot are not duplicated by the merge', () => {
    const s = useMessengerStore.getState();
    // Same envelope landed in both slots (in-flight race).
    s.appendMessage(SYNTH, msg({id: 'synthLocal', envelope_id: 'shared-env'}));
    s.upsertConversation(directRow(UUID));            // creates UUID row (empty)
    s.appendMessage(UUID,  msg({id: 'uuidLocal', envelope_id: 'shared-env', conversation_id: UUID}));
    // Re-sync the UUID row (second /conversations/mine poll) — must stay 1.
    s.upsertConversation(directRow(UUID, {name: 'Alice Renamed'}));

    const list = useMessengerStore.getState().messages[UUID];
    expect(list.filter(m => m.envelope_id === 'shared-env')).toHaveLength(1);
  });

  test('no synthetic slot → upsert is a plain insert (no migration side effects)', () => {
    useMessengerStore.getState().upsertConversation(directRow(UUID));
    const st = useMessengerStore.getState();
    expect(st.conversations[UUID]).toBeDefined();
    expect(st.messages[UUID]).toBeUndefined();
    expect(st.conversationOrder).toEqual([UUID]);
  });

  test('a group upsert never triggers direct-slot migration', () => {
    const s = useMessengerStore.getState();
    s.appendMessage(SYNTH, msg({id: 'in1', envelope_id: 'e1'}));
    s.upsertConversation({
      id: 'group-1', type: 'group', name: 'Team', participants: [PEER, 'bob'],
      unread_count: 0, is_muted: false, created_at: '2026-06-09T11:00:00.000Z',
      peer: {userId: '', deviceId: 1}, session_state: 'fresh',
    } as never);
    // Synthetic 1:1 row untouched.
    expect(useMessengerStore.getState().messages[SYNTH]).toHaveLength(1);
    expect(useMessengerStore.getState().conversations[SYNTH]).toBeDefined();
  });
});
