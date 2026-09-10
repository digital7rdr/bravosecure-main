import {Body, Controller, Param, Post, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {IsArray, IsString, IsOptional, ArrayMaxSize, ArrayMinSize, Matches, MaxLength, MinLength} from 'class-validator';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {MediaService} from './media.service';
import {CreateUploadUrlDto} from './dto/upload-url.dto';

/**
 * P0-V5 — sender's grant-registration payload. Each entry is the
 * recipient userId as known to auth-service (the same value carried in
 * the access token's `sub`). Bounded so a malicious caller can't push
 * a 10M-element array; ArrayMaxSize lines up with the service-layer cap.
 */
class RegisterGrantsDto {
  @IsString() @Matches(/^att\/[a-f0-9-]{36}$/)
  objectKey!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1024)
  @IsString({each: true})
  @MinLength(1, {each: true}) @MaxLength(128, {each: true})
  recipientUserIds!: string[];

  // F15 register-grants-envelopeid-400 — the mobile client signature already
  // sends `envelopeId`; without whitelisting it here the global ValidationPipe
  // (forbidNonWhitelisted) 400s the whole request, so grant registration fails
  // and the object silently drops to lax-mode open access. Accept it (optional)
  // so the request validates; it also carries the retract/purge linkage.
  @IsOptional() @IsString() @MaxLength(256)
  envelopeId?: string;
}

/** A10 — sender asks to hard-delete one of their own attachment objects. */
class PurgeMediaDto {
  @IsString() @Matches(/^att\/[a-f0-9-]{36}$/)
  objectKey!: string;
}

/**
 *   POST /media/upload-url         — get a presigned PUT for a new blob
 *   POST /media/download-url/:key  — get a presigned GET for an existing blob
 *   POST /media/grants             — sender registers the recipient set
 *
 * All require Bearer auth + X-Signal-Device-Id. No per-file MFA here —
 * M10 File Vault MFA layers a stricter guard on vault-backed endpoints.
 *
 * P0-V5: download-url now demands `@CurrentCaller`; the service rejects
 * callers absent from the per-object recipient-grant set (strict mode)
 * or admits with a warn-log when no grant set exists yet (lax mode, the
 * default during mobile + ops-console rollout). Flip
 * `MEDIA_REQUIRE_RECIPIENT_GRANT=true` to enforce strictly.
 */
// Media-parity (2026-07-03) — /media/* had NO rate limiting (only the
// relay + backup controllers applied UserThrottlerGuard). Add per-user
// throttling; download-url in particular is now hit on every attachment
// open + TTL-refreshes Redis, so a hostile client could hammer it.
@Controller('media')
@UseGuards(JwtHttpGuard, UserThrottlerGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // Uploads are the most expensive op (they mint a signed PUT); keep it
  // roomy for a legit burst of attachments but bounded.
  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post('upload-url')
  async createUpload(
    @CurrentCaller() caller: CallerContext,
    @Body()          dto:    CreateUploadUrlDto,
  ): Promise<{uploadUrl: string; objectKey: string; expiresAt: number}> {
    return this.media.createUploadUrl({
      contentLength: dto.contentLength,
      contentType:   dto.contentType,
      callerUserId:  caller.claims.sub,
    });
  }

  // Downloads fire on every attachment open (and now refresh the grant
  // TTL), so allow a healthy scroll-through of a media-heavy chat.
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Post('download-url/:key(*)')
  async createDownload(
    @CurrentCaller() caller: CallerContext,
    @Param('key')    key:    string,
  ): Promise<{downloadUrl: string; expiresAt: number}> {
    return this.media.createDownloadUrl(key, caller.claims.sub);
  }

  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Post('grants')
  async registerGrants(
    @CurrentCaller() caller: CallerContext,
    @Body()          dto:    RegisterGrantsDto,
  ): Promise<{ok: true; count: number}> {
    return this.media.registerGrants(dto.objectKey, caller.claims.sub, dto.recipientUserIds);
  }

  // A10 r2-media-never-purged — the SENDER purges their own attachment blob on
  // message retract / disappearing-expiry (the relay can't see the E2E object
  // key, so this is client-initiated). Owner-checked in the service.
  @Post('purge')
  async purge(
    @CurrentCaller() caller: CallerContext,
    @Body()          dto:    PurgeMediaDto,
  ): Promise<{ok: true; purged: boolean}> {
    return this.media.purgeObject(dto.objectKey, caller.claims.sub);
  }
}
