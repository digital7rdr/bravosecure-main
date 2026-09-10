/**
 * B-263 — the messenger surfaces carried four badges that never varied, and
 * hid one thing that does.
 *
 * The four removals share a shape: a banner or badge rendered unconditionally,
 * announcing a property that is ALWAYS true. "AES-256 ENCRYPTED · VERIFIED",
 * "Messages are end-to-end encrypted", a check on every 1:1 avatar, a
 * shield beside every peer's name. None of them could ever say anything else,
 * so none of them carried information — and the avatar check sat in the same
 * SE corner as the presence dot, which is the one badge there that DOES vary.
 *
 * The fifth is the opposite problem. `showMeta` was `isLastInGroup`, so a run
 * of consecutive messages from one sender collapsed to a single timestamp +
 * tick on the last of them. Delivery state is PER MESSAGE: send three in a row
 * and the first two showed no tick at all, letting the run's last status stand
 * in for messages that might be `sent`, `failed` or `undelivered`. A tick you
 * cannot see is indistinguishable from one that never arrived.
 *
 * These are RN screens the node Jest project cannot mount, so they are pinned
 * by source scan. Both repo traps apply and are handled: comments are stripped
 * before every absence assertion (prose naming a removed string is the classic
 * false result), and the files are CRLF so nothing here is `\n`-anchored.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');

function code(file: string): string {
  return readFileSync(join(SCREENS, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-263 — MessengerHomeScreen', () => {
  it('CONTROL: the scan is reading a real, populated screen', () => {
    // Without this, a renamed/moved file would make every absence assertion
    // below pass against an empty string.
    const src = code('MessengerHomeScreen.tsx');
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('RowOnlineDot');
  });

  it('the always-on "AES-256 ENCRYPTED / VERIFIED" banner is gone', () => {
    const src = code('MessengerHomeScreen.tsx');
    expect(src).not.toContain('AES-256');
    expect(src).not.toContain('VERIFIED');
  });

  it('the unconditional verified check on the avatar is gone', () => {
    const src = code('MessengerHomeScreen.tsx');
    expect(src).not.toContain('VerifiedBadge');
    // The style must go too, or the next person re-adds the badge to use it.
    expect(src).not.toContain('verifiedBadge');
  });

  it('but LIVE PRESENCE on the avatar survives — that is the badge that varies', () => {
    // The point of the change, and the assertion that stops "remove the
    // avatar badges" from being read as "remove all of them".
    const src = code('MessengerHomeScreen.tsx');
    expect(src).toContain('<RowOnlineDot peerId={peerId} />');
  });
});

describe('B-263 — ChatScreen', () => {
  it('CONTROL: the scan is reading a real, populated screen', () => {
    const src = code('ChatScreen.tsx');
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('showMeta');
  });

  it('the always-on end-to-end-encrypted banner is gone', () => {
    const src = code('ChatScreen.tsx');
    // NARROWED in B-281, and the reason is a lesson worth keeping.
    //
    // This used to be `not.toMatch(/end-to-end encrypted/i)` — any mention of the
    // phrase, anywhere. It passed for the wrong reason: `code()` pairs the first
    // `/*` with the NEXT `*/`, so a run of JSX comments could swallow real code
    // between them, and the empty-state copy ("Send a message — it will be
    // end-to-end encrypted…") was being deleted before the assertion ever saw it.
    // Editing unrelated comments shifted the pairing, the line reappeared, and a
    // green test went red with the banner still correctly absent.
    //
    // So pin the BANNER, not the phrase: the removed element was a persistent
    // strip in the message area, i.e. a styled banner node. Empty-state and
    // attach-sheet copy may say "end-to-end encrypted" all they like.
    expect(src).not.toMatch(/styles\.e2eBanner/);
    expect(src).not.toMatch(/Messages are end-to-end encrypted/i);
  });

  it('the unconditional shield beside the peer name is gone', () => {
    const src = code('ChatScreen.tsx');
    expect(src).not.toContain('shield-check');
  });

  it('LOOPBACK MODE survives, and only renders when it actually fires', () => {
    // Loopback is a genuinely exceptional state, so it is NOT chrome — but its
    // container must be conditional or its own padding leaves exactly the dead
    // band the removed banner used to occupy.
    const src = code('ChatScreen.tsx');
    expect(src).toContain('LOOPBACK MODE');
    expect(src).toMatch(/\{loopbackActive && \(\s*<View style=\{styles\.bannersStack\}>/);
  });

  it('EVERY bubble renders its own timestamp + tick, not just the run\'s last', () => {
    // The regression this pins: reverting to `isLastInGroup` hides the
    // delivery state of every message but the last in a burst.
    const src = code('ChatScreen.tsx');
    const line = src.split(/\r?\n/).find(l => l.includes('const showMeta'));
    expect(line).toBeDefined();
    expect(line).toContain('const showMeta = true');
    expect(line).not.toContain('isLastInGroup');
  });

  it('isLastInGroup still drives bubble GEOMETRY — only the meta strip changed', () => {
    // Guards the over-correction: deleting the flag outright would square off
    // the corners of every grouped bubble and flatten the run styling.
    //
    // The anchor MOVED in B-279 and the invariant did not. This used to assert
    // `bubbleRadii(sent, isFirstInGroup, isLastInGroup)`, a helper that
    // re-derived the corner set so a `<LinearGradient>` child could be clipped
    // to the bubble silhouette. That child is gone (the gradient is now the
    // bubble's own background, which inherits its real radii), and so is the
    // helper — it was a second copy of the rule that could drift out of step
    // with the StyleSheet variants. The run-grouping geometry now has exactly
    // one home, which is what these four conditionals are.
    const src = code('ChatScreen.tsx');
    expect(src).toMatch(/sent && !isLastInGroup\s+&& styles\.sentBubbleRunMid/);
    expect(src).toMatch(/sent && !isFirstInGroup && styles\.sentBubbleRunTail/);
    expect(src).toMatch(/!sent && !isLastInGroup\s+&& styles\.recvBubbleRunMid/);
    expect(src).toMatch(/!sent && !isFirstInGroup && styles\.recvBubbleRunTail/);
    expect(src).toContain('sentBubbleRunMid');
  });
});
