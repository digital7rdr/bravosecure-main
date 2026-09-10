/**
 * Channels vs2 items 2 / 6 / 8 — the ONE rule that turns a flat channel list
 * into an organisation tree.
 *
 * Three surfaces need this shape: the invite team picker (item 2), the
 * member-facing directory (item 6) and the admin create/manage dashboard
 * (item 8). Writing the rule three times is this repo's most-shipped bug class,
 * so it lives here once and `organisationTreeSingleSource.test.ts` bans a
 * second copy.
 *
 * ── WHY "no parent" is not enough to mean "organisation" ──────────────────
 *
 * The member-facing endpoint MASKS `parent_id` to null when the caller is not a
 * member of the parent (server-side metadata filtering — a member of a standard
 * sub-channel must not be handed the id of its restricted parent). So a row
 * with `parent_id: null` is one of two completely different things:
 *   - a genuine organisation root, or
 *   - an orphan whose parent exists but is hidden from this caller.
 * Grouping on `!parent_id` alone renders every orphan as its own organisation —
 * exactly the flat pile item 2 exists to kill. The server therefore also sends
 * `parent_hidden`, `visible_ancestor_id` and `root_id`, and the switch below is
 * driven by those.
 *
 * ── AN ADMIN LEGITIMATELY SEES A DIFFERENT TREE FROM A MEMBER ─────────────
 *
 * Do not "fix" this. The directory shows the channels you belong to; the manage
 * dashboard shows the whole organisation. Same helper, different input: the
 * admin source is not membership-filtered, so it emits `parent_hidden:false`
 * and `visible_ancestor_id:null` on every row and the hidden-parent cases below
 * simply never fire. That is why no `authority: 'admin' | 'member'` mode
 * parameter exists — earlier drafts had one and it was the source of the bug it
 * was meant to prevent.
 */
import type {DepartmentChannelDto, ManagedChannelDto} from '@services/api';

/** The subset both sources satisfy. Everything here is optional except id/name
 *  precisely because the two DTOs disagree about what they carry. */
export interface TreeRow {
  id: string;
  name: string;
  /**
   * B-624 — the OWNING organisation, and the ONLY field `orgSectionsOf` reads.
   *
   * OPTIONAL because an old server omits it, and every consumer here fails OPEN
   * on its absence: such rows share one section rather than disappearing.
   */
  org_id?: string;
  parent_id?: string | null;
  level?: number;
  is_broadcast?: boolean;
  /**
   * UI corrections 2026-08-15 item 04 — a chat channel attached to its parent
   * WITHOUT consuming a hierarchy tier. See `isLateralRow`.
   *
   * ABSENT means the server is too old to say, which is NOT the same as false —
   * `serverKnowsLaterals` is the gate that tells them apart.
   */
  is_lateral?: boolean;
  /**
   * DISPLAY ONLY — "draw this row with the announcement glyph".
   *
   * Set by `nestParentedBroadcasts`, which clears `is_broadcast` so the row can
   * enter the tree as an ordinary lateral. Without this the re-placed row would
   * silently lose its bullhorn and read as a normal chat. It is deliberately
   * NOT a second `is_broadcast`: nothing may branch on it, and no server field
   * maps to it.
   */
  announcement?: boolean;
  archived?: boolean;
  access?: string;
  channel_type?: string;
  parent_hidden?: boolean;
  visible_ancestor_id?: string | null;
  root_id?: string | null;
  mintable_by_me?: boolean;
  /** The server's refusal code when not mintable — what makes honest copy
   *  possible. Absent on an old server. */
  mint_refusal?: string | null;
}

/**
 * The five shapes a row can have, evaluated IN ORDER. The switch is total on
 * purpose: an earlier draft was written as "roots, children, and everything
 * else", and "everything else" silently swallowed ordinary children — every
 * normal row picked up a spurious "(not shown)" rung under its own parent.
 */
export type RowPlacement =
  /** 1 — a #broadcast never enters the tree; it keeps its own treatment. */
  | {kind: 'broadcast'}
  /** 2 — an ordinary child of a parent the caller can see. No rung. */
  | {kind: 'child'; parentId: string}
  /** 3 — a genuine organisation root. */
  | {kind: 'organisation'}
  /** 4 — parent hidden, but some ancestor IS visible: nest under it and draw
   *      ONE placeholder rung between them. */
  | {kind: 'orphanUnderAncestor'; ancestorId: string}
  /** 5 — parent hidden and no visible ancestor at all: group under a synthetic,
   *      non-tappable header keyed by root_id. */
  | {kind: 'orphanUnderSyntheticRoot'; rootKey: string};

/**
 * The label for the placeholder rung in case 4.
 *
 * NEUTRAL WORDING IS DELIBERATE — do not "improve" it to "(restricted)".
 * The rung is not a statement about access. The commonest way to reach case 4
 * is a rung this member was simply never seeded into: path-scoped seeding skips
 * managers-only rungs while climbing, so SASFA → RSA(restricted) → Fort Hunter
 * seeds the root and the leaf and not the middle. Naming a reason we do not
 * actually know would leak one and be wrong most of the time.
 */
export const HIDDEN_RUNG_LABEL = '(not shown)';

