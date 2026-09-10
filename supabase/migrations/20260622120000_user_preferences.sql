-- User preferences (BUILD_RUNBOOK Step 25) — language / currency / notification
-- categories / location-sharing scope / app-lock. Additive + idempotent.
--
-- notif_prefs is a JSONB category map; the `safety` category is FORCED ON server-side
-- (the PATCH coerces notif_prefs.safety = true) so a user can never silence a
-- safety-critical alert. Defaults keep every existing row functional (English, the
-- region currency resolved client-side, all notifications on, full location scope).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS language       TEXT    NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'ar', 'bn')),
  ADD COLUMN IF NOT EXISTS currency       TEXT
    CHECK (currency IS NULL OR currency IN ('AED', 'SAR', 'BDT', 'GBP')),
  ADD COLUMN IF NOT EXISTS notif_prefs    JSONB   NOT NULL DEFAULT '{"safety": true}'::jsonb,
  ADD COLUMN IF NOT EXISTS location_scope TEXT    NOT NULL DEFAULT 'while_on_duty'
    CHECK (location_scope IN ('while_on_duty', 'during_mission', 'never')),
  ADD COLUMN IF NOT EXISTS app_lock       BOOLEAN NOT NULL DEFAULT FALSE;
