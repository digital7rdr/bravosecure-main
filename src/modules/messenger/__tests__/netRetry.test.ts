/**
 * W1/B-313 — restore must TOLERATE low network, not merely survive it.
 *
 * Device evidence (Pixel 6a, 2026-07-27 22:36–22:37): one timed-out fetch
 * aborted the whole restore run into a hard banner needing a manual RETRY —
 * three times on LTE until the founder switched to Wi-Fi. The cursor made the
 * retries cheap, but a dropped packet must surface NOTHING.
 *
 * `withNetRetry` wraps a single network call: retry with backoff on the
 * transport-failure class only (BackupError kind 'network' — the
 * `fetch_failed:` wrapper from backupClient), pass every other error through
 * untouched (auth/quota/integrity failures are NOT transient and must keep
 * their exact semantics — wrapping them would soften real failures).
 */
import {withNetRetry} from '../backup/netRetry';
import {BackupError} from '../backup/backupClient';

const netErr = () => new BackupError('network', 'fetch_failed:timeout');

describe('B-313 — withNetRetry', () => {
  it('passes a first-try success straight through', async () => {
    const fn = jest.fn(async () => 'ok');
    await expect(withNetRetry(fn, {delaysMs: [1, 1, 1]})).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries the network class and succeeds', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(netErr())
      .mockRejectedValueOnce(netErr())
      .mockResolvedValueOnce('ok');
    await expect(withNetRetry(fn, {delaysMs: [1, 1, 1]})).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts the delay budget and rethrows the LAST network error', async () => {
    const fn = jest.fn().mockRejectedValue(netErr());
    await expect(withNetRetry(fn, {delaysMs: [1, 1]})).rejects.toMatchObject({kind: 'network'});
    // 1 initial + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('NON-network errors pass through immediately — no retry, exact semantics kept', async () => {
    for (const err of [
      new BackupError('unauthorized', 'nope'),
      new BackupError('quota_exceeded', 'full'),
      new Error('backup.merkle_mismatch:rows_count_mismatch'),
    ]) {
      const fn = jest.fn().mockRejectedValue(err);
      await expect(withNetRetry(fn, {delaysMs: [1, 1, 1]})).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('reports each retry so callers can log a trail', async () => {
    const attempts: number[] = [];
    const fn = jest.fn()
      .mockRejectedValueOnce(netErr())
      .mockResolvedValueOnce('ok');
    await withNetRetry(fn, {delaysMs: [1, 1], onRetry: a => { attempts.push(a); }});
    expect(attempts).toEqual([1]);
  });

  it('a cancellation check stops the loop between attempts', async () => {
    const fn = jest.fn().mockRejectedValue(netErr());
    let cancelled = false;
    const p = withNetRetry(fn, {delaysMs: [1, 1, 1], isCancelled: () => cancelled});
    cancelled = true;
    await expect(p).rejects.toMatchObject({kind: 'network'});
    // First attempt ran; cancellation prevented further retries.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
