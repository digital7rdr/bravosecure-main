/**
 * B-255 — "if an admin removes someone from the group there is no system
 * message saying that person removed that person".
 *
 * Adding a member appended a visible "<actor> added <member>" row on every
 * device; removing one appended NOTHING. The roster silently shrank, and the
 * removed member's device simply went quiet — no way to tell whether someone
 * left, was removed, or the group had broken. A membership change with no
 * trace in the one place every member is looking.
 */
import {
  appendMemberRemovedEvent,
  memberRemovedMessageId,
  systemEventText,
} from '../runtime/groupEventMessage';
import {useMessengerStore} from '../store/messengerStore';

const GROUP = 'grp-1';

beforeEach(() => {
  useMessengerStore.setState({
    messages: {},
    directoryNames: {},
    directoryAvatars: {},
    groupMemberNames: {},
  } as never);
});

function rows() {
  return useMessengerStore.getState().messages[GROUP] ?? [];
}

describe('memberRemovedMessageId', () => {
  it('is deterministic in (group, member, epoch) so both sides converge', () => {
    // The remover and every receiver synthesize their own row; identical ids
    // are what collapse them into ONE entry instead of N duplicates.
    expect(memberRemovedMessageId(GROUP, 'u2', 7)).toBe('sys:remove:grp-1:u2:7');
    expect(memberRemovedMessageId(GROUP, 'u2', 7)).toBe(memberRemovedMessageId(GROUP, 'u2', 7));
  });

  it('differs from the ADD id for the same member and epoch', () => {
    // An add and a remove at the same epoch must never collide onto one row.
    expect(memberRemovedMessageId(GROUP, 'u2', 7)).not.toBe(`sys:add:${GROUP}:u2:7`);
  });
});

