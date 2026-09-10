import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-190 — Incident queue: "Any status" label + filter rows folding.
 *
 * Three defects in one row pair:
 *
 *   1. The status row read "Any status" while the severity row directly above it
 *      already read "All" — two labels for the same idea.
 *   2. The severity row was a plain `View` of five `flex: 1` chips, which
 *      squeezed "Critical" to an ellipsis at 320dp.
 *   3. `statusScroll` was a fixed `height: 44` while `statusRow` still carried
 *      `paddingBottom: 12` — leaving 32dp for a chip that needs ~35, so the chips
 *      were clipped top AND bottom.
 *
 * Fix: both rows scroll horizontally and never wrap, chips size to their own
 * label (`flexShrink: 0`), and the inter-row gap moved to `marginBottom` —
 * OUTSIDE the fixed-height box. A paddingBottom inside a fixed-height scroll
 * view eats the chip's own space, which is what folded the labels.
 *
 * `IncidentQueueScreen.tsx` is an RN screen with native-module imports, so this
 * is a source scan. CRLF-safe; comments are stripped before every assertion —
 * the fix's own explanatory comments name `paddingBottom`, `flex:1` and the old
 * heights, which would otherwise make the absence assertions pass vacuously.
 */

const SCREEN = join(
  process.cwd(), 'src', 'screens', 'deptchat', 'IncidentQueueScreen.tsx',
);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function source(): string {
  return stripComments(readFileSync(SCREEN, 'utf8'));
}

/** A named StyleSheet entry's body, CODE only. */
function style(name: string): string {
  const src = source();
  const start = src.indexOf(`${name}: {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}', start + name.length + 3);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-190 — incident queue filter rows', () => {
  it('BOTH filter rows are horizontal ScrollViews', () => {
    const src = source();
    const horizontal = src.match(/<ScrollView\s+horizontal/g) ?? [];
    // Severity row + status row. A plain View for either one is the regression:
    // five flex:1 chips ellipsised "Critical" at 320dp.
    expect(horizontal.length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/contentContainerStyle=\{s\.filterRow\}/);
    expect(src).toMatch(/contentContainerStyle=\{s\.statusScroll\}|contentContainerStyle=\{s\.statusRow\}/);
  });

  it('the severity row no longer stretches chips with flex: 1', () => {
    expect(style('filterRow')).not.toMatch(/flex:\s*1\b/);
  });

  it('chips size to their own label and never shrink below it', () => {
    // Without flexShrink: 0 a longer status label ("Under review") was squeezed
    // narrower than its text and wrapped to two lines, while short labels fit
    // and hid the bug.
    expect(style('statusChip')).toMatch(/flexShrink:\s*0\b/);
  });

  it('the inter-row gap lives in marginBottom, OUTSIDE the fixed-height box', () => {
    expect(style('statusScroll')).toMatch(/marginBottom:\s*\d/);
    expect(style('filterScroll')).toMatch(/marginBottom:\s*\d/);
  });

  it('no paddingBottom inside the scrolled row content (the clipping cause)', () => {
    // 44dp box − 12dp paddingBottom = 32dp for a chip that needs ~35.
    expect(style('statusRow')).not.toMatch(/paddingBottom/);
    expect(style('filterRow')).not.toMatch(/paddingBottom/);
  });

  it('the scroll boxes are tall enough for a chip', () => {
    // Explicit height is required: a horizontal ScrollView with only flexGrow:0
    // has no intrinsic height inside a flex-column parent on Android and
    // collapses below the chip. It must clear the ~35dp the chip needs.
    for (const name of ['filterScroll', 'statusScroll']) {
      const h = style(name).match(/height:\s*(\d+)/);
      expect(h).not.toBeNull();
      expect(Number(h?.[1])).toBeGreaterThanOrEqual(38);
    }
  });

  it('the status row does not reintroduce the "Any status" label', () => {
    // Both rows use "All" for the no-filter chip.
    expect(source()).not.toMatch(/Any status/i);
  });
});
