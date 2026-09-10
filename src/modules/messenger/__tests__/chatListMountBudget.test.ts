/**
 * B-279 — "the app still feels laggy / response lazy on the messenger module."
 *
 * The cause was MEASURED with `dumpsys gfxinfo` on a Redmi Note 11 (1080x2400,
 * density 440) before any code changed, over a scripted, repeatable interaction
 * so the numbers are comparable run to run:
 *
 *   scroll a chat   7.2% janky   99th 20ms   Slow UI thread  7/516   GPU 7ms
 *   type a message 29.9% janky   99th 36ms   Slow UI thread 12/67    GPU 3ms
 *   open a chat    20.5% janky   99th 61ms   Slow UI thread 64/419   GPU 7ms
 *
 * The GPU never came close to the 16.7ms budget. Every jank bucket that DID
 * fire was "Slow UI thread" — the UI thread MOUNTING views, not drawing them.
 * That is what rules the two fixes this file pins:
 *
 *   1. Mount budgets. `initialNumToRender` 20 mounted ~2.5 screens of bubbles
 *      synchronously in the first commit of a chat open (the panel holds ~8),
 *      and `windowSize` 11 kept up to 11 screens resident.
 *   2. One native view per bubble, not two. The gradient fill moved off a child
 *      `<LinearGradient>` and onto the bubble's own background.
 *
 * NOTE for the next person tempted to "fix the lag" by deleting shadows: the
 * measurement above says the GPU is idle. Stripping the cobalt bubble glow
 * would cost the design and buy nothing. Do not do it without a NEW measurement
 * showing GPU-bound frames.
 *
 * These screens mount RN views, so the node project cannot import them — this
 * is a comment-stripped source scan. Both files are CRLF: nothing here is
 * `\n`-anchored, because a `\n` anchor matches nothing and passes VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const chat = strip(['src', 'screens', 'messenger', 'ChatScreen.tsx']);
const home = strip(['src', 'screens', 'messenger', 'MessengerHomeScreen.tsx']);

/** The numeric value of a FlatList prop written as `name={12}`. */
function listProp(src: string, name: string): number {
  const m = new RegExp(`${name}=\\{(\\d+)\\}`).exec(src);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

describe('B-279 — the chat thread mount budget', () => {
  // Ceilings, not equalities: tuning further DOWN after a new measurement is
  // fine and must not turn this suite red. Regressing back UP is the bug.
  it('does not mount more than a screen and a bit on the first commit', () => {
    expect(listProp(chat, 'initialNumToRender')).toBeLessThanOrEqual(10);
  });

  it('keeps each incremental batch short enough to land inside a frame', () => {
    expect(listProp(chat, 'maxToRenderPerBatch')).toBeLessThanOrEqual(8);
  });

  it('keeps at most ~5 screens of bubbles resident', () => {
    expect(listProp(chat, 'windowSize')).toBeLessThanOrEqual(5);
  });

  it('still recycles offscreen cells on Android', () => {
    // Removing this would grow native-view memory on the target device class.
    expect(chat).toContain("removeClippedSubviews={Platform.OS === 'android'}");
  });

  it('still has no getItemLayout — bubble heights genuinely vary', () => {
    // Guards against someone "optimising" by inventing a fixed row height,
    // which produces jumpy scroll and breaks reply-jump.
    expect(chat).not.toContain('getItemLayout');
  });
});

describe('B-279 — the conversation list mount budget', () => {
  it('mounts about a viewport, not double one', () => {
    expect(listProp(home, 'initialNumToRender')).toBeLessThanOrEqual(10);
  });

  it('batches and overscans within budget', () => {
    expect(listProp(home, 'maxToRenderPerBatch')).toBeLessThanOrEqual(8);
    expect(listProp(home, 'windowSize')).toBeLessThanOrEqual(5);
  });
});

describe('B-279 — one native view per bubble, not two', () => {
  it('the bubble gradient is a background, not a child view', () => {
    expect(chat).toMatch(/sentBubbleFill:\s*\{\s*experimental_backgroundImage:/);
    expect(chat).toMatch(/recvBubbleFill:\s*\{\s*experimental_backgroundImage:/);
  });

  it('THE REGRESSION: no <LinearGradient> between the bubble and its inner view', () => {
    // The whole point. LinearGradient is still legitimately used elsewhere on
    // this screen (avatar, attach sheet, mic button), so absence cannot be
    // asserted globally — only across the per-message span, which is the one
    // that multiplies by the number of rows mounted.
    const open = chat.indexOf('styles.bubble,');
    const inner = chat.indexOf('styles.bubbleInner,', open);
    expect(open).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(open);
    expect(chat.slice(open, inner)).not.toContain('LinearGradient');
  });

  it('the gradient fill is applied to text bubbles only', () => {
    // Image bubbles keep the flat fill: the photo covers it and only the 3px
    // padding ring would ever show a gradient.
    expect(chat).toMatch(/!isImage && \(sent \? styles\.sentBubbleFill : styles\.recvBubbleFill\)/);
  });

  it('the opaque fallback colour survives under the gradient', () => {
    // If experimental_backgroundImage ever fails to paint, the bubble must
    // still be a solid cobalt/obsidian shape rather than transparent. It is
    // also what the iOS glow shadow needs to render against.
    expect(chat).toMatch(/sentBubble:\s*\{[\s\S]{0,400}?backgroundColor: DM\.accentDeep/);
    expect(chat).toMatch(/recvBubble:\s*\{[\s\S]{0,400}?backgroundColor: DM\.recvBubble/);
  });

  it('the fill reuses the SAME stops the LinearGradient used', () => {
    // Pins that this was a like-for-like swap, not a redesign. If someone
    // changes the palette they must change SENT_GRADIENT/RECV_GRADIENT, which
    // keeps one source of truth for the bubble material.
    expect(chat).toContain('${SENT_GRADIENT[0]} 0%, ${SENT_GRADIENT[1]} 100%');
    expect(chat).toContain('${RECV_GRADIENT[0]} 0%, ${RECV_GRADIENT[1]} 100%');
  });

  it('B-285: every colour stop states an explicit position', () => {
    // A stop without a position makes RN's Android parser log
    // "Unsupported type for radius property: Null" once per stop, per bubble, per
    // commit — 260 warnings in 50s on device, against 0 before the change. The
    // gradient renders either way, so nothing but this test catches a regression.
    const fills = chat.match(/experimental_backgroundImage: `[^`]+`/g) ?? [];
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      const stops = fill.split(',').slice(1);   // drop the direction term
      for (const stop of stops) {
        expect(stop).toMatch(/\d+%/);
      }
    }
  });

  it('every closed sheet subtree is gated, not merely hidden', () => {
    // `<Modal visible={false}>` renders nothing, but React still CONSTRUCTS the
    // whole child element tree on every render to pass it as a prop. Gating on
    // the flag skips that. Measured honestly: this bought no visible frame-time
    // win on a short thread (the chat-open cost is one big commit, not element
    // creation) — it is kept because it is strictly less work per render and it
    // stops six sheets being rebuilt on every re-render of an OPEN chat.
    for (const guard of ['forwardSource', 'actionMsg', 'infoMsg', 'attachOpen', 'timerOpen']) {
      expect(chat).toContain(`{${guard} && (`);
    }
  });

  it('the emoji keyboard mounts only while open', () => {
    // rn-emoji-keyboard mounts its KeyboardProvider even when `open={false}`,
    // and that provider's memo flattens the whole ~1,800-entry emoji dataset.
    // `open={false}` did NOT prevent it — only not rendering it does.
    //
    // B-281 swapped the modal <EmojiPicker> for the inline <EmojiKeyboard>; the
    // mount-only-while-open invariant is unchanged, so only the tag moved.
    expect(chat).toContain('{emojiOpen && (');
    const gate = chat.indexOf('{emojiOpen && (');
    const tag = chat.indexOf('<EmojiKeyboard', gate);
    expect(tag).toBeGreaterThan(gate);
    expect(tag - gate).toBeLessThan(200);
  });

  it('NO PERFDIAG probe shipped', () => {
    // The instrumentation that found the numbers in this file's header logged
    // via console.warn, which SURVIVES release builds. It must never ship.
    expect(chat).not.toContain('PERFDIAG');
  });

  it('the dead bubbleRadii duplicate is gone', () => {
    // It existed only to re-derive the bubble corners for the overlay child.
    // A background inherits the view's real radii, so the duplicate could
    // silently drift out of step with the StyleSheet run-grouping variants.
    expect(chat).not.toContain('bubbleRadii');
  });
});
