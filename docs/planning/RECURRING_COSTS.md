# Bravo Lite — Recurring Costs Audit

> Last updated: 2026-04-30
> Scope: every paid third-party service, infra component, and cloud resource
> the production stack will hit on a recurring basis. Audited from the
> codebase — env keys, SDK imports, config files. Each row says what we
> currently pay (dev), what we _will_ pay at small/medium scale, and the
> pricing model so we can swap providers if costs surprise us.

Currency: USD unless noted. "Small scale" = 1k MAU / ~3k missions per month.
"Medium scale" = 10k MAU / ~30k missions per month. Estimates rounded up
to the next price tier.

---

## 1. Active services (already wired, configured, billing-ready)

These are in the codebase **right now** with real keys. Switching to live
keys flips them to billing immediately.

### 1.1 Twilio Verify (OTP / SMS)

- **Used for**: phone-number verification at registration + login (OTP).
- **Code**: [auth-service/src/auth](apps/auth-service/src/auth) · `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` in [auth-service/.env](apps/auth-service/.env).
- **Dev status**: `OTP_DEV_BYPASS=true` — any 4-8 digit code passes, no Twilio call.
- **Pricing model**:
  - Verify API: **$0.05 per verification** (covers SMS + voice + email channels in the same fee).
  - Phone number rental: **$1.15/mo per long code** (US/UAE/BD vary).
- **Small scale**: ~3k bookings/mo + ~1k registrations + retries → **~$200–250/mo**.
- **Medium scale**: ~30k events/mo → **~$1,500–1,800/mo**.
- **Notes**: Verify is meaningfully cheaper than raw Programmable SMS once you factor international routes, especially BD/UAE where carriers add per-message surcharge. Keep `TWILIO_VERIFY_SID` set; never fall through to `TWILIO_FROM` for prod.

### 1.2 Stripe (wallet top-up)

- **Used for**: Bravo Credit purchases via PaymentIntents in `wallet.service`. 1 USD = 10 BC.
- **Code**: [wallet/stripe.client.ts](apps/auth-service/src/wallet/stripe.client.ts), `@stripe/stripe-react-native` on mobile · `STRIPE_SECRET_KEY` (currently `sk_test_…`).
- **Dev status**: test mode key. Test cards (`4242 4242 4242 4242`) work, no money moves.
- **Pricing model**:
  - Cards (international): **2.9 % + $0.30** per successful charge.
  - 3DS / SCA: free.
  - Refunds: original processing fee NOT refunded.
  - Disputes: **$15 per chargeback** (refunded if you win).
- **Small scale**: $50k GMV/mo → **~$1,750/mo** (3.5 % effective).
- **Medium scale**: $500k GMV/mo → **~$17.5k/mo**.
- **Notes**: Stripe negotiates rates above ~$80k GMV/mo. The platform-fee mechanic (1 BC remainder on uneven splits per [BRAVO_LITE_PROGRESS.md §10](BRAVO_LITE_PROGRESS.md)) is unrelated — that's our own margin, not Stripe's.

### 1.3 Mapbox (maps + directions + geocoding)

- **Used for**:
  - **Map tiles** — every `BravoMap` (ops console live page, dispatch picker, list); RN WebViews ([bravoLiveRouteMapHtml.ts](src/modules/booking/bravoLiveRouteMapHtml.ts), [bravoLocationPickerMapHtml.ts](src/modules/booking/bravoLocationPickerMapHtml.ts), [bravoBookingMapHtml.ts](src/modules/booking/bravoBookingMapHtml.ts)).
  - **Directions API** — primary route at dispatch + 2-3 alternatives per `/ops/missions/:id/route-options` ([mapbox-directions.service.ts](apps/auth-service/src/ops/mapbox-directions.service.ts)).
  - **Geocoding / Search Box** — pickup/dropoff autocomplete ([LocationPickerScreen.tsx](src/screens/booking/LocationPickerScreen.tsx)).
  - **Static images** — intel feed thumbnails ([modules/news/mapbox.ts](src/modules/news/mapbox.ts)).
- **Code**: `MAPBOX_ACCESS_TOKEN` (auth-service), `EXPO_PUBLIC_MAPBOX_TOKEN` (mobile), `NEXT_PUBLIC_MAPBOX_TOKEN` (ops). Same public token across all three.
- **Dev status**: live token, free tier.
- **Pricing model** (free tier first, then **per 1k**):
  - **Map tiles** (Maps GL JS): 50k MAU free → **$5/1k MAU** above that.
  - **Directions**: 100k requests/mo free → **$2/1k** above.
  - **Geocoding**: 100k temporary requests/mo free → **$0.75/1k** permanent / **$0.50/1k** temporary above.
