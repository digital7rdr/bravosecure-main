-- B-696 Phase D (VAULT_DURABILITY_DESIGN_2026-08-29 §6) — E2E-encrypted vault
-- index blob, one row per user. Client-side AES-256-GCM under an HKDF subkey
-- of the backup master key (info 'bravo-vault-index-v1'); the server stores
-- an opaque blob it can never read. Shape and optimistic-versioning semantics
-- are a deliberate clone of backup_session_snapshots (stale_seq 409 + adopt).
-- DELIBERATELY NOT part of the Merkle mirror — see design doc §6.1.

CREATE TABLE IF NOT EXISTS public.vault_index_blobs (
  user_id     uuid        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  blob        bytea       NOT NULL,
  seq         bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS vault_index_blobs_touch ON public.vault_index_blobs;
CREATE TRIGGER vault_index_blobs_touch
  BEFORE UPDATE ON public.vault_index_blobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Deny-by-default RLS (house rule); messenger-service uses the service-role
-- client, which bypasses RLS by design — the API layer is the authz gate.
ALTER TABLE public.vault_index_blobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vault_index_blobs FROM anon, authenticated;

COMMENT ON TABLE public.vault_index_blobs IS
  'B-696: opaque E2E-encrypted vault index (file keys + albums), seq-versioned. Server-unreadable.';
