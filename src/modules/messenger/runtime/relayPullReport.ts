/**
 * B-703 MR-1 — the killed-app wake's honesty contract.
 *
 * Why: `pullEnvelopes` catches every drain error and resolves anyway, so
 * `headlessDrainAndNotify` reported 'drained' for a pull that FAILED outright,
 * and for one that left every envelope sitting on the relay. fcmHeadless then
 * retired the "Checking for new messages" placeholder and returned WITHOUT
 * posting the fallback banner - total silence for a real message, logged as
 * success. The server sends ONE wake per message, so nothing retried it; the
 * message surfaced only on the next wake or the next app open.
 *
 * Both live classes land in that hole: an identity-regen peer takes
 * `LeaveOnRelayError` (B-701, seen on the founder's device as `drain first-msg
 * leave-on-relay`) and the nested-txn residue takes the transient-sql branch.
 * Neither acks, so neither is ingested, and both used to report 'drained'.
 *
 * ACCOUNTING BY ID, NOT BY COUNT. A drain page that does not fill its limit
 * re-pulls the SAME envelopes on the next iteration (the cursor deliberately
 * does not advance, and acks flush on a 200 ms timer), so plain counters
 * inflate by up to 10x - and the probe these numbers feed is meant to be read
 * off a device. Worse, deduping only one counter would let a re-acked envelope
 * cancel out a genuinely stuck one and report a clean drain. Sets make the
 * result idempotent: `leftOnRelay` is the set of ids that were pulled and
 * neither acked nor held by a concurrent pass, which is exactly the set of
 * envelopes this drain did not ingest.
 */

export interface RelayPullReport {
  /**
   * false = nothing can be concluded from this pull: it threw, or no drain
   * actually ran (epoch bail). Callers must treat it as "not ingested".
   */
  ok: boolean;
  /** Distinct envelopes the relay handed us across every page of this drain. */
  pulled: number;
  /** Distinct envelopes whose fate was decided and acked (delivered/discarded). */
  acked: number;
  /** Distinct envelopes a concurrent pass already held - that pass owns them. */
  skipped: number;
  /** Distinct envelopes left on the relay for a later retry: NOT ingested. */
  leftOnRelay: number;
}

/** What the killed-app lane should do about a finished pull. */
export type PullDrainVerdict = 'drained' | 'incomplete' | 'failed';

export function failedPullReport(): RelayPullReport {
  return {ok: false, pulled: 0, acked: 0, skipped: 0, leftOnRelay: 0};
}

/** A completed drain with nothing to do (loopback, or an empty relay queue). */
export function emptyPullReport(): RelayPullReport {
  return {ok: true, pulled: 0, acked: 0, skipped: 0, leftOnRelay: 0};
}

export function pullReportFromIds(ids: {
  pulled: ReadonlySet<string>;
  acked: ReadonlySet<string>;
  skipped: ReadonlySet<string>;
}): RelayPullReport {
  let leftOnRelay = 0;
  for (const id of ids.pulled) {
    // Acked wins over skipped: an envelope held by a concurrent pass on one
    // iteration and acked on the next WAS ingested, not left behind.
    if (!ids.acked.has(id) && !ids.skipped.has(id)) {leftOnRelay += 1;}
  }
  return {
    ok:      true,
    pulled:  ids.pulled.size,
    acked:   ids.acked.size,
    skipped: ids.skipped.size,
    leftOnRelay,
  };
}

/**
 * The ONE rule that turns a pull report into a killed-lane outcome.
 *
 * A missing report (no `pullEnvelopes` on the runtime, or a `void` return from
 * a degraded build) is 'failed' on purpose: nothing was ingested, so the wake
 * owes the user its fallback banner. That case used to report 'drained'.
 *
 * 'incomplete' is deliberately NOT conditioned on how much the drain DID
 * ingest. An earlier cut required `acked === 0` to stop a muted thread's wake
 * from posting the unmutable generic fallback - but silently-acked traffic is
 * routine (an `alreadySeen` redelivery, a reaction, and above all the
 * rehandshake nudge that the leave-on-relay path itself sends), so one such
 * envelope alongside the stuck one restored the original silence in exactly the
 * B-701 population this exists to fix. The muted case belongs to the CALLER,
 * which asks the notifier whether it reached a verdict; "how many envelopes
 * acked" was never a proxy for that.
 */
export function classifyPullReport(report: RelayPullReport | null | undefined | void): PullDrainVerdict {
  if (!report || report.ok !== true) {return 'failed';}
  if (report.leftOnRelay > 0) {return 'incomplete';}
  return 'drained';
}
