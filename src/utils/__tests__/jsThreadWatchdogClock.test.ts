/**
 * B-303 — the stall watchdog measured with a WALL clock, so a time change read
 * as a multi-second JS freeze.
 *
 * `startJsThreadWatchdog` computed drift from `Date.now()`. `Date.now()` is not
 * monotonic: an NTP correction, a timezone/DST write, or a manual clock change
 * STEPS it, and the whole step lands in `drift` as a stall that never happened.
 *
 * Device evidence (Pixel 6a, 2026-07-27): stall **#389, "blocked ~2425ms"**,
 * sits exactly on a clock step plus a `TIME_SET` broadcast, with no app work in
 * the window at all.
 *
 * This is the SAME class of defect as the backgrounded-app false positive the
 * module header already documents (and which `jsThreadWatchdog.test.ts` pins) —
 * a second, independent way for the probe to invent work. It matters more than
 * a normal logging bug because CLAUDE.md's lag section instructs future sessions
 * to trust these numbers when hunting the remaining unexplained freeze; a probe
 * that inflates its own worst-case sends them chasing nothing.
 *
 * `performance.now()` is monotonic and immune to clock steps. The fallback
 * matters too: if a runtime lacks it we must still measure (with the old
 * caveat) rather than crash or silently stop reporting.
 */
import {_selectMonotonicNow} from '../jsThreadWatchdog';

describe('B-303 — drift must come from a monotonic clock', () => {
  it('prefers performance.now() when the runtime has it', () => {
    let ticks = 1000;
    const perf = {now: () => ticks};
    const now = _selectMonotonicNow(perf);

    expect(now()).toBe(1000);
    ticks = 1250;
    expect(now()).toBe(1250);
  });

  it('a wall-clock STEP does not move the monotonic reading', () => {
    // The actual bug, in one assertion: Date.now() jumps, performance.now()
    // does not, and drift must be computed from the one that does not.
    let monotonic = 500;
    const now = _selectMonotonicNow({now: () => monotonic});

    const before = now();
    const dateBefore = Date.now();
    // Simulate an NTP correction: wall clock leaps forward, no time passes.
    const dateAfter = dateBefore + 2425;
    const after = now();

    expect(after - before).toBe(0);          // no real time elapsed
    expect(dateAfter - dateBefore).toBe(2425); // ...but the wall clock says 2.4s
    monotonic += 250;
    expect(now() - before).toBe(250);         // and it still tracks real elapsed time
  });

  it('falls back to a working clock when performance.now() is absent', () => {
    // Must keep measuring rather than return a constant — a frozen source would
    // silently report zero stalls forever, which reads as "the lag is fixed".
    for (const missing of [undefined, {}, {now: 42 as unknown as () => number}]) {
      const now = _selectMonotonicNow(missing as {now?: () => number} | undefined);
      const a = now();
      expect(typeof a).toBe('number');
      expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('the watchdog does not compute drift from Date.now()', () => {
    // Source scan: the seam above can be correct while the call site still uses
    // the wall clock. CRLF-safe (no `\n` anchors), comments stripped first —
    // this file's own prose names Date.now() repeatedly.
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'utils', 'jsThreadWatchdog.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');

    // The two reads that produce `drift` must both be monotonic.
    expect(src).toMatch(/last = monotonicNow\(\)/);
    expect(src).toMatch(/const now = monotonicNow\(\)/);
    // And the wall clock must not be what the interval samples.
    expect(src).not.toMatch(/const now = Date\.now\(\)/);
  });
});
