import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {ProApplicationsService} from './pro-applications.service';
import {
  CancelProApplicationDto, CreateProposalDto, DeclineProMissionDto, InternalNotesDto,
  ProThreadMessageDto, RejectProApplicationDto, ScheduleProMissionDto,
} from './dto/pro-application.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Ops-console Pro Applications surface. Same guard chain as every /ops/*
 * route (JwtAuthGuard → CsrfGuard → AdminGuard); proposal/reject decisions
 * require SUPERVISOR/ADMIN, reads + notes + thread replies any admin.
 * Pro applications are HQ-level (no region scoping — coverage_area is free
 * text, not a dispatch region).
 */
@Controller('ops/pro-applications')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class ProApplicationsOpsController {
  constructor(
    private readonly proApps: ProApplicationsService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.proApps.listForOps(status, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.proApps.getForOps(id);
  }

  @Post(':id/proposal')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createProposal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProposalDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.createProposal(req.admin, id, dto);
    await this.audit.recordAdmin(req.admin, 'pro_application.proposal_create', 'application', id, {
      total_credits: dto.total_credits, coverage_start: dto.coverage_start, coverage_end: dto.coverage_end,
    });
    return r;
  }

  @Post(':id/reject')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProApplicationDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.reject(req.admin, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'pro_application.reject', 'application', id, {reason: dto.reason});
    return r;
  }

  /** Cancel on the client's behalf (phone request etc.) — terminal, pushes the client. */
  @Post(':id/cancel')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelProApplicationDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.opsCancel(req.admin, id, dto.note ?? undefined);
    await this.audit.recordAdmin(req.admin, 'pro_application.cancel', 'application', id, {note: dto.note ?? null});
    return r;
  }

  @Post(':id/missions/:missionId/schedule')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async scheduleMission(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @Body() dto: ScheduleProMissionDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.scheduleMission(req.admin, id, missionId, dto.assigned_team, dto.ops_note);
    await this.audit.recordAdmin(req.admin, 'pro_mission.schedule', 'application', id, {mission_id: missionId});
    return r;
  }

  @Post(':id/missions/:missionId/decline')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async declineMission(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @Body() dto: DeclineProMissionDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.declineMission(req.admin, id, missionId, dto.ops_note);
    await this.audit.recordAdmin(req.admin, 'pro_mission.decline', 'application', id, {
      mission_id: missionId, ops_note: dto.ops_note ?? null,
    });
    return r;
  }

  // OC-13 — both mutations below were unaudited (notes also unguarded beyond
  // the base admin chain). Notes are SUPERVISOR+: they steer how every other
  // operator treats the plan. The audit row records length, never the body —
  // notes/messages can carry client PII and the audit trail is broadly read.
  @Put(':id/internal-notes')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async internalNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InternalNotesDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.setInternalNotes(id, dto.notes);
    await this.audit.recordAdmin(req.admin, 'pro_application.internal_notes', 'application', id, {
      notes_len: dto.notes?.length ?? 0,
    });
    return r;
  }

  @Post(':id/messages')
  async sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProThreadMessageDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.proApps.opsSendMessage(req.admin, id, dto.body);
    await this.audit.recordAdmin(req.admin, 'pro_application.ops_message', 'application', id, {
      body_len: dto.body?.length ?? 0,
    });
    return r;
  }
}
