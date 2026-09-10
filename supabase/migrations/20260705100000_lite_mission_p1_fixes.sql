-- Lite mission Phase-1 correctness fixes
-- (docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md §3.1)
--
-- LM-B1 — arrival no-show re-dispatch dead-end. missions.booking_id was hard-UNIQUE,
-- so the ABORTED mission left behind by ArrivalNoShowService.reDispatch permanently
-- blocked the replacement agency's crew-assign: the assignCrew tenant gate requires
-- "no mission row" and the UNIQUE blocked a fresh INSERT, so every re-crew attempt
-- 409'd (booking_not_assignable) and the escrow stayed HELD forever. Replace the
-- hard UNIQUE with a partial unique over non-ABORTED rows: at most ONE ACTIVE
-- mission per booking; ABORTED missions remain as history rows.
--
-- ⚠️ Deploy lock-step: code that says `ON CONFLICT (booking_id)` on missions can no
-- longer infer a conflict target after this migration (org-mission + job-feed were
-- updated to the partial-index target in the same change). Apply this migration and
-- deploy the matching auth-service build together.
ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_booking_id_key;
DROP INDEX IF EXISTS public.missions_booking_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS missions_booking_active_uq
  ON public.missions (booking_id) WHERE status <> 'ABORTED';

-- LM-B7 — family payer resolution on the auto path. The payer (family holder, or
-- the client themselves) is resolved ONCE at request time and stamped here;
-- DispatchService.accept()'s holdToEscrow debits THIS user and stamps it as
-- escrow_holds.client_id, so every later refund/split credits the actual payer.
ALTER TABLE public.lite_bookings ADD COLUMN IF NOT EXISTS payer_user_id uuid;

-- LM-C4 — per-crew check-in ("I'm in position"): non-lead members finally get a
-- visible, timestamped action; surfaces on the agency monitor + deployment view.
ALTER TABLE public.mission_crew ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

-- ─── F1 — invoice / receipt system ────────────────────────────────────────────
-- The pricing breakdown was computed at quote time and DISCARDED (only totals
-- survived); an invoice must reflect the quoted lines, not a recomputation.
ALTER TABLE public.lite_bookings ADD COLUMN IF NOT EXISTS pricing_breakdown jsonb;

-- Gapless per-region invoice numbering (AE-2026-000001 …).
CREATE TABLE IF NOT EXISTS public.invoice_sequences (
  region_code text PRIMARY KEY,
  next_no     bigint NOT NULL DEFAULT 1
);

-- One receipt (and at most one credit note) per booking; line_items carry the
-- itemised quote; totals are in Bravo Credits (1:1 EUR at quote time — the FX
-- provenance for fiat display lives on the wallet rows).
CREATE TABLE IF NOT EXISTS public.invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number   text NOT NULL UNIQUE,
  booking_id       uuid NOT NULL REFERENCES public.lite_bookings(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('client_receipt', 'credit_note')),
  issued_at        timestamptz NOT NULL DEFAULT NOW(),
  currency         text NOT NULL DEFAULT 'BC',
  line_items       jsonb NOT NULL DEFAULT '[]',
  subtotal_credits integer NOT NULL,
  tax_rate_pct     numeric NOT NULL DEFAULT 0,
  tax_credits      integer NOT NULL DEFAULT 0,
  total_credits    integer NOT NULL,
  pdf_url          text,
  UNIQUE (booking_id, kind)
);
CREATE INDEX IF NOT EXISTS invoices_booking_idx ON public.invoices (booking_id);
