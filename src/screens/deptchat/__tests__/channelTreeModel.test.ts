/**
 * UI corrections 2026-08-15 items 03 / 04 / 06 — the tree MODEL.
 *
 * `buildChannelTree` decides three things the screen then just draws: what tier
 * a row is, how far to indent it, and whether it is a level or a lateral. Every
 * one of those is a place a wrong answer is invisible — a mislabelled tier looks
 * like a design choice, and a dropped row looks like an empty organisation.
 *
 * This file also CARRIES OVER the assertions worth keeping from
 * `orgChannelTree.test.tsx`, which is retired with its screen: the masked-orphan
 * rung, the synthetic-root grouping key, and "an organisation row is a channel,
 * not a header". Dropping them silently while deleting the file would be exactly
 * the coverage loss the plan forbids.
 */
import {
  buildChannelTree, visibleTreeNodes, hasExpandableChildren, descendantIdsOf,
  isLateralRow, serverKnowsLaterals, nestParentedBroadcasts, MAX_TIER,
  type TreeRow,
} from '../organisationTree';

const row = (id: string, parent_id: string | null, over: Partial<TreeRow> = {}): TreeRow => ({
  id, name: id.toUpperCase(), parent_id,
  parent_hidden: false, visible_ancestor_id: null, root_id: null,
  is_broadcast: false, is_lateral: false, archived: false, ...over,
});

/** A full four-tier chain with a lateral hanging off the deepest node. */
const DEEP: TreeRow[] = [
  row('l1', null, {level: 0}),
  row('l2', 'l1', {level: 1}),
  row('l3', 'l2', {level: 2}),
  row('l4', 'l3', {level: 3}),
  row('lat', 'l4', {level: 3, is_lateral: true}),
];

describe('tier is WALK DEPTH, not the level column', () => {
  it('assigns L1..L4 down a full chain, and the lateral gets no tier at all', () => {
    const t = buildChannelTree(DEEP);
    expect(t.map(n => [n.row.id, n.tier])).toEqual([
      ['l1', 1], ['l2', 2], ['l3', 3], ['l4', 4], ['lat', null],
    ]);
    expect(t.find(n => n.row.id === 'lat')?.kind).toBe('lateral');
  });

  it('a LEGACY level-1 root is still L1 — this is the whole reason for walk depth', () => {
    /**
     * Two root shapes exist in production simultaneously and permanently:
     * pre-vs2-item-8 workspaces store organisations at level 1, while
     * "+ Create new organisation" mints them at level 0. Re-parenting is blocked
     * by the DB, so this can never be normalised away — and labelling by the
     * `level` column would show two identical-looking organisations as L1 and L2.
     */
    const legacy = [row('root', null, {level: 1}), row('kid', 'root', {level: 2})];
    expect(buildChannelTree(legacy).map(n => [n.row.id, n.tier]))
      .toEqual([['root', 1], ['kid', 2]]);
  });

  it('CLAMPS rather than inventing an L5', () => {
    // Only reachable through masked ancestry, but an unlabelled row beats a
    // wrong label, and a crash beats neither.
    const over = [...DEEP, row('l5', 'l4', {level: 3})];
    const tiers = buildChannelTree(over).map(n => n.tier).filter((x): x is number => x !== null);
    expect(Math.max(...tiers)).toBe(MAX_TIER);
  });

  it('a lateral does NOT advance the tier for anything after it', () => {
    // The lateral shares its parent's level, so it must not push a sibling down.
    const t = buildChannelTree([
      row('l1', null, {level: 0}),
      row('lat', 'l1', {level: 0, is_lateral: true}),
      row('l2', 'l1', {level: 1}),
    ]);
    expect(t.find(n => n.row.id === 'l2')?.tier).toBe(2);
  });
});

describe('isLateralRow / serverKnowsLaterals', () => {
  it('a #broadcast IS a lateral — the founder said so', () => {
    // "Broadcasts must be listed under specific channels, where they were
    // created under as a lateral channel."
    expect(isLateralRow(row('b', 'p', {is_broadcast: true}))).toBe(true);
  });

  it('the capability gate keys on PRESENCE, never on truthiness', () => {
    // `some(r => r.is_lateral === true)` would deadlock forever: no laterals
    // exist until one is created, and none can be created while the gate is shut.
    expect(serverKnowsLaterals([row('a', null, {is_lateral: false})])).toBe(true);
    const {is_lateral: _drop, ...old} = row('a', null);
    expect(serverKnowsLaterals([old as TreeRow])).toBe(false);
  });
});

