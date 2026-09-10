/**
 * Scope v2 Phase 4, B3 — the WORKSPACE Vault tab must not mix shelves.
 *
 * `DepartmentalNavigator` makes FilesScreen the Vault tab's landing route (it
 * is registered as 'MessengerHome' so VaultLock's back-exit still resolves), and
 * the plan doc names FilesScreen three times as the A10/M11B surface. But its
 * rows come from `selectMediaMessages`, which spans EVERY conversation on the
 * device — so the first screen of the company Vault listed the user's DMs and
 * personal groups beside company files, while the compliant shelf sat two
 * screens deeper behind the PIN.
 *
 * Outside the workspace the same screen is the personal Files browser and must
 * keep its full scope — so this pins BOTH directions.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

const mockInShell = jest.fn();
const mockDeptConversationIds: {value: Record<string, true>} = {value: {'conv-channel': true}};
const mockCompanyConvIds = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// B-663 batch - FilesScreen now imports the direct-upload pickers.
jest.mock('react-native-image-picker', () => ({launchImageLibrary: jest.fn(), launchCamera: jest.fn()}));
jest.mock('expo-document-picker', () => ({getDocumentAsync: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  // `addListener` is required: selection mode registers a beforeRemove
  // listener, so without it long-press throws and selection can never be
  // exercised — which is why the batch lane had no coverage at all.
  useNavigation: () => ({
    navigate: jest.fn(), goBack: jest.fn(), isFocused: () => true,
    addListener: () => () => undefined,
  }),
  useFocusEffect: () => undefined,
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('expo-sharing', () => ({isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn()}));
jest.mock('react-native-svg', () => ({__esModule: true, default: 'Svg', Rect: 'Rect'}));
jest.mock('@components/Halo', () => ({Halo: () => null}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/ui/AttachmentFileViewer', () => ({AttachmentFileViewer: () => null}));
jest.mock('@/modules/messenger/media', () => ({readUriBytes: jest.fn(), resolveAttachmentFileUri: jest.fn()}));
// The REAL surface is tap/select/impact/heavy — an invented `selection` left
// `haptics.tap` undefined, so long-press threw before selection mode opened.
jest.mock('@utils/haptics', () => ({haptics: {
  tap: jest.fn(), select: jest.fn(), impact: jest.fn(), heavy: jest.fn(),
}}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn()}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({isOrgAffiliated: true, hasCloudVault: true}),
  showTierUpgradePrompt: jest.fn(),
}));
jest.mock('@/modules/messenger/vault', () => ({
  openVault: jest.fn(), moveBytesToVault: jest.fn(), findVaultRow: jest.fn(() => null),
  vaultHydrated: () => true,
  vaultPersistApi: () => undefined,
  useVaultStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({files: [], removeFile: jest.fn(), unlockedUntil: Date.now() + 5 * 60_000}),
    {getState: () => ({files: [], isUnlocked: () => true, hasPin: () => true})},
  ),
  // The SHARED predicate the affordance gates now delegate to — the same one
  // `moveBytesToVault` and `FileViewer` use, so a row and the viewer it opens
  // can never disagree. Driven from the wide registry fixture below.
  isDepartmentConversation: (id: string) => !!mockDeptConversationIds.value[id],
}));
jest.mock('@/modules/messenger/vault/useCompanyShelf', () => ({
  useCompanyConversationIds: () => mockCompanyConvIds(),
}));
jest.mock('@screens/deptchat/_obsidian', () => ({
  ...jest.requireActual('@screens/deptchat/_obsidian'),
  useInDepartmentalShell: () => mockInShell(),
}));

const mockCompanyMsg = {
  id: 'm-co', conversation_id: 'conv-channel', sender_id: 'u2', type: 'file',
  content: '', created_at: '2026-08-02T10:00:00.000Z', is_encrypted: true,
  media_object_key: 'o-co', media_key: 'k', media_iv: 'i',
  media_mime: 'application/pdf', media_meta: {name: 'BOARD-MINUTES.pdf', sizeBytes: 10},
};
const mockPersonalMsg = {
  ...mockCompanyMsg,
  id: 'm-dm', conversation_id: 'conv-dm',
  media_object_key: 'o-dm', media_meta: {name: 'HOLIDAY-SNAP.pdf', sizeBytes: 10},
};
/** `type: 'video'` — the bucket `bucketFor` used to drop on the floor. */
const mockCompanyVideo = {
  ...mockCompanyMsg,
  id: 'm-vid', type: 'video', media_object_key: 'o-vid',
  media_mime: 'video/mp4', media_meta: {name: 'SITE-WALKTHROUGH.mp4', sizeBytes: 99},
};
/** The OTHER video shape: `type: 'file'` with a video mime. Both reach 'vid',
 *  by different branches, and only one had a fixture. */
