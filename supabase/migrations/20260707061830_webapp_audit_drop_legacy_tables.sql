-- DC-12 — drop the 16 dead/legacy tables (0 code references verified; all FKs
-- point only within the legacy set). DDL is recoverable from the original
-- migrations (init_phase1 / booking_module / vbg_module / intel).
-- Order: children before parents; CASCADE covers the intra-set FKs.

-- Legacy booking schema (superseded by lite_bookings/*)
drop table if exists public.booking_addons cascade;
drop table if exists public.booking_assignments cascade;
drop table if exists public.itineraries cascade;
drop table if exists public.gps_pings cascade;            -- partitioned parent
drop table if exists public.gps_pings_default cascade;    -- default partition
drop table if exists public.bookings cascade;
drop table if exists public.corporate_members cascade;
drop table if exists public.corporate_accounts cascade;

-- Legacy money schema (superseded by wallet_balances)
drop table if exists public.wallets cascade;

-- Superseded audit / relay / vault / coverage
drop table if exists public.audit_events cascade;
drop table if exists public.message_envelopes cascade;
drop table if exists public.vault_items cascade;
drop table if exists public.media_recipient_grants cascade;
drop table if exists public.agent_coverage_zones cascade;

-- Unused intel seed tables
drop table if exists public.intel_items cascade;
drop table if exists public.intel_sources cascade;
