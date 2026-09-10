/**
 * B-184 — THE app-wide keyboard-inset rule. One function, one hook, zero
 * per-screen arithmetic.
 *
 * Why this exists (both halves are proven from the RN sources, not guessed):
 *
 *  1. `endCoordinates.height` does NOT mean the same thing on the two
 *     platforms, so the same number produced two opposite defects.
 *
 *     Android, `ReactRootView.checkForKeyboardEvents()` (API >= 30):
 *         height = imeInsets.bottom - systemBars().bottom
 *     i.e. RN SUBTRACTS the navigation-bar band that the IME also covers.
 *     Under edge-to-edge (`edgeToEdgeEnabled=true`, mandatory on RN 0.81 /
 *     target SDK 36) our views run to the physical screen bottom, so padding
 *     by that number under-lifts by exactly `insets.bottom` — 24 dp on gesture
 *     nav, 48 dp on 3-button. That is the "composer cut in half" repro.
 *     The API < 30 legacy path measures against the raw display metrics and
 *     already includes the bar, hence the version gate below.
 *
 *     iOS, `RCTKeyboardObserver`: `endCoordinates` is the UIKeyboard end frame
 *     converted to WINDOW coordinates. A docked keyboard is flush to the
 *     window bottom, so `height` ALREADY spans the home indicator. Adding
 *     `insets.bottom` on top of it is dead space under the keyboard.
 *
 *  2. `KeyboardAvoidingView` is banned repo-wide (see keyboardContract.test).
 *     Its `_relativeKeyboardHeight` is
 *         max(frame.y + frame.height - (screenY - keyboardVerticalOffset), 0)
 *     so a non-zero `keyboardVerticalOffset` inflates the padding one-for-one
 *     — ChatScreen passed `insets.top + 10` and bought ~69 pt of blind space
 *     on a notched iPhone — and `frame.y` comes from `onLayout`, which is
 *     PARENT-relative, so the math is silently wrong the moment the KAV is not
 *     a direct child of a full-screen view. On Android it is inert with
 *     `behavior=undefined` and leaves ghost padding with `behavior="height"`.
 *
 * The rule, in one line:
 *
 *     THE BOTTOM-MOST ELEMENT OF A SURFACE OWNS THE KEYBOARD INSET.
 *     It pads by `bottomPad(gap)`; nothing else in the tree reacts to the IME.
 *
 * Pick one of three values and never hand-roll a fourth:
 *
 *   | Situation                                            | Use                    |
 *   | ---------------------------------------------------- | ---------------------- |
 *   | Bottom-anchored composer / sticky footer / sheet     | `bottomPad(gap)`       |
 *   | Container that lifts a whole column (form, backdrop) | `overlap`              |
 *   | A child inside an already-lifted container           | `safeBottom + gap`     |
 *
 * `bottomPad` REPLACES the safe-area inset while the keyboard is up, it never
 * stacks on it — the IME is already covering the nav bar / home indicator.
 *
 * Register: docs/audits/KEYBOARD_INSET_AUDIT_2026-07-24.md
 * Device matrix + repro steps: docs/qa/KEYBOARD_UI_TEST_PLAN.md
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Keyboard, Platform, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardHandler} from 'react-native-keyboard-controller';
import {runOnJS} from 'react-native-reanimated';
import type {RefObject} from 'react';
import type {ScrollView} from 'react-native';

/**
 * Why: some OEM IMEs re-fire the show event with 1-2 px height bumps per
 * animation frame (ChatScreen Fix #29). Below this delta we keep the previous
 * value so consumers don't re-render every frame of the IME slide-in.
 */
export const KEYBOARD_NOISE_FLOOR_DP = 4;

/** The Android API level at which RN switched to the inset-based keyboard path. */
export const ANDROID_INSET_KEYBOARD_API = 30;

