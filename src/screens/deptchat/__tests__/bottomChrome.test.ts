/**
 * Static source-scan regression for B-185 (and the B-156 class it belongs to) —
 * dead space between a screen's bottom action and the ObsidianTabBar.
 *
 * These deptchat screens cannot be imported by a node test (navigation,
 * safe-area, expo-linear-gradient, the API layer), so the layout contract is
 * pinned by reading the source — the same technique as
 * rosterSuspensionInvariants.test.ts and messageTopologyInvariants.test.ts.
 *
 * Two distinct defects live here:
 *
 *   B-156  a fixed-bottom footer that adds `insets.bottom` while the
 *          ObsidianTabBar below it ALREADY reserves the safe area — the safe
 *          area is counted twice and opens a dead band.
 *   B-185  ChannelEditorScreen's primary action sits inside a ScrollView with
 *          no flexGrow, so on the short "New Channel" form the button floated
 *          mid-screen with ~200dp of void between it and the tab bar.
 *
 * If one of these fails: do NOT delete the assertion. Restore the guarantee, or
 * change the rule deliberately and update sqa.md B-185.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');
const EDITOR = join(DIR, 'ChannelEditorScreen.tsx');
const MANAGE = join(DIR, 'ManageChannelsScreen.tsx');

/** These files are CRLF — normalise so `\n`-anchored patterns cannot match
 *  nothing and pass vacuously. */
function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Strip comments before any absence/ordering assertion — the doc comments in
 *  these very files quote the values under test. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function region(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-185 — deptchat bottom chrome (static source scan)', () => {
  describe('ChannelEditorScreen', () => {
    it('C1: the scroll content grows to fill the viewport', () => {
      // Without flexGrow the content container is content-height, so the
      // spacer in C2 has no free space to absorb and the button stays put.
      const scroll = region(stripComments(read(EDITOR)), '<ScrollView', 'keyboardShouldPersistTaps');
      expect(scroll).toMatch(/flexGrow: 1/);
    });

    it('C2: a growable spacer pushes the action block to the bottom', () => {
      // It must be growable AND have a minHeight: growable alone would collapse
      // to zero when the form overflows (editing, or fontScale >= 1.3) and glue
      // the button to the last radio row.
      const src = stripComments(read(EDITOR));
      const spacer = /<View style=\{\{flexGrow: 1, minHeight: (\d+)\}\} \/>\s*\n\s*<PrimaryButton/.exec(src);
      expect(spacer).not.toBeNull();
      expect(Number(spacer![1])).toBeGreaterThan(0);
    });

    it('C3: the safe area is not double-counted inside the Departmental shell', () => {
      // The ObsidianTabBar below already reserves insets.bottom. Adding it again
      // here is the B-156 double-count.
      const src = stripComments(read(EDITOR));
      expect(src).toMatch(/useInDepartmentalShell/);
      expect(src).toMatch(/inDepartmentalShell \? 0 : insets\.bottom/);
      // …and the old unconditional reservation is gone.
      expect(src).not.toMatch(/paddingBottom: insets\.bottom \+ 40/);
    });
  });

  describe('ManageChannelsScreen', () => {
    it('C4: the in-shell footer clears the tab bar by a hair, not a band', () => {
      // The tab bar contributes its own 14dp top pad + hairline + 14dp, so a
      // further 14 here put two visible hairlines ~29dp apart and read as a
      // dead band under the "New channel" button.
      const src = stripComments(read(MANAGE));
      const pad = /paddingBottom: inDepartmentalShell \? (\d+) :/.exec(src);
      expect(pad).not.toBeNull();
      expect(Number(pad![1])).toBeLessThanOrEqual(8);
    });

    it('C5: the standalone path still reserves the real safe area', () => {
      // Reachable from MessengerHome with no tab bar under it — dropping
      // insets.bottom there would put the button under the gesture pill.
      expect(stripComments(read(MANAGE))).toMatch(/: insets\.bottom \+ \d+\}/);
    });
  });
});
