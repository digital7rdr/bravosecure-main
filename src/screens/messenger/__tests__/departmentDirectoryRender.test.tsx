/**
 * Channels vs2 item 5 — the MEMBER directory, rendered.
 *
 * This surface had zero render coverage. Everything green about it was either
 * the pure helper (`organisationTree.test.ts`) or a source scan that never
 * looks at the render block — and round 1's blocker (`directoryBuckets` not
 * TOTAL, so rows under a case-5 row vanished) lived exactly here. A property
 * test on the helper proved the buckets accounted for every row; it could not
 * see that the screen then rendered only three of the four.
 */
import React from 'react';
import {render, fireEvent, waitFor, within} from '@testing-library/react-native';

const mockListChannels = jest.fn();
const mockSearchMessages = jest.fn();
const mockNavigate = jest.fn();
let mockFocused = true;
let mockUser: Record<string, unknown>;
let mockConversations: Record<string, {unread_count?: number}>;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), canGoBack: () => true, getParent: () => undefined, getState: () => ({routeNames: []})}),
  // The shared opener gates its async navigate on FOCUS, not mount — the
  // directory is a tab root and a tab switch never unmounts it.
  useIsFocused: () => mockFocused,
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('@store/authStore', () => ({
  // BOTH call shapes. `deptNoun` reaches for `getState()`, and it renders only
  // on the EMPTY branch — so a hook-only mock crashes exactly one test: the one
  // hunting a crash, which reads as the defect being real.
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({user: mockUser}),
    {getState: () => ({user: mockUser})}),
}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({hasDeptChannels: true, isOrgAffiliated: true, tier: 'enterprise'}),
  // `deptNoun` calls this directly, and only on the EMPTY branch.
  deriveEntitlements: () => ({isWorkspaceTenant: true}),
}));
jest.mock('@store/activeWorkspace', () => ({
  activeWorkspaceOrgParam: () => undefined,
  scopeChannelsToActiveWorkspace: (c: unknown) => c,
  useActiveWorkspace: () => null,
  contextManagerRole: () => 'admin',
}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({conversations: mockConversations, groups: {}}),
    {getState: () => ({conversations: mockConversations, groups: {}})}),
}));
// B-636 — the screen now asks the runtime to search message BODIES. The mock is
// controllable per test so the hits are real data flowing through the real
// grouping/snippet code, not a rendered fixture.
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn().mockResolvedValue({
    searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
  }),
}));
jest.mock('@/modules/messenger/hooks', () => ({waitForMessengerReady: jest.fn().mockResolvedValue(undefined)}));
jest.mock('@/modules/messenger/orgWorkspace/provisionChannel', () => ({
  ensureChannelProvisioned: jest.fn().mockResolvedValue({status: 'already', groupConversationId: 'g'}),
}));
jest.mock('@/modules/messenger/orgWorkspace/membershipIntents', () => ({
  drainMembershipIntents: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@services/api', () => ({
  departmentApi: {listChannels: () => mockListChannels(), resetGroup: jest.fn()},
  enterpriseApi: {myJoinRequest: jest.fn().mockRejectedValue(new Error('none')),
    myInvites: jest.fn().mockRejectedValue(new Error('none'))},
  orgApi: {
    // vs2 item 17b — every surface that advertises a module now asks
    // which ones this workspace hides. Rejecting is the fail-open path.
    workspaceSettings: jest.fn().mockRejectedValue(new Error('none')),listCpos: jest.fn().mockRejectedValue(new Error('none'))},
}));

import DepartmentChannelsScreen from '../DepartmentChannelsScreen';

