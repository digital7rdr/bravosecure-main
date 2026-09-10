/**
 * Channels vs2 item 2 — the two-stage hierarchical team picker.
 *
 * A RENDER test, deliberately. `organisationTree.test.ts` proves the grouping
 * RULE in isolation and a source scan proves the screen imports it — neither can
 * prove the screen actually drills, or that a node the server marked
 * un-mintable is really unpressable. A typo'd stage guard, a subtree rendered
 * from the wrong id, or a disabled row whose onPress still fires would leave
 * both of those green. Press the rows and assert what happens.
 *
 * The mock list mirrors `approvalsMintTeam.test.tsx` (same screen, same deps);
 * what differs is that these fixtures carry a HIERARCHY.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockCreateInvite = jest.fn();
const mockListManaged = jest.fn();

jest.mock('@utils/constants', () => ({
  API_BASE_URL: 'https://example.invalid',
  DIAL_CODES: [{code: 'BD', dial: '+880', digits: 10}],
}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: undefined}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
}));
jest.mock('../deptNoun', () => ({deptMemberNoun: () => 'Member', deptEmployeeNoun: () => 'Member'}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {phone_e164: '+8801711111111'}}),
}));
jest.mock('@/modules/messenger/contacts/useDiscoveredContacts', () => ({
  useDiscoveredContacts: () => ({permission: 'unknown', loading: false, error: null, matches: [], refresh: jest.fn()}),
}));
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class {}}));
jest.mock('@services/api', () => ({
  enterpriseApi: {createInvite: (...a: unknown[]) => mockCreateInvite(...a)},
  departmentApi: {listManagedChannels: () => mockListManaged()},
  tokenStore: {get: () => null},
}));

import InviteMemberScreen from '../InviteMemberScreen';
import {WHOLE_WORKSPACE_LABEL, HIDDEN_RUNG_LABEL} from '../organisationTree';

/** An ADMIN-source row: real parent_id, fields emitted explicitly. */
const node = (id: string, name: string, parent_id: string | null, over: Record<string, unknown> = {}) => ({
  id, name, parent_id, level: parent_id ? 2 : 0,
  channel_type: 'department', access: 'standard',
  archived: false, is_broadcast: false,
  parent_hidden: false, visible_ancestor_id: null,
  mintable_by_me: true, ...over,
});

const SASFA = node('sasfa', 'SASFA', null);
const RSA = node('rsa', 'RSA', 'sasfa');
const FORT = node('fort', 'Fort Hunter', 'rsa');
const CORTAC = node('cortac', 'CORTAC', null);
const TREE = [SASFA, RSA, FORT, CORTAC];

beforeEach(() => {
  jest.clearAllMocks();
  mockListManaged.mockResolvedValue({data: {channels: TREE}});
  mockCreateInvite.mockResolvedValue({data: {code: 'ABC123', expires_at: null}});
});

const fillPhone = async (utils: ReturnType<typeof render>) =>
  fireEvent.changeText(
    await utils.findByPlaceholderText('Phone number (with country code)'),
    '+8801712345678');

describe('stage 1 — pick the organisation', () => {
  it('lists ORGANISATIONS, not the flat pile of every channel', async () => {
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(utils.getByLabelText('Open organisation CORTAC')).toBeTruthy();
    // The whole point: descendants must NOT be offered as peers of their root.
    expect(utils.queryByLabelText('Join team RSA')).toBeNull();
    expect(utils.queryByLabelText('Join team Fort Hunter')).toBeNull();
  });

  it('offers the whole-workspace escape hatch, named for what it grants', async () => {
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByLabelText(WHOLE_WORKSPACE_LABEL)).toBeTruthy();
  });

  it('an empty workspace explains itself instead of rendering a blank card', async () => {
    mockListManaged.mockResolvedValue({data: {channels: []}});
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByText(/No organisations yet/)).toBeTruthy();
  });
});

