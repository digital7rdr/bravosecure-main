/**
 * F4 — department-channel notification taps opened the WRONG SCREEN.
 *
 * A department channel's conversation is stored with `type: 'group'`, so
 * `fcmBootstrap`'s msg-wake tap handler computed `isGroup = true` and deep-linked
 * to `Chat`. `ChatScreen` renders phone + video buttons unconditionally, so
 * tapping a channel push landed the user on a surface the PDF explicitly forbids
 * (frames A9 and M9: "No phone/call button appears in Department Channel chat;
 * calls remain in Messenger").
 *
 * This drives the REAL notifee handler installed by `startFcmBootstrap()` (same
 * harness as notifTapNavContract.test.ts) against the REAL messenger store, so
 * it fails on the actual routing decision — not on a re-implementation of it.
 * The three states a tap can be in each get a case:
 *
 *   ordinary group          -> Chat            (must not regress)
 *   channel, pointer known  -> DepartmentChat  (the fix)
 *   channel, pointer absent -> DepartmentChannels directory, NEVER Chat
 *
 * The third matters because `deptGroupByChannel` is only written when a channel
 * thread is opened on THIS device (and B-206 overwrites it), while
 * `deptConversationIds` is filled from the server at every messenger boot. A fix
 * that read only the pointer would send every never-opened channel to the banned
 * screen — i.e. it would look fixed and not be.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  NativeModules: {},
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(() => new Promise(() => { /* never settles */ })),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
  };
  const messaging = () => api;
  return {__esModule: true, default: messaging};
});

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    deleteChannel:          jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

const mockNavigate = jest.fn();
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {
    isReady:  () => true,
    navigate: (name: string, params?: unknown) => { mockNavigate(name, params); },
  },
}));

jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier: jest.fn(),
  stopBackgroundMessageNotifier:  jest.fn(),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: jest.fn(async () => {}), sendText: jest.fn(), markRead: jest.fn()})),
}));
jest.mock('@/modules/messenger/backup/restoreMode', () => ({isRestoreModeActive: () => false}));

const mockResolveConversationMeta =
  jest.fn(async (_conversationId: string): Promise<{name?: string; isGroup: boolean} | null> => null);
const mockResolvePersistedDeptMaps = jest.fn(async (): Promise<{
  deptConversationIds?: Record<string, true>;
  deptGroupByChannel?: Record<string, string>;
}> => ({}));
jest.mock('../push/mutedLookup', () => ({
  isConversationMuted:         jest.fn(async () => false),
  resolveDirectConversationId: jest.fn(async () => null),
  resolveDirectConversation:   jest.fn(async () => null),
  resolveDirectPeerName:       jest.fn(async () => null),
  resolveConversationMeta:     (conversationId: string) => mockResolveConversationMeta(conversationId),
  conversationExists:          jest.fn(async () => false),
  resolvePersistedDeptMaps:    () => mockResolvePersistedDeptMaps(),
}));

import type {LocalConversation} from '../store/types';

const PRESS = 1;
type Handler = (ev: unknown) => Promise<void>;

function tap(data: Record<string, string>): unknown {
  return {type: PRESS, detail: {notification: {data}, pressAction: {id: 'default'}}};
}

function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

async function bootHandler(): Promise<Handler> {
  const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
  await boot.startFcmBootstrap();
  const calls = nf().onBackgroundEvent.mock.calls;
  return calls[calls.length - 1][0] as Handler;
}

/** The nested leaf of the last navigate — `{screen, initial?, params?}`. */
function leaf(): {screen?: string; initial?: boolean; params?: Record<string, unknown>} {
  const last = mockNavigate.mock.calls[mockNavigate.mock.calls.length - 1];
  return ((last[1] as {params?: Record<string, unknown>}).params ?? {}) as never;
}

/**
 * Seed the REAL store. Its persist middleware rehydrates async on first
 * require and its custom merge REPLACES `conversations`, so settle that
 * microtask chain before writing (notifTapNavContract's rule).
 */
async function seed(
  convs: Array<Partial<LocalConversation> & {id: string}>,
  dept?: {channels?: Record<string, string>; ids?: string[]},
): Promise<void> {
  const {useMessengerStore} = require('../store/messengerStore') as
    typeof import('../store/messengerStore');
  for (let i = 0; i < 20; i++) { await Promise.resolve(); }
  const s = useMessengerStore.getState();
  s.reset();
  s.setOwner('owner-1');
  for (const c of convs) {
    s.upsertConversation({
      type: 'group', participants: [], unread_count: 0, is_muted: false,
      created_at: '2026-08-04T00:00:00.000Z', session_state: 'established',
      peer: {userId: '', deviceId: 0},
      ...c,
    } as LocalConversation);
  }
  // The two maps the store really writes: `setDeptChannelGroup` records the
  // channel->conversation POINTER (and additively the registry);
  // `rememberDeptConversation` is what armDeptConversationRegistry() calls at
  // boot from the server channel list, and records the registry ONLY.
  for (const [channelId, convoId] of Object.entries(dept?.channels ?? {})) {
    useMessengerStore.getState().setDeptChannelGroup(channelId, convoId);
  }
  for (const id of dept?.ids ?? []) {
    useMessengerStore.getState().rememberDeptConversation(id);
  }
}

