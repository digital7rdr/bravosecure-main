-- ──────────────────────────────────────────────────────────────────────
-- Audit Rev2 API-06 — dedupe ledger for Stripe webhook events.
--
-- Stripe delivers webhooks AT-LEAST-ONCE and retries for up to 3 days on any
-- non-2xx, so a duplicate `invoice.paid` used to add another 30 days of Pro for
-- one payment (subscription.service.handleSubscriptionEvent ran the additive
-- GREATEST(...) + INTERVAL '30 days' unconditionally, with no dedupe).
--
-- Two design points that a naive `event_id`-only table gets wrong:
--   1. The PK is (event_id, handler), NOT event_id alone. Stripe delivers the
--      SAME event.id to EVERY configured endpoint, and this account has two
--      (auth-service /wallet/stripe-webhook and /subscription/stripe-webhook).
--      Today only the subscription handler writes here (handler='subscription')
--      — the wallet handler acts on DISJOINT event types (payment_intent.*) and
--      dedupes via its own status-guarded ledger flip, so it needs no row. The
--      composite key exists so that if the wallet handler is ever extended to a
--      shared event type, a shared event_id PK could not let one endpoint claim
--      the id and silently no-op the other.
--   2. The claim is written INSIDE the same transaction as the side effect
--      (subscription.service does this), so a crash between "claim" and "grant"
--      cannot permanently lose the grant — the transaction rolls back both.
--
-- RLS: enabled + forced to match the DB-01 deny-by-default rule. The backend
-- connects as `postgres` (BYPASSRLS), so server writes are unaffected; anon has
-- no policy and therefore no access.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.stripe_processed_events (
  event_id     TEXT        NOT NULL,
  handler      TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, handler)
);

-- Retention sweep support: ProLapseCron deletes rows older than 90 days.
CREATE INDEX IF NOT EXISTS stripe_processed_events_processed_at_idx
  ON public.stripe_processed_events (processed_at);

ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_processed_events FORCE  ROW LEVEL SECURITY;
