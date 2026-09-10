/**
 * M1A rule 12 — the cloud-vault entitlement seam.
 *
 * Why lazy requires: `openVault` runs in node-env unit tests, and a static
 * import of authStore drags expo-local-authentication (untransformed ESM)
 * into the suite. The requires resolve at CALL time, so the navigation
 * helper stays parse-clean everywhere and tests mock this module.
 */
export function hasCloudVaultEntitlement(): boolean {
  const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
  const {deriveEntitlements} = require('@store/entitlements') as typeof import('@store/entitlements');
  return deriveEntitlements(useAuthStore.getState().user).hasCloudVault;
}

export function promptCloudVaultUpgrade(): void {
  const {showTierUpgradePrompt} = require('@store/entitlements') as typeof import('@store/entitlements');
  const {openPricing} = require('@navigation/openPricing') as typeof import('@navigation/openPricing');
  showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
}
