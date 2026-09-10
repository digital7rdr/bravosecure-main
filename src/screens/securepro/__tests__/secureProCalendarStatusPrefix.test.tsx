/**
 * PDF-1 #6 follow-up — "Requested / Confirmed / Booked should reflect the true
 * mission status": the Coverage Calendar's REQUESTS rows must read as a
 * sentence led by the mission's real status, in the legend's own words
 * ("Requested" / "Scheduled"), e.g. "Requested from 01 Sep 2026 to 02 Sep 2026".
 *
 * RED-first: the pre-fix row rendered the bare range ("01 Sep 2026 to 02 Sep
 * 2026") with no status word in the sentence.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import SecureProCalendarScreen from '@screens/securepro/SecureProCalendarScreen';
import {secureProApi} from '@services/api';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

jest.mock('@services/api', () => ({
  secureProApi: {
    missions: jest.fn(),
    requestMission: jest.fn(),
  },
}));

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
jest.mock('@screens/securepro/useProAppRealtime', () => ({useProAppRealtime: () => {}}));

const APP = {
  id: 'app-1',
  status: 'ACTIVE',
  start_date: '2026-09-01',
  proposal: {coverage_start: '2026-09-01', coverage_end: '2026-11-30'},
};
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: APP}),
}));

const mockMissions = secureProApi.missions as jest.Mock;

const mission = (id: string, status: string, dates: string[]) => ({
  id, application_id: 'app-1', requested_by: 'u1', mission_dates: dates, note: null,
  status, assigned_team: [], ops_note: null, created_at: '2026-08-20T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SecureProCalendarScreen — REQUESTS rows carry the true mission status', () => {
  it('a REQUESTED mission reads "Requested from A to B"', async () => {
    mockMissions.mockResolvedValue({data: {missions: [
      mission('m1', 'REQUESTED', ['2026-09-01', '2026-09-02']),
    ]}});
    const {findByText} = render(<SecureProCalendarScreen />);
    expect(await findByText(/Requested from 01 Sep 2026 to 02 Sep 2026/)).toBeTruthy();
  });

  it('a SCHEDULED mission uses the legend word "Scheduled", and a single day reads "on"', async () => {
    mockMissions.mockResolvedValue({data: {missions: [
      mission('m2', 'SCHEDULED', ['2026-10-05']),
    ]}});
    const {findByText} = render(<SecureProCalendarScreen />);
    expect(await findByText(/Scheduled on 05 Oct 2026/)).toBeTruthy();
  });

  it('never renders a bare range with no status word', async () => {
    mockMissions.mockResolvedValue({data: {missions: [
      mission('m3', 'REQUESTED', ['2026-09-10', '2026-09-11', '2026-09-12']),
    ]}});
    const {findByText, queryByText} = render(<SecureProCalendarScreen />);
    await findByText(/10 Sep 2026 to 12 Sep 2026/);
    // The bare range (count separator immediately followed by the date) is the pre-fix shape.
    expect(queryByText(/dates · 10 Sep 2026/)).toBeNull();
  });
});
