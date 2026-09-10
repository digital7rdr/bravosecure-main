/**
 * Regression for Issues 18 + 19 (Testing Issues V2, pp.23–24).
 *
 * B-247+ contract: these were RED before `departmentalEntry.ts` existed. The
 * decisive one is "the Agent shell" — GroupsScreen is registered in BOTH
 * MessengerNavigator and AgentNavigator, but only Messenger registers
 * `DepartmentChannels`, so the old `navigation.navigate('DepartmentChannels')`
 * resolved to nothing and was dropped. A dropped navigate is silent in a
 * release build, which is precisely what "the card does not open" looks like.
 *
 * The fakes below mirror the REAL registrations (verified against
 * src/navigation/*.tsx) — if a navigator's route list changes, the
 * `pins the real navigator registrations` block fails and these shells must be
 * re-derived rather than quietly drifting out of sync with the app.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));

const mockDispatch = jest.fn();
let mockRootState: unknown;

/**
 * Stub the REF, keep `../navigationRef` REAL.
 *
 * The first version of this mock re-implemented `mountedTreeHasRoute` inside
 * the factory. That is the repo's duplicate-copy bug class aimed at its own
 * regression test: deleting the sibling recursion from the real function left
 * THIS file 100% green — including the R7-1 sibling case that names it as the
 * subject — while `mountedTreeSearch.test.ts` went red. A test that re-writes
 * the code it is guarding cannot see that code regress.
 *
 * `jest.requireActual('../navigationRef')` would not help: the real
 * `mountedTreeHasRoute` closes over the real module-level ref, which is never
 * ready under node. So the seam has to be one level lower — the ref factory.
 * `requireActual` on the rest of @react-navigation/native because
 * departmentalEntry needs the real `CommonActions`.
 */
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  createNavigationContainerRef: () => ({
    isReady: () => true,
    // A WRAPPER, not `mockDispatch` directly: the factory is hoisted above the
    // const initialiser, so a direct reference captures undefined and the call
    // throws "dispatch is not a function".
    dispatch: (...a: unknown[]) => mockDispatch(...a),
    getRootState: () => mockRootState,
  }),
}));

import {Alert} from '@utils/alert';
import {
  findNavigatorWithRoute,
  isInDepartmentalShell,
  openAttendance,
  openEmployees,
  openDepartmentChannels,
  openJoinFlowScreen,
  type RouteAwareNavigation,
} from '../departmentalEntry';

interface FakeNav {
  navigate: jest.Mock;
  getParent: () => FakeNav | undefined;
  getState: () => {routeNames: string[]};
}

/** Build a navigator chain, innermost first. Each level gets its own
 *  navigate() mock so a test can assert WHICH navigator handled the action. */
function chain(...levels: string[][]): FakeNav[] {
  const navs: FakeNav[] = levels.map(routeNames => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({routeNames}),
  }));
  navs.forEach((n, i) => { n.getParent = () => navs[i + 1]; });
  return navs;
}

// The three shells MainNavigator can render. Exactly one is mounted at a time.
const messengerShell = () => chain(
  ['MessengerHome', 'Chat', 'Groups', 'DepartmentChannels', 'Departmental'],
);
const agentShell = () => chain(
  ['AgentHome', 'Groups', 'MessengerHome', 'Departmental'],
);
const departmentalShell = () => chain(
  ['DepartmentChannels', 'DepartmentChat', 'ManageChannels'],   // ChannelsStack
  ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],          // the 5-tab shell
);
const bareShell = () => chain(['Home', 'Settings']);

beforeEach(() => {
  (Alert.alert as jest.Mock).mockClear();
  mockDispatch.mockClear();
  mockRootState = undefined;
});

/**
 * R7-1 — the join/approval screens, and the SIBLING case an ancestor walk
 * cannot reach.
 *
 * `Approvals` / `JoinWorkspace` / `ApprovalStatus` were registered only in
 * MessengerNavigator, while every approver persona (agency owner AND promoted
 * org manager) is routed into the Agent shell, and the APPLICANT is a client
 * account whose ActivityCenter is BookingNavigator's — under SecureTab, with
 * the three routes under the sibling MessengerTab. Walking up from either found
 * nothing, and each call site dropped the tap with a bare no-else `if (host)`.
 */
