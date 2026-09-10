import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type {Response} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {readOrgContextHeader} from '../org/org-context';
import {AttendanceService} from './attendance.service';

/** Just enough of the request to read a header from. */
type RawRequest = {headers?: Record<string, unknown>};
import {
  AssignCposDto, ClockInDto, ClockOutDto, CreateShiftDto, DisputeSessionDto, PatchAssignmentsDto,
  EditShiftDto, ExportSessionsDto, ReviewSessionDto, SetDayStatusDto, UpdateShiftDto,
} from './dto/attendance.dto';

/**
 * Attendance — provider-managed CPO shift clock-in/out.
 *
 * Two trust scopes on one controller:
 *  - CPO self (JwtAuthGuard, scoped to user.sub): clock-in/out + own history.
 *  - Provider (OrgManagerGuard, scoped to manager.org_user_id): roster view +
 *    edit. OrgManagerGuard runs after JwtAuthGuard so req.user is populated.
 */
@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // ── CPO self ──────────────────────────────────────────────────────
  @Post('clock-in')
  @HttpCode(200)
  clockIn(@Body() dto: ClockInDto, @CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    return this.attendance.clockIn(user.sub, dto, readOrgContextHeader(req));
  }

  @Post('clock-out')
  @HttpCode(200)
  clockOut(@Body() dto: ClockOutDto, @CurrentUser() user: AccessClaims) {
    return this.attendance.clockOut(user.sub, dto);
  }

  @Get('me')
  myShifts(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    // B-611 — scope "my shifts" to the org being viewed (twin of B-610 incidents);
    // an absent header shows all the CPO's own shifts, never a partial list.
    return this.attendance.myShifts(user.sub, readOrgContextHeader(req));
  }

  // CPO self: dispute an own (closed/reviewed) record → back to the manager queue.
  @Post('sessions/:id/dispute')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard)
  disputeSession(
    @Param('id') id: string,
    @Body() dto: DisputeSessionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.attendance.disputeSession(user.sub, id, dto.note);
  }

  // ── Provider (org-scoped) ─────────────────────────────────────────
  @Get('org/sessions')
  @UseGuards(OrgManagerGuard)
  orgShifts(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('cpo_user_id') cpoUserId?: string,
  ) {
    // manager.department is the FORCED branch filter, same as pendingQueue —
    // this list is the Corrections picker, so it must offer only sessions the
    // correction verbs will accept.
    return this.attendance.orgShifts(manager.org_user_id, {cpoUserId}, manager.department);
  }

  @Patch('sessions/:id')
  @UseGuards(OrgManagerGuard)
  editShift(
    @Param('id') shiftId: string,
    @Body() dto: EditShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.editShift(manager.org_user_id, manager.user_id, shiftId, {
      clock_in_at: dto.clock_in_at,
      clock_out_at: dto.clock_out_at,
      edit_reason: dto.edit_reason,
    }, manager.department); // AUTHZ-3 — branch scope
  }

  // ── Dept Chat v2 · shifts (flag-gated; legacy routes above unchanged) ──
  //
  // DeptChatV2Guard runs first → 404 when the flag is off, so these routes are
  // invisible until rollout. The real auth guards (JwtAuthGuard at the class
  // level, OrgManagerGuard here) still apply — the flag never replaces a guard.

  @Post('shifts')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  createShift(
    @Body() dto: CreateShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.createShift(manager.org_user_id, manager.user_id, dto, manager.department);
  }

  @Post('shifts/:id/assignments')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  assignCpos(
    @Param('id') shiftId: string,
    @Body() dto: AssignCposDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.assignCpos(manager.org_user_id, shiftId, dto.cpo_user_ids, manager.user_id, manager.department);
  }

  /** G-ab — who is on this shift (edit-mode prefill). */
  @Get('shifts/:id/assignments')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async listAssignments(
    @Param('id') shiftId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return {assignments: await this.attendance.listAssignments(
      manager.org_user_id, shiftId, manager.department)};
  }

  /** G-ab — diff the assignment set (the un-assign that never existed:
   *  assignCpos is insert-only, so a mis-assignment was permanent). The
   *  branch scope rides the argument, never the body (F HIGH-1 lesson). */
  @Patch('shifts/:id/assignments')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  patchAssignments(
    @Param('id') shiftId: string,
    @Body() dto: PatchAssignmentsDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.patchAssignments(manager.org_user_id, shiftId,
      {add: dto.add, remove: dto.remove, assign_department: dto.assign_department},
      manager.user_id, manager.department);
  }

  @Patch('shifts/:id')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  updateShift(
    @Param('id') shiftId: string,
    @Body() dto: UpdateShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.updateShift(manager.org_user_id, manager.user_id, shiftId, dto, manager.department);
  }

  @Delete('shifts/:id')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  archiveShift(
    @Param('id') shiftId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.archiveShift(manager.org_user_id, manager.user_id, shiftId, manager.department);
  }

  @Get('shifts')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  listShifts(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.attendance.listOrgShifts(manager.org_user_id, undefined, manager.department);
  }

  // CPO self: "today's assigned shift" (or null → UI blocks check-in).
  @Get('my-shift/today')
  @UseGuards(DeptChatV2Guard)
  myTodayShift(@CurrentUser() user: AccessClaims) {
    return this.attendance.myTodayShift(user.sub);
  }

  // ── Dept Chat v2 · review workflow + admin view + export (Steps 6,7) ──

  @Patch('sessions/:id/review')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  reviewSession(
    @Param('id') id: string,
    @Body() dto: ReviewSessionDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.reviewSession(manager.org_user_id, manager.user_id, id, dto.decision, dto.notes, manager.department); // AUTHZ-3 — branch scope
  }

  @Post('day-status')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  setDayStatus(
    @Body() dto: SetDayStatusDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    // The FORCED branch filter, same as every scoped handler below: a
    // delegated manager writes only their own branch (F review HIGH-1). The
    // force applies ONLY when the caller chose department MODE — forcing it
    // unconditionally populated a second targeting mode on every scoped
    // call and 400'd the whole feature for scoped managers (HIGH-A). The
    // member_ids/legacy paths are branch-constrained by the 4th argument
    // instead, inside the membership query.
    return this.attendance.setDayStatus(manager.org_user_id, manager.user_id, {
      cpoUserId: dto.cpo_user_id, memberIds: dto.member_ids,
      department: dto.department != null ? (manager.department ?? dto.department) : undefined,
      status: dto.status, date: dto.date, dates: dto.dates, notes: dto.notes,
    }, manager.department);
  }

  // Department scoping (PDF p.9/p.16): a department-scoped manager's view is
  // FORCED to their department — a requested filter can only narrow within it.
  @Get('org/summary')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  orgSummary(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cpo_user_id') cpoUserId?: string,
    @Query('department') department?: string,
    @Query('shift_id') shiftId?: string,
  ) {
    return this.attendance.orgSummary(manager.org_user_id, {
      from, to, cpoUserId, shiftId,
      department: manager.department ?? department,
    });
  }

  @Get('org/pending')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  pendingQueue(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('department') department?: string,
  ) {
    return this.attendance.pendingQueue(manager.org_user_id, {
      department: manager.department ?? department,
    });
  }

  @Post('org/export')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async exportSessions(
    @Body() dto: ExportSessionsDto,
    @CurrentOrgManager() manager: OrgManagerContext,
    @Res({passthrough: true}) res: Response,
  ): Promise<string> {
    const out = await this.attendance.exportSessions(manager.org_user_id, manager.user_id, {
      from: dto.from, to: dto.to, cpoUserId: dto.cpo_user_id, shiftId: dto.shift_id,
      department: manager.department ?? dto.department,
    });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    return out.body;
  }
}