describe('TOTALITY and UNIQUENESS — exactly once, not at least once', () => {
  /**
   * `directoryBucketsAreTotal` proves "at least once" by filtering against a
   * Set, which is structurally blind to DUPLICATES — and a duplicate is exactly
   * what an under-reaching ancestor walk produces (the row appears at top level
   * AND inside its ancestor's subtree). So this counts.
   */
  const counts = (rows: TreeRow[]) => {
    const m = new Map<string, number>();
    for (const n of buildChannelTree(rows)) {m.set(n.row.id, (m.get(n.row.id) ?? 0) + 1);}
    return m;
  };

  it.each([
    ['a full chain plus a lateral', DEEP],
    ['a flat workspace — the COMMON shape', [
      row('a', null, {level: 1}), row('b', null, {level: 1}), row('c', null, {level: 1}),
    ]],
    ['a masked orphan under a visible ancestor', [
      row('org', null, {level: 0}),
      row('mid', 'org', {level: 1}),
      row('leaf', null, {level: 3, parent_hidden: true, visible_ancestor_id: 'org'}),
    ]],
    ['a case-5 synthetic root (parent hidden, no visible ancestor)', [
      row('x', null, {level: 2, parent_hidden: true, visible_ancestor_id: null, root_id: 'ghost'}),
      row('y', null, {level: 1}),
    ]],
    ['a parentless broadcast', [row('org', null, {level: 0}), row('bc', null, {is_broadcast: true})]],
    ['an old server with no tree fields at all', [
      {id: 'p', name: 'P', parent_id: null} as TreeRow,
      {id: 'q', name: 'Q', parent_id: null} as TreeRow,
    ]],
  ])('%s — every row appears exactly once', (_label, rows) => {
    const m = counts(rows as TreeRow[]);
    expect(m.size).toBe((rows as TreeRow[]).length);
    for (const [id, c] of m) {expect(`${id}:${c}`).toBe(`${id}:1`);}
  });
});

describe('collapseChildless is a PARAMETER, not a constant', () => {
  it('the ADMIN surface keeps a childless organisation visible', () => {
    /**
     * `organisationRootsOf`: "a freshly created organisation is childless by
     * definition, so collapsing it would make it invisible in the admin org
     * list, and the admin could never drill in to add its first child. The
     * create flow would dead-end on its very first use."
     *
     * The member surface collapses it to a plain chat row instead, which is
     * right for them — hence a parameter rather than one hardcoded answer.
     */
    const rows = [row('fresh', null, {level: 0})];
    const admin = buildChannelTree(rows, {collapseChildless: false});
    expect(admin.map(n => [n.row.id, n.kind])).toEqual([['fresh', 'level']]);

    const member = buildChannelTree(rows, {collapseChildless: true});
    // Still present — just drawn as a neutral chat row rather than a tier.
    expect(member.map(n => [n.row.id, n.kind])).toEqual([['fresh', 'lateral']]);
  });
});

describe('collapsing (PDF §03)', () => {
  it('hides child levels AND the laterals beneath them', () => {
    // "When a level is collapsed, its child levels and the lateral channels
    // attached beneath that level are hidden."
    const nodes = buildChannelTree(DEEP);
    const visible = visibleTreeNodes(nodes, new Set(['l2']));
    expect(visible.map(n => n.row.id)).toEqual(['l1', 'l2']);
  });

  it('hides GRANDchildren too — an ancestor, not just a parent', () => {
    // Keying on the direct parent alone would hide L2 while leaving L3 dangling
    // under nothing.
    const nodes = buildChannelTree(DEEP);
    expect(visibleTreeNodes(nodes, new Set(['l1'])).map(n => n.row.id)).toEqual(['l1']);
  });

  it('a leaf is not expandable, so it gets no chevron', () => {
    const nodes = buildChannelTree(DEEP);
    expect(hasExpandableChildren(nodes, 'l4')).toBe(true);
    expect(hasExpandableChildren(nodes, 'lat')).toBe(false);
  });
});

