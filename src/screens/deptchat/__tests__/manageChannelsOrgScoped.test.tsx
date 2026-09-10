/**
 * Channels vs2 item 8 — Manage Channels becomes organisation-scoped.
 *
 * The case that matters most here is NOT the happy path: it is that nothing an
 * admin could do before became unreachable. The first version of this screen
 * put the ARCHIVED list inside the legacy branch, so the moment a workspace
 * grew a hierarchy an admin could archive a channel and then never find it
 * again. A capability that vanishes when the UI improves is a regression.
 */
import React from 'react';
import {render, fireEvent, act} from '@testing-library/react-native';

const mockListManaged = jest.fn();
const mockNavigate = jest.fn();
let mockUser: Record<string, unknown>;
const backHandlers: Array<() => boolean> = [];

// RN's index re-exports `require('./Libraries/Utilities/BackHandler').default`,
// so a mock without `default` leaves `BackHandler` itself undefined and the
// screen throws inside the focus effect.
jest.mock('react-native/Libraries/Utilities/BackHandler', () => ({
  __esModule: true,
  default: {
    addEventListener: (e: string, cb: () => boolean) => {
      if (e !== 'hardwareBackPress') {throw new Error('unexpected BackHandler event: ' + e);}
      backHandlers.push(cb);
      return {remove: () => { const i = backHandlers.indexOf(cb); if (i >= 0) {backHandlers.splice(i, 1);} }};
    },
  },
}));

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn(), getParent: () => undefined, getState: () => ({routeNames: []})}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), [cb]); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: mockUser}),
}));
jest.mock('@services/api', () => ({
  // PDF checklist line 9 — both screens now read the org's chosen tier
  // vocabulary. Absent resolves to the built-ins, so a rejecting stub keeps
  // these cases on exactly the wording they already assert.
  orgApi: {workspaceSettings: () => Promise.reject(new Error('no settings in test'))},
  departmentApi: {listManagedChannels: () => mockListManaged()},
}));

import ManageChannelsScreen from '../ManageChannelsScreen';

/** ADMIN-source row: real parent_id, tree fields explicit. */
const ch = (id: string, name: string, parent_id: string | null, over: Record<string, unknown> = {}) => ({
  id, name, parent_id, department: null, description: null,
  channel_type: 'department', access: 'standard', post_mode: 'open',
  level: parent_id ? 2 : 0, is_broadcast: false, is_lateral: false, member_count: 1,
  provisioned: true, archived: false, created_at: 'now',
  parent_hidden: false, visible_ancestor_id: null, ...over,
});

/** An OLD server: no `is_lateral` key at all. Built by hand because `ch` now
 *  supplies one, and "absent" is the whole point of this shape. */
const oldCh = (id: string, name: string, parent_id: string | null) => {
  const {is_lateral: _drop, ...rest} = ch(id, name, parent_id);
  return rest;
};

const HIERARCHY = [
  ch('sasfa', 'SASFA', null), ch('rsa', 'RSA', 'sasfa'),
  ch('cortac', 'CORTAC', null),
];

beforeEach(() => {
  jest.clearAllMocks();
  backHandlers.length = 0;
  mockUser = {id: 'u1', owns_workspace: true};
  // vs2 edge A3 — a MODERN server answers the tenant question. Cases that want
  // the old-server compat path override this with the bare `{channels}` shape.
  mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: true}});
});

describe('the two-stage workspace dashboard', () => {
  it('opens on the organisation list, not a flat pile', async () => {
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(u.getByLabelText('Create new organisation')).toBeTruthy();
  });

  it('"Create new organisation" asks the server for a ROOT', async () => {
    // Not merely "no parent": on a legacy flat workspace an omitted parent
    // produces another level-1 Main, not a level-0 organisation.
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Create new organisation'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor', {root: true, workspaceTenant: true});
  });

  /**
   * UI corrections 2026-08-15 item 04 SPLITS the single "Create channel in X"
   * into the PDF's two distinct actions: "+ Add lateral channel" and
   * "+ Add sub-level". They are not cosmetic variants — a lateral does not
   * consume a hierarchy tier and a sub-level does, which is the entire feature.
   */
  it('drilling in shows that organisation, and offers BOTH placed creates', async () => {
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    expect(await u.findByLabelText('Add sub-level in RSA')).toBeTruthy();
    fireEvent.press(u.getByLabelText('Add sub-level in SASFA'));
    // The parent travels as a param so the form STATES the placement.
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      {parentId: 'sasfa', parentName: 'SASFA', workspaceTenant: true});
  });

  it('a LATERAL create carries the lateral flag, a sub-level does not', async () => {
    // The flag is what makes the server derive parent.level + 0 instead of +1.
    // Sending the same payload for both would silently make every lateral a
    // structural child — unfixable afterwards, since is_lateral is frozen and
    // re-parenting is blocked.
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await u.findByLabelText('Add lateral channel in SASFA'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      {parentId: 'sasfa', parentName: 'SASFA', lateral: true, workspaceTenant: true});
  });

  it('HIDES the lateral affordance when the server cannot say it supports it', async () => {
    /**
     * D-6 — in PRODUCTION `forbidNonWhitelisted` is false, so an old server
     * STRIPS `lateral: true` and creates a structural child instead. That row is
     * frozen and un-re-parentable, i.e. unfixable. So the button waits until the
     * response PROVES the field exists.
     *
     * Presence, never truthiness — a `=== true` gate would deadlock forever
     * because no laterals exist until one is created.
     */
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      // No is_lateral key anywhere = an old server. ch() supplies one, so these
      // are built by hand to be honestly field-less.
      oldCh('sasfa', 'SASFA', null),
      oldCh('rsa', 'RSA', 'sasfa'),
    ]}});
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    // Sub-levels still work — that path predates the flag.
    expect(await u.findByLabelText('Add sub-level in SASFA')).toBeTruthy();
    expect(u.queryByLabelText('Add lateral channel in SASFA')).toBeNull();
  });

  it('is not a one-way door', async () => {
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    fireEvent.press(await u.findByLabelText('Back to organisations'));
    expect(await u.findByLabelText('Open organisation CORTAC')).toBeTruthy();
  });
});

