/**
 * SN-01 — every transport HTTP request must be bounded by a deadline.
 *
 * Why: React Native's Android stack (OkHttp) is configured with no read
 * timeout, so a black-holed connection leaves `fetch` pending for minutes.
 * On the send path that stalls a message in 'sending' with no failure
 * transition, and because `drainOutbox` iterates serially behind a single
 * inflight guard, one hung request froze every queued retry to every peer.
 *
 * INVARIANTS under test:
 *   1. A request that never settles is aborted at TRANSPORT_TIMEOUT_MS.
 *   2. A request that settles normally is returned untouched and its timer is
 *      cleared — a late abort must never fire against a completed request.
 *   3. The abort is observable as an AbortError so callers can classify it as
 *      a transient failure (recordAttempt + backoff) rather than a hard error.
 *   4. The real send-path clients (relay/keys/sender-cert) actually pass an
 *      AbortSignal — a helper nobody wires up fixes nothing.
 */

import {
  fetchWithTimeout,
  isTimeoutError,
  TRANSPORT_TIMEOUT_MS,
} from '../src/transport/fetchWithTimeout';

describe('fetchWithTimeout — SN-01 unbounded-request guard', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts a request that never settles, at the documented deadline', async () => {
    jest.useFakeTimers();

    // A fetch that only ever settles when its signal aborts — i.e. the
    // black-holed connection this guard exists for.
    global.fetch = jest.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), {name: 'AbortError'})),
        );
      }),
    ) as unknown as typeof fetch;

    const pending = fetchWithTimeout('https://relay.test/envelopes', {method: 'POST'});
    // Attach the assertion before advancing so the rejection is never unhandled.
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});

    jest.advanceTimersByTime(TRANSPORT_TIMEOUT_MS);
    await assertion;
  });

  it('does NOT abort before the deadline', async () => {
    jest.useFakeTimers();
    let aborted = false;

    global.fetch = jest.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('Aborted'), {name: 'AbortError'}));
        });
      }),
    ) as unknown as typeof fetch;

    const pending = fetchWithTimeout('https://relay.test/envelopes');
    // Attach the handler up front: this promise is expected to reject once we
    // cross the deadline below, and an unhandled rejection would leak.
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});

    jest.advanceTimersByTime(TRANSPORT_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(aborted).toBe(false);

    // Settle the request so no timer or pending promise outlives the test.
    jest.advanceTimersByTime(1);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('returns a normal response and clears the timer so no late abort fires', async () => {
    jest.useFakeTimers();
    let aborted = false;

    const ok = {ok: true, status: 200} as Response;
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return Promise.resolve(ok);
    }) as unknown as typeof fetch;

    await expect(fetchWithTimeout('https://relay.test/ping')).resolves.toBe(ok);

    // Long past the deadline: a leaked timer would abort a finished request.
    jest.advanceTimersByTime(TRANSPORT_TIMEOUT_MS * 5);
    expect(aborted).toBe(false);
  });

  it('honours an explicit per-call timeout', async () => {
    jest.useFakeTimers();

    global.fetch = jest.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), {name: 'AbortError'})),
        );
      }),
    ) as unknown as typeof fetch;

    const pending = fetchWithTimeout('https://relay.test/slow', {}, 1_000);
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});

    jest.advanceTimersByTime(1_000);
    await assertion;
  });

  it('classifies an abort as a timeout, and other failures as not', () => {
    expect(isTimeoutError(Object.assign(new Error('Aborted'), {name: 'AbortError'}))).toBe(true);
    expect(isTimeoutError(new Error('Network request failed'))).toBe(false);
    expect(isTimeoutError('not-an-error')).toBe(false);
  });
});

describe('send-path clients actually pass an AbortSignal — SN-01 wiring', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it('RelayHttpClient.send issues a request carrying a signal', async () => {
    const seen: Array<RequestInit | undefined> = [];
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve({
        status: 200,
        ok: true,
        text: () => Promise.resolve(JSON.stringify({envelopeId: 'e1'})),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const {RelayHttpClient} = await import('../src/transport/relayClient');
    const relay = new RelayHttpClient({
      baseUrl: 'https://relay.test',
      getToken: async () => 'tok',
      signalDeviceId: 1,
    });

    await relay.send({
      recipient:   {userId: 'u2', deviceId: 1},
      outerSealed: 'AAAA',
      clientMsgId: 'cm1',
    });

    expect(seen.length).toBeGreaterThan(0);
    // The whole point of SN-01: no request leaves this layer unbounded.
    expect(seen[0]?.signal).toBeDefined();
  });
});
