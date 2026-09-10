/**
 * sqa.md bug register — this suite pins: B-196, B-205b.
 *
 * B-196 (a manager could demote or REMOVE the org owner: department_channel_members.role is
 * a two-value admin|viewer flag with no link to org_members.member_role, and "is a channel
 * admin" was the ONLY gate on updateMemberRole and removeMember) is pinned by the SEC cases
 * enforcing the rank model — owner 3, active manager 2, everyone else 1, actor must
 * STRICTLY outrank the target. B-205b (the UI still OFFERED controls the server would
 * reject) is the per-member manageable flag.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {
  q: jest.fn(), qOne: jest.fn(),
  // addMember/removeMember wrap membership + intent + audit in one tx (page-10
  // rule 4). A DISTINCT tx handle, so a test can pin WHICH side of the
  // boundary a write ran on — the C1 lesson from enterpriseJoin.spec.
  withTransaction: jest.fn(),
};
const mockTx = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};

describe('DepartmentService', () => {
  let svc: DepartmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockTx.q.mockReset().mockResolvedValue([]);
    mockTx.qOne.mockReset().mockResolvedValue(null);
    mockDb.withTransaction.mockImplementation(
      async (cb: (t: typeof mockTx) => unknown) => cb(mockTx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(DepartmentService);
  });

  describe('listMembers', () => {
    // Call order after the manageable flag landed:
    //   1 memberRole(caller)  2 members query  3 channel org
    //   4 orgRank(caller)      5.. orgRank(each member; owner short-circuits, no query)
    const ORG = 'org-1';

    it('returns the roster + my_role + a manageable flag per member', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // memberRole(caller)
        .mockResolvedValueOnce({org_id: ORG})             // channel org
        .mockResolvedValueOnce({member_role: 'manager'})  // caller rank 2
        .mockResolvedValueOnce({member_role: 'cpo'});     // the one CPO member → rank 1
      mockDb.q.mockResolvedValueOnce([
        {user_id: 'cpo-1', role: 'admin', role_label: 'CPO', display_name: 'Lead'},
      ]);
      const res = await svc.listMembers('mgr-1', 'c1');
      expect(res.my_role).toBe('admin');
      expect(res.members).toHaveLength(1);
      expect(res.members[0].manageable).toBe(true);
    });

    // B-205 — the whole point: a manager viewing the OWNER's row must not get a
    // manageable=true (which would show the "Make viewer"/remove controls that
    // only 403 on the server). Owner short-circuits orgRank to 3 with no query.
    it('SEC: a manager cannot manage the OWNER (manageable=false)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // memberRole(manager)
        .mockResolvedValueOnce({org_id: ORG})             // channel org
        .mockResolvedValueOnce({member_role: 'manager'}); // caller rank 2; member IS the org → 3, no query
      mockDb.q.mockResolvedValueOnce([
        {user_id: ORG, role: 'admin', role_label: 'Owner', display_name: 'Boss'},
      ]);
      const res = await svc.listMembers('mgr-1', 'c1');
      expect(res.members[0].manageable).toBe(false);
    });

    it('SEC: a manager cannot manage a PEER manager (manageable=false)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'})  // caller rank 2
        .mockResolvedValueOnce({member_role: 'manager'}); // target rank 2 → equal, not manageable
      mockDb.q.mockResolvedValueOnce([
        {user_id: 'mgr-2', role: 'admin', role_label: 'Manager', display_name: 'Peer'},
      ]);
      const res = await svc.listMembers('mgr-1', 'c1');
      expect(res.members[0].manageable).toBe(false);
    });

    it('never marks the caller themselves manageable', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'}); // caller rank; member IS caller → skipped in outrank
      mockDb.q.mockResolvedValueOnce([
        {user_id: 'mgr-1', role: 'admin', role_label: 'Manager', display_name: 'Me'},
      ]);
      const res = await svc.listMembers('mgr-1', 'c1');
      expect(res.members[0].manageable).toBe(false);
    });

    it('rejects a non-member', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.listMembers('stranger', 'c1')).rejects.toThrow('not_a_channel_member');
    });
  });

  describe('registerGroup', () => {
    it('lets an admin link the messenger group', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})   // memberRole
        .mockResolvedValueOnce({id: 'c1'});        // update returns row
      const res = await svc.registerGroup('u-admin', 'c1', 'grp_abc');
      expect(res).toEqual({ok: true, group_conversation_id: 'grp_abc', adopted: false});
    });

    it('forbids a viewer from registering the group', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.registerGroup('u-viewer', 'c1', 'grp_abc'))
        .rejects.toThrow('only_admin_can_register_group');
    });

    it('rejects an empty group id', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'admin'});
      await expect(svc.registerGroup('u-admin', 'c1', ''))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ─── Phase 3 — org workspace + membership/rekey seam ─────────────────
  describe('seedOrgWorkspace', () => {
    it('seeds NOTHING for any tenant — every org starts clean (client 2026-08-26)', async () => {
      const res = await svc.seedOrgWorkspace('org-1');
      expect(res).toEqual({created: 0});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

});

  describe('removeMember (rekey seam)', () => {
    it('admin-only, refuses self-removal, deletes the row, and enqueues a remove intent — ALL ON THE TX', async () => {
      // A manager removing a CPO — the rank gate now sits between the
      // admin check and the DELETE.
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // memberRole(admin)
        .mockResolvedValueOnce({org_id: 'org-1'})         // assertOutranks: channel's org
        .mockResolvedValueOnce({member_role: 'manager'})  // actor rank 2
        .mockResolvedValueOnce({member_role: 'cpo'});     // target rank 1
      mockTx.qOne.mockResolvedValueOnce({user_id: 'cpo-9'}); // DELETE ... RETURNING
      await svc.removeMember('mgr-1', 'ch-1', 'cpo-9');

      // Asserting on the TX handle pins the boundary: membership row, rekey
      // intent and audit commit or roll back together (page-10 rule 4).
      // The DELETE is asserted DIRECTLY on the tx handle (not merely implied
      // by the null-default miss path) so a future mockDb.qOne default cannot
      // silently un-pin it.
      expect(mockTx.qOne).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM public\.department_channel_members/),
        ['ch-1', 'cpo-9'],
      );
      const intentInsert = mockTx.q.mock.calls.find(c =>
        /INSERT INTO public.channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert).toBeDefined();
      expect(intentInsert?.[1]).toEqual(['ch-1', 'cpo-9', 'remove', 'mgr-1']);
      // The audit rides the SAME tx, PII-free metadata.
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'member.channel_remove',
        expect.objectContaining({
          targetKind: 'user', targetId: 'cpo-9',
          metadata: {channel_id: 'ch-1'}, tx: mockTx,
        }),
      );
    });

    it('refuses self-removal', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'admin'});
      await expect(svc.removeMember('admin-1', 'ch-1', 'admin-1')).rejects.toThrow('cannot_remove_self');
    });

    it('rejects a non-admin', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.removeMember('viewer-1', 'ch-1', 'cpo-9')).rejects.toThrow('only_admin_can_manage_members');
    });
  });

  describe('addMember (rekey seam)', () => {
    it('upserts the member and enqueues an add intent — all on the TX, with the audit', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // memberRole(admin)
        .mockResolvedValueOnce({org_id: 'org-1'})  // channel org lookup
        .mockResolvedValueOnce({ok: 1});           // target is an active org member
      await svc.addMember('admin-1', 'ch-1', 'cpo-2', 'viewer', 'CPO');
      const intentInsert = mockTx.q.mock.calls.find(c =>
        /INSERT INTO public.channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert?.[1]).toEqual(['ch-1', 'cpo-2', 'add', 'admin-1']);
      const memberInsert = mockTx.q.mock.calls.find(c =>
        /INSERT INTO public.department_channel_members/i.test(String(c[0])));
      expect(memberInsert).toBeDefined();
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'admin-1', 'member.channel_add',
        expect.objectContaining({
          targetKind: 'user', targetId: 'cpo-2',
          metadata: {channel_id: 'ch-1', role: 'viewer'}, tx: mockTx,
        }),
      );
    });

    it('rejects a target who is not an active member of the channel org (tenant scope, audit D4-a)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // caller is channel admin
        .mockResolvedValueOnce({org_id: 'org-1'})  // channel org
        .mockResolvedValueOnce(null);              // target NOT an active org member
      await expect(svc.addMember('admin-1', 'ch-1', 'stranger', 'viewer'))
        .rejects.toThrow('member_not_in_org');
      const intentInsert = [...mockDb.q.mock.calls, ...mockTx.q.mock.calls].find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert).toBeUndefined();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it('allows adding the org account itself (no org_members lookup needed)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // caller is admin
        .mockResolvedValueOnce({org_id: 'org-1'}); // channel org === target id
      await svc.addMember('admin-1', 'ch-1', 'org-1', 'admin', 'Owner');
      const intentInsert = mockTx.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert?.[1]).toEqual(['ch-1', 'org-1', 'add', 'admin-1']);
    });
  });

  // ─── Step 18 — manager channel management ────────────────────────────
  describe('createChannel', () => {
    it('seeds the org as admin + CPOs as viewers on a standard channel and audits', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-new'});       // INSERT channel
      mockDb.q.mockResolvedValueOnce([                          // activeOrgMembers
        {member_user_id: 'cpo-1', member_role: 'cpo'},
        {member_user_id: 'mgr-1', member_role: 'manager'},
      ]);
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', channel_type: 'department', access: 'standard'});
      expect(res.id).toBe('ch-new');
      const cpoInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'cpo-1');
      expect(cpoInsert?.[1]?.[2]).toBe('viewer');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'channel.create', expect.objectContaining({targetId: 'ch-new'}),
      );
    });

    it('excludes CPOs from a restricted/incident channel (managers-only seed)', async () => {
      // vs2 P3 — createChannel now probes org_workspaces first when a
      // managers-only PARENTLESS channel is requested (a workspace may not have
      // a restricted root). This org is an AGENCY, where a top-level incident
      // channel is legitimate and the refusal must not fire.
      mockDb.qOne.mockResolvedValueOnce(null);
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-inc'});
      mockDb.q.mockResolvedValueOnce([
        {member_user_id: 'cpo-1', member_role: 'cpo'},
        {member_user_id: 'mgr-1', member_role: 'manager'},
      ]);
      await svc.createChannel('org-1', 'mgr-1', {name: 'Incident Queue', channel_type: 'incident', access: 'restricted'});
      const cpoInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'cpo-1');
      expect(cpoInsert).toBeUndefined();
      const mgrInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'mgr-1');
      expect(mgrInsert?.[1]?.[2]).toBe('admin');
    });

    // ── UI corrections 2026-08-15 item 04 — LATERAL CHANNELS ──────────────────
    //
    // The DB trigger is the guarantee (20260816000000); these are the friendly
    // 400s, and the ORDER they fire in matters — a caller must not learn "that
    // parent is a lateral" from an org they do not own, and the tenant gate must
    // not be reachable by a request the parentless rule already refuses.

    it('refuses a lateral with NO parent, before any DB work', async () => {
      // "Lateral to what?" has no answer, and the trigger would silently give it
      // the root default level instead of a derived one.
      await expect(svc.createChannel('org-1', 'mgr-1', {name: '#general', lateral: true}))
        .rejects.toThrow('lateral_channel_needs_parent');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('ALLOWS a lateral on an AGENCY tenant — one channel model (2026-08-26)', async () => {
      // FLIPPED. The old refusal protected the agency per-level #broadcast
      // arithmetic; that producer is gone for every tenant, and with it the
      // tenant probe this path used to make.
      mockDb.qOne.mockResolvedValueOnce({                 // parent lookup
        org_id: 'org-1', level: 2, is_broadcast: false, is_lateral: false,
        parent_id: 'p1', access: 'standard', channel_type: 'department',
      });
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-lat-a', level: 2, is_lateral: true});
      mockDb.q.mockResolvedValueOnce([]);                 // activeOrgMembers
      const res = await svc.createChannel('org-1', 'mgr-1',
        {name: '#general', lateral: true, parent_id: 'parent-1'});
      expect(res.is_lateral).toBe(true);
    });

    it('refuses a lateral UNDER a lateral — the rule the 4-hop walk depends on', async () => {
      mockDb.qOne.mockResolvedValueOnce({                 // parent lookup
        org_id: 'org-1', level: 2, is_broadcast: false, is_lateral: true,
        parent_id: 'grandparent', access: 'standard', channel_type: 'department',
      });
      await expect(svc.createChannel('org-1', 'mgr-1',
        {name: '#deeper', lateral: true, parent_id: 'lateral-1'}))
        .rejects.toThrow('lateral_channel_cannot_have_children');
    });

    it('ALLOWS a lateral at the depth cap — that is the whole feature', async () => {
      /**
       * The bug this pins: gating the lateral on the same `parent.level >= 3`
       * guard as a structural child makes "a lateral at EVERY level" false at
       * exactly the deepest level — the one the PDF's own worked example uses
       * (Team 1 -> #missions/#projects/#locations). A lateral inherits level 3,
       * which the CHECK accepts; only a structural child would compute 4.
       */
      mockDb.qOne.mockResolvedValueOnce({                 // parent at the cap
        org_id: 'org-1', level: 3, is_broadcast: false, is_lateral: false,
        parent_id: 'p2', access: 'standard', channel_type: 'department',
      });
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-lat', level: 3, is_lateral: true});
      mockDb.q.mockResolvedValueOnce([]);                 // activeOrgMembers
      const res = await svc.createChannel('org-1', 'mgr-1',
        {name: '#missions', lateral: true, parent_id: 'team-1'});
      expect(res.level).toBe(3);
      // THE ECHO. In production forbidNonWhitelisted is false, so an OLD server
      // silently strips `lateral` and makes a structural child — frozen and
      // un-re-parentable, i.e. unfixable. The client verifies this field rather
      // than assuming its request was honoured, so it has to be returned.
      expect(res.is_lateral).toBe(true);
    });

    it('still refuses a STRUCTURAL child at the depth cap', async () => {
      // The other half of the same branch: skipping the cap for laterals must not
      // skip it for everything.
      mockDb.qOne.mockResolvedValueOnce({                 // parent at the cap
        org_id: 'org-1', level: 3, is_broadcast: false, is_lateral: false,
        parent_id: 'p2', access: 'standard', channel_type: 'department',
      });
      await expect(svc.createChannel('org-1', 'mgr-1', {name: 'Deeper', parent_id: 'team-1'}))
        .rejects.toThrow('max_channel_depth_reached');
    });

    /**
     * B-590 — a legacy flat channel (parentless, level 1: the 20260803010000
     * default for every pre-hierarchy row) is PROMOTED to a level-0 root the
     * moment it takes its first structural child, so its new tree keeps all
     * four visible tiers instead of topping out at three ("I can create a
     * sub-channel, then a sub of that, then I can't go further").
     */
    const LEGACY_ROOT = {
      org_id: 'org-1', level: 1, is_broadcast: false, is_lateral: false,
      parent_id: null, access: 'standard', channel_type: 'department',
    };

    it('B-590: promotes a legacy level-1 root on its FIRST structural child', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(LEGACY_ROOT)               // parent lookup
        .mockResolvedValueOnce(null)                      // no structural children yet
        .mockResolvedValueOnce({id: 'ch-new', level: 1, is_lateral: false}); // INSERT (derives under the promoted root)
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', parent_id: 'root-1'});
      expect(res.level).toBe(1);
      // BOTH statements run on the SAME transaction handle — the review found
      // the autocommit shape half-shifts a tree when only the second collides.
      const updates = mockTx.q.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' '));
      expect(updates.some(s =>
        s.includes('SET level = 0 WHERE id = $1 AND parent_id IS NULL AND level = 1'))).toBe(true);
      // …and the existing laterals/broadcasts re-derive in the same breath.
      expect(updates.some(s => s.includes('c.parent_id = p.id AND p.id = $1'))).toBe(true);
      // A structural level change on an existing channel gets its own audit line.
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'channel.promote_root',
        expect.objectContaining({targetId: 'root-1',
          metadata: expect.objectContaining({from_level: 1, to_level: 0})}),
      );
    });

    it('B-590: does NOT promote a root that already HAS a structural child', async () => {
      // Such a tree exists only where the promotion migration skipped a
      // #broadcast collision — half-shifting it here would re-create the
      // hazard the migration deliberately backed away from.
      mockDb.qOne
        .mockResolvedValueOnce(LEGACY_ROOT)
        .mockResolvedValueOnce({n: 1})                    // structural child exists
        .mockResolvedValueOnce({id: 'ch-new', level: 2, is_lateral: false});
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', parent_id: 'root-1'});
      expect(res.level).toBe(2);
      expect(mockDb.withTransaction).not.toHaveBeenCalled();
    });

    it('B-590: promotes on an AGENCY tenant too — one tree model (2026-08-26)', async () => {
      // FLIPPED. The workspace-only guard existed because agency #broadcast
      // arithmetic keyed on the stored level; nothing keys on it any more.
      mockDb.qOne
        .mockResolvedValueOnce(LEGACY_ROOT)
        .mockResolvedValueOnce(null)                      // no structural children yet
        .mockResolvedValueOnce({id: 'ch-new', level: 1, is_lateral: false});
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', parent_id: 'root-1'});
      expect(res.level).toBe(1);
      const updates = mockTx.q.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' '));
      expect(updates.some(s =>
        s.includes('SET level = 0 WHERE id = $1 AND parent_id IS NULL AND level = 1'))).toBe(true);
    });

    it('B-590: a collision on the CASCADE rolls the whole promotion back and the create still succeeds', async () => {
      /**
       * The scenario production can actually produce, per the review: the root
       * promotion itself cannot collide (the candidate is NOT is_broadcast) —
       * only the SECOND statement can, when a live legacy #broadcast occupies
       * the level a re-deriving child would land on. The first version of this
       * test failed the FIRST statement, a case that cannot happen, and would
       * have stayed green with the two statements left in autocommit — where
       * the real collision half-shifts the tree irreversibly. Both statements
       * share one transaction, so the rejection below rolls back the root too.
       */
      mockTx.q
        .mockResolvedValueOnce([])                        // root promotion succeeds…
        .mockRejectedValueOnce(new Error(
          'duplicate key value violates unique constraint "dept_channels_one_broadcast_per_level"'));
      mockDb.qOne
        .mockResolvedValueOnce(LEGACY_ROOT)
        .mockResolvedValueOnce(null)                      // no structural children
        .mockResolvedValueOnce({id: 'ch-new', level: 2, is_lateral: false});
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', parent_id: 'root-1'});
      expect(res.level).toBe(2);
      // No promotion happened, so no promotion audit line either.
      expect(mockAudit.log).not.toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'channel.promote_root', expect.anything());
    });
  });

  describe('configureChannel', () => {
    it('rejects a channel from another org (tenant scope)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'other-org', access: 'standard'});
      await expect(svc.configureChannel('org-1', 'mgr-1', 'ch-x', {name: 'x'}))
        .rejects.toThrow('org_scope_violation');
    });

    it('tightening to restricted removes CPO viewers via the rekey path', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})                        // removeMember memberRole
        .mockResolvedValueOnce({org_id: 'org-1'});                     // assertOutranks — actor IS the org, fast path
      mockTx.qOne.mockResolvedValueOnce({user_id: 'cpo-1'});           // removeMember DELETE (on the tx)
      mockDb.q.mockResolvedValueOnce([{user_id: 'cpo-1'}]);            // viewers to remove
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'restricted'});
      const removeIntent = mockTx.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])) && c[1]?.[2] === 'remove');
      expect(removeIntent).toBeDefined();
      // The flagship M1 case: the tighten acts AS the org (authorization) but
      // the audit row must name the MANAGER who clicked. mgr-1 ≠ org-1, so
      // dropping the auditActor argument goes red here.
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'member.channel_remove', expect.anything());
    });

    it('aborts the access flip (no bare-flip) when a CPO removal fails', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})                        // removeMember memberRole
        .mockRejectedValueOnce(new Error('db down'));                  // assertOutranks channel read throws
      mockDb.q.mockResolvedValueOnce([{user_id: 'cpo-1'}]);            // viewers to remove
      await expect(svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'restricted'}))
        .rejects.toThrow('channel_tighten_incomplete');
      // The column flip must NOT have run while a CPO is still un-rekeyed.
      const updateCall = mockDb.q.mock.calls.find(c => /UPDATE public\.department_channels/i.test(String(c[0])));
      expect(updateCall).toBeUndefined();
    });

    it('D7-b: loosening back to standard re-seeds CPO viewers via the add+rekey path', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'restricted', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})    // addMember memberRole
        .mockResolvedValueOnce({org_id: 'org-1'})  // addMember channel lookup
        .mockResolvedValueOnce({ok: 1});           // addMember org-member check
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1', member_role: 'cpo'}]); // activeOrgMembers
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'standard'});
      const addIntent = mockTx.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])) && c[1]?.[2] === 'add');
      expect(addIntent).toBeDefined(); // the rekeyed-out CPO is re-added with an add+rekey intent
    });

    /**
     * F8 REGRESSION — the loosen path resolves its role from the REQUEST.
     *
     * `loosenedPostMode = input.post_mode ?? current.post_mode` is the one place
     * left that answers "who may post" from the caller instead of the stored
     * rule, and F8 turned that from cosmetic into destructive: on a #broadcast
     * the trigger pins post_mode to 'announcement', so a request carrying
     * post_mode:'open' makes the loop call addMember with role='admin' — which
     * assertBroadcastPostingAllowed now REFUSES. Every refusal is swallowed by
     * the loop's catch, so a manager who tightens then loosens the mandatory
     * #broadcast gets a 200 and an empty channel: no ordinary employee is ever
     * re-added, and page-10-rule-1's "exists at each level" channel is invisible
     * to everyone but managers.
     *
     * Before F8 this flow was correct — addMember succeeded and the post_mode
     * re-seed 40 lines below (which DOES read the stored mode) demoted them back
     * to viewer. The fix is to answer this question the same way that block
     * already does: from the STORED post_mode.
     */
    it('SEC/F8: loosening a #broadcast with post_mode:open still re-seeds its members', async () => {
      mockDb.qOne
        // assertManagesChannel — a #broadcast that was tightened to restricted.
        .mockResolvedValueOnce({
          org_id: 'org-1', access: 'restricted', channel_type: 'board',
          name: '#broadcast', post_mode: 'announcement', is_broadcast: true,
        })
        .mockResolvedValueOnce({role: 'admin'})                      // addMember memberRole
        .mockResolvedValueOnce({org_id: 'org-1', is_broadcast: true}) // addMember channel read
        // One object serves BOTH readers of the 4th call, so the mock does not
        // encode which branch is taken: orgRank reads member_role (broken path),
        // the org-membership check just needs a row (fixed path).
        .mockResolvedValueOnce({ok: 1, member_role: 'cpo'})
        .mockResolvedValueOnce({post_mode: 'announcement'});         // UPDATE … RETURNING
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1', member_role: 'cpo'}]);

      await svc.configureChannel('org-1', 'mgr-1', 'bc-1', {access: 'standard', post_mode: 'open'});

      const seeded = mockTx.q.mock.calls.find(c =>
        /INSERT INTO public\.department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'cpo-1');
      // The member is back in the channel…
      expect(seeded).toBeDefined();
      // …as a VIEWER, because the stored mode is 'announcement'. Not 'admin':
      // that is what the F8 rule refuses, and refusing is what dropped them.
      expect(seeded?.[1]?.[2]).toBe('viewer');
    });

    it('D7-c: an empty department clears it via the sentinel CASE', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'});
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {department: ''});
      // Phase 2 — this UPDATE moved from db.q to db.qOne because it now needs
      // `RETURNING post_mode` (roles must be re-seeded from the STORED mode, not
      // the requested one, or a #broadcast's members get promoted).
      const upd = mockDb.qOne.mock.calls.find(c => /UPDATE public\.department_channels/i.test(String(c[0])));
      expect(upd).toBeDefined();
      expect(String(upd![0])).toMatch(/department\s+=\s+CASE WHEN \$3::text IS NULL/);
      expect((upd![1] as unknown[])[2]).toBe(''); // '' passes through to the clear branch
    });
  });

  describe('archiveChannel / unarchiveChannel', () => {
    it('archives a channel it manages', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'});
      const res = await svc.archiveChannel('org-1', 'mgr-1', 'ch-1');
      expect(res).toEqual({ok: true});
      const upd = mockDb.q.mock.calls.find(c => /SET archived_at = NOW\(\)/i.test(String(c[0])));
      expect(upd).toBeDefined();
      expect(mockAudit.log).toHaveBeenCalledWith('org-1', 'mgr-1', 'channel.archive', expect.anything());
    });

    it('rejects archiving a channel from another org', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'other-org', access: 'standard', channel_type: 'department'});
      await expect(svc.archiveChannel('org-1', 'mgr-1', 'ch-x')).rejects.toThrow('org_scope_violation');
    });

    it('unarchives a channel it manages', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'});
      const res = await svc.unarchiveChannel('org-1', 'mgr-1', 'ch-1');
      expect(res).toEqual({ok: true});
      const upd = mockDb.q.mock.calls.find(c => /SET archived_at = NULL/i.test(String(c[0])));
      expect(upd).toBeDefined();
      expect(mockAudit.log).toHaveBeenCalledWith('org-1', 'mgr-1', 'channel.unarchive', expect.anything());
    });

    it('rejects unarchiving a channel from another org', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'other-org', access: 'standard', channel_type: 'department'});
      await expect(svc.unarchiveChannel('org-1', 'mgr-1', 'ch-x')).rejects.toThrow('org_scope_violation');
    });
  });

  describe('updateMemberRole', () => {
    // Call order after the rank gate landed:
    //   1 memberRole(actor)  2 assertOutranks: SELECT org_id
    //   3 orgRank(actor)     4 orgRank(target)   5 the UPDATE
    // orgRank short-circuits WITHOUT a query when the id IS the org owner.
    const ORG = 'org-1';
    it('admin promotes a viewer to post access', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // caller is channel admin
        .mockResolvedValueOnce({org_id: ORG})             // channel's org
        .mockResolvedValueOnce({member_role: 'manager'})  // actor rank = 2
        .mockResolvedValueOnce({member_role: 'cpo'});     // target rank = 1
      mockTx.qOne.mockResolvedValueOnce({user_id: 'cpo-1'}); // UPDATE (on the tx, with the audit)
      const res = await svc.updateMemberRole('mgr-1', 'ch-1', 'cpo-1', 'admin');
      expect(res).toEqual({ok: true});
      expect(mockAudit.log).toHaveBeenCalledWith(
        ORG, 'mgr-1', 'member.channel_role',
        expect.objectContaining({metadata: {channel_id: 'ch-1', role: 'admin'}, tx: mockTx}),
      );
    });
    it('rejects a non-admin', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.updateMemberRole('viewer-1', 'ch-1', 'cpo-1', 'admin'))
        .rejects.toThrow('only_admin_can_manage_members');
    });
    it('rejects an unknown member', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'})
        .mockResolvedValueOnce({member_role: 'cpo'});
      // The UPDATE runs on the tx; mockTx.qOne defaults to null = no row.
      await expect(svc.updateMemberRole('mgr-1', 'ch-1', 'ghost', 'viewer'))
        .rejects.toThrow('member_not_found');
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    // ── rank gate ────────────────────────────────────────────────────────
    // Every manager is made channel-admin on every org channel and the OWNER is
    // a channel member too, so "is a channel admin" alone let a manager demote
    // the owner to viewer in the owner's own thread.
    it('SEC: a manager cannot demote the ORG OWNER to viewer', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // manager IS a channel admin
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'}); // actor rank 2; target IS the org → 3, no query
      await expect(svc.updateMemberRole('mgr-1', 'ch-1', ORG, 'viewer'))
        .rejects.toThrow('cannot_modify_org_owner');
    });

    it('SEC: a manager cannot change a PEER manager', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'})  // actor 2
        .mockResolvedValueOnce({member_role: 'manager'}); // target 2 → equal rank refused
      await expect(svc.updateMemberRole('mgr-1', 'ch-1', 'mgr-2', 'viewer'))
        .rejects.toThrow('insufficient_rank_for_target');
    });

    // "Allow post" sends role='admin', and admin is the ONLY gate on member
    // management — so granting a CPO post access used to hand them the right to
    // change anyone's access, including the owner's.
    it('SEC: a CPO with post access cannot change another CPO', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})           // CPO was given "Allow post"
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'cpo'})      // actor 1
        .mockResolvedValueOnce({member_role: 'cpo'});     // target 1 → refused
      await expect(svc.updateMemberRole('cpo-1', 'ch-1', 'cpo-2', 'viewer'))
        .rejects.toThrow('insufficient_rank_for_target');
    });

    it('SEC: the OWNER may still change a manager', async () => {
      // The owner short-circuits assertOutranks the moment org_id is known, so
      // NEITHER rank lookup runs — exactly 2 pool reads; the UPDATE is on the tx.
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG});      // actor IS the org → fast path
      mockTx.qOne.mockResolvedValueOnce({user_id: 'mgr-1'}); // UPDATE ... RETURNING
      await expect(svc.updateMemberRole(ORG, 'ch-1', 'mgr-1', 'viewer')).resolves.toEqual({ok: true});
      expect(mockDb.qOne).toHaveBeenCalledTimes(2);
    });

    it('SEC: removeMember is gated by the same rank rule', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG})
        .mockResolvedValueOnce({member_role: 'manager'}); // target is the org → 3
      await expect(svc.removeMember('mgr-1', 'ch-1', ORG))
        .rejects.toThrow('cannot_modify_org_owner');
    });
  });

  /**
   * F8 — A MEMBER MUST NOT BE PROMOTED TO A POSTING ROLE INSIDE #broadcast.
   *
   * Page 10 rule 1: "#broadcast exists at each level; Members cannot post, reply
   * or call in it." Posting is gated by department_channel_members.role
   * ('admin' posts, 'viewer' cannot), and every SEED path resolves that from
   * post_mode — which the DB trigger pins to 'announcement' on a broadcast, so
   * members land as viewers.
   *
   * But `role` has two writers that take it straight from the caller and never
   * read is_broadcast: `updateMemberRole` (the in-thread "Allow post" control)
   * and `addMember` (the DTO's role, which is an UPSERT — `DO UPDATE SET role`).
   * One PATCH restored a member's composer in the one channel the rule says it
   * must not exist in.
   *
   * The refusal is RANK-based, not blanket: managers and the owner are seeded
   * channel-admin on the broadcast on purpose (somebody has to broadcast), so
   * the rule is about MEMBERS — matching `isManager ? 'admin' : memberRole` in
   * seedChannelMembers rather than inventing a second notion of "member".
   */
  describe('#broadcast posting (F8)', () => {
    const ORG = 'org-1';

    it('SEC: updateMemberRole REFUSES to promote a member to admin in a #broadcast', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})                       // actor is channel admin
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: true})     // assertOutranks channel read
        .mockResolvedValueOnce({member_role: 'manager'})              // actor rank 2
        .mockResolvedValueOnce({member_role: 'cpo'})                  // target rank 1 (outrank ok)
        .mockResolvedValueOnce({member_role: 'cpo'});                 // target rank 1 (broadcast rule)
      await expect(svc.updateMemberRole('mgr-1', 'bc-1', 'cpo-1', 'admin'))
        .rejects.toThrow('broadcast_members_cannot_post');
      // …and the promotion must NOT have been written — on EITHER handle.
      const upd = [...mockDb.qOne.mock.calls, ...mockTx.qOne.mock.calls].find(c =>
        /UPDATE public\.department_channel_members/i.test(String(c[0])));
      expect(upd).toBeUndefined();
    });

    it('still allows DEMOTING a member to viewer in a #broadcast', async () => {
      // The rule bans granting a composer, not taking one away — and a blanket
      // "no role writes in a broadcast" would strand anyone wrongly promoted.
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: true})
        .mockResolvedValueOnce({member_role: 'manager'})
        .mockResolvedValueOnce({member_role: 'cpo'});
      mockTx.qOne.mockResolvedValueOnce({user_id: 'cpo-1'});          // UPDATE (on the tx)
      await expect(svc.updateMemberRole('mgr-1', 'bc-1', 'cpo-1', 'viewer'))
        .resolves.toEqual({ok: true});
    });

    it('still allows a MANAGER to hold post access in a #broadcast', async () => {
      // Managers are seeded channel-admin on the broadcast; refusing them would
      // make the channel unusable for its actual purpose.
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: true})     // actor IS the org → fast path
        .mockResolvedValueOnce({member_role: 'manager'});             // target rank 2 → may post
      mockTx.qOne.mockResolvedValueOnce({user_id: 'mgr-2'});          // UPDATE (on the tx)
      await expect(svc.updateMemberRole(ORG, 'bc-1', 'mgr-2', 'admin'))
        .resolves.toEqual({ok: true});
    });

    it('a NON-broadcast channel is unaffected — promotion still works', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: false})
        .mockResolvedValueOnce({member_role: 'manager'})
        .mockResolvedValueOnce({member_role: 'cpo'});
      mockTx.qOne.mockResolvedValueOnce({user_id: 'cpo-1'});
      await expect(svc.updateMemberRole('mgr-1', 'ch-1', 'cpo-1', 'admin'))
        .resolves.toEqual({ok: true});
    });

    /**
     * THE SECOND WRITER. addMember is the quieter route to the same state: it
     * upserts with `DO UPDATE SET role = EXCLUDED.role`, so POSTing an existing
     * member with role='admin' promotes them without ever touching
     * updateMemberRole. Guarding only the obvious one is exactly the
     * "narrower surface than the code has" shape this repo keeps hitting.
     */
    it('SEC: addMember REFUSES to add a member with post access to a #broadcast', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})                       // caller is channel admin
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: true})     // channel read
        .mockResolvedValueOnce({member_role: 'cpo'});                 // target rank 1
      await expect(svc.addMember('mgr-1', 'bc-1', 'cpo-2', 'admin'))
        .rejects.toThrow('broadcast_members_cannot_post');
      // No membership row, and no rekey intent — the add is fully refused.
      const ins = [...mockDb.q.mock.calls, ...mockTx.q.mock.calls].find(c =>
        /INSERT INTO public\.department_channel_members/i.test(String(c[0])));
      expect(ins).toBeUndefined();
      // BOTH handles: after the tx move a deleted guard would write on
      // mockTx.q, and a mockDb-only absence check would pass vacuously.
      const intent = [...mockDb.q.mock.calls, ...mockTx.q.mock.calls].find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intent).toBeUndefined();
      // The audit is the newly added write — the refusal path must not emit it.
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it('a tx-CALLBACK NotFoundException reaches the caller with its type intact', async () => {
      // Pins the SERVICE side only: no try/catch inside the callback swallows
      // or re-wraps the miss. The mock withTransaction is a passthrough, so
      // the REAL BEGIN/ROLLBACK/rethrow contract lives in
      // database.service.spec.ts — configureChannel's
      // `instanceof NotFoundException` branch depends on both halves.
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // memberRole(org)
        .mockResolvedValueOnce({org_id: 'org-1'}); // assertOutranks fast path (actor IS org)
      await expect(svc.removeMember('org-1', 'ch-1', 'cpo-9'))
        .rejects.toThrow(NotFoundException);
    });

    it('addMember still seeds a VIEWER into a #broadcast (everyone sees it)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce({org_id: ORG, is_broadcast: true})
        .mockResolvedValueOnce({ok: 1});                              // active org member
      await expect(svc.addMember('mgr-1', 'bc-1', 'cpo-2', 'viewer')).resolves.toEqual({ok: true});
      const intent = mockTx.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intent?.[1]).toEqual(['bc-1', 'cpo-2', 'add', 'mgr-1']);
    });
  });

  describe('deleteChannel (creator-only)', () => {
    it('lets the creator delete', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      const res = await svc.deleteChannel('owner-1', 'ch-1');
      expect(res).toEqual({ok: true});
      expect(mockDb.q.mock.calls.find(c => /DELETE FROM public\.department_channels/i.test(String(c[0])))).toBeDefined();
    });
    it('forbids a non-creator', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'someone-else', org_id: 'org-1'});
      await expect(svc.deleteChannel('intruder', 'ch-1')).rejects.toThrow('only_creator_can_delete');
    });
  });

  describe('resetGroup (owner-only recovery)', () => {
    it('lets the owner clear the group linkage for re-provisioning', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      const res = await svc.resetGroup('owner-1', 'ch-1');
      expect(res).toEqual({ok: true});
      expect(mockDb.q.mock.calls.find(c =>
        /UPDATE public\.department_channels SET group_conversation_id = NULL/i.test(String(c[0])))).toBeDefined();
    });
    it('forbids a non-owner', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      await expect(svc.resetGroup('cpo-9', 'ch-1')).rejects.toThrow('only_owner_can_reset');
    });
  });
});
