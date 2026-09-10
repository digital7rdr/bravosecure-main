import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-197 — the department composer was a chunky two-row block.
 *
 * The SEND BUTTON (44dp), not the text field (pill `minHeight: 42`), set the row
 * height, and `alignItems: 'flex-end'` pushed all growth upward — leaving the
 * dept composer ~10dp taller than 1:1 chat before any content was typed.
 *
 * Fix: controls are 38dp on a CENTRED row, with `hitSlop` keeping the touch
 * targets ≥ 44dp (DESIGN_REVIEW_LOOP §3.4 — shrinking the visual control must
 * not shrink the tap target), and composer `paddingTop` drops 10 → 6.
 *
 * `DepartmentChatScreen.tsx` imports `expo-clipboard` and `rn-emoji-keyboard`,
 * which the Jest transform cannot parse — the same constraint that forced B-244's
 * colour helpers out into `senderColors.ts`. Style objects left inside the screen
 * are therefore reachable only by a source scan.
 *
 * CRLF-safe; comments stripped before assertions.
 */

const SCREEN = join(
  process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx',
);

// LINE-ANCHORED, per `src/__tests__/sourceScanSafety.test.ts` — the screen this
// scans is on its KNOWN_HAZARDS list. A greedy block-comment strip treats the
// slash-star inside the wildcard MIME literal in getDocumentAsync as a comment
// opener and eats ~116 lines of real code before any assertion runs; absence
// assertions then pass over code that is present.
// (Written as line comments on purpose: spelling the sequence out inside a
// block comment closes the block — which is the same class of trap.)
function stripComments(src: string): string {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

function source(): string {
  return stripComments(readFileSync(SCREEN, 'utf8'));
}

/** A named StyleSheet entry's body, CODE only. */
function style(name: string): string {
  const src = source();
  const start = src.indexOf(`${name}: {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('},', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-197 — dept composer control metrics', () => {
  /**
   * PARTIALLY SUPERSEDED — client review vs2 (2026-08-09) item 11.
   *
   * B-197 optimised this composer for COMPACTNESS (parity with 1:1 chat's
   * resting height). The client asked for the opposite: "make the message-
   * writing box larger, approximately the same size and behaviour as the
   * WhatsApp message box… enough space to see a useful part of a longer
   * message while typing", with the controls not crowding the text.
   *
   * Exactly ONE of B-197's assertions is retired:
   *   · retired — pill `minHeight: 38`. Item 11 needs a taller resting box;
   *     the new floor is pinned in this file, below.
   *   · KEPT and still true — the CENTRED ROW. An earlier revision of item 11
   *     flipped it to `flex-end` on the theory that 1:1 chat does that; it does
   *     NOT. `inputWrap` (flex-end) is ChatScreen's PILL; its composer ROW is
   *     `inputBar`, which is `alignItems:'center'`. Flipping the row put the
   *     whole pill-minus-controls difference at the top and left the controls
   *     sitting below the pill's centre in the resting state. Only the PILL is
   *     flex-end here, matching `inputWrap`.
   *   · KEPT — the 38dp controls, so the SEND BUTTON never drives the row
   *     height again. The field now drives it, which is what B-197 wanted.
   */
  it('the composer row is centred, not flex-end (B-197, still true)', () => {
    const composer = style('composer');
    expect(composer).toMatch(/alignItems:\s*'center'/);
    expect(composer).not.toMatch(/alignItems:\s*'flex-end'/);
  });

  it('the FIELD drives the row height, never the send button (B-197 core)', () => {
    const pill = style('inputPill');
    const minH = Number(/minHeight:\s*(\d+)/.exec(pill)?.[1]);
    // Strictly taller than the 38dp controls — the inversion B-197 fixed.
    expect(minH).toBeGreaterThan(38);
  });

  it('composer paddingTop is 6, not the old 10', () => {
    expect(style('composer')).toMatch(/paddingTop:\s*6\b/);
  });

  it('the send button is 38dp — it no longer sets the row height', () => {
    const send = style('sendBtn');
    expect(send).toMatch(/width:\s*38\b/);
    expect(send).toMatch(/height:\s*38\b/);
    // 44 here is the regression: the button, not the field, drove the row.
    expect(send).not.toMatch(/height:\s*44\b/);
  });

  it('the announcement toggle matches at 38dp', () => {
    const toggle = style('annToggle');
    expect(toggle).toMatch(/width:\s*38\b/);
    expect(toggle).toMatch(/height:\s*38\b/);
  });

  /** Item 11 — the box is WhatsApp-sized and grows a WHOLE number of lines. */
  it('the pill grows from the bottom, so the text does not jump as it wraps', () => {
    expect(style('inputPill')).toMatch(/alignItems:\s*'flex-end'/);
  });

  it('the growth cap is derived from lineHeight, never a raw dp literal', () => {
    // A literal cap is scaled by NEITHER scaleTextStyles nor the OS font scale,
    // while lineHeight is scaled by both — so at fontScale 1.3 a literal slices
    // the last line in half, which is the very complaint item 11 answers.
    const src = source();
    expect(src).toMatch(/COMPOSER_MAX_LINES\s*=\s*\d+/);
    expect(src).toMatch(/COMPOSER_MAX_H\s*=\s*COMPOSER_MAX_LINES\s*\*\s*COMPOSER_LINE_H/);
    expect(style('input')).toMatch(/maxHeight:\s*COMPOSER_MAX_H\b/);
    // …and the pill's own cap must not sit BELOW the input's, or it silently
    // becomes the real limit and the derivation is decorative.
    expect(style('inputPill')).toMatch(/maxHeight:\s*COMPOSER_MAX_H\s*\+/);
  });

  it('the resting box is WhatsApp-sized, not the old 38dp strip', () => {
    expect(Number(/minHeight:\s*(\d+)/.exec(style('inputPill'))?.[1])).toBeGreaterThanOrEqual(44);
    expect(Number(/fontSize:\s*([\d.]+)/.exec(style('input'))?.[1])).toBeGreaterThanOrEqual(15);
  });

  it('hitSlop keeps the shrunken controls at a >=44dp touch target', () => {
    // Was `toMatch(/hitSlop/)` over the WHOLE file — satisfied by any one
    // control, which is how the 18dp emoji button sat below the minimum while
    // this test claimed all of them were covered. Count instead: attach,
    // announce toggle, emoji, send.
    const hits = source().match(/hitSlop/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(4);
  });
});
