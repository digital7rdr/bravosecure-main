# Key Rotation Runbook

Operational procedures for rotating long-lived secret material in production.
Each procedure is designed to minimise client-visible downtime.

---

## 1. Sender-certificate signing key (XEd25519 / Curve25519)

**Where it lives.** `apps/auth-service/src/sender-cert/sender-cert.service.ts`
reads the 32-byte Curve25519 private key from `SENDER_CERT_PRIVATE_KEY_B64`
into process memory at first cert issue. The matching public key is
distributed in the mobile client bundle (and shipped via OTA for ops-console).

**Trigger.**

- Scheduled: every 12 months.
- Incident: any suspicion the private key has been exfiltrated (compromised
  host, leaked env, contractor offboarding without env scrub).

**Pre-flight.**

1. Generate a new keypair locally — never on a shared box:

   ```bash
   node -e "const c = require('@privacyresearch/curve25519-typescript'); \
     (async () => { \
       const w = new c.AsyncCurve25519Wrapper(); \
       const kp = await w.generateKeyPair(); \
       console.log('priv b64 =', Buffer.from(kp.private).toString('base64')); \
       console.log('pub  b64 =', Buffer.from(kp.public).toString('base64')); \
     })();"
   ```

2. Stash both halves in the password manager under
   `sender-cert / <YYYY-MM-DD> / {priv, pub}`. The priv half lives there only
   so we can re-deploy if the env is wiped; it never leaves the password
   manager except through the deploy pipeline.

**Rollout.**

The mobile client verifies certs against a single trusted public key, so
this is a coordinated rotation, not a dual-key handover. Outstanding certs
issued with the old key remain valid until their TTL expires
(`SENDER_CERT_TTL_SECONDS`, default 24h).

1. Ship a new mobile build that ships the **new** public key. Wait until at
   least 95% of MAU is on the new build (check Sentry / RN OTA dashboards).
   Force-update floor stays the previous version for fall-back.
2. Roll auth-service:
   1. Set `SENDER_CERT_PRIVATE_KEY_B64` to the new private key in the prod
      secret store (AWS Secrets Manager / Vault — never .env on disk).
   2. Restart auth-service replicas one at a time
      (`kubectl rollout restart deployment/auth-service`).
   3. The first restarted replica starts minting certs signed with the new
      private key; clients on the new public key verify them successfully.
   4. Old-key certs already in flight remain valid for up to 24h —
      compromise window is bounded by the TTL, not by the rotation moment.
3. After 48h (2× cert TTL), revoke the old key:
   1. Remove `SENDER_CERT_PRIVATE_KEY_B64_PREV` if you kept a fallback.
   2. Bump the version pin on the public key in `packages/messenger-core` so
      a stale client that hadn't updated cannot validate any new cert.

**Verification.**

```bash
# 1. New certs come back signed
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.bravosecure.com/sender-cert -X POST -d '{"...":"..."}' \
  | jq .cert | base64 -d | xxd | head

# 2. Sealed-sender envelopes still deliver
#    (live messages between two test accounts on the new build).
```

**Roll-back.** Re-set `SENDER_CERT_PRIVATE_KEY_B64` to the previous value
and restart. Mobile clients that have already pinned the new public key
will fail to verify; they recover on next build push.

---

## 2. JWT access-token secret (`JWT_ACCESS_SECRET`)

**Where it lives.** `apps/auth-service/src/config/configuration.ts` and the
mirror in `apps/messenger-service/src/config/configuration.ts`. Both services
MUST share the same secret so the messenger gateway can verify access JWTs
issued by auth-service.

**Rollout.**

This is a hard cut — there is no dual-secret support today. Plan for ≤30s
gateway disruption, do it during the lowest-traffic window.

1. Generate a new secret: `openssl rand -base64 64`.
2. Update the secret in the secret store.
3. Roll auth-service AND messenger-service replicas together — same
   deploy. Use `kubectl rollout status` to confirm both reach Ready before
   moving on.
4. All active access tokens become invalid; clients silently rotate via
   refresh-token on the next request. Refresh tokens are unaffected (hashed
   in `auth_devices`, not signed with the access secret).

**Frequency.** Quarterly, or on suspected compromise.

---

## 3. APNs / FCM credentials

**APNs p8 signing key.**

1. Generate a new key at developer.apple.com → Keys → +. Download the .p8
   (you can only download once).
2. Stash in password manager under `apns / <YYYY-MM-DD> / {key-id, team-id, .p8}`.
3. Update `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_PRIVATE_KEY_PATH` in the
   secret store. Mount the p8 contents into the auth-service pod via a
   Kubernetes Secret.
4. Restart auth-service replicas. Old p8 stays valid until you revoke it
   in the Apple console (do that 48h after rollout).

**FCM service account JSON.**

1. console.firebase.google.com → Project Settings → Service accounts → Generate
   new private key. Download the JSON.
2. Stash in password manager under `fcm / <YYYY-MM-DD> / service-account.json`.
3. Update `GOOGLE_APPLICATION_CREDENTIALS` to point at the new file (mount
   via Kubernetes Secret).
4. Restart auth-service.
5. After 7 days, revoke the previous service account key from the Firebase
   console.

**Frequency.** Annually for both. Revoke promptly if a contractor with cert
access offboards.

---

## 4. TURN shared secret (`TURN_STATIC_AUTH_SECRET`)

**Where it lives.** Both messenger-service env AND coturn config (`static-auth-secret`
in `/etc/turnserver.conf`). Both halves must rotate atomically — coturn HMACs
the username against the secret, messenger-service signs the same way.

**Rollout.**

1. Generate: `openssl rand -hex 32`.
2. Edit `/etc/turnserver.conf` on each coturn box to add the new secret as a
   second `static-auth-secret` line (coturn accepts multiple).
3. `systemctl reload coturn` on each box (no connection drop — coturn
   re-reads config in place).
4. Update `TURN_STATIC_AUTH_SECRET` in the messenger-service secret store.
5. Restart messenger-service replicas. New TURN credentials issued by
   `/webrtc/turn-credentials` are signed with the new secret; coturn
   accepts them via the new line.
6. After 25h (≥1× credential TTL), remove the old `static-auth-secret`
   line from `/etc/turnserver.conf` and `systemctl reload coturn` again.

**Frequency.** Annually. Tied to coturn maintenance windows since both
services restart.

---

## 5. Database connection strings

Standard practice: rotate the password in RDS / Supabase, update
`DATABASE_URL` in the secret store, rolling-restart auth-service. No
client-visible downtime.

---

## Audit trail

Every rotation MUST log:

- Date
- Operator (initials)
- Reason (scheduled / incident)
- New key fingerprint (sha256 of public material, first 16 hex)
- Roll-out duration
- Verification steps performed

Drop the entry in `docs/rotations.log` (append-only, committed to repo
with the PR that bumps the rotation date).
