import {Controller, Get, Post, Body, UseGuards, Req, HttpCode} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import type {Request} from 'express';
import {VaultPinService} from './vault-pin.service';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {clientIp} from '../common/http/client-ip';
import {
  SetVaultPinDto, VerifyVaultPinDto,
  VaultPinResetRequestDto, VaultPinResetVerifyDto, VaultPinResetCompleteDto,
} from './dto/vault-pin.dto';

/**
 * B-696 — vault PIN verifier endpoints (VAULT_DURABILITY_DESIGN §4-§5).
 * All JWT-authed and account-bound (audit S2: no free-text identities
 * anywhere in the reset flow). Throttles mirror /auth/me/password; the
 * per-account Redis lockout inside the service is the real brute-force gate.
 */
@Controller('auth/vault-pin')
@UseGuards(JwtAuthGuard)
export class VaultPinController {
  constructor(private readonly pins: VaultPinService) {}

  @Throttle({default: {limit: 20, ttl: 60_000}})
  @Get()
  status(@CurrentUser() user: AccessClaims) {
    return this.pins.status(user.sub);
  }

  @Throttle({default: {limit: 5, ttl: 60_000}})
  @Post()
  @HttpCode(200)
  set(@Body() dto: SetVaultPinDto, @CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.pins.set(dto, user.sub, user.deviceId, clientIp(req));
  }

  @Throttle({default: {limit: 5, ttl: 60_000}})
  @Post('verify')
  @HttpCode(200)
  verify(@Body() dto: VerifyVaultPinDto, @CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.pins.verify(dto, user.sub, user.deviceId, clientIp(req));
  }

  @Throttle({default: {limit: 3, ttl: 600_000}})
  @Post('reset/request')
  @HttpCode(200)
  resetRequest(@Body() dto: VaultPinResetRequestDto, @CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.pins.resetRequest(dto, user.sub, user.deviceId, clientIp(req));
  }

  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('reset/verify')
  @HttpCode(200)
  resetVerify(@Body() dto: VaultPinResetVerifyDto, @CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.pins.resetVerify(dto, user.sub, user.deviceId, clientIp(req));
  }

  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('reset/complete')
  @HttpCode(200)
  resetComplete(@Body() dto: VaultPinResetCompleteDto, @CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.pins.resetComplete(dto, user.sub, user.deviceId, clientIp(req));
  }
}
