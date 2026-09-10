import {Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}        from '../common/decorators/current-user.decorator';
import type {AccessClaims}  from '../auth/jwt.service';
import {FamilyService}      from './family.service';
import {FamilyQuotaService} from './family-quota.service';
import {
  ApproveCreditDto, InviteMemberDto, RejectCreditDto, ReportLocationDto,
  RequestCreditDto, SetHoldDto, SetSpendLimitDto,
} from './dto/family.dto';

/**
 * Family hierarchy endpoints. JWT-guarded + per-user throttled. Holder ops
 * are scoped to the caller as holder; member ops to the caller as member —
 * no endpoint accepts a foreign user id.
 */
@Controller('family')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class FamilyController {
  constructor(
    private readonly family: FamilyService,
    private readonly quota: FamilyQuotaService,
  ) {}

  // ── Holder side ──
  @Post('invite')
  invite(@Body() dto: InviteMemberDto, @CurrentUser() user: AccessClaims) {
    return this.family.invite(user.sub, dto.phoneE164, dto.spendLimitCredits ?? null, dto.relationship ?? null);
  }

  /**
   * At the 4/4 cap — file an Ops request to raise the linked-member seat limit.
   * Self-serve `invite` stays hard-capped; this is the escape hatch.
   */
  @Post('request-seats')
  requestSeats(@CurrentUser() user: AccessClaims) {
    return this.family.requestSeats(user.sub);
  }

  @Get('members')
  members(@CurrentUser() user: AccessClaims) {
    return this.family.listMembers(user.sub).then(members => ({members}));
  }

  /** Credit-usage breakdown (Claude-token-style): total + per-member + recent. */
  @Get('usage')
  usage(@CurrentUser() user: AccessClaims) {
    return this.family.usage(user.sub);
  }

  /** Itemised per-member spend from the owner's wallet (actor-stamped ledger). */
  @Get('members/:id/spend')
  memberSpend(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.memberSpend(user.sub, id);
  }

  /**
   * Set / clear a member's spending quota (spec §18, §19).
   *
   * `user.sub` is BOTH the holder scope and the audited actor — the route never
   * reads a holder id from the body or the path, so a caller can only ever
   * change a quota inside their own family.
   *
   * Refuses a reduction below the member's already-spent amount with
   * `QUOTA_BELOW_SPENT` + the minimum, which is what §44's confirmation dialog
   * renders.
   */
  @Patch('members/:id/limit')
  setLimit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSpendLimitDto, @CurrentUser() user: AccessClaims) {
    return this.family.setSpendLimit(user.sub, id, dto.spendLimitCredits ?? null, user.sub, dto.reason ?? null);
  }

  /** Append-only quota-change history for one member (spec §37). Holder-scoped. */
  @Get('members/:id/quota-history')
  quotaHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.quota.quotaHistory(user.sub, id).then(history => ({history}));
  }

  // ── Credit requests · holder side (spec §13-§16) ──
  //
  // Every one of these is scoped by `holder_id = user.sub` inside the service,
  // so a holder cannot see or decide another family's requests, and a MEMBER
  // calling them finds nothing to act on (§39: approving your own request is
  // not a permission that exists).

  /** Every credit request across the holder's family, newest first (§43). */
  @Get('credit-requests')
  listRequests(@CurrentUser() user: AccessClaims) {
    return this.quota.listRequests(user.sub).then(requests => ({requests}));
  }

  /** Approve in full, or in part by supplying a smaller `approvedCredits` (§14). */
  @Post('credit-requests/:id/approve')
  approveRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveCreditDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.quota.approveRequest(user.sub, id, dto.approvedCredits ?? null, dto.reason ?? null);
  }

  /** Reject — the member's quota is not touched (§15). */
  @Post('credit-requests/:id/reject')
  rejectRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCreditDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.quota.rejectRequest(user.sub, id, dto.reason ?? null);
  }

  /** Hold / unhold a member (heldUntilIso null lifts the hold). */
  @Patch('members/:id/hold')
  setHold(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetHoldDto, @CurrentUser() user: AccessClaims) {
    return this.family.setHold(user.sub, id, dto.heldUntilIso ?? null);
  }

  @Delete('members/:id')
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.revoke(user.sub, id);
  }

  // ── Member side ──
  @Get('membership')
  membership(@CurrentUser() user: AccessClaims) {
    return this.family.myMembership(user.sub).then(membership => ({membership}));
  }

  /**
   * Member device reports its last fix (foreground, ~10-min cadence). A
   * non-member / held / opted-out caller gets `{reported:false}` — soft, so
   * the client backs off without error noise.
   */
  @Post('location')
  reportLocation(@Body() dto: ReportLocationDto, @CurrentUser() user: AccessClaims) {
    return this.family.reportLocation(user.sub, {lat: dto.lat, lng: dto.lng, accuracyM: dto.accuracyM ?? null});
  }

  // ── Credit requests · member side (spec §11, §12, §17) ──

  /**
   * Ask the holder for more spending credit.
   *
   * The membership is resolved from `user.sub`, so the body carries only an
   * amount and a reason. A second request while one is open is refused with
   * `CREDIT_REQUEST_PENDING` + the open request's id, which is what lets §42's
   * UI show "View Request" instead of a duplicate-creating button.
   */
  @Post('credit-requests')
  requestCredit(@Body() dto: RequestCreditDto, @CurrentUser() user: AccessClaims) {
    return this.quota.requestCredit(user.sub, dto.requestedCredits, dto.reason ?? null)
      .then(request => ({request}));
  }

  /** The member's own request history — own rows only (§39). */
  @Get('credit-requests/mine')
  myRequests(@CurrentUser() user: AccessClaims) {
    return this.quota.myRequests(user.sub).then(requests => ({requests}));
  }

  /**
   * Cancel a PENDING request (§16 holder, §17 member).
   *
   * One route for both sides: the service authorises by PARTICIPATION against
   * the stored row (caller must be its holder or its member) and refuses any
   * non-pending status, so an APPROVED / REJECTED / EXPIRED request can never
   * be cancelled and a cancelled one can never later be approved.
   */
  @Post('credit-requests/:id/cancel')
  cancelRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.quota.cancelRequest(user.sub, id);
  }

  @Get('invites')
  invites(@CurrentUser() user: AccessClaims) {
    return this.family.invitesFor(user.sub).then(invites => ({invites}));
  }

  @Post('invites/:id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.accept(user.sub, id);
  }

  @Post('invites/:id/decline')
  decline(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.decline(user.sub, id);
  }
}
