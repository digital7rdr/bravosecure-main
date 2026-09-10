/**
 * W1/B-313 — transport-failure retry for the backup walks.
 *
 * Device evidence (2026-07-27): one timed-out page fetch aborted the whole
 * restore into a hard banner needing a manual RETRY — three times on LTE.
 * Every network hop in the restore/heal walks now rides through this wrapper:
 * a dropped packet retries with backoff and surfaces NOTHING; only sustained
 * failure escapes to the caller (where the runner's quiet auto-resume takes
 * over — the banner is the LAST resort, not the first).
 *
 * Scope discipline: ONLY the transport-failure class retries (BackupError
 * kind 'network' — backupClient's `fetch_failed:` wrapper). Auth, quota and
 * integrity failures pass through byte-identically on the first throw —
 * wrapping those would soften real failures into "try again later".
 */
import {BackupError} from './backupClient';

const DEFAULT_DELAYS_MS = [2_000, 8_000, 30_000];

function isNetworkFailure(e: unknown): boolean {
  return e instanceof BackupError && e.kind === 'network';
}

export async function withNetRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    delaysMs?: number[];
    isCancelled?: () => boolean;
    onRetry?: (attempt: number, err: Error) => void;
  },
): Promise<T> {
  const delays = opts?.delaysMs ?? DEFAULT_DELAYS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      if (opts?.isCancelled?.()) {break;}
      // ±25% jitter so many clients recovering together don't stampede.
      const base = delays[attempt - 1];
      const jittered = base + Math.floor((Math.random() - 0.5) * base * 0.5);
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, jittered)));
      if (opts?.isCancelled?.()) {break;}
      opts?.onRetry?.(attempt, lastErr as Error);
    }
    try {
      return await fn();
    } catch (e) {
      if (!isNetworkFailure(e)) {throw e;}
      lastErr = e;
    }
  }
  throw lastErr;
}
