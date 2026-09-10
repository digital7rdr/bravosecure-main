-- Dept Chat v2 · Channels Hub v2 (PDF p.4). Additive channel typing + access
-- level on department_channels so the hub can group Board / Department / Incident
-- channels and badge read-only (announcement) + restricted (private) ones.
--
-- 🛑 NO crypto change. Restricted/incident visibility is enforced by MEMBERSHIP
-- SEEDING (the server simply never adds a normal CPO to a restricted/incident
-- channel, so listChannels' membership JOIN never returns the row) — never by a
-- client-side hide. The group-key / rekey path is untouched.
--
-- Additive + idempotent with defaults → ZERO behaviour change to existing
-- channels (they read as 'department' / 'standard'). department_channels already
-- has RLS from 20260603000000. Down-migration at the foot (commented).

ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'department'
    CHECK (channel_type IN ('board', 'department', 'incident')),
  ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'standard'
    CHECK (access IN ('standard', 'read_only', 'restricted'));

-- ── Down migration (uncomment to revert) ─────────────────────────────────────
-- ALTER TABLE public.department_channels
--   DROP COLUMN IF EXISTS channel_type,
--   DROP COLUMN IF EXISTS access;