const mockCompanyVideoAsFile = {
  ...mockCompanyMsg,
  id: 'm-vid2', type: 'file', media_object_key: 'o-vid2',
  media_mime: 'video/quicktime', media_meta: {name: 'HANDOVER.mov', sizeBytes: 99},
};

/**
 * TWO SOURCES, deliberately distinct in this fixture.
 *
 *  - `mockCompanyConvIds` (narrow, server membership) decides what the screen
 *    SHOWS inside the workspace shell. It fails closed to empty.
 *  - `deptConversationIds` (wide, additive registry) decides whether a file may
 *    MOVE to the personal vault — the same source `moveBytesToVault` reads.
 *
 * They are kept separate here because reading the narrow one for the affordance
 * gates made them disagree with the refusal on first paint and whenever the
 * membership fetch failed.
 */

jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({
    conversations: {
      'conv-channel': {id: 'conv-channel', name: 'Board'},
      'conv-dm': {id: 'conv-dm', name: 'Alice'},
    },
    messages: {},
    deptConversationIds: mockDeptConversationIds.value,
    removeMessage: jest.fn(),
  }),
  selectMediaMessages: () => [mockCompanyMsg, mockPersonalMsg, mockCompanyVideo, mockCompanyVideoAsFile],
}));

import FilesScreen from '../FilesScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockCompanyConvIds.mockReturnValue(new Set(['conv-channel']));
  mockDeptConversationIds.value = {'conv-channel': true};
});

