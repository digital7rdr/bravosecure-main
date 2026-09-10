/**
 * Read the routing hints out of our own access token, WITHOUT verifying it.
 *
 * ⚠️ SECURITY BOUNDARY — read this before using anything here.
 *
 * These claims are NEVER a grant. The signature is not checked (the secret
 * lives on auth-service and must stay there), so nothing returned by this
 * module may authorize an action, unlock data, or widen access. The single
 * legitimate use is choosing which LOCAL SCREEN to render while the server is
 * unreachable: every request the resulting screen makes is still authorized
 * server-side, and `/auth/me` overwrites the guess the moment it succeeds.
 *
 * Shape comes from auth-service `jwt.service.ts` signAccessToken:
 *   {sub: <userId>, role: <UserRole>, device_id: <deviceId>, jti, exp, iat}
 */
import type {User, UserRole} from '@appTypes/index';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  deviceId?: string;
  /** Seconds since epoch, as minted by auth-service. */
  exp?: number;
}

const KNOWN_ROLES: readonly string[] = [
  'individual', 'corporate', 'agent', 'service_provider', 'ops',
];

/**
 * base64url → UTF-8 string. `atob` yields one char per BYTE (latin1), so a
 * multi-byte name anywhere in the payload would corrupt `JSON.parse` unless the
 * bytes are re-assembled — cheap insurance for a function whose whole job is to
 * survive inputs it did not create.
 */
function decodeBase64UrlUtf8(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const b64 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
    const binary = (globalThis as {atob?: (s: string) => string}).atob?.(b64);
    if (typeof binary !== 'string') {return null;}
    let percent = '';
    for (let i = 0; i < binary.length; i++) {
      percent += '%' + binary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return decodeURIComponent(percent);
  } catch { return null; }
}

/**
 * Decode the payload of a JWT. Returns null for anything that is not a
 * well-formed token carrying a usable `sub` + known `role` — a garbage or
 * truncated token must never produce a half-built session.
 */
export function decodeAccessTokenClaims(token: string | null | undefined): AccessTokenClaims | null {
  if (!token || typeof token !== 'string') {return null;}
  const parts = token.split('.');
  if (parts.length !== 3) {return null;}
  const json = decodeBase64UrlUtf8(parts[1]);
  if (!json) {return null;}
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json) as Record<string, unknown>; }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') {return null;}

  const sub = parsed.sub;
  const role = parsed.role;
  if (typeof sub !== 'string' || sub.length === 0) {return null;}
  // An unknown role can't drive the role-gated navigator any better than no
  // session at all, and guessing one would route the user into the wrong
  // product. Refuse instead.
  if (typeof role !== 'string' || !KNOWN_ROLES.includes(role)) {return null;}

  const deviceId = typeof parsed.device_id === 'string' ? parsed.device_id : undefined;
  const exp = typeof parsed.exp === 'number' ? parsed.exp : undefined;
  return {sub, role: role as UserRole, deviceId, exp};
}

/**
 * The smallest `User` that can drive RootNavigator, built from token claims.
 *
 * Deliberately carries NONE of the §35A routing fields (`account_kind`,
 * `managed_org`, `permitted_modules`, `workspaces`, …): they are not in the
 * token, and inventing them is how a manager lands in the wrong product. An
 * absent field means "unknown", which every consumer already handles because
 * that is exactly the state before the first `/auth/me` of a fresh login.
 *
 * Marked so the rest of the app can tell a guessed identity from a verified
 * one — see `sessionUnverified` in authStore, which keeps this shape out of the
 * durable boot snapshot.
 */
export function minimalUserFromClaims(claims: AccessTokenClaims): User {
  return {
    id: claims.sub,
    phone: '',
    full_name: '',
    role: claims.role,
    is_verified: false,
    created_at: '',
  };
}
