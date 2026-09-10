/**
 * B-433 — a removed member must not be rung by the next group call.
 *
 * Founder repro on vc272: "if i remove someone from the group and start a call
 * that removed person got a ring."
 *
 * The ring set is a UNION (B-247) of five sources, two of which live on the
 * conversation ROW — `participants` and `rosterUserIds`. Removal updated only
 * the crypto state, and `rosterUserIds` is deliberately sticky across upserts,
 * so the removed user survived in the row and the union rang them.
 *
 * Two halves are pinned here, because either alone would let the bug back:
 *   1. the UNION still behaves (a stale row really does ring a removed user) —
 *      so the fix has to be the row, not the union;
 *   2. the removal helper narrows BOTH row fields, on BOTH devices.
 */
import {computeRingSet} from '../webrtc/ringSet';

describe('B-433 — the ring set is only as good as the row it reads', () => {
  it('DEMONSTRATES the bug: a stale roster rings someone already removed', () => {
    /**
     * The REAL pre-fix device shape, corrected in review — do not "simplify"
     * it back.
     *
     * `participants` is NOT stale: `setGroupState` rewrites it from crypto
     * membership on both removal paths, so it has already dropped `evicted`.
     * The single stale field is `rosterUserIds`, and that alone is enough for
     * the union to ring them. An earlier version of this test also listed
     * `evicted` in `localMembers`, which no device can actually produce — an
     * invented payload that would have kept passing even if the roster half
     * were fixed.
     *
     * Kept as a live assertion rather than prose: it is the reason the fix
     * belongs in the ROW and not in computeRingSet. Anyone "fixing" this by
     * making the union subtract non-members re-opens B-247 (see next case).
     */
    const rung = computeRingSet({
      ownId:        'me',
      localMembers: ['alice'],
      roster:       ['me', 'alice', 'evicted'],
      groupMembers: ['me', 'alice'],
      server:       ['me', 'alice'],
    });
    expect(rung).toContain('evicted');
  });

  it('a just-added member with no local crypto state IS still rung (B-247 must hold)', () => {
    // The reason the union exists. Any fix for B-433 that breaks this has
    // simply traded one bug for the older one.
    const rung = computeRingSet({
      ownId:        'me',
      localMembers: ['alice'],
      roster:       ['me', 'alice', 'newbie'],
      groupMembers: ['me', 'alice'],
      server:       ['me', 'alice', 'newbie'],
    });
    expect(rung).toEqual(expect.arrayContaining(['alice', 'newbie']));
    expect(rung).not.toContain('me');
  });
});

