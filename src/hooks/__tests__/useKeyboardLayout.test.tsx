/**
 * B-184 regression pins for the app-wide keyboard-inset rule.
 *
 * The two field defects this suite exists to stop coming back:
 *   • iOS "blind space" — a gap between the composer and the keyboard, because
 *     the safe-area inset was STACKED on a keyboard height that already spans
 *     the home indicator (and KAV's keyboardVerticalOffset added insets.top on
 *     top of that).
 *   • Android "cut down" — the composer sliced in half by the IME, because RN's
 *     endCoordinates.height on API>=30 is `ime - systemBars`, so padding by it
 *     under-lifts by exactly the nav-bar band under edge-to-edge.
 *
 * `computeKeyboardOverlap` is pure so BOTH platforms can be asserted in one
 * run — mocking Platform per file would only ever cover whichever one the
 * jest preset resolves to.
 */
import {act, renderHook} from '@testing-library/react-native';
import {Keyboard, Platform} from 'react-native';
import type {ScrollView} from 'react-native';

// Capturing override of the setup's no-op keyboard-controller mock, so the
// K4 seam (onEnd → runOnJS → applyOverlap) can be fired at runtime and pinned
// behaviourally — closing the source-scan's pin-depth gap (a deleted callback
// applyOverlap or a deleted settle branch is caught here, not just by shape).
const mockKcHolder: {onEnd?: (e: {height: number}) => void} = {};
jest.mock('react-native-keyboard-controller', () => ({
  __esModule: true,
  KeyboardProvider: ({children}: {children: unknown}) => children,
  useKeyboardHandler: (h: {onEnd?: (e: {height: number}) => void}) => { mockKcHolder.onEnd = h.onEnd; },
}));
// The global reanimated mock lacks runOnJS; the seam calls it, so give it the
// test-correct identity behaviour: runOnJS(fn)(arg) hops to JS = calls fn(arg).
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  runOnJS: (fn: (...a: unknown[]) => unknown) => fn,
}));
import {
  computeKeyboardOverlap,
  keyboardControllerOverlap,
  useKeyboardOverlap,
  useKeyboardLayout,
  useRevealOnKeyboard,
  KEYBOARD_NOISE_FLOOR_DP,
  type KeyboardOverlapEnv,
} from '../useKeyboardLayout';

// Pixel-class: 24 dp gesture-nav band, 360x800 dp window.
const ANDROID_30: KeyboardOverlapEnv = {os: 'android', apiLevel: 34, safeBottom: 24, windowHeight: 800};
// Pre-R devices take RN's legacy display-metrics path (minSdk is 24).
const ANDROID_29: KeyboardOverlapEnv = {os: 'android', apiLevel: 29, safeBottom: 24, windowHeight: 800};
// iPhone 14 Pro class: 34 pt home indicator, 852 pt window.
const IOS: KeyboardOverlapEnv = {os: 'ios', apiLevel: 0, safeBottom: 34, windowHeight: 852};

