/**
 * The group call's state vocabulary — and which of those states are terminal.
 *
 * DEPENDENCY-FREE ON PURPOSE, in its own module. `useGroupCall.ts` transitively
 * pulls in WebRTC, Crashlytics and other native modules, so anything that
 * imports the type from there cannot be unit-tested in the node project — which
 * is exactly what happened to `groupCallResourceRelease.ts`, the pure decision
 * that gates the release of the shared audio session and the call foreground
 * service (B-595). Same reasoning as `restoreWriteThrough.ts`.
 *
 * `useGroupCall` re-exports both, so every existing import site is unchanged
 * and there is still ONE definition.
 */
export type GroupCallState =
  | 'idle'
  | 'unavailable'   // SFU returned an error or transport missing
  | 'creating'
  | 'joining'
  | 'joined'
  | 'reconnecting'  // mediasoup transport disconnected, ICE restart in flight
  | 'left'
  | 'failed'
  | 'kicked'
  | 'ended-by-host' // Host left → server fired sfu.room.ended → we tore down
  | 'full';

/**
 * B-595 — the states from which this call can never carry media again.
 *
 * Stated ONCE, beside the union it partitions: a second copy would be a list
 * that silently stops matching when a state is added, and what it gates is the
 * release of two SHARED resources (the InCallManager session and the call
 * foreground service). Wrong in the "still live" direction strands a
 * "Bravo Secure call · Hang up" notification with nothing left to dismiss it;
 * wrong the other way rips both off a live call.
 *
 * `reconnecting` is deliberately NOT terminal — an ICE restart is in flight and
 * the call is expected back. Neither is `full`: that call never started, so it
 * never took the session.
 */
export const GROUP_TERMINAL_STATES: ReadonlySet<GroupCallState> = new Set<GroupCallState>([
  'left', 'failed', 'kicked', 'ended-by-host', 'unavailable',
]);
