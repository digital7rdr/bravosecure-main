/**
 * Channels vs2 item 17b — per-workspace module hiding, server side.
 *
 * THE RULE THIS FILE EXISTS TO PROTECT: hiding is PRESENTATION, never a
 * permission. Nothing here may become an authorisation input, the routes stay
 * registered, and every existing guard keeps enforcing exactly what it did
 * before. The tests below therefore assert the shape of the decision AND its
 * absence from anything that grants access.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from './org-audit.service';
import {WorkspaceService} from './workspace.service';
import {DepartmentService} from '../department/department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn().mockResolvedValue(undefined)};
const mockDept = {seedOrgWorkspace: jest.fn()};

describe('workspace module settings', () => {
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

  describe('reading', () => {
    it('no settings row means nothing is hidden — the pre-feature behaviour', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.getSettings('orgA')).resolves.toEqual({
        // PDF checklist line 9 — levelNames rides the same response and has the
        // same fail-open shape: no row means [], which the client reads as "use
        // the built-in tier vocabulary", i.e. the pre-feature behaviour.
        orgUserId: 'orgA', hiddenModules: [], levelNames: [],
      });
    });

    it('ECHOES the org id back, so the client can key on it', async () => {
      // The client's request param is undefined on most paths, so a
      // request-keyed store collapses every workspace into one bucket. The
      // response has to name the org it describes.
      mockDb.qOne.mockResolvedValueOnce({hidden_modules: ['incidents'], level_names: ['Region']});
      await expect(svc.getSettings('orgA')).resolves.toEqual({
        orgUserId: 'orgA', hiddenModules: ['incidents'], levelNames: ['Region'],
      });
    });
  });

  /**
   * PDF checklist line 9 — "Admins can choose the names of levels."
   *
   * PRESENTATION ONLY. org_workspace_settings' own header states that nothing
   * in it is read by an authorisation check, and a tier NAME decides nothing:
   * depth is still governed by department_channels.level and its CHECK, so
   * renaming a tier cannot move a channel, change who sees it, or add a fifth
   * level. The cases below pin the normalisation, because the client is not a
   * boundary — an older app or a direct API call reaches this too.
   */
  describe('level names', () => {
    it('drops TRAILING blanks so "renamed L1 only" stores one entry', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({hidden_modules: [], level_names: ['Region']});
      const res = await svc.setLevelNames('orgA', 'mgr', ['Region', '', '', '']);
      expect(res.levelNames).toEqual(['Region']);
    });

    it('KEEPS an interior blank — position is which TIER was renamed', async () => {
      // ['', 'Branch'] means "default L1, rename L2". Compacting it would move
      // Branch to L1 and silently rename the wrong tier.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({hidden_modules: [], level_names: ['', 'Branch']});
      const res = await svc.setLevelNames('orgA', 'mgr', ['', 'Branch']);
      expect(res.levelNames).toEqual(['', 'Branch']);
    });

    it('an ALL-BLANK array clears back to the built-ins', async () => {
      // What makes the editor's clear-to-reset work without a separate action.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({hidden_modules: [], level_names: []});
      const res = await svc.setLevelNames('orgA', 'mgr', ['  ', '']);
      expect(res.levelNames).toEqual([]);
    });

    it('caps the count and the length — the client is not the boundary', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({hidden_modules: [], level_names: []});
      await svc.setLevelNames('orgA', 'mgr', ['a'.repeat(80), 'b', 'c', 'd', 'e']);
      const written = mockDb.qOne.mock.calls.find(c => /INSERT INTO public.org_workspace_settings/.test(String(c[0])) && /level_names/.test(String(c[0])));
      expect(written).toBeTruthy();
      const names = (written as unknown[])[1] as string[][];
      expect(names[1]).toHaveLength(4);
      expect(names[1][0]).toHaveLength(24);
    });

    it('does NOT touch hidden_modules — two independent whole-value replaces', async () => {
      /**
       * Its own route and its own UPDATE for a reason: the settings PATCH
       * replaces the WHOLE hidden-module set, so folding renames into it would
       * force every caller to resend that set — and an app that forgot would
       * silently un-hide every hidden module.
       */
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
        .mockResolvedValueOnce({hidden_modules: ['incidents'], level_names: ['Region']});
      const res = await svc.setLevelNames('orgA', 'mgr', ['Region']);
      const sql = String(mockDb.qOne.mock.calls.at(-2)?.[0] ?? mockDb.qOne.mock.calls.at(-1)?.[0]);
      expect(sql).not.toMatch(/hidden_modules\s*=/);
      expect(res.hiddenModules).toEqual(['incidents']);
    });
  });

  describe('writing', () => {
    it('drops values it does not recognise instead of rejecting the whole call', async () => {
      // An older app that has not learned a new module name must still be able
      // to change the ones it does know.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const res = await svc.setHiddenModules('orgA', 'mgr', ['attendance', 'telepathy']);
      expect(res.hiddenModules).toEqual(['attendance']);
    });

    it('de-duplicates and sorts, so the stored value compares by equality', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      const res = await svc.setHiddenModules('orgA', 'mgr', ['incidents', 'attendance', 'incidents']);
      expect(res.hiddenModules).toEqual(['attendance', 'incidents']);
    });

    it('audits BEFORE and AFTER explicitly', async () => {
      // "settings changed" is unanswerable three months later. The 2026-08-04
      // review made stating both the house rule.
      mockDb.qOne
        .mockResolvedValueOnce({hidden_modules: ['attendance']})  // before
        .mockResolvedValueOnce(null);                              // the upsert
      await svc.setHiddenModules('orgA', 'mgr', ['incidents']);
      expect(mockAudit.log).toHaveBeenCalledWith(
        'orgA', 'mgr', 'workspace.settings.update',
        expect.objectContaining({
          metadata: {before: ['attendance'], after: ['incidents']},
        }),
      );
    });

    it('replaces the WHOLE set — an empty array un-hides everything', async () => {
      mockDb.qOne.mockResolvedValueOnce({hidden_modules: ['attendance']}).mockResolvedValueOnce(null);
      const res = await svc.setHiddenModules('orgA', 'mgr', []);
      expect(res.hiddenModules).toEqual([]);
    });
  });

  describe('who may write — one resolver, the guard arms in the guard order', () => {
    it('an ACTIVE COMPANY AGENT is its own org', async () => {
      // The arm that was missing. Without it the whole feature was dead for
      // agencies while the home screen still offered them the control: the
      // company account got 403 and its delegated managers got a raw FK
      // violation from the settings table.
      mockDb.qOne.mockResolvedValueOnce({user_id: 'agency-1'});
      await expect(svc.assertManagerOrg('agency-1')).resolves.toBe('agency-1');
    });

    it('an owner administers their OWN workspace, even when they manage another org', async () => {
      // Ordering mirrors OrgManagerGuard. Reversed, the founder of A would
      // administer B whenever they open their own workspace.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce({owner_user_id: 'owner-1'});
      await expect(svc.assertManagerOrg('owner-1')).resolves.toBe('owner-1');
    });

    it('a LAPSED owner does not — the owner arm is Enterprise-gated', async () => {
      // The guard is lapse-aware and this mirror was not, so a lapsed owner who
      // manages another workspace edited the LAPSED one and watched their Save
      // do nothing.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgB', member_role: 'manager', department: null}]);
      await expect(svc.assertManagerOrg('lapsed-1')).resolves.toBe('orgB');
    });

    it('a delegated manager administers the org they manage', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgB', member_role: 'manager', department: null}]);
      await expect(svc.assertManagerOrg('mgr-1')).resolves.toBe('orgB');
    });

    it('a DEPARTMENT-SCOPED manager is refused an ORG-WIDE change', async () => {
      // Every attendance and incident service applies that scope as a forced
      // filter; this would be the one place it stopped applying, letting a
      // Sales-only manager blank Attendance for the whole company.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgB', member_role: 'manager', department: 'Sales'}]);
      await expect(svc.assertManagerOrg('sales-mgr')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a plain member is REFUSED the write but KEEPS the read', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgA', member_role: 'employee', department: null}]);
      await expect(svc.assertManagerOrg('member-1')).rejects.toBeInstanceOf(ForbiddenException);

      mockDb.qOne.mockReset(); mockDb.q.mockReset();
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgA', member_role: 'employee', department: null}]);
      await expect(svc.resolveOrgContext('member-1'))
        .resolves.toEqual({orgUserId: 'orgA', canManage: false});
    });

    it('administers the org the caller is VIEWING, not their oldest one', async () => {
      /**
       * vs2 item 4. Unifying the read and the write on one resolver made them
       * agree with each other; it did not make either agree with the org on
       * screen. A manager of Acme (January) and Borealis (June) who opened the
       * module sheet inside Borealis was shown ACME's toggles and, on Save,
       * silently rewrote Acme — a 200, and an audit row naming it as intent.
       */
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([
        {org_user_id: 'acme', member_role: 'manager', department: null},
        {org_user_id: 'borealis', member_role: 'manager', department: null},
      ]);
      await expect(svc.assertManagerOrg('dana', 'borealis')).resolves.toBe('borealis');
    });

    it('a company agent sent a FOREIGN header keeps their own org, never null', async () => {
      /**
       * Round 1 made each arm return early only when the header agreed, which
       * silently DISCARDED the arm otherwise — a company agent or owner with a
       * stale header fell through to the membership arm and resolved to null.
       *
       * Null is not "no opinion" here. It serialises as
       * `{orgUserId: null, hiddenModules: []}`, the client reads an empty
       * hidden set as "hide nothing", and Save stays ENABLED — so one tap
       * PATCHes `[]` and un-hides every module org-wide. That is exactly the
       * destructive Save the sheet's `loaded` flag exists to prevent, reached
       * through a different door.
       */
      mockDb.qOne.mockResolvedValueOnce({user_id: 'agency-1'}).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.resolveOrgContext('agency-1', 'a-workspace-they-left'))
        .resolves.toEqual({orgUserId: 'agency-1', canManage: true});
    });

    it('an OWNER sent a foreign header likewise keeps their own workspace', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce({owner_user_id: 'owner-1'});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.resolveOrgContext('owner-1', 'some-other-org'))
        .resolves.toEqual({orgUserId: 'owner-1', canManage: true});
    });

    it('a WRITE naming an org the caller no longer holds is REFUSED, not redirected', async () => {
      /**
       * The read may fall back — worst case the manager sees the wrong list and
       * notices. A write may not.
       *
       * Dana is inside Borealis and taps Save. Between the GET and the PATCH the
       * Borealis admin removes her. Borealis leaves her candidate list, and the
       * silent fallback picked ACME: Acme's module visibility overwritten with
       * Borealis's toggles, 200, and an audit row naming Acme as her intent. The
       * client cannot catch it — the reconcile has usually unmounted the sheet
       * before the response arrives.
       *
       * This costs the dispatch lanes nothing, because nothing that fails to
       * send a header can reach it.
       */
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'acme', member_role: 'manager', department: null}]);
      // NAME the refusal. `assertManagerOrg` also throws ForbiddenException for
      // `org_manager_access_required`, so an instanceof check cannot tell the new
      // path from the ordinary 403 it might silently degrade into.
      await expect(svc.assertManagerOrg('dana', 'borealis-she-just-lost'))
        .rejects.toThrow('org_context_unknown');
    });

    it('...but a write with NO header still falls back, exactly as before', async () => {
      // Cold starts, unstamped routes and older builds all land here. Refusing
      // them is the mistake that 403'd Accept Offer.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'acme', member_role: 'manager', department: null}]);
      await expect(svc.assertManagerOrg('dana')).resolves.toBe('acme');
    });

    it('a READ naming an org the caller does not hold still falls back quietly', async () => {
      // A stale header on a GET is ordinary — a switch mid-flight, a push tap.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'acme', member_role: 'manager', department: null}]);
      await expect(svc.resolveOrgContext('dana', 'not-mine'))
        .resolves.toEqual({orgUserId: 'acme', canManage: true});
    });


    it('an owner who also manages another workspace can administer THAT one', async () => {
      // The owner arm short-circuited unconditionally, so a founder who also
      // managed a second workspace could never reach its settings at all.
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce({owner_user_id: 'owner-1'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'orgB', member_role: 'manager', department: null}]);
      await expect(svc.assertManagerOrg('owner-1', 'orgB')).resolves.toBe('orgB');
    });

    it('ONE resolver serves both verbs — the read and the write cannot disagree', async () => {
      /**
       * They were two functions and they diverged: the read took "oldest active
       * membership of any role", the write took "manager-role membership". An
       * employee of A who manages B therefore LOADED A's toggles and SAVED them
       * onto B, rewriting B to A's set without touching a row.
       */
      const src = readFileSync('src/org/workspace.controller.ts', 'utf8');
      expect(src).toMatch(/@Get\('settings'\)[\s\S]{0,400}?resolveOrgContext/);
      expect(src).not.toMatch(/resolveOrgForCaller/);
    });

    it('BOTH verbs actually read the header off the request', () => {
      /**
       * Everything else in this file passes `requested` straight into the
       * service, so the controller could stop reading the header entirely and
       * every test here — and in multiOrgContext.spec.ts — would stay green
       * with the cross-tenant fix dead. The client half has the same guard
       * (`orgContextHeader.test.ts`, "THE WIRING"); this is the server half.
       *
       * Line-based and comment-skipping: a `\n`-anchored regex over a CRLF file
       * matches nothing and passes VACUOUSLY, and the house comment-stripper
       * has eaten real code in this repo.
       */
      const lines = readFileSync('src/org/workspace.controller.ts', 'utf8')
        .split(/\r?\n/)
        .filter(l => {
          const t = l.trim();
          return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        });
      const wired = lines.filter(l => /readOrgContextHeader\(req\)/.test(l));
      /**
       * EVERY route, not a fixed count. This asserted exactly 2 and broke when
       * PDF checklist line 9 added the level-names PATCH — a false positive
       * that says nothing about the property being protected.
       *
       * The property is: no route resolves the org from the BODY. So count the
       * routes and require the same number of header reads. A new route that
       * forgets the header still fails; adding one that remembers does not.
       */
      // The ORG-SCOPED routes are the `settings` ones; @Post()/@Get() create and
      // read the caller's OWN workspace and have no org to resolve. Counting
      // those explicitly beats arithmetic over every decorator, which is what
      // made the first version of this miscount.
      const orgScoped = lines.filter(l => /@(Get|Patch|Post|Put|Delete)\('settings/.test(l)).length;
      expect(wired.length).toBeGreaterThanOrEqual(2);
      expect(wired).toHaveLength(orgScoped);
      // The GET resolves (member-readable); every WRITE asserts manager rights.
      expect(lines.filter(l => /resolveOrgContext\(user\.sub, readOrgContextHeader/.test(l))).toHaveLength(1);
      expect(lines.filter(l => /assertManagerOrg\(user\.sub, readOrgContextHeader/.test(l)).length)
        .toBeGreaterThanOrEqual(2);
    });

    it('the ATTENDANCE and INCIDENT controllers read it too', () => {
      /**
       * vs2 item 4 round 3 threaded the header into both services, and the
       * service tests call the services DIRECTLY — so deleting the argument at
       * either controller leaves every one of them green while a workspace
       * employee's clock-in files against the wrong company again.
       *
       * These two are the whole write surface that takes the header outside
       * this controller; the rest of the org-scoped writes go through
       * OrgManagerGuard, which reads it itself.
       */
      for (const f of ['attendance/attendance.controller.ts', 'incident/incident.controller.ts']) {
        const lines = readFileSync(`src/${f}`, 'utf8').split(/\r?\n/).filter(l => {
          const t = l.trim();
          return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        });
        expect({file: f, wired: lines.some(l => /readOrgContextHeader\(req\)/.test(l))})
          .toEqual({file: f, wired: true});
      }
    });

    it('nobody resolves to null — which the client reads as "show everything"', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(svc.resolveOrgContext('nobody')).resolves.toBeNull();
    });
  });

  it('HIDING IS NOT A PERMISSION — no guard reads the settings table', () => {
    /**
     * The invariant the whole feature rests on. If a guard ever consults
     * `hidden_modules`, hiding a card silently becomes a way to revoke access —
     * and a deep link or a push already in flight becomes a 403 instead of a
     * screen.
     */
    // Every guard in the tree, not a hand-listed pair — a NEW guard that
    // reads the table is exactly the regression this is for.
    // `git ls-files`, the house pattern (sourceScanSafety.test.ts). NOT
    // fs.globSync: that is Node 22+, and CI pins Node 20 — the suite would
    // have gone red on push while passing on this machine.
    const guards = execSync('git ls-files "src/**/*.guard.ts"', {encoding: 'utf8'})
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.endsWith('.spec.ts'));
    expect(guards.length).toBeGreaterThan(3);
    for (const rel of guards) {
      const src = readFileSync(rel, 'utf8');
      expect(`${rel}: ${src.includes('hidden_modules')}`).toBe(`${rel}: false`);
      expect(`${rel}: ${src.includes('org_workspace_settings')}`).toBe(`${rel}: false`);
    }
  });
});
