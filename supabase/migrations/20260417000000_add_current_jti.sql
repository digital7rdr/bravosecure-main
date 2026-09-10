-- Add current_jti to auth_devices so that DELETE /auth/session can
-- instantly revoke the associated access token in Redis without needing
-- the client to pass the jti back.
--
-- NULL = no active token for this device (new device or already revoked).

ALTER TABLE public.auth_devices
  ADD COLUMN IF NOT EXISTS current_jti TEXT;

-- Index is intentionally omitted — lookups are by (user_id, device_id)
-- which already has a UNIQUE index. current_jti is only read during revoke.