/**
 * B-277 — the smallest share of the WINDOW a real IME can occupy.
 *
 * MEASURED on a Redmi Note 11, API 33, edge-to-edge. The process id in the log
 * is the giveaway — it is not a race and not the animation:
 *
 *     pid 1882  keyboardDidShow h=326.18  ✅
 *     pid 5774  keyboardDidShow h=5.09    ❌  <- first open in a FRESH process
 *     pid 5774  keyboardDidShow h=326.18  ✅
 *     pid 5774  keyboardDidShow h=326.18  ✅
 *
 * The FIRST keyboard open after a cold start reports garbage; every later open in
 * that process reports the truth. Under edge-to-edge RN reports
 * `imeInsets.bottom - systemBars().bottom`, and on that first open the inset has
 * barely cleared the nav bar (52 - 47 = 5). Android emits `keyboardDidShow` once
 * per transition and `Keyboard.metrics()` is event-derived, so the bad value is
 * final for that session — no amount of polling or retrying can fix it (both were
 * tried and shipped; both failed).
 *
 * A ratio, NOT an absolute dp figure, because the app runs on small phones,
 * tablets and foldables: 326/792 is 41% of the screen, while the bogus 5/792 is
 * 0.6%. No IME on any form factor is under ~15% of its window.
 */
export const KEYBOARD_MIN_WINDOW_FRACTION = 0.15;

/** Is `height` big enough to be a real keyboard on a window this tall? */
export function isPlausibleKeyboardHeight(height: number, windowHeight: number): boolean {
  if (!(height > 0)) {
    return false;
  }
  // No window measurement to judge against — accept any positive height rather
  // than reject a reading we cannot evaluate.
  if (!(windowHeight > 0)) {
    return true;
  }
  return height / windowHeight >= KEYBOARD_MIN_WINDOW_FRACTION;
}

/**
 * The height to actually use, given what was reported and what we have LEARNED
 * about this device.
 *
 * The learned value is not a constant I chose — each device teaches the app its
 * own keyboard height the first time it reports a believable one, and that is
 * what gets substituted when a later reading is impossible. Pure so the whole
 * decision table can be tested without a device.
 */
export function resolveKeyboardHeight(
  reported: number,
  windowHeight: number,
  learned: number,
): number {
  if (isPlausibleKeyboardHeight(reported, windowHeight)) {
    return reported;
  }
  // Implausible. Prefer what this device has already shown us; if it has taught
  // us nothing yet (very first keyboard open on a fresh install) keep the
  // reported value — a small lift beats pretending the keyboard is absent.
  return isPlausibleKeyboardHeight(learned, windowHeight) ? learned : reported;
}

/**
 * Largest believable IME height this device has reported, remembered across
 * cold starts. LARGEST rather than latest on purpose: swapping to an emoji or
 * numeric pad changes the height, and under-lifting hides the composer while
 * over-lifting only leaves a gap. Persisted best-effort — a miss costs one
 * badly-lifted first open, never correctness.
 */
const LEARNED_KB_KEY = 'ui:keyboardHeightDp';
let learnedKeyboardHeight = 0;
let learnedLoaded = false;

export function _setLearnedKeyboardHeightForTest(v: number): void {
  learnedKeyboardHeight = v;
  learnedLoaded = true;
}

function loadLearnedKeyboardHeight(): void {
  if (learnedLoaded) {
    return;
  }
  learnedLoaded = true;
  try {
    const AsyncStorage = (
      require('@react-native-async-storage/async-storage') as {default: {getItem: (k: string) => Promise<string | null>}}
    ).default;
    void AsyncStorage.getItem(LEARNED_KB_KEY).then(raw => {
      const v = Number(raw);
      if (Number.isFinite(v) && v > learnedKeyboardHeight) {
        learnedKeyboardHeight = v;
      }
    }).catch(() => undefined);
  } catch { /* storage unavailable — in-memory learning still works */ }
}

