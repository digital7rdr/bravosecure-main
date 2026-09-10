/**
 * B-595 — who owns the shared call resources when a group call screen tears down.
 *
 * There is ONE InCallManager session and ONE call foreground service for the
 * whole app, shared by the 1:1 and group stacks (B-243 fixed the audio session,
 * B-256 the foreground service). `GroupCallScreen`'s audio effect is one of only
 * two places that release the group's claim on them — the other is
 * `endActiveGroupCall`. So this decision is load-bearing in BOTH directions:
 *
 *   - release too eagerly → the notification and the audio session are ripped
 *     off a call that is still running;
 *   - release too timidly  → a "Bravo Secure call · Hang up" notification with
 *     nothing left to dismiss it, and a device pinned in
 *     MODE_IN_COMMUNICATION (no call audio on the next call).
 *
 * It is a pure function so both directions can be tested without mounting a
 * screen, an SFU, or a native module — the screen itself cannot be imported by
 * a node test, which is exactly how the bug below survived.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────────
 *
 * The End button calls `call.leave()`, NOT `endActiveGroupCall` — so nothing
 * marks the registry entry `ending`, and the registry teardown that would also
 * have stopped the service never runs. `leaveInternal` then flips the call to a
 * terminal state SYNCHRONOUSLY at its top (B-37) and nulls the registry only in
 * its async tail. `call.state` is a dependency of the audio effect, so that flip
 * re-runs the effect and fires its cleanup IN BETWEEN — at a moment when the
 * registry still holds our own room, un-`ending`. The old test was
 * `live.roomId === roomKey → return`, which matched, so the cleanup skipped the
 * stop. The re-run then early-returned on `state !== 'joined'` and registered no
 * new cleanup, so the later unmount stopped nothing either.
 *
 * ── AND THE LATENT ONE IT ALSO CLOSES ─────────────────────────────────────
 *
 * The old form returned only for `keepAlive` or OUR room, and fell through —
 * releasing — when a live entry named a DIFFERENT room. A newer call in another
 * room would have had its session and notification torn off by the old screen's
 * unmount. The rule is not "is the registry pointing at me", it is "is ANY group
 * call still live".
 */
// From the dependency-free state module, NOT from `useGroupCall` — importing it
// from there pulls WebRTC and Crashlytics into this module's graph and makes it
// unmountable in the node project, which is the whole reason this file exists.
import {GROUP_TERMINAL_STATES, type GroupCallState} from '@/modules/messenger/webrtc/groupCallStates';

/** The subset of the registry entry this decision reads. */
export interface LiveGroupEntry {
  roomId:     string | null;
  keepAlive?: boolean;
  /** WI-1.6 — a teardown in flight is NOT a live owner. */
  ending?:    boolean;
}

export function shouldReleaseSharedCallResources(input: {
  /** `getActiveGroupCall()` — the raw registry entry, or null. */
  entry:   LiveGroupEntry | null;
  /** The room this screen instance was started for. */
  roomKey: string;
  /** The CURRENT state of this instance (read through a ref, never a closure). */
  state:   GroupCallState;
}): boolean {
  const {entry, roomKey, state} = input;
  // WI-1.6 — an `ending` entry is mid-teardown; it owns nothing.
  const live = entry && entry.ending !== true ? entry : null;
  // Nothing is live: the resources are ours to release.
  if (!live) {return true;}
  // A minimized call is live with no screen mounted — the case the registry
  // teardown exists to cover. Never release under it.
  if (live.keepAlive === true) {return false;}
  // The ONLY live entry that does not mean "someone still needs these" is this
  // instance's own dying call, and terminal state is the only thing that
  // distinguishes it from a re-mounted screen for the same live room.
  const ourDyingEntry = live.roomId === roomKey && GROUP_TERMINAL_STATES.has(state);
  return ourDyingEntry;
}
