/**
 * Delivery-failure signalling (handoff §3.6 options (a) + (c)).
 *
 * The relay's ack is one wire signal carrying two meanings — "delete
 * this envelope" and "the recipient has it" — and the receive path
 * deliberately acks terminal decrypt failures (anti-poison, P1-4), so
 * a destroyed message produced the same sender-side ✓✓ as a delivered
 * one and left no trace in the receiver's thread. This module carries
 * the receiver-side truth:
 *
 *   - `noteDestroyedEnvelope` / `takeDestroyedEnvelope`: the deep
 *     receive path (doHandleIncoming) marks an envelope as DESTROYED
 *     (unrecoverable, will never render); the ack site reads the mark
 *     and acks with `disposition: 'discarded'` so the relay emits
 *     `envelope.undeliverable` to the sender instead of
 *     `envelope.delivered`. Module-level map avoids threading yet
 *     another parameter through the 13-arg receive signature.
 *   - `insertDecryptFailurePlaceholder`: persistent per-conversation
 *     "message couldn't be decrypted" row, deduped by envelopeId, so
 *     the receiver sees a gap marker instead of silence.
 *   - `applyEnvelopeUndeliverable`: sender-side handler for the new
 *     `envelope.undeliverable` frame — flips the bubble to
 *     `undelivered` and defends against a late `envelope.delivered`
 *     (applyEnvelopeDelivered only advances from `sent`, so the
 *     undelivered mark is stable once set).
 *
 * Stash branches (group no_key / recoverable tamper) are NOT destroyed
 * — the device durably holds the ciphertext and renders it after key
 * sync — so they keep the honest `delivered` disposition and never get
 * a destroyed-placeholder.
 *
 * Security: never logs or stores plaintext/ciphertext/key material —
 * only envelopeIds, conversation ids, and short reason codes.
 */

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import type {SessionAddress} from '@bravo/messenger-core';

export interface DestroyedEnvelopeInfo {
  envelopeId:      string;
  /** Known for post-unwrap failures (AAD reject, tamper-final). */
  conversationId?: string;
  peer?:           SessionAddress;
  reason:          string;
}

const MAX_TRACKED = 200;
const destroyed = new Map<string, DestroyedEnvelopeInfo>();

export function noteDestroyedEnvelope(info: DestroyedEnvelopeInfo): void {
  if (!info.envelopeId) {return;}
  if (destroyed.size >= MAX_TRACKED && !destroyed.has(info.envelopeId)) {
    const oldest = destroyed.keys().next().value;
    if (oldest !== undefined) {destroyed.delete(oldest);}
  }
  destroyed.set(info.envelopeId, info);
}

export function takeDestroyedEnvelope(envelopeId?: string): DestroyedEnvelopeInfo | undefined {
  if (!envelopeId) {return undefined;}
  const info = destroyed.get(envelopeId);
  if (info) {destroyed.delete(envelopeId);}
  return info;
}

/** Test hook — clears module state between cases. */
export function _resetDestroyedEnvelopes(): void {
  destroyed.clear();
}

export function placeholderMessageId(envelopeId: string): string {
  return `undecryptable:${envelopeId}`;
}

/**
 * Build + append the persistent placeholder row. Returns the appended
 * message so the caller can mirror it into SQLCipher (the receive path
 * does `sqlMessages.upsert(msg)` inside the txn, same as real rows), or
 * null when deduped / not insertable. Idempotent by message id — a WS
 * redelivery or drain retry of the same envelope never duplicates it.
 */
export function insertDecryptFailurePlaceholder(params: {
  conversationId: string;
  peer:           SessionAddress;
  envelopeId:     string;
  reason:         string;
}): LocalMessage | null {
  const {conversationId, peer, envelopeId, reason} = params;
  if (!envelopeId || !conversationId) {return null;}
  const store = useMessengerStore.getState();
  const id = placeholderMessageId(envelopeId);
  if (store.messages[conversationId]?.some(m => m.id === id)) {return null;}
  const msg: LocalMessage = {
    id,
    conversation_id: conversationId,
    sender_id:       peer.userId,
    type:            'system',
    content:         "A message couldn't be decrypted on this device. Ask the sender to resend it.",
    status:          'delivered',
    is_encrypted:    false,
    created_at:      new Date().toISOString(),
    peer,
    envelope_id:     envelopeId,
  };
  store.appendMessage(conversationId, msg);
  // Why: reason is a short code, never message content — safe to log.
  console.warn(`[messenger] recv-failure placeholder convo=${conversationId.slice(0, 12)} env=${envelopeId.slice(0, 8)} reason=${reason.slice(0, 40)}`);
  return msg;
}