describe('stage 2 — pick the team inside it', () => {
  it('drilling in shows that organisation and its subtree, and nothing else', async () => {
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));

    expect(await utils.findByLabelText('Join team SASFA')).toBeTruthy();
    expect(utils.getByLabelText('Join team RSA')).toBeTruthy();
    expect(utils.getByLabelText('Join team Fort Hunter')).toBeTruthy();
    // The OTHER organisation's rows must not leak into this subtree.
    expect(utils.queryByLabelText('Join team CORTAC')).toBeNull();
  });

  it('the root itself is selectable — an org IS a valid team', async () => {
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team SASFA'));
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: 'sasfa'}));
  });

  it('a deep leaf sends ITS id, not its root', async () => {
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team Fort Hunter'));
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: 'fort'}));
  });

  it('shows the full path on the confirm card', async () => {
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team Fort Hunter'));
    expect(await utils.findByText(/SASFA → RSA → Fort Hunter/)).toBeTruthy();
  });

  it('drilling into the SECOND organisation shows ITS subtree, not the first one', async () => {
    // Not redundant with the test above: every assertion there is also
    // satisfied by a screen that always renders orgs[0]'s subtree regardless of
    // which row was tapped, because SASFA happens to be first. Mutating
    // `subtreeOf(rows, orgId)` to `subtreeOf(rows, orgs[0].id)` survived the
    // whole suite until this case existed.
    mockListManaged.mockResolvedValue({
      data: {channels: [SASFA, RSA, FORT, CORTAC, node('cape', 'Cape Town', 'cortac')]},
    });
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation CORTAC'));

    expect(await utils.findByLabelText('Join team Cape Town')).toBeTruthy();
    expect(utils.getByLabelText('Join team CORTAC')).toBeTruthy();
    expect(utils.queryByLabelText('Join team SASFA')).toBeNull();
    expect(utils.queryByLabelText('Join team Fort Hunter')).toBeNull();
  });

  it('is not a one-way door — Back returns to the organisation list', async () => {
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Back to organisations'));
    expect(await utils.findByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(utils.queryByLabelText('Join team Fort Hunter')).toBeNull();
  });
});

describe('greying follows the SERVER, per row', () => {
  it('a node the server says is un-mintable renders disabled and cannot be picked', async () => {
    mockListManaged.mockResolvedValue({
      data: {channels: [SASFA, {...RSA, mintable_by_me: false}, FORT]},
    });
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));

    const row = await utils.findByLabelText('Join team RSA');
    // THE load-bearing assertion. The `fireEvent.press` below looks like the
    // stronger check but is inert: RNTL refuses to dispatch a press to an
    // element whose accessibilityState marks it disabled, so it passes whether
    // or not the handler guards itself. Mutating the guard away survived the
    // whole suite; mutating `disabled` away does not.
    expect(row.props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(row);
    // …and its CHILD is still reachable — greying one rung must not sever the
    // branch below it.
    fireEvent.press(utils.getByLabelText('Join team Fort Hunter'));
    fireEvent.press(await utils.findByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: 'fort'}));
  });

  it('an ABSENT mintable_by_me (old server) does not grey anything', async () => {
    const {mintable_by_me: _drop, ...noField} = RSA;
    mockListManaged.mockResolvedValue({data: {channels: [SASFA, noField, FORT]}});
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    const row = await utils.findByLabelText('Join team RSA');
    expect(row.props.accessibilityState).toMatchObject({disabled: false});
  });
});