/**
 * How many ancestor hops a walk may climb.
 *
 * ⚠️ FOUR, NOT THREE, SINCE ITEM 04. It used to be three, justified by
 * "`level` is CHECKed 0..3, so a row has at most three ancestors". A LATERAL
 * falsifies that: it inherits its parent's level instead of incrementing, so
 * L1(0) → L2(1) → L3(2) → L4(3) → lateral(3) sits FOUR hops from its root. At
 * three the sweep below stopped short and emitted the lateral BOTH at top level
 * and inside its ancestor's subtree — a duplicate, which is the exact defect
 * `directoryBuckets` exists to prevent.
 *
 * Four is the true bound: roots are capped at level 0/1, every STRUCTURAL hop
 * increments a level CHECKed ≤ 3, and `dept_channel_set_level` forces a lateral
 * to be a LEAF — so at most ONE non-incrementing hop can appear in a chain.
 * The server's ancestor walk carries the identical bound and the identical
 * reasoning; if one moves, so must the other.
 */
const MAX_DEPTH = 4;

/** Display tiers are L1..L4. A deeper walk (only reachable through masked
 *  ancestry) clamps rather than inventing an L5. */
export const MAX_TIER = 4;

/**
 * Is this row a LATERAL — a chat hanging off a level rather than a level itself?
 *
 * ONE definition, because two would drift. `is_broadcast` is folded in because a
 * #broadcast IS a lateral by the founder's own description ("Broadcasts must be
 * listed under specific channels, where they were created under as a lateral
 * channel") — and on the agency tenant, which keeps its per-level broadcasts,
 * that is exactly how they should draw.
 */
export function isLateralRow(row: TreeRow): boolean {
  return row.is_lateral === true || row.is_broadcast === true;
}

/**
 * Does the server that produced these rows speak the LATERAL protocol?
 *
 * PRESENCE, never truthiness. `rows.some(r => r.is_lateral === true)` would be a
 * permanent deadlock: no laterals exist yet, so the create affordance would
 * never render, so none could ever be created. And there is deliberately NO
 * `rows.length === 0` escape hatch — `serverKnowsHierarchy`'s CALL SITE has one
 * for the clean-workspace case, and copying it here would fail the gate OPEN
 * against an old server, which is the one thing it exists to prevent.
 *
 * WHY THE GATE MATTERS AT ALL: in production `forbidNonWhitelisted` is false, so
 * an old server SILENTLY STRIPS a `lateral: true` request and creates a
 * structural child instead — frozen and un-re-parentable, i.e. unfixable. This
 * hides the affordance; the server's `is_lateral` echo on create is the actual
 * guarantee, because a read-side probe cannot survive a rolling deploy.
 */
export function serverKnowsLaterals(rows: readonly TreeRow[]): boolean {
  return rows.some(r => r.is_lateral !== undefined);
}

/**
 * G4 (founder, 2026-08-19) — "Announcements should be within the organisation
 * itself. To avoid announcing to wrong organization/association."
 *
 * A `#broadcast` never enters the tree: `placeRow` classifies it first, so
 * `childrenOf` can never claim it and it lands in `directoryBuckets.announcements`
 * — rendered as an UNPARENTED row at the root of the screen. That is exactly
 * the "global announcements list" the founder crossed out twice, and the
 * organisation it actually belongs to is nowhere on the row.
 *
 * This helper re-places the ones that CAN be placed: a broadcast whose
 * `parent_id` is present in the same list becomes a plain lateral under that
 * parent. It then draws where it was created, inside its organisation, as the
 * neutral card §04 asks for, and it counts toward that organisation's total.
 *
 * ── WHY A HELPER AND NOT A CHANGE TO `placeRow` ──────────────────────────
 *
 * Rev 4 §2.4 rejected changing `placeRow`, and that reasoning is still correct
 * for AGENCIES: an agency's per-level `#broadcast` is parented to whichever node
 * happened to be the first channel created at that level, while EVERY active
 * member is seeded into it. Nesting it there would give members of other
 * branches a masked parent and demote their guaranteed announcements door to a
 * "(not shown)" rung. So the decision stays at the CALL SITE, and only the two
 * workspace-tenant tree surfaces opt in. `placeRow` is untouched.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ──────────────────────────────────
 *
 *   - A PARENTLESS broadcast. It has no organisation to move into — inventing
 *     one would assert a relationship that does not exist. It stays a
 *     `broadcast` placement and keeps its own door (the legacy section on the
 *     admin screen), which is what stops the F2 purge being a prerequisite.
 *   - A broadcast whose parent is filtered out of THIS list (archived, or
 *     hidden from this viewer). Re-placing it would strand it: `childrenOf`
 *     would never return it and no bucket would claim it either — a row with
 *     zero doors, which is the exact defect `directoryBuckets` exists to
 *     prevent.
 *   - A broadcast under a parent `buildChannelTree` DOES NOT WALK. See
 *     `parentIsWalked` — this one is not theoretical, it was measured.
 *
 * Idempotent: a row it has already re-placed has `is_broadcast === false` and
 * is skipped on a second pass.
 */