/**
 * B-262 — reconcile a give-up placeholder when its real message finally
 * recovers. The group stash drain's age bound leaves a placeholder whose
 * `envelope_id` equals the stashed envelope's; `appendMessage` dedups on
 * `envelope_id` (`messengerStore` :903), so the recovered real row would be
 * SILENTLY DROPPED (`appendMessage` returns null → never persisted, and the
 * drain then deletes the last stash copy) unless the placeholder is removed
 * FIRST. Removing it also clears the now-stale "couldn't decrypt" gap.
 *
 * Call this on the SUCCESS path, immediately before appending the real row.
 *
 * Routes through `store.removeMessage` on purpose: the placeholder IS a
 * mirrored/Merkle-covered row (`mirrorMessage` filters nothing), so it must
 * leave through the ledger-consistent path — `removeMessage` fires
 * `notifyBackupRemoved`, i.e. a removal tombstone the backup mirror + Merkle
 * root account for. Guarded on actual presence so a placeholder that was never
 * there yields NO spurious tombstone (B-169 false-tombstone class), which also
 * makes it idempotent and a safe no-op. Returns true iff one was removed.
 */
export function reconcileRecoveredPlaceholder(conversationId: string, envelopeId: string): boolean {
  if (!conversationId || !envelopeId) {return false;}
  const store = useMessengerStore.getState();
  const id = placeholderMessageId(envelopeId);
  if (!store.messages[conversationId]?.some(m => m.id === id)) {return false;}
  store.removeMessage(conversationId, id);
  return true;
}

/**
 * Sender-side `envelope.undeliverable` handler. Flips `sent` (and a
 * stale `delivered` that raced ahead) to `undelivered`; never touches
 * `read` (the receipt proves the recipient rendered it, which
 * contradicts a destroy — trust the stronger signal). Idempotent.
 * Returns the number of bubbles flipped (0 or 1).
 *
 * B-143 — the match must consider the per-recipient `envelope_ids` map,
 * not just the scalar `envelope_id`. A group fan-out stamps one envelope
 * id per member and seeds the scalar from the FIRST leg only, so a
 * scalar-only test made the outcome depend on fan-out ORDER: the first
 * member's destroy flipped the bubble, every other member's identical
 * destroy was silently dropped and the sender kept a ✓✓ for a message
 * that member will never see. This is now the same match its sibling
 * `applyEnvelopeDelivered` has used since SYNC-1.
 *
 * B-683 — the flip rule is ALL-LEGS, closing B-143's recorded open
 * question (the per-leg partial-delivery model). B-143's interim rule was
 * "any leg destroyed ⇒ the bubble is undelivered", justified as the
 * mirror of the delivered handler — but since B-187 the delivered side
 * flips only when EVERY shipped leg delivered, so the pessimism had lost
 * its symmetry and one member's dead session redded messages every other
 * member held (founder screenshot, 2026-08-27). Now: a leg-matched
 * verdict records THAT member's failure (`recordUndeliverableLeg`), and
 * the scalar flips only when every current participant's leg is shipped,
 * dead, and unreceipted. Scalar-only rows (1:1/legacy — no map is ever
 * written on a 1:1 path) keep the immediate flip. A verdict matching only
 * a map-bearing row's STALE scalar (first-wins-seeded; cleared only by a
 * fresh-wire-id resend) is ignored — a dead prior attempt must not red a
 * retried message. Full audit:
 * docs/audits/FEED_TICKER_FALSE_RETRY_AUDIT_2026-08-27.md §2.
 *
 * Why `envelopeDelivered.ts`'s status!=='sent' receipt drop needs no
 * change: post-B-683 a flip implies every shipped leg was terminally
 * destroyed, and one ack consumes the envelope server-side — no
 * contradicting delivered can arrive after a correct flip.
 *
 * NOTE on group re-sends: since the B-683 follow-up (WhatsApp parity),
 * the B-46 auto-resend (`selectUndeliverableResend`) grants a group row
 * ONE bounded automatic attempt — safe precisely because the all-legs
 * rule above means a group 'undelivered' row is one NOBODY holds, and
 * the execution rides the manual chip's F2 lane (fresh wire id + atomic
 * artifact reset). A partial failure never reaches 'undelivered', so it
 * can never trigger a re-send.
 */
export function applyEnvelopeUndeliverable(envelopeId: string): number {
  if (!envelopeId) {return 0;}
  const store = useMessengerStore.getState();
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      const legs = msg.envelope_ids;
      if (legs && Object.keys(legs).length > 0) {
        const leg = Object.entries(legs).find(([, id]) => id === envelopeId);
        if (leg) {
          const before = msg.status;
          store.recordUndeliverableLeg(conversationId, msg.id, leg[0], Date.now());
          const after = useMessengerStore.getState()
            .messages[conversationId]?.find(m => m.id === msg.id);
          return after?.status === 'undelivered' && before !== 'undelivered' ? 1 : 0;
        }
        if (msg.envelope_id === envelopeId) {
          // B-683 — stale scalar from a dead prior attempt; ignore.
          return 0;
        }
        continue;
      }
      if (msg.envelope_id !== envelopeId) {continue;}
      // Scalar-only row (1:1 / legacy) — original immediate flip.
      if (msg.status === 'sent' || msg.status === 'delivered') {
        store.updateMessageStatus(conversationId, msg.id, 'undelivered');
        return 1;
      }
      return 0;
    }
  }
  return 0;
}
