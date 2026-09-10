/**
 * Channels vs2 item 7 — the simplified New Channel form.
 *
 * The ask: "remove description/department field, fixed parent list, Type
 * options. Name of channel placeholder + Top level indicator + Access directly
 * below."
 *
 * A RENDER test with an AGENCY TWIN for every case. The whole change is
 * tenant-gated, and a rule that only fires on the tenant you were thinking
 * about is this scope's most repeated mistake — agency orgs type real branch
 * values into DEPARTMENT and those values are the scope key for attendance and
 * incidents, so removing the field there would strand every scoped manager.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

const mockCreateChannel = jest.fn();
const mockNavigate = jest.fn();
const mockListManaged = jest.fn();
const mockDeleteChannel = jest.fn();
const mockConfigure = jest.fn();
let mockRouteParams: Record<string, unknown> | undefined;
let mockUser: Record<string, unknown>;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useRoute: () => ({params: mockRouteParams}),
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/orgWorkspace/provisionChannel', () => ({
  ensureChannelProvisioned: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../deptNoun', () => ({deptMemberNoun: () => 'Members', deptEmployeeNoun: () => 'Member'}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: mockUser}),
}));
jest.mock('@services/api', () => ({
  // PDF checklist line 9 — both screens now read the org's chosen tier
  // vocabulary. Absent resolves to the built-ins, so a rejecting stub keeps
  // these cases on exactly the wording they already assert.
  orgApi: {workspaceSettings: () => Promise.reject(new Error('no settings in test'))},
  departmentApi: {
    createChannel: (...a: unknown[]) => mockCreateChannel(...a),
    configureChannel: (...a: unknown[]) => mockConfigure(...a),
    listManagedChannels: () => mockListManaged(),
    archiveChannel: jest.fn(),
    unarchiveChannel: jest.fn(),
    deleteChannel: (...a: unknown[]) => mockDeleteChannel(...a),
  },
}));

import ChannelEditorScreen from '../ChannelEditorScreen';

const WORKSPACE = {id: 'u1', owns_workspace: true};
const AGENCY = {id: 'u1', owns_workspace: false, org_is_workspace: false};

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  mockUser = WORKSPACE;
  mockListManaged.mockResolvedValue({data: {channels: []}});
  mockCreateChannel.mockResolvedValue({data: {id: 'new', name: 'X'}});
});

describe('the WORKSPACE form is Name → Placement → Access', () => {
  it('drops DEPARTMENT and TYPE', async () => {
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('Name of channel')).toBeTruthy();
    expect(u.queryByPlaceholderText('e.g. Intel')).toBeNull();
    expect(u.queryByText('DEPARTMENT (OPTIONAL)')).toBeNull();
    expect(u.queryByText('TYPE')).toBeNull();
    // ACCESS survives — it is the one thing the mock still asks for.
    expect(u.getByText('ACCESS')).toBeTruthy();
  });

  /**
   * item 04 — the placement line now DISTINGUISHES the two creates.
   *
   * "Under RSA" was unambiguous while there was one kind of child. There are two
   * now, and they differ in the one thing an admin cannot see afterwards: a
   * sub-level consumes a hierarchy tier and a lateral does not. Since
   * `is_lateral` is frozen and re-parenting is blocked, picking the wrong one is
   * not correctable — so the form has to say which it is about to make.
   */
  it('states the placement as a SUB-LEVEL when it is one', async () => {
    mockRouteParams = {parentId: 'p1', parentName: 'RSA'};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByText('Sub-level under RSA')).toBeTruthy();
    expect(u.getByText('Adds a new level under it')).toBeTruthy();
  });

  it('states the placement as a LATERAL when it is one', async () => {
    mockRouteParams = {parentId: 'p1', parentName: 'RSA', lateral: true};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByText('Lateral channel in RSA')).toBeTruthy();
    expect(u.getByText('Sits at the same level — it does not add a new tier')).toBeTruthy();
  });

  it('offers ANNOUNCEMENTS on a lateral, and only on a lateral', async () => {
    // D-5 — a workspace's announcement channel is a lateral with
    // post_mode 'announcement'; there is no is_broadcast field a caller can set.
    // On a LEVEL it must not be offered: a level is structure.
    mockRouteParams = {parentId: 'p1', parentName: 'RSA', lateral: true};
    const lat = render(<ChannelEditorScreen />);
    expect(await lat.findByText('Announcements')).toBeTruthy();

    mockRouteParams = {parentId: 'p1', parentName: 'RSA'};
    const lvl = render(<ChannelEditorScreen />);
    await lvl.findByText('Sub-level under RSA');
    expect(lvl.queryByText('Announcements')).toBeNull();
  });

  it('sends the lateral flag, and only when asked', async () => {
    mockRouteParams = {parentId: 'p1', parentName: 'RSA', lateral: true};
    mockCreateChannel.mockResolvedValue({data: {id: 'new', name: 'X', is_lateral: true}});
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('Name of channel'), '#events');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({parent_id: 'p1', lateral: true})));
  });

  it('WARNS when the server silently dropped the lateral flag', async () => {
    /**
     * In production `forbidNonWhitelisted` is false, so an OLD server strips
     * `lateral` and creates a structural child — which consumes a tier, is
     * frozen, and cannot be re-parented, i.e. can only be deleted. A read-side
     * capability probe cannot catch it either (a rolling deploy can serve the
     * read from a new instance and the write from an old one), so the echo is
     * the only real signal and it has to be acted on.
     */
    mockRouteParams = {parentId: 'p1', parentName: 'RSA', lateral: true};
    mockCreateChannel.mockResolvedValue({data: {id: 'new', name: 'X'}});  // no echo
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('Name of channel'), '#events');
    fireEvent.press(u.getByText('Create channel'));
    const {Alert} = jest.requireMock('@utils/alert') as {Alert: {alert: jest.Mock}};
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith(
      'Channel created, but not as a lateral', expect.stringContaining('sub-level')));
  });

  it('an existing ANNOUNCEMENT lateral round-trips instead of demoting', async () => {
    /**
     * ⚠️ THE THIRD SILENT DEMOTION THIS RESOLVER HAS SHIPPED.
     *
     * access 'standard' + post_mode 'announcement' used to fall through to
     * `pm === 'open' ? 'standard' : 'read_only'` and resolve to READ ONLY — so
     * opening the channel and pressing Save, even for a rename, re-sent
     * post_mode 'read_only' and quietly turned the announcement channel into an
     * ordinary read-only one. Same shape as the first two: a new
     * (access, post_mode) pair added to the table with no arm in the resolver.
     */
    mockRouteParams = {channel: {
      id: 'c9', name: '#announcements', department: null, channel_type: 'department',
      access: 'standard', archived: false, post_mode: 'announcement',
      is_broadcast: false, is_lateral: true,
    }};
    const u = render(<ChannelEditorScreen />);
    fireEvent.press(await u.findByText('Save changes'));
    await waitFor(() => expect(mockConfigure).toHaveBeenCalledWith('c9',
      expect.objectContaining({post_mode: 'announcement'})));
  });

  it('says Top level when creating an organisation', async () => {
    mockRouteParams = {root: true};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByText('Top level')).toBeTruthy();
  });

  it('never sends a department, so the channel is branchless', async () => {
    // The server treats NULL as "belongs to every manager" (item 7's
    // relaxation). Sending '' instead of omitting would store an empty string
    // and match no manager at all.
    mockRouteParams = {root: true};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('Name of channel'), 'SASFA');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
    const body = mockCreateChannel.mock.calls[0][0] as Record<string, unknown>;
    expect('department' in body).toBe(false);
    expect(body.root).toBe(true);
  });

  it('sends parent_id — never root — when nested', async () => {
    mockRouteParams = {parentId: 'p1', parentName: 'RSA'};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('Name of channel'), 'Fort Hunter');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
    const body = mockCreateChannel.mock.calls[0][0] as Record<string, unknown>;
    expect(body.parent_id).toBe('p1');
    expect('root' in body).toBe(false);
  });

  it('does NOT offer Restricted for a top-level organisation', async () => {
    // A root nobody can see leaves every member below it with a directory
    // containing zero organisations. The server refuses it; the form should not
    // dangle the option in the first place.
    mockRouteParams = {root: true};
    const u = render(<ChannelEditorScreen />);
    await u.findByText('Standard');
    expect(u.getByText('Read only')).toBeTruthy();
    expect(u.queryByText('Restricted')).toBeNull();
  });

  it('DOES offer Restricted for a nested channel', async () => {
    // The exception is roots only — a restricted node mid-tree is ordinary.
    mockRouteParams = {parentId: 'p1', parentName: 'RSA'};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByText('Restricted')).toBeTruthy();
  });
});

