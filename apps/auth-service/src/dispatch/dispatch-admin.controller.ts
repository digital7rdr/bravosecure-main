import {
  Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import type {Request} from 'express';
import {IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {DispatchKillswitchService} from '../ops/dispatch-killswitch.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {DispatchService} from './dispatch.service';

type OpsReq = Request & {admin: AdminContext};

export class FireTestDispatchDto {
  @IsString() @MaxLength(8) region_code!: string;
  @IsOptional() @IsString() @MaxLength(64) region_label?: string;
  @IsNumber() pickup_lat!: number;
  @IsNumber() pickup_lng!: number;
  @IsOptional() @IsString() @MaxLength(256) pickup_address?: string;
  @IsOptional() @IsInt() @Min(1) @Max(4) cpo_count?: number;
  @IsOptional() @IsInt() @Min(1) @Max(48) duration_hours?: number;
  @IsOptional() @IsBoolean() armed?: boolean;
  @IsOptional() @IsNumber() @Min(1) total_eur?: number;
}

export class KillswitchDto {
  @IsBoolean() enabled!: boolean;
}

/**
 * Ops-console Dispatch Monitor surface (auto-dispatch visibility). Admin-only — reuses the
 * /ops guard chain (JwtAuthGuard → CsrfGuard → AdminGuard). GET /ops/dispatch/monitor shows
 * the live engine state; POST /ops/dispatch/test fires a real auto booking through the
 * matchmaker so an operator can watch an offer reach the nearest eligible agency.
 */
@Controller('ops/dispatch')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class DispatchAdminController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly audit: OpsAuditService,
    private readonly killswitch: DispatchKillswitchService,
  ) {}

  @Get('monitor')
  monitor() {
    return this.dispatch.monitor();
  }

  /** Runtime kill-switch state for the monitor banner (any admin may read). */
  @Get('killswitch')
  async killswitchState() {
    return {runtime: await this.killswitch.currentRuntimeValue(), enabled: await this.killswitch.isAutoDispatchEnabled()};
  }

  /** Dispatch Inspector — LIST every auto-dispatch request + its current state (any admin, read-only). */
  @Get('requests')
  listRequests(@Query('status') status?: string, @Query('limit') limit?: string) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.dispatch.listDispatchRequests(status, n);
  }

  /** Dispatch Inspector — full lifecycle DETAIL of one request (offer cascade, crew, escrow,
   *  mission, merged timeline). 404 when the booking does not exist. Any admin, read-only. */
  @Get('requests/:id')
  async getRequest(@Param('id', ParseUUIDPipe) id: string) {
    const detail = await this.dispatch.getDispatchRequestDetail(id);
    if (!detail) {
      throw new NotFoundException('booking_not_found');
    }
    return detail;
  }

  @Post('test')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  fireTest(@Body() dto: FireTestDispatchDto, @Req() req: OpsReq) {
    return this.dispatch.fireTestDispatch(req.admin.user_id, dto);
  }

  /** Step 26 — SUPERVISOR override: cancel a stuck DISPATCHING booking (409 if it already
   *  moved on). Attributable: writes an `ops_audit` row with the acting admin. */
  @Post(':bookingId/cancel')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  async cancel(@Param('bookingId') bookingId: string, @Req() req: OpsReq) {
    const result = await this.dispatch.adminCancel(bookingId);
    if (!result.cancelled) {
      throw new ConflictException('not_cancellable'); // no longer DISPATCHING
    }
    await this.audit.recordAdmin(req.admin, 'dispatch.cancel', 'booking', bookingId, {override: true});
    return {ok: true, cancelled: true};
  }

  /** Step 26 — SUPERVISOR override: force-assign a stuck booking to its current live offer
   *  (runs the real accept saga incl. escrow charge). 409 if no live offer to bind. */
  @Post(':bookingId/force-assign')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  async forceAssign(@Param('bookingId') bookingId: string, @Req() req: OpsReq) {
    const res = await this.dispatch.adminForceAssign(bookingId);
    await this.audit.recordAdmin(req.admin, 'dispatch.force_assign', 'booking', bookingId, {
      override: true, provider_user_id: res.provider_user_id,
    });
    return {ok: true, ...res};
  }

  /** Step 26 — ADMIN-only runtime kill switch flip (Redis `dispatch:enabled`). Stops/starts
   *  NEW auto-offers; never touches in-flight escrow. Attributable. */
  @Put('killswitch')
  @RequireRoles('ADMIN')
  async setKillswitch(@Body() dto: KillswitchDto, @Req() req: OpsReq) {
    await this.killswitch.setEnabled(dto.enabled);
    await this.audit.recordAdmin(req.admin, 'dispatch.killswitch', 'system', 'global', {enabled: dto.enabled});
    return {ok: true, enabled: await this.killswitch.isAutoDispatchEnabled()};
  }
}
