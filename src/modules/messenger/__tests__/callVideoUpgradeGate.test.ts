/**
 * B-389 — "Could not turn on video ... (upgradeToVideo: call must be connected
 * (got calling))".
 *
 * ROOT CAUSE, in order:
 *
 *  1. CallScreen's `isRinging` is `isIncoming && state === 'ringing' && ...`.
 *     It suppresses the control tray ONLY for an INCOMING ringing call.
 *  2. The tray renders on `!isRinging`, so for an OUTGOING call — whose state
 *     is 'calling' until the peer answers — every control INCLUDING Camera is
 *     live before the call is connected.
 *  3. The Camera button's only guard was `liveCall.isUpgrading`. Nothing looked
 *     at the call state.
 *  4. useCall.upgradeToVideo correctly refuses with
 *     `upgradeToVideo: call must be connected (got calling)`. THAT GUARD IS
 *     CORRECT — a mid-call SDP renegotiation on a peer connection that has not
 *     completed its initial offer/answer is exactly the glare this codebase has
 *     been bitten by before. It must NOT be weakened to make this test pass.
 *  5. CallScreen's catch maps known failures to friendly text. The
 *     "must be connected" message matched NO branch, so it fell through to the
 *     generic body: "End the call and start a fresh video call to continue."
 *
 * Step 5 is why this is more than cosmetic: the app instructed the user to TEAR
 * DOWN A HEALTHY ENCRYPTED CALL to recover from a condition that resolves by
 * itself the moment the peer answers.
 *
 * There are TWO entry points into the upgrade, not one — the Camera button and
 * the "Turn on mine" action on the peer-added-video alert — so the state gate
 * has to live in `setIsCameraOn` (the shared choke point), not only on the
 * button. Disabling the button as well is the UX half.
 *
 * A source scan, because CallScreen.tsx cannot be imported by this project
 * (native op-sqlite / RN deps). Guarded per CLAUDE.md: EOL-normalised read, and
 * comments stripped LINE-BY-LINE — the house block-comment stripper is
 * documented to delete real code when it meets a `/*` inside a string.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx');
const HOOK   = join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useCall.ts');

/** Strip line comments and block-comment bodies without a regex that can eat code. */
function codeOnly(path: string): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) {inBlock = false;}
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) {inBlock = true;}
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('B-389 — Camera must not attempt a video upgrade before the call connects', () => {
  it('the scan can actually see code (guards against a vacuous pass)', () => {
    const src = codeOnly(SCREEN);
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain('setIsCameraOn');
    expect(src).not.toContain('\r');
  });

  // THE GUARD ITSELF — must survive. This is the correctness invariant; the fix
  // is to stop CALLING it in a bad state, never to relax it.
  it('useCall.upgradeToVideo still refuses when the call is not connected', () => {
    const hook = codeOnly(HOOK);
    expect(hook).toMatch(/currentState\s*!==\s*'connected'/);
    expect(hook).toMatch(/upgradeToVideo: call must be connected/);
  });

  // (a) The shared choke point. Both the Camera button AND the "Turn on mine"
  // action on the peer-added-video alert route through setIsCameraOn, so the
  // gate belongs here — gating only the button leaves the alert path open.
  it('setIsCameraOn refuses to start an upgrade unless the call is connected', () => {
    const src = codeOnly(SCREEN);
    const start = src.indexOf('const setIsCameraOn');
    expect(start).toBeGreaterThan(-1);
    // Body up to the peer-added-video effect that follows it.
    const body = src.slice(start, src.indexOf('peerAddedVideoNoticedRef', start));
    expect(body).toMatch(/liveCall\.state\s*!==\s*'connected'/);
  });

  // (b) The UX half — the button is visibly and functionally inert pre-connect.
  it('the Camera control is disabled until the call is connected', () => {
    const src = codeOnly(SCREEN);
    const camera = src.split('\n').find(l => l.includes("id:'camera'"));
    expect(camera).toBeDefined();
    expect(camera).toMatch(/disabled/);
  });

  // (c) The advice. The old generic body told the user to hang up.
  it('a not-yet-connected upgrade does NOT tell the user to end the call', () => {
    const src = codeOnly(SCREEN);
    expect(src).toMatch(/must be connected/);
    const branch = src.slice(src.indexOf('let title'), src.indexOf('Alert.alert(title'));
    // A dedicated branch for the not-connected case must exist BEFORE the
    // generic fallback is used.
    expect(branch).toMatch(/must be connected/i);
  });
});
