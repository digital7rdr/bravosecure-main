# Bravo Secure — Wireframe (r4) vs. Delivered Build

> **Purpose:** establish, with file-level evidence, the difference between the scope defined in
> `BRAVO ARCHITECTURE - Wireframes mockups r4.pdf` (17 pages, "WIRE FRAMES version 1.4", PHASE 1)
> and the system that has actually been built — and to price the variation.
>
> **Baseline contract value:** USD 20,000 (fixed price, Phase 1).
> **Prepared:** 2026-07-25 · against `main` @ `98b71c3` · 727 commits.

---

## 1. Executive summary

|                                        |                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Screens described in the wireframe** | ~48 across 8 modules (Messenger, Lite, Pro, Department, Agent, News/Ads, Payments, VBG)    |
| **Screens actually shipped**           | **262 screen files** across 15 modules                                                     |
| **Platforms in the wireframe**         | Mobile app only                                                                            |
| **Platforms shipped**                  | Mobile app **+ a 30-route web Ops Console** (never specified)                              |
| **Backend in the wireframe**           | Implied, never specified                                                                   |
| **Backend shipped**                    | 2 NestJS services, **352 API endpoints**, 93 DB migrations, Redis, Kafka, SFU, TURN        |
| **Total code shipped**                 | ~**303,000 lines** (TS/TSX/Kotlin), 1,449 source files                                     |
| **Verification apparatus**             | 412 test files · 243 logged & triaged bugs (`sqa.md`) · 45 audit reports · 13 ops runbooks |

**Headline finding:** the delivered system is roughly **3× the specified scope**. Ten substantial
modules were built that appear **nowhere** in the wireframe, including an entire second application
(the web Ops Console). Conservatively estimated, the work beyond the wireframe is **~321 engineering
days**, against a baseline scope of roughly **~110 days**.

**Counter-finding (stated honestly):** one wireframe area — **Bravo Pro's AI retainer layer**
(Bravo Calendar sync, AI auto-scheduling, per-event GEO risk review) — is materially **under-delivered**
at ~40%. Section 6 lists every such gap. This should be disclosed and quoted as a separate completion
package rather than discovered by the client.

---

## 2. Method & evidence

Every claim below is anchored to code in this repository:

- Wireframe text extracted verbatim from all 17 PDF pages.
- Delivered surface enumerated from `src/screens/**`, `src/modules/**`, `apps/**`, `packages/**`.
- Line counts via `find | cat | wc -l` per directory; endpoint counts via decorator scan of
  `*.controller.ts`; migration count from `supabase/migrations/`.
- "Not delivered" claims verified by targeted grep before being written down.

---

## 3. Module-by-module comparison

### 3.1 Phase 1 · Onboarding (wireframe pp. 2–3)

| Wireframe asked                                                   | Delivered                                                                                                     | Verdict        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
| Splash (2.5s auto-advance)                                        | `SplashScreen.tsx`                                                                                            | ✅ Met         |
| Path Selection — 3 paths                                          | `HomeSelectionScreen.tsx`, `ProductGateScreen.tsx`                                                            | ✅ Met         |
| 7-step registration                                               | `RegisterScreen`, `ProfileCompletionScreen`, `SignupSuccessScreen`                                            | ✅ Met         |
| Verification method — 4 options (OTP / TOTP / Face / Fingerprint) | `OTPVerificationScreen`, `OtpVerifyScreen`, `apps/auth-service/src/totp/`, `apps/auth-service/src/biometric/` | ✅ Met         |
| Permission Setup — 5 permissions, one step                        | `PermissionsScreen.tsx`                                                                                       | ✅ Met         |
| Role Selection — Individual / Corporate                           | `RoleSelectionScreen.tsx`                                                                                     | ✅ Met         |
| —                                                                 | **Extra:** product-scoped plan gate, pending-tier resume, invite/referral code entry                          | ➕ Beyond spec |

**Verdict: met, plus commercial gating that was never specified.**

---

### 3.2 Bravo Messenger (wireframe pp. 4–5)

