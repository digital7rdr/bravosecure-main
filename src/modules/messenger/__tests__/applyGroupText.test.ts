import {applyGroupText, type GroupTextDeps, type GroupTextArgs} from '../runtime/applyGroupText';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the group TEXT lane, tested for real.
 *
 * Before the extraction these four gates lived inside `doHandleIncoming`, a
 * 1,064-line function in an 8k-line file that no test can import (react-native
 * dies in the node project). The only available pin was a static source scan
 * asserting the gates textually APPEAR in the right order. That catches deletion
 * and reordering; it cannot catch a gate that is present but wrong — an inverted
 * condition, a check against the wrong id, a drop that forgets to note the
 * envelope.
 *
 * These tests RUN the lane. That is the whole return on the extraction; the line
 * count barely moved.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5. The ADMIN lane next door is NOT
 * extracted and must not be — it is architecture-gated (§10 item 5).
 */

const PEER: SessionAddress = {userId: 'alice-1111', deviceId: 1};
const GROUP_ID = 'group-abcd';

function groupState(memberIds: string[], over: Partial<GroupState> = {}): GroupState {
  // `members` is a RECORD keyed by userId, not an array — isGroupMember does
  // `Boolean(state.members[userId])`. Getting this wrong is silent: an array
  // makes every membership check fail, so every group message drops as
  // non-member. Worth stating, because the static scan this replaced could
  // never have caught a wrong-shaped state.
  const members: Record<string, unknown> = {};
  for (const id of memberIds) {members[id] = {userId: id, role: 'member'};}
  return {
    groupId: GROUP_ID, epoch: 3, members, masterKeyB64: 'k', name: 'G', ...over,
  } as unknown as GroupState;
}

function mkDeps(over: Partial<GroupTextDeps> = {}): GroupTextDeps & {
  appended: Array<[string, LocalMessage]>; upserted: LocalMessage[];
  destroyed: Array<{reason: string}>; logs: string[]; crashLogs: string[];
} {
  const appended: Array<[string, LocalMessage]> = [];
  const upserted: LocalMessage[] = [];
  const destroyed: Array<{reason: string}> = [];
  const logs: string[] = [];
  const crashLogs: string[] = [];
  let n = 0;
  const base: GroupTextDeps = {
    isPeerBlocked:       () => false,
    isRestoreTombstoned: () => false,
    noteDestroyed:       (a) => { destroyed.push({reason: a.reason}); },
    appendMessage:       (cid, m) => { appended.push([cid, m]); return m.id; },
    upsert:              async (m) => { upserted.push(m); },
    makeId:              () => `id-${++n}`,
    crashLog:            (m) => { crashLogs.push(m); },
    log:                 (m) => { logs.push(m); },
    ...over,
  };
  return Object.assign(base, {appended, upserted, destroyed, logs, crashLogs});
}

function mkArgs(over: Partial<GroupTextArgs> = {}): GroupTextArgs {
  return {
    env:            {group: {groupId: GROUP_ID}, aad: {ts: 1_700_000_000_000}},
    conversationId: GROUP_ID,
    peer:           PEER,
    content:        'hello',
    envelopeId:     'env-1',
    existing:       groupState([PEER.userId, 'bob-2222']),
    ...over,
  };
}

describe('S5 applyGroupText — the happy path', () => {
  it('appends the message and persists the COMMITTED id', async () => {
    const deps = mkDeps();
    const out = await applyGroupText(mkArgs(), deps);

    expect(out).toEqual({kind: 'appended', committedId: expect.any(String)});
    expect(deps.appended).toHaveLength(1);
    expect(deps.appended[0][0]).toBe(GROUP_ID);
    expect(deps.appended[0][1].content).toBe('hello');
  });

  it('M8/M12 — upserts the id the STORE returned, not the one we built', async () => {
    // The store may fork the id on a content-divergent collision. Persisting the
    // pre-append object is exactly the memory/disk divergence M8 exists for.
    const deps = mkDeps({appendMessage: () => 'FORKED#1'});
    await applyGroupText(mkArgs(), deps);

    expect(deps.upserted).toHaveLength(1);
    expect(deps.upserted[0].id).toBe('FORKED#1');
  });

  it('M12 — does not persist at all when the store deduped the row away', async () => {
    const deps = mkDeps({appendMessage: () => null});
    const out = await applyGroupText(mkArgs(), deps);

    expect(out).toEqual({kind: 'appended', committedId: null});
    expect(deps.upserted).toHaveLength(0);
  });

  it('tolerates a runtime with no SQL store (the loopback path)', async () => {
    const deps = mkDeps({upsert: null});
    await expect(applyGroupText(mkArgs(), deps)).resolves.toEqual(
      {kind: 'appended', committedId: expect.any(String)},
    );
  });
});

