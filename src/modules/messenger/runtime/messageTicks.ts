/**
 * B-131 — THE tick rule. One implementation, imported by every surface that
 * draws delivery state.
 *
 * The chat bubble and the conversation-list row disagreed: the bubble mapped the
 * message's real `status`, while the list rendered `unread_count === 0`. That
 * expression means "*I* have no unread incoming messages" — it says nothing
 * about whether the PEER read MY message — so every conversation with a cleared
 * badge drew a blue double tick, including ones whose last outgoing message was
 * still only `sent`.
 *
 * Pure and presentation-free ON PURPOSE: it returns a semantic tick, not an icon
 * name or a colour. Each surface owns its own visual mapping (the bubble uses
 * muted/glow brand tokens, the list row is smaller and single-coloured), but
 * neither gets to own the RULE. That split is what keeps them from drifting
 * apart again while both still look "correct" in isolation.
 */

export type TickKind =
  /** Not our message, or nothing to show. */
  | 'none'
  /** Queued / in flight — no tick yet. */
  | 'pending'
  /** Accepted by the relay; the peer has not received it. */
  | 'single'
  /** Delivered to the peer's device. */
  | 'double'
  /** The peer read it. */
  | 'double-read'
  /** Send failed, or the recipient's device destroyed the envelope. */
  | 'failed';

/** The subset of a message this rule needs. Keeps the module store-agnostic. */
export interface TickMessageLike {
  status?:    string;
  sender_id?: string;
}

export function outgoingTick(msg: TickMessageLike | undefined | null): TickKind {
  if (!msg) {return 'none';}
  // Ticks describe OUR delivery state. An incoming last message gets none —
  // drawing one there was half of the reported bug.
  if (msg.sender_id !== 'self') {return 'none';}
  switch (msg.status) {
    case 'sending':     return 'pending';
    case 'sent':        return 'single';
    case 'delivered':   return 'double';
    case 'read':        return 'double-read';
    case 'failed':      return 'failed';
    // The recipient's device destroyed the envelope (decrypt failure). It was
    // NOT delivered — any tick here would be a lie.
    case 'undelivered': return 'failed';
    default:            return 'none';
  }
}