function rememberKeyboardHeight(height: number): void {
  if (!(height > learnedKeyboardHeight)) {
    return;
  }
  learnedKeyboardHeight = height;
  try {
    const AsyncStorage = (
      require('@react-native-async-storage/async-storage') as {default: {setItem: (k: string, v: string) => Promise<void>}}
    ).default;
    void AsyncStorage.setItem(LEARNED_KB_KEY, String(height)).catch(() => undefined);
  } catch { /* best-effort */ }
}

export interface KeyboardEventMetrics {
  /** `endCoordinates.height`, dp. */
  height: number;
  /** `endCoordinates.screenY`, dp. Meaningful on iOS only. */
  screenY?: number;
}

export interface KeyboardOverlapEnv {
  os: string;
  /** `Platform.Version`. Only read on Android, where it is the API level. */
  apiLevel: number;
  /** Safe-area bottom inset (nav bar / home indicator), dp. */
  safeBottom: number;
  /** Window height, dp. */
  windowHeight: number;
}

/**
 * The rule's arithmetic core: how many dp of the SCREEN BOTTOM the IME covers.
 * Pure and platform-explicit so it can be exhaustively tested without mocking
 * `Platform` — see `src/hooks/__tests__/useKeyboardLayout.test.tsx`.
 */
export function computeKeyboardOverlap(
  evt: KeyboardEventMetrics | null | undefined,
  env: KeyboardOverlapEnv,
): number {
  const height = evt?.height ?? 0;
  if (!(height > 0)) {
    return 0;
  }

  if (env.os === 'android') {
    // RN subtracted systemBars().bottom on the API>=30 path — add it back so
    // the value is measured from the physical screen bottom like iOS.
    const barBand =
      env.apiLevel >= ANDROID_INSET_KEYBOARD_API ? Math.max(0, env.safeBottom) : 0;
    return height + barBand;
  }

  // iOS. Docked: screenY = windowHeight - height, so `covered` === height.
  // Undocked/floating iPad keyboard: screenY sits at/past the window bottom and
  // nothing is covered. screenY === 0 is the Reduce-Motion cross-fade quirk
  // (RN reports 0 instead of the frame origin) — fall back to `height`.
  const covered =
    env.windowHeight > 0 && evt?.screenY
      ? Math.max(0, env.windowHeight - evt.screenY)
      : height;
  return Math.min(height, covered);
}

/**
 * K4 — the overlap for `react-native-keyboard-controller`'s reported height.
 *
 * With translucent bars (set on the KeyboardProvider) the controller reports
 * the FULL covered band off WindowInsetsAnimation — already measured from the
 * screen bottom, exactly the number `overlap` means, and INDEPENDENT of the
 * JS safe-area inset. So the overlap IS that height (clamped to the window) —
 * we deliberately do NOT route it through `computeKeyboardOverlap`'s Android
 * `barBand` add-back: doing so would re-inject the JS `safeBottom` sampled at
 * event time and, if that sample was pre-settle (0), leave a permanent gap
 * once the inset resolved (the B-252 trap, inverted).
 *
 * Pure and env-light so the in-session letter→emoji resize is testable without
 * a device: a taller height yields a larger overlap; a 0 is a real close; an
 * implausible cold-start reading (B-277) is ignored — we retain `prev` rather
 * than drop the composer behind the keyboard.
 */
export function keyboardControllerOverlap(
  fullHeight: number,
  windowHeight: number,
  prev: number,
): number {
  if (!(fullHeight > 0)) {
    return 0;
  }
  if (!isPlausibleKeyboardHeight(fullHeight, windowHeight)) {
    return prev;
  }
  return windowHeight > 0 ? Math.min(fullHeight, windowHeight) : fullHeight;
}

