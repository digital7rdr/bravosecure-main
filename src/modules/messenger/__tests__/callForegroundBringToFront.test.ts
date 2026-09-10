/**
 * NA-04 (native leg) — CallKeep's backToForeground() sends a BARE launcher
 * intent, so MainActivity.isCallLaunch is false and setCallLaunchFlags(false)
 * actively CLEARS showWhenLocked/turnScreenOn: a lock-screen answer stays
 * behind the keyguard and the process never reaches the foreground procstate
 * the mic/camera FGS types require.
 *
 * bringAppToForeground() must therefore prefer BravoCallForeground's own
 * launch intent (which carries EXTRA_CALL_LAUNCH) and only fall back to
 * CallKeep when the native method is missing (pre-NA-04 binary).
 */

const mockNativeModules: Record<string, unknown> = {};
let mockPlatformOS = 'android';
jest.mock('react-native', () => ({
  get Platform() { return {OS: mockPlatformOS}; },
  NativeModules: mockNativeModules,
  DeviceEventEmitter: {addListener: jest.fn(() => ({remove: jest.fn()}))},
}));

const mockBackToForeground = jest.fn();
jest.mock('react-native-callkeep', () => ({
  __esModule: true,
  default: {
    setup:                 jest.fn(async () => true),
    registerAndroidEvents: jest.fn(),
    addEventListener:      jest.fn(() => ({remove: jest.fn()})),
    backToForeground:      mockBackToForeground,
  },
}));

type FgModule = typeof import('../runtime/callForegroundService');
type BridgeModule = typeof import('../push/callKitBridge');

function loadFg(native: unknown): FgModule {
  mockNativeModules.BravoCallForeground = native;
  return require('../runtime/callForegroundService') as FgModule;
}

function loadBridge(native: unknown): BridgeModule {
  mockNativeModules.BravoCallForeground = native;
  return require('../push/callKitBridge') as BridgeModule;
}

beforeEach(() => {
  // The bridge lazy-require()s callForegroundService, which snapshots
  // NativeModules.BravoCallForeground at load time — a shared registry would
  // hand the next test the previous test's native stub.
  jest.resetModules();
  mockPlatformOS = 'android';
  mockBackToForeground.mockClear();
  for (const k of Object.keys(mockNativeModules)) { delete mockNativeModules[k]; }
});

describe('NA-04 — callForegroundService.bringCallUiToForeground', () => {
  it('returns false and calls nothing on a pre-NA-04 binary (method absent)', () => {
    const fg = loadFg({start: jest.fn(), stop: jest.fn()});
    expect(fg.bringCallUiToForeground()).toBe(false);
  });

  it('invokes the native method and returns true when present', () => {
    const bring = jest.fn();
    const fg = loadFg({start: jest.fn(), stop: jest.fn(), bringCallUiToForeground: bring});
    expect(fg.bringCallUiToForeground()).toBe(true);
    expect(bring).toHaveBeenCalledTimes(1);
  });

  it('returns false instead of throwing when the native call blows up', () => {
    const bring = jest.fn(() => { throw new Error('boom'); });
    const fg = loadFg({start: jest.fn(), stop: jest.fn(), bringCallUiToForeground: bring});
    expect(fg.bringCallUiToForeground()).toBe(false);
  });
});

describe('NA-04 — callKitBridge.bringAppToForeground routing', () => {
  it('uses the EXTRA_CALL_LAUNCH native path and does NOT fall back to CallKeep', async () => {
    const bring = jest.fn();
    const bridge = loadBridge({start: jest.fn(), stop: jest.fn(), bringCallUiToForeground: bring});
    await bridge.setupCallKit();

    bridge.bringAppToForeground();

    expect(bring).toHaveBeenCalledTimes(1);
    expect(mockBackToForeground).not.toHaveBeenCalled();
  });

  it('falls back to CallKeep when the native method is missing (old APK, new JS)', async () => {
    const bridge = loadBridge({start: jest.fn(), stop: jest.fn()});
    await bridge.setupCallKit();

    bridge.bringAppToForeground();

    expect(mockBackToForeground).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on iOS (the system surfaces the app on a CallKit answer)', async () => {
    const bring = jest.fn();
    const bridge = loadBridge({start: jest.fn(), stop: jest.fn(), bringCallUiToForeground: bring});
    await bridge.setupCallKit();
    mockPlatformOS = 'ios';

    bridge.bringAppToForeground();

    expect(bring).not.toHaveBeenCalled();
    expect(mockBackToForeground).not.toHaveBeenCalled();
  });
});
