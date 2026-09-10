/**
 * B-453 — the vault lock's exit and its return target.
 *
 * FilesScreen is now PIN gated, and it is registered in the workspace Vault tab
 * under the route name 'MessengerHome' (DepartmentalNavigator names it that so
 * this screen's anti-leak reset resolves). Those two facts together are a trap:
 * `exitToHome` RESETS to 'MessengerHome', which inside that shell IS the gated
 * Files browser — so backing out of the lock lands on a screen whose guard
 * immediately replaces it with the lock again. A lock↔files ping-pong with no
 * way out of the tab.
 *
 * The exit is therefore shell-aware: inside the workspace it leaves the Vault
 * TAB (parent navigator → Home) rather than resetting onto the gated route.
 * Everywhere else the original reset is unchanged.
 *
 * The lock itself is NOT weakened by any of this: the hardware-back trap still
 * fires, and it still routes away from the vault rather than revealing it.
 *
 * The shell is detected through the REAL `isInDepartmentalShell` walk here,
 * driven by the navigator's own `routeNames` — mocking the predicate would pin
 * the branch while leaving the question it answers untested.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockReplace = jest.fn();
const mockReset = jest.fn();
const mockNavigate = jest.fn();
const mockParentNavigate = jest.fn();
const mockVerifyPin = jest.fn();
const mockSetupPin = jest.fn();
const mockGoBack = jest.fn();
/**
 * Route names of the stack this screen sits in, and of its parent — plus the
 * live route LIST, which the Settings-lane cancel reads to check what actually
 * sits beneath the lock (`routeNames` alone cannot answer that: it is the set
 * of registered routes, not the stack).
 */
const mockTree = {
  stack:  ['MessengerHome', 'VaultLock', 'VaultScreen'] as string[],
  parent: undefined as string[] | undefined,
  routes: undefined as Array<{name: string}> | undefined,
  index:  undefined as number | undefined,
  canGoBack: false,
};
const mockRouteParams: {value: {next?: string} | undefined} = {value: undefined};
/** Whether the vault is already open behind this warm lock screen. */
const mockVault = {unlocked: false};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync:  jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({success: false})),
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    replace:   mockReplace,
    reset:     mockReset,
    navigate:  mockNavigate,
    goBack:    mockGoBack,
    canGoBack: () => mockTree.canGoBack,
    isFocused: () => true,
    getState:  () => ({routeNames: mockTree.stack, routes: mockTree.routes, index: mockTree.index}),
    getParent: () => (mockTree.parent
      ? {navigate: mockParentNavigate, getState: () => ({routeNames: mockTree.parent}), getParent: () => undefined}
      : undefined),
  }),
  useRoute: () => ({key: 'VaultLock-1', name: 'VaultLock', params: mockRouteParams.value}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    (require('react') as typeof React).useEffect(cb, [cb]);
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@/modules/messenger/vault', () => {
  const useVaultStore = (sel: (s: unknown) => unknown) => sel({
    verifyPin: (pin: string) => mockVerifyPin(pin),
    unlockWithBiometric: jest.fn(),
    biometricEnabled: false,
    // VaultNewPinScreen's slice — a first-run user has no PIN yet.
    setupPin: (pin: string) => mockSetupPin(pin),
    changePin: jest.fn(async () => undefined),
    hasPin: () => false,
    setBiometricEnabled: jest.fn(),
    // VaultLockScreen SUBSCRIBES to this now (a mid-session null routes to
    // setup). Non-null = "this user has a PIN", which is the state every case
    // in this file is about.
    pinHash: 'phc$stub',
  });
  (useVaultStore as unknown as {getState: () => unknown}).getState = () => ({
    hasPin: () => true,
    // Locked — every case here is a user standing at the keypad. An unlocked
    // vault forwards on focus instead (pinned in vaultPinFirstAccess), which
    // one case below deliberately exercises.
    isUnlocked: () => mockVault.unlocked,
  });
  return {useVaultStore};
});

import VaultLockScreen from '../VaultLockScreen';
import VaultNewPinScreen from '../VaultNewPinScreen';
import {goBackOnce} from '@navigation/tapGuard';

