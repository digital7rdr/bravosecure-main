/**
 * P1-BR-4 (B-58) — resume / send-ack-watchdog guard for the messenger
 * transport.
 *
 * The active-call foreground service keeps the WS socket alive across a
 * background stint, but the backgrounded 4 s heartbeat leaves `lastPongAt`
 * stale. Without this guard the AppState-'active' handler and the WS
 * send-ack watchdog would `forceReconnect()` a HEALTHY socket, which the
 * gateway reads as a call drop and fans out `call.hangup{failed}` to the
 * peer — the deterministic "tapping the ongoing-call notification
 * disconnects the call" bug. These pure helpers centralise "is a call
 * live?" and "what should resume do?" so both forceReconnect sites — and
 * the unit tests — share exactly one source of truth.
 *
 * Both registries are `import type`-only modules (node-safe), so this
 * helper is importable in the crypto Jest project without the RN/native
 * graph the rest of the runtime pulls in.
 */

/**
 * True when a 1:1 or group call is currently non-terminal. Lazy-require to
 * dodge the circular import between the runtime and the call registries.
 */
export function hasLiveCall(): boolean {
  try {
    const {getActiveCall} = require('./callRegistry') as typeof import('./callRegistry');
    const c = getActiveCall();
    if (c && c.state !== 'ended' && c.state !== 'failed') {return true;}
  } catch { /* registry not loaded (tests / early boot) */ }
  try {
    const {getActiveGroupCall} = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
    const g = getActiveGroupCall();
    // Live while creating/joining/joined/reconnecting; terminal states
    // (left/failed/kicked/ended-by-host/unavailable/full/idle) are not.
    // WI-1.6 — `ending` is a teardown in progress, never something to resume,
    // minimise, or probe. "Busy" and "live" genuinely diverge here: the
    // launch-side busy guards DO block on it; this one must not.
    if (g && !g.ending &&
        (g.state === 'creating' || g.state === 'joining' || g.state === 'joined' || g.state === 'reconnecting')) {
      return true;
    }
  } catch { /* registry not loaded */ }
  return false;
}

export type ResumeAction = 'drain' | 'probe' | 'reconnect';

/**
 * Decide what the AppState-'active' handler should do on resume:
 *  • `drain`     — the pong is fresh, socket is genuinely live; just pull
 *                  any envelopes that piled up while backgrounded.
 *  • `probe`     — pong stale BUT a call is live: the call FGS kept the
 *                  socket up. Send one ping and only rebuild if no pong
 *                  lands within the grace window, so a healthy mid-call
 *                  socket is never torn down (B-58).
 *  • `reconnect` — pong stale and no call: the ordinary Doze-thaw safety
 *                  net; tear down + reconnect immediately.
 */
export function decideResumeAction(pongFresh: boolean, liveCall: boolean): ResumeAction {
  if (pongFresh) {return 'drain';}
  if (liveCall) {return 'probe';}
  return 'reconnect';
}
