import {Injectable} from '@nestjs/common';
import {ThrottlerGuard} from '@nestjs/throttler';

/**
 * Audit P0-5 — HTTP throttler keyed by authenticated user id, not IP.
 *
 * Default `ThrottlerGuard` buckets by remote IP, which is too coarse
 * for the relay surface: every device behind a NAT shares one bucket,
 * and one chatty user starves the rest of the LAN. Carrier-grade NAT
 * (mobile networks) is worse — thousands of subscribers behind one
 * upstream IP.
 *
 * We bucket by the authenticated `claims.sub` populated by
 * `JwtHttpGuard` (which runs first on every guarded route). Falls back
 * to IP only when no caller is attached — defensive; the routes that
 * apply this guard are all JWT-gated upstream.
 *
 * Mirrors `apps/auth-service/src/common/guards/user-throttler.guard.ts`
 * so the two services have the same operator-facing knob shape.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const caller = req['caller'] as {claims?: {sub?: string}} | undefined;
    if (caller?.claims?.sub) return `user:${caller.claims.sub}`;
    return super.getTracker(req);
  }
}
