/**
 * iOS PushKit bootstrap — push/voipPush.ts.
 *
 * This module had ZERO executable coverage. It owns the iOS half of the VoIP
 * wake lane, and Apple's contract makes several of its branches load-bearing in
 * a way no source scan can prove:
 *
 *   • Android must never touch PushKit at all (the FCM-data lane in
 *     fcmBootstrap.ts is Android's VoIP path). A stray registration there is a
 *     second token lifecycle for a token the server would never sign.
 *   • Apple rotates the VoIP token on reinstall / restore / cert switch, so the
 *     `register` event — not the (always-null) getToken shim — is what actually
 *     posts the token. Losing that listener silently kills killed-app ringing
 *     after the next reinstall.
 *   • Every inbound PushKit push MUST report a CallKit incoming call within
 *     ~5 s or the entitlement is revoked. So reportIncomingCall fires BEFORE the
 *     HMAC verification, and a failed verification must then reportEnded(...,
 *     'failed') rather than skip the display.
 *   • The wake key the server mints on /push/register-voip has to reach
 *     voipWakeVerify's keychain slot, or every subsequent wake fails to verify.
 *
 * Everything here executes the real module; only the edges (native PushKit
 * module, network, keychain-backed verifier, auth store) are mocked, in-file.
 */

const mockPlatform: {OS: 'ios' | 'android'; Version: number} = {OS: 'ios', Version: 17};
jest.mock('react-native', () => ({Platform: mockPlatform, NativeModules: {}}));

const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
  },
}));

jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));

// ── the native PushKit module ────────────────────────────────────────────────
const mockHandlers = new Map<string, (arg: unknown) => void>();
const mockVoip = {
  registerVoipToken:   jest.fn(),
  addEventListener:    jest.fn((type: string, handler: (arg: unknown) => void) => { mockHandlers.set(type, handler); }),
  removeEventListener: jest.fn((type: string) => { mockHandlers.delete(type); }),
};
let mockNativeLinked = true;
jest.mock('react-native-voip-push-notification', () => ({
  __esModule: true,
  // A dev build without the native module autolinked hands back a shape with no
  // addEventListener — getPushKit() must treat that as "inert", not crash.
  get default() { return mockNativeLinked ? mockVoip : {}; },
}));

jest.mock('../push/callKitBridge', () => ({
  reportIncomingCall: jest.fn(),
  reportEnded:        jest.fn(),
}));

jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake:    jest.fn(async () => ({ok: true, reason: 'verified'})),
  storeVoipWakeKey:  jest.fn(async () => {}),
}));

jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'self-1'}})},
}));

type Voip = typeof import('../push/voipPush');
function loadVoipPush(): Voip {
  return require('../push/voipPush') as Voip;
}

// jest.resetModules() re-runs every mock factory, so a top-level `import` of a
// mocked seam would hold a DEAD instance while the module under test talks to a
// fresh one. Read them live, the same way fcmBootstrapOrder.test.ts does.
let ring:     jest.Mock;
let ended:    jest.Mock;
let verify:   jest.Mock;
let storeKey: jest.Mock;
let fetchMock: jest.Mock;

