-- Auto-dispatch hardening (BUILD_RUNBOOK Step 6 review, finding L4-MAJOR):
-- make "at most one LIVE (OFFERED) offer per booking" a HARD database invariant.
--
-- Step 6's cascade always transitions the current offer out of OFFERED
-- (REJECTED / EXPIRED / SUPERSEDED) BEFORE offering the next agency, so in the
-- sequential path this index never fires. It exists purely as a race guard: two
-- concurrent cascades for the same booking (e.g. the Step 8 expire-watchdog and
-- an inbound reject, or two auth-service pods) could otherwise each read the
-- offer-count + ranking on an interleaved snapshot and both INSERT a live offer,
-- letting two agencies hold an offer for one booking — which in Step 7 (accept)
-- would enable a double-confirm / double-charge. With this partial unique index
-- the second INSERT loses with 23505; DispatchService.offerNext distinguishes
-- this index (stop — another cascade already placed the live offer) from
-- dispatch_offers_one_live_per_provider (advance to the next-ranked agency).
--
-- Mirrors dispatch_offers_one_live_per_provider (20260620000000_auto_dispatch).
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offers_one_live_per_booking
  ON public.dispatch_offers (booking_id) WHERE status = 'OFFERED';
