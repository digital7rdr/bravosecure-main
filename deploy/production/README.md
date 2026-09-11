# Production deployment — bravosecure.cloud (31.97.126.211)

Self-hosted. No Twilio, no Stripe, no hosted Supabase, no cloud object store.
The two third-party pieces that remain are **Firebase FCM** (the only reliable
killed-app wake path on stock Android) and **Mapbox tiles**.

| Concern | Self-hosted with |
| --- | --- |
| Database, PostgREST, auth roles, storage | Supabase (AGPL), `/opt/supabase` |
| Object storage for attachments | MinIO, S3-compatible drop-in |
| TLS | Caddy + Let's Encrypt |
| TURN/STUN | coturn |
| Error tracking | GlitchTip (Sentry-wire-compatible) |
| Login second factor | TOTP (RFC 6238) — no SMS provider |

## 0. DNS — do this first

Caddy cannot issue a certificate for a name that does not resolve, and failed
ACME attempts count against Let's Encrypt rate limits.

```
auth   A  31.97.126.211
relay  A  31.97.126.211
ops    A  31.97.126.211
media  A  31.97.126.211
turn   A  31.97.126.211
api    A  31.97.126.211     # Supabase gateway — the mobile app calls it directly
```

```bash
for h in auth relay ops media turn api; do dig +short $h.bravosecure.cloud; done
```

**All five must sit under `bravosecure.cloud`.** The ops session cookie is
issued with `Domain=.bravosecure.cloud`, so a cookie set by `auth.` is
delivered to `ops.`. Put either on a different apex and console login bounces
to `/login` forever with no error — we hit exactly this failure in reverse
when trying to drive the console from localhost against a remote backend.

## 1. Prepare the box

Source of truth is **github.com/digital7rdr/bravosecure-main**. If the repo is
private, give the box a read-only deploy key first:

```bash
ssh root@31.97.126.211
ssh-keygen -t ed25519 -N '' -f ~/.ssh/bravo-deploy -C "bravo-vps"
cat ~/.ssh/bravo-deploy.pub      # → GitHub repo → Settings → Deploy keys → Add (read-only)
printf 'Host github.com\n  IdentityFile ~/.ssh/bravo-deploy\n' >> ~/.ssh/config
git clone git@github.com:digital7rdr/bravosecure-main.git /opt/bravo
```

If it is public, plain HTTPS is fine:

```bash
git clone https://github.com/digital7rdr/bravosecure-main.git /opt/bravo
```

Then:

```bash
cd /opt/bravo && bash deploy/production/bootstrap.sh
```

Installs Docker + Caddy, opens only 22/80/443/3478/5349/49160-49200, stages
Supabase, and re-checks DNS. It does **not** touch SSH auth — harden that
deliberately, per the note it prints, with a second session open.

## 2–3. Supabase: configure, start, migrate — one script

```bash
bash /opt/bravo/deploy/production/setup-supabase.sh
```

It generates `/opt/supabase/.env` (Postgres password, `JWT_SECRET`, and the
`ANON_KEY` / `SERVICE_ROLE_KEY` JWTs minted from it, dashboard credentials,
`API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL` = `https://api.bravosecure.cloud`,
`DISABLE_SIGNUP=true`), starts the stack, waits for Postgres, applies the
158 migrations in order with `ON_ERROR_STOP`, tracks them in
`public._bravo_migrations` so re-runs only apply new ones, then loads
`seed.sql` (intel-source reference data, no users).

Two things it does that the upstream defaults get wrong on a public box:

- **Docker bypasses ufw.** Published ports are written straight into iptables,
  so upstream's Kong `:8000` and pooler `:5432/:6543` on `0.0.0.0` would be
  open to the internet regardless of the firewall. The script binds all of
  them to `127.0.0.1` (env for Kong and the transaction pooler; a compose
  `!override` for the pooler's `5432`, since `POSTGRES_PORT` is used as a bare
  number in connection strings and can't carry a host prefix) and refuses to
  continue if anything is still on `0.0.0.0`.
- **The example keys are demo keys.** `ANON_KEY`/`SERVICE_ROLE_KEY` are HS256
  JWTs that must be signed by *your* `JWT_SECRET`; the script mints them.

An existing `/opt/supabase/.env` is never regenerated — that would rotate
`JWT_SECRET` and invalidate every anon key already compiled into a client.

Studio is reachable only over a tunnel: `ssh -L 8000:localhost:8000
root@31.97.126.211` → `http://localhost:8000`, dashboard credentials in
`/opt/supabase/.env`.

## 4. Secrets and services

```bash
cd /opt/bravo/deploy/production
./make-env.sh                      # fresh secrets; reads the Supabase creds itself; refuses to overwrite
# ONE placeholder remains — NEXT_PUBLIC_MAPBOX_TOKEN in .env (the pk. token from config/staging.env on your Mac), then:
cp <your>/firebase-service-account.json secrets/
cp Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
journalctl -u caddy -f             # watch all six certs issue, then Ctrl-C
./sync-turn-certs.sh               # coturn needs turn.'s cert BEFORE it starts
(crontab -l 2>/dev/null; echo "17 4 * * * /opt/bravo/deploy/production/sync-turn-certs.sh") | crontab -
docker compose -f docker-compose.prod.yml up -d --build
```

`make-env.sh` writes the sender-cert **public** key into `.env` for the
console build and prints it for the mobile build
(`EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64`). Without it a client falls back to
a DEV authority key and sealed-sender certs do not verify.

### First login — TOTP enrolment

`AUTH_SECOND_FACTOR=totp` is set in `.env.auth`. Create the first ops admin,
then sign in at `https://ops.bravosecure.cloud`:

```bash
docker exec -it bravo-auth node scripts-create-admin.mjs +971501234567 'Str0ngPass!23' OPS-1 ADMIN 'Sudeesh'
```

Because the account has no authenticator yet, the password step returns an
enrolment payload: the console shows a QR, the manual key, and eight backup
codes (shown once). Scan it with any TOTP app, tick "I have saved the backup
codes", enter the 6-digit code — that one verify both confirms the enrolment
and signs you in. Every later login is password + authenticator code.
`scripts-create-admin.mjs` reads `DATABASE_URL` — inside the container that is
the same value auth-service runs with, so no tunnelling is needed.

## 4b. Redeploying after a push

```bash
cd /opt/bravo && bash deploy/production/deploy.sh                 # all three app services
cd /opt/bravo && bash deploy/production/deploy.sh ops-console     # just one
```

`deploy.sh` fast-forwards the checkout, rebuilds only the named services,
rolls them, waits for health, and probes the public URLs. It never touches
the env files or the infra containers — rolling Redis drops every live
WebSocket and rolling coturn drops every call.

## 5. coturn's certificate

TURN-over-TLS on 5349 is the transport that gets calls through networks
blocking UDP, and it needs a real certificate. Caddy owns issuance and renewal;
`sync-turn-certs.sh` copies the current cert into `secrets/coturn-certs/` and
restarts coturn only when it changed. It runs once in §4 before the first
start and daily from cron for renewals (~every 60 days). Without the cron,
TLS-TURN silently expires and only the calls that needed it most start
failing.

## 6. Point the clients at production

Ops-console: already baked by the compose build args. `NEXT_PUBLIC_*` are
build-time — changing one needs `docker compose build ops-console`, not a
restart.

Mobile: the URLs are compiled into the bundle, so this is a **rebuild**, not a
config push. Existing APKs keep talking to staging until replaced.

```
EXPO_PUBLIC_API_BASE_URL=https://auth.bravosecure.cloud
EXPO_PUBLIC_MSG_BASE_URL=https://relay.bravosecure.cloud
EXPO_PUBLIC_SUPABASE_URL=https://api.bravosecure.cloud
EXPO_PUBLIC_SUPABASE_ANON_KEY=<from /opt/supabase/.env>
EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=<printed by make-env.sh>
```

## 7. What is deliberately inert

- **Profile-photo upload.** The mobile app calls a Supabase Edge Function,
  `avatar-upload-url`, whose source was never in this repo — it existed only on
  the old hosted project. Until it is recreated under `supabase/functions/`
  (verify the Bravo JWT via `/auth/me`, return a service-role signed upload
  URL scoped to that user's path), avatar upload fails with
  `avatar_upload_url_failed`. Everything else on the profile works.
- **Error tracking.** `SENTRY_DSN` is blank; auth-service warns at boot that
  dispatch-SLO and money-drift alerts are silent. Stand up GlitchTip and fill
  the DSN when ready — nothing fails closed without it.

- **Wallet top-up and subscriptions.** No PSP, and `ALLOW_NO_STRIPE_TOPUP=1`
  is refused in production because it mints free credits. Bookings that need
  payment will fail; everything else works.
- **App Check** starts `warn-only`. Move to `enforce` once a mobile build
  ships with it, or `/push/*` rejects real devices.

## 8. Verify before announcing

```bash
curl -s https://auth.bravosecure.cloud/auth/health                      # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://relay.bravosecure.cloud/envelopes  # 401 = alive
curl -s -o /dev/null -w '%{http_code}\n' https://ops.bravosecure.cloud/ # 307 → /login
docker compose -f docker-compose.prod.yml ps                            # all healthy
```

TURN is the one thing curl cannot prove. Use `trickle-ice` with the
credentials from `GET /webrtc/turn-credentials` and confirm a **relay**
candidate appears — host and srflx candidates appearing is not evidence TURN
works.

## 9. Backups

Nothing here is backed up by default. Before real data lands:

```bash
docker exec supabase-db pg_dump -U postgres postgres | gzip > /opt/backups/db_$(date +%F).sql.gz
docker run --rm -v bravo_minio-data:/data -v /opt/backups:/b alpine tar czf /b/minio_$(date +%F).tar.gz -C /data .
```

Put both on a schedule and copy them **off this box** — a backup that only
exists on the machine it protects is not a backup.