const DEPT_TABS = ['Home', 'Channels', 'Attend', 'Incident', 'Vault'];

beforeEach(() => {
  jest.clearAllMocks();
  mockTree.stack = ['MessengerHome', 'VaultLock', 'VaultScreen'];
  mockTree.parent = undefined;
  mockTree.routes = undefined;
  mockTree.index = undefined;
  mockTree.canGoBack = false;
  mockVault.unlocked = false;
  mockRouteParams.value = undefined;
  mockVerifyPin.mockResolvedValue({ok: true});
  mockSetupPin.mockResolvedValue(undefined);
});

/** Enter the same 6 digits, the only way to drive either keypad. */
function enterPin(getByText: (t: string) => unknown) {
  for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1') as never);}
}

describe('B-453 — leaving the lock must not land on the screen the lock guards', () => {
  it('B-453 — inside the workspace shell it leaves the Vault TAB, never resets onto MessengerHome', () => {
    mockTree.parent = DEPT_TABS;                         // the 5-tab workspace shell

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(mockParentNavigate).toHaveBeenCalledWith('Home');
    // The reset is the ping-pong: 'MessengerHome' in that stack IS FilesScreen.
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('B-453 — outside the shell the original reset to MessengerHome is unchanged', () => {
    mockTree.parent = undefined;                         // messenger / agent stack

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]});
    expect(mockParentNavigate).not.toHaveBeenCalled();
  });

  it('B-453 — the hardware-back trap survives and takes the same shell-aware exit', () => {
    mockTree.parent = DEPT_TABS;
    const {BackHandler} = require('react-native') as typeof import('react-native');
    const spy = jest.spyOn(BackHandler, 'addEventListener');

    render(<VaultLockScreen />);

    const entry = spy.mock.calls.find(c => c[0] === 'hardwareBackPress');
    expect(entry).toBeDefined();
    const handler = entry![1] as () => boolean;
    // Returning true is what CONSUMES the key — dropping that lets back pop the
    // lock and reveal whatever sits below it.
    expect(handler()).toBe(true);
    expect(mockParentNavigate).toHaveBeenCalledWith('Home');
    spy.mockRestore();
  });
});

