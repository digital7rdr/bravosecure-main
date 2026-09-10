/**
 * B-285 — the stall watchdog must not cry wolf.
 *
 * The first version on device reported "JS thread blocked ~4760ms" when the
 * founder opened the system photo picker. The app was not blocked — it was
 * BACKGROUNDED, Android suspends timers for a backgrounded process, and the
 * interval simply did not fire. That reading sent me looking for four seconds of
 * work that never happened.
 *
 * An over-reporting profiler is worse than no profiler, so the background case is
 * pinned here: a real stall reports, a backgrounded gap never does.
 */
import {AppState} from 'react-native';
import {
  startJsThreadWatchdog,
  stopJsThreadWatchdog,
  jsThreadStallStats,
  _resetJsThreadWatchdogForTest,
} from '../jsThreadWatchdog';

type Listener = () => void;
let listeners: Listener[] = [];
let warns: string[] = [];
/**
 * B-303 — the MONOTONIC clock the watchdog now measures with.
 *
 * These helpers used to fake a stall with `jest.setSystemTime(Date.now() + ms)`,
 * i.e. by stepping the WALL clock — which is precisely the false positive B-303
 * removed (an NTP correction is not a blocked thread). The suite was encoding
 * the bug as its definition of a stall, so it went red against the fix and had
 * to be corrected here rather than the fix being softened.
 *
 * Driving `performance.now()` directly is also strictly more faithful:
 * `advanceTimersByTime` moves clock and timers in lockstep and can never
 * produce drift on its own, so drift has to be injected deliberately either way.
 */
let perfNow = 0;

beforeEach(() => {
  jest.useFakeTimers();
  _resetJsThreadWatchdogForTest();
  listeners = [];
  warns = [];
  perfNow = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => perfNow);
  jest.spyOn(console, 'warn').mockImplementation((m?: unknown) => { warns.push(String(m)); });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, cb: Listener) => {
    listeners.push(cb);
    return {remove: () => { listeners = listeners.filter(l => l !== cb); }};
  }) as unknown as typeof AppState.addEventListener);
  setAppState('active');
});

afterEach(() => {
  stopJsThreadWatchdog();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function setAppState(s: 'active' | 'background'): void {
  Object.defineProperty(AppState, 'currentState', {value: s, configurable: true, writable: true});
}

/**
 * One healthy tick: the timer fires on schedule, so drift is 0.
 *
 * Note `advanceTimersByTime` moves the FAKE CLOCK in lockstep with the timers, so
 * it can never on its own produce drift — advancing 2000ms just fires the 250ms
 * interval eight times with 0 drift each. That is why a stall needs `stall()`.
 */
function tick(): void {
  perfNow += 250;              // exactly one period elapsed → drift 0
  jest.advanceTimersByTime(250);
}

/**
 * Simulate the JS thread being blocked for `ms`: the wall clock jumps forward
 * while only ONE interval callback gets to run, which is exactly what a blocked
 * thread looks like from inside the timer.
 */
function stall(ms: number): void {
  // B-303 — advance the MONOTONIC clock, not the wall clock. Real elapsed time
  // passed while only one interval callback got to run: that is what a blocked
  // thread looks like from inside the timer, and it is what must still report.
  perfNow += ms;
  jest.advanceTimersByTime(250);
}

describe('B-285 — a genuine foreground stall is reported', () => {
  it('a long gap while active reports once', () => {
    startJsThreadWatchdog();
    tick();          // a normal tick — no drift
    expect(warns).toHaveLength(0);

    // One interval that takes far longer than its period. Fake timers fire the
    // callback once per elapsed period; the LAST of those carries the drift.
    stall(2000);
    expect(warns.some(w => w.includes('JS thread blocked'))).toBe(true);
    expect(jsThreadStallStats().stalls).toBeGreaterThan(0);
  });

  it('normal ticks never report', () => {
    startJsThreadWatchdog();
    for (let i = 0; i < 20; i++) { tick(); }
    expect(warns).toHaveLength(0);
    expect(jsThreadStallStats()).toEqual({stalls: 0, worstMs: 0});
  });

  it('B-303 — a WALL-CLOCK step is not a stall', () => {
    // The device repro: Pixel 6a, 2026-07-27, stall #389 "blocked ~2425ms" sat
    // exactly on an NTP correction plus a TIME_SET broadcast, with no app work
    // in the window. The wall clock leaps; no real time passes; the JS thread
    // was never blocked. Reporting it sends the next session hunting 2.4s of
    // work that never ran — the same cost the backgrounded-app case already had.
    startJsThreadWatchdog();
    tick();
    expect(warns).toHaveLength(0);

    jest.setSystemTime(Date.now() + 2425);  // NTP steps the wall clock...
    perfNow += 250;                          // ...but only one period really elapsed
    jest.advanceTimersByTime(250);

    expect(warns).toHaveLength(0);
    expect(jsThreadStallStats()).toEqual({stalls: 0, worstMs: 0});
  });
});

describe('B-285 — THE FALSE POSITIVE: backgrounding is not a stall', () => {
  it('a gap spent in the background is NOT reported', () => {
    startJsThreadWatchdog();
    tick();
    setAppState('background');
    listeners.forEach(l => l());
    stall(5000);                       // the photo-picker case, 5s away
    expect(warns).toHaveLength(0);
    expect(jsThreadStallStats().stalls).toBe(0);
  });

  it('a background round-trip INSIDE one interval is not reported either', () => {
    // The two-sample check (active now && active before) cannot see this on its
    // own: both samples read 'active'. The transition flag is what catches it.
    startJsThreadWatchdog();
    tick();
    setAppState('background');
    listeners.forEach(l => l());
    setAppState('active');
    listeners.forEach(l => l());
    stall(5000);
    expect(warns).toHaveLength(0);
  });

  it('reporting RESUMES after the app settles back in the foreground', () => {
    // The guard must not latch. If one backgrounding silenced the watchdog for
    // the rest of the session it would be useless after the first photo pick.
    startJsThreadWatchdog();
    setAppState('background');
    listeners.forEach(l => l());
    stall(3000);
    setAppState('active');
    listeners.forEach(l => l());
    tick();   // settle: consumes the transition flag
    tick();   // a clean active interval
    warns.length = 0;
    stall(2000);  // now a genuine stall
    expect(warns.some(w => w.includes('JS thread blocked'))).toBe(true);
  });
});

describe('B-285 — lifecycle hygiene', () => {
  it('is idempotent — starting twice does not stack two timers', () => {
    // Two timers would double every report and misstate the cadence.
    startJsThreadWatchdog();
    startJsThreadWatchdog();
    tick();
    stall(2000);
    const first = warns.filter(w => w.includes('JS thread blocked')).length;
    expect(first).toBeGreaterThan(0);
    expect(warns.filter(w => w.includes('stall #2')).length).toBeLessThanOrEqual(1);
  });

  it('stop() removes the AppState subscription', () => {
    startJsThreadWatchdog();
    expect(listeners).toHaveLength(1);
    stopJsThreadWatchdog();
    expect(listeners).toHaveLength(0);
  });
});
