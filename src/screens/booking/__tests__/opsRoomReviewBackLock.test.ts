/**
 * B-370 — OpsRoomReview's visible back arrow bypassed the payment lock
 * (static source scan).
 *
 * `lockBack` blocks hardware back AND the swipe gesture while the booking is
 * in flight: ops review pending OR auto-pay countdown / debit in progress
 * (payState countdown/paying/paid), released after the 5-minute poll cap
 * (pollGaveUp). But the header arrow's visibility was gated on
 * `state === 'pending'` alone, so during the countdown/paying/paid window the
 * arrow was rendered and its goBackOnce() bypassed the lock on BOTH platforms
 * — on iOS it was the primary affordance. The arrow must be gated on the same
 * `lockBack` condition the other two affordances use; as a bonus this also
 * un-hides the arrow in the gave-up-while-pending state, which released the
 * lock but previously kept the arrow hidden forever.
 *
 * The screen mounts RN views, so this node project cannot import it —
 * comment-stripped scan. The file is CRLF: normalize first, strip comments
 * before asserting.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const SCREEN = 'src/screens/ops/OpsRoomReviewScreen.tsx';

describe('B-370 — the back arrow honours the same lock as hardware back and the gesture', () => {
  it('the arrow/spacer ternary is gated on lockBack, not on state === "pending"', () => {
    const src = strip(read(SCREEN));
    const spacerAt = src.indexOf('s.backSpacer');
    expect(spacerAt).toBeGreaterThan(-1);
    const window = src.slice(Math.max(0, spacerAt - 300), spacerAt);
    expect(window).toMatch(/lockBack\s*\?/);
    expect(window).not.toMatch(/state === 'pending'\s*\?/);
  });

  it('the lock itself still gates gesture + hardware back (regression anchor)', () => {
    const src = strip(read(SCREEN));
    expect(src).toMatch(/gestureEnabled: false/);
    expect(src).toMatch(/hardwareBackPress/);
  });
});
