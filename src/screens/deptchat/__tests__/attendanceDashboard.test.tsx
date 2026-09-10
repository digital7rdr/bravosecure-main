/**
 * Client review vs2 item 13 — "Manage Shifts, Set Day Status, and Monthly
 * Roster must be combined on one attendance dashboard rather than treated as
 * separate disconnected areas."
 *
 * A RENDER test, deliberately. The sibling source scan in
 * `rosterCorrectionsClient.test.ts` proves the four `<X embedded />` tags exist
 * in the file — it cannot prove the segment bar reaches them. A typo in a
 * SEGMENTS key, a body wired under the wrong key, or a `tab` value nothing can
 * set would all leave that scan green while the dashboard showed one segment
 * forever. Press the pills and assert what actually renders.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
// Spread the real module: navigationRef needs createNavigationContainerRef,
// and departmentalEntry (imported transitively) reads it at module scope.
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
  useRevealOnKeyboard: () => jest.fn(),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
// Native modules and stores the four segment bodies pull in transitively.
// (Same shape as joinCtaReachability's list — these screens sit deep in the
// workspace import graph.)
jest.mock('react-native-geolocation-service', () => ({
  getCurrentPosition: jest.fn(), requestAuthorization: jest.fn(),
}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// Both shapes: the hook form AND `.getState()`, which deptNoun calls at render
// time. Mocking only the hook made one segment throw where the others passed.
const AUTH_STATE = {user: {id: 'u1', is_org_manager: true, account_kind: 'agency'}};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(AUTH_STATE);
  useAuthStore.getState = () => AUTH_STATE;
  return {useAuthStore};
});

// Every segment loads on mount; empty payloads keep the test about ROUTING.
jest.mock('@services/api', () => ({
  attendanceApi: {
    orgSummary: jest.fn().mockResolvedValue({data: {counts: {}, total: 0, pendingReview: 0}}),
    pendingQueue: jest.fn().mockResolvedValue({data: []}),
    listShifts: jest.fn().mockResolvedValue({data: []}),
    orgSessions: jest.fn().mockResolvedValue({data: []}),
    readRosterMonth: jest.fn().mockResolvedValue({data: {month: null}}),
    getRosterMonth: jest.fn().mockResolvedValue({data: {month: null}}),
  },
  orgApi: {
    // vs2 item 17b — every surface that advertises a module now asks
    // which ones this workspace hides. Rejecting is the fail-open path.
    workspaceSettings: jest.fn().mockRejectedValue(new Error('none')),listCpos: jest.fn().mockResolvedValue({data: []})},
}));

import AdminAttendanceScreen from '../AdminAttendanceScreen';

describe('vs2 item 13 — the one attendance dashboard', () => {
  it('renders all five segments in the bar', async () => {
    const ui = render(<AdminAttendanceScreen />);
    for (const label of ['Review', 'Shifts', 'Day status', 'Roster', 'Corrections']) {
      expect(ui.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('opens on REVIEW, so the screen still lands where it always did', async () => {
    const ui = render(<AdminAttendanceScreen />);
    await waitFor(() => expect(ui.getAllByText('PENDING REVIEW').length).toBe(1));
  });

  /**
   * Assert the SWITCH, not the switched-in screen's loaded content: these
   * bodies each fire their own async load on mount, and waiting on that inside
   * the routing test races the child's state updates rather than testing the
   * routing. The review queue disappearing proves the host swapped bodies.
   */
  it.each([
    ['Shifts'],
    ['Day status'],
    ['Roster'],
    ['Corrections'],
  ])('the %s pill replaces the review queue', async (label) => {
    const ui = render(<AdminAttendanceScreen />);
    await waitFor(() => expect(ui.getAllByText('PENDING REVIEW').length).toBe(1));
    fireEvent.press(ui.getByLabelText(label));
    await waitFor(() => expect(ui.queryByText('PENDING REVIEW')).toBeNull());
  });

  it('the switch is not one-way — Review comes back', async () => {
    const ui = render(<AdminAttendanceScreen />);
    await waitFor(() => expect(ui.getAllByText('PENDING REVIEW').length).toBe(1));
    fireEvent.press(ui.getByLabelText('Shifts'));
    await waitFor(() => expect(ui.queryByText('PENDING REVIEW')).toBeNull());
    fireEvent.press(ui.getByLabelText('Review'));
    await waitFor(() => expect(ui.getAllByText('PENDING REVIEW').length).toBe(1));
  });

  it('the embedded bodies do NOT draw their own header', async () => {
    const ui = render(<AdminAttendanceScreen />);
    // Let the host settle before pressing: its own load resolves async and a
    // press mid-flight targets a node React has already replaced.
    await waitFor(() => expect(ui.getAllByText('PENDING REVIEW').length).toBe(1));
    fireEvent.press(ui.getByLabelText('Shifts'));
    // The host's header is the only one; ShiftManagement's own "Shifts" title
    // would be a second header inside the dashboard.
    await waitFor(() => expect(ui.getAllByText('Admin Attendance').length).toBe(1));
  });
});
