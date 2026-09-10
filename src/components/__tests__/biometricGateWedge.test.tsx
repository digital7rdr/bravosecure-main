/**
 * "Freeze at Verifying ID" — the BiometricGate wedge (vs2 review §4.5).
 *
 * REPORTED AS A CALL BUG, and it is not in the call stack at all: the literal
 * string is this gate's own "Verifying identity…". A cold boot from an incoming
 * call with Biometric Lock on has to pass through here while the 45s ring TTL
 * burns, so a hang eats the call silently.
 *
 * THE MECHANISM: `authenticateAsync` had no bound. If the native prompt never
 * resolved, status stayed 'prompting' forever — and the retry button renders
 * only on 'failed', so there was NO affordance of any kind. The re-entrancy
 * guard then made the foreground-relock a silent no-op while that call was
 * wedged: it set 'checking', `authenticate()` returned immediately, and the
 * gate parked on a spinner nothing could move. The file logged nothing on any
 * path, which is why this never appeared in a device log.
 *
 * ⚠️ THE GATE IS A SECURITY BOUNDARY. Every case here asserts the wedge is
 * ESCAPABLE, never that it is bypassed — children must stay unmounted until a
 * real `success: true` comes back.
 */
import React from 'react';
import {render, act, fireEvent} from '@testing-library/react-native';
import {Text} from 'react-native';

const mockAuthenticate = jest.fn();
const mockCancel = jest.fn(async () => {});
let appStateListener: ((s: string) => void) | null = null;

const mockLevel = jest.fn(async () => 2);   // BIOMETRIC_STRONG
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: {NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3},
  getEnrolledLevelAsync: () => mockLevel(),
  authenticateAsync: (...a: unknown[]) => mockAuthenticate(...a),
  cancelAuthenticate: () => mockCancel(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: jest.fn(async () => '1')},   // Biometric Lock ON
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
// `cancelAuthenticate` is an ANDROID-ONLY API and the RN jest preset reports
// ios, so without this the supersede path silently skips the cancel and the
// assertion below would be testing nothing.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default},
}));
jest.mock('react-native/Libraries/AppState/AppState', () => ({
  __esModule: true,
  default: {
    addEventListener: (_e: string, cb: (s: string) => void) => {
      appStateListener = cb;
      return {remove: () => { appStateListener = null; }};
    },
  },
}));

import BiometricGate from '../BiometricGate';

const CHILD = <Text>UNLOCKED CONTENT</Text>;

/**
 * ⚠️ `getByText('UNLOCKED CONTENT')` DOES NOT PROVE THE GATE IS OPEN.
 *
 * Once the user has unlocked once, the gate keeps `children` mounted forever
 * and re-locks by drawing an absolutely-positioned SIBLING overlay on top —
 * that is deliberate, so the navigation tree survives every background cycle.
 * RNTL walks the element tree and ignores stacking, so the children are found
 * either way. Two assertions in the first draft of this suite were green and
 * vacuous for exactly that reason.
 *
 * Assert on the ABSENCE OF THE LOCK instead.
 */
function expectUnlocked(u: {queryByText: (m: string | RegExp) => unknown}): void {
  expect(u.queryByText('UNLOCK')).toBeNull();
  expect(u.queryByText('Verifying identity…')).toBeNull();
  expect(u.queryByText('UNLOCKED CONTENT')).not.toBeNull();
}

/**
 * Let the mount effects (flag read → runAfterInteractions → authenticate)
 * settle.
 *
 * Advances fake timers as well as flushing microtasks: on Android the gate
 * cancels any outstanding native prompt and then waits ~250ms for that cancel
 * to LAND before opening the next one (the expo module resolves the old promise
 * on a background executor and keeps only one promise field). A microtask-only
 * flush leaves every `authenticateAsync` un-called.
 *
 * 750ms total — past the 250ms settle, inside both watchdogs (8s / 6s).
 */
async function settle(): Promise<void> {
  /**
   * SEPARATE `act` BOUNDARIES, not a loop inside one.
   *
   * React batches the state update from the flag-read continuation and only
   * commits it when `act` finishes — so the effect that calls `authenticate()`,
   * and therefore the 250ms timer, does not exist until the act block ends.
   * Advancing timers inside that same block runs every advance BEFORE the timer
   * they are meant to fire (verified with a probe: the pre-settle log appeared,
   * the post-settle one never did). Alternating commit/advance rounds is what
   * actually drives the chain.
   */
  for (let round = 0; round < 5; round++) {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { jest.advanceTimersByTime(150); });
  }
}