describe('the AGENCY form is untouched', () => {
  beforeEach(() => { mockUser = AGENCY; });

  it('keeps DEPARTMENT and TYPE', async () => {
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('e.g. Intel')).toBeTruthy();
    expect(u.getByText('TYPE')).toBeTruthy();
    // …and the original NAME placeholder, not the workspace wording.
    expect(u.getByPlaceholderText('e.g. Operations')).toBeTruthy();
  });

  it('still SENDS department, because it is a real scope key there', async () => {
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('e.g. Operations'), 'Ops');
    fireEvent.changeText(u.getByPlaceholderText('e.g. Intel'), 'Intel');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
    expect(mockCreateChannel.mock.calls[0][0]).toMatchObject({department: 'Intel'});
  });

  it('still offers Restricted at top level', async () => {
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByText('Restricted')).toBeTruthy();
  });
});

describe('a manager INSIDE a workspace gets the workspace form', () => {
  it('org_is_workspace counts, not just ownership', async () => {
    // A delegated manager administers channels but does not own the workspace.
    // Keying on ownership alone would show them the agency form — with a
    // DEPARTMENT field whose value the workspace tenant ignores.
    mockUser = {id: 'mgr', owns_workspace: false, org_is_workspace: true};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('Name of channel')).toBeTruthy();
    expect(u.queryByText('TYPE')).toBeNull();
  });
});