describe('openJoinFlowScreen — R6-2 / R7-1', () => {
  /** The client tab shell: SecureTab and MessengerTab are SIBLINGS. */
  const clientRootState = {
    routeNames: ['Auth', 'Main'],
    routes: [{state: {
      routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
      routes: [
        {state: {routeNames: ['MessengerHome', 'Approvals', 'JoinWorkspace', 'ApprovalStatus']}},
        {state: {routeNames: ['Home', 'Pricing', 'ActivityCenter']}},
      ],
    }}],
  };

  it('MESSENGER shell (no workspace): opens the screen directly', () => {
    const [nav] = chain(['DepartmentChannels', 'Approvals', 'JoinWorkspace', 'ApprovalStatus']);
    expect(openJoinFlowScreen(nav, 'Approvals')).toEqual({ok: true, via: 'direct'});
    expect(nav.navigate).toHaveBeenCalledWith('Approvals');
  });

  it('HOME TAB of the departmental shell: hops the sibling Channels stack', () => {
    // The routes live on the Channels stack — a SIBLING of the Home tab, which
    // findNavigatorWithRoute cannot see because it walks UP only. Before the
    // resolver this always fell through to "not available here yet", for every
    // admin, on the screen that shows their own pending badge.
    const navs = chain(
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],
      ['AgentDashboard', 'Departmental'],
    );
    expect(openJoinFlowScreen(navs[0], 'Approvals')).toEqual({ok: true, via: 'tab'});
    // `initial: false` is part of the contract, not decoration — without it the
    // lazy Channels stack ROOTS at Approvals with no history (R9-2).
    expect(navs[0].navigate).toHaveBeenCalledWith('Channels', {screen: 'Approvals', initial: false});
  });

  it('AGENT shell, outside the workspace: enters the shell focused on the screen', () => {
    const [nav] = chain(['AgentHome', 'ActivityCenter', 'Departmental']);
    expect(openJoinFlowScreen(nav, 'Approvals')).toEqual({ok: true, via: 'shell'});
    expect(nav.navigate).toHaveBeenCalledWith(
      'Departmental', {screen: 'Channels', params: {screen: 'Approvals', initial: false}});
  });

  /**
   * THE R7-1 BUG. The applicant taps "your request was approved" in the client
   * shell's ActivityCenter. Every ancestor of BookingNavigator lacks all four
   * candidate routes — the targets are in the sibling MessengerTab — so the
   * loop's own closing notification alerted "not available here".
   */
  it('CLIENT shell: reaches the routes in the SIBLING MessengerTab', () => {
    mockRootState = clientRootState;
    const [nav] = chain(['Home', 'Pricing', 'ActivityCenter'], ['MessengerTab', 'SecureTab', 'ProfileTab']);
    expect(openJoinFlowScreen(nav, 'ApprovalStatus')).toEqual({ok: true, via: 'sibling'});
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
    // INSPECT THE PAYLOAD, not just the call count. Asserting only
    // `toHaveBeenCalledTimes(1)` left this branch — the one that carries the
    // R7-1 bug — free to dispatch to the wrong screen, or to drop
    // `initial: false` and re-root MessengerNavigator at the target. Both
    // mutations survived every behavioural test in the suite.
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {screen: 'MessengerTab', params: {screen: 'ApprovalStatus', initial: false}},
    });
  });

  it('a tree with NO door anywhere reports it, instead of a dead tap', () => {
    mockRootState = {routeNames: ['Auth'], routes: []};
    const [nav] = bareShell();
    expect(openJoinFlowScreen(nav, 'JoinWorkspace')).toEqual({ok: false, via: 'none'});
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  /**
   * ORDER, not just presence. If `shell` were tried before `tab`, a user
   * already inside the workspace would RE-ENTER a mounted shell — which stacks
   * a second identical copy and reads as a dead tap, the exact failure Issue 19
   * documents. Presence assertions cannot see this; only order can.
   */
  it('prefers the TAB hop over re-entering a shell it is already inside', () => {
    const navs = chain(
      ['Home', 'Channels', 'Attend'],
      ['AgentDashboard', 'Departmental'],
    );
    openJoinFlowScreen(navs[0], 'Approvals');
    // `initial: false` is part of the contract, not decoration — without it the
    // lazy Channels stack ROOTS at Approvals with no history (R9-2).
    expect(navs[0].navigate).toHaveBeenCalledWith('Channels', {screen: 'Approvals', initial: false});
    expect(navs[1].navigate).not.toHaveBeenCalled();
  });

  /**
   * R8-5. Inside the workspace the TAB hop outranks even a direct hit, because
   * the direct one can be on a navigator OUTSIDE the shell: in a departmental
   * shell hosted by MessengerNavigator, the walk from the Home tab finds
   * `Approvals` on MessengerNavigator and pushes it full-screen OVER the
   * workspace, losing the tab bar. Staying on the Channels tab is what this
   * resolver's own contract promises.
   */
  it('inside the shell, the tab hop outranks a direct hit on an OUTER navigator', () => {
    const navs = chain(
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],       // the tab shell
      ['MessengerHome', 'Approvals', 'DepartmentChannels'],      // MessengerNavigator
    );
    expect(openJoinFlowScreen(navs[0], 'Approvals')).toEqual({ok: true, via: 'tab'});
    // `initial: false` is part of the contract, not decoration — without it the
    // lazy Channels stack ROOTS at Approvals with no history (R9-2).
    expect(navs[0].navigate).toHaveBeenCalledWith('Channels', {screen: 'Approvals', initial: false});
    expect(navs[1].navigate).not.toHaveBeenCalled();
  });

  it('OUTSIDE the shell, a direct registration still wins', () => {
    // No `Attend` anywhere: not the workspace, so there is no tab to preserve.
    const navs = chain(
      ['DepartmentChannels', 'Approvals'],
      ['MessengerHome', 'Departmental'],
    );
    expect(openJoinFlowScreen(navs[0], 'Approvals').via).toBe('direct');
    expect(navs[1].navigate).not.toHaveBeenCalled();
  });

  it('routes each of the three screens, not just the admin one', () => {
    for (const r of ['Approvals', 'JoinWorkspace', 'ApprovalStatus'] as const) {
      const [nav] = chain(['DepartmentChannels', 'Approvals', 'JoinWorkspace', 'ApprovalStatus']);
      expect(openJoinFlowScreen(nav, r)).toEqual({ok: true, via: 'direct'});
      expect(nav.navigate).toHaveBeenCalledWith(r);
    }
  });
});