const ch = (id: string, name: string, parent_id: string | null, over: Record<string, unknown> = {}) => ({
  id, name, parent_id, description: null, department: null,
  group_conversation_id: `g-${id}`, unread_count: 0, my_role: 'viewer',
  channel_type: 'department', access: 'standard', post_mode: 'open',
  level: parent_id ? 2 : 1, is_broadcast: false, created_by: 'someone',
  parent_hidden: false, visible_ancestor_id: null, root_id: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  mockUser = {id: 'me', owns_workspace: true};
  mockConversations = {};
  mockSearchMessages.mockResolvedValue([]);
  mockListChannels.mockResolvedValue({data: {channels: [
    ch('sasfa', 'SASFA', null, {level: 0}), ch('rsa', 'RSA', 'sasfa'),
    ch('solo', 'Solo Team', null),
    ch('bc', '#broadcast', null, {is_broadcast: true}),
    // G4 — a PARENTED one too. With only the parentless row above,
    // `nestParentedBroadcasts` is a no-op on this fixture and the member
    // call site is pinned by nothing: a reviewer deleted the call from the
    // screen and every suite stayed green.
    ch('sasfa-ann', '#announcements', 'sasfa', {is_broadcast: true, level: 1}),
    // …and a root whose ONLY child is that lateral, which is the shape the
    // collapse seed has to treat differently from SASFA (which hides RSA).
    ch('flat', 'Flat Org', null, {level: 0}),
    ch('flat-ann', '#notices', 'flat', {is_broadcast: true, level: 1}),
  ]}});
});

