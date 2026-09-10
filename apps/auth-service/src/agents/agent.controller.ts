import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post,
  Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {diskStorage} from 'multer';
import {extname, join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {AgentService} from './agent.service';
import {MissionLeadService} from './mission-lead.service';
import {
  CreateAgentDto, UpdateCompanyDto, UpdateCoverageDto, UpdateAvailabilityDto,
  UploadDocumentDto, UploadKycDocDto, SetDutyDto, SetAgencyProfileDto,
  ApplyToJobDto, KYC_KINDS, type KycKind,
  // Audit P0-V6 — promoted from inline `@Body() body: {...}` interfaces.
  UpdateLocationDto, RaiseSosDto, MarkWaypointDto, PushTelemetryDto, GeoFixDto, VerifyArrivalDto,
} from './dto/agent.dto';

/**
 * Agent Portal REST surface — partner-self endpoints only.
 *
 * SECURITY: this controller is mounted under JwtAuthGuard + CpoSessionGuard.
 * Every route MUST scope to `user.sub` (the calling agent's own user id); a
 * managed CPO whose agency membership ended is ejected before the handler runs.
 * Admin-only mutations against another agent (`/:id/review/*`,
 * `/:id/deploy/signoff`) live on `OpsController` under `AdminGuard +
 * @RequireRoles('SUPERVISOR','ADMIN')`. Do not add `:id`-parameterised
 * mutation routes here — the FSM `actor` argument is not a substitute
 * for transport-level authorization.
 */
@Controller('agents')
// RS-01 — CpoSessionGuard runs AFTER JwtAuthGuard (req.user populated) and
// re-reads the §35A discriminator per request: a managed CPO whose org
// membership is no longer 'active' (suspended/removed) is ejected with
// agency_access_ended; company/individual agents resolve to a non-cpo kind and
// pass through untouched. Does NOT gate on agent_status, so an active-membership
// CPO still onboarding (DOCS_PENDING) keeps access to the upload/submit routes.
@UseGuards(JwtAuthGuard, CpoSessionGuard)
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly lead:   MissionLeadService,
  ) {}

  // 01 — create partner profile
  @Post()
  create(@Body() dto: CreateAgentDto, @CurrentUser() user: AccessClaims) {
    return this.agents.create(user.sub, dto);
  }

  // Read current agent state (used across every screen)
  @Get('me')
  getMe(@CurrentUser() user: AccessClaims) {
    return this.agents.getMe(user.sub);
  }

  // 02 — Company + capabilities
  @Patch('me/company')
  updateCompany(@Body() dto: UpdateCompanyDto, @CurrentUser() user: AccessClaims) {
    return this.agents.updateCompany(user.sub, dto);
  }

  // 03 — KYC kick-off (regulator + DBS lookups run async)
  @Post('me/kyc/start')
  startKyc(@CurrentUser() user: AccessClaims) {
    return this.agents.startKyc(user.sub);
  }

  // 03c — Skip the standalone KYC screen and merge KYC uploads into
  // the compliance pack. Idempotent.
  @Post('me/kyc/skip')
  skipKyc(@CurrentUser() user: AccessClaims) {
    return this.agents.skipKycToDocs(user.sub);
  }

  // 03b — Agent uploads supporting evidence for a KYC slot.
  // Flips the check to `done` so ops sees it on the console.
  @Post('me/kyc/:kind/upload')
  uploadKycDoc(
    @Param('kind') kind: string,
    @Body() dto: UploadKycDocDto,
    @CurrentUser() user: AccessClaims,
  ) {
    if (!(KYC_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`unknown kyc kind ${kind}`);
    }
    return this.agents.uploadKycDoc(user.sub, kind as KycKind, dto);
  }

  // 04 — Coverage toggles
  @Patch('me/coverage')
  updateCoverage(@Body() dto: UpdateCoverageDto, @CurrentUser() user: AccessClaims) {
    return this.agents.updateCoverage(user.sub, dto);
  }

  // 05 — Availability
  @Patch('me/availability')
  updateAvailability(@Body() dto: UpdateAvailabilityDto, @CurrentUser() user: AccessClaims) {
    return this.agents.updateAvailability(user.sub, dto);
  }

  // Generic file upload — used by both the KYC and compliance-pack steps.
  // Saves to <cwd>/uploads/<userId>/<timestamp>-<safeName> and returns the
  // public URL under /uploads (served as static assets in main.ts).
  @Post('me/upload')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (req, _file, cb) => {
        const userId = (req as Express.Request & {user?: AccessClaims}).user?.sub ?? 'anon';
        const dir = join(process.cwd(), 'uploads', userId);
        // A sync throw here is NOT caught by Multer and kills the whole Node
        // process (observed live: root-owned uploads volume → EACCES → 502 +
        // container restart). Always hand the error to cb so a storage failure
        // fails THIS request instead of the process.
        try {
          mkdirSync(dir, {recursive: true});
          cb(null, dir);
        } catch (e) {
          cb(e as Error, dir);
        }
      },
      filename: (_req, file, cb) => {
        const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safe}${safe.includes('.') ? '' : extname(file.originalname || '')}`);
      },
    }),
    limits: {fileSize: 25 * 1024 * 1024},  // 25MB
  }))
  uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AccessClaims,
  ) {
    if (!file) throw new BadRequestException('no_file');
    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3001';
    return {
      file_url: `${base}/uploads/${user.sub}/${file.filename}`,
      filename: file.originalname,
      size: file.size,
    };
  }

  // 06 — Documents
  @Post('me/documents')
  uploadDoc(@Body() dto: UploadDocumentDto, @CurrentUser() user: AccessClaims) {
    return this.agents.uploadDocument(user.sub, dto);
  }

  @Post('me/submit')
  submit(@CurrentUser() user: AccessClaims) {
    return this.agents.submitForReview(user.sub);
  }

  // 07 — Admin review moved to OpsController (`/ops/agents/:id/decide`).
  //      The previous `@Post(':id/review/open')` / `:id/review/decision'`
  //      routes here were guarded only by JwtAuthGuard and let any
  //      agent-JWT holder promote any other agent to ACTIVE. Use the ops
  //      console (AdminGuard + @RequireRoles('SUPERVISOR','ADMIN')).

  // 08 — Dashboard mutations
  @Patch('me/duty')
  setDuty(@Body() dto: SetDutyDto, @CurrentUser() user: AccessClaims) {
    return this.agents.setDuty(user.sub, dto.on_duty);
  }

  // Bug 3 — operating region + DPA acceptance (the dispatch-eligibility inputs with no other UI).
  @Patch('me/agency-profile')
  setAgencyProfile(@Body() dto: SetAgencyProfileDto, @CurrentUser() user: AccessClaims) {
    return this.agents.setAgencyProfile(user.sub, dto);
  }

  @Patch('me/location')
  updateLocation(
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.updateLocation(user.sub, dto.lat, dto.lng, {
      accuracy_m: dto.accuracy_m, speed_kph: dto.speed_kph, is_mocked: dto.is_mocked,
    });
  }

  // PATCH /agents/me/stats was removed — it let any agent inflate their
  // own jobs_total / duty_hours_mtd dashboard counters without doing any
  // missions. Both fields are written server-side now: jobs_total is
  // bumped by `OpsService.completeBooking` on payout, duty_hours_mtd is
  // a future-stamped field. Keep the service method for internal callers
  // (one-off backfills) but no controller route.

  // Published jobs the agent can apply for.
  // Testing affordance — provider region browse of open jobs (LB1 coarse-only).
  // Company (service-provider) agents only; ?region= optional (omit / ALL = every region).
  @Get('me/open-jobs')
  browseOpenJobs(@Query('region') region: string | undefined, @CurrentUser() user: AccessClaims) {
    return this.agents.browseOpenJobs(user.sub, region);
  }

  @Get('me/available-jobs')
  getAvailableJobs(@CurrentUser() user: AccessClaims) {
    return this.agents.getAvailableJobs(user.sub);
  }

  // Agent applies to a published job. Body must carry the dress pledge —
  // ops audits these against the booking's dress_instructions.
  // Idempotency-Key collapses a double-tap onto a single application
  // row so the dress_pledged_at timestamp isn't bumped multiple times.
  @Post('me/jobs/:jobId/apply')
  @UseInterceptors(IdempotencyInterceptor)
  applyToJob(
    @Param('jobId') jobId: string,
    @Body() dto: ApplyToJobDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.applyToJob(user.sub, jobId, dto.dress_pledge);
  }

  // Agent withdraws a pending application.
  @Post('me/jobs/:jobId/withdraw')
  @UseInterceptors(IdempotencyInterceptor)
  withdrawApplication(@Param('jobId') jobId: string, @CurrentUser() user: AccessClaims) {
    return this.agents.withdrawApplication(user.sub, jobId);
  }

  // List all applications the current agent has submitted.
  @Get('me/applications')
  getMyApplications(@CurrentUser() user: AccessClaims) {
    return this.agents.getMyApplications(user.sub);
  }

  // Agent polls for the mission they're currently crewed on (or null).
  // Powers the dashboard "Next on Ops" card + the deep link into the
  // MissionLeadConsole / live tracking screens.
  @Get('me/active-mission')
  getActiveMission(@CurrentUser() user: AccessClaims) {
    return this.agents.getMyActiveMission(user.sub);
  }

  // Agent's completed/aborted mission history (newest first), each row
  // carrying the agent's own payout if one was settled. Powers the
  // "My Missions" history list on the agent app.
  @Get('me/missions')
  getMyMissions(@CurrentUser() user: AccessClaims) {
    return this.agents.getMyMissionHistory(user.sub);
  }

  // Agent polls their own deployment checks for a specific mission.
  @Get('me/missions/:missionId/deployment')
  getMissionDeployment(
    @Param('missionId') missionId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.getMyMissionDeployment(user.sub, missionId);
  }

  @Get('me/jobs/:jobId')
  getJobDetail(@Param('jobId') jobId: string, @CurrentUser() user: AccessClaims) {
    return this.agents.getJobDetail(user.sub, jobId);
  }

  // Mission post-mortem the agent's "recent payouts" rows tap into.
  // Returns the booking + mission essentials (route, distance, duration)
  // plus the agent's own payout details (amount, deduction reason).
  // Gated on `mission_payouts` to ensure only crew who actually got paid
  // for this booking can see the summary.
  @Get('me/payouts/:bookingId/summary')
  getPayoutSummary(
    @Param('bookingId') bookingId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.getPayoutSummary(user.sub, bookingId);
  }

  // Agent acknowledges they're kitted up per the dress instructions.
  @Post('me/missions/:missionId/dress-acknowledge')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  acknowledgeDress(
    @Param('missionId') missionId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.acknowledgeDress(user.sub, missionId);
  }

  // LM-C2 — a crew member self-acknowledges one deploy check
  // (dress/vehicle/equip/briefing); all four gate the lead's Start.
  @Post('me/missions/:missionId/checks/:checkKey/acknowledge')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  acknowledgeDeployCheck(
    @Param('missionId') missionId: string,
    @Param('checkKey') checkKey: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.acknowledgeDeployCheck(user.sub, missionId, checkKey);
  }

  // LM-C4 — any crew member marks themselves in position (not just the lead).
  @Post('me/missions/:missionId/check-in')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  crewCheckIn(
    @Param('missionId') missionId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.crewCheckIn(user.sub, missionId);
  }

  // Executive Protection — the lead confirms an elapsed hour of the protection block
  // ("all smooth" + optional comment). executive missions have no waypoints; this
  // hourly timeline is their progress record (client + agency + ops see it).
  @Post('me/missions/:missionId/hourly-checkin')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  hourlyCheckIn(
    @Param('missionId') missionId: string,
    @Body() body: {hour_index: number; comment?: string},
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.hourlyCheckIn(user.sub, missionId, body?.hour_index as number, body?.comment);
  }

  // LM-C7 — a crew member asks the agency to close the mission (lead
  // unreachable). The agency confirms via POST /org/missions/:id/complete.
  @Post('me/missions/:missionId/request-complete')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  requestComplete(
    @Param('missionId') missionId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.requestComplete(user.sub, missionId);
  }

  // Lead-CPO mission FSM transitions (AGENT actor). Lead-only +
  // idempotency-collapsed. The mission FSM table allows these for the
  // AGENT actor but until now there was no controller route — missions
  // were stuck at DISPATCHED forever until ops manually called
  // /ops/bookings/:id/complete.
  // LM-C3 — each transition may carry the device GPS fix; the server logs a
  // geofence WARNING when it fires far from the pickup/dropoff (never blocks).
  @Post('me/missions/:missionId/pickup')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  missionPickup(
    @Param('missionId') missionId: string,
    @Body() fix: GeoFixDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.missionPickup(user.sub, missionId, fix);
  }

  @Post('me/missions/:missionId/go-live')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  missionGoLive(
    @Param('missionId') missionId: string,
    @Body() fix: GeoFixDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.missionGoLive(user.sub, missionId, fix);
  }

  // Step 16 — the assigned lead reads the on-arrival verify code to confirm identity
  // with the client at handover. Lead-only; matches GET /bookings/:id/verify-code.
  @Get('me/missions/:missionId/verify-code')
  missionVerifyCode(
    @Param('missionId') missionId: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.getMissionVerifyCode(user.sub, missionId);
  }

  // FRAUD-2 / P0 — the assigned lead enters the arrival code the CLIENT's screen
  // shows to prove presence; stamps missions.identity_verified_at, which the
  // proof-of-completion gate requires before escrow may auto-release.
  @Post('me/missions/:missionId/verify-arrival')
  @HttpCode(200)
  verifyArrival(
    @Param('missionId') missionId: string,
    @Body() dto: VerifyArrivalDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.verifyArrival(user.sub, missionId, dto.code);
  }

  @Post('me/missions/:missionId/complete')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  missionComplete(
    @Param('missionId') missionId: string,
    @Body() fix: GeoFixDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.agents.missionComplete(user.sub, missionId, fix);
  }

  // CPO panic button. Crew-membership-checked + idempotent so a frantic
  // multi-tap doesn't multiply SOS rows. The mission FSM moves to SOS
  // and the ops room receives a system post.
  // Issue 41 — the assigned officer accepts or declines. Idempotency-keyed so a
  // double-tap collapses to one write.
  @Post('me/missions/:missionId/respond')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  respondToAssignment(
    @Param('missionId') missionId: string,
    @Body() dto: {action?: string; reason?: string},
    @CurrentUser() user: AccessClaims,
  ) {
    const action = dto?.action === 'decline' ? 'decline' : 'accept';
    return this.agents.respondToAssignment(user.sub, missionId, action, dto?.reason);
  }

  @Post('me/missions/:missionId/sos')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  raiseSos(
    @Param('missionId') missionId: string,
    @Body() dto: RaiseSosDto,
    @CurrentUser() user: AccessClaims,
  ) {
    // Audit P0-V6 — DTO already validated by ValidationPipe (reason
    // length 1-200, lat/lng range when present). Keep the trim() so
    // " " strings the class-validator MinLength(1) lets through still
    // collapse to the right server-side rep.
    return this.agents.raiseSos(user.sub, missionId, {
      reason: dto.reason.trim().slice(0, 200),
      lat: dto.lat,
      lng: dto.lng,
    });
  }

  // Mission lead — manual waypoint mark.
  // Tags: DISPATCH | RECON | PICKUP | DROPOFF
  // Idempotent — retry against the same waypoint converges via the
  // server-side `WHERE state != 'done'` guard but the audit row + the
  // optional auto-fired EN_ROUTE side-effect benefit from collapsing
  // double-taps to a single write.
  @Post('me/missions/:missionId/waypoints/mark')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  markWaypoint(
    @Param('missionId') missionId: string,
    @Body() body: MarkWaypointDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.lead.markWaypoint(user.sub, missionId, body.tag);
  }

  // Mission lead — push GPS telemetry. Auto-fires CHKPT 01 / CHKPT 02
  // based on distance to dropoff.
  @Post('me/missions/:missionId/telemetry')
  @HttpCode(200)
  pushTelemetry(
    @Param('missionId') missionId: string,
    @Body() sample: PushTelemetryDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.lead.pushTelemetry(user.sub, missionId, sample);
  }

  // 09 — Deployment sign-off moved to OpsController
  //      (`POST /ops/missions/:missionId/deployment/signoff`). Same
  //      reason as the review endpoints above — was JWT-guarded only,
  //      allowing any agent to sign off another's deployment.

  // Logout / wipe agent profile entry — terminal cleanup.
  @Delete('me')
  remove(@CurrentUser() _user: AccessClaims) {
    // intentionally unimplemented in MVP — ops deletes via admin console
    return {ok: false, reason: 'not_implemented'};
  }
}
