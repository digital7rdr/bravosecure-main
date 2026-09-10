/**
 * PDF-1 #4 follow-up — "Protection Requested" must be VISIBLE, not just an
 * alert. On `no_cpo_assigned` the screen used to show a positive Alert and
 * return to the same idle "Request Protection" state, so once the alert was
 * dismissed nothing on screen said a request existed.
 *
 * Now the idle phase renders an on-screen status card ("Protection Requested"
 * + "Sent to the Bravo Control System at HH:MM…") and the CTA reads "Request
 * again" (requests stay allowed — the server re-notifies Ops). The card is
 * local, per app session, and clears once a real session is adopted.
 *
 * RED-first: pre-fix, after the no_cpo_assigned rejection the idle block
 * rendered only "Request Protection" — no card, no "Request again".
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';
import ProLiveMissionScreen from '@screens/pro/ProLiveMissionScreen';
import {protectionApi} from '@services/api';
import {Alert} from '@utils/alert';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
}));
jest.mock('react-native-webview', () => ({WebView: 'WebView'}));
jest.mock('react-native-geolocation-service', () => ({
  getCurrentPosition: jest.fn(), requestAuthorization: jest.fn(),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, visible: false, safeBottom: 0, bottomPad: (g = 0) => g}),
}));
jest.mock('@hooks/useProPlanGate', () => ({useProPlanGate: () => {}}));
jest.mock('@hooks/useProtectionReadiness', () => ({
  useProtectionReadiness: () => ({
    flags: {}, missing: [], ready: true, checking: false, serverState: null, blockedBy: [],
    recheck: jest.fn(), openSettings: jest.fn(),
  }),
}));
jest.mock('@components/protection/ReadinessGate', () => 'ReadinessGate');
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@utils/locationPermission', () => ({
  ensureLiveLocationAccess: jest.fn().mockResolvedValue('granted'),
}));
jest.mock('@/modules/maps/mapToken', () => ({MAPBOX_TOKEN: 'x', MAPBOX_TOKEN_MISSING: true}));
jest.mock('@/modules/maps/mapWebViewSource', () => ({mapHtmlSource: (h: string) => ({html: h})}));
jest.mock('@store/secureProStore', () => ({
  useSecureProStore: (sel: (s: unknown) => unknown) => sel({application: {id: 'app-1', status: 'ACTIVE'}}),
}));
jest.mock('@services/protectionLocationService', () => ({
  protectionLocationService: {
    getStatus: () => ({serverStatus: null, lastSentAt: null, lastError: null}),
    subscribe: () => () => {},
    start: jest.fn(),
    stop: jest.fn(),
  },
}));
jest.mock('@screens/pro/useProtectionSessionRealtime', () => ({useProtectionSessionRealtime: () => {}}));
jest.mock('@services/api', () => ({
  protectionApi: {
    current: jest.fn(),
    create: jest.fn(),
    end: jest.fn(),
    notes: jest.fn().mockResolvedValue({data: {notes: []}}),
    postNote: jest.fn(),
  },
  sosApi: {raise: jest.fn()},
}));

const mockCurrent = protectionApi.current as jest.Mock;
const mockCreate = protectionApi.create as jest.Mock;
const mockAlert = Alert.alert as jest.Mock;

const NO_CPO = {response: {status: 409, data: {message: 'no_cpo_assigned'}}};
const NO_SESSION = {response: {status: 404}};

/** Drive the consent dialog: press "Start Protection" on the captured Alert. */
async function requestProtection(api: ReturnType<typeof render>, label = 'Request protection') {
  fireEvent.press(await api.findByLabelText(label));
  const call = mockAlert.mock.calls.find(c => c[0] === 'Share your live location?');
  expect(call).toBeTruthy();
  const start = (call![2] as Array<{text: string; onPress?: () => void}>).find(b => b.text === 'Start Protection');
  await act(async () => { start!.onPress!(); });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrent.mockRejectedValue(NO_SESSION);
});

describe('ProLiveMissionScreen — "Protection Requested" is visible on screen (PDF-1 #4)', () => {
  it('after no_cpo_assigned the idle phase shows the status card and the CTA reads "Request again"', async () => {
    mockCreate.mockRejectedValue(NO_CPO);
    const api = render(<ProLiveMissionScreen />);
    await api.findByLabelText('Request protection');

    await requestProtection(api);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(await api.findByText('Protection Requested')).toBeTruthy();
    expect(api.getByText(/Sent to the Bravo Control System at \d{1,2}:\d{2} (AM|PM)\. Ops will assign a protection officer and confirm shortly\./)).toBeTruthy();
    expect(api.getByText('Request again')).toBeTruthy();
    // The positive Alert is still raised — the card is in ADDITION to it.
    expect(mockAlert).toHaveBeenCalledWith('Protection Requested', expect.any(String));
  });

  it('"Request again" still fires a request (the server re-notifies Ops), and the card stays', async () => {
    mockCreate.mockRejectedValue(NO_CPO);
    const api = render(<ProLiveMissionScreen />);
    await api.findByLabelText('Request protection');
    await requestProtection(api);
    await api.findByText('Request again');

    await requestProtection(api, 'Request again');
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(api.getByText('Protection Requested')).toBeTruthy();
  });

  it('a real failure keeps the generic error and shows NO card', async () => {
    mockCreate.mockRejectedValue({response: {status: 500, data: {message: 'boom'}}});
    const api = render(<ProLiveMissionScreen />);
    await api.findByLabelText('Request protection');
    await requestProtection(api);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockAlert).toHaveBeenCalledWith("Couldn't start protection", expect.any(String));
    expect(api.queryByText('Protection Requested')).toBeNull();
    expect(api.queryByText('Request again')).toBeNull();
    expect(api.getByLabelText('Request protection')).toBeTruthy();
  });

  it('the card clears once a real session is adopted', async () => {
    mockCreate.mockRejectedValueOnce(NO_CPO).mockResolvedValueOnce({data: {session: {
      id: 's1', status: 'REQUESTED', cpo_name: 'Officer A', call_sign: null, sos_active: false, activated_at: null,
    }}});
    const api = render(<ProLiveMissionScreen />);
    await api.findByLabelText('Request protection');
    await requestProtection(api);
    await api.findByText('Protection Requested');

    await requestProtection(api, 'Request again');
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(await api.findByText('Starting protection…')).toBeTruthy();
    expect(api.queryByText('Protection Requested')).toBeNull();
  });
});
