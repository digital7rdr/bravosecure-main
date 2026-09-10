import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SubscriptionService} from './subscription.service';

/**
 * Pro lapse sweep — downgrades users whose paid Pro period elapsed and who
 * have no live Stripe auto-renew subscription. This is the backstop for
 * "payment failed → fall back to Lite": when a card stops working, Stripe
 * eventually deletes the subscription (handled in the webhook), but a user
 * who never enabled auto-renew simply lapses — this sweep flips them to
 * Lite once `pro_active_until` passes.
 *
 * Plain setInterval (matches WalletExpiryCron) — no @nestjs/schedule dep.
 * Idempotent: the UPDATE only touches rows still 'pro' + past their period,
 * so re-running the same minute is a no-op.
 *
 * Disable via PRO_LAPSE_SWEEP_DISABLED=1 (tests / smoke envs).
 */
@Injectable()
export class ProLapseCron implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProLapseCron.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly subscription: SubscriptionService,
    private readonly cfg: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.cfg.get<string>('PRO_LAPSE_SWEEP_DISABLED') === '1'
        || process.env['PRO_LAPSE_SWEEP_DISABLED'] === '1') {
      this.log.warn('pro lapse sweep is disabled by env');
      return;
    }
    const intervalMs = Number(process.env['PRO_LAPSE_SWEEP_INTERVAL_MS'] ?? 60 * 60 * 1000);
    if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
      this.log.error(`refusing to start pro lapse sweep — interval ${intervalMs}ms < 60_000ms`);
      return;
    }
    const initialDelay = Math.floor(Math.random() * 60_000) + 5_000;
    setTimeout(() => {
      this.tick().catch(e => this.log.warn(`pro lapse first-tick failed: ${(e as Error).message}`));
      this.timer = setInterval(
        () => this.tick().catch(e => this.log.warn(`pro lapse tick failed: ${(e as Error).message}`)),
        intervalMs,
      );
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }, initialDelay);
    this.log.log(`pro lapse sweep scheduled every ${intervalMs}ms (first fire in ~${initialDelay}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // BC auto-renew FIRST — a successful renewal moves the paid window
    // forward so the downgrade sweep below skips the account (M1A/S9).
    await this.subscription.renewFromCredits().catch(e =>
      this.log.warn(`bc auto-renew sweep failed: ${(e as Error).message}`),
    );
    const {downgraded} = await this.subscription.sweepLapsedPro();
    if (downgraded > 0) this.log.log(`paid-tier lapse sweep: ${downgraded} downgraded to lite`);

    // Audit Rev2 API-06 — trim the webhook dedupe ledger past Stripe's retry
    // window so it can't grow unbounded.
    await this.subscription.sweepProcessedStripeEvents().catch(e =>
      this.log.warn(`stripe event ledger sweep failed: ${(e as Error).message}`),
    );
  }
}
