/**
 * PDF-1 #7 (D2) — the linked-member "Family Full" DEAD-END becomes an
 * actionable "Request additional seats" Ops request.
 *
 * At the 4/4 cap the old CTA was a dimmed, DISABLED "Family Full" button that
 * did nothing. The founder decision: keep the self-serve add hard-capped at 4,
 * but give the holder an escape hatch — a live button that files an Ops request
 * (`familyApi.requestSeats`) and confirms "Request sent — Ops will be in touch".
 *
 * RED-first: against the dead-button code `getByLabelText('Request additional
 * seats')` throws (the label is "Add member"/text "Family Full", disabled).
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';
import SecureProMembersScreen from '@screens/securepro/SecureProMembersScreen';
import {familyApi} from '@services/api';
import {Alert} from '@utils/alert';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(cb, []);
  },
}));

const member = (i: number) => ({
  id: `m${i}`, memberId: `u${i}`, name: `Member ${i}`, avatarUrl: null,
  status: 'active', relationship: 'Son', heldUntil: null,
  spendLimit: null, spent: 0,
  invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-01T00:00:00.000Z',
  lastLocation: null,
});

jest.mock('@services/api', () => ({
  familyApi: {
    members: jest.fn(),
    requestSeats: jest.fn().mockResolvedValue({data: {ok: true}}),
    memberSpend: jest.fn().mockResolvedValue({data: {member: {}, byFeature: [], transactions: []}}),
    invite: jest.fn(),
    setHold: jest.fn(),
    setLimit: jest.fn(),
    remove: jest.fn(),
  },
  tokenStore: {get: jest.fn(), set: jest.fn()},
  refreshAccessTokenShared: jest.fn(),
}));

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 110, bottomPad: () => 12}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
jest.mock('@/modules/messenger/contacts/useDiscoveredContacts', () => ({
  useDiscoveredContacts: () => ({matches: [], loading: false, permission: 'granted'}),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@/modules/news/mapbox', () => ({buildPinMapUrl: () => ''}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+971500000000'}}),
}));

const mockMembers = familyApi.members as jest.Mock;
const mockRequestSeats = familyApi.requestSeats as jest.Mock;
const mockAlert = Alert.alert as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestSeats.mockResolvedValue({data: {ok: true}});
});

describe('SecureProMembersScreen — the cap CTA files an Ops request', () => {
  it('at 4/4 shows an actionable "Request additional seats" (NOT a dead "Family Full")', async () => {
    mockMembers.mockResolvedValue({data: {members: [member(1), member(2), member(3), member(4)]}});
    const {findByLabelText, queryByText} = render(<SecureProMembersScreen />);

    const cta = await findByLabelText('Request additional seats');
    expect(cta).toBeTruthy();
    // The dead button is gone, and the live one is not disabled.
    expect(queryByText('Family Full')).toBeNull();
    expect(cta.props.accessibilityState?.disabled).toBe(false);
  });

  it('pressing it fires familyApi.requestSeats and confirms "request sent"', async () => {
    mockMembers.mockResolvedValue({data: {members: [member(1), member(2), member(3), member(4)]}});
    const {findByLabelText, findByText} = render(<SecureProMembersScreen />);

    fireEvent.press(await findByLabelText('Request additional seats'));

    await waitFor(() => expect(mockRequestSeats).toHaveBeenCalledTimes(1));
    expect(await findByText('Request sent — Ops will be in touch')).toBeTruthy();
    expect(mockAlert).toHaveBeenCalledWith('Request sent', expect.stringContaining('Ops'));
  });

  it('below the cap the normal "Add Member" CTA is unchanged (no request path)', async () => {
    mockMembers.mockResolvedValue({data: {members: [member(1), member(2), member(3)]}});
    const {findByText, queryByLabelText} = render(<SecureProMembersScreen />);

    expect(await findByText('Add Member')).toBeTruthy();
    expect(queryByLabelText('Request additional seats')).toBeNull();
  });
});
