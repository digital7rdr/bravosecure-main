/**
 * Scope v2 Phase 5 — Monthly Roster (A7.2) and Attendance Corrections (A7.4).
 *
 * The behavioural cases run the real service against a mocked db. The
 * STRUCTURAL cases are source scans, because the invariants that matter most
 * here are ABSENCES — "the original is never updated", "the client never
 * supplies the time", "the branch is never passed as null" — and an absence is
 * exactly what a behavioural test stops seeing the moment someone adds the
 * thing back somewhere else.
 *
 * Carry-forward from Phases 3–4, applied deliberately:
 *  - assert the DECISION SITE, sliced to the function, never a token file-wide;
 *  - a fixture that mocks the predicate under test cannot discriminate it;
 *  - `required` pins existence, not correctness — assert the VALUE.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {RosterService} from './roster.service';
import {CORRECTABLE_STATUSES} from './dto/roster.dto';

// withTransaction hands back mockDb ITSELF, so the transaction is transparent
// to these tests and every existing `mockDb.qOne.mock.calls` assertion keeps
// meaning what it did. recordCorrection runs in a transaction because the
// FOR UPDATE row lock is only real inside one.
const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockAudit = {log: jest.fn().mockResolvedValue(undefined)};

const ORG = 'org-1';
const MGR = 'mgr-1';

function source(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'attendance', file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

/**
 * Strip SQL line comments before any ordering/absence assertion.
 *
 * Prose containing the banned word is the single most common false result in
 * this repo's source scans — the comments below deliberately EXPLAIN why
 * CASCADE and REFERENCES are absent, and would satisfy a naive scan for them.
 */
function stripSqlComments(sql: string): string {
  return sql.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
}

/**
 * THE BRANCH RULE FOR AN ATTENDANCE SESSION — asserted as an EXCLUSION.
 *
 * The predicate this replaces was `sh.department IS NULL OR sh.department = $3`,
 * which reads as branch-scoped and is not: a day-status session (leave /
 * sick_leave / off_duty / absent) and every legacy clock-in carry NO shift_id,
 * so `sh` never matches, the IS NULL arm is TRUE, and the branch test is OR-ed
 * away. Any branch manager could read AND CORRECT any other branch's sick-leave
 * records.
 *
 * Two tests asserted `/sh\.department = \$3/` throughout and stayed green the
 * whole time, because a token can be present while being disjoined into
 * irrelevance. So this asserts the shape that EXCLUDES:
 *   - the branch is resolved through the member when there is no shift, and
 *   - no bare `IS NULL` arm can re-open the hole.
 */
function expectBranchScoped(sql: string): void {
  const q = stripSqlComments(sql);
  // Resolved via the shift when there is one, via the CPO's org_members row
  // when there is not — never abandoned.
  expect(q).toMatch(/LEFT JOIN public\.org_members om/);
  expect(q).toMatch(/om\.org_user_id = s\.org_user_id AND om\.member_user_id = s\.cpo_user_id/);
  expect(q).toMatch(/COALESCE\(sh\.department, om\.department\) = \$3/);
  // THE REGRESSION GUARD: a null on either side must never widen the filter.
  expect(q).not.toMatch(/sh\.department IS NULL/);
  expect(q).not.toMatch(/om\.department IS NULL/);
}

// The tenancy pre-read findConflicts does before it will touch a month. It
// returns the month's own date and branch, which the conflict query then scopes
// by — so the fixture must carry them, or the test would be proving the query
// works with `undefined` bounds.
const OWNED = {id: 'rm-1', month: '2026-09-01', department: null};

const DRAFT = {
  id: 'rm-1', month: '2026-09-01', status: 'draft',
  published_at: null, amended_at: null, archived_at: null, department: null,
};

