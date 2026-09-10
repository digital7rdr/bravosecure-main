/**
 * B-46 — sender-side auto-resend on `envelope.undeliverable`.
 *
 * When the recipient's device destroys an envelope it cannot decrypt
 * (identity churn: reinstall, cleared data, cross-install login, failed
 * backup restore), the relay tells the SENDER via `envelope.undeliverable`.
 * The sender still holds the plaintext locally — so the content is
 * trivially recoverable by re-establishing a session against the
 * recipient's CURRENT identity and re-sending. This module holds the
 * pure decision logic (eligibility + bounded budget); the crypto
 * execution lives in a productionRuntime closure (needs the live
 * SessionManager / relay / cert cache).
 *
 * Eligibility is deliberately narrow (mirrors ChatScreen.retrySend):
 *   - own outbound TEXT rows only. Media re-encrypt isn't supported on
 *     this path.
 *   - the row must currently be `undelivered` (applyEnvelopeUndeliverable
 *     runs first) — a `read` receipt is the stronger signal and wins.
 *   - a disappearing message whose deadline passed is NOT re-sent.
 *
 * B-683 follow-up (founder: WhatsApp parity) — GROUP rows now get one
 * bounded automatic attempt too ('resend-group'). The original refusal
 * reason ("a group row can't attribute which member's envelope died")
 * was retired by B-683's per-leg `undeliverable_legs` map, and the
 * all-legs flip rule makes the safety argument: a group row is
 * 'undelivered' only when EVERY shipped member destroyed it, so a
 * resend cannot duplicate for anyone. Execution rides the manual
 * retry's F2 lane (sendText + existingMsgId → fresh wire id + atomic
 * artifact reset), keeping wire behaviour identical to a chip tap.
 *
 * Budget: at most MAX_AUTO_RESENDS_PER_MESSAGE automatic attempts per
 * message id, LRU-capped in memory (mirrors firstMessageRetryBudget).
 * A process restart grants a fresh (still-bounded) budget — acceptable:
 * each new attempt requires the recipient to actively discard again,
 * and the manual retry chip remains the terminal fallback.
 *
 * SECURITY (CLAUDE.md stop-condition note): this adds NO new trust
 * decision. The resend fetches the peer's authority-signed bundle from
 * keys-service — the exact trust model of every first-contact send
 * (`ensureOutgoingSession`) and of the receive-side rotation refresh
 * (`peerIdentityRefresh.ts`). Ack/retract tokens, envelope ids and
 * relay dwell semantics are untouched; the resend is an ordinary new
 * submit with a NEW clientMsgId (the old id is dedup-claimed on the
 * server for the dwell window and would be coalesced into the dead
 * envelope — see envelope.service.ts claimClientMsgId).
 *
 * Never logs plaintext — message ids / envelope ids / reasons only.
 */

import type {SessionAddress} from '@bravo/messenger-core';
import type {LocalMessage, LocalConversation} from '../store/types';

/** Max automatic resends per message id (manual retry chip is unbounded). */
export const MAX_AUTO_RESENDS_PER_MESSAGE = 1;
/** Bound on the in-memory budget map (mirrors firstMessageRetryBudget). */
const RESEND_BUDGET_CAP = 256;

const attempts = new Map<string, number>();

function touchLru(messageId: string, count: number): void {
  if (attempts.has(messageId)) {attempts.delete(messageId);}
  attempts.set(messageId, count);
  if (attempts.size > RESEND_BUDGET_CAP) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) {attempts.delete(oldest);}
  }
}

export interface UndeliverableResendPlan {
  action:         'resend';
  conversationId: string;
  message:        LocalMessage;
  peer:           SessionAddress;
  /** Absolute recipient-side deadline (sec) carried over from the original. */
  expiresAtSec?:  number;
}

export interface UndeliverableResendGroupPlan {
  action:         'resend-group';
  conversationId: string;
  message:        LocalMessage;
}