describe('findNavigatorWithRoute', () => {
  it('finds a route on the screen’s OWN navigator', () => {
    const [nav] = messengerShell();
    expect(findNavigatorWithRoute(nav, 'DepartmentChannels')).toBe(nav);
  });

  it('finds a route on an ANCESTOR, not just the immediate parent', () => {
    // The single-level getParent() probe this replaces could not see past one
    // level — the Issue 19 hypothesis.
    const navs = departmentalShell();
    expect(findNavigatorWithRoute(navs[0], 'Attend')).toBe(navs[1]);
  });

  it('returns null when NO navigator in the mounted tree has the route', () => {
    const [nav] = agentShell();
    expect(findNavigatorWithRoute(nav, 'DepartmentChannels')).toBeNull();
  });

  it('survives a navigator that exposes no getState/getParent', () => {
    const nav = {navigate: jest.fn()};
    expect(findNavigatorWithRoute(nav, 'Anything')).toBeNull();
  });

  it('terminates on a cyclic parent chain instead of hanging', () => {
    const self: RouteAwareNavigation = {
      navigate: jest.fn(),
      getParent: () => self,
      getState: () => ({routeNames: ['Nope']}),
    };
    expect(findNavigatorWithRoute(self, 'Missing')).toBeNull();
  });
});