describe('RosterService', () => {
  let svc: RosterService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset().mockResolvedValue([]);
    mockDb.qOne.mockReset();
    mockDb.withTransaction.mockReset().mockImplementation(
      async (fn: (t: typeof mockDb) => unknown) => fn(mockDb));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RosterService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(RosterService);
  });

  describe('A7.2 — a month always has a STATE', () => {
    /**
     * THE GEOMETRY RULE. A draft month and a month nobody has touched are the
     * same thing to a member (nothing) and must be DIFFERENT things to a
     * manager — otherwise the founder-visible symptom is "I published it and
     * nothing happened". So OPENING THE PLANNER (a POST) creates the draft —
     * while the GET never writes; see the verb-split block below.
     */
    it('ensureMonth creates a DRAFT when absent, so the calendar has a state to show', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)        // no existing row
        .mockResolvedValueOnce(DRAFT);      // the insert
      const row = await svc.ensureMonth(ORG, MGR, '2026-09-15');
      expect(row.status).toBe('draft');
      const insert = String(mockDb.qOne.mock.calls[1][0]);
      expect(insert).toMatch(/INSERT INTO public\.cpo_roster_months/);
    });

    it('normalises ANY day in the month to the first', async () => {
      mockDb.qOne.mockResolvedValueOnce(DRAFT);
      await svc.ensureMonth(ORG, MGR, '2026-09-15');
      // Without this, two managers opening the 3rd and the 15th would be
      // planning two different "months".
      expect(mockDb.qOne.mock.calls[0][1]).toEqual([ORG, '2026-09-01', null]);
    });

    it('accepts a bare YYYY-MM', async () => {
      mockDb.qOne.mockResolvedValueOnce(DRAFT);
      await svc.ensureMonth(ORG, MGR, '2026-09');
      expect(mockDb.qOne.mock.calls[0][1]).toEqual([ORG, '2026-09-01', null]);
    });

    it('rejects a month it cannot parse, rather than inventing one', async () => {
      await expect(svc.ensureMonth(ORG, MGR, 'not-a-date')).rejects.toThrow(BadRequestException);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('two managers opening the same month do not race into two rows', async () => {
      // The INSERT is ON CONFLICT DO NOTHING, so the loser reads the winner's
      // row instead of erroring — opening a calendar is not a conflict.
      mockDb.qOne
        .mockResolvedValueOnce(null)        // no existing
        .mockResolvedValueOnce(null)        // insert lost the race
        .mockResolvedValueOnce(DRAFT);      // re-read
      const row = await svc.ensureMonth(ORG, MGR, '2026-09');
      expect(row).toEqual(DRAFT);
      expect(String(mockDb.qOne.mock.calls[1][0])).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    });
  });

  describe('A7.2 — the VERB SPLIT (pre-flag-flip blocker)', () => {
    /**
     * `GET /roster/month` used to CREATE a draft on first read — so a retry,
     * a prefetch, or a monitoring probe minted a real month, and a draft month
     * hides its shifts from `myTodayShift`, blocking member check-in. The GET
     * now reads only; creation moved to `POST month/ensure`.
     */
    it('readMonth NEVER writes — no INSERT on any path (mutation: restore create-on-read → RED)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);   // month never opened
      const row = await svc.readMonth(ORG, '2026-09-15');
      expect(row).toBeNull();
      // Anti-vacuity: the read must actually have queried — a stubbed
      // `return null` with no SQL at all would otherwise pass on ''.
      expect(mockDb.qOne).toHaveBeenCalledTimes(1);
      const allSql = [...mockDb.qOne.mock.calls, ...mockDb.q.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(allSql).toMatch(/SELECT/);
      expect(allSql).not.toMatch(/INSERT/i);
      expect(allSql).not.toMatch(/UPDATE/i);
    });

    it('readMonth returns the existing row with the same branch bucketing as ensureMonth', async () => {
      mockDb.qOne.mockResolvedValueOnce(DRAFT);
      const row = await svc.readMonth(ORG, '2026-09-15', 'Ops');
      expect(row).toEqual(DRAFT);
      expect(mockDb.qOne.mock.calls[0][1]).toEqual([ORG, '2026-09-01', 'Ops']);
      expect(String(mockDb.qOne.mock.calls[0][0])).toMatch(/COALESCE\(department, ''\) = COALESCE\(\$3::text, ''\)/);
    });

    /**
     * PUBLISH/ARCHIVE REQUIRE AN OPENED MONTH (edge-case review, 2026-08-07).
     * Create-on-publish left a silently-minted draft behind when the conflict
     * gate refused; create-on-archive was worse — a TERMINAL archived row for
     * a month nobody planned, with no un-archive path, hiding every later
     * shift in that month+branch from check-in AND the absent sweep.
     */
    it('publishMonth on a never-opened month is a 404, and MINTS NOTHING (mutation: restore ensureMonth → RED)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);   // readMonth: never planned
      await expect(svc.publishMonth(ORG, MGR, '2026-09')).rejects.toThrow(NotFoundException);
      const allSql = [...mockDb.qOne.mock.calls, ...mockDb.q.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(allSql).not.toMatch(/INSERT/i);
      expect(allSql).not.toMatch(/UPDATE/i);
    });

    it('archiveMonth on a never-opened month is a 404, and MINTS NOTHING', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.archiveMonth(ORG, MGR, '2026-09')).rejects.toThrow(NotFoundException);
      const allSql = [...mockDb.qOne.mock.calls, ...mockDb.q.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(allSql).not.toMatch(/INSERT/i);
      expect(allSql).not.toMatch(/UPDATE/i);
    });

    it('archiveMonth on an OPENED month archives it, org-scoped (the happy path the 404 guard made load-bearing)', async () => {
      const archived = {...DRAFT, status: 'archived', archived_at: '2026-09-20T00:00:00.000Z'};
      mockDb.qOne
        .mockResolvedValueOnce(DRAFT)       // readMonth finds the opened month
        .mockResolvedValueOnce(archived);   // the UPDATE returns the row
      const row = await svc.archiveMonth(ORG, MGR, '2026-09');
      expect(row.status).toBe('archived');
      const update = String(mockDb.qOne.mock.calls[1][0]);
      expect(update).toMatch(/UPDATE public\.cpo_roster_months/);
      expect(update).toMatch(/SET status = 'archived', archived_at = NOW\(\)/);
      // Org-scoped WHERE — a month id alone must never be enough.
      expect(update).toMatch(/WHERE id = \$1 AND org_user_id = \$2/);
      expect(mockDb.qOne.mock.calls[1][1]).toEqual([DRAFT.id, ORG]);
    });

    it('ensureMonth is reachable from EXACTLY ONE route: POST month/ensure (source scan)', () => {
      // The whole point of the split: opening the planner is the only act
      // that creates a month row. A future "helpful" ensure call in publish
      // or archive reintroduces both bugs above.
      const src = readFileSync(join(__dirname, 'roster.service.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n');
      const ensureCalls = src.match(/this\.ensureMonth\(/g) ?? [];
      expect(ensureCalls).toHaveLength(0);
      const ctrl = readFileSync(join(__dirname, 'roster.controller.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n');
      expect(ctrl.match(/this\.roster\.ensureMonth\(/g) ?? []).toHaveLength(1);
    });

    it('the controller wires GET → readMonth and POST month/ensure → ensureMonth (source scan)', () => {
      // The Phase-3 bug class: correct SQL, controller passing the wrong thing.
      // Strip comments so prose cannot satisfy the assertions — BLOCKS FIRST,
      // then line tails (a `//` inside a JSDoc, e.g. a URL, would otherwise
      // eat the block terminator and let the block regex swallow real code).
      const src = readFileSync(join(__dirname, 'roster.controller.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n');
      // The GET handler calls readMonth and never ensureMonth.
      const getBlock = src.slice(src.indexOf("@Get('month')"), src.indexOf("@Post('month/ensure')"));
      expect(getBlock).toMatch(/this\.roster\.readMonth\(/);
      expect(getBlock).not.toMatch(/ensureMonth/);
      // The ensure route is a POST and forwards the manager's branch.
      const ensureBlock = src.slice(src.indexOf("@Post('month/ensure')"), src.indexOf("@Get('month/:id/conflicts')"));
      expect(ensureBlock).toMatch(/this\.roster\.ensureMonth\(mgr\.org_user_id, mgr\.user_id, dto\.month, mgr\.department\)/);
    });
  });

  describe('A7.2 — conflict flagging BEFORE publish', () => {
    it('refuses to publish while a CPO is double-booked, and RETURNS the clashes', async () => {
      const clash = {
        cpo_user_id: 'u1', cpo_name: 'Sam', shift_a: 'a', shift_b: 'b',
        start_a: 'x', end_a: 'y', start_b: 'p', end_b: 'q',
      };
      mockDb.qOne.mockResolvedValueOnce(DRAFT);
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      mockDb.q.mockResolvedValueOnce([clash]);
      const res = await svc.publishMonth(ORG, MGR, '2026-09');
      // NOT an exception: this is the check working, so the UI gets the list.
      expect(res).toMatchObject({ok: false, reason: 'conflicts'});
      if (!res.ok) {expect(res.conflicts).toEqual([clash]);}
      // …and nothing was published.
      const wrote = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/UPDATE public\.cpo_roster_months/);
    });

    it('detects PARTIAL overlap, not just identical times', async () => {
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      // The only form that catches a 22:00–06:00 shift running into the next
      // morning's. Comparing dates or start times alone misses it.
      expect(sql).toMatch(/sa\.start_at < sb\.end_at/);
      expect(sql).toMatch(/sb\.start_at < sa\.end_at/);
    });

    it('reports each clashing PAIR once', async () => {
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1');
      expect(String(mockDb.q.mock.calls[0][0])).toMatch(/a\.shift_id < b\.shift_id/);
    });

    it('ignores archived shifts — they are not part of the plan', async () => {
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/sa\.archived_at IS NULL/);
      expect(sql).toMatch(/sb\.archived_at IS NULL/);
    });

    /**
     * The month id arrives from the URL. Org-scoping the SHIFTS is not enough:
     * a branch-scoped manager could pass a sibling branch's month id and read
     * that branch's whole roster. Every other read in this phase is
     * branch-scoped; this one was not.
     */
    it('REFUSES a month that is not the calling manager’s branch', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.findConflicts(ORG, 'rm-other', 'Ops')).rejects.toThrow(NotFoundException);
      // …and it never ran the conflict query at all.
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('scopes the ownership check to the branch when the manager has one', async () => {
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1', 'Ops');
      // The PREDICATE, not the params. Passing 'Ops' in the array proves only
      // that the branch was handed to the query — the array is unchanged even
      // when the WHERE clause that uses it is deleted, so asserting on it
      // cannot discriminate the bug it is here to catch.
      const own = stripSqlComments(String(mockDb.qOne.mock.calls[0][0]));
      expect(own).toMatch(/COALESCE\(department, ''\) = \$3/);
      expect(mockDb.qOne.mock.calls[0][1]).toContain('Ops');
    });

    /**
     * SCOPED BY TIME, NOT BY LINK — and this is the assertion that says so.
     *
     * Keying the month on `roster_month_id` made the whole check defeatable by
     * write ORDER: a shift created before the month row existed is unlinked
     * forever, nothing backfills it, and "shifts already exist, THEN the
     * manager opens the planner" is the normal sequence for every org already
     * running. The check would report a confident zero over a calendar full of
     * double-bookings — the same empty box the link was meant to fix.
     *
     * A calendar month is a time range, so the query asks the question in time.
     * EITHER side need only touch the month, which is also what catches the
     * overnight shift straddling the boundary.
     */
    it('scopes the month by TIME, so an unlinked shift cannot hide a clash', async () => {
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1');
      const sql = stripSqlComments(String(mockDb.q.mock.calls[0][0]));
      // Half-open range on BOTH sides, so a shift merely overlapping the month
      // counts and a link is never consulted.
      expect(sql).toMatch(/sa\.start_at < \(\$2::date \+ INTERVAL '1 month'\) AND sa\.end_at > \$2::date/);
      expect(sql).toMatch(/sb\.start_at < \(\$2::date \+ INTERVAL '1 month'\) AND sb\.end_at > \$2::date/);
      // The link must play NO part in deciding what the check covers.
      expect(sql).not.toMatch(/roster_month_id/);
      // …and the bound is the month's own date, read from the owned row.
      expect(mockDb.q.mock.calls[0][1]).toContain('2026-09-01');
    });

    /**
     * A month is branch-scoped, so its conflict list must be too. Without this
     * an 'Ops' manager reads the Logistics branch's names, shift ids and
     * windows through their own month — the tenancy hole the ownership
     * pre-read does not close, because it only guards WHICH month, not which
     * shifts the query then reaches.
     */
    it('scopes BOTH sides of the pair to the branch', async () => {
      mockDb.qOne.mockResolvedValueOnce({...OWNED, department: 'Ops'});
      await svc.findConflicts(ORG, 'rm-1', 'Ops');
      const sql = stripSqlComments(String(mockDb.q.mock.calls[0][0]));
      // COALESCE on BOTH sides of BOTH comparisons: a null department folds to
      // the bucket '' exactly as cpo_roster_months_unique and
      // resolveRosterMonthId fold it. Treating null as a WILDCARD here would
      // have made one column mean two different things in one feature, and
      // would have blocked the org-wide month's publish on conflicts inside
      // branch rosters its manager is not planning.
      expect(sql).toMatch(/COALESCE\(sa\.department, ''\) = COALESCE\(\$3::text, ''\)/);
      expect(sql).toMatch(/COALESCE\(sb\.department, ''\) = COALESCE\(\$3::text, ''\)/);
      expect(sql).not.toMatch(/\$3::text IS NULL/);
      expect(mockDb.q.mock.calls[0][1]).toContain('Ops');
    });

    it('is scoped to the calling org on BOTH sides of the self-join', async () => {
      // One side alone would let another org's shift create a phantom clash.
      mockDb.qOne.mockResolvedValueOnce(OWNED);
      await svc.findConflicts(ORG, 'rm-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/sa\.org_user_id = \$1/);
      expect(sql).toMatch(/sb\.org_user_id = \$1/);
    });

    it('publishes anyway when the manager FORCES it, and records that', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(DRAFT)
        .mockResolvedValueOnce(OWNED)
        .mockResolvedValueOnce({...DRAFT, status: 'published', published_at: 'now'});
      mockDb.q.mockResolvedValueOnce([{cpo_user_id: 'u1'}]);
      const res = await svc.publishMonth(ORG, MGR, '2026-09', {force: true});
      expect(res.ok).toBe(true);
      expect(mockAudit.log).toHaveBeenCalledWith(
        ORG, MGR, 'roster.published',
        expect.objectContaining({metadata: expect.objectContaining({forced: true, conflicts: 1})}));
    });
  });

  describe('A7.2 — published vs AMENDED are different facts', () => {
    it('first publish sets published, with the stamp', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(DRAFT)
        .mockResolvedValueOnce(OWNED)
        .mockResolvedValueOnce({...DRAFT, status: 'published'});
      const res = await svc.publishMonth(ORG, MGR, '2026-09');
      expect(res.ok).toBe(true);
      expect(mockDb.qOne.mock.calls[2][1]).toContain('published');
    });

    /**
     * A CPO who already read last week's plan needs to know it CHANGED. A
     * boolean cannot carry that, and collapsing the two is the "I republished
     * and nobody noticed" failure.
     */
    it('re-publishing an already-live month AMENDS it', async () => {
      const live = {...DRAFT, status: 'published' as const, published_at: 'first'};
      mockDb.qOne
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce(OWNED)
        .mockResolvedValueOnce({...live, status: 'amended', amended_at: 'now'});
      const res = await svc.publishMonth(ORG, MGR, '2026-09');
      expect(res.ok).toBe(true);
      expect(mockDb.qOne.mock.calls[2][1]).toContain('amended');
    });

    it('an amendment PRESERVES the original publish stamp', async () => {
      const live = {...DRAFT, status: 'amended' as const, published_at: 'first'};
      mockDb.qOne.mockResolvedValueOnce(live).mockResolvedValueOnce(OWNED).mockResolvedValueOnce(live);
      await svc.publishMonth(ORG, MGR, '2026-09');
      const sql = String(mockDb.qOne.mock.calls[2][0]);
      // COALESCE, not assignment: "first published on" must not become "last
      // amended on".
      expect(sql).toMatch(/published_at = COALESCE\(published_at, NOW\(\)\)/);
      expect(sql).toMatch(/published_by = COALESCE\(published_by, \$4\)/);
    });

    it('an ARCHIVED month cannot be published', async () => {
      mockDb.qOne.mockResolvedValueOnce({...DRAFT, status: 'archived'});
      await expect(svc.publishMonth(ORG, MGR, '2026-09')).rejects.toThrow(ConflictException);
    });

    it('the publish UPDATE is org-scoped', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(DRAFT)
        .mockResolvedValueOnce(OWNED)
        .mockResolvedValueOnce(DRAFT);
      await svc.publishMonth(ORG, MGR, '2026-09');
      expect(String(mockDb.qOne.mock.calls[2][0])).toMatch(/WHERE id = \$1 AND org_user_id = \$2/);
    });
  });

  describe('A7.4 — a correction NEVER overwrites the original', () => {
    /**
     * THE REAL COLUMNS. The first version of this fixture used
     * `started_at` / `ended_at`, which do not exist on `cpo_shift_sessions` —
     * and because the service used the same invented names, every test passed
     * while every real correction threw Postgres 42703. The fixture had become
     * the schema definition. There is now a shape gate below that cross-checks
     * the SQL against the service's own `ShiftSession` interface.
     */
    const SESSION = {
      id: 's-1', cpo_user_id: 'u1', attendance_status: 'absent',
      // 'closed' explicitly: the pre-read now returns s.status and the guard
      // refuses 'open'. Omitting it made every test pass on undefined !== 'open'
      // — the fixture-becomes-the-schema trap this file documents.
      status: 'closed',
      clock_in_at: '2026-08-04T09:00:00.000Z',
      clock_out_at: '2026-08-04T17:00:00.000Z',
    };

    /**
     * The trail must stay ATTRIBUTABLE after its subject is gone — that is the
     * entire justification for dropping the foreign key on `session_id`.
     * `cpo_user_id` was added to the table for it and then never written, so
     * the column sat NULL forever and the justification was false. The value is
     * already in scope on the session row the service just read.
     */
    it('records WHOSE attendance was corrected, not only which session', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      });
      const [sql, params] = mockDb.qOne.mock.calls[1];
      expect(String(sql)).toMatch(/cpo_user_id/);
      expect(params).toContain('u1');
    });

    /**
     * `after` is a bare @IsObject() on the DTO, so without an explicit check any
     * string lands in `after_value` JSONB, becomes the effective status on every
     * later fold, and is a value the real column's CHECK would have rejected.
     * The table is APPEND-ONLY — a bad row can never be updated or deleted, so
     * this is the last place it can be stopped.
     */
    it('REFUSES an attendance_status the real column would reject', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'banana'},
      })).rejects.toThrow(BadRequestException);
      // …and nothing was written to the append-only table.
      const wrote = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/INSERT INTO public\.attendance_corrections/);
    });

    /**
     * C2 adversarial review (2026-08-07) — a JSON null slipped past BOTH
     * gates: it returned from normaliseCorrectableValue before the enum
     * check, and the readers' COALESCE fold cannot represent "corrected to
     * null" — it silently fell back to the RAW value while `?|` still bricked
     * every writer on the field. Unfixable, in an append-only table.
     */
    it('REFUSES a JSON-null correction value (clearing a field is not supported)', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'clear it',
        after: {clock_out_at: null} as unknown as Record<string, unknown>,
      })).rejects.toThrow('correction_value_required');
      const wrote = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/INSERT INTO public\.attendance_corrections/);
    });

    it('a null attendance_status must not bypass the enum gate either', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'x',
        after: {attendance_status: null} as unknown as Record<string, unknown>,
      })).rejects.toThrow('correction_value_required');
    });

    /**
     * Corrections target FINISHED records. An open session's checkout has not
     * happened: "correcting" it pre-writes a value the CPO's real clockOut
     * (unguarded — it is the member's own live action) then fights with, and
     * the client shows ON SHIFT next to a folded "→ 17:00" on the same row.
     */
    it('REFUSES to correct an OPEN session', async () => {
      mockDb.qOne.mockResolvedValueOnce({...SESSION, status: 'open', clock_out_at: null});
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'left early', after: {clock_out_at: '2026-08-04T15:00:00.000Z'},
      })).rejects.toThrow('cannot_correct_open_session');
      const wrote = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/INSERT INTO public\.attendance_corrections/);
    });

    /**
     * The PAIR is validated, not each field alone — one call can set both
     * times, and an HH:MM typo (or a day-anchor slip on an overnight session)
     * would otherwise fold a NEGATIVE-duration shift into every reader and the
     * compliance CSV, permanently: the chain is append-only and nothing
     * prompts a revert (edge-case review, 2026-08-08).
     */
    it('REFUSES a correction whose effective clock-out is at or before clock-in', async () => {
      // clock_out set to before the UNCORRECTED clock-in (09:00).
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'typo', after: {clock_out_at: '2026-08-04T01:30:00.000Z'},
      })).rejects.toThrow('correction_out_before_in');
      // …and the pair rule sees BOTH sides of one call: moving clock-in past
      // the (kept) clock-out fails the same way.
      mockDb.qOne.mockReset().mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'typo', after: {clock_in_at: '2026-08-04T18:00:00.000Z'},
      })).rejects.toThrow('correction_out_before_in');
      const wrote = mockDb.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/INSERT INTO public\.attendance_corrections/);
    });

    /**
     * THREE COPIES OF ONE LIST — the repo's most common bug shape.
     *
     * `CORRECTABLE_STATUSES` (dto), `AttendanceStatus` (service type) and the
     * column's own CHECK (migration) must name the same set. Nothing pinned
     * them, and the drift is not cosmetic: the validation now rejects anything
     * outside the dto list, so the day a 9th status is added to the type and
     * the CHECK but not here, every correction to a session holding it is
     * refused — and `attendance_corrections` is APPEND-ONLY, so a value that
     * did slip through could never be removed.
     *
     * Read from the OTHER TWO SOURCES rather than restating the list, or this
     * test becomes a fourth copy.
     */
    it('CORRECTABLE_STATUSES matches the type AND the column CHECK', () => {
      const svcSrc = source('attendance.service.ts');
      const union = svcSrc.slice(svcSrc.indexOf('export type AttendanceStatus'));
      const fromType = new Set(
        (union.slice(0, union.indexOf(';')).match(/'([a-z_]+)'/g) ?? [])
          .map(q => q.replace(/'/g, '')));

      // 20260807100000 is where the AUTHORITATIVE CHECK lives since the
      // day-status-v2 widening — pointing at the 2026-06 original would make
      // this gate validate a superseded constraint (or pass vacuously).
      const mig = readFileSync(
        join(process.cwd(), '..', '..', 'supabase', 'migrations',
             '20260807100000_day_status_v2.sql'), 'utf8').replace(/\r\n/g, '\n');
      const check = mig.slice(mig.indexOf('ADD CONSTRAINT cpo_shift_sessions_attendance_status_check'));
      const fromCheck = new Set(
        (check.slice(0, check.indexOf('))')).match(/'([a-z_]+)'/g) ?? [])
          .map(q => q.replace(/'/g, '')));

      // The scans themselves must work — an empty set would make this vacuous.
      //
      // THIS EXACT 10 IS INTENTIONAL BRITTLENESS, NOT AN OVERSIGHT. Adding a
      // legitimate 11th status is SUPPOSED to fail here, because that is the
      // moment the three copies can drift. Loosening it to `>= 10` to make a
      // run green kills the gate — update the number together with all three
      // lists, or the drift this exists to catch passes silently.
      // (8 → 10 on 2026-08-07: emergency_leave + mission, scope-v2 A7.3.)
      expect(fromType.size).toBe(10);
      expect(fromCheck.size).toBe(10);
      expect([...CORRECTABLE_STATUSES].sort()).toEqual([...fromType].sort());
      expect([...CORRECTABLE_STATUSES].sort()).toEqual([...fromCheck].sort());
    });

    it('still ACCEPTS every status the column allows', async () => {
      // ALL of them, from the shared list — the earlier version hard-coded five
      // of eight and called itself "every status the column allows".
      for (const status of CORRECTABLE_STATUSES.filter(s => s !== SESSION.attendance_status)) {
        mockDb.qOne.mockReset();
        mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
        await expect(svc.recordCorrection(ORG, MGR, {
          session_id: 's-1', reason: 'fix', after: {attendance_status: status},
        })).resolves.toBeTruthy();
      }
    });

    /**
     * setDayStatus DELETEs the day's session to upsert it. An INNER JOIN in the
     * history read therefore threw the trail away exactly when it mattered: the
     * row survived in an append-only table that no read path could reach —
     * reintroducing, one join further out, the failure the missing foreign key
     * was justified by.
     */
    it('still returns the history after the session it annotates is gone', async () => {
      await svc.listCorrections(ORG, 's-1');
      const sql = stripSqlComments(String(mockDb.q.mock.calls[0][0]));
      // The LEFT JOIN is the whole mechanism. An earlier version of this test
      // also asserted `s.id IS NULL` in the predicate — a clause that provably
      // could not change behaviour (an unmatched session leaves sh unmatched
      // too), so it went red for a reason corresponding to nothing.
      expect(sql).toMatch(/LEFT JOIN public\.cpo_shift_sessions s ON s\.id = c\.session_id/);
      expect(sql).not.toMatch(/\n\s*JOIN public\.cpo_shift_sessions/);
    });

    /**
     * The guard in attendance.service (`assertNotUnderCorrection`) is only
     * mutually exclusive if BOTH sides lock the session row. editShift and
     * reviewSession take `FOR UPDATE`; this pre-read did not, so the two paths
     * did not serialise: A checks (clean) -> B inserts a correction -> A's
     * UPDATE lands, producing exactly the lie the guard exists to prevent, in
     * an APPEND-ONLY table.
     *
     * And a lock outside a transaction is released at statement end, so the
     * transaction is part of the invariant, not an implementation detail.
     */
    it('LOCKS the session, inside a transaction, so the guard is not advisory', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      });
      expect(mockDb.withTransaction).toHaveBeenCalled();
      const preRead = stripSqlComments(String(mockDb.qOne.mock.calls[0][0]));
      // OF s — locking the LEFT JOINed shift/member rows too would serialise
      // unrelated writes across the whole branch.
      expect(preRead).toMatch(/FOR UPDATE OF s/);
    });

    /**
     * The audit write must share the transaction AND must not be swallowed.
     *
     * Outside it, a failed commit leaves an audit row asserting a correction
     * that does not exist. Inside it but caught, it is worse: Postgres aborts
     * the whole transaction on any statement error (25P02), so continuing makes
     * withTransaction COMMIT an already-aborted transaction.
     */
    it('writes its audit row IN the transaction, and lets a failure through', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        ORG, MGR, 'attendance.corrected',
        expect.objectContaining({tx: expect.anything()}),
      );
    });

    it('does NOT swallow an audit failure', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      mockAudit.log.mockRejectedValueOnce(new Error('audit down'));
      // For an append-only compliance trail, "the correction failed" beats
      // "it landed but we cannot say who made it".
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      })).rejects.toThrow('audit down');
    });

    it('folds the prior chain INSIDE the transaction, not on another connection', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      });
      // The fold decides `before_value`; reading it outside the lock would fold
      // a chain a concurrent writer could still be extending.
      const foldRead = mockDb.q.mock.calls
        .map(c => String(c[0]))
        .find(s => /FROM public\.attendance_corrections/.test(s));
      expect(foldRead).toBeDefined();
      expect(foldRead).toMatch(/ORDER BY corrected_at ASC/);
    });

    it('writes a NEW ROW and leaves the session untouched', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(SESSION)
        .mockResolvedValueOnce({id: 'c-1', session_id: 's-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'Clocked in at the wrong site',
        after: {attendance_status: 'present'},
      });
      const all = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(all).toMatch(/INSERT INTO public\.attendance_corrections/);
      // THE load-bearing assertion of A7.4.
      expect(all).not.toMatch(/UPDATE (public\.)?cpo_shift_sessions/);
    });

    it('captures BEFORE from the server, not from the client', async () => {
      // A client-supplied before-image would let the audit trail be written to
      // say whatever the caller wanted it to say.
      mockDb.qOne
        .mockResolvedValueOnce(SESSION)
        .mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix',
        after: {attendance_status: 'present'},
      });
      const params = mockDb.qOne.mock.calls[1][1] as unknown[];
      expect(JSON.parse(String(params[params.length - 2]))).toEqual({attendance_status: 'absent'});
      expect(JSON.parse(String(params[params.length - 1]))).toEqual({attendance_status: 'present'});
    });

    it('takes the time from the DATABASE, never a parameter', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      });
      const sql = String(mockDb.qOne.mock.calls[1][0]);
      // A7.4 says "when (server time)". The column's DEFAULT NOW() supplies it,
      // and the INSERT must not name the column at all.
      expect(sql).not.toMatch(/corrected_at\s*[,)]/);
    });

    it('REQUIRES a reason, and rejects whitespace', async () => {
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: '   ', after: {attendance_status: 'present'},
      })).rejects.toThrow(BadRequestException);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('refuses a correction that changes NOTHING', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'absent'},
      })).rejects.toThrow(BadRequestException);
    });

    it('ignores fields a correction may not touch', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION).mockResolvedValueOnce({id: 'c-1'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix',
        after: {attendance_status: 'present', cpo_user_id: 'someone-else', org_user_id: 'other-org'},
      });
      // Last param, not a fixed index: the INSERT gained cpo_user_id, and a
      // hard-coded position silently started reading the BEFORE image instead.
      const params = mockDb.qOne.mock.calls[1][1] as unknown[];
      const after = JSON.parse(String(params[params.length - 1]));
      expect(after).toEqual({attendance_status: 'present'});
      expect(after.cpo_user_id).toBeUndefined();
    });

    it('is TENANCY-scoped — another org\'s session is not correctable', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-other', reason: 'fix', after: {attendance_status: 'present'},
      })).rejects.toThrow(NotFoundException);
      expect(String(mockDb.qOne.mock.calls[0][0])).toMatch(/WHERE s\.id = \$1 AND s\.org_user_id = \$2/);
    });

    /**
     * BRANCH scope, not just org. `recordCorrection` and `listCorrections` had
     * no department parameter at all while the three roster routes did — so a
     * branch-scoped manager could read and correct ANY session in the org. The
     * "every handler is scoped" claim was true for 3 of 5.
     */
    it('is BRANCH-scoped too — a manager cannot correct another branch', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {attendance_status: 'present'},
      }, 'Ops')).rejects.toThrow(NotFoundException);
      const call = mockDb.qOne.mock.calls[0];
      expectBranchScoped(String(call[0]));
      expect(call[1]).toEqual(['s-1', ORG, 'Ops']);
    });

    it('the history read is branch-scoped as well', async () => {
      await svc.listCorrections(ORG, 's-1', 'Ops');
      expectBranchScoped(String(mockDb.q.mock.calls[0][0]));
      expect(mockDb.q.mock.calls[0][1]).toEqual(['s-1', ORG, 'Ops']);
    });

    /**
     * B4 — `before` must answer "what did it say before THIS correction".
     *
     * After the first correction that is no longer what the session row says,
     * because the session is never updated. Reading the row gave a chain that
     * lied: c1 absent→present, then c2 recorded absent→late. Folding the
     * existing corrections gives the true current value.
     */
    it('takes BEFORE from the effective value, not the untouched original', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);           // original: absent
      mockDb.q.mockResolvedValueOnce([                       // one prior correction
        {id: 'c-1', after_value: {attendance_status: 'present'}, before_value: {}},
      ]);
      mockDb.qOne.mockResolvedValueOnce({id: 'c-2'});
      await svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'second look', after: {attendance_status: 'late'},
      });
      const params = mockDb.qOne.mock.calls[1][1] as unknown[];
      // 'present' — what it actually said — NOT 'absent', the original.
      expect(JSON.parse(String(params[params.length - 2]))).toEqual({attendance_status: 'present'});
      expect(JSON.parse(String(params[params.length - 1]))).toEqual({attendance_status: 'late'});
    });

    it('a mistaken correction can be REVERTED', async () => {
      // Comparing against the immutable original rejected the revert as
      // "changes nothing", which made a wrong correction permanent.
      mockDb.qOne.mockResolvedValueOnce(SESSION);           // original: absent
      mockDb.q.mockResolvedValueOnce([
        {id: 'c-1', after_value: {attendance_status: 'present'}, before_value: {}},
      ]);
      mockDb.qOne.mockResolvedValueOnce({id: 'c-2'});
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'reverting my error', after: {attendance_status: 'absent'},
      })).resolves.toBeTruthy();
    });

    it('compares timestamps as INSTANTS, not strings', async () => {
      // Postgres renders `2026-08-04 09:00:00+00`; a client sends
      // `...T09:00:00.000Z`. Same moment, different strings — a raw === guard
      // never fires for a time field.
      mockDb.qOne.mockResolvedValueOnce({...SESSION, clock_in_at: '2026-08-04 09:00:00+00'});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'no-op', after: {clock_in_at: '2026-08-04T09:00:00.000Z'},
      })).rejects.toThrow(BadRequestException);
    });

    it('rejects an unparseable timestamp rather than storing it', async () => {
      mockDb.qOne.mockResolvedValueOnce(SESSION);
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.recordCorrection(ORG, MGR, {
        session_id: 's-1', reason: 'fix', after: {clock_in_at: 'banana'},
      })).rejects.toThrow(BadRequestException);
    });

    it('lists history oldest-first, org-scoped', async () => {
      await svc.listCorrections(ORG, 's-1');
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(/WHERE c\.session_id = \$1 AND c\.org_user_id = \$2/);
      // Oldest first is load-bearing: recordCorrection folds this chain in
      // order to compute the effective value.
      expect(sql).toMatch(/ORDER BY c\.corrected_at ASC/);
    });
  });

  describe('structural invariants', () => {
    const svcSrc = source('roster.service.ts');
    const ctlSrc = source('roster.controller.ts');
    const dtoSrc = source('dto/roster.dto.ts');

    it('the service NEVER updates a session row', () => {
      // The whole of A7.4 in one absence.
      expect(svcSrc).not.toMatch(/UPDATE\s+(public\.)?cpo_shift_sessions/);
    });

    it('the correction DTO accepts no time, org or branch', () => {
      // A field the API does not accept cannot be spoofed, and cannot be
      // accidentally honoured by a later edit.
      expect(dtoSrc).not.toMatch(/corrected_at/);
      expect(dtoSrc).not.toMatch(/org_user_id/);
      expect(dtoSrc).not.toMatch(/department/);
    });

    it('EVERY roster route passes the manager branch, never null', () => {
      /**
       * Phase 3 shipped exactly this bug: correct SQL, and the controller
       * handing it `null`.
       *
       * The first version of this pin asserted `not.toMatch(/,\s*null\)/)` —
       * which the realistic mutation (`department: null,` as an object field)
       * walks straight past, because it ends in a comma, not a paren. Anchoring
       * on the punctuation instead of the DECISION is the same mistake this
       * test exists to catch. So: count the real forwards, and ban the field
       * being nulled in any form.
       */
      const forwards = ctlSrc.match(/mgr\.department/g) ?? [];
      // readMonth, ensureMonth, publish, archive, conflicts, corrections —
      // every route that reaches a scoped query.
      expect(forwards.length).toBeGreaterThanOrEqual(3);
      expect(ctlSrc).not.toMatch(/department:\s*(null|undefined)/);
      expect(ctlSrc).not.toMatch(/,\s*(null|undefined)\s*\)/);
      // …and every handler is org-scoped from the guard, never from the body.
      expect(ctlSrc).not.toMatch(/dto\.org_user_id/);
      expect(ctlSrc).not.toMatch(/dto\.department/);
    });

    it('the whole controller is manager-only', () => {
      // Order-and-membership, not a literal argument list. The first version
      // of this assertion required a closing paren straight after
      // OrgManagerGuard, which made it IMPOSSIBLE to add DeptChatV2Guard
      // without the suite going red — a test that pins a bug in place.
      const guards = ctlSrc.match(/@UseGuards\(([^)]*)\)/)?.[1] ?? '';
      expect(guards).toMatch(/\bJwtAuthGuard\b/);
      expect(guards).toMatch(/\bOrgManagerGuard\b/);
      // Auth before tenancy: OrgManagerGuard reads the claims JwtAuthGuard sets.
      expect(guards.indexOf('JwtAuthGuard')).toBeLessThan(guards.indexOf('OrgManagerGuard'));
    });

    /**
     * Every v2 route on AttendanceController carries DeptChatV2Guard, which
     * 404s while the rollout flag is off. Phase 5's routes shipped without it,
     * so they were live ahead of any UI. (Historically the GET also WROTE —
     * create-on-read minted draft months; the verb split fixed that on
     * 2026-08-07, and the VERB SPLIT describe above pins it — but the flag
     * guard remains the outer wall for the whole surface.)
     */
    it('is behind the rollout flag, like every other v2 route', () => {
      const guards = ctlSrc.match(/@UseGuards\(([^)]*)\)/)?.[1] ?? '';
      expect(guards).toMatch(/\bDeptChatV2Guard\b/);
      // No member-facing route may appear here: a draft is invisible to the
      // team because there is no route that could show it, not because a
      // filter remembered to.
      expect(ctlSrc).not.toMatch(/@CurrentUser\(\)/);
    });

    /**
     * THE GATE THAT WOULD HAVE CAUGHT B1 BEFORE THE CODE EXISTED.
     *
     * `roster.service.ts` selected `started_at` / `ended_at` from
     * `cpo_shift_sessions`. Those columns do not exist — the real ones are
     * `clock_in_at` / `clock_out_at` — so every correction threw Postgres
     * 42703, and the invented names survived review because the test fixture
     * used them too.
     *
     * A unit test with a mocked db can never see a wrong column name. This
     * cross-checks the SQL against the service's own `ShiftSession` interface,
     * which is the closest thing to the schema that lives in this repo.
     */
    it('every session column the roster reads EXISTS on the session type', () => {
      const iface = source('attendance.service.ts');
      const block = iface.slice(iface.indexOf('interface ShiftSession'),
                                iface.indexOf('}', iface.indexOf('interface ShiftSession')));
      const declared = new Set(
        (block.match(/^\s{2}(\w+)\??:/gm) ?? []).map(m => m.trim().replace(/\??:$/, '')));
      // The scan must actually find the interface, or every assertion below is
      // vacuous — the failure mode a source gate dies of most often.
      expect(declared.size).toBeGreaterThan(5);
      expect(declared.has('clock_in_at')).toBe(true);

      // THE CLAIM: every field a correction may touch is a real column.
      for (const f of ['attendance_status', 'clock_in_at', 'clock_out_at']) {
        expect(declared.has(f)).toBe(true);
      }
      expect(svcSrc).toMatch(
        /CORRECTABLE_FIELDS = \['attendance_status', 'clock_in_at', 'clock_out_at'\]/);
      // …and the invented ones never come back.
      expect(declared.has('started_at')).toBe(false);
      expect(svcSrc).not.toMatch(/started_at|ended_at/);
    });

    it('the migration makes corrections append-only in the DATABASE', () => {
      const mig = readFileSync(
        join(process.cwd(), '..', '..', 'supabase', 'migrations',
             '20260804000000_roster_months_and_corrections.sql'),
        'utf8').replace(/\r\n/g, '\n');
      // Application code can be bypassed by a second writer; this rule is the
      // one where that is not good enough, because an UPDATE destroys the
      // evidence the table exists to hold.
      expect(mig).toMatch(/BEFORE UPDATE OR DELETE ON public\.attendance_corrections/);
      expect(mig).toMatch(/RAISE EXCEPTION/);
      // A published month must always carry its stamp, or the CPO-facing
      // "published on" line renders blank.
      expect(mig).toMatch(/cpo_roster_months_publish_stamp/);
      // One roster per org × department × month, with NULL folded — a plain
      // unique index would let the org-wide roster be created twice.
      expect(mig).toMatch(/COALESCE\(department, ''\), month\)/);
    });

    /**
     * B3 — the cascade that would have broken a live write path FOREVER.
     *
     * ON DELETE CASCADE on `session_id` plus the append-only trigger above is a
     * contradiction: a Postgres RI cascade issues a real child DELETE, the row
     * trigger RAISEs, and the PARENT transaction aborts. `setDayStatus` upserts
     * by deleting the day's session — so once a day-status session had been
     * corrected, setting that CPO's day status would fail every time, with a
     * message about a table the caller never touched.
     *
     * RESTRICT fails the same way from the other direction, and both are also
     * wrong for A7.4: a trail kept "forever" must outlive its subject.
     */
    it('the corrections trail has NO foreign key that would fight the trigger', () => {
      const mig = readFileSync(
        join(process.cwd(), '..', '..', 'supabase', 'migrations',
             '20260804000000_roster_months_and_corrections.sql'),
        'utf8').replace(/\r\n/g, '\n');
      const start = mig.indexOf('CREATE TABLE IF NOT EXISTS public.attendance_corrections');
      expect(start).toBeGreaterThan(-1);
      const block = mig.slice(start, mig.indexOf(');', start));
      // Comments carry the words "CASCADE" and "REFERENCES" while explaining
      // why they are absent — stripping them first is the difference between a
      // real gate and one that fails on its own prose.
      const code = stripSqlComments(block);
      expect(code).toMatch(/session_id\s+UUID NOT NULL,/);
      expect(code).not.toMatch(/REFERENCES/);
      expect(code).not.toMatch(/CASCADE|RESTRICT/);
    });
  });
});
