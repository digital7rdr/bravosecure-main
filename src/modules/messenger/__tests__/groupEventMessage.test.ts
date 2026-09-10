/**
 * SN-11 — membership changes must leave exactly ONE visible trace in the
 * thread, on every device.
 *
 * Why the dedup matters: the adding device appends this row locally and every
 * receiving device appends it again when it applies the same `add` admin
 * action. Admin envelopes are also re-delivered (relay redelivery, the
 * pending-envelope drain, a restore replay), so a non-deterministic id would
 * stack "X added Y" lines every time one landed.
 */

import {useMessengerStore} from '../store/messengerStore';
import {
  appendMemberAddedEvent,
  appendChannelRenamedEvent,
  memberAddedMessageId,
  channelRenamedMessageId,
  resolveMemberName,
  systemEventText,
} from '../runtime/groupEventMessage';

const GROUP = 'g-abc';
const ADMIN = 'admin-user-id';
const ADDED = 'added-user-id-1234567890';

function reset() {
  useMessengerStore.setState({messages: {}, conversations: {}, groupMemberNames: {}} as never);
}

describe('SN-11 — group membership history', () => {
  beforeEach(reset);

  it('appends a readable line naming both people', () => {
    useMessengerStore.setState({
      conversations: {
        [`direct:${ADMIN}`]: {id: `direct:${ADMIN}`, type: 'direct', name: 'Alex'},
        [`direct:${ADDED}`]: {id: `direct:${ADDED}`, type: 'direct', name: 'Sam'},
      },
    } as never);

    const msg = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 3,
    });

    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('Alex added Sam');
    expect(msg!.type).toBe('system');
    expect(useMessengerStore.getState().messages[GROUP]).toHaveLength(1);
  });

  it('says "You" for the acting device, never a raw id', () => {
    useMessengerStore.setState({
      conversations: {[`direct:${ADDED}`]: {id: `direct:${ADDED}`, type: 'direct', name: 'Sam'}},
    } as never);

    const msg = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1, selfUserId: ADMIN,
    });

    expect(msg!.content).toBe('You added Sam');
  });

  it('phrases it correctly for the person who was added', () => {
    useMessengerStore.setState({
      conversations: {[`direct:${ADMIN}`]: {id: `direct:${ADMIN}`, type: 'direct', name: 'Alex'}},
    } as never);

    const msg = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1, selfUserId: ADDED,
    });

    expect(msg!.content).toBe('Alex added you');
  });

  /**
   * ISSUE 02 was caused by surfacing bare identifiers to users. Even the
   * unknown-contact fallback must not print a full UUID.
   */
  it('never renders a full raw id when the contact is unknown', () => {
    const msg = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1,
    });
    expect(msg!.content).not.toContain(ADDED);
    expect(msg!.content).toContain('Member ');
  });

  it('is idempotent — a re-delivered admin action does not stack rows', () => {
    const first = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 5,
    });
    const second = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 5,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(useMessengerStore.getState().messages[GROUP]).toHaveLength(1);
  });

  it('derives the SAME id on the sending and receiving devices', () => {
    // Both sides key off (group, member, epoch) — no clock, no randomness.
    expect(memberAddedMessageId(GROUP, ADDED, 7))
      .toBe(memberAddedMessageId(GROUP, ADDED, 7));
    expect(memberAddedMessageId(GROUP, ADDED, 7))
      .not.toBe(memberAddedMessageId(GROUP, ADDED, 8));
  });

  it('records a re-add after a removal as a distinct event', () => {
    appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 2});
    // Removed, then added back — the epoch has advanced, so this is new.
    appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 9});
    expect(useMessengerStore.getState().messages[GROUP]).toHaveLength(2);
  });

  it('ignores an event with no group or member', () => {
    expect(appendMemberAddedEvent({groupId: '', actorUserId: ADMIN, addedUserId: ADDED, epoch: 1})).toBeNull();
    expect(appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: '', epoch: 1})).toBeNull();
  });

  it('resolves a name from a peer-matched direct thread', () => {
    useMessengerStore.setState({
      conversations: {
        'server-uuid-row': {id: 'server-uuid-row', type: 'direct', name: 'Jordan', peer: {userId: ADDED, deviceId: 1}},
      },
    } as never);
    expect(resolveMemberName(ADDED)).toBe('Jordan');
  });

  /**
   * DOCUMENTS the "You added Member <code>" bug: a department-channel member
   * with NO 1:1 thread with the actor (the common case — many CPOs never
   * direct-message their manager) has their real name in groupMemberNames
   * (hydrated by DepartmentChatScreen's roster poll), which resolveMemberName
   * used to never check.
   */
  it('prefers the roster-hydrated groupMemberNames name over the raw-id fallback', () => {
    useMessengerStore.getState().setGroupMemberName(GROUP, ADDED, 'Roger');
    expect(resolveMemberName(ADDED, undefined, GROUP)).toBe('Roger');

    const msg = appendMemberAddedEvent({
      groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1,
    });
    // The ADDED person's name resolves via groupMemberNames (the fix); the
    // actor still falls back to a short id since neither source knows them
    // here — this test is only about the ADDED side of the bug.
    expect(msg!.content).toBe(`Member ${ADMIN.slice(0, 6)} added Roger`);
  });

  it('still falls back to "Member <code>" when no name is known anywhere', () => {
    expect(resolveMemberName(ADDED, undefined, GROUP)).toBe(`Member ${ADDED.slice(0, 6)}`);
  });
});

