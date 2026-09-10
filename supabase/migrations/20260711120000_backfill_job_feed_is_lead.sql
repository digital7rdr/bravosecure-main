-- LB-OTP4 — backfill mission_crew.is_lead for missions crewed via the legacy
-- ops/admin job-board (JobFeedService.dispatch), which inserted crew WITHOUT the
-- is_lead boolean (column default FALSE). The client verify-code endpoint resolves
-- the lead via `WHERE mc.is_lead = TRUE`, so those missions returned 400
-- `no_crew_assigned` forever and the principal's team-code card showed permanent
-- dots. The writer is fixed in job-feed.service.ts; this repairs existing rows.
--
-- Derive the lead from the role='LEAD' marker (slot 0), and ONLY for missions that
-- currently have no lead row at all — never touch a mission that already has a
-- proper is_lead=TRUE from the org/auto-dispatch path. Idempotent.

UPDATE mission_crew mc
   SET is_lead = TRUE
 WHERE mc.role = 'LEAD'
   AND mc.slot = 0          -- defensive: exactly one slot-0 lead per mission, so this
                            -- can never promote two rows even on dirty legacy data
   AND mc.is_lead = FALSE
   AND NOT EXISTS (
     SELECT 1 FROM mission_crew x
      WHERE x.mission_id = mc.mission_id
        AND x.is_lead = TRUE
   );
