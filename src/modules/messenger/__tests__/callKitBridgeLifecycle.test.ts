/**
 * callKitBridge — EXECUTABLE lifecycle coverage.
 *
 * This module is the CallKit (iOS) / Telecom (Android) seam for the 1:1 call
 * stack. Every export is a "must never throw into a live call" wrapper, and
 * almost every one of them has a documented regression attached to it:
 *
 *   • the inert-bridge contract — a missing / unlinked `react-native-callkeep`
 *     must degrade to no-ops, never crash the call (module header);
 *   • P3 — `foregroundService.channelId` MUST be the v2 channel id, or setup
 *     RE-CREATES the legacy v1 channel that `ensureIncomingCallChannel()`
 *     deletes and the user sees two "Incoming calls" entries;
 *   • B-109 RC-3 — `reportAnswered` is iOS-ONLY on purpose (Android's in-app
 *     accept is the device-verified B-53/B-58 path and must stay untouched);
 *   • B-109 RC-4 — `waitForIosAudioSession` gates `InCallManager.start` on
 *     CXProvider's `didActivateAudioSession`, and MUST fall through on timeout
 *     so a CallKit-less run can never leave a call silent;
 *   • B-391b — `reportAudioRoute` mirrors our route onto the Telecom
 *     Connection using CALLKEEP'S vocabulary ('Bluetooth'/'Headset'/'Speaker'/
 *     'Earpiece'), not ours; the native switch falls through otherwise.
 *
 * `bringAppToForeground` (NA-04) is deliberately NOT re-tested here — it is
 * already pinned by callForegroundBringToFront.test.ts.
 */

let mockPlatformOS = 'android';
jest.mock('react-native', () => ({
  get Platform() { return {OS: mockPlatformOS}; },
  NativeModules: {},
  DeviceEventEmitter: {addListener: jest.fn(() => ({remove: jest.fn()}))},
}));

/** Flip to simulate "native module not linked / not installed". */
let mockCallKeepMissing = false;

type Handler = (data: Record<string, unknown>) => void;

interface CkMock {
  setup: jest.Mock;
  registerAndroidEvents: jest.Mock;
  unregisterAndroidEvents: jest.Mock;
  displayIncomingCall: jest.Mock;
  startCall: jest.Mock;
  answerIncomingCall: jest.Mock;
  reportConnectedOutgoingCallWithUUID: jest.Mock;
  setCurrentCallActive: jest.Mock;
  endCall: jest.Mock;
  reportEndCallWithUUID: jest.Mock;
  endAllCalls: jest.Mock;
  setMutedCall: jest.Mock;
  rejectCall: jest.Mock;
  backToForeground: jest.Mock;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  setAudioRoute?: jest.Mock;
  CONSTANTS?: unknown;
}

let mockCk: CkMock;
/** Every listener installed via addEventListener, by event name. */
let mockListeners: Record<string, Handler[]>;
/** remove() calls observed on the handles addEventListener returned. */
let mockRemoved: string[];

function freshCk(): CkMock {
  mockListeners = {};
  mockRemoved = [];
  return {
    setup:                   jest.fn(async () => true),
    registerAndroidEvents:   jest.fn(),
    unregisterAndroidEvents: jest.fn(),
    displayIncomingCall:     jest.fn(),
    startCall:               jest.fn(),
    answerIncomingCall:      jest.fn(),
    reportConnectedOutgoingCallWithUUID: jest.fn(),
    setCurrentCallActive:    jest.fn(),
    endCall:                 jest.fn(),
    reportEndCallWithUUID:   jest.fn(),
    endAllCalls:             jest.fn(),
    setMutedCall:            jest.fn(),
    rejectCall:              jest.fn(),
    backToForeground:        jest.fn(),
    removeEventListener:     jest.fn(),
    setAudioRoute:           jest.fn(async () => undefined),
    addEventListener:        jest.fn((type: string, handler: Handler) => {
      (mockListeners[type] ??= []).push(handler);
      return {remove: () => { mockRemoved.push(type); }};
    }),
    CONSTANTS: {
      END_CALL_REASONS: {
        FAILED: 1, REMOTE_ENDED: 2, UNANSWERED: 3,
        ANSWERED_ELSEWHERE: 4, DECLINED_ELSEWHERE: 5, MISSED: 6,
      },
    },
  };
}

