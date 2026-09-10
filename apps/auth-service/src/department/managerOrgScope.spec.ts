/**
 * G5 (founder, 2026-08-19) — "When adding Admins, it should be organization
 * specific only. Admins should not be able to see other organizations."
 *
 * Inside a WORKSPACE tenant an "organisation" is a root CHANNEL (SASFA, GSSG),
 * not an `org_id` — one tenant holds several — and nothing scoped a delegated
 * manager to one of them. `listOrgChannels` is `WHERE c.org_id = $1`, so an
 * admin added to SASFA opened Manage Channels and administered GSSG too.
 *
 * The answer is DERIVED from membership rows that already exist rather than
 * stored in a new column. `department.service.ts` carries the full reasoning;
 * the short version is that this service `SELECT`s its columns literally, so a
 * client shipping ahead of an unapplied migration takes `42703
 * undefined_column` — a 500 across the entire Department Channels module.
 *
 * ⚠️ WHAT THIS IS NOT. It is a VISIBILITY scope, not an authorization boundary.
 * Every mutation is still gated by `OrgManagerGuard` + `assertManagesChannel`.
 * Do not start relying on it as a permission check.
 *
 * The DB is MOCKED here, so these are claims about the derivation, not about
 * what Postgres returns for the membership query.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};
const ORG = 'org-1';
const MANAGER = 'mgr-1';

/** One admin-source row. Only id/parent_id matter to the walk; the rest exists
 *  because `mintRefusalFor` reads it and would otherwise throw. */
const chan = (id: string, parent_id: string | null, over: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), department: null, description: null,
  channel_type: 'department', access: 'standard', org_id: ORG, created_by: ORG,
  has_children: false, parent_id, level: parent_id ? 2 : 0,
  post_mode: 'open', is_broadcast: false, is_lateral: false, member_count: 1,
  provisioned: true, archived: false, created_at: 'now', ...over,
});

/** SASFA → RSA, and a second organisation the scoped admin must not see. */
const ROWS = [
  chan('sasfa', null), chan('rsa', 'sasfa'), chan('gssg', null), chan('gssg-ops', 'gssg'),
];

