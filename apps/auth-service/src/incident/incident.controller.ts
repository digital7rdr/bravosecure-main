import {
  Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {readOrgContextHeader} from '../org/org-context';
import {IncidentService} from './incident.service';

/** Just enough of the request to read a header from. */
type RawRequest = {headers?: Record<string, unknown>};
import {
  AddIncidentNoteDto, AssignIncidentDto, AttachIncidentDto, StoreAttachmentKeysDto,
  SubmitIncidentDto, UpdateIncidentStatusDto,
} from './dto/incident.dto';

/**
 * Incident reporting (Dept Chat v2). Two scopes on one controller:
 *  - Member (JwtAuthGuard): submit + list own incidents.
 *  - Manager (OrgManagerGuard): the org queue + lifecycle (status/assign/note).
 *
 * Whole controller is gated by DeptChatV2Guard (404 when the flag is off).
 * Static routes (`mine`, `queue`) are declared before `:id` so they win.
 */
@Controller('incidents')
@UseGuards(JwtAuthGuard, DeptChatV2Guard)
export class IncidentController {
  constructor(private readonly incidents: IncidentService) {}

  // ── Member ──────────────────────────────────────────────────────
  @Post()
  @HttpCode(201)
  submit(@Body() dto: SubmitIncidentDto, @CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    return this.incidents.submit(user.sub, dto, readOrgContextHeader(req));
  }

  @Get('mine')
  mine(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    // B-610 — scope "my reports" to the org being viewed. Without the header the
    // list filtered by submitter alone, so a member of several orgs saw reports
    // from all of them mixed together. Resolve the org exactly as submit() does.
    return this.incidents.mine(user.sub, readOrgContextHeader(req));
  }

  // ── Manager (org-scoped) ────────────────────────────────────────
  // A department-scoped manager's queue/detail are FORCED to their department
  // (PDF p.9/p.16); an unscoped manager may narrow via the department filter.
  @Get('queue')
  @UseGuards(OrgManagerGuard)
  queue(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('category') category?: string,
    @Query('submitter_id') submitterId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('department') department?: string,
  ) {
    return this.incidents.queue(manager.org_user_id, {
      status, severity, category, submitterId, from, to,
      department: manager.department ?? department,
    });
  }

  @Get(':id')
  @UseGuards(OrgManagerGuard)
  detail(@Param('id') id: string, @CurrentOrgManager() manager: OrgManagerContext) {
    return this.incidents.detail(manager.org_user_id, id, manager.department);
  }

  @Patch(':id/status')
  @UseGuards(OrgManagerGuard)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateIncidentStatusDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.incidents.updateStatus(manager.org_user_id, manager, id, dto.to, dto.note);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @UseGuards(OrgManagerGuard)
  assign(
    @Param('id') id: string,
    @Body() dto: AssignIncidentDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.incidents.assign(manager.org_user_id, manager, id, dto.assignee_user_id);
  }

  @Post(':id/note')
  @HttpCode(200)
  @UseGuards(OrgManagerGuard)
  addNote(
    @Param('id') id: string,
    @Body() dto: AddIncidentNoteDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.incidents.addNote(manager.org_user_id, manager, id, dto.note, dto.internal ?? true);
  }

  // ── Evidence (Step 10) — submitter attaches; submitter OR org manager lists.
  // No OrgManagerGuard here: the service does the dual (submitter|manager) check
  // so the submitter can see their own evidence and a cross-org manager gets 403.
  @Post(':id/attachments')
  @HttpCode(201)
  attach(@Param('id') id: string, @Body() dto: AttachIncidentDto, @CurrentUser() user: AccessClaims) {
    return this.incidents.attach(user.sub, id, dto.storage_key);
  }

  @Get(':id/attachments')
  listAttachments(@Param('id') id: string, @CurrentUser() user: AccessClaims) {
    return this.incidents.listAttachments(user.sub, id);
  }

  // ── Evidence key delivery (Step 10 · E2) ──────────────────────────
  // E2EE: the per-file key is sealed (outer-ECIES) to each recipient device and
  // stored as opaque ciphertext; a viewer fetches + unseals their own blob.
  // Authz lives in the service (submitter stores; submitter|org-manager reads).

  /** Whom the submitter must seal the key to: org managers + the submitter. */
  @Get(':id/recipients')
  recipients(@Param('id') id: string, @CurrentUser() user: AccessClaims) {
    return this.incidents.evidenceRecipients(user.sub, id);
  }

  /** Submitter stores per-recipient-device sealed keys for an attachment they own. */
  @Post(':id/attachments/:attId/keys')
  @HttpCode(201)
  storeKeys(
    @Param('id') id: string, @Param('attId') attId: string,
    @Body() dto: StoreAttachmentKeysDto, @CurrentUser() user: AccessClaims,
  ) {
    return this.incidents.storeAttachmentKeys(user.sub, id, attId, dto.keys);
  }

  /** Viewer (submitter|manager) fetches their own sealed key for THIS device. */
  @Get(':id/attachments/:attId/key')
  getKey(
    @Param('id') id: string, @Param('attId') attId: string,
    @Query('device_id') deviceId: string, @CurrentUser() user: AccessClaims,
  ) {
    return this.incidents.getMyAttachmentKey(user.sub, Number(deviceId), id, attId);
  }
}