jest.mock('react-native-callkeep', () => {
  if (mockCallKeepMissing) { throw new Error('react-native-callkeep not linked'); }
  return {__esModule: true, default: mockCk};
});

type Bridge = typeof import('../push/callKitBridge');

function loadBridge(): Bridge {
  return require('../push/callKitBridge') as Bridge;
}

/** Fire a native CallKeep event into every listener registered for it. */
function emit(type: string, data: Record<string, unknown> = {}): void {
  for (const h of mockListeners[type] ?? []) { h(data); }
}

beforeEach(() => {
  // The bridge memoises the native module AND its setup flags at module
  // scope — a shared registry hands the next test the previous test's state.
  jest.resetModules();
  // `waitForIosAudioSession` arms a real setTimeout per waiter that outlives a
  // resolve-by-event; under real timers those keep the jest worker alive.
  jest.useFakeTimers();
  mockPlatformOS      = 'android';
  mockCallKeepMissing = false;
  mockCk              = freshCk();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('inert bridge — react-native-callkeep is not linked', () => {
  it('setupCallKit resolves without throwing and leaves the bridge inactive', async () => {
    mockCallKeepMissing = true;
    const b = loadBridge();
    await expect(b.setupCallKit()).resolves.toBeUndefined();
    expect(b.isCallKitActive()).toBe(false);
  });

  it('every report* call is a silent no-op (a missing module must never break a call)', async () => {
    mockCallKeepMissing = true;
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => {
      b.reportIncomingCall({callId: 'c1', callerName: 'Bow', kind: 'voice'});
      b.reportOutgoingCall({callId: 'c1', calleeName: 'Bow', kind: 'video'});
      b.reportConnected('c1');
      b.reportAnswered('c1');
      b.reportAudioRoute('BLUETOOTH');
      b.reportMuteChange('c1', true);
      b.reportEnded('c1', 'remoteEnded');
      b.teardownCallKit();
    }).not.toThrow();
    // Nothing reached the (absent) native module.
    expect(mockCk.displayIncomingCall).not.toHaveBeenCalled();
    expect(mockCk.startCall).not.toHaveBeenCalled();
  });

  it('subscribeToCallKitEvents returns a working no-op unsubscribe', async () => {
    mockCallKeepMissing = true;
    const b = loadBridge();
    await b.setupCallKit();
    const onAnswer = jest.fn();
    const off = b.subscribeToCallKitEvents({onAnswer});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
    expect(mockCk.addEventListener).not.toHaveBeenCalled();
  });

  it('waitForIosAudioSession resolves true immediately when the bridge is inert', async () => {
    mockCallKeepMissing = true;
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await expect(b.waitForIosAudioSession(50)).resolves.toBe(true);
  });
});

describe('setupCallKit', () => {
  it('registers the SELF-MANAGED phone account against the v2 notification channel (P3)', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    expect(mockCk.setup).toHaveBeenCalledTimes(1);
    const opts = mockCk.setup.mock.calls[0][0] as {
      android: {selfManaged: boolean; foregroundService: {channelId: string}};
      ios: {includesCallsInRecents: boolean; supportsVideo: boolean};
    };
    // P3 — the legacy 'bravo-incoming-call' string re-creates the v1 channel
    // that ensureIncomingCallChannel() deletes. Must stay in lockstep with
    // callNotification.CHANNEL_ID.
    expect(opts.android.foregroundService.channelId).toBe('bravo-incoming-call-v2');
    // selfManaged=false would hand audio to the OS and fight InCallManager.
    expect(opts.android.selfManaged).toBe(true);
    // Bravo keeps its own private call log — mirroring to system Recents
    // would leak peer identities to anyone holding the phone.
    expect(opts.ios.includesCallsInRecents).toBe(false);
  });

  it('is idempotent — a second call does not re-run native setup', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    await b.setupCallKit();
    await b.setupCallKit();
    expect(mockCk.setup).toHaveBeenCalledTimes(1);
  });

  it('android: registers the native event bridge AFTER setup resolves', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    expect(mockCk.registerAndroidEvents).toHaveBeenCalledTimes(1);
    expect(mockCk.setup.mock.invocationCallOrder[0])
      .toBeLessThan(mockCk.registerAndroidEvents.mock.invocationCallOrder[0]);
    expect(b.isCallKitActive()).toBe(true);
  });

  it('android: a throwing registerAndroidEvents does not un-succeed setup', async () => {
    mockCk.registerAndroidEvents.mockImplementation(() => { throw new Error('telecom denied'); });
    const b = loadBridge();
    await expect(b.setupCallKit()).resolves.toBeUndefined();
    expect(b.isCallKitActive()).toBe(true);
  });

  it('setup() resolving false leaves the bridge inactive and gates every report', async () => {
    mockCk.setup.mockResolvedValue(false);
    const b = loadBridge();
    await b.setupCallKit();
    expect(b.isCallKitActive()).toBe(false);
    expect(mockCk.registerAndroidEvents).not.toHaveBeenCalled();
    b.reportIncomingCall({callId: 'c1', callerName: 'Bow', kind: 'voice'});
    b.reportConnected('c1');
    expect(mockCk.displayIncomingCall).not.toHaveBeenCalled();
    expect(mockCk.setCurrentCallActive).not.toHaveBeenCalled();
  });

  it('setup() rejecting is swallowed and leaves the bridge inactive', async () => {
    mockCk.setup.mockRejectedValue(new Error('phone account rejected'));
    const b = loadBridge();
    await expect(b.setupCallKit()).resolves.toBeUndefined();
    expect(b.isCallKitActive()).toBe(false);
  });

  it('ios: installs the CXProvider audio-session listeners, not the android event bridge', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    expect(mockCk.registerAndroidEvents).not.toHaveBeenCalled();
    expect(mockListeners.didActivateAudioSession?.length).toBe(1);
    expect(mockListeners.didDeactivateAudioSession?.length).toBe(1);
  });

  it('ios: a throwing addEventListener does not fail setup', async () => {
    mockPlatformOS = 'ios';
    mockCk.addEventListener.mockImplementation(() => { throw new Error('no bridge'); });
    const b = loadBridge();
    await expect(b.setupCallKit()).resolves.toBeUndefined();
    expect(b.isCallKitActive()).toBe(true);
  });
});