/**
 * Channels vs2 edge A3 — THE DUAL PERSONA.
 *
 * Every case above keys the form off `mockUser`, i.e. off a USER-level fact.
 * That is exactly the bug: `isWorkspaceTenant` is true for anybody with ANY
 * workspace affiliation, so an agency company/manager who had also joined an
 * Enterprise workspace got the workspace form on their AGENCY — and this form
 * DROPS `department`, which in an agency is the live branch-scope key for
 * attendance (13 handlers), incidents and invite minting. A null department
 * also makes the channel mintable by every manager under item 7's relaxation.
 *
 * The fix makes the tenant a fact about the ORG ON SCREEN, echoed by the server
 * and handed down by ManageChannels (this screen's only door).
 */
describe('edge A3 — the tenant is the ORG on screen, not the user', () => {
  // The persona: owns/joined a workspace AND administers an agency.
  const DUAL = {id: 'u1', owns_workspace: true, workspaces: [{org_id: 'ws-1'}]};

  it('an AGENCY org keeps DEPARTMENT even when the USER has a workspace', async () => {
    mockUser = DUAL;
    mockRouteParams = {workspaceTenant: false};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('e.g. Intel')).toBeTruthy();
    expect(u.getByText('TYPE')).toBeTruthy();
    expect(u.getByPlaceholderText('e.g. Operations')).toBeTruthy();
  });

  it('…and SENDS it, so the channel is not created branchless', async () => {
    // The damaging half. Without this the row lands with department = NULL and
    // every scoped read in the agency silently stops matching it.
    mockUser = DUAL;
    mockRouteParams = {workspaceTenant: false};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('e.g. Operations'), 'Ops');
    fireEvent.changeText(u.getByPlaceholderText('e.g. Intel'), 'Intel');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
    expect(mockCreateChannel.mock.calls[0][0]).toMatchObject({department: 'Intel'});
  });

  it('a WORKSPACE org still drops it, even when the user flag says otherwise', async () => {
    // The mirror: the org fact WINS in both directions, or a delegated manager
    // of a workspace whose user flags are unset gets the agency form back.
    mockUser = {id: 'u1', owns_workspace: false, org_is_workspace: false};
    mockRouteParams = {workspaceTenant: true};
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('Name of channel')).toBeTruthy();
    expect(u.queryByText('TYPE')).toBeNull();
  });

  it('an OLD caller that sends no tenant falls back to the user-level flag', async () => {
    // Compat: a build whose ManageChannels does not pass the param must behave
    // exactly as it did before, not render a blank form.
    mockUser = AGENCY;
    mockRouteParams = undefined;
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('e.g. Intel')).toBeTruthy();
  });
});

