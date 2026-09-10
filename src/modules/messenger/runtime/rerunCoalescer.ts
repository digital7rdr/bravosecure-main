/**
 * OR-4 — single-flight coalescer WITH a re-run latch.
 *
 * Why: a plain mutex implements mutual exclusion but not edge retention — a
 * trigger that lands inside the critical section is absorbed into a pass that
 * is already committed to a dead route. This keeps the single-flight property
 * but remembers that a trigger arrived and runs one more (bounded) pass when
 * the current one settles.
 *
 * OR-2 — optional wall-clock ownership. A run whose relay POST abort timer is
 * frozen by a locked screen never settles, so a bare in-flight latch would
 * swallow every later trigger for the whole lock (the same trap
 * maybeRenewSocketAuth's REAUTH_STUCK_MS guards against). With `stuckMs` set,
 * a trigger arriving after `stuckMs` of no progress SUPERSEDES the wedged run:
 * a fresh pass starts, and the old run learns it lost the slot through
 * `ctx.superseded()` (callers should bail at their next unit of progress).
 * `ctx.heartbeat()` refreshes the liveness stamp so a long queue of
 * slow-but-alive rows is never mistaken for a wedge.
 */

/** Extra passes a latched trigger may schedule (total passes = this + 1). */
export const MAX_COALESCER_RERUNS = 2;

export interface CoalescerRunCtx {
  /** OR-2 — refresh the in-flight run's liveness stamp (call per unit of progress). */
  heartbeat(): void;
  /** OR-2 — true once a stuck-window takeover superseded this run. */
  superseded(): boolean;
}

export function createRerunCoalescer(
  run: (ctx: CoalescerRunCtx) => Promise<void>,
  maxReruns: number = MAX_COALESCER_RERUNS,
  stuckMs?: number,
): () => Promise<void> {
  let inflight: Promise<void> | null = null;
  let rerunRequested = false;
  let seq = 0;
  let owner = 0;
  let heartbeatAt = 0;

  return (): Promise<void> => {
    if (inflight) {
      if (stuckMs !== undefined && Date.now() - heartbeatAt >= stuckMs) {
        // OR-2 — the in-flight run made no progress for the whole stuck
        // window: take the slot. The old run's finally can no longer release
        // the NEW inflight (identity check below), and it self-cancels at
        // its next ctx.superseded() probe.
        inflight = null;
        rerunRequested = false;
      } else {
        rerunRequested = true;
        return inflight;
      }
    }
    const me = ++seq;
    owner = me;
    heartbeatAt = Date.now();
    const ctx: CoalescerRunCtx = {
      heartbeat: () => {
        if (owner === me) {heartbeatAt = Date.now();}
      },
      superseded: () => owner !== me,
    };
    let myPromise: Promise<void>;
    const pump = async (): Promise<void> => {
      let lastErr: unknown = null;
      let lastFailed = false;
      try {
        for (let pass = 0; pass <= maxReruns; pass++) {
          if (owner !== me) {break;}
          rerunRequested = false;
          lastErr = null;
          lastFailed = false;
          try {
            await run(ctx);
          } catch (e) {
            lastErr = e;
            lastFailed = true;
          }
          if (!rerunRequested) {break;}
        }
      } finally {
        // Why: the slot must be released BEFORE the rejection is delivered, so
        // a `.catch(() => coalescer())` handler can start a fresh pass instead
        // of re-receiving the dead promise. A superseded run must not release
        // the slot its successor now owns.
        if (inflight === myPromise) {
          rerunRequested = false;
          inflight = null;
        }
      }
      if (lastFailed) {throw lastErr;}
    };
    // Why: start the pump on a microtask so `inflight` is assigned BEFORE the
    // first pass runs — otherwise a `run` that re-enters the coalescer
    // synchronously would see an empty slot and spawn an unbounded chain.
    myPromise = Promise.resolve().then(pump);
    inflight = myPromise;
    return myPromise;
  };
}
