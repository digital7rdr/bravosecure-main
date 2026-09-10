/**
 * Regression pins for the app-wide bottom-inset rule (B-245).
 *
 * The field defect: `@react-navigation/bottom-tabs` lays the scene container
 * and the tab bar out as SIBLINGS, so a screen's bottom edge IS the top of the
 * bar — and ObsidianTabBar already pads itself by `insets.bottom`. Screens that
 * added `Math.max(insets.bottom, 12)` to their own footer reserved the system
 * nav bar TWICE. On a 3-button-nav Android phone that is ~48dp, the exact size
 * of the dead black gap the founder screenshotted under "CONFIRM LOCATION" and
 * "WAITING FOR BRAVO CONTROL SYSTEM". The same double-count pushed the
 * booking-home FAB ~120dp up, over the "RECENT BOOKINGS" list.
 *
 * `computeBottomBase` is pure so BOTH cases can be asserted in one run, rather
 * than whichever one the harness happens to mount.
 */
import {act, renderHook} from '@testing-library/react-native';
import {
  computeBottomBase,
  useBottomInset,
  useReportBottomTabBar,
  __resetBottomTabBarForTest,
  BOTTOM_INSET_FLOOR_DP,
} from '../useBottomInset';

// 3-button-nav Android: the case that produced every screenshot.
const THREE_BUTTON = 48;
// Gesture-nav / home indicator.
const GESTURE = 24;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 24, bottom: mockSafeBottom, left: 0, right: 0}),
}));
let mockSafeBottom = THREE_BUTTON;

beforeEach(() => {
  __resetBottomTabBarForTest();
  mockSafeBottom = THREE_BUTTON;
});

describe('computeBottomBase — the rule', () => {
  it('a tab bar REPLACES the safe-area inset, it never stacks on it', () => {
    // The whole bug in one assertion. 0, not 48.
    expect(computeBottomBase({hasTabBar: true, safeBottom: THREE_BUTTON})).toBe(0);
    expect(computeBottomBase({hasTabBar: true, safeBottom: GESTURE})).toBe(0);
  });

  it('standalone, the element owns the inset', () => {
    expect(computeBottomBase({hasTabBar: false, safeBottom: THREE_BUTTON})).toBe(THREE_BUTTON);
    expect(computeBottomBase({hasTabBar: false, safeBottom: GESTURE})).toBe(GESTURE);
  });

  it('standalone with no reported inset still gets a touch margin', () => {
    expect(computeBottomBase({hasTabBar: false, safeBottom: 0})).toBe(BOTTOM_INSET_FLOOR_DP);
    expect(computeBottomBase({hasTabBar: false, safeBottom: 4})).toBe(BOTTOM_INSET_FLOOR_DP);
  });

  it('the floor never INFLATES a real inset', () => {
    // Math.max, not addition — the classic way this arithmetic goes wrong.
    expect(computeBottomBase({hasTabBar: false, safeBottom: 34})).toBe(34);
  });
});

describe('useBottomInset', () => {
  it('with no tab bar mounted, padding includes the inset', () => {
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.hasTabBar).toBe(false);
    expect(result.current.bottomPad(12)).toBe(THREE_BUTTON + 12);
    expect(result.current.contentBottom(20)).toBe(THREE_BUTTON + 20);
  });

  it('a mounted tab bar drops the inset from every consumer', () => {
    const bar = renderHook(() => useReportBottomTabBar(true));
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.hasTabBar).toBe(true);
    expect(result.current.bottomPad(12)).toBe(12);
    expect(result.current.contentBottom(20)).toBe(20);
    bar.unmount();
  });

  it('an ALREADY-mounted consumer re-renders when the bar appears', () => {
    // The tab bar is a sibling of the scene, so it can mount after the screen.
    // Without a subscription the screen would keep the standalone padding and
    // the dead gap would survive the fix.
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.bottomPad(12)).toBe(THREE_BUTTON + 12);
    const bar = renderHook(() => useReportBottomTabBar(true));
    expect(result.current.bottomPad(12)).toBe(12);
    act(() => { bar.unmount(); });
    expect(result.current.bottomPad(12)).toBe(THREE_BUTTON + 12);
  });

  it('a HIDDEN bar does not count — the screen owns the safe area again', () => {
    // Routes set tabBarStyle:{display:'none'} (fullscreen map, messenger).
    // Treating a hidden bar as present would clip content behind the nav bar,
    // which is the opposite failure and just as bad.
    const bar = renderHook(() => useReportBottomTabBar(false));
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.hasTabBar).toBe(false);
    expect(result.current.bottomPad(12)).toBe(THREE_BUTTON + 12);
    bar.unmount();
  });

  it('a shell swap never dips through zero', () => {
    // Root -> CPO -> departmental all render ObsidianTabBar; React mounts the
    // new one BEFORE unmounting the old. A boolean would flash false here and
    // every footer in the app would jump by the inset mid-transition.
    const first = renderHook(() => useReportBottomTabBar(true));
    const {result} = renderHook(() => useBottomInset());
    const second = renderHook(() => useReportBottomTabBar(true));
    act(() => { first.unmount(); });
    expect(result.current.hasTabBar).toBe(true);
    expect(result.current.bottomPad(12)).toBe(12);
    second.unmount();
  });

  it('gap defaults are sane and additive', () => {
    const bar = renderHook(() => useReportBottomTabBar(true));
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.bottomPad()).toBe(12);
    expect(result.current.contentBottom()).toBe(24);
    expect(result.current.bottomPad(0)).toBe(0);
    bar.unmount();
  });

  it('safeBottom still reports the RAW inset for the rare edge case', () => {
    const bar = renderHook(() => useReportBottomTabBar(true));
    const {result} = renderHook(() => useBottomInset());
    expect(result.current.safeBottom).toBe(THREE_BUTTON);
    bar.unmount();
  });
});