describe('the collapsed unread roll-up', () => {
  it('a collapsed level can see everything beneath it', () => {
    /**
     * The drill-in row this tree replaces carried its subtree's AGGREGATE unread
     * for a documented reason: without it "the nested path had no unread signal
     * at all — the header chip counted a message the member could see nowhere".
     * A collapsed level reproduces that state exactly, so it needs the same data.
     */
    const nodes = buildChannelTree(DEEP);
    expect(descendantIdsOf(nodes, 'l1')).toEqual(['l2', 'l3', 'l4', 'lat']);
    expect(descendantIdsOf(nodes, 'l4')).toEqual(['lat']);
    expect(descendantIdsOf(nodes, 'lat')).toEqual([]);
  });
});

describe('carried over from the retired OrgChannelTreeScreen', () => {
  it('a masked orphan nests under its VISIBLE ancestor, behind a neutral rung', () => {
    const rows = [
      row('org', null, {level: 0}),
      row('leaf', null, {level: 2, parent_hidden: true, visible_ancestor_id: 'org'}),
    ];
    const t = buildChannelTree(rows);
    const leaf = t.find(n => n.row.id === 'leaf');
    expect(leaf?.parentId).toBe('org');
    expect(leaf?.rung).toBe(true);
    // The organisation itself carries no rung.
    expect(t.find(n => n.row.id === 'org')?.rung).toBe(false);
  });

  it('a case-5 synthetic root is a grouping KEY, never a row you can land on', () => {
    // `root_id` names an ancestor the caller cannot see; it must not become a
    // rendered row, or the tree asserts a channel exists that the server has
    // deliberately withheld.
    const rows = [row('x', null, {level: 2, parent_hidden: true, root_id: 'ghost'})];
    const ids = buildChannelTree(rows).map(n => n.row.id);
    expect(ids).toContain('x');
    expect(ids).not.toContain('ghost');
  });

  it('an organisation row is a CHANNEL, not a header', () => {
    // Three real shapes reach the top of this tree as openable channels: a
    // legacy Main that grew one child, a `root: true` organisation, and a
    // masked mid-tree row. Department chats are hidden from every messenger
    // list, so a top row that cannot be opened has no other door.
    const t = buildChannelTree(DEEP);
    expect(t[0].row.id).toBe('l1');
    expect(t[0].kind).toBe('level');
  });
});


/**
 * G4 (founder, 2026-08-19) — "Announcements should be within the organisation
 * itself. To avoid announcing to wrong organization/association."
 *
 * `placeRow` classifies a broadcast FIRST, so it never enters the tree: it
 * lands in `directoryBuckets.announcements` and is drawn as an unparented row
 * at the root of the screen. That is the global announcements list the founder
 * crossed out, wearing a different hat. This helper re-places the ones that can
 * be placed — and, just as importantly, refuses the ones that cannot.
 */
