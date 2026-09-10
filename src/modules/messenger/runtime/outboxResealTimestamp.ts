/**
 * OM-05 — which timestamp a RE-SEALED outbox envelope carries in `aad.ts`.
 *
 * The receiver stamps `created_at` from `aad.ts` (productionRuntime receive
 * path), while the sender's bubble keeps its compose time. Re-minting
 * `Date.now()` at drain therefore left the two devices permanently disagreeing
 * on where the message belongs in the thread. The outbox already persists the
 * compose moment as `outbox.created_at`, so the drain carries it instead.
 *
 * Approved under NA-GATE-3 (2026-07-20): `SealedAad.ts` is reinterpreted from
 * "when this seal ran" to "when the sender composed this message". The clamps
 * exist because `aad.ts` is still an accept-window input: `verifySealedAad`
 * rejects `stale` beyond SEALED_AAD_MAX_AGE_MS and `future` beyond
 * SEALED_AAD_FUTURE_MS — and NEITHER bound may be widened (CLAUDE.md
 * AAD-binding stop condition). A row that outlived the window, or a device
 * whose clock jumped backwards, falls back to "now" — shipping an envelope the
 * receiver destroys is worse than shipping one ordered late.
 */

import {SEALED_AAD_MAX_AGE_MS} from '@bravo/messenger-core';

/**
 * How far inside the stale bound a carried timestamp must stay. Covers the
 * drain's own round-trip plus receiver clock skew.
 */
export const RESEAL_TS_SAFETY_MARGIN_MS = 60 * 60 * 1000;

export function resolveResealAadTs(
  composedAtMs: number | undefined,
  nowMs: number = Date.now(),
): number {
  if (typeof composedAtMs !== 'number' || !Number.isFinite(composedAtMs)) {
    return nowMs;
  }
  if (composedAtMs > nowMs) {
    return nowMs;
  }
  if (composedAtMs < nowMs - (SEALED_AAD_MAX_AGE_MS - RESEAL_TS_SAFETY_MARGIN_MS)) {
    return nowMs;
  }
  return composedAtMs;
}
