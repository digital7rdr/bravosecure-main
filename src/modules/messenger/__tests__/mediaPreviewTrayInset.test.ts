import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * B-284 — the media tray's Cancel / Send sat UNDER the navigation bar.
 *
 * `MediaPreviewTray` padded its bottom with a hardcoded `26`. That is not a
 * safe-area inset: on a 3-button nav bar it is ~22dp short (the founder's
 * screenshot shows the system icons drawn over the buttons) and it is wrong by a
 * different amount on a gesture pill, a notch phone or a tablet. **No dp constant
 * is right on every device.**
 *
 * The tray is a bottom-anchored sheet, so the app-wide keyboard rule (B-184)
 * applies verbatim: THE BOTTOM-MOST ELEMENT OF A SURFACE OWNS THE KEYBOARD
 * INSET, and it pads by `bottomPad(gap)`. `bottomPad` REPLACES the safe-area
 * inset while the IME is up rather than stacking on it — stacking is the iOS
 * "blind space" bug — which is exactly why a raw constant plus an inset cannot
 * be made correct by tuning the number.
 *
 * `MediaPreviewTray.tsx` is RN, so this is a source scan. CRLF-safe; comments
 * stripped before the absence assertions — the file's own B-284 note contains
 * both the literal `26` and the word `paddingBottom`, which would make a naive
 * scan pass vacuously.
 *
 * The app-wide contract (KeyboardAvoidingView / keyboardVerticalOffset / kbHeight
 * bans) is enforced separately by `src/hooks/__tests__/keyboardContract.test.ts`.
 * This file pins only that THIS surface adopts the rule.
 */

const TRAY = join(process.cwd(), 'src', 'modules', 'messenger', 'ui', 'MediaPreviewTray.tsx');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function source(): string {
  return stripComments(readFileSync(TRAY, 'utf8'));
}

describe('B-284 — the media tray uses the keyboard rule, not a dp constant', () => {
  it('imports the app-wide keyboard-layout hook', () => {
    expect(source()).toMatch(/useKeyboardLayout/);
  });

  it('the sheet pads its bottom with bottomPad(...)', () => {
    expect(source()).toMatch(/paddingBottom:\s*bottomPad\(/);
  });

  it('no hardcoded bottom padding survives in the StyleSheet (the regression)', () => {
    // The exact pre-fix form was `paddingBottom: 26` inside the sheet style.
    // Any bare number here is wrong on some device by construction.
    expect(source()).not.toMatch(/paddingBottom:\s*\d/);
  });

  it('does not hand-roll keyboard avoidance (B-184 ban list)', () => {
    const src = source();
    expect(src).not.toMatch(/KeyboardAvoidingView/);
    expect(src).not.toMatch(/keyboardVerticalOffset/);
    expect(src).not.toMatch(/Keyboard\.addListener/);
  });
});
