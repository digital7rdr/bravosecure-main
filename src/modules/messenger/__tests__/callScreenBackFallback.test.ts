/**
 * BB-1 / BB-2 (2026-08-15 back-button audit) — every exit on the three call
 * surfaces must survive a COLD mount, where the screen is the stack's ONLY
 * route (B-319: a cold ring/answer is BY DESIGN seeded flagless — see
 * pushNavigateParamSweep "ring resolver sites stay FLAGLESS") and a bare
 * navigation.goBack() is a silent no-op.
 *
 * The B-319 fallback contract: canGoBack() ? goBack() : shell-aware home exit
 * via navigateToMessengerScreen(navigationRef, 'MessengerHome'). CallScreen
 * and GroupCallScreen carried it on SOME paths (dismissCallScreen, the
 * terminal auto-pop) while their minimize family stayed bare; the ring screen
 * had NO fallback at all — Decline left the user trapped on the ring screen
 * with hardware back swallowed (decline(); return true).
 *
 * Source scan, not a render test: none of these screens mount under the node
 * project. Files are CRLF — normalise before any regex. Comments are stripped
 * so prose about goBack can neither satisfy nor trip a pin.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (f: string): string => readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('BB-1 — IncomingGroupCallScreen dismissals survive a cold ring', () => {
  const src = strip(read('IncomingGroupCallScreen.tsx'));

  it('has NO bare navigation.goBack() — every exit rides dismissRing', () => {
    expect(src).not.toMatch(/navigation\.goBack\(\)/);
  });

  it('dismissRing carries the B-319 canGoBack fallback to the shell-aware home exit', () => {
    const at = src.indexOf('const dismissRing');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('}, [', at));
    expect(body).toMatch(/canGoBack\(\)/);
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome', \{\}\)/);
  });

  it('the Decline path (also the hardware-back handler) rides dismissRing', () => {
    const at = src.indexOf('const decline');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('}, [', at));
    expect(body).toMatch(/dismissRing\(\)/);
    // The hardware handler funnels through decline() — it must not grow its
    // own second dismissal verb.
    expect(src).toMatch(/const onBack = \(\) => \{\s*decline\(\);\s*return true;/);
    expect(src).toMatch(/addEventListener\('hardwareBackPress', onBack\)/);
  });
});

describe('BB-2 — CallScreen minimize family survives a cold-answered call', () => {
  const src = strip(read('CallScreen.tsx'));

  it('popOrHome exists with the canGoBack fallback (and no dismissedRef latch)', () => {
    const at = src.indexOf('const popOrHome');
    expect(at).toBeGreaterThan(-1);
    // Terminator: the next hook — a '};' scan dies early on the type-cast
    // line ('… => boolean};') inside the helper body.
    const body = src.slice(at, src.indexOf('useEffect(', at));
    expect(body).toMatch(/canGoBack/);
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome', \{\}\)/);
    expect(body).not.toMatch(/dismissedRef/);
  });

  it('the visible Minimise control rides popOrHome', () => {
    expect(src).toMatch(/const minimise = \(\) => popOrHome\(\)/);
  });

  it('the hardware-back handler has no bare cast-goBack left', () => {
    // The exact pre-fix shape at both terminal branches of the handler.
    expect(src).not.toMatch(/\(navigation as unknown as \{goBack: \(\) => void\}\)\.goBack\(\)/);
  });
});

describe('BB-2 — GroupCallScreen minimize/hangup/blocker survive a cold-answered call', () => {
  const src = strip(read('GroupCallScreen.tsx'));

  it('popOrHome exists with the canGoBack fallback', () => {
    const at = src.indexOf('const popOrHome');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('}, [', at));
    expect(body).toMatch(/canGoBack\(\)/);
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome', \{\}\)/);
  });

  it('minimize rides popOrHome, never a bare goBack', () => {
    expect(src).not.toMatch(/setGroupCallMinimized\(true\);\s*navigation\.goBack\(\)/);
    const at = src.indexOf('const minimize');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf('}, [', at))).toMatch(/popOrHome\(\)/);
  });

  it('hangup rides popOrHome AND latches the terminal auto-pop (no double back)', () => {
    // 'const hangup' alone would anchor on hangupInFlightRef.
    const at = src.indexOf('const hangup = useCallback');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('}, [', at));
    expect(body).toMatch(/popOrHome\(\)/);
    expect(body).toMatch(/terminalPoppedRef\.current = true/);
    expect(body).not.toMatch(/navigation\.goBack\(\)/);
  });

  it('the full/kicked/failed/unavailable blocker Close is guarded for a cold mount', () => {
    // Those states are NOT terminal-pop states, so the auto-pop fallback never
    // covers them — the Close button must carry its own.
    expect(src).toMatch(/navigation\.canGoBack\(\) \? goBackOnce\(navigation\) : popOrHome\(\)/);
  });

  it('the terminal auto-pop keeps its original B-213 fallback', () => {
    const at = src.indexOf('isTerminalPopState(call.state)');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('TERMINAL_POP_DELAY_MS', at));
    expect(body).toMatch(/canGoBack\(\)/);
  });
});