describe('FilesScreen scopes itself to the company shelf inside the workspace', () => {
  /**
   * `bucketFor` had no `video` branch while `selectMediaMessages` includes
   * `type === 'video'` (MSG-13), so videos were dropped from this screen —
   * meaning a video posted in a department channel was invisible on the
   * workspace Vault tab while the Company shelf listed it. Two Phase 4 surfaces
   * disagreeing about the same scope.
   */
  it('lists a company VIDEO, so the two company surfaces agree', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText} = render(<FilesScreen />);
    // Both video shapes: `type: 'video'` and `type: 'file'` with a video mime.
    // They reach the same bucket by different branches.
    expect(await findByText('SITE-WALKTHROUGH.mp4')).toBeTruthy();
    expect(await findByText('HANDOVER.mov')).toBeTruthy();
  });

  it('INSIDE the departmental shell it lists company files only', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText, queryByText} = render(<FilesScreen />);
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    // THE RULE — a personal conversation's file must not appear on the
    // workspace Vault tab.
    expect(queryByText('HOLIDAY-SNAP.pdf')).toBeNull();
  });

  it('OUTSIDE it the personal Files browser keeps its full scope', async () => {
    mockInShell.mockReturnValue(false);
    const {findByText} = render(<FilesScreen />);
    expect(await findByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
  });

  /**
   * The row shield must not be offered on a file the vault will refuse. Inside
   * the workspace shell EVERY row is a company row, so leaving it there was a
   * dead affordance on 100% of the list — and the refusal message is the only
   * thing the user would ever get from it.
   */
  it('a COMPANY row offers no Move-to-vault shield', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText, queryByLabelText} = render(<FilesScreen />);
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    expect(queryByLabelText('Move to vault')).toBeNull();
  });

  it('a PERSONAL row keeps its shield', async () => {
    // The suppression must be scoped to company rows, not applied everywhere.
    mockInShell.mockReturnValue(false);
    const {findByText, findAllByLabelText} = render(<FilesScreen />);
    expect(await findByText('HOLIDAY-SNAP.pdf')).toBeTruthy();
    const shields = await findAllByLabelText('Move to vault');
    // Only the DM row — the two company rows are still suppressed by
    // membership, even though this screen is outside the shell.
    expect(shields).toHaveLength(1);
  });

  /**
   * The promo card told the user to "tap the shield on any row" — on the
   * workspace Vault tab no row has one any more. It is the consumer of the
   * affordance the shield gating removed, which is the question CLAUDE.md
   * change-safety rule 8 asks about every deletion.
   */
  it('the vault promo does not instruct an impossible action', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText, queryByText} = render(<FilesScreen />);
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    expect(queryByText(/Tap the shield on any row/)).toBeNull();
    expect(await findByText(/Company files stay in your workspace/)).toBeTruthy();
  });

  it('...and still gives the instruction when a pushable row exists', async () => {
    mockInShell.mockReturnValue(false);       // personal browser: the DM row can move
    const {findByText} = render(<FilesScreen />);
    expect(await findByText(/Tap the shield on any row/)).toBeTruthy();
  });

  /**
   * The bucket, not just the presence. A `type: 'file'` with a video mime falls
   * through to `docs` when the video branch is broken, so it still RENDERS —
   * asserting it appears at all cannot see the regression. Assert it appears
   * under VID.
   */
  it('a video-mime file buckets as VID, not as a document', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText, queryByText} = render(<FilesScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByText('VID'));
    expect(await findByText('HANDOVER.mov')).toBeTruthy();
    expect(await findByText('SITE-WALKTHROUGH.mp4')).toBeTruthy();
    // ...and the PDF is not in that bucket.
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
  });

  /**
   * The batch lane is the same dead affordance as the row shield, and it costs
   * more: `runBatchVaultMove` RESOLVES BYTES FIRST (download + AES-decrypt per
   * file) and only then hits the refusal — so an all-company selection would
   * download everything to report "0 of N moved". Inside the workspace shell
   * that is the entire list.
   */
  it('an ALL-COMPANY selection offers no batch Vault action', async () => {
    mockInShell.mockReturnValue(true);
    const {findByText, findByLabelText, queryByLabelText} = render(<FilesScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent(await findByText('BOARD-MINUTES.pdf'), 'longPress');
    // BatchAction exposes its label via accessibilityLabel, not a Text node.
    // Selection mode is open — Share is offered…
    expect(await findByLabelText('Share')).toBeTruthy();
    // …but Vault is not, because nothing selected could move.
    expect(queryByLabelText('Vault')).toBeNull();
  });

  it('a selection containing a PERSONAL row keeps the batch Vault action', async () => {
    // Mixed selections must still offer it; the company rows fail individually.
    mockInShell.mockReturnValue(false);
    const {findByText, findByLabelText} = render(<FilesScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent(await findByText('HOLIDAY-SNAP.pdf'), 'longPress');
    expect(await findByLabelText('Vault')).toBeTruthy();
  });

  /**
   * R7-B2 — a GENUINELY MIXED selection. The previous "keeps the batch Vault
   * action" case long-pressed only the personal row, which satisfies `.some`
   * AND `.every` — so swapping the predicate survived. Under `.every` a user
   * could not vault their own personal file merely because a company file was
   * also selected.
   */
  it('a MIXED selection still offers the batch Vault action', async () => {
    mockInShell.mockReturnValue(false);
    const {findByText, findByLabelText} = render(<FilesScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent(await findByText('HOLIDAY-SNAP.pdf'), 'longPress');   // personal
    fireEvent.press(await findByText('BOARD-MINUTES.pdf'));         // + company
    expect(await findByLabelText('Vault')).toBeTruthy();
  });

  /**
   * R7-B3 — the affordance gates must read the WIDE registry, not the narrow
   * server list. Outside the shell, a failed membership fetch empties the
   * narrow list; if the gates read it, every company row gets its shield back
   * and disagrees with the viewer that opens from it.
   */
  it('a failed membership fetch does NOT restore the shield on company rows', async () => {
    mockInShell.mockReturnValue(false);
    mockCompanyConvIds.mockReturnValue(new Set());          // fetch failed / first paint
    mockDeptConversationIds.value = {'conv-channel': true}; // registry still knows
    const {findByText, findAllByLabelText} = render(<FilesScreen />);
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    const shields = await findAllByLabelText('Move to vault');
    // Only the DM row — the company rows stay suppressed on the registry.
    expect(shields).toHaveLength(1);
  });

  it('a revoked membership empties the workspace tab, not just reorders it', async () => {
    mockInShell.mockReturnValue(true);
    mockCompanyConvIds.mockReturnValue(new Set());
    const {queryByText} = render(<FilesScreen />);
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
    expect(queryByText('HOLIDAY-SNAP.pdf')).toBeNull();
  });
});
