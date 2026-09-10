/**
 * Channels vs2 item 4 — multi-organisation membership, and the header that says
 * WHICH one a request is about.
 *
 * Founder decision 2026-08-12: yes to multi-org, Option A — a manager's
 * authority follows the organisation they are viewing, with no cap on how many
 * they may hold.
 *
 * ⚠️ THE SECURITY PROPERTY THIS FILE EXISTS FOR: the header NARROWS the
 * caller's real memberships and can never add one. If that ever stops holding,
 * one line of client code becomes cross-tenant access — a manager reading
 * another company's incident queue or approving its timesheets. Every test
 * below that names an org the caller does not hold expects the request to be
 * refused that org, not obeyed.
 */
import {ForbiddenException} from '@nestjs/common';
import type {ExecutionContext} from '@nestjs/common';
import {OrgManagerGuard} from './org-manager.guard';
import {readOrgContextHeader, pickOrgContext, ORG_CONTEXT_HEADER} from './org-context';

const mockDb = {q: jest.fn(), qOne: jest.fn()};

function ctxWith(user: unknown, headers: Record<string, unknown> = {}) {
  const req: Record<string, unknown> = {user, headers};
  const ctx = {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
  return {ctx, req: req as {orgManager?: {org_user_id: string; department: string | null; user_id: string}}};
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = '33333333-3333-4333-8333-333333333333';

describe('readOrgContextHeader — a header is untrusted input', () => {
  it('reads a uuid', () => {
    expect(readOrgContextHeader({headers: {[ORG_CONTEXT_HEADER]: ORG_A}})).toBe(ORG_A);
  });

  it.each([
    ['absent', {}],
    ['empty', {[ORG_CONTEXT_HEADER]: ''}],
    ['not a uuid', {[ORG_CONTEXT_HEADER]: 'org-1; DROP TABLE users'}],
    ['a number', {[ORG_CONTEXT_HEADER]: 42}],
    ['absurdly long', {[ORG_CONTEXT_HEADER]: 'a'.repeat(10000)}],
  ])('%s reads as null, which means "use my default"', (_label, headers) => {
    expect(readOrgContextHeader({headers: headers as Record<string, unknown>})).toBeNull();
  });

  it('takes the first value when a client sends the header twice', () => {
    expect(readOrgContextHeader({headers: {[ORG_CONTEXT_HEADER]: [ORG_A, ORG_B]}})).toBe(ORG_A);
  });
});

describe('pickOrgContext — it NARROWS, it never grants', () => {
  const rows = [{org_user_id: ORG_A}, {org_user_id: ORG_B}];

  it('no header gives the first candidate, i.e. the pre-item-4 behaviour', () => {
    expect(pickOrgContext(rows, null)?.org_user_id).toBe(ORG_A);
  });

  it('a header naming one of MY orgs selects it', () => {
    expect(pickOrgContext(rows, ORG_B)?.org_user_id).toBe(ORG_B);
  });

  it('a header naming an org I do NOT hold is ignored, not obeyed', () => {
    // THE escalation attempt. It must fall back to the caller's own default —
    // still their data — rather than returning ORG_C.
    expect(pickOrgContext(rows, ORG_C)?.org_user_id).toBe(ORG_A);
  });

  it('no memberships gives null, whatever the header claims', () => {
    expect(pickOrgContext([], ORG_C)).toBeNull();
  });
});

describe('OrgManagerGuard — authority follows the viewed organisation', () => {
  let guard: OrgManagerGuard;
  beforeEach(() => {
    jest.resetAllMocks();
    mockDb.q.mockResolvedValue([]);
    guard = new OrgManagerGuard(mockDb as never);
  });

  it('a manager of TWO orgs administers the one named by the header', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([
      {org_user_id: ORG_A, department: null},
      {org_user_id: ORG_B, department: null},
    ]);
    const {ctx, req} = ctxWith({sub: 'mgr'}, {[ORG_CONTEXT_HEADER]: ORG_B});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_B);
  });

  it('and the OLDEST when no header is sent, deterministically', async () => {
    // Not "whichever row Postgres returned first": without ORDER BY that is
    // unstable between requests, so the same manager would administer a
    // different company on consecutive taps.
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([
      {org_user_id: ORG_A, department: null},
      {org_user_id: ORG_B, department: null},
    ]);
    const {ctx, req} = ctxWith({sub: 'mgr'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
    expect(String(mockDb.q.mock.calls[0][0])).toMatch(/ORDER BY created_at ASC/);
  });

  it('CANNOT be pointed at an org the caller does not manage', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([{org_user_id: ORG_A, department: null}]);
    const {ctx, req} = ctxWith({sub: 'mgr'}, {[ORG_CONTEXT_HEADER]: ORG_C});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Their own org, NOT the one they asked for.
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('an OWNER viewing an org they also manage gets THAT org', async () => {
    /**
     * The ordering change item 4 required. The owner arm used to return
     * immediately, so an owner of A who also manages B administered A even
     * while looking at B — under Option A, the wrong company's data.
     */
    mockDb.qOne.mockResolvedValueOnce(null)             // not a company agent
      .mockResolvedValueOnce({owner_user_id: ORG_A});   // owns A
    mockDb.q.mockResolvedValueOnce([{org_user_id: ORG_B, department: null}]);
    const {ctx, req} = ctxWith({sub: ORG_A}, {[ORG_CONTEXT_HEADER]: ORG_B});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_B);
  });

  it('and their OWN workspace with no header — precedence is unchanged', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce({owner_user_id: ORG_A});
    const {ctx, req} = ctxWith({sub: ORG_A});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('a company agent still stops at ONE read when no context is named', async () => {
    // Rule 7. Gathering every arm unconditionally would cost two extra queries
    // per request on every manager route, to choose between candidates nobody
    // asked about.
    mockDb.qOne.mockResolvedValueOnce({user_id: ORG_A});
    const {ctx, req} = ctxWith({sub: ORG_A});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
    expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('a company agent who ALSO manages another org can switch to it', async () => {
    /**
     * The one path where an existing persona's behaviour changed. Before item 4
     * the company arm returned immediately, so an agency owner who also managed
     * a client workspace could never reach it. Now a header naming that
     * workspace skips the short-circuit and resolves to it.
     *
     * This arm backs dispatch and claim-booking, so it is the one worth pinning
     * explicitly rather than inferring from the manager tests.
     */
    mockDb.qOne.mockResolvedValueOnce({user_id: ORG_A})   // is a company agent
      .mockResolvedValueOnce(null);                        // owns no workspace
    mockDb.q.mockResolvedValueOnce([{org_user_id: ORG_B, department: null}]);
    const {ctx, req} = ctxWith({sub: ORG_A}, {[ORG_CONTEXT_HEADER]: ORG_B});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_B);
  });

  it('...and a header naming an org they do NOT hold falls back to their own', async () => {
    // NARROWS, never grants: an unheld org is not obeyed, and the caller keeps
    // exactly the authority they had before item 4.
    mockDb.qOne.mockResolvedValueOnce({user_id: ORG_A}).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([]);
    const {ctx, req} = ctxWith({sub: ORG_A}, {[ORG_CONTEXT_HEADER]: ORG_C});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('a multi-org WRITE is NOT refused for want of a header', async () => {
    /**
     * I added an `org_context_required` refusal here and it had to come out.
     *
     * The reasoning was fine in isolation — a write that could land on either
     * of two orgs should name one. What makes it unshippable is that the client
     * cannot always send a header: the context is set in exactly two places and
     * is not persisted, so it is null after every cold start, and this guard is
     * mounted class-wide on three DISPATCH controllers whose writes are
     * deliberately never stamped. A delegated manager of an agency who also
     * manages a workspace — the persona item 4 exists for — was 403'd on Accept
     * Offer with no client action able to clear it.
     *
     * This test is the tombstone. A server rule may only require what every
     * door already sends.
     */
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([
      {org_user_id: ORG_A, department: null},
      {org_user_id: ORG_B, department: null},
    ]);
    const {ctx, req} = ctxWith({sub: 'dana'});
    (ctx.switchToHttp().getRequest() as {method?: string}).method = 'POST';
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('a single-org manager writes exactly as before', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([{org_user_id: ORG_A, department: null}]);
    const {ctx, req} = ctxWith({sub: 'solo'});
    (ctx.switchToHttp().getRequest() as {method?: string}).method = 'POST';
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('and a multi-org READ still answers, defaulting to the oldest', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([
      {org_user_id: ORG_A, department: null},
      {org_user_id: ORG_B, department: null},
    ]);
    const {ctx, req} = ctxWith({sub: 'dana'});
    (ctx.switchToHttp().getRequest() as {method?: string}).method = 'GET';
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager?.org_user_id).toBe(ORG_A);
  });

  it('belonging to nothing is still a refusal, header or not', async () => {
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([]);
    const {ctx} = ctxWith({sub: 'nobody'}, {[ORG_CONTEXT_HEADER]: ORG_C});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a department-scoped manager keeps their scope in the CHOSEN org', async () => {
    // The scope belongs to the MEMBERSHIP, so switching org switches scope with
    // it — carrying A's department into B would filter B's data by a department
    // name that means nothing there.
    mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockDb.q.mockResolvedValueOnce([
      {org_user_id: ORG_A, department: 'Sales'},
      {org_user_id: ORG_B, department: 'Ops'},
    ]);
    const {ctx, req} = ctxWith({sub: 'mgr'}, {[ORG_CONTEXT_HEADER]: ORG_B});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'mgr', org_user_id: ORG_B, department: 'Ops'});
  });
});
