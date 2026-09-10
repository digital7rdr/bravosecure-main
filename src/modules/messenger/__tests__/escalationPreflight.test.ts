/**
 * B-301 — a failed escalation destroyed the working 1:1 call.
 *
 * `CallScreen.escalateToGroupCall` hung the 1:1 up and THEN
 * `navigation.replace`d to GroupCallScreen, which is where the SFU room is
 * actually created. Nothing rolled the hangup back, so a room that never formed
 * cost the user a call that was working and left them on "Call failed" with
 * nothing to return to.
 *
 * THE FIX IS TO STOP HANGING UP. CallScreen already knows how to survive its own
 * unmount with the call running: the `beforeRemove` listener minimizes any live
 * call ("a swipe-back gesture must minimize a live call, never cut it — for
 * every non-terminal state"), which sets `keepAlive` so `useCall`'s cleanup
 * leaves the controller alone and the FloatingCallOverlay takes over. That path
 * fires on `replace` too. The ONLY reason escalation lost the call is that
 * `hangup()` ran FIRST, driving the state terminal so the minimize branch's
 * `liveStates` check no longer matched.
 *
 * So the 1:1 now rides through the navigation, minimized, and GroupCallScreen
 * ends it only once the room is genuinely joined. If the group call never forms,
 * the 1:1 is still up and the overlay is the way back — escalation becomes
 * atomic: either you land in the group call, or you still have the call you
 * started with.
 *
 * This also removes a gap for the OTHER party. Previously they were cut, then
 * re-rung; now they keep their working call until the room exists.
 *
 * Two gates remain in front of the (now much cheaper) transition, and ORDER is
 * still the point for both — a gate after the navigation protects nothing:
 *   - B-111-A: no FrameCryptor ⇒ refuse, the call continues.
 *   - B-301:  no relay transport ⇒ the room CANNOT be created, so refuse before
 *     spending the transition at all. This is the flaky-network moment when a
 *     user reaches for "Add" in the first place.
 *
 * CallScreen/GroupCallScreen mount RN views, so the node project cannot import
 * them — comment-stripped source scan. Both files are CRLF, so nothing here is
 * `\n`-anchored (a `\n` anchor matches nothing and passes VACUOUSLY); the prose
 * above names `hangup` repeatedly, which is why the strip must happen first.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(file: string): string {
  return readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const callSrc  = () => code('CallScreen.tsx');
const groupSrc = () => code('GroupCallScreen.tsx');

function escalateBody(): string {
  const src = callSrc();
  const at = src.indexOf('const escalateToGroupCall');
  expect(at).toBeGreaterThan(-1);
  // Widened from 3600 when the B-301 camera-handoff block grew a registry key
  // (WI-1.1). The window still ends well inside the function.
  return src.slice(at, at + 4200);
}

describe('B-301 — escalation must be atomic', () => {
  it('the 1:1 is NOT hung up before the room exists', () => {
    // The whole bug in one line. Hanging up here is irreversible and happens
    // strictly before the room is created on another screen.
    expect(escalateBody()).not.toMatch(/liveCall\.hangup\(\)/);
  });

  it('the live call is handed to GroupCallScreen so it can be ended on success', () => {
    const body = escalateBody();
    // Shorthand or explicit — either is fine, it just has to travel.
    expect(body).toMatch(/navigation\.replace\('GroupCallScreen', \{[\s\S]{0,1600}pendingDirectCallId\s*[,:}]/);
    // And it must be the id of the call that is actually live, not a guess.
    expect(body).toMatch(/getActiveCall\(\)\?\.callId/);
  });

  it('the beforeRemove MINIMIZE path survives — it is what carries the call', () => {
    // If a refactor drops this, the call dies on the replace again and the
    // escalation is silently back to being destructive.
    const src = callSrc();
    expect(src).toMatch(/addListener\('beforeRemove'/);
    expect(src).toMatch(/liveStates\.includes\(live\.state\)/);
  });

  it('GroupCallScreen ends the 1:1 only AFTER it has joined', () => {
    const src = groupSrc();
    const at = src.indexOf('pendingDirectCallId');
    expect(at).toBeGreaterThan(-1);
    // The end must be gated on a JOINED room, never run unconditionally on
    // mount — that would reintroduce the bug with extra steps. Guard-clause
    // form: bail unless joined, and only then reach endActiveCall.
    const GUARD = "if (!pendingDirectCallId || call.state !== 'joined')";
    expect(src).toContain(GUARD + ' {return;}');
    // Anchor on the FULL guard: `call.state !== 'joined'` alone appears nine
    // times in this screen, so a bare indexOf locks onto an unrelated effect
    // and the distance check below becomes meaningless.
    const guardAt = src.indexOf(GUARD);
    const endAt   = src.indexOf('endActiveCall(', guardAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(guardAt);
    expect(endAt - guardAt).toBeLessThan(500);
  });

  it('it ends the RIGHT call — not whatever happens to be active', () => {
    // Ending blindly would kill an unrelated call that started in between.
    expect(groupSrc()).toMatch(/callId === pendingDirectCallId/);
  });
});

describe('B-301 — the gates in front of the transition, and their order', () => {
  it('the transport is pre-flighted', () => {
    expect(escalateBody()).toMatch(/waitForLiveTransport\(/);
  });

  it('a missing transport ABORTS the escalation', () => {
    expect(escalateBody()).toMatch(/waitForLiveTransport\([\s\S]{0,400}return;/);
  });

  it('both gates run BEFORE the navigation', () => {
    const body = escalateBody();
    const fcAt   = body.indexOf('frameCryptorOrchestratorAvailable');
    const wsAt   = body.indexOf('waitForLiveTransport(');
    const navAt  = body.indexOf("navigation.replace('GroupCallScreen'");
    expect(fcAt).toBeGreaterThan(-1);
    expect(wsAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(-1);
    expect(fcAt).toBeLessThan(navAt);
    expect(wsAt).toBeLessThan(navAt);
  });
});
