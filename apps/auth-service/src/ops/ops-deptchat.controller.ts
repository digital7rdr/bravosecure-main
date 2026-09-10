import {
  Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type {Request, Response} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {AttendanceService} from '../attendance/attendance.service';
import {IncidentService} from '../incident/incident.service';
import {OpsAuditService} from './ops-audit.service';

type OpsReq = Request & {admin: AdminContext};

/**
 * Bravo-admin (HQ) oversight for Dept Chat v2 — cross-org incident view +
 * per-org attendance summary + the heavy CSV export (PDF renders client-side
 * on the ops-console). Different TRUST TIER from the org-manager surface: gated
 * by AdminGuard (admin_users), never OrgManagerGuard. Same guard chain as
 * /ops/* (JwtAuthGuard → CsrfGuard → AdminGuard), plus DeptChatV2Guard so the
 * surface is invisible until rollout.
 */
@Controller('ops/deptchat')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, DeptChatV2Guard)
export class OpsDeptChatController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly incidents: IncidentService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get('incidents')
  listIncidents(
    @Query('org_id') orgId?: string,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
  ) {
    return this.incidents.adminIncidents({orgId, status, severity});
  }

  @Get('attendance/summary')
  attendanceSummary(
    @Query('org_id') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.orgSummary(orgId, {from, to});
  }

  // Export is a SUPERVISOR/ADMIN action (it materialises a roster file). Biometric-
  // free CSV; the HQ action is recorded in ops_audit AND the org_audit_log.
  @Post('attendance/export')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async export(
    @Body() body: {org_id: string; from?: string; to?: string},
    @Req() req: OpsReq,
    @Res({passthrough: true}) res: Response,
  ): Promise<string> {
    const out = await this.attendance.exportSessions(body.org_id, req.admin.user_id, {
      from: body.from, to: body.to,
    });
    await this.audit.recordAdmin(req.admin, 'attendance.export', 'system', body.org_id, {format: 'csv'});
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    return out.body;
  }
}
