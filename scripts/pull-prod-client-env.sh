#!/usr/bin/env bash
#
# pull-prod-client-env.sh — write config/production.env for mobile builds that
# talk to the VPS. Run ON YOUR MAC (uses your SSH access to the box).
#
#     bash scripts/pull-prod-client-env.sh
#
# Every host below is the VPS. The two values that are not URLs — the Supabase
# anon key (minted on the box by setup-supabase.sh) and the sender-cert PUBLIC
# key (minted by make-env.sh) — are read from the box over SSH, so they are
# never retyped. The Mapbox pk. token is the one external dependency that stays
# (tiles), taken from config/staging.env if present.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BOX="${BOX:-root@31.97.126.211}"
OUT=config/production.env

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }

read -r ANON SENDER_PUB < <(ssh "$BOX" '
  a=$(grep -E "^ANON_KEY=" /opt/supabase/.env | cut -d= -f2-);
  s=$(grep -E "^NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=" /opt/bravo/deploy/production/.env | cut -d= -f2-);
  printf "%s %s\n" "$a" "$s"') || die "could not read values from $BOX — has setup-supabase.sh and make-env.sh run there?"
[[ -n "$ANON" ]]       || die "ANON_KEY empty on the box (/opt/supabase/.env)"
[[ -n "$SENDER_PUB" ]] || die "sender-cert public key empty on the box (deploy/production/.env)"
ok "anon key + sender-cert public key read from $BOX"

MAPBOX="$(grep -E '^EXPO_PUBLIC_MAPBOX_TOKEN=' config/staging.env 2>/dev/null | cut -d= -f2- || true)"
[[ -n "$MAPBOX" ]] || echo "  ! no Mapbox token in config/staging.env — set EXPO_PUBLIC_MAPBOX_TOKEN in $OUT by hand"

cat > "$OUT" <<EOF
EXPO_PUBLIC_API_BASE_URL=https://auth.bravosecure.cloud
EXPO_PUBLIC_MSG_BASE_URL=https://relay.bravosecure.cloud
EXPO_PUBLIC_SUPABASE_URL=https://api.bravosecure.cloud
EXPO_PUBLIC_SUPABASE_ANON_KEY=${ANON}
EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=${SENDER_PUB}
EXPO_PUBLIC_MAPBOX_TOKEN=${MAPBOX}
EXPO_PUBLIC_AUTO_DISPATCH=true
EXPO_PUBLIC_DEPT_CHAT_V2=true
EOF
ok "wrote $OUT"
printf '\n  Build against production:\n    npm run android:prod:mac     # debug build + Metro, installed on the connected device/emulator\n    npm run apk:prod:mac         # release APK → android/app/build/outputs/apk/release/\n\n'
