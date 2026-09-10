import {Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {DispatchRoomIntentsService, type DispatchRoomIntent} from './dispatch-room-intents.service';

interface OrgScopedRequest {
  orgManager: OrgManagerContext;
}

/**
 * Agency-facing Ops Room membership-intent endpoints (BUILD_RUNBOOK Step 12). The agency
 * device polls these on dashboard focus, runs the matching Signal rekey on its own device
 * (the room creator/admin holds the group key — the server never does), then acks.
 *
 * Guard order mirrors DispatchController: JwtAuthGuard → req.user, OrgManagerGuard →
 * req.orgManager (the company self OR an active manager of it; 403 otherwise),
 * UserThrottlerGuard rate-limits. Every route is scoped to req.orgManager.org_user_id;
 * the service fuses that org-scope into its SQL (IDOR-safe).
 */
@Controller('dispatch/room-intents')
@UseGuards(JwtAuthGuard, OrgManagerGuard, UserThrottlerGuard)
export class DispatchRoomIntentsController {
  constructor(private readonly intents: DispatchRoomIntentsService) {}

  /** This agency's pending room intents (oldest first). */
  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Get()
  async list(@Req() req: OrgScopedRequest): Promise<{intents: DispatchRoomIntent[]}> {
    return {intents: await this.intents.listRoomIntents(req.orgManager.org_user_id)};
  }

  /** Ack one intent AFTER the agency device has broadcast the rekey. Conditional UPDATE
   *  is the exactly-once + IDOR guard (second ack or cross-org → 404). */
  @Throttle({default: {limit: 60, ttl: 60_000}})
  @Post(':intentId/ack')
  ack(
    @Req() req: OrgScopedRequest,
    @Param('intentId', ParseUUIDPipe) intentId: string,
  ): Promise<{ok: true}> {
    return this.intents.ackRoomIntent(req.orgManager.org_user_id, intentId);
  }

  /** B-416 — atomically claim the room's single E2EE key authority BEFORE
   *  bootstrapping/draining it. First admin device (owner or manager) wins;
   *  everyone else receives the existing claimant and stands down. The
   *  claimant is the CALLER (user_id), not the org. */
  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Post('rooms/:conversationId/claim')
  claim(
    @Req() req: OrgScopedRequest,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<{claimed_by: string}> {
    return this.intents.claimRoomCrypto(
      req.orgManager.org_user_id, req.orgManager.user_id, conversationId);
  }
}
