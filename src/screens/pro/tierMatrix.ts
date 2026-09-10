/**
 * M1A §2 — the approved tier matrix, single client-side source of truth.
 * Rendered IN FULL wherever a tier is described (never "all Lite features +"
 * shorthand).
 *
 * TIER_LABELS names the MESSENGER subscription ladder
 * (users.subscription_tier): Bravo Messenger Lite / Bravo Messenger Pro /
 * Enterprise. "Bravo Secure Pro" is a DIFFERENT product — the
 * request-and-approval protection plan (pro_applications) — and its name may
 * only appear in PRODUCT_PLANS.secure below. Keeping the two families apart
 * is pinned by lockedTerminology.test.ts.
 */
export const TIER_LABELS = {
  lite: 'Bravo Messenger Lite',
  pro: 'Bravo Messenger Pro',
  enterprise: 'Enterprise',
} as const;

export const LITE_FEATURES = [
  'Messenger',
  'Group Chats',
  'Voice and Video Calls (up to 10 people)',
  'Secure Phone Vault',
  'News',
  'Encryption AES-256',
];

export const PRO_FEATURES = [
  ...LITE_FEATURES,
  'Cloud Backup',
  'Secure Cloud Vault (100MB free)',
];

// A7.3 — "use Member terminology; remove remaining Employee or CPO labels."
// This row read "Employee Attendance Tracking" on the Enterprise plan tile, and
// the PDF's own prose (page 1 LOCKED RULES and frame A2) calls the module plain
// Attendance. The FEATURE is unchanged — this list is copy only; the module,
// its routes and `attendanceApi` are untouched.
export const ENTERPRISE_FEATURES = [
  ...PRO_FEATURES,
  'Department Channels',
  'Attendance Tracking',
  'Incident Reporting',
];

export const TIER_FEATURES = {
  lite: LITE_FEATURES,
  pro: PRO_FEATURES,
  enterprise: ENTERPRISE_FEATURES,
} as const;

// ─── Issue 22 — plans are scoped by PRODUCT PATH ────────────────────────────
//
// The lists above describe the MESSENGER product. Onboarding rendered them
// regardless of which card the user tapped, so someone entering through Secure
// Services was offered "Group Chats" and "Voice and Video Calls" and no mention
// of booking a detail. PDF p.5 locks one plan pair per product family; the
// tier IDS (lite/pro/enterprise) stay shared because the subscription ladder,
// the paywall and the entitlement checks are all keyed on them.
//
// The Secure Services lines below describe functionality this app actually
// ships on that path (BookingHome -> ServiceType -> dispatch -> LiveTracking,
// and the ProDashboard suite). Exact marketing wording is a product-owner call
// — see docs/handoffs/BOOKING_BUGS_V2_FIX_PLAN.md §10.

export const SECURE_LITE_FEATURES = [
  'On-demand CPO booking',
  'Secure Transfer (point to point)',
  'Live mission tracking',
  'Team verification code on arrival',
  'Bravo Control System monitoring',
  'Bravo Credits wallet',
];

export const SECURE_PRO_FEATURES = [
  ...SECURE_LITE_FEATURES,
  'Retainer teams',
  'Itinerary & travel alerts',
  'Assigned team profiles',
  'AI-assisted scheduling',
  'Risk review reports',
];

export const VBG_FEATURES = [
  'AI safety monitoring',
  'Security Risk Assessment',
  'OSINT threat feed',
  'Geo-risk mapping',
  'Emergency escalation',
];

/** A plan offered on one product path. `tier` drives signup + the paywall. */
export interface ProductPlan {
  tier: 'lite' | 'pro' | 'enterprise';
  title: string;
  eyebrow: string;
  desc: string;
  features: string[];
}

/**
 * The plans a given product path may offer, using the LOCKED names from PDF p.5.
 * Department Channels and Virtual Bodyguard are separate products, so the
 * Enterprise tier belongs to the Messenger/Department path only.
 */