/** dp of the screen bottom currently covered by the IME. 0 when closed. */
export function useKeyboardOverlap(): number {
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();
  const [overlap, setOverlap] = useState(0);

  const env = useMemo<KeyboardOverlapEnv>(
    () => ({
      os: Platform.OS,
      apiLevel: Number(Platform.Version) || 0,
      safeBottom: insets.bottom,
      windowHeight,
    }),
    [insets.bottom, windowHeight],
  );

  // Why: a latest-ref instead of effect deps — re-subscribing on every
  // rotation / inset change would drop the listener mid-IME-animation.
  const envRef = useRef<KeyboardOverlapEnv>(env);
  envRef.current = env;

  /**
   * B-252 — the LAST show event's raw metrics, retained after it is consumed.
   *
   * The overlap is a function of (event, env), but only the event half was
   * ever an input: env was sampled once, at the instant the event fired, and
   * the result frozen. On Android that is a one-shot reading, because
   * `keyboardDidShow` fires only on a visibility TRANSITION — there is no
   * second event to correct a value computed against a half-initialised
   * environment.
   *
   * That is the "first time only" bug. `computeKeyboardOverlap` adds
   * `safeBottom` back on Android API>=30, so if the show event lands before
   * the safe-area provider has reported the real inset — which is exactly
   * what happens on a screen's FIRST paint, while it is still mounting and
   * the JS thread is busy — the band added back is 0 and the surface
   * under-lifts by the whole nav-bar height. The composer sits behind the
   * keyboard. Leave and come back: the provider is warm, the inset is right
   * on the first render, and it works. Hence "go back and try again".
   *
   * Keeping the event lets the overlap be RECOMPUTED when the environment
   * settles, instead of being stuck with whatever was known at event time.
   */
  const lastShowRef = useRef<KeyboardEventMetrics | null>(null);

  /**
   * K4 — the last FULL keyboard height the WindowInsets controller reported,
   * or null when it says the keyboard is closed. Kept RAW (env-independent),
   * NOT baked into `lastShowRef`'s bar-subtracted form: the controller's height
   * already means "dp covered", so it must be re-clamped, never re-barBand'd,
   * on a later env settle. Authoritative over `lastShowRef` while set (Android).
   */
  const kcFullRef = useRef<number | null>(null);
  const overlapRef = useRef(0);

  const applyOverlap = useCallback((next: number) => {
    overlapRef.current = next;
    setOverlap(prev => (Math.abs(prev - next) > KEYBOARD_NOISE_FLOOR_DP ? next : prev));
  }, []);

  useEffect(() => {
    // iOS fires Will* ahead of the animation and again on every frame change
    // (autocorrect bar, keyboard-type swap). Android only emits Did* and only
    // on a visibility TRANSITION — see the stale-height note in the test plan.
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    // B-277 — pull this device's learned keyboard height in before the first
    // show event, so a cold start's bogus reading already has a substitute.
    loadLearnedKeyboardHeight();
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    // B-252 — SEED from the CURRENT keyboard state. A transition event that
    // fired before this listener attached is gone for good, so a hook mounting
    // under an already-open IME would otherwise read 0 for the whole visit:
    // a remounted composer, or a screen pushed while the keyboard is up.
    // B-277 — seeding ONCE is not enough, and this is the "tap it fast and the
    // composer stays behind the keyboard" bug.
    //
    // Android emits keyboardDidShow only on a visibility TRANSITION. Three
    // instants race on a fast tap: the IME starts animating, didShow fires, and
    // this effect attaches its listener. `useEffect` is a PASSIVE effect —
    // flushed after paint — so on a busy JS thread (this app renders a 22ms
    // median frame) the listener can attach AFTER didShow has already fired.
    // The event is then gone for good; a single seed taken at that moment reads
    // isVisible()===false because the keyboard was still mid-animation when the
    // effect ran. lastShowRef stays null, so the settle-recompute below returns
    // early too, and overlap is stuck at 0 for the WHOLE visit — the composer
    // sits behind the keyboard. Dismiss and reopen makes a fresh transition,
    // which is exactly the "go back and try again and it works" report.
    //
    // So re-seed a few times instead of once. Bounded and self-cancelling: it
    // stops the moment a real height lands (from here or from the listener),
    // costs nothing when the keyboard is closed, and never fights a live event
    // because both paths write through the same noise-floored applyOverlap.
    const reseedTimers: Array<ReturnType<typeof setTimeout>> = [];
    const reseed = (): boolean => {
      try {
        const kb = Keyboard as unknown as {
          isVisible?: () => boolean;
          metrics?: () => KeyboardEventMetrics | undefined;
        };
        // Don't gate on isVisible() alone — it is false mid-animation, which is
        // precisely the window this repair exists for. A positive height from
        // metrics() is the authoritative signal.
        const metrics = kb.metrics?.();
        const visible = kb.isVisible?.();
        // `visible !== false` admits both true and undefined (older RN without
        // the static), and excludes only a confirmed-closed keyboard — whose
        // stale metrics from a previous session must NOT be adopted.
        if (metrics && metrics.height > 0 && visible !== false) {
          lastShowRef.current = metrics;
          applyOverlap(computeKeyboardOverlap(metrics, envRef.current));
          return true;
        }
      } catch {
        // Older RN / a test double without these statics. The listeners below
        // remain the primary path; seeding is a repair, never a requirement.
      }
      return false;
    };
    if (!reseed()) {
      // Spans one IME slide-in (~250-300ms on Android) without polling past it.
      for (const delay of [16, 120, 300]) {
        reseedTimers.push(setTimeout(() => {
          if (lastShowRef.current) {return;}
          reseed();
        }, delay));
      }
    }

    const show = Keyboard.addListener(showEvt, e => {
      const coords = e?.endCoordinates ?? null;
      const reported = coords?.height ?? 0;
      const win = envRef.current.windowHeight;
      // B-277 — the first keyboard open in a fresh process reports an impossible
      // height (measured: 5dp for a 326dp keyboard) and nothing ever corrects it.
      // Substitute what this device has taught us; learn from every believable
      // reading so it is right from then on, including after a cold start.
      if (isPlausibleKeyboardHeight(reported, win)) {
        rememberKeyboardHeight(reported);
      }
      const height = resolveKeyboardHeight(reported, win, learnedKeyboardHeight);
      const used: KeyboardEventMetrics | null =
        coords ? {...coords, height} : null;
      lastShowRef.current = used;
      applyOverlap(computeKeyboardOverlap(used, envRef.current));
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      lastShowRef.current = null;
      kcFullRef.current = null;
      overlapRef.current = 0;
      setOverlap(prev => (prev === 0 ? prev : 0));
    });
    return () => {
      for (const t of reseedTimers) {clearTimeout(t);}
      show.remove();
      hide.remove();
    };
  }, [applyOverlap]);

  // B-252 — recompute against the settled environment. Runs whenever the
  // inset or window changes while the keyboard is up: the first-paint inset
  // resolving, a rotation, a fold, a nav-mode switch. A no-op when the
  // keyboard is closed, and the noise floor absorbs sub-4dp churn.
  useEffect(() => {
    // K4 — the controller value is authoritative while set, and env-independent:
    // it only re-clamps to the (possibly new) window, never re-adds a barBand.
    // This is what keeps a pre-settle controller reading from becoming a
    // permanent over-lift once `safeBottom` resolves.
    if (kcFullRef.current !== null) {
      applyOverlap(keyboardControllerOverlap(kcFullRef.current, env.windowHeight, overlapRef.current));
      return;
    }
    if (!lastShowRef.current) {
      return;
    }
    applyOverlap(computeKeyboardOverlap(lastShowRef.current, env));
  }, [env, applyOverlap]);

  /**
   * K4 (sqa.md) — the in-session resize the RN listeners cannot see. Android
   * emits `keyboardDidShow` ONLY on a visibility transition, so switching the
   * system keyboard from its letter pad to its emoji pad (taller, same
   * session, no hide/show) fired no event: `overlap` stayed frozen at the
   * shorter height and the emoji keyboard drew over the composer.
   *
   * `react-native-keyboard-controller` reads the IME height off
   * WindowInsetsAnimation, so its `onEnd` fires on EVERY settle — the first
   * open, a hide, AND an in-place resize. With translucent bars (set on the
   * KeyboardProvider) its height is the FULL covered band = the overlap
   * directly (env-independent), so a normal open agrees with the RN path to the
   * dp (the noise floor absorbs the echo) and an emoji resize — where RN is
   * silent — is the only source that fires, so the composer follows the taller
   * keyboard.
   *
   * ANDROID-ONLY: iOS already re-fires `keyboardWillShow` on a keyboard-type
   * swap (see the show-listener note), and its `endCoordinates` carry the
   * `screenY` the undocked-iPad branch needs — which the controller event does
   * not — so letting this drive iOS would over-lift a floating keyboard. The
   * bug (no event on in-place resize) is Android's alone.
   */
  const onKeyboardControllerHeight = useCallback((fullHeight: number) => {
    const cur = envRef.current;
    if (cur.os !== 'android') {
      return;
    }
    const win = cur.windowHeight;
    if (fullHeight <= 0) {
      kcFullRef.current = null; // a real close — fall back to the RN listener (also 0)
    } else if (isPlausibleKeyboardHeight(fullHeight, win)) {
      kcFullRef.current = fullHeight; // only a believable height becomes authoritative
    }
    // An implausible positive (B-277 cold-start garbage) leaves kcFullRef
    // untouched, and keyboardControllerOverlap returns `prev` — never a drop.
    applyOverlap(keyboardControllerOverlap(fullHeight, win, overlapRef.current));
  }, [applyOverlap]);

  useKeyboardHandler(
    {
      onEnd: e => {
        'worklet';
        runOnJS(onKeyboardControllerHeight)(e.height);
      },
    },
    [onKeyboardControllerHeight],
  );

  return overlap;
}