export interface UndeliverableResendSkip {
  action: 'skip';
  reason: string;
}

export type UndeliverableResendDecision =
  UndeliverableResendPlan | UndeliverableResendGroupPlan | UndeliverableResendSkip;

/**
 * Decide whether the envelope the relay just reported undeliverable maps
 * to a message we can safely auto-resend. On a 'resend' decision the
 * budget is noted as a side effect (mirrors decideRecoveryDisposition),
 * so each caller counts as exactly one attempt.
 */
export function selectUndeliverableResend(
  state: {
    messages:      Record<string, LocalMessage[]>;
    conversations: Record<string, LocalConversation>;
  },
  envelopeId: string,
  nowMs: number,
): UndeliverableResendDecision {
  if (!envelopeId) {return {action: 'skip', reason: 'no-envelope-id'};}

  let conversationId: string | null = null;
  let message: LocalMessage | null = null;
  for (const [convId, list] of Object.entries(state.messages)) {
    // B-683 follow-up — match per-leg ids too (the B-143 lesson, again):
    // a group's all-dead flip usually completes on a NON-scalar leg, so a
    // scalar-only match made the group auto-resend depend on fan-out order.
    const hit = list.find(m => m.envelope_id === envelopeId ||
      Object.values(m.envelope_ids ?? {}).includes(envelopeId));
    if (hit) { conversationId = convId; message = hit; break; }
  }
  if (!conversationId || !message) {return {action: 'skip', reason: 'not-found'};}

  if (message.sender_id !== 'self') {return {action: 'skip', reason: 'not-own-outbound'};}
  // applyEnvelopeUndeliverable ran first; anything else means a stronger
  // signal won (read), the send never completed (sending/failed), or a
  // race — leave it alone.
  if (message.status !== 'undelivered') {return {action: 'skip', reason: `status-${message.status}`};}
  if (message.type !== 'text') {return {action: 'skip', reason: 'non-text'};}
  if (!message.content) {return {action: 'skip', reason: 'empty-content'};}

  const conv = state.conversations[conversationId];
  if (!conv) {return {action: 'skip', reason: 'no-conversation'};}

  let expiresAtSec: number | undefined;
  if (typeof message.expires_at === 'number') {
    if (message.expires_at <= nowMs) {return {action: 'skip', reason: 'expired'};}
    expiresAtSec = Math.floor(message.expires_at / 1000);
  }

  const used = attempts.get(message.id) ?? 0;
  if (used >= MAX_AUTO_RESENDS_PER_MESSAGE) {return {action: 'skip', reason: 'budget-exhausted'};}

  // B-683 follow-up — a non-direct 'undelivered' row means EVERY shipped
  // member destroyed it (the all-legs rule), so an automatic re-send
  // cannot duplicate for anyone. Execution = the manual chip's lane.
  // Critic D1 — that premise holds ONLY for map-bearing rows: a legacy
  // pre-B-187 row (no envelope_ids) is flipped by the scalar path on a
  // SINGLE leg's destroy, so other members may still HOLD the message and
  // an automatic fresh-wire-id re-send would duplicate for every holder.
  // Legacy rows stay manual-chip-only (a human chooses the duplicate risk).
  if (conv.type !== 'direct') {
    if (!message.envelope_ids || Object.keys(message.envelope_ids).length === 0) {
      return {action: 'skip', reason: 'legacy-no-legs'};
    }
    touchLru(message.id, used + 1);
    return {action: 'resend-group', conversationId, message};
  }

  const peer = message.peer;
  if (!peer?.userId) {return {action: 'skip', reason: 'no-peer'};}
  touchLru(message.id, used + 1);

  return {action: 'resend', conversationId, message, peer, expiresAtSec};
}

/** Test-only — number of tracked message ids (for the LRU-bound test). */
export function _undeliverableResendBudgetSize(): number {
  return attempts.size;
}

/** Test-only — reset the in-process budget. */
export function _resetUndeliverableResendBudget(): void {
  attempts.clear();
}
