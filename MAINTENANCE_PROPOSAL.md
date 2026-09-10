# Bravo Secure — Annual Maintenance & Support Proposal

> **Companion to:** [`SCOPE_VS_WIREFRAME.md`](SCOPE_VS_WIREFRAME.md) (scope variation & valuation)
> **Prepared:** 2026-07-25 · against `main` @ `98b71c3`
> **Headline recommendation:** **Tier 2 — USD 3,900 / month**, 12-month minimum term.

---

## 1. What is actually being maintained

This is not a single mobile app. The maintenance contract covers a live, security-critical,
multi-platform production system:

| Component                                                         | Scale                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Mobile app (React Native 0.81 / Expo SDK 54, iOS + Android)       | 262 screens · 189,000 LOC                                                                  |
| `auth-service` (NestJS)                                           | 316 endpoints · 49,400 LOC                                                                 |
| `messenger-service` (NestJS + WebSocket + SFU + TURN)             | 36 endpoints · 23,400 LOC                                                                  |
| `ops-console` (Next.js 15 web app)                                | 30 routes · 16,400 LOC                                                                     |
| `messenger-core` (Signal Protocol / sealed sender / group crypto) | 8,800 LOC                                                                                  |
| Database                                                          | Postgres · 93 migrations · RLS policies                                                    |
| Infrastructure                                                    | Contabo VPS · Docker Compose (6 containers) · Redis · Kafka · coturn · S3/R2               |
| Third-party integrations                                          | Twilio · Stripe · Firebase/FCM · APNs · Mapbox · GDELT · NewsData · Google News · Guardian |
| **Total**                                                         | **~303,000 LOC · 1,449 source files · 352 API endpoints**                                  |

**Critical subsystems that carry real operational risk:** end-to-end encryption (libsignal, sealed
sender v2, group master keys), WebRTC voice/video + group calling via SFU, killed-app push delivery,
financial ledger (Bravo Credits, escrow, settlement, payouts), and the auto-dispatch engine.

A failure in any of these is a **revenue or safety incident**, not a cosmetic bug. That is what the
retainer is really buying.

---

## 2. Requested scope, and what each line costs to deliver

The client has asked for the thirteen lines below. Each one is costed in engineering days per month.

