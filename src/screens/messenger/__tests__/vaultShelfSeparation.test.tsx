/**
 * Scope v2 Phase 4 — "two shelves in the same cupboard: personal files and
 * company files, NEVER MIXED", at the render level.
 *
 * `companyShelfScope.test.ts` proves the derivation is correctly scoped. This
 * file proves the SCREEN cannot show one shelf's files while claiming the
 * other — which is the part a pure-function test cannot see, and the part that
 * would actually leak a company file into a personal list.
 *
 * It also pins the no-redesign rule: a personal account must see this screen
 * exactly as it was before Phase 4, with no shelf switch at all.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

const mockEntitlements = jest.fn();
const mockListChannels = jest.fn();
const mockCompanyFiles = jest.fn();
const mockVaultFiles = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), replace: jest.fn(), goBack: jest.fn(), isFocused: () => true}),
  useFocusEffect: (cb: () => void | (() => void)) => { const R = require('react'); R.useEffect(() => cb(), []); },
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@store/entitlements', () => ({useEntitlements: () => mockEntitlements()}));
jest.mock('@services/api', () => ({departmentApi: {listChannels: () => mockListChannels()}}));
jest.mock('@/modules/messenger/vault/useCompanyShelf', () => ({useCompanyShelf: () => mockCompanyFiles()}));
jest.mock('@/modules/messenger/media', () => ({
  readUriBytes: jest.fn(), resolveAttachmentFileUri: jest.fn(async () => 'file:///tmp/x'),
}));
/**
 * NOT stubbed to `() => null`.
 *
 * The first version of this file did exactly that, and it hid a real defect:
 * FileViewer's `vaultHandle` falls back to `msg:<id>` when `vaultSourceKey` is
 * absent, so the action bar rendered anyway and "Move to Vault" copied a
 * company file into the PERSONAL shelf — two taps to break this phase's
 * headline rule, with a comment in VaultScreen asserting the opposite. A stub
 * cannot see what the real component decides.
 *
 * This records the props the screen passes AND the labels the real bar would
 * show, so both halves of the decision are pinned.
 */
