/**
 * OR-2 — the send-recovery clock.
 *
 * B-100/B-101 event-drove the CALL paths off the server's engine.io ping
 * because RN freezes JS timers while the Android host activity is paused.
 * Every MESSAGING recovery path was left on a timer: the 5-20s WS ack
 * watchdog, the 60s outbox tick, and `fetchWithTimeout`'s abort. Send +
 * lock onto a half-dead fd and nothing retries until unlock. These pure
 * helpers hold the decisions that let the outbox drain ride the same
 * always-running clock the auth renewal already uses.
 */

/**
 * Minimum gap between server-signal-driven drains. The server's engine.io
 * heartbeat is ~25s, so in the silent locked case this is effectively "one
 * drain per heartbeat"; in a busy foreground chat it coalesces the
 * per-frame signals down to the same cadence.
 */
export const SIGNAL_DRAIN_MIN_INTERVAL_MS = 20_000;

/**
 * How long a drain may go without progress before another drain is allowed
 * to supersede it. Must exceed TRANSPORT_TIMEOUT_MS (20s) with margin: a
 * single slow-but-alive relay POST is not stuck. Measured against a
 * per-ROW heartbeat, not the drain start, so a long queue of slow rows
 * never trips it.
 */
export const DRAIN_STUCK_MS = 45_000;

export function shouldDrainOnServerSignal(lastDrainAt: number, now: number): boolean {
  // Cold start (nothing drained yet this session) always drains.
  if (lastDrainAt <= 0) {return true;}
  return now - lastDrainAt >= SIGNAL_DRAIN_MIN_INTERVAL_MS;
}
