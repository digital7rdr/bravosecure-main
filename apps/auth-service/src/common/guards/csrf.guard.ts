import {Injectable, CanActivate, ExecutionContext, ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';

/**
 * Audit fix 0.4 — double-submit CSRF guard.
 *
 * Applied alongside JwtAuthGuard on STATE-CHANGING /ops/* endpoints.
 * Read-only endpoints (GET) are safe by virtue of being GETs (browsers
 * don't auto-submit non-GET cross-origin without an explicit form POST,
 * and SameSite=Strict on the session cookie blocks that anyway).
 *
 * Two-track behavior:
 *   - **Cookie session (browser, ops-console):** require both a
 *     `bravo_ops_csrf` cookie and a matching `X-CSRF-Token` header.
 *     The cookie is set by /auth/verify; the JS reads it (it's NOT
 *     httpOnly) and echoes it on every mutating call. An attacker who
 *     CSRFs us can plant the cookie via SameSite=Lax, but they can't
 *     read its value to put in the header.
 *   - **Bearer token (mobile, scripts):** no cookie session, no CSRF
 *     check. Mobile uses Authorization: Bearer which CSRF can't forge —
 *     attacker would need the token itself, at which point the game's
 *     already over.
 *
 * Failure mode: 403 with code `csrf_token_invalid`. Don't leak whether
 * the cookie is missing vs the header is missing — both branches collapse
 * into the same error, same as Django's default.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & {cookies?: Record<string, string>}>();

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const usingCookieSession = !!req.cookies?.['bravo_ops_token'];
    if (!usingCookieSession) {
      // Bearer-token caller — CSRF doesn't apply.
      return true;
    }

    const cookieCsrf = req.cookies?.['bravo_ops_csrf'];
    const headerCsrf = req.headers['x-csrf-token'];
    if (
      typeof cookieCsrf !== 'string' || cookieCsrf.length === 0 ||
      typeof headerCsrf !== 'string' || headerCsrf.length === 0 ||
      cookieCsrf !== headerCsrf
    ) {
      throw new ForbiddenException('csrf_token_invalid');
    }
    return true;
  }
}
