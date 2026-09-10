/**
 * B-367 / B-368 — iOS back-navigation parity (static source scan).
 *
 * iOS has NO hardware back button, so `BackHandler.addEventListener(
 * 'hardwareBackPress', …)` NEVER fires there — the only back affordances are
 * the native-stack swipe gesture and on-screen buttons, and the only
 * cross-platform intercept is `navigation.addListener('beforeRemove', …)`.
 * The same is true on Android for the react-native-screens swipe gesture
 * (OneUI et al pop the native screen without dispatching hardwareBackPress —
 * the documented BS-022 mechanism).
 *
 * B-367 — CallScreen's beforeRemove listener minimized EVERY live state,
 * including an UNANSWERED incoming ring. The BackHandler branch (CALL-07)
 * declines that ring, but on iOS it can never run: a swipe-back during an
 * incoming ring minimized the ring into the FloatingCallOverlay and the
 * caller rang out the full 45s timeout with nobody ever coming back —
 * the exact CALL-07 bug, resurrected on the gesture path. The listener must
 * decline (via declineCallRef, the latest-closure ref) BEFORE the minimize
 * branch, latch dismissedRef first (the pop is already in flight; the
 * decline watchdog's dismissCallScreen would otherwise goBack a second time
 * onto the PARENT screen), and be re-entry-guarded on hangupInFlightRef
 * (the decline itself pops the screen and re-fires beforeRemove).
 *
 * B-368 — FilesScreen's multi-select exited on hardware back only. A swipe
 * back (the ONLY back gesture on iOS) popped the whole screen instead of
 * exiting selection mode. The fix is a beforeRemove listener scoped to
 * selectionMode that prevents back-shaped removals (GO_BACK / POP) and
 * clears the selection instead — programmatic removals (RESET / REPLACE,
 * e.g. sign-out) must still pass through.
 *
 * CallScreen/FilesScreen mount RN views, so this node project cannot import
 * them — comment-stripped source scan. Both files are CRLF: normalize line
 * endings FIRST (a `\n`-anchored regex on raw CRLF matches nothing and the
 * test passes VACUOUSLY), and strip comments before any ordering/absence
 * assertion (the prose above names the banned words).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const CALL  = 'src/screens/messenger/CallScreen.tsx';
const FILES = 'src/screens/messenger/FilesScreen.tsx';

/** The beforeRemove listener body of CallScreen (registration → unsubscribe return). */
function callBeforeRemoveBody(): string {
  const src = strip(read(CALL));
  const at = src.indexOf("addListener('beforeRemove'");
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('return unsubscribe', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('B-367 — swipe-back on an unanswered incoming ring must DECLINE, not minimize', () => {
  it('the beforeRemove listener has an incoming-ring decline branch', () => {
    const body = callBeforeRemoveBody();
    expect(body).toMatch(/isIncoming/);
    expect(body).toMatch(/'ringing'/);
    expect(body).toMatch(/declineCallRef\.current\(\)/);
  });

  it('the decline branch runs BEFORE the minimize branch', () => {
    const body = callBeforeRemoveBody();
    const declineAt  = body.indexOf('declineCallRef.current()');
    // WI-1.1 — the minimise is keyed now (`setMinimized(key, true)`), so match
    // the CALL rather than a literal argument list.
    const minimizeAt = body.search(/setMinimized\([^)]*true\)/);
    expect(declineAt).toBeGreaterThan(-1);
    expect(minimizeAt).toBeGreaterThan(-1);
    expect(declineAt).toBeLessThan(minimizeAt);
  });

  it('it funnels through the B-306 dismissal helper in skipPop mode, before declining', () => {
    // dismissCallScreen({skipPop: true}) latches dismissedRef (the decline
    // watchdog cannot double-pop onto the parent) AND still consumes any
    // parked group ring — a hand-rolled `dismissedRef.current = true` here
    // would bypass the consume and is exactly what the B-306 pin in
    // escalationRingHandoff.test.ts forbids.
    const body = callBeforeRemoveBody();
    const latchAt   = body.indexOf('dismissCallScreen({skipPop: true})');
    const declineAt = body.indexOf('declineCallRef.current()');
    expect(latchAt).toBeGreaterThan(-1);
    expect(latchAt).toBeLessThan(declineAt);
    expect(body).not.toMatch(/dismissedRef\.current = true/);
  });

  it('it is re-entry-guarded on hangupInFlightRef (decline pops the screen and re-fires beforeRemove)', () => {
    expect(callBeforeRemoveBody()).toMatch(/hangupInFlightRef\.current/);
  });

  it('the minimize path survives for every other live state (escalation + BS-022 depend on it)', () => {
    const body = callBeforeRemoveBody();
    expect(body).toMatch(/liveStates\.includes\(live\.state\)/);
    expect(body).toMatch(/setMinimized\([^)]*true\)/);
  });

  it('WI-1.1 — the swipe-back minimise is keyed to THIS screen’s call', () => {
    // Unkeyed, a swipe-back on a superseded CallScreen minimised whatever call
    // then held the slot — hiding a call the user never asked to hide.
    const body = callBeforeRemoveBody();
    expect(body).toMatch(/live\.callId === callIdRef\.current/);
    expect(body).toMatch(/setMinimized\(\{callId: live\.callId, gen: live\.gen\}, true\)/);
  });
});

describe('B-368 — FilesScreen selection mode must survive a swipe-back', () => {
  it('a beforeRemove listener exits selection mode instead of popping the screen', () => {
    const src = strip(read(FILES));
    const at = src.indexOf("addListener('beforeRemove'");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/preventDefault\(\)/);
    expect(body).toMatch(/setSelected\(null\)/);
  });

  it('it only intercepts back-shaped removals (GO_BACK / POP) — resets and replaces pass through', () => {
    const src = strip(read(FILES));
    const at = src.indexOf("addListener('beforeRemove'");
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/GO_BACK/);
    expect(body).toMatch(/POP/);
  });

  it('the intercept is scoped to selection mode', () => {
    const src = strip(read(FILES));
    // The effect bails when selection mode is off — a plain back must
    // still leave the screen.
    const at = src.indexOf("addListener('beforeRemove'");
    const windowStart = Math.max(0, at - 400);
    expect(src.slice(windowStart, at)).toMatch(/selectionMode/);
  });

  it('the Android hardware-key path is retained (BackHandler still exits selection)', () => {
    const src = strip(read(FILES));
    expect(src).toMatch(/hardwareBackPress/);
  });
});
