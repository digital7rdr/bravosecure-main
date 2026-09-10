/**
 * B-247 — "when an agent calls the group call the client got rung but the CPO
 * are not rung; when CPO starts the video call the client got rung but the
 * agent or manager don't get rung."
 *
 * ROOT CAUSE (corrected — my first read blamed the wrong layer).
 * `ensureAssignedGroup` writes the FULL roster onto the mission Ops Room
 * conversation. `resolveRosterOverwrite` then collapses `participants` to
 * `cryptoMembers` — "peers I already hold a group key for" — the moment any
 * exist. `otherMembers` in launchCall reads exactly that field, so the ring set
 * is crypto-narrowed no matter what the server says. Whoever finished key
 * exchange rings (the client, who gets an early re-share); whoever has not is
 * silently skipped.
 *
 * The narrowing is CORRECT and must stay — it is what stops a removed member
 * being resurrected into media grants. Ringing is the exception: it is plain
 * SFU signalling and needs no key. Hence a separate `rosterUserIds` that the
 * narrowing never touches.
 *
 * `/conversations/mine` cannot cover this either: an Ops Room is not a server
 * conversation row at all — verified against the live DB, `missions` has no
 * `conversation_id`, only `comms_room_failed_at`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {resolveRosterOverwrite} from '../runtime/pendingRosterIntents';

const R = process.cwd();
function code(rel: string[]): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join(R, ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('the narrowing that causes it is REAL and stays', () => {
  it('participants collapse to crypto membership whenever any exists', () => {
    // Behavioural proof of the mechanism, not a scan. If this ever stops being
    // true the rosterUserIds workaround is no longer needed — but until then,
    // this is exactly why the ring skipped the CPOs.
    const out = resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: ['client', 'cpo-1', 'cpo-2', 'manager'],
      serverParticipants:   ['client', 'cpo-1', 'cpo-2', 'manager'],
      cryptoMembers:        ['client'],          // only the client has the key yet
    });
    expect(out.participants).toEqual(['client']);
  });

  it('with no crypto members it falls through to the server list', () => {
    const out = resolveRosterOverwrite({
      hasPending: false,
      existingParticipants: undefined,
      serverParticipants:   ['client', 'cpo-1'],
      cryptoMembers:        [],
    });
    expect(out.participants).toEqual(['client', 'cpo-1']);
  });
});

/**
 * PART 2 — the first fix only closed ONE of the two reported directions.
 *
 * `rosterUserIds` was written in exactly one place, `ensureAssignedGroup`,
 * which is the AGENCY/owner path: it mints the master key and fans out the
 * signed create. A CPO never runs it — their room arrives through
 * `upsertGroupConversationFromState`, the single receive-side writer — so a
 * CPO device had no roster at all and fell straight back to crypto membership.
 * That is precisely "when CPO starts the call the client rings but the agent
 * or manager don't".
 *
 * Worse, every snapshot source is frozen: `ensureAssignedGroup` returns early
 * once a key exists, so CPOs dispatched AFTER the room was minted never enter
 * `participants` or `rosterUserIds` on the agency device either, and an Ops
 * Room has no server row to correct it.
 *
 * `groups[id].members` is the only LIVE source — applyAdminAction maintains it
 * through every add and remove, on every device that applied the action — so
 * the ring now unions it too. No migration: installs already hold that state.
 */
