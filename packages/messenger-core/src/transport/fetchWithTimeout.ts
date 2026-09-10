/**
 * SN-01 — bound every transport HTTP request with an AbortController deadline.
 *
 * React Native's Android stack (OkHttp) is configured with no read timeout, so
 * a black-holed connection — routine on a 2G handover, a NAT rebind, or Wi-Fi
 * with a dead upstream — leaves `fetch` pending for minutes rather than
 * failing. On the send path that stalls a message in 'sending' with no failure
 * transition, and because `drainOutbox` iterates serially behind a single
 * inflight guard, one hung request freezes every queued retry to every peer.
 *
 * The same reasoning already produced the H-14 fix in `backupClient.ts`; the
 * send transport was the last layer left unbounded.
 *
 * An abort surfaces as a normal rejection, so existing callers treat it as a
 * transient failure (recordAttempt + backoff). Server-side `(recipient,
 * clientMsgId)` dedup makes retry-after-timeout safe.
 */
export const TRANSPORT_TIMEOUT_MS = 20_000;

/**
 * Wraps `fetch` with a hard deadline. `timeoutMs` is a wall-clock cap on the
 * whole exchange (headers + body), which is the correct shape for the small
 * JSON payloads this transport carries. Do NOT reuse this for blob transfers —
 * those need progress-aware inactivity watchdogs instead (see mediaClient).
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = TRANSPORT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

/** True when a rejection came from `fetchWithTimeout` aborting the request. */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
