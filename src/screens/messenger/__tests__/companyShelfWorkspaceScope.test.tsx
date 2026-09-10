/**
 * Phase B — the company shelf is scoped to the ACTIVE workspace, and the vault
 * refusal registry deliberately is NOT.
 *
 * `companyShelfFailClosed.test.tsx` drives this hook hard, but never with a
 * workspace context set, so `scopeChannelsToActiveWorkspace` and
 * `activeWorkspaceOrgParam` only ever ran their null / pass-through arms.
 * Deleting either call from `useCompanyChannels` left that suite green.
 *
 * The file exists because ONE module holds two OPPOSITE requirements, which is
 * exactly the shape a later "let's make these consistent" refactor breaks:
 *
 *   - `useCompanyChannels` (what a user SEES) must be NARROW: while the user is
 *     inside workspace A, workspace B's channels — and every company file in
 *     them — must not appear on A's shelf.
 *   - `armDeptConversationRegistry` (what the vault REFUSES) must be WIDE and
 *     unscoped: it feeds `moveBytesToVault`'s refusal, so if it only knew the
 *     active workspace's conversations, workspace B's company files would become
 *     copyable into the personal vault the moment the user switched context.
 *     The source calls this out — "or workspace B's company files become
 *     vaultable".
 *
 * Narrowing what you show, never what you refuse.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import {Text} from 'react-native';

type ChannelRow = {id: string; name: string; org_id?: string; group_conversation_id?: string};

const mockListChannels = jest.fn<Promise<{data: {channels: ChannelRow[]}}>, [unknown?]>();
const mockFocus: {cb: (() => void | (() => void)) | null} = {cb: null};

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    mockFocus.cb = cb;
    R.useEffect(() => cb(), []);
  },
}));
// Forward the ARITY faithfully — `listChannels()` and `listChannels(undefined)`
// are the same call to the server but a different claim about this code, and
// the unscoped-registry test below turns on exactly that difference.
jest.mock('@services/api', () => ({
  departmentApi: {listChannels: (...args: unknown[]) => mockListChannels(...(args as [unknown?]))},
}));
jest.mock('@store/entitlements', () => ({useEntitlements: () => ({isOrgAffiliated: true})}));

const mockRememberDept = jest.fn();
jest.mock('@/modules/messenger/store/messengerStore', () => {
  const msg = (id: string, convo: string, name: string) => ({
    id, conversation_id: convo, sender_id: 'u2', content: '', is_encrypted: true,
    created_at: '2026-08-01T10:00:00.000Z',
    media_object_key: `obj-${id}`, media_key: 'k', media_iv: 'i',
    media_mime: 'application/pdf', media_meta: {name, sizeBytes: 10},
  });
  const state = () => ({
    deptGroupByChannel: {},
    rememberDeptConversation: mockRememberDept,
    messages: {
      'conv-A': [msg('m1', 'conv-A', 'ACME-ops.pdf')],
      'conv-B': [msg('m2', 'conv-B', 'BOREALIS-secret.pdf')],
    },
  });
  const useMessengerStore = (sel: (s: unknown) => unknown) => sel(state());
  useMessengerStore.getState = state;
  return {useMessengerStore};
});

// The REAL workspace store — this is the module under test as much as the hook.
import {useActiveWorkspace} from '@store/activeWorkspace';
import {
  useCompanyShelf, useCompanyConversationIds, armDeptConversationRegistry,
} from '@/modules/messenger/vault/useCompanyShelf';

function Probe() {
  const files = useCompanyShelf();
  return <Text>{files.length === 0 ? 'EMPTY' : files.map(f => f.name).join(',')}</Text>;
}
function IdProbe() {
  const ids = useCompanyConversationIds();
  return <Text>{ids.size === 0 ? 'NO-IDS' : [...ids].sort().join(',')}</Text>;
}

const ACME: ChannelRow = {id: 'ch-a', name: 'Acme Ops', org_id: 'org-A', group_conversation_id: 'conv-A'};
const BOREALIS: ChannelRow = {id: 'ch-b', name: 'Borealis Ops', org_id: 'org-B', group_conversation_id: 'conv-B'};

function enterWorkspace(org_id: string) {
  useActiveWorkspace.getState().setActiveWorkspace({org_id, name: org_id, role: 'employee'});
}

beforeEach(() => {
  jest.clearAllMocks();
  useActiveWorkspace.getState().setActiveWorkspace(null);
  mockListChannels.mockResolvedValue({data: {channels: [ACME, BOREALIS]}});
});

afterEach(() => {
  useActiveWorkspace.getState().setActiveWorkspace(null);
});

describe('the shelf asks the server for the workspace the user is inside', () => {
  it('sends the active workspace org id', async () => {
    enterWorkspace('org-A');
    const {findByText} = render(<Probe />);
    await findByText(/ACME-ops\.pdf|EMPTY/);
    expect(mockListChannels).toHaveBeenCalledWith({orgId: 'org-A'});
  });

  it('sends no scope at all when there is no context — pre-Phase-B behaviour', async () => {
    const {findByText} = render(<Probe />);
    await findByText(/ACME-ops\.pdf|EMPTY/);
    expect(mockListChannels).toHaveBeenCalledWith(undefined);
  });
});

describe('another workspace\'s company files never reach this shelf', () => {
  /**
   * The leak this scoping exists to stop. Both orgs' channels come back from a
   * server that has not learned the query param (or from a shared cache); the
   * client must still show only the workspace the user is standing in.
   */
  it('drops rows belonging to a DIFFERENT workspace', async () => {
    enterWorkspace('org-A');
    const {findByText, queryByText} = render(<Probe />);

    expect(await findByText('ACME-ops.pdf')).toBeTruthy();
    expect(queryByText(/BOREALIS/)).toBeNull();
  });

  it('shows the other workspace\'s files — and only those — after switching', async () => {
    const {act} = require('@testing-library/react-native');
    enterWorkspace('org-A');
    const {findByText} = render(<Probe />);
    expect(await findByText('ACME-ops.pdf')).toBeTruthy();

    enterWorkspace('org-B');
    await act(async () => { mockFocus.cb?.(); });

    expect(await findByText('BOREALIS-secret.pdf')).toBeTruthy();
    expect(mockListChannels).toHaveBeenLastCalledWith({orgId: 'org-B'});
  });

  it('shows BOTH when the user is not inside any workspace', async () => {
    const {findByText} = render(<Probe />);
    const shown = await findByText(/pdf/);
    expect(shown.props.children).toContain('ACME-ops.pdf');
    expect(shown.props.children).toContain('BOREALIS-secret.pdf');
  });

  /**
   * Fail-OPEN by construction, and deliberately so: a server that predates the
   * column returns rows with no `org_id`, and dropping those would empty the
   * shelf for every user on an older backend.
   */
  it('passes through rows an older server sent without an org id', async () => {
    mockListChannels.mockResolvedValue({data: {
      channels: [{id: 'ch-a', name: 'Legacy Ops', group_conversation_id: 'conv-A'}],
    }});
    enterWorkspace('org-A');
    const {findByText} = render(<Probe />);
    expect(await findByText('ACME-ops.pdf')).toBeTruthy();
  });

  it('is EMPTY when the active workspace has no channels of its own', async () => {
    mockListChannels.mockResolvedValue({data: {channels: [BOREALIS]}});
    enterWorkspace('org-A');
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
  });
});