describe('the four buckets all reach the screen', () => {
  /**
   * UI corrections 2026-08-15 items 03 + 06 SUPERSEDE the drill-in.
   *
   * "Every hierarchy level must be collapsible/expandable… users should only
   * open the branches they need" is ONE screen with dropdowns, not a second
   * screen. So an organisation row no longer navigates anywhere, and
   * OrgChannelTree is retired. The old assertion is replaced, not deleted.
   *
   * ⚠️ WHICH CONTROL OPENS IT CHANGED ON 2026-08-19 (G1/G2). It used to be the
   * row NAME; the founder gave that press to the dropdown ("it must be when you
   * click on the whole card/button"), so an expandable level now opens from its
   * own button instead. This test kept passing through that change by accident
   * — `/^Open SASFA/` simply resolved to the new button — which is precisely
   * why the member door is asserted EXPLICITLY below rather than left to a
   * regex that happens to match two different controls.
   */
  it('an organisation OPENS ITS OWN THREAD; it no longer drills in', async () => {
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.press(await u.findByLabelText(/^Open SASFA/));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'sasfa'})));
    // The retired route must not be reachable from here any more.
    expect(mockNavigate).not.toHaveBeenCalledWith('OrgChannelTree', expect.anything());

    mockNavigate.mockClear();
    fireEvent.press(u.getByText('Solo Team'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'solo', postMode: 'open'})));
  });

  /**
   * G1/G2 (founder, 2026-08-19) on the MEMBER surface.
   *
   * The whole card now toggles a level that has children, so the level's own
   * conversation needs its own control — and department conversations are
   * hidden from every messenger list, so that button is the only route to the
   * thread. `ChannelTree`'s unit suite pins the wiring; this pins that the
   * MEMBER SCREEN actually gets it, with real channel data and a real navigate.
   */
  it('G1 (B-609) — the CHEVRON toggles the branch; the CARD opens the chat', async () => {
    /**
     * ⚠️ REVERSES the 2026-08-19 G1. Founder FB-1/B-609: the card LEFT of the
     * divider opens the chat, only the chevron expands. The member tree seeds
     * every expandable level CLOSED, so the toggle observable is RSA appearing
     * on a CHEVRON press and disappearing on a second — and a CARD press must
     * navigate, never toggle.
     */
    const u = render(<DepartmentChannelsScreen />);
    await u.findByText('SASFA');
    await waitFor(() => expect(u.queryByText('RSA')).toBeNull());
    // The chevron — right of the divider — toggles.
    fireEvent.press(u.getByTestId('channel-tree-chevron-sasfa'));
    expect(await u.findByText('RSA')).toBeTruthy();
    fireEvent.press(u.getByTestId('channel-tree-chevron-sasfa'));
    await waitFor(() => expect(u.queryByText('RSA')).toBeNull());
    // …and toggling never opened a chat.
    expect(mockNavigate).not.toHaveBeenCalled();
    // The card itself — left of the divider — opens the thread.
    fireEvent.press(u.getByTestId('channel-tree-card-sasfa', {includeHiddenElements: true}));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'sasfa'})));
  });

  it('G4 — an announcement channel is drawn INSIDE the level that owns it', async () => {
    /**
     * The member half of the founder's "announcements should be within the
     * organization itself". Without the nesting the row draws at the ROOT of
     * the screen — a global announcements list wearing a different hat — and
     * nothing on it says which organisation it reaches.
     *
     * SASFA's children are all laterals, so the seed leaves it OPEN and the
     * channel is visible without a tap; a level is only seeded collapsed when
     * it hides a sub-LEVEL.
     */
    /**
     * THE ASSERTION HAS TO DISTINGUISH NESTED FROM ROOT-LEVEL, and merely
     * finding the row does not: un-nested it is still on screen, just at the
     * root, with the same label. So the proof is COLLAPSE — a nested row is
     * hidden while its level is closed and appears when the level is opened.
     * Deleting the nesting call makes the first assertion fail immediately.
     */
    const u = render(<DepartmentChannelsScreen />);
    await u.findByText('SASFA');
    // SASFA hides a sub-LEVEL (RSA), so it starts collapsed — and if the
    // announcement really is INSIDE it, it is hidden too.
    await waitFor(() => expect(u.queryByLabelText('Open #announcements')).toBeNull());
    // B-609 — the branch opens on the CHEVRON now, not the card (which opens the
    // chat). Expand SASFA and its nested announcement appears.
    fireEvent.press(u.getByTestId('channel-tree-chevron-sasfa'));
    expect(await u.findByLabelText('Open #announcements')).toBeTruthy();
    // …and the PARENTLESS legacy row is untouched: still at the root, visible
    // the whole time.
    expect(u.getByLabelText('Open #broadcast')).toBeTruthy();
  });

  it('G4/H — a level whose only children are LATERALS is not seeded collapsed', async () => {
    /**
     * The seed used to close every level with anything under it. Nesting a
     * broadcast gives a previously CHILDLESS root a child, so it stops
     * collapsing into the `chats` bucket and becomes a real L1 — and the old
     * seed then shut it. A flat workspace's one-tap rows became a collapsed
     * card, and the root's own thread moved from the card (which now toggles)
     * to the small open button.
     *
     * The founder's reason for collapsing is overpopulation, and a branch is a
     * sub-LEVEL. RSA below IS a sub-level, so that one still starts closed.
     */
    const u = render(<DepartmentChannelsScreen />);
    await u.findByText('Flat Org');
    // Flat Org's only child is a lateral: open, no tap needed.
    expect(u.getByLabelText('Open #notices')).toBeTruthy();
    // SASFA hides a sub-LEVEL, so it still starts closed.
    await waitFor(() => expect(u.queryByText('RSA')).toBeNull());
  });

  it('G2 — and the level still has a door to its own thread', async () => {
    // The regression the open button exists for. Without it, pressing anywhere
    // on an expandable level only toggles, and its conversation is unreachable.
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open SASFA, level 1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'sasfa'})));
  });

  /**
   * ITEM 02 — "This must be removed. Broadcasts must be listed under specific
   * channels, where they were created under as a lateral channel."
   *
   * The GLOBAL section goes; the channel does NOT. It is a lateral now
   * (isLateralRow folds in is_broadcast), so it renders as a neutral card in the
   * tree instead of under a heading of its own. Both halves are asserted,
   * because deleting the section without keeping the row would be the
   * door-loss this module has shipped before.
   */
  it('item 02 — the global ANNOUNCEMENTS heading is gone, the channel is not', async () => {
    const u = render(<DepartmentChannelsScreen />);
    expect(await u.findByText('#broadcast')).toBeTruthy();
    expect(u.queryByText('ANNOUNCEMENTS')).toBeNull();
  });
});

