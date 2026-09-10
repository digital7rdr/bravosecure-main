/**
 * BS-CALL-KEY-RECOVER — wait for the SFrame group master key to arrive,
 * resolving the instant it's filed in the store, with a hard ceiling.
 *
 * Why this is a standalone module (vs inline in useGroupCall's boot IIFE):
 *   1. The fail-closed decision — "key present ⇒ proceed; window elapsed
 *      with no key ⇒ refuse" — is security-relevant (per
 *      docs/ARCHITECTURE_AMENDMENT_SFRAME.md §"fails closed"), so it lives
 *      in a pure, fake-timer-testable unit, the same way `keyLookupId` /
 *      `mayResyncExisting` are pinned in adhocCallKeyLookup.test.ts.
 *   2. useGroupCall.ts imports mediasoup-client / react-native-webrtc at
 *      module top, which won't load under the node-based messenger-crypto
 *      Jest project — so a helper that must be unit-tested there cannot
 *      live in that file.
 *
 * This module holds NO key material; it only observes key PRESENCE via the
 * injected `hasKey` probe.
 *
 * The motivating bug: the key envelope (sealed Signal relay) and the
 * sfu.ring (WS frame) travel separate paths. A cold-wake joiner on
 * cellular, or one whose envelope is queued behind a backlog, can have the
 * key land 10-20 s after accepting — past the old 8 s ceiling, which then
 * hard-failed the whole call ("Call failed") even though the key was
 * moments away. Widening the window and resolving the instant the key
 * lands recovers those calls WITHOUT relaxing the gate: a genuinely-absent
 * key after the window still fails closed (no media, never plaintext).
 */

export type GroupCallKeyWaitOutcome = 'ready' | 'timeout' | 'cancelled';

export interface GroupCallKeyWaitOptions {
  /** Probe: is the group master key present in the store yet? */
  hasKey:      () => boolean;
  /**
   * Register a listener fired on every store change; returns an
   * unsubscribe fn. The helper re-probes `hasKey()` on each fire.
   */
  subscribe:   (cb: () => void) => () => void;
  /** Probe: has the call been torn down while we wait? */
  isCancelled: () => boolean;
  /** Total ceiling before failing closed. Default 25 s. */
  timeoutMs?:  number;
  /**
   * Cancel-poll cadence. A teardown doesn't necessarily push a store
   * change that would wake the subscription, so we also poll. Default
   * 250 ms.
   */
  pollMs?:     number;
}

/**
 * Outcomes:
 *   'ready'     — the key is present (immediately, or arrived in-window)
 *   'timeout'   — the window elapsed and the key never arrived; the caller
 *                 MUST fail closed (no key ⇒ no media)
 *   'cancelled' — the call was torn down mid-wait; the caller bails
 *                 silently (the teardown path owns the state transition)
 */
export function waitForGroupCallKey(
  opts: GroupCallKeyWaitOptions,
): Promise<GroupCallKeyWaitOutcome> {
  // Fast paths — never arm timers if we already know the answer.
  if (opts.hasKey())      {return Promise.resolve('ready');}
  if (opts.isCancelled()) {return Promise.resolve('cancelled');}

  const timeoutMs = opts.timeoutMs ?? 25_000;
  const pollMs    = opts.pollMs ?? 250;

  return new Promise<GroupCallKeyWaitOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: GroupCallKeyWaitOutcome): void => {
      if (settled) {return;}
      settled = true;
      clearTimeout(deadline);
      clearInterval(cancelPoll);
      unsub();
      resolve(outcome);
    };
    // Re-evaluate both conditions on every wake (store change or poll).
    // `ready` wins over `cancelled` if the key happens to land in the same
    // tick a teardown begins — having the key is never the wrong outcome.
    const check = (): void => {
      if (opts.hasKey())           {finish('ready');}
      else if (opts.isCancelled()) {finish('cancelled');}
    };
    const deadline   = setTimeout(() => finish('timeout'), timeoutMs);
    const unsub      = opts.subscribe(check);
    const cancelPoll = setInterval(check, pollMs);
  });
}

/**
 * B-07 — mid-call "turn camera on" when the SFrame encryptor hasn't landed.
 *
 * `toggleVideo` enables a fresh camera producer only AFTER the group master
 * key (→ FrameCryptor encryptor) is present, so it never streams plaintext
 * video. Before the key arrives the old code refused SILENTLY: the user
 * tapped the camera button and nothing happened.
 *
 * This helper turns that dead tap into (1) a single user-visible notice and
 * (2) a ONE-SHOT retry that re-runs the toggle the instant the encryptor
 * lands — without weakening the no-plaintext gate (it never enables media
 * itself; it only re-invokes the caller's guarded toggle).
 *
 * It holds NO key material — it observes encryptor PRESENCE via `hasEncryptor`
 * and reuses `waitForGroupCallKey`'s presence-or-cancel wait.
 *
 * Concurrency: `isArmed`/`setArmed` gate against repeated taps stacking
 * subscriptions — a second call while a retry is already armed is a no-op.
 * If the wait ends in 'cancelled' (call torn down) or 'timeout' the retry is
 * NOT fired and the arm flag is cleared so a later tap can re-arm.
 */
export interface VideoEncryptorRetryOptions {
  /** Probe: is the SFrame encryptor present yet? */
  hasEncryptor: () => boolean;
  /** Register a store-change listener; returns an unsubscribe fn. */
  subscribe:    (cb: () => void) => () => void;
  /** Probe: has the call been torn down? */
  isCancelled:  () => boolean;
  /** Surface the transient user-visible notice. */
  notify:       (message: string) => void;
  /** Re-invoke the guarded toggle once the encryptor lands. */
  retry:        () => void;
  /** Read the concurrent-arm guard flag (true ⇒ a retry is already armed). */
  isArmed:      () => boolean;
  /** Set the concurrent-arm guard flag. */
  setArmed:     (v: boolean) => void;
  /** Window ceiling forwarded to waitForGroupCallKey. */
  timeoutMs?:   number;
}

export const VIDEO_ENCRYPTOR_WAIT_NOTICE =
  'Waiting for call encryption — try again in a moment';

/**
 * @returns `true` if a retry was armed by THIS call, `false` if it was a
 * no-op (already armed, or the encryptor is already present so the caller
 * should just proceed).
 */
export function armVideoEncryptorRetry(
  opts: VideoEncryptorRetryOptions,
): boolean {
  // Encryptor already present — nothing to wait for; caller proceeds.
  if (opts.hasEncryptor()) {return false;}
  // A retry is already in flight — don't stack subscriptions on repeat taps.
  if (opts.isArmed())      {return false;}

  opts.setArmed(true);
  opts.notify(VIDEO_ENCRYPTOR_WAIT_NOTICE);

  void waitForGroupCallKey({
    hasKey:      opts.hasEncryptor,
    subscribe:   opts.subscribe,
    isCancelled: opts.isCancelled,
    timeoutMs:   opts.timeoutMs,
  }).then((outcome) => {
    opts.setArmed(false);
    // Only re-attempt when the encryptor actually landed AND the call is
    // still live. 'timeout'/'cancelled' must NOT enable video.
    if (outcome === 'ready' && !opts.isCancelled()) {
      opts.retry();
    }
  });

  return true;
}
