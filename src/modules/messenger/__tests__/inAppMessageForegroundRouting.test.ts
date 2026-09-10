/**
 * B-692 S-3/S-5b — foreground routing for message notifications.
 *
 * While the app is FOREGROUNDED the store notifier must route a fresh
 * committed inbound message to the IN-APP layer (banner event + receive tone
 * + haptic) instead of notifee — the old blanket bail produced zero feedback
 * with the app open. Pins:
 *   - foreground event → in-app banner listener, notifee display NEVER called;
 *   - active-thread arrival → subtle in-chat tone only, no banner event;
 *   - muted conversation → silent on the foreground lane too;
 *   - M16 holds on this lane: a rolled-back receive txn emits nothing;
 *   - W29 seen-set is still maintained foregrounded — messages seen in-app do
 *     NOT banner when the app next backgrounds (the B-132 class in reverse);
 *   - the background notifee lane is unchanged (control).
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
    currentState: 'active',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
}));

jest.mock('../contacts/directoryNames', () => ({
  __esModule: true,
  ensureDirectoryNames: jest.fn(),
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

// Observe the audio/haptic cues without pulling expo-av into the node VM.
jest.mock('../runtime/messageTone', () => ({
  __esModule: true,
  playMessageTone: jest.fn(async () => true),
}));
jest.mock('../../../utils/haptics', () => ({
  __esModule: true,
  haptics: {tap: jest.fn(), select: jest.fn(), impact: jest.fn(), heavy: jest.fn()},
}));

import {AppState} from 'react-native';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {
  startBackgroundMessageNotifier,
  stopBackgroundMessageNotifier,
  getMessagePostedGeneration,
} from '../push/backgroundMessageNotifier';
import {setInAppMessageBannerListener, type InAppMessageEvent} from '../push/inAppMessageNotifier';
import {playMessageTone} from '../runtime/messageTone';
import {haptics} from '../../../utils/haptics';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const tone = playMessageTone as jest.Mock;
const hapticSelect = haptics.select as jest.Mock;

const flush = async () => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

function groupConv(id: string, extra?: Partial<LocalConversation>): LocalConversation {
  return {
    id,
    type:          'group',
    name:          `Group ${id}`,
    participants:  ['peer-1', 'peer-2'],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date('2026-08-01T00:00:00Z').toISOString(),
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
    content:         `body of ${id}`,
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-08-29T10:00:00Z').toISOString(),
    peer:            {userId: 'peer-1', deviceId: 1},
    ...extra,
  } as LocalMessage;
}

describe('foreground routing (B-692 S-3)', () => {
  let events: InAppMessageEvent[];
  let unsubBanner: () => void;

  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'active';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    events = [];
    unsubBanner = setInAppMessageBannerListener(e => events.push(e));
    try {
      const {_resetMsgNotifStateForTest} = require('../push/callNotification') as typeof import('../push/callNotification');
      _resetMsgNotifStateForTest();
    } catch { /* module mocked away in some configs */ }
  });

  afterEach(() => {
    unsubBanner();
    stopBackgroundMessageNotifier();
  });

  it('routes a foreground arrival to the in-app banner + tone + haptic, never notifee', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].conversationId).toBe('g1');
    expect(events[0].title).toBe('Ops Team');
    expect(events[0].body).toBe('body of m1');
    expect(events[0].isGroup).toBe(true);
    expect(tone).toHaveBeenCalledWith('banner');
    expect(hapticSelect).toHaveBeenCalledTimes(1);
  });

  it('a message in the ACTIVE thread plays the subtle in-chat tone only — no banner event', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().setActiveConversation('g1');
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(tone).toHaveBeenCalledWith('inChat');
    expect(hapticSelect).not.toHaveBeenCalled();
  });

  it('a MUTED conversation stays silent on the foreground lane too', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1', {is_muted: true}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();
  });

  it('a self message emits nothing in-app', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1', {sender_id: 'self'}));
    await flush();
    expect(events).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();
  });

  it('M16 — a rolled-back receive txn emits NO in-app event or tone; a committed one does', async () => {
    const {runWithRatchetTxn} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    useMessengerStore.getState().upsertConversation(groupConv('g9'));
    startBackgroundMessageNotifier();

    const failing = {async execute(sql: string) {
      if (/^COMMIT/i.test(sql)) {throw new Error('disk full');}
      return undefined;
    }};
    await expect(runWithRatchetTxn(failing as never, async () => {
      useMessengerStore.getState().appendMessage('g9', inbound('rolled', 'g9'));
    })).rejects.toThrow('disk full');
    await flush();
    expect(events).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();

    const ok = {async execute() {return undefined;}};
    await runWithRatchetTxn(ok as never, async () => {
      useMessengerStore.getState().appendMessage('g9', inbound('kept', 'g9'));
    });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('body of kept');
  });

  it('W29 — messages seen foregrounded do NOT banner on the next backgrounding', async () => {
    useMessengerStore.getState().upsertConversation(groupConv('g2'));
    startBackgroundMessageNotifier();
    // The foreground-seen message is deliberately the NEWEST row: if the
    // watermark skipped it, it would win the tail-reduce and banner as a
    // stale replay once the app backgrounds (the B-132 class in reverse).
    useMessengerStore.getState().appendMessage('g2', inbound('seen-live', 'g2', {
      created_at: new Date('2026-08-29T12:00:00Z').toISOString(),
    }));
    await flush();
    expect(display).not.toHaveBeenCalled();

    (AppState as unknown as {currentState: string}).currentState = 'background';
    // An OLDER late-drained arrival — splices mid-list, leaves the tail alone.
    useMessengerStore.getState().appendMessage('g2', inbound('bg-arrival', 'g2', {
      created_at: new Date('2026-08-29T11:00:00Z').toISOString(),
    }));
    await flush();

    // Exactly ONE notifee banner, and it is for the background arrival — the
    // foreground-seen message must not replay as a stale banner.
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].body).toBe('body of bg-arrival');
  });

  it('control — the background notifee lane is unchanged and emits no in-app event', async () => {
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().upsertConversation(groupConv('g3'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g3', inbound('m1', 'g3'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();
  });

  it('critic F1 — a foreground in-app cue ADVANCES the P2-6 generation, on both routes', async () => {
    // Without these bumps the fcmBootstrap P2-6 fallback sees an unchanged
    // generation after its pull and stacks an alerting notifee banner on top
    // of the in-app cue when the user foregrounds mid-pull — the cross-layer
    // double-notification this session exists to kill.
    useMessengerStore.getState().upsertConversation(groupConv('g4'));
    startBackgroundMessageNotifier();
    const g0 = getMessagePostedGeneration();

    useMessengerStore.getState().appendMessage('g4', inbound('m1', 'g4'));
    await flush();
    expect(getMessagePostedGeneration()).toBe(g0 + 1); // banner route counts as "drew"

    useMessengerStore.getState().setActiveConversation('g4');
    useMessengerStore.getState().appendMessage('g4', inbound('m2', 'g4'));
    await flush();
    expect(getMessagePostedGeneration()).toBe(g0 + 2); // active-thread tone counts too
  });

  it('critic F5 — AppState "unknown" (early boot) is NOT foreground UI: the old silent bail holds', async () => {
    (AppState as unknown as {currentState: string}).currentState = 'unknown';
    useMessengerStore.getState().upsertConversation(groupConv('g5'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g5', inbound('m1', 'g5'));
    await flush();

    // No notifee banner, no in-app event, no tone — nobody is provably
    // looking at a mounted banner host yet.
    expect(display).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(tone).not.toHaveBeenCalled();
  });
});