describe('a masked orphan is nested, not promoted to an organisation', () => {
  it('renders under its visible ancestor behind a neutral placeholder rung', async () => {
    // The member-side shape: Fort Hunter's parent (RSA) is managers-only, so the
    // server masks parent_id and reports the nearest visible ancestor instead.
    mockListManaged.mockResolvedValue({
      data: {channels: [
        SASFA,
        {...FORT, parent_id: null, parent_hidden: true, visible_ancestor_id: 'sasfa', root_id: 'sasfa'},
      ]},
    });
    const utils = render(<InviteMemberScreen />);
    // NOT a second organisation in stage 1.
    expect(await utils.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(utils.queryByLabelText('Open organisation Fort Hunter')).toBeNull();

    fireEvent.press(utils.getByLabelText('Open organisation SASFA'));
    expect(await utils.findByLabelText('Join team Fort Hunter')).toBeTruthy();
    // The rung is drawn, and says nothing about WHY the rung is hidden.
    expect(utils.getByText(HIDDEN_RUNG_LABEL)).toBeTruthy();
  });
});

describe('regressions found by the P2-a edge-case review', () => {
  it('E1 — an OLD server plus a real hierarchy must not claim "no organisations"', async () => {
    // The compat gate and the classifier keyed off DIFFERENT fields: parent_id
    // is emitted by the PRE-vs2 server, so `hasHierarchy` flipped true while
    // `placeRow` (which keys off parent_hidden) could classify nothing as an
    // organisation. Stage 1 then told an admin with a full tree that they had
    // no organisations, leaving the whole-workspace grant as their only option.
    const old = (id: string, name: string, parent_id: string | null) => ({
      id, name, parent_id, level: parent_id ? 2 : 1,
      channel_type: 'department', access: 'standard',
      archived: false, is_broadcast: false,
    });
    mockListManaged.mockResolvedValue({
      data: {channels: [old('r', 'Root', null), old('c', 'Child', 'r')]},
    });
    const utils = render(<InviteMemberScreen />);
    // Degrades to the FLAT list — every row pickable, nothing lost.
    expect(await utils.findByLabelText('Join team Root')).toBeTruthy();
    expect(utils.getByLabelText('Join team Child')).toBeTruthy();
    expect(utils.queryByText(/No organisations yet/)).toBeNull();
  });

  it('E4 — archived channels do not pile up in the picker', async () => {
    mockListManaged.mockResolvedValue({
      data: {channels: [SASFA, RSA, {...node('dead', 'Retired', 'sasfa'), archived: true}]},
    });
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    expect(await utils.findByLabelText('Join team RSA')).toBeTruthy();
    expect(utils.queryByLabelText('Join team Retired')).toBeNull();
  });

  it('E6 — an all-grey list says WHY instead of being a silent wall', async () => {
    // A branch-scoped manager whose branch matches nothing greys every row.
    // Before the picker greyed anything, submitting at least produced an
    // explicit "outside your branch" alert; silence is a diagnosability
    // regression.
    // The refusal CODE matters, not just the boolean: the copy is derived from
    // it so that an unscoped owner looking at restricted channels is not told
    // to "ask an owner to widen your scope".
    const outOfBranch = {mintable_by_me: false, mint_refusal: 'team_channel_outside_your_branch'};
    mockListManaged.mockResolvedValue({
      data: {channels: [{...SASFA, ...outOfBranch}, {...RSA, ...outOfBranch}]},
    });
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByText(/None of these teams are in your branch/)).toBeTruthy();
  });
});

describe('regressions found by the ROUND-2 edge-case review', () => {
  it('R2-A — Back still works once a team is SELECTED', async () => {
    // The pre-select effect was keyed on "a team is selected and no org is
    // open", so pressing Back set orgId to null and the effect immediately
    // drilled straight back in. Stage 1 was unreachable for anyone who had
    // picked a team — meaning they could never switch organisation, on the one
    // screen this item exists to build.
    const utils = render(<InviteMemberScreen />);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team Fort Hunter'));
    fireEvent.press(utils.getByLabelText('Back to organisations'));

    expect(await utils.findByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(utils.queryByLabelText('Join team Fort Hunter')).toBeNull();
  });

  it('R2-A2 — and can then switch to the OTHER organisation', async () => {
    mockListManaged.mockResolvedValue({
      data: {channels: [SASFA, RSA, FORT, CORTAC, node('cape', 'Cape Town', 'cortac')]},
    });
    const utils = render(<InviteMemberScreen />);
    await fillPhone(utils);
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team Fort Hunter'));
    fireEvent.press(utils.getByLabelText('Back to organisations'));
    fireEvent.press(await utils.findByLabelText('Open organisation CORTAC'));
    fireEvent.press(await utils.findByLabelText('Join team Cape Town'));
    fireEvent.press(await utils.findByText('Create invite'));

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({team_channel_id: 'cape'}));
  });

  it('R2-D — the all-grey explanation is scoped to what is ON SCREEN', async () => {
    // One organisation entirely out of branch while another is fine. Computed
    // over the whole workspace the copy stayed silent in exactly the case that
    // confuses people: drill into the dead one, every row grey, no reason given.
    const outOfBranch = {mintable_by_me: false, mint_refusal: 'team_channel_outside_your_branch'};
    mockListManaged.mockResolvedValue({
      data: {channels: [{...SASFA, ...outOfBranch}, {...RSA, ...outOfBranch}, CORTAC]},
    });
    const utils = render(<InviteMemberScreen />);
    // Nothing at stage 1 — the workspace as a whole HAS something mintable.
    expect(utils.queryByText(/None of these teams are in your branch/)).toBeNull();
    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    expect(await utils.findByText(/None of these teams are in your branch/)).toBeTruthy();
  });

  it('R2-E — a live child of a filtered-out parent must not VANISH', async () => {
    // The picker drops archived rows and #broadcasts. A live child of one then
    // had nothing to nest under: not an organisation, and no childrenOf call
    // would ever claim it, so it disappeared from the screen entirely. The
    // rendering has to be total — the top of what we can show is the honest
    // place for it.
    mockListManaged.mockResolvedValue({
      data: {channels: [
        {...node('dead', 'Retired Branch', null), archived: true},
        node('live', 'Live Team', 'dead'),
      ]},
    });
    const utils = render(<InviteMemberScreen />);
    // It surfaces as a top-level row rather than being silently dropped.
    // waitFor, not a bare query: the list loads asynchronously, and querying
    // straight after render finds nothing for ANY reason — which would make
    // this assertion fail even against a correct fix.
    await waitFor(() => {
      const asOrg = utils.queryByLabelText('Open Live Team');
      const asTeam = utils.queryByLabelText('Join team Live Team');
      expect(asOrg ?? asTeam).toBeTruthy();
    });
    expect(utils.queryByLabelText('Join team Retired Branch')).toBeNull();
  });
});

