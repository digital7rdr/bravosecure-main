/**
 * Lightweight registry for the WebSocket round-trip time.
 *
 * The runtime sends a `ping` frame every 4s carrying `Date.now()` and
 * publishes the resulting `pong` round-trip into this registry.
 * Anything in the app — chips, tracker overlays, debug HUDs — can
 * subscribe via `onRtt()` for sub-frame updates.
 *
 * Decoupled from the runtime so loopback tests don't need to mock it.
 */

let lastRttMs:    number | null = null;
let lastSampleAt: number | null = null;
const listeners = new Set<(rttMs: number | null) => void>();

export function publishRtt(rttMs: number): void {
  lastRttMs    = rttMs;
  lastSampleAt = Date.now();
  listeners.forEach(fn => { try { fn(rttMs); } catch { /* ignore */ } });
}

export function getRtt(): {rttMs: number | null; ageMs: number | null} {
  if (lastSampleAt === null) {return {rttMs: null, ageMs: null};}
  return {rttMs: lastRttMs, ageMs: Date.now() - lastSampleAt};
}

export function onRtt(fn: (rttMs: number | null) => void): () => void {
  listeners.add(fn);
  try { fn(lastRttMs); } catch { /* ignore */ }
  return () => { listeners.delete(fn); };
}

/** Reset on user logout / runtime teardown so the next session starts clean. */
export function clearRtt(): void {
  lastRttMs = null;
  lastSampleAt = null;
  listeners.forEach(fn => { try { fn(null); } catch { /* ignore */ } });
}
