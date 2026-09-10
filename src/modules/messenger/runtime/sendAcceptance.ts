/**
 * "Did the relay already take this send?" — one rule, two callers.
 *
 * B-683/F4 established the artifact test for the MSG-07 boot sweep: acceptance
 * artifacts prove the relay took the send, and every lane writes the retract
 * token BEFORE the envelope id, so a token with no id is the reachable
 * kill-window residue rather than an inconsistency.
 *
 * B-703 MR-4 needs the identical question at a second site, so the rule moved
 * here instead of being copied (this repo's most common bug shape is N drifted
 * copies of one behaviour). The race it answers: the WS ack watchdog gives up
 * and starts an HTTP retry; the server's `envelope.accepted` then lands WHILE
 * that retry is in flight, flipping the bubble to 'sent', recording the
 * envelope id and DELETING the durable outbox row. When the retry's own POST
 * then fails, `recordAttempt` finds no row, reports `queued: false`, and the
 * catch stamps 'failed' — over 'sent', on a message the relay is holding.
 * Both statuses are off-ladder, so status rank does not protect it. The retry
 * chip that appears then mints a FRESH wire id (B-122) which the relay's
 * (recipient, clientMsgId) dedup cannot coalesce, and the recipient receives
 * the message twice. One race, both of the founder's symptoms.
 *
 * Structural interface, not the store's `LocalMessage`: this module must stay
 * import-free so the node jest project can load it (house Tier-A rule).
 */

export interface SendAcceptanceProbe {
  status?: string | null;
  /** 1:1 — set by handleAccepted (WS) and by the HTTP fallback's response. */
  envelope_id?: string | null;
  retract_token?: string | null;
  /** Group fan-out — per-recipient maps. */
  envelope_ids?: Record<string, unknown> | null;
  retract_tokens?: Record<string, unknown> | null;
}

/** Artifacts ONLY: something the relay handed back for this message. */
export function hasAcceptanceArtifact(m: SendAcceptanceProbe): boolean {
  return !!(
    m.envelope_id ||
    m.retract_token ||
    (m.envelope_ids && Object.keys(m.envelope_ids).length > 0) ||
    (m.retract_tokens && Object.keys(m.retract_tokens).length > 0)
  );
}

/** Statuses that already mean "the server has it" — all above 'sending'. */
const ACCEPTED_STATUSES = new Set(['sent', 'delivered', 'read']);

/**
 * Artifact OR an already-advanced status.
 *
 * The status half matters because the two writes are separate store calls: a
 * miss on `updateMessageEnvelopeId` (the silent-miss class) would leave a row
 * that is visibly 'sent' with no artifact, and overwriting THAT with 'failed'
 * is the same user-visible bug.
 */
export function wasSendAccepted(m: SendAcceptanceProbe): boolean {
  return hasAcceptanceArtifact(m) || ACCEPTED_STATUSES.has(String(m.status ?? ''));
}

/**
 * Acceptance state captured immediately BEFORE an attempt ships.
 *
 * Why this exists: "does this row carry an artifact?" is NOT the question the
 * retry's failure handler needs answered. The 1:1 retry lane deliberately keeps
 * the previous attempt's `envelope_id` / `retract_token` (only the group lane
 * calls `resetWireArtifactsForResend`), so on every `undelivered` retry — B-122's
 * whole population — a round-1 artifact is still on the bubble. Treating that as
 * proof would make a genuinely failed round 2 return early, leaving the bubble
 * at 'sending' with no chip, no banner and no terminal outbox state: a permanent
 * spinner, and with no durable queue behind it, a lost message. That is strictly
 * worse than the false chip this guard was added to prevent.
 */
export interface AcceptanceSnapshot {
  envelopeId: string | null;
  retractToken: string | null;
  accepted: boolean;
}

export function snapshotAcceptance(m: SendAcceptanceProbe | null | undefined): AcceptanceSnapshot {
  return {
    envelopeId:   m?.envelope_id ?? null,
    retractToken: m?.retract_token ?? null,
    accepted:     !!m && wasSendAccepted(m),
  };
}

/**
 * Did the relay accept THIS attempt while it was in flight?
 *
 * True only when acceptance is newly present: either the row was not accepted
 * before and is now, or a NEW artifact landed on it. A row that merely still
 * carries the artifact it started with answers false, so its own failure is
 * reported honestly.
 */
export function acceptedDuringAttempt(
  before: AcceptanceSnapshot,
  after: SendAcceptanceProbe | null | undefined,
): boolean {
  if (!after || !wasSendAccepted(after)) {return false;}
  if (!before.accepted) {return true;}
  return (after.envelope_id ?? null) !== before.envelopeId ||
         (after.retract_token ?? null) !== before.retractToken;
}