- **Small scale** (1k MAU + ~6k Directions + ~10k geocoding): **$0** (well under free tier).
- **Medium scale** (10k MAU + ~90k Directions + ~150k geocoding): **~$200/mo** mostly Directions overage.
- **Cost amplifier today**: each `/route-options` call burns up to **3 Directions calls** because of the synthetic via-point fan-out. At 30k missions/mo with ~2 RE-ROUTE-picker opens average → 180k Directions calls. Plan accordingly or cache route options per mission.

### 1.4 Supabase (Postgres + Auth + Realtime + Storage)

- **Used for**: primary OLTP database (`lite_bookings`, `missions`, `agents`, `conversations`, `message_envelopes`, …).
- **Code**: connection via `DATABASE_URL` in [auth-service/.env](apps/auth-service/.env).
- **Dev status**: local Docker (`supabase start` — free). Production = Supabase Cloud.
- **Pricing model** (Supabase Cloud):
  - Free: 500 MB DB, 5 GB egress, 2 projects.
  - **Pro**: **$25/mo** + usage. 8 GB DB / 250 GB egress included.
  - Compute add-on: **$10–$3,300/mo** depending on instance size.
- **Small scale**: Pro + Small compute (`$25 + $15 = $40/mo`).
- **Medium scale**: Pro + Medium compute (`$25 + $60 = $85/mo`) + ~100 GB egress overage = **~$100–150/mo**.
- **Notes**: only the bare DB is needed — we don't use Supabase Auth or Realtime here. Self-hosted Postgres on RDS ($14/mo `db.t4g.micro`) is comparable; pick Supabase for the dashboard + branching.

### 1.5 Mapbox token rotation

- Tokens are public (committed to .env.example). The **scope** matters — keep separate dev/staging/prod tokens with URL/IP restrictions so a leaked dev token can't run up a prod bill.

---

## 2. Wired but currently dormant

In the codebase, would activate at production rollout.

### 2.1 AWS S3 / Cloudflare R2 (file vault + media)

- **Used for**:
  - **Vault** — long-lived encrypted user files ([messenger-service/src/vault/vault.service.ts](apps/messenger-service/src/vault/vault.service.ts), `@aws-sdk/client-s3`).
  - **Media** — per-message ephemeral blobs (5-min TTL, 50 MB max upload), same bucket.
  - **Future** — when the messenger moves from "server-blind relay" to optional cloud-backup of envelopes.
- **Code**: env keys on messenger-service: `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`, `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`, `MEDIA_S3_ENDPOINT` (set this for R2). Currently unset → vault throws `vault_storage_not_configured`.
- **Pricing model**:
  - **Cloudflare R2** (recommended — no egress fees):
    - Storage: **$0.015/GB-mo**.
    - Class A ops (writes/lists): **$4.50/million**.
    - Class B ops (reads): **$0.36/million**.
    - **Egress: $0**. ← key reason to pick R2 over S3 for media.
  - **AWS S3 Standard** (alternative):
    - Storage: **$0.023/GB-mo**.
    - GET: **$0.0004/1k**.
    - Egress: **$0.09/GB** (this kills you for media-heavy apps).
- **Small scale** (50 GB stored, 100k reads/mo, 1k writes/mo on R2): **~$1.50/mo**.
- **Medium scale** (1 TB, 1M reads, 100k writes on R2): **~$20/mo**.
- **Cost trap**: avoid AWS S3 for media if iOS/Android download blobs frequently — egress alone at medium scale would add **$200+/mo**. Pick R2.

### 2.2 Firebase Cloud Messaging (FCM) — Android push

- **Used for**: dispatch notifications, mission alerts, SOS alerts, payout cards.
- **Code**: `@react-native-firebase/app` + `@react-native-firebase/messaging` in [package.json](package.json). [PermissionsScreen.tsx](src/screens/auth/PermissionsScreen.tsx) handles the runtime permission. **Not yet wired to actually send** — see [BRAVO_LITE_PROGRESS.md §7](BRAVO_LITE_PROGRESS.md): "Push notifications · ⏳ FCM/APNs not wired."
- **Pricing model**: **Free** for unlimited messages on FCM. Always.
- **Cost**: **$0**.
- **Notes**: still need a Firebase project + service-account JSON for the auth-service to mint device tokens.

### 2.3 Apple Push Notification service (APNs) — iOS push

- **Used for**: same as FCM, on iOS.
- **Pricing model**:
  - APNs itself: **free**.
  - Apple Developer Program: **$99/year** required to ship to the App Store and to issue APNs auth keys.
- **Cost**: **$99/yr** flat. Already a sunk cost if you ship iOS at all.

### 2.4 Agora (WebRTC video/voice fallback)

