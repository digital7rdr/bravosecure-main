/**
 * sqa.md bug register — this suite pins: B-188, B-198, B-249.
 *
 * B-188 (the org OWNER's profile opened "not related to your organization" — the owner has
 * no org_members row, so the roster-only getMemberProfile lookup 403'd not_your_org_member)
 * is pinned by the owner-branch cases. B-198 (the manager dashboard showed a different
 * rating / jobs count than the owner — both KPIs were bound to the SELF row from GET
 * /agents/me, while rating is written against the org and jobs_total counts org bookings)
 * is pinned by "COUNTS completed missions instead of trusting the agents.jobs_total
 * counter".
 */
import {Test, TestingModule} from '@nestjs/testing';
import {ConflictException, ForbiddenException} from '@nestjs/common';
import {OrgCpoService} from './org-cpo.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';

const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(),
};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockDept = {addMember: jest.fn(), removeMember: jest.fn(), updateMemberRole: jest.fn()};
const mockAuth = {revokeAllUserSessions: jest.fn()};
const mockOrgAudit = {log: jest.fn()};

describe('OrgCpoService', () => {
  let service: OrgCpoService;
  const ORG = 'org-user-1';

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPw.hash.mockResolvedValue('$argon2id$mock');
    // Channel sync reads the org's channels; default to none so existing tests
    // exercise just the roster mutation. mockDb.q default is set per-test.
    mockDept.addMember.mockResolvedValue({ok: true});
    mockDept.removeMember.mockResolvedValue({ok: true});
    mockDept.updateMemberRole.mockResolvedValue({ok: true});
    mockOrgAudit.log.mockResolvedValue(undefined);
    // Default: org owns no channels, so post-commit channel sync is a no-op.
    mockDb.q.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgCpoService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: mockPw},
        {provide: DepartmentService, useValue: mockDept},
        {provide: AuthService, useValue: mockAuth},
        {provide: OrgAuditService, useValue: mockOrgAudit},
      ],
    }).compile();
    service = module.get(OrgCpoService);
  });

  const dto = {
    display_name: 'Jane CPO',
    email: 'jane@example.com',
    phone_e164: '+15555550111',
    temp_password: 'temp-pass-1',
    call_sign: 'CPO-91',
  };

  describe('addEmployee (M1A rule 16)', () => {
    it('rejects a service-provider agent (agent cannot be an employee)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-prov', display_name: 'Prov', email: 'p@x.io'}) // target found
        .mockResolvedValueOnce({user_role: 'individual', agent_type: 'company', agent_status: 'ACTIVE',
          managed_by_org_id: null, member_role: null, member_status: null, org_user_id: null,
          org_name: null, password_set_at: new Date()}); // ACCOUNT_KIND_SQL → company agent
      await expect(service.addEmployee(ORG, 'p@x.io')).rejects.toThrow(/provider_account_cannot_be_employee/);
      // never inserted
      expect(mockDb.q).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO org_members'), expect.anything());
    });

    it('rejects a managed CPO of another org', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-cpo', display_name: 'Cpo', email: 'c@x.io'})
        .mockResolvedValueOnce({user_role: 'individual', agent_type: 'cpo', agent_status: 'ACTIVE',
          managed_by_org_id: 'other-org', member_role: 'cpo', member_status: 'active', org_user_id: 'other-org',
          org_name: 'Other', password_set_at: new Date()});
      await expect(service.addEmployee(ORG, 'c@x.io')).rejects.toThrow(/provider_account_cannot_be_employee/);
    });

    it('enrolls a plain individual as an active employee', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-ind', display_name: 'Ivy', email: 'i@x.io'}) // target
        .mockResolvedValueOnce(null)   // ACCOUNT_KIND_SQL → individual (no rows)
        .mockResolvedValueOnce(null);  // no existing membership
      // listRoster (db.q) returns the freshly-enrolled row.
      mockDb.q.mockImplementation((sql: string) =>
        /FROM org_members om/.test(sql)
          ? Promise.resolve([{member_user_id: 'u-ind', display_name: 'Ivy', email: 'i@x.io',
              call_sign: null, member_role: 'employee', status: 'active', agent_status: null,
              missions_completed: 0, created_at: new Date(), on_duty: false, on_mission: false, armed_authorized: false}])
          : Promise.resolve([]));
      const row = await service.addEmployee(ORG, 'i@x.io', 'actor-1');
      expect(row.member_role).toBe('employee');
      const insertCall = mockDb.q.mock.calls.find(c => /INSERT INTO org_members/.test(c[0] as string));
      expect(insertCall?.[1]).toEqual([ORG, 'u-ind', 'actor-1']);
    });
  });

  describe('createManagedCpo', () => {
    it('rejects when a user with that email/phone already exists', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'existing'}); // dup pre-check
      await expect(service.createManagedCpo(ORG, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(mockDb.withTransaction).not.toHaveBeenCalled();
    });

    it('creates users + agents + org_members atomically in one transaction', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // no dup

      // tx mock: first qOne inside tx returns the new user id.
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-1'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      const out = await service.createManagedCpo(ORG, dto);

      // Password was hashed before the tx (never store plaintext).
      expect(mockPw.hash).toHaveBeenCalledWith('temp-pass-1');

      // Exactly one users insert, one agents insert, one org_members insert.
      const sqls = txQ.mock.calls.map((c) => String(c[0]));
      const agentInsert = sqls.find((s) => /INSERT INTO agents/i.test(s));
      const memberInsert = sqls.find((s) => /INSERT INTO org_members/i.test(s));
      expect(agentInsert).toMatch(/managed_by_org_id/);
      expect(agentInsert).toMatch(/'cpo'/);
      expect(agentInsert).toMatch(/'DOCS_PENDING'/);
      expect(memberInsert).toBeDefined();

      // org_members bound to the SUPPLIED org and the NEW cpo user.
      const memberCall = txQ.mock.calls.find((c) => /INSERT INTO org_members/i.test(String(c[0])));
      expect(memberCall?.[1]).toEqual(
        expect.arrayContaining([ORG, 'new-cpo-1']),
      );

      expect(out).toMatchObject({
        member_user_id: 'new-cpo-1',
        member_role: 'cpo',
        status: 'active',
        agent_status: 'DOCS_PENDING',
      });
    });

    it('Step 23 — translates a 23505 unique race (concurrent same-email) into a clean 409', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // soft pre-check passes (race window)
      // The txn loses the race and hits users.email (citext UNIQUE) / one-active-agency.
      mockDb.withTransaction.mockRejectedValueOnce({code: '23505', constraint: 'users_email_key'});
      await expect(service.createManagedCpo(ORG, dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('Step 23 — a non-unique txn error is NOT masked as a conflict', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      mockDb.withTransaction.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.createManagedCpo(ORG, dto)).rejects.toThrow('connection reset');
    });

    it('defaults member_role to cpo when omitted', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-2'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      const {member_role: _omit, ...noRole} = {...dto, member_role: undefined};
      const out = await service.createManagedCpo(ORG, noRole as any);
      expect(out.member_role).toBe('cpo');
    });
  });

  describe('applyAsOrg', () => {
    it('rejects a CPO that is not an active member of the org (tenant isolation)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // member lookup → not found
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'not-mine', dressPledge: 'Black suit'}),
      ).rejects.toThrow('cpo_not_active_member_of_org');
    });

    it('rejects a too-short dress pledge before any DB read', async () => {
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'ok'}),
      ).rejects.toThrow('dress_pledge_required');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('writes org as applicant and the named CPO as the deployed officer', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({call_sign: 'CPO-7', status: 'ACTIVE'})         // member ok
        .mockResolvedValueOnce({status: 'PUBLISHED'})                          // job open
        .mockResolvedValueOnce({id: 'app-1', status: 'PENDING', assigned_cpo_user_id: 'cpo-1'}); // upsert

      const out = await service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'Black suit + tie'});
      expect(out).toMatchObject({id: 'app-1', assigned_cpo_user_id: 'cpo-1'});

      const upsertCall = mockDb.qOne.mock.calls.find(c => /INSERT INTO job_applications/i.test(String(c[0])));
      // params: [jobId, orgUserId, callSign, pledge, cpoUserId]
      expect(upsertCall?.[1][0]).toBe('job-1');
      expect(upsertCall?.[1][1]).toBe(ORG);       // agent_id = applicant_org = org
      expect(upsertCall?.[1][4]).toBe('cpo-1');   // assigned_cpo_user_id = officer
      expect(String(upsertCall?.[0])).toMatch(/applicant_org_id/);
      expect(String(upsertCall?.[0])).toMatch(/assigned_cpo_user_id/);
    });

    it('refuses to deploy a CPO whose agent record is not yet approved', async () => {
      mockDb.qOne.mockResolvedValueOnce({call_sign: 'CPO-7', status: 'DOCS_PENDING'});
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'Black suit'}),
      ).rejects.toThrow('cpo_not_approved_for_deployment');
    });
  });

  // Q7/Q10 (founder, 2026-08-08) — role changes widened from OWNER-only to
  // owner + any UNSCOPED manager, with two hard lines: the owner is
  // untouchable, and only the MANAGER pivot is a role change (cpo ⇄ employee
  // would silently swap the member's app shell).
  describe('setMemberRole (Q7/Q10)', () => {
    it('SEC: nobody can target the ORG OWNER — not even the owner account itself', async () => {
      await expect(
        service.setMemberRole(ORG, ORG, 'manager', ORG),
      ).rejects.toThrow('cannot_modify_org_owner');
      expect(mockDb.q).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE org_members'), expect.anything());
    });

    it('SEC: a branch-SCOPED manager cannot change roles', async () => {
      await expect(
        service.setMemberRole(ORG, 'emp-1', 'manager', 'mgr-1', 'Operations'),
      ).rejects.toThrow('scoped_manager_cannot_change_roles');
    });

    it('an UNSCOPED manager promotes an employee to manager (channels reseeded as admin)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'employee', status: 'active'}) // target row
        .mockResolvedValueOnce({member_role: 'manager'})                    // conditional UPDATE claim
        .mockResolvedValueOnce({member_role: 'manager'});                   // sync's role re-read
      const r = await service.setMemberRole(ORG, 'emp-1', 'manager', 'mgr-1', null);
      expect(r.member_role).toBe('manager');
      const update = mockDb.qOne.mock.calls.find(c => /UPDATE org_members SET member_role/.test(c[0] as string));
      // Conditional on the role we READ — the concurrency claim (MEDIUM-2).
      expect(update?.[1]).toEqual([ORG, 'emp-1', 'manager', 'employee']);
    });

    // Round-2 (critic MEDIUM-2): a manager who could unmake a peer could then
    // suspend them — demote of a MANAGER is owner-only. Promote stays open to
    // unscoped managers ("assign other as admin" — founder).
    it('SEC: a manager cannot demote a PEER manager (demote→suspend escalation)', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'manager', status: 'active'});
      await expect(
        service.setMemberRole(ORG, 'mgr-2', 'employee', 'mgr-1', null),
      ).rejects.toThrow('only_org_owner_can_demote_managers');
    });

    it('the OWNER demotes a non-CPO manager back to employee', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce(null)                       // no managed-CPO agents row
        .mockResolvedValueOnce({member_role: 'employee'}); // conditional UPDATE claim
      const r = await service.setMemberRole(ORG, 'mgr-2', 'employee', ORG);
      expect(r.member_role).toBe('employee');
    });

    // Round-3: the demote target is the SERVER's decision — the caller's
    // non-manager value means only "demote". Three rounds each broke a
    // different persona letting a caller-side rule pick the role (tenant rule
    // corrupted agency back-office staff; the client's unscoped agent_status
    // diverged for an independent CPO invited into a workspace and made them
    // undemotable). A managed-CPO agents row OF THIS ORG (minted only by
    // createManagedCpo) means 'cpo'; everyone else means 'employee' —
    // whatever the request said.
    it('SEC: demoting a NON-CPO manager "to cpo" WRITES employee (server substitutes)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce(null)                        // no managed-CPO agents row
        .mockResolvedValueOnce({member_role: 'employee'});  // conditional UPDATE claim
      const r = await service.setMemberRole(ORG, 'mgr-2', 'cpo', ORG);
      expect(r.member_role).toBe('employee');
      const update = mockDb.qOne.mock.calls.find(c => /UPDATE org_members SET member_role/.test(String(c[0])));
      expect(update?.[1]).toEqual([ORG, 'mgr-2', 'employee', 'manager']);
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.role',
        expect.objectContaining({metadata: {from: 'manager', to: 'employee'}}));
    });

    it('SEC: demoting a managed-CPO manager "to employee" WRITES cpo (server substitutes)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce({user_id: 'mgr-2'})     // managed-CPO agents row of this org
        .mockResolvedValueOnce({member_role: 'cpo'});  // conditional UPDATE claim
      const r = await service.setMemberRole(ORG, 'mgr-2', 'employee', ORG);
      expect(r.member_role).toBe('cpo');
      const update = mockDb.qOne.mock.calls.find(c => /UPDATE org_members SET member_role/.test(String(c[0])));
      expect(update?.[1]).toEqual([ORG, 'mgr-2', 'cpo', 'manager']);
    });

    it('a lost concurrency claim surfaces as a conflict, with NO channel sweep', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'employee', status: 'active'})
        .mockResolvedValueOnce(null); // conditional UPDATE matched nothing
      await expect(
        service.setMemberRole(ORG, 'emp-1', 'manager', ORG),
      ).rejects.toThrow('role_changed_concurrently');
      expect(mockDept.addMember).not.toHaveBeenCalled();
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    it('refuses cpo → employee (would strip the CPO shell sideways)', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'active'});
      await expect(
        service.setMemberRole(ORG, 'cpo-1', 'employee', ORG),
      ).rejects.toThrow('role_change_not_allowed');
    });

    it('refuses employee → cpo (would flip them INTO the CPO shell)', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'employee', status: 'active'});
      await expect(
        service.setMemberRole(ORG, 'emp-1', 'cpo', ORG),
      ).rejects.toThrow('role_change_not_allowed');
    });

    it('refuses a role change on a non-active member', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'employee', status: 'suspended'});
      await expect(
        service.setMemberRole(ORG, 'emp-1', 'manager', ORG),
      ).rejects.toThrow('member_not_active');
    });
  });

  // ─── B-417 — stranded crypto-claims detection (report-only, never frees) ──
  // A demoted/suspended/removed member who holds Ops Room crypto claims
  // (B-416) strands those rooms. Claims are deliberately NOT auto-freed
  // (B-416 review: fork surface); this lane detects + reports instead.
  describe('B-417 — stranded crypto-claims detection', () => {
    const notOnMission = () => mockDb.qOne.mockResolvedValueOnce({on_mission: false});
    const CLAIMS_ROWS = [{conversation_id: 'room-1'}, {conversation_id: 'room-2'}];
    const claimsQ = (rows: Array<{conversation_id: string}>) =>
      mockDb.q.mockImplementation((sql: string) =>
        /dispatch_room_crypto_claims/.test(String(sql))
          ? Promise.resolve(rows)
          : Promise.resolve([]));

    it('DEMOTE returns the stranded room ids AND writes the explicit audit row (OrgAuditService is the mocked blind spot — args asserted, not just called)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce(null)                       // no managed-CPO agents row
        .mockResolvedValueOnce({member_role: 'employee'}); // conditional UPDATE claim
      claimsQ(CLAIMS_ROWS);
      const r = await service.setMemberRole(ORG, 'mgr-2', 'employee', ORG);
      expect(r.stranded_room_claims).toEqual(['room-1', 'room-2']);
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.crypto_claims_stranded',
        expect.objectContaining({
          targetKind: 'user', targetId: 'mgr-2',
          metadata: {trigger: 'demote', rooms: ['room-1', 'room-2']},
        }));
      // Pin the helper's SQL shape: member-scoped claimed_by + the org-scoped
      // intents EXISTS (the completeness argument rides on both).
      const call = mockDb.q.mock.calls.find(c => /dispatch_room_crypto_claims/.test(String(c[0])));
      expect(String(call?.[0])).toMatch(/claimed_by = \$2/);
      expect(String(call?.[0])).toMatch(/EXISTS[\s\S]*dispatch_room_intents[\s\S]*org_user_id = \$1/);
      expect(call?.[1]).toEqual([ORG, 'mgr-2']);
    });

    it('DEMOTE with no claims → empty list, NO stranded audit row', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({member_role: 'employee'});
      const r = await service.setMemberRole(ORG, 'mgr-2', 'employee', ORG);
      expect(r.stranded_room_claims).toEqual([]);
      expect(mockOrgAudit.log).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), 'member.crypto_claims_stranded', expect.anything());
    });

    it('a PROMOTE never runs the claims check', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'employee', status: 'active'})
        .mockResolvedValueOnce({member_role: 'manager'});
      const r = await service.setMemberRole(ORG, 'emp-1', 'manager', ORG);
      expect(r.stranded_room_claims).toEqual([]);
      expect(mockDb.q.mock.calls.some(c => /dispatch_room_crypto_claims/.test(String(c[0])))).toBe(false);
    });

    it('SUSPEND returns the ids with trigger "suspended"', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG}); // status update ok
      claimsQ(CLAIMS_ROWS);
      const r = await service.setMemberStatus(ORG, 'mgr-2', 'suspended', ORG, {reason: 'x'});
      expect(r.stranded_room_claims).toEqual(['room-1', 'room-2']);
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.crypto_claims_stranded',
        expect.objectContaining({metadata: {trigger: 'suspended', rooms: ['room-1', 'room-2']}}));
    });

    it('REMOVE returns the ids with trigger "removed"; REINSTATE never checks', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      claimsQ(CLAIMS_ROWS);
      const removed = await service.setMemberStatus(ORG, 'mgr-2', 'removed', ORG);
      expect(removed.stranded_room_claims).toEqual(['room-1', 'room-2']);
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.crypto_claims_stranded',
        expect.objectContaining({metadata: {trigger: 'removed', rooms: ['room-1', 'room-2']}}));

      jest.clearAllMocks();
      mockOrgAudit.log.mockResolvedValue(undefined);
      mockDb.q.mockResolvedValue([]);
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      const reinstated = await service.setMemberStatus(ORG, 'mgr-2', 'active', ORG);
      expect(reinstated.stranded_room_claims).toEqual([]);
      expect(mockDb.q.mock.calls.some(c => /dispatch_room_crypto_claims/.test(String(c[0])))).toBe(false);
    });

    it('a FAILING claims check never fails the roster change (best-effort)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({member_role: 'employee'});
      mockDb.q.mockImplementation((sql: string) =>
        /dispatch_room_crypto_claims/.test(String(sql))
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([]));
      const r = await service.setMemberRole(ORG, 'mgr-2', 'employee', ORG);
      expect(r.member_role).toBe('employee');
      expect(r.stranded_room_claims).toEqual([]);
    });

    it('READ-ONLY (extends the B-416 zero-UPDATE/DELETE pin): this service only ever SELECTs the claims table', () => {
      const {readFileSync} = require('node:fs') as typeof import('node:fs');
      const {join} = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, 'org-cpo.service.ts'), 'utf8');
      const mentions = src.match(/[^\n]*dispatch_room_crypto_claims[^\n]*/g) ?? [];
      expect(mentions.length).toBeGreaterThan(0);
      for (const line of mentions) {
        expect(line).not.toMatch(/UPDATE|DELETE|INSERT/i);
      }
    });
  });

  describe('setMemberStatus', () => {
    // Suspending now requires a reason (shown to the CPO at login) and first
    // asks whether they are on a live mission — that check burns a qOne.
    const SUSPEND = {reason: 'Repeated lateness'};
    const notOnMission = () => mockDb.qOne.mockResolvedValueOnce({on_mission: false});

    it('scopes the update to the org + member and throws when no row matched', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        service.setMemberStatus(ORG, 'not-mine', 'suspended', undefined, SUSPEND),
      ).rejects.toThrow('member_not_found_in_org');

      const [sql, params] = mockDb.qOne.mock.calls[1];
      expect(String(sql)).toMatch(/UPDATE org_members/i);
      expect(params.slice(0, 3)).toEqual([ORG, 'not-mine', 'suspended']);
    });

    it('removes a suspended CPO from every org channel (triggers rekey intent)', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});     // status update ok
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1'}, {id: 'ch-2'}]); // org owns 2 channels
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, SUSPEND);
      expect(mockDept.removeMember).toHaveBeenCalledTimes(2);
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-1', 'cpo-1', undefined);
      expect(mockDept.addMember).not.toHaveBeenCalled();
    });

    // D2 — a suspension with no reason is rejected before anything is written.
    it('rejects a suspension with no reason', async () => {
      notOnMission();
      await expect(
        service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, {reason: '  '}),
      ).rejects.toThrow('suspend_reason_required');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    // ── RANK (item 10) ────────────────────────────────────────────────
    // OrgManagerGuard admits ANY active manager of the org, and `actorId` used
    // to feed only the audit row — never authorization. So one manager could
    // suspend or remove a PEER manager, which revokes their sessions and pulls
    // them out of every org channel. The owner was safe only by accident (no
    // org_members row ⇒ the UPDATE matched nothing ⇒ 400).
    it("SEC: a manager cannot change the ORG OWNER's status", async () => {
      await expect(
        service.setMemberStatus(ORG, ORG, 'suspended', 'mgr-1', SUSPEND),
      ).rejects.toThrow('cannot_modify_org_owner');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('SEC: a manager cannot suspend a PEER manager', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'manager'}); // the target
      await expect(
        service.setMemberStatus(ORG, 'mgr-2', 'suspended', 'mgr-1', SUSPEND),
      ).rejects.toThrow('only_org_owner_can_change_manager_status');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    // Q7 — the rank rule protects PEER MANAGERS only. The old `!== 'cpo'`
    // form swept in 'employee' too, so a workspace co-admin could not suspend
    // or remove a plain employee — their whole roster job.
    it('Q7: a manager MAY suspend a workspace EMPLOYEE', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'employee'}); // rank check
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});        // status update ok
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1'}]);
      await service.setMemberStatus(ORG, 'emp-1', 'suspended', 'mgr-1', SUSPEND);
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalled();
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-1', 'emp-1', 'mgr-1');
    });

    it('SEC: a manager MAY still suspend a CPO', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo'});   // rank check
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});     // status update ok
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1'}]);            // one org channel
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', 'mgr-1', SUSPEND);
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalled();
      // The DISTINGUISHING actor pin (I-a review F1): mgr-1 ≠ ORG, so this
      // goes red if the auditActor threading is dropped — the ORG-actor
      // assertions elsewhere provably cannot tell threaded from fallback.
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-1', 'cpo-1', 'mgr-1');
    });

    it('SEC: the OWNER acting on their own org skips the rank gate entirely', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      await service.setMemberStatus(ORG, 'mgr-2', 'suspended', ORG, SUSPEND);
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalled();
    });

    // D4 — a CPO standing on a live detail must not be cut off mid-mission.
    it('refuses to suspend a CPO who is on a live mission', async () => {
      mockDb.qOne.mockResolvedValueOnce({on_mission: true});
      await expect(
        service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, SUSPEND),
      ).rejects.toThrow('member_on_live_mission');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    it('refuses to remove a CPO who is on a live mission', async () => {
      mockDb.qOne.mockResolvedValueOnce({on_mission: true});
      await expect(
        service.setMemberStatus(ORG, 'cpo-1', 'removed'),
      ).rejects.toThrow('member_on_live_mission');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('rejects an inverted suspension window', async () => {
      notOnMission();
      await expect(
        service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, {
          reason: 'x', from: '2026-08-10T00:00:00Z', until: '2026-08-01T00:00:00Z',
        }),
      ).rejects.toThrow('suspend_window_inverted');
    });

    it('rejects a suspension longer than a year', async () => {
      notOnMission();
      await expect(
        service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, {
          reason: 'x', from: '2026-01-01T00:00:00Z', until: '2027-06-01T00:00:00Z',
        }),
      ).rejects.toThrow('suspend_window_too_long');
    });

    it('persists the window and the acting manager', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo'});  // rank gate
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', 'mgr-9', {
        reason: 'Kit not returned', from: '2026-08-01T00:00:00Z', until: '2026-08-15T00:00:00Z',
      });
      const params = mockDb.qOne.mock.calls[2][1];
      expect(params[3]).toEqual(new Date('2026-08-01T00:00:00Z')); // suspended_from
      expect(params[4]).toEqual(new Date('2026-08-15T00:00:00Z')); // suspended_until
      expect(params[5]).toBe('Kit not returned');
      expect(params[6]).toBe('mgr-9');
    });

    it('re-adds a reinstated CPO to every org channel', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1', post_mode: 'read_only'}]);
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      // Scope v2 Phase 2 — the role is now derived PER CHANNEL from that
      // channel's post_mode (a fixed role meant `open` channels muted anyone who
      // joined the org later), and NO role_label is stamped: persisting 'CPO'
      // re-created the A7.3 defect Phase 0 removed, because the stored word wins
      // over the tenant's live noun.
      expect(mockDept.addMember).toHaveBeenCalledWith(ORG, 'ch-1', 'cpo-1', 'viewer', undefined, undefined);
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    // A normal CPO must NEVER be auto-joined into a managers-only channel — the
    // add-path SELECT must exclude restricted access AND incident channels (an
    // incident channel left at default 'standard' access is still managers-only).
    it('CPO add path excludes restricted access and incident channels', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG}); // status update; member_role lookup → undefined → viewer
      mockDb.q.mockResolvedValueOnce([]);                    // channels select (none)
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      const sel = mockDb.q.mock.calls.find(c => /FROM public\.department_channels/i.test(String(c[0])));
      expect(String(sel?.[0])).toMatch(/access IN \('standard', 'read_only'\)/);
      expect(String(sel?.[0])).toMatch(/channel_type <> 'incident'/);
    });

    // RS-01 — suspend/remove must instantly kill the CPO's live sessions so an
    // unexpired access token can't ride into /agents/* or the messenger relay.
    it('revokes all sessions of a suspended CPO', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]); // no channels
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', undefined, SUSPEND);
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('cpo-1');
    });

    it('revokes all sessions of a removed CPO', async () => {
      notOnMission();
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'removed');
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('cpo-1');
    });

    it('does NOT revoke sessions when reinstating (active)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });
  });

  describe('setMemberRole (RS-10 · cpo ⇄ manager)', () => {
    // Q7 flipped this pin: role changes are now owner + UNSCOPED managers
    // (founder: "multiple admins manage these things"). The boundary moved to
    // branch scope — a SCOPED manager is still refused (see the Q7/Q10
    // describe above), and an unscoped one proceeds to the member lookup.
    it('admits a non-owner UNSCOPED manager as far as the member lookup', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // target not in this org
      await expect(
        service.setMemberRole(ORG, 'cpo-1', 'manager', 'manager-user-9', null),
      ).rejects.toThrow('member_not_found_in_org');
      expect(mockDb.qOne).toHaveBeenCalled();
    });

    it('throws when the member is not in the caller org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        service.setMemberRole(ORG, 'not-mine', 'manager', ORG),
      ).rejects.toThrow('member_not_found_in_org');
    });

    it('refuses to change the role of a suspended/removed member', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'suspended'});
      await expect(
        service.setMemberRole(ORG, 'cpo-1', 'manager', ORG),
      ).rejects.toThrow('member_not_active');
    });

    it('is idempotent: same role → no update, no audit, no channel churn', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'active'});
      const out = await service.setMemberRole(ORG, 'cpo-1', 'cpo', ORG);
      expect(out).toEqual({member_role: 'cpo', stranded_room_claims: []});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockOrgAudit.log).not.toHaveBeenCalled();
    });

    it('promote: flips member_role, audits member.role, seeds channel admin everywhere', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'cpo', status: 'active'})
        .mockResolvedValueOnce({member_role: 'manager'})  // conditional UPDATE claim
        .mockResolvedValueOnce({member_role: 'manager'}); // sync's role re-read
      mockDb.q
        .mockResolvedValueOnce([{id: 'ch-open'}, {id: 'ch-restricted'}]); // ALL channels (admin add)

      const out = await service.setMemberRole(ORG, 'cpo-1', 'manager', ORG);
      expect(out).toEqual({member_role: 'manager', stranded_room_claims: []});

      const update = mockDb.qOne.mock.calls.find(c => /UPDATE org_members SET member_role/i.test(String(c[0])));
      expect(update?.[1]).toEqual([ORG, 'cpo-1', 'manager', 'cpo']);

      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.role', expect.objectContaining({
        targetId: 'cpo-1',
        metadata: {from: 'cpo', to: 'manager'},
      }));

      // Promotion joins EVERY channel (incl. restricted) as channel admin.
      expect(mockDept.addMember).toHaveBeenCalledTimes(2);
      // Promoted BY the org owner in this fixture — the audit actor rides through.
      expect(mockDept.addMember).toHaveBeenCalledWith(ORG, 'ch-restricted', 'cpo-1', 'admin', 'Manager', ORG);
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    it('demote: removes from restricted/incident channels (rekey seam) and downgrades open channels to viewer', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce({user_id: 'mgr-1'})   // managed-CPO agents row → 'cpo' is right
        .mockResolvedValueOnce({member_role: 'cpo'}); // conditional UPDATE claim
      mockDb.q
        .mockResolvedValueOnce([
          {id: 'ch-open', managers_only: false},
          {id: 'ch-restricted', managers_only: true},
          {id: 'ch-incident', managers_only: true},
        ]); // demote sweep select

      await service.setMemberRole(ORG, 'mgr-1', 'cpo', ORG);

      // Restricted/incident: hard remove → dept enqueues remove+rekey intents.
      // Trailing arg: the demoting actor (the org owner here) names the audit row.
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-restricted', 'mgr-1', ORG);
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-incident', 'mgr-1', ORG);
      // Open: keeps membership (and key), drops posting rights to viewer.
      // Q7/A7.3 — the stored 'Manager' label is CLEARED (null), never
      // overwritten with a tenant noun: the roster then renders the live noun
      // ("Member" on a workspace, "CPO" on an agency).
      expect(mockDept.updateMemberRole).toHaveBeenCalledWith(ORG, 'ch-open', 'mgr-1', 'viewer', null, ORG);
      expect(mockDept.addMember).not.toHaveBeenCalled();

      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.role', expect.objectContaining({
        metadata: {from: 'manager', to: 'cpo'},
      }));
    });

    it('demote sweep is best-effort: one channel failing does not abort the rest', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({member_role: 'manager', status: 'active'})
        .mockResolvedValueOnce({user_id: 'mgr-1'})   // managed-CPO agents row
        .mockResolvedValueOnce({member_role: 'cpo'}); // conditional UPDATE claim
      mockDb.q
        .mockResolvedValueOnce([
          {id: 'ch-a', managers_only: true},
          {id: 'ch-b', managers_only: true},
        ]);
      mockDept.removeMember
        .mockRejectedValueOnce(new Error('member_not_found'))
        .mockResolvedValueOnce({ok: true});

      const out = await service.setMemberRole(ORG, 'mgr-1', 'cpo', ORG);
      expect(out).toEqual({member_role: 'cpo', stranded_room_claims: []});
      expect(mockDept.removeMember).toHaveBeenCalledTimes(2);
    });
  });

  describe('listManagers / setManagerPermissions (owner Manager-Permissions screen)', () => {
    it('lists managers with permitted_modules defaulted to empty (not yet granted)', async () => {
      mockDb.q.mockResolvedValueOnce([
        {user_id: 'mgr-1', display_name: 'Alex', email: 'a@x.com', avatar_url: null, call_sign: 'M-1', status: 'active', permitted_modules: null},
        {user_id: 'mgr-2', display_name: 'Sam', email: 's@x.com', avatar_url: null, call_sign: 'M-2', status: 'active', permitted_modules: ['dept', 'earn']},
      ]);
      const out = await service.listManagers(ORG);
      expect(out).toEqual([
        expect.objectContaining({user_id: 'mgr-1', permitted_modules: []}),
        expect.objectContaining({user_id: 'mgr-2', permitted_modules: ['dept', 'earn']}),
      ]);
    });

    it('rejects a non-owner actor — a delegated manager cannot grant permissions', async () => {
      await expect(
        service.setManagerPermissions(ORG, 'mgr-1', ['dept'], 'manager-user-9'),
      ).rejects.toThrow('only_org_owner_can_change_permissions');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown module key without writing anything', async () => {
      await expect(
        service.setManagerPermissions(ORG, 'mgr-1', ['dept', 'not-a-real-module'], ORG),
      ).rejects.toThrow('unknown_module:not-a-real-module');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('replaces the full granted set (dedup) and returns the new value', async () => {
      mockDb.qOne.mockResolvedValueOnce({permitted_modules: ['dept', 'earn']});
      const out = await service.setManagerPermissions(ORG, 'mgr-1', ['dept', 'earn', 'dept'], ORG);
      expect(out).toEqual({ok: true, permitted_modules: ['dept', 'earn']});
      const call = mockDb.qOne.mock.calls[0];
      expect(call[1]).toEqual([ORG, 'mgr-1', ['dept', 'earn']]);
    });

    it('throws when the target is not an active manager in this org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        service.setManagerPermissions(ORG, 'not-a-manager', ['dept'], ORG),
      ).rejects.toThrow('manager_not_found');
    });
  });

  describe('member.* audit (RS-11)', () => {
    it('setMemberStatus writes a member.status org_audit row with the acting manager', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo'});  // rank gate (manager acting)
      mockDb.qOne.mockResolvedValueOnce({on_mission: false});   // live-mission gate
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', 'manager-user-2', {reason: 'No-show'});
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, 'manager-user-2', 'member.status', expect.objectContaining({
        targetId: 'cpo-1',
        metadata: expect.objectContaining({status: 'suspended', reason: 'No-show'}),
      }));
    });

    it('createManagedCpo writes a member.add org_audit row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-7'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      await service.createManagedCpo(ORG, dto, 'manager-user-2');
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, 'manager-user-2', 'member.add', expect.objectContaining({
        targetId: 'new-cpo-7',
        metadata: {member_role: 'cpo'},
      }));
    });

    it('audit failure never breaks the roster mutation (best-effort)', async () => {
      mockOrgAudit.log.mockRejectedValue(new Error('audit db down'));
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(service.setMemberStatus(ORG, 'cpo-1', 'active')).resolves.toEqual({stranded_room_claims: []});
    });
  });

  describe('getCapacity (Step 20)', () => {
    it('computes free = total − busy − reserved (never negative) + surfaces on-duty/active', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({total: '6', busy: '2', reserved: '1', on_duty: '3', active: '2', completed: '17'})
        .mockResolvedValueOnce({rating: '4.75'});   // the ORG's rating roll-up
      const cap = await service.getCapacity(ORG);
      expect(cap).toEqual({
        guards_total: 6, guards_free: 3, guards_on_duty: 3, active_missions: 2,
        org_rating: 4.75, org_jobs_total: 17,
      });
    });

    it('COUNTS completed missions instead of trusting the agents.jobs_total counter', async () => {
      // Founder report: "it says 2 jobs, the company completed a lot." That
      // counter is bumped in ONE place (settleBooking), so it only counts jobs
      // that reached settlement — production had jobs_total = 2 against 16
      // completed missions and zero mission_payouts rows. Both the owner and
      // the manager read this same field, so both were wrong.
      mockDb.qOne
        .mockResolvedValueOnce({total: '2', busy: '0', reserved: '0', on_duty: '1', active: '0', completed: '16'})
        .mockResolvedValueOnce({rating: '5.00', jobs_total: 2}); // stale counter must be IGNORED
      const cap = await service.getCapacity(ORG);
      expect(cap.org_jobs_total).toBe(16);
    });

    it('counts COMPLETED missions for bookings assigned to this org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await service.getCapacity(ORG);
      const sql = mockDb.qOne.mock.calls[0][0] as string;
      expect(sql).toMatch(/m\.status = 'COMPLETED'\)[\s\S]*?AS completed/);
      expect(sql).toContain('b.assigned_provider_user_id = $1');
      // The rating roll-up is still read from the agents row (it is accurate —
      // it runs on the rating-submission path, not on settlement).
      expect(mockDb.qOne.mock.calls[1][0]).toContain('SELECT rating FROM agents');
    });

    it('clamps free to 0 when reservations exceed roster', async () => {
      mockDb.qOne.mockResolvedValueOnce({total: '2', busy: '1', reserved: '5', on_duty: '0', active: '1'});
      const cap = await service.getCapacity(ORG);
      expect(cap.guards_free).toBe(0);
      expect(cap.guards_total).toBe(2);
    });

    it('defaults to zeros when the agency has no roster row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const cap = await service.getCapacity(ORG);
      expect(cap).toEqual({
        guards_total: 0, guards_free: 0, guards_on_duty: 0, active_missions: 0,
        org_rating: null, org_jobs_total: 0,
      });
    });
  });

  describe('listMemberMissionHistory (MISSION-HISTORY · IDOR gate)', () => {
    it('throws ForbiddenException when the member is not in the caller org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // org_members membership gate misses
      await expect(service.listMemberMissionHistory(ORG, 'outsider-cpo'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockDb.q).not.toHaveBeenCalled(); // never reaches the history query
    });

    it('returns the org-scoped history (tenancy predicate present) when the member belongs to the org', async () => {
      mockDb.qOne.mockResolvedValueOnce({ok: 1}); // gate passes
      mockDb.q.mockResolvedValueOnce([
        {mission_id: 'm1', booking_id: 'b1', short_code: 'MSN-1', status: 'COMPLETED',
         role: 'LEAD', is_lead: true, started_at: null, ended_at: null,
         route_distance_m: 1000, route_duration_s: 600,
         pickup_address: 'A', dropoff_address: 'B', region_label: 'AE', paid_credits: '250'},
      ]);
      const res = await service.listMemberMissionHistory(ORG, 'cpo-1');
      expect(res).toHaveLength(1);
      expect(res[0].paid_credits).toBe(250); // Number-coerced
      const sql = (mockDb.q.mock.calls.find((c: unknown[]) => /FROM mission_crew mc/.test(c[0] as string)) ?? [''])[0] as string;
      expect(sql).toMatch(/assigned_provider_user_id = \$1/);
    });
  });

  describe('listRoster (MISSION-HISTORY · completed count)', () => {
    it('surfaces missions_completed per member', async () => {
      mockDb.q.mockResolvedValueOnce([]); // expiry sweep: nothing lapsed
      mockDb.q.mockResolvedValueOnce([
        {member_user_id: 'cpo-1', display_name: 'A', email: null, call_sign: 'A1',
         member_role: 'cpo', status: 'active', agent_status: 'APPROVED',
         missions_completed: 4, created_at: new Date()},
      ]);
      const res = await service.listRoster(ORG);
      expect(res[0].missions_completed).toBe(4);
    });
  });

  // Bug fix — the org owner has no org_members row (they ARE the org), so
  // requesting their own profile via the roster-scoped query always threw
  // 'not_your_org_member'. Every roster member/manager got a real profile
  // screen from a chat sender tap or the org chart; the owner hit a dead end
  // (blank error text / no "View full profile" option). getMemberProfile now
  // branches to a public.users-only lookup when memberUserId === orgUserId.
  describe('getMemberProfile — owner branch', () => {
    it('serves the owner\'s own identity from public.users instead of the org_members-scoped query', async () => {
      const createdAt = new Date('2025-01-01T00:00:00Z');
      mockDb.q.mockResolvedValueOnce([]); // expiry sweep: nothing lapsed
      mockDb.qOne.mockResolvedValueOnce({
        member_user_id: ORG, display_name: 'Founder Corp', email: 'founder@corp.example',
        phone_e164: '+15555550100', avatar_url: null, created_at: createdAt,
      });
      const res = await service.getMemberProfile(ORG, ORG);
      expect(res.member_role).toBe('owner');
      expect(res.display_name).toBe('Founder Corp');
      expect(res.email).toBe('founder@corp.example');
      expect(res.stats.missions_total).toBe(0);
      // Never touched the org_members-scoped roster query.
      const sql = (mockDb.qOne.mock.calls[0] ?? [''])[0] as string;
      expect(sql).not.toMatch(/FROM org_members/);
    });

    it('throws NotFoundException when the owner account itself is gone', async () => {
      mockDb.q.mockResolvedValueOnce([]); // expiry sweep
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.getMemberProfile(ORG, ORG)).rejects.toThrow(/org_not_found/);
    });

    it('still uses the roster-scoped query for a real member (unchanged behaviour)', async () => {
      mockDb.q.mockResolvedValueOnce([]); // expiry sweep
      mockDb.qOne.mockResolvedValueOnce(null); // roster row missing
      await expect(service.getMemberProfile(ORG, 'cpo-1')).rejects.toThrow(/not_your_org_member/);
      const sql = (mockDb.qOne.mock.calls[0] ?? [''])[0] as string;
      expect(sql).toMatch(/FROM org_members/);
    });
  });
});
