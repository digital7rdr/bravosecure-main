/**
 * The ack disposition rule — shared by the WS receive path (handleDeliverInner)
 * and the HTTP catch-up path (drainRelay), which used to compute it inline in
 * two places with only the local variable name differing (`handledOk` vs
 * `handled`). Two copies of a REMOTE-DEVICE UI CONTRACT is how they drift.
 *
 * The disposition is not local bookkeeping: `'discarded'` makes the RELAY emit
 * `envelope.undeliverable`, which flips the SENDER's bubble to `undelivered`
 * and fires a B-46 auto-resend. `'delivered'` is the ✓✓ signal. So getting this
 * wrong changes another user's screen. See MESSAGE_LOOP.md M5.
 *
 * The rule: ack `'discarded'` when the message will NEVER render on this device
 * — either the handler threw unrecoverably (`handledOk === false`) or the deep
 * receive path left a destroyed-note (AAD reject / tamper-final / recovery
 * give-up). Otherwise `'delivered'`: the device genuinely holds it (rendered,
 * or durably stashed — stash branches leave no note, so 'delivered' stays
 * honest).
 *
 * Pure and dependency-free (Tier A): the caller passes the destroyed-note it
 * already consumed via `takeDestroyedEnvelope`, so this does not itself touch
 * that FIFO map.
 */
export type AckDisposition = 'discarded' | 'delivered';

export function ackDispositionFor(handledOk: boolean, hasDestroyedNote: boolean): AckDisposition {
  return (!handledOk || hasDestroyedNote) ? 'discarded' : 'delivered';
}
