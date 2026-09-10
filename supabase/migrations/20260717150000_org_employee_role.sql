-- M1A rule 16 v2 — Enterprise individuals manage EMPLOYEES.
--
-- 'employee' is a messenger-workspace member: dept channels, attendance and
-- incident reporting — WITHOUT becoming a deployable CPO or a manager.
-- deriveAccountKind only reacts to 'cpo'/'manager', so enrolling an existing
-- user as an employee never hijacks their app shell; DeptChatAccessGuard's
-- membership path admits any active row, so dept access follows automatically.

ALTER TABLE public.org_members DROP CONSTRAINT IF EXISTS org_members_member_role_check;
ALTER TABLE public.org_members
  ADD CONSTRAINT org_members_member_role_check
  CHECK (member_role IN ('cpo', 'manager', 'employee'));
