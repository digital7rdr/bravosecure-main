/**
 * Channels vs2 item 2 (P2-d) — path-scoped accept-time seeding.
 *
 * Accepting an invite used to seed EVERY eligible channel in the workspace,
 * discarding the team the admin picked. These cases pin the replacement: the
 * chain down to the team, the team's subtree, the broadcasts those cover, and
 * the fallback when the team no longer survives.
 *
 * The rule is a pure function precisely so it can be tested here. No unit test
 * in this project executes SQL, and a graph rule expressed in SQL would have
 * been asserted only as query TEXT — which is exactly how a live defect shipped
 * past a green suite two weeks ago.
 */
import {resolveSeedScope, type SeedCandidate} from './seed-path';

const ch = (
  id: string, parent_id: string | null, over: Partial<SeedCandidate> = {},
): SeedCandidate => ({
  id, parent_id, access: 'standard', channel_type: 'department',
  is_broadcast: false, ...over,
});

/**
 *  SASFA
 *   ├─ RSA
 *   │   ├─ Fort Hunter
 *   │   │   └─ Alpha Squad
 *   │   └─ Fort Bravo
 *   └─ Kenya
 *       └─ Nairobi
 *  CORTAC          (a second organisation)
 */
const TREE: SeedCandidate[] = [
  ch('sasfa', null), ch('rsa', 'sasfa'), ch('fort', 'rsa'), ch('squad', 'fort'),
  ch('bravo', 'rsa'), ch('kenya', 'sasfa'), ch('nairobi', 'kenya'),
  ch('cortac', null),
];

const idsOf = (s: ReturnType<typeof resolveSeedScope>) =>
  s.kind === 'scoped' ? [...s.ids].sort() : s.kind;

describe('resolveSeedScope — the happy path', () => {
  it('no team named at mint still seeds org-wide', () => {
    // The ONE case where org-wide is what the admin actually asked for.
    expect(resolveSeedScope(TREE, null).kind).toBe('orgWide');
  });

  it('a mid-tree team seeds its CHAIN and its SUBTREE, and nothing sideways', () => {
    const s = resolveSeedScope(TREE, 'fort');
    expect(idsOf(s)).toEqual(['fort', 'rsa', 'sasfa', 'squad']);
    // The sibling fort and the whole other branch are NOT granted — this is the
    // over-grant the change exists to stop.
    expect(idsOf(s)).not.toContain('bravo');
    expect(idsOf(s)).not.toContain('kenya');
    expect(idsOf(s)).not.toContain('cortac');
  });

  it('an organisation ROOT seeds that whole organisation, but not its peer', () => {
    const s = resolveSeedScope(TREE, 'sasfa');
    expect(idsOf(s)).toEqual(
      ['bravo', 'fort', 'kenya', 'nairobi', 'rsa', 'sasfa', 'squad']);
    expect(idsOf(s)).not.toContain('cortac');
  });

  it('a leaf seeds only its own chain', () => {
    expect(idsOf(resolveSeedScope(TREE, 'squad')))
      .toEqual(['fort', 'rsa', 'sasfa', 'squad']);
  });
});

describe('#broadcast is LEVEL-scoped, so every scope gets all of them', () => {
  /**
   * FLIPPED DELIBERATELY, per the bug-regression contract. The previous rule
   * here was "a broadcast rides along only where its own ancestor chain is
   * covered", and the previous version of the middle test asserted the exact
   * opposite of what it asserts now.
   *
   * That rule read as the careful choice — don't hand someone a channel hanging
   * off a parent they cannot navigate to — and was measurably wrong. There is
   * exactly ONE broadcast per LEVEL for the whole organisation (the unique
   * index is on `(org_id, level)`), and `ensureBroadcastForLevel` parents it
   * under whichever node happened to create the first channel at that level.
   * That parent is an accident of creation order, not a statement about
   * audience. Under the chain rule, two members at the same level in the same
   * org received DIFFERENT announcement channels depending on which branch was
   * built first — so half the organisation silently stopped receiving org-wide
   * announcements.
   *
   * Missing announcements is a far worse failure than seeing a channel whose
   * parent is not navigable, and the renderer already has a case for the
   * latter (the neutral "(not shown)" rung).
   */
  it('includes a broadcast parented inside the seeded set', () => {
    const rows = [...TREE, ch('bcast-rsa', 'rsa', {is_broadcast: true})];
    expect(idsOf(resolveSeedScope(rows, 'fort'))).toContain('bcast-rsa');
  });

  it('ALSO includes one parented on a branch the member is not in', () => {
    const rows = [...TREE, ch('bcast-kenya', 'kenya', {is_broadcast: true})];
    expect(idsOf(resolveSeedScope(rows, 'fort'))).toContain('bcast-kenya');
  });

  it('two members on different branches get the SAME announcement channels', () => {
    // The property that actually matters, and the one the chain rule broke.
    const rows = [...TREE,
      ch('b1', null, {is_broadcast: true}), ch('b2', 'rsa', {is_broadcast: true})];
    const a = (idsOf(resolveSeedScope(rows, 'fort')) as string[]).filter(i => i.startsWith('b'));
    const b = (idsOf(resolveSeedScope(rows, 'nairobi')) as string[]).filter(i => i.startsWith('b'));
    expect(a).toEqual(b);
  });

  it('a parentless broadcast belongs to the workspace and is always included', () => {
    const rows = [...TREE, ch('bcast-top', null, {is_broadcast: true})];
    expect(idsOf(resolveSeedScope(rows, 'fort'))).toContain('bcast-top');
  });

  it('an ARCHIVED broadcast is not seeded — it is in nobody\'s list', () => {
    const rows = [...TREE, ch('bcast-dead', null, {is_broadcast: true, archived: true})];
    expect(idsOf(resolveSeedScope(rows, 'fort'))).not.toContain('bcast-dead');
  });
});

