#!/usr/bin/env bash
#
# setup-supabase.sh — configure, start and migrate the self-hosted Supabase
# stack at /opt/supabase. Run ON THE BOX as root, after bootstrap.sh:
#
#     bash /opt/bravo/deploy/production/setup-supabase.sh
#
# Idempotent: an existing /opt/supabase/.env is NEVER regenerated (that would
# rotate JWT_SECRET and invalidate every ANON_KEY/SERVICE_ROLE_KEY already baked
# into clients). Migrations are tracked in a table so re-runs only apply new ones.
#
# WHAT IT FIXES THAT THE UPSTREAM DEFAULTS GET WRONG FOR A PUBLIC BOX
#   • Docker publishes ports by writing iptables rules directly — ufw does NOT
#     apply to them. Upstream publishes Kong :8000 and the Postgres pooler
#     :5432/:6543 on 0.0.0.0, i.e. to the whole internet. This binds all of
#     them to 127.0.0.1; Caddy is the only public path (api.bravosecure.cloud,
#     five API prefixes only).
#   • ANON_KEY / SERVICE_ROLE_KEY are JWTs that must be signed by JWT_SECRET.
#     The example file ships demo keys signed by a demo secret. Minted here.
#   • API_EXTERNAL_URL / SUPABASE_PUBLIC_URL are baked into the URLs GoTrue and
#     Storage return — wrong values surface as broken links on phones.
set -euo pipefail

SB=/opt/supabase
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLIC_URL="https://api.bravosecure.cloud"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ -f "$SB/docker-compose.yml" ]] || die "$SB not staged — run bootstrap.sh first"
command -v docker >/dev/null || die "docker missing — run bootstrap.sh first"