describe('S5 applyGroupText — P1-N4 membership gate', () => {
  it('drops a text envelope from a non-member', async () => {
    const deps = mkDeps();
    const out = await applyGroupText(
      mkArgs({existing: groupState(['bob-2222', 'carol-3333'])}), deps,
    );

    expect(out).toEqual({kind: 'dropped', reason: 'nonmember'});
    expect(deps.appended).toHaveLength(0);
    expect(deps.upserted).toHaveLength(0);
  });

  it('M10/W11 — the drop is NOTED so the sender is acked discarded, not ✓✓', async () => {
    const deps = mkDeps();
    await applyGroupText(mkArgs({existing: groupState(['bob-2222'])}), deps);

    expect(deps.destroyed).toEqual([{reason: 'group-nonmember'}]);
  });

  it('FAILS OPEN when we hold no group state', async () => {
    // We cannot judge membership without state, and dropping here would discard
    // legitimate traffic for a group not yet synced. Same trade-off P1-N4 made.
    const deps = mkDeps();
    const out = await applyGroupText(mkArgs({existing: undefined}), deps);

    expect(out.kind).toBe('appended');
  });

  it('drops BEFORE building the row — a non-member never gets an id minted', async () => {
    // Ordering matters beyond tidiness: makeId is the store's id source, and
    // building a row for a dropped envelope is how ghost rows get invented.
    let minted = 0;
    const deps = mkDeps({makeId: () => `id-${++minted}`});
    await applyGroupText(mkArgs({existing: groupState(['bob-2222'])}), deps);

    expect(minted).toBe(0);
  });
});

describe('S5 applyGroupText — M-08 restore tombstone', () => {
  it('drops a message the user deleted before reinstalling', async () => {
    const deps = mkDeps({isRestoreTombstoned: () => true});
    const out = await applyGroupText(mkArgs(), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'tombstoned'});
    expect(deps.appended).toHaveLength(0);
  });

  it('is keyed on the BUILT row id, not the envelope id', async () => {
    // The tombstone set stores message ids. Checking envelopeId would silently
    // never match, leaving the gate permanently inert.
    const seen: string[] = [];
    const deps = mkDeps({isRestoreTombstoned: (id) => { seen.push(id); return false; }});
    await applyGroupText(mkArgs({envelopeId: 'env-XYZ'}), deps);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe('env-XYZ');
    expect(seen[0]).toBe(deps.appended[0][1].id);
  });

  it('does NOT note the envelope — the sender sent a fine message', async () => {
    // Distinct from the non-member drop: nothing is wrong with this message or
    // its sender; the RECIPIENT deleted it. Telling the sender 'discarded'
    // would leak a local deletion back to them.
    const deps = mkDeps({isRestoreTombstoned: () => true});
    await applyGroupText(mkArgs(), deps);

    expect(deps.destroyed).toHaveLength(0);
  });
});

describe('S5 applyGroupText — P2-9 blocked peer', () => {
  it('suppresses the render', async () => {
    const deps = mkDeps({isPeerBlocked: () => true});
    const out = await applyGroupText(mkArgs(), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'blocked'});
    expect(deps.appended).toHaveLength(0);
    expect(deps.upserted).toHaveLength(0);
  });

  it('gates on the SENDER, not the group', async () => {
    const asked: string[] = [];
    const deps = mkDeps({isPeerBlocked: (u) => { asked.push(u); return false; }});
    await applyGroupText(mkArgs(), deps);

    expect(asked).toEqual([PEER.userId]);
  });
});

describe('S5 applyGroupText — G-08 transcript divergence', () => {
  it('logs a fork but NEVER drops', async () => {
    // A benign out-of-order delivery mismatches transiently and settles on the
    // next admin action, so dropping here would destroy good messages.
    const deps = mkDeps();
    const out = await applyGroupText(mkArgs({
      env:      {group: {groupId: GROUP_ID, senderTranscriptHash: 'theirs-aaaa'}, aad: {ts: 1}},
      existing: groupState([PEER.userId], {transcriptHash: 'ours-bbbb'} as Partial<GroupState>),
    }), deps);

    expect(out.kind).toBe('appended');
    expect(deps.crashLogs.join(' ')).toContain('G-08 transcript divergence');
  });

  it('stays quiet when the hashes agree', async () => {
    const deps = mkDeps();
    await applyGroupText(mkArgs({
      env:      {group: {groupId: GROUP_ID, senderTranscriptHash: 'same'}, aad: {ts: 1}},
      existing: groupState([PEER.userId], {transcriptHash: 'same'} as Partial<GroupState>),
    }), deps);

    expect(deps.crashLogs).toHaveLength(0);
  });
});

describe('S5 applyGroupText — gate ORDER', () => {
  it('membership beats tombstone and blocked', async () => {
    // All three fire at once. Membership must win: it is the only one that owes
    // the sender a destroyed-note, so a different winner changes what the sender
    // is told.
    const deps = mkDeps({isRestoreTombstoned: () => true, isPeerBlocked: () => true});
    const out = await applyGroupText(mkArgs({existing: groupState(['bob-2222'])}), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'nonmember'});
    expect(deps.destroyed).toEqual([{reason: 'group-nonmember'}]);
  });

  it('tombstone beats blocked', async () => {
    const deps = mkDeps({isRestoreTombstoned: () => true, isPeerBlocked: () => true});
    const out = await applyGroupText(mkArgs(), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'tombstoned'});
  });
});
