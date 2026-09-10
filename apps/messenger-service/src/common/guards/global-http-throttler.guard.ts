import {ExecutionContext, Injectable} from '@nestjs/common';
import {ThrottlerGuard} from '@nestjs/throttler';
import {UserThrottlerGuard} from './user-throttler.guard';

// Nest's GUARDS_METADATA key — what @UseGuards writes on classes/handlers.
const GUARDS_METADATA = '__guards__';

/**
 * Audit P2-2 / P2-16 — the "global" ThrottlerModule was inert: without an
 * `APP_GUARD` binding nothing ever consulted it, so every controller that
 * didn't explicitly apply `UserThrottlerGuard` (vault, push, sfu, turn,
 * users) shipped with NO rate limit at all. Bound as `APP_GUARD` in
 * `AppModule`, this guard enforces the module-level default (60 req/10 s)
 * on every HTTP route, with two carve-outs:
 *
 *  1. Non-HTTP contexts (the WS gateway) are skipped — `switchToHttp()` on
 *     a ws context yields no req/res and the base guard would throw. The
 *     gateway has its own per-socket + per-user limiter (ws-rate-limiter).
 *
 *  2. Routes whose controller/handler already binds a ThrottlerGuard
 *     subclass via `@UseGuards` (relay, media, backup) are skipped. Those
 *     keep their tuned per-user buckets; stacking the global bucket on top
 *     would double-count and — because `req.caller` is not yet populated
 *     when APP_GUARDs run — the stacked bucket would be IP-keyed, 429ing
 *     legitimate users behind carrier-grade NAT.
 *
 * Tracker: inherits `UserThrottlerGuard` keying (per-user when a caller is
 * attached; IP otherwise). APP_GUARDs run before route guards, so in
 * practice the global bucket is IP-keyed — sufficient to close the
 * unauthenticated/stolen-token DoS gap the audit flagged. Per-route
 * `@Throttle({...})` overrides still apply to this guard via the
 * reflector.
 */
@Injectable()
export class GlobalHttpThrottlerGuard extends UserThrottlerGuard {
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
}
