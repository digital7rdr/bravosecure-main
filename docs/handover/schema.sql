--
-- PostgreSQL database dump
--

\restrict Qm574yh8RDKpec61Pq9obzzcdexAJGfvdOZv4ZohcXBFmDbATykU1m5jWAdNNae

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: _realtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA _realtime;


--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA extensions;


--
-- Name: graphql; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphql;


--
-- Name: graphql_public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graphql_public;


--
-- Name: pg_net; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_net; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_net IS 'Async HTTP';


--
-- Name: pgbouncer; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgbouncer;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: realtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA realtime;


--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA storage;


--
-- Name: supabase_functions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA supabase_functions;


--
-- Name: supabase_migrations; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA supabase_migrations;


--
-- Name: vault; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA vault;


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;


--
-- Name: EXTENSION supabase_vault; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION supabase_vault IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: aal_level; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


--
-- Name: code_challenge_method; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.code_challenge_method AS ENUM (
    's256',
    'plain'
);


--
-- Name: factor_status; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_status AS ENUM (
    'unverified',
    'verified'
);


--
-- Name: factor_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_type AS ENUM (
    'totp',
    'webauthn',
    'phone'
);


--
-- Name: oauth_authorization_status; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_authorization_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'expired'
);


--
-- Name: oauth_client_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_client_type AS ENUM (
    'public',
    'confidential'
);


--
-- Name: oauth_registration_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_registration_type AS ENUM (
    'dynamic',
    'manual'
);


--
-- Name: oauth_response_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_response_type AS ENUM (
    'code'
);


--
-- Name: one_time_token_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
);


--
-- Name: admin_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.admin_role AS ENUM (
    'OPS',
    'SUPERVISOR',
    'ADMIN'
);


--
-- Name: agent_check_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_check_state AS ENUM (
    'queued',
    'running',
    'done',
    'failed'
);


--
-- Name: agent_doc_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_doc_state AS ENUM (
    'upload',
    'done',
    'rejected'
);


--
-- Name: agent_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_status AS ENUM (
    'DRAFT',
    'PROFILE_COMPLETE',
    'KYC_PENDING',
    'DOCS_PENDING',
    'SUBMITTED',
    'UNDER_REVIEW',
    'APPROVED',
    'REJECTED',
    'ACTIVE'
);


--
-- Name: agent_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agent_type AS ENUM (
    'company',
    'cpo',
    'transport'
);


--
-- Name: application_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.application_status AS ENUM (
    'PENDING',
    'SHORTLISTED',
    'ASSIGNED',
    'REJECTED',
    'WITHDRAWN'
);


--
-- Name: cpo_availability; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cpo_availability AS ENUM (
    'available',
    'on_mission',
    'off_duty'
);


--
-- Name: dispatch_offer_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispatch_offer_status AS ENUM (
    'OFFERED',
    'ACCEPTED',
    'REJECTED',
    'EXPIRED',
    'SUPERSEDED',
    'CANCELLED'
);


--
-- Name: escrow_hold_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.escrow_hold_status AS ENUM (
    'HELD',
    'PENDING_RELEASE',
    'RELEASED',
    'REFUNDED',
    'PARTIAL',
    'DISPUTED'
);


--
-- Name: job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status AS ENUM (
    'PUBLISHED',
    'REVIEW',
    'ASSIGNED',
    'DISPATCHED',
    'CANCELLED'
);


--
-- Name: lite_booking_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.lite_booking_status AS ENUM (
    'DRAFT',
    'PENDING_OPS',
    'OPS_APPROVED',
    'PAYMENT_PENDING',
    'CONFIRMED',
    'LIVE',
    'COMPLETED',
    'CANCELLED',
    'DISPATCHING',
    'NO_PROVIDER',
    'AGENCY_NO_SHOW'
);


--
-- Name: mission_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mission_status AS ENUM (
    'DISPATCHED',
    'PICKUP',
    'LIVE',
    'SOS',
    'COMPLETED',
    'ABORTED'
);


--
-- Name: system_broadcast_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.system_broadcast_kind AS ENUM (
    'booking_submitted',
    'booking_approved',
    'booking_rejected',
    'booking_cancelled',
    'mission_started',
    'mission_pickup',
    'mission_live',
    'mission_sos',
    'mission_sos_ack',
    'mission_sos_resolved',
    'mission_abort',
    'mission_complete',
    'agent_approved',
    'agent_rejected',
    'payment_captured',
    'custom'
);


--
-- Name: vehicle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vehicle_status AS ENUM (
    'available',
    'on_mission',
    'maintenance'
);


--
-- Name: wallet_tx_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.wallet_tx_status AS ENUM (
    'pending',
    'succeeded',
    'failed',
    'refunded'
);


--
-- Name: wallet_tx_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.wallet_tx_type AS ENUM (
    'topup',
    'payment',
    'refund',
    'payout',
    'expire',
    'escrow_hold',
    'escrow_refund',
    'escrow_release'
);


--
-- Name: buckettype; Type: TYPE; Schema: storage; Owner: -
--

CREATE TYPE storage.buckettype AS ENUM (
    'STANDARD',
    'ANALYTICS',
    'VECTOR'
);


