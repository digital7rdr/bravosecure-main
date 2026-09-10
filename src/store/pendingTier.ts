import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * M1A — the paid tier picked on the pre-auth tier screen, carried through
 * signup/OTP so the post-auth paywall can ask for the subscription "at the
 * end" (founder rule 5). AsyncStorage (not component state) because the
 * flow crosses OTP + app restarts. Cleared on subscribe, on the explicit
 * "Start as Lite today" decline, and on sign-out.
 *
 * Mirrors the pendingProvider bridge pattern.
 */
const KEY = 'auth:pending_tier';

export type PendingPaidTier = 'pro' | 'enterprise';

export const pendingTier = {
  async set(tier: PendingPaidTier): Promise<void> {
    try { await AsyncStorage.setItem(KEY, tier); } catch { /* best-effort */ }
  },
  async get(): Promise<PendingPaidTier | null> {
    try {
      const v = await AsyncStorage.getItem(KEY);
      return v === 'pro' || v === 'enterprise' ? v : null;
    } catch { return null; }
  },
  async clear(): Promise<void> {
    try { await AsyncStorage.removeItem(KEY); } catch { /* best-effort */ }
  },
};
