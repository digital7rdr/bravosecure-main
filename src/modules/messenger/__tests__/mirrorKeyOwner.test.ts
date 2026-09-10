/**
 * Regression — backup MIRROR MASTER KEY owner-binding.
 *
 * Bug (builds <=1.0.36): BackupRestoreScreen / BackupSetupScreen saved
 * the mirror key under the Signal UUID (`user.id`), but every reader
 * (backupBoot RESUME-AUTO, the runtime) looks it up under `ownerKey`
 * (`email ?? phone ?? id`). The two services never matched, so:
 *   • loadMirrorMasterKey(ownerKey) always missed → mirror never resumed
 *     (the `No entry found for service: bravo.messenger.mirrorkey.<email>`
 *     heartbeat in logcat),
 *   • the boot RESTORE gate re-fired every cold start.
 *
 * These tests pin the contract: a key SAVED under ownerKey is FOUND under
 * ownerKey, and a legacy UUID-keyed entry is migrated to the canonical
 * owner on first read (so already-restored users don't re-enter their
 * password). No raw key material is asserted on — only presence + which
 * service it lives under.
 */

// In-memory keychain so save/load/reset round-trip like the OS keychain,
// keyed by `service`. The Map lives INSIDE the factory (jest.mock can't
// close over outer scope) and is exported as `__store` so the test can
// inspect/clear it.
jest.mock('react-native-keychain', () => {
  const __store = new Map<string, string>();
  return {
    __esModule: true,
    __store,
    SECURITY_LEVEL: {SECURE_HARDWARE: 'sh', SECURE_SOFTWARE: 'ss'},
    ACCESSIBLE: {
      WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'a',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY:     'b',
    },
    setGenericPassword: async (_account: string, password: string, opts: {service: string}) => {
      __store.set(opts.service, password);
      return true;
    },
    getGenericPassword: async (opts: {service: string}) => {
      const password = __store.get(opts.service);
      return password ? {username: 'x', password, service: opts.service} : false;
    },
    resetGenericPassword: async (opts: {service: string}) => {
      __store.delete(opts.service);
      return true;
    },
  };
});

const store = (jest.requireMock('react-native-keychain') as {__store: Map<string, string>}).__store;

import {
  saveMirrorMasterKey,
  loadMirrorMasterKey,
  clearMirrorMasterKey,
} from '../runtime/keychain';

const MIRROR_PREFIX = 'bravo.messenger.mirrorkey';
const OWNER_KEY = 'monwamoni@gmail.com';        // email — canonical
const LEGACY_UUID = '9f1c0b3a-1111-2222-3333-444455556666'; // user.id
const RAW_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

beforeEach(() => store.clear());

describe('mirror key owner-binding', () => {
  it('a key saved under ownerKey is found under the SAME ownerKey', async () => {
    await saveMirrorMasterKey(OWNER_KEY, RAW_B64);
    expect(store.has(`${MIRROR_PREFIX}.${OWNER_KEY}`)).toBe(true);
    expect(await loadMirrorMasterKey(OWNER_KEY)).toBe(RAW_B64);
  });

  it('a key saved under the UUID is NOT visible to an ownerKey lookup (the original bug)', async () => {
    await saveMirrorMasterKey(LEGACY_UUID, RAW_B64);
    // Plain ownerKey lookup (no migration hint) must miss — this is what
    // every old reader did, producing the No-entry-found heartbeat.
    expect(await loadMirrorMasterKey(OWNER_KEY)).toBeNull();
  });

  it('migrates a legacy UUID-keyed entry to ownerKey on first read', async () => {
    await saveMirrorMasterKey(LEGACY_UUID, RAW_B64);

    const got = await loadMirrorMasterKey(OWNER_KEY, LEGACY_UUID);
    expect(got).toBe(RAW_B64);

    // Adopted under the canonical owner …
    expect(store.has(`${MIRROR_PREFIX}.${OWNER_KEY}`)).toBe(true);
    // … and the stale UUID entry is gone (one-shot, never repeats).
    expect(store.has(`${MIRROR_PREFIX}.${LEGACY_UUID}`)).toBe(false);

    // A subsequent plain lookup now hits without the legacy hint.
    expect(await loadMirrorMasterKey(OWNER_KEY)).toBe(RAW_B64);
  });

  it('migration is a no-op when ownerKey already holds the key', async () => {
    await saveMirrorMasterKey(OWNER_KEY, RAW_B64);
    await saveMirrorMasterKey(LEGACY_UUID, 'stale-do-not-pick');
    // ownerKey entry wins; legacy is left untouched (not its job to clean
    // an unrelated entry it never read).
    expect(await loadMirrorMasterKey(OWNER_KEY, LEGACY_UUID)).toBe(RAW_B64);
  });

  it('returns null (no throw) when neither owner has a key', async () => {
    expect(await loadMirrorMasterKey(OWNER_KEY, LEGACY_UUID)).toBeNull();
  });

  it('clearMirrorMasterKey removes the ownerKey entry', async () => {
    await saveMirrorMasterKey(OWNER_KEY, RAW_B64);
    await clearMirrorMasterKey(OWNER_KEY);
    expect(await loadMirrorMasterKey(OWNER_KEY)).toBeNull();
  });
});
