import {Controller, Post, Get, Param, Body, UseGuards, Res} from '@nestjs/common';
import type {Response} from 'express';
import type {Request}  from 'express';
import {Req}           from '@nestjs/common';
import {KeysService}   from './keys.service';
import {JwtAuthGuard}  from '../common/guards/jwt-auth.guard';
import {CurrentUser}   from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {UploadKeysDto} from './dto/upload-keys.dto';
import {clientIp}      from '../common/http/client-ip';

function ip(req: Request): string {
  return clientIp(req);
}

@Controller('auth/keys')
@UseGuards(JwtAuthGuard)
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Post('upload')
  async upload(
    @Body() dto: UploadKeysDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const result = await this.keys.upload(dto, user.sub, user.deviceId, ip(req));
    if (result.poolSize < 10) res.setHeader('X-Pre-Key-Count', String(result.poolSize));
    return result;
  }

  // B-18 — list ALL of a peer's Signal devices (each with its own bundle), for
  // multi-device fan-out. Declared BEFORE the ':userId' route so
  // '/auth/keys/:userId/devices' is matched here, not swallowed as a userId.
  @Get(':userId/devices')
  async fetchDevices(
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
  ) {
    return this.keys.fetchDevices(targetUserId, user.sub, user.deviceId, ip(req));
  }

  @Get(':userId')
  async fetchBundle(
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const {bundle, authoritySig, poolSize} = await this.keys.fetchBundle(targetUserId, user.sub, user.deviceId, ip(req));
    if (poolSize < 10) res.setHeader('X-Pre-Key-Count', String(poolSize));
    // Why: authoritySig must ride at the top level of the response —
    // strict clients (P0-I2 requireBundleBinding) reject the bundle
    // as bundle_authority_sig_missing without it.
    return {...bundle, authoritySig};
  }
}
