import {
  Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {DispatchService} from './dispatch.service';
import {WithdrawBookingDto} from './dto/offer.dto';

interface OrgScopedRequest {
  orgManager: OrgManagerContext;
}

/**
 * Job-Portal marketplace endpoints (JOB_PORTAL_MARKETPLACE_SPEC §2/§3) — the agency-
 * facing pull side of dispatch, complementing the push offers in DispatchController.
 *
 * Same guard stack (order load-bearing): JwtAuthGuard populates req.user,
 * OrgManagerGuard resolves req.orgManager (the company self OR an active manager of
 * it), UserThrottlerGuard rate-limits per user. Both routes act as the resolved org.
 */
@Controller('dispatch')
@UseGuards(JwtAuthGuard, OrgManagerGuard, UserThrottlerGuard)
export class DispatchJobsController {
  constructor(private readonly dispatch: DispatchService) {}

  /** Claim an open booking from the Job Portal — first agency to commit wins; the
   *  loser's re-run resolves to 409 job_taken. Tap-safe via IdempotencyInterceptor;
   *  the client MUST mint a per-booking key (`claim-<bookingId>`). The authoritative
   *  exactly-once is the booking-locked conditional flip in claimOpenBooking. */
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @UseInterceptors(IdempotencyInterceptor)
  @Post('open-jobs/:bookingId/claim')
  claim(
    @Req() req: OrgScopedRequest,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ): Promise<{offer_id: string; booking_id: string; status: 'CONFIRMED'}> {
    return this.dispatch.claimOpenBooking(bookingId, req.orgManager.org_user_id);
  }

  /** Withdraw an accepted-but-uncrewed booking back to the portal (pre-crew only —
   *  409 crew_already_assigned once a live mission exists). Key: `withdraw-<bookingId>`. */
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @UseInterceptors(IdempotencyInterceptor)
  @Post('bookings/:bookingId/withdraw')
  withdraw(
    @Req() req: OrgScopedRequest,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() body: WithdrawBookingDto,
  ): Promise<{booking_id: string; status: 'DISPATCHING'}> {
    return this.dispatch.withdrawBooking(bookingId, req.orgManager.org_user_id, body?.reason);
  }
}
