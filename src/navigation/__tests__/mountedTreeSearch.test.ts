/**
 * R6-4 / R7-1 — the SIBLING search, which had no test at all.
 *
 * `findNavigatorWithRoute` walks the caller's ancestors. That is right for
 * "where may I go from here", but the client shell is a TAB navigator, so
 * SecureTab's routes and MessengerTab's routes are siblings — invisible to an
 * ancestor walk. Two separate dead taps came from exactly that:
 *
 *  - R6-4: `openPricing` dispatched Main → SecureTab → Pricing from the Agent
 *    and CPO shells, where SecureTab does not exist. The payload went unhandled
 *    and the upgrade button did nothing.
 *  - R7-1: the applicant's own "your request was approved" notification, tapped
 *    from the client shell's ActivityCenter (BookingNavigator, under SecureTab),
 *    could not reach the join screens registered under MessengerTab.
 *
 * The correctness of both now rests on one claim: `routeNames` is
 * REGISTRATION-complete, so a lazy tab that has never been rendered is still
 * found, and only the navigator that REGISTERS the route needs to be mounted.
 * If that were false the search would return false for a client-shell user who
 * should reach Pricing — a false negative worse than the original bug. So the
 * claim is pinned here rather than left as a comment.
 */
const mockGetRootState = jest.fn();
let mockReady = true;

jest.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    isReady: () => mockReady,
    getRootState: () => mockGetRootState(),
    dispatch: jest.fn(),
  }),
}));

import {mountedTreeHasRoute} from '../navigationRef';

/** The real client shell: root stack → Main → tab navigator → per-tab stacks.
 *  SecureTab is registered on the TAB navigator, one level above the stack that
 *  actually owns `Pricing`. */
const clientShell = {
  routeNames: ['Auth', 'Main', 'PermGate'],
  routes: [
    {},                       // Auth — never entered, no nested state
    {state: {
      routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
      routes: [
        {state: {routeNames: ['MessengerHome', 'Chat', 'JoinWorkspace', 'ApprovalStatus']}},
        // SecureTab LAZY: registered on the parent, never rendered, so it has
        // no nested state of its own. This is the case that would break a
        // search relying on the screen having mounted.
        {},
        {state: {routeNames: ['Profile']}},
      ],
    }},
  ],
};

/** The agency shell: MainNavigator returns AgentNavigator INSTEAD of the tab
 *  shell, so neither SecureTab nor MessengerTab exists anywhere. */
const agentShell = {
  routeNames: ['Auth', 'Main'],
  routes: [{}, {state: {routeNames: ['AgentDashboard', 'Departmental', 'ActivityCenter']}}],
};

beforeEach(() => { mockReady = true; mockGetRootState.mockReset(); });

describe('mountedTreeHasRoute', () => {
  it('finds a route registered on an ancestor tab navigator, unrendered', () => {
    mockGetRootState.mockReturnValue(clientShell);
    // THE false-negative guard: SecureTab's own subtree is absent above, and it
    // must still be found — via the tab navigator's routeNames.
    expect(mountedTreeHasRoute('SecureTab')).toBe(true);
  });

  it('finds a route in a SIBLING branch, which an ancestor walk cannot', () => {
    mockGetRootState.mockReturnValue(clientShell);
    expect(mountedTreeHasRoute('MessengerTab')).toBe(true);
    // And nested one level deeper still, inside that sibling's own stack.
    expect(mountedTreeHasRoute('ApprovalStatus')).toBe(true);
  });

  it('returns false when the shell genuinely does not host it', () => {
    mockGetRootState.mockReturnValue(agentShell);
    expect(mountedTreeHasRoute('SecureTab')).toBe(false);
    expect(mountedTreeHasRoute('MessengerTab')).toBe(false);
    // ...while still finding what that shell DOES register.
    expect(mountedTreeHasRoute('Departmental')).toBe(true);
  });

  it('is false before the container is ready, rather than throwing', () => {
    mockReady = false;
    expect(mountedTreeHasRoute('SecureTab')).toBe(false);
    expect(mockGetRootState).not.toHaveBeenCalled();
  });

  it('tolerates an undefined root state and empty branches', () => {
    mockGetRootState.mockReturnValue(undefined);
    expect(mountedTreeHasRoute('SecureTab')).toBe(false);
    mockGetRootState.mockReturnValue({routes: [{}, {state: {}}]});
    expect(mountedTreeHasRoute('SecureTab')).toBe(false);
  });

  it('terminates on a self-referential state instead of hanging', () => {
    const cyclic: {routeNames: string[]; routes: Array<{state?: unknown}>} =
      {routeNames: ['Nope'], routes: []};
    cyclic.routes.push({state: cyclic});
    mockGetRootState.mockReturnValue(cyclic);
    expect(mountedTreeHasRoute('Missing')).toBe(false);
  });
});
