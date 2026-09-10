-- Audit fix Phase 2 — data integrity & audit hardening.
--
-- Bundles the five sub-fixes:
--   2.1  ops_audit append-only enforcement (BEFORE UPDATE/DELETE → RAISE)
--        + REVOKE UPDATE/DELETE from the application role.
--   2.2  Foreign keys for `mission_crew.agent_id`, `job_applications.agent_id`,
--        `sos_events.mission_id`, `admin_users.user_id`. mission_id stays
--        nullable (legacy client-side SOS events have NULL).
--   2.3  CHECK constraints + named enums for `mission_waypoints.state`,
--        `mission_crew.role` / `mission_crew.status`, `ops_audit.actor_role` /
--        `ops_audit.subject_type`. Plus an FSM-enforcement trigger on
--        `missions.status` and `lite_bookings.status` rejecting invalid
--        transitions at the DB layer.
--   2.4  Drop the four `gen_random_uuid()`-seeded admin rows from the
--        ops_admin migration. Until invite-flow lands, admins are seeded
--        by an out-of-band one-shot script that creates a real users row
--        first; the random-uuid rows pointed at non-existent users.
--   2.5  Schema-side prep for cpo_pool: nothing here — the application
--        change replaces hardcoded armed/region/specialties with reads
--        from agent_profiles.coverage and capabilities. Listed in the
--        commit so this migration is the single boundary for Phase 2.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.1  ops_audit append-only
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops_audit_no_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ops_audit is append-only — UPDATE/DELETE forbidden (use a corrective insert with action=*.correction)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ops_audit_no_update ON ops_audit;
CREATE TRIGGER ops_audit_no_update
  BEFORE UPDATE ON ops_audit
  FOR EACH ROW EXECUTE FUNCTION ops_audit_no_mutation();

DROP TRIGGER IF EXISTS ops_audit_no_delete ON ops_audit;
CREATE TRIGGER ops_audit_no_delete
  BEFORE DELETE ON ops_audit
  FOR EACH ROW EXECUTE FUNCTION ops_audit_no_mutation();

-- REVOKE-able role: in self-hosted Postgres the auth-service connects
-- as a single role (e.g. `auth_service`); on Supabase the equivalent is
-- the service-role / app-role. The DO-block below picks whichever role
-- exists so this migration is portable. If neither exists, skip — the
-- triggers above are the authoritative defense; the REVOKE is just
-- belt-and-braces for direct-DB access.
DO $$
DECLARE
  app_role TEXT;
BEGIN
  FOR app_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('auth_service','authenticated','service_role','postgres')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON ops_audit FROM %I', app_role);
  END LOOP;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.2  Foreign keys
-- ─────────────────────────────────────────────────────────────────────────────

-- mission_crew.agent_id → agents(user_id). Was a soft reference before.
-- Soft-fail (NOT VALID) so a deploy with stale rows doesn't block; the
-- VALIDATE step is opt-in (see end-of-migration note). Once the table is
-- known clean, run `ALTER TABLE mission_crew VALIDATE CONSTRAINT
-- mission_crew_agent_id_fk;`.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mission_crew_agent_id_fk'
  ) THEN
    ALTER TABLE mission_crew
      ADD CONSTRAINT mission_crew_agent_id_fk
      FOREIGN KEY (agent_id) REFERENCES agents(user_id) ON DELETE RESTRICT
      NOT VALID;
  END IF;
END$$;

-- job_applications.agent_id → agents(user_id). Same pattern.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'job_applications_agent_id_fk'
  ) THEN
    ALTER TABLE job_applications
      ADD CONSTRAINT job_applications_agent_id_fk
      FOREIGN KEY (agent_id) REFERENCES agents(user_id) ON DELETE RESTRICT
      NOT VALID;
  END IF;
END$$;

-- sos_events.mission_id → missions(id). Allow NULL because legacy
-- client-raised SOS events (Phase 0.7) don't carry a mission id.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sos_events_mission_id_fk'
  ) THEN
    ALTER TABLE sos_events
      ADD CONSTRAINT sos_events_mission_id_fk
      FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END$$;

-- admin_users.user_id → users(id). Hard FK because every admin MUST
-- correspond to a real user row — the demo seed cleanup below removes
-- the orphans that would otherwise block validation.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'admin_users_user_id_fk'
  ) THEN
    ALTER TABLE admin_users
      ADD CONSTRAINT admin_users_user_id_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.3  CHECK constraints (named enums where reusable, CHECK where one-off)
-- ─────────────────────────────────────────────────────────────────────────────

-- mission_waypoints.state  ∈ {pending, current, done, sos}
ALTER TABLE mission_waypoints
  DROP CONSTRAINT IF EXISTS mission_waypoints_state_chk;
ALTER TABLE mission_waypoints
  ADD CONSTRAINT mission_waypoints_state_chk
  CHECK (state IN ('pending','current','done','sos'));

-- mission_crew.role  ∈ {LEAD, CP, DRIVER, RESERVE}
ALTER TABLE mission_crew
  DROP CONSTRAINT IF EXISTS mission_crew_role_chk;
