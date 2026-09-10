import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan for B-128 part 1 — a group reaction must pass the SAME
 * membership gate as a group text message.
 *
 * `doHandleIncoming`'s group-reaction lane handled a reaction carrying a group
 * stamp behind an `isPeerBlocked` check and nothing else, then applied it with
 * the RAW WIRE `groupId`. The group-text lane has dropped non-members since
 * P1-N4. So:
 *
 *   any authenticated user who knows a groupId could place reactions into a
 *   group they are not a member of, and have never been a member of.
 *
 * A reaction is a 1:1-pairwise-encrypted CONTROL envelope carrying a group
 * ROUTING hint (MSG-02) — it is NOT encrypted under the group master key. That
 * is exactly why this lane was easy to miss and why the gate matters: possession
 * of the group key gates the text lane implicitly, and the reaction lane gets no
 * such protection for free. A removed member keeps working reactions forever.
 *
 * The gate mirrors the text lane's shape, including its `existing &&` fail-open:
 * with no local group state we cannot judge membership, and dropping there would
 * discard legitimate traffic for a group we simply have not synced yet.
 *
 * NOT FIXED HERE — B-128 part 2: reaction envelopes are sealed with an AAD of
 * only `{to, ts}`, so `verifySealedAad`'s conversation/group checks are inert for
 * them. Changing the AAD shape is a CLAUDE.md architecture stop-condition
 * ("sealed-sender envelope shape … or AAD binding") and needs sign-off. This
 * membership gate is defence in depth, not a substitute for that binding.
 *
 * If this fails, do NOT relax it. See sqa.md B-128 / MESSAGE_LOOP.md.
 */

// S5 — the lane moved to its own module and now has REAL behavioural tests in
// applyReactionLane.test.ts. This scan is kept as the cheap second layer: it
// pins the gate's SHAPE (order, fail-open, the destroyed-note) directly in the
// source, so a refactor that silently rewires the deps still trips something.
const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'applyReactionLane.ts');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The group-reaction lane: from its `unwrapped.reaction && unwrapped.group` test to the group path. */
function groupReactionLane(): string {
  return stripComments(readFileSync(RUNTIME, 'utf8'));
}

describe('B-128 — a group reaction passes the membership gate', () => {
  it('the lane checks isGroupMember before applying the reaction', () => {
    const lane = groupReactionLane();
    const gate = lane.search(/isGroupMember\(/);
    const apply = lane.indexOf('applyReaction(');
    expect(gate).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(apply);
  });

  it('the gate reads the receiver\'s CURRENT group state, not the wire', () => {
    // The whole point: `groupId` is attacker-supplied wire data. Membership has
    // to be judged against what WE believe the group is, or the check is
    // circular and the attacker just asserts their own membership.
    expect(groupReactionLane()).toMatch(/groupState/);
  });

  it('fails open when we hold no group state (matches the text lane)', () => {
    // A truthiness guard on the state, not a bare `!isGroupMember(...)`. With no
    // local state we cannot judge membership, and dropping would discard
    // legitimate reactions for a group we simply have not synced yet — the same
    // trade-off P1-N4 already made for text.
    //
    // The backreference matters: it pins that the variable being null-checked is
    // the SAME one passed to isGroupMember. `a && !isGroupMember(b, …)` would
    // satisfy a looser pattern while guarding nothing.
    expect(groupReactionLane()).toMatch(/(\w+)\s*&&\s*!isGroupMember\(\s*\1\s*,/);
  });

  it('keeps the blocked-peer gate it already had (P2-9)', () => {
    expect(groupReactionLane()).toMatch(/isPeerBlocked\(peer\.userId\)/);
  });

  it('the drop is NOTED, so the sender is not told it landed (M10/W11)', () => {
    // A bare return inside doHandleIncoming COMMITS and acks 'delivered'. The
    // group-text non-member drop learned this in W11; the reaction drop must
    // report the same thing rather than a false success.
    // Injected as `deps.noteDestroyed` since S5 — the concrete
    // `noteDestroyedEnvelope` is wired in by productionRuntime's deps factory,
    // which applyReactionLane.test.ts pins separately.
    expect(groupReactionLane()).toMatch(/noteDestroyed\(\{[^}]*reason:\s*'group-reaction-nonmember'/);
  });
});
