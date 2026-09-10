/**
 * P3-B-2 — `backup:enabled` / `backup:skipped` were device-global, so a
 * multi-account device leaked one user's backup boot decision into the
 * next user's session (user B with existing chats was never prompted to
 * set up backup → "lost history" class). The backupFlags module scopes
 * both flags per owner while migrating/tolerating the legacy global
 * keys that not-yet-migrated writers (BackupSetupScreen) still use.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BACKUP_ENABLED_KEY_PREFIX,
  LEGACY_BACKUP_ENABLED_KEY,
  LEGACY_BACKUP_SKIPPED_KEY,
  readBackupEnabledSource,
  readBackupSkippedSource,
  setBackupEnabled,
  setBackupSkipped,
  clearBackupEnabled,
  migrateLegacyEnabledToOwner,
} from '../backup/backupFlags';

const ALICE = 'alice@example.com';
const BOB   = 'bob@example.com';

describe('P3-B-2 — owner-scoped backup flags', () => {
  beforeEach(async () => {
    await (AsyncStorage as unknown as {clear: () => Promise<void>}).clear();
  });

  it('setBackupEnabled writes the owner-scoped key (and the legacy key for un-migrated readers)', async () => {
    await setBackupEnabled(ALICE);
    expect(await readBackupEnabledSource(ALICE)).toBe('owner');
    // Legacy key kept in sync for BackupSetupScreen/MessengerSettingsScreen.
    expect(await AsyncStorage.getItem(LEGACY_BACKUP_ENABLED_KEY)).toBe('1');
  });

  it("one owner's enabled flag does not read as another owner's OWNER-scoped flag", async () => {
    await setBackupEnabled(ALICE);
    // Bob still sees only the legacy fallback — never 'owner'. The
    // SUGGEST boot branch requires 'owner', so Bob IS prompted.
    expect(await readBackupEnabledSource(BOB)).toBe('legacy');
    expect(await AsyncStorage.getItem(`${BACKUP_ENABLED_KEY_PREFIX}${BOB}`)).toBeNull();
  });

  it('skipped: legacy global flag is still honored (BackupSetupScreen not yet migrated)', async () => {
    await AsyncStorage.setItem(LEGACY_BACKUP_SKIPPED_KEY, '1');
    expect(await readBackupSkippedSource(ALICE)).toBe('legacy');
    expect(await readBackupSkippedSource(BOB)).toBe('legacy');
  });

  it('migrateLegacyEnabledToOwner adopts the legacy flag into owner scope once', async () => {
    await AsyncStorage.setItem(LEGACY_BACKUP_ENABLED_KEY, '1');
    expect(await readBackupEnabledSource(ALICE)).toBe('legacy');
    await migrateLegacyEnabledToOwner(ALICE);
    expect(await readBackupEnabledSource(ALICE)).toBe('owner');
    // Legacy key intentionally left for the other readers.
    expect(await AsyncStorage.getItem(LEGACY_BACKUP_ENABLED_KEY)).toBe('1');
  });

  it('migrate is a no-op when the legacy flag is absent', async () => {
    await migrateLegacyEnabledToOwner(ALICE);
    expect(await readBackupEnabledSource(ALICE)).toBeNull();
  });

  it('clearBackupEnabled clears both the owner-scoped and legacy keys', async () => {
    await setBackupEnabled(ALICE);
    await clearBackupEnabled(ALICE);
    expect(await readBackupEnabledSource(ALICE)).toBeNull();
    expect(await AsyncStorage.getItem(LEGACY_BACKUP_ENABLED_KEY)).toBeNull();
  });

  it('setBackupEnabled clears the skipped flags (enable wins over an old skip)', async () => {
    await AsyncStorage.setItem(LEGACY_BACKUP_SKIPPED_KEY, '1');
    await setBackupEnabled(ALICE);
    expect(await readBackupSkippedSource(ALICE)).toBeNull();
  });

  it('setBackupSkipped writes owner-scoped + legacy skip, without touching enabled', async () => {
    await setBackupSkipped(ALICE);
    expect(await readBackupSkippedSource(ALICE)).toBe('owner');
    expect(await AsyncStorage.getItem(LEGACY_BACKUP_SKIPPED_KEY)).toBe('1');
    expect(await readBackupEnabledSource(ALICE)).toBeNull();
    // Bob sees only the legacy fallback for skip (which SUGGEST honors —
    // deliberate; see backupFlags module doc).
    expect(await readBackupSkippedSource(BOB)).toBe('legacy');
  });
});
