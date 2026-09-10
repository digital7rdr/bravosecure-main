/**
 * BR-2 — backupBoot RESTORE-RESUME silent auto-resume.
 *
 * An interrupted restore (kill mid-background-walk) used to force the
 * user back through the password screen even though everything needed to
 * continue — local identity, keychain mirror key, persisted cursors —
 * was already on the device. The boot path now restarts the background
 * runner directly (no password, no screen) and only falls back to the
 * BackupRestore screen when a piece is missing.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});
jest.mock('../backup/backupClient', () => ({
  __esModule: true,
  BackupError: class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  },
  backupClient: {getIdentityHeader: jest.fn(async () => ({userId: 'u'}))},
}));
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  hasDbKey: jest.fn(async () => true),
  loadMirrorMasterKey: jest.fn(async () => Buffer.alloc(32, 5).toString('base64')),
}));
jest.mock('../store/messengerStore', () => ({
  __esModule: true,
  useMessengerStore: {getState: () => ({conversations: {}})},
}));
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  setMirrorKey: jest.fn(),
}));
jest.mock('../backup/mirrorBootstrap', () => ({
  __esModule: true,
  startMirrorBootstrap: jest.fn(),
}));
jest.mock('../runtime', () => ({
  __esModule: true,
  getOwnCryptoStore: jest.fn(() => ({
    getIdentityKeyPair: async () => ({
      pubKey: new Uint8Array(32).fill(3).buffer,
      privKey: new Uint8Array(32).fill(9).buffer,
    }),
  })),
}));
jest.mock('../backup/restoreBackground', () => ({
  __esModule: true,
  startBackgroundRestore: jest.fn(() => true),
}));

import {runBackupBoot} from '../backup/backupBoot';
import {markRestoreIncomplete, clearRestoreState, markArchiveReplayIncomplete} from '../backup/restoreResume';
import {startBackgroundRestore} from '../backup/restoreBackground';
import {setMirrorKey} from '../backup/messageMirror';
import {loadMirrorMasterKey} from '../runtime/keychain';

const OWNER_KEY = 'owner@mail';
const OWNER_UUID = 'owner-uuid-1';

function makeNav(): {isReady: () => boolean; navigate: jest.Mock} {
  return {isReady: () => true, navigate: jest.fn()};
}

describe('BR-2 — boot silent restore resume', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearRestoreState(OWNER_UUID);
  });

  it('resumes the background restore from the keychain key — no password screen', async () => {
    await markRestoreIncomplete(OWNER_UUID);
    const nav = makeNav();
    const getRuntime = jest.fn(async () => ({}));

    await runBackupBoot(nav as never, {
      ownerKey: OWNER_KEY,
      legacyOwnerId: OWNER_UUID,
      getMessengerRuntime: getRuntime,
    });

    expect(getRuntime).toHaveBeenCalled();
    expect(setMirrorKey).toHaveBeenCalledTimes(1);
    expect(startBackgroundRestore).toHaveBeenCalledTimes(1);
    const params = (startBackgroundRestore as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(params.ownerUserId).toBe(OWNER_UUID);
    expect(params.ownerKey).toBe(OWNER_KEY);
    expect(params.skipMessageWalk).toBe(false);
    // The user lands on MessengerHome, not the password screen.
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('archive-only interruption resumes with skipMessageWalk (walk already verified complete)', async () => {
    await markArchiveReplayIncomplete(OWNER_UUID);
    const nav = makeNav();

    await runBackupBoot(nav as never, {
      ownerKey: OWNER_KEY,
      legacyOwnerId: OWNER_UUID,
      getMessengerRuntime: jest.fn(async () => ({})),
    });

    const params = (startBackgroundRestore as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(params.skipMessageWalk).toBe(true);
  });

  it('falls back to the BackupRestore screen when the keychain key is gone', async () => {
    await markRestoreIncomplete(OWNER_UUID);
    (loadMirrorMasterKey as jest.Mock).mockResolvedValue(null);
    const nav = makeNav();

    await runBackupBoot(nav as never, {
      ownerKey: OWNER_KEY,
      legacyOwnerId: OWNER_UUID,
      getMessengerRuntime: jest.fn(async () => ({})),
    });

    expect(startBackgroundRestore).not.toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith('Main', {
      screen: 'MessengerTab',
      params: {screen: 'BackupRestore'},
    });
  });
});
