/**
 * Call-UI parity plan §4 (G1) — the incoming ring must play the DEVICE-DEFAULT
 * ringtone via BravoRingtoneModule, on a SILENT v2 notification channel, and
 * stop through the single dismiss funnel.
 *
 * Contracts under test:
 *   1. startIncomingRingtone forwards (callId, RING_TIMEOUT_MS=45s — must
 *      equal the notification's PUSH-B5 `timeoutAfter`) to the native module;
 *      stop forwards the callId (or null for stop-any); a missing native
 *      module (old APK / iOS / tests) is a silent no-op, never a throw.
 *   2. showIncomingCallNotif displays on the silent `bravo-incoming-call-v2`
 *      channel (NO `sound` key — `sound:'default'` was the notification
 *      CHIME bug), deletes the legacy v1 channel, keeps `timeoutAfter` 45s,
 *      and starts the ringtone only AFTER the card displays.
 *   3. dismissCallNotif stops the ringtone AND cancels the notification.
 */

const nativeStart = jest.fn();
const nativeStop = jest.fn();
const nativeModules: Record<string, unknown> = {
  BravoRingtone: {start: nativeStart, stop: nativeStop},
};

// NOT `{virtual: true}` — B-161. `react-native` is a REAL module, and a virtual
// mock of an existing module races the real resolution. When the real one won,
// this suite died at REQUIRE time (RN's entry is untransformed ESM under the
// node-env `messenger-crypto` project) — reported as a whole-suite failure with
// zero failed assertions, which is exactly the B-153 "moving flake" signature.
jest.mock(
  'react-native',
  () => ({
    Platform: {OS: 'android', Version: 34},
    NativeModules: nativeModules,
  }),
);

const displayed: Array<Record<string, unknown>> = [];
const cancelled: string[] = [];
const createdChannels: Array<Record<string, unknown>> = [];
const deletedChannels: string[] = [];

jest.mock(
  '@notifee/react-native',
  () => ({
    __esModule: true,
    default: {
      createChannel: jest.fn(async (c: Record<string, unknown>) => {
        createdChannels.push(c);
        return c.id;
      }),
      deleteChannel: jest.fn(async (id: string) => { deletedChannels.push(id); }),
      displayNotification: jest.fn(async (n: Record<string, unknown>) => { displayed.push(n); }),
      cancelNotification: jest.fn(async (id: string) => { cancelled.push(id); }),
      onBackgroundEvent: jest.fn(),
      onForegroundEvent: jest.fn(),
    },
    AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
    AndroidCategory: {CALL: 'call', MESSAGE: 'msg'},
    AndroidVisibility: {PUBLIC: 1, PRIVATE: 0},
    AndroidStyle: {BIGTEXT: 0},
    EventType: {PRESS: 1, ACTION_PRESS: 2},
  }),
);

import {
  startIncomingRingtone,
  stopIncomingRingtone,
  isNativeRingActive,
  bindInAppRingOwnership,
  RING_TIMEOUT_MS,
} from '../push/incomingRingtone';
import {showIncomingCallNotif, dismissCallNotif} from '../push/callNotification';

beforeEach(() => {
  stopIncomingRingtone(null, 'reset');
  nativeStart.mockClear();
  nativeStop.mockClear();
  displayed.length = 0;
  cancelled.length = 0;
  createdChannels.length = 0;
  deletedChannels.length = 0;
  nativeModules.BravoRingtone = {start: nativeStart, stop: nativeStop};
});

describe('incomingRingtone wrapper', () => {
  it('start forwards callId + the PUSH-B5-aligned 45s native timeout', () => {
    startIncomingRingtone('call-1');
    expect(RING_TIMEOUT_MS).toBe(45_000);
    expect(nativeStart).toHaveBeenCalledWith('call-1', 45_000);
  });

  it('stop forwards the callId, and null means stop-any', () => {
    stopIncomingRingtone('call-1', 'test');
    expect(nativeStop).toHaveBeenCalledWith('call-1');
    stopIncomingRingtone(null, 'sweep');
    expect(nativeStop).toHaveBeenCalledWith(null);
  });

  it('missing native module (old APK / iOS) is a silent no-op', () => {
    delete nativeModules.BravoRingtone;
    expect(() => startIncomingRingtone('call-2')).not.toThrow();
    expect(() => stopIncomingRingtone('call-2', 'test')).not.toThrow();
    expect(nativeStart).not.toHaveBeenCalled();
    expect(nativeStop).not.toHaveBeenCalled();
  });

  it('a native throw is contained, never propagated to the ring path', () => {
    nativeModules.BravoRingtone = {
      start: () => { throw new Error('binder died'); },
      stop:  () => { throw new Error('binder died'); },
    };
    expect(() => startIncomingRingtone('call-3')).not.toThrow();
    expect(() => stopIncomingRingtone('call-3', 'test')).not.toThrow();
  });
});

