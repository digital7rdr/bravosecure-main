/**
 * B-703 MR-12 — "the store can record the outcome" gate for the outbox drain.
 *
 * The drain records a successful send STORE-FIRST: `updateMessageStatus('sent')`
 * and `updateMessageEnvelopeId` write to the in-memory message map, while
 * `markDelivered` durably deletes the outbox row. Run it before
 * `hydrateMessages` and the map is EMPTY: both writes silently no-op, the row is
 * gone, and the MSG-07 boot sweep then finds a `sending` row with no outbox
 * entry and no acceptance artifact and reds a message the relay accepted.
 *
 * Moving the boot kick below the hydrate closed ONE door. It was not enough:
 * `transport.connect()` starts long before the SQLCipher block, and every other
 * kick — the `connected` handler, NetInfo, AppState resume, the server-signal
 * probe, the AppState-background flush — gates on `sqlOutbox` being non-null
 * and nothing else. `sqlOutbox` is constructed BEFORE the hydrate, with several
 * awaits (peer-session warm, identity acks, `loadRecent(200)` — the most
 * expensive read in boot) in between. A handshake completing in that window
 * reproduces the bug exactly, over HTTP, with no connectivity precondition to
 * soften it. One gate closes all six.
 *
 * FAILS OPEN, deliberately. If hydration hangs, sending must not stop with it:
 * the wait is bounded and a timeout proceeds anyway (and says so). A rare
 * false chip is a far better failure than an app that cannot send.
 */

let hydrated = false;
let waiters: Array<() => void> = [];

/** Called once the message map holds this owner's rows. Idempotent. */
export function markMessagesHydrated(): void {
  if (hydrated) {return;}
  hydrated = true;
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    try { w(); } catch { /* a waiter's own failure is not this gate's problem */ }
  }
}

/** Runtime teardown / owner switch: the next boot must gate again. */
export function resetMessagesHydratedGate(): void {
  hydrated = false;
  // Release anything still parked, or a drain from the dying runtime would
  // hang until its timeout instead of bailing on its epoch check.
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    try { w(); } catch { /* ignore */ }
  }
}

export function areMessagesHydrated(): boolean {
  return hydrated;
}

/**
 * Resolves true once hydration has happened, or false if the bound elapsed
 * first. Never rejects.
 */
export function awaitMessagesHydrated(timeoutMs = 10_000): Promise<boolean> {
  if (hydrated) {return Promise.resolve(true);}
  return new Promise<boolean>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {return;}
      settled = true;
      console.warn(
        `[messenger.outbox] proceeding without hydration after ${timeoutMs}ms — a send outcome may not reach its bubble`,
      );
      resolve(false);
    }, timeoutMs);
    waiters.push(() => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}
