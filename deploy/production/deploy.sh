#!/usr/bin/env bash
#
# deploy.sh — pull the latest commit and roll the app containers, ON THE BOX.
#
#     cd /opt/bravo && bash deploy/production/deploy.sh            # everything
#     cd /opt/bravo && bash deploy/production/deploy.sh ops-console  # one service
#
# Infra containers (redis, minio, coturn) are left alone unless you name them —
# rolling Redis drops every live WebSocket, and rolling coturn drops every call.
# The env files are never touched: they are generated once by make-env.sh and
# re-running that would rotate JWT secrets out from under every signed-in device.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE="docker-compose.prod.yml"
APP_SERVICES=(auth-service messenger-service ops-console)

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

SERVICES=("${@:-${APP_SERVICES[@]}}")

say "Pre-flight"
for f in .env .env.auth .env.messenger; do [[ -f $f ]] || die "$f missing — run ./make-env.sh first"; done
grep -q 'PASTE_' .env .env.auth .env.messenger && die "unfilled PASTE_* placeholders remain in the env files" || ok "env files present, no placeholders"
[[ -f secrets/firebase-service-account.json ]] || die "secrets/firebase-service-account.json missing (FCM push)"
grep -qE '^AUTH_SECOND_FACTOR=totp' .env.auth || die ".env.auth must set AUTH_SECOND_FACTOR=totp — no Twilio here, and production refuses 'sms' without it"
ok "second factor: totp"

say "Update source"
before="$(git -C ../.. rev-parse --short HEAD)"
git -C ../.. pull --ff-only
after="$(git -C ../.. rev-parse --short HEAD)"
ok "$before → $after"

say "Build + roll: ${SERVICES[*]}"
docker compose -f "$COMPOSE" build "${SERVICES[@]}"
docker compose -f "$COMPOSE" up -d "${SERVICES[@]}"

say "Health (waiting up to 90s)"
for i in $(seq 1 18); do
  sleep 5
  unhealthy="$(docker compose -f "$COMPOSE" ps --format '{{.Name}} {{.Health}}' | grep -vE 'healthy|^$' | grep -E "$(IFS='|'; echo "${SERVICES[*]}")" || true)"
  [[ -z "$unhealthy" ]] && break
done
docker compose -f "$COMPOSE" ps
[[ -z "${unhealthy:-}" ]] || die "still unhealthy after 90s:
$unhealthy
  logs:  docker compose -f $COMPOSE logs --tail=100 <service>"

curl -fsS https://auth.bravosecure.cloud/auth/health >/dev/null && ok "auth: /auth/health 200"
[[ "$(curl -s -o /dev/null -w '%{http_code}' https://relay.bravosecure.cloud/envelopes)" == "401" ]] && ok "relay: 401 unauthenticated (alive)"
[[ "$(curl -s -o /dev/null -w '%{http_code}' https://ops.bravosecure.cloud/)" =~ ^30[27]$ ]] && ok "ops: redirects to /login"
say "Deployed $after"
