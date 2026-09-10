/**
 * B-44 — BackupRestoreScreen must handle the P0-1 legacy hard cut.
 *
 * A backup row created before the verifier upgrade has no verifier_key;
 * the server 409s every proof, so NO password can ever restore it. The
 * screen previously let the user type a password + pass the biometric
 * gate, then failed with "set your backup password again" — impossible
 * advice, because Settings is unreachable behind the restore gate.
 *
 * Expected behavior under test:
 *   1. header.verifierMissing → the password form is replaced by a
 *      hard-cut panel whose primary action is the existing wipe flow.
 *   2. Normal header → the password form renders unchanged (regression).
 *   3. Defense in depth: restoreBackup throwing verifier_missing mid-
 *      flight flips the screen to the same panel instead of a dead-end
 *      generic error.
 */
import React from 'react';
import {render, act, fireEvent} from '@testing-library/react-native';

// BKRES-19 — the header fetch now rides on useFocusEffect, so the mock
// must actually run the callback (like the real hook does on first focus)
// instead of being a no-op.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) =>
    require('react').useEffect(cb, [cb]),
}));
jest.mock('../RestoreProgressOverlay', () => 'RestoreProgressOverlay');
jest.mock('@/modules/messenger/backup/backupBiometricGate', () => ({
  runBackupBiometricGate: jest.fn(() => Promise.resolve({ok: true})),
}));
jest.mock('@/modules/messenger/backup/identityBackup', () => ({restoreBackup: jest.fn()}));
jest.mock('@/modules/messenger/backup/restoreMessages', () => ({restoreAllMessages: jest.fn()}));
jest.mock('@/modules/messenger/backup/messageMirror', () => ({setMirrorKey: jest.fn()}));
jest.mock('@/modules/messenger/backup/mirrorBootstrap', () => ({startMirrorBootstrap: jest.fn()}));
jest.mock('@/modules/messenger/backup/restoreResume', () => ({clearRestoreState: jest.fn()}));
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
    backupClient: {getIdentityHeader: jest.fn(), forget: jest.fn()},
  };
});
jest.mock('@/modules/messenger/runtime', () => ({
  getOwnCryptoStore: jest.fn(() => ({})),
  getMessengerRuntime: jest.fn(() => Promise.resolve({})),
}));
jest.mock('@/modules/messenger/runtime/productionRuntime', () => ({
  setDeferBundlePublish: jest.fn(),
  publishOwnBundleAfterRestore: jest.fn(() => Promise.resolve()),
  disposeLiveRuntime: jest.fn(),
  replayArchivedEnvelope: jest.fn(),
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({user: {id: 'self-uuid', email: 'me@test'}}),
}));

import {Alert} from '@utils/alert';
import BackupRestoreScreen from '../BackupRestoreScreen';
import {backupClient, BackupError} from '@/modules/messenger/backup/backupClient';
import {restoreBackup} from '@/modules/messenger/backup/identityBackup';

const headerMock = backupClient.getIdentityHeader as jest.Mock;
const restoreMock = restoreBackup as jest.Mock;

function makeHeader(verifierMissing: boolean) {
  return {
    userId: 'self-uuid',
    verifierMissing,
    verifyNonce: 'n',
    verifyNonceTtlSec: 120,
    salt: 'c2FsdA==',
    kdfParams: {},
    failedAttempts: 0,
    lockedUntil: null,
  };
}

function makeNav() {
  return {goBack: jest.fn(), replace: jest.fn(), navigate: jest.fn()};
}

const renderScreen = (nav = makeNav()) =>
  render(<BackupRestoreScreen navigation={nav as any} route={{} as any} />);

const flush = () => act(async () => { await Promise.resolve(); });

