-- Bravo Secure — Server-enforced backup verification (audit P0-1)
--
-- Closes the "client-self-reported throttle" gap. Previously /backup/identity/bundle
-- returned the wrapped bytes to anyone with a valid JWT, and the brute-force
-- counter only advanced when the CLIENT voluntarily POSTed /backup/identity/fail
-- on an AES-GCM unwrap failure. A malicious client (curl, modified APK, stolen
-- JWT) could skip the /fail call and run Argon2 offline on the bundle at
-- whatever rate they pleased — the 5-attempt / 1-hour lockout the UI promised
-- did not exist for an attacker who controlled the client.
--
-- Fix:
--   • Setup-time: client uploads a `verifier_key` = HKDF(derived_key,
--     'bravo-backup-verifier-v1', 32B). Server stores it but cannot use it
--     to unwrap the bundle (HKDF is one-way, and the wrap key is derived_key,
--     not verifier_key).
--   • Restore-time: GET /backup/identity/header returns a fresh server-issued
--     nonce. Client computes proof = HMAC-SHA256(verifier_key, nonce || user_id)
--     and POSTs /backup/identity/verify. Server validates HMAC with the
--     stored verifier_key; on success returns a single-use verify_token that
--     unlocks GET /backup/identity/bundle for 60s.
--   • Every /verify failure bumps failed_attempts SERVER-SIDE regardless of
--     client cooperation. After maxFailedAttempts the row is locked and
--     /verify returns 423 until the cool-down expires.
--
-- Legacy rows (no verifier_key) — see audit decision: "force re-setup on
-- next login". The server treats verifier_key IS NULL as "header endpoint
-- still serves metadata so the client can detect the upgrade gate, but
-- /verify rejects with 409 verifier_missing". The client surfaces a
-- one-time prompt to re-enter the backup password and re-wrap with a
-- verifier_key attached.

ALTER TABLE public.identity_backups
  ADD COLUMN IF NOT EXISTS verifier_key BYTEA;

COMMENT ON COLUMN public.identity_backups.verifier_key IS
  'HKDF(derived_key, ''bravo-backup-verifier-v1'', 32B). Server uses this to '
  'validate HMAC proofs at /backup/identity/verify. NULL on rows created '
  'before the P0-1 audit fix — those rows require a one-time re-setup before '
  '/bundle becomes readable again.';
