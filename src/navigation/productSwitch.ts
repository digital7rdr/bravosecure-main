/**
 * THE cross-product switch pre-flight. Every door that changes product uses it.
 *
 * ── WHY IT IS ONE FUNCTION ───────────────────────────────────────────────
 *
 * A product switch is not a navigation — `switchProduct` is a plain store write
 * and the client shell is keyed on `activeProduct`, so the shell remount is a
 * raw React unmount that never dispatches `beforeRemove`. Three things must
 * therefore happen BEFORE it, and each of them was, at some point, wired at one
 * call site and forgotten at another:
 *
 *   1. ask (item 18),
 *   2. state the cost when an unanswered group ring will die,
 *   3. minimise a live call so the floating overlay can keep it alive.
 *
 * The VBG Home "Secure Services" tile shipped with NONE of the three (edge A5);
 * `SwitchDashboardSection` had all three but kept them private, so the tile
 * could not have reused them even deliberately. One behaviour with N drifted
 * copies is this repo's most-shipped defect, and this particular one destroys a
 * live call, so it lives here and nowhere else.
 *
 * Lives in `navigation/`, not in a component: a screen must be able to reach it
 * without importing a React component, or a routine `jest.mock` of that
 * component to stub a heavy child turns the switch handler into a crash.
 */

/**
 * Keep a live call alive across the shell remount.
 *
 * `FloatingCallOverlay` is mounted OUTSIDE the shell, so a MINIMISED call
 * survives with its End button; a full-screen one is destroyed with no way back
 * to it. Two registries, two modules — `setGroupCallMinimized` is exported by
 * `groupCallRegistry`, not `callRegistry`, and calling it on the wrong module
 * would be a no-op that reads as wired.
 *
 * Lazily required so the messenger runtime stays out of the drawer's and the
 * VBG screen's import graphs, and wrapped whole: a routing convenience must
 * never be able to kill the switch it is protecting.
 */
export function minimiseLiveCall(): void {
  try {
    const {hasLiveCall} = require('@/modules/messenger/runtime/callResumeGuard') as
      typeof import('@/modules/messenger/runtime/callResumeGuard');
    if (!hasLiveCall()) {return;}
    try {
      const one = require('@/modules/messenger/runtime/callRegistry') as
        typeof import('@/modules/messenger/runtime/callRegistry');
      // WI-1.1 — this function names no call (a product switch minimises
      // whatever is live), so it reads the live entry's own key synchronously.
      const live = one.getActiveCall();
      if (live) {one.setMinimized({callId: live.callId, gen: live.gen}, true);}
    } catch { /* no 1:1 call in flight */ }
    try {
      const grp = require('@/modules/messenger/runtime/groupCallRegistry') as
        typeof import('@/modules/messenger/runtime/groupCallRegistry');
      // WI-1.5 — same as the 1:1 above: this function names no room, so it
      // reads the live entry's own id synchronously.
      const liveGroup = grp.getActiveGroupCall();
      if (liveGroup) {grp.setGroupCallMinimized(liveGroup.roomId, true);}
    } catch { /* no group call in flight */ }
  } catch { /* messenger runtime not loaded — nothing to minimise */ }
}

/**
 * Is an UNANSWERED group ring about to be destroyed by the switch?
 *
 * `groupCallRegistry` is first written after Accept, so `hasLiveCall()` is
 * false while the phone is still ringing and `minimiseLiveCall()` no-ops.
 * `IncomingGroupCallScreen` is a stack child under the product key, and the
 * group overlay's only gate is `isMinimized` — so the keyed remount unmounts
 * the ring with nothing to restore and no rescue path. The 1:1 lane is fine: it
 * registers at ring time, so it minimises and the overlay can answer it.
 */
function groupRingPending(): boolean {
  try {
    const {peekPendingGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as
      typeof import('@/modules/messenger/webrtc/pendingGroupRing');
    return !!peekPendingGroupRing();
  } catch {
    return false;   // the ring lane is not loaded — nothing pending
  }
}

/**
 * Ask, state the cost, minimise, then switch.
 *
 * Say the ring cost rather than swallowing it. BLOCKING the switch would be
 * worse — a ring the user is deliberately walking away from would trap them —
 * so the confirm states what it will cost and lets them decide.
 *
 * `onConfirmed` performs the actual `switchProduct` call, because only the
 * caller knows its `returnTo` origin (B-352).
 */
export function confirmProductSwitch(destination: string, onConfirmed: () => void): void {
  /**
   * REQUIRED at call time, not imported at module top — and this is load-bearing
   * for the tests, not a style choice. A static import makes jest evaluate the
   * `@utils/alert` mock factory at MODULE LOAD, which is before the suite's
   * `const mockAlert = jest.fn()` has run, so the factory captures `undefined`
   * and every `Alert.alert` in the file dies with "is not a function". The code
   * this was extracted from required it lazily for the same reason.
   */
  const {confirmSwitchDashboard} = require('@utils/alert') as typeof import('@utils/alert');
  confirmSwitchDashboard(
    destination,
    () => { minimiseLiveCall(); onConfirmed(); },
    groupRingPending()
      ? {note: 'An incoming group call is still ringing. Leaving will end it for you.'}
      : undefined,
  );
}
