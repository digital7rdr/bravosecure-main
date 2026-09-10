import {BadRequestException, ConflictException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {CORRECTABLE_STATUSES} from './dto/roster.dto';

/**
 * Scope v2 Phase 5 — Monthly Roster (A7.2) and Attendance Corrections (A7.4).
 *
 * ── TWO SOURCES, TWO QUESTIONS (the Phase 4 lesson, applied up front) ────────
 *
 * Phase 4 twice shipped a bug by answering one question with the other's data
 * source. The equivalent pair here is:
 *
 *   "what may a MANAGER see and edit?"  → every month, whatever its status.
 *   "what may a MEMBER see?"            → published/amended months only.
 *
 * Those are different questions, so they are different queries — and the member
 * one is scoped STRUCTURALLY: it joins through `cpo_roster_months` and requires
 * a published state, so a draft has no path into the result at all. There is no
 * filter for a future reader to forget.
 *
 * ── DRAFT IS NOT EMPTY ───────────────────────────────────────────────────────
 *
 * A draft month and a month nobody has touched are the same thing to a member
 * (nothing) and must be *different* things to a manager, or the founder-visible
 * symptom is "I published it and nothing happened". `ensureMonth` (POST-only)
 * therefore always returns a row — created on demand as a draft — so the
 * calendar can render "DRAFT · not visible to your team" instead of an empty
 * grid. `readMonth` (the GET) creates nothing and may return null.
 */
@Injectable()
export class RosterService {
  private readonly log = new Logger(RosterService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
  ) {}

  /** Normalise any date in a month to that month's first day, in UTC. */
  private monthKey(input: string): string {
    const d = new Date(`${input.slice(0, 7)}-01T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {throw new BadRequestException('invalid_month');}
    return d.toISOString().slice(0, 10);
  }

  /**
   * A7.2 — READ the manager's month, creating nothing. `GET /roster/month`
   * must be a safe verb: with create-on-read, a retry, a prefetch, or a
   * crawler minted a real draft month — and a draft month HIDES every shift
   * in it from `myTodayShift`, blocking member check-in (the documented
   * pre-flag-flip blocker). Returns null when the month was never opened;
   * the client renders "not planned yet" and calls `POST month/ensure` when
   * the manager actually opens the planner.
   */
  async readMonth(
    orgUserId: string, month: string, department?: string | null,
  ): Promise<RosterMonth | null> {
    const key = this.monthKey(month);
    return await this.db.qOne<RosterMonth>(
      `SELECT id, month::text, status, published_at, amended_at, archived_at, department
         FROM public.cpo_roster_months
        WHERE org_user_id = $1 AND month = $2::date
          AND COALESCE(department, '') = COALESCE($3::text, '')`,
      [orgUserId, key, department ?? null],
    );
  }

  /**
   * A7.2 — the manager's month, created as a DRAFT when absent so the
   * calendar has a state to show; creating it is not publishing it. WRITES —
   * reached only from POST verbs (`month/ensure`, publish, archive): opening
   * the planner IS the act of choosing to plan that month.
   */
  async ensureMonth(
    orgUserId: string, actorUserId: string, month: string, department?: string | null,
  ): Promise<RosterMonth> {
    const key = this.monthKey(month);
    const existing = await this.db.qOne<RosterMonth>(
      `SELECT id, month::text, status, published_at, amended_at, archived_at, department
         FROM public.cpo_roster_months
        WHERE org_user_id = $1 AND month = $2::date
          AND COALESCE(department, '') = COALESCE($3::text, '')`,
      [orgUserId, key, department ?? null],
    );
    if (existing) {return existing;}

    const created = await this.db.qOne<RosterMonth>(
      `INSERT INTO public.cpo_roster_months (org_user_id, department, month, created_by)
       VALUES ($1, $2, $3::date, $4)
       -- Two managers opening the same month at once is ordinary, not an error.
       ON CONFLICT (org_user_id, COALESCE(department, ''), month) DO NOTHING
       RETURNING id, month::text, status, published_at, amended_at, archived_at, department`,
      [orgUserId, department ?? null, key, actorUserId],
    );
    if (created) {return created;}
    // Lost the race — read the winner's row.
    const raced = await this.db.qOne<RosterMonth>(
      `SELECT id, month::text, status, published_at, amended_at, archived_at, department
         FROM public.cpo_roster_months
        WHERE org_user_id = $1 AND month = $2::date
          AND COALESCE(department, '') = COALESCE($3::text, '')`,
      [orgUserId, key, department ?? null],
    );
    if (!raced) {throw new BadRequestException('roster_month_unavailable');}
    return raced;
  }

  /**
   * A7.2 — "conflict flagging before publish".
   *
   * A conflict is one CPO assigned to two OVERLAPPING shifts. Detected with an
   * interval overlap (`a.start < b.end AND b.start < a.end`), which is the only
   * form that catches partial overlap; comparing dates or start times alone
   * misses a 22:00–06:00 shift running into the next morning's.
   *
   * Archived shifts are excluded — they are not part of the plan.
   */
  async findConflicts(
    orgUserId: string, rosterMonthId: string, department?: string | null,
  ): Promise<RosterConflict[]> {
    // TENANCY. `rosterMonthId` arrives from the URL, so org-scoping the SHIFTS
    // is not enough on its own — a branch-scoped manager could pass a sibling
    // branch's month id and read that branch's roster. Every other read in this
    // phase is branch-scoped; this one was not.
    const owned = await this.db.qOne<{id: string; month: string; department: string | null}>(
      `SELECT id, month::text, department FROM public.cpo_roster_months
        WHERE id = $1 AND org_user_id = $2
          AND ($3::text IS NULL OR COALESCE(department, '') = $3)`,
      [rosterMonthId, orgUserId, department ?? null],
    );
    if (!owned) {throw new NotFoundException('roster_month_not_found');}

    return this.db.q<RosterConflict>(
      `SELECT a.cpo_user_id,
              u.display_name        AS cpo_name,
              a.shift_id            AS shift_a,
              b.shift_id            AS shift_b,
              sa.start_at::text     AS start_a,
              sa.end_at::text       AS end_a,
              sb.start_at::text     AS start_b,
              sb.end_at::text       AS end_b
         FROM public.cpo_shift_assignments a
         JOIN public.cpo_shifts sa ON sa.id = a.shift_id
         JOIN public.cpo_shift_assignments b ON b.cpo_user_id = a.cpo_user_id
         JOIN public.cpo_shifts sb ON sb.id = b.shift_id
         JOIN public.users u ON u.id = a.cpo_user_id
        WHERE sa.org_user_id = $1
          AND sb.org_user_id = $1
          AND sa.archived_at IS NULL
          AND sb.archived_at IS NULL
          -- SCOPED BY TIME, NOT BY LINK.
          --
          -- Keying this on roster_month_id made the check defeatable by write
          -- ORDER: a shift created before the month row existed is unlinked
          -- forever (nothing backfills it), and "shifts already exist, THEN the
          -- manager opens the planner" is the normal sequence for every org
          -- that is already running. The check would have reported a confident
          -- zero over a calendar full of double-bookings — the same empty box
          -- the link was added to fix.
          --
          -- A calendar month is a time range, so ask the question in time. This
          -- cannot be defeated by ordering, needs no backfill, and works on day
          -- one. EITHER side need only touch the month, which is what catches
          -- the overnight shift that straddles the boundary.
          --
          -- TIMEZONE CAVEAT, deliberate and bounded: date + INTERVAL yields a
          -- TIMESTAMP, compared here against TIMESTAMPTZ, so the boundary is
          -- resolved in the DB session's TimeZone. That is correct only while
          -- that is UTC — which it is, and which matches resolveRosterMonthId
          -- computing the month key in UTC. There is no per-org timezone in the
          -- schema yet; when one lands, this comparison and monthKey must move
          -- together or a shift will file into one month and display in another.
          AND (   (sa.start_at < ($2::date + INTERVAL '1 month') AND sa.end_at > $2::date)
               OR (sb.start_at < ($2::date + INTERVAL '1 month') AND sb.end_at > $2::date))
          -- Branch scope on BOTH sides. Without it an 'Ops' manager reads the
          -- Logistics branch's names, shift ids and windows through their own
          -- month. A cross-branch double-booking is real, but surfacing it is a
          -- deliberate product decision, not a side effect of a missing filter.
          --
          -- NULL FOLDS TO '', it does not mean "any". The unique index
          -- (cpo_roster_months_unique) and resolveRosterMonthId both treat a
          -- null department as the bucket '' — a real, distinct scope — so
          -- treating it as a wildcard HERE would have made one column mean two
          -- different things in the same feature. It would also have coupled
          -- the org-wide month's publish to conflicts inside branch rosters its
          -- manager is not planning, escapable only via the force flag, which would
          -- then record someone else's decision in the org-wide audit.
          AND COALESCE(sa.department, '') = COALESCE($3::text, '')
          AND COALESCE(sb.department, '') = COALESCE($3::text, '')
          -- Ordered so each clashing PAIR is reported once, not twice.
          AND a.shift_id < b.shift_id
          -- Interval overlap. Touching ends (one ends exactly when the next
          -- begins) is a legal back-to-back shift, not a conflict.
          AND sa.start_at < sb.end_at
          AND sb.start_at < sa.end_at
        ORDER BY u.display_name, sa.start_at`,
      // The MONTH'S OWN branch, never the caller's. The ownership check above
      // already forces the two to agree — a branch-scoped manager cannot reach
      // a month with a different department — so a `?? department` fallback
      // here would be dead code that reads like a widening path.
      [orgUserId, owned.month, owned.department ?? null],
    );
  }

  /**
   * A7.2 — publish, or AMEND an already-published month.
   *
   * Publishing is what makes a month visible to the team, so it is the only
   * place the conflict check can be mandatory. `force` exists because a real
   * roster sometimes has a deliberate double-booking, but it is recorded in the
   * audit rather than silently permitted.
   */
  async publishMonth(
    orgUserId: string, actorUserId: string, month: string,
    opts: {department?: string | null; force?: boolean} = {},
  ): Promise<PublishResult> {
    // REQUIRES an opened month — never creates one (edge-case review,
    // 2026-08-07). With create-on-publish, a conflict-failed publish left
    // behind a draft it silently minted (and every later shift in that
    // month+branch linked to it, hidden from its CPO); and publishing a
    // never-planned month governs nothing anyway — pre-existing shifts are
    // unlinked and stay visible regardless. "Open the planner" (POST
    // month/ensure) is the only act that creates the row.
    const row = await this.readMonth(orgUserId, month, opts.department);
    if (!row) {throw new NotFoundException('roster_month_not_planned');}
    if (row.status === 'archived') {throw new ConflictException('roster_month_archived');}

    const conflicts = await this.findConflicts(orgUserId, row.id, opts.department);
    if (conflicts.length > 0 && !opts.force) {
      // NOT an error state — it is the check doing its job, so it returns the
      // conflicts for the UI to show rather than throwing an opaque 400.
      return {ok: false, reason: 'conflicts', conflicts, status: row.status};
    }

    // AMENDED, not published-again, when it was already live: a CPO who read
    // last week's plan needs to know it changed. First publish sets
    // published_at; an amendment preserves it and stamps amended_at.
    const alreadyLive = row.status === 'published' || row.status === 'amended';
    const nextStatus = alreadyLive ? 'amended' : 'published';

    const updated = await this.db.qOne<RosterMonth>(
      `UPDATE public.cpo_roster_months
          SET status       = $3,
              published_at = COALESCE(published_at, NOW()),
              published_by = COALESCE(published_by, $4),
              amended_at   = CASE WHEN $3 = 'amended' THEN NOW() ELSE amended_at END
        -- The status predicate is IN the update, not a pre-check. The JS guard
        -- above reads, then writes; a concurrent archive between the two wrote
        -- the published status over archived_at, storing a month that is live and
        -- archived at once. Judged on whether a row came back, never
        -- read-then-write.
        WHERE id = $1 AND org_user_id = $2 AND status <> 'archived'
        RETURNING id, month::text, status, published_at, amended_at, archived_at, department`,
      [row.id, orgUserId, nextStatus, actorUserId],
    );
    if (!updated) {
      // The month existed a moment ago, so a miss here means it was archived in
      // between — report that, not a bare 404.
      throw new ConflictException('roster_month_archived');
    }

    await this.audit.log(orgUserId, actorUserId, `roster.${nextStatus}`, {
      targetKind: 'roster_month', targetId: row.id,
      metadata: {month: row.month, department: row.department ?? null,
                 conflicts: conflicts.length, forced: !!opts.force},
    }).catch(e => this.log.warn(`roster publish audit failed: ${(e as Error)?.message}`));

    return {ok: true, month: updated, conflicts};
  }

  /** A7.2 — archive a month. Keeps its shifts; removes it from planning.
   *
   *  REQUIRES an opened month (edge-case review, 2026-08-07): create-then-
   *  archive minted a TERMINAL row for a month nobody had planned — there is
   *  no un-archive path, `resolveRosterMonthId` has no status filter, so
   *  every later shift in that month+branch linked to the archived row and
   *  became invisible to `myTodayShift` (un-clock-in-able) AND to the absent
   *  sweep. You cannot withdraw a plan that was never made. */
  async archiveMonth(
    orgUserId: string, actorUserId: string, month: string, department?: string | null,
  ): Promise<RosterMonth> {
    const row = await this.readMonth(orgUserId, month, department);
    if (!row) {throw new NotFoundException('roster_month_not_planned');}
    const updated = await this.db.qOne<RosterMonth>(
      `UPDATE public.cpo_roster_months
          SET status = 'archived', archived_at = NOW()
        WHERE id = $1 AND org_user_id = $2
        RETURNING id, month::text, status, published_at, amended_at, archived_at, department`,
      [row.id, orgUserId],
    );
    if (!updated) {throw new NotFoundException('roster_month_not_found');}
    await this.audit.log(orgUserId, actorUserId, 'roster.archived', {
      targetKind: 'roster_month', targetId: row.id,
      metadata: {month: row.month},
    }).catch(() => undefined);
    return updated;
  }

  /**
   * A7.4 — record a correction WITHOUT touching the original.
   *
   * The session row is never updated here. The correction is a new row, and the
   * effective value is derived by `listCorrections`' consumers as "original,
   * then the latest correction". `corrected_at` is the database's NOW(), never
   * a client clock.
   */
  async recordCorrection(
    orgUserId: string, actorUserId: string,
    input: {session_id: string; reason: string; after: Record<string, unknown>},
    department?: string | null,
  ): Promise<CorrectionRow> {
    const reason = (input.reason ?? '').trim();
    if (!reason) {throw new BadRequestException('correction_reason_required');}

    // ONE TRANSACTION, because the row lock below is the whole point.
    //
    // `FOR UPDATE` outside a transaction acquires and releases the lock within
    // the single statement, so the guard in attendance.service would have been
    // decorative: A checks (clean) -> B inserts a correction -> A's UPDATE
    // lands. Read, fold and insert therefore share one connection.
    return this.db.withTransaction(async (tx) => {

    // Tenancy AND branch in the same read. `department` is a FORCED FILTER —
    // a branch-scoped manager may not correct another branch's session. It was
    // missing here while the roster routes had it, which is precisely the
    // "scoped on 3 of 5 handlers" shape review round 1 found.
    const session = await tx.qOne<Record<string, unknown>>(
      `SELECT s.id, s.cpo_user_id, s.attendance_status, s.status,
              s.clock_in_at::text  AS clock_in_at,
              s.clock_out_at::text AS clock_out_at
         FROM public.cpo_shift_sessions s
         LEFT JOIN public.cpo_shifts sh ON sh.id = s.shift_id
         ${BRANCH_VIA_MEMBER_JOIN}
        WHERE s.id = $1 AND s.org_user_id = $2
          AND ${BRANCH_SCOPE_PREDICATE}
        -- FOR UPDATE makes attendance.service's assertNotUnderCorrection guard
        -- mutually exclusive instead of merely advisory. editShift and
        -- reviewSession both lock this row; without the matching lock here the
        -- two paths do not serialise, so: A checks (clean) -> B inserts a
        -- correction -> A's UPDATE lands, producing exactly the lie the guard
        -- exists to prevent, in an APPEND-ONLY table.
        --
        -- OF s so the LEFT JOINed shift/member rows are not locked too — they
        -- are read for scoping, not mutated, and locking them would serialise
        -- unrelated writes across the whole branch.
        FOR UPDATE OF s`,
      [input.session_id, orgUserId, department ?? null],
    );
    if (!session) {throw new NotFoundException('session_not_found_in_org');}
    // Corrections target FINISHED records only. An open session's checkout has
    // not happened yet — "correcting" it pre-writes a value the CPO's real
    // clockOut (which is unguarded, deliberately: it is the member's own live
    // action) would then fight with, and the client renders the contradiction
    // as ON SHIFT + a folded "→ 17:00" on the same row (C2 edge-case review,
    // 2026-08-07). The session closes first; then it can be corrected.
    // `status` holds 'open' | 'closed' | 'edited' (20260610000000): every
    // other writer closes — setDayStatus and the rollup insert 'closed',
    // clockOut sets 'closed', editShift sets 'edited' — so the denylist of
    // one is complete.
    if (session.status === 'open') {throw new ConflictException('cannot_correct_open_session');}

    // THE EFFECTIVE VALUE, not the original.
    //
    // `before` must answer "what did it say before THIS correction", which
    // after the first correction is no longer what the session row says — the
    // session is never updated. Folding the existing chain gives the true
    // current value, and it is also what makes a mistaken correction
    // REVERSIBLE: comparing against the immutable original rejected the revert
    // as "changes nothing".
    const effective = {...session};
    // Read INSIDE the transaction: the fold decides `before_value`, so reading
    // it on another connection would fold a chain that a concurrent writer
    // could still be extending.
    const priors = await tx.q<CorrectionRow>(
      `SELECT after_value FROM public.attendance_corrections
        WHERE session_id = $1 AND org_user_id = $2
        ORDER BY corrected_at ASC`,
      [input.session_id, orgUserId],
    );
    for (const prior of priors) {
      Object.assign(effective, prior.after_value);
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const f of CORRECTABLE_FIELDS) {
      if (!(f in input.after)) {continue;}
      // VALIDATE the input, NORMALISE the stored value.
      //
      // Running the same validation over the stored side would strand a
      // session permanently the day AttendanceStatus gains a value that
      // CORRECTABLE_STATUSES has not yet learned: every session holding it
      // becomes uncorrectable, and the error names the INPUT, which is
      // valid — pointing the manager at the wrong thing. The stored value is
      // already whatever the column's own CHECK allowed.
      const next = normaliseCorrectableValue(f, input.after[f], true);
      const cur = normaliseCorrectableValue(f, effective[f], false);
      if (next === cur) {continue;}
      before[f] = cur;
      after[f] = next;
    }
    if (Object.keys(after).length === 0) {
      // The DB CHECK would refuse this too; failing here gives an honest reason
      // instead of a constraint violation.
      throw new BadRequestException('correction_changes_nothing');
    }
    // Validate the EFFECTIVE PAIR, not each field alone — one call can set
    // both times, and a clock-out at or before clock-in (an HH:MM typo, or a
    // day-anchor slip on an overnight session) would otherwise fold into every
    // reader and the compliance CSV as a negative-duration shift, permanently
    // (the chain is append-only; nothing prompts a revert).
    //
    // Only when the correction TOUCHES a time: only time edits can CREATE an
    // inversion, and gating status-only corrections on it would hold them
    // hostage to legacy rows whose stored pair was already inverted by the
    // unvalidated editShift path (critic residue, 2026-08-08).
    if (after.clock_in_at !== undefined || after.clock_out_at !== undefined) {
      const effIn = (after.clock_in_at
        ?? normaliseCorrectableValue('clock_in_at', effective.clock_in_at, false)) as string | null;
      const effOut = (after.clock_out_at
        ?? normaliseCorrectableValue('clock_out_at', effective.clock_out_at, false)) as string | null;
      if (effIn && effOut && Date.parse(effOut) <= Date.parse(effIn)) {
        throw new BadRequestException('correction_out_before_in');
      }
    }

    const row = await tx.qOne<CorrectionRow>(
      `INSERT INTO public.attendance_corrections
         (session_id, org_user_id, corrected_by, cpo_user_id,
          reason, before_value, after_value)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING id, session_id, corrected_by, corrected_at::text,
                 reason, before_value, after_value`,
      // cpo_user_id is denormalised precisely so the trail stays attributable
      // after the session row is gone. Adding the column and never writing it
      // would have left it NULL forever and made the whole justification for
      // dropping the foreign key false.
      [input.session_id, orgUserId, actorUserId, session.cpo_user_id ?? null, reason,
       JSON.stringify(before), JSON.stringify(after)],
    );
    if (!row) {throw new BadRequestException('correction_failed');}

    // IN the transaction, and NOT swallowed.
    //
    // Two traps, one on each side. Left outside (this used `this.audit` with a
    // .catch()), the audit row commits on its own connection — so a failed
    // commit here would leave an audit row asserting a correction that does not
    // exist. Passed `tx` but still swallowed, it is worse: Postgres aborts the
    // whole transaction on any statement error (25P02), so catching and
    // continuing makes withTransaction COMMIT an already-aborted transaction.
    //
    // So: same connection, and let it throw. For an APPEND-ONLY compliance
    // trail, "the correction failed" is strictly better than "the correction
    // landed but we cannot say who made it". attendance.service already logs
    // this table's sibling events with `tx`; this is the same rule in one place.
    await this.audit.log(orgUserId, actorUserId, 'attendance.corrected', {
      targetKind: 'attendance_session', targetId: input.session_id,
      metadata: {reason, fields: Object.keys(after)}, tx,
    });

      return row;
    });
  }

  /**
   * A7.4 — THE EFFECTIVE-VALUE RULE, JS side: fold the corrections oldest →
   * newest over the session row; the last correction NAMING a field wins.
   * The live implementation is `recordCorrection`'s inline fold above (it
   * decides what the record "said before"); this list is its input.
   *
   * KEEP IN LOCKSTEP with `AttendanceService.effectiveField` — the SQL twin
   * that folds the same rule into the human-facing readers (N4, wired
   * 2026-08-07). Ties on corrected_at resolve identically: `id ASC` here with
   * last-assign-wins ≡ the SQL's `id DESC LIMIT 1` — both pick the max id.
   * (An exported `effectiveSession` wrapper existed and was DELETED
   * 2026-08-07: zero callers, and a dead "canonical" twin is how rules drift.)
   *
   * Oldest first so the history reads as a story.
   */
  async listCorrections(
    orgUserId: string, sessionId: string, department?: string | null,
  ): Promise<CorrectionRow[]> {
    return this.db.q<CorrectionRow>(
      // The branch filter joins back through the session's shift, so a
      // branch-scoped manager reads only their own branch's history — the same
      // forced filter the roster routes use.
      `SELECT c.id, c.session_id, c.corrected_by, c.corrected_at::text,
              c.reason, c.before_value, c.after_value
         FROM public.attendance_corrections c
         -- LEFT, not INNER. An INNER JOIN here threw the trail away exactly
         -- when it mattered: setDayStatus DELETEs the day's session to upsert
         -- it, so every correction against that session became unreadable —
         -- the row survived in an append-only table that no read path could
         -- reach. That is the failure the missing foreign key was justified by,
         -- reintroduced one join further out.
         LEFT JOIN public.cpo_shift_sessions s ON s.id = c.session_id
         LEFT JOIN public.cpo_shifts sh ON sh.id = s.shift_id
         ${BRANCH_VIA_MEMBER_JOIN}
        WHERE c.session_id = $1 AND c.org_user_id = $2
          AND ${BRANCH_SCOPE_PREDICATE}
        -- Oldest first: the chain must be folded in the order it happened, and
        -- recordCorrection replays it to compute the effective value. id ASC
        -- breaks timestamp ties the same way the SQL fold's id DESC does.
        ORDER BY c.corrected_at ASC, c.id ASC`,
      [sessionId, orgUserId, department ?? null],
    );
  }
}

/**
 * The ONLY fields a correction may touch, and the real column names.
 *
 * The first version of this named `started_at` / `ended_at`, which do not exist
 * on `cpo_shift_sessions` — the columns are `clock_in_at` / `clock_out_at`.
 * Every correction threw Postgres 42703, and the invented names survived
 * because the test fixture used them too: the fixture had become the schema
 * definition. Pinned now by a shape gate against the service's own
 * `ShiftSession` interface.
 */
/**
 * ONE branch-scope rule for attendance sessions, shared by every read that has
 * one — because the bug it fixes is what happens when a rule is written twice.
 *
 * THE HOLE IT CLOSES. The predicate used to be
 * `sh.department IS NULL OR sh.department = $3`, which looks branch-scoped and
 * is not: a day-status session (leave / sick_leave / off_duty / absent) carries
 * NO shift_id, so `sh` never matches, `sh.department IS NULL` is TRUE, and the
 * whole branch test is OR-ed away. Any branch-scoped manager could read and
 * CORRECT any other branch's sick-leave records — the most sensitive rows in
 * the table. Legacy clock-ins have a null shift_id too.
 *
 * The fix is to ask the right question. A session with no shift still belongs
 * to a CPO, and a CPO's branch is `org_members.department` — the column that
 * exists for exactly this ("NULL = whole org, set = the manager only sees that
 * department's attendance"). So resolve the branch through the SHIFT when there
 * is one and through the MEMBER when there is not.
 *
 * COALESCE, not a disjunction: a null on either side must never widen the
 * filter, which was the original defect.
 */
const BRANCH_VIA_MEMBER_JOIN = `LEFT JOIN public.org_members om
           ON om.org_user_id = s.org_user_id AND om.member_user_id = s.cpo_user_id`;

/**
 * `om.status` IS DELIBERATELY NOT FILTERED — do not "tighten" this.
 *
 * The composite PK (org_user_id, member_user_id) means there is exactly one row
 * per person per org, so this reads as "their current or last-known branch",
 * which is the right attribution for a HISTORICAL record. Adding
 * `AND om.status = 'active'` would drop the branch for a departed employee and
 * make every past record of theirs invisible to every branch manager.
 *
 * ── WHY THIS PREDICATE DIFFERS FROM findConflicts' ──────────────────────────
 *
 * Here a NULL `$3` means "an unscoped manager, who sees everything".
 * In findConflicts a NULL department is a BUCKET (`COALESCE(...,'')`), not a
 * wildcard, because there it identifies WHICH ROSTER is being planned.
 * Different questions, so deliberately different rules — a later "consistency"
 * pass that harmonises them will reintroduce a bug at one end or the other.
 */
const BRANCH_SCOPE_PREDICATE =
  `($3::text IS NULL OR COALESCE(sh.department, om.department) = $3)`;

export const CORRECTABLE_FIELDS = ['attendance_status', 'clock_in_at', 'clock_out_at'] as const;

/**
 * Compare timestamps as INSTANTS, not strings.
 *
 * Postgres renders `2026-08-04 09:00:00+00` while a client sends
 * `2026-08-04T09:00:00.000Z`. Those are the same moment and different strings,
 * so a raw `===` no-op guard never fires for a time field and would store the
 * before/after images in two different formats.
 */
function normaliseCorrectableValue(
  field: string, value: unknown, validate: boolean,
): unknown {
  if (value === null || value === undefined) {
    // The STORED/effective side is legitimately null (an open session's
    // clock_out_at). The INPUT side must never be: a JSON null slips past the
    // status enum below, the readers' COALESCE fold cannot represent
    // "corrected to null" (it silently falls back to the raw value) while
    // `?|` still bricks every writer on the field — an unfixable state in an
    // append-only table. Corrections REPLACE values; clearing one is not a
    // supported operation (C2 adversarial review, 2026-08-07).
    if (validate) {throw new BadRequestException('correction_value_required');}
    return null;
  }
  if (field === 'attendance_status') {
    if (!validate) {return String(value);}
    // VALIDATE, do not pass through.
    //
    // `after` is a bare @IsObject() on the DTO, so without this any string —
    // or an object — is written verbatim into `after_value` JSONB, becomes the
    // effective status on every later fold, and is a value the real column's
    // CHECK would have rejected. The table is APPEND-ONLY: a bad row here can
    // never be updated or deleted, so this is the last place it can be caught.
    if (!(CORRECTABLE_STATUSES as readonly string[]).includes(String(value))) {
      throw new BadRequestException('invalid_attendance_status');
    }
    return String(value);
  }
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) {throw new BadRequestException(`invalid_${field}`);}
  return new Date(t).toISOString();
}

export interface RosterMonth {
  id: string;
  month: string;
  status: 'draft' | 'published' | 'amended' | 'archived';
  published_at: string | null;
  amended_at: string | null;
  archived_at: string | null;
  department: string | null;
}

export interface RosterConflict {
  cpo_user_id: string;
  cpo_name: string | null;
  shift_a: string;
  shift_b: string;
  start_a: string;
  end_a: string;
  start_b: string;
  end_b: string;
}

export type PublishResult =
  | {ok: true; month: RosterMonth; conflicts: RosterConflict[]}
  | {ok: false; reason: 'conflicts'; conflicts: RosterConflict[]; status: RosterMonth['status']};

export interface CorrectionRow {
  id: string;
  session_id: string;
  corrected_by: string;
  corrected_at: string;
  reason: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
}
