/**
 * WI-2.3 — the call deadlines are a SYSTEM, and this pins the relationships.
 *
 * The ANSWER-STALL bug was two individually-correct numbers in two files that
 * nobody had read side by side: the signalling layer retried `call.answer` for
 * 40 s while the connecting watchdog killed the call at 20 s. Asserting each
 * value in isolation would not have caught it — only the ORDERING does.
 *
 * The second half of this file is the drift guard that matters more than the
 * first: every owning module must actually USE the shared constant, not a
 * local copy of the same number. A duplicated literal is how the relationship
 * silently breaks while this file stays green.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  RING_TIMEOUT_MS,
  ACCEPT_INTENT_TTL_MS,
  CALL_SETUP_SEND_BUDGET_MS,
  ANSWER_DELIVERY_WATCHDOG_MS,
  CONNECTING_WATCHDOG_MS,
  TURN_FETCH_CEILING_MS,
  RECONNECT_BUDGET_MS,
  GROUP_REJOIN_CEILING_MS,
  GROUP_REBUILD_MARK_CEILING_MS,
  RESTART_RETRY_MS,
  DISPATCH_FRAME_TTL_MS,
  ONE_TO_ONE_LAUNCH_WATCHDOG_MS,
  RECENTLY_ENDED_WINDOW_MS,
  NAV_READY_WAIT_MS,
  INCOMING_PAYLOAD_TTL_MS,
  INCOMING_TOMBSTONE_TTL_MS,
  ICE_WAIT_OPEN_MS,
  OFFER_VERIFY_DEADLINE_MS,
} from '../webrtc/callDeadlines';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8');

// ────────────────────────────────────────────────────────────────────
describe('WI-2.3 — the ordering invariants', () => {
  it('ANSWER_DELIVERY > CALL_SETUP_SEND_BUDGET — THE ANSWER-STALL rule', () => {
    // If this inverts, answering from a notification on a slow or cold socket
    // dies at the shorter clock every single time.
    expect(ANSWER_DELIVERY_WATCHDOG_MS).toBeGreaterThan(CALL_SETUP_SEND_BUDGET_MS);
  });

  it('ANSWER_DELIVERY > CONNECTING — the delivery budget is the longer one', () => {
    expect(ANSWER_DELIVERY_WATCHDOG_MS).toBeGreaterThan(CONNECTING_WATCHDOG_MS);
  });

  it('CONNECTING stays <= 20 s — a stuck ICE must still be caught quickly', () => {
    // Carried forward from `answerDeliveryStall.test.ts`. The long budget must
    // apply ONLY while delivery is pending; widening this trades the
    // ANSWER-STALL bug for calls that hang.
    expect(CONNECTING_WATCHDOG_MS).toBeLessThanOrEqual(20_000);
  });

  it('ACCEPT_INTENT_TTL === RING_TIMEOUT — never answer a dead offer', () => {
    // Past the ring window the caller has already given up. B-110's ghost
    // auto-answer was a call that connected ~35 s after its offer with zero
    // user action.
    expect(ACCEPT_INTENT_TTL_MS).toBe(RING_TIMEOUT_MS);
  });

  it('RECENTLY_ENDED > RING_TIMEOUT — the ghost-redial guard outlives the ring', () => {
    // CALL-N15 and FIX-14 both read this. A restore navigation carrying an
    // ended callId can arrive any time inside the caller's ring window.
    expect(RECENTLY_ENDED_WINDOW_MS).toBeGreaterThan(RING_TIMEOUT_MS);
  });

  it('DISPATCH_FRAME_TTL < RING_TIMEOUT — a queued frame cannot outlive its call', () => {
    expect(DISPATCH_FRAME_TTL_MS).toBeLessThan(RING_TIMEOUT_MS);
  });

  it('TURN ceiling is small enough that call boot never waits on it', () => {
    // B-110/F-1: no ceiling meant a ~35 s stall with `iceServers` null.
    expect(TURN_FETCH_CEILING_MS).toBeLessThanOrEqual(6_000);
    expect(TURN_FETCH_CEILING_MS).toBeLessThan(CONNECTING_WATCHDOG_MS);
  });

  it('RESTART_RETRY fits several times inside RECONNECT_BUDGET', () => {
    // Otherwise the budget expires having made one attempt, and "retry" is a
    // word rather than a behaviour.
    expect(RECONNECT_BUDGET_MS / RESTART_RETRY_MS).toBeGreaterThanOrEqual(4);
  });

  it('the group rebuild mark expires within one reconnect budget', () => {
    /**
     * THIS ASSERTION CARRIES A TERMINATION PROOF, and until round 3 it existed
     * only as prose.
     *
     * While a group rejoin is rebuilding a room, `onBudgetExpiry` declines to
     * fail the call and re-arms for another full window — that rebuild IS the
     * recovery. The reason that cannot loop forever is arithmetic: the mark was
     * stamped at or before the expiry that saw it, so the RE-ARMED expiry lands
     * at least one budget later, by which time a mark that has not been
     * refreshed is certain to have aged past its ceiling.
     *
     * Invert this relationship and a wedged rebuild defers the budget
     * indefinitely: the call sits in 'reconnecting' forever holding the audio
     * session, the foreground service and launchCall's busy guard, with no way
     * out but a force-quit. That is B-108's "only terminal authority" contract
     * silently retired — which is exactly what a first attempt at this fix did.
     */
    expect(GROUP_REBUILD_MARK_CEILING_MS).toBeLessThanOrEqual(RECONNECT_BUDGET_MS);
  });

  it('the rejoin TAKEOVER window outlives the rebuild mark', () => {
    // These two were one constant and must not become one again. The takeover
    // wants to be SLOW to abandon a rejoin that is merely working; the mark
    // wants to be QUICK to release, because while it is held the tile-reconcile
    // backstop is blind. Sharing a number traded one bug for the other.
    expect(GROUP_REBUILD_MARK_CEILING_MS).toBeLessThan(GROUP_REJOIN_CEILING_MS);
  });

  it('the launch watchdog is short — it only releases a double-tap latch', () => {
    expect(ONE_TO_ONE_LAUNCH_WATCHDOG_MS).toBeLessThan(RING_TIMEOUT_MS);
  });

  it('WI-4.8 — the incoming payload outlives a last-second answer on a cold navigator', () => {
    // A ring answered at its 45 s deadline, on a cold launch whose navigator
    // takes the full nav wait, hydrates SDP/deviceId/conversationId from the
    // cache at t≈65 s. The old private 60 s TTL expired underneath exactly
    // that answer and starved it into the B-102 A1 stall.
    expect(INCOMING_PAYLOAD_TTL_MS).toBeGreaterThan(RING_TIMEOUT_MS + NAV_READY_WAIT_MS);
  });

  it('WI-5.6 — the ICE wait-open budget sits well under the setup send budget', () => {
    // Buffered trickle only matters while its offer/answer is being applied;
    // a socket down longer than this is the ICE-restart path's problem.
    expect(ICE_WAIT_OPEN_MS).toBeLessThan(CALL_SETUP_SEND_BUDGET_MS);
    expect(ICE_WAIT_OPEN_MS).toBeLessThan(CONNECTING_WATCHDOG_MS);
  });

  it('WI-5.5 — the offer-verify deadline stays under the frame-queue TTL', () => {
    // The verify heads the per-callId inbound chain; chained frames must not
    // outlive their queue window waiting on it.
    expect(OFFER_VERIFY_DEADLINE_MS).toBeLessThan(DISPATCH_FRAME_TTL_MS);
    expect(OFFER_VERIFY_DEADLINE_MS).toBeLessThan(RING_TIMEOUT_MS);
  });

  it('WI-4.8 — the tombstone outlives the payload', () => {
    // The tombstone's whole job is covering the window between "consumed" and
    // "expired"; equal-or-shorter re-opens the delayed-rewake resurrection.
    expect(INCOMING_TOMBSTONE_TTL_MS).toBeGreaterThan(INCOMING_PAYLOAD_TTL_MS);
  });

  it('every deadline is a positive finite number of milliseconds', () => {
    const all = {
      RING_TIMEOUT_MS, ACCEPT_INTENT_TTL_MS, CALL_SETUP_SEND_BUDGET_MS,
      ANSWER_DELIVERY_WATCHDOG_MS, CONNECTING_WATCHDOG_MS, TURN_FETCH_CEILING_MS,
      RECONNECT_BUDGET_MS, RESTART_RETRY_MS, DISPATCH_FRAME_TTL_MS,
      GROUP_REJOIN_CEILING_MS, GROUP_REBUILD_MARK_CEILING_MS,
      ONE_TO_ONE_LAUNCH_WATCHDOG_MS, RECENTLY_ENDED_WINDOW_MS,
      NAV_READY_WAIT_MS, INCOMING_PAYLOAD_TTL_MS, INCOMING_TOMBSTONE_TTL_MS,
      ICE_WAIT_OPEN_MS, OFFER_VERIFY_DEADLINE_MS,
    };
    for (const [name, v] of Object.entries(all)) {
      expect(`${name}=${v}`).toBe(`${name}=${Math.trunc(v)}`);
      expect(v).toBeGreaterThan(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.3 — the owning modules use the shared constant, not a copy', () => {
  /**
   * This is the half that actually prevents drift. The ordering assertions
   * above only protect the numbers this module owns; if a consumer keeps its
   * own literal, that consumer can drift while every assertion here stays
   * green — which is precisely the shape of the bug being fixed.
   *
   * Comment lines are stripped so the prose EXPLAINING a number never counts
   * as a use of it, and the scan is `\r?\n`-safe because these files are CRLF.
   */
  const codeOf = (rel: string): string =>
    read(...rel.split('/'))
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it.each([
    ['src/modules/messenger/webrtc/callController.ts',   'callDeadlines'],
    ['src/modules/messenger/webrtc/callRingState.ts',    'callDeadlines'],
    ['src/modules/messenger/webrtc/signallingClient.ts', 'callDeadlines'],
    ['src/modules/messenger/webrtc/callDispatcher.ts',   'callDeadlines'],
    ['src/modules/messenger/webrtc/launchCall.ts',       'callDeadlines'],
    ['src/modules/messenger/runtime/callRegistry.ts',    'callDeadlines'],
    ['src/screens/messenger/CallScreen.tsx',             'callDeadlines'],
    // Review round 3 — useGroupCall declared its OWN `RECONNECT_BUDGET_MS =
    // 30_000`, and that literal carries the proof that `onBudgetExpiry`
    // terminates (a rebuild can defer the expiry by at most one window only
    // because GROUP_REBUILD_MARK_CEILING_MS <= the budget). With it inlined,
    // this scan could not see it and the two could silently diverge — at which
    // point a stuck rebuild defers the budget forever and the call can never
    // fail. Exactly the drift shape this block exists to catch, in a file it
    // was not watching.
    ['src/modules/messenger/webrtc/useGroupCall.ts',      'callDeadlines'],
    // WI-4.8 — the push layer joined the system: the payload/tombstone TTLs
    // and the cold-launch nav wait were private literals that had already
    // drifted out of alignment with the ring window (60 s TTL < 45 s ring +
    // 20 s nav wait — the late-answer starvation).
    ['src/modules/messenger/push/incomingCallCache.ts',   'callDeadlines'],
    ['src/modules/messenger/push/fcmBootstrap.ts',        'callDeadlines'],
  ])('%s imports from the shared module', (file, marker) => {
    expect(codeOf(file as string)).toContain(marker as string);
  });

  it('no owning module still defines its own copy of a shared deadline', () => {
    // The literal `= 45_000` / `= 40_000` / … shapes these constants used to
    // have. Finding one again means a value was re-inlined and the ordering
    // pins above no longer describe reality.
    const OWNERS: Array<[string, RegExp]> = [
      ['src/modules/messenger/webrtc/callController.ts',   /[=]\s*(20_000|50_000|30_000|4_000)\s*;/],
      ['src/modules/messenger/webrtc/callRingState.ts',    /[=]\s*45_000\s*;/],
      ['src/modules/messenger/webrtc/signallingClient.ts', /[=]\s*40_000\s*;/],
      ['src/modules/messenger/webrtc/callDispatcher.ts',   /[=]\s*30_000\s*;/],
      ['src/modules/messenger/webrtc/launchCall.ts',       /[=]\s*10_000\s*;/],
      ['src/modules/messenger/runtime/callRegistry.ts',    /[=]\s*2\s*\*\s*60\s*\*\s*1000\s*;/],
      ['src/modules/messenger/webrtc/useGroupCall.ts',      /const RECONNECT_BUDGET_MS\s*=\s*30_000\s*;/],
      // WI-4.8 — the shapes the push layer's literals had before promotion.
      ['src/modules/messenger/push/incomingCallCache.ts',   /[=]\s*(60|90|150)\s*\*\s*1000\s*;/],
      ['src/modules/messenger/push/fcmBootstrap.ts',        /Date\.now\(\)\s*-\s*t0\s*<\s*20000|waitReady\(20000\)/],
    ];
    const offenders: string[] = [];
    for (const [file, re] of OWNERS) {
      const code = codeOf(file);
      if (re.test(code)) {offenders.push(`${file} still inlines ${re}`);}
    }
    expect(offenders).toEqual([]);
  });

  it('POSITIVE CONTROL — the scanner can actually see these files', () => {
    // `toEqual([])` above is absence-only: a rotted path or a broken filter
    // would certify an empty set having read nothing.
    const probe = codeOf('src/modules/messenger/webrtc/callDeadlines.ts');
    expect(probe.length).toBeGreaterThan(500);
    expect(probe).toContain('RING_TIMEOUT_MS');
  });
});
