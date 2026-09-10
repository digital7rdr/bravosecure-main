/**
 * F12 — PAGING + LAZY LOADING for the channel lists.
 *
 * `listChannels` and `listChannelsForOps` had no LIMIT, no OFFSET and no cursor:
 * every call returned every row a caller could see, forever. The PDF asks for
 * paging and lazy loading, and an unbounded list query is one large tenant away
 * from a response nobody can render.
 *
 * KEYSET, not OFFSET — these lists grow at the head, so an OFFSET page N shifts
 * under the client the moment a channel is created mid-scroll (rows duplicated
 * or skipped), and OFFSET still scans everything it skips.
 *
 * THE TWO ORDERINGS ARE DELIBERATELY DIFFERENT and both are pinned here:
 *   listChannels        level ASC, created_at DESC — a tree renderer depends on
 *                       a parent preceding its children;
 *   listChannelsForOps  created_at DESC — the ops table is FLAT with no depth
 *                       column, so level-first only reordered an HQ operator's
 *                       rows for a consumer that does not exist yet.
 * Paging must not "harmonise" them.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';
import {DepartmentController} from './department.controller';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};

/** A row as the DB hands it back — with the internal cursor column attached. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {id: 'ch-1', name: 'Ops', level: 1, _cursor: '1|2026-08-01 10:00:00+00|ch-1', ...over};
}

describe('F12 — listChannels is bounded and pageable', () => {
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

  it('ALWAYS applies a LIMIT, even when the caller asks for no paging', () => {
    return svc.listChannels('user-1').then(() => {
      const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/LIMIT \$5/);
      // The bound is the point: the default page must be a real number, not
      // a sentinel that re-opens the unbounded query.
      expect(params[4]).toBe(DepartmentService.DEFAULT_PAGE_SIZE);
      expect(DepartmentService.DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
    });
  });

  it('keeps the tree ordering — level ASC then created_at DESC', async () => {
    await svc.listChannels('user-1');
    const sql = String(mockDb.q.mock.calls[0][0])
      .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/ORDER BY c\.level ASC, c\.created_at DESC/);
    // c.id is the keyset TIE-BREAK: created_at is not unique, and a cursor over
    // a non-unique key silently drops or repeats tied rows at a page boundary.
    expect(sql).toMatch(/ORDER BY c\.level ASC, c\.created_at DESC, c\.id DESC/);
  });

  it('the first page sends NULL keys, so the predicate is inert', async () => {
    await svc.listChannels('user-1');
    const params = mockDb.q.mock.calls[0][1] as unknown[];
    expect(params.slice(0, 4)).toEqual(['user-1', null, null, null]);
  });

  it('a cursor walks the composite key in the SAME directions as the ORDER BY', async () => {
    await svc.listChannels('user-1', {cursor: '2|2026-08-01 10:00:00+00|ch-9'});
    const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
    expect(params.slice(0, 4)).toEqual(['user-1', '2', '2026-08-01 10:00:00+00', 'ch-9']);
    const code = sql.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    // level ASCENDING…
    expect(code).toMatch(/c\.level > \$2::smallint/);
    // …then created_at and id DESCENDING, which is why this cannot be a single
    // row-value comparison.
    expect(code).toMatch(/c\.level = \$2::smallint AND c\.created_at < \$3::timestamptz/);
    expect(code).toMatch(/c\.created_at = \$3::timestamptz\s*\n?\s*AND c\.id < \$4::uuid/);
  });

  it('clamps an oversized limit and floors a fractional one', async () => {
    await svc.listChannels('user-1', {limit: 99999});
    expect((mockDb.q.mock.calls[0][1] as unknown[])[4]).toBe(DepartmentService.MAX_PAGE_SIZE);
    mockDb.q.mockClear();
    await svc.listChannels('user-1', {limit: 10.7});
    expect((mockDb.q.mock.calls[0][1] as unknown[])[4]).toBe(10);
  });

  it('falls back to the default for a junk limit rather than an unbounded query', async () => {
    for (const bad of [0, -5, Number.NaN, null, undefined]) {
      mockDb.q.mockClear();
      await svc.listChannels('user-1', {limit: bad as number});
      expect(`${String(bad)}:${(mockDb.q.mock.calls[0][1] as unknown[])[4]}`)
        .toBe(`${String(bad)}:${DepartmentService.DEFAULT_PAGE_SIZE}`);
    }
  });

  it('REFUSES a malformed cursor instead of silently restarting at page 1', async () => {
    // Silently treating it as "no cursor" makes a paging client loop forever on
    // page 1; passing a partial tuple through hands Postgres a bad timestamp.
    for (const bad of ['nonsense', '1|2026-08-01 10:00:00+00', 'a|b|c|d', '1||ch-9']) {
      mockDb.q.mockClear();
      await expect(svc.listChannels('user-1', {cursor: bad}))
        .rejects.toThrow(BadRequestException);
      expect(mockDb.q).not.toHaveBeenCalled();
    }
  });

  it('returns a next_cursor only when the page was FULL', async () => {
    // A short page is provably the last one.
    mockDb.q.mockResolvedValueOnce([row(), row({id: 'ch-2'})]);
    const short = await svc.listChannels('user-1');
    expect(short.next_cursor).toBeNull();

    mockDb.q.mockResolvedValueOnce([
      row({_cursor: 'a'}), row({id: 'ch-2', _cursor: 'LAST'}),
    ]);
    const full = await svc.listChannels('user-1', {limit: 2});
    expect(full.next_cursor).toBe('LAST');
  });

  it('STRIPS the cursor column, so the row shape every client parses is unchanged', async () => {
    // This is what makes paging backward-compatible: the paging key is an
    // implementation detail of the query, not a new field on every channel.
    mockDb.q.mockResolvedValueOnce([row()]);
    const page = await svc.listChannels('user-1');
    expect(page.channels).toHaveLength(1);
    expect(Object.keys(page.channels[0])).not.toContain('_cursor');
    expect(page.channels[0]).toMatchObject({id: 'ch-1', name: 'Ops'});
  });
});

describe('F12 — listChannelsForOps is bounded and pageable', () => {
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

  it('ALWAYS applies a LIMIT', async () => {
    await svc.listChannelsForOps();
    const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LIMIT \$3/);
    expect(params[2]).toBe(DepartmentService.DEFAULT_PAGE_SIZE);
  });

  /**
   * THE ORDERING DIFFERENCE IS DELIBERATE AND DOCUMENTED. Ops renders a flat
   * table; level-first there was a live behaviour change for a consumer that
   * does not exist. Paging must not quietly unify the two lists.
   */
  it('keeps its RECENCY order — level-first stays member-only', async () => {
    await svc.listChannelsForOps();
    const sql = String(mockDb.q.mock.calls[0][0])
      .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/ORDER BY c\.created_at DESC, c\.id DESC/);
    expect(sql).not.toMatch(/ORDER BY c\.level/);
  });

  it('pages on (created_at, id) — two fields, because it is not level-ordered', async () => {
    await svc.listChannelsForOps({cursor: '2026-08-01 10:00:00+00|ch-9'});
    const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
    expect(params.slice(0, 2)).toEqual(['2026-08-01 10:00:00+00', 'ch-9']);
    const code = sql.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/c\.created_at < \$1::timestamptz/);
    expect(code).toMatch(/c\.created_at = \$1::timestamptz AND c\.id < \$2::uuid/);
  });

  it('rejects a THREE-part cursor — the member cursor is not interchangeable', async () => {
    await expect(svc.listChannelsForOps({cursor: '1|2026-08-01 10:00:00+00|ch-9'}))
      .rejects.toThrow(BadRequestException);
    expect(mockDb.q).not.toHaveBeenCalled();
  });

  it('strips the cursor column here too', async () => {
    mockDb.q.mockResolvedValueOnce([{id: 'ch-1', name: 'Ops', _cursor: 'x'}]);
    const page = await svc.listChannelsForOps();
    expect(Object.keys(page.channels[0])).not.toContain('_cursor');
  });
});

