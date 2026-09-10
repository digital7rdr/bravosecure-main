/**
 * Responsive scaling primitives.
 *
 * The app is PORTRAIT-LOCKED (app.json "orientation":"portrait") and iOS
 * runs in scaled-iPhone mode on tablets (ios.supportsTablet:false). So the
 * device's logical width/height is fixed for the process lifetime, which
 * makes a STATIC `Dimensions.get('window')` read at module load correct —
 * and, crucially, callable inside `StyleSheet.create()` where almost all of
 * the app's size literals live. (A hook cannot be called there.)
 *
 * ASSUMPTION / known limit: static styles built from these values do NOT
 * reflow if the window resizes mid-session (Android split-screen / foldable
 * unfold). That's the one real-world gap and is accepted for current scope.
 * For a screen that genuinely needs reactive layout, use `useResponsive()`.
 *
 * Reference device = the ~375×812 logical phone everything was designed for
 * (iPhone 11/12/13-class). At that size every function is the identity.
 */
import type {
  StyleSheet} from 'react-native';
import {
  Dimensions,
  PixelRatio,
  useWindowDimensions,
} from 'react-native';

const {width: SCREEN_W, height: SCREEN_H} = Dimensions.get('window');

const BASE_WIDTH = 375;
const BASE_HEIGHT = 812;

export const screenWidth = SCREEN_W;
export const screenHeight = SCREEN_H;

// Breakpoints — logical px on the portrait short edge (width).
export const isSmallPhone = SCREEN_W < 350; // iPhone SE 1st gen (320), small Androids
export const isLargePhone = SCREEN_W >= 414; // Plus / Max-class phones
export const isTablet = SCREEN_W >= 600; // Android tablets / large foldables (iOS never hits this)

/** Linear horizontal scale — widths, horizontal padding, icon sizes. */
export function scale(size: number): number {
  return Math.round((SCREEN_W / BASE_WIDTH) * size);
}

/** Linear vertical scale — heights, vertical padding/margins. */
export function verticalScale(size: number): number {
  return Math.round((SCREEN_H / BASE_HEIGHT) * size);
}

/**
 * Damped scale — the safe default for most sizing. `factor` 0 = no scaling
 * (returns size unchanged), 1 = full linear scale. Default 0.5 splits the
 * difference so large screens grow but not as aggressively as a raw ratio.
 */
export function moderateScale(size: number, factor = 0.5): number {
  return Math.round(size + (scale(size) - size) * factor);
}

// Fonts scale GENTLER than layout (oversized body text reads worse than
// slightly-large padding) and are CLAMPED so text is never absurd on a
// tablet or unreadable on a tiny phone.
const FONT_FACTOR = 0.3;
const FONT_MIN_FACTOR = 0.85;
const FONT_MAX_FACTOR = 1.2;

/** Scale a font size with a gentle factor, clamped to 0.85×–1.20× of the
 *  design size and snapped to the device pixel grid (avoids blur). */
export function scaleFont(size: number): number {
  const scaled = moderateScale(size, FONT_FACTOR);
  const min = size * FONT_MIN_FACTOR;
  const max = size * FONT_MAX_FACTOR;
  const clamped = Math.min(max, Math.max(min, scaled));
  return Math.round(PixelRatio.roundToNearestPixel(clamped));
}

/** Max content width for tablet centering (used by ScreenContainer). On
 *  phones this equals the screen width, so centering becomes a no-op. */
export const maxContentWidth = isTablet ? 560 : SCREEN_W;

/**
 * Keys in a style object that represent text SIZING and should be scaled.
 *
 * ⚠️ B-657 — `letterSpacing` was here and was REMOVED. Do not put it back.
 *
 * `scaleFont` ends in `Math.round(...)`, which is right for a font size (a
 * fractional dp buys nothing and blurs) and WRONG for tracking, where the
 * normal design range is sub-1dp. Rounding it broke the type two ways at once:
 *
 *   designed   360dp   393dp
 *     0.4   ->    0       0     ← tracking silently DELETED
 *     1.5   ->    1       2     ← +33% on a 393dp phone, and DEVICE-DEPENDENT
 *     2.4   ->    2       3
 *
 * So every letter-spaced label rendered wider than designed on a ≥393dp phone,
 * by an amount that differed per device. On the founder's Redmi the Secure home
 * title ("SECURE SERVICES", `letterSpacing: 1.5`) rendered at 2 — 7.5dp of
 * unrequested width on a row that was already ~39dp overfull, which is what
 * ellipsised it to "SECURE SE…".
 *
 * Tracking is a typographic CONSTANT, not a responsive size: it is chosen
 * against the font, not the viewport. It now passes through untouched.
 *
 * This narrows letter-spaced text app-wide (177 files use `scaleTextStyles`).
 * The direction is safe — text can only get closer to its designed width, so a
 * layout can lose an overflow but never gain one.
 */
const TEXT_KEYS = ['fontSize', 'lineHeight'] as const;

/**
 * Shallow-map a StyleSheet input, scaling text-sizing keys
 * (fontSize / lineHeight — NOT letterSpacing, see TEXT_KEYS) on each style
 * object via `scaleFont`, leaving every other property (color, width,
 * padding, …) untouched. Lets a screen opt its whole StyleSheet into responsive
 * typography with a single wrap, no per-literal edits:
 *
 *   const s = StyleSheet.create(scaleTextStyles({ title: {fontSize: 28} }));
 */
export function scaleTextStyles<T extends StyleSheet.NamedStyles<T>>(
  styles: T & StyleSheet.NamedStyles<T>,
): T {
  const entries = Object.entries(styles as unknown as Record<string, Record<string, unknown>>);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, style] of entries) {
    const next: Record<string, unknown> = {...style};
    for (const key of TEXT_KEYS) {
      const v = next[key];
      if (typeof v === 'number') {
        next[key] = scaleFont(v);
      }
    }
    out[name] = next;
  }
  return out as unknown as T;
}

/**
 * Reactive convenience hook — returns the same scale functions plus the
 * LIVE window dimensions, for the rare screen that wants to re-layout on a
 * window resize (Android split-screen) rather than the static module read.
 */
export function useResponsive() {
  const {width, height} = useWindowDimensions();
  return {
    width,
    height,
    scale,
    verticalScale,
    moderateScale,
    scaleFont,
    isSmallPhone,
    isLargePhone,
    isTablet,
  };
}

/**
 * Reactive centered-content width — for surfaces that must reflow LIVE on a
 * window resize (Android split-screen, foldable unfold) rather than the
 * launch-time module read that `isTablet` / `maxContentWidth` rely on. Under
 * the app's portrait lock those static values are frozen for the process
 * lifetime (see the file header); a foldable that boots folded then unfolds
 * would keep the narrow value forever. This hook reads the LIVE window each
 * render.
 *
 * Returns the live width, whether we're on a large canvas (≥ the tablet
 * breakpoint), and a `contentMaxWidth` capped at `cap` so a wide inner
 * display shows a comfortable centered column instead of edge-to-edge
 * stretch. On a phone `contentMaxWidth` equals the screen width, so
 * `maxWidth: contentMaxWidth` is a no-op. `cap` defaults to 600 (a single
 * reading column); pass wider for a chat column.
 */
export function useContentWidth(cap = 600): {
  width: number;
  isLargeScreen: boolean;
  contentMaxWidth: number;
} {
  const {width} = useWindowDimensions();
  const isLargeScreen = width >= 600;
  return {
    width,
    isLargeScreen,
    contentMaxWidth: isLargeScreen ? Math.min(cap, width) : width,
  };
}
