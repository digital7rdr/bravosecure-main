import {BadRequestException, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService, type Tx} from '../database/database.service';
import {StripeClient, type StripeEvent} from './stripe.client';

type TxType   = 'topup' | 'payment' | 'refund' | 'payout' | 'expire' | 'escrow_hold' | 'escrow_refund' | 'escrow_release';
type TxStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

/**
 * Bravo Credits expiry policy. Every minted batch of credits gets a
 * 12-month TTL; the sweep cron expires the batch on the dot and writes
 * an `expire`-typed audit row so users can see why their balance fell.
 *
 * `applyCreditDelta` (positive paths) writes a row into
 * `wallet_credit_batches`; `debitBatchesFifo` walks those rows oldest-
 * expiry-first so about-to-expire credits get used before fresh ones.
 */
const CREDIT_TTL_MONTHS = 12;

interface WalletBalanceRow {
  user_id: string;
  bravo_credits: number;
  currency: string;
  stripe_customer_id: string | null;
  updated_at: Date;
}

interface WalletTxRow {
  id: string;
  user_id: string;
  type: TxType;
  status: TxStatus;
  amount_credits: number;
  amount_fiat_cents: number;
  fiat_currency: string;
  description: string | null;
  booking_id: string | null;
  stripe_intent_id: string | null;
  stripe_client_secret: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  settled_at: Date | null;
}

export interface WalletBalance {
  bravo_credits: number;
  currency: string;
  stripe_customer_id: string | null;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: TxType;
  status: TxStatus;
  amount: number;             // same semantics the mobile store expects
  currency: string;
  description: string;
  booking_id?: string;
  created_at: string;
}

export interface TopUpResult {
  transaction_id: string;
  credits_awarded: number;
  /** Present when Stripe is enabled. */
  client_secret?: string;
  intent_id?: string;
  customer_id?: string;
  /** Present when Stripe is disabled — the client auto-settles locally. */
  fallback?: true;
  balance: WalletBalance;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

@Injectable()
export class WalletService {
  private readonly log = new Logger(WalletService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
    private readonly stripe: StripeClient,
  ) {}

  async getBalance(userId: string, tx?: Tx): Promise<WalletBalance> {
    const q = tx ?? this.db;
    const row = await q.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1`,
      [userId],
    ) ?? await this.ensureBalanceRow(userId);
    return {
      bravo_credits: row.bravo_credits,
      currency: row.currency,
      stripe_customer_id: row.stripe_customer_id,
    };
  }

  /**
   * A user's credit batches for the wallet UI (audit F-06 — the mobile
   * Balance tab renders these with per-batch expiry). Returns active +
   * recently-expired batches, newest first, in the shape the mobile
   * `CreditBatch` type expects. `amount` is the REMAINING credits in the
   * batch (total minus consumed) — that's the number expiry will reclaim.
   */
  async listBatches(userId: string): Promise<Array<{
    id: string;
    label: string;
    booking_id?: string;
    amount: number;
    aed_equivalent: number;
    issued_at: string;
    expires_at: string;
    source: 'booking' | 'topup';
  }>> {
    const rows = await this.db.q<{
      id: string; amount_credits: number; consumed_credits: number;
      issued_at: Date; expires_at: Date; src_type: TxType | null; booking_id: string | null;
    }>(
      `SELECT b.id, b.amount_credits, b.consumed_credits, b.issued_at, b.expires_at,
              t.type AS src_type, t.booking_id
         FROM wallet_credit_batches b
         LEFT JOIN wallet_transactions t ON t.id = b.source_tx_id
        WHERE b.user_id = $1
          AND b.consumed_credits < b.amount_credits
          AND (b.expired_at IS NULL OR b.expired_at > NOW() - INTERVAL '30 days')
        ORDER BY b.expires_at ASC, b.issued_at ASC
        LIMIT 100`,
      [userId],
    );
    return rows.map(r => {
      const remaining = r.amount_credits - r.consumed_credits;
      const issued = new Date(r.issued_at);
      return {
        id: r.id,
        label: issued.toLocaleDateString('en-GB', {month: 'short', year: 'numeric'}),
        booking_id: r.booking_id ?? undefined,
        amount: remaining,
        aed_equivalent: remaining, // 1 BC = 1 currency unit (Phase-1 peg)
        issued_at: issued.toISOString(),
        expires_at: new Date(r.expires_at).toISOString(),
        source: (r.src_type === 'payout' || r.src_type === 'refund') && r.booking_id ? 'booking' : 'topup',
      };
    });
  }

  async listTransactions(userId: string, limit = 50, offset = 0): Promise<WalletTransaction[]> {
    const rows = await this.db.q<WalletTxRow>(
      `SELECT * FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows.map(this.toClientTx);
  }

  // ── Promo codes ───────────────────────────────────────────────────────────

  /**
   * Redeem a promo code → credit BC once per user. The (promo_id, user_id)
   * primary key on promo_redemptions makes the double-redeem guard atomic
   * (a racing second insert conflicts), so a user can't double-credit a code.
   */
  async redeemPromo(userId: string, rawCode: string): Promise<{credits_awarded: number; balance: WalletBalance}> {
    const code = rawCode.trim().toUpperCase();
    if (!code) {throw new BadRequestException('code_required');}

    // One transaction end-to-end (audit F-15): the FOR UPDATE lock makes the
    // max_redemptions check-then-increment atomic (no oversell), and a crash
    // can no longer leave a redemption row without its ledger row / credit.
    return await this.db.withTransaction(async (t: Tx) => {
      const promo = await t.qOne<{
        id: string; credits: number; max_redemptions: number | null;
        redeemed_count: number; expires_at: string | null;
      }>(
        `SELECT id, credits, max_redemptions, redeemed_count, expires_at
           FROM promo_codes WHERE upper(code) = $1 AND active = true
           FOR UPDATE`,
        [code],
      );
      if (!promo) {throw new BadRequestException('invalid_code');}
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {throw new BadRequestException('code_expired');}
      if (promo.max_redemptions !== null && promo.redeemed_count >= promo.max_redemptions) {
        throw new BadRequestException('code_exhausted');
      }

      // Atomic per-user guard: the PK rejects a second redemption by this user.
      try {
        await t.q(
          `INSERT INTO promo_redemptions (promo_id, user_id, credits) VALUES ($1, $2, $3)`,
          [promo.id, userId, promo.credits],
        );
      } catch {
        throw new BadRequestException('already_redeemed');
      }
      await t.q(`UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE id = $1`, [promo.id]);

      const tx = await this.insertTx({
        userId,
        type: 'topup',
        status: 'succeeded',
        amountCredits: promo.credits,
        amountFiatCents: 0,
        fiatCurrency: 'aed',
        description: `Promo code ${code}`,
        metadata: {kind: 'promo', code},
        settledAt: new Date(),
      }, t);
      await this.creditDeltaTx(t, userId, promo.credits, tx.id);
      return {credits_awarded: promo.credits, balance: await this.getBalance(userId, t)};
    });
  }

