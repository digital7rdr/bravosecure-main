/**
 * UI corrections 2026-08-15 — item 12: "The buttons at the top right of the
 * screen is cut off."
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A RENDER TEST.
 *
 * The defect is an OVERFLOW: `headerTop` is `justifyContent: 'space-between'`
 * with two children, and neither could shrink, so the right-hand action pills
 * were pushed past the usable width. React Native's test renderer performs no
 * layout — there is no Yoga pass, no measured width, and therefore nothing that
 * can observe a clip. A render test could only assert the buttons EXIST, which
 * they always did; that is exactly why this shipped.
 *
 * So the properties that prevent the overflow are pinned directly. Each one is
 * load-bearing and the reason is recorded, because the tempting "cleanup" is to
 * delete them as redundant:
 *
 *   - `flex: 1` on headerLeft      — lets the left side yield at all.
 *   - `minWidth: 0` on headerLeft  — a flex child defaults to `min-width: auto`,
 *                                    which floors it at its CONTENT size. Without
 *                                    this the `flex: 1` is inert and the row
 *                                    still overflows. This is the pair that
 *                                    actually fixes it.
 *   - `numberOfLines={1}` on the title — a JSX PROP, not a style, so it is
 *                                    scanned separately. It converts the shrink
 *                                    into an ellipsis; without it the title wraps
 *                                    and the header grows taller instead.
 *
 * ⚠️ Deliberately NOT pinned: `flexShrink: 0` on `headerActions`/`iconPill`.
 * Yoga already defaults flexShrink to 0, so asserting it would pin a PLACEBO —
 * the assertion would pass whether or not the property existed, and would read
 * as coverage. (The one place it IS written, `tierChip`, is documented in the
 * source as intent for a future sweep, not as the fix.)
 *
 * ⚠️ CRLF: this file is scanned line-based, never with a `\n`-anchored regex,
 * because a `\n` anchor matches nothing on a CRLF file and the test would pass
 * VACUOUSLY (CLAUDE.md, twice-burned).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');

/** Raw source, CRLF normalised. Comments are NOT stripped for the prop scan —
 *  see the guard below, which proves we matched real code, not prose. */
function src(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}

/** Comment-stripped, for assertions that must not be satisfied by the docblocks
 *  above them — every one of which quotes the very tokens under test. */
