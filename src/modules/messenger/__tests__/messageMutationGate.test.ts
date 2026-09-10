import {
  decideMessageMutation,
  canEditOwnMessage,
  canDeleteForEveryone,
  EDIT_WINDOW_MS,
  DELETE_WINDOW_MS,
  type MutationGateArgs,
  type MutationTargetLike,
} from '../runtime/messageMutationGate';
import type {GroupState} from '@bravo/messenger-core';

/**
 * The authorisation contract for edit + delete-for-everyone.
 *
 * These are the assertions that stop the B-128 class recurring on a lane that
 * REWRITES and DESTROYS rather than decorates. Every "drop" case here is a
 * capability a peer must never have; every "stash" case is a directive that
 * must never be lost. Read the module header before relaxing any of them.
 */

const PEER = 'u-peer';
const OTHER = 'u-other';

function group(members: string[], epoch = 1): GroupState {
  // `members` is a Record keyed by userId, NOT an array — an array fixture
  // silently makes isGroupMember return false for everyone, which reads as a
  // gate that works while actually testing nothing.
  return {
    groupId: 'g-1',
    name:    'G',
    owner:   members[0] ?? 'u-owner',
    epoch,
    members: Object.fromEntries(
      members.map(userId => [userId, {deviceId: 1, admin: false, joinedAt: 0}]),
    ),
    masterKeyB64: 'k',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as GroupState;
}

function target(over: Partial<MutationTargetLike> = {}): MutationTargetLike {
  return {sender_id: PEER, ...over};
}

function decide(over: Partial<MutationGateArgs> = {}) {
  return decideMessageMutation({
    mutation:      {kind: 'delete'},
    fromUserId:    PEER,
    target:        target(),
    isPeerBlocked: () => false,
    ...over,
  });
}

describe('gate order — the checks that must run before anything else', () => {
  it('drops a blocked peer, even for a message they really did author', () => {
    expect(decide({isPeerBlocked: u => u === PEER}))
      .toEqual({kind: 'drop', reason: 'blocked'});
  });

  it('drops a non-member of the group (B-128 parity)', () => {
    expect(decide({groupState: group([OTHER])}))
      .toEqual({kind: 'drop', reason: 'nonmember'});
  });

  it('applies for a current member', () => {
    expect(decide({groupState: group([PEER, OTHER])})).toEqual({kind: 'apply'});
  });

  it('a REMOVED member cannot delete their old messages', () => {
    // The whole point of the membership gate: authorship alone is not enough
    // once someone is out of the group.
    expect(decide({groupState: group([OTHER]), target: target({sender_id: PEER})}))
      .toEqual({kind: 'drop', reason: 'nonmember'});
  });

  it('skips the membership gate for a 1:1 (no groupState)', () => {
    expect(decide({groupState: undefined})).toEqual({kind: 'apply'});
  });

  it('the blocked check runs BEFORE the membership check', () => {
    // Both would fire; blocked must win, so the reason is stable and the log
    // line names the real cause.
    expect(decide({isPeerBlocked: () => true, groupState: group([OTHER])}))
      .toEqual({kind: 'drop', reason: 'blocked'});
  });
});

describe('missing target — must STASH, never drop', () => {
  it('stashes when we hold no copy of the target', () => {
    expect(decide({target: null})).toEqual({kind: 'stash'});
  });

  it('stashes an edit for an unknown target too', () => {
    expect(decide({target: null, mutation: {kind: 'edit', editedAt: 5}}))
      .toEqual({kind: 'stash'});
  });

  it('a BLOCKED peer with an unknown target is still dropped, not stashed', () => {
    // Otherwise the stash becomes an unbounded write primitive for a peer the
    // user has explicitly blocked.
    expect(decide({target: null, isPeerBlocked: () => true}))
      .toEqual({kind: 'drop', reason: 'blocked'});
  });

  it('a NON-MEMBER with an unknown target is dropped, not stashed', () => {
    expect(decide({target: null, groupState: group([OTHER])}))
      .toEqual({kind: 'drop', reason: 'nonmember'});
  });
});

describe('authorship — the property the feature rests on', () => {
  it('refuses to let a peer mutate OUR message', () => {
    expect(decide({target: target({sender_id: 'self'})}))
      .toEqual({kind: 'drop', reason: 'own-row'});
  });

  it('refuses to let a peer mutate a THIRD party\'s message', () => {
    expect(decide({fromUserId: PEER, target: target({sender_id: OTHER})}))
      .toEqual({kind: 'drop', reason: 'not-author'});
  });

  it('refuses even when the impostor is a legitimate group member', () => {
    // Membership is not authorship. A member of the group may delete only what
    // they themselves wrote.
    expect(decide({
      fromUserId: PEER,
      target:     target({sender_id: OTHER}),
      groupState: group([PEER, OTHER]),
    })).toEqual({kind: 'drop', reason: 'not-author'});
  });

  it('allows the real author', () => {
    expect(decide({fromUserId: PEER, target: target({sender_id: PEER})}))
      .toEqual({kind: 'apply'});
  });

  it('the own-row check is not merely the not-author check in disguise', () => {
    // A peer whose userId literally IS the sentinel must still not reach our
    // rows. This is why the two rules are separate.
    expect(decide({fromUserId: 'self', target: target({sender_id: 'self'})}))
      .toEqual({kind: 'drop', reason: 'own-row'});
  });
});

describe('tombstones are one-way', () => {
  it('drops a second delete for an already-deleted message', () => {
    expect(decide({target: target({deleted_for_all: true})}))
      .toEqual({kind: 'drop', reason: 'tombstoned'});
  });

  it('drops an EDIT for a deleted message — a late edit must not resurrect a body', () => {
    // The in-flight ordering that makes this reachable: author sends an edit,
    // then deletes; the delete overtakes the edit on the wire.
    expect(decide({
      mutation: {kind: 'edit', editedAt: Date.now()},
      target:   target({deleted_for_all: true}),
    })).toEqual({kind: 'drop', reason: 'tombstoned'});
  });
});

describe('edit ordering', () => {
  it('applies an edit to a never-edited message', () => {
    expect(decide({mutation: {kind: 'edit', editedAt: 100}, target: target()}))
      .toEqual({kind: 'apply'});
  });

  it('applies a NEWER edit', () => {
    expect(decide({mutation: {kind: 'edit', editedAt: 200}, target: target({edited_at: 100})}))
      .toEqual({kind: 'apply'});
  });

  it('drops an OLDER edit that lost the race', () => {
    expect(decide({mutation: {kind: 'edit', editedAt: 50}, target: target({edited_at: 100})}))
      .toEqual({kind: 'drop', reason: 'stale-edit'});
  });

  it('drops an exact REPLAY of the edit already applied', () => {
    // `<=` not `<`. A duplicate drain would otherwise re-apply and re-dirty the
    // backup mirror on every pass.
    expect(decide({mutation: {kind: 'edit', editedAt: 100}, target: target({edited_at: 100})}))
      .toEqual({kind: 'drop', reason: 'stale-edit'});
  });

  it('does NOT apply edit ordering to a delete', () => {
    // A delete has no ordering key; an already-edited message is still
    // deletable.
    expect(decide({mutation: {kind: 'delete'}, target: target({edited_at: 999})}))
      .toEqual({kind: 'apply'});
  });
});

describe('canEditOwnMessage — the sender-side window', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const own = (over: Record<string, unknown> = {}) => ({
    sender_id:  'self',
    type:       'text',
    created_at: new Date(now - 60_000).toISOString(),
    ...over,
  });

  it('allows a fresh own text message', () => {
    expect(canEditOwnMessage(own(), now)).toBe(true);
  });

  it('refuses someone else\'s message', () => {
    expect(canEditOwnMessage(own({sender_id: PEER}), now)).toBe(false);
  });

  it('refuses a tombstoned message', () => {
    expect(canEditOwnMessage(own({deleted_for_all: true}), now)).toBe(false);
  });

  it('refuses non-text (media, call records, system lines)', () => {
    for (const type of ['image', 'audio', 'video', 'file', 'call', 'system']) {
      expect(canEditOwnMessage(own({type}), now)).toBe(false);
    }
  });

  it('closes exactly at the window edge', () => {
    expect(canEditOwnMessage(own({created_at: new Date(now - EDIT_WINDOW_MS).toISOString()}), now)).toBe(true);
    expect(canEditOwnMessage(own({created_at: new Date(now - EDIT_WINDOW_MS - 1).toISOString()}), now)).toBe(false);
  });

  it('treats a future-stamped row as age zero, not as expired', () => {
    expect(canEditOwnMessage(own({created_at: new Date(now + 60_000).toISOString()}), now)).toBe(true);
  });

  it('refuses a row with a missing or unparseable created_at', () => {
    expect(canEditOwnMessage(own({created_at: undefined}), now)).toBe(false);
    expect(canEditOwnMessage(own({created_at: 'not-a-date'}), now)).toBe(false);
  });
});