beforeEach(() => {
  // `clearAllMocks` clears CALLS but not implementations, so a
  // `mockReturnValue(neverResolves)` from an earlier case would silently become
  // the file-wide default for any unqueued call.
  mockAuthenticate.mockReset();
  mockCancel.mockReset();
  mockCancel.mockResolvedValue(undefined);
  mockLevel.mockReset();
  mockLevel.mockResolvedValue(2);
  jest.useFakeTimers();
  appStateListener = null;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('a prompt that never answers is ESCAPABLE', () => {
  it('offers UNLOCK after the watchdog instead of spinning forever', async () => {
    mockAuthenticate.mockReturnValue(new Promise(() => {}));   // never resolves
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    // Before the watchdog: the honest waiting state, no affordance.
    expect(u.queryByText('UNLOCK')).toBeNull();

    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(u.getByText('UNLOCK')).toBeTruthy();
    // …and it says what actually happened.
    expect(u.getByText(/did not respond/i)).toBeTruthy();
  });

  it('does NOT let the user in — the wedge is escapable, not bypassed', async () => {
    mockAuthenticate.mockReturnValue(new Promise(() => {}));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(u.queryByText('UNLOCKED CONTENT')).toBeNull();
  });

  it('pressing UNLOCK supersedes the dead prompt and opens a NEW one', async () => {
    // The old guard swallowed this press: `authenticating.current` was still
    // true, so the retry was a no-op and the button did nothing at all.
    mockAuthenticate.mockReturnValueOnce(new Promise(() => {}));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);

    mockAuthenticate.mockResolvedValueOnce({success: true});
    await act(async () => { fireEvent.press(u.getByText('UNLOCK')); });
    await settle();
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
    expect(mockCancel).toHaveBeenCalled();          // the dead prompt is dismissed
    expectUnlocked(u);
  });
});

describe('the relock path cannot park the gate on a spinner', () => {
  it('an AppState fire racing the mount effect opens NO second prompt, and still escapes', async () => {
    /**
     * THE ORIGINAL WEDGE, exactly. On Android launch, AppState 'active' fires
     * alongside the mount effect: `backgroundedAt` is null so `awayMs` is 0, the
     * grace window does not apply, and the relock arm runs. It set 'checking'
     * and called `authenticate()`, which returned early on the re-entrancy
     * guard — leaving the gate on a spinner that nothing could ever move,
     * because the retry button renders only on a failed state.
     */
    mockAuthenticate.mockReturnValue(new Promise(() => {}));   // never resolves
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    expect(appStateListener).not.toBeNull();

    await act(async () => { appStateListener!('active'); });
    await settle();
    // The guard still does its real job: no second native prompt behind the first.
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    // …but the outstanding run's watchdog still owns the outcome, so the user
    // is not stranded on 'checking'.
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(u.getByText('UNLOCK')).toBeTruthy();
    expect(u.queryByText('UNLOCKED CONTENT')).toBeNull();
  });

  it('a real background→foreground relock over a STALLED prompt starts a fresh one', async () => {
    // Any relock necessarily lands >30s after backgrounding, so the 20s
    // watchdog has always fired by then: the outstanding prompt is presumed
    // dead and the returning user gets a live prompt rather than a corpse.
    mockAuthenticate.mockReturnValueOnce(new Promise(() => {}));
    render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();

    await act(async () => { appStateListener!('background'); });
    await act(async () => { jest.advanceTimersByTime(31_000); });
    mockAuthenticate.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { appStateListener!('active'); });
    await settle();
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
    expect(mockCancel).toHaveBeenCalled();
  });
});

describe('a late answer from a superseded prompt', () => {
  it('a late SUCCESS unlocks, and the superseding prompt cannot re-lock it', async () => {
    // The user proved who they are. Re-locking them because the prompt that
    // replaced the dead one was then cancelled would be the fix creating its
    // own lockout.
    let resolveFirst: ((r: {success: boolean}) => void) | null = null;
    mockAuthenticate.mockReturnValueOnce(new Promise(r => { resolveFirst = r as never; }));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    await act(async () => { jest.advanceTimersByTime(10_000); });

    let resolveSecond: ((r: {success: boolean}) => void) | null = null;
    mockAuthenticate.mockReturnValueOnce(new Promise(r => { resolveSecond = r as never; }));
    await act(async () => { fireEvent.press(u.getByText('UNLOCK')); });
    await settle();

    // The FIRST prompt answers late, with a success.
    await act(async () => { resolveFirst!({success: true}); });
    await settle();
    expectUnlocked(u);

    // Now the second prompt is cancelled. The user must stay in.
    await act(async () => { resolveSecond!({success: false}); });
    await settle();
    expectUnlocked(u);
  });

  it('a late FAILURE from a superseded run is ignored', async () => {
    let resolveFirst: ((r: {success: boolean}) => void) | null = null;
    mockAuthenticate.mockReturnValueOnce(new Promise(r => { resolveFirst = r as never; }));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    await act(async () => { jest.advanceTimersByTime(10_000); });

    mockAuthenticate.mockResolvedValueOnce({success: true});
    await act(async () => { fireEvent.press(u.getByText('UNLOCK')); });
    await settle();
    expectUnlocked(u);

    await act(async () => { resolveFirst!({success: false}); });
    await settle();
    expectUnlocked(u);
  });
});