/** Let the module's floating promises (`void verifyAndDispatch`, `.catch`) settle. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) { await Promise.resolve(); }
}

function okResponse(body: unknown = {ok: true}) {
  return {
    ok:     true,
    status: 200,
    json:   async () => body,
    text:   async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  // `started` / `unsubTokenRefresh` latch at module scope — every case needs a
  // virgin module registry.
  jest.resetModules();
  jest.clearAllMocks();
  mockHandlers.clear();
  mockAsyncStore.clear();
  mockNativeLinked = true;
  mockPlatform.OS = 'ios';

  const bridge = require('../push/callKitBridge') as Record<string, jest.Mock>;
  const wake   = require('../push/voipWakeVerify') as Record<string, jest.Mock>;
  ring     = bridge.reportIncomingCall;
  ended    = bridge.reportEnded;
  verify   = wake.verifyVoipWake;
  storeKey = wake.storeVoipWakeKey;
  verify.mockImplementation(async () => ({ok: true, reason: 'verified'}));

  fetchMock = jest.fn(async () => okResponse());
  (global as {fetch?: unknown}).fetch = fetchMock;
});

describe('startVoipPushBootstrap — platform gate', () => {
  it('is a total no-op on Android (the FCM-data lane owns VoIP wakes there)', async () => {
    mockPlatform.OS = 'android';
    await loadVoipPush().startVoipPushBootstrap();

    expect(mockVoip.registerVoipToken).not.toHaveBeenCalled();
    expect(mockVoip.addEventListener).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on iOS asks the OS for the token and wires register + notification + cold-launch replay', async () => {
    await loadVoipPush().startVoipPushBootstrap();

    // PushKit has no synchronous getToken — registerVoipToken() is what makes
    // the OS deliver the token through the `register` event.
    expect(mockVoip.registerVoipToken).toHaveBeenCalledTimes(1);
    expect(mockHandlers.has('register')).toBe(true);
    expect(mockHandlers.has('notification')).toBe(true);
    // Without didLoadWithEvents, a push-triggered COLD launch replays neither
    // the token nor the wake — the app rings once and never re-registers.
    expect(mockHandlers.has('didLoadWithEvents')).toBe(true);
  });

  it('is idempotent — a second bootstrap in the same process does not double-subscribe', async () => {
    const voip = loadVoipPush();
    await voip.startVoipPushBootstrap();
    const afterFirst = mockVoip.addEventListener.mock.calls.length;
    await voip.startVoipPushBootstrap();

    expect(mockVoip.addEventListener.mock.calls.length).toBe(afterFirst);
    expect(mockVoip.registerVoipToken).toHaveBeenCalledTimes(1);
  });

  it('stays inert when the native PushKit module is not linked', async () => {
    mockNativeLinked = false;
    await loadVoipPush().startVoipPushBootstrap();

    expect(mockHandlers.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stopVoipPushBootstrap drops the rotation listener and re-arms the bootstrap', async () => {
    const voip = loadVoipPush();
    await voip.startVoipPushBootstrap();
    voip.stopVoipPushBootstrap();

    // The unsubscribe the adapter returns is the module's removeEventListener.
    expect(mockVoip.removeEventListener).toHaveBeenCalledWith('register');

    // `started` cleared → a re-login re-registers instead of silently skipping.
    await voip.startVoipPushBootstrap();
    expect(mockVoip.registerVoipToken).toHaveBeenCalledTimes(2);
  });
});

describe('token registration — POST /push/register-voip', () => {
  it('posts the rotated token with the iOS platform + device-id header the gateway requires', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    await loadVoipPush().startVoipPushBootstrap();
    // Apple rotates on reinstall / restore / cert switch — this is the lane
    // that keeps the server's stored token from going stale.
    mockHandlers.get('register')!('pushkit-token-xyz');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://msg.test/push/register-voip');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Authorization':      'Bearer jwt-abc',
      'Content-Type':       'application/json',
      'X-Signal-Device-Id': '1',
    });
    // `platform: 'ios'` is what routes this token into the server's APNs-VoIP
    // sender rather than the FCM high-priority path.
    expect(JSON.parse(String(init.body))).toEqual({platform: 'ios', token: 'pushkit-token-xyz'});
  });

  it('does not post at all before the user has a JWT (retries on the next bootstrap)', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('register')!('tok-no-auth');
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeKey).not.toHaveBeenCalled();
  });

  it('persists the wake key the server mints so later wakes can HMAC-verify', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    fetchMock.mockImplementation(async () => okResponse({wakeKeyB64: 'V0FLRUtFWQ=='}));
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('register')!('tok-1');
    await flush();

    // deviceId '1' — the same account key voipWakeVerify reads back.
    expect(storeKey).toHaveBeenCalledWith('self-1', '1', 'V0FLRUtFWQ==');
  });

  it('a non-2xx register neither stores a key nor rejects into the event loop', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    fetchMock.mockImplementation(async () => ({
      ok: false, status: 500, text: async () => 'boom', json: async () => ({}),
    }));
    await loadVoipPush().startVoipPushBootstrap();
    expect(() => mockHandlers.get('register')!('tok-1')).not.toThrow();
    await flush();

    expect(storeKey).not.toHaveBeenCalled();
  });

  it('a response without wakeKeyB64 registers the token but stores nothing', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    fetchMock.mockImplementation(async () => okResponse({ok: true}));
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('register')!('tok-1');
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storeKey).not.toHaveBeenCalled();
  });
});

describe('inbound PushKit notification — Apple 5-second contract', () => {
  it('reports the CallKit incoming call BEFORE the HMAC verification runs', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callId: 'call-1', callerName: 'Alice', callKind: 'video'});

    // Synchronous: reportIncomingCall must have fired on the same tick the push
    // was delivered, and strictly BEFORE the verifier — missing Apple's ~5 s
    // CXCallUpdate window once revokes the VoIP entitlement, so verification
    // can only ever un-ring a call it already displayed.
    expect(ring).toHaveBeenCalledTimes(1);
    expect(ring).toHaveBeenCalledWith({callId: 'call-1', callerName: 'Alice', kind: 'video'});
    expect(ring.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);

    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic caller label and voice kind for an unlabelled wake', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callId: 'call-2'});
    await flush();

    expect(ring).toHaveBeenCalledWith({callId: 'call-2', callerName: 'Bravo contact', kind: 'voice'});
  });

  it('drops a failed verification by ending the briefly-displayed CallKit ring', async () => {
    verify.mockImplementation(async () => ({ok: false, reason: 'replay'}));
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callId: 'call-3', nonce: 'n1', exp: '1700000000', sig: 'sig'});
    await flush();

    // The user sees a flash of CallKit UI — far better than losing the
    // entitlement, and far better than ring-spam from a replayed payload.
    expect(ended).toHaveBeenCalledWith('call-3', 'failed');
  });

  it('leaves a verified ring standing (the WS call.offer drives the rest)', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callId: 'call-4', nonce: 'n1', exp: 1700000000, sig: 'sig'});
    await flush();

    expect(ended).not.toHaveBeenCalled();
  });

  it('coerces a string exp to a number for the verifier (APNs delivers strings)', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callId: 'call-5', nonce: 'n5', exp: '1700000000', sig: 'sig-5'});
    await flush();

    expect(verify).toHaveBeenCalledWith({
      selfUserId: 'self-1',
      fields: {
        kind: 'voip-wake', callId: 'call-5', callKind: 'voice',
        nonce: 'n5', exp: 1700000000, sig: 'sig-5',
      },
    });
  });

  it('ignores a malformed push with no callId (nothing to report to CallKit)', async () => {
    await loadVoipPush().startVoipPushBootstrap();
    mockHandlers.get('notification')!({callerName: 'Nobody'} as unknown as {callId: string});
    await flush();

    expect(ring).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('cold-launch replay (didLoadWithEvents)', () => {
  it('re-registers the token and re-rings the cached wake the launch was for', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    await loadVoipPush().startVoipPushBootstrap();

    mockHandlers.get('didLoadWithEvents')!([
      {name: 'RNVoipPushRemoteNotificationsRegisteredEvent', data: 'replayed-token'},
      {name: 'RNVoipPushRemoteNotificationReceivedEvent', data: {callId: 'call-cold', callerName: 'Bob'}},
    ]);
    await flush();

    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)))
      .toEqual({platform: 'ios', token: 'replayed-token'});
    expect(ring).toHaveBeenCalledWith({callId: 'call-cold', callerName: 'Bob', kind: 'voice'});
  });

  it('ignores a non-array replay payload and a register event with non-string data', async () => {
    mockAsyncStore.set('auth:access_token', 'jwt-abc');
    await loadVoipPush().startVoipPushBootstrap();

    mockHandlers.get('didLoadWithEvents')!(undefined);
    mockHandlers.get('didLoadWithEvents')!([
      {name: 'RNVoipPushRemoteNotificationsRegisteredEvent', data: {not: 'a token'}},
    ]);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ring).not.toHaveBeenCalled();
  });
});
