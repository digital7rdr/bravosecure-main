import {
  Body, Controller, Get, Param, Post, Query, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {BookingService, type ClientBooking} from './booking.service';
import {PricingService} from './pricing.service';
import {InvoiceService} from './invoice.service';
import {CreateBookingDto, EstimateBookingDto} from './dto/create-booking.dto';
import {CreateDisputeDto} from './dto/dispute.dto';
import {SubmitRatingDto} from './dto/rating.dto';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly invoices: InvoiceService,
    private readonly pricing: PricingService,
  ) {}

  @Post()
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<{booking: ClientBooking}> {
    return this.bookings.create(user.sub, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AccessClaims,
    @Query('status') status?: string,
    @Query('page') page?: string,
  ): Promise<{bookings: ClientBooking[]; total: number}> {
    const pageNum = page !== undefined && /^\d+$/.test(page) ? Number(page) : undefined;
    return this.bookings.list(user.sub, {status, page: pageNum});
  }

  /**
   * Founder 2026-08-26 — the live service-pricing board (ops-editable), for
   * the client mirror. The apps keep their compiled numbers as the fail-open
   * fallback; at the shipped values this returns exactly those.
   */
  @Get('service-pricing')
  servicePricing() {
    return this.pricing.config().then(cfg => ({pricing: cfg}));
  }

  @Get('add-ons')
  addOns(
    @Query('region') region = 'AE',
  ) {
    return this.bookings.listAddOns(region);
  }

  // Audit fix 3.1 — live CPO availability per region. Drives the Lite
  // ZoneMap/BookingHome screens (replaces the hardcoded REGIONS const).
  @Get('regions/availability')
  regionsAvailability() {
    return this.bookings.listRegionsAvailability();
  }

  @Post('estimate')
  estimate(@Body() dto: EstimateBookingDto) {
    return this.bookings.estimate(dto);
  }

  @Get(':id')
  getById(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<ClientBooking> {
    return this.bookings.getById(user.sub, id);
  }

  @Get(':id/team')
  getTeam(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getTeam(user.sub, id);
  }

  // F1 — the numbered, line-itemised receipt (COMPLETED) or credit note
  // (refunded terminal). Idempotent: issued once, then re-served.
  @Get(':id/invoice')
  getInvoice(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.invoices.getOrCreateForClient(user.sub, id);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.cancel(user.sub, id);
  }

  // Idempotency-Key is required: a network blip retry or a multi-device
  // race must not double-debit the wallet. The interceptor collapses
  // identical-key replays onto the cached first response (24h TTL).
  // Client mints `paywc:<bookingId>` so retries against the same booking
  // converge; a separate retry for a new charge attempt rotates the key.
  @Post(':id/pay-with-credits')
  @UseInterceptors(IdempotencyInterceptor)
  payWithCredits(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.payWithCredits(user.sub, id);
  }

  // Step 11 — client confirms early; releases the escrow to the agency NOW.
  // Idempotency-Key required (a retry must not double-release).
  @Post(':id/confirm-complete')
  @UseInterceptors(IdempotencyInterceptor)
  confirmComplete(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.confirmComplete(user.sub, id);
  }

  // Step 11 — client raises a dispute, freezing the escrow (beats the release sweep).
  @Post(':id/dispute')
  @UseInterceptors(IdempotencyInterceptor)
  dispute(
    @Param('id') id: string,
    @Body() dto: CreateDisputeDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.openDispute(user.sub, id, dto);
  }

  // Step 24 — client rates the agency on a COMPLETED booking; recomputes agents.rating
  // (the dispatch-ranking trust signal). Owner+COMPLETED-only, idempotent (one per booking).
  @Post(':id/rating')
  @UseInterceptors(IdempotencyInterceptor)
  submitRating(
    @Param('id') id: string,
    @Body() dto: SubmitRatingDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.submitRating(user.sub, id, dto);
  }

  // Step 11 — hold state + final split for the receipt/UI (client owner or agency).
  @Get(':id/escrow')
  getEscrow(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getEscrow(user.sub, id);
  }

  // Step 19 — client reads the coarse provider reveal (name/call-sign/★/missions) for the
  // agency that accepted their auto booking. Owner-scoped; no precise location (LB1).
  @Get(':id/provider')
  getProvider(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getProvider(user.sub, id);
  }

  // Step 16 — client reads the on-arrival verify code (HMAC-derived, never stored)
  // to confirm the assigned lead guard's identity at handover. Read → no interceptor.
  @Get(':id/verify-code')
  getVerifyCode(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getVerifyCode(user.sub, id);
  }

  // Step 16 — client escalates a stranded NO_PROVIDER booking to the hotline.
  // Side-channel only (no status flip); idempotency-collapsed so a retry is a no-op.
  @Post(':id/escalate')
  @UseInterceptors(IdempotencyInterceptor)
  escalate(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.escalate(user.sub, id);
  }
}
