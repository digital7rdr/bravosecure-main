#!/usr/bin/env bash
#
# make-env.sh — generate production env files with fresh secrets, ON THE BOX.
#
# Run once, on 31.97.126.211, from deploy/production/. It writes .env,
# .env.auth and .env.messenger (all gitignored) and NEVER overwrites an
# existing one — re-running after the stack is live would rotate JWT secrets
# out from under every signed-in device.
#
# Secrets are generated here, not committed and not carried over from staging.
# Staging secrets have been through CI logs and shared configs; production
# starts clean. The ONE thing carried over is the Firebase service account,
# which is a project credential rather than an environment secret.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }

for f in .env .env.auth .env.messenger; do
  [[ -e "$f" ]] && die "$f already exists — refusing to regenerate (that would rotate live JWT secrets and sign out every device). Edit it by hand, or move it aside deliberately."
done

command -v openssl >/dev/null || die "openssl not found"

# Supabase values come straight from the file setup-supabase.sh generated —
# no copy-paste of a 200-char service-role key through a terminal.
SB_ENV=/opt/supabase/.env
if [[ -f "$SB_ENV" ]]; then
  sbget() { grep -E "^$1=" "$SB_ENV" | head -1 | cut -d= -f2-; }
  SB_DB_PASSWORD="$(sbget POSTGRES_PASSWORD)"
  SB_SERVICE_ROLE="$(sbget SERVICE_ROLE_KEY)"
  SB_ANON="$(sbget ANON_KEY)"
  [[ -n "$SB_DB_PASSWORD" && -n "$SB_SERVICE_ROLE" ]] || die "$SB_ENV exists but lacks POSTGRES_PASSWORD/SERVICE_ROLE_KEY — run setup-supabase.sh first"
  ok "Supabase credentials read from $SB_ENV"
else
  SB_DB_PASSWORD="PASTE_SUPABASE_DB_PASSWORD"; SB_SERVICE_ROLE="PASTE_SUPABASE_SERVICE_ROLE_KEY"; SB_ANON="PASTE_SUPABASE_ANON_KEY"
  warn "$SB_ENV not found — Supabase values left as PASTE_* placeholders"
fi

gen()    { openssl rand -base64 36 | tr -d '\n/+=' | head -c 48; }
genhex() { openssl rand -hex 32; }

JWT_ACCESS="$(gen)"
JWT_ACTION="$(gen)"
TOTP_KEY="$(genhex)"          # 64 hex = AES-256; prod fails closed without it
REDIS_PW="$(gen)"
TURN_SECRET="$(gen)"
MINIO_USER="bravo-$(openssl rand -hex 4)"
MINIO_PW="$(gen)"

# ── Sender-cert keypair (XEd25519 over Curve25519) ────────────────────────
# auth-service signs sealed-sender certs with the private half; every client
# verifies with the public half. Generated here so the private half never
# leaves the box.
echo "Generating sender-cert keypair…"
npm --prefix /tmp init -y >/dev/null 2>&1 || true
npm --prefix /tmp install @privacyresearch/curve25519-typescript >/dev/null 2>&1 \
  || die "could not install curve25519 lib to generate the sender-cert keypair"
