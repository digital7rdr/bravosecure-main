/**
 * Regression test — restore-status correctness.
 *
 * Bug discovered 2026-05-07: when a user deletes the app and restores
 * from backup, outbound messages were keeping their pre-delete status
 * ('sent' / 'delivered' / 'read'). That's a UX lie — the freshly-
 * installed device has never spoken to the relay about those
 * envelopes; the acks came from the OLD device's WS session and
 * don't transfer. WhatsApp/Signal both downgrade to a single tick
 * ('sent') after restore for the same reason.
 *
 * The fix is in `decideRestoredStatus` (restoreMessages.ts):
 * outbound rows always floor to 'sent'; inbound rows keep their
 * persisted status (read-state on received messages is locally
 * driven, so it's still semantically true after restore).
 *
 * This test exercises every status transition the helper has to
 * decide, plus the directional split (outbound vs inbound).
 */
import {decideRestoredStatus, isOutboundSenderId, SELF_SENDER_ID} from '../backup/restoreStatus';

const ME    = 'user-self';
const OTHER = 'user-other';

describe('decideRestoredStatus (post-restore correctness)', () => {
  describe('outbound messages — must floor to "sent"', () => {
    // Every status the old device could have stored; all floor to 'sent'
    // because the new device has no proof of any of them.
    it.each(['sending', 'sent', 'delivered', 'read', 'failed', undefined] as const)(
      'outbound with backup status=%s → "sent"',
      backupStatus => {
        // sender_id matches ownerUserId → outbound
        expect(decideRestoredStatus(ME, ME, backupStatus)).toBe('sent');
      },
    );

    it('does NOT propagate a "delivered" lie from backup', () => {
      // The original bug: 2-tick from old device survives restore.
      expect(decideRestoredStatus(ME, ME, 'delivered')).not.toBe('delivered');
      expect(decideRestoredStatus(ME, ME, 'delivered')).toBe('sent');
    });

    it('does NOT propagate a "read" lie from backup', () => {
      // Worse case: blue-tick (read receipt) survives restore.
      expect(decideRestoredStatus(ME, ME, 'read')).not.toBe('read');
      expect(decideRestoredStatus(ME, ME, 'read')).toBe('sent');
    });

    it('resolves zombie "sending" — fresh runtime cannot retry', () => {
      // pendingByClientMsgId Map is empty after restore; nothing would
      // ever retry a 'sending' message. Showing it at 1-tick prevents
      // the user staring at a clock that never resolves.
      expect(decideRestoredStatus(ME, ME, 'sending')).toBe('sent');
    });

    it('resolves zombie "failed" — same reason as sending', () => {
      // Old device's failed envelope id is gone; user has no Retry
      // context. Better to show 1-tick than a permanent error pill.
      expect(decideRestoredStatus(ME, ME, 'failed')).toBe('sent');
    });
  });

  describe('inbound messages — preserve backup status', () => {
    // Read-state on received messages is locally driven on the old
    // device; the user marked it read because they actually saw it.
    // That truth survives restore, so we keep the value.
    it('inbound with backup status=read → "read"', () => {
      expect(decideRestoredStatus(OTHER, ME, 'read')).toBe('read');
    });

    it('inbound with backup status=delivered → "delivered"', () => {
      expect(decideRestoredStatus(OTHER, ME, 'delivered')).toBe('delivered');
    });

    it('inbound with no status field → defaults to "delivered"', () => {
      // Legacy backup rows that pre-date the status field. Defaulting
      // to 'delivered' for inbound is fine — the user can see it,
      // therefore it was delivered to them at some point.
      expect(decideRestoredStatus(OTHER, ME, undefined)).toBe('delivered');
    });

    it('inbound never gets floored to "sent" by mistake', () => {
      // Sanity guard against a future regression where someone moves
      // the floor logic above the direction check.
      expect(decideRestoredStatus(OTHER, ME, 'read')).not.toBe('sent');
    });
  });

  describe('direction edge cases', () => {
    it('treats string-equality as the directional check', () => {
      // sender_id and ownerUserId both happen to be the same string
      // representation — outbound. Whitespace or case differences are
      // NOT normalised; the caller is responsible for canonical IDs.
      expect(decideRestoredStatus('abc-123', 'abc-123', 'read')).toBe('sent');
      expect(decideRestoredStatus('abc-123', 'ABC-123', 'read')).toBe('read');
    });
  });

  // P2-B-4 — the production store writes outbound rows with the 'self'
  // sentinel (NOT the owner UUID), and the mirror backs them up verbatim.
  // The pre-fix suite only ever used UUID sender ids, which is why the
  // dead outbound path passed: rowSenderId === ownerUserId was never true
  // for a real restored outbound row, so 'sending'/'failed'/'read'
  // zombies survived every restore.
  describe("P2-B-4 — 'self' sentinel outbound rows", () => {
    it.each(['sending', 'sent', 'delivered', 'read', 'failed', undefined] as const)(
      "sender_id='self' with backup status=%s → 'sent'",
      backupStatus => {
        expect(decideRestoredStatus(SELF_SENDER_ID, ME, backupStatus)).toBe('sent');
      },
    );

    it("does NOT propagate a zombie 'sending' clock from a 'self' row", () => {
      expect(decideRestoredStatus('self', 'a1b2c3-uuid', 'sending')).toBe('sent');
    });

    it("does NOT propagate a 'read' lie from a 'self' row", () => {
      expect(decideRestoredStatus('self', 'a1b2c3-uuid', 'read')).toBe('sent');
    });

    it('isOutboundSenderId accepts BOTH the owner UUID and the sentinel', () => {
      expect(isOutboundSenderId(ME, ME)).toBe(true);
      expect(isOutboundSenderId(SELF_SENDER_ID, ME)).toBe(true);
      expect(isOutboundSenderId(OTHER, ME)).toBe(false);
    });

    it("an inbound peer named literally 'self' cannot exist upstream — sentinel wins", () => {
      // Why: 'self' is reserved by the local store; a genuine peer UUID
      // can never equal it, so treating it as outbound is always safe.
      expect(decideRestoredStatus('self', ME, 'read')).not.toBe('read');
    });
  });
});
