import {DepartmentService} from './department.service';
import type {ChannelAccess, ChannelType} from './dto/channel.dto';

/**
 * Channels vs2 item 2 (P2-d) — WHICH channels an accepted invite seeds.
 *
 * Until now, accepting seeded EVERY eligible channel in the workspace and threw
 * the admin's chosen team away. With one organisation per workspace that reads
 * as a generous default; with several it is a cross-organisation grant issued
 * on every join, and the team picker in front of it is decorative.
 *
 * A PURE FUNCTION over rows, deliberately. The rule has four interacting cases
 * (chain, subtree, broadcasts, fallback) and every one of them is a decision
 * about a graph, not about the database. Expressed in SQL it would be
 * untestable in this project — no unit test here executes SQL — and the last
 * defect of exactly that shape shipped to production past a green suite.
 */

export interface SeedCandidate {
  id: string;
  parent_id: string | null;
  access: ChannelAccess;
  channel_type: ChannelType;
  is_broadcast: boolean;
  /**
   * Archived rows MUST be passed in. They are walk scaffolding: never seeded,
   * but the chain has to be able to climb THROUGH them. Omitting them makes an
   * archived ancestor untraversable rather than merely unseedable, so the walk
   * stops dead and reports no surviving chain while a live grandparent sits
   * directly above it — reachable by archiving a leaf and then its
   * now-childless parent, both ordinary operations.
   */
  archived?: boolean;
}

export type SeedScope =
  /** Seed every eligible channel — the historical behaviour, for an invite that
   *  named no team at all. */
  | {kind: 'orgWide'}
  /** Seed exactly these ids (plus nothing else). */
  | {kind: 'scoped'; ids: Set<string>; fellBackTo: string | null}
  /** Nothing survives that could be seeded. The caller must REFUSE the accept
   *  before claiming the invite, so the link stays usable after a re-invite. */
  | {kind: 'dead'};

/** Depth is CHECKed 0..3, so no walk in this file may exceed three hops. Kept
 *  as a named bound rather than a literal so the two walks cannot disagree. */
const MAX_DEPTH = 3;

/**
 * "Surviving" is not just "not archived".
 *
 * A managers-only rung (restricted, or an incident channel) is skipped by the
 * seed loop itself, so treating it as a valid fallback target lands the employee
 * in a workspace with zero channels — the exact outcome this fallback exists to
 * prevent, reached with no error and no log. The walk therefore keeps CLIMBING
 * past such rungs rather than stopping at one.
 */
// Deliberately NOT a type predicate. `row is SeedCandidate` would tell
// TypeScript that a FAILING check means "not a channel", so inside a loop that
// has already established the row exists the false branch narrows to `never`
// and every later field read is a compile error. Existence and survival are two
// different questions; the callers ask them separately.
function survives(row: SeedCandidate, asManager: boolean): boolean {
  if (row.archived) {return false;}
  // A MANAGER invite seeds managers-only channels — seedApprovedMemberChannels
  // skips the visibility rule for them — so applying the EMPLOYEE rule here
  // refuses the accept for exactly the channels the seeder would have placed
  // them in. Narrow trigger (a manager invited to a chain that is entirely
  // restricted), completely wrong answer.
  return asManager || !DepartmentService.seedsManagersOnly(row.access, row.channel_type);
}

/**
 * Resolve the seed scope for an accepted invite.
 *
 * @param rows        EVERY channel in the org, archived ones INCLUDED and
 *                    flagged. Archived rows are walk scaffolding: never seeded,
 *                    but the climb must be able to pass through them.
 * @param teamId      the team the admin picked, or null for "no specific team".
 * @param asManager   a MANAGER invite seeds managers-only channels too, so the
 *                    survival predicate has to know. Without it a manager whose
 *                    only chain is restricted is refused an accept for channels
 *                    the seeder would happily have placed them in.
 * @param teamParentId the parent recorded at MINT. Load-bearing only when the
 *                    team row is gone: `team_channel_id` is ON DELETE SET NULL
 *                    and deleting a leaf is allowed, so without this a deleted
 *                    team is indistinguishable from "no team" and silently
 *                    widens the grant to the whole workspace.
 */
