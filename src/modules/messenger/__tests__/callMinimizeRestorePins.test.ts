/**
 * B-329 / B-330 — minimize→restore regressions in the 1:1 video call
 * (founder repro, 2026-07-29).
 *
 * B-329: after restore, the first tap on the video area sometimes did nothing.
 * useCall seeded state 'ringing'/'idle' and held it until iceServers resolved
 * (a network fetch), so the restored screen spent that whole window on
 * callState==='connecting': the chrome tap-catcher (gated on 'connected') was
 * unmounted, the auto-hide timer never armed, and a restored INCOMING call
 * flashed the ring surface. Fix: seed the hook's state from the registry when
 * a live call with the same callId exists.
 *
 * B-330: the self-view PiP could strand off its 16px margin rails. Two paths:
 * a stolen gesture (no onPanResponderTerminate — B-242 class) left the offset
 * un-flattened and un-snapped, and a grab mid-settle let the running spring
 * finish against a re-based offset. Fix: settlePipIntoBounds shared by
 * release/terminate, stopAnimation on grant, and a mount/window-change
 * re-clamp so a restore always renders inside bounds.
 *
 * Pinned as source scans — screens/hooks pull react-native and cannot be
 * imported by the node project (CRLF-safe, comments stripped).
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

describe('B-329 — useCall state seeds from the registry on a restore mount', () => {
  const at = useCallSrc.indexOf('useState<CallState>');
  const seed = useCallSrc.slice(at, useCallSrc.indexOf('});', at));

  it('the initializer adopts the live registry state for the same callId', () => {
    expect(at).toBeGreaterThan(-1);
    expect(seed).toMatch(/getActiveCall/);
    expect(seed).toMatch(/live\.callId === callId/);
    expect(seed).toMatch(/return live\.state;/);
  });

  it('the fresh-mount fallback is unchanged (B-103/B-319 semantics)', () => {
    expect(seed).toMatch(/direction === 'incoming' \? 'ringing' : 'idle'/);
  });

  it("the chrome tap-catcher still gates on 'connected' (never active while ringing)", () => {
    expect(screenSrc).toMatch(/callState === 'connected' && \(\s*<Pressable/);
  });
});

describe('B-330 — self-view PiP can never strand off its margin rails', () => {
  const respAt = screenSrc.indexOf('const pipResponder');
  const resp = screenSrc.slice(respAt, screenSrc.indexOf(').current;', respAt));

  it('release and terminate both settle through the shared clamp', () => {
    expect(respAt).toBeGreaterThan(-1);
    const release = resp.slice(resp.indexOf('onPanResponderRelease'), resp.indexOf('onPanResponderTerminate'));
    const terminate = resp.slice(resp.indexOf('onPanResponderTerminate'));
    expect(release).toMatch(/settlePipIntoBounds\(\);/);
    expect(terminate).toMatch(/pipPan\.flattenOffset\(\);/);
    expect(terminate).toMatch(/settlePipIntoBounds\(\);/);
  });

  it('a grab mid-settle kills the running spring before the offset re-base', () => {
    const grant = resp.slice(resp.indexOf('onPanResponderGrant'), resp.indexOf('onPanResponderMove'));
    const stop = grant.indexOf('pipPan.stopAnimation()');
    const rebase = grant.indexOf('pipPan.setOffset');
    expect(stop).toBeGreaterThan(-1);
    expect(rebase).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(rebase);
  });

  it('parents cannot steal the gesture silently', () => {
    expect(resp).toMatch(/onPanResponderTerminationRequest: \(\) => false/);
  });

  it('a restore or window change re-clamps into current bounds (skipped mid-gesture)', () => {
    const at = screenSrc.indexOf('if (pipGrantPosRef.current) {return;}');
    expect(at).toBeGreaterThan(-1);
    const effect = screenSrc.slice(at, screenSrc.indexOf(']);', at));
    expect(effect).toMatch(/settlePipIntoBounds\(\);/);
    expect(effect).toMatch(/win\.width, win\.height/);
  });

  it('the clamp reads live window dims (winRef), not a mount-time capture', () => {
    const at = screenSrc.indexOf('const settlePipIntoBounds');
    expect(at).toBeGreaterThan(-1);
    const body = screenSrc.slice(at, screenSrc.indexOf('}, [pipPan]);', at));
    expect(body).toMatch(/winRef\.current\.width/);
    expect(body).toMatch(/winRef\.current\.height/);
    expect(body).toMatch(/margin: 16/);
    expect(body).not.toMatch(/Dimensions\.get/);
  });
});
