import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {ProtectionService} from './protection.service';
import {OpsEndSessionDto, TransferSessionDto} from './dto/protection.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Ops protection-monitoring surface (spec §8). Standard /ops guard chain; the
 * two mutations (end, transfer) require SUPERVISOR/ADMIN and record through
 * OpsAuditService. Location-detail READS additionally write protection_access_audit
 * (service side, §9).
 */
@Controller('ops/protection')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class ProtectionOpsController {
  constructor(
    private readonly protection: ProtectionService,
    private readonly audit: OpsAuditService,
  ) {}

  /** Monitoring / history list with combinable filters (status, cpo, user, dates). */
  @Get('sessions')
  list(
    @Query('status') status?: string,
    @Query('cpo_user_id') cpoUserId?: string,
    @Query('customer_id') customerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.protection.opsListSessions({status, cpoUserId, customerId, from, to, limit: limit ? Number(limit) : undefined});
  }

  /** Session detail incl. the coordinate trail (audited). */
  @Get('sessions/:id')
  detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.protection.opsSessionDetail(req.admin, id);
  }

  /** Full canonical mission-history timeline (audited). */
  @Get('sessions/:id/timeline')
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @Req() req: OpsReq,
  ) {
    return this.protection.opsTimeline(req.admin, id, Number(limit) || 100, before ? Number(before) : undefined);
  }

  /** Ops end (end_reason 'ops', reason text required + audited). */
  @Post('sessions/:id/end')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async end(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OpsEndSessionDto, @Req() req: OpsReq) {
    const r = await this.protection.opsEnd(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'protection_session.end', 'application',
      r.session.application_id, {session_id: id, reason: dto.reason});
    return r;
  }

  /** Edge J — explicit transfer to another officer (audited; notifies both CPOs + customer). */
  @Post('sessions/:id/transfer')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async transfer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferSessionDto, @Req() req: OpsReq) {
    const r = await this.protection.opsTransfer(req.admin, id, dto.new_cpo_user_id);
    await this.audit.recordAdmin(req.admin, 'protection_session.transfer', 'application',
      r.session.application_id, {
        session_id: id, from_cpo_user_id: r.previous_cpo_user_id, to_cpo_user_id: dto.new_cpo_user_id,
      });
    return r;
  }
}