describe('B-247 part 2 — the ring reads the group state, not just snapshots', () => {
  const launch = code(['src', 'modules', 'messenger', 'webrtc', 'launchCall.ts']);
  const recv   = code(['src', 'modules', 'messenger', 'runtime', 'groupConversationUpsert.ts']);
  const runtime = code(['src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts']);

  it('the ring unions the live group member map', () => {
    // The union rule itself moved to ringSet.ts so it could be tested
    // BEHAVIOURALLY per device shape (ringSet.test.ts) instead of by scanning
    // the text of an implementation that had already been wrong twice. What
    // this file still guards is that launchCall FEEDS it the live map.
    expect(launch).toMatch(/Object\.keys\(store\.groups\[conversationId\]\?\.members \?\? \{\}\)/);
    expect(launch).toMatch(/return computeRingSet\(\{localMembers, hint, roster, groupMembers, server, ownId\}\)/);
  });

  it('and still never rings the caller from that source', () => {
    // Enforced once, centrally, for every source — asserted behaviourally in
    // ringSet.test.ts ('never rings itself' / 'still excludes the caller when
    // ownId is unknown'). Here: ownId is actually passed in.
    const ring = code(['src', 'modules', 'messenger', 'webrtc', 'ringSet.ts']);
    expect(ring).toMatch(/if \(p && p !== 'self' && p !== ownId\) \{set\.add\(p\);\}/);
    expect(launch).toMatch(/const ownId = useAuthStore\.getState\(\)\.user\?\.id;/);
  });

  it('the RECEIVING device records a roster too', () => {
    // The gap that broke the CPO-initiated direction outright.
    expect(recv).toMatch(/rosterUserIds: memberIds,/);
  });

  it('ordinary user-created groups get one as well', () => {
    // createGroupChat, not just the mission room — a plain 4-person group had
    // the same ring behaviour.
    const fn = runtime.slice(runtime.indexOf('store.upsertConversation({'));
    expect(fn.slice(0, 600)).toMatch(/rosterUserIds: \[ownAddress\.userId, \.\.\.others\]/);
  });

  it('every device shape now has at least one non-crypto ring source', () => {
    // agency (ensureAssignedGroup) + creator (createGroupChat) + receiver
    // (upsertGroupConversationFromState) + the live map for everyone.
    const writes = [runtime, recv].join('\n').match(/rosterUserIds:/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the true roster is preserved and used for ringing', () => {
  const runtime = code(['src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts']);
  const launch  = code(['src', 'modules', 'messenger', 'webrtc', 'launchCall.ts']);
  const store   = code(['src', 'modules', 'messenger', 'store', 'messengerStore.ts']);
  const types   = code(['src', 'types', 'index.ts']);

  it('the Conversation type carries it', () => {
    expect(types).toMatch(/rosterUserIds\?: string\[\]/);
  });

  it('ensureAssignedGroup writes it alongside participants', () => {
    // Written at the one moment the true membership is known, BEFORE the
    // narrowing runs.
    expect(runtime).toMatch(/rosterUserIds: \[ownAddress\.userId, \.\.\.others\]/);
  });

  it('the ring fan-out reads it', () => {
    expect(launch).toMatch(/conversations\[conversationId\]\?\.rosterUserIds/);
  });

  it('the ring UNIONS it rather than replacing the other sources', () => {
    // localMembers + hint + roster + groupMembers + server. Dropping any one
    // re-breaks a different launch path (the hint covers a mission room
    // launched before materialisation; groupMembers covers the CPO-initiated
    // direction). The union is now performed in ringSet.ts — this asserts
    // every source still REACHES it, which is the part launchCall owns.
    const fn = launch.slice(launch.indexOf('async function ringRecipients'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/computeRingSet\(\{localMembers, hint, roster, groupMembers, server, ownId\}\)/);
    expect(body).toMatch(/conversationApi\.listMine\(\)/);
    const ring = code(['src', 'modules', 'messenger', 'webrtc', 'ringSet.ts']);
    for (const src of ['src.localMembers', 'src.hint', 'src.roster', 'src.groupMembers', 'src.server']) {
      expect(ring).toContain(`add(${src});`);
    }
  });

  it('it never rings the caller', () => {
    // Was asserted inline per source; now one central filter, proven
    // behaviourally in ringSet.test.ts.
    const ring = code(['src', 'modules', 'messenger', 'webrtc', 'ringSet.ts']);
    expect(ring).toMatch(/p !== 'self' && p !== ownId/);
  });

  it('upsertConversation keeps it when the incoming record lacks it', () => {
    // The store REPLACES rather than merges, so a later roster sync or a
    // message-driven upsert would wipe it and the ring would silently fall
    // back to crypto membership — the original bug, reintroduced quietly.
    expect(store).toMatch(/c\.rosterUserIds \|\| !prev\?\.rosterUserIds/);
    expect(store).toMatch(/\{\.\.\.c, rosterUserIds: prev\.rosterUserIds\}/);
  });

  it('an upsert that DOES know the roster may replace it', () => {
    // Sticky must not mean frozen — a real membership change has to land.
    // B-411 moved the ternary off the assignment line (name_source shares the
    // stickiness pass), so pin the branch shape: roster-knowing upserts take
    // `c` wholesale, flagless ones re-carry prev.rosterUserIds.
    expect(store).toMatch(/const next = c\.rosterUserIds \|\| !prev\?\.rosterUserIds\s*\r?\n\s*\? c/);
  });
});
