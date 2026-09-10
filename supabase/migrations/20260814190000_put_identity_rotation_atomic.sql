-- AUDIT-2026-08-13 B-6 — atomic identity-backup rotation.
--
-- putIdentity's rotation path was wipe-THEN-upsert across five separate
-- PostgREST calls. A failure between the wipes and the identity upsert
-- left the OLD identity row pointing at a WIPED mirror: if the client
-- abandoned setup there, the owner device's mirror_flushed ledger still
-- claimed every row was flushed (BACKUP_LOOP I1), so the sweep never
-- re-uploaded — a silently EMPTY backup behind a valid-looking identity
-- row (the I5 class: a server wipe the client ledger never heard about).
-- The partial-wipe windows (W2..W4) were each individually survivable
-- (orphans fail decrypt closed; stale snapshot seq heals via the I6
-- adopt; a stale merkle commit hard-fails restore until the owner's
-- next commit) — but all of them exist only because five writes ran
-- with no transaction. One function = one transaction = no windows.
--
-- Concurrency: the advisory xact lock at function entry serializes ALL
-- putIdentity calls for one user — including two concurrent FIRST-EVER
-- setups, which FOR UPDATE alone cannot serialize (no row exists yet to
-- lock; both would see FOUND=false and last-writer-wins the identity row
-- while the loser's device mirrors under a key the row no longer names —
-- critic review F5). FOR UPDATE still guards the read-compare-write on
-- existing rows within that serialization.
--
-- Deploy note: messenger-service calls this via PostgREST rpc and
-- FALLS BACK to the legacy sequential path (with a loud error log) when
-- the function is absent, so shipping the service before this migration
-- is applied degrades to today's behaviour, never a hard failure.

CREATE OR REPLACE FUNCTION public.put_identity_rotation_atomic(
  p_user_id                 uuid,
  p_wrapped_master_key      bytea,
  p_salt                    bytea,
  p_kdf_params              jsonb,
  p_wrapped_identity_bundle bytea,
  p_verifier_key            bytea
) RETURNS jsonb
LANGUAGE plpgsql
-- House pattern (bump_backup_failed_attempts): pin resolution to public
-- so operator/function lookup cannot ride the caller's search_path.
SET search_path = public
AS $$
DECLARE
  v_existing_key bytea;
  v_had_existing boolean := false;
  v_rotated      boolean := false;
BEGIN
  -- F5 — serialize per-user, INCLUDING first-ever setups (see header).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT wrapped_master_key INTO v_existing_key
    FROM public.identity_backups
   WHERE user_id = p_user_id
     FOR UPDATE;
  v_had_existing := FOUND;
  v_rotated := v_had_existing
    AND v_existing_key IS DISTINCT FROM p_wrapped_master_key;

  IF v_rotated THEN
    -- Round 7 / F6 semantics preserved: only a TRUE rotation wipes.
    -- Same four targets as the sequential path (M-4: the snapshot and
    -- merkle commit are encrypted/signed under the OLD key and would
    -- respectively 409-block and hard-fail the fresh device).
    DELETE FROM public.messages_backup          WHERE owner_user_id = p_user_id;
    DELETE FROM public.conversation_backups     WHERE owner_user_id = p_user_id;
    DELETE FROM public.backup_session_snapshots WHERE user_id = p_user_id;
    DELETE FROM public.backup_merkle_commits    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO public.identity_backups (
    user_id, wrapped_master_key, salt, kdf_params,
    wrapped_identity_bundle, verifier_key,
    failed_attempts, locked_until
  ) VALUES (
    p_user_id, p_wrapped_master_key, p_salt, p_kdf_params,
    p_wrapped_identity_bundle, p_verifier_key,
    0, NULL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    wrapped_master_key      = EXCLUDED.wrapped_master_key,
    salt                    = EXCLUDED.salt,
    kdf_params              = EXCLUDED.kdf_params,
    wrapped_identity_bundle = EXCLUDED.wrapped_identity_bundle,
    verifier_key            = EXCLUDED.verifier_key,
    -- Throttle counters reset on every re-upload — the user either set
    -- a new password or recovered; the guess counter is moot for the
    -- new ciphertext (same as the sequential path).
    failed_attempts         = 0,
    locked_until            = NULL;

  RETURN jsonb_build_object('had_existing', v_had_existing, 'rotated', v_rotated);
END;
$$;

-- Server (service_role) is the only client of the backup tables — same
-- posture as the tables themselves (Phase-1 RLS convention).
REVOKE ALL ON FUNCTION public.put_identity_rotation_atomic(uuid, bytea, bytea, jsonb, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.put_identity_rotation_atomic(uuid, bytea, bytea, jsonb, bytea, bytea) TO service_role;
