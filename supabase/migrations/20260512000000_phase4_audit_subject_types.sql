-- Audit fix 4.2 / 4.7 — extend `ops_audit.subject_type` to allow 'pii'
-- (click-to-reveal customer PII in the ops console) and 'conversation'
-- (every ops read of a mission group thread, per 4.7).
--
-- The Phase 2 constraint pinned the set so an ad-hoc INSERT couldn't
-- pollute the feed; rolling forward the set on schema change is the
-- intended evolution path.
ALTER TABLE ops_audit
  DROP CONSTRAINT IF EXISTS ops_audit_subject_type_chk;
ALTER TABLE ops_audit
  ADD CONSTRAINT ops_audit_subject_type_chk
  CHECK (subject_type IN (
    'booking','mission','agent','job','sos','application','wallet','user',
    'pii','conversation'
  ));
