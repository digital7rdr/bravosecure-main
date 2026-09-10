import {Body, Controller, HttpCode, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgCpoService} from './org-cpo.service';

/**
 * Issue 34 — roster invitation redemption.
 *
 * WHY THIS IS A SEPARATE CONTROLLER. OrgController is mounted under
 * `OrgManagerGuard`, which resolves the caller's org from org_members. The whole
 * point of this route is that the caller is NOT yet on any roster, so it can
 * never pass that guard. It therefore lives here, behind JwtAuthGuard alone.
 *
 * It could not live on AgentController either: OrgModule imports AgentModule, so
 * AgentModule importing OrgModule to reach OrgCpoService would cycle.
 *
 * SECURITY: authenticated as the JOINING user. The route takes no org id — the
 * org is resolved from the CODE, which only a provider can mint, so a caller
 * cannot choose which roster to join by tampering with the request.
 */
@Controller('org/invites')
@UseGuards(JwtAuthGuard)
export class OrgInviteController {
  constructor(private readonly orgCpo: OrgCpoService) {}

  @Post('redeem')
  @HttpCode(200)
  redeem(@Body() dto: {code?: string}, @CurrentUser() user: AccessClaims) {
    return this.orgCpo.redeemInviteCode(user.sub, dto?.code ?? '');
  }
}
