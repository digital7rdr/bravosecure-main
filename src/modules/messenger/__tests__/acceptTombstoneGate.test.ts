/**
 * WI-4.7 — accept() must consult the incoming-call tombstone BEFORE answering.
 *
 * The race: caller cancels while this device is still routing the Answer
 * (notification tap → cold navigation → controller build). Every cancel lane
 * tombstones the callId via `clearIncomingCallPayload`, and the dead-offer
 * watchdog polls that tombstone at 1 Hz — but `accept()` itself never looked.
 * In the ≤1 s window between the cancel landing and the watchdog's next tick,
 * an Answer went through: `markCallAccepted` burned the accept dedupe,
 * `reportAnswered` answered the CXCall (stamping a bogus answered state into
 * the system UI), and `controller.accept()` sent `call.answer` at a peer that
 * had already hung up.
 *
 * The gate sits AFTER the null-controller bail (B-319 owns that refusal and
 * its message) and BEFORE the CallKit bridge calls — same reasoning as B-319:
 * refuse before anything burns state. The refusal returns false, which
 * CallScreen's auto-accept `.then` treats as latch-release; the watchdog's own
 * tombstone probe then makes the verdict terminal within a tick.
 *
 * Source scan (useCall is a hook — the node project cannot import it).
 * CRLF-safe, comments stripped per the house rules.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

const useCallSrc = stripComments(readFileSync(
  join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useCall.ts'), 'utf8',
));

function acceptBody(): string {
  const at = useCallSrc.indexOf('const accept = useCallback');
  expect(at).toBeGreaterThan(-1);
  const end = useCallSrc.indexOf('const decline', at);
  expect(end).toBeGreaterThan(at);
  return useCallSrc.slice(at, end);
}

describe('WI-4.7 — the tombstone gate inside useCall.accept()', () => {
  it('accept() probes isIncomingCallDead before answering', () => {
    expect(acceptBody()).toMatch(/isIncomingCallDead\(callId\)/);
  });

  it('the probe refuses with return false, not a throw', () => {
    const body = acceptBody();
    const probe = body.indexOf('isIncomingCallDead(callId)');
    expect(probe).toBeGreaterThan(-1);
    // The refusal is the first return after the probe, and it is `false`.
    const window = body.slice(probe, probe + 400);
    const firstReturn = window.match(/return\s+(\w+);/);
    expect(firstReturn?.[1]).toBe('false');
  });

  it('ordering: null-controller bail → tombstone gate → CallKit bridge calls', () => {
    const body = acceptBody();
    const bail    = body.indexOf('if (!controllerRef.current)');
    const probe   = body.indexOf('isIncomingCallDead(callId)');
    const bridge  = body.indexOf('markCallAccepted');
    expect(bail).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(-1);
    // After B-319's bail: a doomed attempt must not even reach the probe path
    // decision with a null controller (the bail's message names that class).
    expect(bail).toBeLessThan(probe);
    // Before the bridge: a dead call must never answer the CXCall or burn the
    // accept dedupe — that is the entire point of the gate.
    expect(probe).toBeLessThan(bridge);
  });

  it('the refusal is loud on the release-visible channel', () => {
    const body = acceptBody();
    const probe = body.indexOf('isIncomingCallDead(callId)');
    const window = body.slice(probe, probe + 400);
    expect(window).toMatch(/console\.warn\(\s*'\[CALLDIAG\]/);
  });

  it('the cache require is guarded — an unavailable module must not veto a live accept', () => {
    // Review round 1 — anchored on the gate's OWN try/catch, not "any try
    // exists somewhere": the require and the probe must both sit between one
    // `try {` and its `} catch {`, with no other statement block boundary in
    // between, and the catch must PROCEED (contain no return).
    const body = acceptBody();
    const probe = body.indexOf('isIncomingCallDead(callId)');
    expect(probe).toBeGreaterThan(-1);
    const tryAt = body.lastIndexOf('try {', probe);
    expect(tryAt).toBeGreaterThan(-1);
    const gate = body.slice(tryAt, body.indexOf('}', body.indexOf('} catch {', probe) + 1) + 1);
    expect(gate).toMatch(/try \{\s*const cache = require\('\.\.\/push\/incomingCallCache'\)/);
    expect(gate).toContain('isIncomingCallDead(callId)');
    const catchAt = gate.indexOf('} catch {');
    expect(catchAt).toBeGreaterThan(-1);
    const catchBody = gate.slice(catchAt, gate.length);
    expect(catchBody).not.toMatch(/return/);
  });
});
