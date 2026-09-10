import {ExecutionContext, ForbiddenException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OrgManagerGuard, assertOrgScope} from './org-manager.guard';

/** CRLF-normalised, comment-free source. The prose in both files under scan
 *  discusses the very arm being asserted absent, so a raw read would satisfy
 *  every assertion below on the EXPLANATION of the defect. */
function source(rel: string): string {
  return readFileSync(join(process.cwd(), 'src', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

const mockDb = {q: jest.fn(), qOne: jest.fn()};

function ctxWith(user: unknown): {ctx: ExecutionContext; req: any} {
  const req: any = {user};
  const ctx = {
    switchToHttp: () => ({getRequest: () => req}),
  } as unknown as ExecutionContext;
  return {ctx, req};
}

describe('OrgManagerGuard', () => {
  let guard: OrgManagerGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    // vs2 item 4 — the managed-org lookup is now `q` (a SET: a person may
    // manage several orgs). `resetAllMocks` clears the return value, and an
    // undefined where the driver always gives an array is a harness gap, not
    // a code one — the guard must not gain a `?? []` to paper over a mock.
    mockDb.q.mockResolvedValue([]);
    guard = new OrgManagerGuard(mockDb as any);
  });

  it('rejects an unauthenticated request', async () => {
    const {ctx} = ctxWith(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a company agent as its own org and stamps req.orgManager (unscoped)', async () => {
    mockDb.qOne.mockResolvedValueOnce({user_id: 'org-1'}); // company agent lookup
    const {ctx, req} = ctxWith({sub: 'org-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'org-1', org_user_id: 'org-1', department: null});
  });

  /**
   * Scope v2 Phase 6 — THE OWNER ARM, tested by BEHAVIOUR.
   *
   * A source scan asserting the owner query exists is decorative here: deleting
   * the `if (asOwner) { ... return true; }` block leaves the query in place, so
   * the scan passes while the owner is never admitted and 403s on every manager
   * route — the whole roster surface, channel management, and the join-approval
   * inbox. Only running the guard can see that.
   */
  it('admits an Enterprise WORKSPACE OWNER as its own org (Path 1b)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)                        // no company agent
      .mockResolvedValueOnce({owner_user_id: 'own-1'});   // owns a workspace
    const {ctx, req} = ctxWith({sub: 'own-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Org-wide, exactly like the company-agent arm: an owner is not branch-scoped.
    expect(req.orgManager).toEqual({user_id: 'own-1', org_user_id: 'own-1', department: null});
    // …and it never needed a manager row or a tier read to get there.
    expect(mockDb.qOne).toHaveBeenCalledTimes(2);
  });

  it('the owner lookup is lapse-aware, so a lapsed owner falls through', async () => {
    const sql = String(mockDb.qOne.mock.calls[0]?.[0] ?? '');
    void sql; // shape asserted below from a fresh call
    mockDb.qOne
      .mockResolvedValueOnce(null)   // no company agent
      .mockResolvedValueOnce(null)   // owner row REFUSED by the tier predicate
      .mockResolvedValueOnce(null)   // not a delegated manager
      .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null});
    const {ctx} = ctxWith({sub: 'own-lapsed'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    const ownerSql = String(mockDb.qOne.mock.calls[1][0]);
    expect(ownerSql).toMatch(/subscription_tier = 'enterprise'/);
    expect(ownerSql).toMatch(/pro_active_until IS NULL OR u\.pro_active_until > NOW\(\)/);
  });

  it('admits a delegated manager and resolves their org from org_members', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null) // does not own a workspace
      ; // …and the manager lookup is now `q` — a SET, since item 4
    mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-7', department: null}]);
    const {ctx, req} = ctxWith({sub: 'mgr-2'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'mgr-2', org_user_id: 'org-7', department: null});
  });

  it('carries a department-scoped manager\'s scope on the context (PDF p.9/p.16)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null); // does not own a workspace
    mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-7', department: 'Operations'}]);
    const {ctx, req} = ctxWith({sub: 'mgr-3'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'mgr-3', org_user_id: 'org-7', department: 'Operations'});
  });

  it('rejects a plain CPO (member but not manager / not company)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null) // does not own a workspace
      .mockResolvedValueOnce(null); // no active manager row
    const {ctx} = ctxWith({sub: 'cpo-9'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('D4-c: the company path requires status = ACTIVE (a suspended company is excluded)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // no ACTIVE company row (suspended)
      .mockResolvedValueOnce(null) // does not own a workspace
      .mockResolvedValueOnce(null); // not a manager either
    const {ctx} = ctxWith({sub: 'org-suspended'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(String(mockDb.qOne.mock.calls[0][0])).toMatch(/type = 'company' AND status = 'ACTIVE'/);
  });
});

/**
 * F2 — BUYING THE SUBSCRIPTION MUST NOT GRANT ADMIN AUTHORITY.
 *
 * This block previously asserted the OPPOSITE: it pinned an "M1A Path 3" arm
 * that admitted ANY active enterprise-tier user as manager of an implicit org
 * whose id was their own user id. That made the PAYMENT the authorization.
 * Frame A4: "A user without a verified path must not reach Admin controls" and
 * "Admin selection alone must never create authority." Measured on staging
 * before the fix: a plain enterprise-tier individual with no workspace and no
 * org got `is_org_manager: true`, `org: null`, and `POST /department/channels`
 * returned 200.
 *
 * The verified paths are Path 1 (company agent), Path 1b (workspace owner) and
 * Path 2 (delegated manager). A tier is not one of them — the buyer becomes an
 * admin by CREATING the workspace, which is still gated on the tier by
 * WorkspaceService.
 */
describe('OrgManagerGuard — F2: a paid tier is NOT a path to authority', () => {
  let guard: OrgManagerGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    // vs2 item 4 — the managed-org lookup is now `q` (a SET: a person may
    // manage several orgs). `resetAllMocks` clears the return value, and an
    // undefined where the driver always gives an array is a harness gap, not
    // a code one — the guard must not gain a `?? []` to paper over a mock.
    mockDb.q.mockResolvedValue([]);
    guard = new OrgManagerGuard(mockDb as any);
  });

  /**
   * The tier row is STILL MOCKED on purpose. If it were omitted the pre-fix
   * guard would read `undefined`, resolve a lite tier and throw anyway — the
   * test would pass against the defect. Supplying an active enterprise row is
   * what makes this red before the fix and green after.
   */
  it('REFUSES an ACTIVE enterprise-tier individual with no workspace and no org', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null) // owns no workspace — never created one
      .mockResolvedValueOnce(null) // not a delegated manager
      .mockResolvedValueOnce({subscription_tier: 'enterprise', pro_active_until: null});
    const {ctx, req} = ctxWith({sub: 'ent-1'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    // …and nothing was stamped, so a downstream @CurrentOrgManager cannot read
    // a fabricated org off the request even if a route forgot the guard order.
    expect(req.orgManager).toBeUndefined();
  });

  /**
   * The stronger form: the tier is never even CONSULTED. Counting the reads is
   * what catches a re-introduction that resolves the tier some other way (a
   * different helper, a join onto users) — the arm is gone, not merely
   * narrowed. Exactly three reads: company agent, workspace owner, manager row.
   */
  it('never issues a tier read at all — three DB reads, then a refusal', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const {ctx} = ctxWith({sub: 'ent-2'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    // Two `qOne` (company agent, workspace owner) + one `q` (managed orgs).
    // Still three reads and still no tier read — the third simply moved to
    // the set-returning helper when a manager became able to hold several.
    expect(mockDb.qOne).toHaveBeenCalledTimes(2);
    expect(mockDb.q).toHaveBeenCalledTimes(1);
  });

  /** The buyer's real path: create a workspace, then Path 1b admits them. */
  it('but an enterprise buyer who CREATED a workspace still passes (Path 1b)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)                       // no company agent
      .mockResolvedValueOnce({owner_user_id: 'ent-1'});  // owns a workspace
    const {ctx, req} = ctxWith({sub: 'ent-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'ent-1', org_user_id: 'ent-1', department: null});
  });

  it('provider paths win FIRST — a company agent stops at one read (rule 7)', async () => {
    mockDb.qOne.mockResolvedValueOnce({user_id: 'org-1'});
    const {ctx} = ctxWith({sub: 'org-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockDb.qOne).toHaveBeenCalledTimes(1);
  });
});

/**
 * …AND THE MIRROR. `resolveIsOrgManager` exists to PREDICT what this guard
 * admits, so the tier arm had to die on both sides in one change: leaving it in
 * the mirror would keep `/auth/me` reporting `is_org_manager: true` for a buyer
 * the server then 403s on every manager route — the client and the server
 * disagreeing about the same person, which is the shape frame A4 calls out.
 *
 * A source scan, because a unit test can only see the arm it was written for.
 */
describe('F2 — neither the guard nor its mirror has a tier arm', () => {
  it('the guard does not resolve a tier anywhere', () => {
    const src = source(join('org', 'org-manager.guard.ts'));
    // effectiveTierOf(...) === 'enterprise' WAS the tier-only decision.
    expect(src).not.toMatch(/effectiveTierOf/);
    // The owner arm's activeEnterpriseSql must SURVIVE — it lapses a real
    // workspace owner and is not a tier-only grant. Asserting it is present is
    // what keeps the ban above from being satisfied by deleting Path 1b.
    expect(src).toMatch(/activeEnterpriseSql\('u'\)/);
    expect(src).toMatch(/FROM public\.org_workspaces w/);
  });

  it('resolveIsOrgManager admits exactly company OR owner OR manager', () => {
    const src = source(join('auth', 'account-kind.ts'));
    const fn = src.slice(src.indexOf('export async function resolveIsOrgManager'));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toMatch(/is_enterprise/);
    // Assert the DECISION SITE, not merely the absence of a token: an arm could
    // come back under any name, and this is the one line that consumes them.
    expect(fn).toMatch(/row\.is_company \|\| row\.is_owner \|\| row\.is_manager\)/);
  });
});

describe('assertOrgScope', () => {
  it('passes when the manager acts on their own org', () => {
    expect(() =>
      assertOrgScope({user_id: 'm', org_user_id: 'org-1', department: null}, 'org-1'),
    ).not.toThrow();
  });

  it('throws a scope violation when acting on a different org', () => {
    expect(() =>
      assertOrgScope({user_id: 'm', org_user_id: 'org-1', department: null}, 'org-2'),
    ).toThrow(/org_scope_violation/);
  });
});
