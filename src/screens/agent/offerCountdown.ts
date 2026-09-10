/**
 * offerCountdown (BUILD_RUNBOOK Step 20) — pure helpers for the incoming-offer countdown
 * ring. CRITICAL: the countdown binds to the SERVER `expires_at`, never a local 0-start
 * timer, so every agency device (and the cascade) agrees on the deadline. Pure → unit-tested.
 */
export const OFFER_TTL_SECONDS = 30; // matches dispatch.service OFFER_TTL_SECONDS

/** Whole seconds left until the offer expires (never negative). */
export function offerRemainingSeconds(expiresAt: string, nowMs: number): number {
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(ms)) {return 0;}
  return Math.max(0, Math.round(ms / 1000));
}

/** Fraction of the window remaining, 0..1 (drives the ring sweep). Assumes the standard
 *  TTL since the coarse offer carries only `expires_at`; a small clock skew just rounds. */
export function offerProgress(expiresAt: string, nowMs: number, ttlSeconds = OFFER_TTL_SECONDS): number {
  if (ttlSeconds <= 0) {return 0;}
  return Math.max(0, Math.min(1, offerRemainingSeconds(expiresAt, nowMs) / ttlSeconds));
}

/** True once the offer deadline has passed. */
export function offerExpired(expiresAt: string, nowMs: number): boolean {
  return offerRemainingSeconds(expiresAt, nowMs) <= 0;
}
