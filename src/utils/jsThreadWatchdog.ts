/**
 * B-285 — JS-thread stall watchdog.
 *
 * Founder: "sometimes the button tap is not registering — I mean the tap renders
 * but the action takes time to register." That description is diagnostic: a
 * `TouchableOpacity`'s press feedback is an Animated opacity change that can run
 * without JS, while `onPress` is a JS callback. Feedback-now / action-later means
 * the JS thread was BUSY when the touch landed, not that the touch was missed.
 *
 * `dumpsys gfxinfo` already showed `Number High input latency` at 590-890 per
 * scripted run, but that counter says nothing about WHAT was running. This does:
 * a fixed-period timer that reports how far its own wake-up drifted. A timer that
 * should fire every 250ms and fires 900ms late means the thread was blocked for
 * ~650ms, and the timestamp says when — which can then be lined up against the
 * other logs to name the culprit.
 *
 * `console.warn`, deliberately: `babel-plugin-transform-remove-console` strips
 * `log` from release builds and keeps `warn`, and a release build is the only
 * place these stalls are worth measuring.
 */

/**
 * FALSE POSITIVE, found on device and fixed here — read before trusting output.
 *
 * Android suspends timers for a BACKGROUNDED process. Opening the system photo
 * picker backgrounded the app for 4.7s, the interval simply did not fire, and the
 * first version of this watchdog reported it as "JS thread blocked ~4760ms". It
 * was not blocked; it was not running. Android's own `Looper PerfMonitor longMsg`
 * shares the confound, because a descheduled process inflates a message's wall
 * time without doing any work.
 *
 * So a report is only emitted when the app was `active` for the WHOLE interval:
 * active now, active at the previous tick, and no foreground transition in
 * between. Anything else is discarded rather than guessed at — an over-reporting
 * profiler is worse than none, because it sends you chasing work that never ran.
 */
/**
 * SECOND FALSE POSITIVE, found on device (B-303) — the clock itself.
 *
 * Drift used to be computed from `Date.now()`, which is a WALL clock. An NTP
 * correction, a DST/timezone write or a manual time change STEPS it, and the
 * entire step lands in `drift` as a stall that never happened. On the Pixel 6a
 * (2026-07-27) stall #389 reported "blocked ~2425ms" sitting exactly on a clock
 * step plus a `TIME_SET` broadcast, with no app work in the window.
 *
 * That matters more than an ordinary logging bug: CLAUDE.md's lag section tells
 * future sessions to trust these numbers while hunting the one freeze that is
 * still unexplained, so a probe that inflates its own worst-case sends them
 * chasing work that never ran — exactly what the background case above already
 * cost once.
 *
 * `performance.now()` is monotonic and immune to clock steps.
 */
import {AppState} from 'react-native';
import {markJsStallOnActiveLanes} from '../modules/messenger/runtime/callDiag';

/**
 * Pick a monotonic time source. Exported as a test seam: the runtime `performance`
 * global cannot be removed from under a suite, and the fallback branch is the one
 * that must not silently freeze (a constant source would report zero stalls
 * forever, which reads as "the lag is fixed").
 */
export function _selectMonotonicNow(perf: {now?: () => number} | undefined): () => number {
  return typeof perf?.now === 'function' ? () => perf.now!() : () => Date.now();
}

/**
 * Resolved on EVERY call, not captured once at import. Capturing binds whichever
 * `performance` existed when this module first loaded — and if the runtime
 * installs its own later (RN does not guarantee ordering), the watchdog would
 * silently keep measuring with the wall clock forever, which is the very bug
 * above. One rule, applied live.
 */
const monotonicNow = (): number =>
  _selectMonotonicNow((globalThis as {performance?: {now?: () => number}}).performance)();

/** How often the watchdog wakes. Short enough to catch a stall inside one tap. */
const TICK_MS = 250;
/**
 * Drift below this is timer jitter, not a stall. A frame is ~16ms; anything under
 * ~8 frames of drift is not what the founder is feeling.
 */
const REPORT_OVER_MS = 120;

let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let worst = 0;
let stalls = 0;
/** Whether the app was foreground at the PREVIOUS tick. */
let wasActive = true;
/** Set on any AppState change, cleared each tick — catches a background+return
 *  that starts and ends inside one interval, which the two-sample check misses. */
let sawTransition = false;
let sub: {remove: () => void} | null = null;

/**
 * Start reporting JS-thread stalls. Idempotent — calling it twice does not stack
 * two timers, which would double the reports and hide the real cadence.
 */
