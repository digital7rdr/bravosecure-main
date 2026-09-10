/**
 * Channels vs2 items 5 + 12, EXTENDED TO EVERY TENANT (client 2026-08-26) —
 * ALL orgs start clean, and nothing is auto-added beneath a main channel.
 *
 * The original scope gated everything on the workspace tenant and kept the
 * agency seeded set as "the twin that must not change". The client then closed
 * the split explicitly: "There must never be pre made channels, even on
 * service provider channels… All Channels must be exactly the same and should
 * also start the same… no need for 2 different types." So the twins below flip
 * from refusal to parity.
 *
 * TWO rules stay workspace-gated on purpose, and their twins still pin that:
 * the restricted-root refusals (seedsManagersOnly also covers channel_type
 * 'incident', and agencies legitimately run top-level incident channels) on
 * both verbs. Directory-integrity rules, not channel-model rules.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};

const ORG = 'org-1';
const MGR = 'mgr-1';

/** The workspace discriminator: `SELECT 1 ... FROM org_workspaces`. */
const isWorkspaceQuery = (sql: string) => /FROM public\.org_workspaces/.test(sql);

describe('vs2 items 5+12 — workspace starts clean, agency unchanged', () => {
  let svc: DepartmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(DepartmentService);
  });

  /** Every INSERT the service issued, as SQL text. */
  const inserts = () => [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls]
    .map((c: unknown[]) => String(c[0]))
    .filter(s => /INSERT INTO public\.department_channels/.test(s));

  describe('seedOrgWorkspace', () => {
    it('a WORKSPACE is seeded with ZERO channels and no #broadcast', async () => {
      // The client asked twice ("do not auto-create default channels", "same at
      // every level"). The reason is structural: five pre-made channels arrive
      // as five parentless roots, so the organisation picker this whole scope is
      // built around would open on five organisations nobody created.
      mockDb.qOne.mockResolvedValueOnce({n: 0});   // idempotency probe
      const res = await svc.seedOrgWorkspace(ORG, 'workspace');
      expect(res).toEqual({created: 0});
      expect(inserts()).toEqual([]);
    });

    it('an AGENCY starts clean too — one channel model (client 2026-08-26)', async () => {
      // The twin, flipped. "There must never be pre made channels, even on
      // service provider channels."
      const res = await svc.seedOrgWorkspace(ORG, 'agency');
      expect(res).toEqual({created: 0});
      expect(inserts()).toEqual([]);
    });

    it('issues NO queries at all — a no-op needs no idempotency probe', async () => {
      await svc.seedOrgWorkspace(ORG, 'workspace');
      await svc.seedOrgWorkspace(ORG);
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });
  });

  describe('createChannel — no auto-#broadcast in a workspace', () => {
    /** Drive a create; `workspace` decides what the tenant probe answers. */
    async function create(workspace: boolean, input: Parameters<DepartmentService['createChannel']>[2]) {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        if (isWorkspaceQuery(sql)) {return workspace ? {n: 1} : null;}
        if (/INSERT INTO public\.department_channels/.test(sql)) {return {id: 'new-ch', level: input.parent_id ? 2 : 1};}
        if (/SELECT org_id, level, is_broadcast/.test(sql)) {
          return {org_id: ORG, level: 1, is_broadcast: false, parent_id: null,
            access: 'standard', channel_type: 'department'};
        }
        return null;
      });
      return svc.createChannel(ORG, MGR, input);
    }

    it('a WORKSPACE create adds no broadcast sibling', async () => {
      await create(true, {name: 'Operations'});
      // ensureBroadcastForLevel's own INSERT names '#broadcast' literally.
      expect(inserts().some(s => /is_broadcast/.test(s))).toBe(false);
    });

    it('an AGENCY create adds no broadcast sibling either', async () => {
      await create(false, {name: 'Operations'});
      const probed = [...mockDb.qOne.mock.calls].map((c: unknown[]) => String(c[0]));
      expect(probed.some(s => /is_broadcast AND archived_at IS NULL/.test(s))).toBe(false);
      expect(inserts().some(s => /is_broadcast/.test(s))).toBe(false);
    });
  });

  describe('item 8 — "+ Create new organisation" mints a real root', () => {
    async function createRoot(over: Record<string, unknown> = {}) {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        if (isWorkspaceQuery(sql)) {return {n: 1};}
        if (/INSERT INTO public\.department_channels/.test(sql)) {return {id: 'root-1', level: 0};}
        return null;
      });
      return svc.createChannel(ORG, MGR, {name: 'SASFA', root: true, ...over});
    }

    it('root: true writes level 0 explicitly', async () => {
      // A BOOLEAN on the wire, never a level — level is trigger-derived
      // everywhere else, and accepting an integer would hand a caller the one
      // column the depth CHECK relies on.
      await createRoot();
      const ins = inserts().find(s => /level/.test(s)) ?? '';
      expect(ins).toMatch(/, level\)/);
      expect(ins).toMatch(/, 0\)/);
    });

    it('root is IGNORED when a parent is given — a child is never a root', async () => {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        if (isWorkspaceQuery(sql)) {return {n: 1};}
        if (/SELECT org_id, level, is_broadcast/.test(sql)) {
          return {org_id: ORG, level: 1, is_broadcast: false, parent_id: null,
            access: 'standard', channel_type: 'department'};
        }
        if (/INSERT INTO public\.department_channels/.test(sql)) {return {id: 'c', level: 2};}
        return null;
      });
      await svc.createChannel(ORG, MGR, {name: 'Sub', root: true, parent_id: 'p1'});
      expect(inserts().some(s => /, level\)/.test(s))).toBe(false);
    });

    it('an AGENCY may mint a root too — the tenants share one tree model', async () => {
      /**
       * FLIPPED by the 2026-08-26 unification. The old refusal existed because
       * the agency arm auto-ran `ensureBroadcastForLevel` after every create
       * and a level-0 caller was untested. That producer no longer exists for
       * ANY tenant, so the refusal's whole rationale is gone with it.
       */
      mockDb.qOne.mockImplementation(async (sql: string) =>
        (isWorkspaceQuery(sql) ? null : {id: 'root-a', level: 0}));
      await expect(svc.createChannel(ORG, MGR, {name: 'SASFA', root: true}))
        .resolves.toMatchObject({id: 'root-a'});
    });

    it('the level-0 broadcast trap is closed by REMOVAL — no producer exists', () => {
      /**
       * Strongest form of the old defence-in-depth pin: instead of asserting
       * the level-stating INSERT inside `ensureBroadcastForLevel`, assert the
       * method is GONE. Comment-stripped, so prose mentioning the old name
       * cannot satisfy or trip it (the false-result class CLAUDE.md documents).
       */
      const svcSrc = require('node:fs')
        .readFileSync(require('node:path').join(process.cwd(), 'src', 'department', 'department.service.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
      expect(svcSrc).not.toMatch(/ensureBroadcastForLevel/);
    });

    it('refuses a restricted PARENTLESS channel even without the root flag', async () => {
      /**
       * THE BYPASS. The refusal was keyed on `input.root === true`, so omitting
       * one boolean walked straight past it: `{name, access:'restricted'}` with
       * no parent_id still produced a parentless restricted root — and EVERY
       * existing workspace organisation is a parentless root, so that is
       * precisely the state the rule forbids.
       *
       * Every other root rule in the service asks `parent_id IS NULL`. This one
       * now agrees with them, which is what makes it unbypassable.
       */
      mockDb.qOne.mockImplementation(async (sql: string) =>
        (isWorkspaceQuery(sql) ? {n: 1} : {id: 'x', level: 1}));
      await expect(svc.createChannel(ORG, MGR, {name: 'SASFA', access: 'restricted'}))
        .rejects.toThrow('restricted_root_not_allowed');
      expect(inserts()).toEqual([]);
    });

    it('an AGENCY may still create a top-level incident channel', async () => {
      // The tenant gate on that refusal is load-bearing: seedsManagersOnly also
      // covers channel_type 'incident', and agencies legitimately run top-level
      // incident channels. An ungated structural rule would have started
      // 400-ing them.
      mockDb.qOne.mockImplementation(async (sql: string) =>
        (isWorkspaceQuery(sql) ? null : {id: 'inc-1', level: 1}));
      await expect(svc.createChannel(ORG, MGR, {name: 'Incidents', channel_type: 'incident'}))
        .resolves.toMatchObject({id: 'inc-1'});
    });

    it('REFUSES a restricted root — it would empty every member\'s directory', async () => {
      // A root nobody can see gives every member below it parent_hidden Mains
      // with no visible ancestor: a directory with zero organisations in it.
      // Server-side because a client-only rule is reachable by editing the root
      // afterwards.
      await expect(createRoot({access: 'restricted'})).rejects.toThrow(BadRequestException);
      await expect(createRoot({channel_type: 'incident'})).rejects.toThrow('restricted_root_not_allowed');
      expect(inserts()).toEqual([]);
    });
  });

  describe('configureChannel — the SECOND door onto a restricted root', () => {
    /** Tighten `ch-1` to restricted; `workspace` decides the tenant answer,
     *  `children` how many live children the row has. */
    async function tighten(workspace: boolean, children: number, parentId: string | null = null) {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        if (isWorkspaceQuery(sql)) {return workspace ? {n: 1} : null;}
        if (/SELECT org_id, channel_type, access, name, post_mode, is_broadcast/.test(sql)) {
          return {org_id: ORG, channel_type: 'department', access: 'standard',
            name: 'SASFA', post_mode: 'open', is_broadcast: false, parent_id: parentId};
        }
        if (/COUNT\(\*\)::int AS n/.test(sql)) {return {n: children};}
        return null;
      });
      return svc.configureChannel(ORG, MGR, 'ch-1', {access: 'restricted'});
    }

    it('refuses tightening a CHILDLESS workspace root', async () => {
      /**
       * createChannel's comment claimed this refusal lived on both verbs. It did
       * not — configureChannel only refused when the root HAD children, a
       * carve-out written for legacy flat level-1 channels where "childless
       * top-level orphans nobody".
       *
       * Item 8's organisation roots break that: a freshly created, still-empty
       * organisation can be tightened in two taps, after which it is invisible
       * to every member AND can never take children (createChannel refuses a
       * restricted-root parent). A directory with zero organisations, and no
       * way back.
       */
      await expect(tighten(true, 0)).rejects.toThrow('restricted_root_not_allowed');
    });

    it('still refuses when it HAS children, with the orphan-specific code', async () => {
      await expect(tighten(true, 3)).rejects.toThrow('restricted_root_would_orphan_children');
    });

    it('an AGENCY root may still be tightened when childless', async () => {
      // Unchanged behaviour for the tenant that never asked for this.
      await expect(tighten(false, 0)).resolves.toBeDefined();
    });

    it('a workspace NON-root may be tightened — only roots are guarded', async () => {
      // A restricted node mid-tree is ordinary; the renderer has a case for it.
      await expect(tighten(true, 0, 'parent-1')).resolves.toBeDefined();
    });
  });

  describe('the #broadcast a workspace already has can be removed', () => {
    async function archive(workspace: boolean) {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        if (isWorkspaceQuery(sql)) {return workspace ? {n: 1} : null;}
        if (/SELECT org_id, channel_type, access, name, post_mode, is_broadcast/.test(sql)) {
          return {org_id: ORG, channel_type: 'board', access: 'standard', name: '#broadcast',
            post_mode: 'announcement', is_broadcast: true, parent_id: null};
        }
        if (/COUNT\(\*\)::int AS n/.test(sql)) {return {n: 0};}
        return null;
      });
      return svc.archiveChannel(ORG, MGR, 'bcast-1');
    }

    it('a WORKSPACE may archive its broadcast', async () => {
      await expect(archive(true)).resolves.toEqual({ok: true});
    });

    it('an AGENCY may archive its legacy broadcast too', async () => {
      // Existing service providers keep their seeded rows (nothing is deleted
      // for them) — parity means they can now REMOVE them themselves, which is
      // exactly what the client's screenshot was about.
      await expect(archive(false)).resolves.toEqual({ok: true});
    });
  });
});
