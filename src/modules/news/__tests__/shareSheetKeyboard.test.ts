/**
 * Share sheet keyboard pin (founder report, 2026-08-26).
 *
 * Reported: "When I want to type something to search, it covers the search
 * bar, then I cannot read what I am typing."
 *
 * `ShareNewsSheet` is a bottom-anchored sheet inside a `Modal`, and the search
 * field lives near the foot of the `ForwardList` it renders. Nothing in that
 * tree reacted to the IME, so the keyboard opened straight over the field.
 *
 * The app-wide rule (CLAUDE.md § "Keyboard / focused input") is that a
 * container lifting a whole column consumes `overlap` from `useKeyboardLayout`
 * — never a hand-rolled listener, never `KeyboardAvoidingView`. The repo-wide
 * ban is already enforced by `keyboardContract.test.ts`; what that scan cannot
 * see is a surface that simply does NOTHING, which is exactly the bug here.
 * So this pins the positive: the sheet reads the hook and applies it.
 *
 * Source scan rather than a render test: the sheet pulls in `ForwardList` from
 * ChatScreen and the messenger runtime, which the app project cannot mount
 * cheaply. Anchored on the decision SITE, not merely "the token appears
 * somewhere in the file".
 */
import fs from 'fs';
import path from 'path';

const SHEET = path.resolve(__dirname, '..', 'ShareNewsSheet.tsx');

/** Strip comments — prose naming a banned token is the classic false result. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('ShareNewsSheet — the keyboard must not cover the search field', () => {
  const src = code(SHEET);

  it('reads the app-wide keyboard rule', () => {
    expect(src).toMatch(/useKeyboardLayout\s*\}?\s*from\s*'@hooks\/useKeyboardLayout'/);
    expect(src).toMatch(/const\s*\{\s*overlap\s*\}\s*=\s*useKeyboardLayout\(\)/);
  });

  it('APPLIES the overlap to the sheet, not just destructures it', () => {
    // The failure mode this pins is a sheet that reads `overlap` and then never
    // uses it — which renders exactly like the bug.
    expect(src).toMatch(/style=\{\[\s*s\.sheet[\s\S]{0,80}?overlap[\s\S]{0,60}?\]\}/);
  });

  it('does not hand-roll keyboard avoidance', () => {
    // Same bans as keyboardContract, asserted at this surface so a local
    // "quick fix" cannot reintroduce them here.
    expect(src).not.toMatch(/KeyboardAvoidingView/);
    expect(src).not.toMatch(/keyboardVerticalOffset/);
    expect(src).not.toMatch(/Keyboard\.addListener/);
  });
});
