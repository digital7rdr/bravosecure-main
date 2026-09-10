/**
 * Channels vs2 item 2 — the shared organisation-grouping helper.
 *
 * The headline gate here is the ROUND-TRIP PROPERTY TEST at the bottom. The
 * failure this whole helper exists to prevent is the admin tree and the member
 * tree disagreeing about what an "organisation" is — and that cannot be caught
 * by asserting either one in isolation, because each looks perfectly sensible
 * on its own fixture. The property ties them together: grouping the full admin
 * list and then keeping only the visible rows must equal grouping the projected
 * member list. Anything that makes the two views diverge breaks it.
 */
import {
  placeRow, organisationRootsOf, childrenOf, needsHiddenRung, ancestorPathOf,
  topLevelOf as organisationTopLevel, hasHierarchy, mintDisabled, blockedReasonOf, subtreeOf,
  directoryBuckets, hasSubtree, orgSectionsOf, filterTreeRows, channelMatchesQuery, expandedIdsForQuery,
  buildChannelTree,
  HIDDEN_RUNG_LABEL, WHOLE_WORKSPACE_LABEL, type TreeRow,
} from '../organisationTree';

/** An admin-source row: true parent_id, nothing hidden, fields EXPLICIT. */
const admin = (id: string, parent_id: string | null, over: Partial<TreeRow> = {}): TreeRow => ({
  id, name: id, parent_id, parent_hidden: false, visible_ancestor_id: null, ...over,
});

/**
 * The server's member-side masking, reproduced exactly: parent_id is nulled
 * when the caller is not a member of the parent, and the three tree fields are
 * filled from the FULL tree. This is the `project` of the property test, and it
 * is written once here so both halves of the property use the same rule.
 */
function project(rows: readonly TreeRow[], visible: ReadonlySet<string>): TreeRow[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const rootOf = (r: TreeRow): string | null => {
    let cur = r, top: string | null = null, hops = 0;
    while (cur.parent_id && hops++ < 3) {
      const p = byId.get(cur.parent_id);
      if (!p) {break;}
      top = p.id; cur = p;
    }
    return top;
  };
  const nearestVisible = (r: TreeRow): string | null => {
    let cur = r, hops = 0;
    while (cur.parent_id && hops++ < 3) {
      const p = byId.get(cur.parent_id);
      if (!p) {return null;}
      if (visible.has(p.id)) {return p.id;}
      cur = p;
    }
    return null;
  };
  return rows.filter(r => visible.has(r.id)).map(r => {
    const parentHidden = !!r.parent_id && !visible.has(r.parent_id);
    const nearest = nearestVisible(r);
    return {
      ...r,
      parent_id: r.parent_id && visible.has(r.parent_id) ? r.parent_id : null,
      parent_hidden: parentHidden,
      visible_ancestor_id: nearest,
      // GATED, exactly as the server gates it. An earlier version of this model
      // emitted root_id unconditionally — i.e. it encoded the PRE-fix server,
      // in which root_id leaked the uuid of an invisible ancestor to a caller
      // whose parent was visible. Every assertion still passed, because
      // placeRow only reads root_id in case 5. So the property test could not
      // have caught the gate being deleted: the model has to match the server
      // or it is not a model.
      root_id: parentHidden && nearest === null ? rootOf(r) : null,
    };
  });
}

