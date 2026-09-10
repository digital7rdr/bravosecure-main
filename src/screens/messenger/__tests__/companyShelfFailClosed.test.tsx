/**
 * Scope v2 Phase 4 — `useCompanyShelf` must FAIL CLOSED.
 *
 * The hook owns the membership fetch, and membership IS the scope of the
 * company shelf. So the interesting case is not the happy path — it is what
 * happens when the server cannot be reached: serving the previous list would
 * keep a removed member's company files visible for as long as that list
 * survived in state.
 *
 * This is its own file because the screen tests mock the hook wholesale (to
 * isolate the render rule), which means nothing there can see the hook's own
 * behaviour. Deleting the fail-closed branch survived every screen test.
 */
import React from 'react';
import {render, waitFor} from '@testing-library/react-native';
import {Text} from 'react-native';

const mockListChannels = jest.fn();
/** Lets a test fire a SECOND focus on the same mount. Without it, "cleared the
 *  list" is indistinguishable from "never populated it", because a fresh mount
 *  starts empty either way — which is exactly why deleting the fail-closed
 *  branch survived the first version of this file. */
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
jest.mock('@services/api', () => ({departmentApi: {listChannels: () => mockListChannels()}}));
// The hook gates its fetch on `isOrgAffiliated` (so a personal account never
// calls the dept API). Stubbed at the boundary: the real module reaches
// authStore → expo-local-authentication, which ships untransformed ESM.
const mockOrgAffiliated = {value: true};
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({isOrgAffiliated: mockOrgAffiliated.value}),
}));
const mockRememberDept = jest.fn();
const mockStoreState: {deptGroupByChannel: Record<string, string>} = {
  deptGroupByChannel: {'ch-1': 'conv-1'},
};
jest.mock('@/modules/messenger/store/messengerStore', () => {
  const state = () => ({
    deptGroupByChannel: mockStoreState.deptGroupByChannel,
    rememberDeptConversation: mockRememberDept,
    messages: {'conv-1': [{
      id: 'm1', conversation_id: 'conv-1', sender_id: 'u2', content: '',
      is_encrypted: true, created_at: '2026-08-01T10:00:00.000Z',
      media_object_key: 'obj-1', media_key: 'k', media_iv: 'i',
      media_mime: 'application/pdf', media_meta: {name: 'SECRET.pdf', sizeBytes: 10},
    }]},
  });
  const useMessengerStore = (sel: (s: unknown) => unknown) => sel(state());
  // `getState` is needed because the hook RECORDS each conversation in the
  // additive dept registry (never by writing deptGroupByChannel — that map is
  // B-206's migration trigger).
  useMessengerStore.getState = state;
  return {useMessengerStore};
});

import {
  useCompanyShelf, useCompanyConversationIds, armDeptConversationRegistry,
} from '@/modules/messenger/vault/useCompanyShelf';

/** Renders the hook's output as text so we assert what a screen would show. */
function Probe() {
  const files = useCompanyShelf();
  return <Text>{files.length === 0 ? 'EMPTY' : files.map(f => f.name).join(',')}</Text>;
}

/**
 * The SECOND read path. `useCompanyConversationIds` feeds FilesScreen — the
 * workspace Vault tab — and had no direct coverage at all: the FilesScreen
 * suite mocks it, and this suite only drove `useCompanyShelf`. That is exactly
 * the "a second read path resolves files without the scope" shape this phase
 * was warned about, so it gets its own probe against the real hook.
 */
function IdProbe() {
  const ids = useCompanyConversationIds();
  return <Text>{ids.size === 0 ? 'NO-IDS' : [...ids].join(',')}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgAffiliated.value = true;
  mockStoreState.deptGroupByChannel = {'ch-1': 'conv-1'};
});