| Wireframe asked                                     | Delivered                                                                                                                                                        | Verdict                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Chats Hub, Individual Chat, New Message, Group Chat | `MessengerHomeScreen`, `ChatScreen`, `NewChatScreen`, `GroupsScreen`                                                                                             | ✅ Met                   |
| Voice call, Video call                              | `VoiceCallScreen`, `CallScreen`, `FloatingCallOverlay`                                                                                                           | ✅ Met                   |
| Calls Log, Files Tab, Chat Info                     | `CallsLogScreen`, `FilesScreen`, `ChatInfoScreen`, `LinksScreen`                                                                                                 | ✅ Met                   |
| Group calls "phone/video icons in header"           | Full **mediasoup SFU** (2,699 LOC + worker pool), SFrame E2EE, TURN credential service, `GroupCallScreen`, `IncomingGroupCallScreen`, tile pager                 | ➕➕ **Far beyond spec** |
| Read receipts, typing, presence dots                | Delivered **plus** delivered/undeliverable leg parity, last-seen retention + privacy strip, skew window                                                          | ➕ Beyond spec           |
| Reply-by-quoting                                    | Delivered **plus** reactions, @mentions, edit/delete over the wire, read-by sheet                                                                                | ➕ Beyond spec           |
| Inline media preview                                | Encrypted media pipeline (AES-256-CBC per file, S3 presign, LRU blob cache, upload progress, multi-photo + zoom)                                                 | ➕ Beyond spec           |
| Voice message (hold mic)                            | Full recorder lifecycle + plaintext cleanup guarantees                                                                                                           | ➕ Beyond spec           |
| —                                                   | **Extra:** encrypted **cloud backup & restore with Merkle-tree verification**, ratchet snapshots, background/batched restore, boot silent resume                 | ➕➕ **Never specified** |
| —                                                   | **Extra:** killed-app push (FCM data + VoIP channels), CallKeep, full-screen intents, foreground services, lock-screen call continuity, in-place WS auth refresh | ➕➕ **Never specified** |
| —                                                   | **Extra:** local SQLCipher store, disappearing-message sweeper both client and server side                                                                       | ➕ Beyond spec           |

**Verdict: met, then substantially exceeded. Backup/Merkle and the SFU are each a project in their own right.**

---

### 3.3 Bravo Lite — booking (wireframe pp. 6–7)

| Wireframe asked                                                     | Delivered                                                                                                                                                                                                                                                                                                               | Verdict                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Zone Map landing, Service Type, Schedule, Baseline Package, Add-Ons | `ZoneMapScreen`, `ServiceTypeScreen`, `BookingDateTimeScreen`, `BaselinePackageScreen`, `AddOnsScreen`, `CustomizeAddOnsScreen`                                                                                                                                                                                         | ✅ Met                                                          |
| Ops room Review — 3 states (Pending/Approved/Rejected)              | `OpsRoomReviewScreen` + real ops approval pipeline                                                                                                                                                                                                                                                                      | ✅ Met                                                          |
| Pricing & Payment, Booking Confirmation                             | `CreditPaywallScreen`, `BookingConfirmationScreen`, `InvoiceScreen`                                                                                                                                                                                                                                                     | ✅ Met                                                          |
| Live Operations — 3-tab, emergency button                           | `LiveTrackingScreen`, `SOSScreen`, `MissionCompleteScreen`, `TripSummaryScreen`, `RateAgencyScreen`                                                                                                                                                                                                                     | ✅ Met                                                          |
| —                                                                   | **Extra:** full **auto-dispatch engine** — Redis offer cascade, offer expiry, relist timeout, crew SLA, arrival/no-show detection, claim/withdraw, abandon handling, scheduled dispatch, dispatch SLO metrics, dispatch inspector, privacy purge, team verify codes (**37 files** in `apps/auth-service/src/dispatch/`) | ➕➕ **Never specified** — wireframe had manual ops review only |
| —                                                                   | **Extra:** real GPS telemetry mirror + WS emit, heading, mission foreground service, live map route lines                                                                                                                                                                                                               | ➕ Beyond spec                                                  |
| —                                                                   | **Extra:** escrow/settlement + payout module, agency acceptance lane                                                                                                                                                                                                                                                    | ➕ Beyond spec                                                  |

**Verdict: met, plus a dispatch engine the wireframe never contemplated.**

---

### 3.4 Bravo Pro — retainer (wireframe pp. 8–9) ⚠️ **the one shortfall**