describe('the watchdog is disarmed once the run finishes', () => {
  it('a successful unlock is NOT re-locked when the watchdog deadline passes', async () => {
    /**
     * Nothing pinned `clearTimeout(watchdog)`. Delete it and every test still
     * passed — while on a device the app would spontaneously re-lock itself
     * `PROMPT_WATCHDOG_MS` after EVERY successful unlock, because the stale
     * timer still owns the run and flips it to 'stalled'.
     */
    mockAuthenticate.mockResolvedValue({success: true});
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    expectUnlocked(u);

    await act(async () => { jest.advanceTimersByTime(60_000); });
    expectUnlocked(u);
  });

  it('a superseded run\'s watchdog cannot stall a live unlocked state', async () => {
    // The watchdog's own ownership check. Without it, run 1's timer fires after
    // run 2 has unlocked and drags the user back behind the overlay.
    let resolveFirst: ((r: {success: boolean}) => void) | null = null;
    mockAuthenticate.mockReturnValueOnce(new Promise(r => { resolveFirst = r as never; }));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    await act(async () => { jest.advanceTimersByTime(10_000); });

    mockAuthenticate.mockResolvedValueOnce({success: true});
    await act(async () => { fireEvent.press(u.getByText('UNLOCK')); });
    await settle();
    expectUnlocked(u);

    // Run 1 finally answers, and its timer window elapses.
    await act(async () => { resolveFirst!({success: false}); });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expectUnlocked(u);
  });
});

describe('an Android biometric LOCKOUT must not open the gate', () => {
  it('a locked-out device still gets a prompt, not a free pass', async () => {
    /**
     * THE FAIL-OPEN THIS CLOSES. `isEnrolledAsync()` is
     * `canAuthenticate(BIOMETRIC_WEAK) == SUCCESS`, so five failed fingerprint
     * attempts make it return false — and the old predicate read that as "no
     * biometrics on this device" and took the `unsupported` arm, which sets
     * `everUnlocked` and opens the app with NO authentication at all. Fail 5x,
     * force-stop, relaunch, and you were in. iOS already counted
     * `biometryLockout` as enrolled; Android did not.
     *
     * A lockout still reports a non-NONE enrolled LEVEL, so the gate prompts —
     * and `disableDeviceFallback:false` lets the user through on their PIN.
     */
    mockLevel.mockResolvedValue(1);                       // SECRET — PIN only / locked out
    mockAuthenticate.mockReturnValue(new Promise(() => {}));
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);    // prompted, not waved through
    expect(u.queryByText('UNLOCKED CONTENT')).toBeNull();
  });

  it('only a device with NOTHING enrolled falls through', async () => {
    // The case the arm exists for — do not brick an unconfigured device.
    mockLevel.mockResolvedValue(0);                       // NONE
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expectUnlocked(u);
  });
});

describe('the BOOT path has its own deadline', () => {
  it('an opt-in flag read that never settles ends on the retry button, not a blank spinner', async () => {
    /**
     * The prompt watchdog structurally cannot see this: it only starts once
     * `authenticate()` has been entered, and the flag read happens BEFORE that.
     * A hung read left `lockEnabled` null forever, which renders a full-screen
     * spinner with no label and no button — a more silent wedge than the one
     * this file exists to fix.
     */
    const AS = require('@react-native-async-storage/async-storage').default as {getItem: jest.Mock};
    AS.getItem.mockReturnValueOnce(new Promise(() => {}));   // never settles
    const u = render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    expect(u.queryByText('UNLOCK')).toBeNull();
    expect(mockAuthenticate).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(6_000); });
    expect(u.getByText('UNLOCK')).toBeTruthy();
    // FAILS CLOSED: an unreadable flag engages the lock rather than skipping it.
    expect(u.queryByText('UNLOCKED CONTENT')).toBeNull();
  });
});

describe('the lane is visible in a release device log', () => {
  it('warns on open and on stall — `log` is stripped in release, `warn` is not', async () => {
    mockAuthenticate.mockReturnValue(new Promise(() => {}));
    render(<BiometricGate>{CHILD}</BiometricGate>);
    await settle();
    const warn = console.warn as jest.Mock;
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[biogate\] prompt open/);
    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\[biogate\] STALLED/);
  });
});
