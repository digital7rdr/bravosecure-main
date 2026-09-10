/**
 * B-280 — founder: "user can tap or put multiple emoji, right now it only takes
 * one and goes back to the chatbox, and there is no keyboard again."
 *
 * Two defects in one affordance, reproduced on device (v1.0.161):
 *
 *   1. `rn-emoji-keyboard` closes after the FIRST selection unless
 *      `allowMultipleSelections` is set — its own handler is
 *      `onEmojiSelected(emoji); !allowMultipleSelections && close();`
 *      So composing "😂🔥👍" meant opening the sheet three times.
 *   2. The sheet covers the keyboard while open, and closing it left the
 *      TextInput BLURRED. The user had to tap the field again before the IME
 *      came back — which reads as "the keyboard is gone".
 *
 * Both composer screens carry the same copy of this affordance, which is this
 * repo's recurring shape (one behaviour, N copies, and the fix lands on one).
 * ChatScreen routes focus through the `ChatComposerHandle` because its draft
 * lives inside the memoised composer (B-159); DepartmentChatScreen holds its
 * draft locally and so uses a plain TextInput ref.
 *
 * Source scan: both screens mount RN views. Both files are CRLF — nothing here
 * is `\n`-anchored, or it would match nothing and pass VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8')
    // The DocumentPicker MIME string '*/*' contains both `/*` and `*/`, which
    // throws the naive block-comment strip below out of sync and eats real code
    // after it (the CLAUDE.md "stripper eats real code" trap). Neutralise that
    // literal sequence first — it never appears in an asserted token.
    .replace(/\*\/\*/g, '   ')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const chat = strip('ChatScreen.tsx');
const dept = strip('DepartmentChatScreen.tsx');

/**
 * B-281 — the follow-on defect, and why ChatScreen and DepartmentChatScreen are
 * now asserted differently.
 *
 * Keeping the sheet open (B-280) exposed the next problem the founder reported:
 * _"when an emoji box opens the chat box is not shown, so I don't see which emoji
 * I type."_ A modal bottom sheet is anchored to the bottom of the WINDOW, so it
 * will always cover a bottom-anchored composer — no height or prop can fix that.
 *
 * ChatScreen therefore stopped using the modal entirely: the library's inline
 * `EmojiKeyboard` renders INSIDE the composer's padded column, below the input
 * bar, in the space `Keyboard.dismiss()` frees. `allowMultipleSelections` is not
 * needed there — an inline keyboard has no self-close behaviour to suppress, so
 * multi-pick is structural rather than opt-in. K4 follow-up: DepartmentChatScreen
 * has now ALSO been ported off the modal to the inline keyboard (it was the last
 * screen still window-anchoring the sheet over its own composer).
 */