read -r SENDER_PRIV SENDER_PUB < <(node -e '
const {AsyncCurve25519Wrapper} = require("/tmp/node_modules/@privacyresearch/curve25519-typescript");
const w = new AsyncCurve25519Wrapper();
const s = require("crypto").randomBytes(32);
w.keyPair(s.buffer.slice(s.byteOffset, s.byteOffset + 32)).then(k =>
  console.log(Buffer.from(k.privKey).toString("base64"), Buffer.from(k.pubKey).toString("base64")));
')
[[ -n "$SENDER_PRIV" && -n "$SENDER_PUB" ]] || die "sender-cert keypair generation produced nothing"
ok "sender-cert keypair generated"

# ── .env — consumed by docker-compose.prod.yml itself ─────────────────────
cat > .env <<EOF
# Compose-level values. Interpolated into docker-compose.prod.yml.
REDIS_PASSWORD=${REDIS_PW}
TURN_STATIC_AUTH_SECRET=${TURN_SECRET}
MINIO_ROOT_USER=${MINIO_USER}
MINIO_ROOT_PASSWORD=${MINIO_PW}

# Mapbox public token (pk.). Client-side and URL-restricted in the Mapbox
# dashboard — not a secret, but it IS baked into the ops-console bundle at
# build time, so changing it needs a rebuild.
NEXT_PUBLIC_MAPBOX_TOKEN=PASTE_PK_TOKEN
NEXT_PUBLIC_MAPBOX_STYLE=mapbox://styles/mapbox/navigation-night-v1

# Public half of the sender-cert keypair (private half is in .env.auth). Baked
# into the ops-console bundle at build time; the mobile build needs the same
# value as EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64.
NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=${SENDER_PUB}
EOF
ok ".env"

# ── .env.auth ─────────────────────────────────────────────────────────────
cat > .env.auth <<EOF
NODE_ENV=production
PORT=3001

# Self-hosted Supabase Postgres (joined via the supabase_default network).
DATABASE_URL=postgresql://postgres:${SB_DB_PASSWORD}@supabase-db:5432/postgres
REDIS_URL=redis://:${REDIS_PW}@redis:6379

# The ops-console origin. An EMPTY value yields origin:false in main.ts — CORS
# off entirely, which the browser reports as a bare "Failed to fetch". In
# production an empty value refuses to boot instead.
CORS_ALLOWED_ORIGINS=https://ops.bravosecure.cloud

# Parent domain so a cookie set by auth. is delivered to ops.. This is the
# whole reason both live under bravosecure.cloud.
COOKIE_DOMAIN=.bravosecure.cloud

JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_ACTION_SECRET=${JWT_ACTION}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
JWT_ISSUER=auth-service
JWT_AUDIENCE=bravo-api
JWT_ACTION_AUDIENCE=bravo-action

# Login second factor. 'totp' = authenticator app, no SMS provider. With
# 'sms' and no Twilio, main.ts refuses to boot (devFlag() has already forced
# the OTP dev-bypass off in production, so 'sms' would mean nobody can log in).
AUTH_SECOND_FACTOR=totp

# TOTP is the login second factor here — no SMS provider. 64 hex = AES-256 for
# sealing TOTP seeds at rest; production fails closed without it.
TOTP_ENCRYPTION_KEY=${TOTP_KEY}
TOTP_ISSUER=Bravo Secure

OTP_LENGTH=6
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=3

# DELIBERATELY ABSENT — main.ts refuses to start in production if any of
# OTP_DEV_BYPASS / BIOMETRIC_DEV_BYPASS / OTP_DEV_RETURN_CODE /
# DISPATCH_TRUST_MOCKED_LOCATION / DISPATCH_DISABLE_REGION_FILTER is 'true',
# and devFlag() force-disables them regardless. Do not add them here.

# No Twilio: OTP-over-SMS is replaced by TOTP. Leaving these blank is correct.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
TWILIO_VERIFY_SID=

# No Stripe. ALLOW_NO_STRIPE_TOPUP must NOT be set to 1 — in production that
# is a free-credit printer and main.ts refuses to start. Wallet top-up and
# subscriptions are therefore inert; see README §7.
STRIPE_SECRET_KEY=

SENDER_CERT_PRIVATE_KEY_B64=${SENDER_PRIV}
SENDER_CERT_TTL_SECONDS=86400
SENDER_CERT_ISSUER=auth-service

# Optional. Leave blank until GlitchTip (self-hosted, Sentry-compatible) is
# stood up — auth-service then WARNS at boot that dispatch SLO / money-drift
# alerts are silent, but nothing fails closed. Fill with the GlitchTip DSN later.
SENTRY_DSN=

ANDROID_PACKAGE_NAME=com.bravosecure
RATE_LIMIT_AUTH_PER_HOUR=5
DEPT_CHAT_V2_ENABLED=true
DISPATCH_REQUIRE_IDENTITY_HANDSHAKE=false
DISPATCH_REQUIRE_LIVE_MOVEMENT=false
DISPATCH_MIN_LIVE_MOVEMENT_M=25
EOF
ok ".env.auth"

# ── .env.messenger ────────────────────────────────────────────────────────
cat > .env.messenger <<EOF
NODE_ENV=production
PORT=3100

# MUST be byte-identical to .env.auth or every relay request 401s.
JWT_ACCESS_SECRET=${JWT_ACCESS}
JWT_ACTION_SECRET=${JWT_ACTION}
JWT_ISSUER=auth-service
JWT_AUDIENCE=bravo-api
JWT_ACTION_AUDIENCE=bravo-action

REDIS_URL=redis://:${REDIS_PW}@redis:6379

# UNSET under NODE_ENV=production means /push/* FAILS CLOSED with 401.
# 'enforce' once the mobile build ships App Check; 'warn-only' until then.
APP_CHECK_MODE=warn-only

RELAY_DWELL_SECONDS=2592000
RELAY_MAX_PULL_LIMIT=100
RELAY_MAX_CIPHERTEXT_BYTES=262144

WS_HEARTBEAT_MS=30000
# MUST stay >= 25000 — at 10000 a late pong under relay latency reaped the
# socket and dropped every participant of a live call at once (sqa.md B-05).
WS_HEARTBEAT_GRACE=25000
WS_SESSION_RECOVERY=false

TURN_STATIC_AUTH_SECRET=${TURN_SECRET}
TURN_TTL_SECONDS=86400
# Ship BOTH transports — many corporate/hotel/mobile networks block outbound
# UDP to non-443 ports, and TCP is the only path that reaches coturn there.
TURN_URLS=turn:turn.bravosecure.cloud:3478?transport=udp,turn:turn.bravosecure.cloud:3478?transport=tcp,turns:turn.bravosecure.cloud:5349?transport=tcp
TURN_STUN_URLS=stun:turn.bravosecure.cloud:3478

# MinIO replaces Cloudflare R2. Internal endpoint for the SDK; presigned URLs
# are signed over MINIO_SERVER_URL (https://media.bravosecure.cloud) so the
# phone can fetch them.
MEDIA_S3_ENDPOINT=http://minio:9000
MEDIA_S3_BUCKET=bravo-messenger-media
MEDIA_S3_REGION=us-east-1
MEDIA_S3_ACCESS_KEY_ID=${MINIO_USER}
MEDIA_S3_SECRET_ACCESS_KEY=${MINIO_PW}
MEDIA_S3_FORCE_PATH_STYLE=true
MEDIA_PRESIGN_TTL_SECONDS=300
MEDIA_MAX_UPLOAD_BYTES=52428800

# Self-hosted Supabase, reached over the shared docker network. Service-role
# key bypasses RLS — required for encrypted backup + privacy sweeps, and in
# production the service refuses to boot without both.
SUPABASE_URL=http://supabase-envoy:8000
SUPABASE_SERVICE_ROLE_KEY=${SB_SERVICE_ROLE}

# FCM — the only reliable killed-app wake path on stock Android.
GOOGLE_APPLICATION_CREDENTIALS=/app/firebase-service-account.json
APNS_VOIP_BUNDLE_ID=com.bravosecure.mobile

SENTRY_DSN=
EOF
ok ".env.messenger"

chmod 600 .env .env.auth .env.messenger
echo
printf '\033[1mGenerated. Now fill every PASTE_* placeholder:\033[0m\n'
grep -n 'PASTE_' .env .env.auth .env.messenger || true
echo
printf '\033[1mValues the MOBILE build needs (EXPO_PUBLIC_*):\033[0m\n'
printf '  EXPO_PUBLIC_SUPABASE_URL=https://api.bravosecure.cloud\n'
printf '  EXPO_PUBLIC_SUPABASE_ANON_KEY=%s\n' "$SB_ANON"
printf '\033[1mSender-cert PUBLIC key — needed by the mobile app and ops-console builds:\033[0m\n'
printf '  %s\n' "$SENDER_PUB"
printf '  (mobile: EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64, ops: NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64)\n'
