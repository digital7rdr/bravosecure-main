/**
 * Mention-aware banners, and the retracted-message banner leak.
 *
 * Two properties that only the notifier can hold:
 *   1. "X mentioned you" is the one signal worth surfacing above a generic
 *      group banner — including when previews are OFF, where being mentioned
 *      would otherwise be indistinguishable from any other message.
 *   2. The notification shade is the ONE surface the store cannot repaint. A
 *      banner posted before a delete-for-everyone keeps rendering the retracted
 *      text until the user swipes it away, so the retraction has to reach it.
 *
 * Deliberately pinned NEGATIVE: a mention does NOT pierce mute. This codebase
 * treats mute as a hard contract (M-04 for banners, BS-MUTE-UNREAD for badges);
 * "mentions pierce mute" is a product decision with its own setting, and if it
 * is ever added this test is where the decision gets recorded.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  AppState: {
    currentState: 'background',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'bravo-messages'),
    deleteChannel:       jest.fn(async () => {}),
    onForegroundEvent:   jest.fn(),
    onBackgroundEvent:   jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

import {AppState} from 'react-native';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {
  startBackgroundMessageNotifier,
  stopBackgroundMessageNotifier,
  setContentPreviewEnabled,
} from '../push/backgroundMessageNotifier';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

const flush = async () => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

const OWNER = 'owner-1';

function groupConv(id: string, extra?: Partial<LocalConversation>): LocalConversation {
  return {
    id,
    type:          'group',
    name:          'Ops Team',
    participants:  [OWNER, 'peer-1', 'peer-2'],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date('2026-07-01T00:00:00Z').toISOString(),
    peer:          {userId: '', deviceId: 0},
    session_state: 'established',
    ...extra,
  } as LocalConversation;
}

function inbound(id: string, conversationId: string, extra?: Partial<LocalMessage>): LocalMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_id:       'peer-1',
    type:            'text',
    content:         'body text',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-07-25T10:00:00Z').toISOString(),
    peer:            {userId: 'peer-1', deviceId: 1},
    ...extra,
  } as LocalMessage;
}

const MENTION_ME = [{userId: OWNER, label: 'Me'}];

beforeEach(() => {
  jest.clearAllMocks();
  (AppState as unknown as {currentState: string}).currentState = 'background';
  useMessengerStore.getState().reset();
  useMessengerStore.getState().setOwner(OWNER);
  // The AUTH uuid is what participants and mentions are keyed on.
  useMessengerStore.setState({_ownAuthUserId: OWNER} as never);
});

afterEach(() => { stopBackgroundMessageNotifier(); });

describe('"X mentioned you"', () => {
  it('prefixes the banner when the message mentions me', () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    useMessengerStore.setState({groupMemberNames: {g1: {'peer-1': 'Alice'}}} as never);
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {
      content: 'hey @Me look at this', mentions: MENTION_ME,
    }));
    return flush().then(() => {
      expect(display).toHaveBeenCalledTimes(1);
      expect(display.mock.calls[0][0].body).toBe('Alice mentioned you: hey @Me look at this');
    });
  });

  it('falls back to "You were mentioned" when the sender name has not resolved', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {mentions: MENTION_ME}));
    await flush();
    expect(display.mock.calls[0][0].body).toContain('You were mentioned');
  });

  it('surfaces the mention even with previews OFF — and still leaks no content', async () => {
    // With previews off there is no body at all, so without this the one
    // message actually addressed to you looks like every other one.
    setContentPreviewEnabled(false);
    try {
      useMessengerStore.getState().upsertConversation(groupConv('g1'));
      useMessengerStore.setState({groupMemberNames: {g1: {'peer-1': 'Alice'}}} as never);
      startBackgroundMessageNotifier();
      useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {
        content: 'super secret plaintext', mentions: MENTION_ME,
      }));
      await flush();
      const arg = display.mock.calls[0][0];
      expect(arg.body).toBe('Alice mentioned you');
      expect(JSON.stringify(arg)).not.toContain('super secret plaintext');
    } finally {
      setContentPreviewEnabled(true);
    }
  });

  it('does NOT prefix when the mention is of someone else', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {
      mentions: [{userId: 'peer-2', label: 'Bob'}],
    }));
    await flush();
    expect(display.mock.calls[0][0].body).toBe('body text');
  });

  it('does NOT prefix an ordinary message with no mentions', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display.mock.calls[0][0].body).toBe('body text');
  });

  it('DOCUMENTS THE DECISION: a mention does NOT pierce mute', async () => {
    // If a "mentions pierce mute" setting is ever added, flip this assertion
    // and say so in the commit — do not delete it.
    useMessengerStore.getState().upsertConversation(groupConv('g1', {is_muted: true}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {mentions: MENTION_ME}));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });
});

describe('a retracted message must not survive on the lock screen', () => {
  it('dismisses the banner when the message is deleted for everyone', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    cancel.mockClear();
    useMessengerStore.getState().applyDeleteForEveryone('g1', 'm1');
    await flush();
    expect(cancel).toHaveBeenCalled();
  });

  it('does NOT re-notify for the tombstone itself', async () => {
    // The id is unchanged, so the seen-id watermark (M16/W29) already covers
    // this — but a future change to that watermark must not quietly turn a
    // retraction into a fresh banner.
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    display.mockClear();

    useMessengerStore.getState().applyDeleteForEveryone('g1', 'm1');
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('does NOT re-notify for an EDIT either', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    display.mockClear();

    useMessengerStore.getState().applyMessageEdit('g1', 'm1', 'corrected body', Date.now());
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('does not dismiss anything when no banner was posted for that chat', async () => {
    // The dismiss is scoped to conversations that actually have a live banner,
    // so an unrelated retraction cannot clear someone else's notification.
    useMessengerStore.getState().upsertConversation(groupConv('g1', {is_muted: true}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    cancel.mockClear();

    useMessengerStore.getState().applyDeleteForEveryone('g1', 'm1');
    await flush();
    expect(cancel).not.toHaveBeenCalled();
  });
});