export interface KeyboardLayout {
  /** dp of the screen bottom covered by the IME; 0 when closed. */
  overlap: number;
  visible: boolean;
  /** The safe-area bottom inset, or 0 once the IME has taken that band over. */
  safeBottom: number;
  /** Bottom padding for a bottom-anchored surface. Replaces, never stacks. */
  bottomPad: (gap?: number) => number;
}

export function useKeyboardLayout(): KeyboardLayout {
  const overlap = useKeyboardOverlap();
  const insets = useSafeAreaInsets();
  const restBottom = insets.bottom;
  return useMemo(() => {
    const visible = overlap > 0;
    return {
      overlap,
      visible,
      safeBottom: visible ? 0 : restBottom,
      bottomPad: (gap = 0) => (visible ? overlap : restBottom) + gap,
    };
  }, [overlap, restBottom]);
}

/**
 * One-liner for the common case: the bottom padding of the surface that sits
 * directly above the keyboard.
 */
export function useKeyboardBottomPad(gap = 0): number {
  const {bottomPad} = useKeyboardLayout();
  return bottomPad(gap);
}

/**
 * For scroll-forms whose inputs sit at/near the BOTTOM of the content:
 * returns an onFocus handler that scrolls to the end once the keyboard has
 * actually shown (replaces fixed-timer hacks that race the IME animation,
 * e.g. the 120 ms BS-BACKUP-PWVIS timeout).
 */
export function useRevealOnKeyboard(scrollRef: RefObject<ScrollView | null>): () => void {
  const overlap = useKeyboardOverlap();
  const overlapRef = useRef(overlap);
  overlapRef.current = overlap;
  const pending = useRef(false);

  const scrollNow = useCallback(() => {
    // Why: wait a frame so kb padding applied on the same keyboard event has
    // committed before the scroll target is measured.
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
  }, [scrollRef]);

  useEffect(() => {
    if (overlap > 0 && pending.current) {
      pending.current = false;
      scrollNow();
    }
  }, [overlap, scrollNow]);

  return useCallback(() => {
    if (overlapRef.current > 0) {
      scrollNow();
    } else {
      pending.current = true;
    }
  }, [scrollNow]);
}