export function nestParentedBroadcasts(rows: readonly TreeRow[]): TreeRow[] {
  const present = new Set(rows.map(r => r.id));
  const byId = new Map(rows.map(r => [r.id, r]));
  /**
   * ⚠️ WILL THE TREE ACTUALLY WALK THIS PARENT? Measured, not assumed.
   *
   * `buildChannelTree` walks ONLY organisation roots. The leftovers
   * (`chats` / `otherChannels` / `announcements`) are emitted as FLAT depth-0
   * rows and their subtrees are never walked — while `directoryBuckets` drops
   * every descendant of a bucketed row via `nestsUnderAnotherBucketRow`.
   *
   * A broadcast escaped that hole only because of the `!r.is_broadcast &&`
   * short-circuit in front of that check: it always landed in the
   * `announcements` bucket, so it was always emitted. Re-placing it as an
   * ordinary child hands it straight INTO the hole — and a row that appears in
   * no walk and no bucket has zero doors on the member directory.
   *
   * Reproduced before this guard existed: a case-5 masked root (`parent_hidden`
   * with no visible ancestor — the shape a member of a restricted, unseeded
   * root gets) with a `#broadcast` under it. The row simply disappeared.
   *
   * So the rule is the honest one: nest only when the chain terminates at a row
   * that IS walked. Anything else keeps its bucket, which is a worse-looking
   * card and a door that exists.
   */
  const parentIsWalked = (id: string): boolean => {
    let cur = byId.get(id);
    for (let hop = 0; hop <= MAX_DEPTH && cur; hop++) {
      const p = placeRow(cur);
      if (p.kind === 'organisation') {return true;}
      // A bucketed row, or a broadcast (never a legal parent anyway).
      if (p.kind === 'orphanUnderSyntheticRoot' || p.kind === 'broadcast') {return false;}
      const host = p.kind === 'child' ? p.parentId : p.ancestorId;
      cur = byId.get(host);
    }
    return false;   // unresolved within the bound — keep the bucket door
  };
  let changed = false;
  const out = rows.map(r => {
    if (!r.is_broadcast || !r.parent_id || !present.has(r.parent_id)) {return r;}
    if (!parentIsWalked(r.parent_id)) {return r;}
    changed = true;
    return {...r, is_broadcast: false, is_lateral: true, announcement: true};
  });
  // Referential stability when nothing moved — these lists feed `useMemo`
  // chains and a fresh array every render would defeat every one of them.
  return changed ? out : (rows as TreeRow[]);
}

// The case-5 synthetic-group HEADERS ("Other channels" / "Other organisations")
// are deliberately NOT declared here yet. Nothing renders a case-5 group: the
// invite picker reads the admin source, which never produces one. Exporting
// copy with no renderer is how dead constants accumulate, and the header text
// should be written next to the component that shows it — in P3, with the
// member directory (items 6 and 8).

/**
 * The escape hatch on the invite form: an invite with no team seeds the joiner
 * across the WHOLE workspace, which becomes a cross-organisation grant the
 * moment a second root exists — so the copy has to say so.
 *
 * Exported as ONE constant because it has a second reader: the Approvals screen
 * renders the admin's read-back of the same state. Two literals drifted apart
 * would have an admin pick "Whole workspace" and Approvals call it something
 * else, describing the same grant two ways on two screens.
 */
export const WHOLE_WORKSPACE_LABEL = 'Whole workspace (all organisations)';

/**
 * Placement for a single row.
 *
 * `hasTreeFields` is the compat gate. A new app talking to an OLD server gets
 * neither `parent_hidden` nor `visible_ancestor_id`; every masked orphan then
 * looks like a root and the directory degrades to the flat pile. So when the
 * fields are absent AND the row has no parent, the row goes to the bucket, not
 * to the organisation list. The admin source emits them explicitly (false/null)
 * so it is never mistaken for an old server.
 */
export function placeRow(row: TreeRow): RowPlacement {
  if (row.is_broadcast) {return {kind: 'broadcast'};}
  if (row.parent_id) {return {kind: 'child', parentId: row.parent_id};}

  const hasTreeFields = row.parent_hidden !== undefined;
  if (!hasTreeFields) {
    // Old server. Route to the bucket keyed by the row itself — never to the
    // organisation list.
    return {kind: 'orphanUnderSyntheticRoot', rootKey: row.id};
  }
  if (!row.parent_hidden) {return {kind: 'organisation'};}
  if (row.visible_ancestor_id) {
    return {kind: 'orphanUnderAncestor', ancestorId: row.visible_ancestor_id};
  }
  // Case 5. root_id is the topmost ancestor regardless of visibility; it is what
  // stops two orphans under two DIFFERENT hidden roots being merged under one
  // header, which would assert a parent relationship that is false. Falling back
  // to the row's own id keeps each such row in its own group rather than
  // inventing a shared one.
  return {kind: 'orphanUnderSyntheticRoot', rootKey: row.root_id ?? row.id};
}

export interface OrganisationRootsOptions {
  /**
   * MEMBER SURFACES ONLY.
   *
   * "A parentless leaf renders as a chat row, not as an organisation heading"
   * is a directory affordance — a member with one channel should see a channel,
   * not a one-item org. Admin surfaces MUST pass false (the default): a freshly
   * created organisation is childless by definition, so collapsing it would
   * make it invisible in the admin org list, and the admin could never drill in
   * to add its first child. The create flow would dead-end on its first use.
   */
  collapseChildless?: boolean;
}

/**
 * The organisation roots of a channel list, in input order.
 *
 * GROUP FIRST, DISABLE SECOND. Un-mintable / restricted / archived rows are
 * NEVER filtered out here — callers render them greyed. Filtering first would
 * delete a restricted organisation root and promote its country children to
 * top-level "organisations" (RSA and Kenya as peers of SASFA), reproducing the
 * exact flat mess this helper exists to fix, from the helper itself.
 */
export function organisationRootsOf(
  rows: readonly TreeRow[],
  opts: OrganisationRootsOptions = {},
): TreeRow[] {
  return topLevelOf(rows, opts).filter(t => t.isOrganisation).map(t => t.row);
}

