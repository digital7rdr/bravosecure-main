-- Refund idempotency (audit C2 — "paid booking cancelled = money vaporized")
--
-- A confirmed booking that was paid (lite_bookings.payment_captured = TRUE)
-- debited the client's wallet via a `type='payment'` row. Cancelling or
-- aborting that booking previously did NOT reverse the debit — the client
-- lost their credits with no refund path. `WalletService.refundForBooking`
-- now mints a `type='refund'` credit on cancel/abort.
--
-- To make that refund safe under retries and the cancel/abort race (a
-- client cancel and an ops abort can both fire), we need at-most-once
-- semantics per (user, booking) for the booking-cancellation refund.
--
-- Note: the payout-idempotency migration deliberately EXCLUDED refunds
-- from uniqueness because top-up reversals can legitimately repeat for a
-- booking. We scope THIS index to booking-cancellation refunds only via a
-- metadata marker (`metadata->>'kind' = 'booking_refund'`) so unrelated
-- refund rows are unaffected.

CREATE UNIQUE INDEX IF NOT EXISTS ux_wallet_tx_booking_refund
  ON wallet_transactions (user_id, booking_id)
  WHERE type = 'refund'
    AND booking_id IS NOT NULL
    AND metadata->>'kind' = 'booking_refund';