describe('BackupRestoreScreen — B-44 legacy verifier_missing hard cut', () => {
  beforeEach(() => {
    headerMock.mockReset();
    restoreMock.mockReset();
  });

  it('replaces the password form with the hard-cut panel when the header says verifierMissing', async () => {
    headerMock.mockResolvedValue(makeHeader(true));
    const screen = renderScreen();
    await flush();

    expect(screen.queryByPlaceholderText('Enter your backup password')).toBeNull();
    expect(screen.queryByText('RESTORE')).toBeNull();
    expect(screen.getByText(/can.t be unlocked/i)).toBeTruthy();
    expect(screen.getByText('START FRESH')).toBeTruthy();
  });

  it('renders the normal password form when the verifier is present (regression)', async () => {
    headerMock.mockResolvedValue(makeHeader(false));
    const screen = renderScreen();
    await flush();

    expect(screen.getByPlaceholderText('Enter your backup password')).toBeTruthy();
    expect(screen.getByText('RESTORE')).toBeTruthy();
    expect(screen.queryByText('START FRESH')).toBeNull();
    expect(screen.getByText('Forgot password — start fresh')).toBeTruthy();
  });

  it('flips to the hard-cut panel if restoreBackup throws verifier_missing mid-flight', async () => {
    headerMock.mockResolvedValue(makeHeader(false));
    restoreMock.mockRejectedValue(new BackupError('verifier_missing', 'verifier_missing'));
    const screen = renderScreen();
    await flush();

    fireEvent.changeText(screen.getByPlaceholderText('Enter your backup password'), 'hunter22');
    await act(async () => {
      fireEvent.press(screen.getByText('RESTORE'));
      await Promise.resolve();
    });
    await flush();

    expect(screen.getByText(/can.t be unlocked/i)).toBeTruthy();
    expect(screen.getByText('START FRESH')).toBeTruthy();
    expect(screen.queryByText(/Restore failed/)).toBeNull();
  });
});

describe('BackupRestoreScreen — BKRES-19 no_backup mid-restore', () => {
  beforeEach(() => {
    headerMock.mockReset();
    restoreMock.mockReset();
  });

  it('informs + replaces to MessengerHome when the RESTORE attempt hits no_backup', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    headerMock.mockResolvedValue(makeHeader(false));
    restoreMock.mockRejectedValue(new BackupError('no_backup', 'no_backup'));
    const nav = makeNav();
    const screen = renderScreen(nav);
    await flush();

    fireEvent.changeText(screen.getByPlaceholderText('Enter your backup password'), 'hunter22');
    await act(async () => {
      fireEvent.press(screen.getByText('RESTORE'));
      await Promise.resolve();
    });
    await flush();

    // No generic error overlay/inline error — the deleted-backup dialog owns it.
    expect(screen.queryByText(/Restore failed/)).toBeNull();
    const call = alertSpy.mock.calls.find(c => c[0] === 'No backup found');
    expect(call).toBeTruthy();
    const okBtn = (call![2] as Array<{text: string; onPress?: () => void}>)
      .find(b => b.text === 'OK');
    okBtn?.onPress?.();
    expect(nav.replace).toHaveBeenCalledWith('MessengerHome');
    alertSpy.mockRestore();
  });
});

describe('BackupRestoreScreen — BKRES-27 nonce_expired friendly copy', () => {
  beforeEach(() => {
    headerMock.mockReset();
    restoreMock.mockReset();
  });

  it('shows the dedicated nonce copy instead of the generic Restore failed line', async () => {
    headerMock.mockResolvedValue(makeHeader(false));
    restoreMock.mockRejectedValue(new BackupError('nonce_expired', 'nonce_expired'));
    const screen = renderScreen();
    await flush();

    fireEvent.changeText(screen.getByPlaceholderText('Enter your backup password'), 'hunter22');
    await act(async () => {
      fireEvent.press(screen.getByText('RESTORE'));
      await Promise.resolve();
    });
    await flush();

    expect(screen.getAllByText('That took too long — please try again.').length)
      .toBeGreaterThan(0);
    expect(screen.queryByText(/nonce_expired/)).toBeNull();
  });
});
