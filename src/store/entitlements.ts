/**
 * B-91 M1 R2 — the ONE place feature entitlements are derived on the client.
 *
 * The spec's tier language (Lite / Pro / Enterprise) maps onto what the
 * server actually knows today:
 *   - Lite/Pro  → `users.subscription_tier` ('lite' | 'pro', TierGuard-backed).
 *   - Enterprise → the ORG capability set (service-provider company account,
 *     agency kind, or an active org member) — the server enforces this via
 *     DeptChatAccessGuard, so the client mirror below can never widen access,
 *     only decide what to RENDER (locked card vs live entry).
 *
 * When a real `messenger_tier` field ships (INDEX Q1), only this file and
 * the server guards change — screens keep calling `useEntitlements()`.
 */
import {useAuthStore} from '@store/authStore';
import {effectiveTier} from '@utils/tier';
import type {PackageTier} from '@appTypes/index';

export interface Entitlements {
  /** Raw stored tier ('lite' | 'pro' | 'enterprise'). Prefer `effective`. */
  tier: string;
  /** Lapse-aware tier (RS-19): a paid tier only while its window is live. */
  effective: PackageTier;
  /** Org-backed workforce account (provider company / agency / active member). */
  isOrgAffiliated: boolean;
  /** Enterprise capability set: paid enterprise tier OR org tenancy. */
  isEnterprise: boolean;
  /**
   * Founder QA 2026-08-08 — the tenant TYPE, not the capability: this account's
   * org is an Enterprise WORKSPACE (owner or member), or they hold the
   * Enterprise tier with no org yet. Drives VOCABULARY (Member/Team vs CPO):
   * a workspace's staff may have nothing to do with bodyguarding. Agencies —
   * and only agencies — keep the CPO wording (rule 7: provider untouched).
   */
  isWorkspaceTenant: boolean;
  hasDeptChannels: boolean;
  /** Secure Cloud Vault (paid cloud storage) — Pro and Enterprise (M1A matrix). */
  hasCloudVault: boolean;
  /** SM-512 marketing label (Pro+). Copy-only — no crypto changes with tier. */
  hasSM512Label: boolean;
}

export function deriveEntitlements(user: ReturnType<typeof useAuthStore.getState>['user']): Entitlements {
  const tier = user?.subscription_tier ?? 'lite';
  const effective = effectiveTier(user);
  // Mirrors DeptChatAccessGuard — org tenancy, not a client-purchasable flag.
  // Display-only; the server is the real gate.
  // Scope v2 Phase 6 — `owns_workspace` is FIRST, and it is why this is not
  // just an account_kind test.
  //
  // An Enterprise workspace owner is deliberately NOT an agency: the alternative
  // was to mint them through the service-provider funnel, which would have put
  // an Enterprise company in the provider home and the job marketplace
  // (owner-decided 2026-08-04). So their `account_kind` is 'individual' and
  // every arm below reports false for them — the person who just created the
  // workspace would have been locked out of it.
  //
  // Server-authoritative, like the rest of this: the flag is derived from
  // `org_workspaces` in ACCOUNT_KIND_SQL, never set by the client.
  const isOrgAffiliated = !!user && (
    user.owns_workspace === true ||
    // vs2 item 4 — an ACTIVE membership of any workspace counts, even when the
    // discriminator's single collapsed row is pointing at something else. The
    // consultant (officer at an agency, employee of a workspace) reads false on
    // every other clause here.
    (user.workspaces?.length ?? 0) > 0 ||
    user.role === 'service_provider' || user.account_kind === 'agency' ||
    ((user.account_kind === 'cpo' || !!user.org) && user.membership_status === 'active')
  );
  // M1A — the paid Enterprise tier ALSO unlocks the enterprise feature set
  // for individuals. Org-OR-tier, never double-gate: org accounts keep every
  // path they have today regardless of subscription_tier.
  const isEnterprise = isOrgAffiliated || effective === 'enterprise';
  // Workspace tenancy: the server says this org IS a workspace (owner or
  // member — org_is_workspace), or the account owns one, or it holds the
  // Enterprise tier without any org (the pre-workspace persona). An agency
  // matches none of these.
  // ⚠️ SECOND COPY of the rule in `screens/deptchat/workspaceTenant.ts`. Round 3
  // widened that one and not this one, and the drift was visible: the drawer
  // offered "Workspaces" while this decided the destination, the entitlement
  // gate and the vocabulary — so the consultant got the Enterprise upsell and
  // agency wording behind a workspace-labelled door. Keep the two clauses
  // identical; the repo's most common bug is one behaviour with N copies.
  const isWorkspaceTenant = !!user && (
    user.org_is_workspace === true ||
    user.owns_workspace === true ||
    (user.workspaces?.length ?? 0) > 0 ||
    (effective === 'enterprise' && !isOrgAffiliated)
  );
  return {
    tier,
    effective,
    isOrgAffiliated,
    isEnterprise,
    isWorkspaceTenant,
    hasDeptChannels: isEnterprise,
    hasCloudVault: effective !== 'lite' || isOrgAffiliated,
    hasSM512Label: effective !== 'lite' || isOrgAffiliated,
  };
}

export function useEntitlements(): Entitlements {
  const user = useAuthStore(s => s.user);
  return deriveEntitlements(user);
}

/**
 * Spec p.8 upgrade prompt (exact copy). Uses the branded Alert host (B-88).
 * With the M1A billing flow live, "View Enterprise" routes into the Pricing
 * page / paywall when the caller passes `onViewPlans`; the descriptive
 * fallback remains for call-sites without navigation access.
 */
export function showEnterpriseUpgradePrompt(opts?: {onViewPlans?: () => void}): void {
  const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
  Alert.alert(
    'Upgrade to Enterprise',
    'Department Channels are available on Enterprise. Upgrade to organise your team into controlled departmental channels.',
    [
      {
        text: 'View Enterprise',
        onPress: opts?.onViewPlans ?? (() => {
          Alert.alert(
            'Enterprise',
            'Enterprise includes Department Channels, Employee Attendance Tracking and Incident Reporting, on top of everything in Bravo Messenger Pro. Upgrade any time from Profile → Messenger Plans.',
          );
        }),
      },
      {text: 'Not Now', style: 'cancel'},
    ],
  );
}

/**
 * M1A rule 12 — generic locked-feature ask for a matrix row the account's
 * tier lacks (first user: Secure Cloud Vault on Lite). Branded dialog via
 * the B-88 host; `onViewPlans` routes to Settings → Pricing / the paywall.
 */
export function showTierUpgradePrompt(
  feature: 'cloud-vault',
  opts?: {onViewPlans?: () => void},
): void {
  const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
  const copy = {
    'cloud-vault': {
      title: 'Upgrade to unlock your Cloud Vault',
      message:
        'Secure Cloud Vault (100MB free) is available on Bravo Messenger Pro and Enterprise. Upgrade to store files in your encrypted cloud vault.',
    },
  }[feature];
  Alert.alert(copy.title, copy.message, [
    ...(opts?.onViewPlans ? [{text: 'View Plans', onPress: opts.onViewPlans}] : []),
    {text: 'Not Now', style: 'cancel' as const},
  ]);
}
