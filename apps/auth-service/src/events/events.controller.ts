import {
  Controller, Get, Param, UseGuards, NotFoundException, BadRequestException,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {RedisService} from '../redis/redis.service';

/**
 * A2 OPAQUE-WAKE-NO-CLIENT-CONSUMER — push-wake hydration.
 *
 * Server-driven FCM wakes carry ONLY the opaque {eventId, eventClass} (P0-N8:
 * no bookingId/missionId/kind on the cleartext FCM channel). The device fetches
 * the real detail blob here, over the regular JWT-gated HTTPS channel.
 *
 * The blob was written by BookingPushBridge.publish under a RECIPIENT-BOUND
 * key (`push-event:<userId>:<eventId>`, 5-min TTL), so a caller can only
 * resolve events addressed to THEM — a leaked opaque eventId is useless to any
 * other account. 404 on miss (expired / wrong recipient / never existed); we
 * never distinguish those so existence isn't leaked across accounts.
 */
@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly redis: RedisService) {}

  @Get('by-id/:eventId')
  async byId(
    @Param('eventId') eventId: string,
    @CurrentUser()    user:    AccessClaims,
  ): Promise<Record<string, unknown>> {
    // base64url(16 bytes) = 22 chars; allow a small range defensively.
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(eventId)) {
      throw new BadRequestException('invalid_event_id');
    }
    const raw = await this.redis.client.get(`push-event:${user.sub}:${eventId}`);
    if (!raw) {
      throw new NotFoundException('event_not_found');
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new NotFoundException('event_not_found');
    }
  }
}
