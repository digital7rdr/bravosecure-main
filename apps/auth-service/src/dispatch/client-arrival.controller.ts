import {Controller, Param, Post, UseGuards, UseInterceptors} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {BookingService} from '../booking/booking.service';
import {SosService} from '../sos/sos.service';

/**
 * Client-facing arrival/identity-handshake endpoints (BUILD_RUNBOOK Step 16).
 *
 * Lives in DispatchModule rather than BookingModule because `not-my-guard` raises a
 * booking-scoped SOS via SosService, and SosModule → OpsModule → BookingModule would
 * make BookingModule importing SosModule a cycle. DispatchModule already imports
 * BookingModule + OpsModule and nothing imports DispatchModule, so it can import
 * SosModule cycle-free and host this one route. The sibling reads (verify-code,
 * escalate) stay on BookingController — they need no SosService.
 *
 * Route prefix is `bookings` so the client sees a single, consistent
 * `/bookings/:id/...` surface even though this handler is wired in a different module.
 */
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class ClientArrivalController {
  constructor(
    private readonly bookings: BookingService,
    private readonly sos: SosService,
  ) {}

  // Client reports the arriving person is NOT the dispatched guard: stamp the marker
  // then raise a booking-scoped SOS (reason 'not_my_guard') so the crew + ops are
  // alerted. Mutating → Idempotency-Key required so a retry doesn't double-raise.
  @Post(':id/not-my-guard')
  @UseInterceptors(IdempotencyInterceptor)
  async notMyGuard(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true; sos_event_id: string}> {
    await this.bookings.markNotMyGuard(user.sub, id);
    const sos = await this.sos.raise(user.sub, {bookingId: id, reason: 'not_my_guard'});
    return {ok: true, sos_event_id: sos.id};
  }
}
