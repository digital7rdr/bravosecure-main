/**
 * sqa.md bug register — this suite pins: B-135.
 *
 * B-135 (an inbound reaction was acked before it was persisted — applyReaction returned
 * void and reached SQLCipher only via the 50ms coalesced write-through, AFTER the receive
 * txn committed and the envelope was acked) is pinned by "M9 — persists the patched row
 * in-txn, not via the deferred subscriber".
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {applyReactionLane, type ReactionLaneDeps, type ReactionLaneArgs} from '../runtime/applyReactionLane';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the shared reaction lane.
 *
 * B-128's membership gate was previously pinned only by a static source scan.
 * It is a P1 SECURITY gate — without it any authenticated user who knew a
 * groupId could react into a group they had never belonged to — so "the text
 * appears in the right order" was a weak thing to rest it on. These tests run
 * it.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5 and sqa.md B-128.
 */

const PEER: SessionAddress = {userId: 'mallory-9999', deviceId: 1};
const GROUP = 'group-abcd';

function groupState(memberIds: string[]): GroupState {
  const members: Record<string, unknown> = {};
  for (const id of memberIds) {members[id] = {userId: id};}
  return {groupId: GROUP, epoch: 4, members} as unknown as GroupState;
}

function mkDeps(over: Partial<ReactionLaneDeps> = {}): ReactionLaneDeps & {
  reactions: string[][]; upserted: LocalMessage[]; destroyed: string[];
} {
  const reactions: string[][] = [];
  const upserted: LocalMessage[] = [];
  const destroyed: string[] = [];
  const base: ReactionLaneDeps = {
    isPeerBlocked: () => false,
    noteDestroyed: (a) => { destroyed.push(a.reason); },
    applyReaction: (cid, uid, target, emoji, remove) => {
      reactions.push([cid, uid, target, emoji, String(remove)]);
      return {id: target, conversation_id: cid} as unknown as LocalMessage;
    },
    upsert: async (m) => { upserted.push(m); },
    log:    () => {},
    ...over,
  };
  return Object.assign(base, {reactions, upserted, destroyed});
}

function mkArgs(over: Partial<ReactionLaneArgs> = {}): ReactionLaneArgs {
  return {
    conversationId: GROUP, peer: PEER,
    reaction: {targetMsgId: 'msg-1', emoji: '👍', remove: false},
    envelopeId: 'env-1',
    groupState: groupState([PEER.userId, 'alice-1111']),
    ...over,
  };
}

describe('S5 applyReactionLane — B-128 membership gate', () => {
  it('drops a reaction from someone who is NOT a group member', async () => {
    const deps = mkDeps();
    const out = await applyReactionLane(
      mkArgs({groupState: groupState(['alice-1111', 'bob-2222'])}), deps,
    );

    expect(out).toEqual({kind: 'dropped', reason: 'nonmember'});
    expect(deps.reactions).toHaveLength(0);
    expect(deps.upserted).toHaveLength(0);
  });

  it('M10 — notes the envelope so the sender is acked discarded, not ✓✓', async () => {
    const deps = mkDeps();
    await applyReactionLane(mkArgs({groupState: groupState(['alice-1111'])}), deps);

    expect(deps.destroyed).toEqual(['group-reaction-nonmember']);
  });

  it('lets a real member through', async () => {
    const deps = mkDeps();
    const out = await applyReactionLane(mkArgs(), deps);

    expect(out.kind).toBe('applied');
    expect(deps.reactions[0]).toEqual([GROUP, PEER.userId, 'msg-1', '👍', 'false']);
  });

  it('FAILS OPEN for a group we hold no state for', async () => {
    // Dropping here would discard legitimate reactions for a group not yet
    // synced — the same trade-off P1-N4 made for text.
    const deps = mkDeps();
    const out = await applyReactionLane(mkArgs({groupState: undefined}), deps);

    expect(out.kind).toBe('applied');
  });
});

