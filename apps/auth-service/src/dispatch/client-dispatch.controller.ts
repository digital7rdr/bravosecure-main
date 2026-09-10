import {
  BadRequestException, Body, Controller, Post, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {BookingService, type ClientBooking} from '../booking/booking.service';
import {DispatchKillswitchService} from '../ops/dispatch-killswitch.service';
import {CreateBookingDto} from '../booking/dto/create-booking.dto';

/**
 * Client-facing auto-dispatch request (BUILD_RUNBOOK Step 19) — the submit path.
 *
 * Ops-gated auto dispatch (product decision): the request NO LONGER starts the
 * matchmaker. It creates the auto booking and submits it to the ops board
 * (PENDING_OPS) for BOTH 'now' and 'later' modes; ops approval
 * (POST /ops/bookings/:id/approve) triggers the offer cascade — immediately for
 * 'now' (via the `dispatch:ops-approved` Redis subscriber) and near pickup for
 * 'later' (ScheduledDispatchService cron). The client polls / receives the
 * booking-approved push and follows the status to DISPATCHING.
 *
 * ⚠️ DARK by default: gated behind AUTO_DISPATCH_ENABLED. Until finance signs off the FX /
 * fee table and the flag flips, this 400s `auto_dispatch_disabled` — no real booking is ever
 * routed into the matchmaker. The affordability soft-check is the CLIENT's responsibility
 * before calling this (route a short balance to the paywall); the authoritative guard
 * remains accept()'s insufficient_credits abort.
 */
@Controller('dispatch')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class ClientDispatchController {
  constructor(
    private readonly bookings: BookingService,
    private readonly config: ConfigService,
    private readonly killswitch: DispatchKillswitchService,
  ) {}

  // Idempotency-Key required: a network-blip retry must not create two auto bookings.
  // Step 23 — per-user throttle on top of the idempotency + one-active-booking guards,
  // so a compromised/abusive client can't hammer the booking pipeline. 5/min is generous
  // given a client can hold one active booking at a time anyway.
  @Throttle({default: {limit: 5, ttl: 60_000}})
  @Post('request')
  @UseInterceptors(IdempotencyInterceptor)
  async request(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<{booking: ClientBooking}> {
    // Step 26 — the runtime kill switch (Redis `dispatch:enabled`) gates the request path
    // on top of the boot-time env flag. OFF ⇒ new auto-offers stop and the client falls
    // back to the legacy booking flow; in-flight escrow/sweeps are untouched.
    if (!(await this.killswitch.isAutoDispatchEnabled())) {
      throw new BadRequestException('auto_dispatch_disabled');
    }
    // Create the auto booking (full pricing/validation/consent via the shared create()).
    // create() submits it DRAFT → PENDING_OPS (audit reason 'submitted_for_ops') for both
    // 'now' and 'later' — nothing to dispatch or roll back here: no matchmaker ran, and the
    // one-active-booking guard inside create() still applies. The client sees PENDING_OPS.
    const {booking} = await this.bookings.create(user.sub, dto, {autoDispatch: true});
    return {booking};
  }
}
