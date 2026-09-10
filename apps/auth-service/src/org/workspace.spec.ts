/**
 * Scope v2 Phase 6 — A5 "Create Org Workspace", and the owner it mints.
 *
 * THE DECISION THIS PINS. The only pre-existing way to become an org owner was
 * `POST /agents` with type='company', which flips the caller to
 * `role='service_provider'` — the security-services funnel, which routes them to
 * the provider home and the job marketplace. An Enterprise company that wants
 * internal department channels is not an agency (owner-decided 2026-08-04), so
 * this path must mint an owner WITHOUT that role grant.
 *
 * That is an ABSENCE, so it is asserted as one: no agents insert, no users
 * update, no role string anywhere in the service.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from './org-audit.service';
import {WorkspaceService} from './workspace.service';
import {DepartmentService} from '../department/department.service';
import {deriveAccountKind, type AccountKindRow} from '../auth/account-kind';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn().mockResolvedValue(undefined)};
const mockDept = {seedOrgWorkspace: jest.fn().mockResolvedValue({created: 4})};
const OWNER = 'user-1';

function source(rel: string): string {
  return readFileSync(join(process.cwd(), 'src', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

/** A bare individual row — the shape a workspace owner actually has. */
function row(over: Partial<AccountKindRow> = {}): AccountKindRow {
  return {
    user_role: 'user', agent_type: null, agent_status: null,
    managed_by_org_id: null, member_role: null, member_status: null,
    org_user_id: null, org_name: null, password_set_at: null,
    user_id: OWNER, owns_workspace: false, workspace_name: null,
    ...over,
  };
}

