-- Signal per-device key store (B-18). Consolidates the four 2026-06-18 migrations
-- (signal_per_device_keys → revert login-hotfix → reapply_with_authsvc →
-- fix_active_install_keeps_device1) that were applied to staging OUT-OF-BAND and
-- never committed to the repo. This brings the repo + any fresh DB to the
-- per-(user, device) Signal key schema that the auth code ALREADY expects:
--   * auth.service.ts issueSession assigns auth_devices.signal_device_id
--   * keys.service.ts resolveSignalDeviceId + ON CONFLICT (user_id, device_id[, key_id])
-- Without this, main is self-inconsistent (auth writes a column no repo migration
-- creates) and key upload 500s ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification") → Signal sessions can't establish.
--
-- 🛑 Crypto/key-handling: this matches the DEPLOYED staging schema exactly — it was
-- recovered from the live DB's applied DDL, not invented. Additive + idempotent;
-- existing rows become "device 1" (smallint DEFAULT 1). down-migration at the foot.

-- 1. signal_identities — one identity per (user, device).
ALTER TABLE public.signal_identities
  ADD COLUMN IF NOT EXISTS device_id smallint NOT NULL DEFAULT 1;
ALTER TABLE public.signal_identities DROP CONSTRAINT IF EXISTS signal_identities_pkey;
ALTER TABLE public.signal_identities ADD CONSTRAINT signal_identities_pkey PRIMARY KEY (user_id, device_id);

-- 2. signal_one_time_prekeys — one OPK pool per (user, device).
ALTER TABLE public.signal_one_time_prekeys
  ADD COLUMN IF NOT EXISTS device_id smallint NOT NULL DEFAULT 1;
ALTER TABLE public.signal_one_time_prekeys DROP CONSTRAINT IF EXISTS signal_one_time_prekeys_pkey;
ALTER TABLE public.signal_one_time_prekeys ADD CONSTRAINT signal_one_time_prekeys_pkey PRIMARY KEY (user_id, device_id, key_id);

-- 3. auth_devices.signal_device_id — stable numeric Signal device id per user,
--    reused/allocated at session issue. Backfill so the MOST-RECENTLY-USED install
--    per user keeps device 1 (preserving its existing identity/keys); older installs
--    get 2,3,…. The uniqueness constraint is (re)added after the renumber so it
--    can't trip on a transient mid-statement collision.
ALTER TABLE public.auth_devices ADD COLUMN IF NOT EXISTS signal_device_id smallint;
ALTER TABLE public.auth_devices DROP CONSTRAINT IF EXISTS auth_devices_user_signaldev_uniq;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY last_used_at DESC NULLS LAST, id) AS rn
    FROM public.auth_devices
)
UPDATE public.auth_devices d
   SET signal_device_id = ranked.rn
  FROM ranked
 WHERE d.id = ranked.id
   AND d.signal_device_id IS DISTINCT FROM ranked.rn;
ALTER TABLE public.auth_devices ALTER COLUMN signal_device_id SET NOT NULL;
ALTER TABLE public.auth_devices ADD CONSTRAINT auth_devices_user_signaldev_uniq UNIQUE (user_id, signal_device_id);

-- ── Down migration (uncomment to revert to single-device) ────────────────────
-- ALTER TABLE public.auth_devices DROP CONSTRAINT IF EXISTS auth_devices_user_signaldev_uniq;
-- ALTER TABLE public.auth_devices DROP COLUMN IF EXISTS signal_device_id;
-- ALTER TABLE public.signal_identities DROP CONSTRAINT IF EXISTS signal_identities_pkey;
-- ALTER TABLE public.signal_identities DROP COLUMN IF EXISTS device_id;
-- ALTER TABLE public.signal_identities ADD CONSTRAINT signal_identities_pkey PRIMARY KEY (user_id);
-- ALTER TABLE public.signal_one_time_prekeys DROP CONSTRAINT IF EXISTS signal_one_time_prekeys_pkey;
-- ALTER TABLE public.signal_one_time_prekeys DROP COLUMN IF EXISTS device_id;
-- ALTER TABLE public.signal_one_time_prekeys ADD CONSTRAINT signal_one_time_prekeys_pkey PRIMARY KEY (user_id, key_id);