ALTER TABLE mission_crew
  ADD CONSTRAINT mission_crew_role_chk
  CHECK (role IN ('LEAD','CP','DRIVER','RESERVE'));

-- mission_crew.status  ∈ {active, sos, standby, off}
ALTER TABLE mission_crew
  DROP CONSTRAINT IF EXISTS mission_crew_status_chk;
ALTER TABLE mission_crew
  ADD CONSTRAINT mission_crew_status_chk
  CHECK (status IN ('active','sos','standby','off'));

-- ops_audit.actor_role / subject_type — pin the dimension space so an
-- ad-hoc INSERT can't pollute the audit feed with stray strings.
ALTER TABLE ops_audit
  DROP CONSTRAINT IF EXISTS ops_audit_actor_role_chk;
ALTER TABLE ops_audit
  ADD CONSTRAINT ops_audit_actor_role_chk
  CHECK (actor_role IN ('OPS','SUPERVISOR','ADMIN','SYSTEM','AGENT','CLIENT'));

ALTER TABLE ops_audit
  DROP CONSTRAINT IF EXISTS ops_audit_subject_type_chk;
ALTER TABLE ops_audit
  ADD CONSTRAINT ops_audit_subject_type_chk
  CHECK (subject_type IN ('booking','mission','agent','job','sos','application','wallet','user'));

-- ── FSM-enforcement triggers ───────────────────────────────────────────────
-- Server code already has FSM helpers (BookingStateMachine, MissionStateMachine).
-- DB-layer triggers act as the last line of defense: even if a service method
-- bypasses the FSM (or a future `psql -c` does), invalid transitions error
-- out at the storage layer.

CREATE OR REPLACE FUNCTION lite_bookings_fsm_check() RETURNS TRIGGER AS $$
BEGIN
  -- No-op when status didn't change.
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- Allowed transitions, mirrored from booking/state-machine.service.ts.
  -- Listed exhaustively so an audit reader sees the legal graph at a
  -- glance. Any pair not in this set raises.
  IF NOT (
    (OLD.status = 'DRAFT'           AND NEW.status IN ('PENDING_OPS','CANCELLED'))
    OR (OLD.status = 'PENDING_OPS'   AND NEW.status IN ('OPS_APPROVED','CANCELLED'))
    OR (OLD.status = 'OPS_APPROVED'  AND NEW.status IN ('PAYMENT_PENDING','CANCELLED'))
    OR (OLD.status = 'PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','CANCELLED'))
    OR (OLD.status = 'CONFIRMED'     AND NEW.status IN ('LIVE','CANCELLED'))
    OR (OLD.status = 'LIVE'          AND NEW.status IN ('COMPLETED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid_booking_transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lite_bookings_fsm_check ON lite_bookings;
CREATE TRIGGER lite_bookings_fsm_check
  BEFORE UPDATE ON lite_bookings
  FOR EACH ROW EXECUTE FUNCTION lite_bookings_fsm_check();

CREATE OR REPLACE FUNCTION missions_fsm_check() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'DISPATCHED' AND NEW.status IN ('PICKUP','LIVE','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'PICKUP'   AND NEW.status IN ('LIVE','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'LIVE'     AND NEW.status IN ('SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'SOS'      AND NEW.status IN ('LIVE','ABORTED','COMPLETED'))
  ) THEN
    RAISE EXCEPTION 'invalid_mission_transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS missions_fsm_check ON missions;
CREATE TRIGGER missions_fsm_check
  BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION missions_fsm_check();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.4  Demo seed admin cleanup
-- ─────────────────────────────────────────────────────────────────────────────
-- The four rows seeded by 20260424000000_ops_admin.sql:64-70 used
-- gen_random_uuid() for user_id, which means there's no matching users row.
-- Once 2.2 lands a hard FK admin_users.user_id → users(id), validating
-- the constraint will fail unless we either delete or backfill these rows.
-- Real admins are minted via the OTP register flow (or, post-Phase 0.1,
-- the invite flow), which creates the users row first — the demo rows
-- never had real auth attached.
DELETE FROM admin_users
 WHERE call_sign IN ('OPS-01','OPS-02','OPS-03','ADM-01')
   AND NOT EXISTS (
     SELECT 1 FROM public.users u WHERE u.id = admin_users.user_id
   );

-- ─────────────────────────────────────────────────────────────────────────────
-- Validation note
-- ─────────────────────────────────────────────────────────────────────────────
-- The four foreign keys above land as NOT VALID so a deploy doesn't fail
-- on stale rows. After verifying the orphans are gone, run:
--
--   ALTER TABLE mission_crew    VALIDATE CONSTRAINT mission_crew_agent_id_fk;
--   ALTER TABLE job_applications VALIDATE CONSTRAINT job_applications_agent_id_fk;
--   ALTER TABLE sos_events       VALIDATE CONSTRAINT sos_events_mission_id_fk;
--   ALTER TABLE admin_users      VALIDATE CONSTRAINT admin_users_user_id_fk;
--
-- These are catalog-level no-ops on already-valid rows but lock the table
-- briefly — schedule them in a low-traffic window. NOT VALID still
-- enforces the constraint on FUTURE inserts/updates, which is the point.
