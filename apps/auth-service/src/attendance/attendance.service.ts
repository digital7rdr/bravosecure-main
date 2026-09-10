import {BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService, type Tx} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {pickOrgContext, orgNameExpr, orgNameJoin} from '../org/org-context';
import {NotificationsService} from '../notifications/notifications.service';

// Closed sets shared by the schema CHECK constraints (20260629000000) and the
// service derivation logic, so a typo can't drift between SQL and TS.
export type AttendanceStatus =
  | 'present' | 'late' | 'absent' | 'early_checkout'
  | 'leave' | 'sick_leave' | 'off_duty' | 'pending_review'
  | 'emergency_leave' | 'mission';
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type ReviewReason =
  | 'face_mismatch' | 'out_of_radius' | 'permission_denied' | 'offline' | 'camera_unavailable'
  // Member-raised dispute (PDF p.8) — routes the record back into the manager queue.
  | 'disputed';

export interface ShiftSession {
  id: string;
  org_user_id: string;
  cpo_user_id: string;
  status: 'open' | 'closed' | 'edited';
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy_m: number | null;
  clock_out_at: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  edited_by: string | null;
  edited_at: string | null;
  edit_reason: string | null;
  /** vs2 item 4 — the COMPANY this record belongs to, for the cross-org lists. */
  org_name?: string | null;
  created_at: string;
  // Dept Chat v2 additive columns (20260629000000). NULL on legacy rows.
  shift_id: string | null;
  face_verified: boolean | null;        // presence-check result only — no biometrics
  face_meta: Record<string, unknown> | null;
  within_radius: boolean | null;
  distance_m: number | null;
  attendance_status: AttendanceStatus | null;
  review_status: ReviewStatus;
  review_reason: ReviewReason | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  admin_notes: string | null;
  // Member's dispute note (20260702000000) — write-once by the disputing member.
  dispute_note: string | null;
}

// An expected duty window + geofence centre + radius (cpo_shifts, 20260629000000).
export interface Shift {
  id: string;
  org_user_id: string;
  /** vs2 item 4 — so the clock-out button can name the shift it will end. */
  org_name?: string | null;
  department: string | null;
  site_label: string | null;
  site_lat: number | null;
  site_lng: number | null;
  approved_radius_m: number;
  start_at: string;
  end_at: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
}

// Verified check-in inputs (Step 5). Structurally satisfied by ClockInDto.
export interface ClockInInput {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  shift_id?: string;
  face_ok?: boolean;
  // D6-e — the camera/face step couldn't run (permission denied, no camera). Distinct from
  // face_ok===false (a genuine presence-check failure) so the manager queue can tell them apart.
  face_unavailable?: boolean;
  face_meta?: Record<string, unknown>;
  offline?: boolean;
}

interface CheckInVerdict {
  within_radius: boolean | null;
  distance_m: number | null;
  attendance_status: AttendanceStatus;
  review_status: ReviewStatus;
  review_reason: ReviewReason | null;
}

// Verified check-out inputs (PDF p.5 requires face + location on check-out too).
// Structurally satisfied by ClockOutDto.
export interface ClockOutInput {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  face_ok?: boolean;
  face_unavailable?: boolean;
}

interface CheckOutVerdict {
  within_radius: boolean | null;
  distance_m: number | null;
  // null = clean checkout; set = flag the session Pending Review with this reason.
  review_reason: ReviewReason | null;
}

// Late if clock-in is more than this past the shift start; early-checkout if
// clock-out is more than this before the shift end. (v1 fixed grace — PDF p.6.)
const GRACE_MS = 10 * 60 * 1000;

/** Great-circle distance in metres (radius check is server-authoritative). */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 🛑 Defence-in-depth for the biometric stop-condition. face_meta is audit
 * metadata only (model/version tag, confidence bucket, timestamp). This strips
 * anything that isn't a scalar — so a client cannot smuggle raw frames or a
 * face descriptor (which would be arrays/objects) into the JSONB column. Keys
 * are capped and string values truncated to keep the row small.
 */
export function sanitizeFaceMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return {};
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (kept >= 12) break;
    if (typeof v === 'string') { out[k] = v.slice(0, 120); kept++; }
    else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; kept++; }
    // arrays/objects (where biometric bytes would live) are dropped on purpose.
  }
  return out;
}

/**
 * Server-authoritative check-in verdict (pure → unit-testable). A failed face
 * check, denied/absent location, out-of-radius position, or offline submission
 * becomes Pending Review with a reason — never a silent Absent (PDF p.17).
 */
export function deriveCheckIn(shift: Shift, input: ClockInInput, now: Date): CheckInVerdict {
  const hasCoords = input.lat != null && input.lng != null;
  let within: boolean | null = null;
  let distance: number | null = null;
  if (hasCoords && shift.site_lat != null && shift.site_lng != null) {
    distance = Math.round(haversineM(input.lat!, input.lng!, shift.site_lat, shift.site_lng));
    within = distance <= shift.approved_radius_m;
  }

  const pending = (reason: ReviewReason): CheckInVerdict => ({
    within_radius: within,
    distance_m: distance,
    attendance_status: 'pending_review',
    review_status: 'pending',
    review_reason: reason,
  });

  if (input.offline) return pending('offline');
  if (!hasCoords) return pending('permission_denied');
  // D6-e — camera unavailable/denied is a distinct reason from a genuine face mismatch.
  if (input.face_unavailable) return pending('camera_unavailable');
  if (input.face_ok === false) return pending('face_mismatch');
  if (within === false) return pending('out_of_radius');

  const lateThreshold = new Date(shift.start_at).getTime() + GRACE_MS;
  return {
    within_radius: within,
    distance_m: distance,
    attendance_status: now.getTime() > lateThreshold ? 'late' : 'present',
    review_status: 'none',
    review_reason: null,
  };
}

/**
 * Server-authoritative check-OUT verdict (pure → unit-testable). Mirrors
 * deriveCheckIn's ordered checks: missing coords → out of radius → face. A
 * failure flags the session Pending Review — the captured check-in stays
 * untouched and the manager decides (PDF p.5/p.6).
 *
 * Back-compat: a legacy client that sends only lat/lng (no face fields) is not
 * face-flagged — same semantics as deriveCheckIn where `face_ok === undefined`
 * passes through. The face result is client-asserted either way.
 */