describe('B-281 — ChatScreen: the composer stays visible', () => {
  it('uses the INLINE keyboard, not the modal sheet', () => {
    expect(chat).toContain('<EmojiKeyboard');
    expect(chat).not.toContain('<EmojiPicker');
    expect(chat).toMatch(/import \{EmojiKeyboard\} from 'rn-emoji-keyboard'/);
  });

  it('the panel sits BELOW the input bar, inside the padded column', () => {
    // Placement IS the fix. Above the input bar it would shove the composer
    // off-screen; outside the padded column it would need a second bottom inset,
    // which the B-184 keyboard contract forbids.
    const barAt = chat.indexOf('styles.inputBar');
    const panelAt = chat.indexOf('styles.emojiPanel');
    expect(barAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(barAt);
  });

  it('opening the panel dismisses the system keyboard', () => {
    // Both up at once means bottomPad lifts the composer by the IME inset AND
    // the panel sits below it — the input leaves the screen.
    expect(chat).toContain('Keyboard.dismiss()');
  });

  it('the emoji button TOGGLES rather than only opening', () => {
    expect(chat).toMatch(/setEmojiOpen\(prev => \{/);
    expect(chat).toMatch(/if \(prev\) \{ composerRef\.current\?\.focusInput\(\); return false; \}/);
  });

  it('tapping the text field swaps back to the system keyboard', () => {
    expect(chat).toMatch(/onFocus=\{\(\) => \{ if \(emojiOpen\) \{ onCloseEmoji\?\.\(\); \} \}\}/);
  });

  it('the panel height is a FRACTION of the window, never a dp constant', () => {
    // B-277's constraint, restated by the founder: "many users will use other
    // phones so it should be dynamic." A clamp is fine; a bare height is not.
    expect(chat).toMatch(/windowHeight \* 0\.38/);
    expect(chat).toMatch(/useWindowDimensions\(\)/);
  });

  it('one append path feeds both the panel and the imperative handle', () => {
    // Two copies would be two chances to forget the synchronous-ref rule that
    // stops a fast keystroke racing an emoji insert.
    expect(chat).toContain('insert: appendToDraft');
    expect(chat).toContain('appendToDraft(e.emoji)');
  });
});

describe('B-281 — DepartmentChatScreen: the composer stays visible (ported off the modal)', () => {
  it('uses the INLINE keyboard, not the modal sheet', () => {
    // K4 follow-up: the dept composer was the last screen still on the window-
    // anchored modal that covered the composer. Now inline, same as ChatScreen.
    expect(dept).toContain('<EmojiKeyboard');
    expect(dept).not.toContain('<EmojiPicker');
    expect(dept).toMatch(/import \{EmojiKeyboard\} from 'rn-emoji-keyboard'/);
  });

  it('dismisses the IME when opening the panel (so the panel takes its place)', () => {
    // Load-bearing: without Keyboard.dismiss() the composer lifts by the IME AND
    // the panel pushes the input off-screen. Pin the dismiss inside the toggle.
    expect(dept).toMatch(/Keyboard\.dismiss\(\)/);
    expect(dept).toContain('const toggleEmoji');
  });

  it('drops the search bar (it forces a full-dataset flatten) — inline has no self-close to suppress', () => {
    expect(dept).not.toMatch(/enableSearchBar/);
    expect(dept).not.toMatch(/allowMultipleSelections/);
  });

  it('hands focus back on close so the keyboard returns', () => {
    expect(dept).toContain('const closeEmoji');
    const m = /const closeEmoji = useCallback\(\(\) => \{([\s\S]{0,180}?)\}, \[\]\)/.exec(dept);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/setEmojiOpen\(false\)/);
    expect(m![1]).toMatch(/\.focus\(\)/);
  });

  it('uses the SAME panel-height formula as ChatScreen (no drifted copy)', () => {
    // Duplicate-copy class: one behaviour, two screens. Pin the exact formula in
    // both so a change to one is a visible diff, not a silent divergence.
    const formula = 'Math.max(240, Math.min(360, Math.round(windowHeight * 0.38)))';
    expect(chat).toContain(formula);
    expect(dept).toContain(formula);
  });
});

describe('B-280 — the focus route each screen uses', () => {
  it('ChatScreen exposes focusInput on the composer handle', () => {
    // The draft lives inside the memoised <ChatComposer> (B-159), so the screen
    // cannot reach the TextInput directly — it must go through the handle. Still
    // true after B-281: the screen owns the open/closed flag, the composer owns
    // the field.
    expect(chat).toMatch(/focusInput:\s*\(\)\s*=>\s*void/);
    expect(chat).toMatch(/focusInput:\s*\(\)\s*=>\s*\{\s*inputRef\.current\?\.focus\(\);/);
    expect(chat).toContain('composerRef.current?.focusInput()');
  });

  it('DepartmentChatScreen focuses its own TextInput ref', () => {
    expect(dept).toContain('ref={draftInputRef}');
    expect(dept).toContain('draftInputRef.current?.focus()');
  });

  it('neither screen reaches for the banned keyboard APIs to do it', () => {
    // CLAUDE.md: the keyboard inset rule is `useKeyboardLayout` and nothing
    // else. Raising the IME by focusing an input is fine; hand-rolling a
    // listener or a KeyboardAvoidingView to "make room" is not.
    for (const s of [chat, dept]) {
      expect(s).not.toContain('KeyboardAvoidingView');
      expect(s).not.toContain('keyboardVerticalOffset');
    }
  });
});
