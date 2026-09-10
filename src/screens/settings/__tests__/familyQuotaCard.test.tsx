/**
 * The family MEMBER's spending card — spec §41, §42, and the §8/§9/§21 split.
 *
 * These are render tests rather than a source scan because the rules are about
 * WHICH state the member is shown, and the states differ only in copy and in
 * which single action is offered. Getting that wrong is the defect §9 names:
 * telling a member their quota is exhausted when the real problem is the root
 * account sends them to ask for credit that cannot help.
 */
import React from 'react';
import {render, screen, waitFor, fireEvent} from '@testing-library/react-native';

// `mock`-prefixed so Jest's out-of-scope guard allows the factory to close
// over them (the guard whitelists that prefix precisely for this).
const mockMembership = jest.fn();
const mockRequestCredit = jest.fn();
const mockCancelCredit = jest.fn();
const mockAlert = jest.fn();

jest.mock('@services/api', () => ({
  familyApi: {
    membership:    (...a: unknown[]) => mockMembership(...a),
    requestCredit: (...a: unknown[]) => mockRequestCredit(...a),
    cancelCredit:  (...a: unknown[]) => mockCancelCredit(...a),
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
// useFocusEffect fires the effect once on mount, which is all these tests need.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));

import {FamilyQuotaCard} from '../FamilyQuotaCard';
import type {FamilyMembership} from '@services/api';

// Typed as the real DTO, not inferred from the literal: inference would narrow
// `pendingRequest` to `null` and `remaining` to `number`, so the overrides these
// tests depend on (a pending request, an unlimited quota) would not type-check —
// and a fixture that cannot express the states under test is worse than useless.
const base: FamilyMembership = {
  holderId: 'u-holder', holderName: 'Dad', relationship: 'son', heldUntil: null,
  spendLimit: 5000, spent: 4250, remaining: 750, effectiveSpendable: 750,
  rootSuspended: false, pendingRequest: null,
};
const give = (over: Partial<FamilyMembership> = {}) =>
  mockMembership.mockResolvedValue({data: {membership: {...base, ...over}}});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCredit.mockResolvedValue({data: {}});
  mockCancelCredit.mockResolvedValue({data: {ok: true}});
});

describe('§41 — the member sees allocated, used and remaining', () => {
  it('renders all three figures from the SERVER, not from local arithmetic', async () => {
    give();
    render(<FamilyQuotaCard />);
    // The spec's own worked example: 5,000 limit / 4,250 used / 750 remaining.
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy());
    expect(screen.getByText('4,250')).toBeTruthy();
    expect(screen.getByText('750')).toBeTruthy();
    expect(screen.getByText('Limit')).toBeTruthy();
    expect(screen.getByText('Remaining')).toBeTruthy();
  });

  it('never displays the holder\'s raw balance', async () => {
    // §41 says "if appropriate"; a member is not entitled to the holder's
    // finances, so the API does not send it and the card cannot leak it.
    give({effectiveSpendable: 750});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('750')).toBeTruthy());
    expect(screen.queryByText(/Root Credit/i)).toBeNull();
  });

  it('renders NOTHING for a user who is not a family member', async () => {
    mockMembership.mockResolvedValue({data: {membership: null}});
    const {toJSON} = render(<FamilyQuotaCard />);
    await waitFor(() => expect(mockMembership).toHaveBeenCalled());
    await waitFor(() => expect(toJSON()).toBeNull());
  });
});

describe('§34 — the approaching-limit warning', () => {
  it('warns at 80% and above', async () => {
    give({spent: 4100, remaining: 900, effectiveSpendable: 900});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/approaching your spending limit/i)).toBeTruthy());
  });

  it('stays quiet below 80%', async () => {
    give({spent: 1000, remaining: 4000, effectiveSpendable: 4000});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('4,000')).toBeTruthy());
    expect(screen.queryByText(/approaching/i)).toBeNull();
  });
});

describe('§8 vs §9 vs §21 — three different refusals, three different messages', () => {
  it('§8: quota exhausted says so, and offers the request action', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/reached your spending limit/i)).toBeTruthy());
    expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy();
  });

  it('§9: quota INTACT but the root is empty — must NOT blame their limit', async () => {
    // remaining 2,000 of quota, but nothing spendable because the root is at 0.
    give({spent: 3000, remaining: 2000, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/Root Account currently has insufficient credit/i)).toBeTruthy());
    // THE regression to guard: telling them their own limit is exhausted.
    expect(screen.queryByText(/reached your spending limit/i)).toBeNull();
  });

  it('§21: a suspended root outranks both messages', async () => {
    give({spent: 0, remaining: 5000, effectiveSpendable: 0, rootSuspended: true});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/suspended/i)).toBeTruthy());
    expect(screen.queryByText(/reached your spending limit/i)).toBeNull();
    expect(screen.queryByText(/Root Account currently has insufficient/i)).toBeNull();
  });
});

describe('§42/§12 — never offer a button that creates a duplicate request', () => {
  it('shows the PENDING state instead of the request button', async () => {
    give({
      spent: 5000, remaining: 0, effectiveSpendable: 0,
      pendingRequest: {id: 'req-1', requestedCredits: 2000, createdAt: new Date().toISOString()},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/2,000 BC is pending approval/i)).toBeTruthy());
    // The duplicate-creating affordance must be gone entirely.
    expect(screen.queryByLabelText(/Request more credit/i)).toBeNull();
  });

  it('§17 — the member can cancel their own pending request', async () => {
    give({
      spent: 5000, remaining: 0, effectiveSpendable: 0,
      pendingRequest: {id: 'req-1', requestedCredits: 2000, createdAt: new Date().toISOString()},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Cancel your pending credit request/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Cancel your pending credit request/i));
    await waitFor(() => expect(mockCancelCredit).toHaveBeenCalledWith('req-1'));
  });

  it('a server CREDIT_REQUEST_PENDING refusal reconciles instead of retrying', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    mockRequestCredit.mockRejectedValue({
      response: {data: {code: 'CREDIT_REQUEST_PENDING', message: 'credit_request_pending', requestId: 'req-9'}},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), '2000');
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      'Request already pending', expect.stringContaining('awaiting approval'),
    ));
    // …and it re-reads rather than insisting: the initial load plus the reload.
    await waitFor(() => expect(mockMembership).toHaveBeenCalledTimes(2));
  });
});

describe('§30 — the amount is validated before it is sent', () => {
  it.each(['0', '-100', '', 'abc'])('refuses %p without calling the API', async text => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), text);
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith('Enter an amount', expect.any(String)));
    expect(mockRequestCredit).not.toHaveBeenCalled();
  });

  it('sends a valid amount', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), '2000');
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    await waitFor(() => expect(mockRequestCredit).toHaveBeenCalledWith(2000));
  });
});

describe('unlimited quota', () => {
  it('shows no bar and offers no request button — there is no ceiling to raise', async () => {
    give({spendLimit: null, remaining: null, spent: 900, effectiveSpendable: 9999});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/No spending limit set/i)).toBeTruthy());
    expect(screen.queryByLabelText(/Request more credit/i)).toBeNull();
  });
});
