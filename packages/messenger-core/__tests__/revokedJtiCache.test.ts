import {RevokedJtiCache, REVOCATION_FRESHNESS_MS} from '../src/runtime/revokedJtiCache';
import type {SenderCertClient} from '../src/transport/senderCertClient';

/**
 * White-box coverage for the cert-revocation poll cache: success/fail-open
 * refresh, in-flight dedup, freshness boundary, and idempotent start/stop
 * timer lifecycle.
 */

function makeClient(impl: () => Promise<{jtis: string[]; asOf: number}>) {
  return {fetchRevocationList: jest.fn(impl)} as unknown as SenderCertClient & {
    fetchRevocationList: jest.Mock;
  };
}

describe('RevokedJtiCache', () => {
  it('starts empty and not fresh', () => {
    const c = new RevokedJtiCache({client: makeClient(async () => ({jtis: [], asOf: 0}))});
    expect([...c.snapshot()]).toEqual([]);
    expect(c.lastUpdatedAt).toBe(0);
    expect(c.isFresh()).toBe(false);
  });

  it('refresh() populates the set and marks fresh on success', async () => {
    const c = new RevokedJtiCache({client: makeClient(async () => ({jtis: ['a', 'b'], asOf: 1}))});
    await c.refresh();
    expect([...c.snapshot()].sort()).toEqual(['a', 'b']);
    expect(c.lastUpdatedAt).toBeGreaterThan(0);
    expect(c.isFresh()).toBe(true);
  });

  it('refresh() fails open — keeps the previous set and calls onError', async () => {
    const onError = jest.fn();
    const client = makeClient(async () => ({jtis: ['a'], asOf: 1}));
    const c = new RevokedJtiCache({client, onError});
    await c.refresh();              // seeds {a}
    const seededAt = c.lastUpdatedAt;
    client.fetchRevocationList.mockRejectedValueOnce(new Error('network'));
    await c.refresh();             // fails — must keep {a}
    expect([...c.snapshot()]).toEqual(['a']);
    expect(c.lastUpdatedAt).toBe(seededAt); // not advanced on failure
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('wraps a non-Error throw into an Error for onError', async () => {
    const onError = jest.fn();
    const client = makeClient(async () => ({jtis: [], asOf: 0}));
    client.fetchRevocationList.mockRejectedValueOnce('boom');
    const c = new RevokedJtiCache({client, onError});
    await c.refresh();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe('boom');
  });

  it('dedups concurrent refreshes into a single in-flight request', async () => {
    let resolve!: (v: {jtis: string[]; asOf: number}) => void;
    const client = makeClient(() => new Promise(r => {resolve = r;}));
    const c = new RevokedJtiCache({client});
    const p1 = c.refresh();
    const p2 = c.refresh();
    expect(client.fetchRevocationList).toHaveBeenCalledTimes(1);
    resolve({jtis: ['x'], asOf: 1});
    await Promise.all([p1, p2]);
    expect([...c.snapshot()]).toEqual(['x']);
  });

  it('isFresh() respects the REVOCATION_FRESHNESS_MS boundary', async () => {
    const c = new RevokedJtiCache({client: makeClient(async () => ({jtis: [], asOf: 0}))});
    await c.refresh();
    const t = c.lastUpdatedAt;
    expect(c.isFresh(t + REVOCATION_FRESHNESS_MS - 1)).toBe(true);
    expect(c.isFresh(t + REVOCATION_FRESHNESS_MS)).toBe(false);
  });

  describe('start/stop timer lifecycle', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('start() fires once immediately then on cadence; stop() halts; start() is idempotent', async () => {
      const client = makeClient(async () => ({jtis: [], asOf: 0}));
      const c = new RevokedJtiCache({client, intervalMs: 1000});
      c.start();
      c.start(); // idempotent — must not add a second interval
      expect(client.fetchRevocationList).toHaveBeenCalledTimes(1); // immediate
      // advanceTimersByTimeAsync flushes microtasks so each refresh's
      // in-flight dedup clears before the next interval tick fires.
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.fetchRevocationList).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1000);
      expect(client.fetchRevocationList).toHaveBeenCalledTimes(3);
      c.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(client.fetchRevocationList).toHaveBeenCalledTimes(3); // no more after stop
      c.stop(); // idempotent — no throw
    });
  });
});
