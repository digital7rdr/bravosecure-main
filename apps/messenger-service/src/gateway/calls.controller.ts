import {
  Controller, Post, Body, Param, UseGuards, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {IsIn, IsOptional, IsString, MaxLength} from 'class-validator';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {MessengerGateway} from './messenger.gateway';

/**
 * P1-BR-3 — decline body. All fields optional so the slim killed-app
 * bundle-entry handler can post whatever the notification data carried.
 *   peerUserId — the 1:1 ring's originator (from the wake's fromUserId).
 *   kind       — 'direct' (default) or 'group'.
 *   roomId     — group room; falls back to :callId (group wakes reuse
 *                roomId as the callId).
 */
class DeclineCallDto {
  @IsOptional() @IsString() @MaxLength(64)
  peerUserId?: string;

  @IsOptional() @IsIn(['direct', 'group'])
  kind?: 'direct' | 'group';

  @IsOptional() @IsString() @MaxLength(128)
  roomId?: string;
}

/** callId / roomId charset — UUIDs + opaque SFU room ids. */
const SAFE_CALL_ID = /^[A-Za-z0-9:_-]{1,128}$/;

/**
 * P1-BR-3 — lightweight authenticated HTTP decline for killed-app rings.
 *
 * A decline pressed on the incoming-call notification of a killed app has no
 * WS and no runtime; without this endpoint the caller rings out the full 45s.
 * The headless handler POSTs here with just the notification data + a JWT.
 *
 * Contract: IDEMPOTENT, always 200 — even when the call is already gone
 * (answered elsewhere, cancelled, expired). The fan-out is best-effort; a 5xx
 * would only make the client retry a decline that cannot succeed any better.
 */
@Controller('calls')
// Audit P0-5 pattern — JwtHttpGuard first so req.caller exists before
// UserThrottlerGuard reads it. Same guard order as the relay endpoints.
@UseGuards(JwtHttpGuard, UserThrottlerGuard)
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(private readonly gateway: MessengerGateway) {}

  @Throttle({default: {limit: 10, ttl: 10_000}})
  @Post(':callId/decline')
  @HttpCode(HttpStatus.OK)
  async decline(
    @CurrentCaller() caller: CallerContext,
    @Param('callId') callId: string,
    @Body() dto: DeclineCallDto,
  ): Promise<{ok: true}> {
    // Malformed id → no-op 200 (idempotent contract; nothing to decline).
    if (!SAFE_CALL_ID.test(callId ?? '')) return {ok: true};
    try {
      await this.gateway.declineCallViaHttp(
        {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
        callId,
        {peerUserId: dto.peerUserId, kind: dto.kind, roomId: dto.roomId},
      );
    } catch (e) {
      // Why: decline must never fail the client — the call may already be gone.
      this.logger.warn(`decline best-effort failed cid=${callId.slice(0, 8)}: ${(e as Error).message}`);
    }
    return {ok: true};
  }
}