  /**
   * Ops-initiated manual credit adjustment (audit F-14). Positive `credits`
   * grants BC (ledger `topup` + expiry batch); negative debits (ledger
   * `payment`, insufficient-guarded, FIFO batch consumption). The ledger
   * row's metadata carries the acting admin + mandatory reason — that IS
   * the audit trail. Locked + transactional like every other money path.
   */
  async adjustCredits(
    adminId: string,
    userId: string,
    credits: number,
    reason: string,
  ): Promise<{balance: WalletBalance; transaction_id: string}> {
    const delta = Math.trunc(credits);
    if (!delta) throw new BadRequestException('credits_must_be_nonzero');
    if (!reason?.trim()) throw new BadRequestException('reason_required');
    await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async (t: Tx) => {
      const row = await t.qOne<WalletBalanceRow>(
        `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!row) throw new BadRequestException('wallet_not_found');
      if (delta < 0 && row.bravo_credits < -delta) {
        throw new BadRequestException('insufficient_credits');
      }
      const tx = await this.insertTx({
        userId,
        type: delta > 0 ? 'topup' : 'payment',
        status: 'succeeded',
        amountCredits: delta,
        amountFiatCents: 0,
        fiatCurrency: row.currency,
        description: `Ops adjustment · ${reason.trim()}`,
        metadata: {kind: 'ops_adjustment', admin_id: adminId, reason: reason.trim()},
        settledAt: new Date(),
      }, t);
      await this.creditDeltaTx(t, userId, delta, delta > 0 ? tx.id : undefined);
      this.log.log(`ops wallet adjustment user=${userId} by=${adminId} (${delta > 0 ? '+' : ''}${delta} BC)`);
      return {balance: await this.getBalance(userId, t), transaction_id: tx.id};
    });
  }

  // ── Saved cards (Payment Methods) ─────────────────────────────────────────

  private async getOrCreateCustomer(userId: string): Promise<string> {
    const row = await this.ensureBalanceRow(userId);
    const customerId = await this.stripe.ensureCustomer(userId, row.stripe_customer_id);
    if (customerId !== row.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }
    return customerId;
  }

  /** Client confirms this SetupIntent via PaymentSheet to save a card. */
  async createCardSetupIntent(userId: string): Promise<{client_secret: string}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const si = await this.stripe.createSetupIntent(customerId);
    return {client_secret: si.client_secret};
  }

  async listCards(userId: string): Promise<{cards: SavedCard[]}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const [cards, defaultId] = await Promise.all([
      this.stripe.listCards(customerId),
      this.stripe.getDefaultCardId(customerId),
    ]);
    return {
      cards: cards.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
        is_default: pm.id === defaultId,
      })),
    };
  }

  async removeCard(userId: string, paymentMethodId: string): Promise<{removed: true}> {
    const customerId = await this.getOrCreateCustomer(userId);
    // Only let the user detach a card that belongs to THEIR customer.
    const owned = await this.stripe.listCards(customerId);
    if (!owned.some(pm => pm.id === paymentMethodId)) {
      throw new BadRequestException('card_not_found');
    }
    await this.stripe.detachCard(paymentMethodId);
    return {removed: true};
  }

  async setDefaultCard(userId: string, paymentMethodId: string): Promise<{default_id: string}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const owned = await this.stripe.listCards(customerId);
    if (!owned.some(pm => pm.id === paymentMethodId)) {
      throw new BadRequestException('card_not_found');
    }
    await this.stripe.setDefaultCard(customerId, paymentMethodId);
    return {default_id: paymentMethodId};
  }

  /**
   * Mint a PaymentIntent + write a PENDING ledger row. When Stripe is
   * disabled (no secret key), we still mint the ledger row and settle it
   * immediately — that lets local dev exercise the full flow end-to-end.
   */
  async topUp(userId: string, input: {amount: number; currency: string; creditsHint?: number}): Promise<TopUpResult> {
    if (input.amount <= 0) throw new BadRequestException('amount must be > 0');

    const cents = Math.round(input.amount * 100);
    const credits = this.computeCreditsForFiat(input.amount, input.currency);
    const balanceRow = await this.ensureBalanceRow(userId);

    // ── Stripe disabled → local-only topup. Still writes a real ledger row.
    if (!this.stripe.enabled) {
      // Why: without this gate a prod deploy that loses STRIPE_SECRET_KEY
      // becomes a free money printer (audit F-15). Dev/staging keep the
      // fallback; production requires the explicit env escape hatch.
      const isProd = this.cfg.get<string>('nodeEnv') === 'production';
      if (isProd && process.env['ALLOW_NO_STRIPE_TOPUP'] !== '1') {
        throw new BadRequestException('stripe_disabled');
      }
      return await this.db.withTransaction(async t => {
        const tx = await this.insertTx({
          userId,
          type: 'topup',
          status: 'succeeded',
          amountCredits: credits,
          amountFiatCents: cents,
          fiatCurrency: input.currency,
          description: `Top-up ${credits} BC (fallback / no stripe)`,
          metadata: {fallback: true},
          settledAt: new Date(),
        }, t);
        await this.creditDeltaTx(t, userId, credits, tx.id);
        return {
          transaction_id: tx.id,
          credits_awarded: credits,
          fallback: true as const,
          balance: await this.getBalance(userId, t),
        };
      });
    }

    // ── Stripe enabled → real PaymentIntent, ledger stays PENDING until webhook.
    const customerId = await this.stripe.ensureCustomer(userId, balanceRow.stripe_customer_id);
    if (customerId !== balanceRow.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }

    const intent = await this.stripe.createPaymentIntent({
      amountCents: cents,
      currency: input.currency,
      customerId,
      description: `Bravo Credits top-up · ${credits} BC`,
      metadata: {user_id: userId, credits: String(credits), kind: 'wallet_topup'},
    });

    const tx = await this.insertTx({
      userId,
      type: 'topup',
      status: 'pending',
      amountCredits: credits,
      amountFiatCents: cents,
      fiatCurrency: input.currency,
      description: `Top-up ${credits} BC`,
      metadata: {kind: 'wallet_topup'},
      stripeIntentId: intent.id,
      stripeClientSecret: intent.client_secret,
    });

    return {
      transaction_id: tx.id,
      credits_awarded: credits,
      client_secret: intent.client_secret,
      intent_id: intent.id,
      customer_id: customerId,
      balance: {
        bravo_credits: balanceRow.bravo_credits,
        currency: balanceRow.currency,
        stripe_customer_id: customerId,
      },
    };
  }

  /**
   * Credit BC to a CPO at mission completion (payout from the booking
   * escrow). Pure ledger motion — no Stripe roundtrip. The booking flow
   * computes the per-agent split and calls this once per assigned CPO.
   *
   * Idempotent per (user_id, booking_id) — relies on a partial unique
   * index on `wallet_transactions (user_id, booking_id) WHERE type =
   * 'payout'` (see migration). A retry returns the existing balance
   * unchanged rather than double-crediting. Without the index, only the
   * caller's `withTransaction` + WHERE-status guard in
   * `OpsService.completeBooking` prevents double-credit; if a future
   * code path (refund flow, maintenance script) calls this method
   * outside that guard the agent would be paid twice.
   */
  async creditForBooking(userId: string, bookingId: string, credits: number, description: string): Promise<WalletBalance> {
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const row = await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async tx => {
      // ON CONFLICT DO NOTHING relies on the partial unique index.
      // Inserted row count tells us whether this is a fresh credit or a
      // duplicate retry — only fresh credits bump the balance.
      const inserted = await tx.q<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, '{}'::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [userId, credits, row.currency, description, bookingId],
      );
      if (inserted.length === 0) {
        // Duplicate — return the current balance without crediting.
        return this.getBalance(userId);
      }
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
        [credits, userId],
      );
      // Mint a 12-month-expiry batch so this payout is subject to the
      // same expiry policy as topups. Source-tx links back to the row
      // we just inserted for traceability.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, inserted[0]?.id ?? null, credits],
      );
      return this.getBalance(userId);
    });
  }

  /**
   * Refund BC to a client when a PAID booking is cancelled or aborted
   * (audit C2). Reverses the original `type='payment'` debit for the
   * booking by minting a `type='refund'` credit of the same magnitude.
   *
   * Idempotent per (user_id, booking_id) via the partial unique index
   * `ux_wallet_tx_booking_refund` (scoped to metadata.kind='booking_refund'
   * so it doesn't collide with unrelated refund rows). A second
   * cancel/abort — or a cancel racing an abort — returns the current
   * balance unchanged rather than double-refunding.
   *
   * The refund amount is derived SERVER-SIDE from the original payment
   * ledger row, never from the caller, so a tampered request can't inflate
   * the refund. Returns `{refunded: false}` when there is no captured
   * payment to reverse (free booking, never paid, or already refunded).
   */
  async refundForBooking(
    userId: string,
    bookingId: string,
    description: string,
  ): Promise<{refunded: boolean; credits: number; balance: WalletBalance}> {
    const row = await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async tx => {
      // Sum the client's captured payment debits for this booking. The
      // payWithCredits path writes a single negative `payment` row; we sum
      // defensively in case of split captures. Lock nothing extra — the
      // refund insert's ON CONFLICT is what guarantees at-most-once.
      const paid = await tx.qOne<{debited: string | null}>(
        `SELECT COALESCE(SUM(-amount_credits), 0) AS debited
           FROM wallet_transactions
          WHERE user_id = $1 AND booking_id = $2
            AND type = 'payment' AND status = 'succeeded'
            AND amount_credits < 0`,
        [userId, bookingId],
      );
      const credits = Math.round(Number(paid?.debited ?? 0));
      if (credits <= 0) {
        // Nothing was captured for this booking — nothing to refund.
        return {refunded: false, credits: 0, balance: await this.getBalance(userId)};
      }
      // Ledger actor = the booking's client (the member on a family booking);
      // `userId` is the payer wallet being made whole.
      const b = await tx.qOne<{client_id: string}>(
        `SELECT client_id FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      const actorId = b?.client_id ?? userId;
      const inserted = await tx.q<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5,
                   '{"kind":"booking_refund"}'::jsonb, NOW(), $6, 'booking')
         ON CONFLICT (user_id, booking_id) WHERE type = 'refund' AND booking_id IS NOT NULL AND metadata->>'kind' = 'booking_refund' DO NOTHING
         RETURNING id`,
        [userId, credits, row.currency, description, bookingId, actorId],
      );
      if (inserted.length === 0) {
        // Already refunded (retry or cancel/abort race) — no double credit.
        return {refunded: false, credits: 0, balance: await this.getBalance(userId)};
      }
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
        [credits, userId],
      );
      await this.reverseFamilySpend(tx, actorId, userId, credits, bookingId);
      // Mint a fresh expiry batch for the refunded credits, same as a
      // payout/topup, so they're subject to the normal 12-month TTL.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, inserted[0]?.id ?? null, credits],
      );
      this.log.log(`wallet refund booking=${bookingId} user=${userId} (+${credits} BC)`);
      return {refunded: true, credits, balance: await this.getBalance(userId)};
    });
  }

  /**
   * Auto-dispatch escrow HOLD (Step 9 / §39.1) — "charged ≠ paid". On agency
   * accept, move the booking's credits from the CLIENT into the platform ESCROW
   * account in a PAIRED ledger; the agency is NOT credited here. Runs on the
   * CALLER's transaction (tx) so it is all-or-nothing with the offer flip — on
   * insufficient_credits it throws and the whole accept unwinds (offer stays
   * OFFERED, no hold). Returns the client's wallet currency for the escrow_holds row.
   *
   * Mirrors the locked-debit core of debitForFeature/payWithCredits. The escrow
   * account is a platform holding account, so its credit gets NO expiry batch
   * (held funds must not be reclaimed by the credit-expiry sweep).
   *
   * LM-B7 — the CALLER passes the resolved payer as `clientId` (BookingService.create
   * resolves the family holder at request time and stamps lite_bookings.payer_user_id;
   * DispatchService.accept debits it). This function stays payer-agnostic.
   */
  async holdToEscrow(
    tx: Tx,
    args: {clientId: string; bookingId: string; offerId: string; credits: number; actorUserId?: string; familyRowId?: string | null},
  ): Promise<{currency: string}> {
    const {clientId, bookingId, offerId, credits} = args;
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    if (!escrowId) throw new Error('escrow_account_unconfigured');
    const desc = `Escrow hold ${bookingId}`;
    // Who the booking is FOR (family member on an owner-paid booking) — the
    // payer stays `clientId`; the actor is what the per-member spend view keys on.
    const actorId = args.actorUserId ?? clientId;

    // 1) Debit the client — lock the balance, gate on funds, ledger + balance.
    const client = await tx.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
      [clientId],
    );
    if (!client || client.bravo_credits < credits) {
      throw new BadRequestException('insufficient_credits');
    }
    // Stamp the FX rate used (the client's currency) so a later refund/release
    // reversal carries the same rate on its receipt — money moves in credits, so
    // this is the audit proof that the reversal is rate-exact, not a recompute input.
    // family_row_id pins cap bookkeeping to the charge-time membership row.
    const meta = JSON.stringify({
      offer_id: offerId,
      ...(args.familyRowId ? {family_row_id: args.familyRowId} : {}),
      ...this.fxStamp(client.currency),
    });
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [clientId, -credits, client.currency, desc, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
      [credits, clientId],
    );
    await this.debitBatchesFifoTx(tx, clientId, credits);

    // 2) Credit the platform escrow account (no expiry batch — held funds don't sweep).
    // Why: the escrow row deliberately stamps the CLIENT's currency (not the escrow
    // account's own) — the held funds belong to that client's job, so release/refund
    // stay symmetric. Credits are the unit; currency is only a label.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'escrow_hold', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [escrowId, credits, client.currency, desc, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
      [credits, escrowId],
    );
    this.log.log(`escrow hold booking=${bookingId} client=${clientId} (${credits} BC -> escrow)`);
    return {currency: client.currency};
  }

  /**
   * Family-correct settle targeting. escrow_holds.client_id is the booking's
   * CLIENT (the member on a family booking) but the hold DEBITED the resolved
   * payer (lite_bookings.payer_user_id — the family holder). Every client-side
   * credit (refund / split / clawback) must therefore go back to the PAYER's
   * wallet, with the member kept as the ledger actor. Falls back to the hold's
   * client for pre-payer-stamp bookings (payer == client there anyway).
   */
  private async bookingSettleTarget(
    tx: Tx,
    bookingId: string,
    fallback: string,
  ): Promise<{creditTo: string; actorId: string}> {
    const b = await tx.qOne<{client_id: string; payer_user_id: string | null}>(
      `SELECT client_id, payer_user_id FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    return {creditTo: b?.payer_user_id ?? fallback, actorId: b?.client_id ?? fallback};
  }

  /**
   * A family-charged booking coming back to the holder frees the member's cap:
   * reverse the `spent_credits` bump the charge made. Prefers the CHARGE-TIME
   * membership row (metadata.family_row_id on the original debit) so a
   * revoke → re-invite between charge and refund can't eat the fresh row's
   * legitimate spend; falls back to the current active pair for pre-stamp
   * rows. GREATEST guards underflow; a missing row is a no-op — the wallet
   * credit above is the source of truth, this is cap bookkeeping.
   */
  private async reverseFamilySpend(tx: Tx, memberId: string, holderId: string, credits: number, bookingId?: string): Promise<void> {
    if (memberId === holderId || credits <= 0) {return;}
    if (bookingId) {
      const charge = await tx.qOne<{row_id: string | null}>(
        `SELECT metadata->>'family_row_id' AS row_id
           FROM wallet_transactions
          WHERE booking_id = $1 AND user_id = $2 AND type = 'payment'
            AND amount_credits < 0 AND metadata ? 'family_row_id'
          ORDER BY created_at ASC LIMIT 1`,
        [bookingId, holderId],
      );
      if (charge?.row_id) {
        await tx.q(
          `UPDATE public.family_members
              SET spent_credits = GREATEST(0, spent_credits - $2)
            WHERE id = $1`,
          [charge.row_id, credits],
        );
        return;
      }
    }
    await tx.q(
      `UPDATE public.family_members
          SET spent_credits = GREATEST(0, spent_credits - $3)
        WHERE member_id = $1 AND holder_id = $2 AND status = 'active'`,
      [memberId, holderId, credits],
    );
  }

  /**
   * Auto-dispatch escrow REFUND (Step 9 / LB5) — full reversal of a HELD hold
   * back to the PAYER (e.g. agency no-show). PAIRED ledger: debit escrow, credit
   * the wallet that funded the hold (the family holder on a member booking —
   * never the member; see bookingSettleTarget). Flips escrow_holds HELD ->
   * REFUNDED with to_client = gross. Runs on the CALLER's tx so it is atomic
   * with the booking flip. Idempotent: a missing or non-HELD hold is a no-op
   * (returns refunded:false).
   */
  async refundEscrowHold(
    tx: Tx,
    bookingId: string,
    reason: string,
  ): Promise<{refunded: boolean; credits: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    if (!escrowId) throw new Error('escrow_account_unconfigured');
    const hold = await tx.qOne<{client_id: string; gross_credits: number; currency: string; status: string}>(
      `SELECT client_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || hold.status !== 'HELD') {
      return {refunded: false, credits: 0}; // nothing held / already settled — idempotent
    }
    const credits = hold.gross_credits;
    const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
    const meta = JSON.stringify({kind: 'escrow_refund', booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the escrow account.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'escrow_refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [escrowId, -credits, hold.currency, reason, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
      [credits, escrowId],
    );
    // 2) Credit the payer + mint a fresh expiry batch (refunded credits get the normal TTL).
    const refundRow = await tx.qOne<{id: string}>(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')
       RETURNING id`,
      [creditTo, credits, hold.currency, reason, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
      [credits, creditTo],
    );
    await tx.q(
      `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
      [creditTo, refundRow?.id ?? null, credits],
    );
    await this.reverseFamilySpend(tx, actorId, creditTo, credits, bookingId);
    // 3) Flip the hold terminal — reconciliation: gross == to_client + to_provider + fee.
    await tx.q(
      `UPDATE escrow_holds
          SET status = 'REFUNDED', settled_at = NOW(),
              to_client_credits = $2, to_provider_credits = 0, platform_fee_credits = 0
        WHERE booking_id = $1`,
      [bookingId, credits],
    );
    this.log.log(`escrow refund booking=${bookingId} payer=${creditTo} (+${credits} BC)`);
    return {refunded: true, credits};
  }

  /**
   * Auto-dispatch escrow RELEASE (Step 11 §42) — on verified completion after the
   * dispute window, pay the agency provider out of escrow and take the platform fee.
   * Tx-aware (atomic with the escrow_holds RELEASED flip). Idempotent: only a
   * PENDING_RELEASE hold releases; a second call sees a non-PENDING_RELEASE status
   * and no-ops. Conserved: to_provider + platform_fee == gross (to_client 0). The
   * provider/fee credits are idempotent on ux_wallet_tx_payout (user, booking), so a
   * stray double-run can't double-pay. The provider is the AGENCY
   * (escrow_holds.provider_user_id) — it settles its own CPOs internally.
   */
  async releaseEscrowHold(
    tx: Tx,
    bookingId: string,
    feePct: number,
  ): Promise<{released: boolean; toProvider: number; platformFee: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!escrowId || !feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{provider_user_id: string | null; gross_credits: number; currency: string; status: string}>(
      `SELECT provider_user_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || hold.status !== 'PENDING_RELEASE' || !hold.provider_user_id) {
      return {released: false, toProvider: 0, platformFee: 0};
    }
    const gross = hold.gross_credits;
    const platformFee = Math.min(gross, Math.max(0, Math.round((gross * feePct) / 100)));
    const toProvider = gross - platformFee;
    const meta = JSON.stringify({kind: 'escrow_release', booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the escrow account by the full gross.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at
       ) VALUES ($1, 'escrow_release', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
      [escrowId, -gross, hold.currency, `Escrow release ${bookingId}`, bookingId, meta],
    );
    await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [gross, escrowId]);

    // 2) Credit the agency provider (idempotent payout) + mint an expiry batch.
    if (toProvider > 0) {
      const payRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [hold.provider_user_id, toProvider, hold.currency, `Mission payout ${bookingId}`, bookingId, meta],
      );
      if (payRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toProvider, hold.provider_user_id]);
        await tx.q(
          `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
          [hold.provider_user_id, payRow.id, toProvider],
        );
      }
    }

    // 3) Credit the platform fee account (idempotent).
    if (platformFee > 0) {
      const feeRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [feeId, platformFee, hold.currency, `Platform fee ${bookingId}`, bookingId, meta],
      );
      if (feeRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformFee, feeId]);
      }
    }

    // 4) Flip the hold terminal — conservation: gross == to_provider + platform_fee + to_client(0).
    await tx.q(
      `UPDATE escrow_holds
          SET status = 'RELEASED', basis = 'full_release', settled_at = NOW(),
              to_provider_credits = $2, platform_fee_credits = $3, to_client_credits = 0
        WHERE booking_id = $1 AND status = 'PENDING_RELEASE'`,
      [bookingId, toProvider, platformFee],
    );
    this.log.log(`escrow release booking=${bookingId} provider=${hold.provider_user_id} (+${toProvider} BC, fee ${platformFee})`);
    return {released: true, toProvider, platformFee};
  }

  /**
   * Auto-dispatch escrow SPLIT settle (Step 11 §39.3-4 / §41) — the general paired-
   * ledger primitive for a partial outcome: pay the provider `toProvider`, refund the
   * client `toClient`, and the remainder is the platform fee. Tx-aware. Conserved:
   * gross == toProvider + toClient + platformFee (platformFee derived, never negative).
   *
   * Powers the mid-LIVE abort pro-rata (HELD -> PARTIAL, basis='pro_rata'), the post-
   * grace cancel fee (HELD -> PARTIAL, basis='partial'), and the admin dispute resolve
   * (DISPUTED -> REFUNDED|PARTIAL|RELEASED). Gated on `fromStatuses` under FOR UPDATE so
   * a second call no-ops (idempotent); the provider payout is also idempotent on
   * ux_wallet_tx_payout. The provider is the AGENCY (escrow_holds.provider_user_id).
   */
  async settleEscrowSplit(
    tx: Tx,
    bookingId: string,
    opts: {
      toProvider: number;
      toClient: number;
      basis: string;
      fromStatuses: string[];
      finalStatus: string;
      reason?: string;
    },
  ): Promise<{settled: boolean; toProvider: number; toClient: number; platformFee: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!escrowId || !feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{
      provider_user_id: string | null; client_id: string; gross_credits: number; currency: string; status: string;
    }>(
      `SELECT provider_user_id, client_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || !opts.fromStatuses.includes(hold.status)) {
      return {settled: false, toProvider: 0, toClient: 0, platformFee: 0}; // wrong state — idempotent no-op
    }
    const gross = hold.gross_credits;
    const toProvider = Math.min(gross, Math.max(0, Math.round(opts.toProvider)));
    const toClient = Math.min(gross - toProvider, Math.max(0, Math.round(opts.toClient)));
    const platformFee = gross - toProvider - toClient; // >= 0 by construction
    if (toProvider > 0 && !hold.provider_user_id) {
      throw new BadRequestException('escrow_split_no_provider');
    }
    const reason = opts.reason ?? `Escrow ${opts.basis} ${bookingId}`;
    const meta = JSON.stringify({kind: 'escrow_split', basis: opts.basis, booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the escrow account by the full gross (funds leaving escrow).
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at
       ) VALUES ($1, 'escrow_release', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
      [escrowId, -gross, hold.currency, reason, bookingId, meta],
    );
    await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [gross, escrowId]);

    // 2) Pay the agency provider its worked/awarded share (idempotent) + expiry batch.
    if (toProvider > 0 && hold.provider_user_id) {
      const payRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [hold.provider_user_id, toProvider, hold.currency, reason, bookingId, meta],
      );
      if (payRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toProvider, hold.provider_user_id]);
        await tx.q(
          `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
          [hold.provider_user_id, payRow.id, toProvider],
        );
      }
    }

    // 3) Refund the payer its unworked/awarded share + expiry batch — the wallet that
    // funded the hold (family holder on a member booking), never escrow_holds.client_id
    // blindly. (Idempotency comes from the fromStatuses guard under FOR UPDATE — a
    // second call sees finalStatus.)
    if (toClient > 0) {
      const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
      const refundRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking') RETURNING id`,
        [creditTo, toClient, hold.currency, reason, bookingId, meta, actorId],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toClient, creditTo]);
      await tx.q(
        `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [creditTo, refundRow?.id ?? null, toClient],
      );
      await this.reverseFamilySpend(tx, actorId, creditTo, toClient, bookingId);
    }

    // 4) Platform fee remainder (idempotent).
    if (platformFee > 0) {
      const feeRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [feeId, platformFee, hold.currency, `Platform fee ${bookingId}`, bookingId, meta],
      );
      if (feeRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformFee, feeId]);
      }
    }

    // 5) Flip the hold terminal — conservation: gross == to_provider + to_client + fee.
    // The status='ANY(fromStatuses)' guard mirrors releaseEscrowHold (redundant under the
    // FOR UPDATE lock taken above, but keeps the flip self-guarding).
    await tx.q(
      `UPDATE escrow_holds
          SET status = $2, basis = $3, settled_at = NOW(),
              to_provider_credits = $4, to_client_credits = $5, platform_fee_credits = $6
        WHERE booking_id = $1 AND status = ANY($7)`,
      [bookingId, opts.finalStatus, opts.basis, toProvider, toClient, platformFee, opts.fromStatuses],
    );
    this.log.log(`escrow split booking=${bookingId} basis=${opts.basis} (provider ${toProvider}, client ${toClient}, fee ${platformFee})`);
    return {settled: true, toProvider, toClient, platformFee};
  }

  /**
   * Auto-dispatch escrow CLAWBACK (Step 11 §41) — a dispute upheld AFTER the hold
   * already RELEASED to the agency. Reclaim `toClient + toPlatform` from the agency (=
   * everything it should not keep, i.e. gross − final to_provider) and route it: refund
   * the client `toClient`, credit the platform fee account `toPlatform`. If the agency is
   * short, the platform fee account fronts the shortfall (a negative-balance recovery to
   * withhold from future payouts). Conserved: agency(−pulled) == client(+toClient) +
   * platform(+toPlatform − shortfall). The escrow_holds split columns are re-stated to
   * the FINAL partition so they still sum to gross (reconciliation-clean). Tx-aware,
   * gated on status='RELEASED' AND basis<>'clawback' under FOR UPDATE → idempotent: a
   * second call sees basis='clawback' and no-ops.
   */
  async clawbackReleasedHold(
    tx: Tx,
    bookingId: string,
    toClient: number,
    toPlatform: number,
    reason: string,
  ): Promise<{clawed: boolean; toClient: number; toPlatform: number; toProvider: number; shortfall: number}> {
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{
      provider_user_id: string | null; client_id: string; gross_credits: number; currency: string;
      status: string; basis: string | null;
      to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
    }>(
      `SELECT provider_user_id, client_id, gross_credits, currency, status, basis,
              to_provider_credits, to_client_credits, platform_fee_credits
         FROM escrow_holds WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    // Idempotent: only a RELEASED, not-yet-clawed-back hold reclaims (basis flips to
    // 'clawback', so a second call short-circuits here).
    if (!hold || hold.status !== 'RELEASED' || hold.basis === 'clawback' || !hold.provider_user_id) {
      return {clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0};
    }
    const gross = hold.gross_credits;
    const wantClient = Math.min(gross, Math.max(0, Math.round(toClient)));
    const wantPlatform = Math.min(gross - wantClient, Math.max(0, Math.round(toPlatform)));
    const pull = wantClient + wantPlatform; // total reclaimed from the agency
    if (pull <= 0) return {clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0};
    const meta = JSON.stringify({kind: 'escrow_clawback', booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the agency for what it can cover; the platform fee account fronts the rest.
    const agency = await tx.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
      [hold.provider_user_id],
    );
    const fromAgency = Math.max(0, Math.min(pull, agency?.bravo_credits ?? 0));
    const shortfall = pull - fromAgency;
    if (fromAgency > 0) {
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
        [hold.provider_user_id, -fromAgency, hold.currency, reason, bookingId, meta],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [fromAgency, hold.provider_user_id]);
      await this.debitBatchesFifoTx(tx, hold.provider_user_id, fromAgency);
    }
    // 2) Refund the payer (+ expiry batch) — same family-correct targeting as
    // refundEscrowHold/settleEscrowSplit.
    if (wantClient > 0) {
      const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
      const refundRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking') RETURNING id`,
        [creditTo, wantClient, hold.currency, reason, bookingId, meta, actorId],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [wantClient, creditTo]);
      await tx.q(
        `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [creditTo, refundRow?.id ?? null, wantClient],
      );
      await this.reverseFamilySpend(tx, actorId, creditTo, wantClient, bookingId);
    }
    // 3) Net the platform fee account: + the awarded platform share, − any shortfall it fronted.
    const platformDelta = wantPlatform - shortfall;
    if (platformDelta !== 0) {
      // MON-5 — when platformFeePct>0 the RELEASE already wrote a (feeId, booking)
      // 'payout' row, so a fresh insert here collides with ux_wallet_tx_payout and
      // rolls back the ENTIRE dispute-resolve (a liveness DoS on the recovery path).
      // Merge the clawback fee movement onto that row instead of inserting a second.
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout'
         DO UPDATE SET amount_credits = wallet_transactions.amount_credits + EXCLUDED.amount_credits,
                       settled_at = NOW()`,
        [feeId, platformDelta, hold.currency, `Clawback platform ${bookingId}`, bookingId, meta],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformDelta, feeId]);
    }
    if (shortfall > 0) {
      this.log.warn(`clawback shortfall booking=${bookingId} agency=${hold.provider_user_id} short=${shortfall} BC — recover from future payouts`);
    }
    // 4) Re-state the FINAL split so the three columns still sum to gross (reconciliation-clean).
    const finalToClient = Math.min(gross, (hold.to_client_credits ?? 0) + wantClient);
    const finalToProvider = Math.max(0, (hold.to_provider_credits ?? gross) - pull);
    const finalPlatform = gross - finalToClient - finalToProvider;
    await tx.q(
      `UPDATE escrow_holds
          SET basis = 'clawback', settled_at = NOW(),
              to_client_credits = $2, to_provider_credits = $3, platform_fee_credits = $4
        WHERE booking_id = $1`,
      [bookingId, finalToClient, finalToProvider, finalPlatform],
    );
    this.log.log(`escrow clawback booking=${bookingId} client +${wantClient} platform +${wantPlatform} (agency -${fromAgency}, short ${shortfall})`);
    return {clawed: true, toClient: wantClient, toPlatform: wantPlatform, toProvider: finalToProvider, shortfall};
  }

  /**
   * Debit BC for a non-booking feature purchase (e.g. a Pro subscription
   * period). Mirrors `debitForBooking` but is not booking-bound — the
   * `description` + optional `metadata` carry the context. Runs inside the
   * caller's transaction when one is supplied so a downstream side-effect
   * (e.g. flipping `subscription_tier`) can roll back the debit on failure.
   *
   * Throws `insufficient_credits` (400) when the caller is short, which the
   * mobile paywall maps onto its card top-up fallback — same contract the
   * booking flow relies on.
   */
  async debitForFeature(
    userId: string,
    credits: number,
    description: string,
    metadata: Record<string, unknown> = {},
    tx?: Tx,
    stamp?: {actorUserId?: string; feature?: string},
  ): Promise<WalletBalance> {
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const run = async (t: Tx): Promise<WalletBalance> => {
      const row = await t.qOne<WalletBalanceRow>(
        // Lock the balance row so a concurrent debit can't race the check.
        `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      ) ?? await this.ensureBalanceRow(userId);
      if (row.bravo_credits < credits) {
        throw new BadRequestException('insufficient_credits');
      }
      const inserted = await t.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5::jsonb, NOW(), $6, $7)
         RETURNING id`,
        [userId, -credits, row.currency, description, JSON.stringify(metadata),
         stamp?.actorUserId ?? userId, stamp?.feature ?? null],
      );
      await t.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [credits, userId],
      );
      // Consume FIFO-by-expiry, same policy as every other debit path.
      await this.debitBatchesFifoTx(t, userId, credits);
      this.log.log(`wallet feature debit user=${userId} (-${credits} BC) tx=${inserted?.id ?? '?'}`);
      return {
        bravo_credits: row.bravo_credits - credits,
        currency: row.currency,
        stripe_customer_id: row.stripe_customer_id,
      };
    };
    // Ensure a balance row exists before opening the locking transaction.
    await this.ensureBalanceRow(userId);
    return tx ? run(tx) : this.db.withTransaction(run);
  }

  /**
   * Client-driven settlement: after PaymentSheet succeeds on the device, the
   * mobile app calls us with the intent id. We verify the intent is actually
   * `succeeded` against Stripe directly, then settle the pending ledger row
   * and credit BC. Idempotent — safe to call twice (returns the settled row
   * on the second call). This is a belt-and-braces path alongside the webhook.
   *
   * Ownership-checked: only the user who owns the pending tx can confirm it.
   */
  async confirmIntent(userId: string, intentId: string): Promise<{
    transaction_id: string;
    status: TxStatus;
    credits_awarded: number;
    balance: WalletBalance;
  }> {
    const tx = await this.db.qOne<WalletTxRow>(
      `SELECT * FROM wallet_transactions
        WHERE stripe_intent_id = $1 AND user_id = $2
        LIMIT 1`,
      [intentId, userId],
    );
    if (!tx) throw new BadRequestException('intent_not_found');
    // Audit Rev2 (live money bug) — only a genuinely-succeeded top-up awarded
    // credits. Reporting `credits_awarded: tx.amount_credits` for a 'failed'
    // row was the bug: a declined-then-retried PaymentIntent left the row
    // 'failed', and this early return then told the UI "N BC added" while
    // nothing was credited. A 'refunded' row was credited then clawed back, so
    // it awarded nothing from the caller's perspective either.
    if (tx.status === 'succeeded' || tx.status === 'refunded') {
      const balance = await this.getBalance(userId);
      return {
        transaction_id: tx.id,
        status: tx.status,
        credits_awarded: tx.status === 'succeeded' ? tx.amount_credits : 0,
        balance,
      };
    }
    // 'pending' OR 'failed' fall through — Stripe permits re-confirming a
    // failed PaymentIntent under the SAME intent id, so a prior decline is
    // recoverable: re-verify with Stripe below and settle if it now succeeded.

    // Independently ask Stripe whether the intent actually landed — trust
    // but verify, never take the client's word for "yes I paid".
    const intent = await this.stripe.getPaymentIntent(intentId);
    if (intent.status === 'succeeded') {
      await this.settlePendingTopup(tx.id, tx.user_id, tx.amount_credits, 'client-confirm');
      const balance = await this.getBalance(userId);
      return {
        transaction_id: tx.id,
        status: 'succeeded',
        credits_awarded: tx.amount_credits,
        balance,
      };
    }

    if (intent.status === 'canceled' || intent.status === 'payment_failed') {
      await this.db.q(
        `UPDATE wallet_transactions
            SET status = 'failed', settled_at = NOW(), stripe_client_secret = NULL
          WHERE id = $1`,
        [tx.id],
      );
      throw new BadRequestException(`intent_${intent.status}`);
    }

    // Intent still requires action on the Stripe side (e.g.
    // requires_confirmation, requires_action). Leave the ledger pending.
    throw new BadRequestException(`intent_${intent.status}`);
  }

  /**
   * Race-proof settle of a PENDING top-up row (audit F-03). The webhook and
   * the client-confirm path can both observe the row as pending; only the
   * one whose status-guarded UPDATE actually flips it credits the wallet.
   * The flip + balance bump + batch mint share one transaction (F-10).
   */
  private async settlePendingTopup(txId: string, userId: string, credits: number, via: string): Promise<void> {
    await this.db.withTransaction(async (t: Tx) => {
      // DC-14 — the Stripe client secret is one-shot bootstrap material; it
      // must not outlive the pending state it authorizes.
      // Audit Rev2 (live money bug) — settle a 'pending' OR previously-'failed'
      // row. Stripe lets a declined PaymentIntent be re-confirmed under the same
      // id; the succeeded event/confirm for that retry must be able to credit a
      // row a prior decline marked 'failed'. 'succeeded'/'refunded' are excluded
      // so a redelivery can never double-credit.
      const flipped = await t.q<{id: string}>(
        `UPDATE wallet_transactions
            SET status = 'succeeded', settled_at = NOW(), stripe_client_secret = NULL
          WHERE id = $1 AND status IN ('pending', 'failed')
          RETURNING id`,
        [txId],
      );
      if (flipped.length === 0) {
        // Already succeeded/refunded — the other settle path won, or this is a
        // duplicate. Nothing left to do.
        this.log.log(`wallet tx ${txId} already settled (${via} lost the race)`);
        return;
      }
      await this.creditDeltaTx(t, userId, credits, txId);
      this.log.log(`wallet tx ${txId} settled via ${via} (+${credits} BC for ${userId})`);
    });
  }

  /**
   * MON-1 — reverse the credits a settled top-up minted, once, when its card charge
   * is reversed. Locks the original top-up row FOR UPDATE so concurrent event
   * redeliveries serialise; a reversal already recorded for the intent is a no-op.
   * The compensating row is a negative `payment` (a debit out of the wallet) marked
   * kind='topup_reversal'; the balance is allowed to go NEGATIVE (an uncollected
   * receivable) rather than leaving unfunded credits spendable.
   */
  /**
   * MON-1 — claw back the credits a card charge minted when the fiat is refunded or
   * a dispute pulls the funds. `refundFraction` is the fraction of the ORIGINAL charge
   * now refunded (1 = full / dispute; <1 = partial). Because Stripe's `amount_refunded`
   * is CUMULATIVE, we compute a TARGET total-reversed = round(minted × fraction) and
   * reverse only the DELTA versus what we've already reversed for this intent — so a
   * series of partials each claw back their increment, a redelivered event is a no-op,
   * and a final full refund after partials reverses only the remaining credits (never
   * double). Clamped to [0, minted] so we can't reverse more than we minted (promo
   * top-ups where credits ≠ cents are handled by scaling the CREDITS, not the fiat).
   */
  private async reverseToppedUpCredits(intentId: string, reason: string, refundFraction = 1): Promise<void> {
    await this.db.withTransaction(async (t: Tx) => {
      const topup = await t.qOne<{id: string; user_id: string; amount_credits: number; currency: string}>(
        `SELECT id, user_id, amount_credits, currency FROM wallet_transactions
          WHERE stripe_intent_id = $1 AND type = 'topup' AND status = 'succeeded'
          ORDER BY settled_at DESC NULLS LAST LIMIT 1
          FOR UPDATE`,
        [intentId],
      );
      if (!topup) {
        this.log.warn(`stripe reversal: no settled top-up for intent ${intentId} (${reason})`);
        return;
      }
      // Credits already clawed back for this intent (prior partials sum up).
      const prior = await t.qOne<{reversed: string | null}>(
        `SELECT COALESCE(SUM(-amount_credits), 0) AS reversed FROM wallet_transactions
          WHERE type = 'payment' AND stripe_intent_id = $1
            AND metadata->>'kind' = 'topup_reversal'`,
        [intentId],
      );
      const alreadyReversed = Math.round(Number(prior?.reversed ?? 0));
      const fraction = Math.min(1, Math.max(0, refundFraction));
      const target = Math.min(topup.amount_credits, Math.round(topup.amount_credits * fraction));
      const delta = target - alreadyReversed;
      if (delta <= 0) {
        this.log.log(`stripe reversal for intent ${intentId} already at/above target (${alreadyReversed}/${target}) — no-op`);
        return;
      }
      const meta = JSON.stringify({kind: 'topup_reversal', stripe_intent_id: intentId, reason, target, delta});
      await t.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, stripe_intent_id, metadata, settled_at, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), 'topup')`,
        [topup.user_id, -delta, topup.currency, `Card charge reversed (${reason})`, intentId, meta],
      );
      await t.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [delta, topup.user_id],
      );
      this.log.warn(`stripe ${reason}: reversed ${delta} BC (target ${target}, was ${alreadyReversed}) for ${topup.user_id} (intent ${intentId}) — balance may be negative`);
    });
  }

  /** Webhook dispatcher — called with an already-verified Stripe event. */
  async handleStripeEvent(event: StripeEvent): Promise<void> {
    // MON-1 — a reversed card charge must claw back the credits it minted, or the
    // customer keeps the goods AND the money (top up → spend → chargeback). The
    // event object here is a charge/dispute carrying the original PaymentIntent id.
    // A dispute-funds-withdrawn pulls the whole charge (fraction 1). A charge.refunded
    // may be PARTIAL: amount_refunded is cumulative, so we pass the refunded FRACTION
    // and reverseToppedUpCredits claws back the proportional delta (idempotent across
    // a series of partials + the final full refund — see that method).
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.funds_withdrawn') {
      const obj = event.data.object as {
        payment_intent?: string | {id?: string};
        amount?: number; amount_refunded?: number;
      };
      const intentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (!intentId) return;
      let fraction = 1;
      if (event.type === 'charge.refunded'
          && typeof obj.amount === 'number' && obj.amount > 0
          && typeof obj.amount_refunded === 'number') {
        fraction = obj.amount_refunded / obj.amount;
      }
      await this.reverseToppedUpCredits(intentId, event.type, fraction);
      return;
    }
    if (event.type !== 'payment_intent.succeeded' &&
        event.type !== 'payment_intent.payment_failed') {
      // Anything else (customer updates, other charge events…) is out of scope.
      return;
    }
    const intent = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
    };
    if (!intent.id) return;

    // Audit Rev2 (live money bug) — accept a 'failed' row too, not just
    // 'pending'. A retry of a declined PaymentIntent fires payment_intent
    // .succeeded for the SAME id; if we only matched 'pending' here the row a
    // prior decline marked 'failed' would never be found and the successful
    // retry would credit nothing while logging "unknown pending intent".
    const tx = await this.db.qOne<WalletTxRow>(
      `SELECT * FROM wallet_transactions
         WHERE stripe_intent_id = $1 AND status IN ('pending', 'failed')
         LIMIT 1`,
      [intent.id],
    );
    if (!tx) {
      this.log.warn(`Stripe event for unknown/settled intent ${intent.id}`);
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      await this.settlePendingTopup(tx.id, tx.user_id, tx.amount_credits, 'webhook');
    } else if (tx.status === 'pending') {
      // Mark failed (non-terminal — a later succeeded event/confirm can still
      // settle it). Don't re-stamp an already-'failed' row.
      await this.db.q(
        `UPDATE wallet_transactions
            SET status = 'failed', settled_at = NOW(), stripe_client_secret = NULL
          WHERE id = $1 AND status = 'pending'`,
        [tx.id],
      );
      this.log.warn(`wallet tx ${tx.id} failed for ${tx.user_id}`);
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async ensureBalanceRow(userId: string): Promise<WalletBalanceRow> {
    const existing = await this.db.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1`,
      [userId],
    );
    if (existing) return existing;
    const inserted = await this.db.qOne<WalletBalanceRow>(
      `INSERT INTO wallet_balances (user_id) VALUES ($1)
        ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
        RETURNING *`,
      [userId],
    );
    if (!inserted) throw new BadRequestException('wallet_init_failed');
    return inserted;
  }

  private async applyCreditDelta(userId: string, delta: number, sourceTxId?: string): Promise<void> {
    // Why: balance bump + batch motion must land atomically (audit F-10) —
    // a crash between them left a succeeded ledger row with no balance.
    await this.db.withTransaction(async (tx: Tx) => {
      await this.creditDeltaTx(tx, userId, delta, sourceTxId);
    });
  }

  /** Tx-bound core of {@link applyCreditDelta}: balance bump + batch mint/consume. */
  private async creditDeltaTx(tx: Tx, userId: string, delta: number, sourceTxId?: string): Promise<void> {
    await tx.q(
      `UPDATE wallet_balances
          SET bravo_credits = bravo_credits + $1
        WHERE user_id = $2`,
      [delta, userId],
    );
    if (delta > 0) {
      // Grant path — mint a new batch with a 12-month TTL.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, sourceTxId ?? null, delta],
      );
    } else if (delta < 0) {
      // Debit path — consume against existing batches FIFO-by-expiry so
      // the closest-to-expiry credits are used first.
      await this.debitBatchesFifoTx(tx, userId, -delta);
    }
  }

  /**
   * Walk a user's active credit batches oldest-expiry-first and bump
   * `consumed_credits` until `need` is covered, inside the caller's
   * transaction so the batch motion shares the same atomic unit as the
   * balance update + ledger insert (FOR UPDATE prevents double-spend).
   *
   * Caller has already debited `wallet_balances.bravo_credits` and
   * already gated on the balance being sufficient — this method only
   * reconciles the batch table with the balance row. If batches don't
   * fully cover `need` (data drift), we log and return silently rather
   * than throwing, because the balance is the source of truth for the
   * user-facing number.
   */
  private async debitBatchesFifoTx(tx: Tx, userId: string, need: number): Promise<void> {
    if (need <= 0) return;
    {
      let remaining = need;
      const batches = await tx.q<{id: string; amount_credits: number; consumed_credits: number}>(
        `SELECT id, amount_credits, consumed_credits
           FROM wallet_credit_batches
          WHERE user_id = $1
            AND expired_at IS NULL
            AND consumed_credits < amount_credits
          ORDER BY expires_at ASC, issued_at ASC
          FOR UPDATE`,
        [userId],
      );
      for (const b of batches) {
        if (remaining <= 0) break;
        const free = b.amount_credits - b.consumed_credits;
        const take = Math.min(remaining, free);
        await tx.q(
          `UPDATE wallet_credit_batches
              SET consumed_credits = consumed_credits + $1
            WHERE id = $2`,
          [take, b.id],
        );
        remaining -= take;
      }
      if (remaining > 0) {
        this.log.warn(`wallet debit drift: user=${userId} needed=${need} unallocated=${remaining}`);
      }
    }
  }

  /**
   * Sweep job — invoked by `walletExpirySweep` (see wallet-expiry.cron.ts).
   * Finds every batch whose `expires_at` has passed and that hasn't been
   * swept yet, reverses the unconsumed remainder out of the user's
   * balance, marks the batch as swept, and writes an `expire` ledger row
   * for the audit trail. Returns the number of batches expired.
   */
  async sweepExpiredCredits(now: Date = new Date()): Promise<{batches: number; creditsExpired: number}> {
    return await this.db.withTransaction(async (tx: Tx) => {
      const due = await tx.q<{id: string; user_id: string; amount_credits: number; consumed_credits: number; expires_at: Date; currency: string | null}>(
        `SELECT b.id, b.user_id, b.amount_credits, b.consumed_credits, b.expires_at, w.currency
           FROM wallet_credit_batches b
           LEFT JOIN wallet_balances w ON w.user_id = b.user_id
          WHERE b.expired_at IS NULL
            AND b.expires_at <= $1
          ORDER BY b.expires_at ASC
          FOR UPDATE OF b`,
        [now],
      );
      let totalCredits = 0;
      for (const batch of due) {
        const remainder = batch.amount_credits - batch.consumed_credits;
        if (remainder > 0) {
          await tx.q(
            `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
            [remainder, batch.user_id],
          );
          await tx.q(
            `INSERT INTO wallet_transactions (
               user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
               description, metadata, settled_at
             ) VALUES ($1, 'expire', 'succeeded', $2, 0, $6, $3, $4::jsonb, $5)`,
            [
              batch.user_id,
              -remainder,
              `Credits expired (${remainder} BC, batch issued > 12mo ago)`,
              JSON.stringify({batch_id: batch.id, kind: 'credit_expiry'}),
              now,
              batch.currency ?? 'AED',
            ],
          );
          totalCredits += remainder;
        }
        await tx.q(
          `UPDATE wallet_credit_batches SET expired_at = $1 WHERE id = $2`,
          [now, batch.id],
        );
      }
      if (due.length > 0) {
        this.log.log(`wallet expiry sweep: ${due.length} batch(es), ${totalCredits} BC reclaimed`);
      }
      return {batches: due.length, creditsExpired: totalCredits};
    });
  }

  /**
   * Nightly reconciliation probe (audit F-12) — reports every wallet whose
   * denormalised balance disagrees with the sum of its succeeded ledger
   * rows. Detection only, never auto-fixes: drift means a code path or a
   * script bypassed the service layer and a human should look at it.
   */
  async reconcileBalances(): Promise<{checked: number; drifted: number}> {
    const rows = await this.db.q<{user_id: string; balance: number; ledger_sum: string}>(
      `SELECT wb.user_id, wb.bravo_credits AS balance,
              COALESCE(SUM(wt.amount_credits) FILTER (WHERE wt.status = 'succeeded'), 0) AS ledger_sum
         FROM wallet_balances wb
         LEFT JOIN wallet_transactions wt ON wt.user_id = wb.user_id
        GROUP BY wb.user_id, wb.bravo_credits
       HAVING wb.bravo_credits <> COALESCE(SUM(wt.amount_credits) FILTER (WHERE wt.status = 'succeeded'), 0)`,
    );
    for (const r of rows) {
      this.log.warn(
        `wallet drift: user=${r.user_id} balance=${r.balance} ledger=${r.ledger_sum} (Δ ${r.balance - Number(r.ledger_sum)})`,
      );
    }
    const checked = await this.db.qOne<{n: string}>(`SELECT COUNT(*) AS n FROM wallet_balances`);
    return {checked: Number(checked?.n ?? 0), drifted: rows.length};
  }

  private async insertTx(input: {
    userId: string;
    type: TxType;
    status: TxStatus;
    amountCredits: number;
    amountFiatCents: number;
    fiatCurrency: string;
    description: string;
    bookingId?: string;
    stripeIntentId?: string;
    stripeClientSecret?: string;
    metadata?: Record<string, unknown>;
    settledAt?: Date;
  }, tx?: Tx): Promise<WalletTxRow> {
    const q = tx ?? this.db;
    const row = await q.qOne<WalletTxRow>(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, stripe_intent_id, stripe_client_secret, metadata, settled_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       RETURNING *`,
      [
        input.userId,
        input.type,
        input.status,
        input.amountCredits,
        input.amountFiatCents,
        input.fiatCurrency,
        input.description,
        input.bookingId ?? null,
        input.stripeIntentId ?? null,
        input.stripeClientSecret ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.settledAt ?? null,
      ],
    );
    if (!row) throw new BadRequestException('tx_insert_failed');
    return row;
  }

  // Code-default FX table (units of fiat per 1 USD) — RECEIPT METADATA ONLY since the
  // 1-fiat-unit = 1-BC peg (computeCreditsForFiat no longer converts). The SOURCE of
  // truth is config.fx (env-overridable); these literals are the fallback when config
  // is absent (e.g. a unit test that stubs ConfigService without an fx block).
  private static readonly FX_DEFAULTS: Record<string, number> = {
    usd: 1, aed: 3.67, eur: 1 / 1.08, sar: 3.75, gbp: 1 / 1.27, bdt: 110,
  };

  /**
   * FX units per 1 USD for `currency` — reads config.fx (finance-set, env-overridable),
   * falling back to FX_DEFAULTS. The single source for both the credit conversion and the
   * metadata rate stamp (so a refund/reversal shows the same rate it was held at; money
   * moves in fixed CREDITS, so the reversal is already credit-exact — this is the proof).
   */
  private fxUnitsPerUsd(currency: string): number {
    const c = currency.toLowerCase();
    const cfg = this.cfg.get<number>(`fx.${c}`);
    if (typeof cfg === 'number' && cfg > 0) return cfg;
    return WalletService.FX_DEFAULTS[c] ?? 1;
  }

  private computeCreditsForFiat(amount: number, _currency: string): number {
    // Why: product rule (2026-07-05, CREDITS_BC_AUDIT F-01/F-02) — 1 unit of
    // fiat = 1 BC, regardless of charge currency. Hard-coded (not config/FX)
    // so an env override can't silently break the peg the UI promises. The FX
    // table below survives only as the metadata rate stamp on receipts.
    return Math.round(amount);
  }

  /** The fx stamp written into a money row's metadata for the receipt/reconciliation. */
  private fxStamp(currency: string): {fx_currency: string; fx_rate: number} {
    return {fx_currency: currency.toLowerCase(), fx_rate: this.fxUnitsPerUsd(currency)};
  }

  private toClientTx = (r: WalletTxRow): WalletTransaction => ({
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    status: r.status,
    amount: r.amount_credits,
    currency: 'BC',
    description: r.description ?? '',
    booking_id: r.booking_id ?? undefined,
    created_at: new Date(r.created_at).toISOString(),
  });
}
