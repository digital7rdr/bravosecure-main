/**
 * Audit Rev2 API-05 — one deadline-bounded fetch for auth-service.
 *
 * Node's global `fetch` has NO default request timeout, so a server that accepts
 * the connection and then stalls holds our promise for ~5 minutes and saturates
 * the connection pool. The news services already pass `AbortSignal.timeout(...)`;
 * this centralises the pattern so the payment, geo and attestation paths get the
 * same bound WITHOUT a ninth inline copy (auth-service cannot import
 * `@bravo/messenger-core`, which has the equivalent helper — the duplicate-copy
 * bug class this repo keeps hitting).
 *
 * Returns the `Response`; the caller still checks `res.ok`. On a deadline it
 * REJECTS — with either an `AbortError` (when a caller signal aborts) or a
 * `TimeoutError` (from `AbortSignal.timeout`). The two names differ, and the
 * existing news classifier only tested `AbortError`; use {@link isDeadlineError}
 * to recognise BOTH.
 */
export async function fetchWithDeadline(
  input: string | URL,
  init: (RequestInit & {deadlineMs?: number}) = {},
): Promise<Response> {
  const {deadlineMs = 10_000, signal, ...rest} = init;
  const timeout = AbortSignal.timeout(deadlineMs);
  // Compose the caller's signal (a shared budget, e.g. Mapbox keyPoints) with
  // our per-request deadline so either can cancel — whichever fires first wins.
  // AbortSignal.any lands in Node 18.17 / 20.3; the root `engines` allows >=18,
  // so fall back to the deadline alone on an older runtime rather than throwing.
  let composed: AbortSignal = timeout;
  if (signal) {
    composed = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
  }
  return fetch(input, {...rest, signal: composed});
}

/**
 * True for a deadline/abort rejection from either primitive:
 *   - `AbortController.abort()`  → DOMException name 'AbortError'
 *   - `AbortSignal.timeout(ms)`  → DOMException name 'TimeoutError'
 * Map these to a 503 (dependency unavailable), distinct from a 402 decline or a
 * 500 our-bug.
 */
export function isDeadlineError(e: unknown): boolean {
  const name = (e as {name?: string} | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