describe('unread survives the nesting', () => {
  it('a COLLAPSED level carries its subtree\'s unread, not just its own', async () => {
    /**
     * The requirement did not go away with the drill-in — it moved.
     *
     * The old drill-in row rolled its subtree's unread up because otherwise "the
     * nested path had no unread signal at all: the header chip counted a message
     * the member could see nowhere". A COLLAPSED level hides its children in
     * exactly the same way, so it inherits exactly the same answer.
     *
     * L2+ start collapsed, so RSA (the child, 3 unread) is hidden on first
     * render and its parent SASFA must show the 3.
     */
    mockConversations = {'g-rsa': {unread_count: 3}};
    const u = render(<DepartmentChannelsScreen />);
    await u.findByText('SASFA');
    // The child is hidden…
    expect(u.queryByText('RSA')).toBeNull();
    // …and its count surfaced on the collapsed parent.
    expect(u.getByText('3')).toBeTruthy();
  });
});

/**
 * B-624 (client, 2026-08-22) — "Different organization channels must never
 * mix… the UI is perfect, just rearrangement of the threads. It must ALWAYS be
 * separate here."
 *
 * The screenshot: Service Providers + ABC Security (Jacques' org) and BAG (the
 * caller's own workspace) as siblings in ONE flat list. Both scoping belts are
 * fail-open no-ops without a workspace context, and the context store is
 * session-only — so a cold boot reaches this screen holding every org's rows.
 *
 * This is the RENDER half of the pin. `organisationTree.test.ts` proves the
 * grouping; only a mount can prove the SCREEN consumes it — the exact gap that
 * let the flat pile ship (the tree stage never read `org_id` at all).
 */
