import type {PackageTier, User} from '@appTypes/index';

/**
 * Paid-tier prices for one 30-day period, in Bravo Credits. Mirror the
 * server constants (auth-service SubscriptionService) — keep the two in
 * lockstep; the paywall shows these and the server charges them.
 * ⚠️ ENTERPRISE_MONTHLY_BC is a placeholder pending founder pricing (M1A Q-A).
 */
export const PRO_MONTHLY_BC = 2000;
export const ENTERPRISE_MONTHLY_BC = 5000;

export const TIER_PRICES_BC = {pro: PRO_MONTHLY_BC, enterprise: ENTERPRISE_MONTHLY_BC} as const;

/**
 * Single source of truth for "is this user on Bravo Pro *right now*?". Pro is a
 * tier, not a role — every client role (individual/corporate) gets Lite for free
 * and layers Pro on top via `subscription_tier`. Prefer this over inline
 * `user?.subscription_tier === 'pro'` checks so the rule lives in one place.
 *
 * RS-19 — a lapsed Pro period (`pro_active_until` set AND in the past) is treated
 * as Lite locally even when cached `subscription_tier` still reads 'pro' (a server
 * downgrade the client hasn't re-pulled yet). Pure client-side guard: it never
 * fabricates 'pro', it only demotes a stale 'pro' whose paid window already closed.
 */
export function isProUser(
  user: Pick<User, 'subscription_tier' | 'pro_active_until'> | null | undefined,
): boolean {
  // M1A superset rule — Enterprise includes everything Pro does, so every
  // existing isProUser() gate admits an active Enterprise account.
  const t = effectiveTier(user);
  return t === 'pro' || t === 'enterprise';
}

/** Reads well at call-sites gating on the live Pro window (RS-19). Same guard as isProUser. */
export const isProActive = isProUser;

/** Effective tier after the local-expiry guard — a paid tier only while its
 *  paid window is live (RS-19); NULL expiry = permanent comp grant (RS-17). */
export function effectiveTier(
  user: Pick<User, 'subscription_tier' | 'pro_active_until'> | null | undefined,
): PackageTier {
  const tier = user?.subscription_tier;
  if (tier !== 'pro' && tier !== 'enterprise') {return 'lite';}
  const until = user?.pro_active_until;
  if (!until) {return tier;} // no expiry recorded → trust the tier (comp/permanent grant)
  const ts = Date.parse(until);
  if (Number.isNaN(ts)) {return tier;} // unparseable timestamp → don't wrongly demote
  return ts > Date.now() ? tier : 'lite';
}
