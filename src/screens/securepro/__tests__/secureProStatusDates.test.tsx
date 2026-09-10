/**
 * PDF-1 #6 follow-up — no raw ISO on a client-facing Pro screen. The status
 * screen still printed `application.start_date` ("2026-09-01") in the request
 * summary and `coverage_start → coverage_end` raw in PREVIOUS PLANS. Both must
 * render the same "DD Mon YYYY" every other Pro screen uses.
 *
 * RED-first: the pre-fix screen rendered the literal ISO strings.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import SecureProStatusScreen from '@screens/securepro/SecureProStatusScreen';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@screens/securepro/useProAppRealtime', () => ({useProAppRealtime: () => {}}));

const APP = {
  id: 'app-1',
  status: 'ACTIVE',
  intended_use: 'family_support',
  intended_use_note: null,
  duration_months: 3,
  duration_note: null,
  start_date: '2026-09-01',
  coverage_area: 'Dubai',
  cpo_count: 2,
  driver_count: 1,
  support_staff_count: 0,
  gender_preference: 'no_preference',
  services: [],
  service_other_note: null,
  notes: null,
  rejected_reason: null,
  submitted_at: '2026-08-20T10:00:00.000Z',
  activated_at: '2026-09-01T00:00:00.000Z',
  current_period_end: '2026-12-01',
  proposal: null,
  events: [],
};
const HISTORY = [{
  id: 'h1', status: 'EXPIRED', intended_use: 'executive_protection',
  submitted_at: '2026-05-01T00:00:00.000Z', activated_at: '2026-05-10T00:00:00.000Z',
  current_period_end: '2026-08-10', total_credits: 12000,
  coverage_start: '2026-05-10', coverage_end: '2026-08-09',
}];
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({
    application: APP, history: HISTORY, isLoading: false, isSubmitting: false, hasLoaded: true,
    loadApplication: jest.fn(), renewPlan: jest.fn(), cancelApplication: jest.fn(),
  }),
}));

describe('SecureProStatusScreen — dates are formatted, never raw ISO', () => {
  it('the Start date row shows "DD Mon YYYY"', () => {
    const {getByText, queryByText} = render(<SecureProStatusScreen />);
    expect(getByText('01 Sep 2026')).toBeTruthy();
    expect(queryByText('2026-09-01')).toBeNull();
  });

  it('PREVIOUS PLANS shows a formatted coverage range, not the ISO pair', () => {
    const {getByText, queryByText} = render(<SecureProStatusScreen />);
    expect(getByText(/10 May 2026 → 09 Aug 2026/)).toBeTruthy();
    expect(queryByText(/2026-05-10 → 2026-08-09/)).toBeNull();
  });
});
