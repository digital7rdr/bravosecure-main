/**
 * BS-WALLET — regression for the "second topup does nothing" bug.
 *
 * Repro on build 59: after one successful topup the Purchase button stayed
 * stuck in its submitting state and every subsequent tap was swallowed (no
 * second POST /wallet/topup), only fixed by unmounting + remounting the
 * screen. Root cause: the `purchasing` re-arm lived in a `finally` that ran
 * only AFTER the post-success balance/batches refresh — so if that refresh
 * hung or rejected outside the catch window, the button never re-armed.
 *
 * These tests pin the invariant: the button re-arms as soon as the topup
 * ATTEMPT settles, independent of the follow-up refresh outcome, so a
 * second topup can always be issued.
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

// W4/B-685 — the screen's default export is now withPaymentBoundary(CreditsScreen)
// (Stripe provider mounts per payment screen, not at the App root). The native
// module doesn't exist in the jest env, so stub the provider to a pass-through —
// the HOC itself still renders, which is the point: tests render what ships.
jest.mock('@stripe/stripe-react-native', () => ({
  StripeProvider: ({children}: {children: React.ReactNode}) => children,
}));

// `mock`-prefixed so jest's mock-factory hoisting allows the reference.
const mockTopUpAndCharge = jest.fn();
const mockLoadBalance = jest.fn(() => Promise.resolve());
const mockLoadCreditBatches = jest.fn(() => Promise.resolve());

jest.mock('@services/stripe', () => ({
  usePaymentFlow: () => ({topUpAndCharge: mockTopUpAndCharge}),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({goBack: jest.fn(), navigate: jest.fn()}),
  useRoute: () => ({params: {}}),
}));

// Stub the API layer so the test doesn't pull the real expo/native env chain
// (CreditsScreen imports walletApi for the promo-code flow).
jest.mock('@services/api', () => ({
  walletApi: {redeemPromo: jest.fn()},
}));

// Drive the wallet store deterministically. loadBalance/loadCreditBatches
// are the post-success refresh calls whose outcome must NOT strand the
// button.
jest.mock('@store/walletStore', () => ({
  useWalletStore: () => ({
    balance: {bravo_credits: 1000, currency: 'aed'},
    creditBatches: [{id: 'b1', amount: 1000, source: 'topup', expires_at: '2027-01-01T00:00:00Z'}],
    transactions: [],
    isLoading: false,
    loadBalance: mockLoadBalance,
    loadCreditBatches: mockLoadCreditBatches,
    loadTransactions: jest.fn(),
  }),
}));

// Silence the success/failure Alerts (RN Alert is a native no-op in jest).
jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});

const topUpAndCharge = mockTopUpAndCharge;
const loadBalance = mockLoadBalance;
const loadCreditBatches = mockLoadCreditBatches;

import CreditsScreen from '../CreditsScreen';

function gotoTopupAndFindButton(api: ReturnType<typeof render>) {
  // Switch to the Top Up tab, then return the Purchase button node.
  fireEvent.press(api.getByText('Top Up'));
  return api.getByTestId('purchase-btn');
}

describe('CreditsScreen — second topup re-arms (BS-WALLET)', () => {
  beforeEach(() => {
    topUpAndCharge.mockReset();
    loadBalance.mockReset().mockResolvedValue(undefined);
    loadCreditBatches.mockReset().mockResolvedValue(undefined);
  });

  it('re-arms the Purchase button after a successful topup so a second topup fires', async () => {
    topUpAndCharge.mockResolvedValue({charged: true, result: {}});
    const api = render(<CreditsScreen />);
    const btn = gotoTopupAndFindButton(api);

    await act(async () => { fireEvent.press(btn); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(1));

    // After success the screen jumps to the balance tab; go back to topup
    // and confirm a SECOND purchase actually fires (button re-armed).
    const btn2 = gotoTopupAndFindButton(api);
    await act(async () => { fireEvent.press(btn2); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(2));
  });

  it('re-arms even when the post-success balance refresh HANGS (the original strand)', async () => {
    topUpAndCharge.mockResolvedValue({charged: true, result: {}});
    // A never-resolving refresh models the real strand: under the old code
    // the `finally` that re-armed the button sat behind this await, so a
    // hung loadBalance left `purchasing` true forever. The fix re-arms
    // BEFORE this await, so the second topup must still fire.
    loadBalance.mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));
    loadCreditBatches.mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));
    const api = render(<CreditsScreen />);
    const btn = gotoTopupAndFindButton(api);

    await act(async () => { fireEvent.press(btn); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(1));

    // Despite the refresh hanging, the button must have re-armed. Note the
    // success-tab jump only happens AFTER the (hung) refresh, so on this
    // strand path the screen stays on the topup tab — the same button node
    // must accept a second press.
    const btn2 = api.getByTestId('purchase-btn');
    await act(async () => { fireEvent.press(btn2); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(2));
  });

  it('re-arms after a failed topup attempt (error path)', async () => {
    topUpAndCharge.mockRejectedValueOnce(new Error('charge failed'))
                  .mockResolvedValueOnce({charged: true, result: {}});
    const api = render(<CreditsScreen />);
    const btn = gotoTopupAndFindButton(api);

    await act(async () => { fireEvent.press(btn); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(1));

    // Error path stays on the topup tab; the same button must re-arm and
    // accept a retry.
    const btn2 = api.getByTestId('purchase-btn');
    await act(async () => { fireEvent.press(btn2); });
    await waitFor(() => expect(topUpAndCharge).toHaveBeenCalledTimes(2));
  });
});
