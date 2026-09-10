import type {RedisService} from './redis.service';

/**
 * Audit HIGH-2 (2026-07-02): run `fn` on AT MOST ONE replica per tick.
 *
 * Every @Cron in a NestJS app fires on EVERY replica. Only `presence.reaper`
 * was guarded; the envelope/archive/media/backup sweeps each ran N times —
 * N concurrent `pending:*` SCANs, N R2 `ListObjectsV2` paginations, N Supabase
 * drains — the instant the service scales past one pod. This is the single
 * shared guard: a `SET <key> <id> NX EX <ttl>` advisory lock. The loser skips
 * this tick (the winner covers the whole cluster); the lock self-expires under
 * TTL so a crashed holder never wedges the job forever.
 *
 * TTL must exceed the job's worst-case runtime so a slow sweep can't have its
 * lock expire and let a second replica start a concurrent run.
 */
export async function runWithReplicaLock(
  redis: RedisService,
  lockKey: string,
  ttlSec: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  // Unique holder id so only the acquiring replica deletes its own lock —
  // never one whose TTL already lapsed and was re-acquired by another pod.
  const instanceId = `${process.pid}-${lockKey}-${Date.now()}`;
  const acquired = await redis.client.set(lockKey, instanceId, 'EX', ttlSec, 'NX');
  if (acquired !== 'OK') {return false;}
  try {
    await fn();
    return true;
  } finally {
    // Best-effort compare-and-delete; worst case the lock self-expires.
    try {
      const held = await redis.client.get(lockKey);
      if (held === instanceId) {await redis.client.del(lockKey);}
    } catch { /* ignore — TTL cleans up */ }
  }
}
