import {
  Controller, Post, Get, Patch, Delete, Body, UseGuards, HttpCode,
  Req, Res, ForbiddenException,
} from '@nestjs/common';
import {Throttle, SkipThrottle} from '@nestjs/throttler';
import type {Request, Response, CookieOptions} from 'express';
import {randomBytes} from 'node:crypto';
import {AuthService}        from './auth.service';
import {JwtService}         from './jwt.service';
import {RedisService}       from '../redis/redis.service';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {CurrentUser}        from '../common/decorators/current-user.decorator';
import type {AccessClaims}  from './jwt.service';
import {RegisterDto}        from './dto/register.dto';
import {RegisterVerifyDto}  from './dto/register-verify.dto';
import {LoginDto}           from './dto/login.dto';
import {VerifyDto}          from './dto/verify.dto';
import {RefreshDto}         from './dto/refresh.dto';
import {SessionDeleteDto}   from './dto/session-delete.dto';
import {ChangePasswordDto}  from './dto/change-password.dto';
import {UpdateProfileDto}   from './dto/update-profile.dto';
import {clientIp}           from '../common/http/client-ip';

const ip = clientIp;

// Audit fix 0.4 — cookie helpers.
//
// `bravo_ops_token` carries the access JWT. httpOnly so JS can't read it,
// Secure in prod, SameSite=Lax so it survives top-level navigation from
// e.g. an email link to ops.bravosecure.com/bookings/<id> — Strict would
// drop the cookie on cross-site GETs and force a re-login on every paged
// admin's first click. CSRF protection comes from the JS-readable
// `bravo_ops_csrf` cookie + `X-CSRF-Token` header (double-submit); Lax
// only allows cross-site GETs, which the CsrfGuard skips anyway.
const isProd = process.env.NODE_ENV === 'production';

// Optional cross-subdomain cookie scope. When the auth-service runs on
// a different subdomain than the ops-console (e.g. auth.94-136-184-52.
// sslip.io vs ops.94-136-184-52.sslip.io on staging, or auth.bravosecure.
// com vs ops.bravosecure.com in prod), the cookies it sets must carry a
// Domain attribute that is the parent of BOTH subdomains — otherwise
// the browser treats them as host-only cookies for the auth host and
// never delivers them to ops requests, causing an infinite /login bounce.
// Set COOKIE_DOMAIN to ".94-136-184-52.sslip.io" on staging and
// ".bravosecure.com" in prod. Unset → no Domain attribute (host-only),
// which is correct for local dev where everything runs on localhost.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

function tokenCookieOptions(maxAgeSec: number): CookieOptions {
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',
    path:     '/',
    maxAge:   maxAgeSec * 1000,
    ...(COOKIE_DOMAIN ? {domain: COOKIE_DOMAIN} : {}),
  };
}

function csrfCookieOptions(maxAgeSec: number): CookieOptions {
  return {
    httpOnly: false, // JS reads this and echoes via header
    secure:   isProd,
    sameSite: 'lax',
    path:     '/',
    maxAge:   maxAgeSec * 1000,
    ...(COOKIE_DOMAIN ? {domain: COOKIE_DOMAIN} : {}),
  };
}

// Audit fix 4.1 — refresh token cookie. httpOnly so JS can't read it
// (XSS-safe), path-scoped to /auth/session/refresh so it never ships to
// other endpoints. TTL matches the refresh JWT (30d default) so the
// browser can ride out a 15-min access expiry without a re-login.
function refreshCookieOptions(maxAgeSec: number): CookieOptions {
  return {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'lax',
    path:     '/auth/session/refresh',
    maxAge:   maxAgeSec * 1000,
    ...(COOKIE_DOMAIN ? {domain: COOKIE_DOMAIN} : {}),
  };
}

function setSessionCookies(
  res: Response,
  accessToken: string,
  expiresIn: number,
  refreshToken?: string,
  refreshTtlSec?: number,
): string {
  res.cookie('bravo_ops_token', accessToken, tokenCookieOptions(expiresIn));
  const csrfToken = randomBytes(32).toString('base64url');
  res.cookie('bravo_ops_csrf', csrfToken, csrfCookieOptions(expiresIn));
  res.setHeader('X-CSRF-Token', csrfToken);
  if (refreshToken && refreshTtlSec) {
    res.cookie('bravo_ops_refresh', refreshToken, refreshCookieOptions(refreshTtlSec));
  }
  return csrfToken;
}