export function deriveCheckOut(shift: Shift, input: ClockOutInput): CheckOutVerdict {
  const hasCoords = input.lat != null && input.lng != null;
  let within: boolean | null = null;
  let distance: number | null = null;
  if (hasCoords && shift.site_lat != null && shift.site_lng != null) {
    distance = Math.round(haversineM(input.lat!, input.lng!, shift.site_lat, shift.site_lng));
    within = distance <= shift.approved_radius_m;
  }

  let reason: ReviewReason | null = null;
  if (!hasCoords) reason = 'permission_denied';
  else if (input.face_unavailable) reason = 'camera_unavailable';
  else if (input.face_ok === false) reason = 'face_mismatch';
  else if (within === false) reason = 'out_of_radius';

  return {within_radius: within, distance_m: distance, review_reason: reason};
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly audit: OrgAuditService,
    // A7.3 "notify the affected Member" — durable inbox rows (the
    // enterprise-join pattern). @Global module, no import needed here.
    private readonly notifications: NotificationsService,
  ) {}

  private get deptChatV2(): boolean {
    return this.config.get<boolean>('featureFlags.deptChatV2') === true;
  }

  // ─── CPO self clock-in/out ───────────────────────────────────────────
  //
  // The owning org is resolved from org_members (managed CPO). A self-
  // registered agent with no org is its own org (so the row is still valid
  // and the CPO can track their own attendance).
  private async resolveOrg(userId: string, requested: string | null = null): Promise<string> {
    /**
     * vs2 item 4 — WHICH org this record belongs to, when the person has more
     * than one.
     *
     * `requested` is the X-Org-Context the client already sends on this surface
     * (api.ts allowlists it). Without honouring it, Chidi — an officer at
     * agency Meridian and an employee of workspace Acme — stands inside Acme,
     * taps the action, and the record is filed against MERIDIAN, because the
     * ordering below prefers his cpo row. Acme's manager reads
     * WHERE org_user_id = the-acme-id and never sees it. The client was
     * faithfully naming the right org and the server was discarding it.
     *
     * `pickOrgContext` NARROWS: a header naming an org this person does not
     * belong to is ignored and the ordering below decides, so the cpo-first
     * default is unchanged for everyone who sends nothing.
     */
    const rows = await this.db.q<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status = 'active'
        -- PREFER the cpo membership, NEVER require it. Requiring it was a
        -- CRITICAL defect: a workspace employee has no cpo row, so nothing
        -- matched, the caller fell through to the self-id default, and the
        -- record was written under the employee's OWN user id — invisible to
        -- every manager read, which all scope by the real org.
        ORDER BY (member_role = 'cpo') DESC, created_at ASC`,
      [userId],
    );
    return pickOrgContext(rows, requested)?.org_user_id ?? userId;
  }

  async clockIn(cpoUserId: string, input: ClockInInput, orgContext: string | null = null): Promise<ShiftSession> {
    // The partial unique index (status='open') is the real guard against two
    // open shifts; check first for a friendly error instead of a 23505.
    const open = await this.db.qOne<{id: string}>(
      `SELECT id FROM cpo_shift_sessions WHERE cpo_user_id = $1 AND status = 'open'`,
      [cpoUserId],
    );
    if (open) throw new BadRequestException('shift_already_open');

    const orgUserId = await this.resolveOrg(cpoUserId, orgContext);

    // Legacy path (flag OFF): bare geotagged clock-in, byte-for-byte unchanged.
    if (!this.deptChatV2) {
      const row = await this.db.qOne<ShiftSession>(
        `INSERT INTO cpo_shift_sessions
           (org_user_id, cpo_user_id, status, clock_in_lat, clock_in_lng, clock_in_accuracy_m)
         VALUES ($1, $2, 'open', $3, $4, $5)
         RETURNING *`,
        [orgUserId, cpoUserId, input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null],
      );
      if (!row) throw new BadRequestException('clock_in_failed');
      return row;
    }

    // Verified path (flag ON): a check-in must be against an assigned shift.
    // Scoped to the org this check-in is being filed against — see myTodayShift.
    const shift = await this.myTodayShift(cpoUserId, orgUserId);
    if (!shift) throw new BadRequestException('no_active_shift_assigned');

    const verdict = deriveCheckIn(shift, input, new Date());
    const row = await this.db.qOne<ShiftSession>(
      `INSERT INTO cpo_shift_sessions
         (org_user_id, cpo_user_id, status, shift_id,
          clock_in_lat, clock_in_lng, clock_in_accuracy_m,
          face_verified, face_meta, within_radius, distance_m,
          attendance_status, review_status, review_reason)
       VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
       RETURNING *`,
      [orgUserId, cpoUserId, shift.id,
       input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null,
       input.face_ok ?? null, JSON.stringify(sanitizeFaceMeta(input.face_meta)),
       verdict.within_radius, verdict.distance_m,
       verdict.attendance_status, verdict.review_status, verdict.review_reason],
    );
    if (!row) throw new BadRequestException('clock_in_failed');
    return row;
  }

  async clockOut(cpoUserId: string, input: ClockOutInput): Promise<ShiftSession> {
    const row = await this.db.qOne<ShiftSession>(
      `UPDATE cpo_shift_sessions
          SET status = 'closed', clock_out_at = NOW(),
              clock_out_lat = $2, clock_out_lng = $3
        WHERE cpo_user_id = $1 AND status = 'open'
        RETURNING *`,
      [cpoUserId, input.lat ?? null, input.lng ?? null],
    );
    if (!row) throw new BadRequestException('no_open_shift');

    // v2 (Step 5): an early clock-out on a clean check-in (present/late) flips
    // the status to early_checkout; a failed check-out verification (face /
    // location / radius, PDF p.5) flags the session Pending Review. A row
    // already pending is never re-flagged, and the captured geotag/time stay
    // immutable — only status/review columns move.
    if (this.deptChatV2 && row.shift_id && row.clock_out_at) {
      const shift = await this.db.qOne<Shift>(
        `SELECT * FROM cpo_shifts WHERE id = $1`, [row.shift_id],
      );
      if (!shift) return row;

      let current = row;
      if ((current.attendance_status === 'present' || current.attendance_status === 'late')) {
        const earlyThreshold = new Date(shift.end_at).getTime() - GRACE_MS;
        if (new Date(row.clock_out_at).getTime() < earlyThreshold) {
          const updated = await this.db.qOne<ShiftSession>(
            `UPDATE cpo_shift_sessions SET attendance_status = 'early_checkout'
              WHERE id = $1 RETURNING *`,
            [row.id],
          );
          current = updated ?? current;
        }
      }

      const verdict = deriveCheckOut(shift, input);
      if (verdict.review_reason && current.review_status !== 'pending') {
        const flagged = await this.db.qOne<ShiftSession>(
          `UPDATE cpo_shift_sessions
              SET review_status = 'pending', review_reason = $2,
                  attendance_status = 'pending_review'
            WHERE id = $1 RETURNING *`,
          [current.id, verdict.review_reason],
        );
        return flagged ?? current;
      }
      return current;
    }
    return row;
  }

  /** The CPO's own recent shifts (newest first). */
  async myShifts(cpoUserId: string, orgContext: string | null = null, limit = 50): Promise<ShiftSession[]> {
    // B-611 — the twin of B-610 (incidents). Scope "my shifts" to the org being
    // viewed when the client names one, so a CPO who works for several agencies
    // no longer sees every agency's shifts mixed in one list (founder directive,
    // reversing the 2026-08-12 cross-org call for this surface). The original
    // decision worried scoping would turn this into "some of my shifts" on an
    // absent context — resolved here: with NO org context (cold start) we show
    // ALL the CPO's own shifts (labelled by org), never a partial list. Always
    // cpo_user_id-scoped (own shifts), so "all" is never a cross-user leak.
    // resolveOrg computes the SAME org key clockIn() stamps, so list and write agree.
    //
    // The corrected aliases come AFTER ses.* — node-postgres keeps the LAST
    // duplicate column, so the fold shadows the raw value. Ordering is by the
    // RAW clock-in: a correction re-grades a record, it does not move it in history.
    const capped = Math.min(limit, 200);
    const orgUserId = orgContext ? await this.resolveOrg(cpoUserId, orgContext) : null;
    const cols = `ses.*,
              ${orgNameExpr()} AS org_name,
              ${AttendanceService.effectiveField('attendance_status')} AS attendance_status,
              ${AttendanceService.effectiveField('clock_in_at')} AS clock_in_at,
              ${AttendanceService.effectiveField('clock_out_at')} AS clock_out_at`;
    if (orgUserId) {
      return this.db.q<ShiftSession>(
        `SELECT ${cols}
           FROM cpo_shift_sessions ses
          ${orgNameJoin('ses.org_user_id')}
          WHERE ses.cpo_user_id = $1 AND ses.org_user_id = $2
          ORDER BY ses.clock_in_at DESC
          LIMIT $3`,
        [cpoUserId, orgUserId, capped],
      );
    }
    return this.db.q<ShiftSession>(
      `SELECT ${cols}
         FROM cpo_shift_sessions ses
        ${orgNameJoin('ses.org_user_id')}
        WHERE ses.cpo_user_id = $1
        ORDER BY ses.clock_in_at DESC
        LIMIT $2`,
      [cpoUserId, capped],
    );
  }

  // ─── Provider view / edit (org-scoped) ───────────────────────────────

  /** All shifts across the org's roster (optionally one CPO), newest first.
   *  Folded like every other manager-facing reader — this is the per-CPO
   *  drill-down, and an unfolded list here would sit one tap from the folded
   *  orgSummary counts and disagree with them (C2 review, MEDIUM-2). */
  async orgShifts(
    orgUserId: string, opts?: {cpoUserId?: string; limit?: number},
    managerDepartment?: string | null,
  ): Promise<ShiftSession[]> {
    const folds = `${AttendanceService.effectiveField('attendance_status')} AS attendance_status,
              ${AttendanceService.effectiveField('clock_in_at')} AS clock_in_at,
              ${AttendanceService.effectiveField('clock_out_at')} AS clock_out_at`;
    // Branch scope with the SAME COALESCE rule as listCorrections/
    // recordCorrection (roster.service BRANCH_SCOPE_PREDICATE): this list is
    // the Corrections screen's session picker, so what it OFFERS must equal
    // what those verbs ACCEPT — unscoped it showed a branch manager every
    // sibling branch's sessions (times, statuses, dispute notes) and then
    // 404'd their correction (edge review, 2026-08-08).
    if (opts?.cpoUserId) {
      return this.db.q<ShiftSession>(
        `SELECT ses.*, ${folds}
           FROM cpo_shift_sessions ses
      LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
      LEFT JOIN org_members om ON om.org_user_id = ses.org_user_id AND om.member_user_id = ses.cpo_user_id
          WHERE ses.org_user_id = $1 AND ses.cpo_user_id = $2
            AND ($3::text IS NULL OR COALESCE(sh.department, om.department) = $3)
          ORDER BY ses.clock_in_at DESC LIMIT $4`,
        [orgUserId, opts.cpoUserId, managerDepartment ?? null, Math.min(opts.limit ?? 100, 500)],
      );
    }
    return this.db.q<ShiftSession>(
      `SELECT ses.*, ${folds}
         FROM cpo_shift_sessions ses
    LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
    LEFT JOIN org_members om ON om.org_user_id = ses.org_user_id AND om.member_user_id = ses.cpo_user_id
        WHERE ses.org_user_id = $1
          AND ($2::text IS NULL OR COALESCE(sh.department, om.department) = $2)
        ORDER BY ses.clock_in_at DESC LIMIT $3`,
      [orgUserId, managerDepartment ?? null, Math.min(opts?.limit ?? 100, 500)],
    );
  }

  /**
   * Provider edits a shift (e.g. correct a forgotten clock-out). Scoped to the
   * org that owns the row, audited via edited_by/edited_at/edit_reason.
   *
   * D6-a — only a clock_out_at edit closes the shift (status → 'edited'). Editing an
   * OPEN shift's clock-in time alone preserves 'open' so the CPO can still clock out
   * (clockOut matches status='open') and the open-shift unique guard keeps blocking a
   * second clock-in. Previously this always flipped to 'edited', orphaning open shifts.
   */
  /**
   * Scope v2 A7.4 — refuse to silently overwrite a session that is under
   * correction. THE PHASE 6 ENTRY BLOCKER.
   *
   * Corrections and direct edits are two mechanisms owning the same fields, and
   * the audit trail cannot represent both. `recordCorrection` folds the
   * correction chain over the session row to decide what the record "said
   * before", and the chain WINS — so a direct write in between makes the next
   * correction's `before_value` claim a value the record never actually held:
   *
   *   c1: absent -> present      (chain says 'present')
   *   editShift: -> 'late'       (the row now says 'late', nothing records it)
   *   c2: before='present'       <- A LIE. It said 'late'.
   *
   * That corrupts the one thing A7.4 exists to guarantee, in an APPEND-ONLY
   * table where it can never be repaired.
   *
   * Refusing is the honest resolution: the manager is directed to the
   * correction API, which records WHO and WHY. It is also zero-regression
   * today — no client can create a correction yet, so no session in production
   * has one. The alternative (make these paths record corrections themselves)
   * is a real feature and belongs with the correction UI, not here.
   */
  /**
   * What each writer actually touches. Named here rather than inlined so the
   * guard's question stays "does a correction own a field I am about to
   * write?" and cannot silently widen back to "does any correction exist?".
   *
   * These MUST stay a subset of the roster's CORRECTABLE_FIELDS — a field this
   * guard does not name is a field a correction cannot protect.
   */
  private static readonly CLOCK = ['clock_in_at', 'clock_out_at'] as const;
  private static readonly STATUS = ['attendance_status'] as const;

  private async isUnderCorrection(
    q: Pick<DatabaseService, 'qOne'> | Tx, orgUserId: string,
    sessionIds: string[], fields: readonly string[],
  ): Promise<boolean> {
    const ids = sessionIds.filter(Boolean);
    if (ids.length === 0 || fields.length === 0) {return false;}
    const hit = await q.qOne<{id: string}>(
      `SELECT id FROM public.attendance_corrections
        WHERE org_user_id = $1 AND session_id = ANY($2::uuid[])
          -- FIELD-AWARE, not "does any correction exist".
          --
          -- The first version asked the wrong question and was wrong in BOTH
          -- directions: editShift (which writes only the clock times) was
          -- refused because someone had re-graded the day, and reviewSession
          -- withheld attendance_status because someone had fixed a clock-out.
          --
          -- after_value already stores exactly the fields each correction owns,
          -- so ?| ("does this object have ANY of these keys") asks whether a
          -- correction owns a field THIS caller is about to write.
          AND after_value ?| $3::text[]
        LIMIT 1`,
      [orgUserId, ids, [...fields]],
    );
    return !!hit;
  }

  private async assertNotUnderCorrection(
    q: Pick<DatabaseService, 'qOne'> | Tx, orgUserId: string,
    sessionIds: string[], fields: readonly string[],
  ): Promise<void> {
    if (await this.isUnderCorrection(q, orgUserId, sessionIds, fields)) {
      throw new ConflictException('session_under_correction');
    }
  }

  /**
   * A7.4 / N4 — the ONE effective-value rule, applied at READ time.
   *
   * A recorded correction must change what every reader shows, or the
   * append-only trail is invisible ink: for months `recordCorrection` wrote
   * rows that orgSummary, the pending queue, the CSV export and the member's
   * own history all ignored. This fragment folds them in: the LATEST
   * correction NAMING the field wins — the SQL twin of `recordCorrection`'s
   * inline Object.assign fold over `listCorrections` (oldest → newest, last
   * write per field). Keep the two in lockstep.
   *
   * SQL-side (not a per-row service fold) because exportSessions reads up to
   * 5000 rows (N+1 forbidden) and orgSummary must aggregate the CORRECTED
   * status inside GROUP BY. The `? '<field>'` key test scopes the fold to
   * corrections that OWN the field — the latest correction overall may be
   * clock-only, and without the key test it would shadow an older status
   * correction. (A JSON *null* value can never appear here: the input side of
   * normaliseCorrectableValue rejects it, precisely because COALESCE cannot
   * represent "corrected to null".) `field` is a compile-time literal from
   * the union below, never caller input — no injection surface. Backed by
   * attendance_corrections_session_idx (session_id, corrected_at DESC), the
   * exact shape of this subquery. `c.id DESC` breaks corrected_at ties (BEGIN
   * timestamps can collide under the row lock) the SAME way the JS twin's
   * ASC-then-last-assign does — both resolve to the max id. The alias is
   * always `ses`; the cast keeps node-postgres returning the same JS type
   * (Date) for corrected and uncorrected clock values alike.
   *
   * WHERE clauses and ORDER BY deliberately stay on the RAW columns
   * everywhere this fragment is used: a date filter defines WHICH records (as
   * originally recorded) belong to the report, and ordering is the record's
   * place in history — the projection then shows their corrected CONTENT. A
   * cross-boundary clock correction therefore appears, corrected, inside the
   * window it was recorded in. Stated, not accidental.
   */
  private static effectiveField(
    field: 'attendance_status' | 'clock_in_at' | 'clock_out_at',
  ): string {
    const cast = field === 'attendance_status' ? '' : '::timestamptz';
    return `COALESCE((SELECT c.after_value->>'${field}'
         FROM public.attendance_corrections c
        WHERE c.session_id = ses.id AND c.org_user_id = ses.org_user_id
          AND c.after_value ? '${field}'
        ORDER BY c.corrected_at DESC, c.id DESC LIMIT 1)${cast}, ses.${field})`;
  }

  async editShift(
    orgUserId: string, editorUserId: string, shiftId: string,
    patch: {clock_in_at?: string; clock_out_at?: string; edit_reason: string},
    department: string | null = null,
  ): Promise<ShiftSession> {
    // PDF p.9 "manual edits must keep original captured data": the pre-edit clock
    // times are preserved in the org_audit_log row (before/after), so a manual
    // time correction never destroys the original capture. FOR UPDATE keeps the
    // before-snapshot and the write atomic.
    return this.db.withTransaction(async (tx) => {
      // AUTHZ-3 — a department-scoped (branch) manager may only edit sessions in
      // their own branch. The session's department is COALESCE(shift, member) —
      // the same predicate the scoped list/queue reads use. A null department (a
      // full org manager) matches all. The locked SELECT is the gate: a foreign
      // branch resolves no row and throws below, so the UPDATE never runs.
      const before = await tx.qOne<ShiftSession>(
        `SELECT ses.* FROM cpo_shift_sessions ses
           LEFT JOIN cpo_shifts sh  ON sh.id = ses.shift_id
           LEFT JOIN org_members om ON om.org_user_id = ses.org_user_id AND om.member_user_id = ses.cpo_user_id
          WHERE ses.id = $1 AND ses.org_user_id = $2
            AND ($3::text IS NULL OR COALESCE(sh.department, om.department) = $3)
          FOR UPDATE OF ses`,
        [shiftId, orgUserId, department],
      );
      if (!before) throw new NotFoundException('shift_not_found_in_org');
      // editShift writes the clock times and nothing else.
      await this.assertNotUnderCorrection(tx, orgUserId, [shiftId], AttendanceService.CLOCK);

      const row = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET clock_in_at  = COALESCE($4::timestamptz, clock_in_at),
                clock_out_at = COALESCE($5::timestamptz, clock_out_at),
                status       = CASE WHEN $5::timestamptz IS NOT NULL THEN 'edited' ELSE status END,
                edited_by    = $3,
                edited_at    = NOW(),
                edit_reason  = $6
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        [shiftId, orgUserId, editorUserId,
         patch.clock_in_at ?? null, patch.clock_out_at ?? null, patch.edit_reason],
      );
      if (!row) throw new NotFoundException('shift_not_found_in_org');

      await this.audit.log(orgUserId, editorUserId, 'attendance.shift.edit', {
        targetKind: 'shift_session', targetId: shiftId,
        metadata: {
          before: {clock_in_at: before.clock_in_at, clock_out_at: before.clock_out_at},
          after: {clock_in_at: patch.clock_in_at ?? null, clock_out_at: patch.clock_out_at ?? null},
          reason: patch.edit_reason,
        },
        tx,
      });
      return row;
    });
  }

  // ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ──────────────────

  /** Manager creates an expected duty window + geofence centre + radius. */
  /**
   * Scope v2 A7.2 — find the roster month a shift falls in, if the org is
   * actually planning that month. Returns null when it is not.
   *
   * Why this exists: `cpo_roster_months` and the publish state machine are
   * worth nothing if no shift is ever attached to a month. The conflict check
   * joins shifts BY `roster_month_id`, so an unlinked shift is invisible to it
   * — the month would publish "0 conflicts" over a calendar full of
   * double-bookings. Linking at the two write sites is what makes the state
   * machine describe reality instead of an empty set.
   *
   * IT DELIBERATELY DOES NOT CREATE THE MONTH.
   *
   * An earlier version did, mirroring the roster ensure path, and that was a
   * regression far worse than the bug it fixed: a created month starts as a
   * DRAFT, drafts are hidden from members, and `myTodayShift` gates CLOCK-IN.
   * So every ad-hoc shift created by the existing day-by-day flow would have
   * become invisible to its CPO and impossible to clock in against — in an org
   * that had never opened the month planner at all.
   *
   * Resolving only an EXISTING month keeps the two flows separate by
   * construction: no planner, no link, no behaviour change. The month row is
   * created when a manager opens the planner (`RosterService.ensureMonth`,
   * POST month/ensure — never a GET), which
   * is the act of choosing to plan that month, and only then does its publish
   * state start governing what the team can see.
   *
   * Month boundaries are computed in UTC, matching `RosterService.monthKey` —
   * two different rules would file a shift in one month and show the manager's
   * calendar for another.
   */
  private async resolveRosterMonthId(
    q: Pick<DatabaseService, 'qOne'> | Tx,
    orgUserId: string,
    department: string | null, startAt: string | Date,
  ): Promise<string | null> {
    const d = new Date(startAt);
    if (Number.isNaN(d.getTime())) {return null;}
    const key = `${d.toISOString().slice(0, 7)}-01`;

    const existing = await q.qOne<{id: string; status: string}>(
      `SELECT id, status FROM public.cpo_roster_months
        WHERE org_user_id = $1 AND month = $2::date
          AND COALESCE(department, '') = COALESCE($3::text, '')`,
      [orgUserId, key, department],
    );
    // ARCHIVED is terminal — there is no un-archive, so a shift linked to an
    // archived month is permanently invisible to its member (myTodayShift
    // hides it) and skipped by the absent sweep, while the create reports
    // plain success. Refusing is the only honest answer; draft linkage stays
    // silent — that IS the planning state (edge review, 2026-08-08; the
    // recurrence loop made this multi-row, so it graduated from caveat to
    // refusal).
    if (existing?.status === 'archived') {
      throw new BadRequestException('roster_month_archived');
    }
    return existing?.id ?? null;
  }

  /**
   * G-c — expand a department to its assignable members. "Team" ==
   * org_members.department: no team entity exists, the branch string IS the
   * grouping (same query shape as setDayStatus's expansion in item F — each
   * site keeps its own refusal semantics on purpose). Managers are excluded
   * from EXPANSION only — "assign the whole branch" means the staff, not its
   * manager; a manager can still be assigned by explicit id on any endpoint.
   * Empty expansion is a LOUD 400 — a silent no-op would read as "assigned
   * the whole team".
   */
  private async expandDepartmentMembers(
    q: Pick<DatabaseService, 'q'> | Tx, orgUserId: string, department: string,
  ): Promise<string[]> {
    const rows = await q.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND status = 'active' AND department = $2
          AND member_role <> 'manager'`,
      [orgUserId, department],
    );
    if (rows.length === 0) {
      throw new BadRequestException('department_has_no_members');
    }
    return rows.map(r => r.member_user_id);
  }

  async createShift(
    orgUserId: string, createdBy: string,
    dto: {
      department?: string; site_label?: string; site_lat?: number; site_lng?: number;
      approved_radius_m?: number; start_at: string; end_at: string;
      repeat_weeks?: number; cpo_user_ids?: string[]; assign_department?: string;
      occurrences?: Array<{start_at: string; end_at: string}>;
    },
    // G-ab HIGH-3: a scoped manager's shifts are FORCED into their branch —
    // a blank Department box must never mint a NULL-department shift they
    // then cannot read back through their own branch predicate.
    // NOTE a consequence: if that branch has no cpo_roster_months row,
    // resolveRosterMonthId yields NULL and the shift is UNLINKED — immediately
    // visible/clockable even while the org's own month sits in draft. That is
    // the pre-v2 ad-hoc behaviour, deliberately preferred over silently filing
    // a branch shift into a month its author cannot read.
    managerDepartment?: string | null,
  ): Promise<{shift: Shift; occurrences: number}> {
    const dept = managerDepartment ?? dto.department ?? null;
    // G-d — the server is the boundary: the client validates too, but an
    // inverted window from any caller must not mint a shift no one can hold.
    if (Date.parse(dto.end_at) <= Date.parse(dto.start_at)) {
      throw new BadRequestException('invalid_shift_window');
    }
    // G-c — the EXPANSION input is validated against the branch, never fed
    // into any scope predicate (the F HIGH-1 spoof-surface rule).
    if (dto.assign_department && managerDepartment != null
        && dto.assign_department !== managerDepartment) {
      throw new ForbiddenException('department_outside_your_branch');
    }
    const weeks = dto.repeat_weeks ?? 1;
    // Q6 — multi-date create. Explicit windows and the weekly repeat are two
    // different answers to "which days"; combining them would multiply into
    // rows nobody asked for, so it is refused loudly.
    if (dto.occurrences && dto.occurrences.length > 0 && dto.repeat_weeks) {
      throw new BadRequestException('occurrences_and_repeat_exclusive');
    }
    const windows: Array<{start: string; end: string}> =
      dto.occurrences && dto.occurrences.length > 0
        ? dto.occurrences.map(o => ({start: o.start_at, end: o.end_at}))
        : Array.from({length: weeks}, (_, k) => ({
            // +7d·k on the UTC instant — DST wall-clock drift is deferred and
            // stated (blueprint G-d); no rrule engine, N real rows.
            start: new Date(Date.parse(dto.start_at) + k * 7 * 86_400_000).toISOString(),
            end: new Date(Date.parse(dto.end_at) + k * 7 * 86_400_000).toISOString(),
          }));
    for (const w of windows) {
      if (Date.parse(w.end) <= Date.parse(w.start)) {
        throw new BadRequestException('invalid_shift_window');
      }
    }
    // Deterministic "first" shift for the response + a stable audit order —
    // and dedupe identical windows: the calendar's Set prevents them from the
    // app, but a direct API caller could mint N copies of one shift in one
    // recurrence group (critic LOW-7).
    windows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let i = windows.length - 1; i > 0; i--) {
      if (windows[i].start === windows[i - 1].start && windows[i].end === windows[i - 1].end) {
        windows.splice(i, 1);
      }
    }
    // ONE transaction across occurrences, assignments and audits: a series
    // must exist wholly or not at all — a half-created series is exactly the
    // orphan-create class G-ab round 3 closed for single shifts.
    return this.db.withTransaction(async tx => {
      let ids = Array.from(new Set(dto.cpo_user_ids ?? []));
      if (dto.assign_department) {
        const expanded = await this.expandDepartmentMembers(tx, orgUserId, dto.assign_department);
        ids = Array.from(new Set([...ids, ...expanded]));
      }
      if (ids.length > 0) {
        const active = await tx.q<{member_user_id: string}>(
          `SELECT member_user_id FROM org_members
            WHERE org_user_id = $1 AND status = 'active' AND member_user_id = ANY($2::uuid[])
              AND ($3::text IS NULL OR department = $3)`,
          [orgUserId, ids, managerDepartment ?? null],
        );
        if (active.length !== ids.length) {
          const ok = new Set(active.map(r => r.member_user_id));
          throw new BadRequestException({
            message: 'cpo_not_active_member_of_org',
            member_ids: ids.filter(t => !ok.has(t)),
          });
        }
      }
      const group = windows.length > 1
        ? (await tx.qOne<{id: string}>(`SELECT gen_random_uuid() AS id`))?.id ?? null
        : null;
      let first: Shift | null = null;
      for (let k = 0; k < windows.length; k++) {
        const startK = windows[k].start;
        const endK = windows[k].end;
        // EACH occurrence resolves its OWN month (and never creates one) —
        // resolving once would file the whole series into the first month and
        // hide every later occurrence from its own month's conflict scan.
        const rosterMonthId = await this.resolveRosterMonthId(tx, orgUserId, dept, startK);
        const row = await tx.qOne<Shift>(
          `INSERT INTO cpo_shifts
             (org_user_id, department, site_label, site_lat, site_lng,
              approved_radius_m, start_at, end_at, created_by, roster_month_id,
              recurrence_group_id)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, 150), $7, $8, $9, $10, $11)
           RETURNING *`,
          [orgUserId, dept, dto.site_label ?? null,
           dto.site_lat ?? null, dto.site_lng ?? null, dto.approved_radius_m ?? null,
           startK, endK, createdBy, rosterMonthId, group],
        );
        if (!row) throw new BadRequestException('shift_create_failed');
        first ??= row;
        if (ids.length > 0) {
          await tx.q(
            `INSERT INTO cpo_shift_assignments (shift_id, cpo_user_id)
               SELECT $1, x FROM unnest($2::uuid[]) AS x
             ON CONFLICT DO NOTHING`,
            [row.id, ids],
          );
        }
        await this.audit.log(orgUserId, createdBy, 'attendance.shift.create', {
          targetKind: 'shift', targetId: row.id,
          metadata: {
            department: dept, site_label: dto.site_label ?? null,
            start_at: startK, end_at: endK, assigned: ids.length,
            ...(group ? {recurrence_group_id: group, occurrence: k + 1, of: windows.length} : {}),
          }, tx,
        });
      }
      return {shift: first as Shift, occurrences: windows.length};
    });
  }

  /**
   * Assign CPOs to a shift. Tenant-isolated: the shift must belong to this org
   * AND every CPO must be an ACTIVE org_members row of this org (mirrors the
   * applyAsOrg cpo_not_active_member_of_org check) — a cross-org id is rejected.
   */
  async assignCpos(
    orgUserId: string, shiftId: string, cpoUserIds: string[], actorUserId?: string,
    // G-ab HIGH-1: this legacy POST shares its path with the scoped PATCH —
    // leaving it unscoped made it the documented escape hatch around the
    // branch predicate shipped next to it.
    managerDepartment?: string | null,
  ): Promise<{assigned: number}> {
    const shift = await this.db.qOne<{id: string}>(
      `SELECT id FROM cpo_shifts
        WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL
          AND ($3::text IS NULL OR department = $3)`,
      [shiftId, orgUserId, managerDepartment ?? null],
    );
    if (!shift) throw new NotFoundException('shift_not_found_in_org');

    const ids = Array.from(new Set(cpoUserIds));
    const active = await this.db.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND status = 'active' AND member_user_id = ANY($2::uuid[])
          AND ($3::text IS NULL OR department = $3)`,
      [orgUserId, ids, managerDepartment ?? null],
    );
    if (active.length !== ids.length) {
      // Same offender-naming as the PATCH sibling: with the branch predicate
      // live, a bare code turns "one out-of-branch pick" into an undiagnosable
      // wall (G-ab NEW-2) — and the client's create flow retries into orphan
      // shifts when it can't tell who was refused.
      const ok = new Set(active.map(r => r.member_user_id));
      throw new BadRequestException({
        message: 'cpo_not_active_member_of_org',
        member_ids: ids.filter(t => !ok.has(t)),
      });
    }

    await this.db.q(
      `INSERT INTO cpo_shift_assignments (shift_id, cpo_user_id)
         SELECT $1, x FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING`,
      [shiftId, ids],
    );
    if (actorUserId) {
      await this.audit.log(orgUserId, actorUserId, 'attendance.shift.assign', {
        targetKind: 'shift', targetId: shiftId, metadata: {count: ids.length},
      });
    }
    return {assigned: ids.length};
  }

  /**
   * G-ab — who is on this shift (edit-mode prefill). Branch-scoped like every
   * manager surface: a scoped manager reads only their own branch's shifts.
   */
  async listAssignments(
    orgUserId: string, shiftId: string, managerDepartment?: string | null,
  ): Promise<Array<{cpo_user_id: string; display_name: string | null}>> {
    const shift = await this.db.qOne<{id: string}>(
      `SELECT id FROM cpo_shifts
        WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL
          AND ($3::text IS NULL OR department = $3)`,
      [shiftId, orgUserId, managerDepartment ?? null],
    );
    if (!shift) throw new NotFoundException('shift_not_found_in_org');
    return this.db.q(
      `SELECT a.cpo_user_id, u.display_name
         FROM cpo_shift_assignments a
         LEFT JOIN users u ON u.id = a.cpo_user_id
        WHERE a.shift_id = $1
        ORDER BY u.display_name NULLS LAST`,
      [shiftId],
    );
  }

  /**
   * G-ab — diff a shift's assignment set. `remove` deliberately skips the
   * active-member check: un-assigning someone already suspended/removed is
   * the whole point (before this endpoint a mis-assignment was PERMANENT —
   * assignCpos is insert-only). Removes are idempotent (0 rows ≠ error).
   *
   * SESSIONS ARE NEVER TOUCHED: a closed session is the immutable record of
   * work that happened; an open one closes through the member's own clockOut;
   * and the rollup joins assignments, so an un-assign BEFORE the ~5-min sweep
   * prevents the auto-absent. An absent the sweep ALREADY wrote is a session
   * row and stays — by design; the remedy is the corrections flow
   * (recordCorrection re-grades any session), never a delete here.
   *
   * Branch scope from DAY ONE (the F HIGH-1/HIGH-A lesson): the shift must
   * sit in a scoped manager's branch, and every ADD target must too. The
   * force rides this argument — never a DTO field.
   */
  async patchAssignments(
    orgUserId: string, shiftId: string,
    diff: {add?: string[]; remove?: string[]; assign_department?: string},
    actorUserId: string, managerDepartment?: string | null,
  ): Promise<{added: number; removed: number}> {
    // Input checks BEFORE any query (an empty PATCH must be a 400, not a 404
    // that leaks shift existence and costs a read).
    const requestedAdd = Array.from(new Set(diff.add ?? []));
    const remove = Array.from(new Set(diff.remove ?? []));
    if (requestedAdd.length === 0 && remove.length === 0 && !diff.assign_department) {
      throw new BadRequestException('assignment_diff_empty');
    }
    // G-c — expansion input, branch-validated, never a scope (see the DTO).
    if (diff.assign_department && managerDepartment != null
        && diff.assign_department !== managerDepartment) {
      throw new ForbiddenException('department_outside_your_branch');
    }
    const removeSet = new Set(remove);
    if (requestedAdd.some(id => removeSet.has(id))) {
      throw new BadRequestException('assignment_diff_overlap');
    }

    // ONE transaction: the two writes and their audit rows commit or roll
    // back together — a failure between them must not leave a half-applied
    // diff whose assign audit has no matching unassign.
    return this.db.withTransaction(async (tx) => {
      const shift = await tx.qOne<{id: string}>(
        `SELECT id FROM cpo_shifts
          WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL
            AND ($3::text IS NULL OR department = $3)`,
        [shiftId, orgUserId, managerDepartment ?? null],
      );
      if (!shift) throw new NotFoundException('shift_not_found_in_org');

      let add = requestedAdd;
      if (diff.assign_department) {
        const expanded = await this.expandDepartmentMembers(tx, orgUserId, diff.assign_department);
        add = Array.from(new Set([...add, ...expanded]));
        // Re-check AFTER expansion: an expanded member colliding with an
        // explicit remove is the same contradictory diff as an explicit one.
        if (add.some(id => removeSet.has(id))) {
          throw new BadRequestException('assignment_diff_overlap');
        }
      }

      let added = 0;
      let removed = 0;
      if (add.length > 0) {
        const active = await tx.q<{member_user_id: string}>(
          `SELECT member_user_id FROM org_members
            WHERE org_user_id = $1 AND status = 'active' AND member_user_id = ANY($2::uuid[])
              AND ($3::text IS NULL OR department = $3)`,
          [orgUserId, add, managerDepartment ?? null],
        );
        if (active.length !== add.length) {
          const ok = new Set(active.map(r => r.member_user_id));
          throw new BadRequestException({
            message: 'cpo_not_active_member_of_org',
            member_ids: add.filter(t => !ok.has(t)),
          });
        }
        const ins = await tx.q<{cpo_user_id: string}>(
          `INSERT INTO cpo_shift_assignments (shift_id, cpo_user_id)
             SELECT $1, x FROM unnest($2::uuid[]) AS x
           ON CONFLICT DO NOTHING
           RETURNING cpo_user_id`,
          [shiftId, add],
        );
        added = ins.length;  // ACTUAL rows, not the requested count
        await this.audit.log(orgUserId, actorUserId, 'attendance.shift.assign', {
          targetKind: 'shift', targetId: shiftId,
          // WHO, not just how many — this row is the compensating record for
          // roster changes; a count alone cannot reconstruct membership.
          metadata: {count: added, member_ids: ins.map(r => r.cpo_user_id)}, tx,
        });
      }
      if (remove.length > 0) {
        const del = await tx.q<{cpo_user_id: string}>(
          `DELETE FROM cpo_shift_assignments
            WHERE shift_id = $1 AND cpo_user_id = ANY($2::uuid[])
            RETURNING cpo_user_id`,
          [shiftId, remove],
        );
        removed = del.length;
        await this.audit.log(orgUserId, actorUserId, 'attendance.shift.unassign', {
          targetKind: 'shift', targetId: shiftId,
          metadata: {count: removed, member_ids: del.map(r => r.cpo_user_id)}, tx,
        });
      }
      return {added, removed};
    });
  }

  /** Manager patches a shift's window/site/geofence. Audited with before/after. */
  async updateShift(
    orgUserId: string, editorUserId: string, shiftId: string,
    dto: {
      department?: string; site_label?: string; site_lat?: number; site_lng?: number;
      approved_radius_m?: number; start_at?: string; end_at?: string;
    },
    // G-ab HIGH-2: unscoped, this route was the laundering hop — a scoped
    // manager could rewrite another branch's shift to their own department,
    // strip its roster through the (now-scoped) assignment routes, and put
    // it back. Scoped managers read only their branch AND cannot move a
    // shift out of it (their department value is forced).
    managerDepartment?: string | null,
  ): Promise<Shift> {
    return this.db.withTransaction(async (tx) => {
      const before = await tx.qOne<Shift>(
        `SELECT * FROM cpo_shifts
          WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL
            AND ($3::text IS NULL OR department = $3) FOR UPDATE`,
        [shiftId, orgUserId, managerDepartment ?? null],
      );
      if (!before) throw new NotFoundException('shift_not_found_in_org');
      const deptWrite = managerDepartment != null
        ? managerDepartment
        : dto.department ?? null;

      // A7.2 — moving a shift to another date or branch moves it to that
      // month's roster. Re-resolved from the EFFECTIVE values (the dto field if
      // present, else what the row already held), because the UPDATE below is
      // COALESCE-based: reading `dto.start_at` alone would unlink every shift
      // edited without a date change.
      const rosterMonthId = await this.resolveRosterMonthId(
        tx, orgUserId,
        deptWrite ?? before.department ?? null,
        dto.start_at ?? before.start_at,
      );

      const row = await tx.qOne<Shift>(
        `UPDATE cpo_shifts
            SET department        = COALESCE($3, department),
                site_label        = COALESCE($4, site_label),
                site_lat          = COALESCE($5, site_lat),
                site_lng          = COALESCE($6, site_lng),
                approved_radius_m = COALESCE($7, approved_radius_m),
                start_at          = COALESCE($8::timestamptz, start_at),
                end_at            = COALESCE($9::timestamptz, end_at),
                -- NOT COALESCE, unlike every other column here.
                --
                -- $10 was re-resolved from the EFFECTIVE values above, so it is
                -- always the correct answer for where this shift now belongs —
                -- INCLUDING null, which means "no longer part of a planned
                -- month". COALESCE would read that null as "keep the old one",
                -- so moving a shift out of a planned August into an unplanned
                -- September would leave it bound to August: polluting August's
                -- conflict check, and making a September shift visible when
                -- August is published.
                roster_month_id   = $10
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        [shiftId, orgUserId, deptWrite, dto.site_label ?? null,
         dto.site_lat ?? null, dto.site_lng ?? null, dto.approved_radius_m ?? null,
         dto.start_at ?? null, dto.end_at ?? null, rosterMonthId],
      );
      if (!row) throw new NotFoundException('shift_not_found_in_org');

      await this.audit.log(orgUserId, editorUserId, 'attendance.shift.update', {
        targetKind: 'shift', targetId: shiftId,
        metadata: {
          before: {start_at: before.start_at, end_at: before.end_at,
            department: before.department, site_label: before.site_label},
          after: dto as Record<string, unknown>,
        },
        tx,
      });
      return row;
    });
  }

  /** Manager archives (soft-deletes) a shift. Assigned CPOs simply lose the
   *  "today's shift" (myTodayShift/listOrgShifts already filter archived). */
  async archiveShift(
    orgUserId: string, editorUserId: string, shiftId: string,
    managerDepartment?: string | null,
  ): Promise<Shift> {
    const row = await this.db.qOne<Shift>(
      `UPDATE cpo_shifts SET archived_at = COALESCE(archived_at, NOW())
        WHERE id = $1 AND org_user_id = $2
          AND ($3::text IS NULL OR department = $3)
        RETURNING *`,
      [shiftId, orgUserId, managerDepartment ?? null],
    );
    if (!row) throw new NotFoundException('shift_not_found_in_org');
    await this.audit.log(orgUserId, editorUserId, 'attendance.shift.archive', {
      targetKind: 'shift', targetId: shiftId,
    });
    return row;
  }

  /** Org's active (non-archived) shifts with an assigned-CPO count, newest
   *  first. Branch-scoped for delegated managers — the unscoped list was the
   *  enumeration step of the G-ab HIGH-2 two-hop, and a shift a scoped
   *  manager cannot manage must never be offered for edit. NULL-department
   *  shifts are the ORG's to manage (scoped managers never see them; their
   *  own creates are department-forced so they cannot mint one). */
  async listOrgShifts(
    orgUserId: string, opts?: {limit?: number}, managerDepartment?: string | null,
  ): Promise<Array<Shift & {assigned_count: number}>> {
    return this.db.q<Shift & {assigned_count: number}>(
      `SELECT s.*, COUNT(a.cpo_user_id)::int AS assigned_count
         FROM cpo_shifts s
         LEFT JOIN cpo_shift_assignments a ON a.shift_id = s.id
        WHERE s.org_user_id = $1 AND s.archived_at IS NULL
          AND ($3::text IS NULL OR s.department = $3)
        GROUP BY s.id
        ORDER BY s.start_at DESC
        LIMIT $2`,
      [orgUserId, Math.min(opts?.limit ?? 100, 500), managerDepartment ?? null],
    );
  }

  /**
   * The CPO's shift for "now": the assignment whose window currently covers now,
   * else the soonest one starting today. Returns null when none — the UI shows
   * the "No active shift assigned" block state and check-in is disabled.
   */
  /**
   * @param orgUserId when given, ONLY that organisation's shifts count.
   *
   * vs2 item 4 — the org and the shift must agree. `clockIn` resolves the org
   * from the header now, and this stayed blind, so the two could name different
   * companies: Chidi standing in Acme, whose only assignment today is
   * Meridian's, wrote a session with org_user_id = acme and
   * shift_id = a Meridian shift. The check-in was then graded against
   * MERIDIAN'S geofence and window, Acme's manager queue showed a session
   * carrying another company's site and coordinates (and could approve it),
   * Meridian saw a no-show — and because the open-session unique index is on
   * cpo_user_id alone, he was locked out of checking in at Meridian for real.
   *
   * Left optional so the standalone GET /attendance/my-shift/today keeps its
   * existing cross-org answer; only the write is narrowed.
   */
  async myTodayShift(cpoUserId: string, orgUserId?: string): Promise<Shift | null> {
    return this.db.qOne<Shift>(
      // org_name so the CLOCK-OUT can say which shift it is ending. The
      // one-open-session index is on the PERSON, not the org, so from inside
      // Acme the button can legitimately close a Meridian shift — correct (one
      // body, one shift) but unreadable unless it is named.
      `SELECT s.*, ${orgNameExpr()} AS org_name
         FROM cpo_shift_assignments a
         JOIN cpo_shifts s ON s.id = a.shift_id AND s.archived_at IS NULL
         ${orgNameJoin('s.org_user_id')}
         -- Scope v2 A7.2 — a DRAFT month is invisible to the team, and an
         -- ARCHIVED one is withdrawn. Shifts with NO roster month are the
         -- pre-v2 day-by-day ones and stay visible exactly as before, which is
         -- why this is a LEFT JOIN with a NULL-permitting predicate rather than
         -- an inner join (that would hide every legacy shift).
         LEFT JOIN public.cpo_roster_months rm ON rm.id = s.roster_month_id
        WHERE a.cpo_user_id = $1
          AND ($2::uuid IS NULL OR s.org_user_id = $2::uuid)
          AND (rm.id IS NULL OR rm.status IN ('published', 'amended'))
          AND s.end_at >= NOW()
          -- D6-d — bound by a forward lead window relative to NOW (tz-independent) instead of
          -- date_trunc('day', NOW()), which evaluated "today" in the server's UTC tz and
          -- mis-gated check-in at the day boundary for non-UTC orgs. A shift is checkable
          -- while it's active OR starts within the next 12h.
          AND s.start_at <= NOW() + INTERVAL '12 hours'
        ORDER BY (s.start_at <= NOW() AND s.end_at >= NOW()) DESC, s.start_at ASC
        LIMIT 1`,
      [cpoUserId, orgUserId ?? null],
    );
  }

  // ─── Dept Chat v2 · review workflow (Step 6) ──────────────────────────

  /**
   * Manager clears a Pending Review record. Approve derives the final status
   * (present/late) from the shift window and vouches the check-in; reject leaves
   * it flagged. Only the review columns + derived status change — the captured
   * geotag/time stay IMMUTABLE (PDF p.7,9). Audited either way.
   */
  async reviewSession(
    orgUserId: string, editorUserId: string, sessionId: string,
    decision: 'approve' | 'reject', notes?: string,
    department: string | null = null,
  ): Promise<ShiftSession> {
    return this.db.withTransaction(async (tx) => {
      // AUTHZ-3 — branch-scoped gate (see editShift): a department manager may only
      // review sessions in their own branch. Locked SELECT is the gate.
      const row = await tx.qOne<ShiftSession>(
        `SELECT ses.* FROM cpo_shift_sessions ses
           LEFT JOIN cpo_shifts sh  ON sh.id = ses.shift_id
           LEFT JOIN org_members om ON om.org_user_id = ses.org_user_id AND om.member_user_id = ses.cpo_user_id
          WHERE ses.id = $1 AND ses.org_user_id = $2
            AND ($3::text IS NULL OR COALESCE(sh.department, om.department) = $3)
          FOR UPDATE OF ses`,
        [sessionId, orgUserId, department],
      );
      if (!row) throw new NotFoundException('session_not_found_in_org');
      if (row.review_status !== 'pending') throw new BadRequestException('not_pending_review');
      // The EFFECTIVE clock-in, read AFTER the lock is held, as its own
      // statement: the queue the manager just looked at shows the FOLDED
      // clock-in, so the late/present derivation below must grade the same
      // value (C2 review HIGH-2). A fold riding the locked SELECT itself read
      // the PRE-WAIT snapshot — a clock-only correction committing while we
      // blocked on recordCorrection's FOR UPDATE was invisible (and
      // isUnderCorrection tests STATUS keys only, so it did not withhold).
      // A fresh READ COMMITTED statement after the lock sees it.
      const eff = await tx.qOne<{v: string | null}>(
        `SELECT ${AttendanceService.effectiveField('clock_in_at')} AS v
           FROM cpo_shift_sessions ses WHERE ses.id = $1`,
        [sessionId],
      );
      // Approving DERIVES a new attendance_status, so it is a third writer to a
      // field the correction chain may already own.
      // NOT a refusal here — that created a dead end.
      //
      // A member can DISPUTE a corrected session, which sets review_status to
      // 'pending'. If the manager's review then threw, the record sat in the
      // pending queue with NO way out: refuse-over-reconcile had turned a member
      // action into an unclearable support ticket.
      //
      // attendance_status is the ONLY correctable field this method writes, so
      // the review can always be recorded — it just must not overwrite a field
      // the correction chain owns. Clear the queue, leave the value alone.
      const underCorrection = await this.isUnderCorrection(
        tx, orgUserId, [sessionId], AttendanceService.STATUS);

      // On approve, vouch presence and derive present/late from the shift
      // window — against the EFFECTIVE clock-in (what the queue displayed).
      const gradedClockIn = eff?.v ?? row.clock_in_at;
      let finalStatus: AttendanceStatus = row.attendance_status ?? 'pending_review';
      if (decision === 'approve') {
        finalStatus = 'present';
        if (row.shift_id && gradedClockIn) {
          const shift = await tx.qOne<{start_at: string}>(
            `SELECT start_at FROM cpo_shifts WHERE id = $1`, [row.shift_id],
          );
          if (shift) {
            const lateThreshold = new Date(shift.start_at).getTime() + GRACE_MS;
            finalStatus = new Date(gradedClockIn).getTime() > lateThreshold ? 'late' : 'present';
          }
        }
      }

      const reviewStatus: ReviewStatus = decision === 'approve' ? 'approved' : 'rejected';
      // RETURNING * is RAW (unfolded) — safe only because every client
      // reloads after a write path returns (AdminAttendance/MyAttendance both
      // do). A future client trusting this body directly would show
      // uncorrected values; fold at the read it reloads through instead.
      const updated = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET review_status = $3,
                -- $7 true = this session is under correction, so the chain owns
                -- attendance_status and the review must not touch it. Every
                -- other column here is review-only and always safe to write.
                attendance_status = CASE WHEN $7 THEN attendance_status ELSE $4 END,
                reviewed_by = $5, reviewed_at = NOW(), admin_notes = $6
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        // D6-b — reject drives attendance_status to a TERMINAL 'absent' (the manager did not
        // vouch the check-in), so it leaves the pending_review bucket in reporting; approve
        // writes the derived present/late.
        [sessionId, orgUserId, reviewStatus,
         decision === 'approve' ? finalStatus : 'absent',
         editorUserId, notes ?? null, underCorrection],
      );
      await this.audit.log(orgUserId, editorUserId, `attendance.review.${decision}`, {
        targetKind: 'shift_session', targetId: sessionId,
        // Record that the derived status was WITHHELD, or a reviewer reading
        // the log later cannot tell why the status did not move.
        metadata: {decision, attendance_status_withheld: underCorrection}, tx,
      });
      if (!updated) throw new BadRequestException('review_failed');
      return updated;
    });
  }

  /**
   * A7.3 — Manager sets a non-check-in day status by writing marker session
   * rows. Targets: one member (legacy), an explicit member_ids[] batch, or a
   * whole department (server-expanded to its ACTIVE NON-MANAGER members —
   * "team" in the PDF maps to `org_members.department`; no team entity
   * exists). Dates: one day (legacy) or an explicit dates[] list (the client
   * expands ranges). ALL-OR-NOTHING on the under-correction guard: a
   * half-applied batch would strand markers mid-replace, exactly the failure
   * the A7.4 guard exists to prevent.
   */
  async setDayStatus(
    orgUserId: string, editorUserId: string,
    dto: {cpoUserId?: string; memberIds?: string[]; department?: string;
          status: 'leave' | 'sick_leave' | 'emergency_leave' | 'off_duty' | 'absent' | 'mission';
          date?: string; dates?: string[]; notes?: string},
    // The manager's FORCED branch (OrgManagerGuard context). Non-null = every
    // target must belong to it; the controller also forces the department
    // MODE's value to it. HIGH-1: without this, a branch-scoped manager
    // could mark another branch absent org-wide.
    managerDepartment?: string | null,
  ): Promise<ShiftSession | {ok: true; members: number; dates: number}> {
    // Exactly one targeting mode per call. `!= null` on purpose:
    // class-validator's @IsOptional skips null too, so a present-and-null
    // key must not count as a second mode (F review LOW-8).
    const modes = [dto.cpoUserId, dto.memberIds, dto.department].filter(m => m != null).length;
    if (modes !== 1) {throw new BadRequestException('day_status_one_targeting_mode');}
    const legacySingle = !!dto.cpoUserId && !dto.dates;

    let targets: string[];
    if (dto.department != null) {
      // Same expansion shape as activeOrgMembers (department.service) +
      // the client picker's non-manager filter. The controller has already
      // forced a scoped manager's value here.
      const rows = await this.db.q<{member_user_id: string}>(
        `SELECT member_user_id FROM org_members
          WHERE org_user_id = $1 AND status = 'active'
            AND department = $2 AND member_role <> 'manager'`,
        [orgUserId, dto.department],
      );
      targets = rows.map(r => r.member_user_id);
      if (targets.length === 0) {throw new BadRequestException('no_active_members_in_department');}
    } else {
      targets = [...new Set(dto.memberIds ?? [dto.cpoUserId as string])];
      // Validate ALL targets in one query (the assignCpos pattern). The org
      // account itself is a legal self-target (legacy) and has no org_members
      // row, so it is excluded from the count check — EXCEPT for a
      // branch-scoped manager, who may never target the org account and
      // whose targets must all sit in their branch.
      const external = managerDepartment != null
        ? targets
        : targets.filter(t => t !== orgUserId);
      if (external.length > 0) {
        const rows = await this.db.q<{member_user_id: string}>(
          `SELECT member_user_id FROM org_members
            WHERE org_user_id = $1 AND member_user_id = ANY($2::uuid[]) AND status = 'active'
              AND ($3::text IS NULL OR department = $3)`,
          [orgUserId, external, managerDepartment ?? null],
        );
        if (rows.length !== external.length) {
          // Name the offenders (F review LOW-10) — a member suspended between
          // roster load and Save must not fail 99 others anonymously.
          const okIds = new Set(rows.map(r => r.member_user_id));
          const missing = external.filter(t => !okIds.has(t));
          throw new BadRequestException({message: 'cpo_not_active_member_of_org', member_ids: missing});
        }
      }
    }

    const dates = [...new Set(dto.dates ?? [dto.date ?? new Date().toISOString()])];
    if (targets.length * dates.length > 500) {
      throw new BadRequestException('day_status_batch_too_large');
    }
    // Bare YYYY-MM-DD stamps store as NOON UTC, not midnight: a midnight-UTC
    // marker renders one day early for any negative-UTC member (their local
    // toLocaleDateString crosses the boundary), and the day-status push walks
    // them straight to the wrong row (F review MEDIUM-7). Noon holds the
    // calendar day for UTC-11..UTC+11; the +12..+14 residual (NZ/Fiji/Samoa/
    // Kiritimati) still shifts, so render-side `timeZone: 'UTC'` remains the
    // airtight follow-up for those markets. Full-ISO legacy stamps pass
    // through untouched; the ::date day-bucket casts agree for every shipped
    // client (both send bare days or trailing-Z ISO; a non-UTC-offset ISO
    // would split the buckets but no client can produce one).
    const stamps = dates.map(d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);

    const result = await this.db.withTransaction(async (tx) => {
      // D6-f — one day-status marker per CPO per day. Remove any prior marker
      // for these dates first so re-marking REPLACES instead of stacking (no
      // per-day unique index exists; this is the upsert). The DELETE would
      // strand a corrected marker's trail — refuse the WHOLE batch first,
      // BEFORE any delete, naming the offending pairs so the manager can
      // carve them out.
      // FOR UPDATE (F review LOW-12): without the lock, a recordCorrection
      // committing between this guard and the DELETE below still gets its
      // subject deleted (an orphaned append-only trail — the exact thing the
      // guard exists to stop). NOTE what this does NOT close: two concurrent
      // batches with NO prior marker both insert (row locks lock existing
      // rows; READ COMMITTED has no predicate locks), so the D6-f one-marker
      // rule still needs a partial unique index to be airtight — logged in
      // the blueprint; the index predicate would be an Nth copy of the
      // marker-status list, so it rides the next status change.
      const priorMarkers = await tx.q<{id: string; cpo_user_id: string; day: string}>(
        `SELECT id, cpo_user_id, clock_in_at::date::text AS day
           FROM cpo_shift_sessions
          WHERE org_user_id = $1 AND cpo_user_id = ANY($2::uuid[])
            AND shift_id IS NULL
            AND attendance_status IN ('leave','sick_leave','emergency_leave','off_duty','absent','mission')
            AND clock_in_at::date = ANY($3::date[])
          FOR UPDATE`,
        [orgUserId, targets, dates],
      );
      if (priorMarkers.length > 0 && await this.isUnderCorrection(
        tx, orgUserId, priorMarkers.map(r => r.id),
        [...AttendanceService.CLOCK, ...AttendanceService.STATUS],
      )) {
        const blocked = await tx.q<{session_id: string}>(
          `SELECT DISTINCT session_id FROM attendance_corrections
            WHERE org_user_id = $1 AND session_id = ANY($2::uuid[])`,
          [orgUserId, priorMarkers.map(r => r.id)],
        );
        const ids = new Set(blocked.map(b => b.session_id));
        const pairs = priorMarkers.filter(m => ids.has(m.id))
          .map(m => ({member: m.cpo_user_id, date: m.day}));
        // `message` keyed so the client's standard errMsg plumbing renders it;
        // `pairs` names the (member, date) markers the manager must carve
        // out. statusCode/error keep the body shape consistent with every
        // other error on this controller (a bare object body replaces
        // Nest's default envelope entirely).
        throw new ConflictException({
          statusCode: 409, error: 'Conflict',
          message: 'session_under_correction', pairs,
        });
      }

      await tx.q(
        `DELETE FROM cpo_shift_sessions
          WHERE org_user_id = $1 AND cpo_user_id = ANY($2::uuid[])
            AND shift_id IS NULL
            AND attendance_status IN ('leave','sick_leave','emergency_leave','off_duty','absent','mission')
            AND clock_in_at::date = ANY($3::date[])`,
        [orgUserId, targets, dates],
      );
      const rows = await tx.q<ShiftSession>(
        `INSERT INTO cpo_shift_sessions
           (org_user_id, cpo_user_id, status, clock_in_at, clock_out_at,
            attendance_status, review_status, reviewed_by, reviewed_at, admin_notes)
         SELECT $1, m, 'closed', d::timestamptz, d::timestamptz, $4, 'approved', $5, NOW(), $6
           FROM unnest($2::uuid[]) AS m CROSS JOIN unnest($3::text[]) AS d
         RETURNING *`,
        [orgUserId, targets, stamps, dto.status, editorUserId, dto.notes ?? null],
      );
      if (rows.length !== targets.length * dates.length) {
        throw new BadRequestException('day_status_failed');
      }
      // One audit row PER MEMBER (bounded by the 100-target DTO cap), in-tx.
      for (const t of targets) {
        await this.audit.log(orgUserId, editorUserId, 'attendance.day_status', {
          targetKind: 'user', targetId: t,
          metadata: {status: dto.status, date_count: dates.length}, tx,
        });
      }
      return rows;
    });

    // Post-commit: the member learns their duty status changed (PDF A7.3
    // "notify the affected Member"). Metadata-only kind — the value is read
    // in My Attendance. Once per member, not per date; PARALLEL so 100
    // members do not add 100 sequential round-trips to the response
    // (F review LOW-11 — record() swallows its own errors by contract).
    // vs2 edge A1/A2 — the ONLY `record()` caller outside the push bridge, so
    // it has to thread the org itself. Without it the bell row cannot say which
    // organisation set the status, and the tap lands on `openAttendance` under
    // whatever context was sticky — which for a recipient who is ALSO a manager
    // means AdminAttendance reading the wrong org's roster (that surface is
    // header-scoped).
    await Promise.all(targets.filter(t => t !== orgUserId).map(t =>
      this.notifications.record(t, {
        eventClass: 'enterprise', kind: 'enterprise.day_status', orgUserId,
      })));

    return legacySingle
      ? result[0]  // byte-compatible with the pre-batch single-row response
      : {ok: true, members: targets.length, dates: dates.length};
  }

  // ─── Dept Chat v2 · member dispute route (PDF p.8) ─────────────────────

  /**
   * A CPO disputes their OWN record — flags it back into the manager Pending
   * Review queue with reason 'disputed' + a short note. The captured data and
   * the manager's prior review columns stay intact except review_status/reason;
   * the manager clears it via the normal reviewSession flow.
   */
  async disputeSession(cpoUserId: string, sessionId: string, note: string): Promise<ShiftSession> {
    return this.db.withTransaction(async (tx) => {
      const row = await tx.qOne<ShiftSession>(
        `SELECT * FROM cpo_shift_sessions
          WHERE id = $1 AND cpo_user_id = $2 FOR UPDATE`,
        [sessionId, cpoUserId],
      );
      if (!row) throw new NotFoundException('session_not_found');
      if (row.review_status === 'pending') throw new BadRequestException('already_pending_review');
      if (row.status === 'open') throw new BadRequestException('shift_still_open');

      const updated = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET review_status = 'pending', review_reason = 'disputed',
                dispute_note = $2
          WHERE id = $1 RETURNING *`,
        [sessionId, note.slice(0, 500)],
      );
      if (!updated) throw new BadRequestException('dispute_failed');
      await this.audit.log(row.org_user_id, cpoUserId, 'attendance.dispute', {
        targetKind: 'shift_session', targetId: sessionId, tx,
      });
      return updated;
    });
  }

  // ─── Dept Chat v2 · admin view + export (Step 7) ──────────────────────

  /** Present/Late/Absent… counts + pending-review count for the org in a range.
   *  department/shiftId filter via the session's shift (PDF p.9). */
  async orgSummary(
    orgUserId: string,
    filters?: {from?: string; to?: string; cpoUserId?: string; department?: string; shiftId?: string},
  ): Promise<{counts: Record<string, number>; total: number; pendingReview: number}> {
    // GROUP BY 1 = the FOLDED status: a corrected 'absent → present' must move
    // between count buckets, which no post-hoc service fold can do without
    // re-implementing this query in JS.
    const rows = await this.db.q<{attendance_status: string | null; n: string}>(
      `SELECT ${AttendanceService.effectiveField('attendance_status')} AS attendance_status,
              COUNT(*)::text AS n
         FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1
          AND ($2::timestamptz IS NULL OR ses.clock_in_at >= $2)
          AND ($3::timestamptz IS NULL OR ses.clock_in_at <= $3)
          AND ($4::uuid IS NULL OR ses.cpo_user_id = $4)
          AND ($5::text IS NULL OR sh.department = $5)
          AND ($6::uuid IS NULL OR ses.shift_id = $6)
        GROUP BY 1`,
      [orgUserId, filters?.from ?? null, filters?.to ?? null, filters?.cpoUserId ?? null,
       filters?.department ?? null, filters?.shiftId ?? null],
    );
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const key = r.attendance_status ?? 'unspecified';
      counts[key] = Number(r.n);
      total += Number(r.n);
    }
    const pending = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n
         FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1 AND ses.review_status = 'pending'
          AND ($2::text IS NULL OR sh.department = $2)`,
      [orgUserId, filters?.department ?? null],
    );
    return {counts, total, pendingReview: Number(pending?.n ?? 0)};
  }

  /** The Pending Review queue (flagged rows + their reason), newest first. */
  async pendingQueue(orgUserId: string, filters?: {department?: string}): Promise<ShiftSession[]> {
    return this.db.q<ShiftSession>(
      `SELECT ses.*,
              ${AttendanceService.effectiveField('attendance_status')} AS attendance_status,
              ${AttendanceService.effectiveField('clock_in_at')} AS clock_in_at,
              ${AttendanceService.effectiveField('clock_out_at')} AS clock_out_at
         FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1 AND ses.review_status = 'pending'
          AND ($2::text IS NULL OR sh.department = $2)
        ORDER BY ses.clock_in_at DESC LIMIT 200`,
      [orgUserId, filters?.department ?? null],
    );
  }

  /**
   * Controlled CSV export (PDF is rendered client-side on the ops-console). 🛑
   * Columns exclude any biometric data — only the face_verified RESULT boolean +
   * radius result are exported, never face_meta. Writes an audit row BEFORE
   * returning (action='attendance.export'); metadata carries no PII.
   */
  async exportSessions(
    orgUserId: string, editorUserId: string,
    filters?: {from?: string; to?: string; cpoUserId?: string; department?: string; shiftId?: string},
  ): Promise<{filename: string; contentType: string; body: string}> {
    const rows = await this.db.q<{
      cpo_user_id: string; display_name: string | null; department: string | null;
      site_label: string | null; clock_in_at: string; clock_out_at: string | null;
      attendance_status: string | null; face_verified: boolean | null;
      within_radius: boolean | null; admin_notes: string | null;
    }>(
      `SELECT ses.cpo_user_id, u.display_name, sh.department, sh.site_label,
              ${AttendanceService.effectiveField('clock_in_at')} AS clock_in_at,
              ${AttendanceService.effectiveField('clock_out_at')} AS clock_out_at,
              ${AttendanceService.effectiveField('attendance_status')} AS attendance_status,
              ses.face_verified, ses.within_radius, ses.admin_notes
         FROM cpo_shift_sessions ses
         LEFT JOIN users u ON u.id = ses.cpo_user_id
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1
          AND ($2::timestamptz IS NULL OR ses.clock_in_at >= $2)
          AND ($3::timestamptz IS NULL OR ses.clock_in_at <= $3)
          AND ($4::uuid IS NULL OR ses.cpo_user_id = $4)
          AND ($5::text IS NULL OR sh.department = $5)
          AND ($6::uuid IS NULL OR ses.shift_id = $6)
        ORDER BY ses.clock_in_at DESC
        LIMIT 5000`,
      [orgUserId, filters?.from ?? null, filters?.to ?? null, filters?.cpoUserId ?? null,
       filters?.department ?? null, filters?.shiftId ?? null],
    );

    const header = ['Member', 'Member ID', 'Department', 'Site', 'Check-in', 'Check-out',
      'Status', 'Face verified', 'In radius', 'Admin notes'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.display_name ?? '', r.cpo_user_id, r.department ?? '', r.site_label ?? '',
        r.clock_in_at ?? '', r.clock_out_at ?? '', r.attendance_status ?? '',
        r.face_verified === null ? '' : r.face_verified ? 'yes' : 'no',
        r.within_radius === null ? '' : r.within_radius ? 'yes' : 'no',
        r.admin_notes ?? '',
      ].map(csvCell).join(','));
    }

    await this.audit.log(orgUserId, editorUserId, 'attendance.export', {
      metadata: {
        from: filters?.from ?? null, to: filters?.to ?? null,
        cpo_user_id: filters?.cpoUserId ?? null, department: filters?.department ?? null,
        shift_id: filters?.shiftId ?? null, format: 'csv', count: rows.length,
      },
    });

    return {
      filename: `attendance-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: lines.join('\r\n'),
    };
  }
}

/** CSV-escape a single cell (quote-wrap; double embedded quotes). */
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}
