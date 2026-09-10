import {Body, Controller, Param, Post, Req, UseGuards} from '@nestjs/common';
import type {Request} from 'express';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {VaultService} from './vault.service';
import {MfaGuard} from './mfa.guard';
import {CreateVaultUploadDto} from './dto/vault-action.dto';

function ipOf(req: Request): string {
  return ((req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()) ?? req.ip ?? 'unknown';
}

/**
 * File Vault endpoints. EVERY route here requires both:
 *   1. A valid access-token (JwtHttpGuard)
 *   2. A fresh MFA-proof action-token (MfaGuard)
 *
 * Upload doesn't strictly need MFA in the Signal spec, but we require
 * it anyway — uploads are rare and enforcing MFA on both sides stops
 * a stolen access-token from silently seeding vault content.
 */
@Controller('vault')
@UseGuards(JwtHttpGuard, MfaGuard)
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post('upload-url')
  async upload(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: CreateVaultUploadDto,
    @Req() req: Request,
  ): Promise<{uploadUrl: string; objectKey: string; expiresAt: number}> {
    return this.vault.createUploadUrl({
      callerUserId:     caller.claims.sub,
      callerAuthDevice: caller.claims.deviceId,
      ip:               ipOf(req),
      contentLength:    dto.contentLength,
      contentType:      dto.contentType,
    });
  }

  @Post('download-url/:key(*)')
  async download(
    @CurrentCaller() caller: CallerContext,
    @Param('key') key: string,
    @Req() req: Request,
  ): Promise<{downloadUrl: string; expiresAt: number}> {
    return this.vault.createDownloadUrl({
      callerUserId:     caller.claims.sub,
      callerAuthDevice: caller.claims.deviceId,
      ip:               ipOf(req),
      objectKey:        key,
    });
  }
}