describe('organisations never mix on the directory (B-624)', () => {
  const JACQUES = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0002';
  const BAG = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';

  const twoOrgs = [
    ch('sp', 'Service Providers', null, {level: 0, org_id: JACQUES}),
    ch('abc', 'ABC Security', null, {level: 0, org_id: JACQUES}),
    ch('bag', 'BAG', null, {level: 0, org_id: BAG}),
  ];

  it('two organisations render as two SEPARATE sections, each holding its own', async () => {
    mockUser = {id: 'me', owns_workspace: true, workspaces: [
      {org_id: BAG, name: 'Bravo Assurance Group', role: 'owner'},
      {org_id: JACQUES, name: 'Jacques Protection', role: 'employee'},
    ]};
    mockListChannels.mockResolvedValue({data: {channels: twoOrgs}});
    const u = render(<DepartmentChannelsScreen />);
    const foreign = await u.findByTestId(`org-section-${JACQUES}`);
    const own = u.getByTestId(`org-section-${BAG}`);
    // Each org's channels are INSIDE its own section…
    expect(within(foreign).getByText('Service Providers')).toBeTruthy();
    expect(within(foreign).getByText('ABC Security')).toBeTruthy();
    expect(within(own).getByText('BAG')).toBeTruthy();
    // …and NOT in the other's. This is the whole complaint.
    expect(within(foreign).queryByText('BAG')).toBeNull();
    expect(within(own).queryByText('Service Providers')).toBeNull();
    expect(within(own).queryByText('ABC Security')).toBeNull();
  });

  it('each section is HEADED by the organisation that owns it', async () => {
    mockUser = {id: 'me', owns_workspace: true, workspaces: [
      {org_id: BAG, name: 'Bravo Assurance Group', role: 'owner'},
      {org_id: JACQUES, name: 'Jacques Protection', role: 'employee'},
    ]};
    mockListChannels.mockResolvedValue({data: {channels: twoOrgs}});
    const u = render(<DepartmentChannelsScreen />);
    expect(within(await u.findByTestId(`org-section-${JACQUES}`)).getByText('Jacques Protection')).toBeTruthy();
    expect(within(u.getByTestId(`org-section-${BAG}`)).getByText('Bravo Assurance Group')).toBeTruthy();
  });

  it('an org this client cannot NAME still gets an honest header, never a blank', async () => {
    // An agency-owned org is structurally absent from `user.workspaces`. An
    // unlabelled section is the flat pile wearing a hat.
    mockUser = {id: 'me', owns_workspace: true, workspaces: [
      {org_id: BAG, name: 'Bravo Assurance Group', role: 'owner'},
    ]};
    mockListChannels.mockResolvedValue({data: {channels: twoOrgs}});
    const u = render(<DepartmentChannelsScreen />);
    const foreign = await u.findByTestId(`org-section-${JACQUES}`);
    expect(within(foreign).getByText('ID 0002')).toBeTruthy();
    // …and never the raw uuid.
    expect(within(foreign).queryByText(JACQUES)).toBeNull();
  });

  it('ONE organisation adds NO new chrome — "the UI is perfect"', async () => {
    // The single-tenant case is the common one. The name IS resolvable here, so
    // a header rendered unconditionally would be found; it must not be.
    mockUser = {id: 'me', owns_workspace: true, workspaces: [
      {org_id: BAG, name: 'Bravo Assurance Group', role: 'owner'},
    ]};
    mockListChannels.mockResolvedValue({data: {channels: [
      ch('bag', 'BAG', null, {level: 0, org_id: BAG}),
      ch('ops', 'Operations', 'bag', {org_id: BAG}),
    ]}});
    const u = render(<DepartmentChannelsScreen />);
    expect(await u.findByText('BAG')).toBeTruthy();
    expect(u.queryByText('Bravo Assurance Group')).toBeNull();
    expect(u.queryAllByTestId(/^org-section-/)).toHaveLength(1);
  });

  it('an OLD SERVER (no org_id) keeps one un-headed section — fail OPEN', async () => {
    // Every row in the default fixture omits `org_id`. Dropping or splitting
    // them would empty / shred the screen against a server that predates the
    // field, which is a worse bug than the one being fixed.
    const u = render(<DepartmentChannelsScreen />);
    expect(await u.findByText('SASFA')).toBeTruthy();
    expect(u.getByText('Solo Team')).toBeTruthy();
    expect(u.queryByText('Other channels')).toBeNull();
    expect(u.queryAllByTestId(/^org-section-/)).toHaveLength(1);
  });

  it('a MIXED response loses nothing — the un-attributed rows keep a section', async () => {
    // A rolling deploy can genuinely serve both shapes at once.
    mockUser = {id: 'me', owns_workspace: true, workspaces: [
      {org_id: BAG, name: 'Bravo Assurance Group', role: 'owner'},
    ]};
    mockListChannels.mockResolvedValue({data: {channels: [
      ch('bag', 'BAG', null, {level: 0, org_id: BAG}),
      ch('legacy', 'Legacy Channel', null, {level: 0}),
    ]}});
    const u = render(<DepartmentChannelsScreen />);
    expect(within(await u.findByTestId(`org-section-${BAG}`)).getByText('BAG')).toBeTruthy();
    const orphan = u.getByTestId('org-section-none');
    expect(within(orphan).getByText('Legacy Channel')).toBeTruthy();
    expect(within(orphan).getByText('Other channels')).toBeTruthy();
  });
});

describe('a malformed response does not take the screen down', () => {
  it('a 200 with no channels array renders the empty state, not a crash', async () => {
    // A captive portal or an LB error page answers 200 with a body that has no
    // `channels`. The header total reduces over that array on every render, so
    // committing `undefined` to state was a red screen one render later.
    mockListChannels.mockResolvedValue({data: {}});
    const u = render(<DepartmentChannelsScreen />);
    await waitFor(() => expect(mockListChannels).toHaveBeenCalled());
    // Read the whole tree at once rather than querying it three times: the
    // crash this pins is one render AFTER the commit (the header total reduces
    // over the array), and a torn-down tree makes an instance query throw
    // something that reads nothing like the defect.
    const tree = JSON.stringify(u.toJSON());
    expect(tree).toContain('No channels yet');
    expect(tree).not.toContain('ANNOUNCEMENTS');
    expect(tree).not.toContain('Could not load');
  });
});

/**
 * B-625 (client, 2026-08-22) — "Can you add a search bar for channels also, to
 * find channels very quickly."
 *
 * Rendered, not scanned: the interesting behaviour is what SURVIVES the filter,
 * and a source scan cannot see a filtered list.
 */
