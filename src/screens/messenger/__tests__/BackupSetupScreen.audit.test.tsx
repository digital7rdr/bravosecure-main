/**
 * 2026-07-06 audit — BackupSetupScreen fixes under test:
 *
 *   • BKSET-27 (M-01): busy must flip BEFORE the biometric await in
 *     handleEnable. A double-tap while the biometric dialog was up ran
 *     setupBackup twice; the second run mints a fresh master key and the
 *     server rotation-wipes the first upload's mirror (permanent restore
 *     orphans). Also: busy resets on the biometric-fail path so the user
 *     can retry.
 *
 *   • BKSET-24: the setup screen's "forgot password" wipe must perform
 *     the same M-17 local cleanup BackupRestoreScreen's wipe does —
 *     clearRestoreState, remove backup:enabled, clearMirrorMasterKey.
 *     A stale backup:enabled suppresses future SUGGEST; a stale mirror
 *     key creates restore orphans after re-setup.
 */
import React from 'react';
import {Alert} from '@utils/alert';
import {render, act, fireEvent} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../RestoreProgressOverlay', () => 'RestoreProgressOverlay');
jest.mock('@/modules/messenger/backup/backupBiometricGate', () => ({
  runBackupBiometricGate: jest.fn(() => Promise.resolve({ok: true})),
}));
jest.mock('@/modules/messenger/backup/identityBackup', () => ({
  setupBackup: jest.fn(),
  restoreBackup: jest.fn(),
}));
jest.mock('@/modules/messenger/backup/restoreMessages', () => ({restoreAllMessages: jest.fn()}));
jest.mock('@/modules/messenger/backup/messageMirror', () => ({
  setMirrorKey: jest.fn(),
  drainMirrorOutbox: jest.fn(() => Promise.resolve()),
  // BUG-6/B-172 — wipe/rotation teardown added 2026-07-24.
  resetMirrorForWipe: jest.fn(),
}));
// BR-1 — the unlock path hands the message walk to the background runner.
jest.mock('@/modules/messenger/backup/restoreBackground', () => ({
  startBackgroundRestore: jest.fn(() => true),
  stopBackgroundRestore: jest.fn(),
}));
jest.mock('@/modules/messenger/backup/mirrorBootstrap', () => ({
  backupNow: jest.fn(() => Promise.resolve({messages: 0, conversations: 0})),
  startMirrorBootstrap: jest.fn(),
}));
jest.mock('@/modules/messenger/backup/restoreResume', () => ({clearRestoreState: jest.fn()}));
jest.mock('@/modules/messenger/backup/merkleCommit', () => ({
  commitMerkleRoot: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/modules/messenger/backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.name = 'BackupError';
      this.kind = kind;
    }
  }
  return {
    BackupError,
    backupClient: {getIdentityHeader: jest.fn(), forget: jest.fn(() => Promise.resolve())},
  };
});
jest.mock('@/modules/messenger/runtime/runtime', () => ({
  getOwnCryptoStore: jest.fn(() => ({
    getIdentityKeyPair: jest.fn(() => Promise.resolve({privKey: new ArrayBuffer(32)})),
  })),
}));
jest.mock('@/modules/messenger/runtime/keychain', () => ({
  saveMirrorMasterKey: jest.fn(() => Promise.resolve()),
  clearMirrorMasterKey: jest.fn(() => Promise.resolve()),
  loadMirrorMasterKey: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({user: {id: 'self-uuid', email: 'me@test'}}),
}));

import BackupSetupScreen from '../BackupSetupScreen';
import {backupClient, BackupError} from '@/modules/messenger/backup/backupClient';
import {setupBackup} from '@/modules/messenger/backup/identityBackup';
import {runBackupBiometricGate} from '@/modules/messenger/backup/backupBiometricGate';
import {clearRestoreState} from '@/modules/messenger/backup/restoreResume';
import {clearMirrorMasterKey} from '@/modules/messenger/runtime/keychain';

const headerMock = backupClient.getIdentityHeader as jest.Mock;
const forgetMock = backupClient.forget as jest.Mock;
const setupMock = setupBackup as jest.Mock;
const bioMock = runBackupBiometricGate as jest.Mock;

const VALID_PWD = 'hunter2hunter2';

function makeNav() {
  return {goBack: jest.fn(), replace: jest.fn(), navigate: jest.fn()};
}

const renderScreen = (nav = makeNav()) =>
  render(<BackupSetupScreen navigation={nav as any} route={{} as any} />);

const flush = () => act(async () => { await Promise.resolve(); });