function code(): string {
  return src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

/** The single-line style entry for `name`, from the StyleSheet. */
function styleLine(name: string): string {
  const line = code().split('\n').find(l => l.trim().startsWith(`${name}: {`));
  // A miss means the style was renamed; failing here beats every assertion
  // below passing vacuously against an empty string.
  expect(`${name}:${line !== undefined}`).toBe(`${name}:true`);
  return line as string;
}

describe('item 12 — the messenger header cannot clip its right-hand actions', () => {
  it('the scan is reading the real screen (guards a vacuous pass)', () => {
    // If the file is ever moved or emptied, readFileSync throws — but a
    // truncated file would let the `not.toMatch` assertions pass on nothing.
    expect(src().length).toBeGreaterThan(20_000);
    expect(code()).toContain('headerTop:');
  });

  it('headerLeft can SHRINK — flex:1 AND minWidth:0, the pair that fixes it', () => {
    const line = styleLine('headerLeft');
    expect(line).toMatch(/flex:\s*1/);
    // The one that is easy to drop as noise and is the actual fix.
    expect(line).toMatch(/minWidth:\s*0/);
  });

  it('the title COLUMN inside it can shrink too', () => {
    // headerLeft yielding is not enough: the column holding the title row and
    // the subtitle is itself a flex child of headerLeft and floors at content
    // size the same way.
    const line = styleLine('headerTitleCol');
    expect(line).toMatch(/flex:\s*1/);
    expect(line).toMatch(/minWidth:\s*0/);
  });

  it('the title itself shrinks and ellipsises rather than wrapping', () => {
    expect(styleLine('headerTitle')).toMatch(/flexShrink:\s*1/);
    // The JSX PROPS — invisible to a style assertion, so scanned on their own.
    // Anchored to the MESSENGER title specifically, not "numberOfLines appears
    // somewhere in a 1600-line file". Re-pointed (not relaxed) 2026-08-22: the
    // element is now multi-line because it also SHRINKS TO FIT.
    const at = code().indexOf('style={styles.headerTitle}');
    expect(at).toBeGreaterThan(-1);
    const el = code().slice(at, code().indexOf('MESSENGER', at) + 9);
    expect(el).toMatch(/numberOfLines=\{1\}/);
    expect(el).toMatch(/MESSENGER$/);
  });

  it('…and shrinks the TYPE before it ellipsises — "M…" is not an acceptable title', () => {
    /**
     * The GOAL is unchanged from 2026-08-22 ("the entire word MESSENGER is
     * gone"): the wordmark must get smaller rather than collapse to one letter.
     * The MECHANISM is reversed.
     *
     * B-661 — this used to require `adjustsFontSizeToFit` + `minimumFontScale`.
     * The founder then reported "MESSENGER" rendering TINY on one phone and
     * correctly on another, on the SAME build, and the research says why:
     *   • `minimumFontScale` is IGNORED under the New Architecture, on both
     *     platforms (facebook/react-native#50248, still open) — so the floor
     *     this test was pinning never actually applied;
     *   • `adjustsFontSizeToFit` on Android/Fabric collapses text toward the
     *     minimum (#32258) or does not resize at all (#43104).
     * `newArchEnabled=true` here. So the pin was enforcing a prop pair that
     * cannot deliver what the comment claims.
     *
     * Replaced by a deterministic width band computed from the measured window:
     * same intent (smaller, never "M…"), but the same result on every device.
     */
    const text = code();
    expect(text).toMatch(/const headerTitleSize = winW >= 430/);
    const at = text.indexOf('style={[styles.headerTitle, {fontSize: headerTitleSize}]}');
    expect(at).toBeGreaterThan(-1);
    const el = text.slice(at, text.indexOf('MESSENGER', at) + 9);
    expect(el).toMatch(/numberOfLines=\{1\}/);
    // The app-wide cap in utils/textDefaults.ts is inert (Text.defaultProps,
    // which React 19 resolves for classes only), so each header caps itself.
    expect(el).toMatch(/maxFontSizeMultiplier=\{1\.2\}/);
    // The unreliable pair must not come back on this title.
    expect(el).not.toMatch(/adjustsFontSizeToFit/);
    expect(el).not.toMatch(/minimumFontScale/);
  });

  it('B-661/2026-08-26 — the channel-count subtitle is GONE and the controls are one size', () => {
    /**
     * B-661 made "18 SECURE / CHANNELS" stay on one line; the client then
     * removed the line outright ("remove channels", annotated screenshot,
     * 2026-08-26) because it still crowded the header into "MES…" on narrower
     * devices. The pin flips to absence: the header renders no channel count.
     */
    const text = code();
    expect(text).not.toMatch(/SECURE CHANNEL/);
    const styles = text.slice(text.indexOf('headerMark: {'));
    expect(styles).toMatch(/headerMark: \{\s*width: 34, height: 34/);
    expect(styles).toMatch(/iconPill: \{\s*width: 34, height: 34/);
  });

  it('the decorative mark yields to the back chevron, which is the crowded case', () => {
    // The chevron only appears when Messenger was entered from Secure Services,
    // and that is precisely when the row ran out of width. The mark is a message
    // glyph beside the word MESSENGER — redundant with the avatar next to it —
    // so it is the cheapest thing to drop, and dropping it buys the title 42dp.
    expect(code()).toMatch(/\{!inSecureProduct && \(\s*<View style=\{styles\.headerMark\}/);
  });

  it('the tier chip is GONE — the title gets the whole row (client 2026-08-26)', () => {
    // "remove Enterprise" — the ENTERPRISE/PRO/LITE chip was the widest fixed
    // element beside the title and the last thing crowding it on 360dp phones.
    const text = code();
    expect(text).not.toMatch(/tierChip/);
    expect(text).not.toMatch(/msgrTier/);
  });

  it('the header carries the horizontal safe-area inset itself', () => {
    // The root View applies only insets.top, so in landscape on a notched device
    // the right-hand pills sat under the cutout. The header is the only row with
    // controls flush right, so it pads itself rather than insetting the list.
    const c = code();
    expect(c).toMatch(/paddingLeft:\s*16\s*\+\s*insets\.left/);
    expect(c).toMatch(/paddingRight:\s*16\s*\+\s*insets\.right/);
  });

  it('CHATSCREEN carries the inset too — the fix was ported, not left behind', () => {
    /**
     * ⚠️ THE HALF THAT WAS MISSED, found by an audit on 2026-08-20.
     *
     * Item 12 was fixed on MessengerHomeScreen and NOT on ChatScreen, which has
     * the identical shape: a root that applies only `insets.top`, a header with
     * a flat `paddingHorizontal`, and voice/video buttons as the last thing in
     * the row. So the founder's exact complaint — "the buttons at the top right
     * of the screen is cut off" — was still live on the other Messenger screen
     * with top-right actions.
     *
     * Why nobody noticed: portrait phones have NO horizontal safe-area inset,
     * so `16 + 0` and `16` render identically. It only bites in landscape or on
     * a device with a side cutout, which is also why a render test cannot see
     * it and this is a source scan.
     *
     * Scanned COMMENT-STRIPPED: the docblock now sitting above that JSX quotes
     * `insets.left` by name, and matching the prose instead of the code is this
     * repo's most common false pass.
     */
    const chat = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    // Guard against a vacuous pass: the screen must still HAVE the actions.
    expect(chat).toMatch(/styles\.headerActions/);
    // B-661 re-point: the literal 18 became `headerGutter` when the gutter was
    // made window-responsive. The invariant is the SAME - a base gutter PLUS
    // the inset, never the inset alone (which would lose the design gutter).
    expect(chat).toMatch(/paddingLeft: headerGutter \+ insets\.left/);
    expect(chat).toMatch(/paddingRight: headerGutter \+ insets\.right/);
    // ...and the base still opens at the design 18dp on a normal phone.
    expect(chat).toMatch(/const headerGutter = winW >= 400 \? 18 :/);
  });

  it('BOTH header branches share these styles — one fix, not two', () => {
    /**
     * The batch-selection toolbar replaces the app bar while chats are selected
     * and is the NARROWER case (three action pills). It must not have grown its
     * own copy of the layout, or the fix covers only the branch someone looked
     * at. Pinned by counting the shared style references.
     */
    const c = code();
    expect((c.match(/styles\.headerTop/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((c.match(/styles\.headerLeft/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((c.match(/styles\.headerActions/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * B-661 — the CHAT header (founder, 2026-08-25: "the messenger text is so small
 * for one device and on another device it's correctly sized… the text are
 * overlapping… make sure the text is a good size and the icon can be smaller to
 * do that, but all over same size").
 *
 * Same reason this is a source scan: no Yoga pass in the test renderer, so a
 * clip or an overflow is unobservable. What IS observable is whether the
 * properties that prevent them are present at the decision site.
 */
describe('B-661 — chat header fits, and its pills are one size', () => {
  const CHAT_SRC = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8',
  ).replace(/\r\n/g, '\n');
  const chat = CHAT_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');

  it('guards a vacuous pass — the scan is reading the real screen', () => {
    expect(chat).toMatch(/styles\.contactInfo/);
    expect(chat).toMatch(/styles\.headerActions/);
  });

  it('the name yields SIZE off the window before it yields characters', () => {
    /**
     * The header row is a fixed budget: back pill + avatar + two call pills +
     * gutters are all constant, so the name gets the remainder. A constant 16pt
     * display face fitted a Pixel 6a and clipped on a Pixel 7 for that reason.
     * Stepped breakpoints, read off the live window — reactive on fold/rotate.
     */
    expect(chat).toMatch(/const \{width: winW, isLargeScreen, contentMaxWidth\} = useContentWidth\(720\)/);
    expect(chat).toMatch(/const chatNameSize = winW >= 430 \? 16 : winW >= 400 \? 15 : winW >= 360 \? 14 : 13;/);
    expect(chat).toMatch(/style=\{\[styles\.contactName, \{fontSize: chatNameSize\}\]\}/);
    // The shrink still has to become an ellipsis, or the header grows taller.
    expect(chat).toMatch(/numberOfLines=\{1\}[\s\S]{0,120}\{headerDisplayName\}/);
  });

  it('NOT adjustsFontSizeToFit — its floor is ignored under the New Architecture', () => {
    /**
     * `minimumFontScale` is not honoured on either platform under Fabric
     * (facebook/react-native#50248, open), so `adjustsFontSizeToFit` shrinks
     * without a floor and the name can collapse to unreadable. This app is
     * `newArchEnabled=true`. Deterministic breakpoints instead.
     */
    expect(chat).not.toMatch(/adjustsFontSizeToFit/);
    expect(chat).not.toMatch(/minimumFontScale/);
  });

  it('every header pill is ONE size and ONE radius', () => {
    // Founder: "the icon can be smaller to do that but all over same size."
    // Was 36/r12 (back) and 40/r20 (call) with 18/16/17pt glyphs — three sizes
    // in one row, and the two 40s ate 88dp before the name got any.
    const back = /backBtn: \{\n\s*width: (\d+), height: (\d+), borderRadius: ([\d.]+),/.exec(chat);
    const icon = /iconBtn: \{\n\s*width: (\d+), height: (\d+), borderRadius: ([\d.]+),/.exec(chat);
    expect(back).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(back!.slice(1)).toEqual(icon!.slice(1));
    // Square, and no larger than the app's header-pill system.
    expect(Number(back![1])).toBe(Number(back![2]));
    expect(Number(back![1])).toBeLessThanOrEqual(34);
    // And every glyph in the header row is the same size.
    expect(chat).toMatch(/name="chevron-left" size=\{17\}/);
    expect(chat).toMatch(/name="phone-outline" size=\{17\}/);
    expect(chat).toMatch(/name="video-outline" size=\{17\}/);
  });

  it('the gutter steps down on a narrow window instead of clipping', () => {
    expect(chat).toMatch(/const headerGutter = winW >= 400 \? 18 : winW >= 360 \? 14 : 12;/);
    // Base gutter PLUS the safe-area inset, never the inset alone — that would
    // lose the design's gutter on a cutout device.
    expect(chat).toMatch(/paddingLeft: headerGutter \+ insets\.left, paddingRight: headerGutter \+ insets\.right/);
  });

  it('the GROUP subtitle row can shrink — that is the text that overlapped', () => {
    /**
     * `memberStackRow` ("N operators · E2E") sits where the 1:1 presence pill
     * sits. The pill has had flexShrink/minWidth since it was written; this row
     * did not, so it ran past the header actions rather than truncating. The
     * dot rail is decorative and fixed — a squashed avatar rail looks broken, a
     * truncated count does not — so the shrink is on the TEXT.
     */
    expect(chat).toMatch(/memberStackRow: \{[^}]*flexShrink: 1[^}]*minWidth: 0/);
    expect(chat).toMatch(/memberStackText: \{[^}]*flexShrink: 1/);
    expect(chat).toMatch(/style=\{styles\.memberStackText\} numberOfLines=\{1\}/);
    expect(chat).toMatch(/style=\{styles\.memberStackE2e\} numberOfLines=\{1\}/);
  });

  it('header text caps its fontScale so a 2x accessibility setting cannot re-break it', () => {
    // 1.2x, matching MessengerHome. The cap is what keeps the fixed-budget row
    // solvable at all; without it no breakpoint table can win.
    expect(chat).toMatch(/maxFontSizeMultiplier=\{1\.2\}[\s\S]{0,120}\{headerDisplayName\}/);
  });
});
