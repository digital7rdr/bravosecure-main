-- Founder QA 2026-08-08 — generalize the agency-flavoured seeded channel names
-- in EXISTING Enterprise workspaces. A workspace's staff may have nothing to do
-- with bodyguarding; 'CPO Roster' and 'Intel' are agency vocabulary. Agencies
-- (orgs WITHOUT an org_workspaces row) keep their set untouched (rule 7).
--
-- Guards: seeded rows only (created_by = org_id), workspace orgs only, and no
-- rename when the target name already exists in that org (avoids duplicates in
-- orgs where an admin already hand-created one).

UPDATE public.department_channels c
   SET name = 'Team Roster'
 WHERE c.name = 'CPO Roster'
   AND c.created_by = c.org_id
   AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
   AND NOT EXISTS (SELECT 1 FROM public.department_channels d
                    WHERE d.org_id = c.org_id AND d.name = 'Team Roster');

UPDATE public.department_channels c
   SET name = 'General', department = 'General'
 WHERE c.name = 'Intel'
   AND c.created_by = c.org_id
   AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id)
   AND NOT EXISTS (SELECT 1 FROM public.department_channels d
                    WHERE d.org_id = c.org_id AND d.name = 'General');

-- DOWN: not provided — the rename is cosmetic and one-way by design.
