/**
 * OM-07 — how long one outbox sweep may run, and when to abandon it.
 *
 * Kept in its own tiny module (no native/runtime imports) so the decision can be
 * unit-tested without standing up the messenger runtime — same rationale as
 * `outboxCertFreshness.ts`.
 *
 * Background: `drainOutbox` ships rows SERIALLY behind a single inflight guard,
 * and a black-holed route makes each `relay.send` hang for the full SN-01 20s
 * transport deadline. With N queued rows that is N x 20s of radio-on time per
 * 60s sweep, and the sweep restarts the moment it ends.
 */

/**
 * Wall-clock budget for one sweep. Half the 60s sweep interval, so a truncated
 * sweep still ends before the next tick. Checked BETWEEN rows, so one in-flight
 * row may overrun it by up to the transport deadline — a soft bound by design;
 * aborting a row mid-flight would risk a duplicate the relay's (recipient,
 * clientMsgId) dedup already covers but the UI does not.
 */
export const OUTBOX_DRAIN_BUDGET_MS = 30_000;

/**
 * Consecutive unreachable failures after which the sweep gives up: the network
 * is down, not the peer, so every remaining row would pay the same 20s. Two
 * rather than one so a single flaky row cannot abort a sweep that would
 * otherwise deliver.
 */
export const OUTBOX_DRAIN_UNREACHABLE_STREAK = 2;

export type DrainStop = 'continue' | 'budget' | 'unreachable';

export function shouldStopDrain(
  state: {startedAtMs: number; unreachableStreak: number},
  nowMs: number = Date.now(),
): DrainStop {
  if (state.unreachableStreak >= OUTBOX_DRAIN_UNREACHABLE_STREAK) {return 'unreachable';}
  if (nowMs - state.startedAtMs >= OUTBOX_DRAIN_BUDGET_MS) {return 'budget';}
  return 'continue';
}