- **Used for**: voice/video calls in the messenger when peer-to-peer WebRTC fails (NAT, corporate firewalls). Coded as **fallback only**; primary path is direct WebRTC ([webrtc/agoraFallback.ts](src/modules/messenger/webrtc/agoraFallback.ts)).
- **Code**: `react-native-agora` in [package.json](package.json). Not yet activated.
- **Pricing model**:
  - First **10k minutes/month free**.
  - Voice: **$0.99/1k minutes**.
  - HD video: **$3.99/1k minutes**.
- **Small scale** (assume 30k min voice fallback / mo): **$20/mo**.
- **Medium scale** (300k min): **$300/mo** voice or **$1,200/mo** video.
- **Notes**: keep the primary WebRTC path well-tested; Agora is the bill saver only if you can keep fallback rate under ~10 %. Each minute on Agora is one minute the ICE/STUN/TURN path failed.

### 2.5 TURN server (WebRTC NAT traversal)

- **Used for**: WebRTC ICE relay when peer-to-peer fails but before falling all the way to Agora. [messenger-service/src/turn](apps/messenger-service/src/turn) issues short-lived TURN credentials.
- **Code**: env keys `TURN_HOST`, `TURN_USER`, `TURN_PASS`. Not deployed yet.
- **Pricing model**:
  - Self-host **coturn** on a t4g.small ($14/mo) — handles ~50 concurrent calls.
  - Or **Twilio Network Traversal Service**: **$0.40/GB** TURN-relayed.
  - Or **Cloudflare TURN**: **$0.05/real-time-hr** (much cheaper at scale).
- **Small scale** (self-hosted): **$14/mo**.
- **Medium scale** (Cloudflare TURN, ~10k call-hrs/mo at 5 % relay rate = ~500 hrs): **$25/mo**.

### 2.6 Push provider — none currently

- Could swap FCM/APNs for **OneSignal** (free up to 10k subs) or **Pusher Beams** ($1/1k per push) if Firebase setup proves painful. Not blocking.

---

## 3. Free / external-rate-limited APIs

Currently free tiers; flag for upgrade if usage grows.

### 3.1 The Guardian Open Platform

- **Used for**: Intel Feed news headlines ([modules/news/guardianClient.ts](src/modules/news/guardianClient.ts)).
- **Pricing**: dev key (`test`) free; **12 calls/sec, 5k/day**. Apply for a real key (free) for higher limits. Real-time content requires their commercial tier (negotiated).
- **Cost**: **$0**.

### 3.2 Reddit / Hacker News / RSS

- **Used for**: intel feed aggregation.
- **Pricing**: free. Reddit recently changed their commercial API tier; we're using public JSON endpoints (rate-limited, free).
- **Cost**: **$0** (until rate-limited; cache aggressively).

---

## 4. Self-hosted infra (your hosting bill, not theirs)

These are services we run ourselves on cloud VMs/containers. Costs vary by provider.

### 4.1 auth-service + messenger-service compute

- **Spec**: 2 NestJS Docker containers, ~512 MB RSS each idle, ~1 GB peak per service.
- **Recommended**: **AWS Fargate** (easy) or **Fly.io** (cheap) or **Railway** (devex):
  - Fargate: **~$30/mo per service** (0.5 vCPU / 1 GB / 24×7).
  - Fly.io: **~$10/mo per service** (shared-1x).
  - Railway: **~$15/mo per service**.
- **Small scale**: 2 services × 1 instance = **$20–60/mo**.
- **Medium scale**: 2 services × 2 instances behind ALB = **$80–250/mo**.

### 4.2 Redis (relay queue + presence + jti allowlist)

- **Used for**:
  - Messenger-service: socket.io adapter, envelope queue (`RELAY_DWELL_SECONDS=2592000` = 30-day TTL on undelivered envelopes).
  - Auth-service: JWT JTI allowlist, OTP attempt counters, telemetry stream.
- **Recommended**:
  - **Upstash Redis** (serverless): **$0.2 per 100k commands**, 256 MB free → **~$5–25/mo** small/medium.
  - **AWS ElastiCache t4g.micro**: **~$11/mo** flat.
  - **Fly Redis**: **~$3/mo** for 256 MB.
- **Small scale**: **~$5–15/mo**.
- **Medium scale**: **~$30–60/mo**.

### 4.3 Kafka (audit events) — optional

- **Used for**: shipping audit events to a SIEM for security review. `KAFKA_BROKERS` empty in dev → audit goes to stdout only.
- **Recommended**:
  - **Confluent Cloud Basic**: **$1/GB ingress + $1/GB egress + $0.10/hr** ≈ **$70/mo** minimum.
  - **AWS MSK Serverless**: **$0.75/hr per cluster** ≈ **$540/mo** baseline (overkill at small scale).
  - **Self-hosted Redpanda** on a t4g.small: **$14/mo**.
- **Small scale**: skip Kafka entirely; stdout → CloudWatch is fine. **$0**.
- **Medium scale**: Self-hosted Redpanda. **$14/mo**.

