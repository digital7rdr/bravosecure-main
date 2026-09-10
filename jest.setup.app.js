/**
 * Setup for the `app` jest project (RN component render tests).
 * Mocks the native modules that screens pull in transitively so a
 * component can mount under react-test-renderer without a device.
 * Add mocks here as new screens come under test.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

// These suites mount real React Native screens under react-test-renderer.
// A first render plus its async settle comfortably exceeds Jest's 5s default
// when the workers are busy — BackupSetupScreen's BKSET-27 case takes ~2s alone
// and was timing out at exactly 5000ms in a full run, which read as a flaky
// assertion but was purely the budget. The `messenger-crypto` project already
// raises its own for the same reason (pure-JS curve math).
//
// 60s, not 20s: under `npx jest` (all three projects sharing workers) these same
// suites have been measured at 35s and 55s wall-clock — 10-20x their solo time —
// so 20s still lost the race. A per-test timeout exists to catch a HANG, and 60s
// catches one just as well while no longer failing a test that is merely
// starved. It costs nothing on a passing run.
jest.setTimeout(60000);

jest.mock('react-native-reanimated', () => {
  try {
    return require('react-native-reanimated/mock');
  } catch {
    return {};
  }
});

jest.mock('react-native-safe-area-context', () => {
  const inset = {top: 0, right: 0, bottom: 0, left: 0};
  return {
    SafeAreaProvider: ({children}) => children,
    SafeAreaConsumer: ({children}) => children(inset),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({x: 0, y: 0, width: 390, height: 844}),
  };
});

jest.mock('react-native-incall-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    setKeepScreenOn: jest.fn(),
    setForceSpeakerphoneOn: jest.fn(),
    chooseAudioRoute: jest.fn(() => Promise.resolve()),
    getIsWiredHeadsetPluggedIn: jest.fn(() => Promise.resolve(false)),
  },
}));

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// react-native-webrtc — RTCView + media types referenced by call screens.
jest.mock('react-native-webrtc', () => ({
  __esModule: true,
  RTCView: 'RTCView',
  MediaStream: class {},
  mediaDevices: {getUserMedia: jest.fn(() => Promise.resolve({getTracks: () => []}))},
}));

// react-native-keyboard-controller — native WindowInsets module (K4 / B-184).
// KeyboardProvider passes children through; useKeyboardHandler is a no-op in
// jsdom (the hook's overlap arithmetic is proven purely via
// keyboardControllerOverlap, and the onEnd→overlap seam by a capturing-mock
// hook test in useKeyboardLayout.test). KeyboardController is stubbed for any
// incidental caller.
jest.mock('react-native-keyboard-controller', () => {
  const {View} = require('react-native');
  return {
    __esModule: true,
    KeyboardProvider: ({children}) => children,
    useKeyboardHandler: () => {},
    KeyboardController: {setInputMode: jest.fn(), setDefaultMode: jest.fn(), dismiss: jest.fn()},
    KeyboardAwareScrollView: View,
    KeyboardStickyView: View,
  };
});

// Keep-awake / status bar no-ops if pulled in transitively.
jest.mock(
  'expo-keep-awake',
  () => ({activateKeepAwakeAsync: jest.fn(), deactivateKeepAwake: jest.fn()}),
  {virtual: true},
);

// expo-linear-gradient ships ESM that jest doesn't transform; render it as a
// plain View in tests (preserves children + style).
jest.mock('expo-linear-gradient', () => {
  const {View} = require('react-native');
  return {LinearGradient: View};
});

// ── Native modules that ship untransformed ESM ───────────────────────────────
// Any test whose import graph reaches `authStore` dies with "Cannot use import
// statement outside a module" before a single assertion runs, because authStore
// imports these at module scope.
//
// B-661 — surfaced when the Channels tab gained an entitlement gate: suites that
// had never touched auth suddenly reached it transitively. Mocked HERE, beside
// the other native mocks, rather than in each suite — the alternative is every
// future test that happens to reach a core store paying the same toll.
//
// Both FAIL CLOSED. A test that needs the biometric gate to PASS must say so
// explicitly, so nothing sails through a lock it should have hit.
jest.mock('expo-local-authentication', () => ({
  __esModule: true,
  hasHardwareAsync: jest.fn().mockResolvedValue(false),
  isEnrolledAsync: jest.fn().mockResolvedValue(false),
  getEnrolledLevelAsync: jest.fn().mockResolvedValue(0),
  authenticateAsync: jest.fn().mockResolvedValue({success: false, error: 'not_available'}),
  cancelAuthenticate: jest.fn(),
  SecurityLevel: {NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3},
}));

jest.mock('@react-native-firebase/crashlytics', () => {
  const noop = jest.fn();
  const crashlytics = () => ({
    log: noop,
    recordError: noop,
    setUserId: noop,
    setAttribute: noop,
    setAttributes: noop,
    setCrashlyticsCollectionEnabled: noop,
  });
  return {__esModule: true, default: crashlytics, firebase: {crashlytics}};
});
