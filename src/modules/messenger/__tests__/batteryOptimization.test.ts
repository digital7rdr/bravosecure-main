/**
 * P2-BR-1 — the battery-optimization wrapper must degrade safely (a missing
 * native module means "nothing to prompt", never a throw), detect the
 * autostart OEM family from the platform fingerprint, and keep the
 * reliability-prompt snooze per owner with expiry.
 */

const mockIsIgnoring = jest.fn(async () => false);
const mockRequest = jest.fn(async () => undefined);
const mockAutostart = jest.fn(async () => true);

jest.mock(
  'react-native',
  () => ({
    Platform: {OS: 'android', constants: {Manufacturer: 'TECNO', Brand: 'TECNO'}},
    NativeModules: {},
  }),
  {virtual: true},
);

const mockStorage = new Map<string, string>();
jest.mock(
  '@react-native-async-storage/async-storage',
  () => ({
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => mockStorage.get(k) ?? null),
      setItem: jest.fn(async (k: string, v: string) => { mockStorage.set(k, v); }),
    },
  }),
  {virtual: true},
);

import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  openAutostartSettings,
  hasOemAutostartScreen,
  snoozeReliabilityPrompt,
  isReliabilityPromptSnoozed,
} from '../push/batteryOptimization';

// Mutate the mocked module's NativeModules in place — the factory cannot
// reference outer objects (jest-hoist), and the wrapper reads NativeModules
// lazily per call, so per-test mutation works.
const mockNativeModules = (jest.requireMock('react-native') as {NativeModules: Record<string, unknown>}).NativeModules;

beforeEach(() => {
  mockIsIgnoring.mockClear();
  mockRequest.mockClear();
  mockAutostart.mockClear();
  mockStorage.clear();
  mockNativeModules.BravoBatteryOptimization = {
    isIgnoringBatteryOptimizations: mockIsIgnoring,
    requestIgnoreBatteryOptimizations: mockRequest,
    openAutostartSettings: mockAutostart,
  };
});

describe('batteryOptimization wrapper', () => {
  it('forwards the native exemption state', async () => {
    mockIsIgnoring.mockResolvedValueOnce(false);
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(false);
    mockIsIgnoring.mockResolvedValueOnce(true);
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true);
  });

  it('missing native module (old APK / iOS) means nothing to prompt', async () => {
    delete mockNativeModules.BravoBatteryOptimization;
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true);
    await expect(openAutostartSettings()).resolves.toBe(false);
    await expect(requestIgnoreBatteryOptimizations()).resolves.toBeUndefined();
    expect(mockIsIgnoring).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('a native reject is contained, never propagated', async () => {
    mockIsIgnoring.mockRejectedValueOnce(new Error('binder died'));
    await expect(isIgnoringBatteryOptimizations()).resolves.toBe(true);
    mockAutostart.mockRejectedValueOnce(new Error('binder died'));
    await expect(openAutostartSettings()).resolves.toBe(false);
    mockRequest.mockRejectedValueOnce(new Error('binder died'));
    await expect(requestIgnoreBatteryOptimizations()).resolves.toBeUndefined();
  });

  it('openAutostartSettings reports whether an OEM screen opened', async () => {
    mockAutostart.mockResolvedValueOnce(true);
    await expect(openAutostartSettings()).resolves.toBe(true);
    mockAutostart.mockResolvedValueOnce(false); // app-details fallback
    await expect(openAutostartSettings()).resolves.toBe(false);
  });

  it('detects the Transsion (TECNO KM5 QA device) fingerprint as autostart OEM', () => {
    expect(hasOemAutostartScreen()).toBe(true);
  });
});

describe('reliability-prompt snooze (per owner, ~7 days)', () => {
  it('is not snoozed by default, snoozes after dismiss, and is per owner', async () => {
    await expect(isReliabilityPromptSnoozed('user-1')).resolves.toBe(false);
    await snoozeReliabilityPrompt('user-1');
    await expect(isReliabilityPromptSnoozed('user-1')).resolves.toBe(true);
    await expect(isReliabilityPromptSnoozed('user-2')).resolves.toBe(false);
  });

  it('an expired snooze no longer suppresses the prompt', async () => {
    await snoozeReliabilityPrompt('user-1', -1);
    await expect(isReliabilityPromptSnoozed('user-1')).resolves.toBe(false);
  });

  it('a corrupt persisted value fails open (prompt shows)', async () => {
    mockStorage.set('notifReliability:snoozeUntil:user-1', 'not-a-number');
    await expect(isReliabilityPromptSnoozed('user-1')).resolves.toBe(false);
  });
});
