/**
 * vbgRetry — transient-upstream self-retry for VBG key-points / threat
 * fetches. The bug: Overpass sometimes returns empty (or errors) on the
 * first hit and succeeds on a manual refresh — the client now retries
 * itself before conceding "not found".
 */
import {retryTransient, VBG_RETRY_DELAYS_MS} from '../vbgRetry';

const noWait = () => Promise.resolve();

describe('retryTransient', () => {
  it('resolves on the first try without retrying', async () => {
    const fn = jest.fn().mockResolvedValue(['kp']);
    const onRetry = jest.fn();
    await expect(retryTransient(fn, {onRetry, sleep: noWait})).resolves.toEqual(['kp']);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('THE BUG: a transient failure then success — retried, resolves', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('overpass 429'))
      .mockResolvedValueOnce(['kp']);
    const onRetry = jest.fn();
    await expect(retryTransient(fn, {onRetry, sleep: noWait})).resolves.toEqual(['kp']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  it('a transient EMPTY result is retried like a failure', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['kp']);
    await expect(
      retryTransient<string[]>(fn, {isEmpty: v => v.length === 0, sleep: noWait}),
    ).resolves.toEqual(['kp']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a genuinely-empty final answer is returned honestly after retries exhaust', async () => {
    const fn = jest.fn().mockResolvedValue([]);
    await expect(
      retryTransient<string[]>(fn, {isEmpty: v => v.length === 0, sleep: noWait}),
    ).resolves.toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1 + VBG_RETRY_DELAYS_MS.length);
  });

  it('rejects with the last error once all attempts fail', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('still down'));
    await expect(retryTransient(fn, {sleep: noWait})).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(1 + VBG_RETRY_DELAYS_MS.length);
  });

  it('waits the configured backoff before each retry', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('down'));
    const sleep = jest.fn((_ms: number) => Promise.resolve());
    await expect(retryTransient(fn, {sleep})).rejects.toThrow('down');
    expect(sleep.mock.calls.map(c => c[0])).toEqual([...VBG_RETRY_DELAYS_MS]);
  });

  it('honours custom delays (retry count follows delaysMs length)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('down'));
    const sleep = jest.fn((_ms: number) => Promise.resolve());
    await expect(retryTransient(fn, {delaysMs: [10], sleep})).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('empty mid-chain then failure rejects (does not resurface the stale empty)', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('final down'));
    await expect(
      retryTransient<string[]>(fn, {isEmpty: v => v.length === 0, sleep: noWait}),
    ).rejects.toThrow('final down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
