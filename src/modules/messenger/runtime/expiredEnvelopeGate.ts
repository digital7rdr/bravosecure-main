/**
 * B-316 — expiry decision for inbound disappearing payloads.
 *
 * Why: `expiresAtSec` is stamped by the SENDER's clock at send time
 * (Date.now()/1000 + ttlSeconds); the receive path compared it to the
 * RECEIVER's Date.now() with zero tolerance. With the 30 s / 5 min TTLs the
 * composer offers, a receiver clock a few minutes fast destroyed every such
 * message on arrival — silently, while the sender kept ✓✓. The grace absorbs
 * realistic device skew; a message inside the grace renders and the normal
 * burn timer takes it from there. Genuinely stale backlog (offline catch-up
 * past TTL + grace) still drops, which is the M7 behaviour this gate keeps.
 */
export const EXPIRY_CLOCK_SKEW_GRACE_MS = 5 * 60_000;

export function shouldDropExpiredPayload(
  expiresAtSec: number | undefined | null,
  nowMs: number,
  graceMs: number = EXPIRY_CLOCK_SKEW_GRACE_MS,
): boolean {
  if (!expiresAtSec) {return false;}
  return expiresAtSec * 1000 + graceMs <= nowMs;
}
