/**
 * Channels vs2 item 18 — the drawer's shape, and what leaves it.
 *
 * Three things the client asked for, and one thing they did not: that no
 * capability disappears while the rows are being rearranged. The provider
 * branch is the one at risk — it has no switch section, so the workspace row
 * moving "into SWITCH DASHBOARD" would delete its only workspace door.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockConfirm = jest.fn((_dest: string, _onYes: () => void) => {});
let mockUser: Record<string, unknown>;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, getParent: () => undefined, getState: () => ({routeNames: []})}),
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({
  Alert: {alert: jest.fn()},
  confirmSwitchDashboard: (d: string, y: () => void) => mockConfirm(d, y),
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(
    (sel?: (s: unknown) => unknown) => (sel ? sel({user: mockUser, signOut: jest.fn()}) : {user: mockUser, signOut: jest.fn()}),
    {getState: () => ({user: mockUser})}),
}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({hasDeptChannels: true, isOrgAffiliated: true}),
  showEnterpriseUpgradePrompt: jest.fn(),
}));
jest.mock('@navigation/departmentalEntry', () => ({
  findNavigatorWithRoute: () => undefined,
  openDepartmentChannels: () => ({ok: true}),
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => false, dispatch: jest.fn()},
  mountedTreeHasRoute: () => false,
  mountedStackHasRoutesAbove: () => false,
}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn()}));

import {ProfileDrawerModal} from '../ProfileDrawerModal';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = {id: 'u1', full_name: 'A B', email: 'a@b.c', account_kind: 'client'};
});

describe('the CLIENT drawer', () => {
  it('moves the workspace row into SWITCH DASHBOARD, below the three products', () => {
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    // CONTAINMENT AND ORDER, not mere presence. The first version asserted only
    // that both labels rendered, which passes identically with the row still in
    // the top group — so the one structural claim of this change was unpinned.
    const text = JSON.stringify(u.toJSON());
    const bookings = text.indexOf('My Bookings');
    const header = text.indexOf('SWITCH DASHBOARD');
    const row = text.indexOf('Channels');
    expect(bookings).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(bookings);
    // …and the workspace row comes after the section header, i.e. inside it.
    expect(row).toBeGreaterThan(header);
  });

  it('calls the destination "Channels" when the user has no workspace', () => {
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    expect(u.getByText('Channels')).toBeTruthy();
    expect(u.queryByText('Workspaces')).toBeNull();
  });

  it('keeps calling it "Workspaces" for an AFFILIATED user', () => {
    // Renaming the hub arm would mislabel an organisations/invites/join hub and
    // collide with item 17's "Channels" header one screen away.
    mockUser = {...mockUser, owns_workspace: true};
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    expect(u.getByText('Workspaces')).toBeTruthy();
    expect(u.queryByText('Channels')).toBeNull();
  });

  it('confirms before going, on BOTH arms of the row', () => {
    /**
     * The confirm hangs off `go`, not off the label. Wiring it by label would
     * have left the workspace-affiliated user — most of the enterprise audience
     * — leaving from the same physical row with no confirm at all.
     */
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('Channels'));
    expect(mockConfirm).toHaveBeenCalledWith('Channels', expect.any(Function));

    mockConfirm.mockClear();
    mockUser = {...mockUser, owns_workspace: true};
    const v = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(v.getByText('Workspaces'));
    expect(mockConfirm).toHaveBeenCalledWith('Workspaces', expect.any(Function));
  });

  it('has no "Choose Dashboard" row', () => {
    // It re-opened the BOOT product gate mid-session — a second way to do what
    // the three product rows already do, with a full-screen takeover.
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    expect(u.queryByText('Choose Dashboard')).toBeNull();
  });
});

describe('the PROVIDER drawer keeps its own door', () => {
  it('still lists the workspace row inline — it has no switch section to move it into', () => {
    mockUser = {...mockUser, account_kind: 'agency'};
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    expect(u.getByText('Channels')).toBeTruthy();
    expect(u.getByText('Return to Dashboard')).toBeTruthy();
    // …and it reaches neither the switch section nor the gate.
    expect(u.queryByText('Secure Services')).toBeNull();
    expect(u.queryByText('Choose Dashboard')).toBeNull();
  });
});

/**
 * Channels vs2 edge A5/A6 — EVERY cross-surface door confirms, through the one
 * shared helper.
 *
 * The same physical row is rendered twice: the client arm draws it inside
 * `SwitchDashboardSection`'s `extraRow`, which wired the confirm by hand, and
 * the PROVIDER arm draws it through the `rows` map, which did not. So one
 * persona was asked and the other was teleported off their surface silently.
 * "Return to Dashboard" — provider-only, and the biggest jump of the three —
 * had no confirm at all.
 */
describe('edge A6 — the provider drawer asks too', () => {
  beforeEach(() => { mockUser = {...mockUser, account_kind: 'agency'}; });

  it('the workspace row CONFIRMS instead of switching surface silently', () => {
    mockUser = {...mockUser, owns_workspace: true};
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('Workspaces'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm.mock.calls[0][0]).toBe('Workspaces');
  });

  it('"Return to Dashboard" confirms as well', () => {
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('Return to Dashboard'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('an ordinary in-surface row does NOT confirm', () => {
    // The rule is "leaves the surface", not "is a drawer row" — My Profile
    // stays put and must not grow a dialog.
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('My Profile'));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('confirming actually RUNS the row\'s action; declining runs nothing', () => {
    /**
     * `mockConfirm` never invoked `onYes`, so nothing asserted that the switch
     * still happens after the dialog — a mis-wire handing this row the wrong
     * `go` would have been invisible.
     *
     * `onClose` is the observable this harness can see: the drawer closes as
     * the FIRST thing every `go` does, and the destination itself lands behind
     * a 220ms fade through resolvers this suite stubs out (`findNavigatorWithRoute`
     * returns undefined here, so no `navigate` is reachable at all).
     */
    mockUser = {...mockUser, owns_workspace: true};
    const onClose = jest.fn();
    const u = render(<ProfileDrawerModal visible onClose={onClose} />);
    fireEvent.press(u.getByText('Workspaces'));
    expect(onClose).not.toHaveBeenCalled();        // asked, not yet acted

    (mockConfirm.mock.calls[0][1] as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);      // …and Yes performs it
  });
});

describe('edge A6 — the CLIENT arm still asks exactly ONCE', () => {
  /**
   * The client renders this same row through `SwitchDashboardSection`'s
   * `extraRow`, which wires its own `confirmSwitchDashboard`. The provider arm's
   * new `confirm` flag must not reach it — `rows` carries `deptRow` only when
   * `isProvider`. Asserted by COUNT: the pre-existing case used
   * `toHaveBeenCalledWith`, which passes just as happily with two calls, so
   * nothing in this suite would have failed if the client started prompting
   * twice.
   */
  it('one dialog per press on the client arm', () => {
    mockUser = {...mockUser, owns_workspace: true};   // client: no account_kind
    const u = render(<ProfileDrawerModal visible onClose={jest.fn()} />);
    fireEvent.press(u.getByText('Workspaces'));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
});