export const PRODUCT_PLANS: Record<'messenger' | 'secure' | 'vbg', ProductPlan[]> = {
  secure: [
    {
      tier: 'lite', title: 'Bravo Secure Lite', eyebrow: 'Personal · Free',
      desc: 'Book a protection detail on demand. Free to join.',
      features: SECURE_LITE_FEATURES,
    },
    {
      tier: 'pro', title: 'Bravo Secure Pro', eyebrow: 'Personal · Subscription',
      desc: 'Retained teams, travel planning and risk reporting.',
      features: SECURE_PRO_FEATURES,
    },
  ],
  messenger: [
    {
      tier: 'lite', title: 'Bravo Messenger Lite', eyebrow: 'Personal · Free',
      desc: 'Secure messaging for everyone. Free forever.',
      features: LITE_FEATURES,
    },
    {
      tier: 'pro', title: 'Bravo Messenger Pro', eyebrow: 'Personal · Subscription',
      desc: 'Everything in Lite plus your encrypted cloud vault.',
      features: PRO_FEATURES,
    },
    {
      tier: 'enterprise', title: 'Enterprise', eyebrow: 'Business · Subscription',
      desc: 'Run your team: Department Channels, attendance and incident reporting.',
      features: ENTERPRISE_FEATURES,
    },
  ],
  vbg: [
    {
      tier: 'lite', title: 'Virtual Bodyguard', eyebrow: 'Personal · Free',
      desc: 'AI safety monitoring and risk intelligence.',
      features: VBG_FEATURES,
    },
  ],
};

/**
 * F9 / PDF A2 + M2 — "the Professional plan must not appear in the Enterprise
 * onboarding route."
 *
 * `plansForProduct` is the ONBOARDING plan list and nothing else: its only
 * production caller is `RoleSelectionScreen.cardsForProduct`, the pre-auth
 * plan picker reached from the product cards. The Enterprise plan is sold on
 * the MESSENGER path (Department Channels is a tier of that ladder, see
 * PRODUCT_PLANS), so that path IS the Enterprise onboarding route, and the rule
 * lands here.
 *
 * WHAT THIS MUST NOT TOUCH — the reason the filter is a selector and not an
 * edit to `PRODUCT_PLANS`:
 *
 *   - `src/screens/settings/PricingScreen.tsx` is Settings -> Pricing, where any
 *     user MANAGES their own plan. It reads TIER_LABELS / TIER_FEATURES, not
 *     this function. Filtering Professional out of that screen would strand
 *     every live Pro subscriber with no current-plan row and no downgrade path.
 *   - `TierPaywall` reads the same two maps, so an existing Pro purchase flow
 *     still resolves its label and features.
 *   - The SECURE path keeps "Bravo Secure Pro": that is the request-and-approval
 *     protection plan, a different product family (lockedTerminology.test.ts),
 *     not the Professional messenger tier A2 names.
 *
 * So `PRODUCT_PLANS` stays the full catalogue and only the onboarding VIEW of it
 * narrows.
 */
const ONBOARDING_HIDDEN: Partial<Record<'messenger' | 'secure' | 'vbg', ProductPlan['tier'][]>> = {
  messenger: ['pro'],
};

/** Plans for the tapped product card. Falls back to Messenger when the path is
 *  unknown (deep link, cold start), which is the historical behaviour. */
export function plansForProduct(product: 'messenger' | 'secure' | 'vbg' | null | undefined): ProductPlan[] {
  // Resolve the KEY first, not just the list. Looking the hidden tiers up under
  // the raw argument while falling back to the messenger LIST would hand an
  // unknown path the messenger ladder with Professional back in it — the exact
  // "a filter that can be bypassed by an unexpected input" shape.
  const key = product && PRODUCT_PLANS[product] ? product : 'messenger';
  const hidden = ONBOARDING_HIDDEN[key] ?? [];
  return hidden.length === 0
    ? PRODUCT_PLANS[key]
    : PRODUCT_PLANS[key].filter(p => !hidden.includes(p.tier));
}
