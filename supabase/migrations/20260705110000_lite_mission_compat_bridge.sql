-- TEMPORARY compatibility bridge (2026-07-05) — REMOVE AFTER the auth-service
-- container on Contabo is rebuilt with the lite-mission Phase-1 code.
--
-- Why: lite_mission_p1_fixes replaced the hard UNIQUE on missions.booking_id
-- with the partial missions_booking_active_uq, but the RUNNING (old)
-- auth-service says `ON CONFLICT (booking_id)` without an index predicate —
-- which can only infer a NON-partial unique index. Without this bridge, every
-- crew-assign / legacy job-feed dispatch on staging errors.
--
-- With the bridge: old code works fully; new code still infers the partial
-- index for its predicate form — only the rare re-dispatch re-crew (2nd
-- mission per booking) is blocked until this bridge is dropped.
--
-- POST-DEPLOY STEP (required): DROP INDEX public.missions_booking_id_bridge;
CREATE UNIQUE INDEX IF NOT EXISTS missions_booking_id_bridge
  ON public.missions (booking_id);
