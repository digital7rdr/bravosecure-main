import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local cache of the user's privacy toggles. The authoritative store
 * is auth-service (`/users/me/privacy`); this cache lets sync paths
 * (like `markRead`) consult the setting without a network round-trip
 * on every receipt. Settings UI writes through on every flip.
 *
 * Defaults match the server defaults — read-receipts default ON, so
 * an uninitialised cache (first launch, before `/users/me` lands) does
 * NOT silently disable the feature for a user who never touched the
 * toggle. Privacy preference: a user who hasn't opted in to a stricter
 * setting gets the legacy behaviour, not a stricter one they didn't
 * choose.
 */
const STORAGE_KEY = 'messenger.privacy.readReceiptsEnabled';

let cached: boolean | undefined;

export async function loadReadReceiptsEnabled(): Promise<boolean> {
  if (cached !== undefined) {return cached;}
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cached = raw === null ? true : raw === 'true';
  } catch {
    cached = true;
  }
  return cached;
}

/** Synchronous read for hot paths — returns the last loaded value, or `true` if uninitialised. */
export function getReadReceiptsEnabledCached(): boolean {
  return cached ?? true;
}

export async function setReadReceiptsEnabled(value: boolean): Promise<void> {
  cached = value;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Best-effort persistence — in-memory cache still reflects the new value.
  }
}

/** Test-only — clears in-memory cache so a fresh load() re-reads storage. */
export function _resetPrivacyCacheForTests(): void {
  cached = undefined;
}