describe('appendMemberRemovedEvent', () => {
  it('appends a system row carrying a structured member_removed event', () => {
    const msg = appendMemberRemovedEvent({
      groupId: GROUP, actorUserId: 'u1', removedUserId: 'u2', epoch: 3,
    });
    expect(msg).not.toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].type).toBe('system');
    expect(rows()[0].event).toEqual({kind: 'member_removed', actorUserId: 'u1', memberUserId: 'u2'});
  });

  it('is idempotent — a re-delivered admin envelope cannot stack duplicates', () => {
    const a = {groupId: GROUP, actorUserId: 'u1', removedUserId: 'u2', epoch: 3};
    appendMemberRemovedEvent(a);
    const second = appendMemberRemovedEvent(a);
    expect(second).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('a removal at a LATER epoch is its own row (re-added, then removed again)', () => {
    appendMemberRemovedEvent({groupId: GROUP, actorUserId: 'u1', removedUserId: 'u2', epoch: 3});
    appendMemberRemovedEvent({groupId: GROUP, actorUserId: 'u1', removedUserId: 'u2', epoch: 9});
    expect(rows()).toHaveLength(2);
  });

  it('refuses a call with no group or no member rather than writing a junk row', () => {
    expect(appendMemberRemovedEvent({groupId: '', actorUserId: 'u1', removedUserId: 'u2', epoch: 1})).toBeNull();
    expect(appendMemberRemovedEvent({groupId: GROUP, actorUserId: 'u1', removedUserId: '', epoch: 1})).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('attributes the row to the ACTOR, so the thread shows who did it', () => {
    appendMemberRemovedEvent({groupId: GROUP, actorUserId: 'u1', removedUserId: 'u2', epoch: 1});
    expect(rows()[0].sender_id).toBe('u1');
  });
});

describe('systemEventText — member_removed', () => {
  it('reads "<actor> removed <member>" with resolved names', () => {
    useMessengerStore.setState({directoryNames: {u1: 'Alex Stone', u2: 'Sam Reed'}} as never);
    const text = systemEventText(
      {kind: 'member_removed', actorUserId: 'u1', memberUserId: 'u2'},
      {groupId: GROUP},
    );
    expect(text).toBe('Alex Stone removed Sam Reed');
  });

  it('says "You removed X" when the actor is me', () => {
    useMessengerStore.setState({directoryNames: {u2: 'Sam Reed'}} as never);
    const text = systemEventText(
      {kind: 'member_removed', actorUserId: 'me', memberUserId: 'u2'},
      {selfUserId: 'me', groupId: GROUP},
    );
    expect(text).toBe('You removed Sam Reed');
  });

  it('says "X removed you" when I am the one removed — lowercase "you"', () => {
    // This is the ONLY notice the removed member gets, so it has to read as a
    // sentence about them, not "Alex removed You".
    useMessengerStore.setState({directoryNames: {u1: 'Alex Stone'}} as never);
    const text = systemEventText(
      {kind: 'member_removed', actorUserId: 'u1', memberUserId: 'me'},
      {selfUserId: 'me', groupId: GROUP},
    );
    expect(text).toBe('Alex Stone removed you');
  });

  it('re-resolves at RENDER time, so a late-arriving name is picked up', () => {
    // The removed member may already be out of the roster by the time this
    // renders — the directory is the only source left for their name.
    const event = {kind: 'member_removed' as const, actorUserId: 'u1', memberUserId: 'u2'};
    expect(systemEventText(event, {groupId: GROUP})).toContain('u2'.slice(0, 8));
    useMessengerStore.setState({directoryNames: {u1: 'Alex', u2: 'Sam'}} as never);
    expect(systemEventText(event, {groupId: GROUP})).toBe('Alex removed Sam');
  });

  it('still handles member_added and channel_renamed — no regression', () => {
    useMessengerStore.setState({directoryNames: {u1: 'Alex', u2: 'Sam'}} as never);
    expect(systemEventText({kind: 'member_added', actorUserId: 'u1', memberUserId: 'u2'}, {groupId: GROUP}))
      .toBe('Alex added Sam');
    expect(systemEventText({kind: 'channel_renamed', actorUserId: 'u1', newName: 'Ops'}, {groupId: GROUP}))
      .toBe('Alex renamed the channel to "Ops"');
  });
});

/**
 * Emitting the row is the whole point — a builder nobody calls fixes nothing.
 * Source scans because both call sites live in modules this project cannot
 * import (productionRuntime pulls the native crypto stack).
 */
describe('both sides of a removal emit the row', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  function code(rel: string): string {
    // CRLF-safe + comment-stripped: prose mentioning the symbol is the classic
    // false pass in this repo's scan tests.
    const raw = readFileSync(join(process.cwd(), rel), 'utf8');
    const out: string[] = [];
    let inBlock = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
      if (t.startsWith('*') || t.startsWith('//')) {continue;}
      out.push(line);
    }
    return out.join('\n');
  }

  it('RECEIVE side: applyGroupAdmin emits on a remove that changed state', () => {
    const src = code('src/modules/messenger/runtime/applyGroupAdmin.ts');
    expect(src).toMatch(/if \(action\.type === 'remove' && next !== args\.existing\) \{[\s\S]{0,120}appendMemberRemovedEvent/);
    // The state-changed gate matters: a stale-epoch or non-admin action is a
    // no-op and must not announce a removal that did not happen.
    expect(src).toMatch(/action\.type === 'remove' && next !== args\.existing/);
  });

  it('SEND side: removeGroupMember emits after applying the removal locally', () => {
    const src = code('src/modules/messenger/runtime/productionRuntime.ts');
    expect(src).toMatch(/appendMemberRemovedEvent\(\{[\s\S]{0,200}removedUserId: removedUserId,/);
  });

  it('the receive side uses the POST-action epoch, matching the sender', () => {
    // Both sides must key on the same epoch or the ids diverge and the row
    // duplicates instead of converging.
    const recv = code('src/modules/messenger/runtime/applyGroupAdmin.ts');
    expect(recv).toMatch(/appendMemberRemovedEvent\(\{[\s\S]{0,200}epoch:\s*next\.epoch/);
    const send = code('src/modules/messenger/runtime/productionRuntime.ts');
    expect(send).toMatch(/appendMemberRemovedEvent\(\{[\s\S]{0,220}epoch:\s*stateAfterRemove\.epoch/);
  });
});
