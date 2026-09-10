/**
 * B-12 — pure decision for whether leaveInternal should emit
 * `sfu.ring.cancel` for the still-ringing invitees when the local user
 * tears the call down.
 *
 * Why a helper: the gate used to require `ringStartedAt` to be set, but
 * `ringStartedAt` is only assigned AFTER the `sfu.ring` ack lands. A host
 * who tapped End in the window between "sendTx connected" and the ack
 * (the exact B-12 symptom) had `ringStartedAt === null`, so the cancel
 * never fired and invitees rang the full 30s. We instead fire whenever
 * an OUTGOING HOST actually rang (or attempted to ring — `sentRing`) OR
 * the ring window had already started, and there is still someone ringing.
 */
export interface RingCancelDecisionInput {
  isHost:            boolean;
  direction:         'incoming' | 'outgoing';
  /** True once we've sent (or attempted) the `sfu.ring`. */
  sentRing:          boolean;
  /** Set only after the `sfu.ring` ack lands; null in the B-12 window. */
  ringStartedAt:     number | null;
  /** How many users we originally dialled. */
  recipientCount:    number;
  /** recipients − already-joined: who would still be ringing. */
  stillRingingCount: number;
}

export function shouldSendRingCancel(input: RingCancelDecisionInput): boolean {
  const {isHost, direction, sentRing, ringStartedAt, recipientCount, stillRingingCount} = input;
  // Only an outgoing host owns the ring queue and may cancel it.
  if (!isHost || direction !== 'outgoing') {return false;}
  // Nothing to cancel if we never rang and the ring window never opened.
  if (!sentRing && ringStartedAt === null) {return false;}
  // No recipients dialled, or everyone already joined → nobody to dismiss.
  if (recipientCount <= 0 || stillRingingCount <= 0) {return false;}
  return true;
}
