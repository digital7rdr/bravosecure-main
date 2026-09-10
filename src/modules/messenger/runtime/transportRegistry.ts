/**
 * Lightweight registry exposing the live `TransportClient` to anything
 * outside the messenger runtime that needs it (e.g. CallScreen, the
 * agent live tracker's RTT chip).
 *
 * The production runtime calls `setLiveTransport()` once it constructs
 * the socket; `getLiveTransport()` returns it (or null when the runtime
 * is in loopback mode or hasn't booted yet). Subscribers can listen for
 * the moment the transport becomes available via `onTransport()`.
 *
 * This is intentionally a tiny module — kept out of the runtime's
 * public surface so loopback tests don't need to mock it.
 */
import type {TransportClient} from '@bravo/messenger-core';

let live: TransportClient | null = null;
const listeners = new Set<(t: TransportClient | null) => void>();

export function setLiveTransport(t: TransportClient | null): void {
  live = t;
  // Fix #15: snapshot the listener Set before iterating. A listener's
  // callback is allowed to add or remove listeners (e.g. an overlay
  // that unsubscribes itself once it's seen a non-null transport);
  // forEach over a live Set when the callback mutates it is undefined-
  // ish in JS engines (V8 will skip the new entry, others may revisit).
  // Materialising into an array makes the iteration deterministic.
  for (const fn of [...listeners]) {
    try { fn(t); } catch { /* one bad listener mustn't block the rest */ }
  }
}

export function getLiveTransport(): TransportClient | null {
  return live;
}

export function onTransport(fn: (t: TransportClient | null) => void): () => void {
  listeners.add(fn);
  // Fire once with current state so the consumer can mount immediately.
  try { fn(live); } catch { /* ignore */ }
  return () => { listeners.delete(fn); };
}

/**
 * B-275 — resolve once a transport EXISTS, or null if it hasn't arrived
 * inside `timeoutMs`.
 *
 * Answering a call from its notification COLD-STARTS the app. The socket
 * needs a second or two after that; anything that asks `getLiveTransport()`
 * exactly once, ~600ms in, gets null and — if it treats that as terminal —
 * kills a call that was about to be perfectly fine. The group-call boot did
 * precisely that and rendered "Group call unavailable".
 *
 * A caller that can wait should wait. Bounded, so a genuinely dead socket
 * still fails instead of hanging behind a spinner.
 */
export function waitForLiveTransport(timeoutMs = 12_000): Promise<TransportClient | null> {
  if (live) {return Promise.resolve(live);}
  return new Promise<TransportClient | null>(resolve => {
    let done = false;
    // `unsub` is assigned by onTransport BELOW, but onTransport fires the
    // listener synchronously once with the current value — so settle() can
    // run before the assignment. Guarding on `done` makes the ordering safe
    // either way.
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (t: TransportClient | null): void => {
      if (done) {return;}
      done = true;
      if (timer) {clearTimeout(timer); timer = null;}
      // May still be null if settle ran synchronously inside onTransport's
      // initial dispatch below; the `if (done)` line after the assignment
      // covers that case. No stray timer is left behind either way — one
      // leaked past a Jest test and produced "Cannot log after tests are done".
      unsub?.();
      resolve(t);
    };
    timer = setTimeout(() => settle(null), timeoutMs);
    unsub = onTransport(t => { if (t) {settle(t);} });
    if (done) {unsub();}
  });
}

/**
 * Drop the live transport reference. Wired into the auth-service
 * signOut flow so a re-login starts with a clean slot — any subscriber
 * holding a stale TransportClient ref now gets `null` and can decline
 * to send signalling.
 *
 * Round 2 fix: the original contract said "caller is expected to .close()
 * the transport BEFORE invoking this" — but the only caller (signOut)
 * never did. Result: the previous user's WS stayed open, kept the
 * persisted `recoveryPid` alive, and the next user's session replayed
 * against the prior session id. Close it here so the contract is
 * automatic. close() is idempotent and a no-op if the socket is already
 * disconnected.
 */
export function clearLiveTransport(): void {
  const prior = live;
  setLiveTransport(null);
  if (prior) {
    try { prior.close(); } catch { /* ignore — socket may already be down */ }
  }
}