| #   | Requested                                             | What it means operationally                                                                                                                                                              |          Days/mo |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------: |
| 1   | Diagnosis and correction of production bugs           | Triage → reproduce → root-cause → fix → regression-test → release. **243 bugs logged and closed to date** — this is the observed run-rate, not a guess                                   |              5.0 |
| 2   | App crashes, broken screens, failed API calls         | Crash triage across 262 screens; RN native-module faults; device- and OEM-specific breakage                                                                                              |        _(in #1)_ |
| 3   | Booking, allocation, cancellation, status-flow faults | The dispatch engine — 37 files, Redis offer cascade, SLA/expiry/relist timers. Highest-consequence lane; every change needs the `LITE_BOOKING_LOOP` verification run                     |              1.5 |
| 4   | Login, OTP, authentication, account-access faults     | Twilio Verify, TOTP, biometric gates, JWT/refresh/sender-cert lifecycle, device takeover, session revocation                                                                             |              1.0 |
| 5   | Payment and Bravo Credits faults                      | Stripe, wallet ledger, escrow, settlement, auto-renew, refunds, reconciliation. Financial correctness — zero tolerance                                                                   |              1.0 |
| 6   | Push, email and SMS notification failures             | FCM data + VoIP channels, APNs, CallKeep, foreground services, full-screen intents, killed-app delivery. Historically the most fragile subsystem in the product                          |              1.5 |
| 7   | iOS / Android compatibility updates                   | One Android major and one iOS major per year — each a genuine port (edge-to-edge insets, permission model, background execution limits, CallKit/notification changes). Amortised monthly |              1.5 |
| 8   | Dependency and framework updates                      | React Native, **Expo SDK (~2 majors/year)**, NestJS, Next.js, libsignal, mediasoup, op-sqlite/SQLCipher, plus CVE patching across ~6 lockfiles. Amortised monthly                        |              2.5 |
| 9   | App Store & Google Play submission support            | Build, sign, upload, review responses, policy + privacy-label changes, staged rollouts, rollback. Both stores, ~8 releases/year                                                          |              1.5 |
| 10  | Backend, database and API maintenance                 | 2 NestJS services, 352 endpoints, Postgres + 93 migrations, Redis, Kafka, TURN/SFU, Docker on Contabo, backup verification                                                               |              2.0 |
| 11  | Monitoring of errors, crashes and system health       | Alert response, uptime/SLO watch, log review, incident write-ups                                                                                                                         |              1.0 |
| 12  | Technical support to BRAVO management and operators   | Ops Console queries, data pulls, account/tenant corrections, operator training                                                                                                           |              1.5 |
| 13  | Minor wording, configuration and UI corrections       | Copy, labels, pricing config, feature flags, theme/spacing corrections                                                                                                                   |              1.5 |
|     | **Total sustained effort**                            |                                                                                                                                                                                          | **≈ 21 days/mo** |

**That is ~0.95 FTE — and it is not one person's skill set.** It spans React Native, NestJS/Postgres,
WebRTC/SFU, applied cryptography, DevOps and QA.

---

## 3. Service tiers

|                                                                   | **Tier 1 — Essential**        | **Tier 2 — Standard** ⭐                 | **Tier 3 — Managed Operations**       |
| ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------- | ------------------------------------- |
| **Monthly fee (USD)**                                             | **$2,200**                    | **$3,900**                               | **$6,000**                            |
| ≈ EUR / AED                                                       | €2,025 / AED 8,080            | €3,590 / AED 14,325                      | €5,520 / AED 22,035                   |
| **Annual**                                                        | $26,400                       | **$46,800**                              | $72,000                               |
| **Pooled effort**                                                 | up to 10 days/mo              | up to 18 days/mo                         | up to 26 days/mo                      |
| **Coverage window**                                               | Business hours, Sun–Thu       | Business hours + P1 weekend cover        | **24/7 on-call for P1**               |
| **P1 response / fix target**                                      | 24 h / 3 business days        | **4 h / 24 h**                           | **1 h / 8 h**                         |
| **P2 response / fix target**                                      | 3 business days / best effort | Next business day / 5 business days      | Same business day / 3 business days   |
| **P3 (minor / cosmetic)**                                         | Best effort                   | Next release                             | Next release                          |
| Lines 1–6 — bugs, crashes, booking, auth, payments, notifications | ✅                            | ✅                                       | ✅                                    |
| Lines 10–11 — backend/DB/API, monitoring                          | Basic uptime                  | ✅ Full                                  | ✅ Full + proactive tuning            |
| Line 8 — dependency & framework updates                           | Security patches only         | ✅ **1 Expo/RN major per year included** | ✅ Continuous                         |
| Line 7 — iOS/Android OS majors                                    | ✖ _quoted separately_         | ✅ 1 per platform per year               | ✅ Included                           |
| Line 9 — store submissions                                        | 2 releases / yr               | **8 releases / yr, both stores**         | Unlimited                             |
| Line 12 — management & operator support                           | Email only                    | ✅ Dedicated channel, business hours     | ✅ Dedicated channel + named engineer |
| Line 13 — minor wording/config/UI                                 | 1 day/mo                      | ✅ 3 days/mo                             | ✅ 5 days/mo                          |
| Full regression gate per release (412 test files)                 | ✅                            | ✅                                       | ✅                                    |
| Monthly health & incident report                                  | ✖                             | ✅                                       | ✅ + quarterly security audit         |
| Small-enhancement allowance                                       | ✖                             | ✖                                        | ✅ 3 days/mo                          |
| Disaster recovery / restore drill                                 | ✖                             | Annual                                   | Quarterly                             |

> **Recommended: Tier 2 — $3,900/month.**
>
> Tier 1 exists to make Tier 2 look correct and to give a landing spot if budget is genuinely tight —
> but be explicit that Tier 1 **excludes OS majors and SDK upgrades**. That is precisely how an
> unmaintained React Native app becomes unshippable within 18 months: Apple and Google both
> hard-enforce minimum target SDK versions, and an app that misses one is removed from sale.

---

## 4. Why $3,900 is the right number — three independent checks

### Check 1 — Industry AMC benchmark

Standard annual maintenance is **15–25% of system value per year**, at the upper end for
security-critical, realtime, multi-platform systems.

| Valuation basis                  |                Value |           20% / yr |        Per month |                  |
| -------------------------------- | -------------------: | -----------------: | ---------------: | ---------------- |
| What the client has paid so far  |              $20,000 |             $4,000 |             $333 | ❌ unserviceable |
| Paid + variation settlement      |              $70,500 |            $14,100 |           $1,175 | ❌ below cost    |
| **Rebuild value at market rate** | **$176,000–241,000** | **$35,200–48,200** | **$2,930–4,020** | ✅               |

**Anchor the percentage to replacement cost, not to the discounted price they paid.** A maintenance
fee derived from a below-market fixed-price build simply propagates that discount forever.

**$3,900/mo = $46,800/yr ≈ 23% of the low-end rebuild value** — squarely inside the normal band.

### Check 2 — Cost to do it in-house

Tier 2 is ~0.85 FTE spread across four disciplines. Fully loaded in the UAE
(salary + visa + insurance + gratuity + tooling):

| Role required                        | Fully loaded / yr | Fraction needed |             Cost |
| ------------------------------------ | ----------------: | --------------: | ---------------: |
| Senior React Native engineer         |           $70,000 |            0.35 |          $24,500 |
| Backend engineer (NestJS + Postgres) |           $65,000 |            0.30 |          $19,500 |
| DevOps / SRE                         |           $70,000 |            0.10 |           $7,000 |
| QA engineer                          |           $40,000 |            0.10 |           $4,000 |
|                                      |                   |                 | **$55,000 / yr** |

Tier 2 delivers the same coverage for **$46,800** — with no hiring risk, no single point of failure,
no ramp-up, and a team that already knows a 300,000-line codebase and its 243-bug history.
**This is the strongest argument in the proposal.**

### Check 3 — Effective day rate

$3,900 ÷ 18 days = **$217/day**.

Maintenance carries SLA obligations, reactive interruption and context-switching cost, so it is
normally priced **above** build rate. Against the Phase-1 implied build rate of $182/day, a $217
maintenance rate is a modest and easily defended uplift.

---

## 5. Severity definitions (put these in the contract)

| Level             | Definition                                                            | Examples                                                                                                                 |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **P1 — Critical** | Production down, data loss, security breach, or revenue/safety impact | Login broken · payments failing · calls not connecting · dispatch not assigning · message loss · app rejected from store |
| **P2 — Major**    | Significant feature broken, workaround exists                         | Push notifications delayed · backup restore failing · a screen crashing on one OEM · Ops Console section erroring        |
| **P3 — Minor**    | Cosmetic, copy, or low-impact defect                                  | Wrong label · spacing issue · non-blocking validation message                                                            |
| **P4 — Request**  | Config change, data pull, question                                    | Pricing config update · feature-flag flip · report export                                                                |

**Clock runs during the tier's coverage window.** State the timezone explicitly: business hours =
**09:00–18:00 GST, Sunday–Thursday**.

---

## 6. Commercial terms

| Term                | Recommended                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Minimum term**    | 12 months, then rolling monthly                                                                      |
| **Notice period**   | 60 days, either side                                                                                 |
| **Payment**         | Monthly in advance · **or 10% discount if 12 months paid annually in advance** (Tier 2: **$42,100**) |
| **Unused days**     | Roll over **one month only**, then lapse — prevents banking a year and demanding it in December      |
| **Overage rate**    | **$260/day** beyond the pooled allowance, pre-approved in writing                                    |
| **Annual uplift**   | +5% per renewal year, or CPI if higher                                                               |
| **Escalation path** | Named contacts both sides · P1 raised by phone, not email                                            |
| **Reporting**       | Monthly report: tickets opened/closed, SLA performance, days consumed, releases shipped, incidents   |
| **Handover clause** | On termination, 10 days of knowledge transfer included at no charge                                  |
| **Load assumption** | Priced for ≤10k MAU / ≤30k missions per month. Exceeding it triggers a good-faith re-rate            |

### Third-party costs — excluded, passed through

Billed **at cost + 15% management margin** if we administer the accounts
(see [`docs/planning/RECURRING_COSTS.md`](docs/planning/RECURRING_COSTS.md)):

| Service                                      | Model                                | ~1k MAU                             | ~10k MAU                 |
| -------------------------------------------- | ------------------------------------ | ----------------------------------- | ------------------------ |
| Twilio Verify (OTP/SMS)                      | $0.05 / verification + number rental | ~$200–250/mo                        | ~$1,500–1,800/mo         |
| Stripe                                       | 2.9% + $0.30 per charge              | volume-linked                       | volume-linked            |
| Contabo VPS + TURN/SFU egress                | fixed + bandwidth                    | ~$60–120/mo                         | scales with call minutes |
| Mapbox · S3/R2 · FCM/APNs · GDELT · NewsData | metered                              | —                                   | —                        |
| Apple Developer / Google Play                | $99/yr · $25 one-off                 | **client's account, client's cost** |                          |

### Explicitly excluded from all tiers

Quoted separately at **$250/day**:

- Any new feature, screen, module or integration
- The wireframe gap list (Bravo Calendar sync, AI scheduling engine, GEO risk review, predictive
  intel, ad-serving backend) — see `SCOPE_VS_WIREFRAME.md` §6 and §8.3 Package 2
- Changes to encryption primitives, sealed-sender envelope shape, group key distribution, or the
  File Vault MFA gate _(architecture-approval gated)_
- New tenants, new regions, new payment providers, white-labelling
- Data migrations arising from client-side business-model changes
- Third-party outages outside our control (best-effort mitigation only)

---

## 7. How to present it

Do **not** send the variation invoice and this proposal as two separate asks. Bundle them — the
maintenance contract is what makes the variation easy to sign.

> **Option A — Settle and maintain (recommended)**
> Variation settlement **$50,500** + Tier 2 AMC **$3,900/mo**, 12-month term.
> _Sweetener:_ first month of maintenance free, **or** the $14,000 gap-completion package delivered
> at **$9,500** if both are signed together.
>
> **Option B — Cashflow variant**
> Reduced settlement **$26,000** + Tier 2 AMC at **$4,400/mo**, 18-month minimum.
> Twelve months returns $79,200; eighteen returns $105,200. Better total, worse certainty.
>
> **Option C — Maintenance only** _(only if the variation is genuinely refused)_
> Tier 2 at **$4,800/mo**, 24-month minimum, no free month.
> State the logic plainly: _"the Ops Console, dispatch engine, SFU and backup system all have to be
> kept alive whether or not they were invoiced — if they are not paid for once, they get paid for
> monthly."_

**Negotiation rule:** the settlement number and the retainer number move in **opposite** directions.
Every dollar conceded on the settlement should add roughly **$40–60/month** to the retainer.

**Three talking points that close it:**

1. _"In-house this is $55,000 a year across four roles. You are being quoted $46,800 for the team
   that already knows the system."_
2. _"Apple and Google both enforce minimum target SDK versions. Without the OS-major coverage in
   Tier 2, the app stops being shippable inside eighteen months — that is not a support issue, it is
   an availability issue."_
3. _"243 bugs have been found and closed to date. That is the actual run-rate of a system this size.
   The retainer is priced on evidence, not on estimate."_

---

## 8. One-line summary

> **Tier 2 — USD 3,900 / month ($46,800/yr, or $42,100 paid annually), 12-month minimum.**
> Covers all thirteen requested lines in full, ~18 engineering days per month, 4-hour P1 response,
> 8 store releases a year, one Expo/RN major and one OS major per platform per year.
> Third-party service costs passed through at cost + 15%. New features quoted separately at $250/day.
