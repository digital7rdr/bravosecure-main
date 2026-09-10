import {Body, Controller, Get, Post, Param, ParseUUIDPipe, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard}        from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard}  from '../common/guards/user-throttler.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {SosService} from './sos.service';
import {RaiseSosDto} from './dto/sos.dto';

@Controller('sos')
// Audit fix #12 — guard order matters: JwtAuthGuard runs first so
// req.user is populated, then UserThrottlerGuard tracks per-user.
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class SosController {
  constructor(private readonly sos: SosService) {}

  /**
   * Audit fix 0.7 — wire the dashboard panic button. Throttled per
   * AUTHENTICATED USER (UserThrottlerGuard above), NOT per IP: behind
   * a hotel/corporate/mobile-carrier NAT, dozens of unrelated users
   * share one IP and a real emergency could exhaust the bucket on
   * someone else's behalf. 3 raises per minute per user prevents
   * thumb-spam without rejecting a panicked double-tap.
   */
  @Throttle({default: {limit: 3, ttl: 60_000}})
  @Post('raise')
  raise(
    @Body() dto: RaiseSosDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.sos.raise(user.sub, dto);
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    await this.sos.cancel(user.sub, id);
    return {ok: true};
  }

  /**
   * Audit fix 0.7 (round-trip) — mobile polls this to learn when ops has
   * acknowledged the panic press. Returns the four lifecycle timestamps;
   * `acknowledged_at !== null` is the gate the dashboard waits on before
   * flipping the "Ops Room On Standby" text from pending to confirmed.
   *
   * Scoped to the owning user only — `WHERE user_id = $1 AND id = $2`
   * — so one panicked customer can't probe another customer's SOS.
   */
  @Get(':id/status')
  status(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.sos.status(user.sub, id);
  }
}