describe('useCompanyShelf fails closed', () => {
  it('lists files for a confirmed membership', async () => {
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    const {findByText} = render(<Probe />);
    expect(await findByText('SECRET.pdf')).toBeTruthy();
  });

  it('shows NOTHING when membership cannot be confirmed (network error)', async () => {
    // The message and its key are still on the device — only the membership
    // answer is missing. Falling back to a cached list here is the leak.
    mockListChannels.mockRejectedValue(new Error('offline'));
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  it('shows NOTHING when the server returns no channels', async () => {
    mockListChannels.mockResolvedValue({data: {channels: []}});
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  it('tolerates a malformed response without showing stale files', async () => {
    mockListChannels.mockResolvedValue({data: {}});
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  /**
   * THE CASE THAT MATTERS, and the one a single fetch cannot express: files
   * were listed, then membership can no longer be confirmed. Keeping the
   * previous list here is the leak — a removed member goes on seeing company
   * files for as long as that state survives.
   */
  it('CLEARS an already-listed shelf when the next check fails', async () => {
    const {act} = require('@testing-library/react-native');
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    const {findByText} = render(<Probe />);
    expect(await findByText('SECRET.pdf')).toBeTruthy();

    // Re-focus with the server refusing / unreachable.
    mockListChannels.mockRejectedValue(new Error('offline'));
    await act(async () => { mockFocus.cb?.(); });
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  it('CLEARS the shelf when the member is removed from every channel', async () => {
    const {act} = require('@testing-library/react-native');
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    const {findByText} = render(<Probe />);
    expect(await findByText('SECRET.pdf')).toBeTruthy();

    // The message and its key are still on the device; only membership changed.
    mockListChannels.mockResolvedValue({data: {channels: []}});
    await act(async () => { mockFocus.cb?.(); });
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  /**
   * A personal account must not even ASK. Running the fetch unconditionally
   * made every non-org user issue `GET /department/channels` on each focus —
   * three DB queries and a logged 403 apiece — for a shelf they can never see.
   */
  it('a NON-org account never calls the dept API, and lists nothing', async () => {
    mockOrgAffiliated.value = false;
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
    expect(mockListChannels).not.toHaveBeenCalled();
  });

  /**
   * R4-N2 — the ENTITLEMENT path needs the same second-focus treatment the
   * network path got. On a fresh mount "cleared" and "never populated" look
   * identical, so deleting the clear survived. Losing org affiliation mid-session
   * must drop the shelf, not freeze the last membership answer.
   */
  it('CLEARS an already-listed shelf when org affiliation is lost', async () => {
    const {act} = require('@testing-library/react-native');
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    const {findByText, rerender} = render(<Probe />);
    expect(await findByText('SECRET.pdf')).toBeTruthy();

    // Re-render BEFORE re-focusing: the hook's focus callback is memoised on
    // `isOrgAffiliated`, so calling the stale one would still close over the old
    // value. Losing affiliation re-renders in the real app, which is what gives
    // React Navigation a new callback to run.
    mockOrgAffiliated.value = false;
    rerender(<Probe />);
    await act(async () => { mockFocus.cb?.(); });
    expect(await findByText('EMPTY')).toBeTruthy();
  });

  /**
   * The BOOT arming, tested behaviourally. A source scan over MainNavigator
   * pins the tokens but survives inverting the guard
   * (`if (!ch.group_conversation_id)`), which records nothing — so the function
   * is extracted and driven directly.
   */
  describe('armDeptConversationRegistry', () => {
    it('records every channel that has a conversation', async () => {
      mockListChannels.mockResolvedValue({data: {channels: [
        {id: 'ch-1', name: 'Ops', group_conversation_id: 'conv-1'},
        {id: 'ch-2', name: 'Board', group_conversation_id: 'conv-2'},
      ]}});
      await expect(armDeptConversationRegistry()).resolves.toBe(2);
      expect(mockRememberDept).toHaveBeenCalledWith('conv-1', undefined);
      expect(mockRememberDept).toHaveBeenCalledWith('conv-2', undefined);
    });

    it('vs2 edge A9 — carries the OWNING ORG when the row has one', async () => {
      /**
       * This call is deliberately UNSCOPED (it must see every workspace's dept
       * conversations, or workspace B's company files become vaultable), which
       * is exactly why it is the only place the client ever learns which
       * workspace a dept conversation belongs to. A dept-message push carries
       * `{kind, conversationId, senderUserId}` and nothing else — so without
       * this, a cross-workspace channel tap opens the thread and Back lands in
       * a directory filtered to the sticky org that does not contain it.
       */
      mockListChannels.mockResolvedValue({data: {channels: [
        {id: 'ch-1', name: 'Ops', group_conversation_id: 'conv-1', org_id: 'org-borealis'},
      ]}});
      await expect(armDeptConversationRegistry()).resolves.toBe(1);
      expect(mockRememberDept).toHaveBeenCalledWith('conv-1', 'org-borealis');
    });

    it('records nothing for a channel with no conversation yet', async () => {
      mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-new', name: 'New'}]}});
      await expect(armDeptConversationRegistry()).resolves.toBe(0);
      expect(mockRememberDept).not.toHaveBeenCalled();
    });

    it('a dept-API failure is swallowed and clears NOTHING', async () => {
      // A 403 is the expected answer for every non-org account. The registry is
      // persisted and additive — clearing it here would un-refuse every company
      // file the device already knew about.
      mockListChannels.mockRejectedValue(new Error('403'));
      await expect(armDeptConversationRegistry()).resolves.toBe(0);
      expect(mockRememberDept).not.toHaveBeenCalled();
    });

    it('tolerates a malformed response', async () => {
      mockListChannels.mockResolvedValue({data: {}});
      await expect(armDeptConversationRegistry()).resolves.toBe(0);
    });
  });

  it('the ID hook resolves only channels the server returned', async () => {
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    const {findByText} = render(<IdProbe />);
    expect(await findByText('conv-1')).toBeTruthy();
  });

  it('the ID hook is EMPTY when membership cannot be confirmed', async () => {
    // `deptGroupByChannel` still maps ch-1 → conv-1 on the device. Falling back
    // to that map would hand FilesScreen a set built from stale local state.
    mockListChannels.mockRejectedValue(new Error('offline'));
    const {findByText} = render(<IdProbe />);
    expect(await findByText('NO-IDS')).toBeTruthy();
  });

  it('the ID hook is EMPTY for a non-org account, without asking', async () => {
    mockOrgAffiliated.value = false;
    const {findByText} = render(<IdProbe />);
    expect(await findByText('NO-IDS')).toBeTruthy();
    expect(mockListChannels).not.toHaveBeenCalled();
  });

  /**
   * R3-B2 — the local channel→conversation map is what `moveBytesToVault` reads
   * to REFUSE a company file, and it is only otherwise written when this device
   * opens that thread. After a reinstall-and-restore the messages come back but
   * the map does not, so every company file was vault-movable until each channel
   * had been opened once. Healing it from the server answer closes that.
   */
  it('RECORDS each conversation in the additive registry, so the refusal works', async () => {
    mockStoreState.deptGroupByChannel = {};      // fresh install: pointer map empty
    mockListChannels.mockResolvedValue({data: {channels: [
      {id: 'ch-1', name: 'Ops', group_conversation_id: 'conv-1'},
    ]}});
    render(<Probe />);
    const {waitFor: wf} = require('@testing-library/react-native');
    await wf(() => expect(mockRememberDept).toHaveBeenCalledWith('conv-1', undefined));
  });

  it('NEVER writes deptGroupByChannel — that map is the B-206 migration trigger', async () => {
    // Healing it satisfied the remap guard without migrating, so the
    // member thread history stayed orphaned under the old id permanently.
    mockStoreState.deptGroupByChannel = {'ch-1': 'conv-OLD'};
    mockListChannels.mockResolvedValue({data: {channels: [
      {id: 'ch-1', name: 'Ops', group_conversation_id: 'conv-1'},
    ]}});
    render(<Probe />);
    const {waitFor: wf} = require('@testing-library/react-native');
    await wf(() => expect(mockRememberDept).toHaveBeenCalledWith('conv-1', undefined));
    // The pointer map is untouched, so DepartmentChatScreen still migrates.
    expect(mockStoreState.deptGroupByChannel['ch-1']).toBe('conv-OLD');
  });

  it('does not record anything when the server sends no conversation id', async () => {
    mockStoreState.deptGroupByChannel = {};
    mockListChannels.mockResolvedValue({data: {channels: [{id: 'ch-new', name: 'Unprovisioned'}]}});
    render(<Probe />);
    const {waitFor: wf} = require('@testing-library/react-native');
    await wf(() => expect(mockListChannels).toHaveBeenCalled());
    expect(mockRememberDept).not.toHaveBeenCalled();
  });

  it('does not render files before the membership answer arrives', async () => {
    // First paint must be empty, not optimistic: an optimistic first paint
    // would flash another org's files during a shell switch.
    let resolve: (v: unknown) => void = () => {};
    mockListChannels.mockReturnValue(new Promise(r => { resolve = r; }));
    const {findByText} = render(<Probe />);
    expect(await findByText('EMPTY')).toBeTruthy();
    resolve({data: {channels: [{id: 'ch-1', name: 'Ops'}]}});
    await waitFor(async () => { expect(await findByText('SECRET.pdf')).toBeTruthy(); });
  });
});