describe('B-453 — the unlock returns to whatever asked for it', () => {
  it('B-453 — a Files-gated unlock goes back to Files, not to the cloud vault', async () => {
    mockRouteParams.value = {next: 'Files'};

    const {getByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('Files'));
    expect(mockReplace).not.toHaveBeenCalledWith('VaultScreen');
  });

  it('B-453 — a workspace Vault-tab unlock goes back to that tab root', async () => {
    mockRouteParams.value = {next: 'MessengerHome'};

    const {getByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('MessengerHome'));
  });

  it('B-453 — with no target it still forwards to the vault (openVault\'s path)', async () => {
    mockRouteParams.value = undefined;

    const {getByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('VaultScreen'));
  });

  it('B-453 — a WRONG pin forwards nowhere at all', async () => {
    mockRouteParams.value = {next: 'Files'};
    mockVerifyPin.mockResolvedValue({ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 4});

    const {getByText, findByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    expect(await findByText('Incorrect PIN. Try again.')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

/**
 * The FIRST-RUN lane. The B-453 gate sends a user with no PIN to VaultNewPin,
 * not to an empty keypad — so setup owes the same return contract. Landing on
 * VaultScreen here is worse than merely wrong: the Cloud Vault is Pro+, so a
 * Lite user who set a PIN to open their own phone files would be dropped on a
 * shelf they have no entitlement to.
 */
describe('B-453 — first-run PIN setup returns to the screen that asked for it', () => {
  it('B-453 — setting a PIN from the Files gate lands back on Files', async () => {
    mockRouteParams.value = {next: 'Files'};

    const {getByText} = render(<VaultNewPinScreen />);
    enterPin(getByText);                       // choose
    await waitFor(() => expect(getByText('Confirm New PIN')).toBeTruthy(), {timeout: 4000});
    enterPin(getByText);                       // confirm

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('Files'), {timeout: 4000});
    expect(mockReplace).not.toHaveBeenCalledWith('VaultScreen');
  });

  it('B-453 — setting a PIN from the workspace Vault tab lands back on that root', async () => {
    mockRouteParams.value = {next: 'MessengerHome'};

    const {getByText} = render(<VaultNewPinScreen />);
    enterPin(getByText);
    await waitFor(() => expect(getByText('Confirm New PIN')).toBeTruthy(), {timeout: 4000});
    enterPin(getByText);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('MessengerHome'), {timeout: 4000});
  });

  it('B-453 — with no target it still opens the vault (openVault\'s first-run path)', async () => {
    mockRouteParams.value = undefined;

    const {getByText} = render(<VaultNewPinScreen />);
    enterPin(getByText);
    await waitFor(() => expect(getByText('Confirm New PIN')).toBeTruthy(), {timeout: 4000});
    enterPin(getByText);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('VaultScreen'), {timeout: 4000});
  });
});

/**
 * The Settings lane — the vault biometric toggle's "Enter PIN" round trip.
 *
 * The forward is RESOLVED, not bare-navigated: this screen runs in three shells
 * and a hard-coded name one of them does not register compiles and silently
 * no-ops (Issues 18/19). And it `navigate`s rather than `replace`s, so the
 * StackRouter pops back to the LIVE Settings instance instead of mounting a
 * second one over the user's unsaved profile edits.
 */
describe('the unlock returns to Settings through the resolver', () => {
  it('resolves the navigator that registers Settings and NAVIGATES to it', async () => {
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.stack = ['MessengerHome', 'VaultLock', 'MessengerSettings'];

    const {getByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('MessengerSettings'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('falls back to the anti-leak exit when NO navigator registers it', async () => {
    // Unreachable once W1 landed, which is exactly why it is pinned: a deep
    // link or a restored state must not strand the user on the keypad.
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.stack = ['MessengerHome', 'VaultLock', 'VaultScreen'];

    const {getByText} = render(<VaultLockScreen />);
    for (let i = 0; i < 6; i++) {fireEvent.press(getByText('1'));}

    await waitFor(() => expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]}));
    expect(mockNavigate).not.toHaveBeenCalledWith('MessengerSettings');
  });

  /**
   * WHY THE CALLER LOCKS. This screen forwards on focus whenever the vault is
   * merely UNLOCKED — the 5-minute window that the Settings toggle's
   * `pinFresh()` anchor deliberately refuses. Reaching here with the vault
   * still open therefore returns the user with NOTHING typed, and the next tap
   * re-raises the same Alert: a loop until the window dies on its own.
   *
   * The forward is correct for every other lane (a warm VaultLock over an
   * already-open vault must not strand anyone) and is arch-gated (§9 G1), so
   * the guarantee lives on the caller: MessengerSettingsScreen's "Enter PIN"
   * handler calls `lock()` before navigating — pinned in
   * vaultBiometricToggle.test.ts. This case is the mechanism that pin exists
   * for: delete the lock() and THIS is what the user gets.
   */
  it('an already-unlocked vault forwards without a PIN — the reason the caller locks first', () => {
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.stack = ['MessengerHome', 'VaultLock', 'MessengerSettings'];
    mockVault.unlocked = true;

    render(<VaultLockScreen />);

    expect(mockNavigate).toHaveBeenCalledWith('MessengerSettings');
    expect(mockVerifyPin).not.toHaveBeenCalled();
  });

  it('a LOCKED vault stays on the keypad — what the caller\'s lock() buys', () => {
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.stack = ['MessengerHome', 'VaultLock', 'MessengerSettings'];
    mockVault.unlocked = false;

    render(<VaultLockScreen />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('the no-PIN hop lands back on Settings too', async () => {
    // A malformed legacy hash nulls pinHash mid-flow, so VaultLock redirects to
    // setup with route.params forwarded whole. Setup owes the same return.
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.stack = ['MessengerHome', 'VaultNewPin', 'MessengerSettings'];

    const {getByText} = render(<VaultNewPinScreen />);
    enterPin(getByText);
    await waitFor(() => expect(getByText('Confirm New PIN')).toBeTruthy(), {timeout: 4000});
    enterPin(getByText);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('MessengerSettings'), {timeout: 4000});
    expect(mockReplace).not.toHaveBeenCalledWith('VaultScreen');
  });
});

/**
 * §3.3b — cancelling the lock in the Settings lane.
 *
 * The user came from a screen that is NOT the vault, so resetting them to
 * MessengerHome throws the pane (and any unsaved edits) away for no security
 * gain. But `next` is CALLER data — it survives deep links and restored
 * navigation state — so "Settings sits beneath" is a CHECKED precondition. The
 * back-trap is never defeated on an unverified param, and the arms below are
 * what stop a future edit from quietly dropping either guard.
 */
describe('the Settings lane cancels back — on proof, not on the param', () => {
  const settingsBeneath = () => {
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.routes = [{name: 'MessengerSettings'}, {name: 'VaultLock'}];
    mockTree.index = 1;
    mockTree.canGoBack = true;
  };

  it('ARM 1 — with Settings genuinely beneath, the arrow pops back to it', () => {
    settingsBeneath();

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    // goBackOnce, not raw goBack: a double tap must not bubble a pop to the
    // parent navigator (B-261).
    expect(goBackOnce).toHaveBeenCalledTimes(1);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockParentNavigate).not.toHaveBeenCalled();
  });

  it('ARM 1 — hardware back takes the same exit and still CONSUMES the key', () => {
    settingsBeneath();
    const {BackHandler} = require('react-native') as typeof import('react-native');
    const spy = jest.spyOn(BackHandler, 'addEventListener');

    render(<VaultLockScreen />);

    const entry = spy.mock.calls.find(c => c[0] === 'hardwareBackPress');
    expect(entry).toBeDefined();
    const handler = entry![1] as () => boolean;
    expect(handler()).toBe(true);
    expect(goBackOnce).toHaveBeenCalledTimes(1);
    expect(mockReset).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ARM 2 — with something ELSE beneath, it falls through to the original exit', () => {
    settingsBeneath();
    mockTree.routes = [{name: 'Chat'}, {name: 'VaultLock'}];

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(goBackOnce).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]});
  });

  it('ARM 2 — canGoBack() false wins even when the state CLAIMS Settings beneath', () => {
    // The discriminating case for guard 1: a restored navigation state can
    // describe a stack the router will not pop (the two disagree). Trusting the
    // snapshot alone consumes the back key on a goBack() that no-ops — the user
    // is HARD-STUCK on the lock, which is worse than the data loss the lane
    // exists to avoid. Guard 2 cannot see this at all.
    mockRouteParams.value = {next: 'MessengerSettings'};
    mockTree.routes = [{name: 'MessengerSettings'}, {name: 'VaultLock'}];
    mockTree.index = 1;
    mockTree.canGoBack = false;

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(goBackOnce).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]});
  });

  it('ARM 2 — with NOTHING beneath it falls through, or the user is HARD-STUCK', () => {
    // goBack() no-ops on an empty stack while the hardware-back handler still
    // returns true: the key is consumed and nothing happens, forever. That is
    // strictly worse than the data loss the lane exists to avoid.
    settingsBeneath();
    mockTree.routes = [{name: 'VaultLock'}];
    mockTree.index = 0;
    mockTree.canGoBack = false;

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(goBackOnce).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]});
  });

  it('ARM 3 — every other lane still resets, even with Settings sitting beneath', () => {
    mockRouteParams.value = {next: 'Files'};
    mockTree.routes = [{name: 'MessengerSettings'}, {name: 'VaultLock'}];
    mockTree.index = 1;
    mockTree.canGoBack = true;

    const {getByLabelText} = render(<VaultLockScreen />);
    fireEvent.press(getByLabelText('Leave vault lock'));

    expect(goBackOnce).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalledWith({index: 0, routes: [{name: 'MessengerHome'}]});
  });
});