describe('canDeleteForEveryone — the sender-side window', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');
  const own = (over: Record<string, unknown> = {}) => ({
    sender_id:  'self',
    created_at: new Date(now - 60_000).toISOString(),
    ...over,
  });

  it('allows a fresh own message', () => {
    expect(canDeleteForEveryone(own(), now)).toBe(true);
  });

  it('allows MEDIA — unlike edit, delete is not text-only', () => {
    expect(canDeleteForEveryone({...own(), type: 'image'} as never, now)).toBe(true);
  });

  it('refuses someone else\'s message', () => {
    expect(canDeleteForEveryone(own({sender_id: PEER}), now)).toBe(false);
  });

  it('closes exactly at the 48h edge', () => {
    expect(canDeleteForEveryone(own({created_at: new Date(now - DELETE_WINDOW_MS).toISOString()}), now)).toBe(true);
    expect(canDeleteForEveryone(own({created_at: new Date(now - DELETE_WINDOW_MS - 1).toISOString()}), now)).toBe(false);
  });

  it('stays open far longer than the edit window', () => {
    const hourOld = own({created_at: new Date(now - 60 * 60 * 1000).toISOString()});
    expect(canEditOwnMessage({...hourOld, type: 'text'}, now)).toBe(false);
    expect(canDeleteForEveryone(hourOld, now)).toBe(true);
  });
});