describe('regressions found by the ROUND-3 review', () => {
  it('R3 — the dropped-pre-select notice clears once a team IS picked', async () => {
    // Both hints rendered at once: "no specific team is selected" directly
    // above "Joining: SASFA → RSA → Fort Hunter". The notice was set on load
    // and never cleared, so the screen contradicted itself.
    jest.spyOn(require('@react-navigation/native'), 'useRoute')
      .mockReturnValue({params: {channelId: 'locked'}});
    mockListManaged.mockResolvedValue({
      data: {channels: [SASFA, RSA, {...node('locked', 'Locked', 'sasfa'), access: 'restricted',
        mintable_by_me: false, mint_refusal: 'team_channel_is_managers_only'}]},
    });
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByText(/can.t be a join target/)).toBeTruthy();

    fireEvent.press(await utils.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await utils.findByLabelText('Join team RSA'));

    await waitFor(() => expect(utils.queryByText(/can.t be a join target/)).toBeNull());
    expect(utils.getByText(/SASFA → RSA/)).toBeTruthy();
    jest.restoreAllMocks();
  });
});

describe('flat legacy workspaces keep the single-stage list', () => {
  it('skips stage 1 entirely when nothing has a parent', async () => {
    // Every pre-hierarchy workspace is a pile of parentless rows. A two-stage
    // picker over one-item organisations would be strictly worse than the radio
    // list it replaced, so the tree only appears where a tree exists.
    mockListManaged.mockResolvedValue({
      data: {channels: [node('a', 'Alpha', null), node('b', 'Bravo', null)]},
    });
    const utils = render(<InviteMemberScreen />);
    expect(await utils.findByLabelText('Join team Alpha')).toBeTruthy();
    expect(utils.getByLabelText('Join team Bravo')).toBeTruthy();
    expect(utils.queryByLabelText('Open organisation Alpha')).toBeNull();
  });
});

/**
 * Channels vs2 edge A8 — the Manager role was offered to a BRANCH-SCOPED
 * manager and refused only at submit (`scoped_manager_cannot_grant_admin`).
 * Honest, but after the admin had filled in the whole form.
 *
 * The team rows already grey via `mintable_by_me`. This needed its OWN signal:
 * that one is per-ROW and the refusal is per-MINTER — the plan's G10 record
 * states outright that `mintable_by_me` deliberately cannot express it.
 */