describe('archived rows are walk SCAFFOLDING — traversable, never seeded', () => {
  it('climbs THROUGH an archived rung to a live grandparent', () => {
    // Two ordinary admin taps reach this: archive the leaf team, then archive
    // its now-childless parent. Filtering archived rows out of the input made
    // that ancestor untraversable rather than merely unseedable, so the walk
    // hit undefined, stopped, and reported a dead chain while SASFA sat live
    // directly above it — refusing an accept that should have succeeded.
    const rows = TREE.map(r =>
      ['fort', 'rsa'].includes(r.id) ? {...r, archived: true} : r);
    const s = resolveSeedScope(rows, 'fort');
    expect(idsOf(s)).toEqual(['sasfa']);
    expect(s.kind === 'scoped' && s.fellBackTo).toBe('sasfa');
  });

  it('never seeds the archived rung itself', () => {
    const rows = TREE.map(r => (r.id === 'rsa' ? {...r, archived: true} : r));
    expect(idsOf(resolveSeedScope(rows, 'fort'))).not.toContain('rsa');
  });

  it('an archived DESCENDANT is not granted', () => {
    const rows = TREE.map(r => (r.id === 'squad' ? {...r, archived: true} : r));
    expect(idsOf(resolveSeedScope(rows, 'fort'))).not.toContain('squad');
  });
});

describe('a MANAGER invite is judged by the manager rule', () => {
  it('a fully restricted chain is NOT dead for a manager', () => {
    // seedApprovedMemberChannels seeds managers-only channels for a manager
    // invite, so judging the chain by the EMPLOYEE rule refused the accept for
    // exactly the channels the seeder would have placed them in.
    const rows = TREE.map(r =>
      ['fort', 'rsa', 'sasfa'].includes(r.id) ? {...r, access: 'restricted' as const} : r);
    expect(resolveSeedScope(rows, 'fort', null, false).kind).toBe('dead');
    expect(resolveSeedScope(rows, 'fort', null, true).kind).toBe('scoped');
  });
});

