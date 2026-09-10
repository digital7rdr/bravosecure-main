import {BadRequestException, HttpException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';
import {StripeClient, type StripeEvent} from '../wallet/stripe.client';
import {isDeadlineError} from '../common/http/fetchWithDeadline';

/**
 * Paid-tier prices, in Bravo Credits, for one 30-day period.
 *
 * Why constants (not config): product fixed Pro at 2000 BC for the
 * current SKU and the client paywall must show the same number. When the
 * pricing service lands this moves behind it; until then a single source
 * of truth here keeps server + client in lockstep.
 *
 * ⚠️ ENTERPRISE_MONTHLY_BC is a PLACEHOLDER (M1A Q-A — founder has not
 * priced the tier yet). Update here + the client paywall together.
 */
export const PRO_MONTHLY_BC = 2000;
export const ENTERPRISE_MONTHLY_BC = 5000;

export type PaidTier = 'pro' | 'enterprise';

export const TIER_PRICES_BC: Record<PaidTier, number> = {
  pro: PRO_MONTHLY_BC,
  enterprise: ENTERPRISE_MONTHLY_BC,
};

const TIER_LABELS: Record<PaidTier, string> = {
  pro: 'Bravo Pro subscription · 30 days',
  enterprise: 'Bravo Enterprise subscription · 30 days',
};

export interface SubscribeResult {
  subscription_tier: PaidTier;
  /** ISO timestamp the current paid period runs until (now + 30 days). */
  active_until: string;
  charged_credits: number;
  balance: {bravo_credits: number; currency: string};
  /** True when a Stripe auto-renewing subscription was also created. */
  auto_renew: boolean;
}

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    private readonly stripe: StripeClient,
  ) {}

  /**
   * Activate (or renew) Pro for one 30-day period by debiting
   * {@link PRO_MONTHLY_BC} Bravo Credits and flipping
   * `public.users.subscription_tier` to `'pro'` — both inside ONE
   * transaction so a failed tier write rolls the debit back and a short
   * balance never half-charges the user.
   *
   * Throws `insufficient_credits` (400) when the wallet is short; the
   * mobile paywall maps that onto the card top-up fallback, identical to
   * the booking pay-with-credits contract.
   *
   * Idempotency note: this is a paid mutation, so callers must guard
   * against double-tap on the client (the paywall already does). We do
   * NOT silently no-op an already-Pro user — renewing extends the period
   * and is an explicit, paid action.
   */
  async subscribeToPro(userId: string, opts: {autoRenew?: boolean} = {}): Promise<SubscribeResult> {
    return this.subscribeToTier(userId, 'pro', opts);
  }

  /**
   * Live per-tier prices in BC — ops-editable (subscription_prices table).
   * Read at CHARGE TIME so a price change applies to every subsequent
   * subscribe/renewal while already-paid periods finish untouched. Falls
   * back to the compiled constants if the table is unreachable/missing.
   */
  async getPrices(): Promise<Record<PaidTier, number>> {
    try {
      const rows = await this.db.q<{tier: PaidTier; price_bc: number}>(
        `SELECT tier, price_bc FROM subscription_prices`,
      );
      const out = {...TIER_PRICES_BC};
      for (const r of rows) {
        if ((r.tier === 'pro' || r.tier === 'enterprise') && Number(r.price_bc) > 0) {
          out[r.tier] = Number(r.price_bc);
        }
      }
      return out;
    } catch (e) {
      this.log.warn(`price table read failed, using defaults: ${e instanceof Error ? e.message : e}`);
      return {...TIER_PRICES_BC};
    }
  }

  /**
   * Founder 2026-08-26 — the ops-editable package catalog (plan_catalog:
   * display copy) merged with the live messenger prices, one fetch for the
   * apps. Fail-open like getPrices: an unreachable table returns an EMPTY
   * catalog and the apps keep their shipped copy — a DB hiccup must never
   * blank a paywall or a plan card.
   */
  async getCatalog(): Promise<{
    catalog: Array<{key: string; display_name: string; description: string; price_bc: number | null}>;
  }> {
    try {
      const [rows, prices] = await Promise.all([
        this.db.q<{key: string; display_name: string; description: string}>(
          `SELECT key, display_name, description FROM plan_catalog ORDER BY key`,
        ),
        this.getPrices(),
      ]);
      const priceFor = (key: string): number | null =>
        key === 'messenger_pro' ? prices.pro
        : key === 'messenger_enterprise' ? prices.enterprise
        : null;
      return {catalog: rows.map(r => ({...r, price_bc: priceFor(r.key)}))};
    } catch (e) {
      this.log.warn(`catalog read failed, apps keep shipped copy: ${e instanceof Error ? e.message : e}`);
      return {catalog: []};
    }
  }

  async subscribeToTier(
    userId: string,
    tier: PaidTier,
    opts: {autoRenew?: boolean} = {},
  ): Promise<SubscribeResult> {
    const price = (await this.getPrices())[tier];
    const result = await this.db.withTransaction(async tx => {
      const user = await tx.qOne<{id: string; subscription_tier: string; stripe_subscription_id: string | null}>(
        `SELECT id, subscription_tier, stripe_subscription_id FROM public.users
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [userId],
      );
      if (!user) throw new NotFoundException('user_not_found');

      // Debit first — throws insufficient_credits if short, which aborts
      // the transaction before any tier change is persisted.
      const balance = await this.wallet.debitForFeature(
        userId,
        price,
        TIER_LABELS[tier],
        {kind: `${tier}_subscription`, period_days: 30},
        tx,
        {feature: 'messenger_plan'},
      );

      // Same-tier renewal EXTENDS the paid window; a tier SWITCH starts a
      // fresh 30-day window (remaining time on the old tier is not converted
      // — the switch is an explicit, replacing purchase). bc_auto_renew
      // mirrors the caller's auto-renew choice: at period end the sweep
      // re-debits BC (Stripe, when configured, renews first and the BC path
      // never double-charges — it only fires with no live Stripe sub).
      const row = await tx.qOne<{pro_active_until: Date}>(
        `UPDATE public.users
            SET subscription_tier = $2,
                bc_auto_renew     = $3,
                pro_active_until  = CASE
                  WHEN subscription_tier = $2 THEN
                    GREATEST(COALESCE(pro_active_until, NOW()), NOW()) + INTERVAL '30 days'
                  ELSE NOW() + INTERVAL '30 days'
                END
          WHERE id = $1
          RETURNING pro_active_until`,
        [userId, tier, opts.autoRenew === true],
      );
      if (!row) throw new BadRequestException('tier_update_failed');

      return {
        balance,
        activeUntil: row.pro_active_until,
        switchedFrom: user.subscription_tier !== tier ? user.subscription_tier : null,
        staleStripeSub: user.subscription_tier !== tier ? user.stripe_subscription_id : null,
      };
    });

    this.log.log(`${tier} subscription activated user=${userId} (-${price} BC)`);

    // A tier switch must not leave the OLD tier's Stripe subscription
    // renewing in the background (it would re-flip the tier and charge the
    // card for the abandoned plan). Cancel it before any new auto-renew.
    if (result.staleStripeSub) {
      if (this.stripe.enabled) {
        await this.stripe.cancelSubscription(result.staleStripeSub).catch(e =>
          this.log.warn(`stale sub cancel failed user=${userId}: ${e instanceof Error ? e.message : e}`),
        );
      }
      await this.db.q(
        `UPDATE public.users
            SET stripe_subscription_id = NULL, pro_renew_status = 'canceled'
          WHERE id = $1 AND stripe_subscription_id = $2`,
        [userId, result.staleStripeSub],
      );
    }

    // Optionally set up Stripe auto-renewal AFTER the BC-funded first period
    // is committed. A failure here must NOT roll back the active period the
    // user already paid for in credits — we just leave auto_renew off.
    let autoRenew = false;
    if (opts.autoRenew && this.stripe.enabled) {
      try {
        autoRenew = await this.enableAutoRenew(userId, tier);
      } catch (e) {
        this.log.warn(`auto-renew setup failed user=${userId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      subscription_tier: tier,
      active_until: new Date(result.activeUntil).toISOString(),
      charged_credits: price,
      balance: {
        bravo_credits: result.balance.bravo_credits,
        currency: result.balance.currency,
      },
      auto_renew: autoRenew,
    };
  }

  /**
   * Create the Stripe auto-renewing subscription for an already-paid user.
   * Reuses the wallet's Stripe customer (so the saved card carries over).
   * Returns true if the subscription is live. An unconfigured price for the
   * tier throws (caught by the caller → BC-only period, auto_renew=false).
   */
  private async enableAutoRenew(userId: string, tier: PaidTier = 'pro'): Promise<boolean> {
    const wallet = await this.db.qOne<{stripe_customer_id: string | null}>(
      `SELECT stripe_customer_id FROM wallet_balances WHERE user_id = $1`,
      [userId],
    );
    // Audit Rev2 API-04 — the ORPHAN fix. createSubscription below
    // unconditionally overwrites users.stripe_subscription_id, and the
    // tier-SWITCH cancel in subscribeToTier only fires on a switch. So a
    // SAME-TIER re-subscribe (renew early, flip auto-renew on, double-tap)
    // created a SECOND Stripe subscription and orphaned the first — which then
    // billed the card every month forever with no row pointing at it and no
    // cancel path support could see. Cancel any existing live sub BEFORE
    // creating the replacement so exactly one subscription is ever live per
    // user. (Concurrent double-taps are additionally guarded by the
    // OptionalIdempotencyInterceptor on the route.)
    const existing = await this.db.qOne<{stripe_subscription_id: string | null}>(
      `SELECT stripe_subscription_id FROM public.users WHERE id = $1`,
      [userId],
    );
    if (existing?.stripe_subscription_id) {
      await this.stripe.cancelSubscription(existing.stripe_subscription_id).catch(e =>
        this.log.warn(`pre-replace sub cancel failed user=${userId} sub=${existing.stripe_subscription_id}: ${e instanceof Error ? e.message : e}`),
      );
      // Review finding — NULL the link IMMEDIATELY after cancel (mirror the
      // tier-switch path). Otherwise, if createSubscription below throws, the
      // row is left pointing at a CANCELLED sub, which ALSO blocks the BC-renew
      // fallback (renewFromCredits + sweepLapsedPro branch-1 both require the
      // link IS NULL) — stranding the user on neither renewal path.
      await this.db.q(
        `UPDATE public.users SET stripe_subscription_id = NULL, pro_renew_status = 'canceled'
          WHERE id = $1 AND stripe_subscription_id = $2`,
        [userId, existing.stripe_subscription_id],
      );
    }
    const customerId = await this.stripe.ensureCustomer(userId, wallet?.stripe_customer_id ?? null);
    if (customerId !== wallet?.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }
    let sub: {id: string; status: string; current_period_end: number};
    try {
      // Per-ATTEMPT idempotency key: dedupes an INTERNAL retry of this exact
      // call, but a genuinely NEW subscribe attempt (user fixed a declined card
      // and tapped again) gets a fresh key so Stripe does not replay its 24h-
      // cached decline. Client double-taps are already deduped at the HTTP layer
      // (OptionalIdempotencyInterceptor on the /subscription routes).
      sub = await this.stripe.createSubscription(
        {customerId, tier, metadata: {user_id: userId, kind: `${tier}_subscription`}},
        `sub:${userId}:${tier}:${Date.now()}`,
      );
    } catch (e) {
      // Review finding (X2) — a DEADLINE or 5xx might mean Stripe CREATED the
      // sub but we lost the response. Letting subscribeToTier swallow this and
      // return auto_renew:false would leave a LIVE sub with no DB link — the
      // orphan this fix exists to kill. Flag reconcile_pending so an ops/cron
      // reconciliation (Stripe subs with no matching users.stripe_subscription_id)
      // can settle it. A 4xx decline created no sub — nothing to reconcile.
      const status = e instanceof HttpException ? e.getStatus() : 0;
      if (isDeadlineError(e) || status >= 500) {
        await this.db.q(
          `UPDATE public.users SET pro_renew_status = 'reconcile_pending' WHERE id = $1`,
          [userId],
        );
        this.log.warn(`auto-renew create ambiguous (may have created a sub) user=${userId} — flagged reconcile_pending`);
      }
      throw e;
    }
    await this.db.q(
      `UPDATE public.users
          SET stripe_subscription_id = $1, pro_renew_status = $2
        WHERE id = $3`,
      [sub.id, sub.status, userId],
    );
    this.log.log(`auto-renew enabled user=${userId} sub=${sub.id} status=${sub.status}`);
    return sub.status === 'active' || sub.status === 'trialing';
  }

  /** User-initiated cancel: stop EVERY renewal path (Stripe card + BC).
   *  The current paid period (pro_active_until) is honoured — they keep
   *  the tier until it lapses, then the sweep downgrades to Lite. */
  async cancelAutoRenew(userId: string): Promise<{cancelled: boolean}> {
    const row = await this.db.qOne<{stripe_subscription_id: string | null; bc_auto_renew: boolean}>(
      `SELECT stripe_subscription_id, bc_auto_renew FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!row || (!row.stripe_subscription_id && !row.bc_auto_renew)) return {cancelled: false};
    if (row.stripe_subscription_id && this.stripe.enabled) {
      await this.stripe.cancelSubscription(row.stripe_subscription_id).catch(e =>
        this.log.warn(`stripe cancel failed user=${userId}: ${e instanceof Error ? e.message : e}`),
      );
    }
    await this.db.q(
      `UPDATE public.users
          SET stripe_subscription_id = NULL,
              bc_auto_renew          = FALSE,
              pro_renew_status       = 'canceled'
        WHERE id = $1`,
      [userId],
    );
    return {cancelled: true};
  }

  /**
   * Settle a Stripe subscription webhook event. Idempotent per state.
   *
   *  - invoice.paid              → extend pro_active_until 30 days, tier=pro
   *  - invoice.payment_failed    → mark past_due (grace until period end)
   *  - customer.subscription.deleted → downgrade to Lite once the period
   *                                     has lapsed (Stripe ended the sub)
   *
   * The renewal extends the PAID period without debiting BC — the card
   * paid the invoice. (The initial period was BC-funded at subscribe time.)
   */
  async handleSubscriptionEvent(event: StripeEvent): Promise<void> {
    const HANDLED = new Set<string>([
      'invoice.paid',
      'invoice.payment_failed',
      'customer.subscription.deleted',
    ]);
    // Claim only AFTER the type filter — the wallet endpoint receives the same
    // event.id for payment_intent.* types, and claiming before the filter would
    // burn ids for events this handler never acts on.
    if (!HANDLED.has(event.type)) return;

    const obj = event.data.object as {
      id?: string;
      subscription?: string;
      customer?: string;
      metadata?: Record<string, string>;
      // A real invoice's TOP-LEVEL metadata is empty; Stripe snapshots the
      // subscription's own metadata (set in createSubscription) under
      // subscription_details.metadata.
      subscription_details?: {metadata?: Record<string, string>};
      // invoice.paid carries the paid period on its line items; the top-level
      // period_end is a fallback. Both are unix seconds.
      period_end?: number;
      lines?: {data?: Array<{period?: {end?: number}}>};
    };
    const userId = obj.metadata?.['user_id'];

    // Resolve the account BEFORE opening the transaction (read-only lookup).
    const subRef = event.type === 'customer.subscription.deleted' ? obj.id : obj.subscription;
    const uid = userId ?? (await this.userIdForSubscription(subRef));
    if (!uid) {
      if (event.type === 'invoice.paid') this.log.warn(`invoice.paid for unknown sub ${obj.subscription}`);
      return;
    }

    // Audit Rev2 API-06 — the claim AND the side effect live in ONE
    // transaction. Stripe delivers webhooks AT-LEAST-ONCE and retries for 3
    // days, so a duplicate invoice.paid used to grant a second 30 days for one
    // payment. The PK is (event_id, handler): the wallet endpoint handles
    // DISJOINT event types (payment_intent.*) and dedupes via its own
    // status-guarded flip, so it writes no row here today — but the composite
    // key keeps this 'subscription' claim independent if that ever changes.
    // Because claim + grant commit together, a crash between them rolls back
    // BOTH — the "commit the claim first" shape permanently loses a grant on a
    // crash and is deliberately avoided.
    await this.db.withTransaction(async tx => {
      const claimed = await tx.q<{event_id: string}>(
        `INSERT INTO public.stripe_processed_events (event_id, handler)
           VALUES ($1, 'subscription')
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [event.id],
      );
      // rowCount is not exposed by this DB layer (db.q returns res.rows), so the
      // dedupe is keyed on RETURNING + rows.length, never `rowCount`.
      if (claimed.length === 0) {
        this.log.log(`duplicate stripe event ${event.id} (subscription) — ignoring`);
        return;
      }

      if (event.type === 'invoice.paid') {
        // A renewal keeps whichever paid tier the row holds — an enterprise
        // account's card renewal must NOT be rewritten to 'pro'. A swept-to-lite
        // row is restored from the sub's metadata tier (else pro). Read
        // subscription_details.metadata FIRST: top-level invoice.metadata is
        // empty on a real invoice, so an enterprise account swept to lite would
        // otherwise be restored as 'pro' and receive pro entitlement for an
        // enterprise charge.
        const kind = obj.subscription_details?.metadata?.['kind'] ?? obj.metadata?.['kind'];
        const metaTier = kind === 'enterprise_subscription' ? 'enterprise' : 'pro';
        const tierCase =
          `CASE WHEN subscription_tier IN ('pro','enterprise') THEN subscription_tier ELSE $2 END`;
        // Audit Rev2 API-06 — assign CONVERGENTLY from Stripe's own period end
        // rather than adding a flat 30 days. Duplicates / out-of-order
        // deliveries become arithmetic no-ops (GREATEST never moves backwards),
        // and an annual Price extends by a year instead of under-granting by 11
        // months. Fall back to +30 days only when the period is absent — the
        // dedupe claim above still protects that path from double-adding.
        //
        // RS-17 — a NULL pro_active_until is a PERMANENT / comp grant and must
        // stay NULL. COALESCE(pro_active_until, NOW()) would convert it to a
        // finite expiry that sweepLapsedPro then downgrades, so both branches
        // preserve NULL explicitly (a card renewal is strictly less generous
        // than an unbounded comp grant).
        const periodEnd = obj.lines?.data?.[0]?.period?.end ?? obj.period_end;
        if (periodEnd) {
          await tx.q(
            `UPDATE public.users
                SET subscription_tier = ${tierCase},
                    pro_renew_status  = 'active',
                    pro_active_until  = CASE WHEN pro_active_until IS NULL THEN NULL
                                        ELSE GREATEST(pro_active_until, to_timestamp($3)) END
              WHERE id = $1`,
            [uid, metaTier, periodEnd],
          );
        } else {
          await tx.q(
            // Convergent even here: clamp to NOW() + 30 days rather than ADDING
            // 30 days, so a manual Stripe re-send of a period-less invoice after
            // the 90-day dedupe row is purged can't stack a second month. Never
            // shortens a longer existing window (GREATEST).
            `UPDATE public.users
                SET subscription_tier = ${tierCase},
                    pro_renew_status  = 'active',
                    pro_active_until  = CASE WHEN pro_active_until IS NULL THEN NULL
                                        ELSE GREATEST(pro_active_until, NOW() + INTERVAL '30 days') END
              WHERE id = $1`,
            [uid, metaTier],
          );
        }
        this.log.log(`paid tier auto-renewed user=${uid} (via card)`);
        return;
      }

      if (event.type === 'invoice.payment_failed') {
        // Don't downgrade yet — Stripe retries; the user keeps Pro until the
        // current period lapses. Just record the failed state for the UI.
        await tx.q(
          `UPDATE public.users SET pro_renew_status = 'past_due' WHERE id = $1`,
          [uid],
        );
        this.log.warn(`pro renewal payment failed user=${uid}`);
        return;
      }

      // customer.subscription.deleted — Stripe gave up or the user cancelled.
      // Drop the sub link + downgrade to Lite once the paid period is past.
      // RS-17 — a NULL pro_active_until is a PERMANENT / comp grant and is
      // NEVER auto-downgraded; only a non-NULL, already-elapsed period flips.
      await tx.q(
        `UPDATE public.users
            SET stripe_subscription_id = NULL,
                pro_renew_status       = 'canceled',
                subscription_tier      = CASE
                  WHEN pro_active_until IS NOT NULL AND pro_active_until <= NOW()
                  THEN 'lite' ELSE subscription_tier END
          WHERE id = $1`,
        [uid],
      );
      this.log.log(`pro subscription ended user=${uid}`);
    });
  }

  /**
   * Audit Rev2 API-06 — retention sweep for the webhook dedupe ledger. A
   * processed-event row only needs to outlive Stripe's 3-day retry window; 90
   * days is a generous margin. Idempotent and safe to run on every replica
   * (a redundant DELETE of already-purged rows is a no-op). Called from
   * ProLapseCron.tick().
   */
  async sweepProcessedStripeEvents(): Promise<number> {
    const rows = await this.db.q<{event_id: string}>(
      `DELETE FROM public.stripe_processed_events
        WHERE processed_at < NOW() - INTERVAL '90 days'
        RETURNING event_id`,
    );
    return rows.length;
  }

  /**
   * Lapse sweep — downgrade any user whose paid Pro period has elapsed and
   * who is no longer entitled. Run periodically (cron). Two cases:
   *
   *  1. Ordinary lapse — no live auto-renew (stripe_subscription_id IS NULL)
   *     and the paid period has passed. The "never renewed / cancelled and
   *     let it run out" path.
   *  2. RS-18 backstop — a Stripe-linked row whose last known renew status
   *     is 'past_due'/'canceled' AND whose paid period is > 14 days past.
   *     This catches a MISSED `customer.subscription.deleted` webhook, which
   *     would otherwise leave the user Pro forever (case 1 requires a null sub
   *     link, so it never fires for these). The 14-day grace deliberately
   *     exceeds Stripe's smart-retry / dunning window so we only downgrade
   *     AFTER Stripe would itself have given up — a still-recoverable past_due
   *     sub in active retry is NOT prematurely swept. The status filter means a
   *     currently-renewing user (status 'active', future period) matches
   *     NEITHER branch and is never touched.
   *
   *  We do NOT clear `stripe_subscription_id` here. The sweep fires on a
   *  GUESS that the sub is dead; if a later smart-retry succeeds, `invoice.paid`
   *  must still correlate the row via the intact sub link (the invoice carries
   *  no user_id) and re-upgrade to Pro. Nulling the link would break that
   *  self-heal and strand a paying customer on Lite. Only the authoritative
   *  `customer.subscription.deleted` webhook clears the link. Re-sweep is
   *  self-limiting: once tier flips to 'lite' the row no longer matches.
   *
   *  RS-17 — `pro_active_until IS NULL` is an explicit PERMANENT / comp
   *  grant (manual ops grant, no expiry) and is NEVER auto-downgraded here;
   *  both branches require `pro_active_until IS NOT NULL`. Only a paid
   *  action or an explicit ops change can remove such a grant.
   */
  /**
   * M1A/S9 — BC auto-renew sweep. For every paid account whose window just
   * lapsed, that opted into auto-renew, and that has NO live Stripe sub
   * (the card path renews those via invoice.paid — this never double-
   * charges), debit the CURRENT price and extend 30 days. Runs BEFORE
   * sweepLapsedPro each tick: a successful renewal moves the window
   * forward so the downgrade sweep skips the row; a failed debit
   * (insufficient credits) leaves it to lapse normally.
   *
   * Per-row transaction with a re-checked FOR UPDATE lock — a concurrent
   * manual subscribe or second cron instance can't double-debit.
   */
  async renewFromCredits(now: Date = new Date()): Promise<{renewed: number; failed: number}> {
    const due = await this.db.q<{id: string; subscription_tier: PaidTier}>(
      `SELECT id, subscription_tier FROM public.users
        WHERE subscription_tier IN ('pro', 'enterprise')
          AND bc_auto_renew = TRUE
          AND stripe_subscription_id IS NULL
          AND pro_active_until IS NOT NULL
          AND pro_active_until <= $1
          AND deleted_at IS NULL
        LIMIT 200`,
      [now],
    );
    if (due.length === 0) return {renewed: 0, failed: 0};

    const prices = await this.getPrices();
    let renewed = 0, failed = 0;
    for (const u of due) {
      const tier = u.subscription_tier;
      const price = prices[tier];
      try {
        await this.db.withTransaction(async tx => {
          const locked = await tx.qOne<{id: string}>(
            `SELECT id FROM public.users
              WHERE id = $1 AND subscription_tier = $2 AND bc_auto_renew = TRUE
                AND stripe_subscription_id IS NULL
                AND pro_active_until IS NOT NULL AND pro_active_until <= $3
              FOR UPDATE`,
            [u.id, tier, now],
          );
          if (!locked) return; // renewed/changed concurrently — skip
          await this.wallet.debitForFeature(
            u.id, price, `${TIER_LABELS[tier]} · auto-renew`,
            {kind: `${tier}_subscription`, period_days: 30, auto_renew: true}, tx,
            {feature: 'messenger_plan'},
          );
          await tx.q(
            `UPDATE public.users
                SET pro_active_until = GREATEST(pro_active_until, NOW()) + INTERVAL '30 days'
              WHERE id = $1`,
            [u.id],
          );
          renewed++;
        });
      } catch (e) {
        failed++;
        this.log.warn(`BC auto-renew failed user=${u.id} tier=${tier}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (renewed > 0) this.log.log(`BC auto-renew sweep: ${renewed} renewed, ${failed} failed`);
    return {renewed, failed};
  }

  async sweepLapsedPro(now: Date = new Date()): Promise<{downgraded: number}> {
    const rows = await this.db.q<{id: string}>(
      `UPDATE public.users
          SET subscription_tier = 'lite'
        WHERE subscription_tier IN ('pro', 'enterprise')
          AND pro_active_until IS NOT NULL
          AND (
                (stripe_subscription_id IS NULL AND pro_active_until <= $1)
             OR (pro_renew_status IN ('past_due', 'canceled')
                 AND pro_active_until < ($1::timestamptz - INTERVAL '14 days'))
          )
        RETURNING id`,
      [now],
    );
    if (rows.length > 0) this.log.log(`paid-tier lapse sweep: ${rows.length} downgraded to lite`);
    return {downgraded: rows.length};
  }

  private async userIdForSubscription(subId: string | undefined): Promise<string | null> {
    if (!subId) return null;
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE stripe_subscription_id = $1`,
      [subId],
    );
    return row?.id ?? null;
  }
}
