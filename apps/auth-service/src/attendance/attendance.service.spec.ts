import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  AttendanceService, deriveCheckIn, deriveCheckOut, sanitizeFaceMeta, type Shift,
} from './attendance.service';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {NotificationsService} from '../notifications/notifications.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
const mockAudit = {log: jest.fn()};
const mockNotifications = {record: jest.fn()};
// Toggled per-test; default OFF so the legacy /attendance/* path is exercised
// exactly as before (Step 1/5 regression guarantee).
let flagOn = false;
const mockConfig = {
  get: jest.fn((key: string) => (key === 'featureFlags.deptChatV2' ? flagOn : undefined)),
};

const shiftFixture = (over: Partial<Shift> = {}): Shift => ({
  id: 'sh1', org_user_id: 'org-9', department: null, site_label: null,
  site_lat: 25.2, site_lng: 55.3, approved_radius_m: 150,
  start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
  created_by: 'mgr-1', archived_at: null, created_at: '2026-06-22T08:00:00Z',
  ...over,
});

describe('AttendanceService', () => {
  let svc: AttendanceService;

  beforeEach(async () => {
    jest.resetAllMocks();
    flagOn = false;
    mockDb.q.mockResolvedValue([]);
    tx.q.mockResolvedValue([]);
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    mockConfig.get.mockImplementation((key: string) =>
      key === 'featureFlags.deptChatV2' ? flagOn : undefined,
    );
    mockNotifications.record.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: ConfigService, useValue: mockConfig},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: NotificationsService, useValue: mockNotifications},
      ],
    }).compile();
    svc = module.get(AttendanceService);
  });

  // ─── Legacy path (flag OFF) — must remain byte-for-byte unchanged ──────
  describe('clockIn (legacy, flag off)', () => {
    it('rejects a second clock-in while a shift is already open', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'open-1'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      await expect(svc.clockIn('cpo-1', {lat: 25, lng: 55})).rejects.toThrow('shift_already_open');
    });

    it('resolves the owning org for a managed CPO and opens a geotagged shift', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)                   // no open shift
        .mockResolvedValueOnce({id: 's1', org_user_id: 'org-9', cpo_user_id: 'cpo-1', status: 'open'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]); // resolveOrg (q: ALL memberships)
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      const out = await svc.clockIn('cpo-1', {lat: 25.2, lng: 55.3, accuracy_m: 8});
      expect(out.org_user_id).toBe('org-9');
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO cpo_shift_sessions/i.test(String(c[0])));
      expect(insert?.[1]).toEqual(['org-9', 'cpo-1', 25.2, 55.3, 8]);
    });

    it('resolves the owning org by PREFERRING a cpo membership, never requiring one', async () => {
      /**
       * vs2 item 4 CRITICAL, the twin of the incident.service assertion.
       *
       * Narrowed to `AND member_role = 'cpo'`, this matched nothing for a
       * workspace EMPLOYEE — who has no cpo row — so the shift was opened with
       * org_user_id = their own user id. Every manager read (org/sessions,
       * org/pending, org/summary, and the roster-correction verbs) is scoped
       * `WHERE ses.org_user_id = <the org>`, so their clock-in never appeared
       * anywhere and could not be approved.
       *
       * Asserted on the SQL: this db mock answers regardless of the query, so
       * nothing behavioural in this file can see a WHERE clause.
       */
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 's1', org_user_id: 'org-9', cpo_user_id: 'cpo-1', status: 'open'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      await svc.clockIn('cpo-1', {lat: 1, lng: 2});

      // Content-addressed: resolveOrg moved from qOne to q when it learned to
      // read the org context, and a positional lookup would silently start
      // asserting against a different query.
      const call = mockDb.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect(call).toBeDefined();
      // Line-wise comment strip — the prose above this query names the clause
      // the assertions forbid, and a greedy stripper has eaten code here before.
      const sql = String(call![0]).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(sql).not.toMatch(/AND\s+member_role\s*=\s*'cpo'/);
      expect(sql).toMatch(/ORDER BY\s*\(member_role = 'cpo'\)\s*DESC/);
    });

    it('falls back to self-as-org for a CPO with no org membership', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 's1', org_user_id: 'cpo-solo', cpo_user_id: 'cpo-solo', status: 'open'});
      mockDb.q.mockResolvedValueOnce([]); // resolveOrg → no memberships
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      const out = await svc.clockIn('cpo-solo', {});
      expect(out.org_user_id).toBe('cpo-solo');
    });
  });

  describe('clockOut', () => {
    it('closes the open shift; throws when there is none', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.clockOut('cpo-1', {})).rejects.toThrow('no_open_shift');
    });
  });

  describe('editShift', () => {
    it('is scoped to the org and audits the edit', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'closed', clock_in_at: 'a', clock_out_at: null}) // before
        .mockResolvedValueOnce(null)  // A7.4 guard: no corrections on this session
        .mockResolvedValueOnce({id: 's1', status: 'edited', edit_reason: 'forgot clock-out'});     // update
      const out = await svc.editShift('org-9', 'mgr-1', 's1', {
        clock_out_at: '2026-06-11T10:00:00Z', edit_reason: 'forgot clock-out',
      });
      expect(out.status).toBe('edited');
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      const [sql, params] = updateCall!;
      expect(String(sql)).toMatch(/WHERE id = \$1 AND org_user_id = \$2/);
      expect(params[0]).toBe('s1');
      expect(params[1]).toBe('org-9');
      expect(params[2]).toBe('mgr-1');
    });

    it('D6-a: only a clock_out_at edit closes the shift (status preserved otherwise)', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'open', clock_in_at: 'a', clock_out_at: null})
        .mockResolvedValueOnce(null)  // A7.4 guard: no corrections on this session
        .mockResolvedValueOnce({id: 's1', status: 'open'});
      await svc.editShift('org-9', 'mgr-1', 's1', {clock_in_at: '2026-06-11T08:00:00Z', edit_reason: 'fix start'});
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      // The status only flips to 'edited' when a clock_out_at ($5) is supplied; else it keeps
      // the existing status (so an open shift stays clock-out-able and the open-guard holds).
      expect(String(updateCall![0])).toMatch(/status\s*=\s*CASE WHEN \$5::timestamptz IS NOT NULL THEN 'edited' ELSE status END/);
    });

    it('throws when the shift is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(
        svc.editShift('org-9', 'mgr-1', 'not-mine', {edit_reason: 'x'}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * Scope v2 A7.4 — THE PHASE 6 ENTRY BLOCKER.
     *
     * Corrections and direct edits are two mechanisms owning the same fields.
     * `recordCorrection` folds the correction chain OVER the session row to
     * decide what the record said before, and the chain wins — so a direct
     * write in between makes the next correction's `before_value` name a value
     * the record never held:
     *
     *   c1: absent -> present   (chain says 'present')
     *   editShift: -> 'late'    (row says 'late'; nothing records it)
     *   c2: before = 'present'  <- a lie, and UNREPAIRABLE: append-only.
     *
     * So the write is refused, not reconciled. The manager is sent to the
     * correction API, which records who and why.
     */
    it('REFUSES to overwrite a session that is under correction', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'closed', clock_in_at: 'a', clock_out_at: null})
        .mockResolvedValueOnce({id: 'corr-1'});   // a correction exists
      await expect(
        svc.editShift('org-9', 'mgr-1', 's1', {clock_in_at: 'x', edit_reason: 'y'}),
      ).rejects.toThrow('session_under_correction');
      // …and it never reached the UPDATE.
      expect(tx.qOne.mock.calls.some(c => /UPDATE cpo_shift_sessions/i.test(String(c[0]))))
        .toBe(false);
    });

    it('the guard is scoped to the org and to the session it is guarding', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'closed'})
        .mockResolvedValueOnce({id: 'corr-1'});
      await expect(
        svc.editShift('org-9', 'mgr-1', 's1', {edit_reason: 'y'}),
      ).rejects.toThrow('session_under_correction');
      const [sql, params] = tx.qOne.mock.calls[1];
      expect(String(sql)).toMatch(/FROM public\.attendance_corrections/);
      // Three halves now: another org's correction must not block this org's
      // edit, another session's must not block this one's, and a correction
      // that owns a DIFFERENT FIELD must not block it either.
      expect(String(sql)).toMatch(/org_user_id = \$1/);
      expect(String(sql)).toMatch(/session_id = ANY\(\$2::uuid\[\]\)/);
      expect(String(sql)).toMatch(/after_value \?\| \$3::text\[\]/);
      expect(params).toEqual(['org-9', ['s1'], ['clock_in_at', 'clock_out_at']]);
    });

    /**
     * THE GUARD WAS FIELD-BLIND, and wrong in BOTH directions.
     *
     * It asked "does ANY correction exist for this session?", so a correction
     * that only re-graded `attendance_status` refused a manager fixing a
     * forgotten clock-out — a field that correction never touched. The mirror
     * defect withheld the derived status in reviewSession because someone had
     * fixed a clock time.
     *
     * `after_value` already stores exactly the fields each correction owns, so
     * the question is asked in the query rather than by the caller.
     */
    it('asks only about the fields the CALLER is about to write', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'closed'})
        .mockResolvedValueOnce(null)                     // no clock-field correction
        .mockResolvedValueOnce({id: 's1', status: 'edited'});
      await svc.editShift('org-9', 'mgr-1', 's1', {edit_reason: 'y'});
      // editShift names the clock fields, never attendance_status.
      expect(tx.qOne.mock.calls[1][1][2]).toEqual(['clock_in_at', 'clock_out_at']);
      expect(tx.qOne.mock.calls[1][1][2]).not.toContain('attendance_status');
    });

    it('setDayStatus names EVERY correctable field, because it deletes the row', async () => {
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1'}]); // membership rows
      tx.q
        .mockResolvedValueOnce([{id: 'marker1', cpo_user_id: 'cpo-1', day: '2026-06-22'}]) // prior
        .mockResolvedValueOnce([])                      // DELETE
        .mockResolvedValueOnce([{id: 'marker2', attendance_status: 'leave'}]); // INSERT … SELECT
      tx.qOne.mockResolvedValueOnce(null);              // no correction on any field
      await svc.setDayStatus('org-9', 'mgr-1', {
        cpoUserId: 'cpo-1', status: 'leave', date: '2026-06-22',
      });
      const fields = tx.qOne.mock.calls[0][1][2] as string[];
      expect(fields.sort()).toEqual(['attendance_status', 'clock_in_at', 'clock_out_at']);
    });
  });

  describe('orgShifts', () => {
    it('filters by a single CPO when requested', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 's1'}]);
      await svc.orgShifts('org-9', {cpoUserId: 'cpo-1'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_user_id = \$2/);
      expect(params.slice(0, 2)).toEqual(['org-9', 'cpo-1']);
    });

    /**
     * This list is the Corrections screen's session picker, so what it OFFERS
     * must equal what listCorrections/recordCorrection ACCEPT — the SAME
     * COALESCE(shift-branch, member-branch) rule those verbs apply. Unscoped,
     * a branch manager saw every sibling branch's sessions (times, statuses,
     * dispute notes) and then 404'd their correction (edge review, 2026-08-08).
     */
    it('is branch-forced with the corrections COALESCE rule, BOTH query shapes', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.orgShifts('org-9', undefined, 'Ops');
      const [sqlAll, paramsAll] = mockDb.q.mock.calls[0];
      expect(String(sqlAll)).toMatch(/\(\$2::text IS NULL OR COALESCE\(sh\.department, om\.department\) = \$2\)/);
      expect(paramsAll[1]).toBe('Ops');
      mockDb.q.mockResolvedValueOnce([]);
      await svc.orgShifts('org-9', {cpoUserId: 'cpo-1'}, 'Ops');
      const [sqlOne, paramsOne] = mockDb.q.mock.calls[1];
      expect(String(sqlOne)).toMatch(/\(\$3::text IS NULL OR COALESCE\(sh\.department, om\.department\) = \$3\)/);
      expect(paramsOne[2]).toBe('Ops');
    });

    it('the controller threads manager.department into it (never a bare call)', () => {
      const src = readFileSync(join(process.cwd(), 'src', 'attendance', 'attendance.controller.ts'), 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
      expect(src).toMatch(/orgShifts\(manager\.org_user_id, \{cpoUserId\}, manager\.department\)/);
    });
  });

  // ─── Dept Chat v2 · verified check-in derivation (Step 5, pure) ────────
  describe('deriveCheckIn', () => {
    const NEAR = {lat: 25.2001, lng: 55.3001}; // ~15 m from the site centre
    const onTime = new Date('2026-06-22T09:05:00Z'); // within the 10-min grace
    const late = new Date('2026-06-22T09:20:00Z');    // past the grace

    it('in-radius + on-time + face_ok → present', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true}, onTime);
      expect(v.attendance_status).toBe('present');
      expect(v.review_status).toBe('none');
      expect(v.within_radius).toBe(true);
    });

    it('in-radius + face_ok but past grace → late (not pending)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true}, late);
      expect(v.attendance_status).toBe('late');
      expect(v.review_status).toBe('none');
    });

    it('denied/absent location → pending_review + permission_denied (NOT absent)', () => {
      const v = deriveCheckIn(shiftFixture(), {face_ok: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('permission_denied');
    });

    it('out-of-radius → pending_review + out_of_radius', () => {
      const v = deriveCheckIn(shiftFixture(), {lat: 25.5, lng: 55.6, face_ok: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('out_of_radius');
      expect(v.within_radius).toBe(false);
    });

    it('face check failed → pending_review + face_mismatch', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: false}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('face_mismatch');
    });

    it('D6-e: camera unavailable → pending_review + camera_unavailable (distinct from a mismatch)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_unavailable: true, face_ok: false}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('camera_unavailable');
    });

    it('D6-e wiring: ClockInDto keeps face_unavailable through the whitelist ValidationPipe', async () => {
      const {ValidationPipe} = await import('@nestjs/common');
      const {ClockInDto} = await import('./dto/attendance.dto');
      const pipe = new ValidationPipe({whitelist: true, transform: true});
      const out = (await pipe.transform(
        {face_ok: false, face_unavailable: true},
        {type: 'body', metatype: ClockInDto},
      )) as Record<string, unknown>;
      // If the DTO doesn't declare the field, whitelist:true strips it and the
      // server can never derive camera_unavailable — the D6-e reason goes dead.
      expect(out.face_unavailable).toBe(true);
    });

    it('offline submission → pending_review + offline (short-circuits)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true, offline: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('offline');
    });

    it('no geofence on the shift → radius not evaluated, falls through to present', () => {
      const v = deriveCheckIn(shiftFixture({site_lat: null, site_lng: null}), {...NEAR, face_ok: true}, onTime);
      expect(v.within_radius).toBeNull();
      expect(v.attendance_status).toBe('present');
    });
  });

  // ─── Dept Chat v2 · clockIn (flag ON) ─────────────────────────────────
  describe('clockIn (verified, flag on)', () => {
    beforeEach(() => { flagOn = true; });

    it('the SHIFT must come from the same org the session is filed against', async () => {
      /**
       * vs2 item 4 round 3 made the org header-aware and left the shift lookup
       * blind, so the two could name different companies. Chidi is standing in
       * Acme and his only assignment today is Meridian's: the row written was
       * org_user_id = acme with a MERIDIAN shift_id. The check-in was then
       * graded against Meridian's geofence and window, Acme's manager queue
       * showed a session carrying another company's site (and could approve
       * it), Meridian recorded a no-show — and since the open-session unique
       * index is on cpo_user_id alone, he could no longer check in at Meridian
       * for real.
       */
      mockDb.qOne
        .mockResolvedValueOnce(null)            // no open shift
        .mockResolvedValueOnce(shiftFixture())  // myTodayShift
        .mockResolvedValueOnce({id: 'sess1', org_user_id: 'acme', attendance_status: 'present'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'acme'}]);  // resolveOrg
      await svc.clockIn('chidi', {lat: 1, lng: 2, face_ok: true});

      const lookup = mockDb.qOne.mock.calls.find(c => /FROM cpo_shift_assignments/.test(String(c[0])));
      expect(lookup).toBeDefined();
      const sql = String(lookup![0]).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(sql).toMatch(/s\.org_user_id = \$2/);
      // …and the org actually reaches it, rather than the predicate sitting
      // there permanently satisfied by a NULL second parameter.
      expect(lookup![1]).toEqual(['chidi', 'acme']);
    });

    it('blocks check-in when no shift is assigned today', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)                   // no open shift
        .mockResolvedValueOnce(null);                  // myTodayShift → none
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      await expect(svc.clockIn('cpo-1', {lat: 25.2, lng: 55.3, face_ok: true}))
        .rejects.toThrow('no_active_shift_assigned');
    });

    it('records the derived status + verification result against the shift', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(shiftFixture())
        .mockResolvedValueOnce({id: 'sess1', org_user_id: 'org-9', attendance_status: 'pending_review'});
      mockDb.q.mockResolvedValueOnce([{org_user_id: 'org-9'}]);
      await svc.clockIn('cpo-1', {face_ok: true}); // no coords → permission_denied
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO cpo_shift_sessions[\s\S]*shift_id/i.test(String(c[0])));
      expect(insert).toBeDefined();
      const params = insert![1] as unknown[];
      expect(params).toContain('pending_review'); // attendance_status
      expect(params).toContain('permission_denied'); // review_reason
    });
  });

  // ─── Spec p.5 — check-OUT verification (face + location, mirrors check-in) ──
  describe('deriveCheckOut', () => {
    const NEAR = {lat: 25.2001, lng: 55.3001};

    it('clean checkout (coords in radius + face ok) → no review flag', () => {
      const v = deriveCheckOut(shiftFixture(), {...NEAR, face_ok: true});
      expect(v.review_reason).toBeNull();
      expect(v.within_radius).toBe(true);
    });

    it('missing coords → permission_denied', () => {
      expect(deriveCheckOut(shiftFixture(), {face_ok: true}).review_reason).toBe('permission_denied');
    });

    it('camera unavailable → camera_unavailable (distinct from mismatch)', () => {
      expect(deriveCheckOut(shiftFixture(), {...NEAR, face_unavailable: true, face_ok: false}).review_reason)
        .toBe('camera_unavailable');
    });

    it('face failed → face_mismatch', () => {
      expect(deriveCheckOut(shiftFixture(), {...NEAR, face_ok: false}).review_reason).toBe('face_mismatch');
    });

    it('out of radius → out_of_radius', () => {
      const v = deriveCheckOut(shiftFixture(), {lat: 25.5, lng: 55.6, face_ok: true});
      expect(v.review_reason).toBe('out_of_radius');
      expect(v.within_radius).toBe(false);
    });

    it('legacy client (no face fields) is not face-flagged', () => {
      expect(deriveCheckOut(shiftFixture(), NEAR).review_reason).toBeNull();
    });

    it('no geofence on the shift → radius not evaluated', () => {
      const v = deriveCheckOut(shiftFixture({site_lat: null, site_lng: null}), {...NEAR, face_ok: true});
      expect(v.within_radius).toBeNull();
      expect(v.review_reason).toBeNull();
    });
  });

  describe('clockOut (verified, flag on)', () => {
    beforeEach(() => { flagOn = true; });

    it('flags the session Pending Review when checkout verification fails', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({ // close UPDATE
          id: 'sess1', shift_id: 'sh1', clock_out_at: '2026-06-22T16:59:00Z',
          attendance_status: 'present', review_status: 'none',
        })
        .mockResolvedValueOnce(shiftFixture()) // shift
        .mockResolvedValueOnce({id: 'sess1', review_status: 'pending', review_reason: 'face_mismatch'}); // flag UPDATE
      const out = await svc.clockOut('cpo-1', {lat: 25.2001, lng: 55.3001, face_ok: false});
      expect(out.review_status).toBe('pending');
      const flag = mockDb.qOne.mock.calls.find(c => /review_status\s*=\s*'pending'/i.test(String(c[0])));
      expect(flag).toBeDefined();
      expect(flag![1]).toContain('face_mismatch');
    });

    it('clean verified checkout does not flag (early-checkout logic still applies)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({
          id: 'sess1', shift_id: 'sh1', clock_out_at: '2026-06-22T16:59:00Z',
          attendance_status: 'present', review_status: 'none',
        })
        .mockResolvedValueOnce(shiftFixture());
      const out = await svc.clockOut('cpo-1', {lat: 25.2001, lng: 55.3001, face_ok: true});
      expect(out.review_status).toBe('none');
      const flag = mockDb.qOne.mock.calls.find(c => /review_status\s*=\s*'pending'/i.test(String(c[0])));
      expect(flag).toBeUndefined();
    });
  });

  // ─── Spec p.8 — member dispute route ──────────────────────────────────
  describe('disputeSession', () => {
    beforeEach(() => { flagOn = true; });

    it('flags own reviewed record back to pending with reason=disputed + note, audited', async () => {
      tx.qOne
        .mockResolvedValueOnce({ // SELECT FOR UPDATE (own row)
          id: 'sess1', org_user_id: 'org-9', cpo_user_id: 'cpo-1',
          review_status: 'rejected', attendance_status: 'absent',
        })
        .mockResolvedValueOnce({id: 'sess1', review_status: 'pending', review_reason: 'disputed'});
      const out = await svc.disputeSession('cpo-1', 'sess1', 'I was on site, GPS was off');
      expect(out.review_status).toBe('pending');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'cpo-1', 'attendance.dispute', expect.objectContaining({targetId: 'sess1'}),
      );
    });

    it("rejects another member's session", async () => {
      tx.qOne.mockResolvedValueOnce(null); // scoped SELECT misses
      await expect(svc.disputeSession('cpo-1', 'not-mine', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when already pending review', async () => {
      tx.qOne.mockResolvedValueOnce({
        id: 'sess1', org_user_id: 'org-9', cpo_user_id: 'cpo-1', review_status: 'pending',
      });
      await expect(svc.disputeSession('cpo-1', 'sess1', 'x')).rejects.toThrow('already_pending_review');
    });
  });

  // ─── Spec p.9 — edit preserves original capture (audit before/after) ──
  describe('editShift (audited, original preserved)', () => {
    it('writes an org_audit_log row carrying the ORIGINAL clock times', async () => {
      tx.qOne
        .mockResolvedValueOnce({ // SELECT FOR UPDATE (before)
          id: 'sess1', org_user_id: 'org-9', status: 'closed',
          clock_in_at: '2026-06-22T08:00:00Z', clock_out_at: '2026-06-22T17:00:00Z',
        })
        .mockResolvedValueOnce(null)  // A7.4 guard: no corrections on this session
        .mockResolvedValueOnce({id: 'sess1', status: 'edited'}); // UPDATE
      await svc.editShift('org-9', 'mgr-1', 'sess1', {
        clock_out_at: '2026-06-22T18:00:00Z', edit_reason: 'forgot to clock out',
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.edit',
        expect.objectContaining({
          targetId: 'sess1',
          metadata: expect.objectContaining({
            before: {clock_in_at: '2026-06-22T08:00:00Z', clock_out_at: '2026-06-22T17:00:00Z'},
          }),
        }),
      );
    });
  });

  // ─── Scope v2 A7.2 — a DRAFT month is invisible to the team ───────────
  describe('myTodayShift respects roster publish state', () => {
    it('hides shifts whose roster month is not published, and keeps unlinked ones', async () => {
      await svc.myTodayShift('cpo-1');
      const sql = String(mockDb.qOne.mock.calls[0][0]);
      // A LEFT JOIN with a NULL-permitting predicate. An inner join would hide
      // every pre-v2 day-by-day shift, which is the whole existing product.
      expect(sql).toMatch(/LEFT JOIN public\.cpo_roster_months/);
      expect(sql).toMatch(/rm\.id IS NULL OR rm\.status IN \('published', 'amended'\)/);
      // draft and archived are the two that must NOT appear in that list
      const allowed = sql.match(/rm\.status IN \(([^)]*)\)/)?.[1] ?? '';
      expect(allowed).not.toMatch(/draft|archived/);
    });
  });

  // ─── Shift update/archive + create/assign audit ───────────────────────
  describe('shift lifecycle audit + update/archive', () => {
    it('createShift writes an audit row', async () => {
      // Scope v2 A7.2 — the shift's roster month is resolved first. G-d moved
      // the whole create into ONE transaction, so the queue rides tx.qOne.
      tx.qOne.mockResolvedValueOnce({id: 'rm-1'});
      tx.qOne.mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z'});
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.create', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    /** G-d — weekly recurrence: N REAL rows, +7d·k, one shared group id, each
     *  occurrence resolving its OWN roster month. Resolving once would file
     *  the whole series into the first month and hide every later occurrence
     *  from its own month's conflict scan (the pinned RED mutation). */
    it('repeat_weeks materialises N rows, each resolving its OWN month', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 'grp-1'})       // gen_random_uuid
        .mockResolvedValueOnce({id: 'rm-jun'})      // month, occurrence 1
        .mockResolvedValueOnce(shiftFixture())      // insert 1
        .mockResolvedValueOnce(null)                // month, occurrence 2 (July — unplanned)
        .mockResolvedValueOnce(shiftFixture({id: 'sh2'}));  // insert 2
      const out = await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-29T09:00:00Z', end_at: '2026-06-29T17:00:00Z', repeat_weeks: 2,
      });
      expect(out.occurrences).toBe(2);
      expect(out.shift.id).toBe('sh1');
      // Occurrence 2 is +7d — into July — and its month lookup used JULY's
      // key, not a copy of occurrence 1's.
      const monthCalls = tx.qOne.mock.calls.filter(c => /cpo_roster_months/.test(String(c[0])));
      expect(monthCalls).toHaveLength(2);
      expect(monthCalls[0][1]).toContain('2026-06-01');
      expect(monthCalls[1][1]).toContain('2026-07-01');
      // Both inserts carry the SAME group id; the start dates are 7 days apart.
      const inserts = tx.qOne.mock.calls.filter(c => /INSERT INTO cpo_shifts/.test(String(c[0])));
      expect(inserts).toHaveLength(2);
      expect((inserts[0][1] as unknown[])[10]).toBe('grp-1');
      expect((inserts[1][1] as unknown[])[10]).toBe('grp-1');
      expect((inserts[1][1] as unknown[])[6]).toBe('2026-07-06T09:00:00.000Z');
      // One audit row per occurrence, ON THE TX — dropping the tx option would
      // commit audits for a rolled-back series (critic P3, 2026-08-08).
      expect(mockAudit.log).toHaveBeenCalledTimes(2);
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.create',
        expect.objectContaining({tx: expect.anything()}));
    });

    /** Q6 — multi-date create: explicit windows, N REAL rows, one shared
     *  group, each occurrence resolving its OWN month, sorted by start so the
     *  response's `shift` is the earliest occurrence regardless of tap order. */
    it('occurrences materialises N rows (sorted), each resolving its OWN month', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 'grp-1'})              // gen_random_uuid
        .mockResolvedValueOnce({id: 'rm-jun'})             // month, June (sorted first)
        .mockResolvedValueOnce(shiftFixture())             // insert 1
        .mockResolvedValueOnce(null)                       // month, July
        .mockResolvedValueOnce(shiftFixture({id: 'sh2'})); // insert 2
      const out = await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        // Deliberately OUT of order — the service sorts by start.
        occurrences: [
          {start_at: '2026-07-03T09:00:00Z', end_at: '2026-07-03T17:00:00Z'},
          {start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z'},
        ],
      });
      expect(out.occurrences).toBe(2);
      expect(out.shift.id).toBe('sh1');
      const monthCalls = tx.qOne.mock.calls.filter(c => /cpo_roster_months/.test(String(c[0])));
      expect(monthCalls[0][1]).toContain('2026-06-01');
      expect(monthCalls[1][1]).toContain('2026-07-01');
      const inserts = tx.qOne.mock.calls.filter(c => /INSERT INTO cpo_shifts/.test(String(c[0])));
      expect(inserts).toHaveLength(2);
      expect((inserts[0][1] as unknown[])[10]).toBe('grp-1');
      expect((inserts[0][1] as unknown[])[6]).toBe('2026-06-22T09:00:00Z');
      expect((inserts[1][1] as unknown[])[6]).toBe('2026-07-03T09:00:00Z');
    });

    it('REFUSES occurrences combined with repeat_weeks', async () => {
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        repeat_weeks: 2,
        occurrences: [{start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z'}],
      })).rejects.toThrow('occurrences_and_repeat_exclusive');
    });

    it('REFUSES an inverted window inside occurrences, even with valid top-level times', async () => {
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        occurrences: [{start_at: '2026-06-23T17:00:00Z', end_at: '2026-06-23T09:00:00Z'}],
      })).rejects.toThrow('invalid_shift_window');
      expect(tx.qOne.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/INSERT INTO cpo_shifts/);
    });

    it('a single shift gets NO recurrence group and the legacy two-query shape', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'rm-1'}).mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
      });
      const inserts = tx.qOne.mock.calls.filter(c => /INSERT INTO cpo_shifts/.test(String(c[0])));
      expect((inserts[0][1] as unknown[])[10]).toBeNull();
      expect(tx.qOne.mock.calls.some(c => /gen_random_uuid/.test(String(c[0])))).toBe(false);
    });

    /** ARCHIVED is terminal (no un-archive): a shift linked into one is
     *  permanently invisible to its member while the create reports success —
     *  and recurrence made it multi-row. Refusal, not caveat (edge review). */
    it('REFUSES to create into an ARCHIVED roster month', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'rm-old', status: 'archived'});
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
      })).rejects.toThrow('roster_month_archived');
      const wrote = tx.qOne.mock.calls.map(c => String(c[0])).join('\n');
      expect(wrote).not.toMatch(/INSERT INTO cpo_shifts/);
    });

    it('REFUSES an inverted window — the server is the boundary, not the form', async () => {
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T17:00:00Z', end_at: '2026-06-22T09:00:00Z',
      })).rejects.toThrow('invalid_shift_window');
      expect(tx.qOne).not.toHaveBeenCalled();
    });

    /** G-d — assignees ride the create tx and are copied to EVERY occurrence:
     *  the create-then-assign orphan window (G-ab round 3) is structurally
     *  gone for callers of the new shape. */
    it('cpo_user_ids are validated once and assigned to every occurrence', async () => {
      tx.q.mockResolvedValueOnce([{member_user_id: 'cpo-a'}]);   // active check
      tx.qOne
        .mockResolvedValueOnce({id: 'grp-1'})
        .mockResolvedValueOnce(null).mockResolvedValueOnce(shiftFixture())
        .mockResolvedValueOnce(null).mockResolvedValueOnce(shiftFixture({id: 'sh2'}));
      await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        repeat_weeks: 2, cpo_user_ids: ['cpo-a'],
      });
      const assigns = tx.q.mock.calls.filter(c => /cpo_shift_assignments/.test(String(c[0])));
      expect(assigns).toHaveLength(2);
      expect(assigns[0][1]).toEqual(['sh1', ['cpo-a']]);
      expect(assigns[1][1]).toEqual(['sh2', ['cpo-a']]);
    });

    /** G-c — assign_department is an EXPANSION input (validated against the
     *  branch), never a scope: scoped managers cannot expand a sibling branch,
     *  and an empty branch is a loud 400, not a silent no-op. */
    it('assign_department expands to active non-manager members; sibling branches are 403', async () => {
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        assign_department: 'Finance',
      }, 'Ops')).rejects.toThrow('department_outside_your_branch');

      tx.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}]) // expansion
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}]); // active check
      tx.qOne.mockResolvedValueOnce({id: 'rm-1'}).mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        assign_department: 'Ops',
      }, 'Ops');
      const expansion = tx.q.mock.calls[0];
      expect(String(expansion[0])).toMatch(/member_role <> 'manager'/);
      expect(expansion[1]).toEqual(['org-9', 'Ops']);
    });

    it('an EMPTY expansion refuses loudly', async () => {
      tx.q.mockResolvedValueOnce([]);   // nobody in the branch
      await expect(svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
        assign_department: 'Ghost',
      })).rejects.toThrow('department_has_no_members');
    });

    it('assignCpos writes an audit row', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});
      mockDb.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}])
        .mockResolvedValueOnce([]);
      await svc.assignCpos('org-9', 'sh1', ['cpo-a'], 'mgr-1');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.assign', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('updateShift patches an owned, non-archived shift and audits before/after', async () => {
      tx.qOne
        .mockResolvedValueOnce(shiftFixture())                            // SELECT FOR UPDATE
        .mockResolvedValueOnce({id: 'rm-1'})                              // roster month
        .mockResolvedValueOnce(shiftFixture({site_label: 'North Gate'})); // UPDATE
      const out = await svc.updateShift('org-9', 'mgr-1', 'sh1', {site_label: 'North Gate'});
      expect(out.site_label).toBe('North Gate');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.update', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    /**
     * Scope v2 A7.2 — B2/B7.
     *
     * The roster state machine, the publish states and the conflict check all
     * key off `cpo_shifts.roster_month_id`. Nothing wrote it, so `findConflicts`
     * matched no rows and every month published "0 conflicts" over a calendar
     * that could be full of double-bookings. These pin the two write sites.
     */
    it('createShift LINKS the shift to its roster month', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'rm-9'});
      tx.qOne.mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {
        department: 'Ops', start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
      });
      const [sql, params] = tx.qOne.mock.calls[1];
      expect(String(sql)).toMatch(/roster_month_id/);
      // The VALUE at its own position, not merely "the id appears somewhere in
      // the params": the array is full of nulls from the optional site fields,
      // so a membership check cannot discriminate a wrong or missing binding.
      expect((params as unknown[])[9]).toBe('rm-9');
    });

    it('createShift resolves the month from the START date, in UTC', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'rm-9'}).mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
      });
      // First of the month, matching RosterService.monthKey exactly. A second
      // month rule would file a shift in one month and the manager's calendar
      // in another.
      expect(tx.qOne.mock.calls[0][1]).toContain('2026-06-01');
    });

    /**
     * THE REGRESSION THIS ROUND ALMOST SHIPPED.
     *
     * The first version of the linkage CREATED the month when it was missing.
     * A created month starts as a DRAFT, drafts are hidden from members, and
     * `myTodayShift` gates CLOCK-IN — so every ad-hoc shift in an org that had
     * never opened the month planner would have become invisible to its CPO
     * and impossible to clock in against. Strictly worse than the missing link
     * it was fixing.
     *
     * Resolving only an EXISTING month keeps the two flows separate BY
     * CONSTRUCTION: no planner, no link, no behaviour change.
     */
    it('createShift NEVER creates a roster month, so ad-hoc shifts stay visible', async () => {
      tx.qOne
        .mockResolvedValueOnce(null)              // no month is being planned
        .mockResolvedValueOnce(shiftFixture());   // the shift insert
      const out = await svc.createShift('org-9', 'mgr-1', {
        start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
      });
      expect(out.shift).toMatchObject({id: 'sh1'});
      expect(out.occurrences).toBe(1);
      // Exactly two queries: the lookup and the insert. An INSERT INTO
      // cpo_roster_months anywhere here is the regression.
      const sqls = tx.qOne.mock.calls.map(c => String(c[0]));
      expect(sqls).toHaveLength(2);
      expect(sqls.join('\n')).not.toMatch(/INSERT INTO public\.cpo_roster_months/);
      // …and the shift is stored unlinked, which is what keeps it visible.
      // Position 9, not `toContain(null)`: five other optional columns bind
      // null here, so a membership check passes whatever roster_month_id holds.
      expect((tx.qOne.mock.calls[1][1] as unknown[])[9]).toBeNull();
    });

    /**
     * The UPDATE binds roster_month_id WITHOUT a COALESCE, unlike every other
     * column in it. A null from the resolver is a real answer — "no longer part
     * of a planned month" — and COALESCE would read it as "keep the old one".
     * Moving a shift from a planned August into an unplanned September would
     * then leave it bound to August: polluting August's conflict check and
     * making a September shift appear when August is published.
     */
    it('updateShift UN-LINKS a shift moved out of a planned month', async () => {
      tx.qOne
        .mockResolvedValueOnce(shiftFixture({start_at: '2026-06-22T09:00:00Z'}))
        .mockResolvedValueOnce(null)                                  // Sept is not planned
        .mockResolvedValueOnce(shiftFixture({start_at: '2026-09-02T09:00:00Z'}));
      await svc.updateShift('org-9', 'mgr-1', 'sh1', {start_at: '2026-09-02T09:00:00Z'});
      const [sql, params] = tx.qOne.mock.calls[2];
      expect(String(sql)).toMatch(/roster_month_id\s*=\s*\$10/);
      expect(String(sql)).not.toMatch(/roster_month_id\s*=\s*COALESCE/);
      expect((params as unknown[])[9]).toBeNull();
    });

    it('updateShift re-links using the EFFECTIVE date, not just the dto', async () => {
      // The UPDATE is COALESCE-based, so an edit that does not carry a date
      // must keep the STORED one. Reading dto.start_at alone would resolve
      // `undefined` and unlink every shift edited for any other reason.
      tx.qOne
        .mockResolvedValueOnce(shiftFixture({start_at: '2026-06-22T09:00:00Z'}))
        .mockResolvedValueOnce({id: 'rm-6'})
        .mockResolvedValueOnce(shiftFixture({site_label: 'North Gate'}));
      await svc.updateShift('org-9', 'mgr-1', 'sh1', {site_label: 'North Gate'});
      expect(tx.qOne.mock.calls[1][1]).toContain('2026-06-01');
    });

    it('updateShift MOVES a shift to the new month when the date changes', async () => {
      tx.qOne
        .mockResolvedValueOnce(shiftFixture({start_at: '2026-06-22T09:00:00Z'}))
        .mockResolvedValueOnce({id: 'rm-jul'})
        .mockResolvedValueOnce(shiftFixture({start_at: '2026-07-02T09:00:00Z'}));
      await svc.updateShift('org-9', 'mgr-1', 'sh1', {start_at: '2026-07-02T09:00:00Z'});
      expect(tx.qOne.mock.calls[1][1]).toContain('2026-07-01');
      expect(tx.qOne.mock.calls[2][1]).toContain('rm-jul');
    });

    it('archiveShift sets archived_at and audits', async () => {
      mockDb.qOne.mockResolvedValueOnce(shiftFixture({archived_at: '2026-07-02T00:00:00Z'}));
      const out = await svc.archiveShift('org-9', 'mgr-1', 'sh1');
      expect(out.archived_at).not.toBeNull();
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.archive', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('updateShift throws when the shift is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.updateShift('org-9', 'mgr-1', 'nope', {site_label: 'x'}))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── Spec p.9/p.10 — department/shift filters ─────────────────────────
  describe('department/shift filters', () => {
    it('orgSummary forwards department + shift filters into the query', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: '0'});
      await svc.orgSummary('org-9', {department: 'Operations', shiftId: 'sh1'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shifts/i);
      expect(params).toContain('Operations');
      expect(params).toContain('sh1');
    });

    it('pendingQueue forwards the department filter', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.pendingQueue('org-9', {department: 'Operations'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shifts/i);
      expect(params).toContain('Operations');
    });

    it('exportSessions filters by department and records ALL filters in the audit metadata', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.exportSessions('org-9', 'mgr-1', {department: 'Operations', shiftId: 'sh1', cpoUserId: 'cpo-a'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/sh\.department/i);
      expect(params).toContain('Operations');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.export',
        expect.objectContaining({
          metadata: expect.objectContaining({department: 'Operations', shift_id: 'sh1', cpo_user_id: 'cpo-a'}),
        }),
      );
    });
  });

  // ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ──────────────────
  describe('assignCpos', () => {
    it('rejects a CPO that is not an active member of this org', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});     // shift belongs to org
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-a'}]); // only 1 of 2 active
      await expect(svc.assignCpos('org-9', 'sh1', ['cpo-a', 'cpo-foreign']))
        .rejects.toThrow('cpo_not_active_member_of_org');
    });

    it('throws when the shift is not in the org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.assignCpos('org-9', 'nope', ['cpo-a']))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('inserts assignments when all CPOs are active members', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});
      mockDb.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}]) // active check
        .mockResolvedValueOnce([]); // insert
      const out = await svc.assignCpos('org-9', 'sh1', ['cpo-a', 'cpo-b']);
      expect(out.assigned).toBe(2);
      const insert = mockDb.q.mock.calls.find(c => /INSERT INTO cpo_shift_assignments/i.test(String(c[0])));
      expect(insert).toBeDefined();
    });
  });

  describe('myTodayShift', () => {
    it('queries the covering/soonest shift for the CPO', async () => {
      mockDb.qOne.mockResolvedValueOnce(shiftFixture());
      const out = await svc.myTodayShift('cpo-1');
      expect(out?.id).toBe('sh1');
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shift_assignments/);
      expect(String(sql)).toMatch(/archived_at IS NULL/);
      expect(params[0]).toBe('cpo-1');
    });
  });

  // ─── 🛑 biometric stop-condition: face_meta sanitizer ─────────────────
  describe('sanitizeFaceMeta', () => {
    it('keeps scalar audit metadata but DROPS arrays/objects (no biometric bytes)', () => {
      const out = sanitizeFaceMeta({
        model: 'facecheck', version: 2, confidenceBucket: 'high', live: true,
        frames: [1, 2, 3], descriptor: {x: 1}, // <- would-be biometric payloads
      });
      expect(out).toEqual({model: 'facecheck', version: 2, confidenceBucket: 'high', live: true});
      expect(out).not.toHaveProperty('frames');
      expect(out).not.toHaveProperty('descriptor');
    });

    it('returns {} for missing/invalid meta', () => {
      expect(sanitizeFaceMeta(undefined)).toEqual({});
    });
  });

  // ─── Dept Chat v2 · review workflow (Step 6) ──────────────────────────
  describe('reviewSession', () => {
    const pendingRow = {
      id: 'sess1', org_user_id: 'org-9', review_status: 'pending',
      attendance_status: 'pending_review', shift_id: 'sh1', clock_in_at: '2026-06-22T09:05:00Z',
    };

    it('approve flips review + derives final status, audits, and NEVER touches the capture', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)                          // SELECT FOR UPDATE
        .mockResolvedValueOnce({v: null})  // post-lock effective clock-in (none)
        .mockResolvedValueOnce(null)  // A7.4 guard: no corrections on this session
        .mockResolvedValueOnce({start_at: '2026-06-22T09:00:00Z'})  // shift window
        .mockResolvedValueOnce({id: 'sess1', review_status: 'approved', attendance_status: 'present'}); // UPDATE
      const out = await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve');
      expect(out.review_status).toBe('approved');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.review.approve', expect.objectContaining({targetId: 'sess1'}),
      );
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      expect(updateCall).toBeDefined();
      expect(String(updateCall![0])).not.toMatch(/clock_in/); // captured geotag/time immutable
    });

    /**
     * THE DEAD END REFUSE-OVER-RECONCILE CREATED.
     *
     * A member can DISPUTE a corrected session, which sets review_status to
     * 'pending'. When reviewSession simply threw, that record sat in the
     * pending queue with NO way out — a member action became an unclearable
     * support ticket.
     *
     * attendance_status is the only correctable field this method writes, so
     * the review is always recordable: clear the queue, and leave the field the
     * correction chain owns untouched.
     */
    it('still CLEARS a disputed session that is under correction, without touching the corrected field', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)                       // SELECT FOR UPDATE
        .mockResolvedValueOnce({v: null})                        // post-lock effective clock-in
        .mockResolvedValueOnce({id: 'corr-1'})                   // it IS under correction
        .mockResolvedValueOnce({start_at: '2026-06-22T09:00:00Z'})
        .mockResolvedValueOnce({id: 'sess1', review_status: 'approved'});
      const out = await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve');
      expect(out.review_status).toBe('approved');   // the queue item is cleared

      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      // The status write is CONDITIONAL, and the flag says "withhold it".
      expect(String(updateCall![0]))
        .toMatch(/attendance_status = CASE WHEN \$7 THEN attendance_status ELSE \$4 END/);
      expect((updateCall![1] as unknown[])[6]).toBe(true);
      // …and the audit records that it was withheld, or nobody can tell why the
      // status did not move.
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.review.approve',
        expect.objectContaining({
          metadata: expect.objectContaining({attendance_status_withheld: true}),
        }),
      );
    });

    it('writes the derived status normally when the session is NOT under correction', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)
        .mockResolvedValueOnce({v: null})                        // post-lock effective clock-in
        .mockResolvedValueOnce(null)                             // no corrections
        .mockResolvedValueOnce({start_at: '2026-06-22T09:00:00Z'})
        .mockResolvedValueOnce({id: 'sess1', review_status: 'approved'});
      await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve');
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      expect((updateCall![1] as unknown[])[6]).toBe(false);
    });

    it('D6-b: reject drives attendance_status to terminal absent (leaves the pending bucket)', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)
        .mockResolvedValueOnce({v: null})  // post-lock effective clock-in
        .mockResolvedValueOnce(null)  // A7.4 guard: no corrections on this session
        .mockResolvedValueOnce({id: 'sess1', review_status: 'rejected', attendance_status: 'absent'});
      const out = await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'reject', 'insufficient evidence');
      expect(out.review_status).toBe('rejected');
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      expect((updateCall![1] as unknown[])[3]).toBe('absent'); // attendance_status param
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.review.reject', expect.anything());
    });

    it('throws when the record is not pending', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sess1', org_user_id: 'org-9', review_status: 'none'});
      await expect(svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve')).rejects.toThrow('not_pending_review');
    });

    it('throws when the session is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.reviewSession('org-9', 'mgr-1', 'nope', 'approve')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('patchAssignments (G-ab — the un-assign that never existed)', () => {
    it('removes WITHOUT the active-member check (un-assigning the suspended is the point), idempotently, audited', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});       // shift in org (+branch)
      tx.q.mockResolvedValueOnce([{cpo_user_id: 'cpo-gone'}]);  // DELETE RETURNING
      await svc.patchAssignments('org-9', 'sh1', {remove: ['cpo-gone']}, 'mgr-1');
      const del = tx.q.mock.calls.find(c => /DELETE FROM cpo_shift_assignments/.test(String(c[0])));
      expect(del?.[1]).toEqual(['sh1', ['cpo-gone']]);
      // No membership query ran for a pure remove.
      expect(tx.q.mock.calls.some(c => /FROM org_members/.test(String(c[0])))).toBe(false);
      // WHO, not just how many; and ON THE TX — the diff and its audits
      // commit or roll back together.
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.shift.unassign',
        expect.objectContaining({targetId: 'sh1',
          metadata: {count: 1, member_ids: ['cpo-gone']}, tx}));
    });

    it('add AND remove in one call (the shape the client sends) - both on ONE tx, ACTUAL counts', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});
      tx.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-new'}])   // membership
        .mockResolvedValueOnce([{cpo_user_id: 'cpo-new'}])      // INSERT RETURNING
        .mockResolvedValueOnce([]);                             // DELETE RETURNING: already gone
      const out = await svc.patchAssignments('org-9', 'sh1',
        {add: ['cpo-new'], remove: ['cpo-old']}, 'mgr-1');
      // removed reports ROWS AFFECTED (0 - already unassigned), never the
      // requested count: the old return body lied.
      expect(out).toEqual({added: 1, removed: 0});
      expect(mockAudit.log).toHaveBeenCalledTimes(2);
      // ...and STILL no session write anywhere on this shape.
      const all = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls, ...tx.q.mock.calls, ...tx.qOne.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(all).not.toMatch(/cpo_shift_sessions/);
    });

    it('an id in BOTH add and remove is refused outright', async () => {
      await expect(svc.patchAssignments('org-9', 'sh1', {add: ['x'], remove: ['x']}, 'mgr-1'))
        .rejects.toThrow('assignment_diff_overlap');
      expect(tx.qOne).not.toHaveBeenCalled();
    });

    /** G-c — assign_department expands into `add` inside the tx; the expansion
     *  is branch-validated (never a scope) and re-checked against `remove`. */
    it('assign_department merges the branch into add; sibling branches 403 before any query', async () => {
      await expect(svc.patchAssignments('org-9', 'sh1',
        {assign_department: 'Finance'}, 'mgr-1', 'Ops'))
        .rejects.toThrow('department_outside_your_branch');
      expect(tx.qOne).not.toHaveBeenCalled();

      tx.qOne.mockResolvedValueOnce({id: 'sh1'});   // shift, in-branch
      tx.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}])  // expansion
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}])  // membership
        .mockResolvedValueOnce([{cpo_user_id: 'cpo-a'}, {cpo_user_id: 'cpo-b'}]);       // INSERT
      const out = await svc.patchAssignments('org-9', 'sh1',
        {assign_department: 'Ops'}, 'mgr-1', 'Ops');
      expect(out.added).toBe(2);
      expect(String(tx.q.mock.calls[0][0])).toMatch(/member_role <> 'manager'/);
    });

    it('an expanded member colliding with an explicit remove is the same contradictory diff', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});
      tx.q.mockResolvedValueOnce([{member_user_id: 'cpo-a'}]);   // expansion includes cpo-a
      await expect(svc.patchAssignments('org-9', 'sh1',
        {assign_department: 'Ops', remove: ['cpo-a']}, 'mgr-1'))
        .rejects.toThrow('assignment_diff_overlap');
      // Nothing written: the refusal precedes both write statements.
      const writes = tx.q.mock.calls.map(c => String(c[0])).join('\n');
      expect(writes).not.toMatch(/INSERT INTO cpo_shift_assignments|DELETE FROM cpo_shift_assignments/);
    });

    it('listAssignments carries the same branch predicate', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});
      mockDb.q.mockResolvedValueOnce([{cpo_user_id: 'cpo-1', display_name: 'Sam'}]);
      const out = await svc.listAssignments('org-9', 'sh1', 'Ops');
      expect(out).toEqual([{cpo_user_id: 'cpo-1', display_name: 'Sam'}]);
      const shiftRead = String(mockDb.qOne.mock.calls[0][0]);
      expect(shiftRead).toMatch(/\$3::text IS NULL OR department = \$3/);
      expect(mockDb.qOne.mock.calls[0][1][2]).toBe('Ops');
    });

    it('SESSIONS ARE NEVER TOUCHED — the record of work that happened is immutable here', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});
      tx.q.mockResolvedValueOnce([{cpo_user_id: 'cpo-1'}]);
      await svc.patchAssignments('org-9', 'sh1', {remove: ['cpo-1'], add: []}, 'mgr-1');
      const all = [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls, ...tx.q.mock.calls, ...tx.qOne.mock.calls]
        .map(c => String(c[0])).join('\n');
      expect(all).not.toMatch(/cpo_shift_sessions/);
    });

    it('adds validate active membership AND the scoped branch (F HIGH-1 lesson, day one)', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});
      tx.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-1'}])   // in-branch
        .mockResolvedValueOnce([{cpo_user_id: 'cpo-1'}]);     // INSERT RETURNING
      await svc.patchAssignments('org-9', 'sh1', {add: ['cpo-1']}, 'mgr-1', 'Ops');
      const membership = tx.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect(String(membership![0])).toMatch(/\$3::text IS NULL OR department = \$3/);
      expect(membership![1][2]).toBe('Ops');
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.shift.assign',
        expect.objectContaining({metadata: {count: 1, member_ids: ['cpo-1']}, tx}));
    });

    it('an out-of-branch add names the offenders', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sh1'});
      tx.q.mockResolvedValueOnce([]);   // nobody matches branch+active
      await expect(svc.patchAssignments('org-9', 'sh1', {add: ['cpo-exec']}, 'mgr-1', 'Ops'))
        .rejects.toMatchObject({response: expect.objectContaining({member_ids: ['cpo-exec']})});
    });

    it('a scoped manager cannot touch another branch’s shift at all', async () => {
      // tx.qOne default null = the branch predicate filtered the shift out.
      await expect(svc.patchAssignments('org-9', 'sh-exec', {remove: ['x']}, 'mgr-1', 'Ops'))
        .rejects.toThrow('shift_not_found_in_org');
      const shiftRead = String(tx.qOne.mock.calls[0][0]);
      expect(shiftRead).toMatch(/\$3::text IS NULL OR department = \$3/);
    });

    it('an empty diff is a 400 BEFORE any query (no shift-existence leak)', async () => {
      await expect(svc.patchAssignments('org-9', 'sh1', {}, 'mgr-1'))
        .rejects.toThrow('assignment_diff_empty');
      expect(tx.qOne).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });
  });

  describe('setDayStatus', () => {
    it('D6-f: replaces any prior day-status marker for the same CPO+date (upsert via delete)', async () => {
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1'}]); // active + in-branch
      tx.q
        .mockResolvedValueOnce([])                  // prior markers: none
        .mockResolvedValueOnce([])                  // DELETE
        .mockResolvedValueOnce([{id: 'marker1', attendance_status: 'leave'}]); // INSERT … SELECT
      await svc.setDayStatus('org-9', 'mgr-1', {cpoUserId: 'cpo-1', status: 'leave', date: '2026-06-22'});
      const del = tx.q.mock.calls.find(c => /DELETE FROM cpo_shift_sessions/i.test(String(c[0])));
      expect(del).toBeDefined();
      expect(String(del![0])).toMatch(/shift_id IS NULL/);
      // The six-value marker list, in DTO order (dayStatusServerContract pins
      // the same equality from source).
      expect(String(del![0])).toMatch(/attendance_status IN \('leave','sick_leave','emergency_leave','off_duty','absent','mission'\)/);
      expect(tx.q.mock.calls.some(c => /INSERT INTO cpo_shift_sessions/i.test(String(c[0])))).toBe(true);
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.day_status',
        expect.objectContaining({targetKind: 'user', targetId: 'cpo-1'}));
    });

    it('A7.3 batch: members × dates in ONE insert, one audit row per member, one notify per member', async () => {
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1'}, {member_user_id: 'cpo-2'}]);
      tx.q
        .mockResolvedValueOnce([])                  // prior markers
        .mockResolvedValueOnce([])                  // DELETE
        .mockResolvedValueOnce([{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}]); // 2×2 rows
      const out = await svc.setDayStatus('org-9', 'mgr-1', {
        memberIds: ['cpo-1', 'cpo-2'], status: 'mission', dates: ['2026-08-10', '2026-08-11'],
      });
      expect(out).toEqual({ok: true, members: 2, dates: 2});
      const ins = tx.q.mock.calls.find(c => /INSERT INTO cpo_shift_sessions/i.test(String(c[0])));
      // One statement, cross-joined — not a loop of single INSERTs.
      expect(String(ins![0])).toMatch(/CROSS JOIN unnest/);
      expect(mockAudit.log).toHaveBeenCalledTimes(2);
      expect(mockNotifications.record).toHaveBeenCalledTimes(2);
      // vs2 edge A1/A2 — and the ORG. This is the only `record()` caller outside
      // the push bridge, so it threads the org itself; without it the bell row
      // taps into Attend under whatever context was sticky, which for a
      // recipient who is also a manager is another org's AdminAttendance.
      expect(mockNotifications.record).toHaveBeenCalledWith('cpo-1',
        {eventClass: 'enterprise', kind: 'enterprise.day_status', orgUserId: 'org-9'});
    });

    it('a batch over the 500 marker cap is refused before any query runs in the tx', async () => {
      const memberIds = Array.from({length: 100}, (_, i) => `c-${i}`);
      const dates = Array.from({length: 6}, (_, i) => `2026-08-0${i + 1}`);
      mockDb.q.mockResolvedValueOnce(memberIds.map(id => ({member_user_id: id})));
      await expect(svc.setDayStatus('org-9', 'mgr-1', {memberIds, status: 'leave', dates}))
        .rejects.toThrow('day_status_batch_too_large');
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('exactly ONE targeting mode per call', async () => {
      await expect(svc.setDayStatus('org-9', 'mgr-1', {
        cpoUserId: 'cpo-1', memberIds: ['cpo-2'], status: 'leave',
      })).rejects.toThrow('day_status_one_targeting_mode');
    });

    /**
     * HIGH-1 (F review) — the one-layer-out class, again: three sibling
     * handlers force `manager.department` and this one didn't, so a
     * branch-scoped Ops manager could mark the Executive branch absent
     * org-wide. The forced branch now rides the 4th service arg AND the
     * membership query's predicate.
     */
    it('HIGH-1: a branch-scoped manager cannot target outside their branch', async () => {
      mockDb.q.mockResolvedValueOnce([]);   // nobody matches org+active+BRANCH
      await expect(svc.setDayStatus('org-9', 'mgr-1',
        {memberIds: ['cpo-exec'], status: 'absent', dates: ['2026-08-10']}, 'Ops'))
        .rejects.toThrow(BadRequestException);
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/\$3::text IS NULL OR department = \$3/);
      expect(params[2]).toBe('Ops');
      expect(tx.q).not.toHaveBeenCalled();  // refused before the tx opened
    });

    it('HIGH-1: a branch-scoped manager cannot target the ORG account (no self-target exemption)', async () => {
      mockDb.q.mockResolvedValueOnce([]);   // the org account has no org_members row
      await expect(svc.setDayStatus('org-9', 'mgr-1',
        {memberIds: ['org-9'], status: 'leave', dates: ['2026-08-10']}, 'Ops'))
        .rejects.toThrow(BadRequestException);
    });

    it('HIGH-1: the controller FORCES the manager branch (source scan)', () => {
      const ctl = readFileSync(join(__dirname, 'attendance.controller.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l: string) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n');
      const start = ctl.indexOf("@Post('day-status')");
      const end = ctl.indexOf("@Get('org/summary')");
      // Fail CLOSED if an anchor moves: slice(start, -1) would run to EOF,
      // where the export handler has a byte-identical forced line (HIGH-A
      // post-mortem — the scan passed while pinning the defective text).
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const slice = ctl.slice(start, end);
      // The force is CONDITIONAL on department mode (unconditional forcing
      // 400'd every scoped manager's member_ids call — two modes counted),
      // and the guard arg is threaded for the member_ids/legacy paths.
      expect(slice).toMatch(/department: dto\.department != null \? \(manager\.department \?\? dto\.department\) : undefined/);
      expect(slice).toMatch(/\}, manager\.department\)/);
    });

    /**
     * HIGH-A regression pin — EXECUTES the controller's exact DTO mapping for
     * the shipped-client shape (member_ids from a SCOPED manager): the force
     * must not add a second targeting mode, and the branch must still bind.
     * A source scan cannot see a mode collision; this runs the real code.
     */
    it('HIGH-A: a scoped manager using member_ids SUCCEEDS, branch-filtered', async () => {
      const mgrDept = 'Ops';
      const dtoDepartment: string | undefined = undefined; // client sent member_ids only
      const mapped = dtoDepartment != null ? (mgrDept ?? dtoDepartment) : undefined;
      mockDb.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-1'}]); // in-branch, active
      tx.q
        .mockResolvedValueOnce([])   // priors
        .mockResolvedValueOnce([])   // DELETE
        .mockResolvedValueOnce([{id: 'm1'}]); // INSERT
      const out = await svc.setDayStatus('org-9', 'mgr-1', {
        memberIds: ['cpo-1'], department: mapped, status: 'leave', dates: ['2026-08-10'],
      }, mgrDept);
      expect(out).toEqual({ok: true, members: 1, dates: 1});
      // …and the membership read carried the forced branch.
      expect(mockDb.q.mock.calls[0][1][2]).toBe('Ops');
    });

    it('a refused membership names the offenders', async () => {
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1'}]); // cpo-2 missing
      await expect(svc.setDayStatus('org-9', 'mgr-1',
        {memberIds: ['cpo-1', 'cpo-2'], status: 'leave', dates: ['2026-08-10']}))
        .rejects.toMatchObject({response: expect.objectContaining({member_ids: ['cpo-2']})});
    });

    it('department targeting expands server-side to active non-managers, and refuses an empty branch', async () => {
      mockDb.q.mockResolvedValueOnce([]);           // expansion: nobody
      await expect(svc.setDayStatus('org-9', 'mgr-1', {department: 'Ops', status: 'leave'}))
        .rejects.toThrow('no_active_members_in_department');
      const exp = mockDb.q.mock.calls.find(c => /FROM org_members/.test(String(c[0])));
      expect(String(exp![0])).toMatch(/department = \$2 AND member_role <> 'manager'/);
      expect(String(exp![0])).toMatch(/status = 'active'/);
    });

    /**
     * setDayStatus upserts by DELETING the day's marker. Deleting a corrected
     * marker strands its trail — the rows survive (append-only) but their
     * subject is gone, which is the failure the missing foreign key was
     * justified by. So the prior markers are read FIRST and the delete is
     * refused if any is under correction.
     */
    it('REFUSES to delete a day marker that is under correction — the WHOLE batch, naming the pairs', async () => {
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1'}]); // active member
      tx.q
        .mockResolvedValueOnce([{id: 'marker1', cpo_user_id: 'cpo-1', day: '2026-06-22'}]) // prior marker
        .mockResolvedValueOnce([{session_id: 'marker1'}]);        // the blocked-pairs read
      tx.qOne.mockResolvedValueOnce({id: 'corr-1'});              // …and it is corrected
      await expect(svc.setDayStatus('org-9', 'mgr-1', {
        cpoUserId: 'cpo-1', status: 'sick_leave', date: '2026-06-22',
      })).rejects.toThrow('session_under_correction');
      // The DELETE must not have run — that is the whole point of reading first.
      expect(tx.q.mock.calls.some(c => /DELETE FROM cpo_shift_sessions/i.test(String(c[0]))))
        .toBe(false);
    });

    it('rejects a CPO that is not an active member of the org', async () => {
      // Membership reads rows via mockDb.q now; the beforeEach default []
      // IS the "not a member" case — no priming needed.
      await expect(svc.setDayStatus('org-9', 'mgr-1', {cpoUserId: 'foreign', status: 'leave'}))
        .rejects.toThrow('cpo_not_active_member_of_org');
    });
  });

  // ─── Dept Chat v2 · admin view + export (Step 7) ──────────────────────
  describe('orgSummary', () => {
    it('aggregates counts + a separate pending-review tally', async () => {
      mockDb.q.mockResolvedValueOnce([
        {attendance_status: 'present', n: '5'},
        {attendance_status: 'late', n: '2'},
      ]);
      mockDb.qOne.mockResolvedValueOnce({n: '3'});
      const out = await svc.orgSummary('org-9');
      expect(out.counts.present).toBe(5);
      expect(out.total).toBe(7);
      expect(out.pendingReview).toBe(3);
    });
  });

  describe('exportSessions', () => {
    it('emits biometric-free CSV and writes an audit row before returning', async () => {
      mockDb.q.mockResolvedValueOnce([
        {cpo_user_id: 'cpo-1', display_name: 'Alex', department: 'Ops', site_label: 'HQ',
         clock_in_at: '2026-06-22T09:00:00Z', clock_out_at: null, attendance_status: 'present',
         face_verified: true, within_radius: true, admin_notes: null},
      ]);
      const out = await svc.exportSessions('org-9', 'mgr-1', {});
      expect(out.contentType).toMatch(/text\/csv/);
      expect(out.body).toMatch(/Alex/);
      expect(out.body).not.toMatch(/face_meta/i); // no biometric metadata
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.export',
        expect.objectContaining({metadata: expect.objectContaining({format: 'csv'})}),
      );
    });
  });

  /**
   * A7.4 / N4 — CORRECTED VALUES ARE WHAT EVERY READER SHOWS.
   *
   * `recordCorrection` appends rows; for months the four human-facing readers
   * ignored them — the admin dashboard, the pending queue, the CSV export and
   * the member's own history all displayed the pre-correction value, so a
   * recorded correction changed nothing anyone could see. Each reader's SQL
   * now folds "the LATEST correction NAMING the field wins" (the SQL twin of
   * recordCorrection's inline Object.assign fold over listCorrections). These
   * assertions pin the fold's SHAPE at each decision site; the mutations each
   * one kills are named inline.
   */
  describe('A7.4 / N4 — the corrections fold reaches every human-facing reader', () => {
    const FOLD_STATUS = /after_value->>'attendance_status'/;
    // Mutation: ASC (or no ORDER) returns the FIRST correction — the fold
    // must take the latest; `c.id DESC` breaks corrected_at ties the same
    // way the JS twin's ASC-then-last-assign does (both pick the max id).
    const LATEST = /ORDER BY c\.corrected_at DESC, c\.id DESC LIMIT 1/;
    // The key test scopes the fold to corrections that NAME the field.
    // Mutation that kills it: drop the `?` filter — the newest correction may
    // be clock-only, so its `->>'attendance_status'` yields NULL and COALESCE
    // falls back to the RAW value, shadowing an older status correction that
    // should still win. (JSON-null values never reach after_value: the input
    // side of normaliseCorrectableValue rejects them — pinned in roster.spec.)
    const KEY_TEST = (f: string) => new RegExp(`after_value \\? '${f}'`);

    const readerSql = async (call: () => Promise<unknown>): Promise<string> => {
      await call();
      return [...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls]
        .map(c => String(c[0])).join('\n');
    };

    it('myShifts NAMES the organisation on every row', async () => {
      /**
       * B-611 SUPERSEDED the 2026-08-12 "stays CROSS-ORG" call: my shifts now
       * scope to the viewing org when a header is present (see the B-611 tests
       * below). This test exercises the NO-HEADER all-own branch, which still
       * spans orgs — so the row must SAY which company it belongs to.
       *
       * Asserted on the SQL: the db is mocked to answer regardless of the
       * query, so nothing behavioural here can see a missing column. The
       * COALESCE order matters — display_name for an org id is the OWNER'S
       * PERSONAL NAME, which this repo has already shipped by accident once.
       */
      mockDb.q.mockResolvedValueOnce([]);
      await svc.myShifts('cpo-1');
      const sql = String(mockDb.q.mock.calls[0][0])
        .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(sql).toMatch(/AS org_name/);
      expect(sql).toMatch(/COALESCE\([a-z_]+\.name,\s*[a-z_]+\.display_name\)/);
      expect(sql).toMatch(/LEFT JOIN public\.org_workspaces/);
    });

    // DOCUMENTS B-611 — twin of B-610 (incidents). "My shifts" must scope to the
    // org being viewed when the client names one, so a CPO at several agencies
    // no longer sees every agency's shifts mixed. Absent header → all-own (never
    // a partial list). resolveOrg computes the same org key clockIn() stamps.
    it('scopes to cpo AND the viewing org when a header is present (B-611)', async () => {
      mockDb.q
        .mockResolvedValueOnce([{org_user_id: 'org-A'}]) // resolveOrg → org_members
        .mockResolvedValueOnce([{id: 'ses1'}]);          // the scoped list
      await svc.myShifts('cpo-1', 'org-A');
      expect(String(mockDb.q.mock.calls[0][0])).toMatch(/FROM org_members/); // resolveOrg ran
      const [sql, params] = mockDb.q.mock.calls[1];
      const clean = String(sql).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(clean).toMatch(/cpo_user_id = \$1 AND ses\.org_user_id = \$2/);
      expect(params[0]).toBe('cpo-1');
      expect(params[1]).toBe('org-A');
    });

    it('shows ALL the cpo’s own shifts when no org is named — no empty list (B-611)', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'ses1'}]); // one query, no resolveOrg
      await svc.myShifts('cpo-1'); // no header
      expect(mockDb.q).toHaveBeenCalledTimes(1);
      const clean = String(mockDb.q.mock.calls[0][0])
        .split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
      expect(clean).toMatch(/WHERE ses\.cpo_user_id = \$1\s+ORDER BY/); // no org filter
      expect(clean).not.toMatch(/org_user_id = \$2/);
    });

    it('myShifts folds all three fields, aliased AFTER ses.* (last duplicate wins)', async () => {
      const sql = await readerSql(() => svc.myShifts('cpo-1'));
      expect(sql).toMatch(FOLD_STATUS);
      expect(sql).toMatch(KEY_TEST('attendance_status'));
      expect(sql).toMatch(KEY_TEST('clock_in_at'));
      expect(sql).toMatch(KEY_TEST('clock_out_at'));
      expect(sql).toMatch(LATEST);
      // The ordering that makes the shadowing work: ses.* first, folds after.
      expect(sql.indexOf('ses.*')).toBeGreaterThan(-1);
      expect(sql.indexOf('ses.*')).toBeLessThan(sql.indexOf("AS attendance_status"));
    });

    it('pendingQueue folds all three fields after ses.*', async () => {
      const sql = await readerSql(() => svc.pendingQueue('org-9'));
      expect(sql).toMatch(FOLD_STATUS);
      expect(sql).toMatch(KEY_TEST('clock_in_at'));
      expect(sql).toMatch(KEY_TEST('clock_out_at'));
      expect(sql).toMatch(LATEST);
      expect(sql.indexOf('ses.*')).toBeLessThan(sql.indexOf("AS attendance_status"));
    });

    it('orgShifts (the per-CPO drill-down) folds all three fields, BOTH branches', async () => {
      const sqlAll = await readerSql(() => svc.orgShifts('org-9'));
      expect(sqlAll).toMatch(FOLD_STATUS);
      expect(sqlAll).toMatch(LATEST);
      jest.clearAllMocks();
      mockDb.q.mockResolvedValue([]);
      const sqlOne = await readerSql(() => svc.orgShifts('org-9', {cpoUserId: 'cpo-1'}));
      expect(sqlOne).toMatch(FOLD_STATUS);
      expect(sqlOne).toMatch(KEY_TEST('clock_out_at'));
    });

    it('orgSummary GROUPs BY the FOLDED status — a corrected grade must change buckets', async () => {
      await svc.orgSummary('org-9');
      // Scoped to the COUNTS query alone: the pendingReview query follows in
      // the same method, and a union of both would let a fold on the wrong
      // query satisfy the assertions.
      const sql = String(mockDb.q.mock.calls[0][0]);
      expect(sql).toMatch(FOLD_STATUS);
      expect(sql).toMatch(LATEST);
      // Mutation: `GROUP BY ses.attendance_status` counts the RAW value while
      // displaying nothing different — the exact invisible-correction bug.
      expect(sql).toMatch(/GROUP BY 1/);
      expect(sql).not.toMatch(/GROUP BY ses\.attendance_status/);
      // The pendingReview tally stays RAW on purpose: review_status is not a
      // correctable field.
      const pendingSql = String(mockDb.qOne.mock.calls[0][0]);
      expect(pendingSql).not.toMatch(FOLD_STATUS);
    });

    it('exportSessions folds the three CSV columns', async () => {
      const sql = await readerSql(() => svc.exportSessions('org-9', 'mgr-1', {}));
      expect(sql).toMatch(FOLD_STATUS);
      expect(sql).toMatch(KEY_TEST('clock_in_at'));
      expect(sql).toMatch(KEY_TEST('clock_out_at'));
      expect(sql).toMatch(LATEST);
    });

    it('reviewSession GRADES from the effective clock-in the queue displayed', async () => {
      // Correction moved clock-in 09:45 → 08:55; shift starts 09:00. The
      // queue shows 08:55, so Approve must derive PRESENT — grading the raw
      // 09:45 wrote 'late' from a time no surface displayed.
      tx.qOne
        .mockResolvedValueOnce({
          id: 's1', shift_id: 'sh1', review_status: 'pending',
          clock_in_at: '2026-08-07T09:45:00.000Z',
          attendance_status: 'pending_review',
        })
        .mockResolvedValueOnce({v: '2026-08-07T08:55:00.000Z'})        // effective read, POST-lock
        .mockResolvedValueOnce(null)                                   // isUnderCorrection: not
        .mockResolvedValueOnce({start_at: '2026-08-07T09:00:00.000Z'}) // the shift window
        .mockResolvedValueOnce({id: 's1', attendance_status: 'present'}); // UPDATE RETURNING
      await svc.reviewSession('org-9', 'mgr-1', 's1', 'approve');
      const update = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/.test(String(c[0])));
      expect(update?.[1]?.[3]).toBe('present');
      // The fold is a SECOND statement AFTER the lock — riding the locked
      // SELECT itself read the pre-wait snapshot, so a clock-only correction
      // that committed while we blocked was invisible (review-round LOW).
      expect(String(tx.qOne.mock.calls[0][0])).toMatch(/FOR UPDATE/);
      expect(String(tx.qOne.mock.calls[0][0])).not.toMatch(/after_value/);
      expect(String(tx.qOne.mock.calls[1][0])).toMatch(/after_value->>'clock_in_at'/);
      expect(String(tx.qOne.mock.calls[1][0])).not.toMatch(/FOR UPDATE/);
    });

    it('every human-facing session reader carries the fold (the gate that would have caught orgShifts)', () => {
      // Comment-stripped (blocks first, then line tails — the canonical order)
      // so prose naming effectiveField cannot satisfy the assertion. The five
      // readers are the ALLOWLIST'S complement: everything else that reads
      // cpo_shift_sessions is deliberately raw — the rollup guard
      // (idempotency), reviewSession's locked pre-read (its fold is a
      // separate post-lock statement, asserted above), clockIn/clockOut (the
      // live flow), and the write paths' RETURNING (clients reload).
      const src = readFileSync(join(__dirname, 'attendance.service.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l: string) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
        .join('\n');
      for (const m of ['myShifts', 'orgShifts', 'orgSummary', 'pendingQueue', 'exportSessions']) {
        const start = src.indexOf(`async ${m}(`);
        expect(start).toBeGreaterThan(-1);
        const end = src.indexOf('\n  }', start);
        const slice = src.slice(start, end > start ? end : undefined);
        expect(slice).toContain('effectiveField(');
      }
    });

    it('the clock folds cast to timestamptz; the status fold does not (type parity with the raw columns)', async () => {
      const sql = await readerSql(() => svc.myShifts('cpo-1'));
      expect(sql).toMatch(/'clock_in_at'\s*\n?\s*ORDER BY c\.corrected_at DESC, c\.id DESC LIMIT 1\)::timestamptz/);
      expect(sql).not.toMatch(/'attendance_status'\s*\n?\s*ORDER BY c\.corrected_at DESC, c\.id DESC LIMIT 1\)::timestamptz/);
    });

    it('the fold is tenancy-bound: the correction must belong to the session’s org', async () => {
      const sql = await readerSql(() => svc.myShifts('cpo-1'));
      // Mutation: dropping the org predicate lets a colliding session_id from
      // another org (impossible today, cheap forever) rewrite this org's read.
      expect(sql).toMatch(/c\.session_id = ses\.id AND c\.org_user_id = ses\.org_user_id/);
    });
  });
});
