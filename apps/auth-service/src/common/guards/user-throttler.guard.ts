import {Injectable} from '@nestjs/common';
import {ThrottlerGuard} from '@nestjs/throttler';

/**
 * Audit fix #12 — throttler keyed by authenticated user id, not IP.
 *
 * Default ThrottlerGuard buckets by remote IP, which is too coarse for
 * any endpoint hit from behind NAT (hotel/corporate/mobile carrier).
 * For an SOS surface — where a real emergency is the worst possible
 * moment to throttle a neighbouring user out of their bucket — we
 * switch to per-user tracking. Falls back to IP when there's no
 * authenticated `req.user` (defensive; the route is JWT-gated so
 * this path shouldn't fire in practice).
 *
 * Apply per-route via `@UseGuards(UserThrottlerGuard)` AFTER the
 * JwtAuthGuard so `req.user` is populated when getTracker runs.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req.user as {sub?: string} | undefined);
    if (user?.sub) return `user:${user.sub}`;
    return super.getTracker(req);
  }
}