describe('placeRow — the five-case switch is TOTAL', () => {
  it('1. a broadcast never enters the tree', () => {
    expect(placeRow({id: 'b', name: '#broadcast', is_broadcast: true, parent_id: 'p'}).kind)
      .toBe('broadcast');
    // …even when it would otherwise look like an organisation root.
    expect(placeRow({id: 'b', name: '#b', is_broadcast: true, parent_id: null, parent_hidden: false}).kind)
      .toBe('broadcast');
  });

  it('2. a child of a VISIBLE parent nests normally, with no rung', () => {
    const p = placeRow(admin('c', 'p'));
    expect(p).toEqual({kind: 'child', parentId: 'p'});
    expect(needsHiddenRung(admin('c', 'p'))).toBe(false);
  });

  it('3. a genuine root is an organisation', () => {
    expect(placeRow(admin('root', null)).kind).toBe('organisation');
  });

  it('4. a hidden parent WITH a visible ancestor nests under it, with a rung', () => {
    const row: TreeRow = {id: 'leaf', name: 'Fort Hunter', parent_id: null,
      parent_hidden: true, visible_ancestor_id: 'sasfa', root_id: 'sasfa'};
    expect(placeRow(row)).toEqual({kind: 'orphanUnderAncestor', ancestorId: 'sasfa'});
    expect(needsHiddenRung(row)).toBe(true);
  });

  it('5. a hidden parent with NO visible ancestor groups by root_id', () => {
    const row: TreeRow = {id: 'leaf', name: 'Fort Hunter', parent_id: null,
      parent_hidden: true, visible_ancestor_id: null, root_id: 'hidden-root'};
    expect(placeRow(row)).toEqual({kind: 'orphanUnderSyntheticRoot', rootKey: 'hidden-root'});
  });

  it('5b. two orphans under DIFFERENT hidden roots are NOT merged', () => {
    // Merging them would assert a parent relationship that is false — worse
    // than the single bucket it replaced. Reachable today via item 8's per-node
    // "Add Members", which places a member under a node without seeding its
    // ancestors.
    const a: TreeRow = {id: 'a', name: 'A', parent_id: null, parent_hidden: true,
      visible_ancestor_id: null, root_id: 'root-1'};
    const b: TreeRow = {id: 'b', name: 'B', parent_id: null, parent_hidden: true,
      visible_ancestor_id: null, root_id: 'root-2'};
    const ka = placeRow(a) as {rootKey: string};
    const kb = placeRow(b) as {rootKey: string};
    expect(ka.rootKey).not.toBe(kb.rootKey);
  });

  it('an ordinary child NEVER gets a spurious rung (the case-4 over-reach)', () => {
    // The bug an earlier three-case draft had: "everything the root rule
    // rejected" swallowed ordinary children, so every normal parent grew a
    // "(not shown)" rung underneath it.
    const rows = [admin('root', null), admin('mid', 'root'), admin('leaf', 'mid')];
    expect(rows.filter(needsHiddenRung)).toEqual([]);
  });
});

describe('compat — an OLD server (fields absent) must not manufacture organisations', () => {
  it('a parentless row with NO tree fields goes to the bucket, not the org list', () => {
    const old: TreeRow = {id: 'x', name: 'X', parent_id: null};
    expect(placeRow(old).kind).toBe('orphanUnderSyntheticRoot');
    expect(organisationRootsOf([old])).toEqual([]);
  });

  it('present-and-false is NOT the same as absent', () => {
    // The admin source emits false/null explicitly for exactly this reason. If
    // "false" were treated like "absent", the admin organisation list would be
    // empty and item 8's create flow would dead-end on its first use.
    expect(placeRow({id: 'x', name: 'X', parent_id: null, parent_hidden: false}).kind)
      .toBe('organisation');
  });
});

describe('organisationRootsOf', () => {
  const tree = [
    admin('sasfa', null), admin('rsa', 'sasfa'), admin('fort', 'rsa'),
    admin('cortac', null),
    admin('bcast', null, {is_broadcast: true}),
  ];

  it('returns only the roots, in input order', () => {
    expect(organisationRootsOf(tree).map(r => r.id)).toEqual(['sasfa', 'cortac']);
  });

  it('GROUPS FIRST AND DISABLES SECOND — a restricted root is still a root', () => {
    // Filtering it out would promote its children to top-level organisations,
    // reproducing the flat pile this helper exists to kill.
    const withRestricted = [admin('sasfa', null, {access: 'restricted'}), admin('rsa', 'sasfa')];
    expect(organisationRootsOf(withRestricted).map(r => r.id)).toEqual(['sasfa']);
  });

  it('an archived root is still a root (the admin list includes archived rows)', () => {
    expect(organisationRootsOf([admin('old', null, {archived: true})]).map(r => r.id))
      .toEqual(['old']);
  });

  it('collapseChildless hides a lone leaf on MEMBER surfaces', () => {
    const lone = [admin('solo', null)];
    expect(organisationRootsOf(lone, {collapseChildless: true})).toEqual([]);
    expect(organisationRootsOf(lone).map(r => r.id)).toEqual(['solo']);
  });

  it('a freshly created (childless) organisation stays visible to an ADMIN', () => {
    // The default. If this ever collapses, an admin cannot drill into the
    // organisation they just made to add its first child — the create flow
    // dead-ends on its very first use.
    expect(organisationRootsOf([admin('brand-new', null)]).map(r => r.id)).toEqual(['brand-new']);
  });

  it('a case-4 orphan counts as a child for collapseChildless', () => {
    const rows: TreeRow[] = [
      admin('sasfa', null),
      {id: 'fort', name: 'Fort', parent_id: null, parent_hidden: true, visible_ancestor_id: 'sasfa'},
    ];
    expect(organisationRootsOf(rows, {collapseChildless: true}).map(r => r.id)).toEqual(['sasfa']);
  });
});