describe('the channel search (B-625)', () => {
  it('offers the search field above the list', async () => {
    const u = render(<DepartmentChannelsScreen />);
    expect(await u.findByLabelText('Search channels')).toBeTruthy();
  });

  it('narrows to the match AND keeps its parent, so the hit is still in a tree', async () => {
    // RSA lives under SASFA. Dropping SASFA would leave RSA hanging off nothing
    // — visible in the list, reachable in no tree.
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'rsa');
    await waitFor(() => expect(u.queryByText('Solo Team')).toBeNull());
    expect(u.getByText('RSA')).toBeTruthy();
    expect(u.getByText('SASFA')).toBeTruthy();
  });

  it('is case-insensitive', async () => {
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'SOLO');
    await waitFor(() => expect(u.getByText('Solo Team')).toBeTruthy());
  });

  it('says so when nothing matches, rather than showing a blank screen', async () => {
    // B-636 widened the copy: the box now searches message bodies too, so an
    // empty state that still said "no CHANNELS match" would leave the user
    // wondering whether the chats had been searched at all.
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'zzzznope');
    await waitFor(() => expect(u.getByText(/No channels or messages match/)).toBeTruthy());
  });

  it('CLEARING the query restores the full list', async () => {
    const u = render(<DepartmentChannelsScreen />);
    const box = await u.findByLabelText('Search channels');
    fireEvent.changeText(box, 'rsa');
    await waitFor(() => expect(u.queryByText('Solo Team')).toBeNull());
    fireEvent.press(u.getByLabelText('Clear channel search'));
    await waitFor(() => expect(u.getByText('Solo Team')).toBeTruthy());
  });

  it('surfaces a match that lives inside a COLLAPSED branch', async () => {
    // The collapse seed hides SASFA's children on first paint. A search whose
    // only hit is one of them must open it — a result you cannot see is not a
    // result, and this is the commonest way a tree search feels broken.
    const u = render(<DepartmentChannelsScreen />);
    await u.findByText('SASFA');
    fireEvent.changeText(u.getByLabelText('Search channels'), 'rsa');
    await waitFor(() => expect(u.getByText('RSA')).toBeTruthy());
  });
});

/**
 * B-636 (client, 2026-08-23) — "this search option should allow you to also
 * search for conversations or words in conversations that's inside the chats."
 *
 * Rendered, not scanned. The pure decisions are pinned in
 * `channelMessageSearch.test.ts`; what only a render can show is that the screen
 * ASKS for the right scope, and that the answer reaches the list and opens the
 * right channel.
 */