describe('G5 — manager_scope_root_ids', () => {
  let svc: DepartmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
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
   * `isWorkspaceTenant` is a qOne; then the rows q; then (only when it gets
   * that far) the membership q. Stating the order here rather than in six
   * places is what stops a future insertion silently feeding the rows query's
   * result to the membership walk.
   */
  const arrange = (opts: {workspace: boolean; memberships: string[]}) => {
    mockDb.qOne.mockResolvedValueOnce(opts.workspace ? {n: 1} : null);
    mockDb.q.mockResolvedValueOnce(ROWS);
    mockDb.q.mockResolvedValueOnce(opts.memberships.map(channel_id => ({channel_id})));
  };

  it('a delegated manager seeded inside SASFA is scoped to SASFA', async () => {
    arrange({workspace: true, memberships: ['rsa']});
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    // The membership is on the CHILD; the scope is the organisation above it.
    expect(out.manager_scope_root_ids).toEqual(['sasfa']);
  });

  it('a manager seeded in BOTH organisations is scoped to both, without duplicates', async () => {
    arrange({workspace: true, memberships: ['rsa', 'sasfa', 'gssg-ops']});
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    expect(out.manager_scope_root_ids?.slice().sort()).toEqual(['gssg', 'sasfa']);
  });

  it('the OWNER is never scoped — it governs the whole tenant', async () => {
    // managerUserId === orgUserId. Short-circuits before the membership query,
    // which is also why only two db calls are arranged below.
    mockDb.qOne.mockResolvedValueOnce({n: 1});
    mockDb.q.mockResolvedValueOnce(ROWS);
    const out = await svc.listOrgChannels(ORG, null, ORG);
    expect(out.manager_scope_root_ids).toBeNull();
    // …and it did NOT pay for a membership round-trip to find that out.
    expect(mockDb.q).toHaveBeenCalledTimes(1);
  });

  it('an AGENCY is never scoped — its branch scope is `department` and stays so', async () => {
    /**
     * The tenant gate is load-bearing, not tidiness. Agencies actively use
     * typed departments for real branch scope; layering a second,
     * differently-derived scope on top would narrow a live permission surface
     * the founder did not ask to change.
     */
    mockDb.qOne.mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce(ROWS);
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    expect(out.manager_scope_root_ids).toBeNull();
    expect(mockDb.q).toHaveBeenCalledTimes(1);
  });

  it('a PRE-A4 caller that omits the user id is never scoped', async () => {
    // `managerUserId` is optional and an old controller does not pass one.
    // Scoping on an unknown caller would be scoping on nobody.
    mockDb.qOne.mockResolvedValueOnce({n: 1});
    mockDb.q.mockResolvedValueOnce(ROWS);
    const out = await svc.listOrgChannels(ORG, null);
    expect(out.manager_scope_root_ids).toBeNull();
  });

  it('NO memberships FAILS OPEN — null, never an empty array', async () => {
    /**
     * THE ASSERTION THAT MATTERS MOST. `[]` reaching the client means "scoped
     * to nothing", and the admin dashboard renders exactly that: no
     * organisations, no create card, nothing to explain it — indistinguishable
     * from data loss. Narrowing what an admin sees is the safe direction;
     * blanking a screen they can use today is not.
     */
    arrange({workspace: true, memberships: []});
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    expect(out.manager_scope_root_ids).toBeNull();
  });

  it('a membership on a channel this org does not have is ignored, not crashed on', async () => {
    // The JOIN already excludes other orgs, so this is belt-and-braces against
    // a row set and a membership set that disagree mid-deploy.
    arrange({workspace: true, memberships: ['not-in-this-org']});
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    expect(out.manager_scope_root_ids).toBeNull();
  });

  it('the membership query is scoped to the CALLER and to THIS org', async () => {
    /**
     * Both halves are a disclosure boundary. Dropping `m.user_id` would scope
     * every admin to the union of everyone's memberships; dropping `c.org_id`
     * would let a membership in another tenant name a root here.
     */
    arrange({workspace: true, memberships: ['rsa']});
    await svc.listOrgChannels(ORG, null, MANAGER);
    const [sql, params] = mockDb.q.mock.calls[1];
    expect(String(sql)).toMatch(/WHERE m\.user_id = \$1 AND c\.org_id = \$2/);
    expect(params).toEqual([MANAGER, ORG]);
  });

  it('the walk REFUSES a broadcast terminus (guard-level pin — see the note)', async () => {
    /**
     * `seedOrgWorkspace` and the 2026-08-05 backfill's `level <= 1` arm both
     * mint parentless broadcasts, and EVERY active member is seeded into them.
     * The walk terminates on the row itself, so without the guard the response
     * claims a broadcast id is an "organisation root".
     *
     * The damage is not cosmetic: the client's `topLevelOf` skips broadcast
     * rows, so such an id can never match anything there. The set is non-empty
     * for the wrong reason, which defeats THIS function's "empty means
     * unscoped" fail-open and hands the client a scope that silently fails open
     * one layer down instead. Two fail-opens firing for a reason nobody
     * intended is how a rule quietly stops existing.
     *
     * ⚠️ THIS PINS THE GUARD, NOT THE BEHAVIOUR, and says so rather than
     * overclaiming. The membership query's own `AND NOT c.is_broadcast` (pinned
     * by the next case) already makes this unreachable through real SQL, so the
     * fixture below feeds a row Postgres would not return. It is here because
     * the two live invariants that make it dead are both in other files, and a
     * relaxation of either silently reopens it.
     */
    mockDb.qOne.mockResolvedValueOnce({n: 1});
    mockDb.q.mockResolvedValueOnce([
      ...ROWS, chan('bc', null, {is_broadcast: true, level: 1}),
    ]);
    mockDb.q.mockResolvedValueOnce([{channel_id: 'bc'}]);
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    expect(out.manager_scope_root_ids).toBeNull();
  });

  it('only ADMIN memberships count — a viewer elsewhere does not widen the scope', async () => {
    /**
     * The founder asked which organisations somebody ADMINISTERS; a membership
     * row answers which they BELONG TO. `seedChannelMembers` gives a manager
     * `'admin'` unconditionally, so this filter can never drop their own
     * organisation — what it drops is every organisation where they are merely
     * a viewer, which is the common way a SASFA manager holds a GSSG row.
     *
     * Asserted on the SQL because the filter is where the decision lives; the
     * derivation above it is already covered.
     */
    arrange({workspace: true, memberships: ['rsa']});
    await svc.listOrgChannels(ORG, null, MANAGER);
    const sql = String(mockDb.q.mock.calls[1][0]);
    expect(sql).toMatch(/AND m\.role = 'admin'/);
    expect(sql).toMatch(/AND NOT c\.is_broadcast/);
  });

  it('a cycle in the parent chain terminates instead of spinning', async () => {
    /**
     * Re-parenting is refused by the DB so this is not producible today, but
     * the walk runs over server-shaped data on every admin page load and an
     * unbounded `while` is not worth two saved lines. The bound also caps a
     * legal deep chain, which is why it is four and not two.
     */
    mockDb.qOne.mockResolvedValueOnce({n: 1});
    mockDb.q.mockResolvedValueOnce([chan('a', 'b'), chan('b', 'a')]);
    mockDb.q.mockResolvedValueOnce([{channel_id: 'a'}]);
    const out = await svc.listOrgChannels(ORG, null, MANAGER);
    // Whatever it lands on, it LANDS — the test failing here would be a hang.
    expect(out.manager_scope_root_ids).toHaveLength(1);
  });
});
