# Database Backup & Restore — Supabase Cloud

**Scope:** the Bravo Secure system of record — Supabase project `qkkfkicgoncxslbwhyhz`.

> This runbook covers the **database**. It is not the same thing as
> [`BACKUP_LOOP.md`](BACKUP_LOOP.md), which covers users' end-to-end-encrypted
> _message_ archives. A green backup-loop run is **not** a database backup, and
> restoring the database does not restore a user's message history.
>
> The legacy self-hosted instance on Contabo (`bravo-staging-pg`) is covered by
> [`CONTABO_MIGRATION_GUIDE.md`](CONTABO_MIGRATION_GUIDE.md) §6.6. It is not the
> system of record.

---

## 1. What protects the database today

| Layer                                | Mechanism                                                                                 | Owner    |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | -------- |
| Automated daily backup               | Supabase platform, retention per plan                                                     | Supabase |
| Point-in-time recovery (PITR)        | Supabase add-on — **confirm whether it is enabled** in Dashboard → Database → Backups     | Supabase |
| On-demand logical backup             | `supabase db dump` — §3 below                                                             | Bravo    |
| Object storage (avatars, KYC, media) | Supabase Storage — **not** included in any `pg_dump`                                      | §5       |
| Schema definition                    | `supabase/migrations/**` in git — 148 migrations, rebuilds an empty database from scratch | Bravo    |

**The schema is always recoverable from git.** What only exists in the database is
_data_, so the procedures below are about data.

---

## 2. One-time setup

```bash
npx supabase login                                     # opens a browser
npx supabase link --project-ref qkkfkicgoncxslbwhyhz   # prompts for the DB password
```

The DB password is in **Dashboard → Project Settings → Database**. It is also stored
as the `SUPABASE_DB_PASSWORD` GitHub Actions secret used by
`.github/workflows/deploy-migrations.yml`.

---

## 3. Taking an on-demand backup

Run before every risky operation: a destructive migration, a bulk data fix, or a
platform upgrade.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p ~/bravo-backups

# 3a. Schema only — every schema, not just public.
npx supabase db dump --linked -f ~/bravo-backups/schema_$STAMP.sql \
  --schema public,auth,storage,graphql,vault,net,supabase_functions

# 3b. Data only — the half that git cannot rebuild.
npx supabase db dump --linked --data-only --use-copy \
  -f ~/bravo-backups/data_$STAMP.sql

# 3c. Roles.
npx supabase db dump --linked --role-only -f ~/bravo-backups/roles_$STAMP.sql
```

Verify before trusting it:

```bash
grep -c '^CREATE TABLE' ~/bravo-backups/schema_$STAMP.sql   # expect ~139
ls -lh ~/bravo-backups/*_$STAMP.sql                          # none should be ~0 bytes
tail -2 ~/bravo-backups/schema_$STAMP.sql                    # must end "PostgreSQL database dump complete"
```

> A dump that ends without that trailer was truncated. Do not proceed on it.

**Store the dumps off the machine that produced them.** They contain every user
record, so treat them as production data: encrypted at rest, access-logged, deleted
on a schedule.

---

## 4. Restore

### 4a. Platform restore — the normal path

**Dashboard → Database → Backups → Restore.** Supabase restores the whole project
to the chosen point. This is the correct choice for accidental mass deletion or
corruption.

Restoring is **destructive and not reversible** — it replaces current state. Take a
fresh §3 dump first, even in an incident, so the pre-restore state is recoverable.

### 4b. Logical restore into a fresh project — DR / verification

Use when the project itself is lost, or to rehearse (§6).

```bash
# 1. Create a new Supabase project, then:
npx supabase link --project-ref <new-ref>

# 2. Schema first, then data.
psql "<new-connection-string>" -v ON_ERROR_STOP=1 -f ~/bravo-backups/schema_<STAMP>.sql
psql "<new-connection-string>" -v ON_ERROR_STOP=1 -f ~/bravo-backups/data_<STAMP>.sql

# 3. Confirm the migration ledger came across, then repoint services.
psql "<new-connection-string>" -c "select count(*) from supabase_migrations.schema_migrations"
```

### 4c. Rebuilding schema only, from git

For a clean environment with no data to preserve:

```bash
npx supabase db reset --linked      # DESTRUCTIVE — drops everything, replays all migrations
```

Locally, the same command against the local stack is the standard way to get a
correct empty database:

```bash
npx supabase start && npx supabase db reset
```

---

## 5. Storage buckets are not in the dump

`pg_dump` captures the `storage.objects` **metadata rows**, not the file bytes.
Avatars, KYC documents and message media live in Supabase Storage and need their own
copy:

```bash
# Requires the S3-protocol credentials from Dashboard -> Project Settings -> Storage
aws s3 sync s3://<bucket> ~/bravo-backups/storage_$STAMP/ \
  --endpoint-url https://qkkfkicgoncxslbwhyhz.supabase.co/storage/v1/s3
```

A database restore without the matching storage copy leaves rows pointing at objects
that no longer exist — profile photos and KYC documents 404.

---

## 6. Restore rehearsal — do this quarterly

A backup that has never been restored is a hypothesis. Once a quarter:

1. Take a §3 dump.
2. Restore it into a scratch Supabase project (§4b).
3. Check the shape matches:
   ```sql
   select count(*) from pg_tables where schemaname = 'public';        -- expect 104 (103 app + PostGIS spatial_ref_sys)
   select count(*) from supabase_migrations.schema_migrations;        -- must match the source dump
   -- Deny-by-default invariant. The pg_depend clause excludes extension-owned
   -- relations (PostGIS's spatial_ref_sys); without it this returns 1, not 0.
   select count(*) from pg_class c where c.relnamespace='public'::regnamespace
     and c.relkind in ('r','p') and not c.relrowsecurity
     and not exists (select 1 from pg_depend d
                      where d.objid = c.oid and d.deptype = 'e');     -- expect 0
   ```
4. Point a staging `auth-service` at it and complete one booking end to end.
5. Delete the scratch project.
6. Record the date and outcome in the table below.

| Date                  | Performed by | Dump used | Result |
| --------------------- | ------------ | --------- | ------ |
| _(not yet rehearsed)_ |              |           |        |

---

## 7. Before any destructive migration

1. Take a §3 dump and verify the trailer.
2. Confirm the tree and the live database agree:
   ```bash
   npx supabase db diff --linked --schema public     # empty output == no drift
   ```
   Non-empty output means someone changed the live database out of band. Write those
   changes back as a migration **before** deploying anything new on top of them.
3. Apply with `npx supabase db push --include-all`.
4. Re-run the diff. It should be empty again.
