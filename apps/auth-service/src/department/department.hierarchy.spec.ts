/**
 * Enterprise Dept Channels scope v2 — Phase 1, the four-level hierarchy.
 *
 * Pins the SERVICE half of the contract (the DB half — derived level, depth
 * CHECK, cross-org parent, re-parent block — lives in the trigger and is pinned
 * by deptChannelHierarchyMigration.test.ts, since no DB runs in unit tests).
 *
 * The rules under test, from the source PDF:
 *   page 1 LOCKED RULES — "Exactly four organisational levels are supported;
 *                          no fifth level is permitted."
 *   page 10 rule 2      — "One Enterprise must never access another
 *                          Enterprise's records or metadata."
 *
 * Why the service validates at all when the trigger already does: the trigger
 * raises a raw Postgres exception, which surfaces as a 500. These checks turn
 * the same three violations into clean 400s. The trigger remains the guarantee;
 * this is the error message.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};

const ORG = 'org-1';
const MGR = 'mgr-1';

describe('DepartmentService — four-level hierarchy (scope v2 Phase 1)', () => {
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

  describe('createChannel — parent validation', () => {
    it('creates a top-level channel with no parent (pre-hierarchy behaviour is unchanged)', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-1', level: 1}); // INSERT
      const res = await svc.createChannel(ORG, MGR, {name: 'Operations'});

      expect(res).toMatchObject({id: 'ch-1', level: 1});
      // No parent lookup should have happened at all.
      const sql = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(sql).not.toMatch(/SELECT org_id, level FROM public\.department_channels/);
      // parent_id must be passed as NULL, not omitted — the column is explicit
      // in the INSERT, so a missing param would shift every positional arg.
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO public\.department_channels/.test(String(c[0])));
      expect(insert?.[1]).toContain(null);
    });

    it('REJECTS a parent belonging to another Enterprise (tenancy — page 10 rule 2)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'someone-else', level: 1}); // parent lookup
      await expect(svc.createChannel(ORG, MGR, {name: 'Leak', parent_id: 'ch-other'}))
        .rejects.toThrow(BadRequestException);
      // and it must not have written anything
      const sql = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(sql).not.toMatch(/INSERT INTO public\.department_channels/);
    });

    it('REJECTS a fifth level — a child of a level-3 channel (page 1 LOCKED RULE)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: ORG, level: 3}); // parent is sub-sub
      await expect(svc.createChannel(ORG, MGR, {name: 'Too deep', parent_id: 'ch-3'}))
        .rejects.toThrow(BadRequestException);
      const sql = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(sql).not.toMatch(/INSERT INTO public\.department_channels/);
    });

    it('REJECTS a missing or archived parent', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // parent lookup finds nothing
      await expect(svc.createChannel(ORG, MGR, {name: 'Orphan', parent_id: 'ch-gone'}))
        .rejects.toThrow(BadRequestException);
    });

    it('ACCEPTS a level-2 child under a level-1 parent and returns the DERIVED level', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG, level: 1})   // parent lookup
        .mockResolvedValueOnce({id: 'ch-2', level: 2});   // INSERT RETURNING (trigger derived)
      const res = await svc.createChannel(ORG, MGR, {name: 'Night shift', parent_id: 'ch-1'});

      expect(res.level).toBe(2);
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO public\.department_channels/.test(String(c[0])));
      expect(insert?.[1]).toContain('ch-1');
      // The caller must NOT be able to assert its own depth: `level` is absent
      // from the INSERT column list, so the trigger is the only writer.
      //
      // PARSE the column list rather than regexing for `level)`. The positional
      // form only caught `level` in LAST position, so moving it anywhere else —
      // `(org_id, level, name, …)` — let a caller state its own depth with the
      // assertion still green.
      const stmt = String(insert?.[0]);
      const cols = stmt
        .slice(stmt.indexOf('department_channels (') + 'department_channels ('.length,
               stmt.indexOf(')', stmt.indexOf('department_channels (')))
        .split(',').map(c => c.trim());
      expect(cols).not.toContain('level');
      expect(cols).toContain('parent_id');
    });

    it('records parent + derived level in the audit trail (page 10 rule 4)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG, level: 1})
        .mockResolvedValueOnce({id: 'ch-2', level: 2});
      await svc.createChannel(ORG, MGR, {name: 'Night shift', parent_id: 'ch-1'});

      expect(mockAudit.log).toHaveBeenCalledWith(
        ORG, MGR, 'channel.create',
        expect.objectContaining({metadata: expect.objectContaining({parent_id: 'ch-1', level: 2})}),
      );
    });
  });

  describe('ALL THREE read sites must carry the tree', () => {
    // The first pass shipped two of three and missed listOrgChannels — which is
    // the query frame A9 ("Show the full authorised hierarchy") actually reads.
    // Enumerating the read sites in a test is what stops that recurring.
    it('listChannels (M8) selects parent_id + level, parents before children', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.listChannels('user-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/c\.parent_id/);
      expect(sql).toMatch(/c\.level/);
      expect(sql).toMatch(/ORDER BY c\.level ASC/);
    });

    it('listChannels HIDES parent_id when the caller is not in the parent', async () => {
      // Otherwise a member of a standard sub-channel is handed the UUID of its
      // RESTRICTED parent — proof that a channel they cannot see exists. The
      // plan doc's own rule: hidden metadata is filtered by the SERVER.
      mockDb.q.mockResolvedValueOnce([]);
      await svc.listChannels('user-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      // Membership-gated, not a bare column read.
      //
      // RE-ANCHORED by vs2 item 2, invariant unchanged. The gate used to be an
      // inline `CASE WHEN EXISTS(... pm.channel_id = c.parent_id ...)`. vs2
      // added two more consumers of that same question (parent_hidden and the
      // ancestor walk), so it is computed once in a LATERAL as `av.v1` and read
      // from three places — three separately-spelled copies of one predicate in
      // a single query being the drift this repo keeps paying for. `a1.id` IS
      // `c.parent_id`: the join above binds them.
      expect(sql).toMatch(/CASE WHEN av\.v1 THEN c\.parent_id ELSE NULL END AS parent_id/);
      expect(sql).toMatch(/pm\.channel_id = a1\.id AND pm\.user_id = \$1/);
      expect(sql).toMatch(/LEFT JOIN public\.department_channels a1 ON a1\.id = c\.parent_id/);
      // The gate must remain a MEMBERSHIP test — a gate that always passes is
      // the regression this test exists to catch.
      expect(sql).toMatch(/AS v1/);
      expect(sql).not.toMatch(/^\s*c\.parent_id,\s*$/m);
    });

    it('listOrgChannels (A9 — Manage Channels) selects parent_id + level', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.listOrgChannels('org-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/c\.parent_id/);
      expect(sql).toMatch(/c\.level/);
      expect(sql).toMatch(/c\.level ASC/);
    });

    it('listChannelsForOps selects parent_id + level', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.listChannelsForOps();
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/c\.parent_id/);
      expect(sql).toMatch(/c\.level/);
    });

    /**
     * …but it does NOT order by them. The ops departments page renders a FLAT
     * table with no depth column, so ordering level-first only had one visible
     * effect: an HQ operator's row order silently changed, for a consumer that
     * does not exist yet. The columns still ship; whoever builds the hierarchy
     * view changes this ordering together with the UI that explains it.
     *
     * The member-facing listChannels DOES order level-first, deliberately — it
     * has a tree renderer that needs a parent to precede its children. Asserted
     * here so the two do not get "harmonised" into one rule.
     */
    it('the OPS read keeps its recency order — level-first is member-only', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.listChannelsForOps();
      const sql = String(mockDb.q.mock.calls[0][0])
        .split(/\r?\n/)
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      expect(sql).toMatch(/ORDER BY c\.created_at DESC/);
      expect(sql).not.toMatch(/ORDER BY c\.level/);
    });
  });

  describe('archive / delete must not orphan a subtree', () => {
    it('REFUSES to archive a parent that still has active sub-channels', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})   // assertManagesChannel
        .mockResolvedValueOnce({n: 2});         // active children
      await expect(svc.archiveChannel(ORG, MGR, 'ch-parent')).rejects.toThrow(ConflictException);
      // and it must NOT have written the archive
      const written = mockDb.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(written).not.toMatch(/SET archived_at = NOW\(\)/);
    });

    it('archives normally when the channel is a leaf', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({n: 0});
      await expect(svc.archiveChannel(ORG, MGR, 'ch-leaf')).resolves.toEqual({ok: true});
      const written = mockDb.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(written).toMatch(/SET archived_at = NOW\(\)/);
    });

    it('REFUSES to unarchive a child whose parent is archived', async () => {
      // The guard must exist on BOTH sides. Archive alone could not orphan a
      // subtree, but archive C (leaf) → archive P → unarchive C reaches exactly
      // the state the archive guard exists to prevent, from the unguarded side.
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})    // assertManagesChannel
        .mockResolvedValueOnce({archived: true}); // parent is archived
      await expect(svc.unarchiveChannel(ORG, MGR, 'ch-child')).rejects.toThrow(ConflictException);
      const written = mockDb.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(written).not.toMatch(/SET archived_at = NULL/);
    });

    it('REFUSES to unarchive a child under a RESTRICTED ROOT — the third door', async () => {
      /**
       * vs2 item 2 (P2-d). createChannel and configureChannel both refuse
       * "restricted root with active children", and unarchive reached the same
       * state by the same archive→archive→unarchive shape the test above
       * describes: archive the child (leaf, allowed) → the root is now
       * childless so tightening it passes configureChannel's guard → unarchive
       * the child. The parent is not archived, so the existing check lets it
       * through, and everyone under that root is stranded beneath a node they
       * cannot see. A rule enforced on two of its three doors is not enforced.
       */
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({
          archived: false, is_root: true, access: 'restricted', channel_type: 'department',
        });
      await expect(svc.unarchiveChannel(ORG, MGR, 'ch-child')).rejects.toThrow(ConflictException);
      const written = mockDb.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(written).not.toMatch(/SET archived_at = NULL/);
    });

    it('ALLOWS unarchiving under a restricted MID-TREE node — only roots are guarded', async () => {
      // A restricted node in the middle of a tree is ordinary: the member still
      // has a visible organisation above it, and the renderer has a case for
      // the hidden rung. Guarding it would forbid a normal structure.
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({
          archived: false, is_root: false, access: 'restricted', channel_type: 'department',
        });
      await expect(svc.unarchiveChannel(ORG, MGR, 'ch-child')).resolves.toEqual({ok: true});
    });

    it('unarchives normally when the parent is active (or there is no parent)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce(null);            // no parent row at all
      await expect(svc.unarchiveChannel(ORG, MGR, 'ch-main')).resolves.toEqual({ok: true});
      const written = mockDb.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(written).toMatch(/SET archived_at = NULL/);
    });

    it('turns the FK RESTRICT violation into a 409, not a 500', async () => {
      // Without this the user sees an alert reading "Internal server error".
      mockDb.qOne.mockResolvedValueOnce({created_by: MGR, org_id: ORG});
      mockDb.q.mockRejectedValueOnce(Object.assign(new Error('fk'), {code: '23503'}));
      await expect(svc.deleteChannel(MGR, 'ch-parent')).rejects.toThrow(ConflictException);
    });
  });
});
