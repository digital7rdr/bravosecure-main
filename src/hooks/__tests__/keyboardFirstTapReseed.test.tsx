/**
 * sqa.md bug register — this suite pins: B-195, B-277.
 *
 * B-195 (the composer hid under the keyboard on FIRST entry — useKeyboardHeight seeded
 * useState(0) and subscribed in an effect, but didShow fires once, at the END of the show
 * animation, so a screen mounted while the IME was already up never got an event and never
 * lifted; backing out and re-entering earns a fresh didShow, which is the reported "works
 * the second time") is the same defect class this suite pins for B-277. The B-195-shaped
 * case is "seeds IMMEDIATELY when the keyboard is already fully open at mount". The inline
 * duplicate of the hook that ChatScreen carried is gone; the app-wide rule is now
 * useKeyboardLayout (B-184).
 */
/**
 * B-277 — "tap the text box fast and it does not come above the keyboard;
 * dismiss it, open it again, and now it does."
 *
 * Android emits `keyboardDidShow` only on a visibility TRANSITION. Three things
 * race on a fast tap: the IME starts animating, didShow fires, and
 * useKeyboardOverlap's effect attaches its listener. `useEffect` is a PASSIVE
 * effect — flushed after paint — so on a busy JS thread the listener can attach
 * AFTER didShow already fired. That event is then gone for good.
 *
 * B-252 added a seed from Keyboard.isVisible()/metrics() for exactly this, but
 * it sampled ONCE, at effect time, when the keyboard is still mid-animation and
 * isVisible() is false. So lastShowRef stayed null, the settle-recompute
 * returned early, and overlap was stuck at 0 for the whole visit.
 *
 * The repair re-seeds a few times across one IME slide-in, gated on a positive
 * metrics() height rather than isVisible().
 */
import {renderHook, act} from '@testing-library/react-native';

// babel-plugin-jest-hoist only lets a jest.mock factory close over variables
// whose names begin with `mock`, and `var` so the hoisted factory sees them.
var mockListeners: Record<string, Array<(e: unknown) => void>> = {};
var mockKbVisible: boolean | undefined = false;
var mockKbMetrics: {height: number; screenY?: number} | undefined;

jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 34},
  useWindowDimensions: () => ({height: 800, width: 400}),
  Keyboard: {
    addListener: (evt: string, cb: (e: unknown) => void) => {
      (mockListeners[evt] ??= []).push(cb);
      return {remove: () => {
        mockListeners[evt] = (mockListeners[evt] ?? []).filter(f => f !== cb);
      }};
    },
    isVisible: () => mockKbVisible,
    metrics: () => mockKbMetrics,
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 24, bottom: 48, left: 0, right: 0}),
}));

import {useKeyboardLayout} from '../useKeyboardLayout';

const reset = (): void => {
  for (const k of Object.keys(mockListeners)) {delete mockListeners[k];}
  mockKbVisible = false;
  mockKbMetrics = undefined;
};

describe('B-277 — a missed keyboardDidShow must still lift the composer', () => {
  beforeEach(() => { jest.useFakeTimers(); reset(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('THE BUG: didShow fired before mount → overlap recovers via re-seed', () => {
    // The IME is already up and animating; no transition event will ever be
    // delivered to this hook instance. Mid-animation Android reports
    // isVisible()===false while metrics() already has the height.
    mockKbVisible = false;
    mockKbMetrics = {height: 300};

    const {result} = renderHook(() => useKeyboardLayout());
    // Nothing yet — this is the broken state the founder saw.
    expect(result.current.overlap).toBe(0);

    // The keyboard finishes animating; a later re-seed tick observes it.
    act(() => { mockKbVisible = true; jest.advanceTimersByTime(150); });

    // 300 (reported) + 48 (nav bar added back on API>=30) = 348.
    expect(result.current.overlap).toBe(348);
    expect(result.current.visible).toBe(true);
    expect(result.current.bottomPad(8)).toBe(356);
  });

  it('seeds IMMEDIATELY when the keyboard is already fully open at mount', () => {
    mockKbVisible = true;
    mockKbMetrics = {height: 300};
    const {result} = renderHook(() => useKeyboardLayout());
    expect(result.current.overlap).toBe(348);
  });

  it('a CONFIRMED-CLOSED keyboard never adopts stale metrics', () => {
    // metrics() keeps the last session's height after the keyboard closes.
    // Adopting it would lift the composer over nothing.
    mockKbVisible = false;
    mockKbMetrics = {height: 300};
    const {result} = renderHook(() => useKeyboardLayout());
    act(() => { jest.advanceTimersByTime(1000); });
    expect(result.current.overlap).toBe(0);
    expect(result.current.bottomPad(8)).toBe(56); // 48 inset + 8 gap
  });

  it('the re-seed STOPS once a real show event has landed', () => {
    const {result} = renderHook(() => useKeyboardLayout());
    act(() => {
      for (const cb of mockListeners.keyboardDidShow ?? []) {
        cb({endCoordinates: {height: 250}});
      }
    });
    expect(result.current.overlap).toBe(298);
    // A later, larger stale metrics must not overwrite the live value.
    act(() => { mockKbVisible = true; mockKbMetrics = {height: 500}; jest.advanceTimersByTime(1000); });
    expect(result.current.overlap).toBe(298);
  });

  it('hide still returns to rest padding', () => {
    mockKbVisible = true;
    mockKbMetrics = {height: 300};
    const {result} = renderHook(() => useKeyboardLayout());
    expect(result.current.overlap).toBe(348);
    act(() => {
      mockKbVisible = false;
      for (const cb of mockListeners.keyboardDidHide ?? []) {cb({});}
    });
    expect(result.current.overlap).toBe(0);
    expect(result.current.bottomPad(8)).toBe(56);
  });

  it('unmount clears the pending re-seed timers', () => {
    mockKbVisible = false;
    mockKbMetrics = {height: 300};
    const {unmount} = renderHook(() => useKeyboardLayout());
    unmount();
    // A timer firing into an unmounted hook would setState after teardown.
    expect(() => { act(() => { jest.advanceTimersByTime(1000); }); }).not.toThrow();
  });
});
