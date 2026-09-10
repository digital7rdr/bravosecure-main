import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore} from './vaultStore';
import {hasCloudVaultEntitlement, promptCloudVaultUpgrade} from './entitlementGate';

/**
 * Small navigation helper — encapsulates the three vault entry branches
 * so every caller (FilesScreen, MessengerSettings, etc.) stays in lockstep:
 *
 *   1. No PIN has been set yet   → VaultNewPin   (first-time setup)
 *   2. Vault is currently unlocked (within the 5-min window)
 *                                → VaultScreen   (direct entry)
 *   3. PIN is set but locked     → VaultLock     (biometric-first,
 *                                                 PIN keypad as fallback)
 *
 * Kept as a free function (not a hook) so smoke tests can exercise the
 * routing logic without rendering a component.
 */
export function openVault(
  nav: NativeStackNavigationProp<MessengerStackParamList, keyof MessengerStackParamList>,
): 'VaultNewPin' | 'VaultScreen' | 'VaultLock' | 'TierGate' {
  // M1A rule 12 — Secure Cloud Vault is Pro+ (org tenancy also entitles).
  // The single choke point for every vault navigation; the server backstops
  // this at action-token issuance (403 tier_insufficient), so a deep link
  // past this gate still can't reach vault bytes.
  if (!hasCloudVaultEntitlement()) {
    promptCloudVaultUpgrade();
    return 'TierGate';
  }
  const state = useVaultStore.getState();
  if (!state.hasPin()) {
    nav.navigate('VaultNewPin');
    return 'VaultNewPin';
  }
  if (state.isUnlocked()) {
    nav.navigate('VaultScreen');
    return 'VaultScreen';
  }
  nav.navigate('VaultLock');
  return 'VaultLock';
}