export function startJsThreadWatchdog(): void {
  if (timer) {return;}
  last = monotonicNow();
  wasActive = AppState.currentState === 'active';
  sawTransition = false;
  sub = AppState.addEventListener('change', () => { sawTransition = true; });
  scheduleCryptoFloorProbe();
  timer = setInterval(() => {
    const now = monotonicNow();
    // B-303 — `performance.now()` is fractional; report whole ms so the log
    // stays comparable with the pre-B-303 numbers already quoted in CLAUDE.md.
    const drift = Math.round(now - last - TICK_MS);
    const isActive = AppState.currentState === 'active';
    // Snapshot and clear BEFORE the early return, or a transition would leak
    // into the next interval and suppress a genuine stall.
    const bridged = sawTransition;
    sawTransition = false;
    const activeThroughout = isActive && wasActive && !bridged;
    wasActive = isActive;
    last = now;
    if (!activeThroughout) {return;}   // backgrounded — not a stall, see header
    if (drift > REPORT_OVER_MS) {
      stalls += 1;
      if (drift > worst) {worst = drift;}
      console.warn(`[LAGDIAG] JS thread blocked ~${drift}ms (stall #${stalls}, worst ${worst}ms)`);
      // Audit Step 0 — the same stall as a [CALLLAT] row on every LIVE call
      // lane, so a JS stall inside a join is not mistaken for a network wait.
      try { markJsStallOnActiveLanes(drift); } catch { /* diagnostics never throw */ }
    }
  }, TICK_MS);
}

export function stopJsThreadWatchdog(): void {
  if (!timer) {return;}
  clearInterval(timer);
  timer = null;
  sub?.remove();
  sub = null;
  if (floorTimer) {clearTimeout(floorTimer); floorTimer = null;}
}

/**
 * W3/B-688 — one-shot crypto-floor probe. The messenger's digests run in
 * pure JS (crypto/polyfills.ts routes subtle.digest through @noble because
 * quick-crypto's native EVP lookup is broken) and the wire text codec is the
 * pure-JS `text-encoding` package. W5 of DEAD_PHONE_SMOOTHNESS_PLAN.md
 * (restoring the native floor) is GATED on knowing what that actually costs
 * on-device — this measures the REAL paths the app uses (the global
 * subtle.digest and TextEncoder/TextDecoder, post-polyfill), once, 30s
 * after boot, and warns numbers only. The bench itself blocks the JS thread
 * for its duration, so the watchdog may report one stall immediately after
 * the [crypto.floor] line — soak analysis must pair them, not count it.
 */
const FLOOR_PROBE_DELAY_MS = 30_000;
let floorTimer: ReturnType<typeof setTimeout> | null = null;
let floorRan = false;

function scheduleCryptoFloorProbe(): void {
  if (floorRan || floorTimer) {return;}
  floorTimer = setTimeout(() => {
    floorTimer = null;
    if (floorRan) {return;}
    floorRan = true;
    (async () => {
      try {
        if (AppState.currentState !== 'active') {return;}   // don't bench a suspended app
        const subtle = (globalThis as {crypto?: {subtle?: {digest?: (a: string, b: ArrayBuffer) => Promise<ArrayBuffer>}}})
          .crypto?.subtle;
        if (!subtle?.digest) {return;}
        const oneKb = new Uint8Array(1024).fill(7).buffer;
        const t0 = monotonicNow();
        for (let i = 0; i < 200; i++) {await subtle.digest('SHA-256', oneKb);}
        const digestMs = Math.round(monotonicNow() - t0);
        const bigStr = 'a'.repeat(100 * 1024);
        const t1 = monotonicNow();
        const encoded = new TextEncoder().encode(bigStr);
        new TextDecoder().decode(encoded);
        const codecMs = Math.round(monotonicNow() - t1);
        console.warn(`[LAGDIAG] [crypto.floor] sha256x200x1KB=${digestMs}ms codec100KB=${codecMs}ms`);
      } catch { /* diagnostics never throw */ }
    })().catch(() => { /* diagnostics never throw */ });
  }, FLOOR_PROBE_DELAY_MS);
}

/** Test seam. */
export function _resetCryptoFloorProbeForTest(): void {
  if (floorTimer) {clearTimeout(floorTimer);}
  floorTimer = null; floorRan = false;
}

/** Test seam — the counters are module state, so a suite must be able to reset them. */
export function _resetJsThreadWatchdogForTest(): void {
  stopJsThreadWatchdog();
  last = 0; worst = 0; stalls = 0; wasActive = true; sawTransition = false;
}

/** Current tally, for a test or a debug screen. */
export function jsThreadStallStats(): {stalls: number; worstMs: number} {
  return {stalls, worstMs: worst};
}
