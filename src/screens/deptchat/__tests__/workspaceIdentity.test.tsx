/**
 * UI corrections 2026-08-15 — item 01: "It must always be the users name, as
 * same user may be a part of many organisations, associations etc."
 *
 * The screenshot circles the SASFA tile. The only identity anywhere on the
 * Workspace Hub was an ORGANISATION's name, so the page read as "you are
 * SASFA" — wrong for anyone who owns, manages or belongs to more than one.
 *
 * These pin the PERSON as the page's identity, and pin the states that make a
 * naive implementation render a blank block or a confident wrong count.
 */
import React from 'react';
import {render, waitFor} from '@testing-library/react-native';

let mockUser: Record<string, unknown> | null;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  // Fire the focus effect once, synchronously, so `load()` runs and the screen
  // leaves its loading state — otherwise every assertion below races the spinner.
  // React is required LAZILY: a jest.mock factory is hoisted above the imports
  // and may not close over an out-of-scope binding.
  useFocusEffect: (cb: () => void) => {
    (require('react') as typeof import('react')).useEffect(cb, []);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}})},
}));
jest.mock('@store/activeWorkspace', () => ({
  useActiveWorkspace: {getState: () => ({setActiveWorkspace: jest.fn()})},
}));
jest.mock('@navigation/departmentalEntry', () => ({openDepartmentChannels: jest.fn()}));
jest.mock('../inviteAccept', () => ({acceptInviteFlow: jest.fn()}));
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({user: mockUser}),
    {getState: () => ({recheckMembership: () => Promise.resolve()})},
  ),
}));
jest.mock('@services/api', () => ({
  enterpriseApi: {
    myWorkspace: () => Promise.resolve({data: {workspace: null}}),
    myInvites: () => Promise.resolve({data: {invites: []}}),
  },
  departmentApi: {listChannels: () => Promise.resolve({data: {channels: []}})},
}));

import WorkspaceHubScreen from '../WorkspaceHubScreen';

const ws = (n: number) => Array.from({length: n}, (_, i) => ({
  org_id: `org-${i}`, name: `Org ${i}`, role: 'owner' as const,
}));

describe('item 01 — the Workspace Hub is headed by the USER, not an organisation', () => {
  beforeEach(() => {
    mockUser = {id: 'u1', full_name: 'Dana Okonkwo', email: 'dana@example.com', workspaces: ws(1)};
  });

  it('shows the user name', async () => {
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Dana Okonkwo')).toBeTruthy();
  });

  it('does NOT present an organisation name as the identity', async () => {
    // The regression: the org tile was the only identity on the page. The tile
    // itself is fine and must stay — what must not happen is the org standing in
    // for the person. Proven positionally: the user's name renders ABOVE the
    // first organisation name in the tree order.
    mockUser = {id: 'u1', full_name: 'Dana Okonkwo', email: 'd@e.com',
      workspaces: [{org_id: 'o1', name: 'SASFA', role: 'owner'}]};
    const u = render(<WorkspaceHubScreen />);
    await u.findByText('Dana Okonkwo');
    const all = u.UNSAFE_getAllByType('Text' as never)
      .map(n => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
    const nameAt = all.findIndex(t => t === 'Dana Okonkwo');
    const orgAt = all.findIndex(t => t === 'SASFA');
    expect(nameAt).toBeGreaterThan(-1);
    expect(orgAt).toBeGreaterThan(-1);
    expect(nameAt).toBeLessThan(orgAt);
  });

  it('counts AFFILIATIONS under the name — the founder\'s own framing', async () => {
    mockUser = {id: 'u1', full_name: 'Dana Okonkwo', email: 'd@e.com', workspaces: ws(3)};
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('3 workspaces')).toBeTruthy();
  });

  it('singularises one workspace', async () => {
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('1 workspace')).toBeTruthy();
  });

  it('an EMPTY full_name falls back rather than rendering a blank identity', async () => {
    // `full_name` is typed NON-optional, so `??` never fires on it — but the
    // server can send ''. Only a truthiness fallback catches that, which is why
    // the code uses `.trim() ||` and not `??`.
    mockUser = {id: 'u1', full_name: '   ', email: 'dana@example.com', workspaces: ws(1)};
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('dana@example.com')).toBeTruthy();
  });

  it('falls back again when there is no email either', async () => {
    mockUser = {id: 'u1', full_name: '', email: '', workspaces: ws(1)};
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Your profile')).toBeTruthy();
  });

  it('does not assert "0 workspaces" at someone whose list has not arrived', async () => {
    // An old server omits `workspaces` entirely. Saying "No workspaces yet" to a
    // user who has three is the same class of confident-wrong the org-as-identity
    // bug was.
    mockUser = {id: 'u1', full_name: 'Dana Okonkwo', email: 'd@e.com'};
    const u = render(<WorkspaceHubScreen />);
    await waitFor(() => expect(u.queryByText('Not in a workspace yet')).toBeNull());
    expect(u.getByText('Your workspaces')).toBeTruthy();
  });

  it('says so honestly when the list really is empty', async () => {
    mockUser = {id: 'u1', full_name: 'Dana Okonkwo', email: 'd@e.com', workspaces: []};
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Not in a workspace yet')).toBeTruthy();
  });
});
