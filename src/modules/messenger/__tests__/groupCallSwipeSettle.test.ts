/**
 * B-242 — group-call tile pager: sliding must work, and a terminated gesture
 * must not strand the page-stack shoved off-screen-left.
 *
 * Founder report: on a group VIDEO call, swiping between tile pages did nothing
 * and the tiles were jammed as ~40px slivers at the FAR LEFT with a black
 * centre. Root cause: the PanResponder had only onPanResponderRelease, so a
 * gesture TERMINATED mid-drag (a child touchable stealing it, an OS cancel, a
 * re-render churn) never reset `swipeX` — the whole stack sat translated left
 * forever. The fix runs the SAME resolveSwipeSettle from BOTH release and
 * terminate, and lands the page on a fast FLICK, not only a long drag.
 *
 * This pins the pure decision (node-testable) + the productionRuntime-style
 * source scan of the screen wire (GroupCallScreen pulls react-native and cannot
 * be imported under the node project).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  resolveSwipeSettle,
  SWIPE_DISTANCE_FRACTION,
  SWIPE_FLING_VELOCITY,
} from '../webrtc/groupCallLayout';

const PAGE = 1000; // distance threshold = 1000 * 0.18 = 180
const base = {pageW: PAGE, pageIndex: 1, totalPages: 3};

describe('resolveSwipeSettle', () => {
  it('advances to the NEXT page on a long left drag', () => {
    expect(resolveSwipeSettle({...base, dx: -300, vx: 0})).toBe(2);
  });

  it('advances to the PREVIOUS page on a long right drag', () => {
    expect(resolveSwipeSettle({...base, dx: 300, vx: 0})).toBe(0);
  });

  it('advances NEXT on a fast left FLICK even with a short drag (the sliding fix)', () => {
    expect(resolveSwipeSettle({...base, dx: -40, vx: -0.5})).toBe(2);
  });

  it('advances PREV on a fast right flick with a short drag', () => {
    expect(resolveSwipeSettle({...base, dx: 40, vx: 0.5})).toBe(0);
  });

  it('springs back on a short, slow drag (below BOTH distance and fling)', () => {
    expect(resolveSwipeSettle({...base, dx: -40, vx: -0.1})).toBe(1);
  });

  it('springs back when distance and fling DISAGREE (a reversed flick)', () => {
    expect(resolveSwipeSettle({...base, dx: -300, vx: 0.5})).toBe(1);
  });

  it('clamps at the last page (cannot advance past the end)', () => {
    expect(resolveSwipeSettle({pageW: PAGE, pageIndex: 2, totalPages: 3, dx: -300, vx: -1})).toBe(2);
  });

  it('clamps at the first page (cannot go before 0)', () => {
    expect(resolveSwipeSettle({pageW: PAGE, pageIndex: 0, totalPages: 3, dx: 300, vx: 1})).toBe(0);
  });

  it('is a no-op when there is only one page', () => {
    expect(resolveSwipeSettle({pageW: PAGE, pageIndex: 0, totalPages: 1, dx: -900, vx: -2})).toBe(0);
  });

  it('never changes page when pageW is degenerate (0) — no NaN threshold', () => {
    expect(resolveSwipeSettle({pageW: 0, pageIndex: 1, totalPages: 3, dx: -900, vx: -2})).toBe(1);
  });

  it('exposes tuned thresholds', () => {
    expect(SWIPE_DISTANCE_FRACTION).toBeGreaterThan(0);
    expect(SWIPE_FLING_VELOCITY).toBeGreaterThan(0);
  });
});

describe('B-242 wiring — GroupCallScreen pager settles on terminate + flings', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx'),
    'utf8',
  );
  // CRLF-safe, comment-stripped view for the behavioural assertions.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('runs the SAME settle on BOTH release and terminate (a terminated gesture no longer strands swipeX)', () => {
    expect(code).toMatch(/onPanResponderRelease:[^\n]*settle\(g\)/);
    expect(code).toMatch(/onPanResponderTerminate:[^\n]*settle\(g\)/);
  });

  it('does not yield the swipe mid-gesture', () => {
    expect(code).toMatch(/onPanResponderTerminationRequest:\s*\(\)\s*=>\s*false/);
  });

  it('routes the settle decision through the pure resolveSwipeSettle', () => {
    expect(src).toContain('resolveSwipeSettle');
    expect(code).toMatch(/resolveSwipeSettle\(/);
  });

  it('moved the 1s duration tick into a leaf so the tile tree stops re-rendering each second (smoothness)', () => {
    expect(code).toMatch(/function CallDurationTimer\(/);
    // WI-3.7 gave this leaf a `roomId` prop, so the old exact-match on
    // `<CallDurationTimer />` no longer described it. Rather than loosen the
    // pin, assert what B-242 actually cared about — the once-per-second state
    // lives INSIDE the leaf, so the parent's tile tree is not re-rendered by
    // it. A prop on the element is fine; the `setInterval` escaping back into
    // GroupCallScreen's own body is not.
    expect(code).toMatch(/<CallDurationTimer[\s/>]/);
    const at = code.indexOf('function CallDurationTimer(');
    expect(at).toBeGreaterThan(-1);
    const leaf = code.slice(at, at + 900);
    expect(leaf).toMatch(/setInterval\(tick, 1000\)/);
    expect(leaf).toMatch(/setElapsed\(/);
    // …and nowhere else in the screen.
    const elsewhere = code.slice(0, at) + code.slice(at + 900);
    expect(elsewhere).not.toMatch(/setInterval\(tick, 1000\)/);
  });
});
