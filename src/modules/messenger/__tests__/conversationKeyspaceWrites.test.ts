/**
 * THE WRITE SIDE of the conversation keyspace — `appendMessage`'s shadow-create
 * / reroute fork and `upsertConversation`'s B-18 synthetic→UUID merge.
 *
 * `directConversationSlots` (see conversationKeyspaceAmbiguity.test.ts) READS
 * both slots because the caller cannot tell which namespace it holds. These are
 * the actions that WRITE them, and they are where B-124 (a call escalation
 * minting a `Bravo · <hex>` row for YOURSELF) and B-125 (messages routed to a
 * slot nothing renders) actually happened.
 *
 * Each branch of the fork is pinned with the id namespace that reaches it:
 *
 *   `direct:<peer>` + no row + a server-UUID row exists  → REROUTE to the UUID
 *   `direct:<peer>` + no row + no server row             → shadow-create 1:1
 *   `direct:<ownUserId>`                                 → NOTHING (B-124 §3.2)
 *   non-`direct:` + no row                               → shadow-create group
 *   non-`direct:` + no row + groups[id].name === 'Call'  → NOTHING (B-106)
 *
 * Several assertions below record ASYMMETRIES between the reroute path and the
 * normal append path (mute handling, own-send handling). They are pinned as the
 * current behaviour so that changing either one is a visible diff rather than a
 * field report.
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
import type {GroupState} from '@bravo/messenger-core';

const PEER  = 'alice-uuid';
const SELF  = 'self-uuid';
const SYNTH = `direct:${PEER}`;
const UUID  = '9d1c2f3a-0000-4000-8000-000000000001';
const HEX_GROUP = 'a1b2c3d4e5f607182930415263748596';

const st = () => useMessengerStore.getState();

function msg(over: Partial<LocalMessage> & {id: string}): LocalMessage {
  return {
    conversation_id: SYNTH,
    sender_id:       PEER,
    type:            'text',
    content:         'hello',
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
    name:          'Alice',
    participants:  [PEER],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-08-01T00:00:00.000Z',
    peer:          {userId: PEER, deviceId: 1},
    session_state: 'established',
    ...over,
  } as LocalConversation;
}

function groupState(groupId: string, name: string): GroupState {
  return {
    groupId, name, owner: SELF,
    members: {[SELF]: {deviceId: 1, admin: true, joinedAt: 0}, [PEER]: {deviceId: 1, admin: false, joinedAt: 0}},
    masterKeyB64: 'K', epoch: 1, createdAt: 0, updatedAt: 0,
  } as GroupState;
}

beforeEach(() => {
  st().reset();
});

describe('appendMessage — REROUTE: inbound at `direct:<peer>` when the UUID row already exists', () => {
  const seedUuidRow = () => st().upsertConversation(convo(UUID));

  it('lands the message in the UUID slot with its conversation_id rewritten, and NOT in the synthetic one', () => {
    seedUuidRow();

    const effective = st().appendMessage(SYNTH, msg({id: 'in-1', envelope_id: 'env-1'}));

    expect(st().messages[UUID]?.map(m => m.id)).toEqual(['in-1']);
    expect(st().messages[UUID]?.[0]?.conversation_id).toBe(UUID);
    // The synthetic slot must be left EMPTY — a copy there is the split-brain
    // that made the home list show two rows for one peer.
    expect(st().messages[SYNTH] ?? []).toEqual([]);
    // No synthetic conversation row is minted either.
    expect(st().conversations[SYNTH]).toBeUndefined();
    expect(effective).toBe('in-1');
  });

  it('updates the UUID row\'s preview, badge and MRU position', () => {
    seedUuidRow();
    st().upsertConversation(convo('other', {peer: {userId: 'bob', deviceId: 1}}));
    // order is now ['other', UUID]
    expect(st().conversationOrder[0]).toBe('other');

    st().appendMessage(SYNTH, msg({id: 'in-1', created_at: '2026-08-09T10:00:00.000Z'}));

    expect(st().conversations[UUID]?.last_message?.id).toBe('in-1');
    expect(st().conversations[UUID]?.unread_count).toBe(1);
    expect(st().conversationOrder[0]).toBe(UUID);
  });

  it('does not bump the badge when the UUID thread is the one on screen', () => {
    seedUuidRow();
    st().setActiveConversation(UUID);

    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    expect(st().conversations[UUID]?.unread_count).toBe(0);
    expect(st().messages[UUID]).toHaveLength(1);
  });

  it('dedups a replayed envelope on the reroute path (id AND envelope_id)', () => {
    seedUuidRow();
    st().appendMessage(SYNTH, msg({id: 'in-1', envelope_id: 'env-1'}));
    // Same envelope, freshly-minted local id (the receive path mints one per
    // decode, so a reconnect-flush re-decode arrives looking "new").
    st().appendMessage(SYNTH, msg({id: 'in-2', envelope_id: 'env-1'}));
    // Same local id again.
    st().appendMessage(SYNTH, msg({id: 'in-1', envelope_id: 'env-1'}));

    expect(st().messages[UUID]?.map(m => m.id)).toEqual(['in-1']);
  });

  it('an OLDER rerouted message does not regress the UUID row\'s preview (OM-06)', () => {
    seedUuidRow();
    st().appendMessage(UUID, msg({id: 'newer', conversation_id: UUID, created_at: '2026-08-09T12:00:00.000Z'}));

    st().appendMessage(SYNTH, msg({id: 'older', created_at: '2026-08-09T09:00:00.000Z'}));

    expect(st().messages[UUID]?.map(m => m.id).sort()).toEqual(['newer', 'older']);
    expect(st().conversations[UUID]?.last_message?.id).toBe('newer');
  });

  it('DOCUMENTS the asymmetry: the reroute path bumps the badge even for a MUTED chat', () => {
    // The main append path checks `!convo.is_muted` before incrementing
    // (BS-MUTE-UNREAD); the reroute branch does not. Pinned as-is so that
    // aligning them is a deliberate, visible change. If this assertion is ever
    // flipped to `toBe(0)`, the reroute branch grew the mute guard.
    st().upsertConversation(convo(UUID, {is_muted: true}));

    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    expect(st().conversations[UUID]?.unread_count).toBe(1);
  });

  it('does NOT reroute an OWN send — it stays in whichever slot the caller named', () => {
    // The fork is gated on `sender_id !== 'self'`. sendText is expected to have
    // already resolved the canonical id; if it ever hands over the synthetic
    // one, the bubble stays there. Pinned so a regression in the send-side
    // resolver shows up as a slot split here.
    seedUuidRow();

    st().appendMessage(SYNTH, msg({id: 'out-1', sender_id: 'self'}));

    expect(st().messages[SYNTH]?.map(m => m.id)).toEqual(['out-1']);
    expect(st().messages[UUID] ?? []).toEqual([]);
  });

  it('does NOT reroute once the synthetic row itself exists — both slots then live on', () => {
    // The fork also requires `!convo`. With both rows present the message stays
    // where it was addressed; `upsertConversation`'s B-18 merge is what folds
    // them back together, not append.
    seedUuidRow();
    st().upsertConversation(convo(SYNTH));

    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    expect(st().messages[SYNTH]?.map(m => m.id)).toEqual(['in-1']);
    expect(st().messages[UUID] ?? []).toEqual([]);
  });

  it('reroutes only for the MATCHING peer — another peer\'s UUID row is not a target', () => {
    st().upsertConversation(convo('bob-uuid-row', {peer: {userId: 'bob', deviceId: 1}}));

    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    expect(st().messages['bob-uuid-row']).toBeUndefined();
    // No server row for Alice → the normal shadow-create fires instead.
    expect(st().messages[SYNTH]?.map(m => m.id)).toEqual(['in-1']);
    expect(st().conversations[SYNTH]?.name).toBe(`Bravo · ${PEER.slice(0, 8)}`);
  });
});

describe('appendMessage — SHADOW-CREATE, per id namespace', () => {
  it('`direct:<peer>` with no row anywhere mints the `Bravo · <hex>` placeholder', () => {
    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    const row = st().conversations[SYNTH];
    expect(row?.type).toBe('direct');
    expect(row?.name).toBe(`Bravo · ${PEER.slice(0, 8)}`);
    expect(row?.name_source).toBe('placeholder');
    expect(row?.participants).toEqual([PEER]);
    expect(st().conversationOrder).toContain(SYNTH);
  });

  it('B-124 §3.2 — `direct:<ownUserId>` never mints a row (you have no 1:1 with yourself)', () => {
    st().setOwner(SELF);
    const selfSlot = `direct:${SELF}`;

    st().appendMessage(selfSlot, msg({
      id: 'in-1', conversation_id: selfSlot,
      peer: {userId: SELF, deviceId: 1}, sender_id: PEER,
    }));

    // The message still lands (nothing is lost) but no chat-list row appears —
    // that row is the duplicate thread the home list relabelled with the PEER's
    // name, giving the caller two identically-titled chats.
    expect(st().messages[selfSlot]).toHaveLength(1);
    expect(st().conversations[selfSlot]).toBeUndefined();
    expect(st().conversationOrder).not.toContain(selfSlot);
  });

  it('a non-`direct:` id with no row mints a GROUP placeholder (audit fix #14)', () => {
    st().appendMessage(HEX_GROUP, msg({id: 'in-1', conversation_id: HEX_GROUP}));

    const row = st().conversations[HEX_GROUP];
    expect(row?.type).toBe('group');
    expect(row?.name).toBe('Group chat');
    // ChatScreen reads conversations[id].name at render; a missing row is a JS
    // crash, which is what this stub exists to prevent.
    expect(st().messages[HEX_GROUP]).toHaveLength(1);
  });

  it('B-106 — an ad-hoc `Call` group grows NO chat-list row, though the message still appends', () => {
    st().setGroupState(groupState(HEX_GROUP, 'Call'));

    st().appendMessage(HEX_GROUP, msg({id: 'call-evt', conversation_id: HEX_GROUP}));

    expect(st().conversations[HEX_GROUP]).toBeUndefined();
    // The Calls tab walks thread-less slots, so the row must survive in messages.
    expect(st().messages[HEX_GROUP]).toHaveLength(1);
  });

  it('an OWN send to an unknown id never shadow-creates anything', () => {
    st().appendMessage(HEX_GROUP, msg({id: 'out-1', conversation_id: HEX_GROUP, sender_id: 'self'}));
    expect(st().conversations[HEX_GROUP]).toBeUndefined();
    expect(st().messages[HEX_GROUP]).toHaveLength(1);
  });

  it('a `direct:` inbound with NO peer field does not shadow-create either', () => {
    st().appendMessage(SYNTH, {...msg({id: 'in-1'}), peer: undefined} as unknown as LocalMessage);
    expect(st().conversations[SYNTH]).toBeUndefined();
    expect(st().messages[SYNTH]).toHaveLength(1);
  });
});

describe('upsertConversation — B-18 merge of the synthetic slot into the canonical UUID row', () => {
  it('dedups by id AND envelope_id when the UUID slot already holds the same message', () => {
    // Both slots accumulated history before the (re)sync: the UUID one from a
    // /messages backfill, the synthetic one from cold inbounds — and the
    // backfill re-decoded one of the same envelopes under a fresh local id.
    st().upsertConversation(convo(UUID));
    st().appendMessage(UUID, msg({id: 'uuid-dup', conversation_id: UUID, envelope_id: 'env-1', created_at: '2026-08-01T10:00:00.000Z'}));
    st().appendMessage(UUID, msg({id: 'shared',   conversation_id: UUID, envelope_id: 'env-2', created_at: '2026-08-01T11:00:00.000Z'}));
    // The synthetic row exists too (push tap / incoming call minted it), so
    // appends addressed to it stay put instead of rerouting.
    st().upsertConversation(convo(SYNTH));
    st().appendMessage(SYNTH, msg({id: 'shared',  envelope_id: 'env-2', created_at: '2026-08-01T11:00:00.000Z'}));
    st().appendMessage(SYNTH, msg({id: 'synth-1', envelope_id: 'env-1', created_at: '2026-08-01T10:00:00.000Z'}));
    st().appendMessage(SYNTH, msg({id: 'synth-2', envelope_id: 'env-3', created_at: '2026-08-01T12:00:00.000Z'}));
    expect(st().messages[SYNTH]).toHaveLength(3);

    st().upsertConversation(convo(UUID));

    const ids = st().messages[UUID]?.map(m => m.id) ?? [];
    // 'shared' matched by id, 'synth-1' matched by envelope_id against
    // 'uuid-dup' — neither is duplicated; only the genuinely new row moves.
    expect(ids.filter(i => i === 'shared')).toHaveLength(1);
    expect(ids).not.toContain('synth-1');
    expect(ids).toContain('synth-2');
    expect(ids).toContain('uuid-dup');
    expect(st().messages[SYNTH]).toBeUndefined();
    expect(st().conversations[SYNTH]).toBeUndefined();
    expect(st().conversationOrder).not.toContain(SYNTH);
  });

  it('folds the synthetic slot\'s unread count into the canonical row', () => {
    st().appendMessage(SYNTH, msg({id: 'a', created_at: '2026-08-01T10:00:00.000Z'}));
    st().appendMessage(SYNTH, msg({id: 'b', created_at: '2026-08-01T11:00:00.000Z'}));
    expect(st().conversations[SYNTH]?.unread_count).toBe(2);

    st().upsertConversation(convo(UUID, {unread_count: 1}));

    expect(st().conversations[UUID]?.unread_count).toBe(3);
  });

  it('B-411 — a SAVED contact name on the synthetic row survives the merge into a sync-minted row', () => {
    st().appendMessage(SYNTH, msg({id: 'a'}));
    // The address-book sweep upgraded the placeholder before /conversations/mine
    // arrived.
    st().upsertConversation({
      ...(st().conversations[SYNTH] as LocalConversation),
      name: 'Mum', name_source: 'contact', phoneE164: '+971500000000',
    });

    // The sync row carries the REGISTERED display name and no provenance.
    st().upsertConversation(convo(UUID, {name: 'Alice B', name_source: undefined}));

    // Dropping the synthetic row unchanged would re-tag a saved friend
    // "· Unsaved" in every notification until the next discovery sweep.
    expect(st().conversations[UUID]?.name).toBe('Mum');
    expect(st().conversations[UUID]?.name_source).toBe('contact');
    expect(st().conversations[UUID]?.phoneE164).toBe('+971500000000');
  });

  it('B-411 — a user-CUSTOM name on the canonical row is never overwritten by the synthetic one', () => {
    st().appendMessage(SYNTH, msg({id: 'a'}));
    st().upsertConversation({
      ...(st().conversations[SYNTH] as LocalConversation),
      name: 'Mum', name_source: 'contact',
    });

    st().upsertConversation(convo(UUID, {name: 'My Lawyer', is_custom_name: true, name_source: 'custom'}));

    expect(st().conversations[UUID]?.name).toBe('My Lawyer');
    expect(st().conversations[UUID]?.is_custom_name).toBe(true);
  });

  it('a synthetic row with only a PLACEHOLDER name loses to the sync row\'s registered name', () => {
    st().appendMessage(SYNTH, msg({id: 'a'}));
    expect(st().conversations[SYNTH]?.name_source).toBe('placeholder');

    st().upsertConversation(convo(UUID, {name: 'Alice B', name_source: 'profile'}));

    expect(st().conversations[UUID]?.name).toBe('Alice B');
    expect(st().conversations[UUID]?.name_source).toBe('profile');
  });

  it('B-247 — a flagless upsert keeps a rosterUserIds the previous row knew', () => {
    st().upsertConversation(convo(HEX_GROUP, {type: 'group', rosterUserIds: [PEER, SELF, 'carol']}));
    // A message-driven upsert that has no idea what the roster is.
    st().upsertConversation(convo(HEX_GROUP, {type: 'group', participants: [PEER]}));

    expect(st().conversations[HEX_GROUP]?.rosterUserIds?.slice().sort())
      .toEqual([PEER, SELF, 'carol'].sort());
  });

  it('a CUSTOM flag on the synthetic row is carried onto the canonical row, not just its name', () => {
    st().appendMessage(SYNTH, msg({id: 'a'}));
    st().upsertConversation({
      ...(st().conversations[SYNTH] as LocalConversation),
      name: 'Mum', is_custom_name: true, name_source: 'custom',
    });

    st().upsertConversation(convo(UUID, {name: 'Alice B'}));

    // Carrying the name but dropping the flag would let the very next discovery
    // sweep overwrite the rename the user just made.
    expect(st().conversations[UUID]?.name).toBe('Mum');
    expect(st().conversations[UUID]?.is_custom_name).toBe(true);
  });

  it('no merge happens when the incoming row is itself `direct:`-shaped', () => {
    st().appendMessage(SYNTH, msg({id: 'a'}));
    st().upsertConversation(convo(SYNTH, {name: 'Alice'}));

    expect(st().conversations[SYNTH]).toBeDefined();
    expect(st().messages[SYNTH]).toHaveLength(1);
  });
});

describe('migrateConversationMessages — B-206 dept-channel remap onto a new id', () => {
  it('moves history under the new id, rewriting each row\'s conversation_id, and drops the old slot', () => {
    st().upsertConversation(convo('old-dept', {type: 'group', participants: [PEER, SELF]}));
    st().upsertConversation(convo('new-dept', {type: 'group', participants: [PEER, SELF]}));
    st().appendMessage('old-dept', msg({id: 'a', conversation_id: 'old-dept', created_at: '2026-08-01T09:00:00.000Z'}));
    st().appendMessage('old-dept', msg({id: 'b', conversation_id: 'old-dept', created_at: '2026-08-01T10:00:00.000Z'}));

    st().migrateConversationMessages('old-dept', 'new-dept');

    expect(st().messages['new-dept']?.map(m => m.id)).toEqual(['a', 'b']);
    expect(st().messages['new-dept']?.every(m => m.conversation_id === 'new-dept')).toBe(true);
    expect(st().messages['old-dept']).toBeUndefined();
    expect(st().conversations['old-dept']).toBeUndefined();
    expect(st().conversationOrder).not.toContain('old-dept');
    expect(st().conversations['new-dept']?.last_message?.id).toBe('b');
  });

  it('dedups by id AND by envelope_id, so a re-provision cannot double every bubble', () => {
    st().upsertConversation(convo('old-dept', {type: 'group', participants: [PEER, SELF]}));
    st().upsertConversation(convo('new-dept', {type: 'group', participants: [PEER, SELF]}));
    st().appendMessage('new-dept', msg({id: 'same-id', conversation_id: 'new-dept', envelope_id: 'e1', created_at: '2026-08-01T09:00:00.000Z'}));
    st().appendMessage('new-dept', msg({id: 'other',   conversation_id: 'new-dept', envelope_id: 'e2', created_at: '2026-08-01T10:00:00.000Z'}));
    st().appendMessage('old-dept', msg({id: 'same-id', conversation_id: 'old-dept', envelope_id: 'e1', created_at: '2026-08-01T09:00:00.000Z'}));
    // Same envelope re-decoded under a fresh local id — caught only by the
    // envelope_id arm.
    st().appendMessage('old-dept', msg({id: 'redecode', conversation_id: 'old-dept', envelope_id: 'e2', created_at: '2026-08-01T10:00:00.000Z'}));
    st().appendMessage('old-dept', msg({id: 'genuinely-new', conversation_id: 'old-dept', envelope_id: 'e3', created_at: '2026-08-01T11:00:00.000Z'}));

    st().migrateConversationMessages('old-dept', 'new-dept');

    expect(st().messages['new-dept']?.map(m => m.id)).toEqual(['same-id', 'other', 'genuinely-new']);
  });

  it('is a no-op for a blank or self-referential migration', () => {
    st().upsertConversation(convo('c1', {type: 'group', participants: [PEER, SELF]}));
    st().appendMessage('c1', msg({id: 'a', conversation_id: 'c1'}));

    st().migrateConversationMessages('c1', 'c1');
    st().migrateConversationMessages('', 'c1');
    st().migrateConversationMessages('c1', '');

    expect(st().messages.c1?.map(m => m.id)).toEqual(['a']);
    expect(st().conversations.c1).toBeDefined();
  });
});

describe('setActiveConversation — opening either slot clears the badge on BOTH (L20)', () => {
  // Order matters: upserting the UUID row while a synthetic sibling exists
  // MERGES the sibling away (B-18). Seeding UUID first, then the synthetic row,
  // is the state a push tap / incoming-call deep link really produces.
  it('opening the UUID row zeroes the synthetic sibling too', () => {
    st().upsertConversation(convo(UUID,  {unread_count: 2}));
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));

    st().setActiveConversation(UUID);

    expect(st().conversations[UUID]?.unread_count).toBe(0);
    expect(st().conversations[SYNTH]?.unread_count).toBe(0);
  });

  it('opening the SYNTHETIC row zeroes the server-UUID sibling too', () => {
    st().upsertConversation(convo(UUID,  {unread_count: 2}));
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));

    st().setActiveConversation(SYNTH);

    expect(st().conversations[SYNTH]?.unread_count).toBe(0);
    expect(st().conversations[UUID]?.unread_count).toBe(0);
  });

  it('a push tap on a peer with no row yet still resolves the peer from the id and does not crash', () => {
    st().upsertConversation(convo(UUID, {unread_count: 3}));

    // Deep link arrives on the synthetic id; no synthetic row exists.
    st().setActiveConversation(SYNTH);

    expect(st().activeConversationId).toBe(SYNTH);
    expect(st().conversations[UUID]?.unread_count).toBe(0);
  });

  it('leaves an unrelated peer\'s badge alone, and clearing the active id is a no-op on badges', () => {
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));
    st().upsertConversation(convo('bob-row', {unread_count: 7, peer: {userId: 'bob', deviceId: 1}}));

    st().setActiveConversation(SYNTH);
    expect(st().conversations['bob-row']?.unread_count).toBe(7);

    st().setActiveConversation(null);
    expect(st().activeConversationId).toBeNull();
    expect(st().conversations['bob-row']?.unread_count).toBe(7);
  });

  it('a GROUP id resolves no peer, so only that group is cleared', () => {
    st().upsertConversation(convo(HEX_GROUP, {type: 'group', unread_count: 5, participants: [PEER, SELF]}));
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));

    st().setActiveConversation(HEX_GROUP);

    expect(st().conversations[HEX_GROUP]?.unread_count).toBe(0);
    expect(st().conversations[SYNTH]?.unread_count).toBe(4);
  });

  // B-691/F3 — ChatScreen pins the active id at mount but defers the
  // unread-zeroing commit until its open transition ends, so the badge sweep
  // stops re-rendering the chat list mid-slide. The id must land (it gates
  // inbound routing + the unread-increment guard); every badge must survive.
  it('B-691 — skipUnreadClear pins the id but leaves EVERY badge untouched', () => {
    st().upsertConversation(convo(UUID,  {unread_count: 2}));
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));

    st().setActiveConversation(UUID, {skipUnreadClear: true});

    expect(st().activeConversationId).toBe(UUID);
    expect(st().conversations[UUID]?.unread_count).toBe(2);
    expect(st().conversations[SYNTH]?.unread_count).toBe(4);
  });

  it('B-691 — the deferred full call still runs the L20 sibling sweep', () => {
    st().upsertConversation(convo(UUID,  {unread_count: 2}));
    st().upsertConversation(convo(SYNTH, {unread_count: 4}));

    st().setActiveConversation(UUID, {skipUnreadClear: true});
    st().setActiveConversation(UUID);

    expect(st().conversations[UUID]?.unread_count).toBe(0);
    expect(st().conversations[SYNTH]?.unread_count).toBe(0);
  });
});

describe('BS-TY2 / B-117 — an inbound message clears only the SENDER\'s typing flag', () => {
  it('clears the aggregate for a 1:1 when its only typist sends', () => {
    st().upsertConversation(convo(SYNTH));
    st().setTypingUser(SYNTH, PEER, true);
    expect(st().typing[SYNTH]).toBe(true);

    st().appendMessage(SYNTH, msg({id: 'in-1'}));

    expect(st().typing[SYNTH]).toBe(false);
    expect(st().typingUsers[SYNTH]).toBeUndefined();
  });

  it('keeps the group indicator up while ANOTHER member is still composing', () => {
    st().upsertConversation(convo(HEX_GROUP, {type: 'group', participants: [PEER, 'carol', SELF]}));
    st().setTypingUser(HEX_GROUP, PEER, true);
    st().setTypingUser(HEX_GROUP, 'carol', true);

    st().appendMessage(HEX_GROUP, msg({id: 'in-1', conversation_id: HEX_GROUP, sender_id: PEER}));

    expect(st().typing[HEX_GROUP]).toBe(true);
    expect(st().typingUsers[HEX_GROUP]).toEqual({carol: true});
  });

  it('our OWN send never touches the peer\'s typing state', () => {
    st().upsertConversation(convo(SYNTH));
    st().setTypingUser(SYNTH, PEER, true);

    st().appendMessage(SYNTH, msg({id: 'out-1', sender_id: 'self'}));

    expect(st().typing[SYNTH]).toBe(true);
    expect(st().typingUsers[SYNTH]).toEqual({[PEER]: true});
  });
});
