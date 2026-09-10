import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard}    from '../common/guards/csrf.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OpsService} from './ops.service';
import {MissionService} from './mission.service';
import {JobFeedService} from './job-feed.service';
import {OpsAuditService} from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import {DepartmentService} from '../department/department.service';
import {ComplianceService} from '../compliance/compliance.service';
import {RejectComplianceDto} from '../compliance/dto/compliance.dto';
import {
  ApproveBookingDto, RejectBookingDto, AgentDecisionDto,
  AbortMissionDto, AckSosDto, EscalateSosDto, ResolveSosDto,
  WaypointProgressDto, OpsListQueryDto,
  DispatchBookingDto, CompleteBookingDto, CancelJobDto, AdjustWalletDto,
  RejectApplicationDto, SelectRouteDto, SignoffMissionDeploymentDto,
  SendMissionMessageDto, TerminateAgentDto, PiiRevealDto, ResolveDisputeDto, ResolveReviewDto,
  RejectArmedDto,
} from './dto/ops.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Bravo Ops Console REST surface. All endpoints JWT-guarded + AdminGuard.
 * Mounted under `/ops`. Consumed by `apps/ops-console` (Next.js).
 */
@Controller('ops')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly missions: MissionService,
    private readonly jobs: JobFeedService,
    private readonly audit: OpsAuditService,
    private readonly systemMsg: SystemMessengerService,
    private readonly departments: DepartmentService,
    private readonly compliance: ComplianceService,
  ) {}

  // ─── Compliance review (Step 15) — verify/reject provider vetting docs ──
  @Get('compliance/pending')
  listPendingCompliance(@Query('region') region?: string) {
    // Ops compliance review is NOT region-bounded — surface every region's
    // pending docs by default (optional ?region= filter), like the dashboard /
    // missions endpoints. Binding req.admin.region here silently orphaned any
    // submission whose region had no same-region admin (e.g. an SA licence
    // invisible to the AE-region admins). verify/reject are by-id, not region-gated.
    return this.compliance.listPending(region || undefined);
  }

  @Post('compliance/:id/verify')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async verifyCompliance(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.compliance.verify(req.admin.user_id, id);
    await this.audit.recordAdmin(req.admin, 'compliance.verify', 'agent', r.subject_user_id, {credential_id: id, doc_type: r.doc_type});
    return r;
  }

  @Post('compliance/:id/reject')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async rejectCompliance(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectComplianceDto, @Req() req: OpsReq) {
    const r = await this.compliance.reject(req.admin.user_id, id, dto.reason);
    // OC-13 — key on the agent (like compliance.verify), not the credential row.
    await this.audit.recordAdmin(req.admin, 'compliance.reject', 'agent', r.subject_user_id, {credential_id: id, reason: dto.reason});
    return r;
  }

  @Post('armed/:id/verify')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async verifyArmed(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.compliance.verifyArmed(req.admin.user_id, id);
    await this.audit.recordAdmin(req.admin, 'compliance.verify_armed', 'agent', r.cpo_user_id, {armed_id: id});
    return r;
  }

  @Post('armed/:id/reject')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async rejectArmed(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectArmedDto, @Req() req: OpsReq) {
    const r = await this.compliance.rejectArmed(req.admin.user_id, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'compliance.reject_armed', 'agent', r.cpo_user_id, {armed_id: id, reason: dto.reason});
    return r;
  }

  // ─── Self / current admin ────────────────────────────────────────
  @Get('me')
  me(@Req() req: OpsReq) {
    return {admin: req.admin};
  }

  // ─── Dashboard ───────────────────────────────────────────────────
  @Get('dashboard')
  dashboard(@Query('region') region?: string) {
    return this.ops.dashboard(region);
  }

  @Get('activity')
  activity(@Query('limit') limit?: string) {
    return this.audit.recentFeed(Number(limit) || 50);
  }

  /**
   * Audit fix 4.2 — click-to-reveal PII audit log. The ops console
   * masks phone/email/address by default; clicking to unmask fires this
   * endpoint so we know which admin viewed which customer's field on
   * which booking/agent/mission. Never returns the value — the value is
   * already in the response that powered the page; this is just the
   * audit signal.
   */
  @Post('audit/pii-reveal')
  async piiReveal(@Body() dto: PiiRevealDto, @Req() req: OpsReq) {
    await this.audit.recordAdmin(req.admin, 'pii.reveal', 'pii', dto.subject, {kind: dto.kind});
    return {ok: true};
  }

  // ─── Bookings ────────────────────────────────────────────────────
  @Get('bookings')
  listBookings(@Query() q: OpsListQueryDto, @Req() req: OpsReq) {
    return this.ops.listBookings(q, req.admin);
  }

  @Get('bookings/:id')
  getBooking(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.ops.getBookingDetail(id, req.admin);
  }

  // Audit AUTH-03 — approve/reject now require SUPERVISOR+, matching the
  // ops-console UI which already hides these from OPS-tier admins (the two
  // layers had drifted: the client gated to SUPERVISOR while the server
  // accepted any admin, making the documented control illusory). approve
  // publishes the job + sets the dress brief and reject kills the booking —
  // meaningful mutations that belong at SUPERVISOR, consistent with
  // dispatch/complete.
  @Post('bookings/:id/approve')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  approveBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveBookingDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.approveBooking(id, req.admin, dto.dress_instructions, dto.notes);
  }

  @Post('bookings/:id/reject')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  rejectBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBookingDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.rejectBooking(id, req.admin, dto.reason, dto.notes);
  }

  @Post('bookings/:id/dispatch')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  dispatchBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchBookingDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.dispatchBooking(id, req.admin, dto);
  }

  @Get('bookings/:id/proposed-payouts')
  getProposedPayouts(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getProposedPayouts(id);
  }

  // Audit fix 1.3 — complete disburses wallet credits to CPOs +
  // optionally accepts per-CPO payout overrides. SUPERVISOR+ only.
  @Post('bookings/:id/complete')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  completeBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteBookingDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.completeBooking(id, req.admin, dto);
  }

  // Step 11 — resolve a disputed escrow hold (final paired split + clawback). The one
  // admin-in-the-loop money point; fail-closed audited. Idempotency-Key required.
  @Post('disputes/:id/resolve')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  resolveDispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.resolveDispute(id, req.admin, dto);
  }

  // MON-2 — release or refund a stranded escrow hold that the proof-of-completion
  // gate sent to review (HELD + review_required). The only operator exit for that
  // state; SUPERVISOR+ only, region-scoped + fail-closed audited, idempotency required.
  @Post('bookings/:id/resolve-review')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  resolveReview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReviewDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.resolveReviewHold(id, req.admin, dto);
  }

  // Audit F-14 — manual BC grant/deduction. SUPERVISOR+ only, reason
  // mandatory; the wallet ledger row + ops_audit row form the trail.
  @Post('wallets/:userId/adjust')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  async adjustWallet(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdjustWalletDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.ops.adjustWallet(req.admin, userId, dto.credits, dto.reason);
    await this.audit.recordAdmin(req.admin, 'wallet.adjust', 'user', userId, {
      credits: dto.credits, reason: dto.reason, transaction_id: r.transaction_id,
    });
    return r;
  }

  // ─── Applicants for a booking (job-application driven dispatch) ───
  @Get('bookings/:id/applicants')
  listBookingApplicants(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.listBookingApplicants(id);
  }

  // ─── Vehicle pool (read-only, for the dispatch picker) ────────────
  @Get('pool/vehicles')
  listAvailableVehicles(@Query('region') region = 'AE') {
    return this.ops.listAvailableVehicles(region);
  }

  // ─── Department Channels (admin oversight) ───────────────────────
  //
  // F12 — paged, but this route STILL RETURNS A BARE ARRAY. The ops console
  // types it as `DepartmentChannelRow[]` (lib/api.ts), so wrapping it in an
  // envelope would break the departments page at runtime for a field nobody
  // asked for. The next page's cursor is the last row's own sort key —
  // `<created_at>|<id>`, both already in the projection — so a paging caller can
  // build it without a new response field.
  @Get('departments')
  async listDepartments(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.departments.listChannelsForOps({
      limit: limit === undefined ? null : Number(limit),
      cursor: cursor ?? null,
    });
    return page.channels;
  }

  // ─── Jobs / Applications ─────────────────────────────────────────
  @Get('jobs')
  listJobs(@Query('status') status?: string) {
    return this.jobs.list(status as never);
  }

  @Get('jobs/:id')
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.getById(id);
  }

  // Audit fix 1.3 — job + application mutations are dispatch-adjacent.
  // shortlist is the lightest (just flips state on PENDING applications)
  // — leave it open to OPS. Cancelling, assigning, rejecting, and
  // dispatching mutate the LIVE crew set so they require SUPERVISOR+.
  @Post('jobs/:id/cancel')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  cancelJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelJobDto,
    @Req() req: OpsReq,
  ) {
    return this.jobs.cancel(id, req.admin, dto.reason);
  }

  @Post('applications/:id/shortlist')
  shortlist(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.jobs.shortlist(id, req.admin);
  }

  @Post('applications/:id/assign')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  assign(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.jobs.assign(id, req.admin);
  }

  @Post('applications/:id/reject')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  rejectApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
    @Req() req: OpsReq,
  ) {
    return this.jobs.reject(id, req.admin, dto.notes);
  }

  /**
   * @deprecated Use `POST /ops/bookings/:id/dispatch` (dispatchBooking).
   *
   * This endpoint creates a mission row at status `DISPATCHED` with no
   * vehicle attached, no Mapbox route precompute, and no comms-channel
   * group. The booking-side dispatch flow does all of that, plus its
   * partial-uniqueness guards prevent the dual-write divergence the two
   * paths used to produce. Kept for backwards compatibility with
   * pre-rollout ops-console builds; remove once usage hits zero.
   */
  @Post('jobs/:id/dispatch')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  dispatchJob(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.jobs.dispatch(id, req.admin);
  }

  // ─── Agents ──────────────────────────────────────────────────────
  @Get('agents')
  listAgents(@Query() q: OpsListQueryDto) {
    return this.ops.listAgents(q);
  }

  @Get('agents/:id')
  getAgent(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getAgentDetail(id);
  }

  // Ops marks a compliance-pack doc as reviewed (called when VIEW is clicked).
  // OC-04 — the reviewed green-tick feeds the approve decision, so it takes the
  // same tier as the decision itself and leaves an audit row.
  @Post('agents/:id/docs/:slot/review')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async reviewDoc(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('slot') slot: string,
    @Req() req: OpsReq,
  ) {
    const res = await this.ops.reviewDocument(id, slot, req.admin.user_id);
    await this.audit.recordAdmin(req.admin, 'agent.doc.review', 'agent', id, {slot});
    return res;
  }

  // Ops marks a KYC check as reviewed (called when VIEW is clicked on KYC panel).
  @Post('agents/:id/kyc/:kind/review')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async reviewKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Req() req: OpsReq,
  ) {
    const res = await this.ops.reviewKycCheck(id, kind, req.admin.user_id);
    await this.audit.recordAdmin(req.admin, 'agent.kyc.review', 'agent', id, {kind});
    return res;
  }

  @Get('agents/:id/stats')
  getAgentStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getAgentStats(id);
  }

  @Post('agents/:id/terminate')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  terminateAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateAgentDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.terminateAgent(id, req.admin, dto.notes);
  }

  @Post('agents/:id/decide')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  decideAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentDecisionDto,
    @Req() req: OpsReq,
  ) {
    return dto.decision === 'APPROVED'
      ? this.ops.approveAgent(id, req.admin, dto.notes)
      : this.ops.rejectAgent(id, req.admin, dto.notes ?? 'no reason given');
  }

  // ─── Missions ────────────────────────────────────────────────────
  @Get('missions')
  listMissions(
    @Query('region') region?: string,
    @Query('status') status?: string,  // 'active' (default) | 'completed'
    @Query('limit')  limit?: string,   // DC-09 — load-more for the completed tab
  ) {
    if (status === 'completed') {
      return this.missions.listClosed(region, Math.min(Number(limit) || 50, 500));
    }
    return this.missions.listActive(region);
  }

  @Get('missions/:id')
  getMission(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.missions.getById(id, req.admin);
  }

  // Deployment checklist for all crew on a mission — used by ops sign-off.
  @Get('missions/:id/deployment')
  getMissionDeployment(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.ops.getMissionDeployment(id, req.admin);
  }

  // Sign off a single deployment check for a crew member on a mission.
  @Post('missions/:id/deployment/signoff')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  signoffMissionDeployment(
    @Param('id', ParseUUIDPipe) missionId: string,
    @Body() dto: SignoffMissionDeploymentDto,
    @Req() req: OpsReq,
  ) {
    return this.ops.signoffMissionDeployment(missionId, dto, req.admin);
  }

  // Audit fix 1.3 — `POST /ops/missions/:id/telemetry` removed.
  // Telemetry pushes belong on the agent surface (`agent.controller.ts:
  // /agents/me/missions/:missionId/telemetry`) where the crew-membership
  // check enforces "the agent is actually on this mission". Letting an
  // ops admin push fake fixes is both wrong (ops doesn't have GPS) and
  // a fraud surface (ops could rewrite a CPO's track).

  @Post('missions/:id/waypoint')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async advanceWaypoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaypointProgressDto,
    @Req() req: OpsReq,
  ) {
    // OC-13 — this mutates the client-visible mission timeline; it now leaves
    // an audit row like every other mission mutation.
    const r = await this.missions.advanceWaypoint(id, dto.seq, dto.state);
    await this.audit.recordAdmin(req.admin, 'mission.waypoint_advance', 'mission', id, {
      seq: dto.seq, state: dto.state,
    });
    return r;
  }

  @Post('missions/:id/abort')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  abortMission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AbortMissionDto,
    @Req() req: OpsReq,
  ) {
    return this.missions.abort(id, req.admin, dto.reason, dto.notes);
  }

  // ─── Re-route picker ─────────────────────────────────────────────

  @Get('missions/:id/route-options')
  getRouteOptions(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.missions.getRouteOptions(id, req.admin);
  }

  @Post('missions/:id/route-select')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  selectRoute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SelectRouteDto,
    @Req() req: OpsReq,
  ) {
    return this.missions.selectRoute(id, dto, req.admin);
  }

  // ─── SOS ─────────────────────────────────────────────────────────

  @Post('sos/:id/ack')
  // AUTHZ-5 — the SOS lane is supervisor-managed (escalate/resolve already require
  // SUPERVISOR+); ack is the lightest of the three and was the only one left open to
  // any admin. Gate it to match, so the whole SOS surface has one authority level.
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  ackSos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AckSosDto,
    @Req() req: OpsReq,
  ) {
    return this.missions.ackSos(id, req.admin, dto.notes);
  }

  @Post('sos/:id/escalate')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  escalateSos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EscalateSosDto,
    @Req() req: OpsReq,
  ) {
    return this.missions.escalateSos(id, req.admin, dto.escalated_to, dto.notes);
  }

  @Post('sos/:id/resolve')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(IdempotencyInterceptor)
  resolveSos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSosDto,
    @Req() req: OpsReq,
  ) {
    return this.missions.resolveSos(id, req.admin, dto.resolution, true);
  }

  // ─── Audit ───────────────────────────────────────────────────────

  @Get('audit/:subject_type/:subject_id')
  subjectAudit(
    @Param('subject_type') subjectType: string,
    @Param('subject_id', ParseUUIDPipe) subjectId: string,
    @Query('limit')        limit?: string,
  ) {
    return this.audit.listForSubject(subjectType as never, subjectId, Number(limit) || 50);
  }

  // ─── System broadcasts (read-only) ──────────────────────────────

  @Get('broadcasts/subject/:subject_type/:subject_id')
  broadcastsForSubject(
    @Param('subject_type') subjectType: string,
    @Param('subject_id', ParseUUIDPipe) subjectId: string,
    @Query('limit')        limit?: string,
  ) {
    return this.systemMsg.listForSubject(subjectType, subjectId, Number(limit) || 50);
  }

  @Get('broadcasts/conversation/:conversation_id')
  broadcastsForConversation(
    @Param('conversation_id', ParseUUIDPipe) conversationId: string,
    @Query('limit')                          limit?: string,
  ) {
    return this.systemMsg.listForConversation(conversationId, Number(limit) || 50);
  }

  // ─── Mission ops-room messaging ──────────────────────────────────
  // Free-form ops → CPO/principal text messages, written into the
  // mission's ops-room conversation as system_broadcasts of kind
  // 'ops_message'. CPOs already render system_broadcasts inline in
  // the messenger, so this lights up on their device automatically.
  @Get('missions/:id/messages')
  async listMissionMessages(@Param('id', ParseUUIDPipe) missionId: string) {
    const m = await this.missions.getMissionRow(missionId);
    if (!m.comms_channel_id) return {messages: []};
    const messages = await this.systemMsg.listForConversation(m.comms_channel_id, 100);
    return {messages, conversation_id: m.comms_channel_id};
  }

  @Post('missions/:id/messages')
  // AUTHZ-5 — injecting a message AS "Ops" into a live mission's ops room carries
  // ops authority to the CPO/principal; gate it like every other mission mutation
  // (route-select, abort, sos escalate/resolve) rather than leaving it any-admin.
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async sendMissionMessage(
    @Param('id', ParseUUIDPipe) missionId: string,
    @Body() dto: SendMissionMessageDto,
    @Req() req: OpsReq,
  ) {
    const text = dto.text.trim();
    if (!text) return {ok: false, reason: 'empty'};
    const m = await this.missions.getMissionRow(missionId);
    if (!m.comms_channel_id) {
      return {ok: false, reason: 'no_ops_room'};
    }
    const adminLabel = req.admin.call_sign || req.admin.role || 'OPS';
    const broadcast = await this.systemMsg.broadcast({
      conversationId: m.comms_channel_id,
      kind: 'ops_message',
      severity: 'info',
      title: `Ops · ${adminLabel}`,
      body: text,
      subject_type: 'mission',
      subject_id: missionId,
      payload: {
        mission_short_code: m.short_code,
        sender_admin_id: req.admin.user_id,
        sender_label: adminLabel,
      },
    });
    await this.audit.record({
      actor_role: req.admin.role,
      actor_id: req.admin.user_id,
      actor_call: adminLabel,
      action: 'mission.ops_message',
      subject_type: 'mission',
      subject_id: missionId,
      metadata: {text_preview: text.slice(0, 80)},
    });
    return {ok: true, id: broadcast.id};
  }
}