describe('computeKeyboardOverlap — the rule', () => {
  it('a closed keyboard is always 0', () => {
    expect(computeKeyboardOverlap({height: 0}, ANDROID_30)).toBe(0);
    expect(computeKeyboardOverlap(null, ANDROID_30)).toBe(0);
    expect(computeKeyboardOverlap(undefined, IOS)).toBe(0);
    expect(computeKeyboardOverlap({height: -5}, IOS)).toBe(0);
  });

  describe('Android', () => {
    it('ADDS BACK the system-bars band RN subtracts on API>=30 (the "cut down" bug)', () => {
      // ReactRootView.checkForKeyboardEvents(): height = ime - systemBars.
      // A reported 300 dp over a 24 dp nav bar is a 324 dp real overlap.
      expect(computeKeyboardOverlap({height: 300}, ANDROID_30)).toBe(324);
    });

    it('scales with the nav-bar mode — 3-button reserves 48 dp', () => {
      expect(computeKeyboardOverlap({height: 300}, {...ANDROID_30, safeBottom: 48})).toBe(348);
    });

    it('adds nothing when there is no bottom inset to restore', () => {
      expect(computeKeyboardOverlap({height: 300}, {...ANDROID_30, safeBottom: 0})).toBe(300);
    });

    it('does NOT compensate on the API<30 legacy path (it already includes the bar)', () => {
      expect(computeKeyboardOverlap({height: 300}, ANDROID_29)).toBe(300);
    });

    it('boundary: API 30 exactly takes the inset path', () => {
      expect(computeKeyboardOverlap({height: 300}, {...ANDROID_30, apiLevel: 30})).toBe(324);
      expect(computeKeyboardOverlap({height: 300}, {...ANDROID_30, apiLevel: 29})).toBe(300);
    });

    it('never subtracts on a negative/garbage inset', () => {
      expect(computeKeyboardOverlap({height: 300}, {...ANDROID_30, safeBottom: -12})).toBe(300);
    });

    it('ignores screenY — RN reports the visible-frame bottom there, not the IME top', () => {
      expect(computeKeyboardOverlap({height: 300, screenY: 500}, ANDROID_30)).toBe(324);
    });
  });

  describe('iOS', () => {
    it('does NOT add the home-indicator inset — the keyboard already covers it (the "blind space" bug)', () => {
      expect(computeKeyboardOverlap({height: 336, screenY: 852 - 336}, IOS)).toBe(336);
    });

    it('is height-only when screenY is absent', () => {
      expect(computeKeyboardOverlap({height: 336}, IOS)).toBe(336);
    });

    it('reports 0 for an undocked/floating iPad keyboard (nothing is covered)', () => {
      expect(computeKeyboardOverlap({height: 300, screenY: 852}, IOS)).toBe(0);
    });

    it('falls back to height on the Reduce-Motion cross-fade quirk (screenY === 0)', () => {
      expect(computeKeyboardOverlap({height: 336, screenY: 0}, IOS)).toBe(336);
    });

    it('never returns more than the keyboard height', () => {
      expect(computeKeyboardOverlap({height: 100, screenY: 10}, IOS)).toBe(100);
    });
  });

  it('the SAME reported height yields platform-correct, DIFFERENT overlaps', () => {
    // This asymmetry is the whole point of the rule. If these two ever match,
    // someone has "simplified" the platform branch away and both bugs return.
    const ios = computeKeyboardOverlap({height: 300}, IOS);
    const android = computeKeyboardOverlap({height: 300}, ANDROID_30);
    expect(ios).toBe(300);
    expect(android).toBe(324);
    expect(android - ios).toBe(ANDROID_30.safeBottom);
  });
});

type Handler = (e?: {endCoordinates?: {height: number; screenY?: number}}) => void;

function mockKeyboard() {
  const handlers = new Map<string, Handler>();
  const removedEvents: string[] = [];
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((evt: string, cb: Handler) => {
    handlers.set(evt, cb);
    return {
      remove: () => {
        removedEvents.push(evt);
        handlers.delete(evt);
      },
    };
  }) as unknown as typeof Keyboard.addListener);
  return {
    removedEvents,
    // Fire both platform variants — the hook subscribes to whichever matches
    // the Jest Platform.OS, the other is a no-op.
    show(height: number) {
      act(() => {
        handlers.get('keyboardDidShow')?.({endCoordinates: {height}});
        handlers.get('keyboardWillShow')?.({endCoordinates: {height}});
      });
    },
    hide() {
      act(() => {
        handlers.get('keyboardDidHide')?.();
        handlers.get('keyboardWillHide')?.();
      });
    },
  };
}

function scrollSpy(ref: {current: ScrollView}): jest.Mock {
  return (ref.current as unknown as {scrollToEnd: jest.Mock}).scrollToEnd;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation(((cb: (time: number) => void) => {
      cb(0);
      return 0;
    }) as unknown as typeof globalThis.requestAnimationFrame);
});

describe('useKeyboardOverlap', () => {
  it('tracks show and hide', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(0);
    kb.show(312);
    expect(result.current).toBe(312);
    kb.hide();
    expect(result.current).toBe(0);
  });

  it('ignores sub-4dp OEM noise re-fires', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardOverlap());
    kb.show(300);
    kb.show(300 + KEYBOARD_NOISE_FLOOR_DP - 2);
    expect(result.current).toBe(300);
    kb.show(360);
    expect(result.current).toBe(360);
  });

  it('removes listeners on unmount', () => {
    const kb = mockKeyboard();
    const {unmount} = renderHook(() => useKeyboardOverlap());
    unmount();
    expect(kb.removedEvents.length).toBe(2);
  });
});

describe('useKeyboardLayout — replace, never stack', () => {
  // The jest.setup.app safe-area mock reports bottom: 0, so these assert the
  // SHAPE of the rule (which term wins) rather than a device-specific number.
  it('bottomPad falls back to the safe-area inset while the keyboard is closed', () => {
    mockKeyboard();
    const {result} = renderHook(() => useKeyboardLayout());
    expect(result.current.visible).toBe(false);
    expect(result.current.overlap).toBe(0);
    expect(result.current.bottomPad(8)).toBe(8); // safeBottom(0) + gap
  });

  it('bottomPad becomes OVERLAP + gap while the keyboard is open — the inset does not add on top', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardLayout());
    kb.show(300);
    expect(result.current.visible).toBe(true);
    expect(result.current.bottomPad(8)).toBe(308);
    // safeBottom collapses so a child inside an already-lifted container
    // cannot re-add the band the keyboard is already covering.
    expect(result.current.safeBottom).toBe(0);
  });

  it('gap defaults to 0', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardLayout());
    kb.show(300);
    expect(result.current.bottomPad()).toBe(300);
  });
});