let handler: Handler;

beforeAll(async () => {
  jest.useFakeTimers();
  handler = await bootHandler();
});
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  mockStore.clear();
  mockNavigate.mockClear();
  mockResolveConversationMeta.mockReset();
  mockResolveConversationMeta.mockResolvedValue(null);
  mockResolvePersistedDeptMaps.mockReset();
  mockResolvePersistedDeptMaps.mockResolvedValue({});
});

describe('F4 — a department-channel tap must not open ChatScreen', () => {
  it('an ORDINARY group still opens Chat (no regression)', async () => {
    await seed([{id: 'g-1', type: 'group', name: 'Ops Team'}]);

    await handler(tap({kind: 'msg-wake', conversationId: 'g-1'}));

    expect(leaf()).toEqual({
      screen: 'Chat', initial: false,
      params: {conversationId: 'g-1', name: 'Ops Team', isGroup: true},
    });
  });

  /** THE BUG. Same `type: 'group'` row — only the dept registry differs. */
  it('a CHANNEL with a known pointer opens DepartmentChat, not Chat', async () => {
    await seed(
      [{id: 'conv-hr', type: 'group', name: '#hr-announcements'}],
      {channels: {'chan-hr': 'conv-hr'}},
    );

    await handler(tap({kind: 'msg-wake', conversationId: 'conv-hr'}));

    expect(leaf().screen).toBe('DepartmentChat');
    expect(leaf().screen).not.toBe('Chat');
    expect(leaf()).toEqual({
      screen:  'DepartmentChat',
      initial: false,   // B-85: seed the stack root beneath, or back exits it
      params: {
        channelId:           'chan-hr',
        channelName:         '#hr-announcements',
        channelDesc:         '',
        groupConversationId: 'conv-hr',
      },
    });
  });

  it('every param DepartmentChatScreen destructures is present and a string', async () => {
    await seed([{id: 'conv-hr', type: 'group', name: undefined}], {channels: {'chan-hr': 'conv-hr'}});

    await handler(tap({kind: 'msg-wake', conversationId: 'conv-hr'}));

    const p = leaf().params as Record<string, unknown>;
    // The B-54 class: a missing required param does not throw at navigate time,
    // it mounts a broken screen. `channelName` has no store value here.
    expect(typeof p.channelId).toBe('string');
    expect(typeof p.channelName).toBe('string');
    expect(typeof p.channelDesc).toBe('string');
    expect(p.groupConversationId).toBe('conv-hr');
  });

  /**
   * The state a pointer-only fix gets wrong: the channel is known departmental
   * (armDeptConversationRegistry filled the registry from the server at boot)
   * but was never opened on this device, so there is no channel id to route
   * with. Chat is the one destination that is NOT allowed.
   */
  it('a CHANNEL known only to the additive registry degrades to the DIRECTORY, never Chat', async () => {
    await seed([{id: 'conv-ops', type: 'group', name: '#ops'}], {ids: ['conv-ops']});

    await handler(tap({kind: 'msg-wake', conversationId: 'conv-ops'}));

    expect(leaf().screen).toBe('DepartmentChannels');
    expect(leaf().screen).not.toBe('Chat');
  });

  /**
   * COLD BOOT — the killed-app tap this whole lane exists for. The live store
   * has not hydrated, so both the conversation meta AND the dept maps come from
   * the persisted vault slice.
   */
  it('cold boot: the persisted dept maps still route to DepartmentChat', async () => {
    await seed([]);                                     // live store empty
    mockResolveConversationMeta.mockResolvedValue({name: '#field-ops', isGroup: true});
    mockResolvePersistedDeptMaps.mockResolvedValue({deptGroupByChannel: {'chan-fo': 'conv-fo'}});

    await handler(tap({kind: 'msg-wake', conversationId: 'conv-fo'}));

    expect(mockResolvePersistedDeptMaps).toHaveBeenCalled();
    expect(leaf()).toEqual({
      screen:  'DepartmentChat',
      initial: false,
      params: {
        channelId:           'chan-fo',
        channelName:         '#field-ops',
        channelDesc:         '',
        groupConversationId: 'conv-fo',
      },
    });
  });

  it('cold boot with no dept record anywhere keeps the ordinary Chat routing', async () => {
    await seed([]);
    mockResolveConversationMeta.mockResolvedValue({name: 'Squad', isGroup: true});

    await handler(tap({kind: 'msg-wake', conversationId: 'g-cold'}));

    expect(leaf().screen).toBe('Chat');
  });

  it('an unresolvable conversation still degrades to MessengerHome (M-05)', async () => {
    await seed([]);

    await handler(tap({kind: 'msg-wake', conversationId: 'nope'}));

    expect(leaf().screen).toBe('MessengerHome');
  });
});
