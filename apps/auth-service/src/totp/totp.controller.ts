import {Controller, Post, Body, UseGuards, HttpCode, Req} from '@nestjs/common';
import type {Request} from 'express';
import {TotpService}       from './totp.service';
import {JwtAuthGuard}      from '../common/guards/jwt-auth.guard';
import {CurrentUser}       from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {TotpVerifyDto}     from './dto/totp-verify.dto';
import {clientIp}          from '../common/http/client-ip';

const ip = clientIp;

@Controller('auth/totp')
export class TotpController {
  constructor(private readonly totp: TotpService) {}

  @UseGuards(JwtAuthGuard)
  @Post('setup')
  setup(@CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.totp.setup(user.sub, user.deviceId, ip(req));
  }

  // Audit Rev2 SEC-02 — this route was UNGUARDED and took `userId` from the
  // body, so a valid 6-digit code plus a leaked UUID minted a full session
  // with no password step: two factors collapsed into one. It is a step-up
  // route, exactly as docs/openapi/bravo-auth-service.yaml already described
  // it ("the second half of a step-up auth flow (bearer + TOTP code)") — the
  // guard makes the code match the contract. The account is taken from the
  // token; passing it in the body is what made the bug possible.
  @UseGuards(JwtAuthGuard)
  @Post('verify')
  @HttpCode(200)
  verify(@CurrentUser() user: AccessClaims, @Body() dto: TotpVerifyDto, @Req() req: Request) {
    return this.totp.verify(user.sub, dto, ip(req));
  }
}
