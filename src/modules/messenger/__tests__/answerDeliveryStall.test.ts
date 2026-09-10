import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  CONNECTING_WATCHDOG_MS,
  ANSWER_DELIVERY_WATCHDOG_MS,
} from '@/modules/messenger/webrtc/callController';

/**
 * ANSWER-STALL — answering from a notification tap stalled on "Answering…"
 * with no audio, then the call died.
 *
 * Reported from the field. Two timers contradicted each other:
 *
 *   - signallingClient retries `call.answer` across a WS reconnect for
 *     CALL_SETUP_SEND_BUDGET_MS (40s). Answering from a notification is the
 *     cold-start case: the socket is often still coming up.
 *   - callController.setState('connecting') armed CONNECTING_WATCHDOG_MS (20s)
 *     IMMEDIATELY, before the answer had been delivered.
 *
 * So at 20s the watchdog killed a call whose answer was still being legitimately
 * retried. The caller never received an answer, no media path was negotiated,
 * and the callee sat behind an "Answering…" label the whole time. The file's own
 * comment already described the failure: "a dropped call.answer wedges the
 * callee until the 20s connecting watchdog."
 *
 * Two independent properties are pinned:
 *   1. the delivery-window budget must EXCEED the signalling send budget, and
 *   2. a delivery FAILURE must end the call explicitly rather than returning
 *      silently and leaving the user on "Answering…".
 *
 * The behavioural half is asserted on the real exported constants; the wiring
 * half is a source scan, because callController's answer path needs a live
 * PeerConnection and cannot be driven in jest.
 */

const CONTROLLER = join(
  process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'callController.ts',
);

/**
 * The signalling layer's own retry budget for call setup frames.
 *
 * WI-2.3 re-point: this used to regex `signallingClient.ts`, which now IMPORTS
 * the value rather than declaring it. Following the constant to its new home
 * keeps the original property — read the real number out of source, so an
 * edit to the number is what this sees — rather than trusting a re-export.
 * The ceiling assertion below is carried forward unchanged and must stay.
 */
const DEADLINES = join(
  process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'callDeadlines.ts',
);

function sendBudgetMs(): number {
  const src = readFileSync(DEADLINES, 'utf8');
  const m = src.match(/CALL_SETUP_SEND_BUDGET_MS\s*=\s*([0-9_]+)/);
  expect(m).toBeTruthy();
  return Number(m![1].replace(/_/g, ''));
}

describe('ANSWER-STALL — the watchdog must not kill a call that is still delivering its answer', () => {
  it('the delivery watchdog outlives the signalling send budget', () => {
    // THE bug. If this inverts again, answering from a notification on a slow
    // or cold socket dies at the shorter clock every time.
    expect(ANSWER_DELIVERY_WATCHDOG_MS).toBeGreaterThan(sendBudgetMs());
  });

  it('the delivery watchdog is strictly longer than the post-delivery watchdog', () => {
    expect(ANSWER_DELIVERY_WATCHDOG_MS).toBeGreaterThan(CONNECTING_WATCHDOG_MS);
  });

  it('the post-delivery watchdog stays short — a stuck ICE is still caught quickly', () => {
    // The long budget must apply ONLY while delivery is pending. Widening the
    // normal connecting watchdog would trade this bug for a call that hangs.
    expect(CONNECTING_WATCHDOG_MS).toBeLessThanOrEqual(20_000);
  });
});

describe('ANSWER-STALL — wiring (source scan; the answer path needs a live PeerConnection)', () => {
  const SRC = readFileSync(CONTROLLER, 'utf8');

  /** Strip comments so the scan sees CODE, not the prose explaining it. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  /** The answer-send block: from the sendAnswer call to the end of its chain. */
  function answerBlock(): string {
    const code = stripComments(SRC);
    const i = code.indexOf('signalling.sendAnswer(');
    expect(i).toBeGreaterThan(-1);
    return code.slice(i, i + 1200);
  }

  it('the delivery window is armed with the LONG budget before awaiting delivery', () => {
    expect(answerBlock()).toMatch(/armConnectingWatchdog\(\s*ANSWER_DELIVERY_WATCHDOG_MS\s*\)/);
  });

  it('a failed delivery ends the call instead of returning silently', () => {
    // The original code was `if (!ok) {return;}` — the single line that left the
    // user on "Answering…" with nothing driving the call to a terminal state.
    const block = answerBlock();
    expect(block).toMatch(/if\s*\(!ok\)\s*\{[\s\S]{0,400}?hangup\(/);
    expect(block).not.toMatch(/if\s*\(!ok\)\s*\{\s*return;\s*\}/);
  });

  it('a successful delivery re-arms the SHORT watchdog (NA-05 is preserved)', () => {
    // The re-arm is what makes the long budget safe: once the frame lands, the
    // real 20s clock restarts from that moment.
    expect(answerBlock()).toMatch(/armConnectingWatchdog\(\s*\)/);
  });

  it('the delivery-failure branch is guarded by callId and state', () => {
    // A late resolution must not hang up a DIFFERENT call the controller has
    // since moved on to.
    const block = answerBlock();
    expect(block).toMatch(/this\.state !== 'connecting'/);
    expect(block).toMatch(/descriptor\?\.callId !== answerCallId/);
  });

  it('armConnectingWatchdog accepts an explicit budget override', () => {
    expect(SRC).toMatch(/private armConnectingWatchdog\(budgetMs\?: number\)/);
    expect(SRC).toMatch(/budgetMs \?\? this\.opts\.connectingWatchdogMs \?\? CONNECTING_WATCHDOG_MS/);
  });
});
