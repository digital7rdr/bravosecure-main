/**
 * Warm-start FIX-12 (B-438 residual) — an unreadable lock flag must not
 * silently disable the app lock.
 *
 * `AsyncStorage.getItem(LOCK_KEY).catch(() => null)` treated a storage ERROR
 * exactly like "the user never enabled the lock": `v === '1'` was false, the
 * gate rendered its children, and the security control was simply absent for
 * that whole boot with nothing in the logs to say so.
 *
 * ⚠️ THE GATE IS A SECURITY BOUNDARY. Like biometricGateWedge.test.tsx, every
 * case here asserts the gate is ESCAPABLE, never that it is bypassed — the
 * fail-closed path must still land on an actionable screen, because a lock
 * that cannot be dismissed when storage is broken is its own outage.
 */
import React from 'react';
import {render, act} from '@testing-library/react-native';
import {Text} from 'react-native';

const mockStore: Record<string, string> = {};
let mockGetItemImpl: (k: string) => Promise<string | null> = async k => mockStore[k] ?? null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => mockGetItemImpl(k),
    setItem: jest.fn(async (k: string, v: string) => { mockStore[k] = v; }),
  },
}));

const mockAuthenticate = jest.fn(async (_opts?: unknown) => ({success: true}));
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: {NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3},
  getEnrolledLevelAsync: async () => 2,
  authenticateAsync: (opts?: unknown) => mockAuthenticate(opts),
  cancelAuthenticate: async () => {},
}));
jest.mock('@/modules/messenger/vault', () => ({
  useVaultStore: {getState: () => ({lock: jest.fn()})},
}));
jest.mock('@components/LoadingView', () => {
  const {Text: T} = require('react-native');
  const React2 = require('react');
  return {
    __esModule: true,
    default: ({label}: {label?: string}) => React2.createElement(T, null, label ?? 'loading'),
    BravoShieldBadge: () => React2.createElement(T, null, 'shield'),
  };
});
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('react-native/Libraries/Interaction/InteractionManager', () => ({
  __esModule: true,
  default: {runAfterInteractions: (cb: () => void) => { cb(); return {cancel: () => {}}; }},
}));

import BiometricGate from '@components/BiometricGate';

const CHILD = 'protected-content';
const renderGate = () =>
  render(<BiometricGate><Text>{CHILD}</Text></BiometricGate>);

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i++) { await Promise.resolve(); }
  });
};

const MIRROR = 'settings:biometricLock:lastKnown';
const LOCK = 'settings:biometricLock';

beforeEach(() => {
  Object.keys(mockStore).forEach(k => { delete mockStore[k]; });
  mockGetItemImpl = async k => mockStore[k] ?? null;
  jest.clearAllMocks();
});

describe('FIX-12 — an unreadable lock flag fails closed', () => {
  it('mirrors the flag whenever it reads it successfully', async () => {
    mockStore[LOCK] = '1';
    renderGate();
    await settle();
    expect(mockStore[MIRROR]).toBe('1');
  });

  it('mirrors the OFF state too, so disabling the lock is remembered', async () => {
    mockStore[LOCK] = '0';
    renderGate();
    await settle();
    expect(mockStore[MIRROR]).toBe('0');
  });

  it('retries once before believing storage is broken', async () => {
    let calls = 0;
    mockGetItemImpl = async k => {
      if (k === LOCK) {
        calls += 1;
        if (calls === 1) {throw new Error('storage blip');}
        return '1';
      }
      return mockStore[k] ?? null;
    };

    renderGate();
    await settle();

    expect(calls).toBeGreaterThanOrEqual(2);
    // Second read said the lock is ON, so the gate must have ENGAGED — i.e.
    // prompted. (It then unlocks, because the mocked prompt succeeds; asserting
    // on the children would be asserting the prompt result, not the gate.)
    expect(mockAuthenticate).toHaveBeenCalled();
  });

  it('keeps the lock ON when storage dies and the mirror says it was enabled', async () => {
    mockStore[MIRROR] = '1';
    mockGetItemImpl = async k => {
      if (k === LOCK) {throw new Error('storage down');}
      return mockStore[k] ?? null;
    };

    renderGate();
    await settle();

    // THE BUG: one transient read error used to skip the prompt entirely and
    // the app lock was gone for the whole boot.
    expect(mockAuthenticate).toHaveBeenCalled();
  });

  it('stays open when storage dies and the lock was never enabled', async () => {
    mockStore[MIRROR] = '0';
    mockGetItemImpl = async k => {
      if (k === LOCK) {throw new Error('storage down');}
      return mockStore[k] ?? null;
    };

    const {queryByText} = renderGate();
    await settle();

    // Biometric Lock is opt-in; failing closed for someone who never turned it
    // on would be an outage, not a defence.
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(queryByText(CHILD)).toBeTruthy();
  });

  it('stays open when BOTH the flag and the mirror are unreadable', async () => {
    mockGetItemImpl = async () => { throw new Error('storage fully down'); };

    const {queryByText} = renderGate();
    await settle();

    // No evidence the lock was ever on — same as the pre-existing default.
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(queryByText(CHILD)).toBeTruthy();
  });

  it('does not throw when the storage shim has no setItem', async () => {
    const asyncStorage = (require('@react-native-async-storage/async-storage') as {
      default: {setItem?: unknown};
    }).default;
    const saved = asyncStorage.setItem;
    asyncStorage.setItem = undefined;
    mockStore[LOCK] = '0';
    try {
      expect(() => { renderGate(); }).not.toThrow();
      await settle();
    } finally {
      asyncStorage.setItem = saved;
    }
  });
});