describe('nothing an admin could do before became unreachable', () => {
  it('ARCHIVED is still listed in the two-stage view', async () => {
    /**
     * THE REGRESSION. Archived sat inside the legacy branch, which the
     * two-stage path replaces wholesale — so on any workspace with a hierarchy
     * the archived list simply stopped rendering, and unarchiving became
     * impossible with no error and no empty state to hint at it.
     */
    mockListManaged.mockResolvedValue({
      data: {channels: [...HIERARCHY, ch('old', 'Retired Team', 'sasfa', {archived: true})]},
    });
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.getByText('ARCHIVED')).toBeTruthy();
    expect(u.getByText('Retired Team')).toBeTruthy();
  });

  it('an archived channel still opens the editor, so it can be unarchived', async () => {
    mockListManaged.mockResolvedValue({
      data: {channels: [...HIERARCHY, ch('old', 'Retired Team', 'sasfa', {archived: true})]},
    });
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    fireEvent.press(u.getByText('Retired Team'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'old', archived: true})}));
  });
});

describe('nothing becomes unmanageable', () => {
  it('#broadcast has a door — it is in NEITHER stage of the tree', async () => {
    /**
     * `placeRow` classifies broadcasts first, so `topLevelOf` skips them and
     * `childrenOf` can never return one: a broadcast appears in no stage at
     * all. This screen is the ONLY door to ChannelEditor in the app, so on a
     * workspace tenant #broadcast was unrenamable, unarchivable and
     * undeletable — while the header pill kept counting it.
     *
     * Live, not hypothetical: the server was just changed to let a workspace
     * DELETE the #broadcast it was seeded before this batch.
     */
    mockListManaged.mockResolvedValue({
      data: {channels: [...HIERARCHY, ch('bc', '#broadcast', null, {is_broadcast: true, level: 1})]},
    });
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Edit Main #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc'})}));
  });

  it('TWO broadcasts are told apart by level — the delete is irreversible', async () => {
    /**
     * The unique index is on (org_id, LEVEL), so an org can hold up to four
     * `#broadcast` rows — and `ensureBroadcastForLevel` hard-codes that one
     * name. The 2026-08-05 backfill minted one per (org, level) with no tenant
     * filter, so any workspace with channels at more than one level has several
     * today. Rendered as name alone they were N identical cards with identical
     * a11y labels, one tap from a deletion the server now permits and nothing
     * undoes.
     *
     * A single-broadcast fixture cannot see this: `findByLabelText` THROWS on
     * multiple matches, so the duplicate labels would have surfaced as a
     * confusing test error against real data rather than a caught defect.
     */
    mockListManaged.mockResolvedValue({data: {channels: [...HIERARCHY,
      ch('bc1', '#broadcast', null, {is_broadcast: true, level: 1}),
      ch('bc2', '#broadcast', null, {is_broadcast: true, level: 2}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Edit Sub #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc2'})}));
    expect(u.getByLabelText('Edit Main #broadcast')).toBeTruthy();
  });

  it('an ARCHIVED broadcast is not offered — archived rows have their own section', async () => {
    // Otherwise it renders twice, in two sections, with two different meanings.
    mockListManaged.mockResolvedValue({
      data: {channels: [...HIERARCHY, ch('bc', '#broadcast', null, {is_broadcast: true, archived: true})]},
    });
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByLabelText('Edit #broadcast')).toBeNull();
  });

  it('an OLD SERVER falls back to the flat list instead of hiding every channel', async () => {
    /**
     * `topLevelOf` classifies by `parent_hidden`. A server without the
     * hierarchy migration emits none, so every row routes to a synthetic root
     * that stage 1 drops: the admin saw ONE card — "Create new organisation" —
     * with every existing channel invisible and uneditable, the footer create
     * button hidden, and ARCHIVED still rendering underneath. That reads as
     * data loss, and an APK ahead of auth-service is this repo's normal order.
     */
    mockListManaged.mockResolvedValue({data: {channels: [
      {...ch('a', 'General', null), parent_hidden: undefined},
      {...ch('b', 'Ops', null), parent_hidden: undefined},
    ]}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('CHANNELS')).toBeTruthy();
    expect(u.getByText('General')).toBeTruthy();
    expect(u.getByText('Ops')).toBeTruthy();
    expect(u.queryByLabelText('Create new organisation')).toBeNull();
  });

  it('…but ZERO channels is a clean workspace, not an old server', async () => {
    // The compat gate must not eat the empty case: a new customer's very first
    // action is building their structure, and stage 1 is its only entry point.
    mockListManaged.mockResolvedValue({data: {channels: []}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Create new organisation')).toBeTruthy();
  });

  it('an ALL-ARCHIVED workspace is not mistaken for an old server', async () => {
    /**
     * The compat gate asked two DIFFERENT row sets: `channels.length === 0` over
     * everything, `serverKnowsHierarchy` over the non-archived subset. A
     * workspace whose channels are all archived is neither empty nor
     * tree-ignorant, but answered "old server" — dropping it into the legacy
     * branch, which brings back the placement-free "New channel" button whose
     * own comment says it would mint yet another parentless Main.
     *
     * Reached in ordinary early setup: create one organisation, archive it.
     */
    mockListManaged.mockResolvedValue({data: {channels: [
      ch('old', 'Retired Org', null, {archived: true}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Create new organisation')).toBeTruthy();
    expect(u.queryByText('New channel')).toBeNull();
  });

  it('a 200 with no channels array renders the empty state, not a crash', async () => {
    // The FOURTH unguarded `data.channels`. Round 2 guarded three of these on
    // the sibling endpoint while editing this very file and missed the one in
    // front of it; `channels.filter(...)` then throws in the render body.
    mockListManaged.mockResolvedValue({data: {}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Create new organisation')).toBeTruthy();
    expect(u.queryByText('Could not load')).toBeNull();
  });

  it('Android hardware BACK leaves STAGE 2, not the screen', async () => {
    // Stage 2 is local state, so the system back gesture popped the whole
    // screen — on the primary admin flow, every time.
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    await u.findByLabelText('Add sub-level in SASFA');
    const handler = backHandlers[backHandlers.length - 1];
    expect(handler).toBeTruthy();
    // Returning TRUE is the half that matters: false lets navigation pop.
    expect(handler()).toBe(true);
    expect(await u.findByLabelText('Open organisation CORTAC')).toBeTruthy();
  });

  it('a refresh BLIP keeps stage 2 — it does not blank the list or drop the admin out', async () => {
    /**
     * REWRITTEN. The first version asserted the blanked state as expected,
     * because that is what the screen did: `load()`'s catch emptied `channels`
     * and a full-screen error card replaced everything. So one blip on the
     * primary admin flow — stage 2 → ChannelEditor → back → focus refetch —
     * wiped the whole channel list AND dropped the admin out of the
     * organisation they were inside.
     *
     * The sibling member screen had already made the opposite call (keep the
     * rows, show a strip). Two surfaces disagreeing about what a blip means is
     * the drift this repo keeps paying for, so this one now matches — and the
     * back press stays meaningful because stage 2 is still on screen.
     */
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    await u.findByLabelText('Add sub-level in SASFA');
    mockListManaged.mockRejectedValue(new Error('offline'));
    await act(async () => {
      u.getByTestId('manage-scroll').props.refreshControl.props.onRefresh();
    });
    // The content survived, with the failure reported above it…
    expect(u.getByLabelText('Add sub-level in SASFA')).toBeTruthy();
    expect(await u.findByLabelText(/Tap to retry/)).toBeTruthy();
    // …and back still means "leave this organisation", not "leave the screen".
    const handler = backHandlers[backHandlers.length - 1];
    expect(handler).toBeTruthy();
    expect(handler()).toBe(true);
    expect(await u.findByLabelText('Open organisation CORTAC')).toBeTruthy();
  });

  it('…but with NOTHING to keep, the failure takes the screen', async () => {
    // First load, no rows behind it: a one-line hairline is not an honest
    // report of a screen that has nothing to show.
    mockListManaged.mockRejectedValue(new Error('offline'));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText(/Could not load/i)).toBeTruthy();
    expect(u.queryByLabelText(/Tap to retry/)).toBeNull();
  });

  it('an organisation that vanishes mid-drill-in says so, rather than teleporting', async () => {
    // Silently bouncing to stage 1 reads as a mis-tap. The member screen says
    // it; so does this one.
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Open organisation SASFA'));
    await u.findByLabelText('Add sub-level in SASFA');
    mockListManaged.mockResolvedValue({data: {channels: [ch('cortac', 'CORTAC', null)]}});
    // Pull-to-refresh. Fired through the RefreshControl's own prop: the handler
    // lives there, not on the ScrollView, so a 'refresh' event on the scroll
    // view is swallowed and the test passes on a screen that never reloaded.
    await act(async () => {
      u.getByTestId('manage-scroll').props.refreshControl.props.onRefresh();
    });
    expect(await u.findByText(/no longer available/)).toBeTruthy();
  });
});

describe('the AGENCY and legacy-flat paths are untouched', () => {
  it('an agency keeps the single flat list and the New channel button', async () => {
    mockUser = {id: 'u1', owns_workspace: false, org_is_workspace: false};
    // The SERVER says agency too — that is the fact the shape now follows.
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: false}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('CHANNELS')).toBeTruthy();
    expect(u.getByText('New channel')).toBeTruthy();
    expect(u.queryByLabelText('Create new organisation')).toBeNull();
  });

  it('a FLAT workspace STILL gets the organisation view — admin surfaces never collapse', async () => {
    /**
     * FLIPPED DELIBERATELY. This previously asserted that a flat workspace kept
     * the legacy list here, mirroring the member directory's data gate.
     *
     * That gate closed a loop with no way out: stage 1 is the ONLY producer of
     * `root: true` and stage 2 the only producer of `parentId`, item 7 removed
     * the parent picker from the workspace form, and the footer button sends
     * neither. So no hierarchy meant no stages meant no way to create one —
     * forever, on every workspace that exists today and on every clean P3
     * workspace, which start with no channels at all.
     *
     * The "one-item organisations" argument belongs to the MEMBER directory,
     * where collapsing is the point. This screen passes
     * `collapseChildless: false` precisely so a childless organisation stays
     * visible and can be filled in.
     */
    mockListManaged.mockResolvedValue({
      data: {channels: [ch('a', 'General', null), ch('b', 'Ops', null)]},
    });
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Create new organisation')).toBeTruthy();
    expect(u.getByLabelText('Open organisation General')).toBeTruthy();
  });

  it('an EMPTY workspace can still create its first organisation', async () => {
    // The clean-P3 case: zero channels. Without this the very first thing a new
    // customer does — build their structure — has no entry point at all.
    // Zero rows, and the tenant fact still arrives — the reason it is a
    // RESPONSE field and not a row field.
    mockListManaged.mockResolvedValue({data: {channels: [], workspace_tenant: true}});
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByLabelText('Create new organisation'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor', {root: true, workspaceTenant: true});
  });

  it('the placement-free New channel button is HIDDEN once organisations exist', async () => {
    // It has no placement, so on a workspace it would mint yet another
    // parentless Main while the screen above asks which organisation you mean.
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByText('New channel')).toBeNull();
  });
});

/**
 * Channels vs2 edge A3 — the dashboard's shape follows the ORG, not the USER.
 *
 * Every case above keys off `mockUser.owns_workspace`, which is the bug: that
 * predicate is true for anybody with ANY workspace affiliation. An agency
 * company/manager who had also joined an Enterprise workspace opened their
 * AGENCY's Manage Channels and got the workspace two-stage UI — flat agency
 * channels drawn as "organisation" cards, the New-channel footer gone, and an
 * editor that drops the DEPARTMENT field (the agency's live branch-scope key).
 */
describe('edge A3 — the server says which kind of org this is', () => {
  // Owns a workspace AND administers an agency. Both facts are true; only the
  // server can say which org this request is about.
  const DUAL = {id: 'u1', owns_workspace: true, workspaces: [{org_id: 'ws-1'}]};

  it('an AGENCY response keeps the flat list and the New channel footer', async () => {
    mockUser = DUAL;
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: false}});
    const u = render(<ManageChannelsScreen />);
    // No stage 1: the agency dashboard is not organisation-first.
    expect(await u.findByText('New channel')).toBeTruthy();
    expect(u.queryByLabelText('Open organisation SASFA')).toBeNull();
    expect(u.queryByLabelText('Create new organisation')).toBeNull();
  });

  it('and hands the editor the ORG fact, so DEPARTMENT survives', async () => {
    // The damaging half: without this the agency's new channels are written
    // with department = NULL and drop out of every scoped read.
    mockUser = DUAL;
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: false}});
    const u = render(<ManageChannelsScreen />);
    fireEvent.press(await u.findByText('New channel'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor', {workspaceTenant: false});
  });

  it('a WORKSPACE response still gets stage 1 even when the user flags are unset', async () => {
    // The mirror direction — a delegated manager whose collapsed membership row
    // pinned their agency must still get the workspace shape inside a workspace.
    mockUser = {id: 'u1', owns_workspace: false, org_is_workspace: false};
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: true}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
  });

  it('an OLD server that says nothing falls back to the user-level flag', async () => {
    // Compat: the field is optional, and its absence must reproduce today's
    // behaviour exactly rather than collapsing every tenant to one shape.
    mockUser = {id: 'u1', owns_workspace: true};
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
  });

  it('a failed REFETCH does not repaint the screen in the other tenant shape', async () => {
    // `load` deliberately keeps the rows on error. If the tenant flag reset to
    // undefined alongside them, an agency admin would watch their dashboard
    // turn into the workspace one mid-session on a single blip.
    mockUser = DUAL;
    mockListManaged.mockResolvedValueOnce({data: {channels: HIERARCHY, workspace_tenant: false}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('New channel')).toBeTruthy();
    mockListManaged.mockRejectedValue(new Error('offline'));
    // ⚠️ NOT `fireEvent(scroll, 'refresh')`. The handler lives on the
    // refreshControl, which is a CHILD on iOS (the preset's platform), and
    // RNTL's event lookup only walks UP — so that form is swallowed and the
    // test passes on a screen that never reloaded. This file already says so
    // above; the first version of this case ignored it and covered nothing
    // (proven by a coverage probe: the catch body was never entered).
    await act(async () => {
      await (u.getByTestId('manage-scroll').props.refreshControl.props.onRefresh as () => Promise<void>)();
    });
    expect(mockListManaged).toHaveBeenCalledTimes(2);
    expect(u.queryByLabelText('Open organisation SASFA')).toBeNull();
  });
});

/**
 * edge A3 — the "ONE door" claim is a GATE, not a comment.
 *
 * `openEditor` exists so the tenant fact cannot be attached at six of seven
 * call sites. Nothing enforced that: an eighth `navigate('ChannelEditor', …)`
 * added later would drop the param and reinstate the original bug with a fully
 * green suite. Four of the seven existing assertions use `objectContaining`, so
 * they would not catch it either.
 *
 * Source scan, because no unit test can see a call site that does not run.
 * File is CRLF — nothing here is `\n`-anchored.
 */
describe('the editor has exactly one door (static scan)', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'deptchat', 'ManageChannelsScreen.tsx'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\/[^\r\n]*/g, '');

  it('navigates to ChannelEditor from exactly ONE place', () => {
    expect(src.match(/navigate\('ChannelEditor'/g) ?? []).toHaveLength(1);
  });

  it('…and that place is openEditor, which attaches the tenant fact', () => {
    const helper = src.slice(src.indexOf('const openEditor'), src.indexOf('const treeRows'));
    expect(helper).toMatch(/navigate\('ChannelEditor',\s*\{\.\.\.params,\s*workspaceTenant:\s*serverTenant\}\)/);
    // The RESOLVED value must not be passed: it is always a boolean, which pins
    // the editor to whatever the fallback was at tap time and kills its own
    // `??` chain — so a tap before the list landed froze the wrong tenant in.
    expect(helper).not.toMatch(/workspaceTenant:\s*isWorkspace/);
  });

  it('every editor door goes through the helper', () => {
    // Six call sites plus the definition.
    expect((src.match(/openEditor\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

/**
 * Channels vs2 edge A4 — the Delete door is pinned END TO END, because every
 * hop in it is invisible to the type system or to any rendering test.
 *
 * A4 existed in the first place because `ChannelEditor` navigated
 * `ChannelMembers` with no flag and NOTHING NOTICED. The consumer
 * (`ChannelMembersScreen`) is rendered by no test in the repo, and the chat
 * header navigates through `(navigation as any)`, so a missed rename would not
 * even have failed typecheck. Source scan: comments stripped, CRLF-safe.
 */
describe('edge A4 — the delete verdict survives every hop (static scan)', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const code = (...rel: string[]) =>
    readFileSync(join(process.cwd(), ...rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\/[^\r\n]*/g, '');

  it('pick() carries `deletable` out of the list', () => {
    // Drop this one field and the door vanishes again, silently — the exact
    // "capability with no door" shape A4 was filed for.
    expect(code('src', 'screens', 'deptchat', 'ManageChannelsScreen.tsx'))
      .toMatch(/deletable:\s*c\.deletable/);
  });

  it('EVERY door into ChannelMembers carries canDelete — both of them', () => {
    const doors = [
      code('src', 'screens', 'deptchat', 'ChannelEditorScreen.tsx'),
      code('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx'),
    ];
    for (const src of doors) {
      const i = src.indexOf("navigate('ChannelMembers'");
      expect(i).toBeGreaterThan(-1);
      // Within the navigate payload, not merely somewhere in the file.
      expect(src.slice(i, i + 220)).toMatch(/canDelete/);
    }
    // …and nobody still sends the OLD name, which would silently drop to
    // undefined (no Delete) with a green suite.
    for (const src of doors) {
      const i = src.indexOf("navigate('ChannelMembers'");
      expect(src.slice(i, i + 220)).not.toMatch(/\bisOwner:/);
    }
  });

  it('the CONSUMER gates the button on canDelete', () => {
    const screen = code('src', 'screens', 'deptchat', 'ChannelMembersScreen.tsx');
    expect(screen).toMatch(/canDelete[,}]/);          // destructured from params
    expect(screen).toMatch(/\{canDelete && \(/);      // and it gates the footer
    expect(screen).not.toMatch(/\{isOwner && \(/);
  });

  it('the confirm does NOT promise a teardown that does not happen', () => {
    // `deleteChannel` removes the directory row and audits it. The Signal group
    // and every member's local copy survive, so "removes it for everyone" was
    // false — and A4 is what made that copy reachable from a real door.
    const screen = code('src', 'screens', 'deptchat', 'ChannelMembersScreen.tsx');
    expect(screen).not.toMatch(/removes it for everyone/);
    expect(screen).toMatch(/cannot be restored/);
  });
});

/**
 * Channels vs2 edge A7 — the RENDER site, not just the rule.
 *
 * `orgDisambiguation` can be perfect and wired nowhere; the pure-rule tests
 * cannot see that. This is stage 1 of the manage dashboard, one of the three
 * surfaces where two identically-named organisations were indistinguishable.
 */
describe('edge A7 — same-named organisations are told apart on stage 1', () => {
  const twins = [
    ch('acme1', 'Acme', null), ch('a1-child', 'Ops', 'acme1'),
    ch('acme2', 'Acme', null), ch('a2-child', 'Ops', 'acme2'),
  ];

  it('adds an id handle to BOTH colliding rows', async () => {
    mockListManaged.mockResolvedValue({data: {channels: twins, workspace_tenant: true}});
    const u = render(<ManageChannelsScreen />);
    await u.findAllByLabelText(/Open organisation Acme/);
    // The channel counts are identical here, so the count alone cannot separate
    // them — the id handle is what does.
    expect(u.getAllByText(/ID [0-9A-Z]+/i).length).toBe(2);
  });

  it('leaves a UNIQUE organisation alone — no gratuitous id', async () => {
    mockListManaged.mockResolvedValue({data: {channels: HIERARCHY, workspace_tenant: true}});
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByText(/ID [0-9A-Z]+/i)).toBeNull();
  });
});


/**
 * G4 (founder, 2026-08-19) — "This should not be there. Announcements should be
 * within the organization itself. To avoid announcing to wrong
 * organization/association."
 *
 * The screenshot is THIS screen's stage 1: a global `ANNOUNCEMENTS` heading
 * over three identical `#broadcast` cards, each subtitled "Org-wide
 * announcements", above two organisations. Nothing on those rows says which
 * organisation they reach, which is the founder's complaint stated exactly.
 *
 * WHAT THE SECTION WAS FOR, before anyone deletes the rest of it. Rev 4 §2.4
 * records it as "the only door to ChannelEditor" for a broadcast, because
 * `placeRow` keeps them out of both stages of the tree — and §8's aborted-purge
 * branch says that with the block gone and `20260817000000` not verified, live
 * broadcast rows have NO admin door anywhere. So the fix places the ones that
 * CAN be placed and keeps a door for the ones that cannot.
 */
describe('G4 — announcements live inside their organisation', () => {
  it('a PARENTED broadcast is managed INSIDE its organisation, with no global heading', async () => {
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      ...HIERARCHY,
      ch('bc', '#broadcast', 'sasfa', {is_broadcast: true, level: 1}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    // The founder's crossed-out block is gone…
    expect(u.queryByText('ANNOUNCEMENTS')).toBeNull();
    expect(u.queryByText('UNPLACED ANNOUNCEMENTS')).toBeNull();
    // …and the row is inside the organisation it belongs to, still editable.
    fireEvent.press(u.getByLabelText('Open organisation SASFA'));
    fireEvent.press(await u.findByLabelText('Edit #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc'})}));
  });

  it('it also COUNTS toward its organisation, instead of an unattributed total', async () => {
    // The old screen counted broadcasts in the header pill while showing them
    // in a section that named no organisation — a number describing something
    // the screen would not point at.
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      ...HIERARCHY,
      ch('bc', '#broadcast', 'sasfa', {is_broadcast: true, level: 1}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    // RSA + #broadcast. Without the nesting it reads 1 — the control below.
    expect(await u.findByText('2 channels inside')).toBeTruthy();
  });

  it('…and the CONTROL: without the broadcast the same organisation reads one less', async () => {
    // Guards the assertion above from passing on an unrelated arithmetic
    // change. The DELTA is the whole claim.
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: HIERARCHY}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('1 channel inside')).toBeTruthy();
  });

  it('a PARENTLESS broadcast keeps a door, under a heading that says what it is', async () => {
    /**
     * The legacy shape, and the reason the block is not simply deleted: it
     * belongs to no organisation, so it cannot be shown inside one. Rev 4 §8's
     * aborted-purge branch is the failure this covers — an org whose purge
     * aborted keeps live rows, and without this they are unreachable.
     */
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      ...HIERARCHY,
      ch('bc', '#broadcast', null, {is_broadcast: true, level: 1}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('UNPLACED ANNOUNCEMENTS')).toBeTruthy();
    // The old copy claimed a reach nobody chose. The new copy states the fact.
    expect(u.queryByText(/Org-wide announcements/)).toBeNull();
    fireEvent.press(u.getByLabelText('Edit Main #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc'})}));
  });

  it('a broadcast is never in BOTH places at once', async () => {
    // The two sources are disjoint by construction (parent present vs absent);
    // this is the assertion that keeps them so. Rendered twice, one card would
    // delete a channel the other still lists.
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      ...HIERARCHY,
      ch('bcA', '#broadcast', 'sasfa', {is_broadcast: true, level: 1}),
      ch('bcB', '#broadcast', null, {is_broadcast: true, level: 2}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    // Only the parentless one is in the section.
    expect(await u.findByText('UNPLACED ANNOUNCEMENTS')).toBeTruthy();
    expect(u.queryByLabelText('Edit Main #broadcast')).toBeNull();
    expect(u.getByLabelText('Edit Sub #broadcast')).toBeTruthy();
  });
});

/**
 * G5 (founder, 2026-08-19) — "When adding Admins, it should be organization
 * specific only. Admins should not be able to see other organizations."
 *
 * The server answers with `manager_scope_root_ids`; this screen is the surface
 * that has to honour it. Derived from seeded membership rather than a new
 * column — see the field's docblock in `department.service.ts` for why a
 * migration was refused here.
 */
describe('G5 — a scoped admin sees ONE organisation', () => {
  const scoped = (roots: string[] | null | undefined, extra: unknown[] = []) => ({
    data: {workspace_tenant: true, channels: [...HIERARCHY, ...extra],
      manager_scope_root_ids: roots},
  });

  it('the other organisation is not on the screen at all', async () => {
    mockListManaged.mockResolvedValue(scoped(['sasfa']));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.queryByLabelText('Open organisation CORTAC')).toBeNull();
  });

  it('and cannot mint a second one — "organization specific only"', async () => {
    mockListManaged.mockResolvedValue(scoped(['sasfa']));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByLabelText('Create new organisation')).toBeNull();
  });

  it('the header pill counts THEIR organisation, not the workspace', async () => {
    // Same defect as the stage-2 pill one level out: a number describing rows
    // the screen refuses to show.
    mockListManaged.mockResolvedValue(scoped(['sasfa']));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    // SASFA + RSA = 2, NOT the three rows in HIERARCHY.
    expect(u.getByText('2')).toBeTruthy();
  });

  it('ARCHIVED is scoped too — it is the one list that renders workspace-wide', async () => {
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('deadA', 'Retired SASFA Team', 'sasfa', {archived: true}),
      ch('deadC', 'Retired CORTAC Team', 'cortac', {archived: true}),
    ]));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.getByText('Retired SASFA Team')).toBeTruthy();
    expect(u.queryByText('Retired CORTAC Team')).toBeNull();
  });

  it('an UNPLACED announcement is the owner problem, not a scoped admin one', async () => {
    // It belongs to no organisation, so it is not in the one they were given.
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('bc', '#broadcast', null, {is_broadcast: true, level: 1}),
    ]));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByText('UNPLACED ANNOUNCEMENTS')).toBeNull();
  });

  it('null means UNSCOPED — the owner still sees everything', async () => {
    mockListManaged.mockResolvedValue(scoped(null));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(u.getByLabelText('Create new organisation')).toBeTruthy();
  });

  it('an OLD SERVER omits the field entirely and nothing changes', async () => {
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: HIERARCHY}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(u.getByLabelText('Create new organisation')).toBeTruthy();
  });

  it('an EMPTY array does not blank the screen', async () => {
    /**
     * The server is written never to send `[]` — it collapses empty to null —
     * so this is the client half of that contract: whichever of the two guards
     * catches it (the `length > 0` arm, or the fail-open below it), the outcome
     * must be a usable screen. Mutation-checked 2026-08-19: removing EITHER
     * guard alone leaves this green, because the other one holds. That is the
     * intended redundancy, not a gap — what must never pass is a scoped admin
     * with no organisations, no create card and nothing to explain it.
     */
    mockListManaged.mockResolvedValue(scoped([]));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
  });

  it('a scope matching NOTHING fails OPEN rather than showing an empty screen', async () => {
    /**
     * Reachable: the two sides walk different row sets. The server walks every
     * channel in the org INCLUDING archived ones; this list excludes them. So a
     * scoped admin whose organisation root has been archived resolves to a root
     * that is not a top-level row here. An empty stage 1 is indistinguishable
     * from data loss, and this scope is a tidying affordance, not an
     * authorization boundary — every mutation is still guarded server-side.
     */
    mockListManaged.mockResolvedValue(scoped(['a-root-that-is-archived']));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation SASFA')).toBeTruthy();
    expect(u.getByLabelText('Open organisation CORTAC')).toBeTruthy();
    // …and the create card comes back with it: an admin looking at every
    // organisation is unscoped in every way that matters to that button.
    expect(u.getByLabelText('Create new organisation')).toBeTruthy();
  });
});


