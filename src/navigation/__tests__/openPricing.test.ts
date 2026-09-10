/**
 * R8-6 / R6-4 — `openPricing` had no test, on a helper that six call sites use
 * and that Phase 3 turned into the ONLY in-app route to buying Enterprise from
 * the feature that advertises it.
 *
 * The bug it now guards: `Pricing` is registered in BookingNavigator alone,
 * reached through `SecureTab`, which exists only in the client tab shell.
 * MainNavigator renders exactly ONE of CpoNavigator / AgentNavigator / that
 * shell — so in the Agent and CPO shells the dispatch named a route the mounted
 * tree does not have, the nested payload went unhandled, and the button was
 * silently dead. Phase 3 made that worse by replacing a working upgrade DIALOG
 * with a redirect to a gate whose upgrade button was that dead button.
 */
const mockDispatch = jest.fn();
const mockGetRootState = jest.fn();
let mockReady = true;

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  createNavigationContainerRef: () => ({
    isReady: () => mockReady,
    getRootState: () => mockGetRootState(),
    dispatch: (...a: unknown[]) => mockDispatch(...a),
  }),
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));

import {Alert} from '@utils/alert';
import {openPricing} from '../openPricing';

/** The client tab shell — SecureTab registered on the tab navigator itself. */
const clientShell = {
  routeNames: ['Auth', 'Main'],
  routes: [{}, {state: {routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab']}}],
};
/** The agency shell — MainNavigator returns AgentNavigator INSTEAD of the tabs. */
const agentShell = {
  routeNames: ['Auth', 'Main'],
  routes: [{}, {state: {routeNames: ['AgentDashboard', 'Departmental']}}],
};

beforeEach(() => {
  mockReady = true;
  mockDispatch.mockClear();
  mockGetRootState.mockReset();
  (Alert.alert as jest.Mock).mockClear();
});

describe('openPricing', () => {
  it('CLIENT shell: dispatches Main → SecureTab → Pricing', () => {
    mockGetRootState.mockReturnValue(clientShell);
    expect(openPricing()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
    // The payload shape is the contract — a wrong nesting is silently dropped.
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    // `initial: false` is part of the payload contract, not decoration: without
    // it the lazy BookingNavigator ROOTS at Pricing (R10-1). Pinning the
    // payload without the flag pins the defect as the contract.
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {screen: 'SecureTab', params: {screen: 'Pricing', initial: false}},
    });
  });

  it('AGENT shell: says so instead of dispatching into nothing', () => {
    mockGetRootState.mockReturnValue(agentShell);
    expect(openPricing()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('before the container is ready it is a no-op, not a throw or an alert', () => {
    mockReady = false;
    expect(openPricing()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    // No alert here on purpose: "not mounted yet" is a race, not a user-facing
    // fact, and alerting on it would fire during boot.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