function clearSessionCookies(res: Response): void {
  const dom = COOKIE_DOMAIN ? {domain: COOKIE_DOMAIN} : {};
  res.clearCookie('bravo_ops_token',   {path: '/', ...dom});
  res.clearCookie('bravo_ops_csrf',    {path: '/', ...dom});
  res.clearCookie('bravo_ops_refresh', {path: '/auth/session/refresh', ...dom});
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth:  AuthService,
    private readonly jwt:   JwtService,
    private readonly redis: RedisService,
  ) {}

  // 5 requests per 10-minute window per IP — rate limited by @nestjs/throttler
  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, ip(req));
  }

  // Step 2 of registration — user row is only created here, after Twilio approves the OTP.
  @Throttle({default: {limit: 10, ttl: 600_000}})
  @Post('register/verify')
  @HttpCode(201)
  async registerVerify(@Body() dto: RegisterVerifyDto, @Req() req: Request) {
    return this.auth.registerVerify(dto, ip(req));
  }

  // Audit fix 0.1 — public admin self-registration is disabled.
  //
  // The previous flow let any unauthenticated request POST a chosen role
  // (OPS / SUPERVISOR / ADMIN) and self-mint an admin account, which is
  // an RCE-equivalent: anyone could grant themselves ADMIN. The endpoint
  // is kept routable so monitoring sees the 403, but always rejects.
  //
  // TODO(invite-flow): replacement is invite-only. Existing ADMIN POSTs
  // /admin/invites → server signs a single-use JWT (email + role baked
  // in, 24h TTL, jti tracked in Redis) → emails the link → invitee opens
  // /admin/accept-invite, sets password + TOTP, server verifies the JWT
  // hasn't been redeemed (DEL jti from Redis on first use), creates the
  // user with the baked-in role. Until this lands, ops accounts are
  // provisioned by a one-off seed script run by infra.
  //
  // @deprecated Self-registration disabled. Use the invite flow (TODO).
  @Throttle({default: {limit: 10, ttl: 600_000}})
  @Post('admin-register/verify')
  @HttpCode(403)
  async adminRegisterVerify() {
    throw new ForbiddenException('admin_self_registration_disabled');
  }

  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, ip(req));
  }

  // Audit fix 0.4 — also issue cookies on verify (browser session).
  // Mobile ignores the cookies and uses the body tokens; ops-console
  // ignores the body tokens (they still ship for backward-compat with
  // any extant in-flight clients) and relies on the cookie.
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() dto: VerifyDto,
    @Req()  req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const result = await this.auth.verify(dto, ip(req));
    if (dto.platform === 'web') {
      // Audit fix 4.1 — also drop the refresh token into a path-scoped
      // httpOnly cookie so the ops-console can silently rotate the
      // access JWT ahead of expiry without ever exposing the refresh
      // value to JS. 30d default TTL via JWT_REFRESH_TTL.
      const refreshTtlSec = this.jwt.ttlToSeconds(this.refreshTtl());
      setSessionCookies(res, result.accessToken, result.expiresIn, result.refreshToken, refreshTtlSec);
    }
    return result;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() dto: RefreshDto,
    @Req()  req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const result = await this.auth.refresh(dto, ip(req));
    // Re-set cookies whenever a refresh comes back so the browser session
    // rotates with each new access token. Platform comes from the
    // auth_devices row that originally issued the refresh token, so the
    // cookie is only re-set when the original session was 'web'.
    if (result.platform === 'web') {
      const refreshTtlSec = this.jwt.ttlToSeconds(this.refreshTtl());
      setSessionCookies(res, result.accessToken, result.expiresIn, result.refreshToken, refreshTtlSec);
    }
    return result;
  }

  /**
   * Audit fix 4.1 — cookie-bound refresh for the ops-console.
   *
   * The /auth/refresh body variant exists for mobile (which stores the
   * refresh token in Keychain and sends it in the body). The ops-console
   * never sees its refresh token — it lives in the `bravo_ops_refresh`
   * cookie, httpOnly + path-scoped so a leaking page can't pull it out
   * with a fetch.
   *
   * Path-scoped to `/auth/session/refresh` so the cookie ONLY ships on
   * this endpoint; every other auth-service call gets the access-token
   * cookie only. Reduces blast radius if the refresh path is ever served
   * insecurely (it won't be — Secure flag set in prod).
   */
  @Post('session/refresh')
  @HttpCode(200)
  async sessionRefresh(
    @Req()  req: Request & {cookies?: Record<string, string>},
    @Res({passthrough: true}) res: Response,
  ) {
    const refreshToken = req.cookies?.['bravo_ops_refresh'];
    if (!refreshToken) throw new ForbiddenException('missing_refresh_cookie');
    const result = await this.auth.refresh({refreshToken}, ip(req));
    if (result.platform !== 'web') {
      // Defensive: a non-web refresh token shouldn't be living in our
      // web cookie jar. If it is, clear it and force a re-login.
      clearSessionCookies(res);
      throw new ForbiddenException('non_web_session');
    }
    const refreshTtlSec = this.jwt.ttlToSeconds(this.refreshTtl());
    setSessionCookies(res, result.accessToken, result.expiresIn, result.refreshToken, refreshTtlSec);
    return {expiresIn: result.expiresIn};
  }

  private refreshTtl(): string {
    // Audit fix 4.1 — keep the TTL string in one place. Falls back to 30d
    // if the config wasn't set (matches auth.service.ts:54 default).
    return process.env.JWT_REFRESH_TTL ?? '30d';
  }

  /**
   * Audit fix 0.4 — issue a short-lived "messenger ticket" the JS can
   * read and pass to socket.io / messenger-service REST. Cookie-bound:
   * caller must already be authenticated via the cookie session, so
   * an XSS attacker can't request a ticket without already controlling
   * the page (in which case they'd just call the same APIs directly).
   *
   * The ticket is just a regular access JWT with a 5-minute TTL. The
   * messenger-service validates it via the shared JWT_ACCESS_SECRET.
   * No new validation path needed.
   */
  @UseGuards(JwtAuthGuard)
  @Post('messenger-ticket')
  @HttpCode(200)
  async messengerTicket(
    @CurrentUser() user: AccessClaims,
    @Req() req: Request & {cookies?: Record<string, string>},
  ): Promise<{ticket: string; expiresIn: number}> {
    // Audit fix #10 — cookie-session callers only. The whole point of
    // the ticket is to keep the long-lived JWT out of JS reach for the
    // ops-console; a mobile Bearer caller already holds an access JWT
    // and doesn't need a 5-min rotator. Refusing the Bearer path also
    // means a stolen mobile token can't be silently amplified into an
    // unending stream of fresh 5-min tickets bypassing rotation/audit.
    if (!req.cookies?.['bravo_ops_token']) {
      throw new ForbiddenException('messenger_ticket_requires_cookie_session');
    }
    const ttlSec = 300; // 5 min
    // RS-05 — mint the ticket's role from a FRESH DB read, not the presented
    // token's (possibly stale) claim, so a role that was downgraded or revoked
    // after this session's JWT was issued can't be re-amplified into a new ticket.
    const role = await this.auth.getCurrentRole(user.sub);
    // Bind the ticket to the caller's user id + device id so the
    // messenger-service can keep its per-device queue routing.
    const {accessToken, jti} = await this.jwt.signAccessToken(
      {sub: user.sub, deviceId: user.deviceId, role},
      ttlSec,
    );
    // BUGFIX — the ticket is a real access JWT, so every guard that checks
    // the jti allowlist (JwtAuthGuard → isJtiValid, used by /sender-cert and
    // the relay) requires this jti to be stored. Without it, every freshly
    // minted ticket was rejected as `token_revoked` the instant it was used.
    // TTL matches the ticket lifetime so the key self-expires.
    await this.redis.storeJti(jti, ttlSec);
    return {ticket: accessToken, expiresIn: ttlSec};
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AccessClaims) {
    return this.auth.getMe(user.sub);
  }

  // Self-service profile update (display name + avatar). Returns the same
  // shape as GET /auth/me so the client can refresh its user from the result.
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  @Throttle({default: {limit: 20, ttl: 60_000}})
  updateProfile(@Body() dto: UpdateProfileDto, @CurrentUser() user: AccessClaims) {
    return this.auth.updateProfile(user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('session')
  @HttpCode(200)
  async deleteSession(
    @Body() dto: SessionDeleteDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const out = await this.auth.deleteSession(dto, user.sub, ip(req));
    // Always clear cookies on session delete — covers logout from any
    // device in the user's auth_devices set.
    clearSessionCookies(res);
    return out;
  }

  /**
   * Audit P0-A5 — credential rotation. The user proves possession of
   * the current password before the change, then every live session
   * for this user is revoked so the compromised session that triggered
   * the rotation doesn't outlive it. Browser cookies on THIS request
   * are cleared as a courtesy — mobile clients lose their access JWT
   * via the Redis JTI revoke regardless.
   *
   * Throttled to 5/minute per IP — a brute-forcer with a stolen access
   * token still has to spend real time guessing the current password.
   */
  @UseGuards(JwtAuthGuard)
  @Post('me/password')
  @HttpCode(200)
  @Throttle({default: {limit: 5, ttl: 60_000}})
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AccessClaims,
    @Req() req: Request,
    @Res({passthrough: true}) res: Response,
  ) {
    const out = await this.auth.changePassword(user.sub, dto, ip(req));
    clearSessionCookies(res);
    return out;
  }

  // Audit Rev2 API-01 — health must not be throttled (this controller's other
  // routes are, so skip at the method level, not the class).
  @SkipThrottle()
  @Get('health')
  health() {
    return {ok: true, ts: new Date().toISOString()};
  }
}