const mockViewerProps = jest.fn();
jest.mock('@/modules/messenger/ui/FileViewer', () => {
  const {Text, View} = require('react-native');
  const R = require('react');
  return {
    FileViewer: (props: {file: unknown; allowVaultActions?: boolean}) => {
      mockViewerProps(props);
      if (!props.file) {return null;}
      // Mirror the real bar's own condition (FileViewer.tsx): Share always,
      // Move-to-Vault and Delete only when vault actions are allowed.
      const allow = props.allowVaultActions !== false;
      return R.createElement(View, null,
        allow ? R.createElement(Text, null, 'Move to Vault') : null,
        R.createElement(Text, null, 'Share'),
        allow ? R.createElement(Text, null, 'Delete') : null,
      );
    },
  };
});
jest.mock('react-native-image-picker', () => ({launchImageLibrary: jest.fn(), launchCamera: jest.fn()}));
jest.mock('expo-document-picker', () => ({getDocumentAsync: jest.fn()}));
jest.mock('@utils/haptics', () => ({haptics: {impact: jest.fn(), selection: jest.fn()}}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
// The store is selector-based AND exposes getState() for the lock guard.
jest.mock('@/modules/messenger/vault', () => {
  const state = {
    get files() { return mockVaultFiles(); },
    removeFile: jest.fn(),
    isUnlocked: () => true,
    // The gate subscribes to this to re-run when the lock deadline moves.
    unlockedUntil: Date.now() + 5 * 60_000,
    // Vault albums (founder 2026-08-08). Present so the screen's album bar can
    // render; kept EMPTY so every assertion below still describes the shelf
    // separation and nothing else. The albums themselves are covered by
    // `modules/messenger/__tests__/vaultAlbumReset.test.ts` and
    // `screens/messenger/__tests__/albumWiring.test.ts`.
    albumState: {albums: [], assignments: {}},
    createVaultAlbum: jest.fn(() => ({id: 'a1', error: null})),
    renameVaultAlbum: jest.fn(() => null),
    deleteVaultAlbum: jest.fn(() => null),
    moveToVaultAlbum: jest.fn(() => null),
  };
  const useVaultStore = (sel: (s: unknown) => unknown) => sel(state);
  useVaultStore.getState = () => state;
  return {
    useVaultStore,
    vaultHydrated: () => true,
    vaultPersistApi: () => undefined,
    moveBytesToVault: jest.fn(),
    // Must RESOLVE: the personal open path awaits this and only sets the
    // viewer on `{ok: true}`. Returning undefined left the viewer null and made
    // the personal-actions case fail for a fixture reason rather than a real
    // one — the invented-payload trap again.
    openVaultFileUri: jest.fn(async () => ({ok: true, uri: 'file:///tmp/personal'})),
  };
});

import VaultScreen from '../VaultScreen';

const PERSONAL = {
  objectKey: 'vault/u1/aaa', keyB64: 'k', ivB64: 'i',
  name: 'MY-PAYSLIP.pdf', size: 100, mimeType: 'application/pdf', createdAt: 1,
};
const COMPANY = {
  objectKey: 'obj-co', keyB64: 'k', ivB64: 'i',
  name: 'BOARD-MINUTES.pdf', size: 200, mimeType: 'application/pdf', createdAt: 2,
  channelId: 'ch-1', channelName: 'Board', messageId: 'm1',
  // Real provenance. Omitting it made the screen pass `undefined` here, which
  // is part of why a `conversationId: null` mutation survived this suite.
  conversationId: 'conv-company',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListChannels.mockResolvedValue({data: {channels: []}});
  mockVaultFiles.mockReturnValue([PERSONAL]);
  mockCompanyFiles.mockReturnValue([COMPANY]);
});

describe('the two shelves are never shown together', () => {
  it('an ORG member defaults to Personal and sees ONLY personal files', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByText, queryByText} = render(<VaultScreen />);
    expect(await findByText('MY-PAYSLIP.pdf')).toBeTruthy();
    // THE RULE. A company file must not appear in the personal shelf.
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
  });

  it('switching to Company shows ONLY company files', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText, queryByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    // ...and the personal file is gone. Not filtered — a different list.
    expect(queryByText('MY-PAYSLIP.pdf')).toBeNull();
  });

  it('the company row names the channel it came from', async () => {
    // Provenance is how a member can tell which channel's permissions govern
    // the file; without it the shelf is an unattributable pile.
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText(/Board/)).toBeTruthy();
  });

  /**
   * NO REDESIGN. The PDF forbids redesigning the Vault, and a personal account
   * has no company shelf — so they must not get a switch, not even a
   * single-option one.
   */
  it('a NON-org account sees no shelf switch at all', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: false});
    const {findByText, queryByLabelText} = render(<VaultScreen />);
    expect(await findByText('MY-PAYSLIP.pdf')).toBeTruthy();
    expect(queryByLabelText('Company files')).toBeNull();
    expect(queryByLabelText('Personal files')).toBeNull();
  });

  it('a non-org account can never reach company files, even if some resolve', async () => {
    // Defence in depth: if the hook ever returned rows for a non-member, the
    // screen still has no path to render them.
    mockEntitlements.mockReturnValue({isOrgAffiliated: false});
    mockCompanyFiles.mockReturnValue([COMPANY]);
    const {findByText, queryByText} = render(<VaultScreen />);
    expect(await findByText('MY-PAYSLIP.pdf')).toBeTruthy();
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
  });

  /**
   * The EMPTY STATES belong to their own shelf too.
   *
   * With a non-empty personal vault this can never be seen, which is exactly
   * why it was missed: dropping the `shelf === 'Personal'` guard from the
   * personal empty state survived every other test here. An org member whose
   * personal vault is empty would then be told "Your vault is empty" while
   * looking at a company shelf full of files.
   */
  it('the PERSONAL empty state never renders on the Company shelf', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    mockVaultFiles.mockReturnValue([]);                 // empty personal vault
    mockCompanyFiles.mockReturnValue([COMPANY]);
    const {findByLabelText, findByText, queryByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    expect(queryByText('Your vault is empty')).toBeNull();
  });

  it('the COMPANY empty state never renders on the Personal shelf', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    mockVaultFiles.mockReturnValue([PERSONAL]);
    mockCompanyFiles.mockReturnValue([]);
    const {findByText, queryByText} = render(<VaultScreen />);
    expect(await findByText('MY-PAYSLIP.pdf')).toBeTruthy();
    expect(queryByText('No company files yet')).toBeNull();
  });

  /**
   * B1/B2 — the viewer must not offer to move a COMPANY file into the personal
   * vault, nor claim to delete a file the vault cannot touch.
   */
  it('opening a COMPANY file offers no vault actions', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText, queryByText} = render(<VaultScreen />);
    const {fireEvent, waitFor: wf} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    fireEvent.press(await findByLabelText(`${COMPANY.name}, from ${COMPANY.channelName}`));

    await wf(() => {
      const last = mockViewerProps.mock.calls[mockViewerProps.mock.calls.length - 1][0];
      expect(last.file).toBeTruthy();
      expect(last.allowVaultActions).toBe(false);
    });
    // ...and the bar really drops them, rather than the flag being cosmetic.
    expect(await findByText('Share')).toBeTruthy();
    expect(queryByText('Move to Vault')).toBeNull();
    expect(queryByText('Delete')).toBeNull();
  });

  it('opening a PERSONAL file keeps its vault actions', async () => {
    // The suppression must be scoped to the company shelf — otherwise the fix
    // would quietly remove Move/Delete from the personal vault too.
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByText} = render(<VaultScreen />);
    const {fireEvent, waitFor: wf} = require('@testing-library/react-native');
    fireEvent.press(await findByText('MY-PAYSLIP.pdf'));
    await wf(() => {
      const last = mockViewerProps.mock.calls[mockViewerProps.mock.calls.length - 1][0];
      expect(last.file).toBeTruthy();
      expect(last.allowVaultActions).not.toBe(false);
    });
    expect(await findByText('Move to Vault')).toBeTruthy();
    expect(await findByText('Delete')).toBeTruthy();
  });

  /**
   * The UPLOAD button was a fourth mixing path: it always writes to the
   * PERSONAL vault, but rendered on both shelves. (The empty-state CTA was
   * already gated; the header one was not.)
   */
  it('the upload button does not render on the Company shelf', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText, queryByLabelText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    // Present on Personal…
    expect(await findByLabelText('Upload file')).toBeTruthy();
    fireEvent.press(await findByLabelText('Company files'));
    await findByText('BOARD-MINUTES.pdf');
    // …and gone on Company.
    expect(queryByLabelText('Upload file')).toBeNull();
  });

  /**
   * Chrome must describe the shelf on screen. A hard-coded "Personal Vault"
   * title over company files, and a banner promising a per-file MFA proof that
   * the company path deliberately does not perform, are the audit-S1 overclaim
   * class this screen's own comments warn about.
   */
  it('the header and the encryption banner follow the shelf', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText, queryByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    expect(await findByText('Personal Vault')).toBeTruthy();
    expect(await findByText(/fresh MFA proof/)).toBeTruthy();

    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('Company Vault')).toBeTruthy();
    expect(queryByText('Personal Vault')).toBeNull();
    // The company shelf must NOT claim a per-file MFA proof.
    expect(queryByText(/fresh MFA proof/)).toBeNull();
    expect(await findByText(/members only/)).toBeTruthy();
  });

  /**
   * R5-B3 — the shelf is DERIVED (`hasCompanyShelf ? shelfPref : 'Personal'`),
   * so losing org affiliation collapses it. Without that, the switch vanished
   * while the company branch kept rendering under a "Company Vault" header,
   * with no route back to Personal.
   *
   * A fresh mount always starts on Personal, so this needs the
   * switch-then-revoke-then-rerender shape — the same blind spot that hid the
   * fail-closed clear twice.
   */
  it('losing org affiliation collapses the shelf back to Personal', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    const {findByLabelText, findByText, queryByText, rerender} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();

    // Affiliation revoked while the Company shelf is open.
    mockEntitlements.mockReturnValue({isOrgAffiliated: false});
    rerender(<VaultScreen />);

    // Back on Personal, with the personal content and header — not stranded on
    // a company shelf whose switch has disappeared.
    expect(await findByText('MY-PAYSLIP.pdf')).toBeTruthy();
    expect(await findByText('Personal Vault')).toBeTruthy();
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();
    expect(queryByText('Company Vault')).toBeNull();
  });

  /**
   * The All/Images/Documents/Audio tabs render on the Company shelf but the
   * company list ignored `activeTab` entirely — tapping "Images" moved the
   * active underline and changed nothing. A control that gives positive
   * feedback for a no-op is worse than a dead one.
   */
  it('the type tabs actually filter the Company shelf', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    mockCompanyFiles.mockReturnValue([
      COMPANY,                                                   // application/pdf
      {...COMPANY, objectKey: 'obj-img', name: 'SITE.jpg', mimeType: 'image/jpeg'},
    ]);
    const {findByLabelText, findByText, queryByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    // All → both.
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    expect(await findByText('SITE.jpg')).toBeTruthy();

    fireEvent.press(await findByText('Images'));
    expect(await findByText('SITE.jpg')).toBeTruthy();
    expect(queryByText('BOARD-MINUTES.pdf')).toBeNull();

    fireEvent.press(await findByText('Documents'));
    expect(await findByText('BOARD-MINUTES.pdf')).toBeTruthy();
    expect(queryByText('SITE.jpg')).toBeNull();
  });

  /**
   * The COUNT and the EMPTY STATE must come from the same derived list as the
   * rows. They were three separate reads, so the Images tab could read
   * "Company · 5" over a single row, and a tab with no matches rendered a
   * section header above an empty container with no empty state.
   */
  it('the company count and empty state follow the active tab', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    mockCompanyFiles.mockReturnValue([
      COMPANY,
      {...COMPANY, objectKey: 'obj-b', name: 'HANDBOOK.pdf'},
      {...COMPANY, objectKey: 'obj-img', name: 'SITE.jpg', mimeType: 'image/jpeg'},
    ]);
    const {findByLabelText, findByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('Company · 3')).toBeTruthy();

    fireEvent.press(await findByText('Images'));
    expect(await findByText('Company · 1')).toBeTruthy();

    // A tab with NO matches gets the empty state, not a header over nothing.
    fireEvent.press(await findByText('Audio'));
    expect(await findByText('No company files yet')).toBeTruthy();
  });

  it('an org member with an empty company shelf gets an honest empty state', async () => {
    mockEntitlements.mockReturnValue({isOrgAffiliated: true});
    mockCompanyFiles.mockReturnValue([]);
    const {findByLabelText, findByText} = render(<VaultScreen />);
    const {fireEvent} = require('@testing-library/react-native');
    fireEvent.press(await findByLabelText('Company files'));
    expect(await findByText('No company files yet')).toBeTruthy();
    // ...and it says the two shelves are separate, which is the product rule.
    expect(await findByText(/separate from your\s+personal vault/)).toBeTruthy();
  });
});
