-- admin_users now needs phone_e164 so ops-console can authenticate the
-- admin via the same phone + password + OTP flow the mobile app uses.
-- Linking is done via admin_users.user_id = public.users.id.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_phone_idx
  ON admin_users(phone_e164)
  WHERE phone_e164 IS NOT NULL;
