/**
 * B-692 NL-7 — which message ids arrived LIVE while their chat was open.
 *
 * The bubble entrance animation used to key on `created_at` being under 2 s
 * old, so any message the pipeline delivered late (server debounce, drain,
 * receive-chain backlog) popped in with no animation — read as "janky". The
 * real question is not "was it sent recently" but "did it just appear in the
 * open chat", which only the screen's own render diff can answer: ChatScreen
 * marks ids that show up after its baseline render, and the bubble consults
 * this registry when it decides its entrance (first render only, so entries
 * need no cleanup beyond the TTL/bound below).
 *
 * The per-commit cap keeps bulk deliveries honest: a drain/backfill that lands
 * a pile of rows in one commit pops in without animation, exactly as before.
 */
const LIVE_ARRIVAL_TTL_MS = 10_000;
const MAX_MARK_PER_COMMIT = 3;
const MAX_ENTRIES = 200;
const liveArrivals = new Map<string, number>();

export function markLiveArrivals(newIds: readonly string[]): void {
  if (newIds.length === 0 || newIds.length > MAX_MARK_PER_COMMIT) {return;}
  const now = Date.now();
  if (liveArrivals.size > MAX_ENTRIES) {
    for (const [k, t] of liveArrivals) {
      if (now - t >= LIVE_ARRIVAL_TTL_MS) {liveArrivals.delete(k);}
    }
  }
  for (const id of newIds) {liveArrivals.set(id, now);}
}

/** True while the entry is fresh — a bubble mounting later than the TTL is a
 *  scroll-back or re-mount, not the arrival itself. */
export function isLiveArrival(id: string): boolean {
  const t = liveArrivals.get(id);
  return t !== undefined && Date.now() - t < LIVE_ARRIVAL_TTL_MS;
}

/** Test seam — the registry is module state. */
export function _resetLiveArrivalsForTest(): void {
  liveArrivals.clear();
}
