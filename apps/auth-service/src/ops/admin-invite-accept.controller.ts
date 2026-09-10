import {Body, Controller, HttpCode, Post} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {AdminInvitesService} from './admin-invites.service';
import {AcceptAdminInviteDto} from './dto/ops.dto';

/**
 * RS-09 — PUBLIC invite redemption. The counterpart of the hard-403'd
 * POST /auth/admin-register/verify stub: instead of self-registration, the
 * invitee presents a single-use token minted by an existing ADMIN. Role,
 * call sign, and email are baked into the invite server-side — the request
 * body can only supply the invitee's own phone + password.
 *
 * Same throttle posture as register/verify: this is an unauthenticated
 * credential-creating endpoint, so it gets the strictest rate limit.
 */
@Controller('auth/admin')
export class AdminInviteAcceptController {
  constructor(private readonly invites: AdminInvitesService) {}

  @Throttle({default: {limit: 10, ttl: 600_000}})
  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptAdminInviteDto) {
    return this.invites.redeemInvite(dto);
  }
}