async function renderSetupModeWithPassword() {
  headerMock.mockRejectedValue(new BackupError('no_backup', 'no_backup'));
  const screen = renderScreen();
  await flush();
  fireEvent.changeText(screen.getByPlaceholderText('At least 4 characters'), VALID_PWD);
  fireEvent.changeText(screen.getByPlaceholderText('Re-enter to confirm'), VALID_PWD);
  return screen;
}

describe('BackupSetupScreen — BKSET-27 double-tap enable guard', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    headerMock.mockReset();
    forgetMock.mockReset();
    setupMock.mockReset();
    bioMock.mockReset();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('a second tap while the biometric dialog is up does NOT run setupBackup twice', async () => {
    let resolveBio!: (v: {ok: boolean}) => void;
    bioMock.mockImplementation(() => new Promise<{ok: boolean}>(res => { resolveBio = res; }));
    setupMock.mockResolvedValue({masterKey: {}, rawB64: 'cmF3'});

    const screen = await renderSetupModeWithPassword();
    const btn = screen.getByTestId('enable-backup-btn');

    // First tap — suspends inside the biometric await with busy already set.
    await act(async () => { fireEvent.press(btn); });
    // Second tap while the dialog is still up — must be a no-op (busy
    // guard + disabled button). Pre-fix, busy only flipped after the
    // gate resolved, so this second tap started a concurrent enable.
    await act(async () => { fireEvent.press(screen.getByTestId('enable-backup-btn')); });
    expect(bioMock).toHaveBeenCalledTimes(1);

    await act(async () => { resolveBio({ok: true}); await Promise.resolve(); });
    await flush();

    expect(setupMock).toHaveBeenCalledTimes(1);
  });

  it('resets busy when the biometric gate fails so the user can retry', async () => {
    bioMock.mockResolvedValue({ok: false});
    const screen = await renderSetupModeWithPassword();

    await act(async () => { fireEvent.press(screen.getByText('ENABLE BACKUP')); });
    await flush();

    expect(screen.getByText('Biometric verification required')).toBeTruthy();
    expect(setupMock).not.toHaveBeenCalled();

    // busy must be back to false — a retry reaches the gate again.
    await act(async () => { fireEvent.press(screen.getByText('ENABLE BACKUP')); });
    await flush();
    expect(bioMock).toHaveBeenCalledTimes(2);
  });

  it('resets busy when setupBackup throws so the form stays usable', async () => {
    bioMock.mockResolvedValue({ok: true});
    setupMock.mockRejectedValue(new Error('boom'));
    const screen = await renderSetupModeWithPassword();

    await act(async () => { fireEvent.press(screen.getByText('ENABLE BACKUP')); });
    await flush();

    expect(setupMock).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.press(screen.getByText('ENABLE BACKUP')); });
    await flush();
    expect(setupMock).toHaveBeenCalledTimes(2);
  });
});

describe('BackupSetupScreen — BKSET-24 forgot-path local cleanup', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    headerMock.mockReset();
    forgetMock.mockReset();
    forgetMock.mockResolvedValue(undefined);
    (clearRestoreState as jest.Mock).mockClear();
    (clearMirrorMasterKey as jest.Mock).mockClear();
    (AsyncStorage.removeItem as jest.Mock).mockClear();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('wipe from unlock mode clears restore state, backup:enabled and the mirror key', async () => {
    headerMock.mockResolvedValue({verifierMissing: false, failedAttempts: 0, lockedUntil: null});
    const screen = renderScreen();
    await flush();

    fireEvent.press(screen.getByText('Forgot password — wipe + start fresh'));
    const confirm = alertSpy.mock.calls.find(c => c[0] === 'Backup permanently lost?');
    expect(confirm).toBeTruthy();
    const wipeBtn = (confirm![2] as Array<{text: string; onPress?: () => void}>)
      .find(b => b.text === 'Wipe & Start Fresh');
    await act(async () => { wipeBtn?.onPress?.(); await Promise.resolve(); });
    await flush();

    expect(forgetMock).toHaveBeenCalledTimes(1);
    // M-17 cleanup — same trio the restore screen's wipe performs.
    expect(clearRestoreState).toHaveBeenCalledWith('self-uuid');
    // P3-B-2 — the wipe clears BOTH the owner-scoped and legacy flags.
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('backup:enabled:me@test');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('backup:enabled');
    expect(clearMirrorMasterKey).toHaveBeenCalledWith('me@test');
    // Screen flips to setup mode for a fresh enrolment.
    expect(screen.getByPlaceholderText('At least 4 characters')).toBeTruthy();
  });
});