/**
 * edge A3 (review round 2) — the form's tenant is a SNAPSHOT, the write's org
 * is a live header. They can drift apart, and the drift lands data.
 *
 * `ManageChannels` freezes the tenant into a route param at navigate time, but
 * `POST /department/channels` is stamped with `activeWorkspace` at REQUEST
 * time (`/department` is in ORG_SCOPED_PREFIXES). This screen is also
 * registered on the outer messenger stack, which the departmental shell's
 * org-switch remount does not reach — and since vs2 edge A1/A2 a notification
 * tap can adopt a different workspace on its own, moving to another TAB rather
 * than unmounting this form.
 *
 * So: open the agency form, get an org-B push, come back, Save → the agency's
 * `department` string is written into workspace B as a spurious top-level
 * organisation that item 7's mint relaxation then refuses to every scoped
 * manager there. The precedent for refusing instead of guessing is
 * ModuleVisibilitySheet.
 */
describe('edge A3 — the organisation must not move under an open form', () => {
  const {useActiveWorkspace} = require('@store/activeWorkspace') as typeof import('@store/activeWorkspace');
  const {Alert} = require('@utils/alert') as {Alert: {alert: jest.Mock}};
  const ORG_A = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
  const ORG_B = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';

  afterEach(() => { useActiveWorkspace.getState().setActiveWorkspace(null); });

  it('REFUSES the save when the context changed since the form opened', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ORG_A, name: 'Acme', role: 'manager'});
    mockUser = AGENCY;
    mockRouteParams = {workspaceTenant: false};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('e.g. Operations'), 'Ops');
    fireEvent.changeText(u.getByPlaceholderText('e.g. Intel'), 'Intel');

    // A push tap adopts another workspace while the form sits there.
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ORG_B, name: 'Borealis', role: 'manager'});

    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockCreateChannel).not.toHaveBeenCalled();
    expect((Alert.alert as jest.Mock).mock.calls[0][1]).toMatch(/switched organisation/i);
  });

  it('allows the save when the context has not moved', async () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ORG_A, name: 'Acme', role: 'manager'});
    mockUser = AGENCY;
    mockRouteParams = {workspaceTenant: false};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('e.g. Operations'), 'Ops');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
  });

  it('the no-context case (agency, header never sent) still saves', async () => {
    // Null→null must compare equal, or every agency admin is blocked outright.
    mockUser = AGENCY;
    mockRouteParams = {workspaceTenant: false};
    const u = render(<ChannelEditorScreen />);
    fireEvent.changeText(await u.findByPlaceholderText('e.g. Operations'), 'Ops');
    fireEvent.press(u.getByText('Create channel'));
    await waitFor(() => expect(mockCreateChannel).toHaveBeenCalled());
  });

  it('prefers its OWN fetched tenant over a stale route param', async () => {
    // The param is taken at navigate time; this screen's own create-mode fetch
    // re-answers the question against the org the request actually resolved to.
    mockUser = AGENCY;
    mockRouteParams = {workspaceTenant: true};                       // stale: says workspace
    mockListManaged.mockResolvedValue({data: {channels: [], workspace_tenant: false}});
    const u = render(<ChannelEditorScreen />);
    expect(await u.findByPlaceholderText('e.g. Intel')).toBeTruthy();  // agency form wins
  });
});

/**
 * Channels vs2 edge A4 — Delete had NO DOOR on the manage flow.
 *
 * The PDF asks for Delete there. `ChannelEditor` navigated `ChannelMembers`
 * with no delete flag at all, and the button renders only behind one — so even
 * the workspace OWNER never saw it on the admin path. The only door that ever
 * passed one was the chat header, and that one passes a client-side owner
 * GUESS. The flag is now the SERVER's per-row verdict, carried through.
 */