describe('B-109 RC-4 — waitForIosAudioSession', () => {
  it('android resolves true immediately (CallKit owns no session there)', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    await expect(b.waitForIosAudioSession(10_000)).resolves.toBe(true);
  });

  it('ios: resolves true when CXProvider activates the session', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    const p = b.waitForIosAudioSession(5_000);
    emit('didActivateAudioSession');
    await expect(p).resolves.toBe(true);
  });

  it('ios: a second wait after activation short-circuits to true', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    emit('didActivateAudioSession');
    await expect(b.waitForIosAudioSession(5_000)).resolves.toBe(true);
  });

  it('ios: FALLS THROUGH on timeout — a CallKit-less run must never stay silent', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    const p = b.waitForIosAudioSession(1_500);
    jest.advanceTimersByTime(1_500);
    await expect(p).resolves.toBe(false);
  });

  it('ios: deactivation re-arms the gate so the next call waits again', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    emit('didActivateAudioSession');
    emit('didDeactivateAudioSession');
    const p = b.waitForIosAudioSession(800);
    jest.advanceTimersByTime(800);
    await expect(p).resolves.toBe(false);
  });

  it('ios: one waiter throwing does not starve the others', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    const first  = b.waitForIosAudioSession(5_000);
    const second = b.waitForIosAudioSession(5_000);
    emit('didActivateAudioSession');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});

