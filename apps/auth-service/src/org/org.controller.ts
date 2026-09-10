import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {OrgManagerGuard, type OrgManagerContext} from './org-manager.guard';
import {CurrentOrgManager} from './current-org-manager.decorator';
import {OrgCpoService} from './org-cpo.service';
import {OrgMissionService} from './org-mission.service';
import {AgentService} from '../agents/agent.service';
import {CreateManagedCpoDto, SetMemberStatusDto, SetMemberRoleDto, SetManagerPermissionsDto, OrgApplyToJobDto, AssignCrewDto, AddEmployeeDto} from './dto/org.dto';

/**
 * Service-provider org management surface.
 *
 * SECURITY: mounted under JwtAuthGuard + OrgManagerGuard. The guard resolves
 * the caller's org from org_members / the company agent row and stamps
 * req.orgManager — every handler scopes to manager.org_user_id, NOT to a path
 * param, so a manager can only ever touch their own roster. This is a separate
 * trust tier from admin_users (HQ ops) — do not mount ops routes here.
 */
@Controller('org')
@UseGuards(JwtAuthGuard, OrgManagerGuard)
export class OrgController {
  constructor(
    private readonly orgCpo: OrgCpoService,
    private readonly orgMission: OrgMissionService,
    private readonly agents: AgentService,
  ) {}

  // Step 20 — capacity summary for the dashboard "X of Y guards free" strip.
  @Get('summary')
  getSummary(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgCpo.getCapacity(manager.org_user_id);
  }

  // Step 13 — this agency's jobs, grouped needs-crew / active / recent.
  @Get('missions')
  listMissions(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgMission.listMissions(manager.org_user_id);
  }

  // MISSION-HISTORY (#3) — the agency's all-completed-missions list + count.
  // Declared BEFORE the :missionId param route so 'completed' isn't captured as an id.
  @Get('missions/completed')
  listCompletedMissions(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgMission.listCompletedMissions(manager.org_user_id);
  }

  // F6 — the agency earnings roll-up (totals + per-mission escrow splits).
  @Get('earnings')
  getEarnings(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgMission.getEarnings(manager.org_user_id);
  }

  // Step 32 — one mission's live positions (CPO leader + principal) for the org
  // desk monitor. Org-scoped in SQL (owner-org only) so a manager can only watch
  // their own deployment; same response shape as the crew-gated agent read.
  @Get('missions/:missionId/live')
  getMissionLive(
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgMission.getMissionLive(manager.org_user_id, missionId);
  }

  // SP-MISSION-DETAIL (#2nd · Decision §3) — the agency's escrow view for a
  // booking it owns (payout + hold status). Org resolved from the guard; the
  // service tenant-gates the booking (IDOR).
  @Get('bookings/:bookingId/escrow')
  getMissionEscrow(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgMission.getMissionEscrow(manager.org_user_id, bookingId);
  }

  // LM-C7 — the agency confirms a completion when the lead can't (phone died /
  // a crew member requested it). Same money-safe core as the lead Finish: the
  // proof gate + release sweep still stand, so the agency cannot pay itself early.
  @Post('missions/:missionId/complete')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  completeMission(
    @Param('missionId', ParseUUIDPipe) missionId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.agents.completeMissionAsOrg(manager.org_user_id, missionId);
  }

  // Step 13 — crew a CONFIRMED booking: pick guards + a leader → creates the mission.
  // Idempotency-Key required: a double-confirm must yield ONE mission.
  @Post('bookings/:bookingId/crew')
  @UseInterceptors(IdempotencyInterceptor)
  assignCrew(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: AssignCrewDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgMission.assignCrew(manager.org_user_id, manager.user_id, bookingId, dto);
  }

  // Create a managed CPO sub-account under the caller's org.
  @Post('cpos')
  createCpo(
    @Body() dto: CreateManagedCpoDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgCpo.createManagedCpo(manager.org_user_id, dto, manager.user_id);
  }

  // List the caller org's roster.
  @Get('cpos')
  listCpos(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgCpo.listRoster(manager.org_user_id);
  }

