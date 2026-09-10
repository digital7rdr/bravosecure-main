import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {OpsAuditService} from '../ops/ops-audit.service';
import {DispatchService} from './dispatch.service';
import type {CoarseOfferDto, FullOfferDto} from './dto/offer.dto';
import {RejectOfferDto} from './dto/offer.dto';

interface OrgScopedRequest {
  orgManager: OrgManagerContext;
}

/**
 * Agency-facing offer endpoints (BUILD_RUNBOOK Step 7).
 *
 * Guard order is load-bearing: JwtAuthGuard populates req.user, OrgManagerGuard
 * resolves req.orgManager (the company self OR an active manager of it; 403
 * otherwise), and UserThrottlerGuard rate-limits per authenticated user. Every
 * route is scoped to the caller's resolved org — getCurrentOfferForOrg only
 * reads that org's offer, and accept/reject/getFullOffer 403 on a cross-tenant
 * offer (LB7 IDOR). Pre-accept payloads are COARSE (LB1): no exact location.
 */
@Controller('dispatch/offers')
@UseGuards(JwtAuthGuard, OrgManagerGuard, UserThrottlerGuard)
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly audit: OpsAuditService,
  ) {}

  /** The caller-org's single live offer (or null), COARSE only. */
  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Get('current')
  current(@Req() req: OrgScopedRequest): Promise<CoarseOfferDto | null> {
    return this.dispatch.getCurrentOfferForOrg(req.orgManager.org_user_id);
  }

  /** Precise location — ACCEPTED + owning org only; audited on every read (LB1).
   *  The audit is fail-closed: if dispatch.full_read cannot be recorded, the
   *  record() throw propagates and the coordinates are never returned. */
  @Throttle({default: {limit: 20, ttl: 60_000}})
  @Get(':id/full')
  async full(
    @Req() req: OrgScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FullOfferDto> {
    const dto = await this.dispatch.getFullOffer(req.orgManager.org_user_id, id);
    await this.audit.record({
      actor_id: req.orgManager.user_id, actor_role: 'SYSTEM', action: 'dispatch.full_read',
      subject_type: 'booking', subject_id: dto.booking_id,
      // Record the OWNING ORG too — for a delegated manager the data owner isn't
      // the actor (user_id); a forensic read must attribute to the org.
      metadata: {offer_id: id, org_user_id: req.orgManager.org_user_id},
    });
    return dto;
  }

  /** Accept — tap-safe via IdempotencyInterceptor (header Idempotency-Key); the
   *  authoritative exactly-once is the conditional UPDATE in DispatchService.accept.
   *  The client MUST mint a per-offer key (e.g. `accept:<offerId>`): the interceptor
   *  cache key is actor+method+route-template+key, so reusing one key across offers
   *  would replay the first offer's cached response. */
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':id/accept')
  accept(
    @Req() req: OrgScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{offer_id: string; booking_id: string; status: 'CONFIRMED'}> {
    return this.dispatch.accept(id, req.orgManager.org_user_id);
  }

  /** Decline — cascades to the next-nearest agency. */
  @Throttle({default: {limit: 20, ttl: 60_000}})
  @Post(':id/reject')
  async reject(
    @Req() req: OrgScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectOfferDto,
  ): Promise<{ok: true}> {
    await this.dispatch.reject(id, req.orgManager.org_user_id, body.reason);
    return {ok: true};
  }
}