describe('WorkspaceService', () => {
  let svc: WorkspaceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset().mockResolvedValue([]);
    mockDb.qOne.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: DepartmentService, useValue: mockDept},
      ],
    }).compile();
    svc = module.get(WorkspaceService);
  });

  describe('A5 — creating the workspace', () => {
    it('creates one owned by the CALLER, and audits it', async () => {
      // The tier gate reads first — creating a workspace needs an ACTIVE
      // enterprise subscription (owner-decided 2026-08-04).
      mockDb.qOne.mockResolvedValueOnce({id: OWNER});
      mockDb.qOne
        .mockResolvedValueOnce(null)                                        // not a company agent
        .mockResolvedValueOnce(null)                                        // none yet
        .mockResolvedValueOnce({owner_user_id: OWNER, name: 'Acme', created_at: 'now'});
      const out = await svc.createWorkspace(OWNER, 'Acme');
      expect(out.owner_user_id).toBe(OWNER);
      // calls[0] = tier gate, [1] = company-agent refusal read, [2] = existing-
      // workspace read, [3] = INSERT.
      expect(mockDb.qOne.mock.calls[3][1]).toEqual([OWNER, 'Acme']);
      expect(mockAudit.log).toHaveBeenCalledWith(
        OWNER, OWNER, 'org.workspace.create', expect.anything());
    });

    it('trims the name, and refuses one that is only whitespace', async () => {
      // The tier gate reads first — creating a workspace needs an ACTIVE
      // enterprise subscription (owner-decided 2026-08-04).
      mockDb.qOne.mockResolvedValueOnce({id: OWNER});
      mockDb.qOne
        .mockResolvedValueOnce(null) // not a company agent
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({owner_user_id: OWNER, name: 'Acme', created_at: 'now'});
      await svc.createWorkspace(OWNER, '  Acme  ');
      expect(mockDb.qOne.mock.calls[3][1][1]).toBe('Acme');

      // A blank name is refused BEFORE any query — not even the tier read runs.
      await expect(svc.createWorkspace(OWNER, '   ')).rejects.toThrow(BadRequestException);
    });

    /**
     * NOT idempotent-by-silence. Quietly returning the existing row would leave
     * the user looking at a workspace called something they never typed, with
     * no error to explain it.
     */
    it('CONFLICTS on a second create rather than silently keeping the first', async () => {
      // The tier gate reads first — creating a workspace needs an ACTIVE
      // enterprise subscription (owner-decided 2026-08-04).
      mockDb.qOne.mockResolvedValueOnce({id: OWNER});
      mockDb.qOne
        .mockResolvedValueOnce(null) // not a company agent
        .mockResolvedValueOnce({owner_user_id: OWNER, name: 'First', created_at: 'x'});
      await expect(svc.createWorkspace(OWNER, 'Second')).rejects.toThrow(ConflictException);
      // …and it never attempted the insert.
      const sqls = mockDb.qOne.mock.calls.map(c => String(c[0]));
      expect(sqls.some(s => /INSERT INTO public\.org_workspaces/.test(s))).toBe(false);
    });

    it('treats losing the create race as a conflict, not a crash', async () => {
      // The tier gate reads first — creating a workspace needs an ACTIVE
      // enterprise subscription (owner-decided 2026-08-04).
      mockDb.qOne.mockResolvedValueOnce({id: OWNER});
      mockDb.qOne
        .mockResolvedValueOnce(null)   // not a company agent
        .mockResolvedValueOnce(null)   // looked clear…
        .mockResolvedValueOnce(null);  // …but ON CONFLICT DO NOTHING returned nothing
      await expect(svc.createWorkspace(OWNER, 'Acme')).rejects.toThrow(ConflictException);
    });

    // Round-3 (edge #1): a COMPANY AGENT is already an org — a workspace row
    // on top would be a second org identity that (since the round-2 fixes)
    // also rewrites the agency's role semantics and vocabulary. Refused, the
    // same way the join lane refuses workspace_owner_cannot_join.
    it('SEC: a company agent cannot create a workspace over its agency', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: OWNER});         // tier gate passes
      mockDb.qOne.mockResolvedValueOnce({user_id: OWNER});    // agents.type='company' row
      await expect(svc.createWorkspace(OWNER, 'Shadow Org'))
        .rejects.toThrow('provider_account_cannot_own_workspace');
      const sqls = mockDb.qOne.mock.calls.map(c => String(c[0]));
      expect(sqls.some(s => /INSERT INTO public\.org_workspaces/.test(s))).toBe(false);
    });
  });

  /**
   * THE BLOCKER round 3 found. `owns_workspace` let the owner INTO the
   * workspace; nothing let them ADMINISTER it. They have no agents row and no
   * org_members row, so all three original OrgManagerGuard arms reported false —
   * and the owner 403'd on the entire roster + corrections surface, channel
   * management, attendance admin, and the join-approval inbox. An Enterprise
   * workspace nobody can administer is not a workspace.
   *
   * `resolveIsOrgManager` exists to PREDICT what that guard admits, so the two
   * are asserted against each other rather than separately — any divergence
   * between them is a bug by construction.
   */
  describe('the owner can ADMINISTER the workspace, not just enter it', () => {
    const guardSrc = source(join('org', 'org-manager.guard.ts'));
    const kindSrc = source(join('auth', 'account-kind.ts'));

    it('OrgManagerGuard has an owner arm', () => {
      expect(guardSrc).toMatch(/FROM public\.org_workspaces w/);
      // Org-wide, exactly like the company-agent arm: an owner is not
      // branch-scoped, so a null department here is the answer, not an omission.
      expect(guardSrc).toMatch(/org_user_id: claims\.sub, department: null/);
    });

    it('resolveIsOrgManager mirrors it, so the client surfaces match', () => {
      expect(kindSrc).toMatch(/FROM public\.org_workspaces w/);
      expect(kindSrc).toMatch(/row\.is_owner/);
    });

    /**
     * BOTH must lapse. An early draft put the owner arm before the tier arm and
     * left expiry to the latter — which never runs, because the owner arm
     * returns first. A lapsed owner would have kept full admin forever.
     */
    it('BOTH the guard arm and the mirror are lapse-aware', () => {
      for (const src of [guardSrc, kindSrc]) {
        // Anchor on the ALIAS. Plain `public.org_workspaces` first appears in
        // ACCOUNT_KIND_SQL's LEFT JOIN, so slicing on it read the wrong block
        // and the assertion passed for the wrong reason — this test caught
        // itself. `FROM public.org_workspaces w` is unique to the manager arms.
        const at = src.indexOf('FROM public.org_workspaces w');
        expect(at).toBeGreaterThan(-1);
        const block = src.slice(at, at + 500);
        // The rule now lives in ONE fragment, so the assertion is that this arm
        // CALLS it — not that it restates it. Restating it is the defect.
        expect(block).toMatch(/activeEnterpriseSql\(/);
      }
    });

    /**
     * …and so is the CLIENT-facing flag, or the two disagree about the same
     * person: the client still shows the workspace while the server refuses
     * every manager route, with employees already inside it.
     */
    it('the client-facing owns_workspace lapses the same way', () => {
      const sql = kindSrc.slice(kindSrc.indexOf('ACCOUNT_KIND_SQL'));
      const flag = sql.slice(sql.indexOf('AS owns_workspace') - 400, sql.indexOf('AS owns_workspace'));
      // Same rule, same fragment, and aliased to the users row this SELECT
      // already joined — a different alias here would silently read NULL.
      expect(flag).toMatch(/activeEnterpriseSql\('u'\)/);
    });

    /**
     * ONE ACTIVE-ENTERPRISE RULE, NOT SIX.
     *
     * Before this was extracted the formula existed in six places —
     * `owns_workspace`, `is_owner` and `is_enterprise` in ACCOUNT_KIND_SQL,
     * OrgManagerGuard's owner arm, WorkspaceService's create gate, and
     * `effectiveTierOf`. The sharpest instance was inside ONE function:
     * OrgManagerGuard Path 1b inlined the SQL while Path 3, twelve lines below,
     * called `effectiveTierOf`.
     *
     * Nothing had drifted. The trigger is a tier change — a grace period, an
     * `enterprise_trial`, a rename of `pro_active_until` — where the natural
     * edit is `effectiveTierOf`, and the SQL copies silently keep the old rule.
     *
     * A UNIT TEST CANNOT SEE COPY N+1, which is the entire reason this is a
     * scan: it fails on the copy that has not been written yet.
     */
    it('the active-enterprise rule is written in exactly ONE place', () => {
      const ROOT = join(process.cwd(), 'src');
      const files = [
        join('auth', 'account-kind.ts'),
        join('org', 'org-manager.guard.ts'),
        join('org', 'workspace.service.ts'),
        join('attendance', 'roster.service.ts'),
        join('attendance', 'attendance.service.ts'),
      ];
      for (const rel of files) {
        const body = source(rel);
        expect({file: rel, hits: (body.match(/subscription_tier = 'enterprise'/g) ?? []).length})
          .toEqual({file: rel, hits: 0});
      }

      // …and the one place it DOES live is the shared fragment, which must
      // still carry both halves of the rule (tier AND the lapse window).
      const tier = readFileSync(join(ROOT, 'common', 'guards', 'tier.guard.ts'), 'utf8')
        .replace(/\r\n/g, '\n');
      const fn = tier.slice(tier.indexOf('export function activeEnterpriseSql'));
      const body = fn.slice(0, fn.indexOf('\n}'));
      expect(body).toMatch(/subscription_tier = 'enterprise'/);
      expect(body).toMatch(/pro_active_until IS NULL OR .*pro_active_until > NOW\(\)/);
    });

    it('creating a workspace REQUIRES an active enterprise subscription', () => {
      const svcSrc = source(join('org', 'workspace.service.ts'));
      expect(svcSrc).toMatch(/enterprise_subscription_required/);
      // Without this the route is a self-serve way past the paid gate:
      // owns_workspace is checked FIRST in the client's isOrgAffiliated.
      expect(svcSrc).toMatch(/activeEnterpriseSql\(/);
    });
  });

  /**
   * FOUND BY ADVERSARIAL QA AGAINST THE LIVE API — none of these were
   * reachable by any test in this repo, which is the point of pinning them.
   */
  describe('defects found only against a real database', () => {
    /**
     * A malformed path param reached Postgres and 500'd with
     * `invalid input syntax for type uuid`. Four routes were affected. The
     * pipe turns it into a clean 400 BEFORE any query runs — same class as
     * the referral-link audit bug, one layer up.
     */
    it('every UUID path param is validated by a pipe, not by Postgres', () => {
      const files = [
        join('department', 'enterprise-join.controller.ts'),
        join('attendance', 'roster.controller.ts'),
      ];
      let checked = 0;
      for (const rel of files) {
        const src = source(rel);
        // Every @Param that feeds a uuid column must name the pipe. `code` is
        // a TEXT column and is deliberately exempt.
        const params = src.match(/@Param\([^)]*\)/g) ?? [];
        expect(params.length).toBeGreaterThan(0);
        for (const pm of params) {
          if (/'code'/.test(pm)) {continue;}
          checked++;
          expect(pm).toMatch(/ParseUUIDPipe/);
        }
      }
      expect(checked).toBeGreaterThanOrEqual(4);
    });

    /**
     * THE COMPANY'S NAME, NOT THE FOUNDER'S. `org.display_name` is the owner
     * USER's name, so every employee saw a person's name as their company —
     * and applicants saw it before joining, which is also a privacy leak.
     * The pre-existing `ws` join is the CALLER's workspace, NULL for every
     * employee, so the fallback never fired. `orgws` joins the ORG's.
     */
    it('org_name comes from the WORKSPACE, falling back to the user', () => {
      const src = source(join('auth', 'account-kind.ts'));
      expect(src).toMatch(/COALESCE\(orgws.name, org.display_name\) AS org_name/);
      // joined on the RESOLVED ORG, not on the caller — that distinction IS
      // the bug. Phase B widened the resolution to the four-arm precedence
      // (managed > agency membership > own active workspace > workspace
      // membership), but the join stays keyed on that resolved-org COALESCE,
      // never bare u.id.
      expect(src).toMatch(/orgws.owner_user_id = COALESCE\(a.managed_by_org_id,/);
      expect(src).not.toMatch(/orgws.owner_user_id = u.id/);
      // the caller's own workspace join must still exist; it drives owns_workspace
      expect(src).toMatch(/ws.owner_user_id = u.id/);
    });

    it('the applicant-facing referral resolve shows the workspace name too', () => {
      const src = source(join('department', 'enterprise-join.service.ts'));
      expect(src).toMatch(/COALESCE\(w.name, u.display_name\) AS org_name/);
      expect(src).toMatch(/LEFT JOIN public.org_workspaces w ON w.owner_user_id = l.org_user_id/);
    });

    /**
     * TRUNCATE fires neither UPDATE nor DELETE row triggers, so one statement
     * wiped the whole HR audit trail while the table claimed append-only.
     */
    it('the corrections trail also survives TRUNCATE', () => {
      const mig = readFileSync(
        join(process.cwd(), '..', '..', 'supabase', 'migrations',
             '20260804030000_attendance_corrections_block_truncate.sql'),
        'utf8').replace(/\r\n/g, '\n');
      // STRIP COMMENTS FIRST. The migration's own prose explains why FOR EACH
      // ROW is wrong, so the file CONTAINS the phrase 'FOR EACH STATEMENT' —
      // a naive scan passed on the explanation while the code said ROW.
      // Caught by mutation; it is the trap CLAUDE.md names as the most common
      // false result in this repo.
      const code = mig.split(/\r?\n/)
        .filter(l => !l.trim().startsWith('--')).join('\n');
      expect(code).toMatch(/BEFORE TRUNCATE ON public\.attendance_corrections/);
      expect(code).toMatch(/FOR EACH STATEMENT/);
      expect(code).not.toMatch(/FOR EACH ROW/);
    });
  });

  describe('the owner is NOT an agency — the whole point of this path', () => {
    const svcSrc = source(join('org', 'workspace.service.ts'));

    it('never creates an agent or touches the user role', () => {
      // The scan must be reading the real file, or every absence below is vacuous.
      expect(svcSrc).toMatch(/INSERT INTO public\.org_workspaces/);
      expect(svcSrc).not.toMatch(/INSERT INTO agents/);
      expect(svcSrc).not.toMatch(/UPDATE\s+(public\.)?users/);
      expect(svcSrc).not.toMatch(/service_provider/);
    });

    it('is behind the rollout flag, like every other v2 route', () => {
      const ctl = source(join('org', 'workspace.controller.ts'));
      const guards = ctl.match(/@UseGuards\(([^)]*)\)/)?.[1] ?? '';
      expect(guards).toMatch(/\bJwtAuthGuard\b/);
      expect(guards).toMatch(/\bDeptChatV2Guard\b/);
    });

    it('takes the owner from the TOKEN, never from the body', () => {
      const ctl = source(join('org', 'workspace.controller.ts'));
      expect(ctl).toMatch(/createWorkspace\(user\.sub,/);
      // An owner field on the body would let a caller mint someone else's org.
      expect(ctl).not.toMatch(/dto\.owner/);
    });
  });

  /**
   * THE GATE BLOCKER 2 NAMES. A workspace owner has no agents row and no
   * org_members row, so `account_kind` is 'individual' and `org` used to resolve
   * to null — the person who just created the workspace could not enter it.
   */
  describe('deriveAccountKind — the workspace owner', () => {
    it('stays an INDIVIDUAL, not an agency', () => {
      const r = deriveAccountKind(row({owns_workspace: true, workspace_name: 'Acme'}));
      expect(r.account_kind).toBe('individual');
      expect(r.owns_workspace).toBe(true);
    });

    it('resolves the org to THEMSELVES, so the workspace is not empty', () => {
      const r = deriveAccountKind(row({owns_workspace: true, workspace_name: 'Acme'}));
      expect(r.org).toEqual({id: OWNER, name: 'Acme'});
    });

    it('does NOT invent an org for an individual with no workspace', () => {
      expect(deriveAccountKind(row()).org).toBeNull();
      expect(deriveAccountKind(row()).owns_workspace).toBe(false);
    });

    /** A membership must still win — an owner-of-A who is a CPO of B is a CPO of B. */
    it('never overrides a real membership with self-as-org', () => {
      const r = deriveAccountKind(row({
        owns_workspace: true, workspace_name: 'Acme',
        member_role: 'cpo', member_status: 'active',
        org_user_id: 'org-B', org_name: 'B Ltd',
      }));
      expect(r.org).toEqual({id: 'org-B', name: 'B Ltd'});
      expect(r.account_kind).toBe('cpo');
    });
  });
});