describe('showIncomingCallNotif — silent v2 channel + native ring', () => {
  it('creates the SILENT v2 channel, deletes v1, displays, then starts the ringtone', async () => {
    await showIncomingCallNotif({callId: 'c-77', kind: 'voice', callerName: 'Fahim'});

    const ring = createdChannels.find(c => c.id === 'bravo-incoming-call-v2');
    expect(ring).toBeDefined();
    // The chime bug: `sound: 'default'` on the channel. Must be ABSENT.
    expect(ring).not.toHaveProperty('sound');
    expect(deletedChannels).toContain('bravo-incoming-call');

    expect(displayed).toHaveLength(1);
    const notif = displayed[0] as {id: string; android: {channelId: string; timeoutAfter: number; loopSound?: boolean}};
    expect(notif.id).toBe('bravo-call-c-77');
    expect(notif.android.channelId).toBe('bravo-incoming-call-v2');
    expect(notif.android.timeoutAfter).toBe(45_000); // PUSH-B5
    expect(notif.android.loopSound).toBeUndefined(); // silent channel — nothing to loop

    expect(nativeStart).toHaveBeenCalledWith('c-77', 45_000);
  });

  it('dismissCallNotif stops the ringtone AND cancels the card', async () => {
    await dismissCallNotif('c-77');
    expect(nativeStop).toHaveBeenCalledWith('c-77');
    expect(cancelled).toContain('bravo-call-c-77');
  });
});

describe('NA-06 — native ring ownership', () => {
  it('is unowned before any ring, owned after start, and only for that callId', () => {
    expect(isNativeRingActive('c-77')).toBe(false);
    startIncomingRingtone('c-77');
    expect(isNativeRingActive('c-77')).toBe(true);
    expect(isNativeRingActive('other')).toBe(false);
  });

  it('stop(callId) and stop(null) both release ownership', () => {
    startIncomingRingtone('c-77');
    stopIncomingRingtone('c-77', 'test');
    expect(isNativeRingActive('c-77')).toBe(false);

    startIncomingRingtone('c-78');
    stopIncomingRingtone(null, 'sweep');
    expect(isNativeRingActive('c-78')).toBe(false);
  });

  it('stop for a DIFFERENT callId does not release ownership', () => {
    startIncomingRingtone('c-77');
    stopIncomingRingtone('c-99', 'other');
    expect(isNativeRingActive('c-77')).toBe(true);
  });

  it('ownership self-expires at RING_TIMEOUT_MS', () => {
    const t0 = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    startIncomingRingtone('c-77');
    now.mockReturnValue(t0 + RING_TIMEOUT_MS - 1);
    expect(isNativeRingActive('c-77')).toBe(true);
    now.mockReturnValue(t0 + RING_TIMEOUT_MS);
    expect(isNativeRingActive('c-77')).toBe(false);
    now.mockRestore();
  });

  it('missing native module never claims ownership (iOS / old APK still plays the in-app tone)', () => {
    delete nativeModules.BravoRingtone;
    startIncomingRingtone('c-77');
    expect(isNativeRingActive('c-77')).toBe(false);
  });

  it('bindInAppRingOwnership fires immediately, flips on start/stop, and unsubscribes', () => {
    const cb = jest.fn();
    const unbind = bindInAppRingOwnership('c-77', cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(true);

    startIncomingRingtone('c-77');
    expect(cb).toHaveBeenLastCalledWith(false);

    stopIncomingRingtone('c-77', 'test');
    expect(cb).toHaveBeenLastCalledWith(true);
    expect(cb).toHaveBeenCalledTimes(3);

    unbind();
    startIncomingRingtone('c-77');
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('a bind made while the native ring already owns the call starts silent', async () => {
    await showIncomingCallNotif({callId: 'c-77', kind: 'voice', callerName: 'Fahim'});
    expect(isNativeRingActive('c-77')).toBe(true);

    const cb = jest.fn();
    bindInAppRingOwnership('c-77', cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(false);

    await dismissCallNotif('c-77');
    expect(cb).toHaveBeenLastCalledWith(true);
    expect(isNativeRingActive('c-77')).toBe(false);
  });

  it('an undefined callId always owns the in-app tone', () => {
    startIncomingRingtone('c-77');
    const cb = jest.fn();
    bindInAppRingOwnership(undefined, cb);
    expect(cb).toHaveBeenLastCalledWith(true);
  });

  it('a throwing listener does not break start/stop', () => {
    let armed = false;
    const bad = jest.fn(() => { if (armed) { throw new Error('boom'); } });
    const good = jest.fn();
    const unbindBad = bindInAppRingOwnership('c-77', bad as unknown as (owns: boolean) => void);
    const unbindGood = bindInAppRingOwnership('c-77', good);
    armed = true;
    expect(() => startIncomingRingtone('c-77')).not.toThrow();
    expect(good).toHaveBeenLastCalledWith(false);
    expect(() => stopIncomingRingtone('c-77', 'test')).not.toThrow();
    expect(good).toHaveBeenLastCalledWith(true);
    unbindBad();
    unbindGood();
  });
});
