import {ForbiddenException, type ExecutionContext} from '@nestjs/common';
import {ACCOUNT_KIND_SQL, WORKSPACE_AFFILIATIONS_SQL, deriveAccountKind, resolveAccountKind, resolveManagerContext, type AccountKindRow} from './account-kind';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import type {DatabaseService} from '../database/database.service';

const row = (over: Partial<AccountKindRow> = {}): AccountKindRow => ({
  user_role: 'individual',
  agent_type: null,
  agent_status: null,
  managed_by_org_id: null,
  member_role: null,
  member_status: null,
  org_user_id: null,
  org_name: null,
  password_set_at: new Date(),
  ...over,
});

describe('account-kind discriminator (Step 4)', () => {
  describe('deriveAccountKind precedence', () => {
    it('managed CPO (agents.type=cpo + managed_by_org_id) → cpo', () => {
      const r = deriveAccountKind(row({
        agent_type: 'cpo', managed_by_org_id: 'org-1', org_name: 'Acme',
        member_role: 'cpo', member_status: 'active', org_user_id: 'org-1',
      }));
      expect(r.account_kind).toBe('cpo');
      expect(r.org).toEqual({id: 'org-1', name: 'Acme'});
      expect(r.membership_status).toBe('active');
    });

    it('active cpo org_member with no agents row → cpo', () => {
      const r = deriveAccountKind(row({member_role: 'cpo', member_status: 'active', org_user_id: 'org-2', org_name: 'Beta'}));
      expect(r.account_kind).toBe('cpo');
      expect(r.org).toEqual({id: 'org-2', name: 'Beta'});
    });

    it('company agent → agency (its own active org, org=null)', () => {
      const r = deriveAccountKind(row({agent_type: 'company'}));
      expect(r.account_kind).toBe('agency');
      expect(r.membership_status).toBe('active');
      expect(r.org).toBeNull();
    });

    it('active manager org_member → agency', () => {
      const r = deriveAccountKind(row({member_role: 'manager', member_status: 'active', org_user_id: 'org-3', org_name: 'Gamma'}));
      expect(r.account_kind).toBe('agency');
      expect(r.org).toEqual({id: 'org-3', name: 'Gamma'});
    });

    it('plain client → individual', () => {
      expect(deriveAccountKind(row()).account_kind).toBe('individual');
    });

    // Phase B (owner-join, founder-approved 2026-08-09) — the two personas
    // the four-arm precedence exists to separate. Mirrors the SQL exactly.
    it('Phase B — an OWNER who joined another WORKSPACE keeps their OWN org as primary; both ride workspaces[]', () => {
      const r = deriveAccountKind(row({
        user_id: 'me', owns_workspace: true, workspace_name: 'My Co',
        member_role: 'employee', member_status: 'active', org_user_id: 'org-b',
        member_org_is_workspace: true, member_org_name: 'Their Co',
        // The SQL's org joins resolve the PRIMARY org's name with the same
        // expression, so org_name here is the OWN workspace's name.
        org_name: 'My Co',
      }));
      expect(r.org).toEqual({id: 'me', name: 'My Co'});
      expect(r.workspaces).toEqual([
        {org_id: 'me', name: 'My Co', role: 'owner'},
        {org_id: 'org-b', name: 'Their Co', role: 'employee'},
      ]);
    });

    it('LOW-5 — an AGENCY crew member who owns a personal workspace keeps the AGENCY as primary', () => {
      const r = deriveAccountKind(row({
        user_id: 'me', owns_workspace: true, workspace_name: 'Side Ws',
        member_role: 'cpo', member_status: 'active', org_user_id: 'agency-1',
        member_org_is_workspace: false, org_name: 'Guard Corp',
      }));
      expect(r.org).toEqual({id: 'agency-1', name: 'Guard Corp'});
      // The agency is not an enterable workspace tile; only the own ws rides.
      expect(r.workspaces).toEqual([{org_id: 'me', name: 'Side Ws', role: 'owner'}]);
    });

    it('Phase B — the member-then-CREATED-own persona flips to their own workspace (deliberate, documented)', () => {
      // Reachable pre-Phase-B (createWorkspace never checked membership) —
      // NOT covered by the inertness argument. The flip to own-workspace on
      // deploy is the intended Discord semantic; this pin makes the
      // behaviour change explicit rather than accidental.
      const r = deriveAccountKind(row({
        user_id: 'me', owns_workspace: true, workspace_name: 'My Co',
        member_role: 'manager', member_status: 'active', org_user_id: 'org-b',
        member_org_is_workspace: true, member_org_name: 'Their Co',
        org_name: 'My Co',
      }));
      expect(r.org?.id).toBe('me');
      expect(r.workspaces.map(w => w.org_id).sort()).toEqual(['me', 'org-b']);
    });

    it('Phase B — the SQL four-arm text is present (mocked-DB blind spot: no test executes it)', () => {
      // A SQL-side revert with the TS mirror intact would be invisible to
      // every unit test — pin the two arms that changed.
      expect(ACCOUNT_KIND_SQL).toMatch(/omws\.owner_user_id IS NULL THEN om\.org_user_id/);
      // [\s\S]*? — activeEnterpriseSql expands multi-line between AND and THEN.
      expect(ACCOUNT_KIND_SQL).toMatch(/ws\.owner_user_id IS NOT NULL AND [\s\S]*? THEN u\.id/);
      expect(ACCOUNT_KIND_SQL).toMatch(/AS member_org_is_workspace/);
      expect(ACCOUNT_KIND_SQL).toMatch(/AS member_org_name/);
    });

    it('Phase B — a plain workspace employee is unchanged: org = the workspace, one workspaces[] entry', () => {
      const r = deriveAccountKind(row({
        user_id: 'me', member_role: 'employee', member_status: 'active',
        org_user_id: 'org-b', member_org_is_workspace: true,
        member_org_name: 'Their Co', org_name: 'Their Co',
      }));
      expect(r.org).toEqual({id: 'org-b', name: 'Their Co'});
      expect(r.workspaces).toEqual([{org_id: 'org-b', name: 'Their Co', role: 'employee'}]);
    });

    it('a SUSPENDED managed CPO still resolves to cpo (so the guard can eject it)', () => {
      const r = deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'suspended'}));
      expect(r.account_kind).toBe('cpo');
      expect(r.membership_status).toBe('suspended');
    });

    it('must_set_password is true for a cpo with NULL password_set_at, false once set', () => {
      expect(deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', password_set_at: null})).must_set_password).toBe(true);
      expect(deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', password_set_at: new Date()})).must_set_password).toBe(false);
    });

    it('must_set_password is false for non-cpo even with NULL password_set_at', () => {
      expect(deriveAccountKind(row({agent_type: 'company', password_set_at: null})).must_set_password).toBe(false);
      expect(deriveAccountKind(row({password_set_at: null})).must_set_password).toBe(false);
    });

    it('cpo_needs_onboarding is true for a not-yet-active managed CPO, false once ACTIVE/APPROVED', () => {
      const cpo = (status: string | null) => row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active', agent_status: status});
      expect(deriveAccountKind(cpo('DOCS_PENDING')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('SUBMITTED')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('UNDER_REVIEW')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('ACTIVE')).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(cpo('APPROVED')).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(cpo(null)).cpo_needs_onboarding).toBe(false); // unknown → don't trap
    });

    it('cpo_needs_onboarding is false for a non-cpo regardless of agent_status', () => {
      expect(deriveAccountKind(row({agent_type: 'company', agent_status: 'DOCS_PENDING'})).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(row({agent_status: 'DOCS_PENDING'})).cpo_needs_onboarding).toBe(false);
    });
  });

  describe('resolveAccountKind (single query)', () => {
    it('runs ACCOUNT_KIND_SQL with the userId and derives from the row', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active'})), q: jest.fn().mockResolvedValue([])};
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'u1');
      expect(db.qOne).toHaveBeenCalledWith(expect.stringContaining('FROM public.users u'), ['u1']);
      expect(r.account_kind).toBe('cpo');
    });

    it('lists EVERY workspace the caller belongs to, not just the discriminating one', async () => {
      /**
       * vs2 item 4. `workspaces[]` used to be built from ACCOUNT_KIND_SQL's
       * `LEFT JOIN LATERAL ... LIMIT 1`, which by construction yields ONE
       * membership — so the hub rendered a single tile no matter how many
       * organisations the user belonged to. The tile is the only place a
       * workspace context is ever set, so the server's whole multi-org path was
       * unreachable from the app: item 4 would have shipped server-only.
       */
      const db = {
        qOne: jest.fn().mockResolvedValue(row({user_id: 'dana'})),
        q: jest.fn().mockResolvedValue([
          {org_user_id: 'acme', member_role: 'manager', org_name: 'Acme'},
          {org_user_id: 'borealis', member_role: 'employee', org_name: 'Borealis'},
        ]),
      };
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'dana');
      expect(r.workspaces).toEqual([
        {org_id: 'acme', name: 'Acme', role: 'manager'},
        {org_id: 'borealis', name: 'Borealis', role: 'employee'},
      ]);
      // Ordered, so the hub does not reshuffle its tiles between launches.
      expect(String(db.q.mock.calls[0][0])).toMatch(/ORDER BY om\.created_at ASC/);
      // WORKSPACE orgs only — an agency roster is not an enterable tile.
      expect(String(db.q.mock.calls[0][0])).toMatch(/org_workspaces/);
    });

    it('names the COMPANY, not the founder who owns it', () => {
      /**
       * A privacy regression this repo had already fixed once — ACCOUNT_KIND_SQL
       * carries a docblock about it — and item 4's new affiliation query
       * reintroduced by selecting the owner's `users.display_name` directly.
       *
       * Acme Corp's workspace is owned by Kwame Boateng. Every employee's hub
       * then rendered a tile titled "Kwame Boateng", beside their own tile which
       * correctly read "Acme Corp": two naming rules in one list, and the
       * owner's personal name disclosed to their whole staff. When display_name
       * is NULL it degraded further — org_name became '' and the workspace
       * header rendered EMPTY, because the consumer uses `??`, and '' is not
       * nullish.
       *
       * Asserted on the SQL: the mocked db returns whatever org_name the test
       * supplies, so no behavioural assertion here can see which column it came
       * from. `org_workspaces.name` is NOT NULL with a non-blank CHECK, so the
       * COALESCE always has a real value to find.
       */
      const sql = WORKSPACE_AFFILIATIONS_SQL.split(/\r?\n/)
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      expect(sql).toMatch(/COALESCE\(\s*w\.name\s*,\s*u\.display_name\s*\)\s+AS\s+org_name/);
      expect(sql).toMatch(/JOIN public\.org_workspaces w/);
    });

    it('the discriminator breaks a full tie deterministically', () => {
      /**
       * vs2 item 4. ACCOUNT_KIND_SQL's LATERAL picks ONE membership to answer
       * `account_kind`, `org`, `org_name`, `org_is_workspace` and
       * `membership_status` with. Its three sort keys —
       * `org_user_id = managed_by_org_id`, `status = 'active'`,
       * `member_role = 'cpo'` — ALL tie for an employee of Acme who also
       * manages Borealis: no managing org, both active, neither a cpo.
       *
       * Unordered, Postgres was free to return either row and to change its
       * mind between plans, so the user's primary organisation FLAPPED between
       * requests. Five other resolvers were given `created_at ASC` and this
       * one — the widest blast radius in the service, feeding /auth/me,
       * CpoSessionGuard, biometric and family — was missed.
       */
      const sql = ACCOUNT_KIND_SQL.split(/\r?\n/)
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      const lateral = sql.slice(sql.indexOf('LEFT JOIN LATERAL'));
      const order = lateral.slice(lateral.indexOf('ORDER BY'), lateral.indexOf('LIMIT 1'));
      expect(order).toMatch(/created_at ASC/);
    });

    it('still lists the caller OWN workspace alongside the ones they joined', async () => {
      const db = {
        qOne: jest.fn().mockResolvedValue(row({user_id: 'dana', owns_workspace: true, workspace_name: 'Dana Co'})),
        q: jest.fn().mockResolvedValue([{org_user_id: 'acme', member_role: 'manager', org_name: 'Acme'}]),
      };
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'dana');
      expect(r.workspaces).toEqual([
        {org_id: 'dana', name: 'Dana Co', role: 'owner'},
        {org_id: 'acme', name: 'Acme', role: 'manager'},
      ]);
    });

    it('never lists the caller own org twice', async () => {
      // The membership query already excludes `org_user_id = $1`, but the owner
      // tile is pushed unconditionally — a duplicate would render two tiles
      // that switch to the same place.
      const db = {
        qOne: jest.fn().mockResolvedValue(row({user_id: 'dana', owns_workspace: true, workspace_name: 'Dana Co'})),
        q: jest.fn().mockResolvedValue([{org_user_id: 'dana', member_role: 'manager', org_name: 'Dana Co'}]),
      };
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'dana');
      expect(r.workspaces).toHaveLength(1);
    });

    it('returns individual + safe defaults when the user row is missing', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn().mockResolvedValue([])};
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'missing');
      // Every axis fails CLOSED, owns_workspace included — an unknown or
      // soft-deleted user owns nothing. toEqual (not toMatchObject) so a NEW
      // field added to the result cannot default to something permissive
      // without this test noticing.
      expect(r).toEqual({
        account_kind: 'individual', org: null, must_set_password: false,
        membership_status: null, suspension: null, cpo_needs_onboarding: false,
        owns_workspace: false,
        // Q1 — the tenant-TYPE flag fails closed too: an unknown user's org
        // is not a workspace, so surfaces keep the (safe) agency wording.
        org_is_workspace: false,
        // Phase B — an unknown user has no enterable workspaces.
        workspaces: [],
        // B-417 — the owner fact fails closed: an unknown user owns no agency,
        // so its device can never enter the Ops Room claim race.
        owns_agency: false,
      });
    });
  });

  /**
   * B-417 — the direct OWNER fact for Ops Room key authority. Exists because
   * the client inferred ownership from `account_kind==='agency' && !org`, a
   * proxy Phase B rotted: an owner who joins another org's workspace gets a
   * non-null org from the four-arm fallback and silently lost key authority
   * over their own agency. Mirrors OrgManagerGuard Path 1 (company + ACTIVE)
   * so the client fact and the server admission can never disagree.
   */
  describe('B-417 — owns_agency', () => {
    it('ACTIVE company agent → true', () => {
      expect(deriveAccountKind(row({agent_type: 'company', agent_status: 'ACTIVE'})).owns_agency).toBe(true);
    });

    it('non-ACTIVE company agent → false (guard Path 1 refuses them too — the fact must not outrun the admission)', () => {
      expect(deriveAccountKind(row({agent_type: 'company', agent_status: 'PENDING_REVIEW'})).owns_agency).toBe(false);
      expect(deriveAccountKind(row({agent_type: 'company', agent_status: null})).owns_agency).toBe(false);
    });

    it('never true for non-company personas, whatever their agent_status', () => {
      expect(deriveAccountKind(row({member_role: 'manager', member_status: 'active', org_user_id: 'o', org_name: 'G', agent_status: 'ACTIVE'})).owns_agency).toBe(false);
      expect(deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', agent_status: 'ACTIVE'})).owns_agency).toBe(false);
      expect(deriveAccountKind(row()).owns_agency).toBe(false);
    });

    it('THE B-417 PERSONA — a workspace-joined owner keeps owns_agency despite the non-null org that broke the legacy inference', () => {
      const r = deriveAccountKind(row({
        agent_type: 'company', agent_status: 'ACTIVE',
        member_role: 'employee', member_status: 'active', org_user_id: 'org-b',
        member_org_is_workspace: true, member_org_name: 'Their Co',
      }));
      expect(r.account_kind).toBe('agency');
      // The rotted proxy: org is NON-null for this persona (four-arm fallback,
      // arm 4) — exactly why `!org` stopped meaning "owner".
      expect(r.org).not.toBeNull();
      expect(r.owns_agency).toBe(true);
    });
  });

  /**
   * The manager discriminator. account_kind CANNOT serve as one: a delegated
   * manager is a promoted CPO, so managed_by_org_id is set and the cpo
   * precedence above pins account_kind='cpo'. Production confirms it —
   * owner "Agent Due" = {agency, org:null}, manager "CPO 1" = {cpo, org set}.
   * Every client-side attempt keyed off account_kind was false for both.
   */
  describe('resolveManagerContext', () => {
    it('reports the managed org and the granted modules together', async () => {
      const db = {qOne: jest.fn().mockResolvedValue({org_id: 'org-1', org_name: 'Agent Due', permitted_modules: ['dept', 'roster']})};
      const r = await resolveManagerContext(db as unknown as DatabaseService, 'mgr-1');
      expect(r).toEqual({managed_org: {id: 'org-1', name: 'Agent Due'}, permitted_modules: ['dept', 'roster']});
    });

    it('an unconfigured manager (NULL grants) is granted NOTHING, not everything', () => {
      // Founder rule: "if the owner doesn't choose any then he will not have
      // any module." Safe to collapse only because managed_org — not this
      // column's null-ness — is what says "is a manager".
      return expect(resolveManagerContext(
        {qOne: jest.fn().mockResolvedValue({org_id: 'org-1', org_name: 'Agent Due', permitted_modules: null})} as unknown as DatabaseService,
        'mgr-2',
      )).resolves.toEqual({managed_org: {id: 'org-1', name: 'Agent Due'}, permitted_modules: []});
    });

    it('a non-manager gets nulls, so the client filters nothing', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn().mockResolvedValue([])};
      const r = await resolveManagerContext(db as unknown as DatabaseService, 'owner');
      expect(r).toEqual({managed_org: null, permitted_modules: null});
    });

    it('queries the ACTIVE manager row only, and never the caller as their own org', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn().mockResolvedValue([])};
      await resolveManagerContext(db as unknown as DatabaseService, 'u1');
      const [sql, params] = db.qOne.mock.calls[0];
      expect(sql).toContain("om.member_role = 'manager'");
      expect(sql).toContain("om.status = 'active'");
      // Keeps an owner structurally incapable of reading as their own manager.
      expect(sql).toContain('om.org_user_id <> $1');
      expect(params).toEqual(['u1']);
    });
  });

  describe('ACCOUNT_KIND_SQL (membership tiebreak)', () => {
    it("prefers the agent's own managing-org membership so a revoked CPO can't escape via another org", () => {
      // A managed CPO suspended in org A but an active manager of org B must read
      // the org-A (suspended) membership, not org B's active one — verified at the
      // DB level; this locks the ORDER BY so a future edit can't drop it.
      expect(ACCOUNT_KIND_SQL).toContain('(org_user_id = a.managed_by_org_id) DESC');
      expect(ACCOUNT_KIND_SQL).toMatch(/ORDER BY[\s\S]*LIMIT 1/);
    });
  });

  describe('CpoSessionGuard', () => {
    const ctxFor = (sub: string | null) => ({
      switchToHttp: () => ({getRequest: () => ({user: sub ? {sub} : undefined})}),
    } as unknown as ExecutionContext);

    const guardWith = (rowVal: AccountKindRow | null) =>
      new CpoSessionGuard({qOne: jest.fn().mockResolvedValue(rowVal), q: jest.fn().mockResolvedValue([])} as unknown as DatabaseService);

    it('throws agency_access_ended for a suspended CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'suspended'}));
      await expect(g.canActivate(ctxFor('cpo-1'))).rejects.toThrow(ForbiddenException);
      await expect(g.canActivate(ctxFor('cpo-1'))).rejects.toThrow('agency_access_ended');
    });

    it('throws for a removed CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'removed'}));
      await expect(g.canActivate(ctxFor('cpo-2'))).rejects.toThrow(ForbiddenException);
    });

    it('passes an active CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active'}));
      await expect(g.canActivate(ctxFor('cpo-3'))).resolves.toBe(true);
    });

    it('is a no-op for an agency caller (company agent)', async () => {
      const g = guardWith(row({agent_type: 'company'}));
      await expect(g.canActivate(ctxFor('agency-1'))).resolves.toBe(true);
    });

    it('is a no-op for an individual caller', async () => {
      const g = guardWith(row());
      await expect(g.canActivate(ctxFor('client-1'))).resolves.toBe(true);
    });

    it('rejects an unauthenticated request', async () => {
      const g = guardWith(null);
      await expect(g.canActivate(ctxFor(null))).rejects.toThrow(ForbiddenException);
    });
  });
});
