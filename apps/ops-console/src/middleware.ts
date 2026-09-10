import {NextResponse, type NextRequest} from 'next/server';

/**
 * Audit fix 0.5 — edge auth gate.
 *
 * Until 0.4 lands (move tokens to httpOnly cookies set by /auth/verify),
 * client-side localStorage is the only place we have a session token, and
 * the middleware can't read it. So this gate operates in two modes:
 *
 *   1. Cookie present (post-0.4): allow through, no further check at the
 *      edge. JWT validity is enforced by the auth-service `/ops/me` call
 *      that every page makes on mount. The point of the edge gate is to
 *      stop unauthenticated clients from receiving the RSC payload.
 *   2. Cookie absent (current): redirect to /login. The login page itself,
 *      `/_next/*`, `/favicon.ico`, and static assets are exempt.
 *
 * NOTE: this DOES NOT verify the JWT signature here — that would require
 * shipping the auth-service's HS256 secret to the edge runtime, which is
 * a worse leak than the redirect we're trying to prevent. Signature
 * verification stays at the auth-service. The middleware only enforces
 * "you have SOMETHING that looks like a session" before the page renders.
 *
 * Audit fix 0.6 (revision) — security headers + CSP nonce.
 *
 * Per-request CSP nonce replaces the static 'unsafe-inline' / 'unsafe-eval'
 * allowlist that the build-time next.config headers carried. Next.js reads
 * the nonce from the `x-nonce` request header we set below and stamps it
 * onto every script/style it emits, so RSC + framework chunks stay
 * executable while raw inline `<script>` blocks injected via XSS do not.
 */

// /accept-invite is the RS-09 admin-invite redemption page: the invitee has
// no session yet by definition, so it must be reachable pre-auth.
const PUBLIC_PATHS = ['/login', '/accept-invite'];

const API_BASE     = process.env.NEXT_PUBLIC_API_BASE_URL       ?? 'http://localhost:3001';
// Two env-var names supported for back-compat: the canonical
// NEXT_PUBLIC_MESSENGER_BASE_URL used elsewhere in the app, and the
// shorter NEXT_PUBLIC_MSG_BASE_URL that the staging compose file
// passes as a build-arg. Either resolves; if both are missing we
// fall back to localhost which is fine for dev.
const MSG_BASE     = process.env.NEXT_PUBLIC_MESSENGER_BASE_URL
                  ?? process.env.NEXT_PUBLIC_MSG_BASE_URL
                  ?? 'http://localhost:3100';
// Mapbox GL fetches over multiple subdomains:
//   • api.mapbox.com         — styles, sprites, glyphs
//   • events.mapbox.com      — telemetry
//   • *.tiles.mapbox.com     — raster + vector tile CDN
// Without the tiles wildcard, dashboard maps render the basemap but
// every actual tile request 404s in the console — "map doesn't work".
const MAPBOX_HOSTS = 'https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com';
const IS_PROD      = process.env.NODE_ENV === 'production';

