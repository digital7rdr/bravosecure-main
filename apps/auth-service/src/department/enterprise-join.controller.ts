import {ParseUUIDPipe} from '@nestjs/common';
import {Body, Controller, Get, HttpCode, Param, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {EnterpriseJoinService} from './enterprise-join.service';
import {AcceptInviteDto, CreateMemberInviteDto, CreateReferralLinkDto, SubmitJoinRequestDto} from './dto/join.dto';

/**
 * Enterprise join → approve loop (M5 / M11A / A11).
 *
 * ── WHY THIS IS NOT ON DepartmentController ─────────────────────────────────
 *
 * That controller is `@UseGuards(JwtAuthGuard, DeptChatAccessGuard)` at class
 * level, and DeptChatAccessGuard's whole job is to admit only people who ALREADY
 * belong to an org. An applicant is by definition not one yet — putting the
 * join routes there would make it impossible to ask to join, which is the
 * feature. So the applicant-facing routes take JwtAuthGuard only: authenticated,
 * but no membership required.
 *
 * That is not a weaker gate, because these routes expose nothing about an
 * Enterprise. `resolveReferralLink` returns a bare `{valid:false}` for a revoked
 * or expired code (M5: "Expired or revoked links show a safe message without
 * exposing organisation data"), and `myJoinRequest` returns only the caller's
 * own application. The admin routes below add OrgManagerGuard.
 */
@Controller('enterprise')
export class EnterpriseJoinController {
  constructor(private readonly join: EnterpriseJoinService) {}

  // ─── Applicant-facing (authenticated, NOT yet a member) ───────────────────

  /** M5 — "which Enterprise/team am I applying to?" before submitting.
   *  B-413 — the caller's identity rides along so a workspace owner gets the
   *  honest blocked shape instead of a Join button that can only 409. */
  @Get('referral-links/:code')
  @UseGuards(JwtAuthGuard)
  resolveLink(@CurrentUser() user: AccessClaims, @Param('code') code: string) {
    return this.join.resolveReferralLink(code, user.sub);
  }

  /** M5 — Submit Request. Creates a pending record and grants nothing. */
  @Post('join-requests')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  submit(@CurrentUser() user: AccessClaims, @Body() dto: SubmitJoinRequestDto) {
    return this.join.submitJoinRequest(user.sub, dto);
  }

  /** M11A — the applicant's own status. */
  @Get('join-requests/me')
  @UseGuards(JwtAuthGuard)
  async mine(@CurrentUser() user: AccessClaims) {
    return {request: await this.join.myJoinRequest(user.sub)};
  }

  // ─── Admin-facing (OrgManagerGuard) ───────────────────────────────────────
  //
  // A11: "Members never create channels, appoint Admins or approve join
  // requests" (page 10 rule 2) — so every route below is manager-gated.

  @Post('referral-links')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  createLink(@CurrentOrgManager() mgr: OrgManagerContext, @Body() dto: CreateReferralLinkDto) {
    return this.join.createReferralLink(mgr.org_user_id, mgr.user_id, dto);
  }

  /**
   * vs2 item 2 (P2-d) — members whose channel seed did not complete.
   *
   * `seed_pending_at` is set inside the approval transaction and cleared by the
   * seeder on success. Without a reader it is the same silence in a new place:
   * the Approvals screen lists PENDING requests and these are settled, and
   * listMemberInvites is capped at 100 rows ordered open-first, so a settled
   * row falls off it immediately in any busy org.
   */
  @Get('seed-pending')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  async seedPending(@CurrentOrgManager() mgr: OrgManagerContext) {
    return {members: await this.join.listSeedPending(mgr.org_user_id, mgr.department)};
  }

  /** The VERB for the listing above. Idempotent; safe to press twice. */
  @Post('seed-pending/:userId/reseed')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  async reseed(
    @CurrentOrgManager() mgr: OrgManagerContext,
    // ParseUUIDPipe, not a bare string: a malformed id would otherwise reach
    // Postgres and surface as a 500 (pinned by the workspace invariant suite).
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.join.reseedMember(mgr.org_user_id, mgr.department, userId);
  }

  @Get('join-requests')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  async pending(@CurrentOrgManager() mgr: OrgManagerContext) {
    // mgr.department is a FORCED FILTER (its own doc comment says so, and
    // attendance + incidents both apply it). Dropping it let a
    // department-scoped manager see and act on branches they do not govern.
    return {requests: await this.join.listPendingRequests(mgr.org_user_id, mgr.department)};
  }

  @Get('referral-links')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  async links(@CurrentOrgManager() mgr: OrgManagerContext) {
    return {links: await this.join.listReferralLinks(mgr.org_user_id)};
  }

  /** Page 10 rule 2 — "revocable invitation tokens". */
  @Post('referral-links/:code/revoke')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  @HttpCode(200)
  revoke(@CurrentOrgManager() mgr: OrgManagerContext, @Param('code') code: string) {
    return this.join.revokeReferralLink(mgr.org_user_id, mgr.user_id, code);
  }

  /** A11 — "Admin decision actions are exactly Approve or Decline." Two routes,
   *  no free-text status field, so no third state can be invented by a caller. */
  @Post('join-requests/:id/approve')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  @HttpCode(200)
  approve(@CurrentOrgManager() mgr: OrgManagerContext,
          @Param('id', ParseUUIDPipe) id: string) {
    return this.join.decideJoinRequest(mgr.org_user_id, mgr.user_id, id, 'approved', mgr.department);
  }

  @Post('join-requests/:id/decline')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  @HttpCode(200)
  decline(@CurrentOrgManager() mgr: OrgManagerContext,
          @Param('id', ParseUUIDPipe) id: string) {
    return this.join.decideJoinRequest(mgr.org_user_id, mgr.user_id, id, 'declined', mgr.department);
  }

  // ─── Item E — member invites by phone/email ───────────────────────────────
  //
  // Admin mint/list/revoke are manager-gated; /me and /accept are
  // invitee-facing (JwtAuthGuard only, same reasoning as the applicant routes:
  // an invitee is by definition not a member yet, and neither route exposes
  // anything not addressed to the caller or bound to code possession).

  /** The caller's own open invites (matched on verified phone / account email). */
  @Get('invites/me')
  @UseGuards(JwtAuthGuard)
  async myInvites(@CurrentUser() user: AccessClaims) {
    return {invites: await this.join.myInvites(user.sub)};
  }

  /** Accept an invite — auto-approve, membership granted in one transaction. */
  @Post('invites/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  acceptInvite(@CurrentUser() user: AccessClaims, @Body() dto: AcceptInviteDto) {
    return this.join.acceptInvite(user.sub, dto.code);
  }

  @Post('invites')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  createInvite(@CurrentOrgManager() mgr: OrgManagerContext, @Body() dto: CreateMemberInviteDto) {
    // mgr.department is the FORCED branch scope — the service refuses admin
    // grants and out-of-branch teams for scoped minters.
    return this.join.createMemberInvite(mgr.org_user_id, mgr.user_id, mgr.department, dto);
  }

  @Get('invites')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  async listInvites(@CurrentOrgManager() mgr: OrgManagerContext) {
    return {invites: await this.join.listMemberInvites(mgr.org_user_id, mgr.department)};
  }

  @Post('invites/:code/revoke')
  @UseGuards(JwtAuthGuard, OrgManagerGuard)
  @HttpCode(200)
  revokeInvite(@CurrentOrgManager() mgr: OrgManagerContext, @Param('code') code: string) {
    return this.join.revokeMemberInvite(mgr.org_user_id, mgr.user_id, code, mgr.department);
  }
}
