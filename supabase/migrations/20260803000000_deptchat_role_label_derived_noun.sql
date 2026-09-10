-- Enterprise Dept Channels scope v2, frame A7.3 — "Use Member terminology
-- throughout; remove remaining Employee or CPO labels."
--
-- THE DEFECT THIS REPAIRS. `department_channel_members.role_label` is documented
-- (20260603000000, line 54) as a *custom display badge*, e.g. 'CPO Surveillance'.
-- Two write paths were instead stamping the GENERIC, TENANT-DEPENDENT staff noun
-- into it:
--
--   * department.service.ts seedChannelMembers — hardcoded 'CPO' for EVERY
--     tenant, including Enterprise workspaces.
--   * ChannelMembersScreen — wrote whatever deptMemberNoun() returned at the
--     moment the member was added ('Employee' for Enterprise, 'CPO' otherwise).
--
-- The client renders `m.role_label ?? <live noun>`, so the STORED string wins.
-- Renaming the Enterprise noun to 'Member' therefore could not fix existing
-- rows: one roster would show 'Employee', 'CPO' and 'Member' side by side
-- permanently. Both write sites now store NULL for non-managers so the noun is
-- derived at render; this migration clears the values they already froze.
--
-- SAFETY. Exact-match only, so genuine custom badges ('CPO Surveillance',
-- 'Employee Liaison', 'Member Services') are NOT touched — only the bare
-- derived nouns. 'Manager' is deliberately preserved: it is tenant-independent
-- and is still written by both paths. Idempotent; re-running is a no-op.
-- Display-only column — no permission, membership or E2EE effect.

UPDATE public.department_channel_members
   SET role_label = NULL
 WHERE role_label IN ('CPO', 'CPOs', 'Employee', 'Employees', 'Member', 'Members');

-- ── Down migration ───────────────────────────────────────────────────────────
-- Not reversible, and deliberately so: the original values were derived, not
-- authored, so there is nothing meaningful to restore. Re-deriving them at
-- render is the correct behaviour and is what the code now does.