/**
 * FOUND ON STAGING 2026-08-05 — not by any of the 2,208 unit tests.
 *
 * A brand-new Enterprise workspace came up completely EMPTY: no default
 * channels, and no `#broadcast`. Frame A9 says #broadcast exists at every
 * level, and the owner's first sight of the product they had just paid for was
 * a blank list.
 *
 * `seedOrgWorkspace` already did exactly this job — but its ONLY caller was the
 * service-provider funnel in `agent.service.ts`, where a company agent is
 * minted. Phase 6 added a SECOND way to become an org (this route) and wired
 * none of it.
 *
 * That is this scope's signature defect, in its purest form: the rule lives on
 * the one creation path that existed when it was written, and is absent on the
 * new one. F5's migration repaired orgs that already had channels and
 * `createChannel` covers channels made from now on — a workspace with NEITHER
 * fell straight between them, which is why every gate stayed green.
 */
describe('a new workspace is SEEDED, not left empty (staging 2026-08-05)', () => {
  let svc: WorkspaceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: DepartmentService, useValue: mockDept},
      ],
    }).compile();
    svc = module.get(WorkspaceService);
  });

  /** entitled → not a company agent → no existing workspace → the INSERT
   *  returns the new row. */
  function happyPath(): void {
    mockDb.qOne
      .mockResolvedValueOnce({id: OWNER})                       // tier gate
      .mockResolvedValueOnce(null)                              // not a company agent
      .mockResolvedValueOnce(null)                              // no existing ws
      .mockResolvedValueOnce({owner_user_id: OWNER, name: 'Acme', created_at: 'now'});
  }

  it('seeds the department workspace for the new owner, with the WORKSPACE channel set', async () => {
    happyPath();
    await svc.createWorkspace(OWNER, 'Acme');
    // Q3 — the 'workspace' tenant picks the generalized channel names
    // (Team Roster/General/…), never the agency's CPO set.
    expect(mockDept.seedOrgWorkspace).toHaveBeenCalledWith(OWNER, 'workspace');
  });

  it('seeds AFTER the row is committed, never for a failed create', async () => {
    // A conflict must not seed channels for a workspace that does not exist.
    mockDb.qOne
      .mockResolvedValueOnce({id: OWNER})                       // tier gate
      .mockResolvedValueOnce(null)                              // not a company agent
      .mockResolvedValueOnce({owner_user_id: OWNER, name: 'Old', created_at: 'then'});
    await expect(svc.createWorkspace(OWNER, 'Acme')).rejects.toThrow(ConflictException);
    expect(mockDept.seedOrgWorkspace).not.toHaveBeenCalled();
  });

  it('does not seed when the tier gate refuses', async () => {
    mockDb.qOne.mockResolvedValueOnce(null);                    // not entitled
    await expect(svc.createWorkspace(OWNER, 'Acme')).rejects.toThrow();
    expect(mockDept.seedOrgWorkspace).not.toHaveBeenCalled();
  });

  /**
   * The workspace is already committed and the user owns it. A seeding failure
   * turning a successful create into a 500 would be a worse bug than the empty
   * list — and it self-heals, because seedOrgWorkspace is idempotent and
   * ensureBroadcastForLevel re-runs on the next channel creation.
   */
  it('a seeding failure does NOT fail the create', async () => {
    happyPath();
    mockDept.seedOrgWorkspace.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.createWorkspace(OWNER, 'Acme')).resolves.toMatchObject({name: 'Acme'});
  });
});
