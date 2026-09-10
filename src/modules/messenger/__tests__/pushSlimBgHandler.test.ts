/**
 * P1-9 / P1-BR-3 — the SLIM bundle-entry notifee handler runs when the process
 * was killed (rich handler not registered). It must:
 *   - persist an inline Reply / Mark-read to the durable queue (runtime is dead
 *     here) and clear the hung RemoteInput spinner, and
 *   - send a call Decline over HTTP so the caller stops ringing WITHOUT
 *     cold-launching, falling back to a durable pending-decline on failure.
 * Exercises the REAL slim handler wired to the REAL pending-actions queue.
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
jest.mock('react-native', () => ({Platform: {OS: 'android'}, NativeModules: {}}));
// NOT `{virtual: true}` — see B-161 in pendingActions.test.ts: the module is
// real, so a virtual mock races the real one and this suite intermittently saw
// the production fallback URL.
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    onBackgroundEvent:   jest.fn(),
    onForegroundEvent:   jest.fn(),
    displayNotification: jest.fn(async () => {}),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

import notifee from '@notifee/react-native';
import {installSlimNotifeeBgHandler} from '../push/callNotification';
import {loadPendingActions, _resetDeclineThrottleForTests} from '../push/pendingActions';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

const ACTION_PRESS = 2;
type Handler = (ev: {type: number; detail: Record<string, unknown>}) => Promise<void>;
let handler: Handler;

beforeAll(() => {
  installSlimNotifeeBgHandler();
  handler = (notifee.onBackgroundEvent as jest.Mock).mock.calls[0][0] as Handler;
});

beforeEach(() => {
  mockStore.clear();
  _resetDeclineThrottleForTests();
  display.mockClear();
  cancel.mockClear();
  (global as {fetch?: unknown}).fetch = undefined;
});

describe('slim bg handler — inline Reply / Mark-read (P1-9)', () => {
  it('persists a typed reply to the durable queue and clears the reply spinner', async () => {
    await handler({
      type: ACTION_PRESS,
      detail: {notification: {data: {kind: 'msg-wake', conversationId: 'c1'}}, pressAction: {id: 'reply-c1'}, input: 'hello world'},
    });
    const loaded = await loadPendingActions();
    expect(loaded).toContainEqual(expect.objectContaining({t: 'reply', convId: 'c1', text: 'hello world'}));
    // The banner is re-posted (same id) to clear the hung RemoteInput spinner.
    expect(display).toHaveBeenCalledWith(expect.objectContaining({id: 'bravo-msg-c1'}));
    // No plaintext leaks into the re-displayed banner.
    expect(JSON.stringify(display.mock.calls.at(-1)![0])).not.toContain('hello world');
  });

  it('does NOT persist an empty reply', async () => {
    await handler({
      type: ACTION_PRESS,
      detail: {notification: {data: {kind: 'msg-wake', conversationId: 'c1'}}, pressAction: {id: 'reply-c1'}, input: '   '},
    });
    expect(await loadPendingActions()).toHaveLength(0);
  });

  it('persists a mark-as-read and dismisses the banner', async () => {
    await handler({
      type: ACTION_PRESS,
      detail: {notification: {data: {kind: 'msg-wake', conversationId: 'c2'}}, pressAction: {id: 'read-c2'}},
    });
    expect(await loadPendingActions()).toContainEqual(expect.objectContaining({t: 'read', convId: 'c2'}));
    expect(cancel).toHaveBeenCalledWith('bravo-msg-c2');
  });
});

describe('slim bg handler — headless Decline (P1-BR-3)', () => {
  it('POSTs a 1:1 decline and cancels the ring on success (no pending fallback)', async () => {
    mockStore.set('auth:access_token', 'tok');
    const fetchMock = jest.fn(async () => ({ok: true, status: 200}));
    (global as {fetch?: unknown}).fetch = fetchMock as unknown as typeof fetch;
    await handler({
      type: ACTION_PRESS,
      detail: {notification: {data: {kind: 'voip', callId: 'call-1', isGroup: '0', fromUserId: 'peer-1'}}, pressAction: {id: 'decline-call-1'}},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://msg.test/calls/call-1/decline');
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-1'); // ring dismissed
    expect((await loadPendingActions()).some(e => e.t === 'decline')).toBe(false);
  });

  it('enqueues a durable pending-decline when the POST fails (flushed on first connect)', async () => {
    mockStore.set('auth:access_token', 'tok');
    (global as {fetch?: unknown}).fetch = jest.fn(async () => ({ok: false, status: 503})) as unknown as typeof fetch;
    await handler({
      type: ACTION_PRESS,
      detail: {notification: {data: {kind: 'voip', callId: 'call-2', isGroup: '1', roomId: 'room-2', kind2: 'x'}}, pressAction: {id: 'decline-call-2'}},
    });
    const loaded = await loadPendingActions();
    expect(loaded).toContainEqual(expect.objectContaining({t: 'decline', callId: 'call-2', kind: 'group', roomId: 'room-2'}));
    expect(cancel).toHaveBeenCalledWith('bravo-call-call-2'); // ring still dismissed
  });
});
