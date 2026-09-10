-- PDF section 13 checklist line 9 — "Admins can choose the names of levels and
-- lateral channels."
--
-- Lateral/channel names were already admin-chosen free text. The TIER vocabulary
-- was not: 'Enterprise / Main / Sub / Sub-sub' is a hardcoded array in the
-- client, so an admin who thinks in "Region / Branch / Team" had to read their
-- own structure in someone else's words.
--
-- WHY THIS COLUMN AND NOT A NEW TABLE
--
-- `org_workspace_settings` already exists for exactly this: PER-ORG
-- PRESENTATION. Its own header states the property that makes it the right home
-- and that must not change — "Nothing in this table is read by an authorisation
-- check, and nothing should start reading it for one." A level NAME is a label;
-- it decides nothing. Depth is still governed by `level` and the CHECK, and
-- renaming a tier cannot move a channel or widen a grant.
--
-- Its PK is users.id, which is what a workspace owner AND an agency company
-- account share, so both org kinds can hold a row (that FK choice is documented
-- in 20260811190000 as a bug fix — do not "tighten" it to org_workspaces).
--
-- SHAPE
--
-- text[] indexed by DISPLAY TIER, i.e. level_names[1] is what the UI calls L1.
-- NOT a 4-column set: the client already clamps display tiers to MAX_TIER and a
-- fixed column set would need a migration the day a fifth tier is discussed.
--
-- EMPTY ARRAY IS THE DEFAULT and means "use the built-in vocabulary", so every
-- org without a row — which is all of them today — behaves exactly as before.
-- A SHORT array is legal and is filled per-slot from the built-ins, so an admin
-- may rename L2 alone and leave the rest.
--
-- Validated in the SERVICE, not by a CHECK, for the same reason
-- `hidden_modules` is: length and emptiness rules are product decisions, and a
-- constraint turns each tweak into a migration that must be deployed before the
-- code using it.

ALTER TABLE public.org_workspace_settings
  ADD COLUMN IF NOT EXISTS level_names text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.org_workspace_settings.level_names IS
  'PDF checklist line 9: admin-chosen names for the hierarchy tiers, indexed by '
  'DISPLAY tier (level_names[1] = L1). Empty = use the built-in '
  'Enterprise/Main/Sub/Sub-sub vocabulary. A short array fills the remaining '
  'tiers from the built-ins. PRESENTATION ONLY - never read by an authorisation '
  'check, and depth is still governed by department_channels.level.';
