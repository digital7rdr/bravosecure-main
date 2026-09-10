import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {WalletService} from './wallet.service';

/**
 * Bravo Credits expiry sweep.
 *
 * Wakes every WALLET_EXPIRY_SWEEP_INTERVAL_MS (default 1h) and asks
 * `WalletService.sweepExpiredCredits` to reclaim any batch whose 12-month
 * TTL has fully elapsed. The sweep is idempotent — re-running it the same
 * minute is a no-op because already-swept rows are filtered by the
 * `expired_at IS NULL` partial index.
 *
 * We use a plain `setInterval` rather than `@nestjs/schedule` to avoid
 * pulling in a new dependency for a single cron — auth-service doesn't
 * use the schedule module anywhere else and the requirements (single job,
 * fixed interval, idempotent) don't justify the extra surface area.
 *
 * Disable via WALLET_EXPIRY_SWEEP_DISABLED=1 (useful for tests + smoke
 * envs where the cron timing distorts wallet balance assertions).
 */
@Injectable()
export class WalletExpiryCron implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WalletExpiryCron.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wallet: WalletService,
    private readonly cfg:    ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.cfg.get<string>('WALLET_EXPIRY_SWEEP_DISABLED') === '1'
        || process.env['WALLET_EXPIRY_SWEEP_DISABLED'] === '1') {
      this.log.warn('wallet expiry sweep is disabled by env');
      return;
    }
    const intervalMs = Number(
      process.env['WALLET_EXPIRY_SWEEP_INTERVAL_MS'] ?? 60 * 60 * 1000,
    );
    if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
      this.log.error(`refusing to start wallet expiry sweep — interval ${intervalMs}ms < 60_000ms`);
      return;
    }

    // First fire after a short delay so a redeploy storm doesn't synchronise
    // every replica's sweep at the same instant. Math.random() across
    // replicas gives a natural jitter.
    const initialDelay = Math.floor(Math.random() * 60_000) + 5_000;
    setTimeout(() => {
      this.tick().catch(e => this.log.warn(`wallet sweep first-tick failed: ${(e as Error).message}`));
      this.timer = setInterval(
        () => this.tick().catch(e => this.log.warn(`wallet sweep tick failed: ${(e as Error).message}`)),
        intervalMs,
      );
      // Unref so Jest / shutdown don't wait on this timer.
      if (this.timer && typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }, initialDelay);
    this.log.log(`wallet expiry sweep scheduled every ${intervalMs}ms (first fire in ~${initialDelay}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const result = await this.wallet.sweepExpiredCredits();
    if (result.batches > 0) {
      this.log.log(`sweep done: ${result.batches} batch(es), ${result.creditsExpired} BC reclaimed`);
    }
    // Piggyback the ledger↔balance reconciliation probe (audit F-12) on the
    // same hourly tick — detection-only, so running it often is harmless.
    const recon = await this.wallet.reconcileBalances();
    if (recon.drifted > 0) {
      this.log.warn(`wallet reconciliation: ${recon.drifted}/${recon.checked} wallet(s) drifted — see drift warnings above`);
    }
  }
}
