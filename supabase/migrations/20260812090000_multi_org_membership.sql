-- Channels vs2 item 4 — a person may belong to MORE THAN ONE organisation.
--
-- Founder decision, 2026-08-12: yes to multi-org membership, and no restriction
-- on managers — a manager may administer as many organisations as they belong
-- to, with authority following the organisation they are currently viewing
-- (Option A of the decision brief).
--
-- ── WHAT THE OLD INDEX WAS, AND WHY IT GOES ──────────────────────────────────
--
--   CREATE UNIQUE INDEX org_members_one_active_agency
--     ON public.org_members (member_user_id) WHERE status = 'active';
--
-- One person, at most one ACTIVE membership row ANYWHERE. It was added
-- (20260622110000_antifraud_integrity.sql) to stop a CPO being simultaneously
-- employed by two agencies — a real integrity rule: two agencies could
-- otherwise roster the same officer for the same hour, both dispatch them, and
-- the attendance and payout records would disagree about who employed them.
--
-- But `org_members` carries THREE roles — 'cpo', 'manager', 'employee' — and
-- the index applied to all of them. On staging at the time of writing: 11 cpo,
-- 7 employee, 3 manager. The 10 employee/manager rows are ordinary office staff
-- on the workspace side of the product, where there is no safety reason a
-- consultant cannot belong to two companies. One index was doing two jobs and
-- only one of them was wanted.
--
-- ── WHAT REPLACES IT ─────────────────────────────────────────────────────────
--
-- Exclusivity is kept exactly where it means something, and dropped where it
-- never did.

-- Pre-flight, run against staging before writing this: zero duplicate
-- (member_user_id, org_user_id) pairs and zero users active as 'cpo' in more
-- than one org, so neither index below can fail on existing data. `grantMembership`
-- reactivates rather than inserting, which is WHY the pair is already unique —
-- but nothing enforced it, so it was checked rather than assumed.

-- ── DEPLOY ORDER: MIGRATION FIRST, THEN THE SERVICE ─────────────────────────
--
-- The usual order here is server-first, and it is wrong for this one.
--
--   Migration first (correct, but NOT a no-op): three of the four join lanes
--   have their own role-blind refusals and stay closed. `addEmployee`
--   (POST /org/employees) does NOT — its only cross-org guard was this index,
--   so from the moment it drops, an admin on the OLD service can create a
--   genuine second active membership. That is the intended end state, just
--   reached before the code that understands it. Keep the window short and
--   deploy the service in the same maintenance slot.
--
--   Service first (wrong): the app permits the second membership, the index
--   is still there to forbid it, and every accept in the window dies on a
--   23505 the user reads as 'already_active_in_another_org' — the exact
--   refusal this item removes, reported as if it were still policy.
--
-- Neither order can corrupt data; one of them just tells users the feature
-- is broken for the length of the deploy.

DROP INDEX IF EXISTS public.org_members_one_active_agency;

-- CPO EMPLOYMENT STAYS EXCLUSIVE. This is the half of the old index that was
-- doing real work, narrowed to the role it was written for.
CREATE UNIQUE INDEX IF NOT EXISTS org_members_one_active_cpo
  ON public.org_members (member_user_id)
  WHERE status = 'active' AND member_role = 'cpo';

-- NO SECOND INDEX. An earlier draft added
--   CREATE UNIQUE INDEX org_members_one_per_org ON org_members (member_user_id, org_user_id)
-- to enforce "one row per (person, org)". That pair is ALREADY the table's
-- PRIMARY KEY — `PRIMARY KEY (org_user_id, member_user_id)`, same two columns,
-- declared the other way round — so the index enforced nothing and only added a
-- second constraint name for the same violation to raise under.
--
-- Worth stating because it also answers the question the draft was worried
-- about: a 'removed' row and an 'active' row for the same pair could never
-- coexist, before or after this migration, so `grantMembership`'s
-- reactivate-rather-than-insert path was never at risk.

COMMENT ON INDEX public.org_members_one_active_cpo IS
  'vs2 item 4: a CPO may be actively employed by only ONE agency. The other '
  'roles (manager, employee) are deliberately multi-org — see '
  'docs/planning/ITEM4_MULTI_ORG_DECISION_BRIEF.md.';

-- ⚠️ A NOTE FOR WHOEVER READS THIS NEXT.
--
-- Dropping the broad index also permits a combination the old one forbade: the
-- same person active as a 'cpo' at an agency AND as an 'employee' of a company
-- workspace. That is intentional — it is the consultant case this item exists
-- for, and the two roles do not overlap operationally (a workspace employee has
-- no shifts, no dispatch and no payouts). The CPO half of their identity is
-- still exclusive, which is what the anti-fraud rule protected.
--
-- Down migration (restores the single-org restriction; will FAIL if anyone has
-- meanwhile become active in two orgs, which is the correct behaviour — that
-- data has to be resolved by a human, not silently dropped):
--
--   DROP INDEX IF EXISTS public.org_members_one_per_org;
--   DROP INDEX IF EXISTS public.org_members_one_active_cpo;
--   CREATE UNIQUE INDEX org_members_one_active_agency
--     ON public.org_members (member_user_id) WHERE status = 'active';
