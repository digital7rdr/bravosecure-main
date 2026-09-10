/**
 * There is exactly ONE InCallManager audio session on the device, but two
 * independent call stacks reach for it: 1:1 (callRegistry + CallScreen) and
 * group/SFU (groupCallRegistry + GroupCallScreen). Neither registry knew the
 * other existed, which broke the session in both directions:
 *
 *   - `endActiveCall` (1:1) stopped the session unconditionally. A stale or
 *     late-arriving 1:1 teardown — a missed call cleaning up, a `call.hangup`
 *     frame for a call that already ended — killed the audio session out from
 *     under a LIVE group call. Symptom: joined the Ops Room, tiles render,
 *     nobody can be heard.
 *
 *   - `endActiveGroupCall` never stopped it at all. It is the mirror of the
 *     CALL-N5 fix that landed in `endActiveCall` on 2026-07-02 and was never
 *     carried across: GroupCallScreen's audio-effect cleanup is the only other
 *     place that stops the session, and that cleanup cannot run while the
 *     screen is unmounted (call minimized). So ending a MINIMIZED group call
 *     from the floating overlay — or the last peer leaving while minimized —
 *     left the device pinned in MODE_IN_COMMUNICATION indefinitely: routing
 *     stuck on the earpiece, the media volume slider inert, and the next call
 *     starting on top of a session that was never torn down.
 *
 * Both report to a user as "no audio in calls", which is why they are fixed
 * together. The rule is one line: stop the shared session only when NOBODY
 * still owns a call.
 */

export type Owner = 'direct' | 'group';

/**
 * Stop the shared InCallManager session unless the other call stack still has
 * a live call. `owner` is the stack whose call is ending — its own registry
 * slot is deliberately NOT consulted, because callers invoke this mid-teardown
 * when their slot may not be cleared yet.
 *
 * Returns true if the session was actually stopped.
 */
export function stopSharedAudioSession(owner: Owner): boolean {
  if (otherStackHasLiveCall(owner)) {
    console.log(`[bravo.callaudio] stop skipped — the ${owner === 'direct' ? 'group' : '1:1'} stack still owns a live call`);
    return false;
  }
  try {
    const InCallManager = require('react-native-incall-manager').default as {stop: () => void};
    InCallManager.stop();
    console.log(`[bravo.callaudio] shared session stopped by ${owner}`);
    return true;
  } catch {
    // Native module missing (iOS simulator / tests) — nothing to stop.
    return false;
  }
}

/**
 * B-256 — exported because the foreground service needs the SAME ownership
 * question. It is one device-wide resource per stack pair; answering "is
 * anybody else still on a call?" twice, in two files, is how the audio
 * arbitration and the notification arbitration would drift apart.
 */
export function otherStackHasLiveCall(owner: Owner): boolean {
  // Lazy requires: callRegistry and groupCallRegistry must not import each
  // other at module scope, and this module is required from inside both.
  try {
    if (owner === 'direct') {
      const {getActiveGroupCall} = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
      const g = getActiveGroupCall();
      // WI-1.6 — a group entry marked `ending` is mid-teardown, not a live
      // owner. Before WI-1.6 the slot was already null by this point, so
      // counting it would newly REFUSE a 1:1 stop for the whole leave window
      // and pin the device in MODE_IN_COMMUNICATION — a CALL-N5 regression.
      return g !== null && g.ending !== true;
    }
    const {getActiveCall} = require('./callRegistry') as typeof import('./callRegistry');
    return getActiveCall() !== null;
  } catch {
    // If the other registry can't be resolved we cannot prove it is busy.
    // Stopping is the safer default: a session left running pins the device
    // in MODE_IN_COMMUNICATION, which is the worse of the two failures.
    return false;
  }
}