/**
 * Every row that must be rendered at the top level, each flagged with whether
 * it is genuinely an ORGANISATION.
 *
 * The distinction is not cosmetic. A row whose host is missing from the list
 * has to appear somewhere — a tree built only from real roots drops it silently
 * (it is not a root, and no `childrenOf` call will ever claim it), and on the
 * invite picker an invisible row is a team the admin cannot grant. But it is
 * NOT an organisation, and labelling it "Open organisation X" asserts a
 * structure that does not exist. So it is surfaced and flagged, and the caller
 * decides how to name it.
 */
export function topLevelOf(
  rows: readonly TreeRow[],
  opts: OrganisationRootsOptions = {},
): Array<{row: TreeRow; isOrganisation: boolean}> {
  const present = new Set(rows.map(r => r.id));
  const childCount = new Map<string, number>();
  for (const r of rows) {
    if (r.is_broadcast) {continue;}
    const parent = hostOf(r);
    if (parent && present.has(parent)) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }
  const out: Array<{row: TreeRow; isOrganisation: boolean}> = [];
  for (const r of rows) {
    if (r.is_broadcast) {continue;}
    const kind = placeRow(r).kind;
    if (kind === 'orphanUnderSyntheticRoot') {continue;}
    const isOrganisation = kind === 'organisation';
    // Stranded: wants a host, but the host is not in this list.
    const stranded = !isOrganisation && !present.has(hostOf(r) ?? '');
    if (!isOrganisation && !stranded) {continue;}
    // collapseChildless applies to ORGANISATIONS only. A stranded row has
    // nothing above it and nothing will ever claim it as a child, so collapsing
    // it would delete it from the screen — reintroducing, on member surfaces,
    // the exact silent-vanish bug this function was written to fix.
    if (isOrganisation && opts.collapseChildless && (childCount.get(r.id) ?? 0) === 0) {continue;}
    out.push({row: r, isOrganisation});
  }
  return out;
}

/** The id this row wants to hang under, or null if it wants to be a root. */
function hostOf(row: TreeRow): string | null {
  const p = placeRow(row);
  return p.kind === 'child' ? p.parentId
    : p.kind === 'orphanUnderAncestor' ? p.ancestorId
      : null;
}


/** Direct children of a node, in input order. Case-4 orphans are included: they
 *  belong under the ancestor, with a placeholder rung drawn between. */
export function childrenOf(rows: readonly TreeRow[], parentId: string): TreeRow[] {
  return rows.filter(r => {
    const p = placeRow(r);
    return (p.kind === 'child' && p.parentId === parentId)
      || (p.kind === 'orphanUnderAncestor' && p.ancestorId === parentId);
  });
}

/** True when a row must be drawn under a "(not shown)" rung beneath its host. */
export function needsHiddenRung(row: TreeRow): boolean {
  return placeRow(row).kind === 'orphanUnderAncestor';
}

/**
 * The ancestor path from the organisation root down to `id`, inclusive, for the
 * confirm-card breadcrumb (SASFA → RSA → Fort Hunter).
 *
 * Derived from `parent_id` ancestry rather than a new wire field. Bounded by the
 * row count so a cycle — which the DB's re-parent block makes unreachable, but
 * which a hand-built fixture can still express — cannot hang the render.
 */
export function ancestorPathOf(rows: readonly TreeRow[], id: string): TreeRow[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const path: TreeRow[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    const p = placeRow(cur);
    const nextId = p.kind === 'child' ? p.parentId
      : p.kind === 'orphanUnderAncestor' ? p.ancestorId
        : null;
    cur = nextId ? byId.get(nextId) : undefined;
  }
  return path;
}

/**
 * Does this list have any hierarchy at all?
 *
 * EVERY EXISTING WORKSPACE IS FLAT. `seedOrgWorkspace` inserts its channels with
 * no parent_id, so a workspace created before the hierarchy shipped is a pile of
 * parentless level-1 rows — and for those, a two-stage "pick the organisation,
 * then pick the team" picker is one extra tap that reveals a list of one-item
 * organisations. That is a worse screen than the flat radio list it replaced.
 *
 * So the tree UI is conditional on there being a tree. A row counts as
 * hierarchical when it has a parent at all — visible (`parent_id`) or masked
 * (`parent_hidden`). Deliberately NOT "placeRow said orphanUnderSyntheticRoot",
 * because that also fires for the old-server compat case, where we know nothing
 * about the shape and must not claim a hierarchy exists.
 */
export function hasHierarchy(rows: readonly TreeRow[]): boolean {
  if (!serverKnowsHierarchy(rows)) {return false;}
  return rows.some(r => !r.is_broadcast && (!!r.parent_id || r.parent_hidden === true));
}

/**
 * Does the SERVER that produced these rows speak the hierarchy protocol?
 *
 * A different question from `hasHierarchy`, and both callers need it separately:
 * the member directory asks "is there a tree to show", the admin dashboard asks
 * "can this server answer at all" — an admin surface must not collapse just
 * because a workspace has not built its structure yet.
 *
 * It must key off the SAME field `placeRow` keys off. `parent_id` alone is not
 * safe: the pre-vs2 server already emits it, so an old server plus a workspace
 * that genuinely has sub-channels would report "hierarchy exists" while
 * `placeRow` cannot classify a single row as an organisation — stage 1 then
 * renders "no organisations" to an admin who has plenty.
 *
 * Lives HERE, not in the screen. `organisationTreeSingleSource` bans a screen
 * from branching on `parent_hidden`, and it is right to: a screen-local copy of
 * this gate is a second opinion about what the tree fields mean.
 */
export function serverKnowsHierarchy(rows: readonly TreeRow[]): boolean {
  return rows.some(r => r.parent_hidden !== undefined);
}

