import {waitForGroupCallKey} from '@/modules/messenger/webrtc/groupCallKeyWait';

/**
 * BS-CALL-KEY-RECOVER — the joiner's SFrame-key wait must recover a call
 * whose key envelope is in-flight (arrives late) instead of hard-failing
 * at a too-short deadline, WITHOUT relaxing the fail-closed gate.
 *
 * The motivating "Call failed" symptom: the key envelope (sealed Signal
 * relay) and the sfu.ring (WS) travel separate paths, so a cold-wake
 * joiner can have the key land 10-20 s after accepting — past the old 8 s
 * ceiling, which then abandoned the whole call even though the key was
 * moments away. These tests pin the four outcomes of the pure wait helper.
 *
 * SECURITY INVARIANT under test: a genuinely-absent key after the window
 * yields 'timeout' (caller fails closed → no media, never plaintext, per
 * ARCHITECTURE_AMENDMENT_SFRAME). The helper never reports 'ready' without
 * `hasKey()` actually being true.
 */

describe('waitForGroupCallKey — BS-CALL-KEY-RECOVER', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  // Minimal store-subscription fake: callbacks fire when we call notify().
  function makeStore(initialKey: boolean) {
    let key = initialKey;
    const listeners = new Set<() => void>();
    return {
      hasKey: () => key,
      subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      setKey: (v: boolean) => { key = v; for (const cb of Array.from(listeners)) {cb();} },
      listenerCount: () => listeners.size,
    };
  }

  it('resolves ready IMMEDIATELY when the key is already present (no timers armed)', async () => {
    const store = makeStore(true);
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => false,
    });
    await expect(p).resolves.toBe('ready');
  });

  it('resolves ready when the key arrives LATE, inside the window', async () => {
    const store = makeStore(false);
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => false,
      timeoutMs: 25_000,
    });
    // Key lands at t=18s — past the old 8s ceiling, within the new window.
    jest.advanceTimersByTime(18_000);
    store.setKey(true);
    await expect(p).resolves.toBe('ready');
  });

  it('FAILS CLOSED (timeout) when the key never arrives within the window', async () => {
    const store = makeStore(false);
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => false,
      timeoutMs: 25_000,
    });
    jest.advanceTimersByTime(25_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('resolves cancelled immediately when already cancelled at entry', async () => {
    const store = makeStore(false);
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => true,
    });
    await expect(p).resolves.toBe('cancelled');
  });

  it('breaks out with cancelled when teardown happens mid-wait (via poll)', async () => {
    const store = makeStore(false);
    let cancelled = false;
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => cancelled,
      timeoutMs: 25_000, pollMs: 250,
    });
    cancelled = true;            // user hit End; no store change fires
    jest.advanceTimersByTime(250); // next cancel-poll tick observes it
    await expect(p).resolves.toBe('cancelled');
  });

  it('ready wins over cancelled if the key lands in the same wake', async () => {
    const store = makeStore(false);
    let cancelled = false;
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => cancelled,
    });
    // Both become true, then a store change fires: having the key is never
    // the wrong outcome, so we proceed rather than abandon.
    cancelled = true;
    store.setKey(true);
    await expect(p).resolves.toBe('ready');
  });

  it('unsubscribes and clears timers on settle (no leak)', async () => {
    const store = makeStore(false);
    const p = waitForGroupCallKey({
      hasKey: store.hasKey, subscribe: store.subscribe, isCancelled: () => false,
      timeoutMs: 25_000,
    });
    expect(store.listenerCount()).toBe(1);
    store.setKey(true);
    await expect(p).resolves.toBe('ready');
    expect(store.listenerCount()).toBe(0);
    // No remaining timers — fast-forward must not throw or fire anything.
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
  });
});
