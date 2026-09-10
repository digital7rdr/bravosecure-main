/**
 * OTPVerificationScreen — custom in-app keypad (Bravo Verify Number redesign).
 *
 * The screen replaced six TextInputs + OS keyboard with an in-app numeric
 * keypad, so digit entry, backspace, clipboard paste, and the
 * complete-gate on Verify are now screen logic. These tests pin that the
 * assembled code reaches the auth store intact.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockVerifyRegister = jest.fn(() => Promise.resolve());
const mockVerifyOtp = jest.fn(() => Promise.resolve());
const mockGetStringAsync = jest.fn(() => Promise.resolve(''));

jest.mock('@store/authStore', () => ({
  useAuthStore: () => ({
    verifyOtp: mockVerifyOtp,
    verifyRegister: mockVerifyRegister,
    register: jest.fn(() => Promise.resolve()),
    completeAuth: jest.fn(() => Promise.resolve()),
    pendingUserId: null,
    isLoading: false,
    error: null,
  }),
}));

// expo-linear-gradient ships ESM that Jest's transformIgnorePatterns
// excludes from transform; stub it like GroupCallScreen.autopop does.
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Path: 'Path',
  Rect: 'Rect',
  Circle: 'Circle',
}));
jest.mock('expo-clipboard', () => ({getStringAsync: () => mockGetStringAsync()}));

jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});

import OTPVerificationScreen from '../OTPVerificationScreen';

const routeParams = {
  phone: '+8801712346163',
  mode: 'register',
  email: 'ranak@example.com',
  password: 'hunter22!',
  fullName: 'Ranak D',
  role: 'client',
  tier: undefined,
};

function renderScreen() {
  const navigation = {goBack: jest.fn()};
  const api = render(
    <OTPVerificationScreen
      navigation={navigation as any}
      route={{params: routeParams} as any}
    />,
  );
  return {...api, navigation};
}

const tap = (api: ReturnType<typeof render>, label: string) =>
  fireEvent.press(api.getByLabelText(label));

describe('OTPVerificationScreen — in-app keypad', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keypad digits assemble the code and Verify submits it', async () => {
    const api = renderScreen();

    // Incomplete code — Verify is gated.
    tap(api, 'Digit 1');
    fireEvent.press(api.getByText('Verify & Continue'));
    expect(mockVerifyRegister).not.toHaveBeenCalled();

    for (const d of ['2', '3', '4', '5', '6']) {tap(api, `Digit ${d}`);}
    fireEvent.press(api.getByText('Verify & Continue'));

    await waitFor(() =>
      expect(mockVerifyRegister).toHaveBeenCalledWith(
        expect.objectContaining({code: '123456', phoneE164: routeParams.phone}),
      ),
    );
  });

  it('backspace removes the last digit before submit', async () => {
    const api = renderScreen();

    tap(api, 'Digit 9');
    tap(api, 'Delete digit');
    for (const d of ['1', '2', '3', '4', '5', '6']) {tap(api, `Digit ${d}`);}
    fireEvent.press(api.getByText('Verify & Continue'));

    await waitFor(() =>
      expect(mockVerifyRegister).toHaveBeenCalledWith(
        expect.objectContaining({code: '123456'}),
      ),
    );
  });

  it('paste extracts digits from clipboard text and fills the code', async () => {
    mockGetStringAsync.mockResolvedValueOnce('Your Bravo code is 654321');
    const api = renderScreen();

    tap(api, 'Paste code');
    await waitFor(() => expect(mockGetStringAsync).toHaveBeenCalled());

    fireEvent.press(api.getByText('Verify & Continue'));
    await waitFor(() =>
      expect(mockVerifyRegister).toHaveBeenCalledWith(
        expect.objectContaining({code: '654321'}),
      ),
    );
  });

  it('extra digit presses beyond 6 are ignored', async () => {
    const api = renderScreen();

    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8']) {tap(api, `Digit ${d}`);}
    fireEvent.press(api.getByText('Verify & Continue'));

    await waitFor(() =>
      expect(mockVerifyRegister).toHaveBeenCalledWith(
        expect.objectContaining({code: '123456'}),
      ),
    );
  });
});
