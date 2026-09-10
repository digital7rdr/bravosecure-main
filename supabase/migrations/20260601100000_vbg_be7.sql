-- BE-7 — Virtual Bodyguard backend: telemetry, geofence, per-device keys,
-- biometric consecutive-fail tracking.

-- Per-device AES-256 key for the encrypted telemetry body. Minted at
-- enroll, stored so the server can decrypt for geofence evaluation.
-- key_b64 is 32 random bytes, base64 — NOT derived from any Signal key.
CREATE TABLE IF NOT EXISTS public.vbg_device_keys (
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  key_b64    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id)
);

-- Latest decrypted fix per user, for the live map / track API fallback
-- (the hot path is the Redis stream; this row survives a Redis restart).
CREATE TABLE IF NOT EXISTS public.vbg_telemetry_last (
  user_id      UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  heading_deg  DOUBLE PRECISION,
  speed_kph    DOUBLE PRECISION,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BE-7.3 — server-side geofences. PostGIS polygons; breach = transition
-- out of a 'safe' zone or into a 'danger' zone.
CREATE TABLE IF NOT EXISTS public.vbg_geofences (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'safe',   -- 'safe' | 'danger'
  area       geography(Polygon, 4326) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vbg_geofences_user_idx ON public.vbg_geofences(user_id) WHERE active;
CREATE INDEX IF NOT EXISTS vbg_geofences_area_gix ON public.vbg_geofences USING GIST (area);

-- BE-7.4 — biometric monitoring tracks CONSECUTIVE fails now (3 → escalate)
-- plus the last geofence zone-state so breach detection only fires on a
-- transition, not on every stationary fix inside a zone.
ALTER TABLE public.vbg_monitoring
  ADD COLUMN IF NOT EXISTS consecutive_fails INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_zone_state   TEXT;