describe('F12 — the HTTP shapes stay backward-compatible', () => {
  it('/department/channels still returns {channels: [...]}, with next_cursor additive', async () => {
    const dept = {
      listChannels: jest.fn().mockResolvedValue({channels: [{id: 'ch-1'}], next_cursor: 'c1'}),
    };
    const ctl = new DepartmentController(dept as unknown as DepartmentService);
    const res = await ctl.listChannels({sub: 'u1'} as never, '25', 'abc');
    // The key every shipped client reads is untouched…
    expect(res.channels).toEqual([{id: 'ch-1'}]);
    // …and the cursor is purely additive.
    expect(res.next_cursor).toBe('c1');
    // Phase B — orgId rides the same options object; null when unsent.
    expect(dept.listChannels).toHaveBeenCalledWith('u1', {limit: 25, cursor: 'abc', orgId: null});
  });

  it('a caller that sends no query params gets the un-paged behaviour', async () => {
    const dept = {
      listChannels: jest.fn().mockResolvedValue({channels: [], next_cursor: null}),
    };
    const ctl = new DepartmentController(dept as unknown as DepartmentService);
    await ctl.listChannels({sub: 'u1'} as never);
    expect(dept.listChannels).toHaveBeenCalledWith('u1', {limit: null, cursor: null, orgId: null});
  });

  /**
   * /ops/departments MUST STAY A BARE ARRAY. The ops console types it as
   * `DepartmentChannelRow[]` (apps/ops-console/src/lib/api.ts), so wrapping it
   * in an envelope breaks the departments page at runtime. A source scan
   * because OpsController's constructor takes the whole ops service graph.
   */
  it('/ops/departments still returns an ARRAY, not an envelope', () => {
    const src = require('node:fs')
      .readFileSync(require('node:path').join(process.cwd(), 'src', 'ops', 'ops.controller.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
    const fn = src.slice(src.indexOf("@Get('departments')"), src.indexOf("@Get('jobs')"));
    expect(fn).toMatch(/listChannelsForOps\(/);
    // Unwrapped — the page's rows, never the page object.
    expect(fn).toMatch(/return page\.channels;/);
    expect(fn).not.toMatch(/return\s+(await\s+)?this\.departments\.listChannelsForOps/);
  });
});
