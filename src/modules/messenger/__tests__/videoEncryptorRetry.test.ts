import {
  armVideoEncryptorRetry,
  VIDEO_ENCRYPTOR_WAIT_NOTICE,
} from '@/modules/messenger/webrtc/groupCallKeyWait';

/**
 * B-07 — tapping "turn camera on" before the SFrame encryptor (group master
 * key) has landed used to refuse SILENTLY: the producer was closed, the track
 * stopped, and nothing surfaced to the user. This pins the new behavior:
 *
 *   - no encryptor  ⇒ surface ONE visible notice + arm exactly ONE retry
 *   - encryptor lands later ⇒ the retry fires exactly once
 *   - encryptor already present ⇒ NO notice, NO retry (caller just proceeds)
 *
 * SECURITY INVARIANT under test: the helper NEVER enables video itself — it
 * only re-invokes the caller's guarded toggle, and only on 'ready' while the
 * call is still live. A timeout / cancellation must NOT fire the retry, so the
 * no-plaintext-video gate in toggleVideo stays intact.
 */
describe('armVideoEncryptorRetry — B-07', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  function makeStore(initial: boolean) {
    let present = initial;
    const listeners = new Set<() => void>();
    return {
      hasEncryptor: () => present,
      subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
      set: (v: boolean) => { present = v; for (const cb of Array.from(listeners)) {cb();} },
      listenerCount: () => listeners.size,
    };
  }

  function makeArm() {
    let armed = false;
    return { isArmed: () => armed, setArmed: (v: boolean) => { armed = v; } };
  }

  it('surfaces a visible notice and arms exactly one retry when the encryptor is absent', () => {
    const store = makeStore(false);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();

    const result = armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });

    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(VIDEO_ENCRYPTOR_WAIT_NOTICE);
    expect(retry).not.toHaveBeenCalled();   // not yet — key hasn't landed
    expect(store.listenerCount()).toBe(1);  // one subscription armed
  });

  it('fires the retry exactly once when the encryptor arrives later', async () => {
    const store = makeStore(false);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();

    armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });

    store.set(true);                 // encryptor lands
    await Promise.resolve();         // flush the .then() chain
    await Promise.resolve();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(arm.isArmed()).toBe(false);     // disarmed after firing
    expect(store.listenerCount()).toBe(0); // wait cleaned up its subscription
  });

  it('does NOT surface a notice or arm a retry when the encryptor is already present', () => {
    const store = makeStore(true);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();

    const result = armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });

    expect(result).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(arm.isArmed()).toBe(false);
  });

  it('repeated taps while already armed do not stack subscriptions or extra notices', () => {
    const store = makeStore(false);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();

    const first = armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });
    const second = armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);            // no-op while armed
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.listenerCount()).toBe(1); // only one subscription
  });

  it('does NOT fire the retry when the call is torn down before the key lands (fails closed)', async () => {
    const store = makeStore(false);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();
    let cancelled = false;

    armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => cancelled, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
    });

    cancelled = true;                  // user hit End mid-wait
    jest.advanceTimersByTime(250);     // cancel-poll observes it
    await Promise.resolve();
    await Promise.resolve();

    expect(retry).not.toHaveBeenCalled();
    expect(arm.isArmed()).toBe(false); // re-armable later
  });

  it('does NOT fire the retry on timeout (key never arrives — fails closed)', async () => {
    const store = makeStore(false);
    const arm = makeArm();
    const notify = jest.fn();
    const retry = jest.fn();

    armVideoEncryptorRetry({
      hasEncryptor: store.hasEncryptor, subscribe: store.subscribe,
      isCancelled: () => false, notify, retry,
      isArmed: arm.isArmed, setArmed: arm.setArmed,
      timeoutMs: 25_000,
    });

    jest.advanceTimersByTime(25_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(retry).not.toHaveBeenCalled();
    expect(arm.isArmed()).toBe(false);
  });
});
