import type {ProApplication} from '@services/api';

/**
 * PDF-1 #1 + Wave 5d (PDF-2 A7) — the Secure product's concrete root screen for
 * a client's tier.
 *
 * A PRO retainer client (an ACTIVE Pro application — their own plan OR a linked
 * family member, since /pro-applications/me returns the owner's ACTIVE row to a
 * member) roots at the Pro dashboard. Everyone else (LITE) roots at the
 * streamlined 4-tab shell (`SecureShell` → SecureTabNavigator: Home · Book ·
 * Summary · Messenger), whose Home tab IS the on-demand Book-Now home. Before
 * Wave 5d the LITE root was the bare `BookingHome` screen; the shell wraps that
 * same home in the 4-tab bar without moving any of the ~55 booking routes.
 *
 * This is the SINGLE tier decision, shared by the tier resolver
 * (`SecureLandingScreen`, the async cold/switch landing) and the drawer's
 * same-product truncation guard (`SwitchDashboardSection`) so the two cannot
 * drift about where a Pro vs Lite client's Secure home is — the truncation guard
 * therefore asks about `SecureShell` for a LITE client, which is the route the
 * resolver actually seeds (asking about the bare `BookingHome` would find nothing
 * once the LITE stack roots at the shell, and the unsaved-form confirm would
 * never fire).
 *
 * NOT the messenger `isProActive` / `subscription_tier` (SP-01: a different
 * product that merely shares the lite/pro vocabulary). Reads ONLY the Secure Pro
 * application status.
 */
export type SecureRoot = 'SecureShell';

/**
 * B-661 — BOTH TIERS NOW ROOT AT THE SHELL. Founder, 2026-08-25.
 *
 * This used to return `ProDashboard` for an ACTIVE Pro client and `SecureShell`
 * for everyone else. That is why a PRO account never saw the 4-tab footer no
 * matter how many builds they installed: `ProDashboard` is not in
 * `SECURE_FULLSCREEN_ROUTES`, so it kept the ROOT tab bar (Messenger · Profile)
 * — and the founder read a permanently-stale-looking footer as "the update is
 * not landing" when in fact the tier had routed them away from the new shell
 * before it could render.
 *
 * The tier decision has not disappeared, it MOVED one level in: the shell's Home
 * tab renders the Pro dashboard for an ACTIVE client and the Book-Now home for
 * everyone else (`SecureTabNavigator`). So a PRO client keeps landing on their
 * dashboard AND gains the footer; a LITE client is unchanged.
 *
 * The return type is deliberately narrowed to the single literal rather than
 * left as a two-member union: a union whose second member is now unreachable
 * invites a `=== 'ProDashboard'` branch that can never run, and TypeScript will
 * flag any such comparison as an error instead of letting it rot.
 */
export function secureRootRoute(_application: ProApplication | null | undefined): SecureRoot {
  return 'SecureShell';
}