describe('S5 applyReactionLane — 1:1 reactions', () => {
  it('skips the membership gate entirely (no groupState)', async () => {
    // A 1:1 has no membership concept, and its conversation id is resolved FROM
    // the peer, so a peer cannot address someone else's thread.
    const deps = mkDeps();
    const out = await applyReactionLane(
      mkArgs({conversationId: 'direct:mallory-9999', groupState: undefined}), deps,
    );

    expect(out.kind).toBe('applied');
    expect(deps.reactions[0][0]).toBe('direct:mallory-9999');
  });

  it('still honours the blocked-peer gate', async () => {
    const deps = mkDeps({isPeerBlocked: () => true});
    const out = await applyReactionLane(mkArgs({groupState: undefined}), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'blocked'});
    expect(deps.reactions).toHaveLength(0);
  });
});

describe('S5 applyReactionLane — gate order and persistence', () => {
  it('blocked beats non-member', async () => {
    // Both fire. Blocked must win: the non-member branch NOTES the envelope, so
    // a different winner changes what the sender is told about a peer they were
    // blocked by.
    const deps = mkDeps({isPeerBlocked: () => true});
    const out = await applyReactionLane(
      mkArgs({groupState: groupState(['alice-1111'])}), deps,
    );

    expect(out).toEqual({kind: 'dropped', reason: 'blocked'});
    expect(deps.destroyed).toHaveLength(0);
  });

  it('M9 — persists the patched row in-txn, not via the deferred subscriber', async () => {
    const deps = mkDeps();
    await applyReactionLane(mkArgs(), deps);

    expect(deps.upserted).toHaveLength(1);
    expect(deps.upserted[0].id).toBe('msg-1');
  });

  it('writes nothing when the target message is not present locally yet', async () => {
    // Out-of-order delivery: the reaction arrived before its target. The reactor
    // can react again once both sides are in sync.
    const deps = mkDeps({applyReaction: () => null});
    const out = await applyReactionLane(mkArgs(), deps);

    expect(out).toEqual({kind: 'applied', patched: null});
    expect(deps.upserted).toHaveLength(0);
  });

  it('passes `remove` through so un-reacting works', async () => {
    const deps = mkDeps();
    await applyReactionLane(
      mkArgs({reaction: {targetMsgId: 'm', emoji: '👍', remove: true}}), deps,
    );

    expect(deps.reactions[0][4]).toBe('true');
  });
});

describe('S5 — the two reaction call sites differ ONLY in topology', () => {
  it('both wire through the SAME deps factory', () => {
    // The lanes were merged precisely because two hand-copied implementations
    // drift — that is how the group lane went without a membership gate until
    // B-128. Two separate deps literals at the call sites would rebuild the same
    // hazard one layer down.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const calls = src.match(/applyReactionLane\(/g) ?? [];
    expect(calls).toHaveLength(2);
    const wirings = src.match(/reactionLaneDeps\(sqlMessages\)/g) ?? [];
    expect(wirings).toHaveLength(2);
  });

  it('only the GROUP call site passes groupState', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Scoped to the applyReactionLane ARGUMENT LISTS, not the whole file.
    // Originally this counted every `groupState: useMessengerStore` in the
    // module and asserted 1 — which was only ever true by accident, because
    // the reaction lane happened to be the sole lane taking group state. The
    // edit / delete-for-everyone lane now passes it too, for exactly the same
    // B-128 membership reason, and that is correct rather than a regression.
    // What this test actually means is "of the TWO reaction call sites, only
    // the group one is topology-aware", so it now reads only those two.
    const argLists = [...src.matchAll(/applyReactionLane\(\s*\{([\s\S]*?)\},/g)].map(m => m[1]);
    expect(argLists).toHaveLength(2);
    const withGroupState = argLists.filter(a => /groupState:\s*useMessengerStore/.test(a));
    expect(withGroupState).toHaveLength(1);
  });
});
