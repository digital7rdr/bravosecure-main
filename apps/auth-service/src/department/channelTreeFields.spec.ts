/**
 * Channels vs2 item 2 — the three fields that make `parent_id: null`
 * unambiguous, plus `mintable_by_me`.
 *
 * WHY THESE ASSERT THE EMITTED VALUE, NOT THE TYPE.
 *
 * `listChannels` fills ChannelSummary through a raw `db.q<T>` cast, so adding a
 * field to the interface WITHOUT the SQL column typechecks perfectly and yields
 * `undefined` on every row at runtime. A test that only reads the type would be
 * green against a server that emits nothing — and the client's compat fallback
 * treats "absent" as "old server", so the whole tree would silently degrade to
 * a flat pile.
 *
 * SCOPE OF THIS FILE, stated honestly: the DB is MOCKED here, so everything
 * below is a claim about the SQL TEXT, not about what Postgres returns. It can
 * prove a column is projected and cannot prove the walk picks the right
 * ancestor. The semantics are covered by `test/integration/channelTree.itest.ts`
 * against a real Postgres — run it (`npm run test:integration`, needs Docker)
 * before trusting any change to this query.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};
const ORG = 'org-1';

describe('vs2 item 2 — tree fields on the two channel sources', () => {
  let svc: DepartmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(DepartmentService);
  });

  /**
   * The SELECT actually sent for the member-facing list, WITH ITS SQL COMMENTS
   * STRIPPED.
   *
   * Not optional hygiene: this query is HEAVILY commented, and its comments
   * discuss archiving, recursion and disclosure — the exact vocabulary the
   * absence assertions below search for. An earlier revision of this file did
   * fail on its own prose. Comment-satisfies-assertion is this repo's single
   * most common false scan result, in both directions.
   */
  async function memberSql(): Promise<string> {
    await svc.listChannels('u1');
    return String(mockDb.q.mock.calls[0][0])
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n');
  }

  describe('listChannels (member view) EMITS all three', () => {
    it('emits parent_hidden, visible_ancestor_id and root_id as columns', async () => {
      const sql = await memberSql();
      expect(sql).toMatch(/\)\s*AS parent_hidden/);
      expect(sql).toMatch(/END AS visible_ancestor_id/);
      expect(sql).toMatch(/AS root_id/);
    });

    it('the mask, parent_hidden and the walk ask ONE shared question', async () => {
      // If these disagree the client is told "you have a hidden parent" while
      // parent_id is populated (or the reverse) and the row renders both nested
      // and orphaned. They used to be three separately-spelled copies of the
      // same predicate in one query; now there is one, in a LATERAL.
      const sql = await memberSql();
      expect(sql).toMatch(/CASE WHEN av\.v1 THEN c\.parent_id ELSE NULL END AS parent_id/);
      expect(sql).toMatch(/\(c\.parent_id IS NOT NULL AND NOT av\.v1\) AS parent_hidden/);
      // Exactly one membership lookup per ancestor hop — FOUR, not eight.
      // (Item 04 raised the walk from three hops to four: a LATERAL inherits its
      // parent level instead of incrementing, so a row can sit four hops from its
      // root. The count moves WITH the walk; it is not relaxed.)
      expect((sql.match(/FROM public\.department_channel_members pm/g) ?? []).length).toBe(4);
    });

    it('reachability folds archive AND membership together, per hop', async () => {
      // An ancestor that is archived is not reachable even if the caller is a
      // member: the row list is filtered to archived_at IS NULL, so pointing at
      // it names a row the caller never receives.
      const sql = await memberSql();
      const av = sql.slice(sql.indexOf('LEFT JOIN LATERAL ('), sql.indexOf(') av ON TRUE'));
      for (const a of ['a1', 'a2', 'a3', 'a4']) {
        expect(av).toMatch(new RegExp(`${a}\\.archived_at IS NULL AND EXISTS`));
        expect(av).toMatch(new RegExp(`pm\\.channel_id = ${a}\\.id AND pm\\.user_id = \\$1`));
      }
    });

    it('the ancestor walk is bounded to FOUR hops — no recursion', async () => {
      /**
       * WHY FOUR (item 04). It was three, justified by "level is CHECKed 0..3, so
       * three ancestors is the whole tree". A LATERAL falsifies that: it inherits
       * its parent level rather than incrementing, so
       * L1(0) -> L2(1) -> L3(2) -> L4(3) -> lateral(3) is FOUR hops from the root.
       *
       * Four is the true bound, not a guess: roots are capped at level 0/1, every
       * STRUCTURAL hop increments a level CHECKed <= 3, and dept_channel_set_level
       * forces a lateral to be a LEAF — so at most ONE non-incrementing hop can
       * exist in any chain. If the leaf rule is relaxed, or agency laterals ship,
       * or the tree is re-levelled, this must grow again — and the failure is
       * SILENT (synthetic orphan + duplicate render), which is why it is pinned.
       */
      const sql = await memberSql();
      expect(sql).toMatch(/LEFT JOIN public\.department_channels a1 ON a1\.id = c\.parent_id/);
      expect(sql).toMatch(/LEFT JOIN public\.department_channels a2 ON a2\.id = a1\.parent_id/);
      expect(sql).toMatch(/LEFT JOIN public\.department_channels a3 ON a3\.id = a2\.parent_id/);
      expect(sql).toMatch(/LEFT JOIN public\.department_channels a4 ON a4\.id = a3\.parent_id/);
      expect(sql).not.toMatch(/WITH RECURSIVE/i);
    });

    it('root_id is GATED to the one case that consumes it', async () => {
      // A DISCLOSURE BOUNDARY, not an optimisation. Emitted unconditionally it
      // hands the uuid of an invisible ancestor to a caller whose parent is
      // perfectly visible — the same leak the parent_id mask exists to close,
      // one hop up. It may only appear where the parent is hidden AND no
      // ancestor is visible.
      const sql = await memberSql();
      const rootExpr = sql.slice(sql.indexOf('CASE WHEN tf.visible_ancestor_id IS NULL'),
        sql.indexOf('AS root_id') + 10);
      expect(rootExpr).toMatch(/tf\.visible_ancestor_id IS NULL/);
      expect(rootExpr).toMatch(/NOT av\.v1/);
      // a4 FIRST — root_id must be the TOPMOST ancestor. The order is SILENT if
      // wrong: it would return a mid-tree node as the synthetic group key and
      // split one hidden-rooted group into several that each claim to be a root.
      expect(rootExpr).toMatch(/COALESCE\(a4\.id, a3\.id, a2\.id, a1\.id\)/);
    });

    it('root_id is NOT archive-filtered — pinned by COUNTING, not by a slice', async () => {
      /**
       * Two slice-based anchors have already been defeated here, each from one
       * clause further out: the first started AT the COALESCE (so a filter
       * written just before it escaped), the second covered the projection (so
       * a filter added in the `av` LATERAL or an `ON` clause escaped). A slice
       * can always be stepped around, because the property is "nowhere in this
       * query does an archive test reach root_id" — which is a statement about
       * the WHOLE query, not a region of it.
       *
       * So: count. Any new `archived_at` anywhere forces someone to look at
       * this test and decide, which is the actual goal.
       */
      const sql = await memberSql();
      const hits = sql.match(/archived_at/g) ?? [];
      expect(hits.length).toBe(5);
      // …and the five are the ones we intend: FOUR reachability hops plus the
      // row filter. Naming them is what makes the count readable when it fails.
      const av = sql.slice(sql.indexOf('LEFT JOIN LATERAL ('), sql.indexOf(') av ON TRUE'));
      expect((av.match(/archived_at/g) ?? []).length).toBe(4);
      expect(sql).toMatch(/WHERE m\.user_id = \$1 AND c\.archived_at IS NULL/);
      // The root_id projection itself carries none.
      const span = sql.slice(sql.indexOf('tf.visible_ancestor_id,'), sql.indexOf('AS root_id'));
      expect(span).not.toMatch(/archived_at/);
    });

    it('the walk prefers the NEAREST visible ancestor', async () => {
      const sql = await memberSql();
      const walk = sql.slice(sql.indexOf('WHEN c.parent_id IS NULL'), sql.indexOf('END AS visible_ancestor_id'));
      expect(walk.indexOf('a1.id')).toBeLessThan(walk.indexOf('a2.id'));
      expect(walk.indexOf('a2.id')).toBeLessThan(walk.indexOf('a3.id'));
      expect(walk.indexOf('a3.id')).toBeLessThan(walk.indexOf('a4.id'));
    });

    it('ORDER BY level ASC comes first — now a CORRECTNESS property, not a nicety', async () => {
      // With the tree fields, a client resolves parent_id / visible_ancestor_id
      // against rows it has already received. Level-ascending order is what
      // guarantees an ancestor lands on an EARLIER page than its descendant, so
      // a paged directory can still build the tree. Reordering this silently
      // breaks multi-page workspaces only.
      const sql = await memberSql();
      const order = sql.slice(sql.indexOf('ORDER BY'));
      expect(order).toMatch(/^ORDER BY c\.level ASC/);
    });
  });

  describe('listOrgChannels (admin view)', () => {
    const chan = (over: Record<string, unknown> = {}) => ({
      id: 'c1', name: 'Fort Hunter', department: null, description: null,
      channel_type: 'department', access: 'standard', org_id: ORG, parent_id: 'p1', level: 2,
      post_mode: 'open', is_broadcast: false, member_count: 1,
      provisioned: true, archived: false, created_at: 'now', ...over,
    });

    /**
     * vs2 edge A3 — the response states WHICH KIND OF ORG it is about.
     *
     * The client's own predicate is a USER-level fact (true for anybody with
     * any workspace affiliation), so the dual persona — an agency manager who
     * has also joined a workspace — got the workspace-shaped UI on their
     * AGENCY, and that UI drops the DEPARTMENT field: new agency channels were
     * created branchless, invisible to every scoped read.
     */
    describe('workspace_tenant (edge A3)', () => {
      it('can_grant_manager is FALSE for a BRANCH-SCOPED minter (edge A8)', async () => {
      // The role radio offered Manager and refused only at submit
      // (scoped_manager_cannot_grant_admin) — honest, but after the work. This
      // is a per-MINTER fact, which is why it cannot ride the per-ROW
      // mintable_by_me (plan G10 records exactly that).
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([]);
      expect((await svc.listOrgChannels(ORG, 'RSA', ORG)).can_grant_manager).toBe(false);
    });

    it('can_grant_manager is TRUE for an UNSCOPED minter', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([]);
      expect((await svc.listOrgChannels(ORG, null, ORG)).can_grant_manager).toBe(true);
    });

    it('mirrors the mint-time rule exactly — department != null is the whole test', async () => {
      // If these drift, the radio greys for someone the server would allow (or
      // the reverse), which is worse than not greying at all.
      const src: string = require('node:fs')
        .readFileSync(
          require('node:path').join(process.cwd(), 'src', 'department', 'enterprise-join.service.ts'),
          'utf8');
      expect(src).toMatch(/managerDepartment != null && role === 'manager'/);
    });

    it('reports FALSE for an agency org', async () => {
        mockDb.qOne.mockResolvedValueOnce(null);         // no org_workspaces row
        mockDb.q.mockResolvedValueOnce([chan()]);
        expect((await svc.listOrgChannels(ORG, null)).workspace_tenant).toBe(false);
      });

      it('reports TRUE for a workspace org', async () => {
        mockDb.qOne.mockResolvedValueOnce({n: 1});
        mockDb.q.mockResolvedValueOnce([chan()]);
        expect((await svc.listOrgChannels(ORG, null)).workspace_tenant).toBe(true);
      });

      it('answers even when the org has ZERO channels', async () => {
        // The reason it is a response field and not a row field: a clean P3
        // workspace has no rows at all, and that is precisely the tenant this
        // scope created. A per-row flag could never speak for it.
        mockDb.qOne.mockResolvedValueOnce({n: 1});
        mockDb.q.mockResolvedValueOnce([]);
        const out = await svc.listOrgChannels(ORG, null);
        expect(out.channels).toEqual([]);
        expect(out.workspace_tenant).toBe(true);
      });

      it('is the SAME resolution the mint refusal uses — one query, one answer', async () => {
        // Two lookups could disagree, and then the form shape and the server's
        // own minting rules would be deciding "workspace?" separately.
        mockDb.qOne.mockResolvedValueOnce({n: 1});
        mockDb.q.mockResolvedValueOnce([chan({department: null})]);
        const out = await svc.listOrgChannels(ORG, 'RSA');
        expect(out.workspace_tenant).toBe(true);
        // The item-7 relaxation (branchless = mintable by any manager) only
        // fires on the workspace tenant, so this agreeing is the observable.
        expect(out.channels[0].mintable_by_me).toBe(true);
        expect(mockDb.qOne).toHaveBeenCalledTimes(1);
      });

      it('the controller passes it through instead of re-wrapping the rows', async () => {
        // It used to return `{channels: await …}`; the fix returns the service
        // object whole. Re-wrapping would drop the field silently and the
        // client would fall back to the user-level flag — the original bug,
        // with a green server test.
        const ctrl = require('node:fs')
          .readFileSync(require('node:path').join(process.cwd(), 'src', 'department', 'department.controller.ts'), 'utf8')
          .replace(/\r\n/g, '\n');
        const body = ctrl.slice(ctrl.indexOf('async listManagedChannels('));
        expect(body.slice(0, 200)).toMatch(/return this\.dept\.listOrgChannels\(/);
        expect(body.slice(0, 200)).not.toMatch(/\{channels:/);
      });
    });

    it('emits parent_hidden FALSE and visible_ancestor_id NULL explicitly', async () => {
      // Not absent. Absent means "old server" to the client, which routes every
      // row to the Other-channels bucket — that would empty the admin
      // organisation list and dead-end the create flow on its first use.
      mockDb.q.mockResolvedValueOnce([chan()]);
      const [row] = (await svc.listOrgChannels(ORG, null)).channels;
      expect(row.parent_hidden).toBe(false);
      expect(row.visible_ancestor_id).toBeNull();
      expect('parent_hidden' in row).toBe(true);
      expect('visible_ancestor_id' in row).toBe(true);
    });

    it('an unscoped manager sees every ordinary channel as mintable', async () => {
      mockDb.q.mockResolvedValueOnce([chan({department: 'RSA'}), chan({id: 'c2', department: null})]);
      const rows = (await svc.listOrgChannels(ORG, null)).channels;
      expect(rows.map(r => r.mintable_by_me)).toEqual([true, true]);
    });

    it('a scoped manager sees only their own branch as mintable', async () => {
      mockDb.q.mockResolvedValueOnce([
        chan({id: 'in', department: 'RSA'}),
        chan({id: 'out', department: 'Kenya'}),
      ]);
      const rows = (await svc.listOrgChannels(ORG, 'RSA')).channels;
      expect(rows.find(r => r.id === 'in')?.mintable_by_me).toBe(true);
      expect(rows.find(r => r.id === 'out')?.mintable_by_me).toBe(false);
    });

    it('the predicate is fed the ROW\'s org, so the cross-org arm can fire here', async () => {
      // It used to be handed the CALLER's org, which made that arm unreachable
      // from this reader — equivalent today because the query filters on
      // org_id, but it meant the shared predicate was only half-exercised on
      // this path, and "equivalent today" is how two readers begin to drift.
      mockDb.q.mockResolvedValueOnce([chan({org_id: 'someone-else'})]);
      const [row] = (await svc.listOrgChannels(ORG, null)).channels;
      expect(row.mintable_by_me).toBe(false);
      expect(row.mint_refusal).toBe('team_channel_in_other_org');
    });

    it('emits WHY a row is not mintable, not just that it is not', async () => {
      // A boolean collapses five refusals into one bit, which left the client
      // guessing — and it guessed "outside your branch" at unscoped owners
      // looking at restricted channels.
      mockDb.q.mockResolvedValueOnce([
        chan({id: 'branch', department: 'Kenya'}),
        chan({id: 'locked', department: 'RSA', access: 'restricted'}),
        chan({id: 'fine', department: 'RSA'}),
      ]);
      const rows = (await svc.listOrgChannels(ORG, 'RSA')).channels;
      expect(rows.map(r => r.mint_refusal)).toEqual([
        'team_channel_outside_your_branch', 'team_channel_is_managers_only', null,
      ]);
    });

    it('archived and managers-only rows are NOT mintable, for anyone', async () => {
      mockDb.q.mockResolvedValueOnce([
        chan({id: 'arch', archived: true}),
        chan({id: 'restricted', access: 'restricted'}),
        chan({id: 'incident', channel_type: 'incident'}),
      ]);
      const rows = (await svc.listOrgChannels(ORG, null)).channels;
      expect(rows.map(r => r.mintable_by_me)).toEqual([false, false, false]);
    });

    it('the rows are otherwise untouched — this is a projection, not a filter', async () => {
      // Group first, disable second. Filtering un-mintable rows out here would
      // delete a restricted organisation root and promote its children to
      // top-level "organisations" — the flat pile item 2 exists to kill.
      mockDb.q.mockResolvedValueOnce([chan({id: 'restricted', access: 'restricted'})]);
      const rows = (await svc.listOrgChannels(ORG, null)).channels;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({id: 'restricted', parent_id: 'p1', level: 2, archived: false});
    });

    it('the TENANT is resolved for real, not assumed (item 7\'s gate)', async () => {
      /**
       * vs2 item 7 relaxes "a branchless channel is mintable by any manager"
       * for WORKSPACES only — agency orgs use typed departments for real branch
       * scope, so the relaxation must not reach them.
       *
       * Hardcoding `workspaceTenant = true` in this method survived the whole
       * suite until this case existed: the picker would have shown an agency's
       * branchless channels as mintable while the server refused them on
       * submit, which is exactly the greying/refusal disagreement the shared
       * predicate exists to prevent.
       */
      mockDb.qOne.mockResolvedValueOnce(null);          // NOT a workspace
      mockDb.q.mockResolvedValueOnce([chan({department: null})]);
      const [agencyRow] = (await svc.listOrgChannels(ORG, 'RSA')).channels;
      expect(agencyRow.mintable_by_me).toBe(false);
      expect(agencyRow.mint_refusal).toBe('team_channel_outside_your_branch');

      jest.clearAllMocks();
      mockDb.qOne.mockResolvedValueOnce({n: 1});        // IS a workspace
      mockDb.q.mockResolvedValueOnce([chan({department: null})]);
      const [wsRow] = (await svc.listOrgChannels(ORG, 'RSA')).channels;
      expect(wsRow.mintable_by_me).toBe(true);
      expect(wsRow.mint_refusal).toBeNull();
    });

    it('the manager branch reaches the service from the guard, not a default', async () => {
      // A controller that forgot the second argument would silently mark every
      // row mintable for a scoped manager — the greying would just stop working,
      // with no error anywhere.
      const ctrl = require('node:fs')
        .readFileSync(require('node:path').join(process.cwd(), 'src', 'department', 'department.controller.ts'), 'utf8')
        .replace(/\r\n/g, '\n');
      // vs2 edge A4 added a THIRD argument — the acting user — so each row can
      // say whether THEY may delete it. Same failure shape if it is forgotten:
      // `deletable` silently becomes false everywhere and the Delete door that
      // A4 exists to create disappears again, with no error anywhere.
      expect(ctrl).toMatch(
        /listOrgChannels\(manager\.org_user_id, manager\.department, manager\.user_id\)/);
    });
  });

  /**
   * vs2 edge A4 — Delete had no door on the manage path, and the server refused
   * the workspace OWNER on a channel a delegated manager created.
   *
   * The button and the enforcement must agree, or the fix is a button that
   * 403s. Both read `canDeleteChannel`.
   */
  describe('deletable (edge A4)', () => {
    const chan = (over: Record<string, unknown> = {}) => ({
      id: 'c1', name: 'Ops', department: null, description: null,
      channel_type: 'department', access: 'standard', org_id: ORG, created_by: 'mgr-1',
      has_children: false,
      parent_id: null, level: 1, post_mode: 'open', is_broadcast: false,
      member_count: 1, provisioned: true, archived: false, created_at: 'now', ...over,
    });

    it('is FALSE for a node with children — the FK RESTRICTs, archived ones too', async () => {
      // Without this the admin taps Delete on an apparent leaf (the tree hides
      // archived children) and is told it "still has channels inside it" that
      // are nowhere on screen — a button that always 409s.
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([chan({created_by: ORG, has_children: true})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(false);
    });

    it('an AGENCY #broadcast is deletable too — 20260826130000 dropped the trigger', async () => {
      // FLIPPED by the 2026-08-26 unification: the delete trigger the old
      // refusal deferred to is gone, and the legacy seeded broadcast is
      // exactly the row a service provider should be able to remove.
      mockDb.qOne.mockResolvedValueOnce(null);          // agency
      mockDb.q.mockResolvedValueOnce([chan({created_by: ORG, is_broadcast: true})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(true);
    });

    it('a WORKSPACE #broadcast stays deletable — that migration made it removable', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 1});        // workspace
      mockDb.q.mockResolvedValueOnce([chan({created_by: ORG, is_broadcast: true})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(true);
    });

    it('never ships the DECIDING columns to the client', async () => {
      // `created_by` and `has_children` exist to compute the flag. This file
      // already pins that class for `root_id`; a new column leaking is the same
      // mistake with a new name.
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([chan()]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect('created_by' in out.channels[0]).toBe(false);
      expect('has_children' in out.channels[0]).toBe(false);
    });

    it('the owner arm is keyed on the ROW\'s org, not the caller\'s', async () => {
      // The first draft inlined the rule and keyed it on `orgUserId`, so a row
      // belonging to another org rendered a Delete the server then 403s.
      // Unreachable only because the query filters org_id — "equivalent today"
      // is how the two readers start to drift.
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([chan({org_id: 'someone-else', created_by: 'mgr-1'})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(false);
    });

    it('the CREATOR may delete their own channel, on either tenant', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);                 // agency
      mockDb.q.mockResolvedValueOnce([chan({created_by: 'mgr-1'})]);
      const out = await svc.listOrgChannels(ORG, null, 'mgr-1');
      expect(out.channels[0].deletable).toBe(true);
    });

    it('the WORKSPACE OWNER may delete a channel a manager created', async () => {
      // The whole point of A4: the PDF asks for Delete on the manage flow, and
      // creator-only refused it to the one person who governs the org.
      mockDb.qOne.mockResolvedValueOnce({n: 1});               // workspace
      mockDb.q.mockResolvedValueOnce([chan({created_by: 'mgr-1'})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(true);
    });

    it('an AGENCY owner inherits the owner arm — one delete rule (2026-08-26)', async () => {
      // FLIPPED. The owner arm was workspace-gated; parity for service
      // providers is precisely the owner being able to remove the seeded set.
      mockDb.qOne.mockResolvedValueOnce(null);                 // agency
      mockDb.q.mockResolvedValueOnce([chan({created_by: 'mgr-1'})]);
      const out = await svc.listOrgChannels(ORG, null, ORG);
      expect(out.channels[0].deletable).toBe(true);
    });

    it('a non-creator delegated manager may NOT delete, workspace or not', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 1});               // workspace
      mockDb.q.mockResolvedValueOnce([chan({created_by: 'someone-else'})]);
      const out = await svc.listOrgChannels(ORG, null, 'mgr-1');
      expect(out.channels[0].deletable).toBe(false);
    });

    it('an OLD caller that names nobody gets no Delete door (compat)', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([chan({created_by: ORG})]);
      const out = await svc.listOrgChannels(ORG, null);        // no acting user
      expect(out.channels[0].deletable).toBe(false);
    });

    it('costs ONE tenant query for the whole page, not one per row', async () => {
      // `canDeleteChannel`'s only async step is the tenant lookup, and the page
      // already holds it. Awaiting per row would be N queries for one answer.
      mockDb.qOne.mockResolvedValueOnce({n: 1});
      mockDb.q.mockResolvedValueOnce([chan(), chan({id: 'c2'}), chan({id: 'c3'})]);
      await svc.listOrgChannels(ORG, null, ORG);
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteChannel enforcement matches the echoed flag (edge A4)', () => {
    /**
     * `mockResolvedValueOnce` is a QUEUE, and these cases consume a DIFFERENT
     * NUMBER of entries depending on which branch fires — the creator path
     * never reaches the tenant lookup. Without a reset, a case that short-
     * circuits leaves its unused entry for the next one, so a real regression
     * surfaces as a failure two tests further down and the attribution is
     * worthless. (Observed exactly that while mutation-proving this block.)
     */
    beforeEach(() => { mockDb.qOne.mockReset(); mockDb.q.mockReset(); });

    it('lets the owner delete a manager-created channel — no tenant lookup left', async () => {
      // 2026-08-26 unification: the owner arm applies to every tenant, so
      // deleteChannel no longer probes org_workspaces at all.
      mockDb.qOne.mockResolvedValueOnce({created_by: 'mgr-1', org_id: ORG});  // the channel
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.deleteChannel(ORG, 'c1')).resolves.toEqual({ok: true});
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });

    it('the AGENCY owner deletes too — same call, same rule (was a refusal)', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'mgr-1', org_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.deleteChannel(ORG, 'c1')).resolves.toEqual({ok: true});
    });

    it('still refuses a non-creator manager on a workspace', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'someone-else', org_id: ORG});
      await expect(svc.deleteChannel('mgr-1', 'c1')).rejects.toThrow(/only_creator_can_delete/);
    });

    it('the creator still deletes without a tenant lookup at all', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'mgr-1', org_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.deleteChannel('mgr-1', 'c1')).resolves.toEqual({ok: true});
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    });
  });
});
