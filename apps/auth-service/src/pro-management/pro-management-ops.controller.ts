import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {ProManagementService} from './pro-management.service';
import {
  CreateInternalOrgDto, CreateOpsCpoDto, CreateProAssignmentDto,
  ScheduleRequestWithCposDto, SuspendCpoDto,
} from './dto/pro-management.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Ops-console Pro management surface: internal organisations, ops-created
 * CPOs, the assignable pool, and overlap-safe CPO↔member assignments.
 * Standard /ops guard chain; anything that creates accounts or commits an
 * officer requires SUPERVISOR/ADMIN.
 */
@Controller('ops/pro-management')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class ProManagementOpsController {
  constructor(
    private readonly mgmt: ProManagementService,
    private readonly audit: OpsAuditService,
  ) {}

  // ── Organisations ──
  @Get('orgs')
  listOrgs() {
    return this.mgmt.listOrgs();
  }

  @Post('orgs')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createOrg(@Body() dto: CreateInternalOrgDto, @Req() req: OpsReq) {
    const r = await this.mgmt.createOrg(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'pro_org.create', 'user',
      (r.org as {id: string}).id, {display_name: dto.display_name});
    return r;
  }

  @Get('orgs/:id')
  orgDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.mgmt.orgDetail(id);
  }

  // ── CPOs ──
  @Post('cpos')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createCpo(@Body() dto: CreateOpsCpoDto, @Req() req: OpsReq) {
    const r = await this.mgmt.createCpo(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'pro_cpo.create', 'agent',
      (r.member as {member_user_id: string}).member_user_id, {org_user_id: dto.org_user_id});
    return r;
  }

  @Post('cpos/:userId/suspension')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async suspend(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: SuspendCpoDto, @Req() req: OpsReq) {
    const r = await this.mgmt.setCpoSuspension(req.admin, userId, dto);
    await this.audit.recordAdmin(
      req.admin, dto.suspend ? 'pro_cpo.suspend' : 'pro_cpo.reinstate', 'agent', userId,
      {days: dto.days ?? null, reason: dto.reason ?? null},
    );
    return r;
  }

  @Get('pool')
  pool(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('application_id') applicationId?: string,
  ) {
    return this.mgmt.listPool(from, to, applicationId);
  }

  /** Global incoming queue: every REQUESTED protection-date request. */
  @Get('requests')
  requests() {
    return this.mgmt.listMissionRequests();
  }

  // ── Assignments ──
  @Get('assignments')
  assignments(
    @Query('application_id') applicationId?: string,
    @Query('cpo_user_id') cpoUserId?: string,
    @Query('status') status?: string,
  ) {
    return this.mgmt.listAssignments({application_id: applicationId, cpo_user_id: cpoUserId, status});
  }

  @Post('assignments')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createAssignment(@Body() dto: CreateProAssignmentDto, @Req() req: OpsReq) {
    const r = await this.mgmt.createAssignment(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'pro_assignment.create', 'application', dto.application_id, {
      assignment_id: r.assignment.id, cpo_user_id: dto.cpo_user_id,
      starts_on: dto.starts_on, ends_on: dto.ends_on,
    });
    return r;
  }

  @Post('assignments/:id/cancel')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.mgmt.cancelAssignment(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'pro_assignment.cancel', 'application',
      r.assignment.application_id, {assignment_id: id, cpo_user_id: r.assignment.cpo_user_id});
    return r;
  }

  @Post('assignments/:id/complete')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async complete(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.mgmt.completeAssignment(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'pro_assignment.complete', 'application',
      r.assignment.application_id, {assignment_id: id, cpo_user_id: r.assignment.cpo_user_id});
    return r;
  }

  /** Schedule a client's multi-date request by assigning real officers. */
  @Post('applications/:id/missions/:missionId/schedule-cpos')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async scheduleWithCpos(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @Body() dto: ScheduleRequestWithCposDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.mgmt.scheduleRequestWithCpos(req.admin, id, missionId, dto);
    await this.audit.recordAdmin(req.admin, 'pro_mission.schedule', 'application', id, {
      mission_id: missionId, cpo_user_ids: dto.cpo_user_ids,
    });
    return r;
  }
}