export function resolveSeedScope(
  rows: readonly SeedCandidate[],
  teamId: string | null,
  teamParentId: string | null = null,
  asManager = false,
): SeedScope {
  // No team AND no breadcrumb: unchanged behaviour, deliberately. This is the
  // one case where org-wide is what the admin actually asked for.
  //
  // THE BREADCRUMB MUST BE CHECKED HERE, NOT LATER. `team_channel_id` is
  // ON DELETE SET NULL, so a DELETED team arrives as teamId === null — exactly
  // like "no team was ever chosen". An early return on `!teamId` alone would
  // therefore route every deleted team to the org-wide seed and never reach the
  // fallback below, which is the precise widening the breadcrumb was added to
  // prevent: the column would have been written at mint, read at accept, and
  // changed nothing.
  if (!teamId && !teamParentId) {return {kind: 'orgWide'};}

  const byId = new Map(rows.map(r => [r.id, r]));
  const team = teamId ? byId.get(teamId) : undefined;

  // THE TRIGGER IS THE SURVIVAL PREDICATE, not "archived or missing".
  //
  // `configureChannel` can tighten a team to restricted AFTER the invite was
  // minted, and mintability is only checked at mint. So at accept the team is
  // neither archived nor missing, the fallback never fires, and the seed loop
  // skips the now-restricted team — the member gets ancestors but not the team
  // they were invited to. If the invited team WAS the root, the chain is [root]
  // alone and NOTHING is seeded, with HTTP 200 and the invite consumed.
  if (team && survives(team, asManager)) {
    const ids = new Set<string>([team.id]);
    for (const a of ancestorsOf(byId, team)) {ids.add(a.id);}
    for (const d of descendantsOf(rows, team.id)) {ids.add(d.id);}
    addOrgBroadcasts(rows, ids);
    return {kind: 'scoped', ids, fellBackTo: null};
  }

  // FALLBACK: the nearest SURVIVING ancestor's CHAIN — never its subtree.
  //
  // Substituting the ancestor as "the selected team" would seed its whole
  // subtree: an archived Fort Hunter under RSA would grant Fort Bravo and Fort
  // Charlie, teams the invite never expressed. Same over-grant as the org-wide
  // default, just smaller.
  //
  // And NOT org-wide, which is the tempting shortcut: a scoped manager's invite
  // is bound to their branch at mint, but accept only re-checks that the minter
  // is still an active manager. "Archived team → seed everything" therefore
  // turns an ordinary admin archive into a silent promotion of a scoped grant
  // into a full cross-branch one.
  const startId = teamParentId ?? team?.parent_id ?? null;
  let cursor = startId ? byId.get(startId) : undefined;
  for (let hop = 0; hop < MAX_DEPTH && cursor; hop++) {
    if (survives(cursor, asManager)) {
      const ids = new Set<string>([cursor.id]);
      for (const a of ancestorsOf(byId, cursor)) {ids.add(a.id);}
      addOrgBroadcasts(rows, ids);
      return {kind: 'scoped', ids, fellBackTo: cursor.id};
    }
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }

  // Nothing left to put them in. Refusing is the honest outcome: landing a real
  // member in a zero-channel workspace looks identical to a successful join
  // until they open the app.
  return {kind: 'dead'};
}

/** Ancestors of `row`, nearest first, bounded. Rows missing from the map are
 *  archived (the caller filters them) and end the walk — an archived ancestor
 *  is not seedable, so the chain honestly stops there. */
function ancestorsOf(
  byId: ReadonlyMap<string, SeedCandidate>, row: SeedCandidate,
): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  let cur = row.parent_id ? byId.get(row.parent_id) : undefined;
  for (let hop = 0; hop < MAX_DEPTH && cur; hop++) {
    // Climb THROUGH an archived rung but never seed it — the row is not in the
    // member's channel list at all, so granting it would be a membership in
    // something they can never see.
    if (!cur.archived) {out.push(cur);}
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

/** Everything under `rootId`. Iterative and depth-bounded: a cycle is
 *  unreachable through the DB (re-parenting is refused by a trigger) but would
 *  hang the accept path, which is not a place to find out. */
function descendantsOf(rows: readonly SeedCandidate[], rootId: string): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  let frontier = new Set<string>([rootId]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.size; depth++) {
    const next = new Set<string>();
    for (const r of rows) {
      if (r.archived) {continue;}
      if (r.parent_id && frontier.has(r.parent_id) && !out.some(o => o.id === r.id)) {
        out.push(r);
        next.add(r.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Add the org's #broadcast channels.
 *
 * A #broadcast IS LEVEL-SCOPED, NOT BRANCH-SCOPED, and that is the whole reason
 * this is not a chain test.
 *
 * There is exactly ONE broadcast per level for the entire organisation — the
 * unique index is on `(org_id, level)` — and `ensureBroadcastForLevel` parents
 * it under whichever node happened to create the first channel at that level.
 * That parent is an accident of creation order, not a statement about who the
 * announcements are for.
 *
 * An earlier version required the broadcast's own ancestor chain to lie inside
 * the seeded set. It read as the careful choice (don't hand out a channel
 * hanging off an invisible parent) and was measurably wrong: two members at the
 * same level in the same org received DIFFERENT announcement channels purely by
 * which branch was created first, so half the organisation silently stopped
 * receiving org-wide announcements. Losing announcements is a much worse
 * failure than seeing a channel whose parent you cannot navigate to — and the
 * renderer already has a case for exactly that (the "(not shown)" rung).
 *
 * Archived broadcasts are still excluded; they are not in anyone's list.
 */
function addOrgBroadcasts(rows: readonly SeedCandidate[], ids: Set<string>): void {
  for (const b of rows) {
    if (b.is_broadcast && !b.archived) {ids.add(b.id);}
  }
}
