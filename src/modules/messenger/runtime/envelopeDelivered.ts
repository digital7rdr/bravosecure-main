/**
 * Audit P0-T6 — sender-facing delivered-tick handler.
 *
 * Why this lives in its own module:
 *   The Jest `messenger-crypto` project runs under Node (no Metro,
 *   no native modules). `productionRuntime.ts` transitively imports
 *   `@op-engineering/op-sqlite`, which is a native module and cannot
 *   be required at test time. Lifting this tiny helper out of the
 *   runtime keeps the unit-test surface dependency-light.
 *
 * Contract:
 *   The relay emits `envelope.delivered { envelopeId }` to the
 *   original submitter device the moment the recipient acks.
 *
 *   B-187 — a GROUP row carries one envelope id per recipient in
 *   `envelope_ids`. A delivered for one of those legs records THAT
 *   member's receipt (`recordDeliveredReceipt`); the scalar status
 *   flips 'sent' → 'delivered' only once every shipped leg has
 *   delivered|read. A scalar-only match (1:1 rows, or legacy/restored
 *   rows with no map) keeps the original behaviour: any delivered
 *   advances the bubble.
 *
 * Guards:
 *   - `read` → leave as-is (a slow delivered must NOT regress a
 *     bubble the recipient has already read).
 *   - `delivered` → no-op (idempotent — defends against any future
 *     relay that emits delivered more than once).
 *   - `sending` / `failed` → skip; we never observed `sent`, so
 *     painting `delivered` would be a lie (most likely a stale
 *     frame for an already-retracted message).
 *
 * Returns the number of bubbles whose STATUS was flipped (0 or 1) —
 * a leg receipt that does not complete the aggregate returns 0.
 * The store carries at most one bubble per envelope_id by
 * construction (the sender mints clientMsgId + the relay mints
 * envelopeId, both unique), so the scan short-circuits on first
 * match.
 */

import {useMessengerStore} from '../store/messengerStore';

export function applyEnvelopeDelivered(envelopeId: string): number {
  if (!envelopeId) {return 0;}
  const store = useMessengerStore.getState();
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      // B-187 — leg match first: attribute the ack to its recipient.
      const leg = Object.entries(msg.envelope_ids ?? {})
        .find(([, id]) => id === envelopeId);
      if (leg) {
        if (msg.status !== 'sent') {return 0;}
        store.recordDeliveredReceipt(conversationId, msg.id, leg[0], Date.now());
        const after = useMessengerStore.getState()
          .messages[conversationId]?.find(m => m.id === msg.id);
        return after?.status === 'delivered' ? 1 : 0;
      }
      if (msg.envelope_id !== envelopeId) {continue;}
      // Scalar-only row — original single-ack behaviour.
      if (msg.status === 'sent') {
        store.updateMessageStatus(conversationId, msg.id, 'delivered');
        return 1;
      }
      return 0;
    }
  }
  return 0;
}