describe('nestParentedBroadcasts', () => {
  const BC = (id: string, parent_id: string | null) =>
    row(id, parent_id, {is_broadcast: true, level: 1});

  it('a PARENTED broadcast becomes a lateral under its own level', () => {
    const rows = [row('org', null, {level: 0}), BC('bc', 'org')];
    const t = buildChannelTree(nestParentedBroadcasts(rows), {collapseChildless: false});
    const bc = t.find(n => n.row.id === 'bc');
    expect(bc?.parentId).toBe('org');
    // Neutral card, no level colour: §04's rule for a lateral.
    expect(bc?.kind).toBe('lateral');
    expect(bc?.tier).toBeNull();
    // …and it still DRAWS as an announcement. Clearing is_broadcast without
    // this would silently turn every announcement channel into a plain chat.
    expect(bc?.row.announcement).toBe(true);
  });

  it('WITHOUT it, the same row is drawn at the root — the bug being fixed', () => {
    // The control. A test that only asserted the fixed shape could pass against
    // a helper that did nothing, if the tree happened to nest broadcasts already.
    const rows = [row('org', null, {level: 0}), BC('bc', 'org')];
    const bc = buildChannelTree(rows, {collapseChildless: false}).find(n => n.row.id === 'bc');
    expect(bc?.parentId).toBeNull();
    expect(bc?.depth).toBe(0);
  });

  it('a PARENTLESS broadcast is untouched — it has no organisation to move into', () => {
    // The common legacy shape (seedOrgWorkspace and the 2026-08-05 backfill's
    // `level <= 1` arm both produce them). Inventing a parent would assert a
    // relationship that does not exist, and the admin screen's residual
    // section is what keeps these reachable.
    const rows = [row('org', null, {level: 0}), BC('bc', null)];
    const out = nestParentedBroadcasts(rows);
    expect(out.find(r => r.id === 'bc')?.is_broadcast).toBe(true);
    expect(out.find(r => r.id === 'bc')?.is_lateral).toBe(false);
  });

  it('a broadcast whose PARENT IS NOT IN THE LIST is untouched', () => {
    /**
     * Stranding, and it is not hypothetical: the admin screen builds its tree
     * from live rows only, so a broadcast under an ARCHIVED parent has a
     * parent_id that resolves to nothing here. Re-placed, `childrenOf` would
     * never return it and no bucket would claim it either — a row with zero
     * doors, which is exactly the defect `directoryBuckets` exists to prevent.
     */
    const out = nestParentedBroadcasts([BC('bc', 'gone')]);
    expect(out[0].is_broadcast).toBe(true);
    expect(out[0].announcement).toBeUndefined();
  });

  it('is idempotent, and returns the SAME array when nothing moved', () => {
    // Referential stability is load-bearing: both callers feed this into a
    // `useMemo` chain, and a fresh array every render defeats all of them.
    const rows = [row('org', null, {level: 0}), BC('bc', null)];
    expect(nestParentedBroadcasts(rows)).toBe(rows);
    const once = nestParentedBroadcasts([row('org', null, {level: 0}), BC('bc', 'org')]);
    expect(nestParentedBroadcasts(once)).toEqual(once);
  });

  it('REFUSES a parent the tree does not walk — the row would vanish', () => {
    /**
     * MEASURED, not theoretical. `buildChannelTree` walks ONLY organisation
     * roots; the leftover buckets are emitted as flat depth-0 rows and their
     * subtrees are never walked, while `directoryBuckets` drops descendants of
     * a bucketed row. A broadcast escaped that hole only because of the
     * `!r.is_broadcast &&` short-circuit in front of `nestsUnderAnotherBucketRow`.
     *
     * So the first version of this helper made a #broadcast under a CASE-5
     * masked root (the shape a member of a restricted, unseeded root gets)
     * disappear from the directory outright — in no walk, in no bucket, with no
     * door. Exactly the class the whole G4 change exists to avoid.
     */
    const rows: TreeRow[] = [
      row('gssg', null, {level: 0}),
      row('rsa', null, {level: 2, parent_hidden: true, root_id: 'ghost'}),
      row('bc', 'rsa', {is_broadcast: true, level: 2}),
    ];
    const ids = buildChannelTree(nestParentedBroadcasts(rows)).map(n => n.row.id);
    expect(ids).toContain('bc');
    // …and it kept its bucket placement rather than being half-moved.
    expect(nestParentedBroadcasts(rows).find(r => r.id === 'bc')?.is_broadcast).toBe(true);
  });

  it('ACCEPTS a case-4 orphan parent — that one IS walked, under its ancestor', () => {
    // The mirror case. Refusing here too would be over-correction: a case-4 row
    // is returned by `childrenOf`, so its subtree is walked normally.
    const rows: TreeRow[] = [
      row('sasfa', null, {level: 0}),
      row('fort', null, {level: 2, parent_hidden: true, visible_ancestor_id: 'sasfa'}),
      row('bc', 'fort', {is_broadcast: true, level: 2}),
    ];
    const bc = buildChannelTree(nestParentedBroadcasts(rows)).find(n => n.row.id === 'bc');
    expect(bc?.parentId).toBe('fort');
    expect(bc?.kind).toBe('lateral');
  });

  it('leaves ordinary rows exactly as they were', () => {
    // The blast radius is broadcasts and nothing else — this helper runs over
    // EVERY row on two screens.
    const rows = DEEP;
    expect(nestParentedBroadcasts(rows)).toBe(rows);
  });
});