--
-- Name: email(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;


--
-- Name: FUNCTION email(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';


--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;


--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;


--
-- Name: FUNCTION role(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;


--
-- Name: FUNCTION uid(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';


--
-- Name: grant_pg_cron_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_cron_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_cron'
  )
  THEN
    grant usage on schema cron to postgres with grant option;

    alter default privileges in schema cron grant all on tables to postgres with grant option;
    alter default privileges in schema cron grant all on functions to postgres with grant option;
    alter default privileges in schema cron grant all on sequences to postgres with grant option;

    alter default privileges for user supabase_admin in schema cron grant all
        on sequences to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on tables to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on functions to postgres with grant option;

    grant all privileges on all tables in schema cron to postgres with grant option;
    revoke all on table cron.job from postgres;
    grant select on table cron.job to postgres with grant option;
  END IF;
END;
$$;


--
-- Name: FUNCTION grant_pg_cron_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_cron_access() IS 'Grants access to pg_cron';


--
-- Name: grant_pg_graphql_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_graphql_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
begin
    if not exists (
        select 1
        from pg_event_trigger_ddl_commands() ev
        join pg_catalog.pg_extension e on ev.objid = e.oid
        where e.extname = 'pg_graphql'
    ) then
        return;
    end if;

    drop function if exists graphql_public.graphql;
    create or replace function graphql_public.graphql(
        "operationName" text default null,
        query text default null,
        variables jsonb default null,
        extensions jsonb default null
    )
        returns jsonb
        language sql
    as $$
        select graphql.resolve(
            query := query,
            variables := coalesce(variables, '{}'),
            "operationName" := "operationName",
            extensions := extensions
        );
    $$;

    -- Attach the wrapper to the extension so DROP EXTENSION cascades to it,
    -- which in turn triggers set_graphql_placeholder to reinstall the "not enabled" stub.
    alter extension pg_graphql add function graphql_public.graphql(text, text, jsonb, jsonb);

    grant usage on schema graphql to postgres, anon, authenticated, service_role;
    grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    grant usage on schema graphql to postgres with grant option;
    grant usage on schema graphql_public to postgres with grant option;
end;
$_$;


--
-- Name: FUNCTION grant_pg_graphql_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_graphql_access() IS 'Grants access to pg_graphql';


--
-- Name: grant_pg_net_access(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.grant_pg_net_access() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_net'
  )
  THEN
    GRANT USAGE ON SCHEMA net TO supabase_functions_admin, postgres, anon, authenticated, service_role;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;

    REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
  END IF;
END;
$$;


--
-- Name: FUNCTION grant_pg_net_access(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.grant_pg_net_access() IS 'Grants access to pg_net';


--
-- Name: pgrst_ddl_watch(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


--
-- Name: pgrst_drop_watch(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


--
-- Name: set_graphql_placeholder(); Type: FUNCTION; Schema: extensions; Owner: -
--

CREATE FUNCTION extensions.set_graphql_placeholder() RETURNS event_trigger
    LANGUAGE plpgsql
    AS $_$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$_$;


--
-- Name: FUNCTION set_graphql_placeholder(); Type: COMMENT; Schema: extensions; Owner: -
--

COMMENT ON FUNCTION extensions.set_graphql_placeholder() IS 'Reintroduces placeholder function for graphql_public.graphql';


--
-- Name: graphql(text, text, jsonb, jsonb); Type: FUNCTION; Schema: graphql_public; Owner: -
--

CREATE FUNCTION graphql_public.graphql("operationName" text DEFAULT NULL::text, query text DEFAULT NULL::text, variables jsonb DEFAULT NULL::jsonb, extensions jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;


--
-- Name: get_auth(text); Type: FUNCTION; Schema: pgbouncer; Owner: -
--

CREATE FUNCTION pgbouncer.get_auth(p_usename text) RETURNS TABLE(username text, password text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
begin
    raise debug 'PgBouncer auth request: %', p_usename;

    return query
    select 
        rolname::text, 
        case when rolvaliduntil < now() 
            then null 
            else rolpassword::text 
        end 
    from pg_authid 
    where rolname=$1 and rolcanlogin;
end;
$_$;


--
-- Name: attendance_corrections_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attendance_corrections_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'attendance_corrections is append-only (attempted %)', TG_OP;
END;
$$;


--
-- Name: attendance_corrections_no_truncate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attendance_corrections_no_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'attendance_corrections is append-only (attempted TRUNCATE)';
END;
$$;


--
-- Name: bump_backup_failed_attempts(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_backup_failed_attempts(p_user_id uuid, p_max_attempts integer, p_lockout_sec integer) RETURNS TABLE(failed_attempts integer, locked_until timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.identity_backups AS ib
     SET failed_attempts = ib.failed_attempts + 1,
         locked_until = CASE
           WHEN ib.failed_attempts + 1 >= p_max_attempts
             THEN NOW() + make_interval(secs => p_lockout_sec)
           ELSE ib.locked_until
         END,
         updated_at = NOW()
   WHERE ib.user_id = p_user_id
  RETURNING ib.failed_attempts, ib.locked_until;
END;
$$;


--
-- Name: FUNCTION bump_backup_failed_attempts(p_user_id uuid, p_max_attempts integer, p_lockout_sec integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bump_backup_failed_attempts(p_user_id uuid, p_max_attempts integer, p_lockout_sec integer) IS 'Atomic increment of identity_backups.failed_attempts with lockout at the threshold. Used by messenger-service verifyProof to keep the brute-force throttle race-free (audit M-5).';


--
-- Name: dept_channel_block_broadcast_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dept_channel_block_broadcast_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.is_broadcast
     AND NOT EXISTS (
       SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = OLD.org_id
     ) THEN
    RAISE EXCEPTION 'broadcast_channel_cannot_be_deleted';
  END IF;
  RETURN OLD;
END;
$$;


--
-- Name: FUNCTION dept_channel_block_broadcast_delete(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.dept_channel_block_broadcast_delete() IS 'vs2 items 5+12: #broadcast is undeletable for AGENCY orgs only. Workspaces start clean and may remove theirs; agency orgs keep the scope-v1 rule.';


--
-- Name: dept_channel_broadcast_mode(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dept_channel_broadcast_mode() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.is_broadcast THEN
    NEW.post_mode := 'announcement';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: dept_channel_set_level(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dept_channel_set_level() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  parent_level   SMALLINT;
  parent_org     UUID;
  parent_lateral BOOLEAN;
BEGIN
  -- `level` IS FROZEN ON UPDATE. (See 20260803010000 for the five-level recipe
  -- this closes: UPDATE ... SET level = 2 slipped past a column-scoped trigger.)
  IF TG_OP = 'UPDATE' AND NEW.level IS DISTINCT FROM OLD.level THEN
    NEW.level := OLD.level;
  END IF;

  -- ...AND SO IS is_lateral, for the same reason and with the same mechanism.
  --
  -- Flipping it changes the row's effective tier. On a parented row this trigger
  -- re-derives level on EVERY update, so a flip would silently re-level the row
  -- -- which can collide with dept_channels_one_broadcast_per_level, and which
  -- no descendant re-level accompanies. Coerced rather than raised, matching the
  -- level freeze one clause up: a silent no-op is what the neighbouring rule
  -- does, and two adjacent rules that disagree about their failure mode is worse
  -- than either choice.
  IF TG_OP = 'UPDATE' AND NEW.is_lateral IS DISTINCT FROM OLD.is_lateral THEN
    NEW.is_lateral := OLD.is_lateral;
  END IF;

  -- Same hole, tenancy edition. BOTH ENDS: testing only NEW.parent_id IS NOT NULL
  -- reads symmetric and is not -- moving a ROOT that has children is silent,
  -- because the root's own parent_id is NULL.
  IF TG_OP = 'UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND (NEW.parent_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.department_channels
                      WHERE parent_id = NEW.id)) THEN
    RAISE EXCEPTION 'cannot_move_child_channel_between_orgs';
  END IF;

  -- RE-PARENTING IS BLOCKED. This trigger is FOR EACH ROW, so moving a node
  -- recomputes only ITS level -- descendants keep stale ones. When a move UI is
  -- built, replace this with a recursive descendant re-level inside the same
  -- transaction; do NOT simply delete the guard.
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'channel_reparenting_not_supported';
  END IF;

  IF NEW.parent_id IS NULL THEN
    -- A LATERAL WITHOUT A PARENT IS MEANINGLESS. There is no level to be lateral
    -- to, and the derivation below is the only thing that gives a lateral its
    -- level -- a parentless one would silently take the root default instead.
    IF NEW.is_lateral THEN
      RAISE EXCEPTION 'lateral_channel_needs_parent';
    END IF;
    -- A root is Enterprise (0) or Main (1).
    IF NEW.level > 1 THEN
      RAISE EXCEPTION 'root_channel_level_invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'channel_cannot_parent_itself';
  END IF;

  SELECT level, org_id, is_lateral INTO parent_level, parent_org, parent_lateral
    FROM public.department_channels WHERE id = NEW.parent_id;

  IF parent_level IS NULL THEN
    RAISE EXCEPTION 'parent_channel_not_found';
  END IF;

  IF parent_org <> NEW.org_id THEN
    RAISE EXCEPTION 'parent_channel_in_other_org';
  END IF;

  -- A LATERAL MUST STAY A LEAF, and this is what keeps the depth rule real.
  --
  -- A lateral does not increment level, so a CHAIN of laterals would add
  -- unbounded REAL depth while the column never moves -- the level CHECK would
  -- become decorative and every ancestor walk (bounded at 4 hops precisely
  -- because at most ONE lateral hop can exist) would silently under-reach.
  -- Same reasoning createChannel already applies to #broadcast: keeping the
  -- hanging object childless is what makes ignoring it sound.
  IF parent_lateral THEN
    RAISE EXCEPTION 'lateral_channel_cannot_have_children';
  END IF;

  -- THE DERIVATION. A lateral belongs to its parent's level ("part of the same
  -- level, just nested under it"); a structural child is one deeper. The CHECK
  -- still rejects 4, so no fifth level.
  NEW.level := parent_level + CASE WHEN NEW.is_lateral THEN 0 ELSE 1 END;
  RETURN NEW;
END;
$$;


--
-- Name: has_free_cpo_capacity(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_free_cpo_capacity(p_agency uuid, p_needed integer) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT (
    (SELECT count(*) FROM public.org_members om
       WHERE om.org_user_id = p_agency AND om.member_role = 'cpo' AND om.status = 'active')
    - (SELECT count(DISTINCT mc.agent_id)
         FROM public.mission_crew mc
         JOIN public.missions m       ON m.id = mc.mission_id
         JOIN public.lite_bookings b  ON b.id = m.booking_id
        WHERE b.assigned_provider_user_id = p_agency
          AND m.status NOT IN ('COMPLETED', 'ABORTED'))
    - COALESCE((SELECT sum(b.cpo_count)
         FROM public.lite_bookings b
        WHERE b.assigned_provider_user_id = p_agency
          AND b.status = 'CONFIRMED'
          AND NOT EXISTS (SELECT 1 FROM public.missions m WHERE m.booking_id = b.id)), 0)
  ) >= p_needed
$$;


--
-- Name: is_eligible_for_dispatch(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_eligible_for_dispatch(p_agency uuid, p_region text, p_requirements jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.agents a
              WHERE a.user_id = p_agency AND a.dpa_accepted_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.compliance_credentials c
              WHERE c.subject_user_id = p_agency AND c.subject_kind = 'agency'
                AND c.kind = 'licence' AND c.region_code = p_region
                AND c.verified AND c.expires_at > NOW())
    AND EXISTS (SELECT 1 FROM public.compliance_credentials c
                  WHERE c.subject_user_id = p_agency AND c.subject_kind = 'agency'
                    AND c.kind = 'insurance' AND c.region_code = p_region
                    AND c.verified AND c.expires_at > NOW())
    AND (
      NOT COALESCE((p_requirements ->> 'armed')::boolean, false)
      OR EXISTS (SELECT 1 FROM public.armed_authorizations aa
                   JOIN public.org_members om ON om.member_user_id = aa.cpo_user_id
                  WHERE om.org_user_id = p_agency AND om.member_role = 'cpo' AND om.status = 'active'
                    AND aa.region_code = p_region AND aa.authorized
                    AND (aa.expires_at IS NULL OR aa.expires_at > NOW()))
    )
$$;


--
-- Name: lite_bookings_fsm_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lite_bookings_fsm_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  -- No-op when status didn't change.
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- Allowed transitions, mirrored from booking/state-machine.service.ts.
  IF NOT (
    (OLD.status = 'DRAFT'            AND NEW.status IN ('PENDING_OPS','DISPATCHING','CANCELLED'))
    OR (OLD.status = 'DISPATCHING'     AND NEW.status IN ('CONFIRMED','NO_PROVIDER','CANCELLED'))
    OR (OLD.status = 'PENDING_OPS'     AND NEW.status IN ('OPS_APPROVED','CANCELLED'))
    OR (OLD.status = 'OPS_APPROVED'    AND NEW.status IN ('PAYMENT_PENDING','DISPATCHING','CANCELLED'))
    OR (OLD.status = 'PAYMENT_PENDING' AND NEW.status IN ('CONFIRMED','CANCELLED'))
    OR (OLD.status = 'CONFIRMED'       AND NEW.status IN ('LIVE','COMPLETED','AGENCY_NO_SHOW','DISPATCHING','CANCELLED'))
    OR (OLD.status = 'LIVE'            AND NEW.status IN ('COMPLETED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid_booking_transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: missions_fsm_check(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.missions_fsm_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'DISPATCHED' AND NEW.status IN ('PICKUP','LIVE','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'PICKUP'   AND NEW.status IN ('LIVE','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'LIVE'     AND NEW.status IN ('SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'SOS'      AND NEW.status IN ('LIVE','ABORTED','COMPLETED'))
  ) THEN
    RAISE EXCEPTION 'invalid_mission_transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: ops_audit_no_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ops_audit_no_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  RAISE EXCEPTION 'ops_audit is append-only — UPDATE/DELETE forbidden (use a corrective insert with action=*.correction)';
END;
$$;


--
-- Name: put_identity_rotation_atomic(uuid, bytea, bytea, jsonb, bytea, bytea); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.put_identity_rotation_atomic(p_user_id uuid, p_wrapped_master_key bytea, p_salt bytea, p_kdf_params jsonb, p_wrapped_identity_bundle bytea, p_verifier_key bytea) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
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


--
-- Name: touch_agents_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_agents_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


--
-- Name: touch_lite_bookings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_lite_bookings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: touch_missions_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_missions_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


--
-- Name: touch_wallet_balances_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_wallet_balances_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: allow_any_operation(text[]); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.allow_any_operation(expected_operations text[]) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT CASE
      WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
      ELSE raw_operation
    END AS current_operation
    FROM current_operation
  )
  SELECT EXISTS (
    SELECT 1
    FROM normalized n
    CROSS JOIN LATERAL unnest(expected_operations) AS expected_operation
    WHERE expected_operation IS NOT NULL
      AND expected_operation <> ''
      AND n.current_operation = CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END
  );
$$;


--
-- Name: allow_only_operation(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.allow_only_operation(expected_operation text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT
      CASE
        WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
        ELSE raw_operation
      END AS current_operation,
      CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END AS requested_operation
    FROM current_operation
  )
  SELECT CASE
    WHEN requested_operation IS NULL OR requested_operation = '' THEN FALSE
    ELSE COALESCE(current_operation = requested_operation, FALSE)
  END
  FROM normalized;
$$;


--
-- Name: can_insert_object(text, text, uuid, jsonb); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "storage"."objects" ("bucket_id", "name", "owner", "metadata") VALUES (bucketid, name, owner, metadata);
  -- hack to rollback the successful insert
  RAISE sqlstate 'PT200' using
  message = 'ROLLBACK',
  detail = 'rollback successful insert';
END
$$;


--
-- Name: enforce_bucket_name_length(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.enforce_bucket_name_length() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if length(new.name) > 100 then
        raise exception 'bucket name "%" is too long (% characters). Max is 100.', new.name, length(new.name);
    end if;
    return new;
end;
$$;


--
-- Name: extension(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.extension(name text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
    _filename text;
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Get the last path segment (the actual filename)
    SELECT _parts[array_length(_parts, 1)] INTO _filename;
    -- Extract extension: reverse, split on '.', then reverse again
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;


--
-- Name: filename(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.filename(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[array_length(_parts,1)];
END
$$;


--
-- Name: foldername(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$$;


--
-- Name: get_common_prefix(text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
SELECT CASE
    WHEN position(p_delimiter IN substring(p_key FROM length(p_prefix) + 1)) > 0
    THEN left(p_key, length(p_prefix) + position(p_delimiter IN substring(p_key FROM length(p_prefix) + 1)))
    ELSE NULL
END;
$$;


--
-- Name: get_size_by_bucket(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_size_by_bucket() RETURNS TABLE(size bigint, bucket_id text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    return query
        select sum((metadata->>'size')::bigint)::bigint as size, obj.bucket_id
        from "storage".objects as obj
        group by obj.bucket_id;
END
$$;


--
-- Name: list_multipart_uploads_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, next_key_token text DEFAULT ''::text, next_upload_token text DEFAULT ''::text) RETURNS TABLE(key text, id text, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(key COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                        substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1)))
                    ELSE
                        key
                END AS key, id, created_at
            FROM
                storage.s3_multipart_uploads
            WHERE
                bucket_id = $5 AND
                key ILIKE $1 || ''%'' AND
                CASE
                    WHEN $4 != '''' AND $6 = '''' THEN
                        CASE
                            WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                                substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                key COLLATE "C" > $4
                            END
                    ELSE
                        true
                END AND
                CASE
                    WHEN $6 != '''' THEN
                        id COLLATE "C" > $6
                    ELSE
                        true
                    END
            ORDER BY
                key COLLATE "C" ASC, created_at ASC) as e order by key COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_key_token, bucket_id, next_upload_token;
END;
$_$;


--
-- Name: list_objects_with_delimiter(text, text, text, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT ''::text, next_token text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, metadata jsonb, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_peek_name TEXT;
    v_current RECORD;
    v_common_prefix TEXT;

    -- Configuration
    v_is_asc BOOLEAN;
    v_prefix TEXT;
    v_start TEXT;
    v_upper_bound TEXT;
    v_file_batch_size INT;

    -- Seek state
    v_next_seek TEXT;
    v_count INT := 0;

    -- Dynamic SQL for batch query only
    v_batch_query TEXT;

BEGIN
    -- ========================================================================
    -- INITIALIZATION
    -- ========================================================================
    v_is_asc := lower(coalesce(sort_order, 'asc')) = 'asc';
    v_prefix := coalesce(prefix_param, '');
    v_start := CASE WHEN coalesce(next_token, '') <> '' THEN next_token ELSE coalesce(start_after, '') END;
    v_file_batch_size := LEAST(GREATEST(max_keys * 2, 100), 1000);

    -- Calculate upper bound for prefix filtering (bytewise, using COLLATE "C")
    IF v_prefix = '' THEN
        v_upper_bound := NULL;
    ELSIF right(v_prefix, 1) = delimiter_param THEN
        v_upper_bound := left(v_prefix, -1) || chr(ascii(delimiter_param) + 1);
    ELSE
        v_upper_bound := left(v_prefix, -1) || chr(ascii(right(v_prefix, 1)) + 1);
    END IF;

    -- Build batch query (dynamic SQL - called infrequently, amortized over many rows)
    IF v_is_asc THEN
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" >= $2 ' ||
                'AND o.name COLLATE "C" < $3 ORDER BY o.name COLLATE "C" ASC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" >= $2 ' ||
                'ORDER BY o.name COLLATE "C" ASC LIMIT $4';
        END IF;
    ELSE
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" < $2 ' ||
                'AND o.name COLLATE "C" >= $3 ORDER BY o.name COLLATE "C" DESC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND o.name COLLATE "C" < $2 ' ||
                'ORDER BY o.name COLLATE "C" DESC LIMIT $4';
        END IF;
    END IF;

    -- ========================================================================
    -- SEEK INITIALIZATION: Determine starting position
    -- ========================================================================
    IF v_start = '' THEN
        IF v_is_asc THEN
            v_next_seek := v_prefix;
        ELSE
            -- DESC without cursor: find the last item in range
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_prefix AND o.name COLLATE "C" < v_upper_bound
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix <> '' THEN
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_next_seek FROM storage.objects o
                WHERE o.bucket_id = _bucket_id
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            END IF;

            IF v_next_seek IS NOT NULL THEN
                v_next_seek := v_next_seek || delimiter_param;
            ELSE
                RETURN;
            END IF;
        END IF;
    ELSE
        -- Cursor provided: determine if it refers to a folder or leaf
        IF EXISTS (
            SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = _bucket_id
              AND o.name COLLATE "C" LIKE v_start || delimiter_param || '%'
            LIMIT 1
        ) THEN
            -- Cursor refers to a folder
            IF v_is_asc THEN
                v_next_seek := v_start || chr(ascii(delimiter_param) + 1);
            ELSE
                v_next_seek := v_start || delimiter_param;
            END IF;
        ELSE
            -- Cursor refers to a leaf object
            IF v_is_asc THEN
                v_next_seek := v_start || delimiter_param;
            ELSE
                v_next_seek := v_start;
            END IF;
        END IF;
    END IF;

    -- ========================================================================
    -- MAIN LOOP: Hybrid peek-then-batch algorithm
    -- Uses STATIC SQL for peek (hot path) and DYNAMIC SQL for batch
    -- ========================================================================
    LOOP
        EXIT WHEN v_count >= max_keys;

        -- STEP 1: PEEK using STATIC SQL (plan cached, very fast)
        IF v_is_asc THEN
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_next_seek AND o.name COLLATE "C" < v_upper_bound
                ORDER BY o.name COLLATE "C" ASC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" >= v_next_seek
                ORDER BY o.name COLLATE "C" ASC LIMIT 1;
            END IF;
        ELSE
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix <> '' THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek AND o.name COLLATE "C" >= v_prefix
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = _bucket_id AND o.name COLLATE "C" < v_next_seek
                ORDER BY o.name COLLATE "C" DESC LIMIT 1;
            END IF;
        END IF;

        EXIT WHEN v_peek_name IS NULL;

        -- STEP 2: Check if this is a FOLDER or FILE
        v_common_prefix := storage.get_common_prefix(v_peek_name, v_prefix, delimiter_param);

        IF v_common_prefix IS NOT NULL THEN
            -- FOLDER: Emit and skip to next folder (no heap access needed)
            name := rtrim(v_common_prefix, delimiter_param);
            id := NULL;
            updated_at := NULL;
            created_at := NULL;
            last_accessed_at := NULL;
            metadata := NULL;
            RETURN NEXT;
            v_count := v_count + 1;

            -- Advance seek past the folder range
            IF v_is_asc THEN
                v_next_seek := left(v_common_prefix, -1) || chr(ascii(delimiter_param) + 1);
            ELSE
                v_next_seek := v_common_prefix;
            END IF;
        ELSE
            -- FILE: Batch fetch using DYNAMIC SQL (overhead amortized over many rows)
            -- For ASC: upper_bound is the exclusive upper limit (< condition)
            -- For DESC: prefix is the inclusive lower limit (>= condition)
            FOR v_current IN EXECUTE v_batch_query USING _bucket_id, v_next_seek,
                CASE WHEN v_is_asc THEN COALESCE(v_upper_bound, v_prefix) ELSE v_prefix END, v_file_batch_size
            LOOP
                v_common_prefix := storage.get_common_prefix(v_current.name, v_prefix, delimiter_param);

                IF v_common_prefix IS NOT NULL THEN
                    -- Hit a folder: exit batch, let peek handle it
                    v_next_seek := v_current.name;
                    EXIT;
                END IF;

                -- Emit file
                name := v_current.name;
                id := v_current.id;
                updated_at := v_current.updated_at;
                created_at := v_current.created_at;
                last_accessed_at := v_current.last_accessed_at;
                metadata := v_current.metadata;
                RETURN NEXT;
                v_count := v_count + 1;

                -- Advance seek past this file
                IF v_is_asc THEN
                    v_next_seek := v_current.name || delimiter_param;
                ELSE
                    v_next_seek := v_current.name;
                END IF;

                EXIT WHEN v_count >= max_keys;
            END LOOP;
        END IF;
    END LOOP;
END;
$_$;


--
-- Name: operation(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.operation() RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN current_setting('storage.operation', true);
END;
$$;


--
-- Name: protect_delete(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.protect_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Check if storage.allow_delete_query is set to 'true'
    IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
        RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
            USING HINT = 'This prevents accidental data loss from orphaned objects.',
                  ERRCODE = '42501';
    END IF;
    RETURN NULL;
END;
$$;


--
-- Name: search(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_peek_name TEXT;
    v_current RECORD;
    v_common_prefix TEXT;
    v_delimiter CONSTANT TEXT := '/';

    -- Configuration
    v_limit INT;
    v_prefix TEXT;
    v_prefix_lower TEXT;
    v_is_asc BOOLEAN;
    v_order_by TEXT;
    v_sort_order TEXT;
    v_upper_bound TEXT;
    v_file_batch_size INT;

    -- Dynamic SQL for batch query only
    v_batch_query TEXT;

    -- Seek state
    v_next_seek TEXT;
    v_count INT := 0;
    v_skipped INT := 0;
BEGIN
    -- ========================================================================
    -- INITIALIZATION
    -- ========================================================================
    v_limit := LEAST(coalesce(limits, 100), 1500);
    v_prefix := coalesce(prefix, '') || coalesce(search, '');
    v_prefix_lower := lower(v_prefix);
    v_is_asc := lower(coalesce(sortorder, 'asc')) = 'asc';
    v_file_batch_size := LEAST(GREATEST(v_limit * 2, 100), 1000);

    -- Validate sort column
    CASE lower(coalesce(sortcolumn, 'name'))
        WHEN 'name' THEN v_order_by := 'name';
        WHEN 'updated_at' THEN v_order_by := 'updated_at';
        WHEN 'created_at' THEN v_order_by := 'created_at';
        WHEN 'last_accessed_at' THEN v_order_by := 'last_accessed_at';
        ELSE v_order_by := 'name';
    END CASE;

    v_sort_order := CASE WHEN v_is_asc THEN 'asc' ELSE 'desc' END;

    -- ========================================================================
    -- NON-NAME SORTING: Use path_tokens approach (unchanged)
    -- ========================================================================
    IF v_order_by != 'name' THEN
        RETURN QUERY EXECUTE format(
            $sql$
            WITH folders AS (
                SELECT path_tokens[$1] AS folder
                FROM storage.objects
                WHERE objects.name ILIKE $2 || '%%'
                  AND bucket_id = $3
                  AND array_length(objects.path_tokens, 1) <> $1
                GROUP BY folder
                ORDER BY folder %s
            )
            (SELECT folder AS "name",
                   NULL::uuid AS id,
                   NULL::timestamptz AS updated_at,
                   NULL::timestamptz AS created_at,
                   NULL::timestamptz AS last_accessed_at,
                   NULL::jsonb AS metadata FROM folders)
            UNION ALL
            (SELECT path_tokens[$1] AS "name",
                   id, updated_at, created_at, last_accessed_at, metadata
             FROM storage.objects
             WHERE objects.name ILIKE $2 || '%%'
               AND bucket_id = $3
               AND array_length(objects.path_tokens, 1) = $1
             ORDER BY %I %s)
            LIMIT $4 OFFSET $5
            $sql$, v_sort_order, v_order_by, v_sort_order
        ) USING levels, v_prefix, bucketname, v_limit, offsets;
        RETURN;
    END IF;

    -- ========================================================================
    -- NAME SORTING: Hybrid skip-scan with batch optimization
    -- ========================================================================

    -- Calculate upper bound for prefix filtering
    IF v_prefix_lower = '' THEN
        v_upper_bound := NULL;
    ELSIF right(v_prefix_lower, 1) = v_delimiter THEN
        v_upper_bound := left(v_prefix_lower, -1) || chr(ascii(v_delimiter) + 1);
    ELSE
        v_upper_bound := left(v_prefix_lower, -1) || chr(ascii(right(v_prefix_lower, 1)) + 1);
    END IF;

    -- Build batch query (dynamic SQL - called infrequently, amortized over many rows)
    IF v_is_asc THEN
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" >= $2 ' ||
                'AND lower(o.name) COLLATE "C" < $3 ORDER BY lower(o.name) COLLATE "C" ASC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" >= $2 ' ||
                'ORDER BY lower(o.name) COLLATE "C" ASC LIMIT $4';
        END IF;
    ELSE
        IF v_upper_bound IS NOT NULL THEN
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" < $2 ' ||
                'AND lower(o.name) COLLATE "C" >= $3 ORDER BY lower(o.name) COLLATE "C" DESC LIMIT $4';
        ELSE
            v_batch_query := 'SELECT o.name, o.id, o.updated_at, o.created_at, o.last_accessed_at, o.metadata ' ||
                'FROM storage.objects o WHERE o.bucket_id = $1 AND lower(o.name) COLLATE "C" < $2 ' ||
                'ORDER BY lower(o.name) COLLATE "C" DESC LIMIT $4';
        END IF;
    END IF;

    -- Initialize seek position
    IF v_is_asc THEN
        v_next_seek := v_prefix_lower;
    ELSE
        -- DESC: find the last item in range first (static SQL)
        IF v_upper_bound IS NOT NULL THEN
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_prefix_lower AND lower(o.name) COLLATE "C" < v_upper_bound
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        ELSIF v_prefix_lower <> '' THEN
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_prefix_lower
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        ELSE
            SELECT o.name INTO v_peek_name FROM storage.objects o
            WHERE o.bucket_id = bucketname
            ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
        END IF;

        IF v_peek_name IS NOT NULL THEN
            v_next_seek := lower(v_peek_name) || v_delimiter;
        ELSE
            RETURN;
        END IF;
    END IF;

    -- ========================================================================
    -- MAIN LOOP: Hybrid peek-then-batch algorithm
    -- Uses STATIC SQL for peek (hot path) and DYNAMIC SQL for batch
    -- ========================================================================
    LOOP
        EXIT WHEN v_count >= v_limit;

        -- STEP 1: PEEK using STATIC SQL (plan cached, very fast)
        IF v_is_asc THEN
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_next_seek AND lower(o.name) COLLATE "C" < v_upper_bound
                ORDER BY lower(o.name) COLLATE "C" ASC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" >= v_next_seek
                ORDER BY lower(o.name) COLLATE "C" ASC LIMIT 1;
            END IF;
        ELSE
            IF v_upper_bound IS NOT NULL THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek AND lower(o.name) COLLATE "C" >= v_prefix_lower
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            ELSIF v_prefix_lower <> '' THEN
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek AND lower(o.name) COLLATE "C" >= v_prefix_lower
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            ELSE
                SELECT o.name INTO v_peek_name FROM storage.objects o
                WHERE o.bucket_id = bucketname AND lower(o.name) COLLATE "C" < v_next_seek
                ORDER BY lower(o.name) COLLATE "C" DESC LIMIT 1;
            END IF;
        END IF;

        EXIT WHEN v_peek_name IS NULL;

        -- STEP 2: Check if this is a FOLDER or FILE
        v_common_prefix := storage.get_common_prefix(lower(v_peek_name), v_prefix_lower, v_delimiter);

        IF v_common_prefix IS NOT NULL THEN
            -- FOLDER: Handle offset, emit if needed, skip to next folder
            IF v_skipped < offsets THEN
                v_skipped := v_skipped + 1;
            ELSE
                name := split_part(rtrim(storage.get_common_prefix(v_peek_name, v_prefix, v_delimiter), v_delimiter), v_delimiter, levels);
                id := NULL;
                updated_at := NULL;
                created_at := NULL;
                last_accessed_at := NULL;
                metadata := NULL;
                RETURN NEXT;
                v_count := v_count + 1;
            END IF;

            -- Advance seek past the folder range
            IF v_is_asc THEN
                v_next_seek := lower(left(v_common_prefix, -1)) || chr(ascii(v_delimiter) + 1);
            ELSE
                v_next_seek := lower(v_common_prefix);
            END IF;
        ELSE
            -- FILE: Batch fetch using DYNAMIC SQL (overhead amortized over many rows)
            -- For ASC: upper_bound is the exclusive upper limit (< condition)
            -- For DESC: prefix_lower is the inclusive lower limit (>= condition)
            FOR v_current IN EXECUTE v_batch_query
                USING bucketname, v_next_seek,
                    CASE WHEN v_is_asc THEN COALESCE(v_upper_bound, v_prefix_lower) ELSE v_prefix_lower END, v_file_batch_size
            LOOP
                v_common_prefix := storage.get_common_prefix(lower(v_current.name), v_prefix_lower, v_delimiter);

                IF v_common_prefix IS NOT NULL THEN
                    -- Hit a folder: exit batch, let peek handle it
                    v_next_seek := lower(v_current.name);
                    EXIT;
                END IF;

                -- Handle offset skipping
                IF v_skipped < offsets THEN
                    v_skipped := v_skipped + 1;
                ELSE
                    -- Emit file
                    name := split_part(v_current.name, v_delimiter, levels);
                    id := v_current.id;
                    updated_at := v_current.updated_at;
                    created_at := v_current.created_at;
                    last_accessed_at := v_current.last_accessed_at;
                    metadata := v_current.metadata;
                    RETURN NEXT;
                    v_count := v_count + 1;
                END IF;

                -- Advance seek past this file
                IF v_is_asc THEN
                    v_next_seek := lower(v_current.name) || v_delimiter;
                ELSE
                    v_next_seek := lower(v_current.name);
                END IF;

                EXIT WHEN v_count >= v_limit;
            END LOOP;
        END IF;
    END LOOP;
END;
$_$;


--
-- Name: search_by_timestamp(text, text, integer, integer, text, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_by_timestamp(p_prefix text, p_bucket_id text, p_limit integer, p_level integer, p_start_after text, p_sort_order text, p_sort_column text, p_sort_column_after text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_cursor_op text;
    v_query text;
    v_prefix text;
BEGIN
    v_prefix := coalesce(p_prefix, '');

    IF p_sort_order = 'asc' THEN
        v_cursor_op := '>';
    ELSE
        v_cursor_op := '<';
    END IF;

    v_query := format($sql$
        WITH raw_objects AS (
            SELECT
                o.name AS obj_name,
                o.id AS obj_id,
                o.updated_at AS obj_updated_at,
                o.created_at AS obj_created_at,
                o.last_accessed_at AS obj_last_accessed_at,
                o.metadata AS obj_metadata,
                storage.get_common_prefix(o.name, $1, '/') AS common_prefix
            FROM storage.objects o
            WHERE o.bucket_id = $2
              AND o.name COLLATE "C" LIKE $1 || '%%'
        ),
        -- Aggregate common prefixes (folders)
        -- Both created_at and updated_at use MIN(obj_created_at) to match the old prefixes table behavior
        aggregated_prefixes AS (
            SELECT
                rtrim(common_prefix, '/') AS name,
                NULL::uuid AS id,
                MIN(obj_created_at) AS updated_at,
                MIN(obj_created_at) AS created_at,
                NULL::timestamptz AS last_accessed_at,
                NULL::jsonb AS metadata,
                TRUE AS is_prefix
            FROM raw_objects
            WHERE common_prefix IS NOT NULL
            GROUP BY common_prefix
        ),
        leaf_objects AS (
            SELECT
                obj_name AS name,
                obj_id AS id,
                obj_updated_at AS updated_at,
                obj_created_at AS created_at,
                obj_last_accessed_at AS last_accessed_at,
                obj_metadata AS metadata,
                FALSE AS is_prefix
            FROM raw_objects
            WHERE common_prefix IS NULL
        ),
        combined AS (
            SELECT * FROM aggregated_prefixes
            UNION ALL
            SELECT * FROM leaf_objects
        ),
        filtered AS (
            SELECT *
            FROM combined
            WHERE (
                $5 = ''
                OR ROW(
                    date_trunc('milliseconds', %I),
                    name COLLATE "C"
                ) %s ROW(
                    COALESCE(NULLIF($6, '')::timestamptz, 'epoch'::timestamptz),
                    $5
                )
            )
        )
        SELECT
            split_part(name, '/', $3) AS key,
            name,
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
        FROM filtered
        ORDER BY
            COALESCE(date_trunc('milliseconds', %I), 'epoch'::timestamptz) %s,
            name COLLATE "C" %s
        LIMIT $4
    $sql$,
        p_sort_column,
        v_cursor_op,
        p_sort_column,
        p_sort_order,
        p_sort_order
    );

    RETURN QUERY EXECUTE v_query
    USING v_prefix, p_bucket_id, p_level, p_limit, p_start_after, p_sort_column_after;
END;
$_$;


--
-- Name: search_v2(text, text, integer, integer, text, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer DEFAULT 100, levels integer DEFAULT 1, start_after text DEFAULT ''::text, sort_order text DEFAULT 'asc'::text, sort_column text DEFAULT 'name'::text, sort_column_after text DEFAULT ''::text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_sort_col text;
    v_sort_ord text;
    v_limit int;
BEGIN
    -- Cap limit to maximum of 1500 records
    v_limit := LEAST(coalesce(limits, 100), 1500);

    -- Validate and normalize sort_order
    v_sort_ord := lower(coalesce(sort_order, 'asc'));
    IF v_sort_ord NOT IN ('asc', 'desc') THEN
        v_sort_ord := 'asc';
    END IF;

    -- Validate and normalize sort_column
    v_sort_col := lower(coalesce(sort_column, 'name'));
    IF v_sort_col NOT IN ('name', 'updated_at', 'created_at') THEN
        v_sort_col := 'name';
    END IF;

    -- Route to appropriate implementation
    IF v_sort_col = 'name' THEN
        -- Use list_objects_with_delimiter for name sorting (most efficient: O(k * log n))
        RETURN QUERY
        SELECT
            split_part(l.name, '/', levels) AS key,
            l.name AS name,
            l.id,
            l.updated_at,
            l.created_at,
            l.last_accessed_at,
            l.metadata
        FROM storage.list_objects_with_delimiter(
            bucket_name,
            coalesce(prefix, ''),
            '/',
            v_limit,
            start_after,
            '',
            v_sort_ord
        ) l;
    ELSE
        -- Use aggregation approach for timestamp sorting
        -- Not efficient for large datasets but supports correct pagination
        RETURN QUERY SELECT * FROM storage.search_by_timestamp(
            prefix, bucket_name, v_limit, levels, start_after,
            v_sort_ord, v_sort_col, sort_column_after
        );
    END IF;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW; 
END;
$$;


--
-- Name: http_request(); Type: FUNCTION; Schema: supabase_functions; Owner: -
--

CREATE FUNCTION supabase_functions.http_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'supabase_functions'
    AS $$
  DECLARE
    request_id bigint;
    payload jsonb;
    url text := TG_ARGV[0]::text;
    method text := TG_ARGV[1]::text;
    headers jsonb DEFAULT '{}'::jsonb;
    params jsonb DEFAULT '{}'::jsonb;
    timeout_ms integer DEFAULT 1000;
  BEGIN
    IF url IS NULL OR url = 'null' THEN
      RAISE EXCEPTION 'url argument is missing';
    END IF;

    IF method IS NULL OR method = 'null' THEN
      RAISE EXCEPTION 'method argument is missing';
    END IF;

    IF TG_ARGV[2] IS NULL OR TG_ARGV[2] = 'null' THEN
      headers = '{"Content-Type": "application/json"}'::jsonb;
    ELSE
      headers = TG_ARGV[2]::jsonb;
    END IF;

    IF TG_ARGV[3] IS NULL OR TG_ARGV[3] = 'null' THEN
      params = '{}'::jsonb;
    ELSE
      params = TG_ARGV[3]::jsonb;
    END IF;

    IF TG_ARGV[4] IS NULL OR TG_ARGV[4] = 'null' THEN
      timeout_ms = 1000;
    ELSE
      timeout_ms = TG_ARGV[4]::integer;
    END IF;

    CASE
      WHEN method = 'GET' THEN
        SELECT http_get INTO request_id FROM net.http_get(
          url,
          params,
          headers,
          timeout_ms
        );
      WHEN method = 'POST' THEN
        payload = jsonb_build_object(
          'old_record', OLD,
          'record', NEW,
          'type', TG_OP,
          'table', TG_TABLE_NAME,
          'schema', TG_TABLE_SCHEMA
        );

        SELECT http_post INTO request_id FROM net.http_post(
          url,
          payload,
          params,
          headers,
          timeout_ms
        );
      ELSE
        RAISE EXCEPTION 'method argument % is invalid', method;
    END CASE;

    INSERT INTO supabase_functions.hooks
      (hook_table_id, hook_name, request_id)
    VALUES
      (TG_RELID, TG_NAME, request_id);

    RETURN NEW;
  END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log_entries; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.audit_log_entries (
    instance_id uuid,
    id uuid NOT NULL,
    payload json,
    created_at timestamp with time zone,
    ip_address character varying(64) DEFAULT ''::character varying NOT NULL
);


--
-- Name: TABLE audit_log_entries; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';


--
-- Name: custom_oauth_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.custom_oauth_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_type text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    acceptable_client_ids text[] DEFAULT '{}'::text[] NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    pkce_enabled boolean DEFAULT true NOT NULL,
    attribute_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    authorization_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    email_optional boolean DEFAULT false NOT NULL,
    issuer text,
    discovery_url text,
    skip_nonce_check boolean DEFAULT false NOT NULL,
    cached_discovery jsonb,
    discovery_cached_at timestamp with time zone,
    authorization_url text,
    token_url text,
    userinfo_url text,
    jwks_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_claims_allowlist text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT custom_oauth_providers_authorization_url_https CHECK (((authorization_url IS NULL) OR (authorization_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_authorization_url_length CHECK (((authorization_url IS NULL) OR (char_length(authorization_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_client_id_length CHECK (((char_length(client_id) >= 1) AND (char_length(client_id) <= 512))),
    CONSTRAINT custom_oauth_providers_discovery_url_length CHECK (((discovery_url IS NULL) OR (char_length(discovery_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_identifier_format CHECK ((identifier ~ '^[a-z0-9][a-z0-9:-]{0,48}[a-z0-9]$'::text)),
    CONSTRAINT custom_oauth_providers_issuer_length CHECK (((issuer IS NULL) OR ((char_length(issuer) >= 1) AND (char_length(issuer) <= 2048)))),
    CONSTRAINT custom_oauth_providers_jwks_uri_https CHECK (((jwks_uri IS NULL) OR (jwks_uri ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_jwks_uri_length CHECK (((jwks_uri IS NULL) OR (char_length(jwks_uri) <= 2048))),
    CONSTRAINT custom_oauth_providers_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100))),
    CONSTRAINT custom_oauth_providers_oauth2_requires_endpoints CHECK (((provider_type <> 'oauth2'::text) OR ((authorization_url IS NOT NULL) AND (token_url IS NOT NULL) AND (userinfo_url IS NOT NULL)))),
    CONSTRAINT custom_oauth_providers_oidc_discovery_url_https CHECK (((provider_type <> 'oidc'::text) OR (discovery_url IS NULL) OR (discovery_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_issuer_https CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NULL) OR (issuer ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_oidc_requires_issuer CHECK (((provider_type <> 'oidc'::text) OR (issuer IS NOT NULL))),
    CONSTRAINT custom_oauth_providers_provider_type_check CHECK ((provider_type = ANY (ARRAY['oauth2'::text, 'oidc'::text]))),
    CONSTRAINT custom_oauth_providers_token_url_https CHECK (((token_url IS NULL) OR (token_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_token_url_length CHECK (((token_url IS NULL) OR (char_length(token_url) <= 2048))),
    CONSTRAINT custom_oauth_providers_userinfo_url_https CHECK (((userinfo_url IS NULL) OR (userinfo_url ~~ 'https://%'::text))),
    CONSTRAINT custom_oauth_providers_userinfo_url_length CHECK (((userinfo_url IS NULL) OR (char_length(userinfo_url) <= 2048)))
);


--
-- Name: flow_state; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.flow_state (
    id uuid NOT NULL,
    user_id uuid,
    auth_code text,
    code_challenge_method auth.code_challenge_method,
    code_challenge text,
    provider_type text NOT NULL,
    provider_access_token text,
    provider_refresh_token text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamp with time zone,
    invite_token text,
    referrer text,
    oauth_client_state_id uuid,
    linking_target_id uuid,
    email_optional boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE flow_state; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.flow_state IS 'Stores metadata for all OAuth/SSO login flows';


--
-- Name: identities; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    email text GENERATED ALWAYS AS (lower((identity_data ->> 'email'::text))) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: TABLE identities; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';


--
-- Name: COLUMN identities.email; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';


--
-- Name: instances; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.instances (
    id uuid NOT NULL,
    uuid uuid,
    raw_base_config text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: TABLE instances; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';


--
-- Name: mfa_amr_claims; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL
);


--
-- Name: TABLE mfa_amr_claims; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';


--
-- Name: mfa_challenges; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    ip_address inet NOT NULL,
    otp_code text,
    web_authn_session_data jsonb
);


--
-- Name: TABLE mfa_challenges; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';


--
-- Name: mfa_factors; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text,
    factor_type auth.factor_type NOT NULL,
    status auth.factor_status NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    secret text,
    phone text,
    last_challenged_at timestamp with time zone,
    web_authn_credential jsonb,
    web_authn_aaguid uuid,
    last_webauthn_challenge_data jsonb
);


--
-- Name: TABLE mfa_factors; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';


--
-- Name: COLUMN mfa_factors.last_webauthn_challenge_data; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.mfa_factors.last_webauthn_challenge_data IS 'Stores the latest WebAuthn challenge data including attestation/assertion for customer verification';


--
-- Name: oauth_authorizations; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_authorizations (
    id uuid NOT NULL,
    authorization_id text NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    state text,
    resource text,
    code_challenge text,
    code_challenge_method auth.code_challenge_method,
    response_type auth.oauth_response_type DEFAULT 'code'::auth.oauth_response_type NOT NULL,
    status auth.oauth_authorization_status DEFAULT 'pending'::auth.oauth_authorization_status NOT NULL,
    authorization_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:03:00'::interval) NOT NULL,
    approved_at timestamp with time zone,
    nonce text,
    CONSTRAINT oauth_authorizations_authorization_code_length CHECK ((char_length(authorization_code) <= 255)),
    CONSTRAINT oauth_authorizations_code_challenge_length CHECK ((char_length(code_challenge) <= 128)),
    CONSTRAINT oauth_authorizations_expires_at_future CHECK ((expires_at > created_at)),
    CONSTRAINT oauth_authorizations_nonce_length CHECK ((char_length(nonce) <= 255)),
    CONSTRAINT oauth_authorizations_redirect_uri_length CHECK ((char_length(redirect_uri) <= 2048)),
    CONSTRAINT oauth_authorizations_resource_length CHECK ((char_length(resource) <= 2048)),
    CONSTRAINT oauth_authorizations_scope_length CHECK ((char_length(scope) <= 4096)),
    CONSTRAINT oauth_authorizations_state_length CHECK ((char_length(state) <= 4096))
);


--
-- Name: oauth_client_states; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_client_states (
    id uuid NOT NULL,
    provider_type text NOT NULL,
    code_verifier text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE oauth_client_states; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.oauth_client_states IS 'Stores OAuth states for third-party provider authentication flows where Supabase acts as the OAuth client.';


--
-- Name: oauth_clients; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_clients (
    id uuid NOT NULL,
    client_secret_hash text,
    registration_type auth.oauth_registration_type NOT NULL,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    client_name text,
    client_uri text,
    logo_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_type auth.oauth_client_type DEFAULT 'confidential'::auth.oauth_client_type NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    CONSTRAINT oauth_clients_client_name_length CHECK ((char_length(client_name) <= 1024)),
    CONSTRAINT oauth_clients_client_uri_length CHECK ((char_length(client_uri) <= 2048)),
    CONSTRAINT oauth_clients_logo_uri_length CHECK ((char_length(logo_uri) <= 2048)),
    CONSTRAINT oauth_clients_token_endpoint_auth_method_check CHECK ((token_endpoint_auth_method = ANY (ARRAY['client_secret_basic'::text, 'client_secret_post'::text, 'none'::text])))
);


--
-- Name: oauth_consents; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_consents (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    scopes text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT oauth_consents_revoked_after_granted CHECK (((revoked_at IS NULL) OR (revoked_at >= granted_at))),
    CONSTRAINT oauth_consents_scopes_length CHECK ((char_length(scopes) <= 2048)),
    CONSTRAINT oauth_consents_scopes_not_empty CHECK ((char_length(TRIM(BOTH FROM scopes)) > 0))
);


--
-- Name: one_time_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_type auth.one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT one_time_tokens_token_hash_check CHECK ((char_length(token_hash) > 0))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.refresh_tokens (
    instance_id uuid,
    id bigint NOT NULL,
    token character varying(255),
    user_id character varying(255),
    revoked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    parent character varying(255),
    session_id uuid
);


--
-- Name: TABLE refresh_tokens; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: saml_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL,
    metadata_xml text NOT NULL,
    metadata_url text,
    attribute_mapping jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    name_id_format text,
    CONSTRAINT "entity_id not empty" CHECK ((char_length(entity_id) > 0)),
    CONSTRAINT "metadata_url not empty" CHECK (((metadata_url = NULL::text) OR (char_length(metadata_url) > 0))),
    CONSTRAINT "metadata_xml not empty" CHECK ((char_length(metadata_xml) > 0))
);


--
-- Name: TABLE saml_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';


--
-- Name: saml_relay_states; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text,
    redirect_to text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    flow_state_id uuid,
    CONSTRAINT "request_id not empty" CHECK ((char_length(request_id) > 0))
);


--
-- Name: TABLE saml_relay_states; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';


--
-- Name: schema_migrations; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.schema_migrations (
    version character varying(255) NOT NULL
);


--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';


--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    factor_id uuid,
    aal auth.aal_level,
    not_after timestamp with time zone,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text,
    oauth_client_id uuid,
    refresh_token_hmac_key text,
    refresh_token_counter bigint,
    scopes text,
    CONSTRAINT sessions_scopes_length CHECK ((char_length(scopes) <= 4096))
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';


--
-- Name: COLUMN sessions.not_after; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';


--
-- Name: COLUMN sessions.refresh_token_hmac_key; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sessions.refresh_token_hmac_key IS 'Holds a HMAC-SHA256 key used to sign refresh tokens for this session.';


--
-- Name: COLUMN sessions.refresh_token_counter; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sessions.refresh_token_counter IS 'Holds the ID (counter) of the last issued refresh token.';


--
-- Name: sso_domains; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "domain not empty" CHECK ((char_length(domain) > 0))
);


--
-- Name: TABLE sso_domains; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';


--
-- Name: sso_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_providers (
    id uuid NOT NULL,
    resource_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    disabled boolean,
    CONSTRAINT "resource_id not empty" CHECK (((resource_id = NULL::text) OR (char_length(resource_id) > 0)))
);


--
-- Name: TABLE sso_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';


--
-- Name: COLUMN sso_providers.resource_id; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: webauthn_challenges; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.webauthn_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    challenge_type text NOT NULL,
    session_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT webauthn_challenges_challenge_type_check CHECK ((challenge_type = ANY (ARRAY['signup'::text, 'registration'::text, 'authentication'::text])))
);


--
-- Name: webauthn_credentials; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.webauthn_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    credential_id bytea NOT NULL,
    public_key bytea NOT NULL,
    attestation_type text DEFAULT ''::text NOT NULL,
    aaguid uuid,
    sign_count bigint DEFAULT 0 NOT NULL,
    transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    backup_eligible boolean DEFAULT false NOT NULL,
    backed_up boolean DEFAULT false NOT NULL,
    friendly_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: admin_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    call_sign text NOT NULL,
    role public.admin_role DEFAULT 'OPS'::public.admin_role NOT NULL,
    region text DEFAULT 'AE'::text NOT NULL,
    token_hash text NOT NULL,
    invited_by uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    redeemed_user_id uuid,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.admin_invites FORCE ROW LEVEL SECURITY;


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    call_sign text NOT NULL,
    role public.admin_role DEFAULT 'OPS'::public.admin_role NOT NULL,
    region text DEFAULT 'AE'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    phone_e164 text
);

ALTER TABLE ONLY public.admin_users FORCE ROW LEVEL SECURITY;


--
-- Name: agent_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_audit (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    from_status public.agent_status,
    to_status public.agent_status NOT NULL,
    actor_id uuid,
    actor_role text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.agent_audit FORCE ROW LEVEL SECURITY;


--
-- Name: agent_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_audit_id_seq OWNED BY public.agent_audit.id;


--
-- Name: agent_deployment_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_deployment_checks (
    user_id uuid NOT NULL,
    check_key text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    signed_by uuid,
    signed_at timestamp with time zone,
    notes text,
    mission_id uuid
);

ALTER TABLE ONLY public.agent_deployment_checks FORCE ROW LEVEL SECURITY;


--
-- Name: agent_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    slot text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    title text NOT NULL,
    state public.agent_doc_state DEFAULT 'upload'::public.agent_doc_state NOT NULL,
    file_url text,
    file_hash_sha256 text,
    uploaded_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    reviewer_id uuid,
    expires_at timestamp with time zone,
    issuing_body text
);

ALTER TABLE ONLY public.agent_documents FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN agent_documents.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_documents.expires_at IS 'Validity end of this qualification/document (Issue 39). NULL = no expiry recorded — never treat NULL as expired.';


--
-- Name: COLUMN agent_documents.issuing_body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_documents.issuing_body IS 'Organisation that issued the qualification (Issue 39 / Issue 36). Organisation name only — never a holder name or certificate reference.';


--
-- Name: agent_kyc_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_kyc_checks (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    state public.agent_check_state DEFAULT 'queued'::public.agent_check_state NOT NULL,
    subject text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    settled_at timestamp with time zone,
    file_url text,
    file_hash_sha256 text,
    uploaded_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    reviewer_id uuid
);

ALTER TABLE ONLY public.agent_kyc_checks FORCE ROW LEVEL SECURITY;


--
-- Name: agent_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_profiles (
    user_id uuid NOT NULL,
    company jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact jsonb DEFAULT '{}'::jsonb NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    coverage jsonb DEFAULT '{"services": [], "countries": []}'::jsonb NOT NULL,
    availability jsonb DEFAULT '{"mode": "full", "loadout": []}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.agent_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: agent_review_pipeline; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_review_pipeline (
    user_id uuid NOT NULL,
    step text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    settled_at timestamp with time zone,
    reviewer_id uuid,
    notes text
);

ALTER TABLE ONLY public.agent_review_pipeline FORCE ROW LEVEL SECURITY;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    user_id uuid NOT NULL,
    type public.agent_type NOT NULL,
    status public.agent_status DEFAULT 'DRAFT'::public.agent_status NOT NULL,
    tier integer DEFAULT 2 NOT NULL,
    call_sign text,
    display_name text,
    rate_aed_per_hour numeric(10,2),
    rating numeric(3,2),
    jobs_total integer DEFAULT 0 NOT NULL,
    duty_hours_mtd integer DEFAULT 0 NOT NULL,
    on_duty boolean DEFAULT false NOT NULL,
    submitted_at timestamp with time zone,
    approved_at timestamp with time zone,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    managed_by_org_id uuid,
    region_code text,
    last_lat double precision,
    last_lng double precision,
    last_location_at timestamp with time zone,
    last_location public.geography(Point,4326),
    offers_received integer DEFAULT 0 NOT NULL,
    offers_accepted integer DEFAULT 0 NOT NULL,
    reliability_breaches integer DEFAULT 0 NOT NULL,
    dpa_accepted_at timestamp with time zone,
    dpa_version text,
    offers_rejected integer DEFAULT 0 NOT NULL,
    acceptance_rate numeric(4,3),
    cooldown_until timestamp with time zone,
    last_location_accuracy_m double precision,
    last_location_mocked boolean DEFAULT false NOT NULL,
    created_by_ops uuid
);

ALTER TABLE ONLY public.agents FORCE ROW LEVEL SECURITY;


--
-- Name: armed_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.armed_authorizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cpo_user_id uuid NOT NULL,
    region_code text NOT NULL,
    permit_ref text,
    authorized boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_by uuid,
    verified_at timestamp with time zone,
    reject_reason text,
    created_by uuid
);

ALTER TABLE ONLY public.armed_authorizations FORCE ROW LEVEL SECURITY;


--
-- Name: attendance_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    org_user_id uuid NOT NULL,
    corrected_by uuid NOT NULL,
    cpo_user_id uuid,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text NOT NULL,
    before_value jsonb NOT NULL,
    after_value jsonb NOT NULL,
    CONSTRAINT attendance_corrections_changes_something CHECK ((before_value <> after_value)),
    CONSTRAINT attendance_corrections_reason_not_blank CHECK ((length(btrim(reason)) > 0))
);


--
-- Name: auth_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    platform text DEFAULT 'android'::text NOT NULL,
    refresh_token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    current_jti text,
    signal_device_id smallint NOT NULL,
    CONSTRAINT auth_devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);

ALTER TABLE ONLY public.auth_devices FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE auth_devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_devices IS 'RLS disabled (accepted deviation). Ownership enforced via req.user.sub at route layer.';


--
-- Name: auth_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    channel text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT auth_otps_channel_check CHECK ((channel = ANY (ARRAY['phone'::text, 'email'::text, 'totp'::text])))
);

ALTER TABLE ONLY public.auth_otps FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE auth_otps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_otps IS 'RLS disabled (accepted deviation). All queries scoped to user_id from JWT sub.';


--
-- Name: COLUMN auth_otps.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_otps.expires_at IS '10 minutes after creation (per plan spec — extended from original 5 min).';


--
-- Name: COLUMN auth_otps.attempt_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_otps.attempt_count IS 'Incremented on each failed verify attempt. Code invalidated when >= 3.';


--
-- Name: auth_totp_backup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_totp_backup_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_totp_backup_codes FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE auth_totp_backup_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_totp_backup_codes IS '10 backup codes per user. code_hash is SHA-256. used_at enforces single-use. All rows deleted and regenerated when setup is re-run.';


--
-- Name: auth_totp_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_totp_secrets (
    user_id uuid NOT NULL,
    secret_encrypted bytea NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_totp_secrets FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE auth_totp_secrets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_totp_secrets IS 'One TOTP secret per user. secret_encrypted is AES-256-GCM; key from TOTP_ENCRYPTION_KEY env.';


--
-- Name: COLUMN auth_totp_secrets.verified_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auth_totp_secrets.verified_at IS 'NULL = setup initiated but not yet confirmed. Unverified secrets older than 10 min should be GC''d.';


--
-- Name: backup_merkle_commits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_merkle_commits (
    user_id uuid NOT NULL,
    root_b64 text NOT NULL,
    row_count integer NOT NULL,
    seq bigint NOT NULL,
    sent_at_ms bigint NOT NULL,
    sig_b64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.backup_merkle_commits FORCE ROW LEVEL SECURITY;


--
-- Name: backup_session_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_session_snapshots (
    user_id uuid NOT NULL,
    blob bytea NOT NULL,
    seq bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.backup_session_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: blocked_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_users (
    blocker_user_id uuid NOT NULL,
    blocked_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blocked_users_check CHECK ((blocker_user_id <> blocked_user_id))
);

ALTER TABLE ONLY public.blocked_users FORCE ROW LEVEL SECURITY;


--
-- Name: booking_cpo_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_cpo_assignments (
    booking_id uuid NOT NULL,
    cpo_id uuid NOT NULL,
    slot integer DEFAULT 0 NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.booking_cpo_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: booking_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    raised_by uuid NOT NULL,
    category text NOT NULL,
    reason text,
    status text DEFAULT 'open'::text NOT NULL,
    to_client_credits integer,
    to_provider_credits integer,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone
);

ALTER TABLE ONLY public.booking_disputes FORCE ROW LEVEL SECURITY;


--
-- Name: channel_membership_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_membership_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    action text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT channel_membership_intents_action_check CHECK ((action = ANY (ARRAY['add'::text, 'remove'::text]))),
    CONSTRAINT channel_membership_intents_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'done'::text])))
);

ALTER TABLE ONLY public.channel_membership_intents FORCE ROW LEVEL SECURITY;


--
-- Name: compliance_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_user_id uuid NOT NULL,
    subject_kind text NOT NULL,
    kind text NOT NULL,
    region_code text NOT NULL,
    reference text,
    issued_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    file_url text,
    file_hash_sha256 text,
    verified_by uuid,
    verified_at timestamp with time zone,
    reject_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.compliance_credentials FORCE ROW LEVEL SECURITY;


--
-- Name: conversation_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_backups (
    owner_user_id uuid NOT NULL,
    conversation_id text NOT NULL,
    kind text NOT NULL,
    name text,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_message_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_muted boolean DEFAULT false NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    default_ttl_sec integer,
    unread_count integer DEFAULT 0 NOT NULL,
    is_custom_name boolean DEFAULT false NOT NULL,
    group_state jsonb,
    deleted boolean DEFAULT false NOT NULL,
    CONSTRAINT conversation_backups_kind_check CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text, 'system'::text])))
);

ALTER TABLE ONLY public.conversation_backups FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN conversation_backups.group_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.conversation_backups.group_state IS 'For kind=group: serialized GroupState ({owner, members, masterKeyB64, epoch, name}). NULL for direct/system rooms.';


--
-- Name: conversation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_members (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT conversation_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);

ALTER TABLE ONLY public.conversation_members FORCE ROW LEVEL SECURITY;


--
-- Name: conversation_membership_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_membership_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    action text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT conversation_membership_intents_action_check CHECK ((action = ANY (ARRAY['add'::text, 'remove'::text]))),
    CONSTRAINT conversation_membership_intents_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'done'::text])))
);

ALTER TABLE ONLY public.conversation_membership_intents FORCE ROW LEVEL SECURITY;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    title text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    archived_reason text,
    CONSTRAINT conversations_kind_check CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text])))
);

ALTER TABLE ONLY public.conversations FORCE ROW LEVEL SECURITY;


--
-- Name: cpo_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cpo_pool (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_sign text NOT NULL,
    display_name text NOT NULL,
    role text DEFAULT 'CPO'::text NOT NULL,
    region_code text DEFAULT 'AE'::text NOT NULL,
    armed boolean DEFAULT false NOT NULL,
    female boolean DEFAULT false NOT NULL,
    specialties text[] DEFAULT '{}'::text[] NOT NULL,
    availability public.cpo_availability DEFAULT 'available'::public.cpo_availability NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.cpo_pool FORCE ROW LEVEL SECURITY;


--
-- Name: cpo_roster_months; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cpo_roster_months (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_user_id uuid NOT NULL,
    department text,
    month date NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    amended_at timestamp with time zone,
    archived_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cpo_roster_months_first_of_month CHECK ((month = (date_trunc('month'::text, (month)::timestamp with time zone))::date)),
    CONSTRAINT cpo_roster_months_publish_stamp CHECK (((status <> ALL (ARRAY['published'::text, 'amended'::text])) OR ((published_at IS NOT NULL) AND (published_by IS NOT NULL)))),
    CONSTRAINT cpo_roster_months_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'amended'::text, 'archived'::text])))
);


--
-- Name: cpo_shift_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cpo_shift_assignments (
    shift_id uuid NOT NULL,
    cpo_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.cpo_shift_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: cpo_shift_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cpo_shift_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_user_id uuid NOT NULL,
    cpo_user_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    clock_in_at timestamp with time zone DEFAULT now() NOT NULL,
    clock_in_lat double precision,
    clock_in_lng double precision,
    clock_in_accuracy_m double precision,
    clock_out_at timestamp with time zone,
    clock_out_lat double precision,
    clock_out_lng double precision,
    edited_by uuid,
    edited_at timestamp with time zone,
    edit_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shift_id uuid,
    face_verified boolean,
    face_meta jsonb,
    within_radius boolean,
    distance_m integer,
    attendance_status text,
    review_status text DEFAULT 'none'::text NOT NULL,
    review_reason text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    admin_notes text,
    dispute_note text,
    CONSTRAINT cpo_shift_sessions_attendance_status_check CHECK (((attendance_status IS NULL) OR (attendance_status = ANY (ARRAY['present'::text, 'late'::text, 'absent'::text, 'early_checkout'::text, 'leave'::text, 'sick_leave'::text, 'off_duty'::text, 'pending_review'::text, 'emergency_leave'::text, 'mission'::text])))),
    CONSTRAINT cpo_shift_sessions_review_reason_check CHECK (((review_reason IS NULL) OR (review_reason = ANY (ARRAY['face_mismatch'::text, 'out_of_radius'::text, 'permission_denied'::text, 'offline'::text, 'camera_unavailable'::text, 'disputed'::text])))),
    CONSTRAINT cpo_shift_sessions_review_status_check CHECK ((review_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT cpo_shift_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'edited'::text])))
);

ALTER TABLE ONLY public.cpo_shift_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: cpo_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cpo_shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_user_id uuid NOT NULL,
    department text,
    site_label text,
    site_lat double precision,
    site_lng double precision,
    approved_radius_m integer DEFAULT 150 NOT NULL,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    created_by uuid NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    roster_month_id uuid,
    recurrence_group_id uuid
);

ALTER TABLE ONLY public.cpo_shifts FORCE ROW LEVEL SECURITY;


--
-- Name: department_channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_channel_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    role_label text,
    last_read_at timestamp with time zone,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT department_channel_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'viewer'::text])))
);

ALTER TABLE ONLY public.department_channel_members FORCE ROW LEVEL SECURITY;


--
-- Name: department_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    department text,
    group_conversation_id text,
    created_by uuid NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    channel_type text DEFAULT 'department'::text NOT NULL,
    access text DEFAULT 'standard'::text NOT NULL,
    name_changed_by uuid,
    name_changed_at timestamp with time zone,
    parent_id uuid,
    level smallint DEFAULT 1 NOT NULL,
    post_mode text DEFAULT 'read_only'::text NOT NULL,
    is_broadcast boolean DEFAULT false NOT NULL,
    is_lateral boolean DEFAULT false NOT NULL,
    CONSTRAINT department_channels_access_check CHECK ((access = ANY (ARRAY['standard'::text, 'read_only'::text, 'restricted'::text]))),
    CONSTRAINT department_channels_channel_type_check CHECK ((channel_type = ANY (ARRAY['board'::text, 'department'::text, 'incident'::text]))),
    CONSTRAINT department_channels_level_range CHECK (((level >= 0) AND (level <= 3))),
    CONSTRAINT department_channels_post_mode_valid CHECK ((post_mode = ANY (ARRAY['open'::text, 'read_only'::text, 'announcement'::text, 'admin_only'::text])))
);

ALTER TABLE ONLY public.department_channels FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN department_channels.is_lateral; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.department_channels.is_lateral IS 'UI corrections 2026-08-15 item 04: a chat channel attached to a hierarchy level without consuming a tier. Inherits its parent level, must have a parent, must stay a leaf, and is frozen after insert.';


--
-- Name: dispatch_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    provider_user_id uuid NOT NULL,
    rank integer NOT NULL,
    distance_km numeric(7,2),
    status public.dispatch_offer_status DEFAULT 'OFFERED'::public.dispatch_offer_status NOT NULL,
    offered_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    responded_at timestamp with time zone,
    reject_reason text
);

ALTER TABLE ONLY public.dispatch_offers FORCE ROW LEVEL SECURITY;


--
-- Name: dispatch_room_crypto_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_room_crypto_claims (
    conversation_id uuid NOT NULL,
    claimed_by uuid NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dispatch_room_crypto_claims FORCE ROW LEVEL SECURITY;


--
-- Name: dispatch_room_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_room_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    org_user_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    action text DEFAULT 'add'::text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT dispatch_room_intents_action_check CHECK ((action = ANY (ARRAY['add'::text, 'remove'::text]))),
    CONSTRAINT dispatch_room_intents_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'done'::text])))
);

ALTER TABLE ONLY public.dispatch_room_intents FORCE ROW LEVEL SECURITY;


--
-- Name: enterprise_join_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enterprise_join_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_user_id uuid NOT NULL,
    applicant_user_id uuid NOT NULL,
    link_id uuid,
    applicant_name text,
    applicant_phone text,
    applicant_email text,
    referrer_user_id uuid,
    team_channel_id uuid,
    message text,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    seed_pending_at timestamp with time zone,
    CONSTRAINT enterprise_join_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text])))
);


--
-- Name: COLUMN enterprise_join_requests.seed_pending_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enterprise_join_requests.seed_pending_at IS 'Set in-tx on approval, cleared by the channel seeder on success. Non-null means the member may be short some channels and needs a re-seed.';


--
-- Name: enterprise_referral_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enterprise_referral_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    org_user_id uuid NOT NULL,
    referrer_user_id uuid,
    team_channel_id uuid,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    invited_phone text,
    invited_email text,
    invited_name text,
    invited_role text DEFAULT 'employee'::text NOT NULL,
    invited_department text,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    team_parent_id uuid,
    CONSTRAINT enterprise_referral_links_dept_needs_manager CHECK (((invited_department IS NULL) OR (invited_role = 'manager'::text))),
    CONSTRAINT enterprise_referral_links_invited_phone_e164 CHECK (((invited_phone IS NULL) OR (invited_phone ~ '^\+[0-9]{7,15}$'::text))),
    CONSTRAINT enterprise_referral_links_invited_role CHECK ((invited_role = ANY (ARRAY['employee'::text, 'manager'::text]))),
    CONSTRAINT enterprise_referral_links_one_contact CHECK ((NOT ((invited_phone IS NOT NULL) AND (invited_email IS NOT NULL))))
);


--
-- Name: COLUMN enterprise_referral_links.team_parent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.enterprise_referral_links.team_parent_id IS 'Parent of team_channel_id at mint time. Non-FK on purpose: it must survive the team being deleted, so accept-time seeding can still resolve the chain.';


--
-- Name: escrow_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escrow_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    offer_id uuid,
    client_id uuid NOT NULL,
    provider_user_id uuid,
    gross_credits integer NOT NULL,
    currency text NOT NULL,
    status public.escrow_hold_status DEFAULT 'HELD'::public.escrow_hold_status NOT NULL,
    held_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    release_eligible_at timestamp with time zone,
    settled_at timestamp with time zone,
    to_provider_credits integer,
    to_client_credits integer,
    platform_fee_credits integer,
    basis text,
    review_required boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.escrow_holds FORCE ROW LEVEL SECURITY;


--
-- Name: family_member_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_member_locations (
    user_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    accuracy_m double precision,
    label text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE family_member_locations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.family_member_locations IS 'Last known device fix per family member (owner-visible on Linked Members). Foreground reports only; row absence is the normal cold state.';


--
-- Name: family_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    holder_id uuid NOT NULL,
    member_id uuid,
    invite_phone text,
    status text DEFAULT 'pending'::text NOT NULL,
    spend_limit_credits integer,
    spent_credits integer DEFAULT 0 NOT NULL,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    relationship text,
    held_until timestamp with time zone
);

ALTER TABLE ONLY public.family_members FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN family_members.relationship; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.family_members.relationship IS 'Owner-declared relationship of the member (spouse/son/daughter/…) — badge on member rows.';


--
-- Name: COLUMN family_members.held_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.family_members.held_until IS 'Owner-imposed hold: while > now() the member cannot spend owner credits or use the owner''s Pro plan.';


--
-- Name: identity_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_backups (
    user_id uuid NOT NULL,
    wrapped_master_key bytea NOT NULL,
    salt bytea NOT NULL,
    kdf_params jsonb NOT NULL,
    wrapped_identity_bundle bytea NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verifier_key bytea
);

ALTER TABLE ONLY public.identity_backups FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN identity_backups.verifier_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.identity_backups.verifier_key IS 'HKDF(derived_key, ''bravo-backup-verifier-v1'', 32B). Server uses this to validate HMAC proofs at /backup/identity/verify. NULL on rows created before the P0-1 audit fix — those rows require a one-time re-setup before /bundle becomes readable again.';


--
-- Name: incident_attachment_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incident_attachment_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attachment_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    device_id integer NOT NULL,
    sealed_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.incident_attachment_keys FORCE ROW LEVEL SECURITY;


--
-- Name: incident_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incident_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    incident_id uuid NOT NULL,
    storage_key text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.incident_attachments FORCE ROW LEVEL SECURITY;


--
-- Name: incident_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incident_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    incident_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    from_status text,
    to_status text,
    note text,
    note_internal boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.incident_events FORCE ROW LEVEL SECURITY;


--
-- Name: incident_ref_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.incident_ref_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incident_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incident_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ref text,
    org_user_id uuid NOT NULL,
    submitter_id uuid NOT NULL,
    department text,
    category text NOT NULL,
    severity text NOT NULL,
    description text NOT NULL,
    location_label text,
    location_lat double precision,
    location_lng double precision,
    status text DEFAULT 'submitted'::text NOT NULL,
    assigned_to uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT incident_reports_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT incident_reports_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'received'::text, 'under_review'::text, 'action_assigned'::text, 'resolved'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.incident_reports FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_sequences (
    region_code text NOT NULL,
    next_no bigint DEFAULT 1 NOT NULL
);

ALTER TABLE ONLY public.invoice_sequences FORCE ROW LEVEL SECURITY;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_number text NOT NULL,
    booking_id uuid NOT NULL,
    kind text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    currency text DEFAULT 'BC'::text NOT NULL,
    line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal_credits integer NOT NULL,
    tax_rate_pct numeric DEFAULT 0 NOT NULL,
    tax_credits integer DEFAULT 0 NOT NULL,
    total_credits integer NOT NULL,
    pdf_url text,
    CONSTRAINT invoices_kind_check CHECK ((kind = ANY (ARRAY['client_receipt'::text, 'credit_note'::text])))
);

ALTER TABLE ONLY public.invoices FORCE ROW LEVEL SECURITY;


--
-- Name: job_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    agent_call_sign text NOT NULL,
    status public.application_status DEFAULT 'PENDING'::public.application_status NOT NULL,
    rank integer,
    fit_score integer,
    distance_km numeric(6,2),
    rate_ccy text DEFAULT 'AED'::text NOT NULL,
    rate_per_hour numeric(10,2),
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    dress_pledge text,
    dress_pledged_at timestamp with time zone,
    applicant_org_id uuid,
    assigned_cpo_user_id uuid
);

ALTER TABLE ONLY public.job_applications FORCE ROW LEVEL SECURITY;


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    short_code text NOT NULL,
    status public.job_status DEFAULT 'PUBLISHED'::public.job_status NOT NULL,
    region_code text NOT NULL,
    route_label text NOT NULL,
    dispatch_at timestamp with time zone NOT NULL,
    duration_hours integer DEFAULT 4 NOT NULL,
    cpo_slots integer DEFAULT 1 NOT NULL,
    requires_armed boolean DEFAULT false NOT NULL,
    requires_armour text,
    slots_filled integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by uuid,
    closed_at timestamp with time zone
);

ALTER TABLE ONLY public.jobs FORCE ROW LEVEL SECURITY;


--
-- Name: lite_booking_add_ons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lite_booking_add_ons (
    id text NOT NULL,
    label text NOT NULL,
    description text,
    region_code text NOT NULL,
    price_eur_per_hour numeric(10,2) DEFAULT 0 NOT NULL,
    requires_ops_approval boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.lite_booking_add_ons FORCE ROW LEVEL SECURITY;


--
-- Name: lite_booking_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lite_booking_audit (
    id bigint NOT NULL,
    booking_id uuid NOT NULL,
    from_status public.lite_booking_status,
    to_status public.lite_booking_status NOT NULL,
    actor_id uuid,
    actor_role text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.lite_booking_audit FORCE ROW LEVEL SECURITY;


--
-- Name: lite_booking_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lite_booking_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lite_booking_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lite_booking_audit_id_seq OWNED BY public.lite_booking_audit.id;


--
-- Name: lite_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lite_bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    status public.lite_booking_status DEFAULT 'DRAFT'::public.lite_booking_status NOT NULL,
    region_code text NOT NULL,
    region_label text NOT NULL,
    service text NOT NULL,
    booking_mode text DEFAULT 'now'::text NOT NULL,
    pickup_time timestamp with time zone NOT NULL,
    pickup_address text NOT NULL,
    pickup_lat numeric(10,7),
    pickup_lng numeric(10,7),
    dropoff_address text,
    dropoff_lat numeric(10,7),
    dropoff_lng numeric(10,7),
    passengers integer DEFAULT 1 NOT NULL,
    cpo_count integer DEFAULT 1 NOT NULL,
    vehicle_count integer DEFAULT 1 NOT NULL,
    driver_only boolean DEFAULT false NOT NULL,
    add_ons jsonb DEFAULT '[]'::jsonb NOT NULL,
    rate_eur_per_hour numeric(10,2) NOT NULL,
    rate_aed_per_hour numeric(10,2) NOT NULL,
    duration_hours integer DEFAULT 4 NOT NULL,
    total_eur numeric(10,2) NOT NULL,
    total_aed numeric(10,2) NOT NULL,
    cpo_id uuid,
    vehicle_id uuid,
    comms_channel_id uuid,
    payment_method text DEFAULT 'card'::text NOT NULL,
    payment_captured boolean DEFAULT false NOT NULL,
    invoice_pdf_url text,
    rating integer,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dress_instructions text,
    dispatch_mode text,
    assigned_provider_user_id uuid,
    dispatch_started_at timestamp with time zone,
    dispatch_settled_at timestamp with time zone,
    crew_deadline_at timestamp with time zone,
    armed_required boolean DEFAULT false NOT NULL,
    requirements jsonb DEFAULT '{}'::jsonb NOT NULL,
    dispute_window_seconds integer,
    location_consent_at timestamp with time zone,
    location_consent_version text,
    female_required boolean DEFAULT false NOT NULL,
    terms_accepted_version text,
    terms_accepted_at timestamp with time zone,
    arrival_deadline_at timestamp with time zone,
    not_my_guard_at timestamp with time zone,
    payer_user_id uuid,
    pricing_breakdown jsonb,
    rating_tags text[],
    rating_remarks text,
    referral_code text,
    referral_code_id uuid,
    task_type text,
    exec_transport jsonb,
    conversation_id uuid,
    confirmed_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    CONSTRAINT lite_bookings_rating_remarks_len CHECK (((rating_remarks IS NULL) OR (char_length(rating_remarks) <= 500)))
);

ALTER TABLE ONLY public.lite_bookings FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN lite_bookings.rating_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.lite_bookings.rating_tags IS 'Preset feedback chips chosen by the client at rating time (Issue 31).';


--
-- Name: COLUMN lite_bookings.rating_remarks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.lite_bookings.rating_remarks IS 'Client free-text remarks, max 500 chars. Authorised quality/ops roles only — never surfaced to the provider (Issue 31).';


--
-- Name: COLUMN lite_bookings.referral_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.lite_bookings.referral_code IS 'The code as submitted, denormalised so reporting survives the code row being deactivated (Issue 28).';


--
-- Name: COLUMN lite_bookings.reminder_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.lite_bookings.reminder_sent_at IS 'B-405: when the T-60min start reminder push was sent (NULL = not yet). Only ''later'' bookings are swept.';


--
-- Name: live_feed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_feed_events (
    id bigint NOT NULL,
    kind text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    actor text,
    subject text,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.live_feed_events FORCE ROW LEVEL SECURITY;


--
-- Name: live_feed_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.live_feed_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: live_feed_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.live_feed_events_id_seq OWNED BY public.live_feed_events.id;


--
-- Name: messages_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_backup (
    owner_user_id uuid NOT NULL,
    message_id text NOT NULL,
    conversation_id text NOT NULL,
    sender_id text NOT NULL,
    recipient_id text,
    msg_type text DEFAULT 'text'::text NOT NULL,
    ciphertext bytea NOT NULL,
    ciphertext_type smallint DEFAULT 1 NOT NULL,
    envelope_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    msg_created_at timestamp with time zone NOT NULL,
    mirrored_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.messages_backup FORCE ROW LEVEL SECURITY;


--
-- Name: mission_crew; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_crew (
    mission_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    slot integer DEFAULT 0 NOT NULL,
    role text NOT NULL,
    call_sign text NOT NULL,
    armed boolean DEFAULT false NOT NULL,
    comms_ch integer DEFAULT 1 NOT NULL,
    mic_hot boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    dress_acknowledged_at timestamp with time zone,
    is_lead boolean DEFAULT false NOT NULL,
    team_idx integer DEFAULT 0 NOT NULL,
    checked_in_at timestamp with time zone,
    accepted_at timestamp with time zone,
    declined_at timestamp with time zone,
    decline_reason text,
    CONSTRAINT mission_crew_role_chk CHECK ((role = ANY (ARRAY['LEAD'::text, 'CP'::text, 'DRIVER'::text, 'RESERVE'::text]))),
    CONSTRAINT mission_crew_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'sos'::text, 'standby'::text, 'off'::text])))
);

ALTER TABLE ONLY public.mission_crew FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN mission_crew.accepted_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mission_crew.accepted_at IS 'When this officer accepted the assignment (Issue 41). NULL = assigned but not yet accepted; the client is NOT told the team is dispatched until at least one crew member has accepted.';


--
-- Name: COLUMN mission_crew.declined_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mission_crew.declined_at IS 'When this officer declined (Issue 41). The provider re-crews; no automatic reassignment yet.';


--
-- Name: mission_hourly_checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_hourly_checkins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mission_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    hour_index integer NOT NULL,
    status text DEFAULT 'SMOOTH'::text NOT NULL,
    comment text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mission_hourly_checkins_comment_check CHECK ((char_length(comment) <= 300)),
    CONSTRAINT mission_hourly_checkins_hour_index_check CHECK (((hour_index >= 1) AND (hour_index <= 24))),
    CONSTRAINT mission_hourly_checkins_status_check CHECK ((status = ANY (ARRAY['SMOOTH'::text, 'ISSUE'::text])))
);


--
-- Name: mission_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mission_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    agent_user_id uuid NOT NULL,
    call_sign text,
    proposed_credits integer NOT NULL,
    paid_credits integer NOT NULL,
    deduction_credits integer DEFAULT 0 NOT NULL,
    deduction_reason text,
    decided_by uuid,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    payee_user_id uuid
);

ALTER TABLE ONLY public.mission_payouts FORCE ROW LEVEL SECURITY;


--
-- Name: mission_principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_principals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mission_id uuid NOT NULL,
    display_name text NOT NULL,
    sub_label text,
    phone text,
    dob_year integer,
    onboard boolean DEFAULT false NOT NULL,
    order_idx integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.mission_principals FORCE ROW LEVEL SECURITY;


--
-- Name: mission_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_telemetry (
    id bigint NOT NULL,
    mission_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading_deg double precision,
    speed_kph double precision,
    accuracy_m double precision,
    distance_to_dropoff_m integer,
    battery_pct integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.mission_telemetry FORCE ROW LEVEL SECURITY;


--
-- Name: mission_telemetry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mission_telemetry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mission_telemetry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mission_telemetry_id_seq OWNED BY public.mission_telemetry.id;


--
-- Name: mission_telemetry_last; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_telemetry_last (
    booking_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading_deg double precision,
    speed_kph double precision,
    eta_minutes integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'agent'::text NOT NULL
);

ALTER TABLE ONLY public.mission_telemetry_last FORCE ROW LEVEL SECURITY;


--
-- Name: mission_waypoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mission_waypoints (
    id bigint NOT NULL,
    mission_id uuid NOT NULL,
    seq integer NOT NULL,
    tag text NOT NULL,
    event text NOT NULL,
    sub text,
    planned_at timestamp with time zone,
    settled_at timestamp with time zone,
    state text DEFAULT 'pending'::text NOT NULL,
    marked_by uuid,
    marked_via text,
    CONSTRAINT mission_waypoints_state_chk CHECK ((state = ANY (ARRAY['pending'::text, 'current'::text, 'done'::text, 'sos'::text])))
);

ALTER TABLE ONLY public.mission_waypoints FORCE ROW LEVEL SECURITY;


--
-- Name: mission_waypoints_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mission_waypoints_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mission_waypoints_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mission_waypoints_id_seq OWNED BY public.mission_waypoints.id;


--
-- Name: missions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.missions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    status public.mission_status DEFAULT 'DISPATCHED'::public.mission_status NOT NULL,
    short_code text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    ended_by uuid,
    end_reason text,
    current_lat double precision,
    current_lng double precision,
    heading_deg double precision,
    speed_kph double precision,
    risk_level text DEFAULT 'LOW'::text NOT NULL,
    comms_pct integer DEFAULT 100 NOT NULL,
    gps_rtk_lock boolean DEFAULT true NOT NULL,
    vehicle_model text,
    vehicle_plate text,
    vehicle_armour text,
    comms_channel_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    route_distance_m integer,
    route_duration_s integer,
    route_polyline text,
    client_lat double precision,
    client_lng double precision,
    client_recorded_at timestamp with time zone,
    pickup_at timestamp with time zone,
    live_at timestamp with time zone,
    comms_room_failed_at timestamp with time zone
);

ALTER TABLE ONLY public.missions FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN missions.comms_room_failed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.missions.comms_room_failed_at IS 'Set when Ops Room creation failed during crew assign (Issue 11) — the mission is dispatched but has no comms room. Cleared when the room is repaired.';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    event_class text NOT NULL,
    kind text NOT NULL,
    booking_id text,
    mission_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    incident_id uuid,
    org_user_id uuid
);


--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notifications IS 'Durable per-user notification inbox (auth-service event classes only — no messenger metadata). Reconcile buffer, 30-day intended retention.';


--
-- Name: COLUMN notifications.incident_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.incident_id IS 'Deep-link target for incident-* kinds. Nullable, no FK: append-only log, dangling ids degrade to the list screen.';


--
-- Name: COLUMN notifications.org_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.org_user_id IS 'Org this event belongs to, so a multi-org recipient tap can scope the workspace surface before it reads. Nullable, no FK: append-only log, unknown ids degrade to the sticky context.';


--
-- Name: ops_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_audit (
    id bigint NOT NULL,
    actor_id uuid,
    actor_role text NOT NULL,
    actor_call text,
    action text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_audit_actor_role_chk CHECK ((actor_role = ANY (ARRAY['OPS'::text, 'SUPERVISOR'::text, 'ADMIN'::text, 'SYSTEM'::text, 'AGENT'::text, 'CLIENT'::text]))),
    CONSTRAINT ops_audit_subject_type_chk CHECK ((subject_type = ANY (ARRAY['booking'::text, 'mission'::text, 'agent'::text, 'job'::text, 'sos'::text, 'application'::text, 'wallet'::text, 'user'::text, 'pii'::text, 'conversation'::text, 'system'::text])))
);

ALTER TABLE ONLY public.ops_audit FORCE ROW LEVEL SECURITY;


--
-- Name: ops_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ops_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ops_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ops_audit_id_seq OWNED BY public.ops_audit.id;


--
-- Name: org_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_user_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    target_kind text,
    target_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.org_audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    org_user_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    member_role text DEFAULT 'cpo'::text NOT NULL,
    call_sign text,
    status text DEFAULT 'active'::text NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_consent_at timestamp with time zone,
    department text,
    suspended_from timestamp with time zone,
    suspended_until timestamp with time zone,
    suspend_reason text,
    suspended_by uuid,
    permitted_modules text[],
    CONSTRAINT org_members_member_role_check CHECK ((member_role = ANY (ARRAY['cpo'::text, 'manager'::text, 'employee'::text]))),
    CONSTRAINT org_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text, 'removed'::text]))),
    CONSTRAINT org_members_status_no_pending CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text, 'removed'::text])))
);

ALTER TABLE ONLY public.org_members FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN org_members.suspended_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_members.suspended_until IS 'NULL = indefinite suspension. Non-NULL = auto-expires; the lazy sweep reinstates via setMemberStatus so channel membership is restored.';


--
-- Name: COLUMN org_members.suspend_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_members.suspend_reason IS 'Mandatory when status=suspended. Surfaced to the suspended CPO at login.';


--
-- Name: org_workspace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_workspace_settings (
    org_user_id uuid NOT NULL,
    hidden_modules text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    level_names text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: TABLE org_workspace_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_workspace_settings IS 'vs2 item 17b: per-workspace presentation settings. hidden_modules controls what the home screen ADVERTISES and is never consulted by an authorisation check — routes stay registered and server guards are unchanged.';


--
-- Name: COLUMN org_workspace_settings.level_names; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_workspace_settings.level_names IS 'PDF checklist line 9: admin-chosen names for the hierarchy tiers, indexed by DISPLAY tier (level_names[1] = L1). Empty = use the built-in Enterprise/Main/Sub/Sub-sub vocabulary. A short array fills the remaining tiers from the built-ins. PRESENTATION ONLY - never read by an authorisation check, and depth is still governed by department_channels.level.';


--
-- Name: org_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_workspaces (
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_workspaces_name_not_blank CHECK ((length(btrim(name)) > 0))
);


--
-- Name: pro_application_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_application_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    actor text NOT NULL,
    event text NOT NULL,
    message text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pro_application_events_actor_check CHECK ((actor = ANY (ARRAY['client'::text, 'ops'::text, 'system'::text])))
);


--
-- Name: TABLE pro_application_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_application_events IS 'Append-only Pro application timeline (client status screen + ops audit).';


--
-- Name: pro_application_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_application_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    sender text NOT NULL,
    sender_id uuid,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pro_application_messages_sender_check CHECK ((sender = ANY (ARRAY['client'::text, 'ops'::text])))
);


--
-- Name: TABLE pro_application_messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_application_messages IS 'Client ↔ Bravo Control System thread per Pro application (revision requests etc.).';


--
-- Name: pro_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'PENDING_PROPOSAL'::text NOT NULL,
    intended_use text NOT NULL,
    intended_use_note text,
    duration_months smallint,
    duration_note text,
    start_date date NOT NULL,
    coverage_area text NOT NULL,
    cpo_count smallint DEFAULT 0 NOT NULL,
    driver_count smallint DEFAULT 0 NOT NULL,
    support_staff_count smallint DEFAULT 0 NOT NULL,
    gender_preference text DEFAULT 'no_preference'::text NOT NULL,
    services jsonb DEFAULT '[]'::jsonb NOT NULL,
    service_other_note text,
    notes text,
    internal_notes text,
    rejected_reason text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    activated_at timestamp with time zone,
    current_period_end timestamp with time zone,
    CONSTRAINT pro_applications_gender_preference_check CHECK ((gender_preference = ANY (ARRAY['no_preference'::text, 'male'::text, 'female'::text, 'mixed'::text]))),
    CONSTRAINT pro_applications_intended_use_check CHECK ((intended_use = ANY (ARRAY['family_support'::text, 'executive_protection'::text, 'travel_protection'::text, 'residential_support'::text, 'event_support'::text, 'custom'::text]))),
    CONSTRAINT pro_applications_status_check CHECK ((status = ANY (ARRAY['PENDING_PROPOSAL'::text, 'PROPOSAL_CREATED'::text, 'REVISION_REQUESTED'::text, 'ACCEPTED'::text, 'ACTIVE'::text, 'REJECTED'::text, 'EXPIRED'::text, 'CANCELLED'::text])))
);


--
-- Name: TABLE pro_applications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_applications IS 'Bravo Secure Pro applications (request-and-approval custom plans). Separate concept from users.subscription_tier.';


--
-- Name: pro_cpo_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_cpo_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    mission_id uuid,
    cpo_user_id uuid NOT NULL,
    org_user_id uuid,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    status text DEFAULT 'ASSIGNED'::text NOT NULL,
    mission_code text NOT NULL,
    note text,
    assigned_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    authorized_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT pro_cpo_assignments_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT pro_cpo_assignments_status_check CHECK ((status = ANY (ARRAY['ASSIGNED'::text, 'COMPLETED'::text, 'CANCELLED'::text])))
);


--
-- Name: TABLE pro_cpo_assignments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_cpo_assignments IS 'CPO ↔ Pro-member protection assignments (date-ranged, overlap-safe via gist exclusion; mission_code opens the CPO mission view). No payout — covered by the plan.';


--
-- Name: COLUMN pro_cpo_assignments.authorized_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pro_cpo_assignments.authorized_at IS 'First successful mission-code verification by the assigned CPO. Non-null = the CPO may restore this mission after reinstall/new device without re-entering the code. Idempotent: never re-stamped.';


--
-- Name: COLUMN pro_cpo_assignments.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pro_cpo_assignments.revoked_at IS 'When ops revoked/cancelled this assignment. Set alongside status=CANCELLED.';


--
-- Name: pro_plan_missions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_plan_missions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    mission_dates date[] NOT NULL,
    note text,
    status text DEFAULT 'REQUESTED'::text NOT NULL,
    assigned_team jsonb DEFAULT '[]'::jsonb NOT NULL,
    ops_note text,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pro_plan_missions_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'SCHEDULED'::text, 'DECLINED'::text, 'COMPLETED'::text])))
);


--
-- Name: TABLE pro_plan_missions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_plan_missions IS 'Multi-date protection requests inside an ACTIVE Bravo Secure Pro plan (no per-mission charge).';


--
-- Name: pro_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pro_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    version integer NOT NULL,
    proposal_number text NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    coverage_start date NOT NULL,
    coverage_end date NOT NULL,
    total_credits integer NOT NULL,
    included_services jsonb DEFAULT '[]'::jsonb NOT NULL,
    assigned_team jsonb DEFAULT '[]'::jsonb NOT NULL,
    terms text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pro_proposals_monthly_credits_check CHECK ((total_credits > 0))
);


--
-- Name: TABLE pro_proposals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pro_proposals IS 'Versioned Bravo Control System proposals for a Pro application (monthly BC price, services, team).';


--
-- Name: COLUMN pro_proposals.total_credits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pro_proposals.total_credits IS 'Total Bravo Credits for the WHOLE coverage period (coverage_start → coverage_end). Debited once at activation.';


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    credits integer NOT NULL,
    max_redemptions integer,
    redeemed_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_codes_credits_check CHECK ((credits > 0))
);

ALTER TABLE ONLY public.promo_codes FORCE ROW LEVEL SECURITY;


--
-- Name: promo_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_redemptions (
    promo_id uuid NOT NULL,
    user_id uuid NOT NULL,
    credits integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.promo_redemptions FORCE ROW LEVEL SECURITY;


--
-- Name: protection_access_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_access_audit (
    id bigint NOT NULL,
    actor_id uuid NOT NULL,
    actor_role text NOT NULL,
    session_id uuid NOT NULL,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.protection_access_audit FORCE ROW LEVEL SECURITY;


--
-- Name: protection_access_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.protection_access_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: protection_access_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.protection_access_audit_id_seq OWNED BY public.protection_access_audit.id;


--
-- Name: protection_session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_session_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint NOT NULL,
    session_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_id uuid,
    actor_role text NOT NULL,
    prev_status text,
    new_status text,
    comment text,
    visibility text DEFAULT 'all'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.protection_session_events FORCE ROW LEVEL SECURITY;


--
-- Name: protection_session_events_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.protection_session_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.protection_session_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: protection_session_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_session_locations (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    accuracy_m real,
    recorded_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    subject text DEFAULT 'customer'::text NOT NULL
);

ALTER TABLE ONLY public.protection_session_locations FORCE ROW LEVEL SECURITY;


--
-- Name: protection_session_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.protection_session_locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: protection_session_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.protection_session_locations_id_seq OWNED BY public.protection_session_locations.id;


--
-- Name: protection_session_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_session_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    sender text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.protection_session_notes FORCE ROW LEVEL SECURITY;


--
-- Name: protection_session_readiness; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_session_readiness (
    session_id uuid NOT NULL,
    role text NOT NULL,
    user_id uuid NOT NULL,
    location_permission boolean DEFAULT false NOT NULL,
    location_services boolean DEFAULT false NOT NULL,
    precise_location boolean DEFAULT false NOT NULL,
    connectivity boolean DEFAULT false NOT NULL,
    location_available boolean DEFAULT false NOT NULL,
    ready boolean GENERATED ALWAYS AS ((location_permission AND location_services AND precise_location AND connectivity AND location_available)) STORED,
    platform text,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT protection_session_readiness_role_check CHECK ((role = ANY (ARRAY['customer'::text, 'cpo'::text])))
);

ALTER TABLE ONLY public.protection_session_readiness FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE protection_session_readiness; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.protection_session_readiness IS 'Per-side device readiness for a protection session. Both rows must be ready before REQUESTED→ACTIVE. Reported by the apps, judged by the backend.';


--
-- Name: COLUMN protection_session_readiness.location_available; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.protection_session_readiness.location_available IS 'A real position was obtained. A rendered map does not count.';


--
-- Name: COLUMN protection_session_readiness.ready; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.protection_session_readiness.ready IS 'GENERATED — every requirement true. Never client-settable.';


--
-- Name: protection_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.protection_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    cpo_user_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    status text DEFAULT 'REQUESTED'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    ended_at timestamp with time zone,
    end_reason text,
    last_fix_at timestamp with time zone,
    sos_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    protect_activated_at timestamp with time zone,
    CONSTRAINT protection_sessions_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'ACTIVE'::text, 'ENDING'::text, 'COMPLETED'::text, 'ABORTED'::text])))
);

ALTER TABLE ONLY public.protection_sessions FORCE ROW LEVEL SECURITY;


--
-- Name: provider_invite_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_invite_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    org_user_id uuid NOT NULL,
    member_role text DEFAULT 'cpo'::text NOT NULL,
    call_sign text,
    expires_at timestamp with time zone,
    redeemed_by uuid,
    redeemed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_invite_codes_role CHECK ((member_role = ANY (ARRAY['cpo'::text, 'manager'::text])))
);

ALTER TABLE ONLY public.provider_invite_codes FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE provider_invite_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_invite_codes IS 'Single-use provider roster invitations (Issue 34). The provider mints the code; the officer redeems it to join that roster. Redemption is a conditional UPDATE, so a code can only ever be used once.';


--
-- Name: provider_referral_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_referral_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    owner_user_id uuid,
    partner_name text,
    purpose text,
    active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    redeemed_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_referral_codes_owner_or_partner CHECK (((owner_user_id IS NOT NULL) OR (partner_name IS NOT NULL)))
);

ALTER TABLE ONLY public.provider_referral_codes FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE provider_referral_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_referral_codes IS 'Partner / preferred-provider attribution codes (Issue 28). ATTRIBUTION ONLY — never read by dispatch ranking, the offer cascade or escrow.';


--
-- Name: sealed_envelope_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sealed_envelope_archive (
    recipient_user_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    outer_sealed bytea NOT NULL,
    ts_ms bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at_sec bigint
);

ALTER TABLE ONLY public.sealed_envelope_archive FORCE ROW LEVEL SECURITY;


--
-- Name: signal_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_identities (
    user_id uuid NOT NULL,
    registration_id integer NOT NULL,
    identity_key bytea NOT NULL,
    signed_prekey_id integer NOT NULL,
    signed_prekey bytea NOT NULL,
    signed_prekey_sig bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id smallint DEFAULT 1 NOT NULL
);

ALTER TABLE ONLY public.signal_identities FORCE ROW LEVEL SECURITY;


--
-- Name: signal_one_time_prekeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_one_time_prekeys (
    user_id uuid NOT NULL,
    key_id integer NOT NULL,
    public_key bytea NOT NULL,
    device_id smallint DEFAULT 1 NOT NULL
);

ALTER TABLE ONLY public.signal_one_time_prekeys FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE signal_one_time_prekeys; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.signal_one_time_prekeys IS 'Max 100 OPKs per user. Incremental append only — never wholesale replacement. Deleted on fetch (single-use). Server sends X-Pre-Key-Count header when pool < 10.';


--
-- Name: sos_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sos_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    booking_id uuid,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    location public.geography,
    status text DEFAULT 'active'::text NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    payload jsonb DEFAULT '{}'::jsonb,
    mission_id uuid,
    agent_id uuid,
    agent_call_sign text,
    reason text NOT NULL,
    lat double precision,
    lng double precision,
    acknowledged_at timestamp with time zone,
    acknowledged_by uuid,
    escalated_at timestamp with time zone,
    escalated_to text,
    resolution text,
    protection_session_id uuid,
    CONSTRAINT sos_events_status_check CHECK ((status = ANY (ARRAY['active'::text, 'acknowledged'::text, 'resolved'::text, 'false_alarm'::text])))
);

ALTER TABLE ONLY public.sos_events FORCE ROW LEVEL SECURITY;


--
-- Name: stripe_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_processed_events (
    event_id text NOT NULL,
    handler text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.stripe_processed_events FORCE ROW LEVEL SECURITY;


--
-- Name: subscription_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_prices (
    tier text NOT NULL,
    price_bc integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT subscription_prices_price_bc_check CHECK ((price_bc > 0)),
    CONSTRAINT subscription_prices_tier_check CHECK ((tier = ANY (ARRAY['pro'::text, 'enterprise'::text])))
);

ALTER TABLE ONLY public.subscription_prices FORCE ROW LEVEL SECURITY;


--
-- Name: system_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    kind public.system_broadcast_kind NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    subject_type text,
    subject_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.system_broadcasts FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    phone_e164 text,
    email public.citext,
    display_name text NOT NULL,
    role text DEFAULT 'individual'::text NOT NULL,
    subscription_tier text DEFAULT 'lite'::text NOT NULL,
    country_code text,
    kyc_status text DEFAULT 'none'::text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    password_hash text,
    bio text,
    last_seen_visible boolean DEFAULT true NOT NULL,
    read_receipts_enabled boolean DEFAULT true NOT NULL,
    pro_active_until timestamp with time zone,
    stripe_subscription_id text,
    pro_renew_status text,
    password_set_at timestamp with time zone,
    language text DEFAULT 'en'::text NOT NULL,
    currency text,
    notif_prefs jsonb DEFAULT '{"safety": true}'::jsonb NOT NULL,
    location_scope text DEFAULT 'while_on_duty'::text NOT NULL,
    app_lock boolean DEFAULT false NOT NULL,
    home_region text,
    suspended_at timestamp with time zone,
    suspended_reason text,
    suspended_by uuid,
    bc_auto_renew boolean DEFAULT false NOT NULL,
    CONSTRAINT users_currency_check CHECK (((currency IS NULL) OR (currency = ANY (ARRAY['AED'::text, 'SAR'::text, 'BDT'::text, 'GBP'::text])))),
    CONSTRAINT users_home_region_check CHECK (((home_region IS NULL) OR (home_region = ANY (ARRAY['AE'::text, 'SA'::text, 'BD'::text, 'GB'::text, 'ZA'::text, 'N/A'::text])))),
    CONSTRAINT users_kyc_status_check CHECK ((kyc_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT users_language_check CHECK ((language = ANY (ARRAY['en'::text, 'ar'::text, 'bn'::text]))),
    CONSTRAINT users_location_scope_check CHECK ((location_scope = ANY (ARRAY['while_on_duty'::text, 'during_mission'::text, 'never'::text]))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['individual'::text, 'agent'::text, 'service_provider'::text]))),
    CONSTRAINT users_subscription_tier_check CHECK ((subscription_tier = ANY (ARRAY['lite'::text, 'pro'::text, 'enterprise'::text])))
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_device_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_device_keys (
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    key_b64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.vbg_device_keys FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    phone_e164 text NOT NULL,
    "position" smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.vbg_favorites FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_geofences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_geofences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'safe'::text NOT NULL,
    area public.geography(Polygon,4326) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.vbg_geofences FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_monitoring; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_monitoring (
    user_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    interval_min integer DEFAULT 60 NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp with time zone,
    missed_count integer DEFAULT 0 NOT NULL,
    lat double precision,
    lng double precision,
    consecutive_fails integer DEFAULT 0 NOT NULL,
    last_zone_state text,
    escalated_at timestamp with time zone
);

ALTER TABLE ONLY public.vbg_monitoring FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_sra_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_sra_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lat double precision,
    lng double precision,
    risk_score integer NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    recommendations jsonb DEFAULT '[]'::jsonb NOT NULL,
    region text,
    context text,
    level text,
    summary text,
    counts jsonb
);

ALTER TABLE ONLY public.vbg_sra_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: vbg_telemetry_last; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vbg_telemetry_last (
    user_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    heading_deg double precision,
    speed_kph double precision,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.vbg_telemetry_last FORCE ROW LEVEL SECURITY;


--
-- Name: vehicle_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_pool (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    call_sign text NOT NULL,
    make_model text NOT NULL,
    plate text NOT NULL,
    region_code text DEFAULT 'AE'::text NOT NULL,
    armored boolean DEFAULT true NOT NULL,
    armor_grade text,
    capacity integer DEFAULT 4 NOT NULL,
    status public.vehicle_status DEFAULT 'available'::public.vehicle_status NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    colour text
);

ALTER TABLE ONLY public.vehicle_pool FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN vehicle_pool.colour; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vehicle_pool.colour IS 'Vehicle colour shown to the client for kerbside identification, e.g. "Black" (Issue 30). NULL = not recorded; the client card omits it rather than guessing.';


--
-- Name: wallet_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_balances (
    user_id uuid NOT NULL,
    bravo_credits integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'AED'::text NOT NULL,
    stripe_customer_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_balances_nonnegative CHECK (((bravo_credits >= 0) OR (user_id = ANY (ARRAY['00000000-0000-0000-0000-0000000000e5'::uuid, '00000000-0000-0000-0000-0000000000fe'::uuid]))))
);

ALTER TABLE ONLY public.wallet_balances FORCE ROW LEVEL SECURITY;


--
-- Name: wallet_credit_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_credit_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_tx_id uuid,
    amount_credits integer NOT NULL,
    consumed_credits integer DEFAULT 0 NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    expired_at timestamp with time zone,
    CONSTRAINT wallet_credit_batches_amount_credits_check CHECK ((amount_credits > 0)),
    CONSTRAINT wallet_credit_batches_check CHECK ((consumed_credits <= amount_credits)),
    CONSTRAINT wallet_credit_batches_consumed_credits_check CHECK ((consumed_credits >= 0))
);

ALTER TABLE ONLY public.wallet_credit_batches FORCE ROW LEVEL SECURITY;


--
-- Name: wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    booking_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type public.wallet_tx_type NOT NULL,
    status public.wallet_tx_status DEFAULT 'pending'::public.wallet_tx_status NOT NULL,
    amount_credits integer DEFAULT 0 NOT NULL,
    amount_fiat_cents integer DEFAULT 0 NOT NULL,
    fiat_currency text DEFAULT 'usd'::text NOT NULL,
    description text,
    stripe_intent_id text,
    stripe_client_secret text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    settled_at timestamp with time zone,
    actor_user_id uuid,
    feature text
);

ALTER TABLE ONLY public.wallet_transactions FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN wallet_transactions.actor_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.actor_user_id IS 'Who TRIGGERED the movement (family member on an owner-paid booking); user_id stays the wallet owner/payer.';


--
-- Name: COLUMN wallet_transactions.feature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wallet_transactions.feature IS 'Spend category: booking | secure_pro_plan | messenger_plan | … (free text, UI maps to labels).';


--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text,
    type storage.buckettype DEFAULT 'STANDARD'::storage.buckettype NOT NULL
);


--
-- Name: COLUMN buckets.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: buckets_analytics; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets_analytics (
    name text NOT NULL,
    type storage.buckettype DEFAULT 'ANALYTICS'::storage.buckettype NOT NULL,
    format text DEFAULT 'ICEBERG'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: buckets_vectors; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets_vectors (
    id text NOT NULL,
    type storage.buckettype DEFAULT 'VECTOR'::storage.buckettype NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: iceberg_namespaces; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.iceberg_namespaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_name text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    catalog_id uuid NOT NULL
);


--
-- Name: iceberg_tables; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.iceberg_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    namespace_id uuid NOT NULL,
    bucket_name text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    location text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    remote_table_id text,
    shard_key text,
    shard_id text,
    catalog_id uuid NOT NULL
);


--
-- Name: migrations; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.migrations (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    hash character varying(40) NOT NULL,
    executed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: objects; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/'::text)) STORED,
    version text,
    owner_id text,
    user_metadata jsonb
);


--
-- Name: COLUMN objects.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: s3_multipart_uploads; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads (
    id text NOT NULL,
    in_progress_size bigint DEFAULT 0 NOT NULL,
    upload_signature text NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    version text NOT NULL,
    owner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_metadata jsonb,
    metadata jsonb
);


--
-- Name: s3_multipart_uploads_parts; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    part_number integer NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    etag text NOT NULL,
    owner_id text,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vector_indexes; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.vector_indexes (
    id text DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    bucket_id text NOT NULL,
    data_type text NOT NULL,
    dimension integer NOT NULL,
    distance_metric text NOT NULL,
    metadata_configuration jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: hooks; Type: TABLE; Schema: supabase_functions; Owner: -
--

CREATE TABLE supabase_functions.hooks (
    id bigint NOT NULL,
    hook_table_id integer NOT NULL,
    hook_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id bigint
);


--
-- Name: TABLE hooks; Type: COMMENT; Schema: supabase_functions; Owner: -
--

COMMENT ON TABLE supabase_functions.hooks IS 'Supabase Functions Hooks: Audit trail for triggered hooks.';


--
-- Name: hooks_id_seq; Type: SEQUENCE; Schema: supabase_functions; Owner: -
--

CREATE SEQUENCE supabase_functions.hooks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hooks_id_seq; Type: SEQUENCE OWNED BY; Schema: supabase_functions; Owner: -
--

ALTER SEQUENCE supabase_functions.hooks_id_seq OWNED BY supabase_functions.hooks.id;


--
-- Name: migrations; Type: TABLE; Schema: supabase_functions; Owner: -
--

CREATE TABLE supabase_functions.migrations (
    version text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: supabase_migrations; Owner: -
--

CREATE TABLE supabase_migrations.schema_migrations (
    version text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now()
);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: agent_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_audit ALTER COLUMN id SET DEFAULT nextval('public.agent_audit_id_seq'::regclass);


--
-- Name: lite_booking_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_booking_audit ALTER COLUMN id SET DEFAULT nextval('public.lite_booking_audit_id_seq'::regclass);


--
-- Name: live_feed_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_feed_events ALTER COLUMN id SET DEFAULT nextval('public.live_feed_events_id_seq'::regclass);


--
-- Name: mission_telemetry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_telemetry ALTER COLUMN id SET DEFAULT nextval('public.mission_telemetry_id_seq'::regclass);


--
-- Name: mission_waypoints id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_waypoints ALTER COLUMN id SET DEFAULT nextval('public.mission_waypoints_id_seq'::regclass);


--
-- Name: ops_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_audit ALTER COLUMN id SET DEFAULT nextval('public.ops_audit_id_seq'::regclass);


--
-- Name: protection_access_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_access_audit ALTER COLUMN id SET DEFAULT nextval('public.protection_access_audit_id_seq'::regclass);


--
-- Name: protection_session_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_locations ALTER COLUMN id SET DEFAULT nextval('public.protection_session_locations_id_seq'::regclass);


--
-- Name: hooks id; Type: DEFAULT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.hooks ALTER COLUMN id SET DEFAULT nextval('supabase_functions.hooks_id_seq'::regclass);


--
-- Name: mfa_amr_claims amr_id_pk; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT amr_id_pk PRIMARY KEY (id);


--
-- Name: audit_log_entries audit_log_entries_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id);


--
-- Name: custom_oauth_providers custom_oauth_providers_identifier_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_identifier_key UNIQUE (identifier);


--
-- Name: custom_oauth_providers custom_oauth_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.custom_oauth_providers
    ADD CONSTRAINT custom_oauth_providers_pkey PRIMARY KEY (id);


--
-- Name: flow_state flow_state_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.flow_state
    ADD CONSTRAINT flow_state_pkey PRIMARY KEY (id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_provider_id_provider_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: mfa_factors mfa_factors_last_challenged_at_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_last_challenged_at_key UNIQUE (last_challenged_at);


--
-- Name: mfa_factors mfa_factors_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_pkey PRIMARY KEY (id);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_code_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_code_key UNIQUE (authorization_code);


--
-- Name: oauth_authorizations oauth_authorizations_authorization_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_authorization_id_key UNIQUE (authorization_id);


--
-- Name: oauth_authorizations oauth_authorizations_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_pkey PRIMARY KEY (id);


--
-- Name: oauth_client_states oauth_client_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_client_states
    ADD CONSTRAINT oauth_client_states_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_user_client_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_client_unique UNIQUE (user_id, client_id);


--
-- Name: one_time_tokens one_time_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: saml_providers saml_providers_entity_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_entity_id_key UNIQUE (entity_id);


--
-- Name: saml_providers saml_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_pkey PRIMARY KEY (id);


--
-- Name: saml_relay_states saml_relay_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: admin_invites admin_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_pkey PRIMARY KEY (id);


--
-- Name: admin_invites admin_invites_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_token_hash_key UNIQUE (token_hash);


--
-- Name: admin_users admin_users_call_sign_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_call_sign_key UNIQUE (call_sign);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (user_id);


--
-- Name: agent_audit agent_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_audit
    ADD CONSTRAINT agent_audit_pkey PRIMARY KEY (id);


--
-- Name: agent_deployment_checks agent_deployment_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_deployment_checks
    ADD CONSTRAINT agent_deployment_checks_pkey PRIMARY KEY (user_id, check_key);


--
-- Name: agent_documents agent_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents
    ADD CONSTRAINT agent_documents_pkey PRIMARY KEY (id);


--
-- Name: agent_documents agent_documents_user_id_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents
    ADD CONSTRAINT agent_documents_user_id_slot_key UNIQUE (user_id, slot);


--
-- Name: agent_kyc_checks agent_kyc_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_kyc_checks
    ADD CONSTRAINT agent_kyc_checks_pkey PRIMARY KEY (user_id, kind);


--
-- Name: agent_profiles agent_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: agent_review_pipeline agent_review_pipeline_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_review_pipeline
    ADD CONSTRAINT agent_review_pipeline_pkey PRIMARY KEY (user_id, step);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (user_id);


--
-- Name: armed_authorizations armed_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.armed_authorizations
    ADD CONSTRAINT armed_authorizations_pkey PRIMARY KEY (id);


--
-- Name: attendance_corrections attendance_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_corrections
    ADD CONSTRAINT attendance_corrections_pkey PRIMARY KEY (id);


--
-- Name: auth_devices auth_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_devices
    ADD CONSTRAINT auth_devices_pkey PRIMARY KEY (id);


--
-- Name: auth_devices auth_devices_user_id_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_devices
    ADD CONSTRAINT auth_devices_user_id_device_id_key UNIQUE (user_id, device_id);


--
-- Name: auth_devices auth_devices_user_signaldev_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_devices
    ADD CONSTRAINT auth_devices_user_signaldev_uniq UNIQUE (user_id, signal_device_id);


--
-- Name: auth_otps auth_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_otps
    ADD CONSTRAINT auth_otps_pkey PRIMARY KEY (id);


--
-- Name: auth_totp_backup_codes auth_totp_backup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_backup_codes
    ADD CONSTRAINT auth_totp_backup_codes_pkey PRIMARY KEY (id);


--
-- Name: auth_totp_secrets auth_totp_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_secrets
    ADD CONSTRAINT auth_totp_secrets_pkey PRIMARY KEY (user_id);


--
-- Name: backup_merkle_commits backup_merkle_commits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_merkle_commits
    ADD CONSTRAINT backup_merkle_commits_pkey PRIMARY KEY (user_id);


--
-- Name: backup_session_snapshots backup_session_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_session_snapshots
    ADD CONSTRAINT backup_session_snapshots_pkey PRIMARY KEY (user_id);


--
-- Name: blocked_users blocked_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_pkey PRIMARY KEY (blocker_user_id, blocked_user_id);


--
-- Name: booking_cpo_assignments booking_cpo_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_cpo_assignments
    ADD CONSTRAINT booking_cpo_assignments_pkey PRIMARY KEY (booking_id, cpo_id);


--
-- Name: booking_disputes booking_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_disputes
    ADD CONSTRAINT booking_disputes_pkey PRIMARY KEY (id);


--
-- Name: channel_membership_intents channel_membership_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_membership_intents
    ADD CONSTRAINT channel_membership_intents_pkey PRIMARY KEY (id);


--
-- Name: compliance_credentials compliance_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_credentials
    ADD CONSTRAINT compliance_credentials_pkey PRIMARY KEY (id);


--
-- Name: conversation_backups conversation_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_backups
    ADD CONSTRAINT conversation_backups_pkey PRIMARY KEY (owner_user_id, conversation_id);


--
-- Name: conversation_members conversation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (conversation_id, user_id);


--
-- Name: conversation_membership_intents conversation_membership_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_membership_intents
    ADD CONSTRAINT conversation_membership_intents_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: cpo_pool cpo_pool_call_sign_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_pool
    ADD CONSTRAINT cpo_pool_call_sign_key UNIQUE (call_sign);


--
-- Name: cpo_pool cpo_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_pool
    ADD CONSTRAINT cpo_pool_pkey PRIMARY KEY (id);


--
-- Name: cpo_roster_months cpo_roster_months_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_roster_months
    ADD CONSTRAINT cpo_roster_months_pkey PRIMARY KEY (id);


--
-- Name: cpo_shift_assignments cpo_shift_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_assignments
    ADD CONSTRAINT cpo_shift_assignments_pkey PRIMARY KEY (shift_id, cpo_user_id);


--
-- Name: cpo_shift_sessions cpo_shift_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_pkey PRIMARY KEY (id);


--
-- Name: cpo_shifts cpo_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shifts
    ADD CONSTRAINT cpo_shifts_pkey PRIMARY KEY (id);


--
-- Name: department_channel_members department_channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channel_members
    ADD CONSTRAINT department_channel_members_pkey PRIMARY KEY (id);


--
-- Name: department_channels department_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channels
    ADD CONSTRAINT department_channels_pkey PRIMARY KEY (id);


--
-- Name: dispatch_offers dispatch_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_offers
    ADD CONSTRAINT dispatch_offers_pkey PRIMARY KEY (id);


--
-- Name: dispatch_room_crypto_claims dispatch_room_crypto_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_crypto_claims
    ADD CONSTRAINT dispatch_room_crypto_claims_pkey PRIMARY KEY (conversation_id);


--
-- Name: dispatch_room_intents dispatch_room_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_intents
    ADD CONSTRAINT dispatch_room_intents_pkey PRIMARY KEY (id);


--
-- Name: enterprise_join_requests enterprise_join_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_pkey PRIMARY KEY (id);


--
-- Name: enterprise_referral_links enterprise_referral_links_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_code_key UNIQUE (code);


--
-- Name: enterprise_referral_links enterprise_referral_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_pkey PRIMARY KEY (id);


--
-- Name: escrow_holds escrow_holds_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escrow_holds
    ADD CONSTRAINT escrow_holds_booking_id_key UNIQUE (booking_id);


--
-- Name: escrow_holds escrow_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escrow_holds
    ADD CONSTRAINT escrow_holds_pkey PRIMARY KEY (id);


--
-- Name: family_member_locations family_member_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_member_locations
    ADD CONSTRAINT family_member_locations_pkey PRIMARY KEY (user_id);


--
-- Name: family_members family_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_pkey PRIMARY KEY (id);


--
-- Name: identity_backups identity_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_backups
    ADD CONSTRAINT identity_backups_pkey PRIMARY KEY (user_id);


--
-- Name: incident_attachment_keys incident_attachment_keys_attachment_id_recipient_user_id_de_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachment_keys
    ADD CONSTRAINT incident_attachment_keys_attachment_id_recipient_user_id_de_key UNIQUE (attachment_id, recipient_user_id, device_id);


--
-- Name: incident_attachment_keys incident_attachment_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachment_keys
    ADD CONSTRAINT incident_attachment_keys_pkey PRIMARY KEY (id);


--
-- Name: incident_attachments incident_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachments
    ADD CONSTRAINT incident_attachments_pkey PRIMARY KEY (id);


--
-- Name: incident_events incident_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_events
    ADD CONSTRAINT incident_events_pkey PRIMARY KEY (id);


--
-- Name: incident_reports incident_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_pkey PRIMARY KEY (id);


--
-- Name: incident_reports incident_reports_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_ref_key UNIQUE (ref);


--
-- Name: invoice_sequences invoice_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_sequences
    ADD CONSTRAINT invoice_sequences_pkey PRIMARY KEY (region_code);


--
-- Name: invoices invoices_booking_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_booking_id_kind_key UNIQUE (booking_id, kind);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: job_applications job_applications_job_id_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_job_id_agent_id_key UNIQUE (job_id, agent_id);


--
-- Name: job_applications job_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_booking_id_key UNIQUE (booking_id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_short_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_short_code_key UNIQUE (short_code);


--
-- Name: lite_booking_add_ons lite_booking_add_ons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_booking_add_ons
    ADD CONSTRAINT lite_booking_add_ons_pkey PRIMARY KEY (id);


--
-- Name: lite_booking_audit lite_booking_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_booking_audit
    ADD CONSTRAINT lite_booking_audit_pkey PRIMARY KEY (id);


--
-- Name: lite_bookings lite_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_bookings
    ADD CONSTRAINT lite_bookings_pkey PRIMARY KEY (id);


--
-- Name: live_feed_events live_feed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_feed_events
    ADD CONSTRAINT live_feed_events_pkey PRIMARY KEY (id);


--
-- Name: messages_backup messages_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_backup
    ADD CONSTRAINT messages_backup_pkey PRIMARY KEY (owner_user_id, message_id);


--
-- Name: mission_crew mission_crew_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_crew
    ADD CONSTRAINT mission_crew_pkey PRIMARY KEY (mission_id, agent_id);


--
-- Name: mission_hourly_checkins mission_hourly_checkins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_hourly_checkins
    ADD CONSTRAINT mission_hourly_checkins_pkey PRIMARY KEY (id);


--
-- Name: mission_hourly_checkins mission_hourly_checkins_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_hourly_checkins
    ADD CONSTRAINT mission_hourly_checkins_uq UNIQUE (mission_id, hour_index);


--
-- Name: mission_payouts mission_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_payouts
    ADD CONSTRAINT mission_payouts_pkey PRIMARY KEY (id);


--
-- Name: mission_principals mission_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_principals
    ADD CONSTRAINT mission_principals_pkey PRIMARY KEY (id);


--
-- Name: mission_telemetry_last mission_telemetry_last_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_telemetry_last
    ADD CONSTRAINT mission_telemetry_last_pkey PRIMARY KEY (booking_id);


--
-- Name: mission_telemetry mission_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_telemetry
    ADD CONSTRAINT mission_telemetry_pkey PRIMARY KEY (id);


--
-- Name: mission_waypoints mission_waypoints_mission_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_waypoints
    ADD CONSTRAINT mission_waypoints_mission_id_seq_key UNIQUE (mission_id, seq);


--
-- Name: mission_waypoints mission_waypoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_waypoints
    ADD CONSTRAINT mission_waypoints_pkey PRIMARY KEY (id);


--
-- Name: missions missions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: ops_audit ops_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_audit
    ADD CONSTRAINT ops_audit_pkey PRIMARY KEY (id);


--
-- Name: org_audit_log org_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_audit_log
    ADD CONSTRAINT org_audit_log_pkey PRIMARY KEY (id);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (org_user_id, member_user_id);


--
-- Name: org_workspace_settings org_workspace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_workspace_settings
    ADD CONSTRAINT org_workspace_settings_pkey PRIMARY KEY (org_user_id);


--
-- Name: org_workspaces org_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_workspaces
    ADD CONSTRAINT org_workspaces_pkey PRIMARY KEY (owner_user_id);


--
-- Name: pro_application_events pro_application_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_application_events
    ADD CONSTRAINT pro_application_events_pkey PRIMARY KEY (id);


--
-- Name: pro_application_messages pro_application_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_application_messages
    ADD CONSTRAINT pro_application_messages_pkey PRIMARY KEY (id);


--
-- Name: pro_applications pro_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_applications
    ADD CONSTRAINT pro_applications_pkey PRIMARY KEY (id);


--
-- Name: pro_cpo_assignments pro_cpo_assignments_mission_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_cpo_assignments
    ADD CONSTRAINT pro_cpo_assignments_mission_code_key UNIQUE (mission_code);


--
-- Name: pro_cpo_assignments pro_cpo_assignments_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_cpo_assignments
    ADD CONSTRAINT pro_cpo_assignments_no_overlap EXCLUDE USING gist (cpo_user_id WITH =, daterange(starts_on, ends_on, '[]'::text) WITH &&) WHERE ((status = 'ASSIGNED'::text));


--
-- Name: pro_cpo_assignments pro_cpo_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_cpo_assignments
    ADD CONSTRAINT pro_cpo_assignments_pkey PRIMARY KEY (id);


--
-- Name: pro_plan_missions pro_plan_missions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_plan_missions
    ADD CONSTRAINT pro_plan_missions_pkey PRIMARY KEY (id);


--
-- Name: pro_proposals pro_proposals_application_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_proposals
    ADD CONSTRAINT pro_proposals_application_id_version_key UNIQUE (application_id, version);


--
-- Name: pro_proposals pro_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_proposals
    ADD CONSTRAINT pro_proposals_pkey PRIMARY KEY (id);


--
-- Name: promo_codes promo_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_code_key UNIQUE (code);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);


--
-- Name: promo_redemptions promo_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_pkey PRIMARY KEY (promo_id, user_id);


--
-- Name: protection_access_audit protection_access_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_access_audit
    ADD CONSTRAINT protection_access_audit_pkey PRIMARY KEY (id);


--
-- Name: protection_session_events protection_session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_events
    ADD CONSTRAINT protection_session_events_pkey PRIMARY KEY (id);


--
-- Name: protection_session_locations protection_session_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_locations
    ADD CONSTRAINT protection_session_locations_pkey PRIMARY KEY (id);


--
-- Name: protection_session_notes protection_session_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_notes
    ADD CONSTRAINT protection_session_notes_pkey PRIMARY KEY (id);


--
-- Name: protection_session_readiness protection_session_readiness_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_readiness
    ADD CONSTRAINT protection_session_readiness_pkey PRIMARY KEY (session_id, role);


--
-- Name: protection_sessions protection_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_sessions
    ADD CONSTRAINT protection_sessions_pkey PRIMARY KEY (id);


--
-- Name: provider_invite_codes provider_invite_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_invite_codes
    ADD CONSTRAINT provider_invite_codes_code_key UNIQUE (code);


--
-- Name: provider_invite_codes provider_invite_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_invite_codes
    ADD CONSTRAINT provider_invite_codes_pkey PRIMARY KEY (id);


--
-- Name: provider_referral_codes provider_referral_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_referral_codes
    ADD CONSTRAINT provider_referral_codes_code_key UNIQUE (code);


--
-- Name: provider_referral_codes provider_referral_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_referral_codes
    ADD CONSTRAINT provider_referral_codes_pkey PRIMARY KEY (id);


--
-- Name: sealed_envelope_archive sealed_envelope_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sealed_envelope_archive
    ADD CONSTRAINT sealed_envelope_archive_pkey PRIMARY KEY (recipient_user_id, envelope_id);


--
-- Name: signal_identities signal_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_identities
    ADD CONSTRAINT signal_identities_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: signal_one_time_prekeys signal_one_time_prekeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_one_time_prekeys
    ADD CONSTRAINT signal_one_time_prekeys_pkey PRIMARY KEY (user_id, device_id, key_id);


--
-- Name: sos_events sos_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_events
    ADD CONSTRAINT sos_events_pkey PRIMARY KEY (id);


--
-- Name: stripe_processed_events stripe_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_processed_events
    ADD CONSTRAINT stripe_processed_events_pkey PRIMARY KEY (event_id, handler);


--
-- Name: subscription_prices subscription_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_prices
    ADD CONSTRAINT subscription_prices_pkey PRIMARY KEY (tier);


--
-- Name: system_broadcasts system_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_broadcasts
    ADD CONSTRAINT system_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_e164_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_e164_key UNIQUE (phone_e164);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vbg_device_keys vbg_device_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_device_keys
    ADD CONSTRAINT vbg_device_keys_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: vbg_favorites vbg_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_favorites
    ADD CONSTRAINT vbg_favorites_pkey PRIMARY KEY (id);


--
-- Name: vbg_favorites vbg_favorites_user_phone_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_favorites
    ADD CONSTRAINT vbg_favorites_user_phone_uniq UNIQUE (user_id, phone_e164);


--
-- Name: vbg_geofences vbg_geofences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_geofences
    ADD CONSTRAINT vbg_geofences_pkey PRIMARY KEY (id);


--
-- Name: vbg_monitoring vbg_monitoring_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_monitoring
    ADD CONSTRAINT vbg_monitoring_pkey PRIMARY KEY (user_id);


--
-- Name: vbg_sra_snapshots vbg_sra_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_sra_snapshots
    ADD CONSTRAINT vbg_sra_snapshots_pkey PRIMARY KEY (id);


--
-- Name: vbg_telemetry_last vbg_telemetry_last_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_telemetry_last
    ADD CONSTRAINT vbg_telemetry_last_pkey PRIMARY KEY (user_id);


--
-- Name: vehicle_pool vehicle_pool_call_sign_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_pool
    ADD CONSTRAINT vehicle_pool_call_sign_key UNIQUE (call_sign);


--
-- Name: vehicle_pool vehicle_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_pool
    ADD CONSTRAINT vehicle_pool_pkey PRIMARY KEY (id);


--
-- Name: wallet_balances wallet_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_balances
    ADD CONSTRAINT wallet_balances_pkey PRIMARY KEY (user_id);


--
-- Name: wallet_credit_batches wallet_credit_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_credit_batches
    ADD CONSTRAINT wallet_credit_batches_pkey PRIMARY KEY (id);


--
-- Name: wallet_transactions wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: buckets_analytics buckets_analytics_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets_analytics
    ADD CONSTRAINT buckets_analytics_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: buckets_vectors buckets_vectors_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets_vectors
    ADD CONSTRAINT buckets_vectors_pkey PRIMARY KEY (id);


--
-- Name: iceberg_namespaces iceberg_namespaces_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.iceberg_namespaces
    ADD CONSTRAINT iceberg_namespaces_pkey PRIMARY KEY (id);


--
-- Name: iceberg_tables iceberg_tables_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_name_key; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_name_key UNIQUE (name);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_pkey PRIMARY KEY (id);


--
-- Name: vector_indexes vector_indexes_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.vector_indexes
    ADD CONSTRAINT vector_indexes_pkey PRIMARY KEY (id);


--
-- Name: hooks hooks_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.hooks
    ADD CONSTRAINT hooks_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: supabase_functions; Owner: -
--

ALTER TABLE ONLY supabase_functions.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (version);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: supabase_migrations; Owner: -
--

ALTER TABLE ONLY supabase_migrations.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: audit_logs_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: custom_oauth_providers_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX custom_oauth_providers_created_at_idx ON auth.custom_oauth_providers USING btree (created_at);


--
-- Name: custom_oauth_providers_enabled_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX custom_oauth_providers_enabled_idx ON auth.custom_oauth_providers USING btree (enabled);


--
-- Name: custom_oauth_providers_identifier_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX custom_oauth_providers_identifier_idx ON auth.custom_oauth_providers USING btree (identifier);


--
-- Name: custom_oauth_providers_provider_type_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX custom_oauth_providers_provider_type_idx ON auth.custom_oauth_providers USING btree (provider_type);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: factor_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors USING btree (user_id, created_at);


--
-- Name: flow_state_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX flow_state_created_at_idx ON auth.flow_state USING btree (created_at DESC);


--
-- Name: identities_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_email_idx ON auth.identities USING btree (email text_pattern_ops);


--
-- Name: INDEX identities_email_idx; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.identities_email_idx IS 'Auth: Ensures indexed queries on the email column';


--
-- Name: identities_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_user_id_idx ON auth.identities USING btree (user_id);


--
-- Name: idx_auth_code; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_auth_code ON auth.flow_state USING btree (auth_code);


--
-- Name: idx_oauth_client_states_created_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_oauth_client_states_created_at ON auth.oauth_client_states USING btree (created_at);


--
-- Name: idx_user_id_auth_method; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_user_id_auth_method ON auth.flow_state USING btree (user_id, authentication_method);


--
-- Name: mfa_challenge_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges USING btree (created_at DESC);


--
-- Name: mfa_factors_user_friendly_name_unique; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX mfa_factors_user_friendly_name_unique ON auth.mfa_factors USING btree (friendly_name, user_id) WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);


--
-- Name: mfa_factors_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors USING btree (user_id);


--
-- Name: oauth_auth_pending_exp_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX oauth_auth_pending_exp_idx ON auth.oauth_authorizations USING btree (expires_at) WHERE (status = 'pending'::auth.oauth_authorization_status);


--
-- Name: oauth_clients_deleted_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX oauth_clients_deleted_at_idx ON auth.oauth_clients USING btree (deleted_at);


--
-- Name: oauth_consents_active_client_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX oauth_consents_active_client_idx ON auth.oauth_consents USING btree (client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_active_user_client_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX oauth_consents_active_user_client_idx ON auth.oauth_consents USING btree (user_id, client_id) WHERE (revoked_at IS NULL);


--
-- Name: oauth_consents_user_order_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX oauth_consents_user_order_idx ON auth.oauth_consents USING btree (user_id, granted_at DESC);


--
-- Name: one_time_tokens_relates_to_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);


--
-- Name: one_time_tokens_token_hash_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);


--
-- Name: one_time_tokens_user_id_token_type_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX one_time_tokens_user_id_token_type_key ON auth.one_time_tokens USING btree (user_id, token_type);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: refresh_tokens_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);


--
-- Name: refresh_tokens_instance_id_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);


--
-- Name: refresh_tokens_parent_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);


--
-- Name: refresh_tokens_session_id_revoked_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens USING btree (session_id, revoked);


--
-- Name: refresh_tokens_updated_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_updated_at_idx ON auth.refresh_tokens USING btree (updated_at DESC);


--
-- Name: saml_providers_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_providers_sso_provider_id_idx ON auth.saml_providers USING btree (sso_provider_id);


--
-- Name: saml_relay_states_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_created_at_idx ON auth.saml_relay_states USING btree (created_at DESC);


--
-- Name: saml_relay_states_for_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_for_email_idx ON auth.saml_relay_states USING btree (for_email);


--
-- Name: saml_relay_states_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states USING btree (sso_provider_id);


--
-- Name: sessions_not_after_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);


--
-- Name: sessions_oauth_client_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_oauth_client_id_idx ON auth.sessions USING btree (oauth_client_id);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);


--
-- Name: sso_domains_domain_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_domains_domain_idx ON auth.sso_domains USING btree (lower(domain));


--
-- Name: sso_domains_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sso_domains_sso_provider_id_idx ON auth.sso_domains USING btree (sso_provider_id);


--
-- Name: sso_providers_resource_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_providers_resource_id_idx ON auth.sso_providers USING btree (lower(resource_id));


--
-- Name: sso_providers_resource_id_pattern_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sso_providers_resource_id_pattern_idx ON auth.sso_providers USING btree (resource_id text_pattern_ops);


--
-- Name: unique_phone_factor_per_user; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX unique_phone_factor_per_user ON auth.mfa_factors USING btree (user_id, phone);


--
-- Name: user_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: webauthn_challenges_expires_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX webauthn_challenges_expires_at_idx ON auth.webauthn_challenges USING btree (expires_at);


--
-- Name: webauthn_challenges_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX webauthn_challenges_user_id_idx ON auth.webauthn_challenges USING btree (user_id);


--
-- Name: webauthn_credentials_credential_id_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON auth.webauthn_credentials USING btree (credential_id);


--
-- Name: webauthn_credentials_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX webauthn_credentials_user_id_idx ON auth.webauthn_credentials USING btree (user_id);


--
-- Name: admin_invites_pending_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_invites_pending_email_idx ON public.admin_invites USING btree (lower(email)) WHERE ((redeemed_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: admin_invites_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_invites_recent_idx ON public.admin_invites USING btree (created_at DESC);


--
-- Name: admin_users_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_users_phone_idx ON public.admin_users USING btree (phone_e164) WHERE (phone_e164 IS NOT NULL);


--
-- Name: admin_users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_users_role_idx ON public.admin_users USING btree (role) WHERE (active = true);


--
-- Name: agent_audit_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_audit_user_idx ON public.agent_audit USING btree (user_id, created_at DESC);


--
-- Name: agent_documents_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_documents_expiry_idx ON public.agent_documents USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: agents_dispatch_pool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_dispatch_pool ON public.agents USING btree (status, on_duty, type) WHERE (type = 'company'::public.agent_type);


--
-- Name: agents_last_location_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_last_location_gix ON public.agents USING gist (last_location);


--
-- Name: agents_managed_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_managed_by_idx ON public.agents USING btree (managed_by_org_id) WHERE (managed_by_org_id IS NOT NULL);


--
-- Name: agents_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_status_idx ON public.agents USING btree (status);


--
-- Name: armed_auth_cpo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX armed_auth_cpo_idx ON public.armed_authorizations USING btree (cpo_user_id, region_code);


--
-- Name: attendance_corrections_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attendance_corrections_org_idx ON public.attendance_corrections USING btree (org_user_id, corrected_at DESC);


--
-- Name: attendance_corrections_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attendance_corrections_session_idx ON public.attendance_corrections USING btree (session_id, corrected_at DESC);


--
-- Name: auth_devices_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_devices_hash_idx ON public.auth_devices USING btree (refresh_token_hash);


--
-- Name: auth_devices_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_devices_user_idx ON public.auth_devices USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: auth_otps_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_otps_user_idx ON public.auth_otps USING btree (user_id, created_at DESC);


--
-- Name: auth_totp_backup_codes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_totp_backup_codes_user_idx ON public.auth_totp_backup_codes USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: blocked_users_blocked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blocked_users_blocked_idx ON public.blocked_users USING btree (blocked_user_id);


--
-- Name: booking_cpo_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_cpo_booking_idx ON public.booking_cpo_assignments USING btree (booking_id);


--
-- Name: booking_disputes_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_disputes_one_open ON public.booking_disputes USING btree (booking_id) WHERE (status = 'open'::text);


--
-- Name: channel_membership_intents_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_membership_intents_pending_idx ON public.channel_membership_intents USING btree (channel_id, created_at) WHERE (state = 'pending'::text);


--
-- Name: compliance_one_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX compliance_one_verified ON public.compliance_credentials USING btree (subject_user_id, kind, region_code) WHERE verified;


--
-- Name: compliance_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX compliance_subject_idx ON public.compliance_credentials USING btree (subject_user_id, kind, region_code, expires_at);


--
-- Name: conversation_backups_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_backups_owner_idx ON public.conversation_backups USING btree (owner_user_id, last_message_at DESC NULLS LAST);


--
-- Name: conversation_membership_intents_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_membership_intents_pending_idx ON public.conversation_membership_intents USING btree (conversation_id, created_at) WHERE (state = 'pending'::text);


--
-- Name: conversations_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_active_idx ON public.conversations USING btree (kind, created_at DESC) WHERE (archived_at IS NULL);


--
-- Name: cpo_pool_region_avail_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_pool_region_avail_idx ON public.cpo_pool USING btree (region_code, availability) WHERE (active = true);


--
-- Name: cpo_roster_months_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_roster_months_org_idx ON public.cpo_roster_months USING btree (org_user_id, month DESC);


--
-- Name: cpo_roster_months_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cpo_roster_months_unique ON public.cpo_roster_months USING btree (org_user_id, COALESCE(department, ''::text), month);


--
-- Name: cpo_shift_assign_cpo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shift_assign_cpo_idx ON public.cpo_shift_assignments USING btree (cpo_user_id);


--
-- Name: cpo_shift_sessions_cpo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shift_sessions_cpo_idx ON public.cpo_shift_sessions USING btree (cpo_user_id, clock_in_at DESC);


--
-- Name: cpo_shift_sessions_open_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cpo_shift_sessions_open_unique ON public.cpo_shift_sessions USING btree (cpo_user_id) WHERE (status = 'open'::text);


--
-- Name: cpo_shift_sessions_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shift_sessions_org_idx ON public.cpo_shift_sessions USING btree (org_user_id, clock_in_at DESC);


--
-- Name: cpo_shift_sessions_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shift_sessions_review_idx ON public.cpo_shift_sessions USING btree (org_user_id) WHERE (review_status = 'pending'::text);


--
-- Name: cpo_shifts_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shifts_org_idx ON public.cpo_shifts USING btree (org_user_id, start_at DESC) WHERE (archived_at IS NULL);


--
-- Name: cpo_shifts_recurrence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shifts_recurrence_idx ON public.cpo_shifts USING btree (org_user_id, recurrence_group_id) WHERE (recurrence_group_id IS NOT NULL);


--
-- Name: cpo_shifts_roster_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cpo_shifts_roster_month_idx ON public.cpo_shifts USING btree (roster_month_id) WHERE (roster_month_id IS NOT NULL);


--
-- Name: deploy_checks_mission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deploy_checks_mission_idx ON public.agent_deployment_checks USING btree (mission_id) WHERE (mission_id IS NOT NULL);


--
-- Name: dept_channel_members_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dept_channel_members_unique ON public.department_channel_members USING btree (channel_id, user_id);


--
-- Name: dept_channel_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dept_channel_members_user_idx ON public.department_channel_members USING btree (user_id);


--
-- Name: dept_channels_lateral_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dept_channels_lateral_idx ON public.department_channels USING btree (parent_id) WHERE (is_lateral AND (archived_at IS NULL));


--
-- Name: dept_channels_one_broadcast_per_level; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dept_channels_one_broadcast_per_level ON public.department_channels USING btree (org_id, level) WHERE (is_broadcast AND (archived_at IS NULL));


--
-- Name: dept_channels_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dept_channels_org_idx ON public.department_channels USING btree (org_id) WHERE (archived_at IS NULL);


--
-- Name: dept_channels_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dept_channels_parent_idx ON public.department_channels USING btree (parent_id) WHERE (archived_at IS NULL);


--
-- Name: dispatch_offers_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dispatch_offers_booking ON public.dispatch_offers USING btree (booking_id, status);


--
-- Name: dispatch_offers_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dispatch_offers_expiry ON public.dispatch_offers USING btree (expires_at) WHERE (status = 'OFFERED'::public.dispatch_offer_status);


--
-- Name: dispatch_offers_one_live_per_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dispatch_offers_one_live_per_booking ON public.dispatch_offers USING btree (booking_id) WHERE (status = 'OFFERED'::public.dispatch_offer_status);


--
-- Name: dispatch_offers_one_live_per_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dispatch_offers_one_live_per_provider ON public.dispatch_offers USING btree (provider_user_id) WHERE (status = 'OFFERED'::public.dispatch_offer_status);


--
-- Name: dispatch_room_intents_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dispatch_room_intents_pending_idx ON public.dispatch_room_intents USING btree (org_user_id, created_at) WHERE (state = 'pending'::text);


--
-- Name: enterprise_invites_match_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_invites_match_email ON public.enterprise_referral_links USING btree (lower(invited_email)) WHERE ((invited_email IS NOT NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: enterprise_invites_match_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_invites_match_phone ON public.enterprise_referral_links USING btree (invited_phone) WHERE ((invited_phone IS NOT NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: enterprise_invites_one_open_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enterprise_invites_one_open_email ON public.enterprise_referral_links USING btree (org_user_id, lower(invited_email)) WHERE ((invited_email IS NOT NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: enterprise_invites_one_open_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enterprise_invites_one_open_phone ON public.enterprise_referral_links USING btree (org_user_id, invited_phone) WHERE ((invited_phone IS NOT NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: enterprise_join_requests_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enterprise_join_requests_one_open ON public.enterprise_join_requests USING btree (org_user_id, applicant_user_id) WHERE (status = 'pending'::text);


--
-- Name: enterprise_join_requests_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_join_requests_pending_idx ON public.enterprise_join_requests USING btree (org_user_id, created_at DESC) WHERE (status = 'pending'::text);


--
-- Name: enterprise_join_requests_seed_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_join_requests_seed_pending_idx ON public.enterprise_join_requests USING btree (org_user_id, seed_pending_at) WHERE (seed_pending_at IS NOT NULL);


--
-- Name: enterprise_referral_links_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_referral_links_open_idx ON public.enterprise_referral_links USING btree (code) WHERE (revoked_at IS NULL);


--
-- Name: escrow_release_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX escrow_release_due ON public.escrow_holds USING btree (release_eligible_at) WHERE (status = 'PENDING_RELEASE'::public.escrow_hold_status);


--
-- Name: family_members_holder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_holder_idx ON public.family_members USING btree (holder_id, status);


--
-- Name: family_members_holder_phone_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_members_holder_phone_pending ON public.family_members USING btree (holder_id, invite_phone) WHERE ((status = 'pending'::text) AND (invite_phone IS NOT NULL));


--
-- Name: family_members_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_member_idx ON public.family_members USING btree (member_id, status);


--
-- Name: family_members_one_active_per_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_members_one_active_per_member ON public.family_members USING btree (member_id) WHERE ((status = 'active'::text) AND (member_id IS NOT NULL));


--
-- Name: family_members_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_phone_idx ON public.family_members USING btree (invite_phone) WHERE (status = 'pending'::text);


--
-- Name: idx_vbg_monitoring_active_beat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vbg_monitoring_active_beat ON public.vbg_monitoring USING btree (status, last_heartbeat_at);


--
-- Name: incident_attachment_keys_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX incident_attachment_keys_lookup_idx ON public.incident_attachment_keys USING btree (attachment_id, recipient_user_id, device_id);


--
-- Name: incident_attachments_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX incident_attachments_idx ON public.incident_attachments USING btree (incident_id);


--
-- Name: incident_events_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX incident_events_idx ON public.incident_events USING btree (incident_id, created_at);


--
-- Name: incident_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX incident_org_status_idx ON public.incident_reports USING btree (org_user_id, status, severity);


--
-- Name: incident_submitter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX incident_submitter_idx ON public.incident_reports USING btree (submitter_id);


--
-- Name: invoices_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_booking_idx ON public.invoices USING btree (booking_id);


--
-- Name: job_applications_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_applications_job_idx ON public.job_applications USING btree (job_id, fit_score DESC NULLS LAST);


--
-- Name: job_applications_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_applications_org_idx ON public.job_applications USING btree (applicant_org_id);


--
-- Name: jobs_dispatch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_dispatch_idx ON public.jobs USING btree (dispatch_at) WHERE (status = ANY (ARRAY['PUBLISHED'::public.job_status, 'REVIEW'::public.job_status]));


--
-- Name: jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_status_idx ON public.jobs USING btree (status);


--
-- Name: lite_booking_audit_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_booking_audit_booking_idx ON public.lite_booking_audit USING btree (booking_id);


--
-- Name: lite_bookings_arrival_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_arrival_due ON public.lite_bookings USING btree (arrival_deadline_at) WHERE ((status = 'CONFIRMED'::public.lite_booking_status) AND (arrival_deadline_at IS NOT NULL));


--
-- Name: lite_bookings_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_client_idx ON public.lite_bookings USING btree (client_id);


--
-- Name: lite_bookings_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_conversation_idx ON public.lite_bookings USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: lite_bookings_pickup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_pickup_idx ON public.lite_bookings USING btree (pickup_time);


--
-- Name: lite_bookings_referral_code_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_referral_code_id_idx ON public.lite_bookings USING btree (referral_code_id) WHERE (referral_code_id IS NOT NULL);


--
-- Name: lite_bookings_reminder_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_reminder_due_idx ON public.lite_bookings USING btree (pickup_time) WHERE ((booking_mode = 'later'::text) AND (reminder_sent_at IS NULL));


--
-- Name: lite_bookings_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lite_bookings_status_idx ON public.lite_bookings USING btree (status);


--
-- Name: live_feed_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_feed_recent_idx ON public.live_feed_events USING btree (created_at DESC);


--
-- Name: messages_backup_mirrored_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_backup_mirrored_at_idx ON public.messages_backup USING btree (mirrored_at);


--
-- Name: messages_backup_owner_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_backup_owner_conv_idx ON public.messages_backup USING btree (owner_user_id, conversation_id, msg_created_at);


--
-- Name: messages_backup_owner_since_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_backup_owner_since_idx ON public.messages_backup USING btree (owner_user_id, msg_created_at DESC);


--
-- Name: messages_backup_owner_ts_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_backup_owner_ts_id_idx ON public.messages_backup USING btree (owner_user_id, msg_created_at, message_id);


--
-- Name: mission_crew_accepted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_crew_accepted_idx ON public.mission_crew USING btree (mission_id) WHERE (accepted_at IS NOT NULL);


--
-- Name: mission_crew_agent_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mission_crew_agent_active_uq ON public.mission_crew USING btree (agent_id) WHERE (status <> 'off'::text);


--
-- Name: mission_crew_one_lead_per_team; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mission_crew_one_lead_per_team ON public.mission_crew USING btree (mission_id, team_idx) WHERE (is_lead = true);


--
-- Name: mission_hourly_checkins_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_hourly_checkins_booking_idx ON public.mission_hourly_checkins USING btree (booking_id);


--
-- Name: mission_payouts_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_payouts_agent_idx ON public.mission_payouts USING btree (agent_user_id);


--
-- Name: mission_payouts_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_payouts_booking_idx ON public.mission_payouts USING btree (booking_id);


--
-- Name: mission_payouts_mission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_payouts_mission_idx ON public.mission_payouts USING btree (mission_id);


--
-- Name: mission_payouts_payee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_payouts_payee_idx ON public.mission_payouts USING btree (payee_user_id);


--
-- Name: mission_telemetry_last_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_telemetry_last_recorded_idx ON public.mission_telemetry_last USING btree (recorded_at DESC);


--
-- Name: mission_telemetry_mission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_telemetry_mission_idx ON public.mission_telemetry USING btree (mission_id, recorded_at DESC);


--
-- Name: mission_waypoints_mission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mission_waypoints_mission_idx ON public.mission_waypoints USING btree (mission_id, seq);


--
-- Name: missions_booking_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX missions_booking_active_uq ON public.missions USING btree (booking_id) WHERE (status <> 'ABORTED'::public.mission_status);


--
-- Name: missions_booking_id_bridge; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX missions_booking_id_bridge ON public.missions USING btree (booking_id);


--
-- Name: missions_comms_room_failed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX missions_comms_room_failed_idx ON public.missions USING btree (comms_room_failed_at) WHERE (comms_room_failed_at IS NOT NULL);


--
-- Name: missions_short_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX missions_short_code_uq ON public.missions USING btree (short_code);


--
-- Name: missions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX missions_status_idx ON public.missions USING btree (status);


--
-- Name: notifications_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: notifications_user_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_unread_idx ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);


--
-- Name: ops_audit_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_audit_actor_idx ON public.ops_audit USING btree (actor_id, created_at DESC);


--
-- Name: ops_audit_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_audit_recent_idx ON public.ops_audit USING btree (created_at DESC);


--
-- Name: ops_audit_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_audit_subject_idx ON public.ops_audit USING btree (subject_type, subject_id, created_at DESC);


--
-- Name: org_audit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_audit_idx ON public.org_audit_log USING btree (org_user_id, created_at DESC);


--
-- Name: org_members_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_member_idx ON public.org_members USING btree (member_user_id);


--
-- Name: org_members_one_active_cpo; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_members_one_active_cpo ON public.org_members USING btree (member_user_id) WHERE ((status = 'active'::text) AND (member_role = 'cpo'::text));


--
-- Name: INDEX org_members_one_active_cpo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.org_members_one_active_cpo IS 'vs2 item 4: a CPO may be actively employed by only ONE agency. The other roles (manager, employee) are deliberately multi-org — see docs/planning/ITEM4_MULTI_ORG_DECISION_BRIEF.md.';


--
-- Name: org_members_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_org_active_idx ON public.org_members USING btree (org_user_id) WHERE (status = 'active'::text);


--
-- Name: org_members_suspension_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_suspension_expiry_idx ON public.org_members USING btree (org_user_id, suspended_until) WHERE ((status = 'suspended'::text) AND (suspended_until IS NOT NULL));


--
-- Name: org_workspaces_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_workspaces_owner_idx ON public.org_workspaces USING btree (owner_user_id);


--
-- Name: pro_application_events_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_application_events_app_idx ON public.pro_application_events USING btree (application_id, created_at DESC);


--
-- Name: pro_application_messages_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_application_messages_app_idx ON public.pro_application_messages USING btree (application_id, created_at);


--
-- Name: pro_applications_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_applications_status_idx ON public.pro_applications USING btree (status, submitted_at DESC);


--
-- Name: pro_applications_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_applications_user_idx ON public.pro_applications USING btree (user_id, submitted_at DESC);


--
-- Name: pro_cpo_assignments_active_authorized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_cpo_assignments_active_authorized_idx ON public.pro_cpo_assignments USING btree (cpo_user_id, ends_on DESC) WHERE ((status = 'ASSIGNED'::text) AND (authorized_at IS NOT NULL));


--
-- Name: pro_cpo_assignments_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_cpo_assignments_app_idx ON public.pro_cpo_assignments USING btree (application_id, starts_on DESC);


--
-- Name: pro_cpo_assignments_cpo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_cpo_assignments_cpo_idx ON public.pro_cpo_assignments USING btree (cpo_user_id, status, starts_on DESC);


--
-- Name: pro_cpo_assignments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_cpo_assignments_status_idx ON public.pro_cpo_assignments USING btree (status, ends_on);


--
-- Name: pro_plan_missions_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_plan_missions_app_idx ON public.pro_plan_missions USING btree (application_id, created_at DESC);


--
-- Name: pro_proposals_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pro_proposals_app_idx ON public.pro_proposals USING btree (application_id, version DESC);


--
-- Name: protection_access_audit_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX protection_access_audit_session_idx ON public.protection_access_audit USING btree (session_id, created_at DESC);


--
-- Name: protection_session_readiness_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX protection_session_readiness_ready_idx ON public.protection_session_readiness USING btree (session_id, ready);


--
-- Name: protection_sessions_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX protection_sessions_app_idx ON public.protection_sessions USING btree (application_id, created_at DESC);


--
-- Name: protection_sessions_cpo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX protection_sessions_cpo_idx ON public.protection_sessions USING btree (cpo_user_id, status);


--
-- Name: protection_sessions_one_live_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX protection_sessions_one_live_uq ON public.protection_sessions USING btree (customer_id) WHERE (status = ANY (ARRAY['REQUESTED'::text, 'ACTIVE'::text, 'ENDING'::text]));


--
-- Name: provider_invite_codes_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_invite_codes_open_idx ON public.provider_invite_codes USING btree (code) WHERE ((redeemed_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: provider_invite_codes_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_invite_codes_org_idx ON public.provider_invite_codes USING btree (org_user_id);


--
-- Name: provider_referral_codes_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_referral_codes_active_idx ON public.provider_referral_codes USING btree (code) WHERE (active = true);


--
-- Name: pse_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pse_actor_idx ON public.protection_session_events USING btree (actor_id, created_at DESC);


--
-- Name: pse_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pse_session_idx ON public.protection_session_events USING btree (session_id, seq);


--
-- Name: psl_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX psl_session_idx ON public.protection_session_locations USING btree (session_id, received_at DESC);


--
-- Name: psl_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX psl_subject_idx ON public.protection_session_locations USING btree (session_id, subject, received_at DESC);


--
-- Name: psn_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX psn_session_idx ON public.protection_session_notes USING btree (session_id, created_at);


--
-- Name: sealed_envelope_archive_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sealed_envelope_archive_expires_at_idx ON public.sealed_envelope_archive USING btree (expires_at_sec) WHERE (expires_at_sec IS NOT NULL);


--
-- Name: sealed_envelope_archive_recipient_ts_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sealed_envelope_archive_recipient_ts_id_idx ON public.sealed_envelope_archive USING btree (recipient_user_id, ts_ms, envelope_id);


--
-- Name: sealed_envelope_archive_recipient_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sealed_envelope_archive_recipient_ts_idx ON public.sealed_envelope_archive USING btree (recipient_user_id, ts_ms);


--
-- Name: sos_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_active_idx ON public.sos_events USING btree (triggered_at DESC) WHERE (status = 'active'::text);


--
-- Name: sos_events_mission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_events_mission_idx ON public.sos_events USING btree (mission_id);


--
-- Name: sos_events_unacked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_events_unacked_idx ON public.sos_events USING btree (triggered_at DESC) WHERE (acknowledged_at IS NULL);


--
-- Name: stripe_processed_events_processed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stripe_processed_events_processed_at_idx ON public.stripe_processed_events USING btree (processed_at);


--
-- Name: system_broadcasts_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_broadcasts_conv_idx ON public.system_broadcasts USING btree (conversation_id, created_at DESC);


--
-- Name: system_broadcasts_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_broadcasts_subject_idx ON public.system_broadcasts USING btree (subject_type, subject_id) WHERE (subject_type IS NOT NULL);


--
-- Name: users_not_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_not_deleted_idx ON public.users USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role) WHERE (deleted_at IS NULL);


--
-- Name: users_suspended_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_suspended_idx ON public.users USING btree (suspended_at) WHERE (suspended_at IS NOT NULL);


--
-- Name: ux_mission_payouts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_mission_payouts_unique ON public.mission_payouts USING btree (mission_id, agent_user_id);


--
-- Name: ux_pro_applications_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_pro_applications_open ON public.pro_applications USING btree (user_id) WHERE (status = ANY (ARRAY['PENDING_PROPOSAL'::text, 'PROPOSAL_CREATED'::text, 'REVISION_REQUESTED'::text, 'ACCEPTED'::text, 'ACTIVE'::text]));


--
-- Name: ux_wallet_tx_booking_refund; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_wallet_tx_booking_refund ON public.wallet_transactions USING btree (user_id, booking_id) WHERE ((type = 'refund'::public.wallet_tx_type) AND (booking_id IS NOT NULL) AND ((metadata ->> 'kind'::text) = 'booking_refund'::text));


--
-- Name: ux_wallet_tx_payout; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_wallet_tx_payout ON public.wallet_transactions USING btree (user_id, booking_id) WHERE ((type = 'payout'::public.wallet_tx_type) AND (booking_id IS NOT NULL));


--
-- Name: vbg_favorites_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vbg_favorites_user_idx ON public.vbg_favorites USING btree (user_id, "position");


--
-- Name: vbg_geofences_area_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vbg_geofences_area_gix ON public.vbg_geofences USING gist (area);


--
-- Name: vbg_geofences_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vbg_geofences_user_idx ON public.vbg_geofences USING btree (user_id) WHERE active;


--
-- Name: vbg_monitoring_active_beat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vbg_monitoring_active_beat_idx ON public.vbg_monitoring USING btree (status, last_heartbeat_at);


--
-- Name: vbg_sra_snapshots_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vbg_sra_snapshots_user_created_idx ON public.vbg_sra_snapshots USING btree (user_id, created_at DESC);


--
-- Name: vehicle_pool_region_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vehicle_pool_region_status_idx ON public.vehicle_pool USING btree (region_code, status) WHERE (active = true);


--
-- Name: wallet_credit_batches_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_credit_batches_active_idx ON public.wallet_credit_batches USING btree (user_id, expires_at) WHERE ((expired_at IS NULL) AND (consumed_credits < amount_credits));


--
-- Name: wallet_credit_batches_sweep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_credit_batches_sweep_idx ON public.wallet_credit_batches USING btree (expires_at) WHERE (expired_at IS NULL);


--
-- Name: wallet_credit_batches_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_credit_batches_user_idx ON public.wallet_credit_batches USING btree (user_id, issued_at DESC);


--
-- Name: wallet_tx_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_tx_actor_idx ON public.wallet_transactions USING btree (user_id, actor_user_id, created_at DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: wallet_tx_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_tx_booking_idx ON public.wallet_transactions USING btree (booking_id);


--
-- Name: wallet_tx_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_tx_intent_idx ON public.wallet_transactions USING btree (stripe_intent_id);


--
-- Name: wallet_tx_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_tx_user_idx ON public.wallet_transactions USING btree (user_id, created_at DESC);


--
-- Name: bname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);


--
-- Name: bucketid_objname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);


--
-- Name: buckets_analytics_unique_name_idx; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX buckets_analytics_unique_name_idx ON storage.buckets_analytics USING btree (name) WHERE (deleted_at IS NULL);


--
-- Name: idx_iceberg_namespaces_bucket_id; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX idx_iceberg_namespaces_bucket_id ON storage.iceberg_namespaces USING btree (catalog_id, name);


--
-- Name: idx_iceberg_tables_location; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX idx_iceberg_tables_location ON storage.iceberg_tables USING btree (location);


--
-- Name: idx_iceberg_tables_namespace_id; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX idx_iceberg_tables_namespace_id ON storage.iceberg_tables USING btree (catalog_id, namespace_id, name);


--
-- Name: idx_multipart_uploads_list; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_multipart_uploads_list ON storage.s3_multipart_uploads USING btree (bucket_id, key, created_at);


--
-- Name: idx_objects_bucket_id_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name ON storage.objects USING btree (bucket_id, name COLLATE "C");


--
-- Name: idx_objects_bucket_id_name_lower; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name_lower ON storage.objects USING btree (bucket_id, lower(name) COLLATE "C");


--
-- Name: name_prefix_search; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX name_prefix_search ON storage.objects USING btree (name text_pattern_ops);


--
-- Name: vector_indexes_name_bucket_id_idx; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX vector_indexes_name_bucket_id_idx ON storage.vector_indexes USING btree (name, bucket_id);


--
-- Name: supabase_functions_hooks_h_table_id_h_name_idx; Type: INDEX; Schema: supabase_functions; Owner: -
--

CREATE INDEX supabase_functions_hooks_h_table_id_h_name_idx ON supabase_functions.hooks USING btree (hook_table_id, hook_name);


--
-- Name: supabase_functions_hooks_request_id_idx; Type: INDEX; Schema: supabase_functions; Owner: -
--

CREATE INDEX supabase_functions_hooks_request_id_idx ON supabase_functions.hooks USING btree (request_id);


--
-- Name: agents agents_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agents_touch_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.touch_agents_updated_at();


--
-- Name: attendance_corrections attendance_corrections_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attendance_corrections_no_truncate BEFORE TRUNCATE ON public.attendance_corrections FOR EACH STATEMENT EXECUTE FUNCTION public.attendance_corrections_no_truncate();


--
-- Name: attendance_corrections attendance_corrections_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attendance_corrections_no_update BEFORE DELETE OR UPDATE ON public.attendance_corrections FOR EACH ROW EXECUTE FUNCTION public.attendance_corrections_append_only();


--
-- Name: backup_merkle_commits backup_merkle_commits_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER backup_merkle_commits_touch BEFORE UPDATE ON public.backup_merkle_commits FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: backup_session_snapshots backup_session_snapshots_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER backup_session_snapshots_touch BEFORE UPDATE ON public.backup_session_snapshots FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: conversation_backups conversation_backups_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER conversation_backups_touch BEFORE UPDATE ON public.conversation_backups FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: department_channels dept_channel_block_broadcast_delete_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dept_channel_block_broadcast_delete_trg BEFORE DELETE ON public.department_channels FOR EACH ROW EXECUTE FUNCTION public.dept_channel_block_broadcast_delete();


--
-- Name: department_channels dept_channel_broadcast_mode_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dept_channel_broadcast_mode_trg BEFORE INSERT OR UPDATE ON public.department_channels FOR EACH ROW EXECUTE FUNCTION public.dept_channel_broadcast_mode();


--
-- Name: department_channels dept_channel_set_level_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dept_channel_set_level_trg BEFORE INSERT OR UPDATE ON public.department_channels FOR EACH ROW EXECUTE FUNCTION public.dept_channel_set_level();


--
-- Name: identity_backups identity_backups_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER identity_backups_touch BEFORE UPDATE ON public.identity_backups FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: lite_bookings lite_bookings_fsm_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lite_bookings_fsm_check BEFORE UPDATE ON public.lite_bookings FOR EACH ROW EXECUTE FUNCTION public.lite_bookings_fsm_check();


--
-- Name: lite_bookings lite_bookings_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lite_bookings_touch_updated_at BEFORE UPDATE ON public.lite_bookings FOR EACH ROW EXECUTE FUNCTION public.touch_lite_bookings_updated_at();


--
-- Name: missions missions_fsm_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER missions_fsm_check BEFORE UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.missions_fsm_check();


--
-- Name: missions missions_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER missions_touch_updated_at BEFORE UPDATE ON public.missions FOR EACH ROW EXECUTE FUNCTION public.touch_missions_updated_at();


--
-- Name: ops_audit ops_audit_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ops_audit_no_delete BEFORE DELETE ON public.ops_audit FOR EACH ROW EXECUTE FUNCTION public.ops_audit_no_mutation();


--
-- Name: ops_audit ops_audit_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ops_audit_no_update BEFORE UPDATE ON public.ops_audit FOR EACH ROW EXECUTE FUNCTION public.ops_audit_no_mutation();


--
-- Name: signal_identities signal_identities_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signal_identities_touch BEFORE UPDATE ON public.signal_identities FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: users users_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: wallet_balances wallet_balances_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER wallet_balances_touch_updated_at BEFORE UPDATE ON public.wallet_balances FOR EACH ROW EXECUTE FUNCTION public.touch_wallet_balances_updated_at();


--
-- Name: buckets enforce_bucket_name_length_trigger; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();


--
-- Name: buckets protect_buckets_delete; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects protect_objects_delete; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_auth_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_factors mfa_factors_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_authorizations oauth_authorizations_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_authorizations
    ADD CONSTRAINT oauth_authorizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: oauth_consents oauth_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: one_time_tokens one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: saml_providers saml_providers_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_flow_state_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_flow_state_id_fkey FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_oauth_client_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sso_domains sso_domains_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: webauthn_challenges webauthn_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: admin_invites admin_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: admin_invites admin_invites_redeemed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_redeemed_user_id_fkey FOREIGN KEY (redeemed_user_id) REFERENCES public.users(id);


--
-- Name: admin_users admin_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_audit agent_audit_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_audit
    ADD CONSTRAINT agent_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agent_deployment_checks agent_deployment_checks_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_deployment_checks
    ADD CONSTRAINT agent_deployment_checks_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: agent_deployment_checks agent_deployment_checks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_deployment_checks
    ADD CONSTRAINT agent_deployment_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agent_documents agent_documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents
    ADD CONSTRAINT agent_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agent_kyc_checks agent_kyc_checks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_kyc_checks
    ADD CONSTRAINT agent_kyc_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agent_profiles agent_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_profiles
    ADD CONSTRAINT agent_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agent_review_pipeline agent_review_pipeline_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_review_pipeline
    ADD CONSTRAINT agent_review_pipeline_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.agents(user_id) ON DELETE CASCADE;


--
-- Name: agents agents_managed_by_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_managed_by_org_id_fkey FOREIGN KEY (managed_by_org_id) REFERENCES public.users(id);


--
-- Name: auth_devices auth_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_devices
    ADD CONSTRAINT auth_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_otps auth_otps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_otps
    ADD CONSTRAINT auth_otps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_totp_backup_codes auth_totp_backup_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_backup_codes
    ADD CONSTRAINT auth_totp_backup_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: auth_totp_secrets auth_totp_secrets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_totp_secrets
    ADD CONSTRAINT auth_totp_secrets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backup_merkle_commits backup_merkle_commits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_merkle_commits
    ADD CONSTRAINT backup_merkle_commits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backup_session_snapshots backup_session_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_session_snapshots
    ADD CONSTRAINT backup_session_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: blocked_users blocked_users_blocked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_blocked_user_id_fkey FOREIGN KEY (blocked_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: blocked_users blocked_users_blocker_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_users
    ADD CONSTRAINT blocked_users_blocker_user_id_fkey FOREIGN KEY (blocker_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: booking_cpo_assignments booking_cpo_assignments_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_cpo_assignments
    ADD CONSTRAINT booking_cpo_assignments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: booking_cpo_assignments booking_cpo_assignments_cpo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_cpo_assignments
    ADD CONSTRAINT booking_cpo_assignments_cpo_id_fkey FOREIGN KEY (cpo_id) REFERENCES public.cpo_pool(id);


--
-- Name: booking_disputes booking_disputes_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_disputes
    ADD CONSTRAINT booking_disputes_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id);


--
-- Name: channel_membership_intents channel_membership_intents_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_membership_intents
    ADD CONSTRAINT channel_membership_intents_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.department_channels(id) ON DELETE CASCADE;


--
-- Name: channel_membership_intents channel_membership_intents_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_membership_intents
    ADD CONSTRAINT channel_membership_intents_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_membership_intents channel_membership_intents_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_membership_intents
    ADD CONSTRAINT channel_membership_intents_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: conversation_backups conversation_backups_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_backups
    ADD CONSTRAINT conversation_backups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversation_membership_intents conversation_membership_intents_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_membership_intents
    ADD CONSTRAINT conversation_membership_intents_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_membership_intents conversation_membership_intents_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_membership_intents
    ADD CONSTRAINT conversation_membership_intents_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversation_membership_intents conversation_membership_intents_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_membership_intents
    ADD CONSTRAINT conversation_membership_intents_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cpo_roster_months cpo_roster_months_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_roster_months
    ADD CONSTRAINT cpo_roster_months_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cpo_roster_months cpo_roster_months_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_roster_months
    ADD CONSTRAINT cpo_roster_months_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cpo_roster_months cpo_roster_months_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_roster_months
    ADD CONSTRAINT cpo_roster_months_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id);


--
-- Name: cpo_shift_assignments cpo_shift_assignments_cpo_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_assignments
    ADD CONSTRAINT cpo_shift_assignments_cpo_user_id_fkey FOREIGN KEY (cpo_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cpo_shift_assignments cpo_shift_assignments_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_assignments
    ADD CONSTRAINT cpo_shift_assignments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.cpo_shifts(id) ON DELETE CASCADE;


--
-- Name: cpo_shift_sessions cpo_shift_sessions_cpo_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_cpo_user_id_fkey FOREIGN KEY (cpo_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cpo_shift_sessions cpo_shift_sessions_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES public.users(id);


--
-- Name: cpo_shift_sessions cpo_shift_sessions_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cpo_shift_sessions cpo_shift_sessions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: cpo_shift_sessions cpo_shift_sessions_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shift_sessions
    ADD CONSTRAINT cpo_shift_sessions_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.cpo_shifts(id);


--
-- Name: cpo_shifts cpo_shifts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shifts
    ADD CONSTRAINT cpo_shifts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: cpo_shifts cpo_shifts_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shifts
    ADD CONSTRAINT cpo_shifts_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cpo_shifts cpo_shifts_roster_month_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cpo_shifts
    ADD CONSTRAINT cpo_shifts_roster_month_id_fkey FOREIGN KEY (roster_month_id) REFERENCES public.cpo_roster_months(id) ON DELETE SET NULL;


--
-- Name: department_channel_members department_channel_members_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channel_members
    ADD CONSTRAINT department_channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.department_channels(id) ON DELETE CASCADE;


--
-- Name: department_channel_members department_channel_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channel_members
    ADD CONSTRAINT department_channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: department_channels department_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channels
    ADD CONSTRAINT department_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: department_channels department_channels_name_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channels
    ADD CONSTRAINT department_channels_name_changed_by_fkey FOREIGN KEY (name_changed_by) REFERENCES public.users(id);


--
-- Name: department_channels department_channels_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channels
    ADD CONSTRAINT department_channels_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: department_channels department_channels_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_channels
    ADD CONSTRAINT department_channels_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.department_channels(id) ON DELETE RESTRICT;


--
-- Name: dispatch_offers dispatch_offers_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_offers
    ADD CONSTRAINT dispatch_offers_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: dispatch_room_crypto_claims dispatch_room_crypto_claims_claimed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_crypto_claims
    ADD CONSTRAINT dispatch_room_crypto_claims_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.users(id);


--
-- Name: dispatch_room_crypto_claims dispatch_room_crypto_claims_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_crypto_claims
    ADD CONSTRAINT dispatch_room_crypto_claims_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: dispatch_room_intents dispatch_room_intents_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_intents
    ADD CONSTRAINT dispatch_room_intents_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: dispatch_room_intents dispatch_room_intents_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_intents
    ADD CONSTRAINT dispatch_room_intents_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: dispatch_room_intents dispatch_room_intents_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_intents
    ADD CONSTRAINT dispatch_room_intents_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: dispatch_room_intents dispatch_room_intents_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_room_intents
    ADD CONSTRAINT dispatch_room_intents_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: enterprise_join_requests enterprise_join_requests_applicant_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_applicant_user_id_fkey FOREIGN KEY (applicant_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: enterprise_join_requests enterprise_join_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enterprise_join_requests enterprise_join_requests_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.enterprise_referral_links(id) ON DELETE SET NULL;


--
-- Name: enterprise_join_requests enterprise_join_requests_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: enterprise_join_requests enterprise_join_requests_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enterprise_join_requests enterprise_join_requests_team_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_join_requests
    ADD CONSTRAINT enterprise_join_requests_team_channel_id_fkey FOREIGN KEY (team_channel_id) REFERENCES public.department_channels(id) ON DELETE SET NULL;


--
-- Name: enterprise_referral_links enterprise_referral_links_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enterprise_referral_links enterprise_referral_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enterprise_referral_links enterprise_referral_links_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: enterprise_referral_links enterprise_referral_links_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: enterprise_referral_links enterprise_referral_links_team_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_referral_links
    ADD CONSTRAINT enterprise_referral_links_team_channel_id_fkey FOREIGN KEY (team_channel_id) REFERENCES public.department_channels(id) ON DELETE SET NULL;


--
-- Name: escrow_holds escrow_holds_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escrow_holds
    ADD CONSTRAINT escrow_holds_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id);


--
-- Name: escrow_holds escrow_holds_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escrow_holds
    ADD CONSTRAINT escrow_holds_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.dispatch_offers(id);


--
-- Name: family_member_locations family_member_locations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_member_locations
    ADD CONSTRAINT family_member_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: family_members family_members_holder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_holder_id_fkey FOREIGN KEY (holder_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: family_members family_members_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: identity_backups identity_backups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_backups
    ADD CONSTRAINT identity_backups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: incident_attachment_keys incident_attachment_keys_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachment_keys
    ADD CONSTRAINT incident_attachment_keys_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.incident_attachments(id) ON DELETE CASCADE;


--
-- Name: incident_attachment_keys incident_attachment_keys_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachment_keys
    ADD CONSTRAINT incident_attachment_keys_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: incident_attachments incident_attachments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachments
    ADD CONSTRAINT incident_attachments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: incident_attachments incident_attachments_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_attachments
    ADD CONSTRAINT incident_attachments_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.incident_reports(id) ON DELETE CASCADE;


--
-- Name: incident_events incident_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_events
    ADD CONSTRAINT incident_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: incident_events incident_events_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_events
    ADD CONSTRAINT incident_events_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.incident_reports(id) ON DELETE CASCADE;


--
-- Name: incident_reports incident_reports_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: incident_reports incident_reports_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: incident_reports incident_reports_submitter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_submitter_id_fkey FOREIGN KEY (submitter_id) REFERENCES public.users(id);


--
-- Name: invoices invoices_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: job_applications job_applications_agent_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_agent_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(user_id) ON DELETE RESTRICT;


--
-- Name: job_applications job_applications_applicant_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_applicant_org_id_fkey FOREIGN KEY (applicant_org_id) REFERENCES public.users(id);


--
-- Name: job_applications job_applications_assigned_cpo_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_assigned_cpo_user_id_fkey FOREIGN KEY (assigned_cpo_user_id) REFERENCES public.users(id);


--
-- Name: job_applications job_applications_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: lite_booking_audit lite_booking_audit_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_booking_audit
    ADD CONSTRAINT lite_booking_audit_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: lite_bookings lite_bookings_referral_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lite_bookings
    ADD CONSTRAINT lite_bookings_referral_code_id_fkey FOREIGN KEY (referral_code_id) REFERENCES public.provider_referral_codes(id) ON DELETE SET NULL;


--
-- Name: messages_backup messages_backup_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_backup
    ADD CONSTRAINT messages_backup_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: mission_crew mission_crew_agent_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_crew
    ADD CONSTRAINT mission_crew_agent_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(user_id) ON DELETE RESTRICT;


--
-- Name: mission_crew mission_crew_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_crew
    ADD CONSTRAINT mission_crew_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: mission_hourly_checkins mission_hourly_checkins_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_hourly_checkins
    ADD CONSTRAINT mission_hourly_checkins_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: mission_hourly_checkins mission_hourly_checkins_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_hourly_checkins
    ADD CONSTRAINT mission_hourly_checkins_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: mission_payouts mission_payouts_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_payouts
    ADD CONSTRAINT mission_payouts_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: mission_payouts mission_payouts_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_payouts
    ADD CONSTRAINT mission_payouts_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: mission_payouts mission_payouts_payee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_payouts
    ADD CONSTRAINT mission_payouts_payee_user_id_fkey FOREIGN KEY (payee_user_id) REFERENCES public.users(id);


--
-- Name: mission_principals mission_principals_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_principals
    ADD CONSTRAINT mission_principals_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: mission_telemetry_last mission_telemetry_last_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_telemetry_last
    ADD CONSTRAINT mission_telemetry_last_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: mission_telemetry mission_telemetry_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_telemetry
    ADD CONSTRAINT mission_telemetry_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: mission_waypoints mission_waypoints_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mission_waypoints
    ADD CONSTRAINT mission_waypoints_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE CASCADE;


--
-- Name: missions missions_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.lite_bookings(id) ON DELETE CASCADE;


--
-- Name: missions missions_comms_channel_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.missions
    ADD CONSTRAINT missions_comms_channel_fk FOREIGN KEY (comms_channel_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: org_audit_log org_audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_audit_log
    ADD CONSTRAINT org_audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: org_audit_log org_audit_log_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_audit_log
    ADD CONSTRAINT org_audit_log_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: org_members org_members_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_suspended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES public.users(id);


--
-- Name: org_workspace_settings org_workspace_settings_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_workspace_settings
    ADD CONSTRAINT org_workspace_settings_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_workspace_settings org_workspace_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_workspace_settings
    ADD CONSTRAINT org_workspace_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_workspaces org_workspaces_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_workspaces
    ADD CONSTRAINT org_workspaces_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pro_application_events pro_application_events_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_application_events
    ADD CONSTRAINT pro_application_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id) ON DELETE CASCADE;


--
-- Name: pro_application_messages pro_application_messages_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_application_messages
    ADD CONSTRAINT pro_application_messages_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id) ON DELETE CASCADE;


--
-- Name: pro_cpo_assignments pro_cpo_assignments_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_cpo_assignments
    ADD CONSTRAINT pro_cpo_assignments_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id) ON DELETE CASCADE;


--
-- Name: pro_cpo_assignments pro_cpo_assignments_mission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_cpo_assignments
    ADD CONSTRAINT pro_cpo_assignments_mission_id_fkey FOREIGN KEY (mission_id) REFERENCES public.pro_plan_missions(id) ON DELETE SET NULL;


--
-- Name: pro_plan_missions pro_plan_missions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_plan_missions
    ADD CONSTRAINT pro_plan_missions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id) ON DELETE CASCADE;


--
-- Name: pro_proposals pro_proposals_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pro_proposals
    ADD CONSTRAINT pro_proposals_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id) ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_promo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_promo_id_fkey FOREIGN KEY (promo_id) REFERENCES public.promo_codes(id) ON DELETE CASCADE;


--
-- Name: protection_session_events protection_session_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_events
    ADD CONSTRAINT protection_session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.protection_sessions(id) ON DELETE CASCADE;


--
-- Name: protection_session_locations protection_session_locations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_locations
    ADD CONSTRAINT protection_session_locations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.protection_sessions(id) ON DELETE CASCADE;


--
-- Name: protection_session_notes protection_session_notes_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_notes
    ADD CONSTRAINT protection_session_notes_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.protection_sessions(id) ON DELETE CASCADE;


--
-- Name: protection_session_readiness protection_session_readiness_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_session_readiness
    ADD CONSTRAINT protection_session_readiness_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.protection_sessions(id) ON DELETE CASCADE;


--
-- Name: protection_sessions protection_sessions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_sessions
    ADD CONSTRAINT protection_sessions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.pro_applications(id);


--
-- Name: protection_sessions protection_sessions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.protection_sessions
    ADD CONSTRAINT protection_sessions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.pro_cpo_assignments(id);


--
-- Name: provider_invite_codes provider_invite_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_invite_codes
    ADD CONSTRAINT provider_invite_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: provider_invite_codes provider_invite_codes_org_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_invite_codes
    ADD CONSTRAINT provider_invite_codes_org_user_id_fkey FOREIGN KEY (org_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: provider_invite_codes provider_invite_codes_redeemed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_invite_codes
    ADD CONSTRAINT provider_invite_codes_redeemed_by_fkey FOREIGN KEY (redeemed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: provider_referral_codes provider_referral_codes_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_referral_codes
    ADD CONSTRAINT provider_referral_codes_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sealed_envelope_archive sealed_envelope_archive_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sealed_envelope_archive
    ADD CONSTRAINT sealed_envelope_archive_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: signal_identities signal_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_identities
    ADD CONSTRAINT signal_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: signal_one_time_prekeys signal_one_time_prekeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_one_time_prekeys
    ADD CONSTRAINT signal_one_time_prekeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sos_events sos_events_mission_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_events
    ADD CONSTRAINT sos_events_mission_id_fk FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE SET NULL;


--
-- Name: sos_events sos_events_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_events
    ADD CONSTRAINT sos_events_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: sos_events sos_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_events
    ADD CONSTRAINT sos_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: subscription_prices subscription_prices_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_prices
    ADD CONSTRAINT subscription_prices_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: system_broadcasts system_broadcasts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_broadcasts
    ADD CONSTRAINT system_broadcasts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: system_broadcasts system_broadcasts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_broadcasts
    ADD CONSTRAINT system_broadcasts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: vbg_device_keys vbg_device_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_device_keys
    ADD CONSTRAINT vbg_device_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vbg_favorites vbg_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_favorites
    ADD CONSTRAINT vbg_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vbg_geofences vbg_geofences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_geofences
    ADD CONSTRAINT vbg_geofences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vbg_monitoring vbg_monitoring_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_monitoring
    ADD CONSTRAINT vbg_monitoring_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vbg_sra_snapshots vbg_sra_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_sra_snapshots
    ADD CONSTRAINT vbg_sra_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vbg_telemetry_last vbg_telemetry_last_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vbg_telemetry_last
    ADD CONSTRAINT vbg_telemetry_last_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: wallet_transactions wallet_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: iceberg_namespaces iceberg_namespaces_catalog_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.iceberg_namespaces
    ADD CONSTRAINT iceberg_namespaces_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES storage.buckets_analytics(id) ON DELETE CASCADE;


--
-- Name: iceberg_tables iceberg_tables_catalog_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES storage.buckets_analytics(id) ON DELETE CASCADE;


--
-- Name: iceberg_tables iceberg_tables_namespace_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.iceberg_tables
    ADD CONSTRAINT iceberg_tables_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES storage.iceberg_namespaces(id) ON DELETE CASCADE;


--
-- Name: objects objects_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_upload_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES storage.s3_multipart_uploads(id) ON DELETE CASCADE;


--
-- Name: vector_indexes vector_indexes_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.vector_indexes
    ADD CONSTRAINT vector_indexes_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets_vectors(id);


--
-- Name: audit_log_entries; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_state; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;

--
-- Name: identities; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_amr_claims; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_factors; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: one_time_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_relay_states; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_domains; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_deployment_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_deployment_checks ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_kyc_checks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_kyc_checks ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_review_pipeline; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_review_pipeline ENABLE ROW LEVEL SECURITY;

--
-- Name: agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

--
-- Name: armed_authorizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.armed_authorizations ENABLE ROW LEVEL SECURITY;

--
-- Name: attendance_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attendance_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_totp_backup_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_totp_backup_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_totp_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_totp_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: backup_merkle_commits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.backup_merkle_commits ENABLE ROW LEVEL SECURITY;

--
-- Name: backup_session_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.backup_session_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_cpo_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_cpo_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_membership_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_membership_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.compliance_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_backups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_backups ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_membership_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_membership_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: cpo_pool; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cpo_pool ENABLE ROW LEVEL SECURITY;

--
-- Name: cpo_roster_months; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cpo_roster_months ENABLE ROW LEVEL SECURITY;

--
-- Name: cpo_shift_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cpo_shift_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: cpo_shift_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cpo_shift_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: cpo_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cpo_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: department_channel_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.department_channel_members ENABLE ROW LEVEL SECURITY;

--
-- Name: department_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.department_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_room_crypto_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_room_crypto_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_room_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_room_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: enterprise_join_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enterprise_join_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: enterprise_referral_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enterprise_referral_links ENABLE ROW LEVEL SECURITY;

--
-- Name: escrow_holds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;

--
-- Name: family_member_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_member_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: family_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_backups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.identity_backups ENABLE ROW LEVEL SECURITY;

--
-- Name: incident_attachment_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.incident_attachment_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: incident_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.incident_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: incident_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.incident_events ENABLE ROW LEVEL SECURITY;

--
-- Name: incident_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: job_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: lite_booking_add_ons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lite_booking_add_ons ENABLE ROW LEVEL SECURITY;

--
-- Name: lite_booking_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lite_booking_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: lite_bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lite_bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: live_feed_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.live_feed_events ENABLE ROW LEVEL SECURITY;

--
-- Name: messages_backup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages_backup ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_crew; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_crew ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_hourly_checkins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_hourly_checkins ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_payouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_principals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_principals ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_telemetry; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_telemetry ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_telemetry_last; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_telemetry_last ENABLE ROW LEVEL SECURITY;

--
-- Name: mission_waypoints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mission_waypoints ENABLE ROW LEVEL SECURITY;

--
-- Name: missions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: ops_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ops_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: org_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: org_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

--
-- Name: org_workspace_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_workspace_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: org_workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_application_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_application_events ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_application_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_application_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_cpo_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_cpo_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_plan_missions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_plan_missions ENABLE ROW LEVEL SECURITY;

--
-- Name: pro_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pro_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_access_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_access_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_session_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_session_events ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_session_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_session_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_session_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_session_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_session_readiness; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_session_readiness ENABLE ROW LEVEL SECURITY;

--
-- Name: protection_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.protection_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_invite_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_invite_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_referral_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_referral_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: sealed_envelope_archive; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sealed_envelope_archive ENABLE ROW LEVEL SECURITY;

--
-- Name: signal_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signal_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: signal_one_time_prekeys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signal_one_time_prekeys ENABLE ROW LEVEL SECURITY;

--
-- Name: sos_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sos_events ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_processed_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_prices ENABLE ROW LEVEL SECURITY;

--
-- Name: system_broadcasts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_broadcasts ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_device_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_device_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_favorites ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_geofences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_geofences ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_monitoring; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_monitoring ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_sra_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_sra_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: vbg_telemetry_last; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vbg_telemetry_last ENABLE ROW LEVEL SECURITY;

--
-- Name: vehicle_pool; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_pool ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_credit_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_credit_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: wallet_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: objects avatars_anon_insert; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY avatars_anon_insert ON storage.objects FOR INSERT TO authenticated, anon WITH CHECK ((bucket_id = 'avatars'::text));


--
-- Name: objects avatars_anon_update; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY avatars_anon_update ON storage.objects FOR UPDATE TO authenticated, anon USING ((bucket_id = 'avatars'::text)) WITH CHECK ((bucket_id = 'avatars'::text));


--
-- Name: objects avatars_public_read; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY avatars_public_read ON storage.objects FOR SELECT USING ((bucket_id = 'avatars'::text));


--
-- Name: buckets; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets_analytics; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets_analytics ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets_vectors; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets_vectors ENABLE ROW LEVEL SECURITY;

--
-- Name: iceberg_namespaces; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.iceberg_namespaces ENABLE ROW LEVEL SECURITY;

--
-- Name: iceberg_tables; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.iceberg_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: migrations; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads_parts; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: vector_indexes; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.vector_indexes ENABLE ROW LEVEL SECURITY;

--
-- Name: supabase_realtime; Type: PUBLICATION; Schema: -; Owner: -
--

CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete, truncate');


--
-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop
         WHEN TAG IN ('DROP EXTENSION')
   EXECUTE FUNCTION extensions.set_graphql_placeholder();


--
-- Name: issue_pg_cron_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_cron_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_cron_access();


--
-- Name: issue_pg_graphql_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_graphql_access();


--
-- Name: issue_pg_net_access; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_net_access();


--
-- Name: pgrst_ddl_watch; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
   EXECUTE FUNCTION extensions.pgrst_ddl_watch();


--
-- Name: pgrst_drop_watch; Type: EVENT TRIGGER; Schema: -; Owner: -
--

CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop
   EXECUTE FUNCTION extensions.pgrst_drop_watch();


--
-- PostgreSQL database dump complete
--

\unrestrict Qm574yh8RDKpec61Pq9obzzcdexAJGfvdOZv4ZohcXBFmDbATykU1m5jWAdNNae

