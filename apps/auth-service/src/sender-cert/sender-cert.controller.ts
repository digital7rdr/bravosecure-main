import {Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {IsInt, IsString, Matches, Min} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {IssueSenderCertDto} from './dto/issue-cert.dto';
import {SenderCertService} from './sender-cert.service';

class RevokeCertDto {
  /** UUID (JWT `jti`). */
  @IsString() @Matches(/^[0-9a-f-]{36}$/i)
  jti!: string;

  /** Remaining TTL in seconds (so Redis can clear after cert would have expired anyway). */
  @IsInt() @Min(1)
  ttlSeconds!: number;
}

@Controller('sender-cert')
export class SenderCertController {
  constructor(private readonly certs: SenderCertService) {}

  /**
   * Mint a cert bound to the caller's identity. JWT-gated.
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  async issue(
    @CurrentUser() user: AccessClaims,
    @Body() dto: IssueSenderCertDto,
  ): Promise<{cert: string; expiresAt: number; jti: string}> {
    return this.certs.issue({
      senderUserId:         user.sub,
      senderSignalDeviceId: dto.senderSignalDeviceId,
      senderIdentityKey:    dto.senderIdentityKey,
    });
  }

  /**
   * Revoke a specific cert by jti. Common flow:
   *   - Device lost → client calls here for every cached outgoing cert jti.
   *   - Key compromise suspected → auth-service admin calls here.
   * Idempotent.
   */
  @UseGuards(JwtAuthGuard)
  @Post('revoke')
  async revoke(
    @CurrentUser() user: AccessClaims,
    @Body() dto: RevokeCertDto,
  ): Promise<{ok: true}> {
    // Auth audit P0-A7 — pass `user.sub` so the service can enforce
    // that only the original issuer can revoke this jti. The previous
    // signature ignored the caller and any authed user could revoke
    // any other user's cert (jtis are visible to receivers and in
    // the public revocation-list — they are not secrets).
    try {
      return await this.certs.revoke(dto.jti, dto.ttlSeconds, user.sub);
    } catch (e) {
      if ((e as Error).message === 'not_owner') {
        throw new ForbiddenException('not_jti_owner');
      }
      throw e;
    }
  }

  /**
   * Nuclear option — revoke ALL outstanding certs for the caller.
   * Called by sign-out flows and the "revoke all sessions" button.
   * Advances a per-user generation counter; clients compare the
   * cert's `iat` against the generation timestamp on verify.
   */
  @UseGuards(JwtAuthGuard)
  @Post('revoke-all')
  @HttpCode(HttpStatus.OK)
  async revokeAll(@CurrentUser() user: AccessClaims): Promise<{newGeneration: number}> {
    return this.certs.revokeAllForUser(user.sub);
  }

  /**
   * PUBLIC endpoint — clients poll this every N minutes to refresh
   * their local revocation cache. Unauthenticated because the list
   * contains only opaque jtis; publishing it leaks nothing beyond
   * "these certs are revoked", which an attacker could determine
   * anyway by trying each cert.
   *
   * Auth audit P0-A7 — throttle hard. The implementation does an
   * unbounded `SCAN MATCH sender-cert:revoked:*` on every call —
   * without a throttle a single curl loop at 1000 RPS drives a
   * Redis-SCAN storm and torches the auth-service. The IP-keyed
   * throttle below trades a small amount of legit client-poll
   * latency for protection against the trivial DoS. Long-term:
   * front this with a CDN-cached 5-minute snapshot.
   */
  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Get('revocation-list')
  async list(): Promise<{jtis: string[]; asOf: number}> {
    return this.certs.revocationList();
  }
}