describe('childrenOf and the breadcrumb', () => {
  const rows: TreeRow[] = [
    admin('sasfa', null), admin('rsa', 'sasfa'), admin('fort', 'rsa'),
    {id: 'orphan', name: 'Orphan', parent_id: null, parent_hidden: true, visible_ancestor_id: 'sasfa'},
  ];

  it('includes case-4 orphans under their visible ancestor', () => {
    expect(childrenOf(rows, 'sasfa').map(r => r.id)).toEqual(['rsa', 'orphan']);
  });

  it('builds the root-to-node path for the confirm card', () => {
    expect(ancestorPathOf(rows, 'fort').map(r => r.id)).toEqual(['sasfa', 'rsa', 'fort']);
  });

  it('a case-4 orphan path skips the hidden rung rather than inventing one', () => {
    expect(ancestorPathOf(rows, 'orphan').map(r => r.id)).toEqual(['sasfa', 'orphan']);
  });

  it('a cycle cannot hang the render', () => {
    // Unreachable through the DB (re-parenting is refused by a trigger) but a
    // hand-built fixture can express it, and an unbounded walk would spin.
    const cyc: TreeRow[] = [admin('a', 'b'), admin('b', 'a')];
    expect(ancestorPathOf(cyc, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('topLevelOf — total rendering WITHOUT lying about structure', () => {
  it('flags a stranded row as NOT an organisation', () => {
    // Callers hand this helper filtered lists (the picker drops archived rows),
    // so a live child can lose its parent. It must still be reachable — a tree
    // built only from real roots drops it silently — but calling it an
    // organisation asserts a structure the workspace does not have.
    const rows: TreeRow[] = [admin('live', 'gone')];
    const tops = organisationTopLevel(rows);
    expect(tops.map(t => t.row.id)).toEqual(['live']);
    expect(tops[0].isOrganisation).toBe(false);
    // …and it is NOT reported as an organisation by the strict accessor.
    expect(organisationRootsOf(rows)).toEqual([]);
  });

  it('a real root is flagged as an organisation', () => {
    const tops = organisationTopLevel([admin('sasfa', null)]);
    expect(tops[0]).toMatchObject({isOrganisation: true});
  });

  it('a case-5 orphan is NOT promoted to top level — it has its own header', () => {
    const row: TreeRow = {id: 'x', name: 'X', parent_id: null, parent_hidden: true,
      visible_ancestor_id: null, root_id: 'hidden'};
    expect(organisationTopLevel([row])).toEqual([]);
  });
});

describe('hasHierarchy — the compat gate', () => {
  it('is FALSE when no row carries the tree fields, even with real parents', () => {
    // The blocker: parent_id is emitted by the PRE-vs2 server too, so keying on
    // it alone made the screen claim a hierarchy that placeRow could not
    // classify — "No organisations yet" to an admin with a full tree.
    const old: TreeRow[] = [{id: 'r', name: 'R', parent_id: null},
      {id: 'c', name: 'C', parent_id: 'r'}];
    expect(hasHierarchy(old)).toBe(false);
  });

  it('is FALSE for a flat NEW-server workspace', () => {
    expect(hasHierarchy([admin('a', null), admin('b', null)])).toBe(false);
  });

  it('is TRUE once a row has a parent, visible or masked', () => {
    expect(hasHierarchy([admin('r', null), admin('c', 'r')])).toBe(true);
    expect(hasHierarchy([admin('r', null),
      {id: 'o', name: 'O', parent_id: null, parent_hidden: true}])).toBe(true);
  });

  it('a lone #broadcast does not constitute a hierarchy', () => {
    expect(hasHierarchy([admin('b', 'p', {is_broadcast: true})])).toBe(false);
  });
});

describe('mintDisabled — server answer wins, local fallback for an old server', () => {
  it('trusts mintable_by_me when the server sent it', () => {
    expect(mintDisabled({id: 'a', name: 'A', mintable_by_me: true, access: 'restricted'})).toBe(false);
    expect(mintDisabled({id: 'a', name: 'A', mintable_by_me: false})).toBe(true);
  });

  it('a #broadcast is disabled even when the server calls it mintable', () => {
    // The one exclusion the server's predicate historically did not encode.
    expect(mintDisabled({id: 'b', name: 'B', mintable_by_me: true, is_broadcast: true})).toBe(true);
  });

  it('falls back to the local exclusions when the field is ABSENT', () => {
    // Treating absent as "allowed" would newly offer restricted and archived
    // channels against an old server — every pick a guaranteed 400.
    expect(mintDisabled({id: 'a', name: 'A', access: 'restricted'})).toBe(true);
    expect(mintDisabled({id: 'a', name: 'A', channel_type: 'incident'})).toBe(true);
    expect(mintDisabled({id: 'a', name: 'A', archived: true})).toBe(true);
    expect(mintDisabled({id: 'a', name: 'A', access: 'standard'})).toBe(false);
  });
});

describe('blockedReasonOf — never assert a reason we do not know', () => {
  const grey = (code: string | null) => ({id: code ?? 'x', name: 'N', mintable_by_me: false, mint_refusal: code});

  it('is null while anything is still pickable', () => {
    expect(blockedReasonOf([{id: 'ok', name: 'OK', mintable_by_me: true}, grey('x')])).toBeNull();
  });

  it('names the branch only when EVERY refusal is the branch', () => {
    expect(blockedReasonOf([grey('team_channel_outside_your_branch')])).toBe('branch');
    expect(blockedReasonOf([grey('team_channel_outside_your_branch'),
      grey('team_channel_is_managers_only')])).toBe('mixed');
  });

  it('an UNSCOPED owner looking at restricted channels is not told about branches', () => {
    // The state right after creating an organisation. The old copy told the
    // owner to "ask an owner to widen your scope".
    expect(blockedReasonOf([grey('team_channel_is_managers_only')])).toBe('managersOnly');
  });

  it('an OLD server (no refusal codes) falls back to vague, not confident', () => {
    expect(blockedReasonOf([{id: 'a', name: 'A', access: 'restricted'}])).toBe('mixed');
  });
});

describe('subtreeOf', () => {
  const rows = [admin('r', null), admin('a', 'r'), admin('b', 'a')];

  it('returns the node and its descendants, depth-annotated', () => {
    expect(subtreeOf(rows, 'r').map(x => [x.row.id, x.depth]))
      .toEqual([['r', 0], ['a', 1], ['b', 2]]);
  });

  it('a cycle cannot overflow the stack', () => {
    // ancestorPathOf has guarded this since it was written; subtreeOf did not,
    // and an unbounded recursion here is a red screen rather than a mis-render.
    const cyc = [admin('a', 'b'), admin('b', 'a')];
    expect(subtreeOf(cyc, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('directoryBuckets is TOTAL — nothing a member has may vanish', () => {
  /** Every id the buckets account for, including everything drilled into. */
  const accountedFor = (rows: TreeRow[]): Set<string> => {
    const b = directoryBuckets(rows);
    const seen = new Set<string>();
    for (const o of b.organisations) {
      for (const {row} of subtreeOf(rows, o.id)) {seen.add(row.id);}
    }
    for (const r of [...b.chats, ...b.otherChannels, ...b.announcements]) {seen.add(r.id);}
    // A bucketed row that leads somewhere drills in, so its subtree counts too.
    for (const r of b.otherChannels) {
      for (const {row} of subtreeOf(rows, r.id)) {seen.add(row.id);}
    }
    return seen;
  };

  const shapes: Array<[string, TreeRow[]]> = [
    ['a plain organisation', [admin('sasfa', null), admin('rsa', 'sasfa')]],
    ['a lone leaf', [admin('solo', null)]],
    ['a #broadcast', [admin('b', null, {is_broadcast: true})]],
    ['an org plus a broadcast', [admin('sasfa', null), admin('rsa', 'sasfa'), admin('b', null, {is_broadcast: true})]],
    ['a case-5 orphan', [{id: 'y', name: 'Y', parent_id: null, parent_hidden: true,
      visible_ancestor_id: null, root_id: 'hidden'}]],
    // THE SHAPE THAT SHIPPED BROKEN: a visible child of a case-5 row. Neither is
    // an organisation, so the child belonged to no bucket and no subtree.
    ['a child UNDER a case-5 orphan', [
      {id: 'y', name: 'Y', parent_id: null, parent_hidden: true, visible_ancestor_id: null, root_id: 'hidden'},
      admin('leaf', 'y'),
    ]],
    ['a case-4 orphan under a case-5 row', [
      {id: 'y', name: 'Y', parent_id: null, parent_hidden: true, visible_ancestor_id: null, root_id: 'hidden'},
      {id: 'deep', name: 'Deep', parent_id: null, parent_hidden: true, visible_ancestor_id: 'y'},
    ]],
    // THE SHAPE ONLY THE SWEEP CATCHES: a child whose parent is not in the
    // list at all (paged out, or membership revoked between fetches). It is not
    // an organisation, no organisation covers it, and no bucketed row leads to
    // it — so a branch-by-branch assignment drops it silently.
    ['a child whose parent is absent entirely', [admin('orphaned', 'gone-parent')]],
    ['a case-4 orphan whose ancestor is absent', [
      {id: 'x', name: 'X', parent_id: null, parent_hidden: true, visible_ancestor_id: 'not-here'},
    ]],
    ['nothing at all', []],
  ];

  it.each(shapes)('accounts for every row: %s', (_label, rows) => {
    const seen = accountedFor(rows);
    const missing = rows.filter(r => !seen.has(r.id)).map(r => r.id);
    expect(missing).toEqual([]);
  });

  it('a #broadcast is never dropped — it is org-wide announcements', () => {
    // Skipping it removed the announcements channel from the directory the
    // moment a workspace grew a hierarchy, while the header chip kept counting
    // it. Every workspace created before vs2 has one.
    const rows = [admin('sasfa', null), admin('rsa', 'sasfa'), admin('b', null, {is_broadcast: true})];
    expect(directoryBuckets(rows).announcements.map(r => r.id)).toEqual(['b']);
  });

  it('a bucketed row that leads somewhere is drillable, not a flat chat', () => {
    const rows: TreeRow[] = [
      {id: 'y', name: 'Y', parent_id: null, parent_hidden: true, visible_ancestor_id: null, root_id: 'hidden'},
      admin('leaf', 'y'),
    ];
    expect(directoryBuckets(rows).otherChannels.map(r => r.id)).toEqual(['y']);
    expect(hasSubtree(rows, 'y')).toBe(true);
    expect(hasSubtree(rows, 'leaf')).toBe(false);
  });
});

describe('shared copy constants', () => {
  it('the escape hatch names the CROSS-ORGANISATION consequence', () => {
    // An org-wide seed becomes a cross-organisation grant the moment a second
    // root exists; copy that says only "no specific team" hides that.
    expect(WHOLE_WORKSPACE_LABEL).toMatch(/all organisations/i);
  });

  it('the hidden rung is labelled neutrally, never by a reason we do not know', () => {
    expect(HIDDEN_RUNG_LABEL).toBe('(not shown)');
    expect(HIDDEN_RUNG_LABEL).not.toMatch(/restricted|private|denied|no access/i);
  });
});

/**
 * THE GATE. For any admin tree and any visible subset, grouping the admin list
 * and intersecting with what is visible must equal grouping the projected
 * member list. This is what actually catches the two views diverging.
 */
describe('round-trip property — admin and member views agree', () => {
  const full: TreeRow[] = [
    admin('sasfa', null), admin('rsa', 'sasfa'), admin('kenya', 'sasfa'),
    admin('fort', 'rsa'), admin('bravo', 'rsa'), admin('nairobi', 'kenya'),
    admin('cortac', null), admin('gssg', null), admin('gssg-main', 'gssg'),
  ];

  /** Every subset would be 2^9; these cover each structurally distinct shape. */
  const subsets: Array<[string, string[]]> = [
    ['everything', full.map(r => r.id)],
    ['one whole branch', ['sasfa', 'rsa', 'fort']],
    ['leaf only, root hidden', ['fort']],
    ['leaf + root, middle hidden', ['sasfa', 'fort']],
    ['two leaves under different hidden middles', ['sasfa', 'fort', 'nairobi']],
    ['two separate organisations', ['sasfa', 'cortac']],
    ['leaves of two different hidden roots', ['fort', 'gssg-main']],
    ['nothing', []],
    ['a childless root only', ['cortac']],
  ];

  it.each(subsets)('holds for: %s', (_label, visibleIds) => {
    const visible = new Set(visibleIds);
    const adminRoots = organisationRootsOf(full).filter(r => visible.has(r.id)).map(r => r.id);
    const memberRoots = organisationRootsOf(project(full, visible)).map(r => r.id);
    expect(memberRoots).toEqual(adminRoots);
  });

  it('a masked orphan is never promoted to an organisation', () => {
    // The single most important consequence: 'fort' is a level-3 leaf whose
    // whole chain is hidden. It must NOT appear as an organisation.
    const projected = project(full, new Set(['fort']));
    expect(projected[0].parent_hidden).toBe(true);
    expect(organisationRootsOf(projected)).toEqual([]);
    expect(placeRow(projected[0]).kind).toBe('orphanUnderSyntheticRoot');
  });

  it('root_id is NULL for every row that does not need it', () => {
    // The disclosure boundary, asserted on the model the property test runs on.
    // A caller whose parent is visible must never receive the id of an
    // invisible ancestor — that is proof a channel they cannot see exists.
    const projected = project(full, new Set(['rsa', 'fort']));
    const fort = projected.find(r => r.id === 'fort')!;
    expect(fort.parent_id).toBe('rsa');
    expect(fort.parent_hidden).toBe(false);
    expect(fort.root_id).toBeNull();
    // …and one hop out: parent hidden, but an ancestor IS visible.
    const nested = project(full, new Set(['sasfa', 'fort'])).find(r => r.id === 'fort')!;
    expect(nested.visible_ancestor_id).toBe('sasfa');
    expect(nested.root_id).toBeNull();
  });

  it('an orphan whose ancestor IS visible nests instead of bucketing', () => {
    const projected = project(full, new Set(['sasfa', 'fort']));
    const fort = projected.find(r => r.id === 'fort')!;
    expect(placeRow(fort)).toEqual({kind: 'orphanUnderAncestor', ancestorId: 'sasfa'});
    expect(childrenOf(projected, 'sasfa').map(r => r.id)).toEqual(['fort']);
  });
});

/**
 * B-624 (client, 2026-08-22) — "Different organization channels must never mix…
 * It must ALWAYS be separate here."
 *
 * The screenshot that opened this: Service Providers + ABC Security (Jacques'
 * org) and BAG (the caller's own workspace) in ONE flat list, because the org
 * scope is fail-open and the tree stage never read `org_id` at all.
 */
describe('orgSectionsOf — organisations never mix (B-624)', () => {
  const row = (id: string, org_id?: string): TreeRow => ({
    id, name: id, parent_id: null, parent_hidden: false, visible_ancestor_id: null,
    ...(org_id === undefined ? {} : {org_id}),
  });

  it('two organisations produce two sections, in FIRST-SEEN order', () => {
    // Interleaved on purpose: "first seen" is not "first contiguous block", and
    // a grouping that keyed off the first RUN would order these B, A.
    const rows = [row('sp', 'A'), row('bag', 'B'), row('abc', 'A')];
    const sections = orgSectionsOf(rows);
    expect(sections.map(s => s.orgId)).toEqual(['A', 'B']);
    expect(sections.map(s => s.rows.map(r => r.id))).toEqual([['sp', 'abc'], ['bag']]);
  });

  it('order is stable across a refetch that returns the same rows', () => {
    // The list must not reshuffle under the user between focus refetches.
    const rows = [row('sp', 'A'), row('bag', 'B'), row('abc', 'A')];
    expect(orgSectionsOf(rows).map(s => s.orgId))
      .toEqual(orgSectionsOf([...rows]).map(s => s.orgId));
  });

  it('ONE organisation ⇒ exactly one section, and the input array itself', () => {
    // The single-tenant case is the common one and must be untouched — visually
    // (the screen renders no header for one section) and referentially (these
    // rows feed useMemo chains; a fresh array every render defeats them).
    const rows = [row('a', 'A'), row('b', 'A')];
    const sections = orgSectionsOf(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0].orgId).toBe('A');
    expect(sections[0].rows).toBe(rows);
  });

  it('an OLD SERVER (no org_id anywhere) keeps every row in one null section', () => {
    // Fail OPEN. A grouping stage that dropped un-attributed rows would empty
    // the whole screen against a server that predates the field.
    const rows = [row('a'), row('b'), row('c')];
    const sections = orgSectionsOf(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0].orgId).toBeNull();
    expect(sections[0].rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('MIXED rows — every input row appears in exactly one section', () => {
    // Totality, count-checked. A rolling deploy can genuinely serve both
    // shapes, and "at least once" is not enough: a row emitted twice would
    // render twice.
    const rows = [
      row('sp', 'A'), row('legacy1'), row('bag', 'B'),
      row('abc', 'A'), row('legacy2'), row('solo', 'C'),
    ];
    const sections = orgSectionsOf(rows);
    expect(sections.map(s => s.orgId)).toEqual(['A', null, 'B', 'C']);
    const emitted = sections.flatMap(s => s.rows.map(r => r.id));
    expect(emitted).toHaveLength(rows.length);
    expect([...emitted].sort()).toEqual([...rows.map(r => r.id)].sort());
    expect(new Set(emitted).size).toBe(rows.length);
  });

  it('an empty list is an empty section list, not a section of nothing', () => {
    expect(orgSectionsOf([])).toEqual([]);
  });

  it('splitting never orphans a child from its parent', () => {
    // Cross-tenant parentage does not exist (the server refuses
    // `parent_channel_in_other_org`), so a section always carries whole trees.
    const rows: TreeRow[] = [
      {...row('sasfa', 'A')},
      {...row('rsa', 'A'), parent_id: 'sasfa'},
      {...row('bag', 'B')},
    ];
    const [a, b] = orgSectionsOf(rows);
    expect(childrenOf(a.rows, 'sasfa').map(r => r.id)).toEqual(['rsa']);
    expect(organisationRootsOf(a.rows).map(r => r.id)).toEqual(['sasfa']);
    expect(organisationRootsOf(b.rows).map(r => r.id)).toEqual(['bag']);
  });
});

/**
 * B-625 (client, 2026-08-22) — "Can you add a search bar for channels also, to
 * find channels very quickly."
 *
 * The list is a TREE, which is what makes this more than a `.filter()`: a hit
 * that loses its chain is a detached row, and a hit that loses its own subtree
 * silently changes how it is DRAWN (see `filterTreeRows`).
 */
describe('filterTreeRows — search keeps the tree a tree (B-625)', () => {
  //  SASFA ─ RSA ─ Fort Hunter
  //        └ Kenya
  //  Solo Team          (a parentless leaf)
  const rows: TreeRow[] = [
    {id: 'sasfa', name: 'SASFA', parent_id: null, parent_hidden: false, visible_ancestor_id: null},
    {id: 'rsa', name: 'RSA', parent_id: 'sasfa', parent_hidden: false, visible_ancestor_id: null},
    {id: 'fort', name: 'Fort Hunter', parent_id: 'rsa', parent_hidden: false, visible_ancestor_id: null},
    {id: 'kenya', name: 'Kenya', parent_id: 'sasfa', parent_hidden: false, visible_ancestor_id: null},
    {id: 'solo', name: 'Solo Team', parent_id: null, parent_hidden: false, visible_ancestor_id: null},
  ];

  it('matches on the channel NAME', () => {
    expect(filterTreeRows(rows, 'Kenya').map(r => r.id)).toEqual(['sasfa', 'kenya']);
  });

  it('is CASE-INSENSITIVE and ignores surrounding space', () => {
    expect(filterTreeRows(rows, '  kEnYa ').map(r => r.id)).toEqual(['sasfa', 'kenya']);
    expect(channelMatchesQuery({name: 'Fort Hunter'}, 'HUNT')).toBe(true);
  });

  it('matches a SUBSTRING, not just a prefix', () => {
    expect(filterTreeRows(rows, 'hunter').map(r => r.id)).toEqual(['sasfa', 'rsa', 'fort']);
  });

  it('KEEPS THE ANCESTORS of a deep match, so the hit is still reachable', () => {
    // Without the chain, 'fort' is STRANDED: its host is missing from the list,
    // so it renders detached at depth 0 with nothing saying where it lives.
    const kept = filterTreeRows(rows, 'Fort');
    expect(kept.map(r => r.id)).toEqual(['sasfa', 'rsa', 'fort']);
    // And the tree really re-forms: parents before children, no orphan.
    const nodes = buildChannelTree(kept);
    expect(nodes.map(n => n.row.id)).toEqual(['sasfa', 'rsa', 'fort']);
    expect(nodes.map(n => n.depth)).toEqual([0, 1, 2]);
    expect(childrenOf(kept, 'rsa').map(r => r.id)).toEqual(['fort']);
  });

  it('KEEPS THE SUBTREE of a match, so it is drawn exactly as it is unfiltered', () => {
    // `directoryBuckets` collapses a CHILDLESS root into the `chats` bucket, so
    // dropping the children would redraw SASFA as a neutral card with no level
    // pill — purely because you typed its name.
    const kept = filterTreeRows(rows, 'SASFA');
    expect(kept.map(r => r.id)).toEqual(['sasfa', 'rsa', 'fort', 'kenya']);
    const before = buildChannelTree(rows).find(n => n.row.id === 'sasfa');
    const after = buildChannelTree(kept).find(n => n.row.id === 'sasfa');
    expect(after).toEqual(before);
  });

  it('DROPS a branch with no match anywhere in it', () => {
    const kept = filterTreeRows(rows, 'Kenya').map(r => r.id);
    expect(kept).not.toContain('rsa');
    expect(kept).not.toContain('fort');
    expect(kept).not.toContain('solo');
  });

  it('an EMPTY query is the IDENTITY — same rows, same order, same array', () => {
    expect(filterTreeRows(rows, '')).toBe(rows);
    expect(filterTreeRows(rows, '   ')).toBe(rows);
    expect(channelMatchesQuery({name: 'anything'}, '')).toBe(true);
  });

  it('NO MATCH is an empty list, so the caller can render an honest empty state', () => {
    expect(filterTreeRows(rows, 'zzz-nothing')).toEqual([]);
  });

  it('never emits a row twice when a parent AND its child both match', () => {
    // 'S' hits SASFA, RSA and Solo Team; the ancestor and subtree sweeps then
    // both claim the same rows.
    const kept = filterTreeRows(rows, 'S');
    expect(new Set(kept.map(r => r.id)).size).toBe(kept.length);
    expect(kept.map(r => r.id)).toEqual(['sasfa', 'rsa', 'fort', 'kenya', 'solo']);
  });

  it('keeps input ORDER, so results do not reshuffle as you type', () => {
    expect(filterTreeRows(rows, 'a').map(r => r.id))
      .toEqual(rows.filter(r => filterTreeRows(rows, 'a').some(k => k.id === r.id)).map(r => r.id));
  });
});

/**
 * B-625 — the channel search. Tree-shaped, so the interesting cases are all
 * about what happens to a match's ANCESTORS.
 */
describe('filterTreeRows — searching a TREE, not a list', () => {
  const rows: TreeRow[] = [
    {id: 'org', name: 'Service Providers'},
    {id: 'mv', name: 'Movement', parent_id: 'org'},
    {id: 'road', name: 'Road movement', parent_id: 'mv'},
    {id: 'air', name: 'Air movement', parent_id: 'mv'},
    {id: 'it', name: 'IT', parent_id: 'org'},
    {id: 'acc', name: 'Access control', parent_id: 'it'},
  ];
  const ids = (out: TreeRow[]) => out.map(r => r.id);

  it('keeps a match AND every ancestor, so the match is still reachable', () => {
    // "Access control" hangs off IT, which hangs off Service Providers. Drop
    // either and the match is in the list but in no tree — no door.
    expect(ids(filterTreeRows(rows, 'access'))).toEqual(['org', 'it', 'acc']);
  });

  it('drops branches with no match in them', () => {
    // The Movement subtree is untouched by an "access" query.
    const out = ids(filterTreeRows(rows, 'access'));
    for (const gone of ['mv', 'road', 'air']) {expect(out).not.toContain(gone);}
  });

  it('is case-insensitive and matches on a substring', () => {
    expect(ids(filterTreeRows(rows, 'MOVEMENT'))).toEqual(['org', 'mv', 'road', 'air']);
    expect(ids(filterTreeRows(rows, 'ovemen'))).toEqual(['org', 'mv', 'road', 'air']);
  });

  it('a matching PARENT keeps its whole subtree — dropping it would RE-CLASSIFY the row', () => {
    // Not cosmetic. The member directory calls `directoryBuckets` with
    // `collapseChildless: true`, so an organisation whose children were filtered
    // away stops being an organisation and collapses into the `chats` bucket —
    // the same row, redrawn as a neutral card with no level pill and no colour,
    // purely because you typed its name. Keeping the subtree makes every
    // surviving row render exactly as it does unfiltered.
    expect(ids(filterTreeRows(rows, 'IT'))).toEqual(['org', 'it', 'acc']);
  });

  it('an empty or blank query is the IDENTITY — same array, so nothing downstream recomputes', () => {
    expect(filterTreeRows(rows, '')).toBe(rows);
    expect(filterTreeRows(rows, '   ')).toBe(rows);
  });

  it('no match yields no rows (the caller shows an honest empty state)', () => {
    expect(filterTreeRows(rows, 'zzzz')).toEqual([]);
  });

  it('preserves input order, which the section split and the tree build rely on', () => {
    expect(ids(filterTreeRows(rows, 'o'))).toEqual(
      ids(rows.filter(r => ids(filterTreeRows(rows, 'o')).includes(r.id))));
  });
});

describe('expandedIdsForQuery — a match inside a collapsed parent is no result', () => {
  it('expands every row that has a child in the filtered set', () => {
    const filtered = filterTreeRows([
      {id: 'org', name: 'Service Providers'},
      {id: 'it', name: 'IT', parent_id: 'org'},
      {id: 'acc', name: 'Access control', parent_id: 'it'},
    ], 'access');
    expect([...expandedIdsForQuery(filtered)].sort()).toEqual(['it', 'org']);
  });

  it('a flat result expands nothing', () => {
    expect([...expandedIdsForQuery([{id: 'a', name: 'A'}])]).toEqual([]);
  });
});
