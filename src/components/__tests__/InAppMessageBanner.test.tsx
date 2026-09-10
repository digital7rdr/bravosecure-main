/**
 * B-692 S-3 — the in-app message banner host.
 *
 * Pins: event → visible card; tap navigates ONCE through the cross-shell
 * messenger door (never a bare navigate) with a synchronous repeat guard;
 * department conversations land on the departmental surface; auto-dismiss;
 * opening the thread by another door retires the banner.
 */
import React from 'react';
import {render, fireEvent, act} from '@testing-library/react-native';

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 20, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true},
  mountedTreeHasRoute: () => true,
}));

const mockNavigate = jest.fn(() => true);
jest.mock('@navigation/messengerDeepLink', () => ({
  navigateToMessengerScreen: (...a: unknown[]) => mockNavigate(...(a as [])),
}));

const mockResolveDept = jest.fn((): {channelId?: string; orgId?: string} | null => null);
jest.mock('@/modules/messenger/push/deptChannelTarget', () => ({
  resolveDeptConversation: () => mockResolveDept(),
}));

jest.mock('@/modules/messenger/store', () => {
  const {create} = jest.requireActual('zustand');
  const useMessengerStore = create(() => ({activeConversationId: null as string | null}));
  return {useMessengerStore};
});

// Keep the audio/haptic cues inert — this suite is about the card.
jest.mock('../../modules/messenger/runtime/messageTone', () => ({
  __esModule: true,
  playMessageTone: jest.fn(async () => true),
}));
jest.mock('../../utils/haptics', () => ({
  __esModule: true,
  haptics: {tap: jest.fn(), select: jest.fn(), impact: jest.fn(), heavy: jest.fn()},
}));

import {InAppMessageBanner, BANNER_AUTO_DISMISS_MS} from '../InAppMessageBanner';
import {notifyForegroundMessage} from '@/modules/messenger/push/inAppMessageNotifier';
import {useMessengerStore} from '@/modules/messenger/store';

const emit = (over?: Partial<Parameters<typeof notifyForegroundMessage>[0]>) =>
  notifyForegroundMessage({
    conversationId: 'c1',
    title: 'Ops Team',
    body: 'On my way',
    senderName: 'Alice',
    isGroup: true,
    inActiveThread: false,
    ...over,
  });

describe('InAppMessageBanner (B-692 S-3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockResolveDept.mockReturnValue(null);
    (useMessengerStore as unknown as {setState: (s: object) => void})
      .setState({activeConversationId: null});
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing until an event arrives, then shows title + sender-prefixed body', () => {
    const {queryByTestId, getByText} = render(<InAppMessageBanner />);
    expect(queryByTestId('in-app-msg-banner')).toBeNull();
    act(() => { emit(); });
    expect(getByText('Ops Team')).toBeTruthy();
    expect(getByText('Alice: On my way')).toBeTruthy();
  });

  it('an active-thread cue never reaches the banner (routed upstream as tone-only)', () => {
    const {queryByTestId} = render(<InAppMessageBanner />);
    act(() => { emit({inActiveThread: true}); });
    expect(queryByTestId('in-app-msg-banner')).toBeNull();
  });

  it('tap opens the conversation through the cross-shell door, and a mashed second tap is dropped', () => {
    const {getByTestId} = render(<InAppMessageBanner />);
    act(() => { emit(); });
    const card = getByTestId('in-app-msg-banner');
    fireEvent.press(card);
    fireEvent.press(card);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.anything(),
      'Chat',
      expect.objectContaining({conversationId: 'c1', name: 'Ops Team', isGroup: true}),
      {initial: false},
    );
  });

  it('a department conversation lands on DepartmentChat, never ChatScreen', () => {
    mockResolveDept.mockReturnValue({channelId: 'ch-7', orgId: 'org-1'});
    const {getByTestId} = render(<InAppMessageBanner />);
    act(() => { emit(); });
    fireEvent.press(getByTestId('in-app-msg-banner'));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.anything(),
      'DepartmentChat',
      expect.objectContaining({channelId: 'ch-7', groupConversationId: 'c1'}),
      {initial: false},
    );
  });

  it('auto-dismisses after BANNER_AUTO_DISMISS_MS', () => {
    const {queryByTestId} = render(<InAppMessageBanner />);
    act(() => { emit(); });
    expect(queryByTestId('in-app-msg-banner')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(BANNER_AUTO_DISMISS_MS + 1000); });
    expect(queryByTestId('in-app-msg-banner')).toBeNull();
  });

  it('opening the thread by another door retires its banner', () => {
    const {queryByTestId} = render(<InAppMessageBanner />);
    act(() => { emit(); });
    expect(queryByTestId('in-app-msg-banner')).toBeTruthy();
    act(() => {
      (useMessengerStore as unknown as {setState: (s: object) => void})
        .setState({activeConversationId: 'c1'});
    });
    act(() => { jest.advanceTimersByTime(1000); });
    expect(queryByTestId('in-app-msg-banner')).toBeNull();
  });
});
