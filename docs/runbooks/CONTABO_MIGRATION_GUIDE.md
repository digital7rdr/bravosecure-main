# Migrating Bravo Secure Staging from AWS EC2 → Contabo (Singapore)

> **Status of this guide:** Written against the **actual live state** of your staging box
> (`13.126.64.19`, instance `i-0bd09e7563368ed39`, ap-south-1) as inspected on 2026-06-02.
> It is specific to _your_ setup — Docker Compose at `/home/ubuntu/bravo`, host-level Caddy,
> self-hosted Postgres, coturn — not a generic template.
>
> **Provider choice:** Targets **Contabo Singapore** (cheapest option, ~$8/mo; Singapore→India
> latency ~30–40 ms is fine for WebRTC calls). **Vultr Mumbai** is kept as a higher-quality
> alternative (~$12/mo, local region) in §4C if call latency/network consistency become an issue.
> The migration steps are ~90% provider-agnostic; only provisioning + firewall differ.
>
> **Trade-off you're accepting with Contabo:** variable IO/network under load and slower support.
> For a staging box that's a reasonable price for ~$50/mo of savings — just know it's the budget pick,
> not the performance pick.

---

## 0. TL;DR — Why this is easier than it looks

The scary number was **273 GB disk used**. The good news from inspection:

| Thing                                                                      | Size       | Migrate?                                                         |
| -------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| Postgres data (`bravo_pg-data`)                                            | **65 MB**  | ✅ Yes (tiny `pg_dump`)                                          |
| Auth uploads (`bravo_auth-uploads`)                                        | **8 KB**   | ✅ Yes (basically empty)                                         |
| Source code (`~/bravo/apps`, `auth-service`, etc.)                         | small      | ✅ Re-clone from git instead                                     |
| Docker **containers layer**                                                | **259 GB** | ❌ **Junk** — log/temp bloat inside a container. Do NOT migrate. |
| Build cache                                                                | 13 GB      | ❌ Junk                                                          |
| Stray backups in `~` (`ITEX_Fatullah_*.bak`, `awscliv2.zip`, `loki-*.zip`) | ~700 MB    | ❌ Unrelated/junk                                                |

**Real application state to move is under ~100 MB.** Everything else is disposable. So this is a
_clean rebuild on the new VPS + restore a 65 MB database_, not a 273 GB block-copy.

**Cost impact:**

|            | AWS now (t3.medium)    | Contabo Singapore (target)     | Vultr Mumbai (alternative)         |
| ---------- | ---------------------- | ------------------------------ | ---------------------------------- |
| Monthly    | ~$64                   | **~$8–11**                     | ~$10–12 (4 GB tier)                |
| Spec       | 2 vCPU / 4 GB / 350 GB | 4 vCPU / 8 GB / 100 GB NVMe    | 2 vCPU / 4 GB / 80 GB NVMe         |
| Region     | Mumbai                 | Singapore (~30–40 ms to India) | Mumbai (local — best call latency) |
| Network/IO | —                      | Variable under load            | High, consistent                   |

Saving: **~$53–56/mo** on top of the t3.medium resize you already did.

> **Why Contabo here:** it's the cheapest option, and Singapore→India latency (~30–40 ms) is still
> fine for WebRTC calls. The cost is variable IO/network and slower support — acceptable for staging.
> If call quality or network consistency disappoints, **Vultr Mumbai** (§4C) is the local-region
> upgrade for a few dollars more. (Hetzner — the usual cheap+reliable pick — is **not** an option
> here: no Asia region, so EU routing adds 100 ms+ to call media.)
>
> **Sizing:** your real usage is ~2.2 GB RAM / ~9 % CPU. Contabo's entry tiers already include
> 8 GB RAM at this price, so you get generous headroom by default. (On Vultr, pick the 4 GB tier —
> ~$12/mo, ~1.8 GB headroom, matching the t3.medium you resized to.)

---

## 1. What you're running today (the source of truth)

**Host:** Ubuntu 22.04, `~/bravo` is the Docker Compose project (`docker-compose.staging.yml`).

**6 containers (all `restart: unless-stopped`):**

