-- Step 26 — allow the `system` ops_audit subject_type for system-wide admin actions
-- (the runtime dispatch kill-switch flip records subject_type='system', subject_id='global').
-- The CHECK constraint pins the dimension space; roll it forward on schema change.
ALTER TABLE ops_audit
  DROP CONSTRAINT IF EXISTS ops_audit_subject_type_chk;
ALTER TABLE ops_audit
  ADD CONSTRAINT ops_audit_subject_type_chk
  CHECK (subject_type IN (
    'booking','mission','agent','job','sos','application','wallet','user',
    'pii','conversation','system'
  ));