describe('edge A8 — the role radio pre-greys for a scoped minter', () => {
  it('DISABLES Manager and says why when the server says the minter is scoped', async () => {
    mockListManaged.mockResolvedValue({data: {channels: TREE, can_grant_manager: false}});
    const u = render(<InviteMemberScreen />);
    await u.findByText('Manager');
    expect(await u.findByText(/scoped to one branch/i)).toBeTruthy();
    /**
     * BOTH halves, deliberately. RNTL's `fireEvent.press` already skips a node
     * whose `accessibilityState.disabled` is true, so the press assertion ALONE
     * passes even with the `disabled` prop removed — and on a device it is the
     * prop that actually blocks the touch. Assert the state explicitly so the
     * a11y half cannot silently become the only thing holding the gate.
     */
    const row = u.getByLabelText(/Invite as manager, unavailable/i);
    expect(row.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(row);
    expect(u.queryByPlaceholderText(/Branch scope/i)).toBeNull();
  });

  it('leaves Manager selectable for an UNSCOPED minter', async () => {
    mockListManaged.mockResolvedValue({data: {channels: TREE, can_grant_manager: true}});
    const u = render(<InviteMemberScreen />);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    // Selecting it reveals the branch-scope field, which is the observable.
    expect(await u.findByPlaceholderText(/Branch scope/i)).toBeTruthy();
  });

  it('an OLD server that says nothing still OFFERS the role (compat)', async () => {
    // The submit-time refusal remains the real boundary; greying on a guess
    // would take the role away from someone the server would allow.
    mockListManaged.mockResolvedValue({data: {channels: TREE}});
    const u = render(<InviteMemberScreen />);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    expect(await u.findByPlaceholderText(/Branch scope/i)).toBeTruthy();
  });
});

/**
 * Channels vs2 edge A7 — the invite picker's stage 1. This row decides which
 * organisation an invitee is SEEDED into, and this surface has neither a role
 * nor a count to fall back on, so the id handle is the only disambiguator.
 */
describe('edge A7 — same-named organisations in the invite picker', () => {
  it('adds an id handle when two organisations share a name', async () => {
    mockListManaged.mockResolvedValue({data: {channels: [
      node('acmeaaa1', 'Acme', null), node('c1', 'Ops', 'acmeaaa1'),
      node('acmebbb2', 'Acme', null), node('c2', 'Ops', 'acmebbb2'),
    ]}});
    const utils = render(<InviteMemberScreen />);
    await utils.findAllByLabelText(/Open organisation Acme/);
    expect((await utils.findAllByText(/ID [0-9A-Z]+/i)).length).toBe(2);
  });

  it('leaves a UNIQUE organisation alone', async () => {
    const utils = render(<InviteMemberScreen />);
    await utils.findByLabelText('Open organisation SASFA');
    expect(utils.queryByText(/ID [0-9A-Z]+/i)).toBeNull();
  });
});


/**
 * G6 (founder, 2026-08-19) — "When adding Admins, it should be organization
 * specific only."
 *
 * A teamless invite seeds the joiner across the WHOLE workspace, which with
 * more than one root is a grant over every organisation in it. For an EMPLOYEE
 * that is a reach an admin can live with. For a MANAGER it is precisely the
 * "admins seeing other organizations" the founder is asking us to stop, and it
 * was the default: `teamId` starts null and nothing objected.
 *
 * Workspace tenant ONLY. An agency has exactly one organisation, so the rule
 * has no meaning there and would only block a legitimate org-wide invite.
 */
describe('G6 — a manager invite must name an organisation', () => {
  const workspace = (over: Record<string, unknown> = {}) =>
    mockListManaged.mockResolvedValue({data: {channels: TREE, workspace_tenant: true, ...over}});
  // The screen refuses through the shared Alert wrapper, which this file
  // already mocks; reached by require so the mock instance is the same one.
  const alertMock = () => (require('@utils/alert').Alert.alert as jest.Mock);

  it('the escape hatch GREYS the moment Manager is selected, and says why', async () => {
    workspace();
    const u = render(<InviteMemberScreen />);
    // Available for an employee…
    expect(await u.findByLabelText(WHOLE_WORKSPACE_LABEL)).toBeTruthy();
    fireEvent.press(u.getByLabelText('Invite as manager'));
    /**
     * BOTH halves, for the reason A8's test records: RNTL's press already skips
     * a node whose accessibilityState.disabled is true, so the press assertion
     * alone would pass with the `disabled` prop removed — and on a device it is
     * the prop that blocks the touch.
     */
    // Matched on the SUFFIX, not on the interpolated constant: the label
    // contains parentheses, so `new RegExp(WHOLE_WORKSPACE_LABEL + …)`
    // reads them as a capture group and silently matches nothing.
    const row = await u.findByLabelText(/unavailable: a manager must be given one organisation/i);
    expect(row.props.accessibilityState?.disabled).toBe(true);
    expect(u.getByText('A manager must be given one organisation')).toBeTruthy();
  });

  it('and the submit refuses rather than minting a whole-workspace admin', async () => {
    workspace();
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(alertMock()).toHaveBeenCalled());
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });

  it('with an organisation chosen, the manager invite goes through', async () => {
    // The rule must not be a wall: choosing a team is the whole ask.
    workspace();
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await u.findByLabelText('Join team RSA'));
    fireEvent.press(u.getByLabelText('Invite as manager'));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({invited_role: 'manager', team_channel_id: 'rsa'})));
  });

  it('an EMPLOYEE keeps the escape hatch — the reach is acceptable for them', async () => {
    workspace();
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText(WHOLE_WORKSPACE_LABEL));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({invited_role: 'employee'})));
  });

  it('an AGENCY is untouched — one organisation, so the rule has no meaning', async () => {
    mockListManaged.mockResolvedValue({data: {channels: TREE, workspace_tenant: false}});
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({invited_role: 'manager'})));
  });

  it('an OLD SERVER that says nothing is treated as untouched too', async () => {
    // `=== true`, not truthiness: undefined means the list has not landed or
    // the server is old, and neither is a reason to refuse an invite that
    // worked yesterday.
    mockListManaged.mockResolvedValue({data: {channels: TREE}});
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
  });
});


