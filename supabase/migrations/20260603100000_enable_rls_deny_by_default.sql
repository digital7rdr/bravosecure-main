-- Security hardening: enable Row Level Security on all public tables.
--
-- Context: the app's data plane is the NestJS auth-service, which connects
-- as the `postgres` role (rolbypassrls = true) — so RLS does NOT affect any
-- backend query. The exposure the Supabase advisor flagged is the `anon` /
-- `authenticated` roles (the mobile EXPO_PUBLIC anon key), which could
-- otherwise read/write every row directly.
--
-- The only client-side Supabase table access (src/services/supabase.ts
-- userService + the useBookingRealtime / useRealtimeMessages hooks) is dead
-- code — none of it is imported/mounted. SOSScreen uses broadcast channels,
-- not postgres_changes, so it is unaffected by table RLS.
--
-- Therefore: enable RLS with NO policies = deny-by-default for anon /
-- authenticated, full access retained for the rolbypassrls backend. This
-- closes the anon-key data exposure without breaking the application. If a
-- future client feature needs direct table access, add scoped policies then.
--
-- FORCE is added too: tables are owned by `postgres` (which bypasses via the
-- role attribute, unaffected by FORCE), so this is harmless defence-in-depth
-- against a future non-bypassing owner connection.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'admin_users','agent_audit','agent_coverage_zones','agent_deployment_checks',
    'agent_documents','agent_kyc_checks','agent_profiles','agent_review_pipeline',
    'agents','audit_events','auth_devices','auth_otps','auth_totp_backup_codes',
    'auth_totp_secrets','blocked_users','booking_addons','booking_assignments',
    'booking_cpo_assignments','bookings','conversation_members','conversations',
    'corporate_accounts','corporate_members','cpo_pool','gps_pings','gps_pings_default',
    'intel_items','intel_sources','itineraries','job_applications','jobs',
    'lite_booking_add_ons','lite_booking_audit','lite_bookings','live_feed_events',
    'message_envelopes','mission_crew','mission_payouts','mission_principals',
    'mission_telemetry','mission_telemetry_last','mission_waypoints','missions',
    'ops_audit','signal_identities','signal_one_time_prekeys','sos_events',
    'system_broadcasts','users','vault_items','vehicle_pool','wallet_balances',
    'wallet_transactions','wallets','messages_backup','conversation_backups',
    'identity_backups','sealed_envelope_archive','backup_merkle_commits',
    'vbg_monitoring','vbg_sra_snapshots','vbg_device_keys','vbg_telemetry_last',
    'vbg_geofences','family_members','backup_session_snapshots',
    'media_recipient_grants','department_channels','department_channel_members',
    'wallet_credit_batches'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
    END IF;
  END LOOP;
END $$;
