/**
 * B-703 MR-1 — the killed-app wake's honesty contract.
 *
 * The bug this pins: `headlessDrainAndNotify` reported 'drained' whenever
 * `pullEnvelopes` resolved, and `pullEnvelopes` swallows every drain error.
 * A failed fetch, and envelopes left on the relay by the identity-regen
 * (B-701 `LeaveOnRelayError`) or transient-sql branches, all reported success —
 * so fcmHeadless retired the "Checking for new messages" placeholder and
 * posted nothing. One wake per message, no retry ⇒ total silence.
 *
 * These cases are the rule in isolation; `headlessDrainNotify.test.ts` pins the
 * lane that consumes it and `relayPullReportWiring.test.ts` pins the runtime
 * bridge that produces it.
 */
import {
  classifyPullReport,
  emptyPullReport,
  failedPullReport,
  pullReportFromIds,
  type RelayPullReport,
} from '../runtime/relayPullReport';

const ids = (...v: string[]) => new Set(v);

describe('pullReportFromIds — accounting by id, so a re-pulled page is idempotent', () => {
  it('every envelope acked ⇒ nothing left behind', () => {
    const r = pullReportFromIds({pulled: ids('a', 'b'), acked: ids('a', 'b'), skipped: ids()});
    expect(r).toEqual({ok: true, pulled: 2, acked: 2, skipped: 0, leftOnRelay: 0});
  });

  it('an envelope that never acked counts as left on the relay', () => {
    // The live shape: 'b' fell through a leave-on-relay `continue` (B-701
    // first-msg recovery / transient-sql rollback).
    expect(pullReportFromIds({pulled: ids('a', 'b'), acked: ids('a'), skipped: ids()}).leftOnRelay).toBe(1);
  });

  it('an envelope held by a CONCURRENT pass is not "left behind" — that pass owns it', () => {
    expect(pullReportFromIds({pulled: ids('a', 'b'), acked: ids('a'), skipped: ids('b')}).leftOnRelay).toBe(0);
  });

  it('THE RE-PULL CASE: the same page seen twice does not inflate or cancel out', () => {
    // A short page is re-pulled with the cursor unmoved and acks still on their
    // 200 ms timer, so 'a' is acked on both passes while 'b' stays stuck. Counts
    // would read pulled=4/acked=2 and hide 'b'; ids report the truth.
    const r = pullReportFromIds({pulled: ids('a', 'b'), acked: ids('a'), skipped: ids()});
    expect(r.pulled).toBe(2);
    expect(r.acked).toBe(1);
    expect(r.leftOnRelay).toBe(1);
    expect(classifyPullReport(r)).toBe('incomplete');
  });

  it('skipped-then-acked across iterations counts as INGESTED, not left behind', () => {
    expect(pullReportFromIds({pulled: ids('a'), acked: ids('a'), skipped: ids('a')}).leftOnRelay).toBe(0);
  });

  it('an empty relay queue is a complete drain', () => {
    expect(classifyPullReport(pullReportFromIds({pulled: ids(), acked: ids(), skipped: ids()}))).toBe('drained');
    expect(classifyPullReport(emptyPullReport())).toBe('drained');
  });
});

describe('classifyPullReport — what the killed lane owes the user', () => {
  const ok = (over: Partial<RelayPullReport> = {}): RelayPullReport => ({
    ok: true, pulled: 1, acked: 1, skipped: 0, leftOnRelay: 0, ...over,
  });

  it('ingested everything ⇒ drained (the notifier has judged every row)', () => {
    expect(classifyPullReport(ok())).toBe('drained');
  });

  it('REGRESSION B-703 MR-1: anything left on the relay ⇒ incomplete', () => {
    expect(classifyPullReport(ok({pulled: 1, acked: 0, leftOnRelay: 1}))).toBe('incomplete');
  });

  it('REGRESSION (critic G1): a silently-ACKED envelope may not mask a stuck one', () => {
    // The compound that defeated an earlier cut of this fix: the leave-on-relay
    // path itself sends a rehandshake nudge, and that nudge acks without ever
    // reaching the notifier. Requiring `acked === 0` for 'incomplete' therefore
    // restored the original silence in exactly the B-701 population. Whether
    // the user still owes a signal is the CALLER's question (the notifier's
    // judged count), never "did any envelope ack".
    expect(classifyPullReport(ok({pulled: 2, acked: 1, leftOnRelay: 1}))).toBe('incomplete');
  });

  it('REGRESSION B-703 MR-1: a failed pull ⇒ failed, never drained', () => {
    expect(classifyPullReport(failedPullReport())).toBe('failed');
    expect(classifyPullReport(ok({ok: false}))).toBe('failed');
  });

  it('REGRESSION B-703 MR-1: no report at all (degraded runtime, void return) ⇒ failed', () => {
    // The old lane did `await runtime.pullEnvelopes?.()` and returned 'drained'
    // unconditionally, so a runtime with no pull method reported success.
    expect(classifyPullReport(undefined)).toBe('failed');
    expect(classifyPullReport(null)).toBe('failed');
  });

  it('skipped-but-ingested-elsewhere is drained — the concurrent pass owns it', () => {
    expect(classifyPullReport(ok({pulled: 2, acked: 1, skipped: 1, leftOnRelay: 0}))).toBe('drained');
  });

  it('failedPullReport is inert — it can never read as progress', () => {
    const r = failedPullReport();
    expect(r.ok).toBe(false);
    expect(r.pulled + r.acked + r.skipped + r.leftOnRelay).toBe(0);
  });
});