| Wireframe asked                                                                                     | Delivered                                                                                   | Verdict                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| Retainer Selection — Custom Plan only, documented baseline                                          | `ProRetainersScreen`, `ProLandingScreen`                                                    | ✅ Met                           |
| Client Profile — risk bar, KYC badge, contract ref                                                  | `ProClientProfileScreen`                                                                    | ✅ Met                           |
| Team Config — CPO/vehicle steppers, gender preference, driver-only                                  | `ProTeamConfigScreen`, `ProAssignedTeamScreen`                                              | ✅ Met                           |
| Live Mission Monitor — 3-tab Assets/Intel/Comms                                                     | `ProLiveMissionScreen` (138 LOC)                                                            | 🟡 Thin                          |
| Activity & INTEL — archive + predictive intelligence, 5-vector threat score                         | `ProActivityHistoryScreen`, `TripHistoryScreen`                                             | 🟡 Partial — no predictive layer |
| Individual Profile (+4 family)                                                                      | `IndividualProfileScreen` + `apps/auth-service/src/family/`                                 | ✅ Met                           |
| Corporate Profile (+10 members, 4 roles)                                                            | `CorporateProfileScreen` + org roles                                                        | ✅ Met                           |
| **Bravo Calendar** — native calendar, ICS/PDF/Excel upload, Google/Outlook sync, AI event parsing   | `ItineraryUploadScreen` only. **No `.ics` handling, no Google/Outlook sync, no AI parser.** | ❌ **Not delivered**             |
| **AI Schedule View** — auto-assign CPOs, week/list views, conflict detection, AI summary            | `ProAISchedulingScreen` — an honest empty state that routes to itinerary upload. No engine. | ❌ **Not delivered**             |
| **GEO Risk Review** — per-event risk bar, contributing factors, AI recommendation, Approve/Escalate | `ProRiskReviewScreen` (123 LOC)                                                             | 🟡 Thin                          |

**Verdict: ~60% delivered. The AI retainer layer is the single genuine gap in the whole build.**

**What was built _instead_ (and was never asked for):** a full **subscription/tier commercial system** —
Lite / **Bravo Secure Pro** / Enterprise, scoped per product path (`src/screens/pro/tierMatrix.ts`),
with ops-editable pricing, Stripe auto-renewing subscriptions, Bravo-Credit-funded renewals, a lapse
cron, server-side `TierGuard` enforcement, client entitlement derivation, and paywall screens.

Note this is a **direct reversal of the brief**: the wireframe states _"Custom Plan only — Silver /
Gold / Platinum tiers removed."_ The delivered tier ladder is a new commercial model, built at the
client's later direction, and is legitimately chargeable as a variation — but it consumed the budget
that the AI retainer layer would otherwise have used. **That trade should be stated plainly.**

---

### 3.5 Department Messenger (wireframe p. 10) — largest single overbuild

The wireframe asked for **two screens**, and was explicit about keeping it minimal:

> _"Simple list of pre-created channels — one per department"_
> _"No threads or reactions — kept simple per product brief"_