/**
 * Review round 1 (2026-08-19) — the three G5 states the first pass got wrong.
 * Each was found by an independent reviewer against the shipped diff.
 */
describe('G5 — review-round fixes', () => {
  const scoped = (roots: string[] | null | undefined, extra: unknown[] = []) => ({
    data: {workspace_tenant: true, channels: [...HIERARCHY, ...extra],
      manager_scope_root_ids: roots},
  });

  it('a scope covering EVERY organisation is not a scope', async () => {
    /**
     * Not exotic: a manager invited with the whole-workspace escape hatch is
     * seeded org-wide (`resolveSeedScopeInTx` → `{kind:'orgWide'}`), so the
     * server derives every root for them — and the plan's own G6 mitigation
     * ("invite as employee, promote later") produces exactly this shape.
     *
     * Treating it as scoped took away TWO doors from someone who had both
     * yesterday: Create-new-organisation, and the residual announcements
     * section Rev 4 §8 says must never disappear.
     */
    mockListManaged.mockResolvedValue(scoped(['sasfa', 'cortac'], [
      ch('bc', '#broadcast', null, {is_broadcast: true, level: 1}),
    ]));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByLabelText('Open organisation CORTAC')).toBeTruthy();
    expect(u.getByLabelText('Create new organisation')).toBeTruthy();
    expect(u.getByText('UNPLACED ANNOUNCEMENTS')).toBeTruthy();
  });

  it('a broadcast whose PARENT IS ARCHIVED keeps a door for the scoped admin', async () => {
    /**
     * It is in NEITHER tree stage (its parent is not among the live rows), it
     * is not archived so it is not in ARCHIVED, and the first version of the
     * scope blanked the residual section outright for any scoped admin. Zero
     * doors on a LIVE channel — the exact defect that section exists to
     * prevent — and the row is inside the admin's OWN organisation.
     */
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('deadKid', 'Retired Team', 'sasfa', {archived: true}),
      ch('bc', '#broadcast', 'deadKid', {is_broadcast: true, level: 2}),
    ]));
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('UNPLACED ANNOUNCEMENTS')).toBeTruthy();
    fireEvent.press(u.getByLabelText('Edit Sub #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc'})}));
  });

  it('…but a genuinely PARENTLESS one is still the owner’s to deal with', async () => {
    // It belongs to no organisation, so it is not in the one they were given.
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('bc', '#broadcast', null, {is_broadcast: true, level: 1}),
    ]));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByText('UNPLACED ANNOUNCEMENTS')).toBeNull();
  });

  it('a STRANDED top-level row is kept when its true root is in scope', async () => {
    /**
     * `topLevelOf` deliberately emits a row whose host is missing from the list
     * (flagged `isOrganisation: false`) so it stays reachable. The server's walk
     * always resolves PAST such a row to its real root, so its own id can never
     * be in the scope set — matching on the id alone deleted it and its whole
     * subtree, which is the one shape `topLevelOf` exists to rescue.
     */
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('deadMid', 'Retired Mid', 'sasfa', {archived: true}),
      ch('orphan', 'Live Orphan', 'deadMid', {level: 3}),
    ]));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.getByLabelText('Open Live Orphan')).toBeTruthy();
  });
});


