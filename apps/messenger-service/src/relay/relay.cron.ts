import {Injectable, Logger} from '@nestjs/common';
import {Cron, CronExpression} from '@nestjs/schedule';
import {EnvelopeService} from './envelope.service';
import {BackupService} from '../backup/backup.service';
import {RedisService} from '../redis/redis.service';
import {runWithReplicaLock} from '../redis/replica-lock';

/**
 * Daily orphan sweep for the pending ZSETs. Redis handles the
 * authoritative TTL on `env:*` keys; this job prunes members left
 * behind in `pending:{user}:{dev}` after expiry. Runs at 03:00 UTC
 * by default — adjust via CRON_DAILY_SWEEP env var.
 *
 * Round 8 — also drives the sealed_envelope_archive retention sweep.
 * The archive table previously had no retention sweeper at all
 * (despite the migration comment promising "90 days, sweep via a
 * separate cron"). Without it, every accepted envelope grew the
 * table unboundedly.
 */
@Injectable()
export class RelayCron {
  private readonly logger = new Logger(RelayCron.name);

  constructor(
    private readonly envelopes: EnvelopeService,
    private readonly backup: BackupService,
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {name: 'relay.orphan-sweep'})
  async dailySweep(): Promise<void> {
    // HIGH-2 — exactly one replica sweeps per tick. TTL (10 min) > worst-case
    // full pending:* SCAN runtime so a slow sweep can't lose its lock.
    await runWithReplicaLock(this.redis, 'relay:orphan-sweep:lock', 600, async () => {
      const removed = await this.envelopes.sweepAllOrphans();
      this.logger.log(`orphan-sweep removed=${removed}`);
    });
  }

  /**
   * Round 8 — sealed-archive retention sweep. Daily at 03:30 UTC so it
   * doesn't collide with the orphan sweep above. 90-day default; the
   * service-level method honours an override for tests.
   */
  @Cron('30 3 * * *', {name: 'backup.archive-sweep'})
  async archiveSweep(): Promise<void> {
    await runWithReplicaLock(this.redis, 'backup:archive-sweep:lock', 600, async () => {
      try {
        const removed = await this.backup.sweepSealedArchive();
        this.logger.log(`archive-sweep removed=${removed}`);
      } catch (e) {
        this.logger.error(`archive-sweep failed: ${(e as Error).message}`);
      }
    });
  }
}