| Container              | Port                   | Role                                   |
| ---------------------- | ---------------------- | -------------------------------------- |
| `bravo-staging-auth`   | 3001                   | auth-service (NestJS)                  |
| `bravo-staging-msgr`   | 3100                   | messenger-service (relay + WS)         |
| `bravo-staging-ops`    | 3002                   | ops-console (Next.js)                  |
| `bravo-staging-pg`     | 5432 (internal)        | **Postgres — your real DB lives here** |
| `bravo-staging-redis`  | 6379 (internal)        | Redis (WS adapter)                     |
| `bravo-staging-coturn` | 3478 + UDP 40000–49999 | TURN/STUN for WebRTC calls             |

**Edge:** host-level **Caddy** (`/etc/caddy/Caddyfile`), auto-TLS via Let's Encrypt, serving:

```
auth.13-126-64-19.sslip.io   → localhost:3001
relay.13-126-64-19.sslip.io  → localhost:3100
ops.13-126-64-19.sslip.io    → localhost:3002
turn.13-126-64-19.sslip.io   → cert host (200)
```

**Critical coupling — the IP is inside the hostnames.** Everything uses
`sslip.io` wildcard DNS (`<ip-with-dashes>.sslip.io` resolves to that IP). When the IP changes to
the new VPS's, **every one of these hostnames changes**, which cascades into client config, Caddy, and
TLS certs. This is the #1 thing the migration is really about.

**Volumes:** `bravo_pg-data` (65 MB), `bravo_auth-uploads` (8 KB). Named, so easy to back up.

**Secrets on the box:** `~/bravo/.env` (6 vars), `~/bravo/.env.staging` (10 vars),
`firebase-service-account.json` (FCM push). These must be copied securely — they are **not** in git.

**Not in use (good — skip these):** `cloudflared` is installed but `~/.cloudflared` is empty → no
tunnel configured. No AWS RDS (DB is the `pg` container). No SSM agent.

---

## 2. Hostnames — you have NO domain, so you use sslip.io (this is already how it works)

