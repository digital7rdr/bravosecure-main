import {
  BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {SkipThrottle} from '@nestjs/throttler';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {OptionalIdempotencyInterceptor} from '../common/interceptors/optional-idempotency.interceptor';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {WalletService, type WalletBalance, type WalletTransaction, type TopUpResult, type SavedCard} from './wallet.service';
import {StripeClient} from './stripe.client';
import {TopUpDto, RedeemPromoDto} from './dto/wallet.dto';

/**
 * Wallet REST surface (all routes under /wallet).
 *
 * Webhook sits at POST /wallet/stripe-webhook and is public — it relies on
 * HMAC signature verification instead of JWT auth.
 */
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly stripe: StripeClient,
  ) {}

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  async getBalance(@CurrentUser() user: AccessClaims): Promise<WalletBalance> {
    return this.wallet.getBalance(user.sub);
  }

  /** Active credit batches with expiry — powers the mobile Balance tab (audit F-06). */
  @Get('credits/batches')
  @UseGuards(JwtAuthGuard)
  async listBatches(@CurrentUser() user: AccessClaims) {
    return this.wallet.listBatches(user.sub);
  }

  @Get('transactions')
  @UseGuards(JwtAuthGuard)
  async listTransactions(
    @CurrentUser() user: AccessClaims,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{transactions: WalletTransaction[]}> {
    const parsedLimit  = Math.min(Math.max(Number(limit)  || 50, 1), 200);
    const parsedOffset = Math.max(Number(offset) || 0, 0);
    const transactions = await this.wallet.listTransactions(user.sub, parsedLimit, parsedOffset);
    return {transactions};
  }

  // Audit Rev2 API-04 — OPTIONAL idempotency: a build that sends an
  // Idempotency-Key gets double-charge replay protection (a dropped-connection
  // retry / double-tap replays the first response instead of minting a second
  // PaymentIntent); an older build with no header is unaffected. The STRICT
  // interceptor would 400 every current client, so it must be the optional one.
  @Post('topup')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(OptionalIdempotencyInterceptor)
  async topUp(
    @CurrentUser() user: AccessClaims,
    @Body() dto: TopUpDto,
  ): Promise<TopUpResult> {
    return this.wallet.topUp(user.sub, {
      amount: dto.amount,
      currency: dto.currency,
      creditsHint: dto.credits_hint,
    });
  }

  /**
   * Client-confirm: the mobile app calls this after PaymentSheet reports
   * success. We re-verify the intent against Stripe's API (so the client
   * can't lie), then settle the pending ledger row + credit BC. Belt-and-
   * braces for envs where the webhook can't reach us.
   */
  @Post('topup/confirm')
  @UseGuards(JwtAuthGuard)
  async confirmTopUp(
    @CurrentUser() user: AccessClaims,
    @Body() body: {intent_id?: string},
  ) {
    if (!body?.intent_id || typeof body.intent_id !== 'string') {
      throw new BadRequestException('intent_id required');
    }
    return this.wallet.confirmIntent(user.sub, body.intent_id);
  }

  @Post('redeem-promo')
  @UseGuards(JwtAuthGuard)
  async redeemPromo(
    @CurrentUser() user: AccessClaims,
    @Body() dto: RedeemPromoDto,
  ): Promise<{credits_awarded: number; balance: WalletBalance}> {
    return this.wallet.redeemPromo(user.sub, dto.code);
  }

  // ── Saved cards (Payment Methods) ─────────────────────────────────────────

  @Get('payment-methods')
  @UseGuards(JwtAuthGuard)
  async listCards(@CurrentUser() user: AccessClaims): Promise<{cards: SavedCard[]}> {
    return this.wallet.listCards(user.sub);
  }

  /** Returns a SetupIntent client_secret the app confirms via PaymentSheet. */
  @Post('payment-methods/setup-intent')
  @UseGuards(JwtAuthGuard)
  async cardSetupIntent(@CurrentUser() user: AccessClaims): Promise<{client_secret: string}> {
    return this.wallet.createCardSetupIntent(user.sub);
  }

  @Delete('payment-methods/:id')
  @UseGuards(JwtAuthGuard)
  async removeCard(
    @CurrentUser() user: AccessClaims,
    @Param('id') id: string,
  ): Promise<{removed: true}> {
    return this.wallet.removeCard(user.sub, id);
  }

  @Post('payment-methods/:id/default')
  @UseGuards(JwtAuthGuard)
  async setDefaultCard(
    @CurrentUser() user: AccessClaims,
    @Param('id') id: string,
  ): Promise<{default_id: string}> {
    return this.wallet.setDefaultCard(user.sub, id);
  }

  /**
   * Stripe → server webhook. Must receive the raw body (configured via
   * `rawBody: true` in main.ts). Idempotent: our handler only acts once
   * per intent id.
   */
  // Audit Rev2 API-01 — never throttle the webhook: Stripe delivers from a
  // small egress IP set (one bucket), and a 429 makes Stripe retry for 3 days,
  // which also voids the API-06 dedupe. HMAC signature verification is the gate.
  @SkipThrottle()
  @Post('stripe-webhook')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: Request & {rawBody?: Buffer},
    @Headers('stripe-signature') signature?: string,
  ): Promise<{received: true}> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const event = this.stripe.verifyWebhook(raw, signature);
    await this.wallet.handleStripeEvent(event);
    return {received: true};
  }
}