describe('B-433 — applyMemberRemovalToUi narrows the row', () => {
  const load = () => {
    let state: {conversations: Record<string, Record<string, unknown>>};
    const upsert = jest.fn((c: {id: string}) => { state.conversations[c.id] = c as never; });
    jest.resetModules();
    jest.doMock('../store/messengerStore', () => ({
      useMessengerStore: {getState: () => ({...state, upsertConversation: upsert})},
    }));
    state = {conversations: {}};
    const mod = require('../runtime/applyMemberRemoval') as
      typeof import('../runtime/applyMemberRemoval');
    return {mod, state, upsert};
  };

  it('drops the removed user from BOTH rosterUserIds and participants', () => {
    const {mod, state, upsert} = load();
    state.conversations.g1 = {
      id: 'g1', name: 'Ops', unread: 4,
      participants:   ['me', 'alice', 'evicted'],
      rosterUserIds:  ['me', 'alice', 'evicted'],
    };

    const out = mod.applyMemberRemovalToUi({groupId: 'g1', removedUserId: 'evicted'});

    expect(out.rowUpdated).toBe(true);
    const written = upsert.mock.calls[0][0] as unknown as {
      rosterUserIds: string[]; participants: string[]; unread: number; name: string;
    };
    expect(written.rosterUserIds).toEqual(['me', 'alice']);
    expect(written.participants).toEqual(['me', 'alice']);
    // upsertConversation is a REPLACE — the rest of the row must survive.
    expect(written.unread).toBe(4);
    expect(written.name).toBe('Ops');
  });

  it('the narrowed row no longer rings the removed user', () => {
    // The end-to-end point of the fix, expressed as the caller sees it.
    const {mod, state} = load();
    state.conversations.g1 = {
      id: 'g1',
      participants:  ['me', 'alice', 'evicted'],
      rosterUserIds: ['me', 'alice', 'evicted'],
    };
    mod.applyMemberRemovalToUi({groupId: 'g1', removedUserId: 'evicted'});
    const row = state.conversations.g1 as {participants: string[]; rosterUserIds: string[]};

    const rung = computeRingSet({
      ownId:        'me',
      localMembers: row.participants,
      roster:       row.rosterUserIds,
      groupMembers: ['me', 'alice'],
      server:       ['me', 'alice'],
    });
    expect(rung).not.toContain('evicted');
    expect(rung).toEqual(['alice']);
  });

  it('is idempotent — a re-delivered removal envelope writes nothing', () => {
    const {mod, state, upsert} = load();
    state.conversations.g1 = {
      id: 'g1', participants: ['me', 'alice'], rosterUserIds: ['me', 'alice'],
    };
    const out = mod.applyMemberRemovalToUi({groupId: 'g1', removedUserId: 'evicted'});
    expect(out.rowUpdated).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('no row (removed before the row existed) is a clean no-op, not a throw', () => {
    const {mod, upsert} = load();
    expect(() => mod.applyMemberRemovalToUi({groupId: 'nope', removedUserId: 'x'}))
      .not.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a row with no roster fields at all is left alone', () => {
    // Older device shapes carry neither field; narrowing must not invent them.
    const {mod, state, upsert} = load();
    state.conversations.g1 = {id: 'g1', name: 'Ops'};
    const out = mod.applyMemberRemovalToUi({groupId: 'g1', removedUserId: 'evicted'});
    expect(out.rowUpdated).toBe(false);
    expect(out.hadRoster).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('B-433 — against the REAL store, not a mock', () => {
  /**
   * The whole fix hinges on one claim: passing `rosterUserIds` explicitly
   * DEFEATS the stickiness in `upsertConversation`. Every case above mocks the
   * store, so none of them actually exercises that guard — the suite would
   * stay green if the predicate ever became `c.rosterUserIds?.length`, which
   * would silently break the narrow-to-empty case.
   *
   * The real store IS importable in this project, so mocking it here was a
   * choice rather than a constraint. This closes it.
   */
  /**
   * NOTE: plain module-level requires, and deliberately NO `jest.resetModules()`
   * here. Resetting between requires hands the helper and the assertion two
   * different store instances, so the writes land somewhere the test cannot
   * see — which produced a RED that looked like a product bug and was purely
   * harness. Unique conversation ids per case keep them independent instead.
   */
  const {useMessengerStore} = require('../store/messengerStore') as
    typeof import('../store/messengerStore');
  const {applyMemberRemovalToUi: apply} = require('../runtime/applyMemberRemoval') as
    typeof import('../runtime/applyMemberRemoval');
  const rosterOf = (id: string) => useMessengerStore.getState().conversations[id]?.rosterUserIds;

  it('the explicit roster write beats the sticky guard', () => {
    useMessengerStore.getState().upsertConversation({
      id: 'g-real', type: 'group', name: 'Ops',
      participants: ['me', 'alice', 'evicted'],
      rosterUserIds: ['me', 'alice', 'evicted'],
    } as never);

    apply({groupId: 'g-real', removedUserId: 'evicted'});

    expect(rosterOf('g-real')).toEqual(['me', 'alice']);
  });

  it('narrows all the way to an EMPTY roster without the guard re-carrying the old one', () => {
    // `[]` is truthy, so the store takes the incoming row wholesale — but that
    // is an accident of the current predicate, and this pins it.
    useMessengerStore.getState().upsertConversation({
      id: 'g-solo', type: 'group', name: 'Solo',
      participants: ['evicted'], rosterUserIds: ['evicted'],
    } as never);

    apply({groupId: 'g-solo', removedUserId: 'evicted'});

    expect(rosterOf('g-solo')).toEqual([]);
  });

  it('a later flagless upsert does NOT resurrect the removed member', () => {
    /**
     * THE case that matters most. The Home sync omits `rosterUserIds`, so
     * stickiness re-carries whatever the row holds on every focus — that is
     * exactly how the stale value survived for weeks. It must now re-carry
     * the NARROWED one, or the fix would be undone on the next screen focus.
     */
    useMessengerStore.getState().upsertConversation({
      id: 'g-sync', type: 'group', name: 'Ops',
      participants: ['me', 'alice', 'evicted'],
      rosterUserIds: ['me', 'alice', 'evicted'],
    } as never);
    apply({groupId: 'g-sync', removedUserId: 'evicted'});
    expect(rosterOf('g-sync')).toEqual(['me', 'alice']);

    // The flagless sync — no rosterUserIds field at all.
    useMessengerStore.getState().upsertConversation({
      id: 'g-sync', type: 'group', name: 'Ops', participants: ['me', 'alice'],
    } as never);

    expect(rosterOf('g-sync')).toEqual(['me', 'alice']);
  });
});

describe('B-433 — repairing rows that went stale BEFORE the fix', () => {
  /**
   * Narrowing on the removal event only helps FUTURE removals. Every existing
   * install still carries whoever it removed last week, because the roster is
   * persisted and the Home sync re-carries it on every focus. Without this the
   * founder's own group stays broken and the fix reads as "didn't work".
   */
  const {useMessengerStore: store} = require('../store/messengerStore') as
    typeof import('../store/messengerStore');
  const {repairRosterFromRemovalHistory: repair} = require('../runtime/applyMemberRemoval') as
    typeof import('../runtime/applyMemberRemoval');

  const seed = (id: string, roster: string[], events: Array<[string, string]>) => {
    store.getState().upsertConversation({
      id, type: 'group', name: 'Ops', participants: roster, rosterUserIds: roster,
    } as never);
    events.forEach(([kind, uid], i) => store.getState().appendMessage(id, {
      id: `${id}-e${i}`, conversation_id: id, sender_id: 'admin', type: 'system',
      content: '', status: 'delivered', is_encrypted: false,
      created_at: new Date(Date.now() + i * 1000).toISOString(),
      event: {kind, actorUserId: 'admin', memberUserId: uid},
    } as never));
  };

  it('drops a member removed before the fix existed', () => {
    seed('r1', ['me', 'alice', 'evicted'], [['member_removed', 'evicted']]);
    const out = repair('r1');
    expect(out.repaired).toEqual(['evicted']);
    expect(store.getState().conversations.r1?.rosterUserIds).toEqual(['me', 'alice']);
  });

  it('KEEPS someone removed and later re-added — last event wins', () => {
    // The case a naive "ever removed ⇒ drop" would get wrong, silently
    // un-ringing a current member.
    seed('r2', ['me', 'alice', 'backagain'], [
      ['member_removed', 'backagain'],
      ['member_added',   'backagain'],
    ]);
    const out = repair('r2');
    expect(out.repaired).toEqual([]);
    expect(store.getState().conversations.r2?.rosterUserIds).toEqual(['me', 'alice', 'backagain']);
  });

  it('is idempotent and silent on an already-clean roster', () => {
    seed('r3', ['me', 'alice'], [['member_removed', 'evicted']]);
    expect(repair('r3').repaired).toEqual([]);
    expect(store.getState().conversations.r3?.rosterUserIds).toEqual(['me', 'alice']);
  });

  it('no transcript / no row is a clean no-op', () => {
    expect(repair('does-not-exist').repaired).toEqual([]);
  });
});

describe('B-433 — BOTH removal paths narrow the row', () => {
  /**
   * Source scan: neither `productionRuntime.ts` (the REMOVER's device — the one
   * in the founder's repro, which then taps Call) nor `applyGroupAdmin.ts`
   * (every other member) can be imported by the node project. A unit test on
   * the helper proves the rule; only a scan proves both callers adopted it —
   * and "one helper, N callers" is exactly where this repo drifts.
   */
  const {readFileSync} = require('fs') as typeof import('fs');
  const {join} = require('path') as typeof import('path');
  const ROOT = join(__dirname, '..', '..', '..', '..');

  const codeLines = (rel: string): string[] => {
    const out: string[] = [];
    let inBlock = false;
    for (const raw of readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
      if (t.startsWith('//') || t.startsWith('*')) {continue;}
      out.push(raw);
    }
    return out;
  };

  it.each([
    ['src/modules/messenger/runtime/productionRuntime.ts'],
    ['src/modules/messenger/runtime/applyGroupAdmin.ts'],
  ])('%s calls applyMemberRemovalToUi next to its member-removed event', (rel) => {
    const lines = codeLines(rel);
    const evtAt = lines.findIndex(l => /appendMemberRemovedEvent\(\{/.test(l));
    expect(evtAt).toBeGreaterThan(-1);
    // Anchored at the decision site: within the same removal block, not merely
    // "the token appears somewhere in the file".
    const region = lines.slice(evtAt, evtAt + 20).join('\n');
    expect(region).toMatch(/applyMemberRemovalToUi\(/);
  });

  it('the LEAVE branch narrows too — a member who walked out must stop ringing', () => {
    /**
     * Found in review: `remove` was fixed and `leave` left with the identical
     * hole. `setGroupState` narrows `participants` for both, but neither
     * narrows the sticky `rosterUserIds`, so a leaver kept getting rung.
     *
     * Anchored on the leave branch itself, and asserted BEFORE the
     * rekey-designation `if` — every remaining member must narrow their own
     * row, while only the designated admin rekeys.
     */
    const lines = codeLines('src/modules/messenger/runtime/applyGroupAdmin.ts');
    const leaveAt = lines.findIndex(l => /action\.type === 'leave' && next !== args\.existing/.test(l));
    expect(leaveAt).toBeGreaterThan(-1);

    const narrowAt = lines.findIndex((l, i) => i > leaveAt && /applyMemberRemovalToUi\(/.test(l));
    const designatedAt = lines.findIndex((l, i) => i > leaveAt && /designated === deps\.ownUserId/.test(l));
    expect(narrowAt).toBeGreaterThan(leaveAt);
    expect(designatedAt).toBeGreaterThan(-1);
    expect(narrowAt).toBeLessThan(designatedAt);
  });
});
