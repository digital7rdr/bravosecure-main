/**
 * Behaviour pins for the cold-start security-check intro.
 *
 * Client request (Corne Breytenbach, 2026-08-31): bring back the encryption
 * loading screen as a ~1.5 s intro on app open — but the client scoped it
 * themselves after the founder flagged the annoyance:
 *
 *   "When you close App completely on phone and Open again it should show...
 *    If the App is open, but just minimised on the phone in background, it must
 *    not load."
 *
 * That second sentence is the whole contract, and it is the part a later change
 * would silently break — an AppState-driven implementation would look correct in
 * a manual cold-start test and replay the intro on every resume in the field.
 * These pins encode "once per JS runtime", which is what makes resume-silence
 * true by construction.
 */
import {act, renderHook} from '@testing-library/react-native';
import {
  useColdStartIntro,
  COLD_START_INTRO_MS,
  __resetColdStartIntroForTests,
} from '@components/useColdStartIntro';

describe('cold-start security-check intro', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetColdStartIntroForTests();
  });
  afterEach(() => { jest.useRealTimers(); });

  it('runs for the 1.5 s the client asked for', () => {
    // Not merely "some duration": the client named 1.5 s, and a drift here is
    // invisible on device but changes the feature they signed off.
    expect(COLD_START_INTRO_MS).toBe(1500);
  });

  it('shows on a cold start and clears itself after the intro window', () => {
    const {result} = renderHook(() => useColdStartIntro());
    expect(result.current.showing).toBe(true);
    expect(result.current.isColdBoot).toBe(true);

    act(() => { jest.advanceTimersByTime(COLD_START_INTRO_MS - 1); });
    expect(result.current.showing).toBe(true);

    act(() => { jest.advanceTimersByTime(1); });
    expect(result.current.showing).toBe(false);
  });

  it('does NOT replay on a resume — the app was only minimised', () => {
    // A background -> foreground resume keeps the JS runtime, so the module
    // flag is already burned. Modelled here as a second mount without a reset.
    const first = renderHook(() => useColdStartIntro());
    act(() => { jest.advanceTimersByTime(COLD_START_INTRO_MS); });
    first.unmount();

    const resumed = renderHook(() => useColdStartIntro());
    expect(resumed.result.current.showing).toBe(false);
    expect(resumed.result.current.isColdBoot).toBe(false);
  });

  it('does not replay even if the intro is interrupted before it finishes', () => {
    // The flag burns on MOUNT, not on timer expiry. Burning it late would let a
    // remount inside the intro window start a second intro.
    const first = renderHook(() => useColdStartIntro());
    expect(first.result.current.showing).toBe(true);
    act(() => { jest.advanceTimersByTime(200); });
    first.unmount();

    const again = renderHook(() => useColdStartIntro());
    expect(again.result.current.showing).toBe(false);
  });

  it('isColdBoot stays true for the whole process after showing ends', () => {
    // RootNavigator picks its checklist from this. If it flipped with `showing`,
    // the steps array identity would change mid-boot and restart the animation.
    const {result} = renderHook(() => useColdStartIntro());
    act(() => { jest.advanceTimersByTime(COLD_START_INTRO_MS); });
    expect(result.current.showing).toBe(false);
    expect(result.current.isColdBoot).toBe(true);
  });

  it('a fresh runtime shows it again', () => {
    renderHook(() => useColdStartIntro());
    act(() => { jest.advanceTimersByTime(COLD_START_INTRO_MS); });

    __resetColdStartIntroForTests(); // = the process was killed and relaunched
    const cold = renderHook(() => useColdStartIntro());
    expect(cold.result.current.showing).toBe(true);
  });
});
