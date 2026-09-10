/**
 * B-126 (2026-07-21) — in-flight envelope registry with stale eviction.
 *
 * The WS deliver path and the HTTP drain both guard against concurrent
 * double-decrypt of the same envelope via an in-flight id set (audit
 * L16). That set assumed entries are always released by a `finally` —
 * but a wedged receive frame (the B-126 chain stall) never resolves, so
 * its ids stayed in-flight FOREVER and both paths silently skipped every
 * redelivery of those envelopes: the exact "messages strand until a cold
 * restart" the founder reported, with zero log lines.
 *
 * The registry keeps the double-decrypt guard but bounds it: an entry
 * older than STALE_MS (> the chain watchdog's force-advance deadline, so
 * the chain is unwedged first) is loudly evicted and the new attempt
 * proceeds — redelivery becomes a fresh, processable attempt instead of
 * a silent no-op. Worst case of a false eviction is one duplicate
 * decrypt attempt, which the persistent seen-envelope dedup and
 * libsignal's message-key handling already tolerate.
 */

export const INFLIGHT_STALE_MS = 150_000;

interface Hold {
  acquiredAt: number;
  token: number;
}

const inflight = new Map<string, Hold>();
let tokenSeq = 0;

export type AcquireResult = 'busy' | number;

/**
 * Returns a release token when acquired (fresh or via stale eviction),
 * or 'busy' while another LIVE attempt holds the envelope. The token
 * makes release ownership-aware: a zombie attempt's late `finally`
 * cannot release the hold a newer attempt owns.
 */
export function tryAcquireEnvelope(
  envelopeId: string,
  nowMs: number = Date.now(),
  staleMs: number = INFLIGHT_STALE_MS,
): AcquireResult {
  const hold = inflight.get(envelopeId);
  if (hold !== undefined) {
    if (nowMs - hold.acquiredAt <= staleMs) {
      return 'busy';
    }
    console.warn(
      `[messenger.inflight] envelope ${envelopeId.slice(0, 8)} stuck in-flight ${Math.round((nowMs - hold.acquiredAt) / 1000)}s — evicting stale hold and reprocessing (B-126)`,
    );
  }
  const token = ++tokenSeq;
  inflight.set(envelopeId, {acquiredAt: nowMs, token});
  return token;
}

/**
 * B-703 MR-1 — is a LIVE attempt still holding this envelope?
 *
 * The drain's report has to say whether an envelope it skipped was actually
 * ingested by the pass that held it. "Was it marked seen?" is the wrong
 * question while that pass is mid-flight: `markSeen` only commits at the end of
 * its receive txn, so a still-running WS deliver reads as "not ingested" and
 * the wake posts a generic banner that then gags the named one the WS lane is
 * about to draw. Still held ⇒ that pass owns it; released ⇒ its outcome is
 * settled and `wasSeen` is meaningful.
 *
 * Uses the same stale window as the acquire, so a wedged hold is not trusted
 * forever.
 */
export function isEnvelopeInFlight(
  envelopeId: string,
  nowMs: number = Date.now(),
  staleMs: number = INFLIGHT_STALE_MS,
): boolean {
  const hold = inflight.get(envelopeId);
  return hold !== undefined && nowMs - hold.acquiredAt <= staleMs;
}

export function releaseEnvelope(envelopeId: string, token: number): void {
  const hold = inflight.get(envelopeId);
  if (hold && hold.token === token) {
    inflight.delete(envelopeId);
  }
}

/** Logout/user-switch + test hook — a new owner starts with a clean slate. */
export function resetInflightRegistry(): void {
  inflight.clear();
}
