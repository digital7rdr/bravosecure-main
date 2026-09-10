import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin ioredis wrapper for messenger-service. Unlike auth-service's
 * RedisService, we don't maintain a JTI allowlist here — the envelope
 * relay uses raw KV + sorted sets. M10 introduces JTI revocation
 * lookups so tokens revoked at auth-service close open WS sessions.
 *
 * The client is created lazy (`lazyConnect: true`) and connected on
 * module init so we fail fast at startup if Redis is unreachable.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  client!: Redis;

  constructor(private readonly config: ConfigService) {}

  /** HIGH-3 — surfaced to /ready so the LB drains a pod that lost Redis. */
  get isReady(): boolean {
    return this.client?.status === 'ready';
  }

  async onModuleInit(): Promise<void> {
    // Tests substitute a mock client via overrideProvider — skip real
    // connect in that case (the mock is already usable).
    if (this.client) return;
    this.client = new Redis(this.config.get<string>('redis.url')!, {
      lazyConnect:          true,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
      // Audit HIGH-3 (2026-07-02): survive a managed-Redis failover / AZ blip
      // instead of wedging every stateful plane. Without an explicit
      // retryStrategy ioredis stops reconnecting after the default budget on
      // some paths; keep trying forever with capped backoff so the service
      // self-heals when the primary is re-elected.
      retryStrategy:  (times: number) => Math.min(times * 200, 5_000),
      // Reconnect specifically on a failover READONLY error (replica promoted
      // to primary mid-flight) — ioredis re-resolves the endpoint.
      reconnectOnError: (err: Error) => /READONLY|ETIMEDOUT|ECONNRESET/.test(err.message),
      // Sentinel/Cluster are configured purely via REDIS_URL / ioredis options
      // at deploy time; this client transparently follows a `redis+sentinel://`
      // or cluster endpoint without code changes.
      keepAlive:      30_000,
    });
    this.client.on('error',      (err: Error) => this.logger.error('Redis error ' + err.message));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting…'));
    this.client.on('ready',      () => this.logger.log('Redis ready'));
    this.client.on('end',        () => this.logger.error('Redis connection ended'));
    await this.client.connect();
    this.logger.log('Redis connected');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.status !== 'end') {
      await this.client.quit().catch(() => { /* ignore */ });
    }
  }

  /**
   * DTO audit P0-V3 — JTI revocation lookup against the shared Redis
   * allowlist auth-service maintains. `auth-service/redis.service.ts`
   * writes `jti:<jti>` = '1' on `issueSession` (with the access-token
   * TTL) and `DEL`s on revoke. Both services point at the same Redis
   * URL via `REDIS_URL`, so the messenger guard can read the same
   * allowlist directly — no cross-service RPC needed.
   *
   * Returns `true` when the JTI is still valid (key present), `false`
   * when revoked or expired. Open-world default: if the key was never
   * issued by auth-service (e.g. a token signed by a stale auth
   * deployment that didn't write to this Redis), this returns
   * `false`, which the guard treats as revoked — the safer policy
   * for a relay that holds plaintext-adjacent state.
   */
  async isJtiValid(jti: string): Promise<boolean> {
    return (await this.client.exists(`jti:${jti}`)) === 1;
  }
}