/**
 * G5 on the ADDING-ADMINS screen — review round 1 (2026-08-19).
 *
 * The plan claimed this fell out of the server change ("the picker is fed by
 * the same endpoint, so a scoped admin can only pick inside their own
 * organisation"). It did not: the endpoint narrows only the new FIELD, never
 * `channels`, and this screen never read the field. So the founder's sentence —
 * which is literally about *adding Admins* — was satisfied on Manage Channels
 * and not on the screen it names.
 */
describe('G5 — the picker is scoped to the minter organisations', () => {
  const scoped = (roots: string[] | null) =>
    mockListManaged.mockResolvedValue({data: {channels: TREE, workspace_tenant: true,
      manager_scope_root_ids: roots}});

  it('stage 1 offers only the organisation this admin runs', async () => {
    scoped(['sasfa']);
    const u = render(<InviteMemberScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.queryByLabelText('Open organisation CORTAC')).toBeNull();
  });

  it('and its subtree is still fully pickable', async () => {
    // Narrowing must not cost the admin their own branch.
    scoped(['sasfa']);
    const u = render(<InviteMemberScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    expect(await u.findByLabelText('Join team RSA')).toBeTruthy();
    expect(u.getByLabelText('Join team Fort Hunter')).toBeTruthy();
  });

  it('null leaves every organisation, exactly as before', async () => {
    scoped(null);
    const u = render(<InviteMemberScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
  });

  it('a scope matching nothing FAILS OPEN rather than emptying the picker', async () => {
    // Same asymmetry as Manage Channels: the two sides walk different row sets.
    scoped(['a-root-not-in-this-list']);
    const u = render(<InviteMemberScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
  });
});

describe('G6 — the rule must be satisfiable', () => {
  it('a CLEAN workspace can still invite its first manager', async () => {
    /**
     * The screen rendered "No organisations yet — invite with no specific team,
     * or create channels first" directly beneath a greyed row saying a manager
     * must be given one, and Create then refused. It instructed the exact
     * action it had disabled, and the first co-admin of a brand-new workspace
     * could not be invited at all.
     *
     * With zero organisations there are no OTHER organisations to leak into,
     * which is the whole point of the rule — so it must not fire.
     */
    mockListManaged.mockResolvedValue({data: {channels: [], workspace_tenant: true}});
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    expect(u.queryByText('A manager must be given one organisation')).toBeNull();
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({invited_role: 'manager'})));
  });

  it('an UN-MINTABLE-but-live workspace still APPLIES the rule, and says what to do', async () => {
    /**
     * The client predicate is the SERVER's, restated — and this is the case
     * that forced it. `mintDisabled` is a strict SUBSET of the server probe (a
     * mintable row is always live, non-broadcast and non-announcement, never
     * the reverse), so keying on it left the escape hatch ENABLED while the
     * server 400'd the mint. A workspace whose only root is `restricted` —
     * reachable on anything predating `restricted_root_not_allowed` — hit that
     * every time.
     *
     * So the rule APPLIES here, and the two halves of the screen must agree
     * about it: the hatch greys, AND the blocked banner stops telling the admin
     * to use it.
     */
      mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
        node('root', 'Legacy Root', null, {access: 'restricted', mintable_by_me: false,
          mint_refusal: 'team_channel_is_managers_only'}),
      ]}});
      const u = render(<InviteMemberScreen />);
      await fillPhone(u);
      fireEvent.press(await u.findByLabelText('Invite as manager'));
      expect(u.getByText('A manager must be given one organisation')).toBeTruthy();
      expect(u.queryByText(/invite with no specific team/i)).toBeNull();
      expect(u.getByText(/Create a standard team first/i)).toBeTruthy();
  });

  it('an ANNOUNCEMENT-only workspace does NOT apply it — the server would not either', async () => {
    // `post_mode: 'announcement'` is excluded by BOTH predicates. This is the
    // half that keeps the two in step in the other direction.
      mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
        node('ann', 'Announcements', null, {post_mode: 'announcement', mintable_by_me: false}),
      ]}});
      const u = render(<InviteMemberScreen />);
      await fillPhone(u);
      fireEvent.press(await u.findByLabelText('Invite as manager'));
      expect(u.queryByText('A manager must be given one organisation')).toBeNull();
      fireEvent.press(u.getByText('Create invite'));
      await waitFor(() => expect(mockCreateInvite).toHaveBeenCalledWith(
        expect.objectContaining({invited_role: 'manager'})));
  });

  it('the SERVER refusal has copy — the client pre-flight is not the boundary', async () => {
    /**
     * Reached whenever the pre-flight was off: the channel list failed to load
     * (so the tenant is unknown), or the caller is an older build. Without the
     * mapping this deterministic 400 reads as a connection failure and the
     * admin retries it forever — a shape this file has already been bitten by
     * twice (`team_channel_in_other_org`).
     */
    mockListManaged.mockResolvedValue({data: {channels: TREE}});
    mockCreateInvite.mockRejectedValue(
      {response: {data: {message: 'manager_invite_requires_team'}}});
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    fireEvent.press(await u.findByLabelText('Invite as manager'));
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(
      (require('@utils/alert').Alert.alert as jest.Mock).mock.calls.at(-1)?.[1],
    ).toMatch(/Choose the organisation or team this manager will run/));
  });
});


