/**
 * WI-2.4 — every screen-owned timer has an owner, and unmount clears it.
 *
 * These were bare `setTimeout` calls with no handle. An unmounted screen's
 * timer still fires: the pop watchdogs would `dismissCallScreen()` a screen
 * that was already gone (popping the PARENT — the exact double-pop B-102's
 * debounce exists to stop), the 350 ms route re-apply would drive
 * InCallManager for a call that had ended, and the 1.5 s accept retry would
 * answer on a dead surface.
 *
 * Source scans, because `CallScreen.tsx` and `FloatingCallOverlay.tsx` pull
 * react-native and cannot be imported by the node project. Comment lines are
 * stripped so the prose EXPLAINING a timer never counts as the timer, and the
 * scan is `\r?\n`-based because these files are CRLF — an LF-anchored regex
 * matches nothing and passes vacuously.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CALL_SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx');
const OVERLAY     = join(process.cwd(), 'src', 'screens', 'messenger', 'FloatingCallOverlay.tsx');

/** Strip comment LINES only — conservative, so a `//` inside a string survives. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SCREEN = codeOf(CALL_SCREEN);
const BAR    = codeOf(OVERLAY);

describe('WI-2.4 — CallScreen timer ownership', () => {
  it('POSITIVE CONTROL — the scanner reads real code, not an empty string', () => {
    // Every absence assertion below is vacuous if this file is unreadable or
    // the comment filter eats everything.
    expect(SCREEN.length).toBeGreaterThan(10_000);
    expect(SCREEN).toContain('const endCall');
    expect(BAR).toContain('const orphanedLive');
  });

  it('the three timers are held in refs', () => {
    expect(SCREEN).toMatch(/const autoAcceptRetryRef\s*=\s*useRef/);
    expect(SCREEN).toMatch(/const routeReapplyRef\s*=\s*useRef/);
    expect(SCREEN).toMatch(/const popWatchdogRef\s*=\s*useRef/);
  });

  it('unmount clears the two mount-bound timers, and DELIBERATELY not the route re-apply', () => {
    // `routeReapplyRef` drives a GLOBAL resource (InCallManager) for a call
    // that outlives this screen. A product switch is a raw React unmount with
    // no `beforeRemove`, so sweeping it would cancel the B-278 route correction
    // mid-flight and strand a minimised call on the earpiece with no screen
    // left to fix it.
    expect(SCREEN).toMatch(/\[autoAcceptRetryRef, popWatchdogRef\]/);
    expect(SCREEN).not.toMatch(/\[autoAcceptRetryRef, routeReapplyRef, popWatchdogRef\]/);
    expect(SCREEN).toMatch(/clearTimeout\(t\.current\)/);
  });

  it('the CALL-07 decline branch is keyed like the minimize branch next to it', () => {
    // `live` is the REGISTRY's entry (possibly another call) while
    // `liveCallStateRef` is THIS screen's state. Unkeyed, a superseded screen
    // still reading 'ringing' would decline — consuming a parked group ring
    // (B-306) — and then return, skipping the minimise of the call that
    // actually holds the slot.
    expect(SCREEN).toMatch(/live && live\.callId === callIdRef\.current && !live\.isMinimized && isIncoming/);
  });

  it('no bare pop watchdog survives — the raw 800 ms shape is gone', () => {
    // The literal shape both End and Decline used before.
    expect(SCREEN).not.toMatch(/setTimeout\(\(\)\s*=>\s*\{\s*dismissCallScreen\(\);\s*\}\s*,\s*800\)/);
    expect(SCREEN).toMatch(/const armPopWatchdog/);
  });

  it('the pop watchdog still funnels through dismissCallScreen (B-306)', () => {
    // It owns dismissedRef (exactly-once) AND consumes any group ring parked
    // behind this call. A raw goBack() here bypasses both — which is why the
    // B-306 pin explicitly forbids pinning the raw shape.
    const at = SCREEN.indexOf('const armPopWatchdog');
    const body = SCREEN.slice(at, at + 400);
    expect(body).toContain('dismissCallScreen()');
    expect(body).not.toMatch(/goBack\(\)/);
  });

  it('the 350 ms route re-apply still invalidates the cached route FIRST (B-278)', () => {
    // Any route apply reached from a resume must invalidate first, or the
    // idempotence guard matches the route it last ASKED for and skips the
    // very correction the delay exists to make.
    const at = SCREEN.indexOf('routeReapplyRef.current = setTimeout');
    expect(at).toBeGreaterThan(-1);
    const body = SCREEN.slice(at, at + 900);
    const inval = body.indexOf('invalidateAppliedRoute()');
    const apply = body.indexOf('reapplyRouteRef.current()');
    expect(inval).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(inval);
  });

  it('the route re-apply refuses once the call has ended or been superseded', () => {
    // It is EXEMPT from the unmount sweep (it must survive a minimize), so it
    // needs its own liveness check: the call can end inside the 350 ms window,
    // and re-driving InCallManager then sets the speakerphone force flag with
    // no session left to clear it — the CALL-N5 / latched-speaker shape,
    // leaking into the next call. Identity captured at ARM time, like the
    // accept retry, or the check is tautological.
    expect(SCREEN).toContain('const routeArmedForCallId = callIdRef.current;');
    const at = SCREEN.indexOf('routeReapplyRef.current = setTimeout');
    const body = SCREEN.slice(at, at + 900);
    const guard = body.indexOf('slot.callId !== routeArmedForCallId');
    const apply = body.indexOf('reapplyRouteRef.current()');
    expect(guard).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(guard);
  });

  it('the accept retry reads LIVE state and verifies the call identity', () => {
    const at = SCREEN.indexOf('autoAcceptRetryRef.current = setTimeout');
    expect(at).toBeGreaterThan(-1);
    const body = SCREEN.slice(at, at + 1200);
    expect(body).toContain('liveCallRef.current');           // live handle, not the closure
    expect(body).toContain("liveCallStateRef.current !== 'ringing'");
    // Identity CAPTURED at arm time. Reading callIdRef inside the callback
    // would be tautological: both it and the registry move with whatever call
    // the screen now shows, so it could never detect a timer armed for an
    // OLDER call — the one thing it exists to detect.
    expect(SCREEN).toContain('const armedForCallId = callIdRef.current;');
    expect(body).toContain('slot.callId !== armedForCallId');
  });

  it('B-319 SURVIVES — the effect still gates on controllerReady BEFORE the latch, and keeps it as a dep', () => {
    // The tension in WI-2.4 as written: "use a ref, not the render closure"
    // must NOT be applied to the effect's inputs. B-319's whole fix is that
    // the effect re-fires when controllerReady flips.
    const gateAt  = SCREEN.indexOf('if (!liveCall.controllerReady)');
    const latchAt = SCREEN.indexOf('autoAcceptedRef.current = true');
    expect(gateAt).toBeGreaterThan(-1);
    expect(latchAt).toBeGreaterThan(gateAt);
    expect(SCREEN).toMatch(/liveCall\.state,\s*liveCall\.controllerReady\]/);
  });

  it('B-319 latch release on a refused accept is intact', () => {
    expect(SCREEN).toMatch(/autoAcceptedRef\.current = false/);
  });
});

describe('WI-2.4 — liveCallStateRef seeds from real state (CALL-07 / B-329 class)', () => {
  it('is no longer hard-coded to the connecting literal', () => {
    expect(SCREEN).not.toMatch(/useRef<string>\('connecting'\)/);
  });

  it('reads the live registry entry, matched on callId', () => {
    const at = SCREEN.indexOf('const liveCallStateRef');
    const body = SCREEN.slice(at, at + 700);
    expect(body).toContain('getActiveCall()');
    expect(body).toContain('live.callId === callId');
  });

  it('keeps B-103’s fresh-boot seed — an incoming mount is ringing from frame 1', () => {
    // Otherwise the ring surface flashes an End button during the TURN fetch.
    const at = SCREEN.indexOf('const liveCallStateRef');
    const body = SCREEN.slice(at, at + 700);
    expect(body).toMatch(/isIncoming \? 'ringing' : 'connecting'/);
  });
});

describe('WI-2.4 — FloatingCallOverlay derives the route from a subscription', () => {
  it('orphanedLive no longer reads navigation during render', () => {
    const at = BAR.indexOf('const orphanedLive');
    expect(at).toBeGreaterThan(-1);
    const body = BAR.slice(at, at + 600);
    expect(body).not.toContain('getCurrentRoute');
    expect(body).toContain('routeName');
  });

  it('the subscription syncs on the navigation state event and unsubscribes', () => {
    expect(BAR).toMatch(/addListener\?\.\('state', sync\)/);
    expect(BAR).toMatch(/return \(\) => \{ try \{ off\?\.\(\); \}/);
  });

  it('keeps the THIRD state — nav-not-ready is not the same as a foreign route', () => {
    // Collapsing `undefined` into "not CallScreen" would be an accident that
    // happens to work; collapsing it the other way hides an unreachable call
    // behind an auth gate with no End control anywhere (B-64).
    expect(BAR).toMatch(/if \(routeName === undefined\) \{return true;\}/);
  });

  it('restore and End REFUSE when the rendered call and the live slot disagree', () => {
    // The navigate payload is built from the RENDERED `active`, so acting on a
    // press-time live read alone is mixed-identity: mount CallScreen for A while
    // un-minimising B, leaving B with no screen and no bar (`orphanedLive` is
    // false — the route IS CallScreen) and therefore no End control at all.
    expect(BAR).toMatch(/!live \|\| live\.callId !== active\.callId/);
    expect(BAR).toMatch(/live && live\.callId === active\.callId/);
    expect(BAR).toMatch(/!liveNow \|\| liveNow\.roomId !== state\.roomId/);
    expect(BAR).toMatch(/liveNow && liveNow\.roomId === state\.roomId/);
  });

  it('confirmRestored’s fallback is still armed and still keyed (B-460)', () => {
    // B-460 cause (2): the restore boolean was discarded and an unresolvable
    // nested navigate silently dropped. The fallback re-minimising is the FIX,
    // not a bug — do not weaken it.
    expect(BAR).toMatch(/if \(!ok\) \{return;\}/);
    expect(BAR).toMatch(/confirmRestored\('CallScreen', \(\) => setMinimized\(key, true\)\)/);
    expect(BAR).toMatch(/confirmRestored\('GroupCallScreen', \(\) => setGroupCallMinimized\(room, true\)\)/);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('review round 3 — the two fixes that had no pin', () => {
  const NAV = codeOf(join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'));

  it('POSITIVE CONTROL — the navigator scan reads real code', () => {
    expect(NAV.length).toBeGreaterThan(10_000);
    expect(NAV).toContain('setIncomingCallHandler');
  });

  it('an offer-replay RE-ASSERT never reaches B-107’s restore-mode busy', () => {
    // The re-assert only fires for a call whose signalling is already
    // registered and whose accept the user explicitly latched — so sending
    // `busy` there would busy the very call being answered. Pre-Phase-2 the
    // replay died at `sig.ingest` and could not reach the handler at all;
    // `clearAllCallDispatchState` runs only on sign-out, so a restore starting
    // mid-ring leaves the registered signalling intact and makes it reachable.
    expect(NAV).toMatch(/!opts\?\.reassert && isRestoreModeActive\(\)/);
  });

  it('the navigator REPORTS whether its navigate landed (B-460’s lesson at this site)', () => {
    // The dispatcher latches the callId on the result. Discarding it meant a
    // navigate silently dropped in a product-gate hold still burned the latch,
    // swallowing the reconnect replay that would have rescued the call.
    expect(NAV).toMatch(/return navigateToMessengerScreen\(navigationRef as never, 'CallScreen'/);
  });

  it('every overlay identity refusal is reported on the [CALLSM] lane', () => {
    // Phase 1 deliberately routes dropped `end` ops to the release-visible
    // channel because "End landed nowhere" is the evidence you grep for.
    // Refusing BEFORE the registry call bypasses that, so the refusal itself
    // has to speak — otherwise "I tapped End and nothing happened" is
    // unfalsifiable from a logcat.
    expect(BAR).toMatch(/logCallSm\('overlay\.restore\.refused'/);
    expect(BAR).toMatch(/logCallSm\('overlay\.end\.refused'/);
    expect(BAR).toMatch(/logCallSm\('overlay\.group-end\.refused'/);
  });
});
