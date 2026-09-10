import {Injectable, Logger} from '@nestjs/common';
import {Cron, CronExpression} from '@nestjs/schedule';
import {RedisService} from '../redis/redis.service';
import {PresenceService} from './presence.service';

/**
 * Reaps stale presence state. The presence counter has a 1h TTL but the
 * state record has a 30d TTL — if a gateway process crashes (kill -9,
 * OOM, network partition) before its disconnect handler runs, the state
 * key remains `online` long after the user is actually gone. Without
 * this sweep, peers see a phantom `online` dot for up to 30 days.
 *
 * Runs every 5 minutes, bounded by the counter TTL — worst-case stale
 * window is ~65 min (1h counter expiry + sweep cadence). Faster cadence
 * would only marginally improve UX while increasing Redis load.
 *
 * Multi-replica safe via a Redis advisory lock. Without the lock every
 * pod scans the same keys and broadcasts duplicate offline frames; with
 * it, exactly one pod sweeps per tick.
 */
@Injectable()
export class PresenceCron {
  private readonly logger = new Logger(PresenceCron.name);
  private static readonly LOCK_KEY     = 'presence:reaper:lock';
  private static readonly LOCK_TTL_SEC = 240;

  constructor(
    private readonly redis:    RedisService,
    private readonly presence: PresenceService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {name: 'presence.reaper'})
  async reap(): Promise<void> {
    const instanceId = `${process.pid}-${Date.now()}`;
    const acquired = await this.redis.client.set(
      PresenceCron.LOCK_KEY, instanceId, 'EX', PresenceCron.LOCK_TTL_SEC, 'NX',
    );
    if (acquired !== 'OK') {
      this.logger.debug('presence-reaper skip — another replica holds the lock');
      return;
    }
    const startedAt = Date.now();
    try {
      const {scanned, reaped} = await this.presence.sweepStale();
      const durationMs = Date.now() - startedAt;
      if (reaped > 0) {
        this.logger.warn(`presence-reaper scanned=${scanned} reaped=${reaped} durationMs=${durationMs}`);
      } else {
        this.logger.log(`presence-reaper scanned=${scanned} reaped=0 durationMs=${durationMs}`);
      }
    } catch (err) {
      this.logger.error(`presence-reaper error ${(err as Error).message}`);
    } finally {
      // Best-effort release; worst case the lock self-expires under TTL.
      const held = await this.redis.client.get(PresenceCron.LOCK_KEY);
      if (held === instanceId) {
        await this.redis.client.del(PresenceCron.LOCK_KEY).catch(() => { /* ignore */ });
      }
    }
  }
}