/**
 * Review round 2 — the `teamId` ⇄ `selected` invariant, broken by G5.
 *
 * Before the scope narrowing the two could not disagree: `loadTeams` dropped a
 * pre-select that was missing or `mintDisabled`, and a survivor was BY
 * CONSTRUCTION in the pickable list. G5 narrowed `pickable` by organisation
 * while that check kept reading the unnarrowed list.
 */
describe('G5 — a pre-select outside the scope must not survive invisibly', () => {
  it('is dropped, explained, and NOT minted', async () => {
    /**
     * Reachable without typing anything: a manager scoped to SASFA is also an
     * ordinary member of a CORTAC channel (the residue documented on
     * `managerScopeRootIds`), opens it from the member directory, and taps
     * Members → "Invite someone new", which passes `{channelId}`.
     *
     * The old behaviour: nothing rendered selected, no breadcrumb, no
     * explanation, the escape-hatch radio read blank because `teamId` was
     * truthy — and Create sent `team_channel_id` for a team in the organisation
     * this screen had just been narrowed to hide. It also slipped past the G6
     * guard, whose condition is `!teamId`.
     */
    jest.spyOn(require('@react-navigation/native'), 'useRoute')
      .mockReturnValue({params: {channelId: 'cortac'}});
    mockListManaged.mockResolvedValue({data: {channels: TREE, workspace_tenant: true,
      manager_scope_root_ids: ['sasfa']}});
    const u = render(<InviteMemberScreen />);
    await fillPhone(u);
    // The explanation the screen already had for a dropped pre-select.
    expect(await u.findByText(/can.t be a join target/)).toBeTruthy();
    fireEvent.press(u.getByText('Create invite'));
    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled());
    expect(mockCreateInvite.mock.calls[0][0]).not.toHaveProperty('team_channel_id');
    jest.restoreAllMocks();
  });
});