/**
 * May this row be attached to an invite as the joiner's team?
 *
 * The server is the authority — `mintable_by_me` is the FULL refusal, branch
 * rule included — with two deliberate wrinkles:
 *
 *  - `is_broadcast` is the ONE exclusion the server does not encode. Its mint
 *    check has no broadcast guard, and a #broadcast row is standard/board with a
 *    null department, so the server would happily consider it mintable.
 *  - When the field is ABSENT (old server) we fall back to the exclusions this
 *    screen used to PRE-FILTER by. Treating absent as "allowed" would newly
 *    offer restricted and archived channels against an old server and turn every
 *    such pick into a guaranteed 400 — a regression dressed up as compatibility.
 *
 * This is the expression that used to live inline in InviteMemberScreen; it is
 * here so the picker and any future caller cannot drift apart.
 */
export function mintDisabled(row: TreeRow): boolean {
  if (row.is_broadcast) {return true;}
  if (row.mintable_by_me !== undefined) {return !row.mintable_by_me;}
  return !!row.archived || row.access === 'restricted' || row.channel_type === 'incident';
}

/**
 * WHY every row on screen is un-pickable — or null when at least one is.
 *
 * The first version of this copy asserted branch scope unconditionally, which
 * is wrong in two states that are not rare:
 *   - an UNSCOPED owner (no branch at all) whose only channel is a restricted
 *     root — the normal state right after creating an organisation. They were
 *     told to "ask an owner to widen your scope"; they ARE the owner, and scope
 *     was not the problem.
 *   - an OLD server, where `mintable_by_me` is absent and the local fallback
 *     never evaluates branch at all.
 * So the reason is derived from the server's refusal code, and falls back to a
 * deliberately vague answer rather than a confident wrong one.
 */
export type BlockedReason = 'branch' | 'managersOnly' | 'mixed';

export function blockedReasonOf(rows: readonly TreeRow[]): BlockedReason | null {
  if (rows.length === 0) {return null;}
  if (!rows.every(mintDisabled)) {return null;}
  // Broadcasts are excluded BY ROW, not by refusal code. Deleting a synthetic
  // 'broadcast' key from the set missed the real case: a broadcast that also
  // carries the server's own `team_channel_is_broadcast` code survived, and one
  // such row forced 'mixed' where 'branch' was the honest answer. (Unreachable
  // from the picker, which strips broadcasts before calling — hygiene, so the
  // helper is correct for its next caller too.)
  const codes = new Set(
    rows.filter(r => !r.is_broadcast && r.mint_refusal !== 'team_channel_is_broadcast')
      .map(r => r.mint_refusal ?? 'unknown'),
  );
  // Nothing but broadcasts: there is no reason to state.
  if (codes.size === 0) {return null;}
  if (codes.size === 1) {
    const [only] = [...codes];
    if (only === 'team_channel_outside_your_branch') {return 'branch';}
    if (only === 'team_channel_is_managers_only') {return 'managersOnly';}
  }
  return 'mixed';
}

/**
 * A node and its whole visible subtree, depth-annotated, in render order
 * (parents before children). Depth is relative to `rootId`, so the caller can
 * indent without re-walking.
 */
export function subtreeOf(
  rows: readonly TreeRow[], rootId: string, depth = 0,
  // Cycle guard, for the same reason ancestorPathOf has one: a self-parent or
  // a loop is unreachable through the DB (re-parenting is refused by a
  // trigger) but expressible in a fixture or a hand-built response, and here it
  // is an unbounded recursion — a stack overflow and a red screen, not a
  // mis-render. The two walks should not disagree about how defensive to be.
  seen: Set<string> = new Set(),
): Array<{row: TreeRow; depth: number}> {
  const self = rows.find(r => r.id === rootId);
  if (!self || seen.has(rootId)) {return [];}
  seen.add(rootId);
  const out = [{row: self, depth}];
  for (const child of childrenOf(rows, rootId)) {
    out.push(...subtreeOf(rows, child.id, depth + 1, seen));
  }
  return out;
}

export interface OrgSection {
  orgId: string | null;
  rows: TreeRow[];
}

/**
 * B-624 (client, 2026-08-22) — "Different organization channels must never mix…
 * It must ALWAYS be separate here."
 *
 * The directory renders every channel the caller is a member of, and that is
 * legitimately more than one tenant's worth: the org scope
 * (`activeWorkspaceOrgParam` / `scopeChannelsToActiveWorkspace`) is fail-open
 * and NO-OPS whenever no workspace context is set — which is every cold boot
 * and every entry that is not the Workspace Hub tile. The tree stage then never
 * looked at `org_id` at all, so `placeRow` called three roots from two tenants
 * "organisations" and drew them as siblings in one flat list.
 *
 * This is the missing stage, and it is deliberately the ONLY thing in this
 * module that reads `org_id`: split first, then build one tree per section with
 * the untouched helpers below. Cross-tenant parentage does not exist (the
 * server refuses `parent_channel_in_other_org`), so splitting cannot orphan a
 * row from its parent.
 *
 * ── THE THREE RULES, AND WHY EACH IS THE SAFE DIRECTION ──────────────────
 *
 *  - FIRST-SEEN ORDER. Sections must not reshuffle between fetches; the server
 *    returns rows in a stable order and this inherits it. Sorting by name would
 *    move a whole block the moment a channel was renamed.
 *  - AN ABSENT `org_id` IS NOT A DROP. Old-server rows share ONE `null` section.
 *    Filtering them would empty the screen for every caller on a server that
 *    predates the field — a fail-CLOSED grouping stage is a worse bug than the
 *    one being fixed.
 *  - ONE ORG ⇒ EXACTLY ONE SECTION, returning the INPUT ARRAY ITSELF. The
 *    single-tenant case (overwhelmingly the common one) must be untouched,
 *    visually and referentially: the caller feeds these rows to `useMemo`
 *    chains, and a fresh array every render defeats every one of them — the
 *    same reason `nestParentedBroadcasts` returns its input unchanged.
 *
 * TOTAL by construction: every input row is pushed into exactly one bucket, so
 * the section row counts always sum back to `rows.length`.
 */
