import {Controller, Post, Body, UseGuards, Req} from '@nestjs/common';
import type {Request} from 'express';
import {BiometricService}  from './biometric.service';
import {JwtAuthGuard}      from '../common/guards/jwt-auth.guard';
import {CurrentUser}       from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {AssertDto}         from './dto/assert.dto';
import {clientIp}          from '../common/http/client-ip';

@Controller('auth/biometric')
@UseGuards(JwtAuthGuard)
export class BiometricController {
  constructor(private readonly bio: BiometricService) {}

  @Post('assert')
  assert(
    @Body() dto: AssertDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    return this.bio.assert(dto, user.sub, user.deviceId, ip);
  }
}
