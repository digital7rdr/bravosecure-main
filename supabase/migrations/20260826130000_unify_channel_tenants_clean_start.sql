-- 2026-08-26 — tenant unification: every org's channels start clean.
--
-- Client (via founder, verbatim intent): "There must never be pre made
-- channels, even on service provider channels. It must always come out clean
-- like on the new enterprise channels… All Channels must be exactly the same
-- and should also start the same… no need for 2 different types."
--
-- Service side (same change set): seedOrgWorkspace is now a no-op for BOTH
-- tenants, the per-level auto-#broadcast producer (ensureBroadcastForLevel)
-- is deleted outright, and archive/delete of a legacy #broadcast is allowed
-- for every tenant.
--
-- This migration retires the DB half of the old rule: the BEFORE DELETE
-- trigger from 20260803020000 that raised 'broadcast_channel_cannot_be_deleted'
-- (already workspace-exempted by 20260811160000). Its purpose was to protect
-- rows the SERVICE auto-created; the service creates none any more, no caller
-- can assert is_broadcast on the wire (channel.dto pins that), and parity for
-- existing service providers is precisely the ability to remove their seeded
-- rows themselves.
--
-- Deliberately KEPT:
--   * dept_channels_one_broadcast_per_level — a uniqueness fact about legacy
--     rows; harmless now, still true.
--   * dept_channel_broadcast_mode_trg — a legacy is_broadcast row that is
--     UPDATEd must stay announcement-mode; the rule is about what a broadcast
--     IS, not about who may remove it.
--
-- No data is touched. Existing seeded channels stay until an owner removes
-- them (the 20260817 purge script remains the manual bulk option).

DROP TRIGGER IF EXISTS dept_channel_block_broadcast_delete_trg
  ON public.department_channels;
DROP FUNCTION IF EXISTS public.dept_channel_block_broadcast_delete();
