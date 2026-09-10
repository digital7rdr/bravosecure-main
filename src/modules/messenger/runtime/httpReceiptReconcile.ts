/**
 * OM-03 (B-121 G1-RT / NA-GATE-1 design A) — reconcile delivery ticks
 * for envelopes submitted over HTTP.
 *
 * The relay can push `envelope.delivered` only to a submitter it has a
 * live-socket mapping for, and Sealed Sender forbids recording who
 * submitted over HTTP. So every ack-watchdog fallback and every outbox
 * drain produced a bubble permanently stuck at single tick. The sender
 * instead polls an anonymous, capability-gated receipt slot with the
 * retract token it already persisted for that message.
 *
 * Lives in its own module for the reason stated in envelopeDelivered.ts:
 * the messenger-crypto Jest project runs under Node and cannot require
 * op-sqlite via productionRuntime.
 */

import {useMessengerStore} from '../store/messengerStore';
import type {RelayReceiptOutcome} from '@bravo/messenger-core';
import {applyEnvelopeDelivered} from './envelopeDelivered';
import {applyEnvelopeUndeliverable} from './decryptFailureSignal';
import type {LocalMessage} from '../store/types';

export interface ReceiptProbe {
  envelopeId: string;
  retractToken: string;
}

/** Matches the server's settled-receipt TTL — older rows can only answer 'unknown'. */
const RECEIPT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_PROBES = 100;

/**
 * Pure selector — exported for tests. Candidates are OUR OWN messages
 * still at single tick that carry both an envelope id and a retract
 * token (the pair the HTTP send path records). `skip` holds ids the
 * relay already answered `'unknown'` for, so a dead slot is asked once.
 *
 * B-187 — a group row with BOTH maps (`envelope_ids` + `retract_tokens`)
 * emits one probe per still-unsettled leg, so ✓✓ can mean "all members
 * have it". A row with the id map but NO tokens map (written before
 * schema v19) grandfathers to the scalar single probe — its per-leg
 * tokens are simply gone and nothing local can reconstruct them.
 */
export function selectReceiptProbes(
  messages: Record<string, LocalMessage[]>,
  nowMs: number,
  skip: ReadonlySet<string>,
): ReceiptProbe[] {
  const out: ReceiptProbe[] = [];
  for (const list of Object.values(messages)) {
    for (const msg of list) {
      if (msg.sender_id !== 'self') {continue;}
      if (msg.status !== 'sent') {continue;}
      const at = Date.parse(msg.created_at);
      if (!Number.isFinite(at) || nowMs - at > RECEIPT_WINDOW_MS) {continue;}
      const legIds = msg.envelope_ids;
      const legTokens = msg.retract_tokens;
      if (legIds && legTokens && Object.keys(legTokens).length > 0) {
        for (const [userId, envelopeId] of Object.entries(legIds)) {
          const token = legTokens[userId];
          if (!envelopeId || !token) {continue;}
          if (skip.has(envelopeId)) {continue;}
          const settled = msg.receipts?.[userId]?.status;
          if (settled === 'delivered' || settled === 'read') {continue;}
          // B-683/F3 — a terminally destroyed leg is settled too: without
          // this skip the poll re-asks (and re-fires the verdict) every
          // 60s forever and burns MAX_PROBES slots.
          if (msg.undeliverable_legs?.[userId] !== undefined) {continue;}
          out.push({envelopeId, retractToken: token});
        }
        continue;
      }
      if (!msg.envelope_id || !msg.retract_token) {continue;}
      if (skip.has(msg.envelope_id)) {continue;}
      out.push({envelopeId: msg.envelope_id, retractToken: msg.retract_token});
    }
  }
  return out.slice(-MAX_PROBES);
}

/**
 * B-703 MR-16 — `'unknown'` used to be a PERMANENT per-session skip, and that
 * is why a 1:1 could sit at one tick until the app was restarted.
 *
 * A WS-submitted envelope opens no server receipt slot at all (the gateway
 * passes no `receipt` to `submitEnvelope`), so the very first poll for it
 * answers `'unknown'` — and the memo then made sure it was never asked again.
 * The delivered frame is the only other route, and its REPLAY emit is
 * fire-and-forget-then-delete, so losing it left the tick stuck for the whole
 * session with nothing able to heal it but a read receipt.
 *
 * The memo still exists — re-asking every 60 s forever would burn the probe
 * budget on envelopes that genuinely have no slot — but it now DECAYS: a few
 * spaced retries, then it latches. A slot that appears later (a redelivery, a
 * server that starts recording them) is picked up; one that never appears
 * costs a handful of probes rather than an unbounded stream.
 */
const UNKNOWN_RETRY_AFTER_MS = 5 * 60_000;
const UNKNOWN_MAX_RETRIES = 3;
const UNKNOWN_MEMO_MAX = 500;
const unknownEnvelopes = new Map<string, {at: number; tries: number}>();
let receiptsUnsupported = false;
let inflight = false;

/** Ids that must NOT be probed on this pass — cooling down, or latched off. */
function currentUnknownSkips(now: number): Set<string> {
  const skip = new Set<string>();
  for (const [id, e] of unknownEnvelopes) {
    if (e.tries >= UNKNOWN_MAX_RETRIES || now - e.at < UNKNOWN_RETRY_AFTER_MS) {skip.add(id);}
  }
  return skip;
}

function noteUnknown(envelopeId: string, now: number): void {
  const prev = unknownEnvelopes.get(envelopeId);
  unknownEnvelopes.set(envelopeId, {at: now, tries: (prev?.tries ?? 0) + 1});
  if (unknownEnvelopes.size > UNKNOWN_MEMO_MAX) {
    const oldest = unknownEnvelopes.keys().next();
    if (!oldest.done) {unknownEnvelopes.delete(oldest.value);}
  }
}

/** Test/logout hook — clears the per-session probe memo. */
export function resetReceiptReconcile(): void {
  unknownEnvelopes.clear();
  receiptsUnsupported = false;
  inflight = false;
}

export async function reconcileHttpReceipts(deps: {
  fetchReceipts: (
    items: ReceiptProbe[],
  ) => Promise<{receipts: Array<{envelopeId: string; outcome: RelayReceiptOutcome}>}>;
  isOurEpoch: () => boolean;
  onUndeliverable?: (envelopeId: string) => void;
}): Promise<void> {
  if (receiptsUnsupported || inflight || !deps.isOurEpoch()) {return;}
  const now = Date.now();
  const probes = selectReceiptProbes(
    useMessengerStore.getState().messages,
    now,
    currentUnknownSkips(now),
  );
  if (probes.length === 0) {return;}
  inflight = true;
  try {
    const res = await deps.fetchReceipts(probes);
    if (!deps.isOurEpoch()) {return;}
    for (const r of res.receipts) {
      switch (r.outcome) {
        case 'delivered':
          applyEnvelopeDelivered(r.envelopeId);
          break;
        case 'discarded':
          applyEnvelopeUndeliverable(r.envelopeId);
          deps.onUndeliverable?.(r.envelopeId);
          break;
        case 'unknown':
          noteUnknown(r.envelopeId, Date.now());
          break;
        default:
          break;
      }
    }
  } catch (e) {
    // Why: a 404 means the relay predates the route — latch off for the
    // session instead of re-asking every 60 s. Any other failure is
    // transient; the next reconnect/timer tick retries.
    if ((e as {status?: number}).status === 404) {
      receiptsUnsupported = true;
    }
  } finally {
    inflight = false;
  }
}
