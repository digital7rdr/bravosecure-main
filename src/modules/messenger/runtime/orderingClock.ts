/**
 * OM-02 — ordering timestamp for an inbound message row.
 *
 * The transcript sorts strictly on `created_at` (messengerStore.appendMessage
 * binary-splices on it) and inbound rows take that value from the SENDER's wall
 * clock (`aad.ts`). `verifySealedAad` deliberately accepts up to 24h of future
 * skew (SEALED_AAD_FUTURE_MS, audit MEDIUM-1) so a mis-set clock cannot destroy
 * messages — which leaves a fast-clocked peer able to pin its rows at the bottom
 * of the thread while every later reply splices ABOVE the question.
 *
 * This module is DISPLAY-ONLY. Its output feeds `LocalMessage.created_at` and
 * nothing else: never `verifySealedAad`, never the seen-envelope set, never
 * `expires_at`. The AAD accept windows in
 * `packages/messenger-core/src/crypto/sealedSender.ts` are untouched.
 */

/**
 * Tolerance before the sender's stamp is treated as impossible rather than
 * merely imprecise. Covers seal→submit latency (a couple of RTTs) plus ordinary
 * NTP jitter; anything beyond it is a mis-set clock, not a slow network.
 */
export const ORDERING_FUTURE_SKEW_MS = 2 * 60 * 1000;

/**
 * `refTsMs` must be an UPPER BOUND on when the message can have existed — the
 * relay's accept time (`ServerEnvelopeDeliver.data.timestamp` /
 * `RelayEnvelope.timestamp`) on the live paths, or our own receive time for a
 * stashed row drained later.
 */
export function orderingTsMs(aadTsMs: number | undefined, refTsMs: number | undefined): number {
  const ref =
    typeof refTsMs === 'number' && Number.isFinite(refTsMs) && refTsMs > 0 ? refTsMs : Date.now();
  if (typeof aadTsMs !== 'number' || !Number.isFinite(aadTsMs) || aadTsMs <= 0) {
    return ref;
  }
  // Why: the reference bounds the FUTURE only. A store-and-forwarded or
  // outbox-queued envelope is legitimately much OLDER than the reference
  // (MSG-01 / L18) and must keep its send time or the drain ordering fixes
  // those audits shipped are undone.
  return aadTsMs > ref + ORDERING_FUTURE_SKEW_MS ? ref : aadTsMs;
}

export function orderingCreatedAt(
  aadTsMs: number | undefined,
  refTsMs: number | undefined,
): string {
  return new Date(orderingTsMs(aadTsMs, refTsMs)).toISOString();
}