**What you're using today is not a real domain.** Your Caddyfile serves
`auth.13-126-64-19.sslip.io`, etc. `sslip.io` is a free public **wildcard-DNS** service: any hostname
of the form `anything.<ip-with-dashes>.sslip.io` automatically resolves to that IP — sslip.io just
reads the IP out of the hostname. You don't register or own anything, and Let's Encrypt still issues
real TLS certs for it (it's a valid public hostname).

So the IP is **baked into the hostname**. When you move to Contabo and get a new IP, the hostnames
change with it — that's the whole migration's core find/replace.

### Option B — Keep sslip.io with the new IP ← **YOUR PATH (no domain needed)**

If Contabo gives you e.g. `185.43.21.99`, your hosts simply become:

```
auth.185-43-21-99.sslip.io
relay.185-43-21-99.sslip.io
ops.185-43-21-99.sslip.io
turn.185-43-21-99.sslip.io
```

Zero DNS setup, zero cost. The only downside: you repeat this IP find/replace on every future move
(because the IP lives inside the hostname). For a staging box that moves rarely, that's fine.

### Option A — Use a real domain (optional future upgrade, ~$10/yr)

If you ever buy a domain, point subdomains (`auth.staging.bravosecure.com`, etc.) at the VPS IP. Then
future IP changes mean updating **one DNS record** instead of a codebase-wide find/replace. Skip this
for now — you don't have a domain, and sslip.io covers you.

> **The rest of this guide assumes Option B (sslip.io).** Wherever you see a hostname, it's
> `<service>.<new-ip-dashes>.sslip.io`. The §5 DNS step is only needed if you later adopt Option A.

---

## 3. Pre-flight on the OLD box (do this first, while it's healthy)

SSH in: `ssh -i C:\Users\Ranak\.ssh\bravo-staging.pem ubuntu@13.126.64.19`

### 3.1 Back up the database (65 MB — trivial)

```bash
cd ~/bravo
# dump the running Postgres container to a file on the host
docker exec -t bravo-staging-pg pg_dumpall -U postgres > ~/bravo_pgdump_$(date +%Y%m%d).sql
# if it uses a specific db/user, use pg_dump instead:
# docker exec -t bravo-staging-pg pg_dump -U <user> -d <db> > ~/bravo_db_$(date +%Y%m%d).sql
ls -lh ~/bravo_pgdump_*.sql   # sanity check it's non-empty
```

> Find the exact `POSTGRES_USER` / `POSTGRES_DB` in `docker-compose.staging.yml` under the `pg`
> service before choosing `pg_dumpall` vs `pg_dump`.

### 3.2 Back up the uploads volume (even though it's 8 KB — be safe)

```bash
docker run --rm -v bravo_auth-uploads:/data -v ~/:/backup alpine \
  tar czf /backup/auth-uploads_$(date +%Y%m%d).tar.gz -C /data .
```

### 3.3 Collect the secrets (handle carefully — these are live credentials)

```bash
mkdir -p ~/migrate-bundle
cp ~/bravo/.env ~/bravo/.env.staging ~/migrate-bundle/
cp ~/bravo/firebase-service-account.json ~/migrate-bundle/ 2>/dev/null
cp ~/bravo/docker-compose.staging.yml ~/migrate-bundle/
sudo cp /etc/caddy/Caddyfile ~/migrate-bundle/Caddyfile.old
cp ~/bravo_pgdump_*.sql ~/migrate-bundle/
cp ~/auth-uploads_*.tar.gz ~/migrate-bundle/ 2>/dev/null
tar czf ~/migrate-bundle.tar.gz -C ~/migrate-bundle .
ls -lh ~/migrate-bundle.tar.gz
```

### 3.4 Pull the bundle down to your laptop (then later push to the new VPS)

From **your Windows machine** (PowerShell):

```powershell
scp -i C:\Users\Ranak\.ssh\bravo-staging.pem ubuntu@13.126.64.19:~/migrate-bundle.tar.gz E:\tmp\migrate-bundle.tar.gz
```

> ⚠️ This bundle contains plaintext secrets and your DB. Keep it off shared drives; delete it from
> all three locations (old box, laptop, new box) once migration is verified.

### 3.5 Note the exact images/tags in use

```bash
docker ps --format '{{.Names}}: {{.Image}}'
```

Record these — you want the new VPS to run the **same image tags** (or rebuild from the same git commit).

---

## 4. Provision the VPS

### 4A. Contabo Singapore (target)

1. Contabo → buy a **Cloud VPS** (NVMe, can be deleted cleanly). **VPS S** (4 vCPU / 8 GB, ~$8) is
   plenty — it already gives generous headroom over your real ~2.2 GB usage.
2. **Region:** **Singapore** (closest Contabo region to India — Contabo has no Mumbai DC).
   Singapore→India is ~30–40 ms, fine for calls.
3. **OS:** Ubuntu 22.04 LTS (match the current box).
4. **SSH key:** add your public key during provisioning (the `.pub` matching `bravo-staging.pem`, or a
   fresh keypair for Contabo).
5. **Firewall:** Contabo has **no cloud firewall** — `ufw` (§4.1) is your only line of defence, so do
   not skip it.
6. Note the assigned **public IP** — call it `NEWIP` below.

### 4.1 First-login hardening (10 min, do not skip on a public box)

```bash
ssh root@NEWIP
# create a non-root user mirroring the AWS setup
adduser ubuntu && usermod -aG sudo ubuntu
rsync --archive --chown=ubuntu:ubuntu ~/.ssh /home/ubuntu
# basic firewall — open only what Bravo needs
ufw allow OpenSSH
ufw allow 80,443/tcp                 # Caddy / HTTPS
ufw allow 3478/tcp                   # TURN control
ufw allow 3478/udp                   # TURN/STUN
ufw allow 40000:49999/udp            # WebRTC media (group calls)
ufw enable
# disable root SSH + password auth
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

> The `40000:49999/udp` + `3478` rules are **essential** — without them group calls silently fail
> on the media plane (this is documented in your `docs/qa/SQA_BRAVO_LITE_TEST_FLOW.md`). AWS security groups
> handled this before. On **Contabo** `ufw` is your only firewall, so don't skip it. (On the Vultr
> alternative in §4C, set the same rules in **both** the Vultr Firewall **and** ufw — defence in depth.)

### 4.2 Install Docker + Caddy

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
# Caddy (host-level, same as old box)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Re-login as `ubuntu` so the docker group applies.

### 4C. Vultr Mumbai (higher-quality alternative — if Contabo underperforms)

If call quality or network consistency on Contabo disappoints, switch to Vultr's **local Mumbai**
region (lowest WebRTC latency, more consistent IO) for a few dollars more:

1. Vultr → **Deploy New Server** → **Cloud Compute - Shared CPU** (hourly-billable, deletes cleanly).
2. **Location:** **Mumbai** (local region — lowest WebRTC latency to your India users).
3. **Plan:** the **4 GB / 2 vCPU / 80 GB NVMe** tier (~$12/mo) — covers your ~2.2 GB usage with
   headroom, matching the t3.medium you resized to. (Bump to 8 GB / ~$24 only for growth room.)
4. **OS:** Ubuntu 22.04 LTS. **SSH key:** add during deploy.
5. **Vultr Firewall (do this — it's a cloud-level firewall, in addition to ufw):** create a firewall
   group and attach it, allowing TCP 22/80/443, TCP+UDP **3478**, and UDP **40000–49999** (the WebRTC
   media range — without it, group calls silently fail).
6. Everything else (§4.1 hardening, §4.2 Docker+Caddy, and §5 onward) is identical.

---

## 5. DNS

### Option B (sslip.io — YOUR PATH): nothing to do ✅

sslip.io needs **no DNS configuration**. The moment you know your Contabo IP, the hostnames
`auth.<ip-dashes>.sslip.io` etc. already resolve to it automatically. Skip straight to §6.

> Just compute your dashed IP: e.g. IP `185.43.21.99` → `185-43-21-99`. That string replaces
> `13-126-64-19` everywhere.

### Option A (real domain — only if you adopt it later)

In your DNS provider for the domain, add **A records** pointing at `NEWIP`:

```
auth.staging    A   NEWIP
relay.staging   A   NEWIP
ops.staging     A   NEWIP
turn.staging    A   NEWIP
```

Wait for propagation (`dig auth.staging.<yourdomain> +short` should return `NEWIP`).
Caddy needs these resolving **before** it can issue Let's Encrypt certs.

---

## 6. Rebuild the stack on the new VPS

### 6.1 Get the code + bundle onto the new box

```bash
# from your laptop, push the bundle (use whichever key you added to the new VPS):
scp -i <new-vps-key> E:\tmp\migrate-bundle.tar.gz ubuntu@NEWIP:~/

# on the new box:
mkdir -p ~/bravo && cd ~/bravo
# Option 1 (cleaner): clone from git at the SAME commit the old box ran
git clone <your-repo-url> .
git checkout <commit-or-branch matching old box>   # e.g. release/1.0.35-audit-fixes
# Option 2: copy the source out of the bundle if the box wasn't git-tracked
tar xzf ~/migrate-bundle.tar.gz -C ~/migrate-bundle
```

### 6.2 Restore secrets + compose

```bash
cd ~/bravo
cp ~/migrate-bundle/.env ~/migrate-bundle/.env.staging .
cp ~/migrate-bundle/firebase-service-account.json .
cp ~/migrate-bundle/docker-compose.staging.yml .   # if not from git
```

### 6.3 Update every hardcoded reference to the old IP/host

This is the heart of the migration. Search-and-replace across env + compose:

```bash
cd ~/bravo
# see what references the old identity first
grep -rn '13.126.64.19\|13-126-64-19.sslip.io' . --include='*.env*' --include='*.yml' --include='*.json'
```

Replace in `.env`, `.env.staging`, and `docker-compose.staging.yml`.
**Option B (sslip.io — your path):** just swap the old dashed IP for the new one.

| Old (current)                           | New (Option B — sslip.io)       | New (Option A — if you have a domain) |
| --------------------------------------- | ------------------------------- | ------------------------------------- |
| `auth.13-126-64-19.sslip.io`            | `auth.<NEWIP-dashes>.sslip.io`  | `auth.staging.<yourdomain>`           |
| `relay.13-126-64-19.sslip.io`           | `relay.<NEWIP-dashes>.sslip.io` | `relay.staging.<yourdomain>`          |
| `turn.13-126-64-19.sslip.io`            | `turn.<NEWIP-dashes>.sslip.io`  | `turn.staging.<yourdomain>`           |
| `13.126.64.19` (TURN_URLS, public host) | `NEWIP`                         | `NEWIP`                               |

> For Option B, this is literally a global find/replace of `13-126-64-19` → `<NEWIP-dashes>` and
> `13.126.64.19` → `NEWIP`. Example: `sed -i 's/13-126-64-19/185-43-21-99/g; s/13\.126\.64\.19/185.43.21.99/g' .env .env.staging docker-compose.staging.yml`

**Don't forget these specific keys** (from your config):

- `TURN_URLS=turn:13.126.64.19:3478?...` → `turn:NEWIP:3478?...` (TURN must advertise the new IP)
- coturn's `external-ip` / `relay-ip` if set in compose → `NEWIP`
- Any `PUBLIC_URL` / `API_BASE_URL` / messenger relay URL in the auth + messenger envs
- Mobile app + ops-console build config that points at the staging hosts (see §8)

### 6.4 Write the new Caddyfile

`/etc/caddy/Caddyfile` — **Option B (sslip.io, your path)**. Replace `<NEWIP-dashes>` with your
Contabo IP using dashes (e.g. `185-43-21-99`):

```
{
  email ranak@bravosecure.com
}
auth.<NEWIP-dashes>.sslip.io {
  encode zstd gzip
  reverse_proxy localhost:3001
}
relay.<NEWIP-dashes>.sslip.io {
  encode zstd gzip
  reverse_proxy localhost:3100
}
ops.<NEWIP-dashes>.sslip.io {
  encode zstd gzip
  reverse_proxy localhost:3002
}
turn.<NEWIP-dashes>.sslip.io {
  respond "TURN cert host" 200
}
```

> This is structurally identical to your current Caddyfile — only the IP-dashes part changes. If you
> later adopt Option A, swap these four hostnames for your real subdomains.

```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -f   # watch certs issue; Ctrl-C when all 4 are green
```

### 6.5 Bring up the containers

```bash
cd ~/bravo
docker compose -f docker-compose.staging.yml up -d
docker compose -f docker-compose.staging.yml ps   # all should be (healthy) within ~1 min
```

### 6.6 Restore the database

```bash
# wait until the pg container is healthy, then load the dump
cat ~/migrate-bundle/bravo_pgdump_*.sql | docker exec -i bravo-staging-pg psql -U postgres
# restore uploads volume
docker run --rm -v bravo_auth-uploads:/data -v ~/migrate-bundle:/backup alpine \
  sh -c 'cd /data && tar xzf /backup/auth-uploads_*.tar.gz'
docker compose -f docker-compose.staging.yml restart   # pick up restored data
```

---

## 7. Verify on the new VPS BEFORE cutover (golden path + error path)

```bash
# containers healthy
docker compose -f docker-compose.staging.yml ps
# HTTPS endpoints answer (via Caddy + Let's Encrypt). Option B = sslip.io hostnames:
curl -sI https://auth.<NEWIP-dashes>.sslip.io/health
curl -sI https://relay.<NEWIP-dashes>.sslip.io/health
curl -sI https://ops.<NEWIP-dashes>.sslip.io/
# TURN reachable
nc -vzu NEWIP 3478
```

**The call path is the high-risk item — test it explicitly:**

1. From a device on the network, point a test build at the new hosts.
2. Place a **1:1 call** → verify audio connects (DTLS-SRTP over the new TURN).
3. Place a **group call** → this exercises UDP 40000–49999; if it fails, your `ufw` media-port
   rule or coturn `external-ip` is wrong.
4. Send + receive a **1:1 message** and a **group message** (Signal sessions, sealed-sender).
5. Trigger a **push notification** (FCM via `firebase-service-account.json`).

> If group calls fail but 1:1 works, it's almost always the media UDP range or coturn's advertised
> IP — recheck §4.1 firewall and the `TURN_URLS`/`external-ip` in §6.3.

---

## 8. Update clients + CI to the new hosts

The server move isn't done until what _points at_ it is updated:

- **Mobile app** (`src/services/api.ts`, `.env.staging`, `app.config`/EAS env): swap staging API +
  relay + TURN URLs to the new hosts. Rebuild the staging APK (`npm run apk:staging`).
- **Ops-console** (`apps/ops-console` env / Vercel env vars): update API base URLs.
- **GitHub Actions** (`.github/workflows/deploy-auth.yml`, `deploy-messenger.yml`): these default to
  `host: 13.126.64.19`. Set the `EC2_HOST` secret → `NEWIP` (or rename appropriately) and update the
  `SSH_PRIVATE_KEY` secret to the new VPS key. The deploy logic itself (SSH + `docker compose`) is
  portable as-is.
- **Docs:** `docs/planning/DEPLOY_PLAN.md`, `docs/openapi/*.yaml`, `docs/qa/SQA_BRAVO_LITE_TEST_FLOW.md`,
  `apps/messenger-service/src/config/configuration.ts` all mention `13.126.64.19` — update for
  accuracy (grep the repo for `13.126.64.19`).

---

## 9. Cutover & decommission

1. Run the new VPS in parallel with AWS until §7 + §8 fully pass. (Staging-only, so no zero-downtime
   ceremony needed — just don't kill AWS until the new box is proven.)
2. Once green for a day or two:
   ```powershell
   # stop AWS instance first (reversible) — watch for a quiet period before terminating
   aws ec2 stop-instances --region ap-south-1 --instance-ids i-0bd09e7563368ed39
   ```
3. **Final teardown of AWS** (irreversible — only after you're certain):
   ```powershell
   aws ec2 terminate-instances --region ap-south-1 --instance-ids i-0bd09e7563368ed39
   # the 350GB gp3 volume is deleted-on-termination if so flagged; verify no orphan volume remains:
   aws ec2 describe-volumes --region ap-south-1 --query "Volumes[?State=='available']"
   # release the in-use Elastic IP 13.126.64.19 AFTER terminate (now it's truly idle)
   aws ec2 describe-addresses --region ap-south-1
   aws ec2 release-address --region ap-south-1 --allocation-id <alloc-id-of-13.126.64.19>
   ```
4. **Delete secret bundles** from old box, laptop (`E:\tmp\migrate-bundle.tar.gz`), and the new box's
   `~/migrate-bundle`. They contain live credentials and your DB.

---

## 10. Rollback plan

Until you terminate AWS, rollback is trivial because the old box is untouched:

1. Re-point DNS (Option A) back to `13.126.64.19`, **or** revert client config to the old
   `sslip.io` hosts (Option B).
2. `aws ec2 start-instances` if you'd stopped it; containers auto-start (`unless-stopped`).
3. Investigate the new-VPS failure offline. No data loss, because AWS still holds the original DB.

**Keep AWS alive (stopped is fine — stopped EC2 only bills for the EBS volume, ~$32/mo) for at least
a week after cutover** before terminating.

---

## 11. Open items / decisions for you

- [x] **Domain choice:** RESOLVED → **Option B (sslip.io)** — you have no domain, so hostnames stay
      `<service>.<new-ip-dashes>.sslip.io`. Option A is a future ~$10/yr upgrade only.
- [ ] **Provider confirmed:** Contabo Singapore (target, §4A) — keep Vultr Mumbai (§4C) as the
      upgrade path if call quality/network consistency disappoints.
- [ ] **Postgres exact user/db:** confirm from `docker-compose.staging.yml` before §3.1.
- [ ] **Backups:** AWS gave you automatic EBS snapshots; neither Vultr nor Contabo does by default
      (Vultr offers paid auto-backups/snapshots). Set up a nightly `pg_dumpall` cron + offsite copy
      regardless (the DB is only 65 MB — cheap to back up often).
- [ ] **Is staging long-lived?** If yes, Option A + automated backups are worth it. If it's
      disposable, Option B is faster.

---

### Appendix — what was already done on AWS (context)

- ✅ Resized `t3.large → t3.medium` (verified: ~2.2 GB RAM used, all 6 containers healthy). −~$32/mo.
- ✅ Deleted 2 orphaned RDS ENIs (`quotly-rds-sg`, `keepr_db`) from deleted databases.
- ❌ 2 idle Elastic IPs in **us-east-1** could not be released via API (`OperationNotPermitted` —
  AWS service-level lock). Needs an AWS Support ticket; allocation IDs
  `eipalloc-0482c5920e99ab8fe`, `eipalloc-0617502c9306035f2`. (Unrelated to this Mumbai box.)

---

## 12. Group video call: "no media flows on physical phone" (BS-MEDIA)

> Added 2026-06-04 after a physical-device repro (TECNO KM5, Android 15, Wi-Fi): in a group
> video call the phone saw nobody and nobody saw it, and the call auto-dropped after 1–5 min.
> adb logcat showed the recv transport reaching `connected` but carrying ZERO RTP
> (8 track-mute / 0 unmute), then `disconnected` at variable times, then ICE-restart failing
> with `transport not open` / `ack_timeout:sfu.transport.restartIce`. BlueStacks emulators on
> the same router worked because they route through the host PC's LAN.

### Root cause (deployment + a now-fixed client default)

Three things interacted:

1. **Client forced relay-only on the SFU path.** `useGroupCall.ts` set
   `iceTransportPolicy: 'relay'` on both mediasoup transports. Correct for 1:1 (both peers
   relay and meet inside coturn) but wrong for the SFU, which is a _public server_ the client
   should reach **directly**. **Fixed in code → `'all'`** (TURN stays as fallback).
2. **The SFU advertised a private IP.** `SFU_ANNOUNCED_IP` was unset, so mediasoup announced
   its container/bind address (RFC1918). The phone's relay candidate could never reach it.
3. **coturn refuses to relay to RFC1918.** The SSRF denylist (`--denied-peer-ip` in
   `docker-compose.yml`) blocks `10/8`, `172.16/12`, `192.168/16`. Since the SFU's announced
   IP was private, coturn dropped every relayed packet bound for the SFU → DTLS completed
   (`connected`) but no RTP flowed → starvation → idle disconnect → restartIce hit an
   already-closed transport.

### Required deployment config (do BOTH on the Contabo box)

The code change alone is not enough — the SFU must advertise a routable IP and its media
ports must be open.

1. **Set the SFU's announced (public) IP** in the messenger-service environment:

   ```bash
   # in /home/ubuntu/bravo/.env (or the compose env for messenger-service)
   SFU_ANNOUNCED_IP=94.136.184.52     # the box's PUBLIC IP
   SFU_LISTEN_IP=0.0.0.0              # bind all interfaces (default; leave as-is)
   ```

   Then recreate the service so mediasoup re-reads it:

   ```bash
   docker compose up -d --force-recreate messenger-service
   ```

2. **Open the SFU's RTC media port range** (mediasoup `WebRtcTransport`s, both UDP and TCP).
   Defaults are `SFU_RTC_MIN_PORT=40000` / `SFU_RTC_MAX_PORT=49999`:

   ```bash
   # ufw example — open UDP + TCP 40000-49999 to the world
   sudo ufw allow 40000:49999/udp
   sudo ufw allow 40000:49999/tcp
   ```

   If messenger-service runs in a bridged Docker network (not host mode), publish the same
   range in compose (`ports: ["40000-49999:40000-49999/udp", "40000-49999:40000-49999/tcp"]`)
   — OR run it `network_mode: host` like coturn already does, which is simpler for an SFU.

3. **Verify** after redeploy: place a 3-device group video call with at least one physical
   phone on mobile/Wi-Fi. Expect remote tiles within a few seconds and a stable call past 5 min.
   In logcat, the recv transport should now show `connected` AND a rising unmute count.

### What the code change buys you on its own

With `iceTransportPolicy: 'all'`, the phone will prefer the direct path to `SFU_ANNOUNCED_IP`.
If you set the announced IP + open the ports, TURN is no longer on the critical path for the
phone↔SFU leg (it stays as a fallback for networks that block UDP to the SFU range, where the
client falls back to TURN-TCP/TLS). **If you skip the deploy config, `'all'` still cannot help**
— there is no routable SFU candidate to reach.
