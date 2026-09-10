/**
 * Call-waiting decision core (B-238-CW).
 *
 * When a second incoming 1:1 call arrives while the user is ALREADY on a
 * call (1:1 or group), the app must not silently busy it (the old CALL-N10
 * behaviour) nor tear the live call down without consent. Instead it routes
 * the new offer into `incomingOneToOneBanner` and the on-screen surface
 * (CallScreen or GroupCallScreen) renders a non-destructive Accept/Decline
 * banner over the live call. This module is the pure decision core those
 * banners call:
 *
 *   Accept  → clear the slot, tear down the CURRENT call, then join the new
 *             one (navigate to CallScreen with the queued offer SDP).
 *   Decline → send `call.hangup{declined}` to the new caller, clear the slot,
 *             and leave the current call untouched.
 *
 * The only thing that differs between the two host surfaces is WHICH call is
 * torn down on Accept — `endActiveCall` (1:1) vs `endActiveGroupCall` (group)
 * — so that is injected as `endCurrentCall`. Everything else is identical,
 * which is exactly why it lives here once instead of being copied into two
 * native screens that can't be unit-tested.
 *
 * Pure + dependency-injected so it runs under the node messenger-crypto
 * project (the screens that consume it pull react-native and cannot).
 */
import type {PendingOneToOne} from './incomingOneToOneBanner';

/** Params handed to CallScreen to join the accepted 1:1 offer. */
export interface AcceptedCallParams {
  callType:       PendingOneToOne['kind'];
  isIncoming:     true;
  conversationId: string;
  callId:         string;
  remoteUserId:   string;
  remoteDeviceId: number;
  incomingSdp:    PendingOneToOne['sdp'];
}

export interface CallWaitingDeps {
  /**
   * Tear down the call CURRENTLY on screen. 1:1 host passes
   * `() => endActiveCall('ended','local')`; group host passes
   * `endActiveGroupCall`. May be sync or async; a rejection must NOT block
   * the accepted call from launching (the user explicitly chose it).
   */
  endCurrentCall: () => Promise<void> | void;
  /** Send a transport frame (used for the decline hangup). Never throws to the caller. */
  sendFrame:      (frame: {event: string; data: unknown}) => void;
  /** Navigate (replace) into the 1:1 CallScreen for the accepted offer. */
  navigateToCall: (params: AcceptedCallParams) => void;
  /** Clear the pending banner slot. */
  clearPending:   () => void;
}

/** Build the CallScreen params for an accepted pending 1:1 offer. */
export function acceptedCallParams(pending: PendingOneToOne): AcceptedCallParams {
  return {
    callType:       pending.kind,
    isIncoming:     true,
    conversationId: `direct:${pending.from.userId}`,
    callId:         pending.callId,
    remoteUserId:   pending.from.userId,
    remoteDeviceId: pending.from.deviceId,
    incomingSdp:    pending.sdp,
  };
}

/**
 * Decline the waiting call: tell the new caller we're busy/declined and drop
 * the banner. The current call is deliberately left running.
 */
export function declineWaitingCall(pending: PendingOneToOne, deps: CallWaitingDeps): void {
  try {
    deps.sendFrame({
      event: 'call.hangup',
      data:  {callId: pending.callId, to: pending.from, reason: 'declined'},
    });
  } catch { /* fire-and-forget — a dead socket must not trap the banner open */ }
  deps.clearPending();
}

/**
 * Accept the waiting call: end the current call FIRST (awaited so the audio
 * session / transport fully releases before the new PC acquires the mic —
 * see GroupCallScreen Fix #15), then join the new one. If the teardown
 * rejects we still navigate: the user chose this call and getting them into
 * it beats a perfectly-clean teardown of the one they're leaving.
 */
export async function acceptWaitingCall(pending: PendingOneToOne, deps: CallWaitingDeps): Promise<void> {
  const params = acceptedCallParams(pending);
  // Clear the slot before the async teardown so a duplicate offer replay
  // can't re-render the banner mid-accept.
  deps.clearPending();
  try {
    await deps.endCurrentCall();
  } catch { /* explicit accept — launch the new call regardless */ }
  deps.navigateToCall(params);
}