/**
 * Review round 2 (2026-08-19/20). Both reviewers found the same two, from
 * opposite directions.
 */
describe('G5 — review round 2', () => {
  const scoped = (roots: string[] | null, extra: unknown[] = []) => ({
    data: {workspace_tenant: true, channels: [...HIERARCHY, ...extra],
      manager_scope_root_ids: roots},
  });

  it('an ARCHIVED organisation still counts as one the scoped admin is not in', async () => {
    /**
     * `scopeApplied` was decided against LIVE roots only. Archive one whole
     * organisation bottom-up — the ordinary way an organisation is retired —
     * and the live root set shrinks to exactly what the scope covers, so the
     * scope reported itself inert: the ARCHIVED list and the create card both
     * un-scoped, and the SASFA admin got the retired organisation's name and
     * its whole archived subtree back, each with a working editor door.
     */
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true,
      manager_scope_root_ids: ['sasfa'],
      channels: [
        ch('sasfa', 'SASFA', null), ch('rsa', 'RSA', 'sasfa'),
        ch('cortac', 'CORTAC', null, {archived: true}),
        ch('cortac-kid', 'Retired CORTAC Team', 'cortac', {archived: true}),
      ]}});
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    expect(u.queryByText('Retired CORTAC Team')).toBeNull();
    expect(u.queryByText('CORTAC')).toBeNull();
    expect(u.queryByLabelText('Create new organisation')).toBeNull();
  });

  it('a broadcast the TREE REFUSED TO NEST still gets a door', async () => {
    /**
     * The residual section used to re-state the nesting rule ("parent present
     * and live?") and call the two sets "disjoint by construction". Then
     * `parentIsWalked` added a SECOND reason not to nest, and a row refused by
     * it fell into the gap between the two predicates: no stage-1 door, no
     * stage-2 door (`subtreeOf` can never return a `broadcast` placement), no
     * section, and not archived either. Zero doors.
     *
     * The section now asks the tree what it ACTUALLY did, so any future reason
     * to decline lands here instead of vanishing. The shape below is a
     * synthetic-root parent, which `parentIsWalked` refuses.
     */
    mockListManaged.mockResolvedValue({data: {workspace_tenant: true, channels: [
      ...HIERARCHY,
      ch('masked', 'Masked', null, {parent_hidden: true, root_id: 'ghost', level: 2}),
      ch('bc', '#broadcast', 'masked', {is_broadcast: true, level: 2}),
    ]}});
    const u = render(<ManageChannelsScreen />);
    expect(await u.findByText('UNPLACED ANNOUNCEMENTS')).toBeTruthy();
    fireEvent.press(u.getByLabelText('Edit Sub #broadcast'));
    expect(mockNavigate).toHaveBeenCalledWith('ChannelEditor',
      expect.objectContaining({channel: expect.objectContaining({id: 'bc'})}));
  });

  it('the scoped pill counts the unplaced rows the screen is also showing', async () => {
    // Omitting them reproduced, one section out, the very "two numbers
    // describing the same thing" the pill was fixed for.
    mockListManaged.mockResolvedValue(scoped(['sasfa'], [
      ch('deadKid', 'Retired Team', 'sasfa', {archived: true}),
      ch('bc', '#broadcast', 'deadKid', {is_broadcast: true, level: 2}),
    ]));
    const u = render(<ManageChannelsScreen />);
    await u.findByLabelText('Open organisation SASFA');
    // SASFA + RSA + the one unplaced broadcast on screen beneath them.
    expect(u.getByText('3')).toBeTruthy();
  });
});
