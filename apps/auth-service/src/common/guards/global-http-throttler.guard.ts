import {ExecutionContext, Injectable, Logger} from '@nestjs/common';
import {ThrottlerGuard, type ThrottlerLimitDetail} from '@nestjs/throttler';
import {UserThrottlerGuard} from './user-throttler.guard';

// Nest's GUARDS_METADATA key — what @UseGuards writes on classes/handlers.
const GUARDS_METADATA = '__guards__';

/**
 * Audit Rev2 API-01 — the ThrottlerModule in AppModule was INERT: with no
 * `APP_GUARD` binding, nothing ever consulted it, so every `@Throttle(...)`
 * decorator in auth-service was dead metadata and /auth/register, /auth/login,
 * /wallet/topup, /users/lookup and every ops route had ZERO rate limiting.
 * messenger-service fixed exactly this and it was never brought across. Bound
 * as `APP_GUARD` in AppModule, this guard enforces the module default on every
 * HTTP route, with two carve-outs (copied verbatim from messenger-service):
 *
 *  1. Non-HTTP contexts are skipped — `switchToHttp()` would yield no req/res.
 *
 *  2. Routes whose controller/handler already binds a ThrottlerGuard subclass
 *     via `@UseGuards` (the 8 controllers that use UserThrottlerGuard — sos,
 *     dispatch, family, vbg, news, …) are skipped. Those keep their tuned
 *     per-USER buckets; stacking this global bucket on top would re-apply each
 *     route's tight `@Throttle` on an IP bucket instead — turning
 *     sos.controller's {limit:3, ttl:60s} into 3 panic-raises per minute per
 *     NAT, resurrecting the exact bug audit fix #12 killed.
 *
 * Health checks and the Stripe webhooks carry `@SkipThrottle()` instead (a
 * throttled /ready crashloops the pod; a throttled webhook makes Stripe retry
 * for 3 days and voids the API-06 dedupe).
 *
 * Tracker: inherits UserThrottlerGuard keying (per-user when a caller is
 * attached; IP otherwise). APP_GUARDs run before route guards, so the global
 * bucket is IP-keyed — and `trust proxy` is now a hop count (main.ts), so that
 * IP is the real client, not a spoofable leftmost X-Forwarded-For.
 */
@Injectable()
export class GlobalHttpThrottlerGuard extends UserThrottlerGuard {
  private readonly log = new Logger(GlobalHttpThrottlerGuard.name);

  // Audit Rev2 API-01 — SHADOW MODE by default. The guard is bound and the
  // @Throttle limits are now consulted, but a breach is LOGGED, not 429'd,
  // until THROTTLE_ENFORCE=true. This is deliberate: the module default is
  // IP-keyed (APP_GUARDs run before JwtAuthGuard, so req.user isn't set yet),
  // and several high-frequency AUTHENTICATED pollers are not per-user keyed
  // (live-mission telemetry GPS, booking, keys fan-out, notifications/events).
  // On shared carrier-grade NAT the IP ceiling could 429 those mid-mission.
  // Ship one release in shadow mode, read the [throttle-shadow] lines to size
  // the real per-IP rates, move those pollers to UserThrottlerGuard/@SkipThrottle,
  // THEN flip THROTTLE_ENFORCE=true. Shadow mode still closes nothing worse than
  // today (limits already did nothing); it just makes them observable first.
  private readonly enforce = process.env['THROTTLE_ENFORCE'] === 'true';

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const declared: unknown[] = [
      ...(Reflect.getMetadata(GUARDS_METADATA, context.getClass()) ?? []),
      ...(Reflect.getMetadata(GUARDS_METADATA, context.getHandler()) ?? []),
    ];
    return declared.some(
      g => typeof g === 'function' && (g === ThrottlerGuard || g.prototype instanceof ThrottlerGuard),
    );
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    if (!this.enforce) {
      const req = context.switchToHttp().getRequest<{method?: string; url?: string; ip?: string}>();
      this.log.warn(
        `[throttle-shadow] WOULD 429 ${req?.method ?? '?'} ${req?.url ?? '?'} ` +
        `ip=${req?.ip ?? '?'} limit=${detail.limit} ttl=${detail.ttl}ms ` +
        `— not enforced (set THROTTLE_ENFORCE=true after sizing per-IP rates)`,
      );
      return;
    }
    return super.throwThrottlingException(context, detail);
  }
}