gen()    { openssl rand -base64 48 | tr -d '\n/+=' | head -c 40; }
b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
mint_jwt() {  # $1 role, $2 secret — HS256, 10-year expiry, same claims Supabase uses
  local hdr pl sig iat exp
  iat=$(date +%s); exp=$((iat + 10*365*24*3600))
  hdr=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  pl=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$1" "$iat" "$exp" | b64url)
  sig=$(printf '%s.%s' "$hdr" "$pl" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
  printf '%s.%s.%s' "$hdr" "$pl" "$sig"
}
setkv() {  # $1 key $2 value — replace in .env or append if the key is absent
  if grep -qE "^$1=" "$SB/.env"; then
    sed -i "s|^$1=.*|$1=$2|" "$SB/.env"
  else
    printf '%s=%s\n' "$1" "$2" >> "$SB/.env"
  fi
}

# ── 1. .env ───────────────────────────────────────────────────────────────
say "Supabase .env"
if [[ -f "$SB/.env" ]] && grep -q '^BRAVO_GENERATED=' "$SB/.env"; then
  ok "already generated — leaving secrets alone"
else
  cp "$SB/.env.example" "$SB/.env"
  JWT_SECRET="$(openssl rand -hex 32)"     # ≥32 chars required by GoTrue
  setkv POSTGRES_PASSWORD           "$(gen)"
  setkv JWT_SECRET                  "$JWT_SECRET"
  setkv ANON_KEY                    "$(mint_jwt anon "$JWT_SECRET")"
  setkv SERVICE_ROLE_KEY            "$(mint_jwt service_role "$JWT_SECRET")"
  setkv DASHBOARD_USERNAME          "bravo-admin"
  setkv DASHBOARD_PASSWORD          "$(gen)"
  setkv SECRET_KEY_BASE             "$(openssl rand -hex 32)"
  setkv VAULT_ENC_KEY               "$(openssl rand -hex 16)"   # exactly 32 chars
  setkv S3_PROTOCOL_ACCESS_KEY_ID   "$(openssl rand -hex 16)"
  setkv S3_PROTOCOL_ACCESS_KEY_SECRET "$(openssl rand -hex 32)"
  setkv POOLER_TENANT_ID            "bravo"
  setkv SITE_URL                    "https://ops.bravosecure.cloud"
  setkv API_EXTERNAL_URL            "$PUBLIC_URL"
  setkv SUPABASE_PUBLIC_URL         "$PUBLIC_URL"
  # Accounts are created by auth-service, never by GoTrue self-signup on a
  # public endpoint.
  setkv DISABLE_SIGNUP              "true"
  # Loopback-only publishing (see header). These two vars appear ONLY in the
  # `ports:` lines, so a host prefix is valid here; POSTGRES_PORT is used as a
  # bare number in connection strings and is handled by the override below.
  setkv KONG_HTTP_PORT              "127.0.0.1:8000"
  setkv KONG_HTTPS_PORT             "127.0.0.1:8443"
  setkv POOLER_PROXY_PORT_TRANSACTION "127.0.0.1:6543"
  setkv BRAVO_GENERATED             "$(date -u +%FT%TZ)"
  chmod 600 "$SB/.env"
  ok "generated (JWT_SECRET, anon + service_role keys, dashboard creds, public URLs)"
fi

# ── 2. loopback override for the pooler's 5432 ────────────────────────────
cat > "$SB/docker-compose.override.yml" <<'YAML'
# Written by deploy/production/setup-supabase.sh — bind the pooler to loopback.
# `!override` REPLACES the upstream ports list (a plain `ports:` would append,
# leaving the 0.0.0.0 binding in place). Requires Compose v2.24+.
services:
  supavisor:
    ports: !override
      - "127.0.0.1:5432:5432"
      - "127.0.0.1:6543:6543"
YAML
ok "override: pooler on 127.0.0.1 only"

# ── 3. up ─────────────────────────────────────────────────────────────────
say "Starting Supabase"
( cd "$SB" && docker compose pull -q && docker compose up -d )
printf '  waiting for supabase-db '
for i in $(seq 1 60); do
  if docker exec supabase-db pg_isready -U postgres -q 2>/dev/null; then echo; ok "postgres ready"; break; fi
  printf '.'; sleep 3
  [[ $i -eq 60 ]] && die "postgres not ready after 3 min — docker compose -f $SB/docker-compose.yml logs db"
done
say "Published ports (must all be 127.0.0.1)"
docker compose -f "$SB/docker-compose.yml" ps --format '{{.Name}}  {{.Ports}}' | grep -E '0\.0\.0\.0|:::' \
  && die "something is still published on 0.0.0.0 — see above; Docker bypasses ufw" \
  || ok "nothing on 0.0.0.0"

# ── 4. migrations, tracked so re-runs are safe ────────────────────────────
say "Migrations"
PSQL=(docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres)
"${PSQL[@]}" <<'SQL'
CREATE TABLE IF NOT EXISTS public._bravo_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
SQL
applied=0; skipped=0
for f in "$REPO"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  if "${PSQL[@]}" -tAc "SELECT 1 FROM public._bravo_migrations WHERE filename='$name'" | grep -q 1; then
    skipped=$((skipped+1)); continue
  fi
  printf '  → %s\n' "$name"
  if "${PSQL[@]}" < "$f"; then
    "${PSQL[@]}" -c "INSERT INTO public._bravo_migrations(filename) VALUES ('$name')"
    applied=$((applied+1))
  else
    die "migration FAILED: $name — nothing after it was applied. Fix and re-run; earlier ones are recorded and will be skipped."
  fi
done
ok "$applied applied, $skipped already present"

if [[ -f "$REPO/supabase/seed.sql" && "${SEED:-1}" == "1" ]]; then
  if "${PSQL[@]}" -tAc "SELECT 1 FROM public._bravo_migrations WHERE filename='seed.sql'" | grep -q 1; then
    ok "seed.sql already applied"
  else
    say "Reference data (supabase/seed.sql — intel sources; no users)"
    "${PSQL[@]}" < "$REPO/supabase/seed.sql" && "${PSQL[@]}" -c "INSERT INTO public._bravo_migrations(filename) VALUES ('seed.sql')"
    ok "seeded"
  fi
fi

say "Done"
printf '  Studio (tunnel only):  ssh -L 8000:localhost:8000 root@31.97.126.211  →  http://localhost:8000\n'
printf '  Dashboard login:       %s / (DASHBOARD_PASSWORD in %s/.env)\n' "$(grep ^DASHBOARD_USERNAME= "$SB/.env" | cut -d= -f2)" "$SB"
printf '  make-env.sh will read POSTGRES_PASSWORD, ANON_KEY and SERVICE_ROLE_KEY from %s/.env automatically.\n\n' "$SB"
