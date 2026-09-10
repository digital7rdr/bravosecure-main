import {Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards} from '@nestjs/common';
import {ArrayMaxSize, IsArray, IsString, MaxLength, MinLength} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {WorkspaceService} from './workspace.service';
import {readOrgContextHeader} from './org-context';

/** Just enough of the request to read a header from. */
type RawRequest = {headers?: Record<string, unknown>};

export class UpdateWorkspaceSettingsDto {
  /**
   * The WHOLE hidden set, not a delta. Two admins toggling different cards from
   * stale screens would otherwise interleave into a set neither chose.
   *
   * Unknown values are dropped by the service rather than 400ing here, so an
   * older app that has not learned a new module name can still change the ones
   * it does know. The cap is a denial-of-service floor, not a product limit.
   */
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({each: true})
  hiddenModules!: string[];
}

/**
 * PDF checklist line 9 - "Admins can choose the names of levels."
 *
 * Its OWN dto and its OWN route, deliberately not another optional field on
 * UpdateWorkspaceSettingsDto. That endpoint takes the WHOLE hidden-module set
 * and replaces it; an admin renaming a tier would then have to send the module
 * set too, and an app that forgot would silently un-hide every hidden module.
 * Two independent whole-value replaces, two routes.
 */
export class UpdateLevelNamesDto {
  /**
   * Names indexed by DISPLAY tier: levelNames[0] is what the UI calls L1.
   *
   * At most 4 (MAX_TIER). Blank entries and a short array are legal and mean
   * "use the built-in name for that tier", which is what lets an admin rename
   * L2 alone; an all-blank array clears back to the built-ins entirely. The
   * service re-normalises regardless - this validation is a DoS floor, not the
   * product rule.
   */
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({each: true})
  @MaxLength(24, {each: true})
  levelNames!: string[];
}

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

/**
 * Scope v2 Phase 6 — A5 "Create Org Workspace".
 *
 * WHY THIS IS A SEPARATE CONTROLLER, and not a route on OrgController:
 * `OrgController` sits behind `OrgManagerGuard`, which resolves the caller's org
 * from `org_members`. The entire point of this route is that the caller does not
 * have an org yet, so it could never pass that guard. Same reasoning as
 * `OrgInviteController`.
 *
 * `DeptChatV2Guard` 404s it while the rollout flag is off, matching every other
 * v2 route — the Enterprise onboarding path must not be reachable before the UI
 * that drives it ships.
 *
 * SECURITY: the owner is ALWAYS `user.sub`. There is no owner field on the body,
 * so a caller cannot mint a workspace owned by somebody else.
 */
@Controller('org/workspace')
@UseGuards(JwtAuthGuard, DeptChatV2Guard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateWorkspaceDto, @CurrentUser() user: AccessClaims) {
    return this.workspace.createWorkspace(user.sub, dto.name);
  }

  @Get()
  async mine(@CurrentUser() user: AccessClaims) {
    return {workspace: await this.workspace.myWorkspace(user.sub)};
  }

  /**
   * vs2 item 17b — which modules this workspace hides from its home screen.
   *
   * MEMBER-READABLE on purpose. Members are who the hiding is for; a
   * managers-only read would leave the cards on screen for everyone except the
   * admin who removed them.
   *
   * Not behind `OrgManagerGuard`, so the org is resolved from the caller
   * (owner or active member). No org → empty, which renders as "show
   * everything" — the same fail-open the whole feature is built on.
   */
  @Get('settings')
  async settings(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    const ctx = await this.workspace.resolveOrgContext(user.sub, readOrgContextHeader(req));
    if (!ctx) {return {orgUserId: null, hiddenModules: [], levelNames: []};}
    return this.workspace.getSettings(ctx.orgUserId);
  }

  /**
   * Change them. MANAGER-ONLY, enforced by re-resolving the caller's manager
   * rights server-side rather than trusting anything on the body.
   *
   * `OrgManagerGuard` is not used here because this controller deliberately
   * sits outside it (see the class docblock — its other routes must serve a
   * caller who has no org yet). The check is therefore explicit.
   */
  @Patch('settings')
  async updateSettings(
    @Body() dto: UpdateWorkspaceSettingsDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: RawRequest,
  ) {
    const orgId = await this.workspace.assertManagerOrg(user.sub, readOrgContextHeader(req));
    return this.workspace.setHiddenModules(orgId, user.sub, dto.hiddenModules);
  }

  /**
   * PDF checklist line 9 - rename the hierarchy tiers. MANAGER-ONLY, resolved
   * server-side exactly like updateSettings above; nothing on the body is
   * trusted to name the org.
   *
   * Presentation only - see the service method and the column comment. This
   * route can never change depth, membership or visibility.
   */
  @Patch('settings/level-names')
  async updateLevelNames(
    @Body() dto: UpdateLevelNamesDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: RawRequest,
  ) {
    const orgId = await this.workspace.assertManagerOrg(user.sub, readOrgContextHeader(req));
    return this.workspace.setLevelNames(orgId, user.sub, dto.levelNames);
  }
}
