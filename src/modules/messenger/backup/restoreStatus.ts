/**
 * Restore-status correctness — decide what message status to assign
 * after a backup restore.
 *
 * Bug discovered 2026-05-07: outbound messages on a freshly-restored
 * device were keeping their pre-delete status (1-tick / 2-tick /
 * blue-tick). That's a UX lie — the new device has never spoken to
 * the relay about those envelopes; the acks came from the OLD device's
 * WS session and don't transfer.
 *
 * Fix: outbound rows always floor to 'sent' (1-tick — strongest claim
 * we can keep without lying); inbound rows keep their persisted status
 * because read-state on received messages is locally driven (the user
 * marked it read on the old device because they actually saw it; that
 * truth survives restore).
 *
 * Pulled into its own file so the unit tests can import it without
 * dragging in the full restoreMessages module (which has heavy
 * transitive deps via backupClient → utils/constants).
 */
import type {LocalMessage} from '../store/types';

// P2-B-4 — the local message store stamps outbound rows with the
// sentinel sender id 'self' (not the owner UUID), and the mirror backs
// them up verbatim. A restored outbound row therefore arrives with
// sender_id === 'self', so the owner-UUID equality alone never fires
// and every real outbound row was treated as inbound (keeping zombie
// 'sending'/'failed'/'read' states after restore).
export const SELF_SENDER_ID = 'self';

/**
 * P2-B-4 — directional check shared by the status floor and the peer
 * fallback in restoreMessages. A row is outbound when its sender is
 * the owner UUID (rows written by older mirrors / server-side paths)
 * OR the store's 'self' sentinel (every row the local store writes).
 */
export function isOutboundSenderId(rowSenderId: string, ownerUserId: string): boolean {
  return rowSenderId === ownerUserId || rowSenderId === SELF_SENDER_ID;
}

/**
 * Decide the status to assign to a restored message row.
 *
 * Outbound side-effects:
 *   • 'delivered' / 'read' — the OLD device's acks; we cannot prove
 *     them on the new device → downgrade to 'sent' so we don't lie
 *   • 'sending' / 'failed' — zombie states; the pendingByClientMsgId
 *     Map is empty on a fresh runtime, so nothing would ever retry
 *     them → resolve to 'sent' so the user doesn't stare at a
 *     forever-clock or a non-actionable error pill
 *   • 'sent' — already at the floor, kept as-is
 *
 * Inbound: keep whatever the backup says (or 'delivered' default for
 * legacy rows that pre-date the status field).
 *
 * Pure function — exported for unit tests.
 */
export function decideRestoredStatus(
  rowSenderId:    string,
  ownerUserId:    string,
  decodedStatus:  LocalMessage['status'] | undefined,
): LocalMessage['status'] {
  if (isOutboundSenderId(rowSenderId, ownerUserId)) {
    return 'sent';
  }
  return decodedStatus ?? 'delivered';
}
