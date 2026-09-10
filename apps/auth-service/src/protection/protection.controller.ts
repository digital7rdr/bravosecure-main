import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {ProtectionService} from './protection.service';
import {CreateSessionDto, LocationBatchDto, ReadinessDto, SessionNoteDto} from './dto/protection.dto';

/**
 * Customer protection-session surface (spec §4). Self-access only — every
 * method scopes to the caller (`customer_id = user.sub` in the service, plan
 * access via assertPlanAccess). Location ingest + the CPO/Ops surfaces live in
 * their own controllers.
 */
@Controller('protection')
@UseGuards(JwtAuthGuard)
export class ProtectionController {
  constructor(private readonly protection: ProtectionService) {}

  /** Open a session (or return the existing live one, `already_active`). */
  @Post('sessions')
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AccessClaims) {
    return this.protection.create(user.sub, dto.application_id);
  }

  /** The caller's live session (or 404 no_active_session) + CPO + server clock. */
  @Get('sessions/current')
  current(@CurrentUser() user: AccessClaims) {
    return this.protection.getCurrent(user.sub);
  }

  /**
   * Report this device's location capability. The session only goes ACTIVE once
   * BOTH sides are ready, so this is also how a customer clears the "Protection
   * Setup Required" gate — and how a mid-session revocation is surfaced.
   */
  @Post('sessions/:id/readiness')
  readiness(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadinessDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.reportReadiness(user.sub, id, 'customer', dto);
  }

  /** Stream a batch of the caller's own fixes. First accepted fix flips ACTIVE. */
  @Post('sessions/:id/locations')
  locations(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationBatchDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.ingestLocations(user.sub, id, dto.fixes);
  }

  /** End the caller's session (idempotent). */
  @Post('sessions/:id/end')
  @UseInterceptors(IdempotencyInterceptor)
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.protection.end(user.sub, id);
  }

  /** Session history (times, CPO, SOS flag — no coordinates). Cursor-paginated. */
  @Get('sessions')
  history(
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.listHistory(user.sub, Number(limit) || 20, before);
  }

  /** In-session note thread (customer comments + officer replies). */
  @Get('sessions/:id/notes')
  notes(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.protection.listCustomerNotes(user.sub, id);
  }

  /** Customer posts a predefined option or a free comment (one-way to the officer).
   *  Idempotency-keyed (§6) — a retry after a disconnect returns the first result
   *  instead of creating a duplicate update. */
  @Post('sessions/:id/notes')
  @UseInterceptors(IdempotencyInterceptor)
  postNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SessionNoteDto, @CurrentUser() user: AccessClaims) {
    return this.protection.postCustomerNote(user.sub, id, dto.body);
  }

  /** Mission-history timeline for the customer's own session (internal events filtered). */
  @Get('sessions/:id/timeline')
  timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit: string | undefined,
    @Query('before') before: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.protection.customerTimeline(user.sub, id, Number(limit) || 50, before ? Number(before) : undefined);
  }
}
