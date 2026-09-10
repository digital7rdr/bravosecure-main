# Ops console on macOS — local stack

`apps/ops-console` is a **Next.js 15 web app** (port 3002), not an Electron/Tauri binary —
"desktop-first" in its package description means a desktop-sized browser UI.

## Why it cannot run against the hosted staging backend

Pointing `NEXT_PUBLIC_API_BASE_URL` at `https://auth.94-136-184-52.sslip.io` from
`http://localhost:3002` fails for **three** independent reasons, only the first of which is
visible as an error:

1. **CORS.** `apps/auth-service/src/main.ts` allowlists origins from `CORS_ALLOWED_ORIGINS`.
   Staging lists the deployed console, not localhost. The browser reports `Failed to fetch`.
   Note the client uses `credentials: 'include'`, so a wildcard cannot help — the server must
   echo the exact origin.
2. **Cookie domain.** `tokenCookieOptions` in `auth/auth.controller.ts` sets
   `Domain=$COOKIE_DOMAIN`, which is `.94-136-184-52.sslip.io` on staging. A browser on
   `localhost` rejects that cookie, so login "succeeds" and then bounces back to `/login`
   forever.
3. **SameSite=Lax.** Even a stored cookie would not be sent on cross-site XHR.

The code states the intent directly: *"Unset → no Domain attribute (host-only), which is
correct for local dev where everything runs on localhost."* So local dev means a local backend.

## ⚠ Empty `CORS_ALLOWED_ORIGINS` fails CLOSED

```js
origin: wildcard ? '*' : (corsOrigins.length > 0 ? corsOrigins : false)
```

An unset or empty value yields `origin: false` — CORS disabled entirely. The browser then shows
the same bare `Failed to fetch` you get from a wrong host, so it is easy to misread as "the
backend is down". `apps/auth-service/.env.example` does **not** include this key; the generated
`.env` does.

## Bring the stack up

Four terminals, left running. Docker Desktop must be up first.

```bash
# 1 — Postgres + PostgREST + Studio (54321 / 54322 / 54323)
cd ~/Projects/Bravo_Secure-main
npx supabase start

# 2 — Redis on 6379 (both services are configured for 6379; the .env.example's
#     7379 is a Windows Hyper-V workaround, not needed on macOS)
brew install redis
redis-server --port 6379

# 3 — auth-service on :3001
cd ~/Projects/Bravo_Secure-main/apps/auth-service
npm install
npm run start:dev

# 4 — messenger-service on :3100
cd ~/Projects/Bravo_Secure-main/apps/messenger-service
npm install
npm run start:dev
```

Health checks:

```bash
curl http://127.0.0.1:3001/auth/health                                   # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/envelopes # 401 = alive
redis-cli -p 6379 ping                                                   # PONG
```

The auth-service boot line prints its CORS state — confirm it says
`cors_origins=http://localhost:3002` and not `none`.

## Create an ops admin

The local database starts empty, so staging credentials will not work here. The console login
needs an `admin_users` row bound to a `users` row:

```bash
cd ~/Projects/Bravo_Secure-main/apps/auth-service
node scripts-create-admin.mjs +971501234567 'Str0ngPass!23' OPS-1 ADMIN 'Sudeesh'
#                              <phone E.164>  <password>     <call sign> <role> <display name>
```

Roles: `OPS` | `SUPERVISOR` | `ADMIN`. The script connects directly to the local Postgres on
54322 (hardcoded), so Supabase must be running first. Re-running updates the role/display name
but never overwrites an existing password.

## Run the console

```bash
cd ~/Projects/Bravo_Secure-main/apps/ops-console
npm install
npm run dev          # http://localhost:3002
```

`apps/ops-console/.env.local` already points at `http://localhost:3001` / `:3100`.
**Restart `npm run dev` after any change to it** — Next.js reads env at server start.

Log in with the phone + password from the admin script. On the OTP step, `OTP_DEV_RETURN_CODE=true`
means the code comes back in the response rather than by SMS.

## Known gaps in this local setup

- `NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` and `SENDER_CERT_PRIVATE_KEY_B64` are both blank, so
  the `/messenger` page falls back to a DEV authority key with a console warning. Generate a
  pair with the snippet in `apps/auth-service/.env.example` and set both halves if you need
  sealed-sender verification.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` on messenger-service are blank, so encrypted
  backup and the privacy sweeps log `backup.disabled` / `privacy.disabled` and no-op. Fill from
  `npx supabase status` if you need those features.
- No S3/R2 credentials, so media attachment presign will fail.
- `RATE_LIMIT_AUTH_PER_HOUR` is raised to 100 locally so repeated login testing doesn't lock you
  out (the template ships 5).
