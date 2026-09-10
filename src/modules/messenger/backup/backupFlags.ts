/**
 * P3-B-2 — owner-scoped backup boot flags.
 *
 * `backup:enabled` / `backup:skipped` were single DEVICE-GLOBAL
 * AsyncStorage keys, so on a multi-account device user B inherited user
 * A's backup boot decision (A's `skipped`/`enabled` suppressed B's
 * SUGGEST prompt → B never set up backup → "lost history" class).
 *
 * This module scopes both flags per owner (the canonical ownerKey:
 * email ?? phone ?? id — the same identity the keychain and boot gate
 * use) while handling the legacy global keys safely:
 *
 *   • Writers ALSO write the legacy global key so flags written by
 *     PRE-migration app versions keep working after an upgrade (via the
 *     legacy fallbacks below) and a downgrade stays consistent.
 *   • The RESUME boot branch may fall back to the legacy `enabled`
 *     flag — it is gated on a server-confirmed backup for THIS owner,
 *     so honoring (and migrating) it there is harmless.
 *   • The SUGGEST boot branch must NOT honor the legacy `enabled` flag
 *     (reaching SUGGEST means the server has no backup for this owner,
 *     so a legacy enabled flag is another account's or stale). The
 *     legacy `skipped` flag IS honored — a skip recorded globally by an
 *     older app version must not re-prompt on every boot.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BACKUP_ENABLED_KEY_PREFIX = 'backup:enabled:';
export const BACKUP_SKIPPED_KEY_PREFIX = 'backup:skipped:';
export const LEGACY_BACKUP_ENABLED_KEY = 'backup:enabled';
export const LEGACY_BACKUP_SKIPPED_KEY = 'backup:skipped';

export type FlagSource = 'owner' | 'legacy' | null;

async function readFlag(ownerKey: string, prefix: string, legacyKey: string): Promise<FlagSource> {
  try {
    if (ownerKey && (await AsyncStorage.getItem(`${prefix}${ownerKey}`)) !== null) {return 'owner';}
    if ((await AsyncStorage.getItem(legacyKey)) !== null) {return 'legacy';}
  } catch { /* fall through */ }
  return null;
}

/** Where the enabled flag is set from: owner-scoped, legacy global, or unset. */
export function readBackupEnabledSource(ownerKey: string): Promise<FlagSource> {
  return readFlag(ownerKey, BACKUP_ENABLED_KEY_PREFIX, LEGACY_BACKUP_ENABLED_KEY);
}

/** Where the skipped flag is set from: owner-scoped, legacy global, or unset. */
export function readBackupSkippedSource(ownerKey: string): Promise<FlagSource> {
  return readFlag(ownerKey, BACKUP_SKIPPED_KEY_PREFIX, LEGACY_BACKUP_SKIPPED_KEY);
}

/**
 * Mark backup enabled for this owner. Also writes the legacy global key
 * (see module doc) and clears both skipped keys.
 */
export async function setBackupEnabled(ownerKey: string): Promise<void> {
  try {
    if (ownerKey) {
      await AsyncStorage.setItem(`${BACKUP_ENABLED_KEY_PREFIX}${ownerKey}`, '1');
      await AsyncStorage.removeItem(`${BACKUP_SKIPPED_KEY_PREFIX}${ownerKey}`);
    }
    await AsyncStorage.setItem(LEGACY_BACKUP_ENABLED_KEY, '1');
    await AsyncStorage.removeItem(LEGACY_BACKUP_SKIPPED_KEY);
  } catch (e) {
    console.warn('[backup.flags] setBackupEnabled persist failed:', (e as Error).message);
  }
}

/**
 * Record a "not now" skip for this owner. Also writes the legacy global
 * key (see module doc). Does not touch the enabled flags — parity with
 * the pre-migration skip behaviour.
 */
export async function setBackupSkipped(ownerKey: string): Promise<void> {
  try {
    if (ownerKey) {
      await AsyncStorage.setItem(`${BACKUP_SKIPPED_KEY_PREFIX}${ownerKey}`, '1');
    }
    await AsyncStorage.setItem(LEGACY_BACKUP_SKIPPED_KEY, '1');
  } catch (e) {
    console.warn('[backup.flags] setBackupSkipped persist failed:', (e as Error).message);
  }
}

/** Clear the enabled flag for this owner (and the legacy global key). */
export async function clearBackupEnabled(ownerKey: string): Promise<void> {
  try {
    if (ownerKey) {
      await AsyncStorage.removeItem(`${BACKUP_ENABLED_KEY_PREFIX}${ownerKey}`);
    }
    await AsyncStorage.removeItem(LEGACY_BACKUP_ENABLED_KEY);
  } catch { /* best-effort */ }
}

/**
 * RESUME-branch migration — adopt a legacy global enabled flag into the
 * owner-scoped key. Only call when the server has confirmed a backup
 * exists for THIS owner (that check is what makes the adoption safe).
 */
export async function migrateLegacyEnabledToOwner(ownerKey: string): Promise<void> {
  if (!ownerKey) {return;}
  try {
    const owner = await AsyncStorage.getItem(`${BACKUP_ENABLED_KEY_PREFIX}${ownerKey}`);
    if (owner !== null) {return;}
    const legacy = await AsyncStorage.getItem(LEGACY_BACKUP_ENABLED_KEY);
    if (legacy === '1') {
      await AsyncStorage.setItem(`${BACKUP_ENABLED_KEY_PREFIX}${ownerKey}`, '1');
      console.log('[backup.flags] migrated legacy backup:enabled to owner scope');
    }
  } catch { /* best-effort */ }
}