describe('Issue 18 — openDepartmentChannels', () => {
  it('MESSENGER shell: opens the standalone screen directly', () => {
    const [nav] = messengerShell();
    expect(openDepartmentChannels(nav)).toEqual({ok: true, via: 'direct'});
    expect(nav.navigate).toHaveBeenCalledWith('DepartmentChannels');
  });

  // THE BUG. Before the fix this navigate resolved to nothing and was dropped.
  it('AGENT shell: falls back to the Departmental workspace on its Channels tab', () => {
    const [nav] = agentShell();
    expect(openDepartmentChannels(nav)).toEqual({ok: true, via: 'shell'});
    // Names the DIRECTORY, not just the tab (R11-6): a bare tab switch lands on
    // whatever the Channels stack was last left on — the chat thread, if the
    // user had opened a channel — instead of the directory this control
    // advertises. `initial: false` keeps a cold stack rooted correctly.
    expect(nav.navigate).toHaveBeenCalledWith('Departmental', {
      screen: 'Channels',
      params: {screen: 'DepartmentChannels', initial: false},
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('never navigates to a route the mounted tree does not have', () => {
    const [nav] = agentShell();
    openDepartmentChannels(nav);
    expect(nav.navigate).not.toHaveBeenCalledWith('DepartmentChannels');
  });

  it('a shell with neither route reports it, instead of a dead tap', () => {
    // Explicitly a MessengerTab-less tree, so this keeps exercising the Alert
    // arm even though the sibling branch exists.
    mockRootState = {routeNames: ['Auth'], routes: []};
    const [nav] = bareShell();
    expect(openDepartmentChannels(nav)).toEqual({ok: false, via: 'none'});
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  /**
   * THE FOUNDER-REPORTED BUG (2026-08-07). The profile drawer mounts on the
   * Secure/Booking and VBG tabs, whose ancestor chain has no workspace route —
   * the door is under the SIBLING MessengerTab. Before this branch the tap
   * alerted "sign in with your organisation account" at an Enterprise
   * subscriber, and (because hasDeptChannels was true) offered no path onward.
   */
  it('CLIENT shell (Secure/VBG tab): reaches the workspace via the SIBLING MessengerTab', () => {
    mockRootState = {
      routeNames: ['Auth', 'Main'],
      routes: [{state: {
        routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
        routes: [{state: {routeNames: ['MessengerHome', 'DepartmentChannels', 'Departmental']}}],
      }}],
    };
    const [nav] = chain(['Home', 'BookingHistory', 'ActivityCenter'], ['MessengerTab', 'SecureTab', 'ProfileTab']);
    expect(openDepartmentChannels(nav)).toEqual({ok: true, via: 'sibling'});
    expect(Alert.alert).not.toHaveBeenCalled();
    // INSPECT THE PAYLOAD (the R7-1 lesson): a count-only assertion lets the
    // dispatch target the wrong screen or drop `initial: false` — which would
    // re-root MessengerNavigator at the target with no history.
    //
    // The target is the STANDALONE directory, parity with the `direct` branch —
    // NOT the Departmental workspace shell. The directory owns the
    // non-entitled gate + Enterprise upsell, so a Lite/Pro user keeps the
    // same pitch they get from the Messenger tab. A mutation that re-aims
    // this at the shell walks a non-member straight into a member dashboard.
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {
        screen: 'MessengerTab',
        params: {screen: 'DepartmentChannels', initial: false},
      },
    });
    expect(JSON.stringify(action.payload)).not.toContain('Departmental');
  });

  /**
   * ORDER: the sibling hop must NOT outrank an ancestor that registers the
   * shell. An agency/CPO tree resolves via `Departmental`; dispatching through
   * a MessengerTab that happens to exist in some future mixed tree would yank
   * the user out of their shell. (The agent-shell test above cannot see this —
   * its mockRootState is undefined, so sibling-first would also pass it.)
   */
  it('prefers the ancestor shell over the sibling dispatch when both exist', () => {
    mockRootState = {
      routeNames: ['Auth', 'Main'],
      routes: [{state: {routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab']}}],
    };
    const [nav] = agentShell();
    expect(openDepartmentChannels(nav)).toEqual({ok: true, via: 'shell'});
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

/**
 * Q4 (founder, 2026-08-08) — `preferHome`: a workspace member/owner's landing
 * is the Departmental HOME dashboard, not the channel directory. The caller
 * vouches for membership (it holds the entitlements; the resolver does not),
 * which is why the sibling payload here MAY name 'Departmental' while the
 * non-preferHome payload is pinned to never contain it (the test above): that
 * pin protects NON-members from being walked into the member dashboard, and
 * preferHome is only ever passed for members.
 */
describe('Q4 — openDepartmentChannels preferHome', () => {
  it('shell mounted: names the Home TAB explicitly — a bare navigate is a no-op from a WARM shell', () => {
    const [nav] = agentShell();
    expect(openDepartmentChannels(nav, {preferHome: true})).toEqual({ok: true, via: 'shell'});
    expect(nav.navigate).toHaveBeenCalledWith('Departmental', {screen: 'Home', initial: false});
  });

  it('CLIENT shell: reaches the workspace HOME via the sibling MessengerTab', () => {
    mockRootState = {
      routeNames: ['Auth', 'Main'],
      routes: [{state: {
        routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
        routes: [{state: {routeNames: ['MessengerHome', 'DepartmentChannels', 'Departmental']}}],
      }}],
    };
    const [nav] = chain(['Home', 'BookingHistory', 'ActivityCenter'], ['MessengerTab', 'SecureTab', 'ProfileTab']);
    expect(openDepartmentChannels(nav, {preferHome: true})).toEqual({ok: true, via: 'sibling'});
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {screen: 'MessengerTab', params: {screen: 'Departmental', params: {screen: 'Home', initial: false}, initial: false}},
    });
  });

  it('no shell anywhere: falls through to the directory branches (gate intact)', () => {
    mockRootState = {routeNames: ['Auth'], routes: []};
    const [nav] = bareShell();
    expect(openDepartmentChannels(nav, {preferHome: true})).toEqual({ok: false, via: 'none'});
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('preferHome FALSE behaves exactly like the option being absent', () => {
    const [nav] = messengerShell();
    expect(openDepartmentChannels(nav, {preferHome: false})).toEqual({ok: true, via: 'direct'});
    expect(nav.navigate).toHaveBeenCalledWith('DepartmentChannels');
  });
});

/**
 * vs2 item 13 — the roster CTA added to the two roster-empty dead ends.
 *
 * Behavioural, not a source scan: a typo in any of the three route names is a
 * SILENT no-op in release, which is the entire reason this module exists. The
 * ordering matters as much as the names — see the R8-5 case below.
 */
describe('vs2 item 13 — openEmployees', () => {
  it('inside the shell it TAB-HOPS, even though an outer Employees exists', () => {
    // R8-5: MessengerNavigator ALSO registers Employees and is an ancestor of
    // the shell on the client/CPO entry paths. A direct-first walk finds that
    // outer copy and push the roster full-screen OVER the workspace, losing the
    // tab bar — and only on some entry paths, which is the nastiest shape.
    const navs = chain(
      ['ShiftManagement', 'ShiftEditor', 'DayStatus'],              // AttendStack
      ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],          // the shell
      ['MessengerHome', 'Employees', 'Departmental'],               // outer messenger
    );
    expect(openEmployees(navs[0])).toEqual({ok: true, via: 'tab'});
    expect(navs[1].navigate).toHaveBeenCalledWith('Channels', {screen: 'Employees', initial: false});
    expect(navs[2].navigate).not.toHaveBeenCalled();
  });

  it('outside the shell it takes the direct route when the host has it', () => {
    const [nav] = chain(['MessengerHome', 'Employees', 'Departmental']);
    expect(openEmployees(nav)).toEqual({ok: true, via: 'direct'});
    expect(nav.navigate).toHaveBeenCalledWith('Employees');
  });

  it('with only the shell route it enters the workspace on the roster', () => {
    const [nav] = agentShell();
    expect(openEmployees(nav)).toEqual({ok: true, via: 'shell'});
    expect(nav.navigate).toHaveBeenCalledWith('Departmental', {
      screen: 'Channels', params: {screen: 'Employees', initial: false},
    });
  });

  it('says so out loud rather than dropping the tap', () => {
    const [nav] = bareShell();
    expect(openEmployees(nav)).toEqual({ok: false, via: 'none'});
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('Issue 19 — openAttendance', () => {
  it('inside the departmental shell it switches TAB on the tab navigator', () => {
    // Re-entering an already-mounted shell stacks an identical copy, which is
    // the classic "nothing happened".
    const navs = departmentalShell();
    expect(openAttendance(navs[0])).toEqual({ok: true, via: 'tab'});
    expect(navs[1].navigate).toHaveBeenCalledWith('Attend');
    expect(navs[0].navigate).not.toHaveBeenCalled();
  });

  it('outside it, enters the shell ALREADY FOCUSED on Attend', () => {
    // The previous call passed no params and landed on the shell's default Home
    // tab — so even when it navigated, it did not open what the card promised.
    const [nav] = messengerShell();
    expect(openAttendance(nav)).toEqual({ok: true, via: 'shell'});
    expect(nav.navigate).toHaveBeenCalledWith('Departmental', {screen: 'Attend'});
  });

  it('works from the AGENT shell too — the role the PDF reports it broken on', () => {
    const [nav] = agentShell();
    expect(openAttendance(nav).ok).toBe(true);
    expect(nav.navigate).toHaveBeenCalledWith('Departmental', {screen: 'Attend'});
  });

  it('a shell with neither route reports it, instead of a dead tap', () => {
    mockRootState = {routeNames: ['Auth'], routes: []};
    const [nav] = bareShell();
    expect(openAttendance(nav)).toEqual({ok: false, via: 'none'});
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  /**
   * FORWARD-GUARD, not a live path (adversarial review, 2026-08-07): today's
   * only caller sits in navigators where `tabs` or `shell` always wins first,
   * so this branch is unreachable until a caller outside the messenger stack
   * exists (e.g. an attendance push tap). The test pins the payload SHAPE so
   * that first future caller inherits a correct branch, not a stale one —
   * do not read it as proof of a drawer→Attendance path from Secure/VBG.
   */
  it('CLIENT shell (Secure/VBG tab): enters the workspace via the SIBLING MessengerTab, focused on Attend', () => {
    mockRootState = {
      routeNames: ['Auth', 'Main'],
      routes: [{state: {
        routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab'],
        routes: [{state: {routeNames: ['MessengerHome', 'Departmental']}}],
      }}],
    };
    const [nav] = chain(['Home', 'BookingHistory'], ['MessengerTab', 'SecureTab', 'ProfileTab']);
    expect(openAttendance(nav)).toEqual({ok: true, via: 'sibling'});
    expect(Alert.alert).not.toHaveBeenCalled();
    const action = mockDispatch.mock.calls[0][0] as {payload?: unknown};
    expect(action.payload).toMatchObject({
      name: 'Main',
      params: {
        screen: 'MessengerTab',
        params: {screen: 'Departmental', initial: false, params: {screen: 'Attend'}},
      },
    });
  });

  it('prefers the ancestor shell over the sibling dispatch when both exist', () => {
    mockRootState = {
      routeNames: ['Auth', 'Main'],
      routes: [{state: {routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab']}}],
    };
    const [nav] = agentShell();
    expect(openAttendance(nav)).toEqual({ok: true, via: 'shell'});
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('isInDepartmentalShell', () => {
  it('is true inside the 5-tab workspace, false in the standalone push', () => {
    expect(isInDepartmentalShell(departmentalShell()[0])).toBe(true);
    expect(isInDepartmentalShell(messengerShell()[0])).toBe(false);
    expect(isInDepartmentalShell(agentShell()[0])).toBe(false);
  });
});

describe('pins the real navigator registrations the fakes above model', () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('AgentNavigator hosts Groups but NOT DepartmentChannels — the bug', () => {
    const agent = src('src/navigation/AgentNavigator.tsx');
    expect(agent).toMatch(/name="Groups"/);
    expect(agent).toMatch(/name="Departmental"/);
    expect(agent).not.toMatch(/name="DepartmentChannels"/);
  });

  it('MessengerNavigator hosts both, which is why it never reproduced there', () => {
    const messenger = src('src/navigation/MessengerNavigator.tsx');
    expect(messenger).toMatch(/name="Groups"/);
    expect(messenger).toMatch(/name="DepartmentChannels"/);
  });

  it('the Departmental shell really does expose Channels and Attend tabs', () => {
    const dept = src('src/navigation/DepartmentalNavigator.tsx');
    expect(dept).toMatch(/name="Channels"/);
    expect(dept).toMatch(/name="Attend"/);
  });

  /**
   * `Attend` is the SENTINEL for "am I inside the departmental shell" — used by
   * `isInDepartmentalShell` and, since R8-4, by the `useInDepartmentalShell`
   * hook that 12 deptchat screens read to decide whether to reserve
   * `insets.bottom`. That hook used to be a single-level `getParent()` probe;
   * widening it to the full ancestor walk is only safe because exactly ONE
   * navigator in the app registers this route.
   *
   * Register a second `Attend` anywhere and those 12 screens silently stop
   * reserving the safe area on a surface that has no tab bar to absorb it — a
   * dead gap or a clipped footer, with nothing else failing. So pin the
   * uniqueness, not just the presence.
   */
  it('exactly ONE navigator registers the `Attend` sentinel route', () => {
    const dir = join(process.cwd(), 'src', 'navigation');
    const hits = readdirSync(dir)
      .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
      // `name="Attend"` exactly — never `Attendance`/`AttendanceResult`, which
      // are screens INSIDE the Attend tab's own stack.
      .filter(f => /name="Attend"/.test(readFileSync(join(dir, f), 'utf8')));
    expect(hits).toEqual(['DepartmentalNavigator.tsx']);
  });

  it('neither entry screen hard-codes a navigate to a shell-specific route', () => {
    for (const rel of [
      'src/screens/messenger/GroupsScreen.tsx',
      'src/screens/messenger/DepartmentChannelsScreen.tsx',
    ]) {
      const body = src(rel)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
        .join('\n');
      expect(body).not.toMatch(/navigate\('DepartmentChannels'\)/);
      expect(body).not.toMatch(/navigate\('Departmental'\)/);
      // And the cast that switched route-name checking off stays gone.
      expect(body).not.toMatch(/navigate\([^)]*as never/);
    }
  });
});
