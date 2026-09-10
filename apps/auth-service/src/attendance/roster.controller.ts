import {ParseUUIDPipe} from '@nestjs/common';
import {Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {RosterService} from './roster.service';
import {EnsureMonthDto, PublishMonthDto, RecordCorrectionDto} from './dto/roster.dto';

/**
 * Scope v2 Phase 5 — Monthly Roster (A7.2) and Attendance Corrections (A7.4).
 *
 * EVERY route here is manager-only: `OrgManagerGuard` on the class, and each
 * handler scoped to `mgr.org_user_id`. There is deliberately no member-facing
 * route on this controller — a member sees the *result* of a published roster
 * through the existing attendance reads, never the roster's planning state.
 * That is what keeps "a draft is invisible to the team" structural rather than
 * a filter someone has to remember.
 *
 * `mgr.department` is a FORCED FILTER, exactly as it is on the join-request
 * inbox: a branch-scoped manager plans their own branch's month, not the org's.
 * Phase 3 shipped a bug by passing `null` here from the controller while the
 * SQL was correct, so the wiring is asserted in this phase's spec too.
 */
@Controller('attendance/roster')
// DeptChatV2Guard 404s the whole controller while the rollout flag is off,
// exactly as the v2 routes on AttendanceController do — Phase 5's endpoints
// must not ship LIVE ahead of any UI.
@UseGuards(JwtAuthGuard, DeptChatV2Guard, OrgManagerGuard)
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  /** A7.2 — READ the manager's month. Never writes (the pre-flag-flip rule:
   *  a retry/prefetch on a GET must not mint a draft month, because a draft
   *  month hides its shifts from `myTodayShift` and blocks member check-in).
   *  `month: null` = never planned; the client offers "Start planning" and
   *  must NOT offer Publish/Archive (both 404 `roster_month_not_planned`).
   *  The DTO on a bare @Query: a missing/malformed `month` was a 500
   *  (`monthKey` sliced undefined), and `?month=2026` silently normalised to
   *  January — the same @Matches the POSTs use makes both a 400. */
  @Get('month')
  async getMonth(@Query() dto: EnsureMonthDto, @CurrentOrgManager() mgr: OrgManagerContext) {
    return {month: await this.roster.readMonth(mgr.org_user_id, dto.month, mgr.department)};
  }

  /** A7.2 — open (create-if-absent) the month as a DRAFT. A POST because it
   *  writes: pressing "plan this month" is the explicit act the row records.
   *  Wrapped as {month} so GET and POST return the same shape — RosterMonth
   *  itself has a `month` date-string field, and a bare row made
   *  `(await ensure()).month` a different type than `(await get()).month`. */
  @Post('month/ensure')
  @HttpCode(200)
  async ensureMonth(@Body() dto: EnsureMonthDto, @CurrentOrgManager() mgr: OrgManagerContext) {
    return {month: await this.roster.ensureMonth(mgr.org_user_id, mgr.user_id, dto.month, mgr.department)};
  }

  /** A7.2 — "conflict flagging before publish", also callable on its own so the
   *  calendar can warn while the manager is still editing. */
  @Get('month/:id/conflicts')
  async conflicts(@Param('id', ParseUUIDPipe) id: string,
                  @CurrentOrgManager() mgr: OrgManagerContext) {
    return {conflicts: await this.roster.findConflicts(mgr.org_user_id, id, mgr.department)};
  }

  /** A7.2 — publish, or amend an already-published month. */
  @Post('publish')
  @HttpCode(200)
  publish(@Body() dto: PublishMonthDto, @CurrentOrgManager() mgr: OrgManagerContext) {
    return this.roster.publishMonth(mgr.org_user_id, mgr.user_id, dto.month, {
      department: mgr.department,
      force: dto.force,
    });
  }

  @Post('archive')
  @HttpCode(200)
  async archive(@Body() dto: PublishMonthDto, @CurrentOrgManager() mgr: OrgManagerContext) {
    return {month: await this.roster.archiveMonth(mgr.org_user_id, mgr.user_id, dto.month, mgr.department)};
  }

  /** A7.4 — record a correction. Never overwrites the original session. */
  @Post('corrections')
  @HttpCode(200)
  correct(@Body() dto: RecordCorrectionDto, @CurrentOrgManager() mgr: OrgManagerContext) {
    return this.roster.recordCorrection(mgr.org_user_id, mgr.user_id, {
      session_id: dto.session_id,
      reason: dto.reason,
      after: dto.after,
      // The branch, forwarded here too. It was missing on this route and on
      // `corrections()` while the three roster routes had it, so a branch
      // manager could read and correct ANY session in the org.
    }, mgr.department);
  }

  /** A7.4 — the full before/after history for one session. */
  @Get('corrections/:sessionId')
  async corrections(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentOrgManager() mgr: OrgManagerContext,
  ) {
    return {corrections: await this.roster.listCorrections(mgr.org_user_id, sessionId, mgr.department)};
  }
}
