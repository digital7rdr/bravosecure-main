import {applyDirectText, type DirectTextDeps, type DirectTextArgs} from '../runtime/applyDirectText';
import {applyGroupText} from '../runtime/applyGroupText';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage} from '../store/types';

/**
 * Seam S5 — the 1:1 TEXT lane, tested for real.
 *
 * Companion to applyGroupText.test.ts. The last describe block is the point of
 * writing these two together: the group and 1:1 lanes check the SAME two drops
 * in OPPOSITE order, and that had never been written down anywhere because both
 * lanes were buried in the same 1,064-line function.
 *
 * See docs/runbooks/MESSAGE_LOOP.md W24/S5.
 */

const PEER: SessionAddress = {userId: 'bob-2222', deviceId: 1};
const CONVO = 'direct:bob-2222';

function mkDeps(over: Partial<DirectTextDeps> = {}): DirectTextDeps & {
  appended: Array<[string, LocalMessage]>; upserted: LocalMessage[]; logs: string[];
} {
  const appended: Array<[string, LocalMessage]> = [];
  const upserted: LocalMessage[] = [];
  const logs: string[] = [];
  let n = 0;
  const base: DirectTextDeps = {
    isPeerBlocked:       () => false,
    isRestoreTombstoned: () => false,
    appendMessage:       (cid, m) => { appended.push([cid, m]); return m.id; },
    upsert:              async (m) => { upserted.push(m); },
    makeId:              () => `id-${++n}`,
    log:                 (m) => { logs.push(m); },
    ...over,
  };
  return Object.assign(base, {appended, upserted, logs});
}

function mkArgs(over: Partial<DirectTextArgs> = {}): DirectTextArgs {
  return {
    env: {aad: {ts: 1_700_000_000_000}}, conversationId: CONVO, peer: PEER,
    content: 'hi', envelopeId: 'env-1', ...over,
  };
}

describe('S5 applyDirectText — the happy path', () => {
  it('appends and persists the COMMITTED id', async () => {
    const deps = mkDeps();
    const out = await applyDirectText(mkArgs(), deps);

    expect(out).toEqual({kind: 'appended', committedId: expect.any(String)});
    expect(deps.appended[0][0]).toBe(CONVO);
    expect(deps.upserted).toHaveLength(1);
  });

  it('M8/M12 — persists the id the STORE returned, not the one we built', async () => {
    const deps = mkDeps({appendMessage: () => 'FORKED#1'});
    await applyDirectText(mkArgs(), deps);

    expect(deps.upserted[0].id).toBe('FORKED#1');
  });

  it('M12 — writes nothing when the store deduped the row away', async () => {
    const deps = mkDeps({appendMessage: () => null});
    const out = await applyDirectText(mkArgs(), deps);

    expect(out).toEqual({kind: 'appended', committedId: null});
    expect(deps.upserted).toHaveLength(0);
  });
});

describe('S5 applyDirectText — M-07 blocked peer', () => {
  it('drops, so appendMessage cannot RESURRECT the blocked conversation', async () => {
    // This is why the gate lives here and not only in the UI: appendMessage
    // shadow-creates a conversation row, so letting the message through would
    // rebuild the thread the user just blocked.
    const deps = mkDeps({isPeerBlocked: () => true});
    const out = await applyDirectText(mkArgs(), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'blocked'});
    expect(deps.appended).toHaveLength(0);
    expect(deps.upserted).toHaveLength(0);
  });
});

describe('S5 applyDirectText — M-08 restore tombstone', () => {
  it('drops a message the user deleted before reinstalling', async () => {
    const deps = mkDeps({isRestoreTombstoned: () => true});
    const out = await applyDirectText(mkArgs(), deps);

    expect(out).toEqual({kind: 'dropped', reason: 'tombstoned'});
    expect(deps.appended).toHaveLength(0);
  });

  it('is keyed on the BUILT row id, not the envelope id', async () => {
    const seen: string[] = [];
    const deps = mkDeps({isRestoreTombstoned: (id) => { seen.push(id); return false; }});
    await applyDirectText(mkArgs({envelopeId: 'env-XYZ'}), deps);

    expect(seen[0]).not.toBe('env-XYZ');
    expect(seen[0]).toBe(deps.appended[0][1].id);
  });
});

describe('S5 — the two text lanes drop in OPPOSITE order (documented, not accidental)', () => {
  // group : tombstone -> blocked
  // 1:1   : blocked   -> tombstone
  //
  // Harmless today: both branches drop and neither notes the envelope, so only
  // the log line differs. Pinned so the difference is visible. If the drops ever
  // gain different consequences — one noting the envelope, one not — this is
  // exactly where that latent inconsistency becomes a real bug.
  const bothFire = {isPeerBlocked: () => true, isRestoreTombstoned: () => true};

  it('1:1 reports `blocked` when both conditions hold', async () => {
    const out = await applyDirectText(mkArgs(), mkDeps(bothFire));
    expect(out).toEqual({kind: 'dropped', reason: 'blocked'});
  });

  it('group reports `tombstoned` for the very same pair of conditions', async () => {
    const members: Record<string, unknown> = {[PEER.userId]: {userId: PEER.userId}};
    const out = await applyGroupText(
      {
        env: {group: {groupId: 'g1'}, aad: {ts: 1}}, conversationId: 'g1',
        peer: PEER, content: 'hi', envelopeId: 'e1',
        existing: {groupId: 'g1', epoch: 1, members} as unknown as GroupState,
      },
      {
        ...bothFire,
        noteDestroyed: () => {}, appendMessage: () => 'x', upsert: null,
        makeId: () => 'm', crashLog: () => {}, log: () => {},
      },
    );
    expect(out).toEqual({kind: 'dropped', reason: 'tombstoned'});
  });
});
