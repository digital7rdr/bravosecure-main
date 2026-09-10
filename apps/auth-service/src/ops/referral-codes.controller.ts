import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {ReferralCodesService} from './referral-codes.service';
import {CreateReferralCodeDto, SetReferralCodeActiveDto} from './dto/ops.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Issue 28 — partner / referral code management. Listing is open to any
 * admin (read-only); minting and (de)activation follow the config-surface
 * gate (SUPERVISOR/ADMIN, same as subscription pricing).
 */
@Controller('ops/referral-codes')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class ReferralCodesController {
  constructor(private readonly codes: ReferralCodesService) {}

  @Get()
  list() {
    return this.codes.list();
  }

  @Post()
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateReferralCodeDto, @Req() req: OpsReq) {
    return this.codes.create(req.admin, dto);
  }

  @Patch(':id/active')
  @HttpCode(200)
  @RequireRoles('SUPERVISOR', 'ADMIN')
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReferralCodeActiveDto,
    @Req() req: OpsReq,
  ) {
    return this.codes.setActive(req.admin, id, dto.active);
  }
}
