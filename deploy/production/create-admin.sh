#!/usr/bin/env bash
#
# create-admin.sh — create (or re-bind) an ops-console admin, ON THE BOX.
#
#     ./create-admin.sh +971501234567                        # ADMIN, generated password, call sign OPS-1
#     ./create-admin.sh +971501234567 'MyOwnPassword!23'     # your own password
#     ./create-admin.sh +971501234567 '' OPS-2 SUPERVISOR 'Night shift'
#
# Why there is no default username/password in the repo: a known credential on
# the admin console of a security product is the first thing an attacker tries.
# This generates one on the box and prints it ONCE — nothing is stored outside
# the database (argon2-hashed), and the first login forces authenticator (TOTP)
# enrolment, so the password alone never opens the console.
#
# Re-running for an existing phone re-binds role/call sign but never overwrites
# the stored password (scripts-create-admin.mjs refuses to).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PHONE="${1:-}"; PASSWORD="${2:-}"; CALLSIGN="${3:-OPS-1}"; ROLE="${4:-ADMIN}"; NAME="${5:-Ops Admin}"

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[[ "$PHONE" =~ ^\+[0-9]{7,15}$ ]] || die "usage: $0 <phone E.164 e.g. +971501234567> [password] [call_sign] [OPS|SUPERVISOR|ADMIN] [display name]"
docker inspect -f '{{.State.Running}}' bravo-auth 2>/dev/null | grep -q true || die "bravo-auth is not running — docker compose -f docker-compose.prod.yml up -d first"

generated=0
if [[ -z "$PASSWORD" ]]; then
  # 4 words × 4 letters + digits: easy to type on a phone, ~50 bits, no ambiguous glyphs
  PASSWORD="$(tr -dc 'a-hj-km-np-z2-9' </dev/urandom | head -c 4)-$(tr -dc 'a-hj-km-np-z2-9' </dev/urandom | head -c 4)-$(tr -dc 'a-hj-km-np-z2-9' </dev/urandom | head -c 4)-$(tr -dc '2-9' </dev/urandom | head -c 4)"
  generated=1
fi
[[ ${#PASSWORD} -ge 12 ]] || die "password must be at least 12 characters"

docker exec bravo-auth node scripts-create-admin.mjs "$PHONE" "$PASSWORD" "$CALLSIGN" "$ROLE" "$NAME"

printf '\n\033[1mOps console login — https://ops.bravosecure.cloud\033[0m\n'
printf '  Phone:     %s\n' "$PHONE"
if [[ $generated -eq 1 ]]; then
  printf '  Password:  %s      ← shown once; not stored anywhere in plain text\n' "$PASSWORD"
else
  printf '  Password:  (the one you supplied)\n'
fi
printf '  Role:      %s   Call sign: %s\n' "$ROLE" "$CALLSIGN"
printf '\n  First login shows an authenticator QR. Scan it (Google Authenticator, Aegis, 1Password…),\n'
printf '  save the 8 backup codes, enter the 6-digit code — that enrols the second factor and signs you in.\n\n'
