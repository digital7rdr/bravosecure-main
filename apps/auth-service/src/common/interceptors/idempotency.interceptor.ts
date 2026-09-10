import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor, BadRequestException,
  ConflictException,
} from '@nestjs/common';
import type {Request} from 'express';
import {Observable, of} from 'rxjs';
import {tap, switchMap} from 'rxjs/operators';
import {createHash} from 'node:crypto';
import {RedisService} from '../../redis/redis.service';
import type {AccessClaims} from '../../auth/jwt.service';
import type {AdminContext} from '../../ops/admin.guard';

const PREFIX = 'idem:';
const TTL_SEC = 24 * 60 * 60;          // 24 hours per audit fix 4.3
const KEY_MIN = 8;
const KEY_MAX = 128;
// Regex matches typical client-side UUID v4 / nanoid / base64url ids.
const KEY_RE = /^[A-Za-z0-9_-]+$/;
// INFRA-11 — sentinel written by the atomic reservation. A completed response is
// always JSON (object/array/`null` — quoted or braced), so this bare non-JSON
// marker can never be produced by JSON.stringify and thus never mistaken for a
// real response. Compared by exact string equality, never parsed.
const IN_PROGRESS = 'idem:in-progress';

/**
 * Audit fix 4.3 — Idempotency-Key interceptor.
 *
 * Apply to handlers that perform a non-idempotent state transition
 * (approve, dispatch, complete, ack, decide, terminate). The client
 * MUST send `Idempotency-Key: <opaque>` (8–128 chars, [A-Za-z0-9_-]).
 * A replay within 24h returns the cached response from the first call;
 * the underlying handler is never invoked twice.
 *
 * Cache key: `idem:<sha256(admin_id + ':' + method + ' ' + route + ':' + key)>`.
 * Scoped to the admin so two admins can't collide on the same key value,
 * and to (method, route) so an idempotent GET key doesn't poison a POST.
 *
 * INFRA-11 — the slot is RESERVED atomically (`SET … NX`) BEFORE the handler
 * runs, not written after it completes. A double-tap race therefore has exactly
 * one winner: the loser sees the reservation and is told to retry (409) rather
 * than executing the money-moving handler a second time. On completion the
 * marker is overwritten with the real response; on handler error (or a
 * non-serializable response) the reservation is RELEASED so a retry can proceed.
 *
 * Failure modes:
 *   - missing header   → 400 (opt-in is explicit per call)
 *   - bad shape        → 400 (catches accidental typos before they cache)
 *   - concurrent in-flight sibling → 409 (retry the same key)
 *   - non-serializable response → reservation released (replay re-executes)
 *   - thrown exception → reservation released (client can retry the same key)
 *   - Redis unavailable → fails CLOSED (throws); the DB conditional-UPDATE
 *     guards remain the money backstop, so this never enables a double effect.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request & {user?: AccessClaims; admin?: AdminContext}>();
    const header = req.header('idempotency-key') ?? req.header('Idempotency-Key');
    if (!header) {
      throw new BadRequestException('idempotency_key_required');
    }
    if (header.length < KEY_MIN || header.length > KEY_MAX || !KEY_RE.test(header)) {
      throw new BadRequestException('idempotency_key_invalid_shape');
    }

    const actor = req.admin?.user_id ?? req.user?.sub ?? 'anon';
    const route = `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`;
    // Hash inside Redis so an attacker who reads the cache can't see
    // customer-provided keys. Recomputable per request from headers +
    // req.admin, so no decode is needed on read.
    const cacheKey = PREFIX + createHash('sha256')
      .update(`${actor}:${route}:${header}`)
      .digest('hex');

    // Atomic reserve-or-detect: exactly one caller wins the slot with NX. The
    // window between two concurrent misses (which previously both ran the
    // handler) no longer exists — the loser never reaches next.handle().
    const reserved = await this.redis.client.set(cacheKey, IN_PROGRESS, 'EX', TTL_SEC, 'NX');
    if (reserved !== 'OK') {
      const existing = await this.redis.client.get(cacheKey);
      if (existing && existing !== IN_PROGRESS) {
        try {
          return of(JSON.parse(existing));
        } catch {
          // Corrupt cached row — do NOT silently re-run a money handler behind
          // the same key; surface a retryable conflict and drop the bad row.
          await this.redis.client.del(cacheKey).catch(() => undefined);
          throw new ConflictException('idempotency_key_conflict');
        }
      }
      // The reservation is held by a still-in-flight sibling (double-tap) — tell
      // the client to retry once the first call has settled.
      throw new ConflictException('idempotency_key_in_progress');
    }

    return next.handle().pipe(
      switchMap(async (result) => {
        try {
          const serialized = JSON.stringify(result ?? null);
          await this.redis.client.set(cacheKey, serialized, 'EX', TTL_SEC);
        } catch {
          // Non-serializable response — the first call already executed, so we
          // return the result but RELEASE the reservation (rather than leaving a
          // 24h IN_PROGRESS marker that would 409 every retry). A replay misses
          // and re-executes the handler.
          await this.redis.client.del(cacheKey).catch(() => undefined);
        }
        return result;
      }),
      tap({error: () => {
        // Thrown handler errors are intentionally NOT cached, and the reservation
        // is released so the client can retry with the same key after a failure.
        void this.redis.client.del(cacheKey).catch(() => undefined);
      }}),
    );
  }
}

/** Helper for tests / non-NestJS callers — same key derivation as the interceptor. */
export function computeIdempotencyCacheKey(actor: string, method: string, route: string, key: string): string {
  return PREFIX + createHash('sha256')
    .update(`${actor}:${method.toUpperCase()} ${route}:${key}`)
    .digest('hex');
}