describe('reportIncomingCall / reportOutgoingCall', () => {
  it('labels the system UI with handle when present, falling back to the name', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportIncomingCall({callId: 'c-in', callerName: 'Bow Rani', handle: '+971500000000', kind: 'video'});
    expect(mockCk.displayIncomingCall)
      .toHaveBeenCalledWith('c-in', '+971500000000', 'Bow Rani', 'generic', true);

    b.reportIncomingCall({callId: 'c-in2', callerName: 'Bow Rani', kind: 'voice'});
    expect(mockCk.displayIncomingCall)
      .toHaveBeenLastCalledWith('c-in2', 'Bow Rani', 'Bow Rani', 'generic', false);
  });

  it('outgoing reports startCall with the video flag derived from kind', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportOutgoingCall({callId: 'c-out', calleeName: 'Bow Rani', kind: 'video'});
    expect(mockCk.startCall)
      .toHaveBeenCalledWith('c-out', 'Bow Rani', 'Bow Rani', 'generic', true);
  });

  it('a throwing native displayIncomingCall is swallowed', async () => {
    mockCk.displayIncomingCall.mockImplementation(() => { throw new Error('telecom busy'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportIncomingCall({callId: 'c1', callerName: 'Bow', kind: 'voice'})).not.toThrow();
  });

  it('a throwing native startCall is swallowed', async () => {
    mockCk.startCall.mockImplementation(() => { throw new Error('no phone account'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportOutgoingCall({callId: 'c1', calleeName: 'Bow', kind: 'voice'})).not.toThrow();
  });
});

describe('B-109 RC-3 — reportAnswered is iOS-only', () => {
  it('android in-app accept does NOT touch the CXCall (B-53/B-58 path stays untouched)', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportAnswered('c-1');
    expect(mockCk.answerIncomingCall).not.toHaveBeenCalled();
  });

  it('ios in-app accept answers the CXCall so the ring cannot decline a live call', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    b.reportAnswered('c-1');
    expect(mockCk.answerIncomingCall).toHaveBeenCalledWith('c-1');
  });

  it('ios: a throwing answerIncomingCall is swallowed', async () => {
    mockPlatformOS = 'ios';
    mockCk.answerIncomingCall.mockImplementation(() => { throw new Error('no such call'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportAnswered('c-1')).not.toThrow();
  });
});

describe('reportConnected picks the per-platform native call', () => {
  it('android uses setCurrentCallActive (works for both directions)', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportConnected('c-1');
    expect(mockCk.setCurrentCallActive).toHaveBeenCalledWith('c-1');
    expect(mockCk.reportConnectedOutgoingCallWithUUID).not.toHaveBeenCalled();
  });

  it('ios uses reportConnectedOutgoingCallWithUUID', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    b.reportConnected('c-1');
    expect(mockCk.reportConnectedOutgoingCallWithUUID).toHaveBeenCalledWith('c-1');
    expect(mockCk.setCurrentCallActive).not.toHaveBeenCalled();
  });

  it('adopts the connected call as the active Telecom call for route mirroring', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    // No incoming/outgoing report ran — reportConnected must still register it.
    b.reportConnected('c-adopted');
    b.reportAudioRoute('SPEAKER_PHONE');
    expect(mockCk.setAudioRoute).toHaveBeenCalledWith('c-adopted', 'Speaker');
  });

  it('a throwing native call is swallowed', async () => {
    mockCk.setCurrentCallActive.mockImplementation(() => { throw new Error('gone'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportConnected('c-1')).not.toThrow();
  });
});

describe('B-391b — reportAudioRoute mirrors OUR route onto the Telecom Connection', () => {
  async function armed() {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportIncomingCall({callId: 'c-route', callerName: 'Bow', kind: 'voice'});
    return b;
  }

  it.each([
    ['BLUETOOTH',     'Bluetooth'],
    ['WIRED_HEADSET', 'Headset'],
    ['SPEAKER_PHONE', 'Speaker'],
    ['EARPIECE',      'Earpiece'],
  ] as const)('translates %s into CallKeep\'s own vocabulary (%s)', async (route, name) => {
    const b = await armed();
    b.reportAudioRoute(route);
    expect(mockCk.setAudioRoute).toHaveBeenCalledWith('c-route', name);
  });

  it('is android-only — iOS routes through CallKit\'s own audio session', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    b.reportIncomingCall({callId: 'c-route', callerName: 'Bow', kind: 'voice'});
    b.reportAudioRoute('BLUETOOTH');
    expect(mockCk.setAudioRoute).not.toHaveBeenCalled();
  });

  it('no-ops when no call is registered (stale id must never be invented)', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportAudioRoute('BLUETOOTH');
    expect(mockCk.setAudioRoute).not.toHaveBeenCalled();
  });

  it('no-ops on a pre-B-391b CallKeep that has no setAudioRoute', async () => {
    delete mockCk.setAudioRoute;
    const b = loadBridge();
    await b.setupCallKit();
    b.reportIncomingCall({callId: 'c-route', callerName: 'Bow', kind: 'voice'});
    expect(() => b.reportAudioRoute('BLUETOOTH')).not.toThrow();
  });

  it('a rejected setAudioRoute promise never surfaces as an unhandled rejection', async () => {
    mockCk.setAudioRoute!.mockRejectedValue(new Error('connection gone'));
    const b = await armed();
    expect(() => b.reportAudioRoute('BLUETOOTH')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('a synchronously throwing setAudioRoute never breaks the call', async () => {
    mockCk.setAudioRoute!.mockImplementation(() => { throw new Error('boom'); });
    const b = await armed();
    expect(() => b.reportAudioRoute('BLUETOOTH')).not.toThrow();
  });

  it('stops mirroring once THAT call ended, but not when a different call ends', async () => {
    const b = await armed();
    // Ending a DIFFERENT call must not clear our active Telecom call.
    b.reportEnded('someone-else', 'remoteEnded');
    b.reportAudioRoute('BLUETOOTH');
    expect(mockCk.setAudioRoute).toHaveBeenCalledWith('c-route', 'Bluetooth');
    mockCk.setAudioRoute!.mockClear();
    // Ending OUR call clears it — a later route hint has nowhere to land.
    b.reportEnded('c-route', 'remoteEnded');
    b.reportAudioRoute('SPEAKER_PHONE');
    expect(mockCk.setAudioRoute).not.toHaveBeenCalled();
  });
});

describe('reportEnded maps Bravo reasons onto CallKeep end-call codes', () => {
  it.each([
    ['failed',            1],
    ['remoteEnded',       2],
    ['unanswered',        3],
    ['answeredElsewhere', 4],
    ['declined',          5],
  ] as const)('%s → code %d', async (reason, code) => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportEnded('c-1', reason);
    expect(mockCk.reportEndCallWithUUID).toHaveBeenCalledWith('c-1', code);
    expect(mockCk.endCall).not.toHaveBeenCalled();
  });

  it('falls back to the unspecified-reason endCall on a CallKeep without CONSTANTS', async () => {
    delete mockCk.CONSTANTS;
    const b = loadBridge();
    await b.setupCallKit();
    b.reportEnded('c-1', 'declined');
    expect(mockCk.endCall).toHaveBeenCalledWith('c-1');
    expect(mockCk.reportEndCallWithUUID).not.toHaveBeenCalled();
  });

  it('a throwing native end is swallowed', async () => {
    mockCk.reportEndCallWithUUID.mockImplementation(() => { throw new Error('unknown uuid'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportEnded('c-1', 'failed')).not.toThrow();
  });
});

describe('reportMuteChange', () => {
  it('is iOS-only — android Telecom has no programmatic mute on self-managed calls', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.reportMuteChange('c-1', true);
    expect(mockCk.setMutedCall).not.toHaveBeenCalled();
  });

  it('ios mirrors the local mute so the lock-screen icon is truthful', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    b.reportMuteChange('c-1', true);
    b.reportMuteChange('c-1', false);
    expect(mockCk.setMutedCall).toHaveBeenNthCalledWith(1, 'c-1', true);
    expect(mockCk.setMutedCall).toHaveBeenNthCalledWith(2, 'c-1', false);
  });

  it('ios: a throwing setMutedCall is swallowed', async () => {
    mockPlatformOS = 'ios';
    mockCk.setMutedCall.mockImplementation(() => { throw new Error('nope'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.reportMuteChange('c-1', true)).not.toThrow();
  });
});

describe('subscribeToCallKitEvents — the system-UI → state-machine seam', () => {
  it('drives onAnswer / onEnd from the native callUUID payload', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    const onAnswer = jest.fn();
    const onEnd    = jest.fn();
    b.subscribeToCallKitEvents({onAnswer, onEnd});
    emit('answerCall', {callUUID: 'c-9'});
    emit('endCall',    {callUUID: 'c-9'});
    expect(onAnswer).toHaveBeenCalledWith('c-9');
    expect(onEnd).toHaveBeenCalledWith('c-9');
  });

  it('drops events with no callUUID rather than firing on the empty string', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    const onAnswer = jest.fn();
    const onEnd    = jest.fn();
    const onToggleMute = jest.fn();
    const onDtmf = jest.fn();
    b.subscribeToCallKitEvents({onAnswer, onEnd, onToggleMute, onDtmf});
    emit('answerCall', {});
    emit('endCall',    {callUUID: ''});
    emit('didPerformSetMutedCallAction', {muted: true});
    emit('didPerformDTMFAction', {digits: '5'});
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onToggleMute).not.toHaveBeenCalled();
    expect(onDtmf).not.toHaveBeenCalled();
  });

  it('coerces the native muted payload to a boolean', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    const onToggleMute = jest.fn();
    b.subscribeToCallKitEvents({onToggleMute});
    emit('didPerformSetMutedCallAction', {callUUID: 'c-9', muted: true});
    emit('didPerformSetMutedCallAction', {callUUID: 'c-9'});
    expect(onToggleMute).toHaveBeenNthCalledWith(1, 'c-9', true);
    expect(onToggleMute).toHaveBeenNthCalledWith(2, 'c-9', false);
  });

  it('requires BOTH uuid and digits before forwarding DTMF', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    const onDtmf = jest.fn();
    b.subscribeToCallKitEvents({onDtmf});
    emit('didPerformDTMFAction', {callUUID: 'c-9', digits: ''});
    expect(onDtmf).not.toHaveBeenCalled();
    emit('didPerformDTMFAction', {callUUID: 'c-9', digits: '42'});
    expect(onDtmf).toHaveBeenCalledWith('c-9', '42');
  });

  it('subscribes ONLY the handlers that were supplied', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.subscribeToCallKitEvents({onAnswer: jest.fn()});
    expect(mockListeners.answerCall?.length).toBe(1);
    expect(mockListeners.endCall).toBeUndefined();
    expect(mockListeners.didPerformSetMutedCallAction).toBeUndefined();
    expect(mockListeners.didPerformDTMFAction).toBeUndefined();
  });

  it('the returned disposer removes every listener it installed', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    const off = b.subscribeToCallKitEvents({
      onAnswer: jest.fn(), onEnd: jest.fn(), onToggleMute: jest.fn(), onDtmf: jest.fn(),
    });
    off();
    expect(mockRemoved.sort()).toEqual([
      'answerCall', 'didPerformDTMFAction', 'didPerformSetMutedCallAction', 'endCall',
    ]);
  });

  it('a listener whose remove() throws does not block the rest of the teardown', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    mockCk.addEventListener.mockImplementationOnce((type: string, handler: Handler) => {
      (mockListeners[type] ??= []).push(handler);
      return {remove: () => { throw new Error('already detached'); }};
    });
    const off = b.subscribeToCallKitEvents({onAnswer: jest.fn(), onEnd: jest.fn()});
    expect(() => off()).not.toThrow();
    expect(mockRemoved).toContain('endCall');
  });

  it('returns a no-op when setup never succeeded', async () => {
    mockCk.setup.mockResolvedValue(false);
    const b = loadBridge();
    await b.setupCallKit();
    b.subscribeToCallKitEvents({onAnswer: jest.fn()});
    expect(mockCk.addEventListener).not.toHaveBeenCalled();
  });
});