describe('edge A4 — the Members door carries the delete verdict', () => {
  const withChannel = (over: Record<string, unknown> = {}) => ({
    channel: {
      id: 'c1', name: 'Ops', department: null, channel_type: 'department',
      access: 'standard', archived: false, post_mode: 'open', is_broadcast: false, ...over,
    },
  });

  it('passes canDelete TRUE when the server says this person may delete it', async () => {
    mockRouteParams = withChannel({deletable: true});
    const u = render(<ChannelEditorScreen />);
    fireEvent.press(await u.findByText('Members'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelMembers',
      expect.objectContaining({channelId: 'c1', canDelete: true}));
  });

  it('passes canDelete FALSE when it does not', async () => {
    mockRouteParams = withChannel({deletable: false});
    const u = render(<ChannelEditorScreen />);
    fireEvent.press(await u.findByText('Members'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelMembers',
      expect.objectContaining({canDelete: false}));
  });

  it('an OLD server that says nothing yields no Delete door (compat)', async () => {
    // Absent must read as "no", never as "yes" — this gates a destructive,
    // cascading action.
    mockRouteParams = withChannel();
    const u = render(<ChannelEditorScreen />);
    fireEvent.press(await u.findByText('Members'));
    const params = mockNavigate.mock.calls.find(c => c[0] === 'ChannelMembers')?.[1] as
      Record<string, unknown>;
    expect(params.canDelete).toBeUndefined();
  });

  /**
   * UI corrections 2026-08-15 item 05 — "There must be an option to Delete
   * Channels, not only archive them."
   *
   * The capability and the `deletable` verdict both already existed; the only
   * DOOR was inside ChannelMembers, one screen further in. These pin the door
   * the founder actually pointed at — on the Edit Channel screen — and pin that
   * it did NOT replace Archive, which the PDF states explicitly.
   */
  describe('item 05 — Delete on the Edit Channel screen', () => {
    it('offers Delete AND Archive together, never one instead of the other', async () => {
      mockRouteParams = withChannel({deletable: true});
      const u = render(<ChannelEditorScreen />);
      expect(await u.findByText('Delete channel')).toBeTruthy();
      expect(u.getByText('Archive channel')).toBeTruthy();
    });

    it('CONFIRMS before deleting, and names the channel in the prompt', async () => {
      // Irreversible, and it sits one row below a reversible action with the
      // same tone — a single tap must not be enough.
      mockRouteParams = withChannel({deletable: true});
      const u = render(<ChannelEditorScreen />);
      fireEvent.press(await u.findByText('Delete channel'));
      expect(mockDeleteChannel).not.toHaveBeenCalled();
      const {Alert} = jest.requireMock('@utils/alert') as {Alert: {alert: jest.Mock}};
      const [title, body] = Alert.alert.mock.calls.at(-1) as [string, string];
      expect(title).toMatch(/delete/i);
      expect(body).toContain('Ops');
      expect(body).toMatch(/cannot be undone/i);
    });

    it('deletes only after the destructive action is chosen', async () => {
      mockRouteParams = withChannel({deletable: true});
      const u = render(<ChannelEditorScreen />);
      fireEvent.press(await u.findByText('Delete channel'));
      const {Alert} = jest.requireMock('@utils/alert') as {Alert: {alert: jest.Mock}};
      const buttons = Alert.alert.mock.calls.at(-1)?.[2] as Array<{text: string; onPress?: () => void}>;
      buttons.find(b => b.text === 'Delete')?.onPress?.();
      await waitFor(() => expect(mockDeleteChannel).toHaveBeenCalledWith('c1'));
    });

    it('EXPLAINS instead of hiding when the server says it is not deletable', async () => {
      // A missing button reads as "this app has no delete" — which is the
      // complaint item 05 answers. Saying why turns a dead end into an
      // instruction, and names the archived-children case the admin cannot see.
      mockRouteParams = withChannel({deletable: false});
      const u = render(<ChannelEditorScreen />);
      expect(u.queryByText('Delete channel')).toBeNull();
      expect(await u.findByText(/can't be deleted/i)).toBeTruthy();
      expect(u.getByText(/archived ones/i)).toBeTruthy();
    });

    it('an OLD server (no verdict) gets no Delete button — absent means NO', async () => {
      // Fail CLOSED on a destructive verb.
      mockRouteParams = withChannel();
      const u = render(<ChannelEditorScreen />);
      await u.findByText('Archive channel');
      expect(u.queryByText('Delete channel')).toBeNull();
    });
  });
});