describe('channel-rename system line', () => {
  beforeEach(reset);

  it('names the actor and the new name', () => {
    useMessengerStore.getState().setGroupMemberName(GROUP, ADMIN, 'Alex');
    const msg = appendChannelRenamedEvent({
      groupId: GROUP, actorUserId: ADMIN, newName: 'Ops North', changedAtIso: '2026-07-23T18:00:00.000Z',
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('Alex renamed the channel to "Ops North"');
    expect(msg!.type).toBe('system');
  });

  it('is idempotent on the SAME changedAtIso — no duplicate lines on repeated polls', () => {
    const first = appendChannelRenamedEvent({
      groupId: GROUP, actorUserId: ADMIN, newName: 'Ops North', changedAtIso: '2026-07-23T18:00:00.000Z',
    });
    const second = appendChannelRenamedEvent({
      groupId: GROUP, actorUserId: ADMIN, newName: 'Ops North', changedAtIso: '2026-07-23T18:00:00.000Z',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(useMessengerStore.getState().messages[GROUP]).toHaveLength(1);
  });

  it('derives the SAME id regardless of caller (sender vs receiving device)', () => {
    expect(channelRenamedMessageId(GROUP, '2026-07-23T18:00:00.000Z'))
      .toBe(channelRenamedMessageId(GROUP, '2026-07-23T18:00:00.000Z'));
    expect(channelRenamedMessageId(GROUP, '2026-07-23T18:00:00.000Z'))
      .not.toBe(channelRenamedMessageId(GROUP, '2026-07-23T19:00:00.000Z'));
  });

  it('a second, later rename posts a NEW line (distinct changedAtIso)', () => {
    appendChannelRenamedEvent({groupId: GROUP, actorUserId: ADMIN, newName: 'Ops North', changedAtIso: '2026-07-23T18:00:00.000Z'});
    appendChannelRenamedEvent({groupId: GROUP, actorUserId: ADMIN, newName: 'Ops South', changedAtIso: '2026-07-23T19:00:00.000Z'});
    expect(useMessengerStore.getState().messages[GROUP]).toHaveLength(2);
  });
});

// B-205a — the auto-add path (a newly created CPO joining every org channel via
// the E2EE admin envelope) carries NO display name, so the "X added Y" row froze
// as "Member <code>". The renderer now re-resolves names at render time from the
// roster the channel hydrates on focus, so the line updates to the real name.
describe('B-205a — system membership lines resolve names at render time', () => {
  beforeEach(reset);

  it('the baked content falls back to Member <code> when no name is known', () => {
    // Exactly the reported symptom: created before the roster hydrates.
    const msg = appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1});
    expect(msg!.content).toMatch(/^Member /);
    // …but the structured event is carried so a live re-render can fix it.
    expect(msg!.event).toEqual({kind: 'member_added', actorUserId: ADMIN, memberUserId: ADDED});
  });

  it('systemEventText shows the REAL name once the roster hydrates', () => {
    const msg = appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1})!;
    // Roster hydration (DepartmentChatScreen focus effect) fills these in.
    useMessengerStore.getState().setGroupMemberName(GROUP, ADMIN, 'Agent Due');
    useMessengerStore.getState().setGroupMemberName(GROUP, ADDED, 'Ariful Islam');
    expect(systemEventText(msg.event!, {groupId: GROUP})).toBe('Agent Due added Ariful Islam');
    // The frozen baked content is NOT what the renderer uses now.
    expect(systemEventText(msg.event!, {groupId: GROUP})).not.toMatch(/Member /);
  });

  it('renders "you" for the self side and resolves a rename live', () => {
    const add = appendMemberAddedEvent({groupId: GROUP, actorUserId: ADMIN, addedUserId: ADDED, epoch: 1})!;
    expect(systemEventText(add.event!, {selfUserId: ADDED, groupId: GROUP})).toMatch(/ added you$/);

    const ren = appendChannelRenamedEvent({groupId: GROUP, actorUserId: ADMIN, newName: 'Ops', changedAtIso: '2026-07-24T00:00:00.000Z'})!;
    useMessengerStore.getState().setGroupMemberName(GROUP, ADMIN, 'Agent Due');
    expect(systemEventText(ren.event!, {groupId: GROUP})).toBe('Agent Due renamed the channel to "Ops"');
  });
});