function wsHost(httpUrl: string): string {
  return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Build the CSP string for a given per-request nonce. Dev keeps
 * 'unsafe-eval' because Next.js's fast-refresh client uses `eval` for
 * hot module replacement; prod drops it. Both modes use a nonce instead
 * of 'unsafe-inline' for scripts. Styles keep 'unsafe-inline' for now
 * because Mapbox GL injects inline `<style>` tags at runtime and the
 * nonce isn't reachable from inside its bundle — switching styles to
 * nonce-only would require forking the Mapbox bootstrap.
 */
function buildCsp(nonce: string): string {
  // P0-W1 fix: the root layout now reads `x-nonce` from request headers,
  // which makes Next.js auto-stamp `nonce=...` onto every framework
  // <script> tag it emits. With nonce + 'strict-dynamic', browsers
  // trust any script the nonced loader transitively imports — so the
  // RSC chunks, framework bootstrap, and Mapbox runtime loads all keep
  // working while raw inline <script> blocks injected via XSS do not.
  //
  // Per CSP3 §6.7.2.4, when a nonce/hash IS present, browsers IGNORE
  // 'unsafe-inline' as a backwards-compat shim — but we keep it for
  // older browsers that don't honour 'strict-dynamic'. Modern browsers
  // see the nonce and ignore the unsafe-inline; old browsers fall back.
  //
  // Allow Google Fonts (https://fonts.googleapis.com for CSS, and
  // https://fonts.gstatic.com for the actual font files) — Next/Tailwind
  // pulls Manrope from there at runtime; without these the body text
  // falls back to system fonts and CSP errors spam the console.
  const GOOGLE_FONTS_STYLE = 'https://fonts.googleapis.com';
  const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';
  const scriptSrc = IS_PROD
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' ${MAPBOX_HOSTS}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval' ${MAPBOX_HOSTS}`;
  return [
    `default-src 'self'`,
    scriptSrc,
    // Mapbox GL spawns its tile-decoder web workers from blob: URLs
    // (built at runtime from the worker bundle). Without 'worker-src'
    // the directive falls back to script-src, which doesn't include
    // blob: — workers fail to start and the entire basemap stays
    // black. Allow self + blob: for workers explicitly.
    `worker-src 'self' blob:`,
    `style-src 'self' 'unsafe-inline' ${GOOGLE_FONTS_STYLE} ${MAPBOX_HOSTS}`,
    `img-src 'self' data: blob: ${MAPBOX_HOSTS}`,
    `font-src 'self' data: ${GOOGLE_FONTS_FILES}`,
    `connect-src 'self' ${API_BASE} ${MSG_BASE} ${wsHost(MSG_BASE)} ${MAPBOX_HOSTS}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

function applySecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set('Content-Security-Policy', buildCsp(nonce));
  res.headers.set('X-Frame-Options',         'DENY');
  res.headers.set('X-Content-Type-Options',  'nosniff');
  res.headers.set('Referrer-Policy',         'no-referrer');
  res.headers.set('Permissions-Policy',      'camera=(), microphone=(), geolocation=()');
  // HSTS is prod-only — emitting it from a localhost dev server can
  // poison the browser's HSTS cache for sibling https:// services on the
  // same parent domain (loopback aside, devs often `hosts`-map a real
  // domain to 127.0.0.1).
  if (IS_PROD) {
    res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  const {pathname} = req.nextUrl;

  // Allow Next.js internals + static assets through.
  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // Per-request CSP nonce — 16 random bytes, base64. Carried into the
  // RSC pipeline via the `x-nonce` request header so Next.js can stamp
  // it onto framework-emitted <script> tags.
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Buffer.from(nonceBytes).toString('base64');

  // Audit CFG-04 — health check bypasses the auth gate but still gets the
  // security headers, and matches EXACTLY (not `/api/healthanything`).
  if (pathname === '/api/health') {
    return applySecurityHeaders(NextResponse.next(), nonce);
  }

  // Public pages bypass the auth gate but still get headers.
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);
    return applySecurityHeaders(
      NextResponse.next({request: {headers: requestHeaders}}),
      nonce,
    );
  }

  // Pre-0.4: tokens live in localStorage, the middleware can't see them.
  // Post-0.4: tokens live in an httpOnly cookie called `bravo_ops_token`.
  // We accept the cookie if present; if neither is set we redirect.
  const hasSessionCookie = req.cookies.has('bravo_ops_token');
  if (hasSessionCookie) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-nonce', nonce);
    return applySecurityHeaders(
      NextResponse.next({request: {headers: requestHeaders}}),
      nonce,
    );
  }

  // No cookie — bounce to /login with `next` query so we can return after
  // login. Use `redirect` (302) not `rewrite` so the URL bar updates.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  return applySecurityHeaders(NextResponse.redirect(loginUrl), nonce);
}

// Run on every request EXCEPT static files Next.js manages itself.
// The `_next` exclusion is also enforced inside `middleware` above as a
// belt-and-braces measure.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
