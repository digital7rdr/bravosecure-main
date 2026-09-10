/**
 * Scope v2 Phase 3 — "can the applicant actually SEE the way in, and does
 * pressing it DO anything?"
 *
 * This is a RENDER test on purpose, and it exists because a source scan failed
 * to see the same defect three times running:
 *
 *  - R5-1: both entry CTAs rendered inside `if (!entitled)`, while the only
 *    screen that navigates here (GroupsScreen) navigated only when
 *    `hasDeptChannels` was TRUE. Arriving required true, rendering required
 *    false. A scan for the helper name passed the whole time.
 *  - R6-1: the entitled-branch CTA was then placed inside the
 *    `channels.length > 0` list branch. A tier-only Enterprise individual holds
 *    no membership rows, so they land in the EMPTY branch — permanently.
 *  - R7 (found against the first version of THIS file): hiding the CTA behind
 *    `!inDepartmentalShell` left 26/26 green, because the test mounted ONE
 *    fixed navigator shape in which `isInDepartmentalShell` was always false.
 *    A reachability test that pins a single topology is not a reachability
 *    test — every Agent/CPO-shell user reaches this screen through the
 *    departmental shell, which is exactly the host R6-2 was about.
 *
 * So: every persona case runs under BOTH topologies, and the CTA is pressed,
 * because visibility is not function.
 */
import React from 'react';
import {render, waitFor, fireEvent} from '@testing-library/react-native';

const mockNavigate = jest.fn();
const mockEntitlements = jest.fn();
const mockListChannels = jest.fn();
const mockMyJoinRequest = jest.fn();
const mockOpenJoinFlow = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

/**
 * The navigator chain the screen is mounted in, innermost first. Swapped per
 * case — this is the whole point of the file. `isInDepartmentalShell` looks for
 * an `Attend` route anywhere up the chain, so the two shapes below are not
 * cosmetic: they select genuinely different render paths.
 */
let CHAIN: string[][] = [[]];

const MESSENGER_SHELL: string[][] = [
  ['DepartmentChannels', 'DepartmentChat', 'JoinWorkspace', 'ApprovalStatus', 'Approvals'],
  ['Main'],
];
const DEPARTMENTAL_SHELL: string[][] = [
  ['DepartmentChannels', 'DepartmentChat', 'JoinWorkspace', 'ApprovalStatus', 'Approvals'],
  ['Home', 'Channels', 'Attend', 'Incident', 'Vault'],
  ['AgentDashboard', 'Departmental'],
];
const TOPOLOGIES: Array<[string, string[][]]> = [
  ['messenger shell', MESSENGER_SHELL],
  ['departmental shell (Agent/CPO)', DEPARTMENTAL_SHELL],
];

function mockNavAt(i: number): {
  navigate: jest.Mock;
  goBack: jest.Mock;
  canGoBack: () => boolean;
  getState: () => {routeNames: string[]};
  getParent: () => unknown;
} | undefined {
  if (i >= CHAIN.length) {return undefined;}
  return {
    navigate: mockNavigate,
    // item 07 — the Channels header gates its chevron on canGoBack() now that
    // this screen is also a visible tab ROOT (nothing to pop there). A mock
    // without it models no real navigation object.
    goBack: jest.fn(),
    canGoBack: () => true,
    getState: () => ({routeNames: CHAIN[i]}),
    getParent: () => mockNavAt(i + 1),
  };
}

