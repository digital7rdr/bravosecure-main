/**
 * ⚠️ RETIRED COMPONENT — read this before "fixing" a failure here.
 *
 * B-646 r3: `TimeDropdownField` no longer uses `WheelTimePicker`; both booking
 * dashboards open the NATIVE platform picker (see `timeDropdownField.test.tsx`).
 * The only remaining reference to the wheel is `BookingDateTimeScreen`, which
 * nothing navigates to — both files are dead. This suite is kept as insurance in
 * case the wheel is ever revived, and it documents the three bugs that killed it.
 * If you delete `WheelTimePicker.tsx`, delete this suite in the SAME commit —
 * do not weaken an assertion to make a run green.
 *
 * B-646 — the time wheel froze under the finger.
 *
 * `Column` drives an IMPERATIVE `ref.scrollTo()` from an effect. The effect used to
 * depend on `[selected, values]`, and the parent rebuilt `values` with `Array.from()`
 * inline in its render body — a new array identity every render. So the effect ran on
 * EVERY render of every column and re-issued `scrollTo({animated: true})`. An animated
 * scrollTo emits its own scroll events and fires `onMomentumScrollEnd` when it settles,
 * which called `onChange`, which re-rendered, which scrolled again. The wheel fought
 * the finger and read as frozen — founder, on device, 2026-08-24.
 *
 * Exactly the same shape as B-643 (the Android date dialog): an unmemoised identity in
 * an effect's dep array re-firing an imperative call on every render.
 *
 * STATIC SOURCE SCAN. The render tests in `timeDropdownField.test.tsx` cover the
 * wheel's VALUE contract but cannot observe how many times a native scroll command was
 * issued, which is the whole defect. Per CLAUDE.md comments are stripped first — the
 * fix's own comment names `values`, `scrollTo` and `animated: true`, so an unstripped
 * scan would pass vacuously — and CRLF is normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE = join(process.cwd(), 'src', 'components', 'booking', 'WheelTimePicker.tsx');

function source(): string {
  return readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-646 — the wheel never re-scrolls itself', () => {
  const src = stripComments(source());

  it('the scroll effect keys on the row INDEX, never on the values array identity', () => {
    // The array is rebuilt by the parent on render; depending on it re-runs forever.
    expect(src).not.toMatch(/\}, \[selected, values\]\);/);
    expect(src).toMatch(/\}, \[idx\]\);/);
  });

  it('never scrolls while the wheel is under the user control', () => {
    expect(src).toMatch(/onScrollBeginDrag=\{onDragStart\}/);
    expect(src).toMatch(/onScrollEndDrag=\{onDragEnd\}/);
    expect(src).toMatch(/if \(busy\.current \|\| appliedIdx\.current === idx\) \{return;\}/);
  });

  // B-646 r2 — the guard must span the MOMENTUM phase. onScrollEndDrag fires the
  // instant the finger lifts, but the wheel keeps gliding until momentum end.
  // Releasing at drag-end left a window where a re-render found the guard down
  // with appliedIdx still on the OLD row, and scrolled the wheel back mid-glide.
  it('holds the guard through momentum, not just the touch', () => {
    // Drag-end must NOT clear it synchronously.
    expect(src).not.toMatch(/const onDragEnd = useCallback\(\(\) => \{busy\.current = false;/);
    expect(src).toMatch(/const onDragEnd = releaseSoon;/);
    // Momentum end is what really clears it...
    const mom = src.slice(src.indexOf('const onMomentumEnd'), src.indexOf('const onDragStart'));
    expect(mom).toMatch(/busy\.current = false;/);
    expect(mom).toMatch(/clearTimeout\(settle\.current\)/);
    // ...with a timer fallback, because RN emits no momentum-end on a slow release.
    expect(src).toMatch(/settle\.current = setTimeout\(/);
    // And the timer must not outlive the column.
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{ if \(settle\.current\) \{clearTimeout\(settle\.current\);\} \}, \[\]\);/);
  });

  it('records where the wheel physically landed, so the same offset is not re-issued', () => {
    const fn = src.slice(src.indexOf('const onMomentumEnd'), src.indexOf('const onDragStart'));
    expect(fn.length).toBeGreaterThan(50);
    expect(fn).toMatch(/appliedIdx\.current = clamped;/);
    // The commit is still conditional — a momentum end on the SAME row must not
    // fire onChange, or Done-less scrolling would churn the parent.
    expect(fn).toMatch(/if \(next !== selected\) \{onChange\(next\);\}/);
  });

  it('the hour and minute columns get stable array identities', () => {
    expect(src).toMatch(/const hours = useMemo\(/);
    expect(src).toMatch(/const minutes = useMemo\(/);
    // A bare Array.from at the top level of the component body is the bug.
    const body = src.slice(src.indexOf('export default function WheelTimePicker'));
    expect(body).not.toMatch(/\n {2}const (hours|minutes) = (is12\s*\n?\s*\?\s*)?Array\.from\(/);
  });

  // B-646 r2 — the two reasons the wheel would not scroll AT ALL on a device.
  it('the centre rail cannot intercept touches', () => {
    const railBlock = src.slice(src.indexOf('rail: {'));
    const block = railBlock.slice(0, railBlock.indexOf('},') + 2);
    // A z-indexed sibling is lifted above the columns for HIT-TESTING on Android,
    // and the band sits exactly where a thumb lands.
    expect(block).not.toMatch(/zIndex/);
    // It must still be inert and painted behind the numbers.
    expect(src).toMatch(/<View pointerEvents="none" style=\{s\.rail\} \/>/);
    expect(src.indexOf('style={s.rail}')).toBeLessThan(src.indexOf('style={s.cols}'));
  });

  it('a flick scrolls — interval momentum is NOT disabled', () => {
    // `disableIntervalMomentum` stops on the index at RELEASE regardless of
    // velocity, so a normal flick snaps back to where it started.
    expect(src).not.toMatch(/disableIntervalMomentum/);
    expect(src).toMatch(/snapToInterval=\{ITEM_HEIGHT\}/);
    expect(src).toMatch(/decelerationRate="fast"/);
  });

  it('the wheel still only reports on momentum end, not on every scroll frame', () => {
    // onScroll would put a JS state write on every frame — a different way to
    // saturate the same thread.
    expect(src).not.toMatch(/onScroll=\{/);
    expect(src).toMatch(/onMomentumScrollEnd=\{onMomentumEnd\}/);
  });
});