describe('the second read path (FilesScreen) scopes identically', () => {
  it('resolves only the active workspace\'s conversation ids', async () => {
    enterWorkspace('org-A');
    const {findByText} = render(<IdProbe />);
    expect(await findByText('conv-A')).toBeTruthy();
  });

  it('resolves every workspace when there is no context', async () => {
    const {findByText} = render(<IdProbe />);
    expect(await findByText('conv-A,conv-B')).toBeTruthy();
  });
});

describe('the vault REFUSAL registry stays deliberately unscoped', () => {
  /**
   * If this ever learned the workspace param, workspace B's company files would
   * stop being recognised as company files the moment the user entered
   * workspace A — and `moveBytesToVault` would happily copy them into the
   * personal vault, where they outlive the membership entirely.
   */
  it('arms with NO workspace filter even while a workspace is active', async () => {
    enterWorkspace('org-A');
    const armed = await armDeptConversationRegistry();

    expect(mockListChannels).toHaveBeenCalledWith();
    expect(mockListChannels.mock.calls[0][0]).toBeUndefined();
    expect(armed).toBe(2);
  });

  it('records the OTHER workspace\'s conversations too, so their files stay unvaultable', async () => {
    enterWorkspace('org-A');
    await armDeptConversationRegistry();

    // Stale-expectation fix: rememberDeptConversation grew an orgId param
    // (dept-channel scoping) and the registry now stamps each conversation
    // with ITS OWN org — which is the point of this test: workspace B's
    // conversations are recorded under org-B even while org-A is active.
    expect(mockRememberDept).toHaveBeenCalledWith('conv-A', 'org-A');
    expect(mockRememberDept).toHaveBeenCalledWith('conv-B', 'org-B');
  });
});