### 4.4 Domain + DNS + SSL

- **Domain**: ~$15/yr (.com via Cloudflare or Namecheap).
- **DNS**: Cloudflare DNS — **free**.
- **SSL**: Let's Encrypt or AWS ACM — **free**.

### 4.5 CDN (static assets — ops-console, mobile OTA bundles)

- **Cloudflare**: free tier covers small/medium scale.
- **CloudFront**: pay-as-you-go (~$0.085/GB).
- **Cost**: **$0** (Cloudflare free tier).

### 4.6 Expo / EAS Build

- **Used for**: Android & iOS production builds via `eas-cli`.
- **Pricing**:
  - Free: 30 builds/mo, queued.
  - **Production**: **$99/mo** — 200 priority builds/mo + concurrent queue + over-the-air updates.
- **Cost at any scale**: **$99/mo** — recommended once you ship.

---

## 5. Forward-looking — items in the spec but not yet wired

These will surface as costs once enabled. Estimated, not committed.

| Item                                                                                 | Pricing                                                                                               | Trigger                                                                                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Cloud-backed message archive** (currently messages dwell in Redis 30 d, then drop) | R2 storage at $0.015/GB-mo. 1 GB ≈ 5M short text envelopes. So **~$5/mo** for 300M archived messages. | When compliance / retention requires server-side persistence beyond the 30-d Redis dwell.                                         |
| **OpenAI / Anthropic** for AI features (if any)                                      | OpenAI: $1.50–$30 per 1M tokens depending on model. Claude: $3–$75 per 1M output tokens.              | None wired in `apps/` or `src/modules/` today. `worldmonitor/` (separate sub-project) has some AI usage; unrelated to Bravo Lite. |
| **Sentry** error tracking                                                            | Free up to 5k events/mo. Team plan **$26/mo** for 50k events.                                         | When Crashlytics-via-Firebase becomes insufficient.                                                                               |
| **Datadog / Grafana Cloud** — observability                                          | Datadog Pro **$15/host/mo + ingest fees**. Grafana Cloud free tier generous.                          | When Cloudwatch logs become unsearchable.                                                                                         |
| **PagerDuty / Opsgenie** — on-call routing                                           | $19/user/mo.                                                                                          | When team grows beyond 1 on-call.                                                                                                 |
| **GitHub Actions** — CI minutes                                                      | Free 2k min/mo on private repos. **$0.008/min** above.                                                | We're well under at this size.                                                                                                    |
| **Vault attachment KMS** (if SOC2 / regulator requires server-side key wrap)         | AWS KMS: $1/key/mo + $0.03 per 10k API calls.                                                         | Currently keys are hardware-backed on-device — no server-side KMS needed. Add only if compliance forces.                          |

---

## 6. Cost-tier summary

| Stage                                     | Stack                                                                                | Total monthly                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Dev (today)**                           | Local Docker · OTP_DEV_BYPASS=true · Stripe test · Supabase local                    | **~$0** (only EAS $99/mo if you build)       |
| **Pre-launch staging** (1 region)         | EC2 t4g.small × 2 + Supabase Pro + Upstash + Mapbox free + Twilio Verify low traffic | **~$120–180/mo**                             |
| **Small scale** (1k MAU / 3k missions)    | Twilio + Stripe + Mapbox free + R2 + Supabase Pro + Fargate ×2 + Redis               | **~$300–400/mo** + **3.5 % of GMV** (Stripe) |
| **Medium scale** (10k MAU / 30k missions) | All of the above scaled                                                              | **~$2,500–3,500/mo** + **3.5 % of GMV**      |

The dominant variable cost at every scale is **Stripe (≈ 3.5 % of GMV)**.
After that, Twilio Verify scales with bookings (each mission ≈ 1 OTP from
the agent + 0–1 from the client). Mapbox Directions only matters once
RE-ROUTE openings × 3 fan-out exceeds 100k/mo.

---

## 7. Cost-saving levers we already control

1. **Mapbox Directions** — cache `route-options` per booking for the booking's lifetime; today every modal open re-fetches.
2. **Twilio Verify** — keep `OTP_DEV_BYPASS=true` for staging environments; only flip on prod.
3. **R2 over S3** — already designed-for via `MEDIA_S3_ENDPOINT` env; just need to point it at R2 to skip egress fees.
4. **Agora rate** — invest in the WebRTC + TURN path quality so fallback rate stays low.
5. **Stripe** — negotiate above $80k/mo GMV. Apply for Stripe Treasury credits.
6. **Supabase** — branch only the production DB; staging uses local Docker.
7. **Audit events** — skip Kafka in early production; CloudWatch logs + an S3 archive bucket is a fraction of the price for compliance-grade retention.