export function orgSectionsOf(rows: readonly TreeRow[]): OrgSection[] {
  const order: Array<string | null> = [];
  const byOrg = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const key = r.org_id ?? null;
    let bucket = byOrg.get(key);
    if (!bucket) {
      bucket = [];
      byOrg.set(key, bucket);
      order.push(key);
    }
    bucket.push(r);
  }
  if (order.length === 0) {return [];}
  if (order.length === 1) {return [{orgId: order[0], rows: rows as TreeRow[]}];}
  return order.map(key => ({orgId: key, rows: byOrg.get(key) as TreeRow[]}));
}

/** Does this row's name match the query? Trimmed, case-insensitive, substring.
 *  A blank query matches everything, so callers can pass the raw input. */
export function channelMatchesQuery(row: {name: string}, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || row.name.toLowerCase().includes(q);
}

/**
 * B-625 — the rows a query keeps, as a TREE rather than as a list of hits.
 *
 * ── WHY A MATCH DRAGS ITS ANCESTORS ***AND*** ITS SUBTREE IN ─────────────
 *
 * ANCESTORS: `buildChannelTree` walks organisation roots. Keeping a deep match
 * without its chain leaves a row whose host is missing — `topLevelOf` calls
 * that STRANDED and emits it at depth 0, so the hit renders detached from the
 * organisation it belongs to, with no indication of where it lives. The tree
 * has to stay a tree.
 *
 * SUBTREE: this one is not cosmetic either. `directoryBuckets` is called with
 * `collapseChildless: true` on the member surface, so a matched organisation
 * whose children were filtered away stops being an organisation and collapses
 * into the `chats` bucket — the same row, suddenly drawn as a neutral card with
 * no level pill and no colour, purely because you typed its name. Keeping the
 * subtree makes every surviving row render EXACTLY as it does unfiltered.
 *
 * Both walks are the module's existing ones (`ancestorPathOf`, `subtreeOf`),
 * cycle-guarded and depth-bounded already; a third private walk here would be
 * the duplicate-copy class with extra steps.
 *
 * IDENTITY ON AN EMPTY QUERY — the input array itself, not a copy. The result
 * feeds `buildChannelTree` through a `useMemo`, and the no-search case is the
 * one that must stay byte-identical to the screen that shipped.
 */
export function filterTreeRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  if (query.trim().length === 0) {return rows as TreeRow[];}
  const keep = new Set<string>();
  for (const r of rows) {
    if (!channelMatchesQuery(r, query)) {continue;}
    for (const a of ancestorPathOf(rows, r.id)) {keep.add(a.id);}
    for (const {row} of subtreeOf(rows, r.id)) {keep.add(row.id);}
  }
  // `filter`, never a walk: input order is what the whole module preserves.
  return rows.filter(r => keep.has(r.id));
}

/**
 * B-625 — the ids to force-EXPAND while a search is running: every row that has
 * a child in the filtered set.
 *
 * A match hidden inside a collapsed parent is the same as no result at all,
 * which is the commonest way a tree search feels broken. `filterTreeRows` above
 * is the filter; this is only the disclosure that makes its output visible.
 */
export function expandedIdsForQuery(rows: readonly TreeRow[]): Set<string> {
  const parents = new Set<string>();
  for (const r of rows) {
    const p = r.parent_id ?? r.visible_ancestor_id;
    if (p) {parents.add(p);}
  }
  return parents;
}

/** Narrowing helpers so callers do not each re-derive the DTO union. */
export function fromManaged(rows: readonly ManagedChannelDto[]): TreeRow[] {
  return rows as unknown as TreeRow[];
}
/** The MEMBER source — membership-filtered, so `parent_hidden` and friends are
 *  the live fields rather than the admin source's explicit false/null. */
export function fromDirectory(rows: readonly DepartmentChannelDto[]): TreeRow[] {
  return rows as unknown as TreeRow[];
}

/**
 * The member directory's THREE buckets, in one pass.
 *
 * The progressive rule is a MEMBER-surface affordance: a root with visible
 * children is an organisation you drill into; a parentless LEAF is just a chat
 * row, so a legacy flat workspace keeps its one-tap chats instead of becoming
 * five "organisations" nobody created. Admin surfaces never collapse — a
 * childless organisation is still an organisation, or the create flow
 * dead-ends on its first use.
 */