  /**
   * M1A rule 16 — enroll an EXISTING app user as an 'employee' of the
   * caller's org (Enterprise individuals run their workspace this way; a
   * provider org may also use it for non-CPO staff). Unlike createCpo this
   * never mints a sub-account and never changes the member's app shell —
   * 'employee' is invisible to the §35A account-kind discriminator.
   */
  @Post('employees')
  @HttpCode(200)
  addEmployee(
    @Body() dto: AddEmployeeDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgCpo.addEmployee(manager.org_user_id, dto.email_or_phone, manager.user_id);
  }

  // MISSION-HISTORY (#3) — a roster CPO's completed-mission call-log. Org is
  // resolved from the guard (never a path param); the service tenant-gates the
  // member against org_members (the IDOR close).
  @Get('cpos/:memberUserId/missions')
  listMemberMissions(
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgCpo.listMemberMissionHistory(manager.org_user_id, memberUserId);
  }

  // Officer profile — identity, compliance, duty state, suspension window and
  // lifetime mission stats in one round-trip. Same IDOR close as /missions.
  @Get('cpos/:memberUserId/profile')
  getMemberProfile(
    @Param('memberUserId', ParseUUIDPipe) memberUserId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    // Issue 39 — pass the VIEWER (not the org) so the access-audit row names
    // the individual manager who opened the officer's profile, not the company.
    return this.orgCpo.getMemberProfile(manager.org_user_id, memberUserId, manager.user_id);
  }

  // Org chart (owner → managers → cpos/employees). Org from the guard.
  @Get('hierarchy')
  getHierarchy(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgCpo.getOrgHierarchy(manager.org_user_id);
  }

  // Apply to a job as the org, naming one of the caller org's CPOs.
  @Post('jobs/:jobId/apply')
  applyToJob(
    @Param('jobId') jobId: string,
    @Body() dto: OrgApplyToJobDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgCpo.applyAsOrg(manager.org_user_id, jobId, {
      cpoUserId: dto.cpo_user_id,
      dressPledge: dto.dress_pledge,
    });
  }

  // Suspend / reinstate / remove a roster member (scoped to caller's org).
  @Patch('cpos/:memberUserId/status')
  @HttpCode(200)
  async setStatus(
    @Param('memberUserId') memberUserId: string,
    @Body() dto: SetMemberStatusDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    const r = await this.orgCpo.setMemberStatus(
      manager.org_user_id, memberUserId, dto.status, manager.user_id,
      {from: dto.suspended_from, until: dto.suspended_until, reason: dto.suspend_reason},
    );
    // B-417 — non-empty when the member holds Ops Room crypto claims that
    // this action strands (see findStrandedRoomClaims); the owner's client
    // surfaces it so the runbook procedure is discoverable at act time.
    return {ok: true as const, member_user_id: memberUserId, status: dto.status,
      stranded_room_claims: r.stranded_room_claims};
  }

  // RS-10 — promote/demote a roster member (cpo/employee ⇄ manager). Owner +
  // unscoped managers (Q7), enforced in the service — the owner is untouchable
  // and a branch-scoped manager is refused; the channel reseed + rekey intents
  // ride along.
  @Patch('cpos/:memberUserId/role')
  @HttpCode(200)
  async setRole(
    @Param('memberUserId') memberUserId: string,
    @Body() dto: SetMemberRoleDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    const r = await this.orgCpo.setMemberRole(
      manager.org_user_id, memberUserId, dto.member_role, manager.user_id, manager.department,
    );
    return {ok: true as const, member_user_id: memberUserId, member_role: r.member_role,
      stranded_room_claims: r.stranded_room_claims};
  }

  // Owner's "Manager Permissions" screen — every manager + their currently
  // granted dashboard modules.
  @Get('managers')
  listManagers(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.orgCpo.listManagers(manager.org_user_id);
  }

  // Owner-only (enforced in the service, mirrors setRole) — replaces the
  // full granted-module set for one manager.
  @Patch('managers/:memberUserId/permissions')
  @HttpCode(200)
  async setManagerPermissions(
    @Param('memberUserId') memberUserId: string,
    @Body() dto: SetManagerPermissionsDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.orgCpo.setManagerPermissions(manager.org_user_id, memberUserId, dto.modules, manager.user_id);
  }
}
