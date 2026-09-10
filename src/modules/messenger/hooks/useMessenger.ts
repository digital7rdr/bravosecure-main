import { useEffect, useState } from 'react';
import { useMessengerStore } from '../store/messengerStore';
import { getMessengerRuntime, type MessengerRuntime } from '../runtime';

/**
 * React hook for ChatScreen-level access to the messenger runtime.
 * On first mount it triggers lazy runtime init; subsequent callers
 * just get back the memoized singleton once ready. `error` surfaces
 * crypto failures that were thrown out of sendText — callers should
 * show a user-visible error, not silently swallow.
 */
export function useMessenger() {
  const ready = useMessengerStore(s => s.ready);
  const error = useMessengerStore(s => s.error);
  const [runtime, setRuntime] = useState<MessengerRuntime | null>(null);

  // B-356 — re-resolve when `ready` flips, not once-per-mount. The old `[]`
  // deps made this a ONE-SHOT: a screen mounted early in boot (notification
  // deep-link) whose resolution rejected kept `runtime` null for the whole
  // mount — messages still rendered (store selector), but everything that
  // needs the runtime (markRead → blue ticks, sends) was silently dead until
  // the user backed out and re-entered. `ready` flips exactly when a build
  // completes, so a retry then either adopts the singleton or surfaces a
  // real error. Idempotent: getMessengerRuntime() returns the cached build.
  useEffect(() => {
    // Teardown flip (ready true→false with a runtime already in hand —
    // logout/owner switch): nothing to re-resolve; the screen is unmounting.
    if (runtime && !ready) {return;}
    let cancelled = false;
    getMessengerRuntime()
      .then(rt => {
        if (!cancelled) {setRuntime(rt);}
      })
      .catch(e => {
        if (!cancelled) {
          console.warn('[RECEIPTDIAG] useMessenger runtime resolve failed:', e instanceof Error ? e.message : String(e));
          useMessengerStore.getState().setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // `runtime` in deps is loop-safe: once set, re-resolving the cached
    // singleton yields the same reference and React bails out of the update.
  }, [ready, runtime]);

  return { runtime, ready: ready && runtime !== null, error };
}

/**
 * Non-hook counterpart to `useMessenger`'s `ready` flag, for plain async
 * callbacks (not React render) that need to know boot hydration has actually
 * finished before trusting in-memory state such as `groups[id].masterKeyB64`.
 * Right after login the store is briefly un-hydrated; reading it before this
 * resolves is what made a genuinely-present group key look "lost".
 */
export function waitForMessengerReady(timeoutMs = 4000): Promise<void> {
  if (useMessengerStore.getState().ready) {return Promise.resolve();}
  return new Promise<void>(resolve => {
    const unsubscribe = useMessengerStore.subscribe(s => {
      if (s.ready) { unsubscribe(); resolve(); }
    });
    setTimeout(() => { unsubscribe(); resolve(); }, timeoutMs);
  });
}