export function directoryBuckets(
  rows: readonly TreeRow[],
  /**
   * ⚠️ ADMIN SURFACES MUST PASS `false`, and this is a parameter rather than a
   * hardcoded `true` precisely because `ChannelTree` is now shared by the member
   * directory and the admin dashboard.
   *
   * `organisationRootsOf`'s own docblock spells out why: "a freshly created
   * organisation is childless by definition, so collapsing it would make it
   * invisible in the admin org list, and the admin could never drill in to add
   * its first child. The create flow would dead-end on its very first use."
   *
   * Defaulted to `true` so every pre-existing member-surface caller is unchanged.
   */
  opts: OrganisationRootsOptions = {collapseChildless: true},
): {
  organisations: TreeRow[];
  chats: TreeRow[];
  otherChannels: TreeRow[];
  announcements: TreeRow[];
} {
  const organisations = organisationRootsOf(rows, opts);

  /**
   * TOTALITY IS THE POINT, and the first version did not have it.
   *
   * That version assigned only two placements and let `child` /
   * `orphanUnderAncestor` fall through, on the assumption they were always
   * reachable by drilling into an organisation. That holds only while the chain
   * ENDS at a real organisation. It does not when the chain terminates at a
   * case-5 row: a member of a hidden-rooted RSA and of its child Fort Hunter
   * saw RSA under "Other channels" and Fort Hunter NOWHERE — in no bucket, in
   * no subtree, with no door. And the restricted/unseeded root that produces
   * case 5 is the same thing that produces those orphaned descendants, so it
   * was the common shape, not an exotic one.
   *
   * So: compute what the organisations actually cover, then sweep EVERY
   * remaining row into a bucket. `directoryBucketsAreTotal` in the tests
   * asserts the arithmetic, because "I think I covered every case" is exactly
   * the reasoning that failed here.
   */
  const covered = new Set<string>();
  for (const o of organisations) {
    for (const {row} of subtreeOf(rows, o.id)) {covered.add(row.id);}
  }

  const chats: TreeRow[] = [];
  const otherChannels: TreeRow[] = [];
  const announcements: TreeRow[] = [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const uncovered = new Set(
    rows.filter(r => !covered.has(r.id) && !r.is_broadcast).map(r => r.id));

  /**
   * Is this row reachable by drilling into ANOTHER uncovered row?
   *
   * Totality on its own produced duplicates: a child of a bucketed row appeared
   * at the top level AND inside that row's drill-down. Descendants belong to
   * their ancestor's tree, so the sweep keeps only the tops.
   */
  const nestsUnderAnotherBucketRow = (row: TreeRow): boolean => {
    let cur: TreeRow | undefined = row;
    for (let hop = 0; hop < MAX_DEPTH && cur; hop++) {
      const host = hostOf(cur);
      if (!host) {return false;}
      if (uncovered.has(host)) {return true;}
      cur = byId.get(host);
    }
    return false;
  };

  for (const r of rows) {
    if (covered.has(r.id)) {continue;}
    if (!r.is_broadcast && nestsUnderAnotherBucketRow(r)) {continue;}
    /**
     * #broadcast is ORG-WIDE and gets its own bucket rather than being skipped.
     *
     * Skipping it removed the announcements channel from the directory the
     * moment a workspace grew a hierarchy: `placeRow` returns `broadcast`, so
     * `childrenOf` never claims it and `subtreeOf` cannot emit it either —
     * three surfaces, zero doors — while the header chip kept counting it and
     * its unread kept feeding the total. Every workspace created before this
     * batch has one.
     */
    if (r.is_broadcast) {announcements.push(r); continue;}
    // A collapsed childless root reads as a plain chat row; everything else
    // that no organisation covers goes to the bucket. No third branch: the
    // absence of one is what makes this total.
    if (placeRow(r).kind === 'organisation') {chats.push(r);} else {otherChannels.push(r);}
  }
  return {organisations, chats, otherChannels, announcements};
}

/**
 * Does this row lead somewhere — i.e. is it worth drilling into rather than
 * opening as a chat?
 *
 * A bucketed row can still have a subtree of its own (a hidden-rooted RSA with
 * children). Rendering it as a flat chat row is what made those children
 * unreachable, so the caller asks this to decide between opening a thread and
 * opening the tree.
 */
export function hasSubtree(rows: readonly TreeRow[], id: string): boolean {
  return subtreeOf(rows, id).length > 1;
}

/**
 * UI corrections 2026-08-15 items 03 / 04 / 06 — the RENDER-READY tree.
 *
 * The PDF replaces the drill-down with a single screen whose levels expand and
 * collapse: "Every hierarchy level must be collapsible/expandable… Users should
 * only open the branches they need." So the renderer needs a flat, ordered list
 * of rows that already knows, for each one, what TIER it is, how far to indent
 * it, and whether it is a level or a lateral.
 *
 * Deriving that in the screen would be a second copy of "what nests under what"
 * — this repo's most-shipped defect — so it lives here beside `placeRow`, and
 * `organisationTreeSingleSource` keeps it that way.
 *
 * ── TIER IS WALK DEPTH, NOT THE `level` COLUMN ────────────────────────────
 *
 * Two root shapes exist in production simultaneously and permanently:
 * pre-vs2-item-8 workspaces have organisations stored at level 1, while
 * "+ Create new organisation" mints them at level 0. Re-parenting is blocked by
 * the DB, so the asymmetry can never be normalised away. Labelling by `level`
 * would show two identical-looking organisations as L1 and L2. Walk depth is
 * invariant to it.
 *
 * ⚠️ CAPABILITY IS THE OPPOSITE — anything asking "may this node take a
 * sub-level?" MUST read the stored `level`, because that is what the server
 * enforces (`parent.level >= 3` → max_channel_depth_reached). Gate on tier and
 * a legacy level-1-rooted workspace renders a button whose every tap 400s.
 *
 * ── TOTALITY ──────────────────────────────────────────────────────────────
 *
 * Every input row appears EXACTLY ONCE. `directoryBuckets` supplies the
 * leftovers so a member whose channels are all mid-tree still sees them, and
 * `channelTreeTotality.test.ts` asserts the arithmetic — "at least once" is not
 * enough, because the 4-hop bound above exists to prevent DUPLICATES.
 */


export interface ChannelTreeNode {
  row: TreeRow;
  kind: 'level' | 'lateral';
  /** Display tier 1..4 for a level row; null for a lateral (it has no colour). */
  tier: number | null;
  /** Indent steps from the left edge. Laterals indent one past their level. */
  depth: number;
  /** Draw the "(not shown)" placeholder rung above this row. */
  rung: boolean;
  /** The id whose expansion controls this row's visibility (null at the top). */
  parentId: string | null;
}

export function buildChannelTree(
  rows: readonly TreeRow[],
  opts: OrganisationRootsOptions = {collapseChildless: true},
): ChannelTreeNode[] {
  const out: ChannelTreeNode[] = [];
  const seen = new Set<string>();

  const walk = (id: string, parentTier: number, depth: number, parentId: string | null): void => {
    const self = rows.find(r => r.id === id);
    // Cycles are impossible through the DB (re-parenting is refused) but are
    // expressible in a fixture or a hand-built response, where they would be an
    // unbounded recursion rather than a mis-render. The other two walks in this
    // module guard the same way.
    if (!self || seen.has(id)) {return;}
    seen.add(id);
    const lateral = isLateralRow(self);
    // A lateral belongs to its PARENT's level ("part of the same level, just
    // nested under it"), so it does not advance the tier. A structural child
    // does. Clamped rather than allowed to invent an L5 — reachable only
    // through masked ancestry, and an unlabelled row beats a wrong label.
    const tier = lateral ? parentTier : Math.min(parentTier + 1, MAX_TIER);
    out.push({
      row: self,
      kind: lateral ? 'lateral' : 'level',
      tier: lateral ? null : tier,
      depth,
      rung: needsHiddenRung(self),
      parentId,
    });
    for (const child of childrenOf(rows, id)) {
      walk(child.id, tier, depth + 1, id);
    }
  };

  const buckets = directoryBuckets(rows, opts);
  for (const org of buckets.organisations) {
    walk(org.id, 0, 0, null);
  }

  /**
   * The leftovers, as ROOT-LEVEL NEUTRAL ROWS.
   *
   * This is what makes a FLAT workspace work — and flat is the common shape, not
   * an edge case: "EVERY EXISTING WORKSPACE IS FLAT" (see `hasHierarchy`), and a
   * workspace with one organisation and no sub-levels is flat too. Rendering
   * those as a clean list of channel cards is precisely what retires the
   * "LEVEL 2 — MAIN" screen the client review crossed out (item 11).
   *
   * Order is stated so it cannot drift: real chats first, then anything an
   * organisation did not cover, then announcements. `seen` makes it idempotent
   * against the walks above.
   */
  for (const r of [...buckets.chats, ...buckets.otherChannels, ...buckets.announcements]) {
    if (seen.has(r.id)) {continue;}
    seen.add(r.id);
    out.push({row: r, kind: 'lateral', tier: null, depth: 0, rung: needsHiddenRung(r), parentId: null});
  }
  return out;
}

/**
 * Which rows are visible given a set of COLLAPSED node ids.
 *
 * Kept beside the builder rather than in the screen: "collapsing a level hides
 * its child levels AND the lateral channels attached beneath it" (PDF §03) is a
 * statement about the tree, and a screen-local version would have to re-derive
 * parentage to honour it.
 *
 * A row is hidden when ANY ancestor is collapsed, not just its parent —
 * otherwise collapsing L1 would hide L2 while leaving L3 dangling under nothing.
 */
export function visibleTreeNodes(
  nodes: readonly ChannelTreeNode[],
  collapsed: ReadonlySet<string>,
): ChannelTreeNode[] {
  const hidden = new Set<string>();
  const out: ChannelTreeNode[] = [];
  for (const n of nodes) {
    const parentHidden = n.parentId !== null
      && (hidden.has(n.parentId) || collapsed.has(n.parentId));
    if (parentHidden) {
      // Its own children must go too — recorded rather than recomputed, which
      // works because the builder emits parents before children.
      hidden.add(n.row.id);
      continue;
    }
    out.push(n);
  }
  return out;
}

/** Does this node have anything to expand? Drives whether a chevron renders. */
export function hasExpandableChildren(
  nodes: readonly ChannelTreeNode[], id: string,
): boolean {
  return nodes.some(n => n.parentId === id);
}

/**
 * Every row beneath `id`, at any depth.
 *
 * EXISTS FOR THE UNREAD ROLL-UP, and that is not a nicety. The drill-in row this
 * tree replaces carried its subtree's AGGREGATE unread for a documented reason:
 * without it "the nested path had no unread signal at all — the header chip
 * counted a message the member could see nowhere, and the only way to find it
 * was to open every organisation in turn". A COLLAPSED level reproduces exactly
 * that state, so it inherits exactly that answer.
 *
 * Works off the already-built node list rather than re-walking `rows`, so it
 * cannot disagree with what is on screen. Cheap: the list is parents-before-
 * children, so one pass with a frontier set is enough.
 */
export function descendantIdsOf(
  nodes: readonly ChannelTreeNode[], id: string,
): string[] {
  const under = new Set<string>([id]);
  const out: string[] = [];
  for (const n of nodes) {
    if (n.parentId !== null && under.has(n.parentId)) {
      under.add(n.row.id);
      out.push(n.row.id);
    }
  }
  return out;
}