describe('teardownCallKit', () => {
  it('drops live system-UI calls and unregisters the android event bridge', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.teardownCallKit();
    expect(mockCk.endAllCalls).toHaveBeenCalledTimes(1);
    expect(mockCk.unregisterAndroidEvents).toHaveBeenCalledTimes(1);
    expect(b.isCallKitActive()).toBe(false);
  });

  it('ios teardown does not touch the android-only event bridge', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    b.teardownCallKit();
    expect(mockCk.endAllCalls).toHaveBeenCalledTimes(1);
    expect(mockCk.unregisterAndroidEvents).not.toHaveBeenCalled();
  });

  it('re-arms setup so the next sign-in re-prompts for the phone-account permission', async () => {
    const b = loadBridge();
    await b.setupCallKit();
    b.teardownCallKit();
    await b.setupCallKit();
    expect(mockCk.setup).toHaveBeenCalledTimes(2);
    expect(b.isCallKitActive()).toBe(true);
  });

  it('is safe when the bridge was never set up', () => {
    const b = loadBridge();
    expect(() => b.teardownCallKit()).not.toThrow();
    expect(mockCk.endAllCalls).not.toHaveBeenCalled();
  });

  it('releases pending iOS audio-session waiters as INACTIVE instead of hanging them', async () => {
    mockPlatformOS = 'ios';
    const b = loadBridge();
    await b.setupCallKit();
    const p = b.waitForIosAudioSession(60_000);
    b.teardownCallKit();
    await expect(p).resolves.toBe(false);
  });

  it('a throwing endAllCalls still resets the flags', async () => {
    mockCk.endAllCalls.mockImplementation(() => { throw new Error('no calls'); });
    const b = loadBridge();
    await b.setupCallKit();
    expect(() => b.teardownCallKit()).not.toThrow();
    expect(b.isCallKitActive()).toBe(false);
  });
});
