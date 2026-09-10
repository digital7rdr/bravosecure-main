import {Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OpsDataService} from './ops-data.service';
import {OpsAuditService} from './ops-audit.service';
import {
  OpsAuditBrowseQueryDto, OpsDisputesQueryDto, OpsEscrowQueryDto,
  OpsSosQueryDto, OpsTxQueryDto, OpsUsersQueryDto,
  SuspendUserDto, EraseUserDto,
} from './dto/ops.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Read surfaces added by the 2026-07-07 data-coverage audit. Same guard
 * chain as OpsController. Money/user/audit reads are SUPERVISOR+ (least
 * privilege — OPS-tier keeps the operational surfaces: SOS, VBG, analytics,
 * broadcasts, telemetry).
 */
@Controller('ops')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class OpsDataController {
  constructor(
    private readonly data: OpsDataService,
    private readonly audit: OpsAuditService,
  ) {}

  // ─── Disputes (DC-02) ─────────────────────────────────────────────
  @Get('disputes')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listDisputes(@Query() q: OpsDisputesQueryDto, @Req() req: OpsReq) {
    return this.data.listDisputes(req.admin, q.status, q.limit);
  }

  // ─── Finance ledger (DC-01) ───────────────────────────────────────
  @Get('finance/transactions')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listTransactions(@Query() q: OpsTxQueryDto) {
    return this.data.listWalletTransactions(q);
  }

  @Get('finance/escrows')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listEscrows(@Query() q: OpsEscrowQueryDto, @Req() req: OpsReq) {
    return this.data.listEscrows(req.admin, q.status, q.limit);
  }

  @Get('finance/payouts')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listPayouts(@Query('limit') limit: string | undefined, @Req() req: OpsReq) {
    return this.data.listPayouts(req.admin, Number(limit) || undefined);
  }

  @Get('finance/invoices')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listInvoices(@Query('limit') limit: string | undefined, @Req() req: OpsReq) {
    return this.data.listInvoices(req.admin, Number(limit) || undefined);
  }

  @Get('finance/promos')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listPromos() {
    return this.data.listPromos();
  }

  @Get('finance/wallet/:userId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  walletOverview(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.data.walletOverview(userId);
  }

  // ─── User directory (DC-04) ───────────────────────────────────────
  @Get('users')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listUsers(@Query() q: OpsUsersQueryDto) {
    return this.data.listUsers(q);
  }

  @Get('users/:id')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.data.getUserDetail(id);
  }

  // SK-07/IS-03 — family memberships both directions (owner-of + member-of).
  @Get('users/:id/family')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  getUserFamily(@Param('id', ParseUUIDPipe) id: string) {
    return this.data.getUserFamily(id);
  }

  @Post('users/:id/devices/:deviceRowId/revoke')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async revokeDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceRowId', ParseUUIDPipe) deviceRowId: string,
    @Req() req: OpsReq,
  ) {
    const r = await this.data.revokeUserDevice(id, deviceRowId);
    await this.audit.recordAdmin(req.admin, 'user.device_revoke', 'user', id, {device_row_id: deviceRowId});
    return r;
  }

  // DC-04 — reversible suspension (locks login + kills live sessions).
  @Post('users/:id/suspend')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async suspendUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendUserDto, @Req() req: OpsReq) {
    const r = await this.data.suspendUser(req.admin.user_id, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'user.suspend', 'user', id, {reason: dto.reason, revoked_sessions: r.revoked_sessions});
    return r;
  }

  @Post('users/:id/restore')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async restoreUser(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.data.restoreUser(id);
    await this.audit.recordAdmin(req.admin, 'user.restore', 'user', id, {});
    return r;
  }

  // DC-04 — GDPR erasure (irreversible: soft-delete + PII scrub). ADMIN only.
  @Post('users/:id/erase')
  @RequireRoles('ADMIN')
  async eraseUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EraseUserDto, @Req() req: OpsReq) {
    const r = await this.data.eraseUser(req.admin.user_id, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'user.erase', 'user', id, {reason: dto.reason, revoked_sessions: r.revoked_sessions});
    return r;
  }

  // ─── SOS log (DC-06) ──────────────────────────────────────────────
  @Get('sos')
  listSos(@Query() q: OpsSosQueryDto) {
    return this.data.listSos(q.status, q.limit);
  }

  // ─── VBG oversight (DC-07) ────────────────────────────────────────
  @Get('vbg/monitoring')
  listVbgMonitoring() {
    return this.data.listVbgMonitoring();
  }

  // ─── Global audit browser + write-only-trail readers (DC-08) ──────
  @Get('audit')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  browseAudit(@Query() q: OpsAuditBrowseQueryDto) {
    return this.data.browseAudit(q);
  }

  // SK-08 — was `audit/org/:orgUserId`, which OpsController's
  // `audit/:subject_type/:subject_id` (ParseUUIDPipe on the 2nd segment)
  // could shadow depending on registration order. `audit-log/` shares no
  // prefix with that wildcard, so the reader is always reachable.
  @Get('audit-log/org/:orgUserId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  orgAudit(@Param('orgUserId', ParseUUIDPipe) orgUserId: string, @Query('limit') limit?: string) {
    return this.data.listOrgAudit(orgUserId, Number(limit) || undefined);
  }

  // ─── Telemetry replay (DC-16) ─────────────────────────────────────
  @Get('missions/:id/telemetry')
  missionTelemetry(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.data.missionTelemetry(id, req.admin);
  }

  // ─── Broadcast log (DC-20) ────────────────────────────────────────
  @Get('broadcasts/recent')
  listRecentBroadcasts(@Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.data.listRecentBroadcasts(kind || undefined, Number(limit) || undefined);
  }

  // ─── Analytics rollups (DC-10) ────────────────────────────────────
  @Get('analytics')
  analytics(@Query('days') days: string | undefined, @Query('region') region: string | undefined, @Req() req: OpsReq) {
    return this.data.analytics(req.admin, Number(days) || 30, region || undefined);
  }
}