describe('useRevealOnKeyboard', () => {
  function makeScrollRef() {
    return {current: {scrollToEnd: jest.fn()} as unknown as ScrollView};
  }

  it('defers the scroll until the keyboard actually shows', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    const {result} = renderHook(() => useRevealOnKeyboard(scrollRef));
    act(() => result.current());
    expect(scrollSpy(scrollRef)).not.toHaveBeenCalled();
    kb.show(300);
    expect(scrollSpy(scrollRef)).toHaveBeenCalledWith({animated: true});
  });

  it('scrolls immediately when the keyboard is already open (field-to-field focus)', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    const {result} = renderHook(() => useRevealOnKeyboard(scrollRef));
    kb.show(300);
    expect(scrollSpy(scrollRef)).not.toHaveBeenCalled();
    act(() => result.current());
    expect(scrollSpy(scrollRef)).toHaveBeenCalledTimes(1);
  });

  it('does not scroll if focus never happened', () => {
    const kb = mockKeyboard();
    const scrollRef = makeScrollRef();
    renderHook(() => useRevealOnKeyboard(scrollRef));
    kb.show(300);
    expect(scrollSpy(scrollRef)).not.toHaveBeenCalled();
  });
});

/**
 * B-252 — "the first time I tap the textbox it stays behind the keyboard; go
 * back, come in again, and it lifts correctly".
 *
 * The overlap is a function of (event, env), but only the event half was ever
 * an input: env was sampled at the instant the show event fired and the result
 * frozen. On Android `keyboardDidShow` fires only on a visibility TRANSITION,
 * so there is no second event to correct a value computed against a
 * half-initialised environment.
 *
 * That is the whole "first time only" shape. computeKeyboardOverlap adds
 * safeBottom back on API>=30, so a show event landing before the safe-area
 * provider has reported the real inset adds back 0 and the surface under-lifts
 * by the entire nav-bar band. Second visit: provider warm, inset correct on the
 * first render, works.
 */
describe('B-252 — the same event yields a different overlap as the env settles', () => {
  it('Android: an inset that has not resolved yet under-lifts by the whole band', () => {
    const evt = {height: 300};
    // First paint — the provider has not reported the nav bar yet.
    const cold = computeKeyboardOverlap(evt, {...ANDROID_30, safeBottom: 0});
    // Settled, 3-button nav.
    const warm = computeKeyboardOverlap(evt, {...ANDROID_30, safeBottom: 48});
    expect(cold).toBe(300);
    expect(warm).toBe(348);
    // The gap IS the bug: 48 dp of composer left under the keyboard.
    expect(warm - cold).toBe(48);
  });

  it('so the value must be RECOMPUTED, not frozen at event time', () => {
    // Guards the contract the hook now implements: keep the event, re-derive.
    const evt = {height: 300};
    expect(computeKeyboardOverlap(evt, {...ANDROID_30, safeBottom: 24}))
      .not.toBe(computeKeyboardOverlap(evt, {...ANDROID_30, safeBottom: 0}));
  });
});

describe('B-252 — useKeyboardOverlap seeds from an ALREADY-OPEN keyboard', () => {
  function mockStatics(visible: boolean, metrics?: {height: number; screenY?: number}) {
    (Keyboard as unknown as {isVisible?: () => boolean}).isVisible = () => visible;
    (Keyboard as unknown as {metrics?: () => unknown}).metrics = () => metrics;
  }

  afterEach(() => {
    delete (Keyboard as unknown as {isVisible?: unknown}).isVisible;
    delete (Keyboard as unknown as {metrics?: unknown}).metrics;
  });

  it('a hook mounting under an open IME reads the CURRENT height, not 0', () => {
    // A transition event that fired before this listener attached is gone for
    // good — a remounted composer, or a screen pushed with the keyboard up,
    // would otherwise read 0 for the entire visit.
    mockKeyboard();
    mockStatics(true, {height: 291});
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(291);
  });

  it('does not seed when the keyboard is closed', () => {
    mockKeyboard();
    mockStatics(false, {height: 291});
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(0);
  });

  it('survives an RN build with no isVisible/metrics statics at all', () => {
    // Seeding is a repair, never a requirement — the listeners stay primary.
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(0);
    kb.show(300);
    expect(result.current).toBe(300);
  });

  it('a zero-height metrics payload is ignored rather than latched', () => {
    mockKeyboard();
    mockStatics(true, {height: 0});
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(0);
  });

  it('still tears down exactly its two listeners', () => {
    const kb = mockKeyboard();
    mockStatics(true, {height: 291});
    const {unmount} = renderHook(() => useKeyboardOverlap());
    unmount();
    expect(kb.removedEvents.length).toBe(2);
  });

  it('hide clears the retained event, so a later env change cannot resurrect it', () => {
    const kb = mockKeyboard();
    const {result} = renderHook(() => useKeyboardOverlap());
    kb.show(300);
    expect(result.current).toBe(300);
    kb.hide();
    expect(result.current).toBe(0);
  });
});

