import {Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards, UseInterceptors} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {ProtectionService} from './protection.service';
import {LocationBatchDto, ReadinessDto, SessionNoteDto} from './dto/protection.dto';

/**
 * CPO protection surface (spec §6). Same guard chain as the PMC mission-code
 * gate (JwtAuthGuard + CpoSessionGuard — a suspended/removed managed CPO is
 * ejected). Every method is scoped in the service to `cpo_user_id = caller`, so
 * a CPO can never read another CPO's customers or sessions (§9). Location reads
 * write protection_access_audit.
 */
@Controller('agents/me/protection')
@UseGuards(JwtAuthGuard, CpoSessionGuard)
export class ProtectionCpoController {
  constructor(private readonly protection: ProtectionService) {}

  /** Assigned customers today + any live session (status, last-fix age, SOS). */
  @Get('overview')
  overview(@CurrentUser() user: AccessClaims) {
    return this.protection.cpoOverview(user.sub);
  }

  /** Mission history — this officer's past + present sessions (paginated). */
  @Get('history')
  history(
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.cpoHistory(user.sub, Number(limit) || 20, before);
  }

  /** Full operational timeline for a session the officer owns. */
  @Get('sessions/:id/timeline')
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.cpoTimeline(user.sub, id, Number(limit) || 50, before ? Number(before) : undefined);
  }

  /** Full live view of one session (customer, latest fix + age, trail). Audited. */
  @Get('sessions/:id')
  session(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.protection.cpoSessionDetail(user.sub, id);
  }

  /** Poll-fallback trail (WS is primary). Audited. */
  @Get('sessions/:id/locations')
  locations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('since') since: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.cpoSessionLocations(user.sub, id, since);
  }

  /**
   * Officer reports THEIR device's location capability. Clears the "Mission Not
   * Ready" gate on the CPO side; the mission still waits until the customer is
   * ready too, and a mid-mission revocation is reported here as well.
   */
  @Post('sessions/:id/readiness')
  readiness(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadinessDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.reportReadiness(user.sub, id, 'cpo', dto);
  }

  /** Officer streams THEIR OWN location during a session (subject='cpo') so ops
   *  can render client / CPO / combined maps. */
  @Post('sessions/:id/cpo-ping')
  cpoPing(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationBatchDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.ingestCpoLocations(user.sub, id, dto.fixes);
  }

  /** Officer posts a predefined status / comment (mission update → Ops).
   *  Idempotency-keyed (§6) — retry after a disconnect never duplicates. */
  @Post('sessions/:id/notes')
  @UseInterceptors(IdempotencyInterceptor)
  note(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SessionNoteDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.postCpoNote(user.sub, id, dto.body);
  }

  /** CPO Protect — formally engage protection (idempotent, one-time). */
  @Post('sessions/:id/protect')
  protect(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.protection.cpoActivateProtect(user.sub, id);
  }
}