jest.mock('@react-navigation/native', () => ({
  // Spread the real module: navigationRef needs createNavigationContainerRef,
  // and replacing the whole module wholesale takes it away.
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => mockNavAt(0),
  // The shared channel opener gates its async navigate on FOCUS.
  useIsFocused: () => true,
  // Run the focus callback once, synchronously, like a real focus would.
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
// Real resolver logic everywhere EXCEPT the one call we want to observe: the
// CTA must be proven to invoke it, with the right route, on press.
jest.mock('@navigation/departmentalEntry', () => ({
  ...jest.requireActual('@navigation/departmentalEntry'),
  openJoinFlowScreen: (...a: unknown[]) => mockOpenJoinFlow(...a),
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('@store/entitlements', () => ({useEntitlements: () => mockEntitlements()}));
jest.mock('@store/authStore', () => ({useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {id: 'u1', is_org_manager: false}})}));
jest.mock('@services/api', () => ({
  departmentApi: {listChannels: () => mockListChannels()},
  enterpriseApi: {myJoinRequest: () => mockMyJoinRequest()},
  // Q5 — the distinct-admin chip fetch; a member's 403 keeps the fallback,
  // and this suite's personas are exactly that lane.
  orgApi: {
    // vs2 item 17b — every surface that advertises a module now asks
    // which ones this workspace hides. Rejecting is the fail-open path.
    workspaceSettings: jest.fn().mockRejectedValue(new Error('none')),listCpos: jest.fn().mockRejectedValue(new Error('403'))},
}));
jest.mock('@/modules/messenger/orgWorkspace/provisionChannel', () => ({ensureChannelProvisioned: jest.fn()}));
jest.mock('@/modules/messenger/orgWorkspace/membershipIntents', () => ({drainMembershipIntents: jest.fn(async () => undefined)}));
// Selector-based store: the mock must APPLY the selector. Returning a bare
// object instead hands each row an object where it expects an unread count,
// which lands inside a <Text> and tears the whole list branch down.
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({conversations: {}}),
}));
jest.mock('@/modules/messenger/runtime', () => ({getMessengerRuntime: () => null}));
jest.mock('@/modules/messenger/hooks', () => ({waitForMessengerReady: jest.fn(async () => undefined)}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
const mockOpenPricing = jest.fn();
jest.mock('@navigation/openPricing', () => ({openPricing: (...a: unknown[]) => mockOpenPricing(...a)}));

import DepartmentChannelsScreen from '../DepartmentChannelsScreen';

/** The labels JoinCta can render — assert what the USER sees, not a symbol. */
const APPLY = 'I have an invite code';
const PENDING = 'View your pending request';
const DECIDED = 'View your request status';

/** Unique to the LIST branch, so a case cannot pass while the screen is still
 *  loading or has silently thrown.
 *
 *  Was "Channels" — the StatChip label — which worked only because the headers
 *  read "Department Channels" and exact matching skipped them. Client review
 *  vs2 item 17 renamed the header to "Channels", making that marker ambiguous
 *  (findByText then throws on multiple matches). "Unread" is the sibling chip:
 *  same branch, same guarantee, and no header uses the word. */
const LIST_MARKER = 'Unread';

interface Persona {
  hasDeptChannels: boolean;
  isOrgAffiliated: boolean;
}

/**
 * Both API mocks return the REAL axios envelope — `{data: {...}}` — because the
 * screen destructures `const {data} = await ...` and then reads `data.channels`
 * / `data.request`. A flatter invented payload makes `data` undefined, the read
 * throws inside the screen's own try/catch, and the channel list silently stays
 * empty: the "channels present" cases would then be testing the EMPTY branch
 * while appearing to pass. That is the trap this repo has hit before.
 */
function mount(p: Persona, channels: unknown[], request: unknown) {
  mockEntitlements.mockReturnValue({...p, tier: p.hasDeptChannels ? 'enterprise' : 'pro'});
  mockListChannels.mockResolvedValue({data: {channels}});
  mockMyJoinRequest.mockResolvedValue({data: {request}});
  return render(<DepartmentChannelsScreen />);
}

const CHANNEL = {
  id: 'c1', name: 'general', channel_type: 'department',
  level: 1, parent_id: null, post_mode: 'all_members',
  unread_count: 0, is_admin: false,
  status: 'active', member_count: 3, department: null, team: null,
};

beforeEach(() => { CHAIN = MESSENGER_SHELL; });
afterEach(() => { jest.clearAllMocks(); });

describe.each(TOPOLOGIES)('mounted in the %s', (_name, chain) => {
  beforeEach(() => { CHAIN = chain; });

  /**
   * THE R5-1 CASE. Not entitled at all — the plain client holding a printed
   * induction code. They land on the gate branch.
   */
  it('NOT entitled, no org → the gate offers the invite-code door', async () => {
    const {findByLabelText} = mount({hasDeptChannels: false, isOrgAffiliated: false}, [], null);
    expect(await findByLabelText(APPLY)).toBeTruthy();
  });

  /**
   * THE R6-1 CASE, and the persona this whole phase exists for. Buying the
   * Enterprise tier sets `hasDeptChannels` true with no membership row, so they
   * pass the entitled gate and then have ZERO channels, forever.
   */
  it('ENTITLED by tier but no org and NO CHANNELS → still offered the door', async () => {
    const {findByLabelText} = mount({hasDeptChannels: true, isOrgAffiliated: false}, [], null);
    expect(await findByLabelText(APPLY)).toBeTruthy();
  });

  it('ENTITLED by tier, no org, and channels present → still offered the door', async () => {
    const {findByLabelText, findByText} = mount({hasDeptChannels: true, isOrgAffiliated: false}, [CHANNEL], null);
    expect(await findByLabelText(APPLY)).toBeTruthy();
    expect(await findByText(LIST_MARKER)).toBeTruthy();
  });

  /**
   * Recoverability (M11A): a pending applicant who backgrounded the app must be
   * able to find their own status again from STATE, without a notification.
   */
  it('a PENDING applicant sees the way back to their status, empty AND listed', async () => {
    const pending = {status: 'pending'};
    const empty = mount({hasDeptChannels: true, isOrgAffiliated: false}, [], pending);
    expect(await empty.findByLabelText(PENDING)).toBeTruthy();

    jest.clearAllMocks();
    const listed = mount({hasDeptChannels: true, isOrgAffiliated: false}, [CHANNEL], pending);
    expect(await listed.findByLabelText(PENDING)).toBeTruthy();
    expect(await listed.findByText(LIST_MARKER)).toBeTruthy();
  });

  /** A DECLINED applicant must still be able to read the outcome. */
  it('a DECLINED applicant can still open their result', async () => {
    const {findByLabelText} = mount({hasDeptChannels: false, isOrgAffiliated: false}, [], {status: 'declined'});
    expect(await findByLabelText(DECIDED)).toBeTruthy();
  });

  /**
   * R7-2 — `myJoinRequest` returns the latest request whatever its status, so
   * it answers 'approved' forever. An approved member is in the org and has
   * nothing outstanding: offering them a "request status" button in perpetuity
   * is clutter on the surface they use every day.
   */
  it('an org member is offered NOTHING — no request, and an old APPROVED one', async () => {
    for (const request of [null, {status: 'approved'}]) {
      jest.clearAllMocks();
      const {queryByLabelText, findByText} = mount(
        {hasDeptChannels: true, isOrgAffiliated: true}, [CHANNEL], request);
      // Positive anchor FIRST: two queryBy→null assertions cannot tell
      // "correctly renders nothing" from "has not rendered yet".
      expect(await findByText(LIST_MARKER)).toBeTruthy();
      expect(queryByLabelText(APPLY)).toBeNull();
      expect(queryByLabelText(PENDING)).toBeNull();
      expect(queryByLabelText(DECIDED)).toBeNull();
    }
  });

  /**
   * The applicant's own status must be fetched for the people who need it —
   * behind the entitled guard it could never populate for a non-entitled user,
   * which is what made the gate CTA unable to route to M11A.
   */
  it('fetches the applicant status in BOTH the gate and the entitled state', async () => {
    mount({hasDeptChannels: false, isOrgAffiliated: false}, [], null);
    await waitFor(() => expect(mockMyJoinRequest).toHaveBeenCalled());

    jest.clearAllMocks();
    mount({hasDeptChannels: true, isOrgAffiliated: false}, [CHANNEL], null);
    await waitFor(() => expect(mockMyJoinRequest).toHaveBeenCalled());
  });

  /**
   * Visibility is not function. A CTA that renders but resolves nothing is the
   * dead tap (R6-3) wearing the costume of a fix, and no scan can tell them
   * apart. Press it and assert the resolver ran with the right destination.
   */
  /**
   * EVERY rendered instance is pressed, in every branch it can appear in.
   *
   * The first version of this case mounted `hasDeptChannels: false` for both
   * presses, so it only ever exercised the GATE-branch instance. Passing
   * `navigation={undefined as never}` to the entitled-branch one then left all
   * 36 tests green while the R6-1 persona — tier-only Enterprise, no org — got
   * "Not available here" from the directory. Asserting one instance visible and
   * a different instance functional is the visibility-is-not-function trap
   * wearing the costume of a fix.
   *
   * `expect.anything()` is load-bearing here: it does NOT match undefined or
   * null, so a dropped navigation prop fails rather than passing vacuously.
   */
  const BRANCHES: Array<[string, Persona, unknown[]]> = [
    ['gate', {hasDeptChannels: false, isOrgAffiliated: false}, []],
    ['entitled, empty', {hasDeptChannels: true, isOrgAffiliated: false}, []],
    ['entitled, listed', {hasDeptChannels: true, isOrgAffiliated: false}, [CHANNEL]],
  ];

  it.each(BRANCHES)('PRESSING the CTA in the %s branch reaches M5 through the resolver', async (_b, persona, channels) => {
    const {findByLabelText} = mount(persona, channels, null);
    fireEvent.press(await findByLabelText(APPLY));
    expect(mockOpenJoinFlow).toHaveBeenCalledWith(expect.anything(), 'JoinWorkspace');
  });

  it.each(BRANCHES)('PRESSING a PENDING CTA in the %s branch reaches M11A', async (_b, persona, channels) => {
    const {findByLabelText} = mount(persona, channels, {status: 'pending'});
    fireEvent.press(await findByLabelText(PENDING));
    expect(mockOpenJoinFlow).toHaveBeenCalledWith(expect.anything(), 'ApprovalStatus');
  });

  /**
   * A REAL transient, not a contrived cell: `/auth/me` only refreshes on
   * foreground and no more than every 30s, so straight after approval the
   * applicant is approved server-side and still reads as un-affiliated
   * locally. They must be able to open the result that tells them so.
   */
  it('APPROVED but not yet affiliated locally → can still open the result', async () => {
    const {findByLabelText} = mount(
      {hasDeptChannels: true, isOrgAffiliated: false}, [], {status: 'approved'});
    fireEvent.press(await findByLabelText(DECIDED));
    expect(mockOpenJoinFlow).toHaveBeenCalledWith(expect.anything(), 'ApprovalStatus');
  });

  it('DECLINED in the ENTITLED branch → the outcome is still reachable', async () => {
    const {findByLabelText, findByText} = mount(
      {hasDeptChannels: true, isOrgAffiliated: false}, [CHANNEL], {status: 'declined'});
    expect(await findByText(LIST_MARKER)).toBeTruthy();
    fireEvent.press(await findByLabelText(DECIDED));
    expect(mockOpenJoinFlow).toHaveBeenCalledWith(expect.anything(), 'ApprovalStatus');
  });

  /**
   * R9-1 — the gate's OTHER control. Phase 3 rerouted GroupsScreen's locked
   * card here INSTEAD of raising the upgrade dialog, so this button is now the
   * only in-app route to buying Enterprise from the feature that advertises it.
   * Gating it on `isOrgAffiliated` (false for every persona that reaches the
   * gate) hid it from everyone and left all 62 tests green — R6-1 one level
   * down, on the sibling control. The scan could not see it: the token
   * `onPress={openPricing}` was still at the decision site, just in a branch
   * nobody enters.
   */
  it('the GATE also offers the purchase path, and pressing it opens Pricing', async () => {
    const {findByLabelText} = mount({hasDeptChannels: false, isOrgAffiliated: false}, [], null);
    fireEvent.press(await findByLabelText('View Enterprise plans'));
    expect(mockOpenPricing).toHaveBeenCalled();
  });

  /**
   * R9-4 — org-affiliated AND pending, which is reachable rather than exotic:
   * `submitJoinRequest` only refuses an applicant holding an ACTIVE membership
   * in the TARGET org, so an agency owner (always org-affiliated) or a member
   * of org A can sit pending against org B. The R7-2 correction —
   * `joinStatus !== 'pending'` rather than a bare `isOrgAffiliated` — is what
   * keeps their own pending request reachable, and nothing pinned it.
   */
  it('org-affiliated but PENDING against another org → still sees their request', async () => {
    const {findByLabelText} = mount(
      {hasDeptChannels: true, isOrgAffiliated: true}, [CHANNEL], {status: 'pending'});
    fireEvent.press(await findByLabelText(PENDING));
    expect(mockOpenJoinFlow).toHaveBeenCalledWith(expect.anything(), 'ApprovalStatus');
  });

  /**
   * R8-3 — the join-status endpoint must not be able to take the whole screen
   * down. `load()` fetches it BEFORE the entitled guard and before
   * `listChannels`, so an unguarded rejection would leave every member of every
   * org on "Loading channels…" forever, from an endpoint that has nothing to do
   * with channels.
   */
  it('a REJECTING join-status endpoint still renders the channel list', async () => {
    mockEntitlements.mockReturnValue({hasDeptChannels: true, isOrgAffiliated: true, tier: 'enterprise'});
    mockListChannels.mockResolvedValue({data: {channels: [CHANNEL]}});
    mockMyJoinRequest.mockRejectedValue(new Error('502'));
    const {findByText} = render(<DepartmentChannelsScreen />);
    expect(await findByText(LIST_MARKER)).toBeTruthy();
  });
});