describe('the fallback — the trigger is SURVIVAL, not just archived-or-missing', () => {
  it('a deleted team arrives as teamId NULL — the breadcrumb must still fire', () => {
    /**
     * THE CASE THE BREADCRUMB EXISTS FOR, and the one an early
     * `if (!teamId) return orgWide` silently swallows.
     *
     * `team_channel_id` is ON DELETE SET NULL, so once the team row is gone the
     * invite presents as teamId === null — indistinguishable from "no team was
     * ever chosen" unless the parent is consulted. Getting this wrong means the
     * column is written at mint, read at accept, and changes nothing: every
     * deleted team quietly becomes a whole-workspace grant.
     */
    const s = resolveSeedScope(TREE, null, 'rsa');
    expect(s.kind).toBe('scoped');
    expect(idsOf(s)).toEqual(['rsa', 'sasfa']);
  });

  it('a DELETED team falls back to the mint-time parent breadcrumb', () => {
    // team_channel_id is ON DELETE SET NULL and deleting a leaf is allowed, so
    // without the breadcrumb this is byte-identical to "no team" and quietly
    // becomes an org-wide grant — the scoped-to-cross-branch promotion arriving
    // through the delete door.
    const s = resolveSeedScope(TREE, 'deleted-id', 'rsa');
    expect(idsOf(s)).toEqual(['rsa', 'sasfa']);
    expect(s.kind === 'scoped' && s.fellBackTo).toBe('rsa');
  });

  it('a deleted team with NO breadcrumb is dead, not org-wide', () => {
    // Pre-migration invites have no breadcrumb. Refusing is the safe reading:
    // silently widening the grant is the failure this whole path prevents.
    expect(resolveSeedScope(TREE, 'deleted-id', null).kind).toBe('dead');
  });

  it('a team TIGHTENED to restricted after mint falls back — it is not seedable', () => {
    // configureChannel can tighten AFTER the invite is minted, and mintability
    // is only checked at mint. Without survival as the trigger the fallback
    // never fires and the seed loop simply skips the team, so the member gets
    // ancestors but not the team they were invited to.
    const rows = TREE.map(r => (r.id === 'fort' ? {...r, access: 'restricted' as const} : r));
    const s = resolveSeedScope(rows, 'fort');
    expect(idsOf(s)).toEqual(['rsa', 'sasfa']);
    expect(idsOf(s)).not.toContain('squad');
  });

  it('an INCIDENT team falls back too — seedsManagersOnly covers both', () => {
    const rows = TREE.map(r => (r.id === 'fort' ? {...r, channel_type: 'incident' as const} : r));
    expect(idsOf(resolveSeedScope(rows, 'fort'))).toEqual(['rsa', 'sasfa']);
  });

  it('the fallback seeds the ancestor CHAIN, never the ancestor\'s subtree', () => {
    // Substituting the ancestor as "the team" would grant Fort Bravo and
    // Nairobi — teams the invite never expressed.
    const rows = TREE.map(r => (r.id === 'fort' ? {...r, access: 'restricted' as const} : r));
    const s = resolveSeedScope(rows, 'fort');
    expect(idsOf(s)).not.toContain('bravo');
    expect(idsOf(s)).not.toContain('nairobi');
  });

  it('the walk CLIMBS PAST a managers-only rung rather than stopping on it', () => {
    // Stopping at a restricted ancestor hands back a chain the seed loop then
    // skips entirely — the employee lands in a zero-channel workspace with no
    // error and no log, which is the state this fallback exists to prevent.
    const rows = TREE.map(r =>
      r.id === 'fort' ? {...r, access: 'restricted' as const}
        : r.id === 'rsa' ? {...r, access: 'restricted' as const} : r);
    const s = resolveSeedScope(rows, 'fort');
    expect(idsOf(s)).toEqual(['sasfa']);
    expect(s.kind === 'scoped' && s.fellBackTo).toBe('sasfa');
  });

  it('a whole dead chain REFUSES rather than seeding nothing', () => {
    // The caller turns this into a pre-claim rollback, so the invite survives
    // for a re-issue instead of being consumed on a join that granted nothing.
    const rows = TREE.map(r =>
      ['fort', 'rsa', 'sasfa'].includes(r.id) ? {...r, access: 'restricted' as const} : r);
    expect(resolveSeedScope(rows, 'fort').kind).toBe('dead');
  });

  it('an ARCHIVED team falls back — archived rows are absent from the input', () => {
    // The caller filters archived_at IS NULL, so an archived team simply is not
    // in `rows`; the breadcrumb is what still resolves the chain.
    const rows = TREE.filter(r => r.id !== 'fort');
    expect(idsOf(resolveSeedScope(rows, 'fort', 'rsa'))).toEqual(['rsa', 'sasfa']);
  });
});

describe('degenerate shapes', () => {
  it('an empty org with a named team is dead, not org-wide', () => {
    expect(resolveSeedScope([], 'anything', null).kind).toBe('dead');
  });

  it('a lone root team seeds exactly itself', () => {
    expect(idsOf(resolveSeedScope([ch('solo', null)], 'solo'))).toEqual(['solo']);
  });

  it('a cycle cannot hang the accept path', () => {
    // Unreachable through the DB (re-parenting is refused by a trigger) but an
    // unbounded walk here would hang a request, not merely mis-render.
    const cyc = [ch('a', 'b'), ch('b', 'a')];
    const s = resolveSeedScope(cyc, 'a');
    expect(s.kind).toBe('scoped');
    expect((idsOf(s) as string[]).length).toBeLessThanOrEqual(2);
  });

  it('the returned set is never shared between calls', () => {
    const a = resolveSeedScope(TREE, 'fort');
    const b = resolveSeedScope(TREE, 'kenya');
    expect(idsOf(a)).not.toEqual(idsOf(b));
  });
});
