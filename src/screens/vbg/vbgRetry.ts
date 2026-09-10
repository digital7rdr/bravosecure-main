/**
 * Transient-upstream retry for VBG fetches.
 *
 * The key-points backend (Overpass) and the threat blend (GDELT/NewsData)
 * occasionally rate-limit or time out on the first hit and succeed moments
 * later — the user-visible symptom was "not found" on first load that a
 * manual refresh fixed. This retries a fetch up to `delaysMs.length` extra
 * times, treating BOTH a rejection and an "empty" resolution (when `isEmpty`
 * is provided) as transient. A final empty answer is returned honestly.
 *
 * Pure module (no React / RN imports) so it's unit-testable in the 'app'
 * Jest project, same as vbgGeoRiskCoords.
 */
export const VBG_RETRY_DELAYS_MS: readonly number[] = [1500, 3000];

export interface RetryTransientOptions<T> {
  /** Backoff before each retry; its length is the number of retries. */
  delaysMs?: readonly number[];
  /** When provided, an "empty" resolution is retried like a failure. */
  isEmpty?: (value: T) => boolean;
  /** Fires just before each retry wait — drive the "Retrying…" UI here. */
  onRetry?: (attempt: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryTransientOptions<T> = {},
): Promise<T> {
  const {delaysMs = VBG_RETRY_DELAYS_MS, isEmpty, onRetry, sleep = defaultSleep} = opts;
  let lastError: unknown = new Error('retryTransient: no attempts ran');
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      onRetry?.(attempt);
      await sleep(delaysMs[attempt - 1]);
    }
    try {
      const value = await fn();
      // Why: an empty set is retried as transient, but once retries are
      // exhausted the empty answer is the honest final result — return it.
      if (isEmpty?.(value) && attempt < delaysMs.length) {continue;}
      return value;
    } catch (e) {
      lastError = e;
      if (attempt === delaysMs.length) {throw e;}
    }
  }
  throw lastError;
}
