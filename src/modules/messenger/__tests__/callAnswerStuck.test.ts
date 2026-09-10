/**
 * B-319 — answer-from-notification stuck on "Answering…" (founder repro,
 * 2026-07-27 complaint #3).
 *
 * Mechanism: a notification/lock-screen answer mounts CallScreen with
 * `autoAccept` while `iceServers` is still resolving, so `useCall` has NO
 * controller yet — but `state === 'ringing'` and the cached SDP are already
 * present, so the auto-accept effect passed every gate, latched
 * `autoAcceptedRef.current = true`, and called `accept()` →
 * `await controllerRef.current?.accept()` on a NULL ref: a silent resolve.
 * The latch never reset, and the dead-offer watchdog's arm check early-returns
 * on that same latch — "Answering…" forever, no timeout.
 *
 * Pinned here (source scan — screens/hooks pull react-native and cannot be
 * imported by the node project; CRLF-safe, comments stripped):
 *  1. useCall.accept() refuses a null controller LOUDLY (returns false) and
 *     does so BEFORE the CallKit bridge calls, so a doomed attempt cannot
 *     answer the CXCall / dismiss ring surfaces.
 *  2. useCall exposes `controllerReady`, set at BOTH controller-assignment
 *     sites (fresh build and registry adopt).
 *  3. CallScreen's auto-accept effect gates on `controllerReady` BEFORE the
 *     one-shot latch, and the effect re-fires on it (dep list).
 *  4. Both terminal dismiss paths have the B-213 canGoBack fallback — a cold
 *     notification launch seeds CallScreen as the stack's ONLY route, so a
 *     bare goBack() strands the user on a dead screen.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

const useCallSrc = stripComments(readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useCall.ts'), 'utf8',
));
const screenSrc = stripComments(readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8',
));

describe('B-319 — useCall.accept() vs the null-controller window', () => {
  it('accept() bails out (returns false) when no controller is built', () => {
    const at = useCallSrc.indexOf('const accept = useCallback');
    expect(at).toBeGreaterThan(-1);
    const body = useCallSrc.slice(at, useCallSrc.indexOf('const decline', at));
    expect(body).toMatch(/if \(!controllerRef\.current\)/);
    expect(body).toMatch(/return false;/);
    expect(body).toMatch(/return true;/);
  });

  it('the null-controller bail sits ABOVE the CallKit bridge calls', () => {
    const at = useCallSrc.indexOf('const accept = useCallback');
    const body = useCallSrc.slice(at, useCallSrc.indexOf('const decline', at));
    const bail = body.indexOf('if (!controllerRef.current)');
    const bridge = body.indexOf('markCallAccepted');
    expect(bail).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(-1);
    expect(bail).toBeLessThan(bridge);
  });

  it('controllerReady is set at BOTH controller assignment sites and returned', () => {
    // Fresh build + registry adopt each must flip readiness, or a call adopted
    // from the floating overlay would never satisfy the CallScreen gate.
    const assigns = useCallSrc.split(/\r?\n/).filter(l => /controllerRef\.current = (?:controller|existing\.controller);/.test(l));
    expect(assigns.length).toBe(2);
    const readySets = useCallSrc.match(/setControllerReady\(true\)/g) ?? [];
    expect(readySets.length).toBeGreaterThanOrEqual(2);
    expect(useCallSrc).toMatch(/return \{[\s\S]*?controllerReady,[\s\S]*?\};\r?\n\}/);
  });
});

describe('B-319 — CallScreen auto-accept gate + latch order', () => {
  function autoAcceptEffect(): string {
    const latch = screenSrc.indexOf('autoAcceptedRef.current = true;');
    expect(latch).toBeGreaterThan(-1);
    // The enclosing effect starts at the previous useEffect before the latch
    // and ends at its dep-array close (the first `]);` after the latch).
    const start = screenSrc.lastIndexOf('useEffect(', latch);
    const end = screenSrc.indexOf(']);', latch) + 3;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(latch);
    return screenSrc.slice(start, end);
  }

  it('the effect refuses to latch before controllerReady', () => {
    const eff = autoAcceptEffect();
    const gate = eff.indexOf('liveCall.controllerReady');
    const latch = eff.indexOf('autoAcceptedRef.current = true;');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(latch);
  });

  it('controllerReady is in the dep list so the effect re-fires when it flips', () => {
    const eff = autoAcceptEffect();
    expect(eff).toMatch(/\[autoAccept, userAccepted, isIncoming, incomingSdpKey, liveCall\.state, liveCall\.controllerReady\]/);
  });

  it('a false accept() releases the latch instead of stranding it', () => {
    const eff = autoAcceptEffect();
    expect(eff).toMatch(/autoAcceptedRef\.current = false;/);
  });
});

describe('B-319 — terminal dismiss cannot strand a single-route stack', () => {
  // Ops-Room call fix (2026-08-09): the fallback's TARGET changed from the
  // hard-coded MessengerTab hop (client-shell-only — it stranded CPO/agency
  // users on a dead call card) to the shell resolver. The pin follows: the
  // canGoBack fallback must still exist AND route through the resolver.
  it('dismissCallScreen has the B-213 canGoBack fallback (resolver-shaped)', () => {
    const at = screenSrc.indexOf('const dismissCallScreen');
    expect(at).toBeGreaterThan(-1);
    const body = screenSrc.slice(at, at + 3000);
    expect(body).toMatch(/canGoBack/);
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome'/);
  });

  it('the failed-state dismiss has the same fallback (resolver-shaped)', () => {
    const at = screenSrc.indexOf('const dismiss = () => {');
    expect(at).toBeGreaterThan(-1);
    const body = screenSrc.slice(at, at + 900);
    expect(body).toMatch(/canGoBack/);
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome'/);
  });
});