| Wireframe asked         | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Department Channels Hub | `DepartmentChannelsScreen`, `DepartmentalHomeScreen`, `ManageChannelsScreen`, `ChannelEditorScreen`, `ChannelMembersScreen`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Department Channel Chat | `DepartmentChatScreen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| —                       | **21 screens total**, including: ML Kit **face-capture attendance verification** (`VerifyAttendanceScreen`, `AttendanceResultScreen`, `MyAttendanceScreen`, `AdminAttendanceScreen`, `DayStatusScreen`), **shift management** (`ShiftManagementScreen`, `ShiftEditorScreen`), **incident reporting** with category → details → evidence → FSM → queue → dispute → PDF export (`ReportIncident*`, `IncidentQueueScreen`, `IncidentDetailScreen`, `MyIncidents*`, `EvidenceSection`), employee directory, dept-scoped manager permissions |
| —                       | Backend: `apps/auth-service/src/attendance/`, `src/incident/` (with a formal incident FSM), `src/department/`, plus attendance rollups and a checkout-verify flow                                                                                                                                                                                                                                                                                                                                                                       |

**Verdict: 2 screens specified → 21 screens + 3 backend modules delivered. ~10× the brief.**

---

### 3.6 Bravo Agent (wireframe pp. 11–12)

| Wireframe asked                                           | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Agent Type Select (3 types)                               | `AgentTypeSelectScreen`                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ Met                   |
| Registration Wizard (4 steps)                             | `AgentRegistrationWizardScreen`, `AgentRegistrationScreen`                                                                                                                                                                                                                                                                                                                                                                    | ✅ Met                   |
| KYC Verification (4 checks)                               | `AgentKYCScreen`, `AgentVerificationStatusScreen`                                                                                                                                                                                                                                                                                                                                                                             | ✅ Met                   |
| Coverage / regions (6 toggles)                            | `AgentCoverageScreen`, `OrgRegionScreen`                                                                                                                                                                                                                                                                                                                                                                                      | ✅ Met                   |
| Availability Setup (4 modes, capability badges)           | `AgentAvailabilityScreen`                                                                                                                                                                                                                                                                                                                                                                                                     | ✅ Met                   |
| Document Upload (6 slots)                                 | `AgentDocsUploadScreen`                                                                                                                                                                                                                                                                                                                                                                                                       | ✅ Met                   |
| Admin Approval (5-step pipeline, 3 states)                | `AgentAdminApprovalScreen`, `AgentVerifiedScreen`, `AgentRejectedScreen`                                                                                                                                                                                                                                                                                                                                                      | ✅ Met                   |
| Deployment Requirements (5-step, **QR deployment token**) | `AgentDeploymentRequirementsScreen` (352 LOC) — **no QR token found**                                                                                                                                                                                                                                                                                                                                                         | 🟡 Partial               |
| Agent Dashboard (5-tab nav)                               | `AgentDashboardScreen`, `AgentHomeScreen`, `JobPortalScreen`, `JobMarketplaceScreen`, `EarningsScreen`                                                                                                                                                                                                                                                                                                                        | ✅ Met                   |
| —                                                         | **Extra: full service-provider / agency multi-tenancy** — `OrgRosterScreen`, `OrgHierarchyScreen`, `OrgCreateCpoScreen`, `OrgCpoProfileScreen`, `OrgCpoMissionsScreen`, `OrgMissionsScreen`, `OrgMissionDetailScreen`, `OrgEarningsScreen`, `OrgComplianceScreen`, `ManagerPermissionsScreen`, `MissionLeadConsoleScreen`, invite codes, referral codes, per-org E2EE chat workspace with rekey seam, org-as-payee settlement | ➕➕ **Never specified** |
| —                                                         | **Extra:** separate CPO on-duty track (`OnDutyHomeScreen`, `AssignedMissionDetailScreen`, `CpoActivationScreen`, `AccessEndedScreen`), incoming-offer watcher, attendance, mission summary                                                                                                                                                                                                                                    | ➕ Beyond spec           |

**Verdict: met, plus an entire B2B tenancy model (companies owning managed CPOs) that the wireframe reduced to a single dropdown option.**

---

### 3.7 News & Ads (wireframe pp. 13–14)

| Wireframe asked                                     | Delivered                                                                                                                                                                                                              | Verdict        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| News Hub (3 section cards)                          | `NewsHubScreen`                                                                                                                                                                                                        | ✅ Met         |
| Regional News Feed (region chips, ticker, trending) | `NewsFeedScreen`                                                                                                                                                                                                       | ✅ Met         |
| Article Detail                                      | `NewsArticleScreen`                                                                                                                                                                                                    | ✅ Met         |
| GEO Ad — Cyber / GEO JV Adverts                     | `NewsAdsScreen` — **partner cards are static demo data, no ad-serving backend**                                                                                                                                        | 🟡 UI shell    |
| User Preferences                                    | `NewsPreferencesScreen`                                                                                                                                                                                                | ✅ Met         |
| —                                                   | **Extra:** real intel aggregation backend — GDELT, NewsData, Google News, Guardian, RSS, HackerNews, Reddit clients + geocoding, geofencing, threat classification (`apps/auth-service/src/vbg/`, `src/modules/news/`) | ➕ Beyond spec |

---

### 3.8 Payments (wireframe p. 15) & File Vault (p. 16)

| Wireframe asked                                                              | Delivered                                                                                                                                                      | Verdict                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pricing Display (EUR primary, AED reference)                                 | `PricingScreen`                                                                                                                                                | ✅ Met                                               |
| Payment Method (Card / Credits / Corporate)                                  | `PaymentMethodsScreen`, `CreditPaywallScreen`                                                                                                                  | ✅ Met                                               |
| Credits Balance (batch expiry, AED 1:1)                                      | `CreditsScreen` + `apps/auth-service/src/wallet/`                                                                                                              | ✅ Met                                               |
| Card Payment — tokenised via Stripe/Telr, 3DS                                | Stripe integration live (`wallet/stripe.client.ts`); 3DS referenced in `CreditPaywallScreen`                                                                   | 🟡 Verify on device                                  |
| Payment Confirmed + credits awarded                                          | Delivered                                                                                                                                                      | ✅ Met                                               |
| File Vault — **500 MB free**, sold in **500 MB increments**, MFA per session | `FileVaultPurchaseScreen`, `VaultLockScreen`, `VaultOTPVerifyScreen`, `VaultNewPinScreen`, `VaultForgotScreen`, server MFA guard with single-use action tokens | 🟡 **Shipped as 100 MB free** — deviation to confirm |
| —                                                                            | **Extra:** escrow, settlement, payout ledger, auto-renew subscriptions, BC top-up                                                                              | ➕ Beyond spec                                       |

---

### 3.9 Virtual Bodyguard (wireframe p. 17)

| Wireframe asked                                                                                    | Delivered                                                                                                                                                                                                     | Verdict        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| VBG Home (PROTECTED badge, principal card, live location, 3 intel cards, quick actions, ops strip) | `VBGHomeScreen`                                                                                                                                                                                               | ✅ Met         |
| SRA Screen (+ hourly biometric monitoring, 3-missed escalation)                                    | `VBGSRAScreen`, `VbgScanPrompt` — escalation with `missed_count` is real                                                                                                                                      | ✅ Met         |
| OSINT Threat Feed                                                                                  | `VBGOSINTScreen`, `IntelFeedScreen`                                                                                                                                                                           | ✅ Met         |
| Nearby Key Points (tactical map, resource markers, distances)                                      | `VBGNearbyScreen`, `VbgKeyPointsMap`, `VBGMapScreen`                                                                                                                                                          | ✅ Met         |
| —                                                                                                  | **Extra:** GeoRisk radius + time-window search (`VBGGeoRiskScreen`), location history, next-of-kin favourites (server-backed, reinstall-durable, `tel:` dialer), dedicated emergency screen, 5-tab VBG footer | ➕ Beyond spec |

**Verdict: 4 screens specified → 13 delivered, backed by a real threat-intel service.**

---

## 4. Built but **never specified anywhere in the wireframe**

These have **zero** corresponding wireframe page. They are pure additional scope.

| #       | Module                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                           | Est. days    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------ |
| **A1**  | **Web Ops Console** (Next.js 15) — 30 routes: live mission wall, dispatch inspector, finance, compliance, audit trail, user admin, agents, bookings, incidents, SOS, VBG, departments, dept-attendance, analytics, admin management, messenger. Includes its own IndexedDB + AES-GCM vault and libsignal client so operators can join encrypted rooms. | `apps/ops-console/` — 16,404 LOC, 63 files                                         | **40**       |
| **A2**  | **Service-provider / agency multi-tenancy** — orgs owning managed CPOs, hierarchy, manager module permissions, org-as-payee payouts, compliance, invite + referral codes, per-org E2EE workspace                                                                                                                                                       | `apps/auth-service/src/org/`, 15 `Org*` screens                                    | **28**       |
| **A3**  | **Department Chat v2** — attendance (ML Kit face capture), shifts, incident reporting + FSM + dispute + PDF export                                                                                                                                                                                                                                     | `deptchat/` 21 screens, `attendance/`, `incident/`, `department/`                  | **32**       |
| **A4**  | **Auto-dispatch engine** — Redis cascade, offer expiry, relist, crew SLA, arrival/no-show, claim/withdraw, scheduled dispatch, SLO, inspector, privacy purge                                                                                                                                                                                           | `apps/auth-service/src/dispatch/` — 37 files                                       | **27**       |
| **A5**  | **Subscription / tier system** — Lite / Pro / Enterprise per product path, Stripe auto-renew, BC-funded renewal, lapse cron, `TierGuard`, entitlements, paywalls                                                                                                                                                                                       | `subscription/`, `tierMatrix.ts`, `entitlements.ts`                                | **14**       |
| **A6**  | **Encrypted cloud backup + Merkle verification** — mirror pipeline, commits, verifier, repair, ratchet snapshots, background/batched restore, boot resume, flush ledger                                                                                                                                                                                | `messenger-service/src/backup/`, `src/modules/messenger/backup/`, `BACKUP_LOOP.md` | **22**       |
| **A7**  | **VBG depth** — GeoRisk radius/time search, GDELT + NewsData blend, Overpass/Mapbox keypoints, next-of-kin, location history                                                                                                                                                                                                                           | `auth-service/src/vbg/`, `src/modules/vbg/`                                        | **13**       |
| **A8**  | **Group calling SFU** — mediasoup service + worker pool, SFrame E2EE, TURN issuance, group call UI                                                                                                                                                                                                                                                     | `messenger-service/src/sfu/` (2,699 LOC), `src/modules/messenger/webrtc/`          | **22**       |
| **A9**  | **Killed-app push & call continuity** — FCM data + VoIP channels, CallKeep, full-screen intents, foreground services, lock-screen continuity, WS auth refresh                                                                                                                                                                                          | `messenger-service/src/push/`, `android/` native                                   | **14**       |
| **A10** | **Infrastructure & delivery** — Contabo VPS, Docker Compose (6 containers), GitHub Actions auto-deploy, Redis, Kafka, observability/telemetry, SBOM, bundle-size + dead-code + typecheck gates, Husky                                                                                                                                                  | `.github/workflows/`, `scripts/deploy-staging.sh`, `observability/`                | **13**       |
| **A11** | **iOS track** (conditional — bill only if contract was Android-first) — CallKit/VoIP, iOS build pipeline, cross-platform call parity                                                                                                                                                                                                                   | `docs/runbooks/IOS_*.md`, `CROSS_PLATFORM_CALL_VIDEO_LOOP.md`                      | **9**        |
|         | **Subtotal — net-new modules**                                                                                                                                                                                                                                                                                                                         |                                                                                    | **234 days** |

---

## 5. Built **deeper** than specified

Not new modules, but delivery far past what a wireframe bullet implies.

| #      | Item                                                                                                                                                                                                                                               | Evidence                                                     | Est. days   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------- |
| **B1** | Messenger production hardening — reactions, @mentions, edit/delete over the wire, receipt leg parity, presence privacy + skew, voice-note lifecycle, link previews, media LRU cache, upload progress, boot-drain yielding, transport single-source | 12 dedicated regression suites                               | **25**      |
| **B2** | Design system — full navy→obsidian migration, 252 native alerts replaced with a branded host, app-wide keyboard-inset rule (`useKeyboardLayout`), responsive/foldable support, accessibility sweep, `DESIGN_REVIEW_LOOP.md` process                | `docs/audits/KEYBOARD_INSET_AUDIT_*`, obsidian sweep commits | **20**      |
| **B3** | QA & verification apparatus — 412 test files, 243 logged/triaged bugs, 45 audit reports, 13 ops runbooks, regression-test contract, mutation testing, flake detection, code knowledge graph                                                        | `sqa.md` (9,130 lines), `docs/audits/`, `docs/runbooks/`     | **30**      |
| **B4** | Data & API surface — 93 migrations, 352 endpoints, RLS policies, audit logging                                                                                                                                                                     | `supabase/migrations/`, controller scan                      | **12**      |
|        | **Subtotal — depth beyond spec**                                                                                                                                                                                                                   |                                                              | **87 days** |

**Total variation: 234 + 87 = ~321 engineering days.**

---

## 6. Wireframe items **not** delivered or partial (disclose these)

| Ref | Item                                                                                                       | Status                    | Est. days to close |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------ |
| C1  | **Bravo Calendar** — ICS/Excel upload, Google/Outlook sync, AI event parsing (p.8)                         | Not built                 | 12                 |
| C2  | **AI Schedule View** — CPO auto-assign, conflict detection, week/list views (p.8)                          | Empty state only          | 14                 |
| C3  | **GEO Risk Review** — per-event score bar, contributing factors, AI recommendation, Approve/Escalate (p.8) | Thin (123 LOC)            | 8                  |
| C4  | **Predictive intelligence** — 5-vector composite threat score, geo-tagged forecast (p.9)                   | Not built                 | 7                  |
| C5  | Video-call **Blur / Background toggle + Effects** — called a "brand differentiator" (p.5)                  | Not found                 | 4                  |
| C6  | **Bravo Deployment Token (QR)** issued on activation (p.12)                                                | Not found                 | 3                  |
| C7  | **Temporary E2EE share links** (p.5) — shipped as a WhatsApp-style links _browser_ instead                 | Reinterpreted             | 4                  |
| C8  | File Vault **500 MB free / 500 MB increments** (p.16) — shipped as 100 MB free                             | Deviation                 | 1                  |
| C9  | **GEO Ads / JV Adverts** — partner cards are static demo data, no ad-serving or commission tracking (p.13) | UI shell                  | 9                  |
| C10 | Card payment **3D Secure** end-to-end                                                                      | Needs device verification | 2                  |
|     | **Total to close the gap list**                                                                            |                           | **~64 days**       |

> Raising C1–C10 yourself converts a liability into a second sale. See §8, Package 2.

---

## 7. Scale evidence

| Metric                                  | Value                         |
| --------------------------------------- | ----------------------------- |
| Source files (TS/TSX/Kotlin/Java/Swift) | 1,449                         |
| Total lines of code                     | ~303,000                      |
| — Mobile screens                        | 78,348 LOC / 262 files        |
| — Mobile domain modules                 | 110,805 LOC / 545 files       |
| — auth-service (NestJS)                 | 49,391 LOC / 304 files        |
| — messenger-service (NestJS)            | 23,410 LOC / 100 files        |
| — ops-console (Next.js)                 | 16,404 LOC / 63 files         |
| — messenger-core (shared crypto)        | 8,843 LOC / 30 files          |
| API endpoints                           | 352 (316 auth + 36 messenger) |
| Database migrations                     | 93                            |
| Test files                              | 412                           |
| Git commits                             | 727                           |
| Bugs logged, triaged & fixed            | 243 (`sqa.md`, 9,130 lines)   |
| Audit reports                           | 45                            |
| Ops runbooks                            | 13                            |

---

## 8. Commercial — what to charge for the extras

### 8.1 The rate you already implicitly agreed

The wireframe scope (48 screens + supporting backend) is realistically **~110 engineering days**.

```
USD 20,000 ÷ 110 days  ≈  USD 182 / day  ≈  USD 23 / hour
```

That is a **fixed-price bargain rate** — well below any market benchmark. It is also the fairest
anchor for the variation, because the client cannot object to being charged the rate they set.

| Benchmark                          | Blended day rate | Same 321 days would cost |
| ---------------------------------- | ---------------- | ------------------------ |
| Your implied Phase-1 rate          | $182             | **$58,400**              |
| South Asia / Eastern Europe agency | $300–400         | $96,000–128,000          |
| UAE / UK / EU agency               | $550–750         | $176,000–241,000         |
| US agency                          | $900–1,200       | $289,000–385,000         |

**Use the market column as the anchor, then quote the implied-rate column as the offer.**
The message is: _"this is a $175k build; you are being invoiced $58k because we honoured your original rate."_

---

### 8.2 Line-item variation invoice (at $182/day)

**Category A — modules never specified (fully billable):**

| Ref | Module                                  |    Days |      Amount |
| --- | --------------------------------------- | ------: | ----------: |
| A1  | Web Ops Console                         |      40 |      $7,280 |
| A2  | Service-provider / agency tenancy       |      28 |      $5,096 |
| A3  | Department Chat v2                      |      32 |      $5,824 |
| A4  | Auto-dispatch engine                    |      27 |      $4,914 |
| A6  | Encrypted backup + Merkle verification  |      22 |      $4,004 |
| A8  | Group calling SFU + SFrame              |      22 |      $4,004 |
| A5  | Subscription / tier system              |      14 |      $2,548 |
| A9  | Killed-app push + call continuity       |      14 |      $2,548 |
| A7  | VBG depth (GeoRisk, OSINT, next-of-kin) |      13 |      $2,366 |
| A10 | Infrastructure, CI/CD, observability    |      13 |      $2,366 |
| A11 | iOS track _(conditional)_               |       9 |      $1,638 |
|     | **Subtotal A**                          | **234** | **$42,588** |

**Category B — depth beyond spec (negotiable / partly absorbable):**

| Ref | Item                                          |   Days |      Amount |
| --- | --------------------------------------------- | -----: | ----------: |
| B1  | Messenger production hardening                |     25 |      $4,550 |
| B2  | Design system + accessibility + responsive    |     20 |      $3,640 |
| B3  | QA apparatus (412 tests, 243 bugs, 45 audits) |     30 |      $5,460 |
| B4  | Extra data model + API surface                |     12 |      $2,184 |
|     | **Subtotal B**                                | **87** | **$15,834** |

|                                                  | Days |      Amount |
| ------------------------------------------------ | ---: | ----------: |
| **Full variation (A + B)**                       |  321 | **$58,422** |
| **Recommended ask** (A in full + B at 50%)       |      | **$50,500** |
| **Negotiation floor** (A only, iOS dropped)      |      | **$41,000** |
| **Hard floor** (top 4 modules only: A1+A2+A3+A4) |      | **$23,100** |

> Currency reference at 1 USD ≈ 0.92 EUR ≈ 3.6725 AED (confirm on invoice date):
> **$50,500 ≈ €46,500 ≈ AED 185,000.**

---

### 8.3 Three ways to package it

**Package 1 — Variation settlement (recommended)**

> One-off change-order for delivered-but-unspecified scope.
> **Ask $50,500 · settle no lower than $41,000.**
> Strongest position: the work is already delivered, running, and tested. Lead with §7's metrics
> and the Ops Console — it is the single hardest item to argue against, because it is a whole
> second application that appears on zero wireframe pages.

**Package 2 — Gap-completion (sell alongside)**

> Close C1–C10: Bravo Calendar sync, AI scheduling engine, GEO risk review, predictive intel,
> call blur/effects, QR deployment token, ad-serving backend, vault sizing.
> **64 days → $11,650 at the same rate.** Quote at **$14,000** with a 2-sprint timeline.
> This is the honest disclosure _and_ the next sale. Raise it before the client finds it.

**Package 3 — Cashflow-friendly alternative**

> If a $50k lump sum is unrealistic for the client:
>
> - Reduced settlement: **$26,000** one-off, **plus**
> - Maintenance & operations retainer: **$3,000–4,000 / month** (12-month minimum)
>   covering bug SLAs, staging + production deploys, security patching, store releases,
>   and the existing QA loop.
> - Twelve months yields $62,000–74,000 — more than Package 1, with a recurring revenue base.

---

### 8.4 Bill these separately (do not absorb)

Third-party running costs are **pass-through**, not part of any development fee — see
`docs/planning/RECURRING_COSTS.md`:

| Service                                         | Model                                | At ~1k MAU    | At ~10k MAU              |
| ----------------------------------------------- | ------------------------------------ | ------------- | ------------------------ |
| Twilio Verify (OTP)                             | $0.05 / verification + number rental | ~$200–250/mo  | ~$1,500–1,800/mo         |
| Stripe                                          | 2.9% + $0.30 per charge              | volume-linked | volume-linked            |
| Contabo VPS + TURN/SFU bandwidth                | fixed + egress                       | —             | scales with call minutes |
| Mapbox, S3/R2 storage, FCM/APNs, GDELT/NewsData | metered                              | —             | —                        |

Add a **15% management margin** if you administer these accounts.

---

### 8.5 How to run the conversation

1. **Lead with the artefact, not the invoice.** Send this document first. Let §3 and §7 do the work.
2. **Anchor on market value.** "At a UAE agency day rate this build is $176k–241k."
3. **Then reveal the ask.** "We are invoicing $50,500 — your original rate, applied to 321 extra days."
4. **Point at the Ops Console.** It is not on any wireframe page. It is an entire second application.
   It ends the "was this in scope?" debate faster than anything else on the list.
5. **Disclose §6 unprompted.** Volunteering the gaps buys the credibility that makes §8.2 land, and
   Package 2 converts the disclosure into a second contract.
6. **Never discount Category A.** Those modules were requested verbally and built to production
   standard. If pressure is needed, waive Category B — frame it as "we are absorbing the $15,800 of
   hardening, testing and design work as goodwill." That reads as a large concession while protecting
   the number that matters.
7. **Get the variation signed before Phase 2 starts.** Leverage never gets better than the moment
   before the next scope begins.

---

## 9. Ongoing maintenance & support

The client has also requested an ongoing maintenance agreement.
**Priced separately in [`MAINTENANCE_PROPOSAL.md`](MAINTENANCE_PROPOSAL.md).**
Headline: **Tier 2 — $3,900 / month**, 12-month term.

---

## 10. One-line summary

> Contracted for **$20,000** against a 17-page wireframe of ~48 screens.
> Delivered **262 screens, 3 backend services, a 30-route web Ops Console, 352 endpoints,
> 93 migrations and 412 test files** — roughly **321 engineering days of unspecified scope**,
> worth **$58,400 at the original rate** and **$176,000+ at market rate**.
>
> **Recommended commercial position:**
> **$50,500** variation settlement · **$14,000** to close the ten genuine wireframe gaps ·
> **$3,900/month** maintenance on a 12-month term.