describe('searching the words inside the chats (B-636)', () => {
  const hit = (id: string, conversationId: string, content: string) => ({
    id, conversation_id: conversationId, content,
    created_at: '2026-08-20T10:00:00.000Z',
  });

  it('asks the runtime for the CHANNELS ON THIS SCREEN, and nothing else', async () => {
    // The id list is the scope boundary — the reason a query typed here cannot
    // reach a 1:1 chat or another organisation's channel. If a refactor drops
    // the argument the search silently becomes global, and nothing else in the
    // suite would notice.
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    await waitFor(() => expect(mockSearchMessages).toHaveBeenCalled());
    const [term, opts] = mockSearchMessages.mock.calls[0] as [string, {conversationIds: string[]}];
    expect(term).toBe('contract');
    expect([...opts.conversationIds].sort()).toEqual(
      ['g-bc', 'g-flat', 'g-flat-ann', 'g-rsa', 'g-sasfa', 'g-sasfa-ann', 'g-solo'].sort());
  });

  it('does NOT scan bodies for a single character', async () => {
    // A one-letter query matches most messages on the device; the name filter
    // still runs, the body scan does not.
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'r');
    await waitFor(() => expect(u.getByText('RSA')).toBeTruthy());
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });

  it('renders a match from inside a chat, with the term highlighted in context', async () => {
    mockSearchMessages.mockResolvedValue([hit('m1', 'g-solo', 'please sign the contract today')]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    const row = await u.findByTestId('channel-msg-hit-m1');
    // The channel it lives in, and the matched word, both reach the row.
    expect(within(row).getByText('Solo Team')).toBeTruthy();
    expect(within(row).getByText('contract')).toBeTruthy();
    expect(within(row).getByText('please sign the ')).toBeTruthy();
  });

  it('finds a chat message even when NO channel name matches — the whole point', async () => {
    mockSearchMessages.mockResolvedValue([hit('m1', 'g-solo', 'the quarterly contract')]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    await u.findByTestId('channel-msg-hit-m1');
    // No channel is called "contract", so the tree half is empty…
    expect(u.queryByText('Solo Team', {exact: true})).toBeTruthy(); // …only as the hit's own label
    expect(u.queryByText(/No channels or messages match/)).toBeNull();
  });

  it('opens the channel the message lives in when its row is pressed', async () => {
    mockSearchMessages.mockResolvedValue([hit('m1', 'g-solo', 'the contract is signed')]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    fireEvent.press(await u.findByTestId('channel-msg-hit-m1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('DepartmentChat',
      expect.objectContaining({channelId: 'solo'})));
  });

  it('DROPS a hit whose conversation is not a channel on this screen', async () => {
    // Second belt behind the SQL allow-list: even a leaked row cannot render.
    mockSearchMessages.mockResolvedValue([
      hit('mine',    'g-solo',        'our contract'),
      hit('foreign', 'g-not-visible', 'their contract'),
    ]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    await u.findByTestId('channel-msg-hit-mine');
    expect(u.queryByTestId('channel-msg-hit-foreign')).toBeNull();
  });

  it('DROPS a hit whose body does not actually contain the term', async () => {
    // SQL LIKE is ASCII-only and locale-blind, so it can disagree with the
    // client fold. A row with nothing to highlight reads as a false positive.
    mockSearchMessages.mockResolvedValue([
      hit('good', 'g-solo', 'the contract'),
      hit('bad',  'g-solo', 'nothing relevant'),
    ]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    await u.findByTestId('channel-msg-hit-good');
    expect(u.queryByTestId('channel-msg-hit-bad')).toBeNull();
  });

  it('clearing the query takes the message results away with it', async () => {
    mockSearchMessages.mockResolvedValue([hit('m1', 'g-solo', 'the contract')]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'contract');
    await u.findByTestId('channel-msg-hit-m1');
    fireEvent.press(u.getByLabelText('Clear channel search'));
    await waitFor(() => expect(u.queryByTestId('channel-msg-hit-m1')).toBeNull());
  });

  it('shows BOTH halves at once — the named channel and the message hit', async () => {
    // "Which did you mean": a channel whose NAME matches is the stronger, cheaper
    // hit and keeps the top of the list; the bodies follow underneath.
    mockSearchMessages.mockResolvedValue([hit('m1', 'g-sasfa', 'about the RSA rollout')]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'rsa');
    const row = await u.findByTestId('channel-msg-hit-m1');
    // The message half: the hit sits under SASFA, the channel it was posted in.
    expect(within(row).getByText('SASFA')).toBeTruthy();
    // The tree half: the RSA channel itself is still listed, outside that row.
    const named = u.getAllByText('RSA').filter(n => !within(row).queryAllByText('RSA').includes(n));
    expect(named.length).toBeGreaterThan(0);
  });

  it('survives a runtime that rejects (offline cold boot) — the name half still works', async () => {
    mockSearchMessages.mockRejectedValue(new Error('runtime unavailable'));
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'rsa');
    await waitFor(() => expect(u.getByText('RSA')).toBeTruthy());
    expect(u.queryByTestId('channel-message-hits')).toBeNull();
  });

  it('does not render an empty MESSAGES block when nothing matched', async () => {
    mockSearchMessages.mockResolvedValue([]);
    const u = render(<DepartmentChannelsScreen />);
    fireEvent.changeText(await u.findByLabelText('Search channels'), 'rsa');
    await waitFor(() => expect(u.getByText('RSA')).toBeTruthy());
    expect(u.queryByTestId('channel-message-hits')).toBeNull();
  });
});
