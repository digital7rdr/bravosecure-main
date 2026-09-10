/**
 * Scope v2 Phase 4, R4-B2 — the AUTOMATIC company-file suppression in
 * `FileViewer`, mounted for real.
 *
 * `showVaultActions = allowVaultActions && !isCompanyFile` is the clause that
 * protects the three surfaces which pass no prop at all — ChatScreen, the
 * FilesScreen row tap, and DepartmentChatScreen. Deleting `!isCompanyFile`
 * survived BOTH full projects, because every other suite mocks FileViewer or
 * AttachmentFileViewer away. A stub cannot see what the real component decides
 * — the same lesson that hid B1 in round 1, one level down.
 *
 * Why it matters even though `moveBytesToVault` refuses: Move would then fail
 * honestly, but DELETE would LIE. It calls `removeFromVault('msg:<id>')`, which
 * matches no personal vault row, and tells the user the file was removed from
 * the device.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

const mockIsDept = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://x.invalid', MSG_BASE_URL: 'https://y.invalid'}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('react-native-gesture-handler', () => ({GestureHandlerRootView: 'GestureHandlerRootView'}));
jest.mock('@/modules/messenger/ui/ZoomableImage', () => ({ZoomableImage: 'ZoomableImage'}));
jest.mock('expo-audio', () => ({useAudioPlayer: () => ({}), useAudioPlayerStatus: () => ({})}));
jest.mock('expo-video', () => ({useVideoPlayer: () => ({}), VideoView: 'VideoView'}));
jest.mock('expo-sharing', () => ({isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn()}));
jest.mock('react-native-file-viewer', () => ({open: jest.fn()}));
jest.mock('@/modules/messenger/media', () => ({readUriBytes: jest.fn()}));
jest.mock('@utils/haptics', () => ({haptics: {tap: jest.fn(), impact: jest.fn()}}));
jest.mock('@/modules/messenger/ui/vaultMoveAction', () => ({resolveVaultMoveAction: () => ({kind: 'move'})}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: {}})}}));
jest.mock('@store/entitlements', () => ({
  deriveEntitlements: () => ({hasCloudVault: true}),
  showTierUpgradePrompt: jest.fn(),
}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn()}));
jest.mock('@/modules/messenger/vault', () => ({
  // albumState mirrors the real store shape — B-592's album picker subscribes
  // to it, and a mock that models less than the store is the documented trap.
  useVaultStore: (sel: (s: unknown) => unknown) =>
    sel({files: [], removeFile: jest.fn(), albumState: {albums: [], assignments: {}}}),
  moveBytesToVault: jest.fn(),
  findVaultRow: () => null,
  isDepartmentConversation: (id: string) => mockIsDept(id),
}));

import {FileViewer, type ViewableFile} from '@/modules/messenger/ui/FileViewer';

const file = (over: Partial<ViewableFile> = {}): ViewableFile => ({
  id: 'm1', conversationId: 'conv-x', name: 'doc.pdf', uri: 'file:///tmp/doc.pdf',
  mimeType: 'application/pdf', size: 10, createdAt: 1, ...over,
});

beforeEach(() => { jest.clearAllMocks(); mockIsDept.mockReturnValue(false); });

describe('FileViewer suppresses vault actions on a company file, for every caller', () => {
  it('a PERSONAL file keeps Move to Vault and Delete', () => {
    const {queryByText} = render(<FileViewer file={file()} onClose={jest.fn()} />);
    expect(queryByText('Move to Vault')).toBeTruthy();
    expect(queryByText('Delete')).toBeTruthy();
    expect(queryByText('Share')).toBeTruthy();
  });

  /** THE CLAUSE. No prop is passed — this is the ChatScreen / FilesScreen /
   *  DepartmentChatScreen shape. */
  it('a COMPANY file loses them WITHOUT the caller passing any prop', () => {
    mockIsDept.mockReturnValue(true);
    const {queryByText} = render(<FileViewer file={file()} onClose={jest.fn()} />);
    expect(queryByText('Move to Vault')).toBeNull();
    expect(queryByText('Delete')).toBeNull();
    // Share stays — reading out a file you can already open is the same
    // capability the channel thread gives you.
    expect(queryByText('Share')).toBeTruthy();
  });

  it('the decision is keyed on the file\'s conversation', () => {
    mockIsDept.mockReturnValue(true);
    render(<FileViewer file={file({conversationId: 'conv-dept'})} onClose={jest.fn()} />);
    expect(mockIsDept).toHaveBeenCalledWith('conv-dept');
  });

  it('a file with NO conversation is never treated as company', () => {
    // A personal vault row passes null; it must not be probed or suppressed.
    const {queryByText} = render(<FileViewer file={file({conversationId: null})} onClose={jest.fn()} />);
    expect(mockIsDept).not.toHaveBeenCalled();
    expect(queryByText('Move to Vault')).toBeTruthy();
  });

  it('the explicit prop still suppresses, independently of the conversation', () => {
    // The Vault screen's Company shelf passes allowVaultActions={false}; the two
    // guards are belt and braces, and neither may depend on the other.
    const {queryByText} = render(
      <FileViewer file={file()} onClose={jest.fn()} allowVaultActions={false} />);
    expect(queryByText('Move to Vault')).toBeNull();
    expect(queryByText('Delete')).toBeNull();
  });
});