describe('K4 — the keyboard-controller resize source (letter→emoji)', () => {
  const WIN = 800;
  // The controller reports the FULL covered band (translucent bars); the
  // overlap IS that band, env-independent — clamped to the window, never
  // barBand-adjusted (that is what avoids the B-252 over-lift regression).
  it('a full covered height is the overlap directly', () => {
    expect(keyboardControllerOverlap(320, WIN, 0)).toBe(320);
    expect(keyboardControllerOverlap(320, 0, 0)).toBe(320); // no window → clamp is a no-op
    expect(keyboardControllerOverlap(900, WIN, 0)).toBe(WIN); // clamps to the window
  });

  it('a closed keyboard (0) is overlap 0 regardless of the previous value', () => {
    expect(keyboardControllerOverlap(0, WIN, 300)).toBe(0);
    expect(keyboardControllerOverlap(-5, WIN, 300)).toBe(0);
  });

  it('an implausible cold-start reading (B-277 5dp) RETAINS the previous overlap, never drops', () => {
    // 5/800 = 0.6% — below the 15% floor. The composer must NOT fall behind
    // the keyboard on a garbage reading.
    expect(keyboardControllerOverlap(5, WIN, 326)).toBe(326);
    expect(keyboardControllerOverlap(5, WIN, 0)).toBe(0);
  });

  // THE BUG: the letter pad is ~290dp, the emoji pad (category + search rows +
  // grid) is taller ~380dp. Switching in-session fires no RN event, so the old
  // overlap stayed at the letter height and the emoji pad drew over the
  // composer. The controller source reports the taller height, and it MUST
  // produce a strictly larger overlap so the composer clears the emoji pad.
  it('the taller emoji pad yields a strictly larger overlap than the letter pad', () => {
    const letter = keyboardControllerOverlap(290, WIN, 0);
    const emoji = keyboardControllerOverlap(380, WIN, letter);
    expect(emoji).toBeGreaterThan(letter);
    expect(emoji).toBe(380); // covers the whole emoji band, not the stale shorter one
  });
});

describe('K4 seam — the controller onEnd drives overlap at runtime (Android)', () => {
  let origOS: typeof Platform.OS;
  beforeEach(() => {
    origOS = Platform.OS;
    (Platform as {OS: string}).OS = 'android';
    mockKcHolder.onEnd = undefined;
  });
  afterEach(() => { (Platform as {OS: string}).OS = origOS; });

  it('firing onEnd lifts overlap with NO RN event, follows an in-place resize, and clears on close', () => {
    mockKeyboard(); // RN listeners attach, but NO keyboardDidShow is fired
    const {result} = renderHook(() => useKeyboardOverlap());
    expect(result.current).toBe(0);
    expect(typeof mockKcHolder.onEnd).toBe('function'); // the hook subscribed

    // The letter pad opens — only the controller reports it here.
    act(() => { mockKcHolder.onEnd?.({height: 360}); });
    expect(result.current).toBe(360);

    // The letter→emoji in-place resize — the bug: RN fires nothing; the
    // controller is the only source, and the composer must follow it up.
    act(() => { mockKcHolder.onEnd?.({height: 460}); });
    expect(result.current).toBe(460);

    // Close.
    act(() => { mockKcHolder.onEnd?.({height: 0}); });
    expect(result.current).toBe(0);
  });

  it('does NOT drive overlap on iOS (RN owns the type-swap + screenY there)', () => {
    (Platform as {OS: string}).OS = 'ios';
    mockKeyboard();
    const {result} = renderHook(() => useKeyboardOverlap());
    act(() => { mockKcHolder.onEnd?.({height: 460}); });
    expect(result.current).toBe(0); // the Android gate short-circuits
  });
});
