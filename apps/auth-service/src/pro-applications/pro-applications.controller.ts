import {
  Body, Controller, Get, Param, Post, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {ProApplicationsService} from './pro-applications.service';
import {
  CreateProApplicationDto, CreateProMissionDto, ProThreadMessageDto, RequestChangesDto,
} from './dto/pro-application.dto';

@Controller('pro-applications')
@UseGuards(JwtAuthGuard)
export class ProApplicationsController {
  constructor(private readonly proApps: ProApplicationsService) {}

  @Post()
  create(
    @Body() dto: CreateProApplicationDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.create(user.sub, dto);
  }

  @Get('me')
  getMine(@CurrentUser() user: AccessClaims) {
    return this.proApps.getMine(user.sub);
  }

  /** One-tap renewal of an EXPIRED (or REJECTED) plan with its old details. */
  @Post(':id/renew')
  renew(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.renew(user.sub, id);
  }

  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.accept(user.sub, id);
  }

  @Post(':id/request-changes')
  requestChanges(
    @Param('id') id: string,
    @Body() dto: RequestChangesDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.requestChanges(user.sub, id, dto.message);
  }

  /** Pay & activate — the wallet debit and the ACTIVE flip are one txn. */
  @Post(':id/activate')
  @UseInterceptors(IdempotencyInterceptor)
  activate(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.activate(user.sub, id);
  }

  /** Withdraw the application — any pre-activation state (terminal). */
  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.cancel(user.sub, id);
  }

  /** Multi-date protection request inside an ACTIVE plan (owner or member). */
  @Post(':id/missions')
  requestMission(
    @Param('id') id: string,
    @Body() dto: CreateProMissionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.requestMission(user.sub, id, dto.dates, dto.note);
  }

  @Get(':id/missions')
  missions(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.listMissions(user.sub, id);
  }

  /** The plan's live protection team — the ops-assigned dedicated officers. */
  @Get(':id/team')
  team(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.listTeam(user.sub, id);
  }

  @Get(':id/messages')
  messages(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.listMessages(user.sub, id);
  }

  @Post(':id/messages')
  sendMessage(
    @Param('id') id: string,
    @Body() dto: ProThreadMessageDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.proApps.sendMessage(user.sub, id, dto.body);
  }
}
