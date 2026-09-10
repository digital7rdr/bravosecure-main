/**
 * B-707 — "I still cannot add message to image before sending, just like
 * WhatsApp we can attach image and can attach msg also." (founder, 2026-08-30)
 *
 * Nothing was broken in the crypto or the wire: `sendMedia` has always accepted
 * `opts.caption`, `productionRuntime` has always put it in the bubble's
 * `content` and shipped it as the message body, and the bubble has always
 * rendered it under the attachment. The gap was entirely in the UI:
 *
 *   1. `MediaPreviewTray` had no caption field ("Captions are intentionally out
 *      of scope" — the header comment this fix replaces), and
 *   2. a SINGLE pick never reached the tray at all. `pickImage` fired it
 *      straight down the media queue, so the one case the founder hits every
 *      day had no surface to type on.
 *
 * Both screens must keep BOTH halves, so this is a source scan: neither screen
 * can be mounted by the node project (they pull op-sqlite / WebRTC / callkeep),
 * and the pure half is pinned separately by `pickedAssets.test.ts`.
 *
 * House rules obeyed (CLAUDE.md): comments are STRIPPED before every absence
 * assertion — each rule below is also written in prose beside the code it
 * guards, and matching the prose would pass vacuously — and the scan is
 * newline-agnostic.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const TRAY  = join('src', 'modules', 'messenger', 'ui', 'MediaPreviewTray.tsx');
const CHAT  = join('src', 'screens', 'messenger', 'ChatScreen.tsx');
const DEPT  = join('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');
/** Both chat surfaces carry the identical picker → tray → queue → sendMedia chain. */
const SCREENS = [CHAT, DEPT];

/** Line-based strip — the house block-comment regex eats code holding `/*`. */
function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('the scan reads real code', () => {
  it.each([TRAY, ...SCREENS])('%s is non-trivial and comment-stripped', rel => {
    const src = codeOnly(rel);
    expect(src.length).toBeGreaterThan(1_000);
    expect(src).not.toContain('\r');
  });
});

describe('B-707 — the pre-send tray owns the caption', () => {
  it('renders a TextInput whose value is the caption state', () => {
    const src = codeOnly(TRAY);
    expect(src).toMatch(/import[\s\S]{0,200}TextInput[\s\S]{0,80}from 'react-native'/);
    expect(src).toMatch(/value=\{caption\}/);
    expect(src).toMatch(/onChangeText=\{setCaption\}/);
  });

  it('hands the typed caption to onSend — not a bare onSend', () => {
    const src = codeOnly(TRAY);
    expect(src).toMatch(/onPress=\{\(\) => onSend\(caption\)\}/);
    // The regression shape: the old tray passed the handler through untouched,
    // so a caption typed here would never leave the component.
    expect(src).not.toMatch(/onPress=\{onSend\}/);
  });

  it('clears the field when the tray closes', () => {
    // The host renders this component unconditionally and gates on
    // `assets.length`, so it is never unmounted between picks. Without the
    // reset the NEXT photo silently carries the LAST photo's text.
    const src = codeOnly(TRAY);
    expect(src).toMatch(/if \(!visible\) \{setCaption\(''\);\}/);
  });

  it('does not autofocus the caption — the thumbnails must stay visible', () => {
    const src = codeOnly(TRAY);
    expect(src).not.toMatch(/autoFocus/);
  });

  it('still owns its keyboard inset through the app-wide rule (B-284 stands)', () => {
    // Adding a TextInput to a bottom sheet is exactly the moment someone
    // reaches for a hand-rolled lift. `mediaPreviewTrayInset.test.ts` pins the
    // padding; this pins that the field did not bring a second mechanism.
    const src = codeOnly(TRAY);
    expect(src).toMatch(/paddingBottom:\s*bottomPad\(/);
    expect(src).not.toMatch(/KeyboardAvoidingView|keyboardVerticalOffset|Keyboard\.addListener/);
  });
});

describe('B-707 — every pick reaches the tray, on BOTH chat surfaces', () => {
  it.each(SCREENS)('%s: no single-pick fast path around the tray', rel => {
    const src = codeOnly(rel);
    // THE regression. Both screens shipped this line; it is why a one-photo
    // send had nowhere to type. Any equivalent early-out re-opens B-707.
    expect(src).not.toMatch(/assets\.length === 1/);
    expect(src).toMatch(/setPendingAssets\(assets\)/);
  });

  it.each(SCREENS)('%s: a camera shot is reviewed too, not sent on the spot', rel => {
    const src = codeOnly(rel);
    const at = src.indexOf('launchCamera(');
    expect(at).toBeGreaterThan(-1);
    // Anchor INSIDE the capture handler: asserting the token merely EXISTS in
    // the file would pass on the library picker's own call.
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/setPendingAssets\(\[\{/);
    expect(block).not.toMatch(/enqueueMediaAssets\(\[\{/);
  });
});

describe('B-707 — the caption survives the queue and reaches sendMedia', () => {
  it.each(SCREENS)('%s: the tray stamps the batch through withBatchCaption', rel => {
    const src = codeOnly(rel);
    expect(src).toMatch(/withBatchCaption/);
    // Stamped BEFORE the state clear, or the tray's own reset races the send.
    const at = src.indexOf('withBatchCaption(pendingAssets');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 300);
    expect(block.indexOf('setPendingAssets([])')).toBeGreaterThan(0);
  });

  it.each(SCREENS)('%s: the serial queue forwards the item\'s own caption', rel => {
    const src = codeOnly(rel);
    // The caption rides the QUEUE ITEM, never a screen-level ref: `sendMedia`
    // turns it into the message body, so a leaked one would publish text the
    // user wrote for a different photo (the B-450 batch-ref hazard).
    expect(src).toMatch(/sendPickedMediaRef\.current\([^)]*next\.caption\)/);
  });

  it.each(SCREENS)('%s: sendMedia is INVOKED with caption in its options', rel => {
    const src = codeOnly(rel);
    // Anchor on the INVOCATION, never on the identifier: `sendMedia` appears
    // first in a `typeof rt.sendMedia !== 'function'` readiness guard, and
    // `caption` appears in the enclosing function's own parameter list — a
    // parameter that is accepted and never forwarded is precisely the bug.
    const call = /await rt\.sendMedia!?\(/.exec(src);
    expect(call).not.toBeNull();
    const opts = src.slice(call!.index, call!.index + 900);
    // The options object opens after the media literal; the caption must be in
    // it as a shorthand property — `[,{]…[,}]` so a mere mention cannot pass.
    expect(opts).toMatch(/[,{]\s*caption\s*[,}]/);
  });
});
