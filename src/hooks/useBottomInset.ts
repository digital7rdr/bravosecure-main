/**
 * ONE rule for the space at the BOTTOM of a screen — the tab-bar counterpart
 * of `useKeyboardLayout` (B-184), and it exists for the same reason: the same
 * arithmetic was hand-rolled per screen and half the copies were wrong.
 *
 * > **A BOTTOM-ANCHORED ELEMENT PADS BY `bottomPad(gap)`. NOTHING ELSE.**
 *
 * The thing every hand-rolled copy got wrong
 * ------------------------------------------
 * `@react-navigation/bottom-tabs` lays the scene container and the tab bar out
 * as SIBLINGS in a column. The scene does not extend under the bar — its
 * bottom edge IS the top of the bar. And `ObsidianTabBar` already pads itself
 * by `insets.bottom`.
 *
 * So a footer inside a tabbed screen that adds `Math.max(insets.bottom, 12)`
 * is reserving the system nav bar TWICE. On a 3-button-nav Android phone
 * `insets.bottom` is ~48dp, which is the exact size of the dead black gap the
 * founder screenshotted under "CONFIRM LOCATION" and "WAITING FOR BRAVO
 * CONTROL SYSTEM". The same double-count pushed the booking-home FAB ~120dp
 * up, straight over the "RECENT BOOKINGS" list.
 *
 * `bottomPad` therefore **REPLACES** the safe-area inset whenever a tab bar is
 * present — it never stacks on it. Exactly the rule `useKeyboardLayout` uses
 * for the IME, for the same reason: something below you already owns that
 * space.
 *
 * | Situation                                   | Use                        |
 * | ------------------------------------------- | -------------------------- |
 * | Footer / CTA pinned to the bottom of a screen | `bottomPad(gap)`         |
 * | ScrollView content that must clear the bottom | `contentBottom(gap)`     |
 * | Absolutely-positioned FAB                     | `bottom: bottomPad(gap)` |
 *
 * A screen with a focused TextInput still follows `useKeyboardLayout` — the
 * IME covers the tab bar too, so while it is up the keyboard rule wins.
 */
import {useEffect, useSyncExternalStore} from 'react';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/**
 * Whether a bottom tab bar is currently mounted and visible.
 *
 * A module-level count rather than React context because the bar is a SIBLING
 * of the scene container — it cannot wrap the screens that need to read it.
 * The app shows one shell at a time (root / CPO / departmental all render
 * `ObsidianTabBar`), so a count is enough; it is a count and not a boolean so
 * that a shell swap, which mounts the new bar before unmounting the old, never
 * dips through zero and flashes every footer.
 */
let visibleBars = 0;
let listeners: Array<() => void> = [];

function emit(): void {
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => { listeners = listeners.filter(x => x !== l); };
}

function snapshot(): boolean {
  return visibleBars > 0;
}

/** Called by ObsidianTabBar only. */
export function useReportBottomTabBar(visible: boolean): void {
  useEffect(() => {
    if (!visible) {return;}
    visibleBars += 1;
    emit();
    return () => { visibleBars = Math.max(0, visibleBars - 1); emit(); };
  }, [visible]);
}

/** Test seam — reset the module-level count between cases. */
export function __resetBottomTabBarForTest(): void {
  visibleBars = 0;
  listeners = [];
}

export interface BottomInset {
  /** True when a tab bar sits below this screen and already owns the inset. */
  hasTabBar: boolean;
  /** The raw safe-area inset. Prefer bottomPad — this is for edge cases. */
  safeBottom: number;
  /**
   * Padding for the BOTTOM-MOST element of a surface. Includes the safe-area
   * inset only when nothing below the screen already reserves it.
   */
  bottomPad: (gap?: number) => number;
  /**
   * Bottom padding for scrollable content so the last row clears the bottom
   * of the screen. Same rule, plus room to scroll past a floating element.
   */
  contentBottom: (gap?: number) => number;
}

/** Minimum comfortable margin when there is no system inset to speak of. */
export const BOTTOM_INSET_FLOOR_DP = 12;

/**
 * The rule, as a pure function — so both the tabbed and standalone cases can
 * be asserted in one run instead of whichever one the harness happens to
 * render (the same reason `computeKeyboardOverlap` is pure).
 *
 * Below a tab bar the screen's own edge is already clear of the system bar, so
 * the gap is pure design spacing. Standalone, the element owns the inset —
 * floored so a gesture-nav phone reporting a tiny inset still gets a
 * comfortable touch margin above the home indicator.
 */
export function computeBottomBase(env: {hasTabBar: boolean; safeBottom: number}): number {
  if (env.hasTabBar) {return 0;}
  return Math.max(env.safeBottom, BOTTOM_INSET_FLOOR_DP);
}

export function useBottomInset(): BottomInset {
  const insets = useSafeAreaInsets();
  const hasTabBar = useSyncExternalStore(subscribe, snapshot, snapshot);
  const base = computeBottomBase({hasTabBar, safeBottom: insets.bottom});
  return {
    hasTabBar,
    safeBottom: insets.bottom,
    bottomPad:     (gap = 12) => base + gap,
    contentBottom: (gap = 24) => base + gap,
  };
}
