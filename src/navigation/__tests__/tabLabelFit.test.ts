/**
 * B-680 (FS-04/FS-37) — every bottom tab bar renders its label through
 * FitLine, never a raw single-line <Text>.
 *
 * ObsidianTabBar solved "my phone is fine, that phone cuts" with FitLine
 * (deterministic shrink-to-fit; see its docblock), but MainNavigator's
 * CustomTabBar — which renders the SAME four flow-mode items — kept a raw
 * `numberOfLines={1}` Text, so "MESSENGER" truncated at fontScale ≈1.4 on a
 * 360dp phone while the sibling bar shrank gracefully. MessengerTabBar had
 * the same raw form plus a harder failure: its labels wrapping made the bar
 * taller than the exported MSG_TAB_HEIGHT=60 that four layout consumers
 * treat as truth.
 *
 * Source scan (these files mount RN navigation and cannot be imported here).
 * CRLF files — no \n anchors.
 */
import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
}

/** Strip / * ... * / and // comments so prose can never satisfy an assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

describe.each([
  ['navigation/MainNavigator.tsx', 's.label'],
  ['navigation/ObsidianTabBar.tsx', 's.label'],
  ['screens/messenger/MessengerTabBar.tsx', 'msgTabStyles.label'],
])('B-680 tab labels — %s', (rel, styleRef) => {
  const src = stripComments(read(rel));

  it('imports FitLine and renders the tab label through it', () => {
    expect(src).toMatch(/import FitLine from '@components\/ui\/FitLine'/);
    const fitAt = src.indexOf('<FitLine');
    expect(fitAt).toBeGreaterThan(-1);
    const el = src.slice(fitAt, src.indexOf('/>', fitAt));
    expect(el).toContain(styleRef);
    expect(el).toMatch(/floorScale=\{0\.7/);
  });

  it('no raw <Text> renders the label style anymore', () => {
    // The bug shape: <Text style={[s.label ...]}>. FitLine owns that style now.
    expect(src).not.toMatch(new RegExp(`<Text[^>]*style=\\{\\[?${styleRef.replace('.', '\\.')}`));
  });
});
