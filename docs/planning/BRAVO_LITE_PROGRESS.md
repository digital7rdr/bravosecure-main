# Bravo Lite — Progress Tracker

> Last updated: 2026-05-01 (afternoon)
> Branch: `main` · Last commit: `6871cd1` (Sealed Sender v2 outer ECIES + persistent blob-cache purge — pushed to `omnidevxstudiobit/Bravo_Secure`)
>
> **For SQA: jump straight to [§17 — SQA Step-by-Step Test Guide](#17-sqa-step-by-step-test-guide-2026-05-01).** That section is self-contained: pull, boot, three role walkthroughs (ops · client · agent), 1:1 + group calling tests, and the Sealed Sender wire-shape smoke. Everything else above is historical context.

---

## Overview

Full stack: React Native (Expo) mobile app · NestJS auth-service (port 3001) · Next.js 15 ops-console (port 3002) · messenger-service Docker (port 3100) · Redis · Supabase Postgres (port 54322)

---

## 1. Agent Onboarding Flow ✅

End-to-end 9-screen agent registration from phone to ops approval.

| Step | Screen                  | Status | Notes                                                                                                                                                                                                                                     |
| ---- | ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | AgentTypeSelect         | ✅     | Entry point for new agents                                                                                                                                                                                                                |
| 2    | AgentRegistrationWizard | ✅     | Company profile, capabilities, contact                                                                                                                                                                                                    |
| 3    | AgentKYC (Verification) | ✅     | Upload-driven — agent attaches 4 docs (Gov ID, POA, SIA, Police) via DocumentPicker. Real files uploaded to auth-service `/uploads/` and served statically. KYC screen removed from future new registrations (goes straight to Coverage). |
| 4    | AgentCoverage           | ✅     | Countries + services toggle                                                                                                                                                                                                               |
| 5    | AgentAvailability       | ✅     | Mode + loadout                                                                                                                                                                                                                            |
| 6    | AgentDocsUpload         | ✅     | 6-slot compliance pack (REQ: SIA, Passport, Insurance, DBS · OPT: First Aid, CV). Real file picker + upload to auth-service disk. KYC uploads auto-mirrored into matching doc slots (passport↔gov_id, sia↔sia_licence, dbs↔police).       |
| 7    | AgentAdminApproval      | ✅     | LIVE polling (3s), pipeline steps, live dot + last-updated timestamp. Back button → AgentDocsUpload (no crash).                                                                                                                           |
| 8    | Auto-ACTIVE on approval | ✅     | Admin approve → status jumps directly to ACTIVE. No onboarding deployment gate.                                                                                                                                                           |
| 9    | AgentDashboard          | ✅     | Real data, real name, ON DUTY toggle with label, Messenger + Intel tiles, pull-to-refresh. No dummy data.                                                                                                                                 |

### Key backend changes

- `POST /agents/me/upload` — multipart file upload, saves to `uploads/{userId}/`, returns `http://localhost:3001/uploads/...` URL
- `POST /agents/me/kyc/:kind/upload` — KYC doc upload, mirrors to compliance pack
- `POST /agents/me/kyc/skip` — auto-settles KYC + advances status (for agents skipping old KYC screen)
- `GET /agents/me/available-jobs` — published jobs the agent can browse
- `GET /agents/me/missions/:missionId/deployment` — per-mission deployment checks

---

## 2. Admin / Ops Review Flow ✅

### Web ops-console (localhost:3002)

| Feature                    | Status | Notes                                                                                                                                                                      |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration + Login       | ✅     | Phone + password + OTP (dev: any 4-8 digits). Creates real `users` row + `admin_users` binding.                                                                            |
| Auth guard                 | ✅     | All pages redirect to `/login` when no token. Logout button in topbar.                                                                                                     |
| Agent roster `/agents`     | ✅     | Live data from DB — name, type, status, tier, region, rating, jobs, on-duty dot. No dummy rows.                                                                            |
| Agent detail `/agents/:id` | ✅     | KYC Documents (4 slots) + Compliance Pack (6 slots), both with VIEW buttons. VIEW stamps `reviewed_at` in DB + updates review pipeline step. Border turns green on review. |
| Agent approval             | ✅     | APPROVE / REJECT buttons with notes. On approve: all 5 pipeline steps flip to `done` atomically, agent becomes ACTIVE. Mobile picks up in ≤3s.                             |
| Dashboard                  | ✅     | Live KPIs from DB (no dummy stats)                                                                                                                                         |
| Bookings                   | ✅     | Live from DB, empty state when none                                                                                                                                        |
| Jobs                       | ✅     | Live from DB, empty state when none                                                                                                                                        |
| Live Ops (missions)        | ✅     | Live from DB + Mapbox markers                                                                                                                                              |
| Finance                    | ⏳     | Placeholder "backend pending" — no dummy charts                                                                                                                            |
| Analytics                  | ⏳     | Placeholder "backend pending"                                                                                                                                              |
| Messenger                  | ⏳     | Placeholder "backend pending"                                                                                                                                              |

### Review pipeline (mobile ↔ ops sync)

- Ops views KYC doc → `kyc` pipeline step → `in_progress` → `done` (when all viewed)
- Ops views compliance doc → `docs` pipeline step → `in_progress` → `done`
- Ops approves → all 5 steps done at once
- Mobile polls every 3s → reflects changes in real time

---

## 3. Mission / Deployment Flow ✅

### Per-mission deployment checklist (NEW — replaces onboarding-time check)

| Step                                                 | Status | Notes                                                                                         |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Job dispatched → mission created                     | ✅     | Existing job dispatch endpoint                                                                |
| Deployment checks seeded per crew member             | ✅     | 4 checks (dress/vehicle/equip/briefing) × each assigned agent, tied to `mission_id`           |
| Ops signs off checks                                 | ✅     | `POST /ops/missions/:id/deployment/signoff`                                                   |
| Ops-console mission detail — Pre-Departure Checklist | ✅     | PASS/FAIL per crew member × 4 checks, live refresh                                            |
| Mobile deployment screen                             | ✅     | Per-mission, polls `/agents/me/missions/:missionId/deployment` every 3s, LIVE dot + timestamp |
| All checks passed → CTA enables                      | ✅     | "Enter Agent Dashboard"                                                                       |

### DB migration

- `agent_deployment_checks` got `mission_id UUID` column — checks are now per-mission, not per-agent lifetime

---

## 4. Messenger — Security & Isolation ✅

| Layer             | Before                           | After                                                                   |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------- |
| Keychain key      | `bravo.messenger.dbkey` (global) | `bravo.messenger.dbkey.{userId}` (per user)                             |
| SQLCipher DB file | `messenger-ios.db` (shared)      | `messenger-{userId[:8]}-ios.db` (per user)                              |
| Runtime singleton | Never reset on user switch       | `_resetMessengerRuntime()` called on every login                        |
| AsyncStorage      | Conversations persisted globally | Production: only `_ownUserId` tag stored (SQLCipher is source of truth) |
| Store owner check | None                             | `setOwner(userId)` clears store if user changes                         |

Signal/WhatsApp model: different users on the same device get separate encrypted DB files with separate hardware-backed keys. A copied DB file cannot be decrypted without the owner's keychain entry.

---

## 5. Jobs & Earnings — Real Data ✅

| Screen          | Before                                          | After                                                                                        |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Job Marketplace | 4 hardcoded fake jobs                           | Real `GET /agents/me/available-jobs` (PUBLISHED jobs from DB). Empty state when none.        |
| Earnings        | Fake "45,820 credits", fake chart, fake payouts | Real: jobs total, duty hours MTD, hourly rate from DB. "Finance module pending" for history. |

---

## 6. Database Migrations Applied

| File                                        | Description                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `20260425000000_agent_kyc_uploads.sql`      | Adds `file_url`, `file_hash_sha256`, `uploaded_at` to `agent_kyc_checks` |
| `20260425010000_admin_phone.sql`            | Adds `phone_e164` to `admin_users` for real OTP login                    |
| `20260425020000_deployment_per_mission.sql` | Adds `mission_id` to `agent_deployment_checks`                           |
| `agent_kyc_checks` ALTER                    | Added `reviewed_at`, `reviewer_id` columns (inline migration)            |

---

## 7. What's Still Pending / Not Yet Built

| Area                                   | Status | Notes                                                                                                               |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Real S3/R2 file upload                 | ⏳     | Currently saves to `auth-service/uploads/` on disk. Production needs S3-compatible presigned URL flow.              |
| Agent-facing job applications          | ⏳     | Agent can browse published jobs. Apply button visible but not wired to a real application endpoint.                 |
| Proof-of-address doc slot              | ⏳     | KYC has a `proof_address` check but no matching compliance-pack slot. Currently auto-marked done if subject exists. |
| Finance / analytics backend            | ⏳     | No endpoints. Ops-console shows empty state.                                                                        |
| Push notifications                     | ⏳     | FCM/APNs not wired. Approval events don't push.                                                                     |
| Ops-console login: proper phone OTP    | ✅     | Works via `/auth/login` + `/auth/admin-register/verify`. OTP_DEV_BYPASS active in dev.                              |
| Agent display name                     | ⏳     | Shows "AGENT" if no `display_name` set. Set during registration wizard but optional.                                |
| Booking → mission flow (client side)   | ✅     | End-to-end working: book → ops approve → auto-pay → ops dispatch → LIVE → app TRACK. See §10.                       |
| WebRTC voice/video (messenger)         | ⏳     | In spec, PeerConnection + DTLS-SRTP. Not yet implemented.                                                           |
| Disappearing messages media encryption | ⏳     | AES-256-CBC per-file media encryption before S3 upload not yet wired.                                               |

---

## 8. Running Services (Local Dev)

| Service                   | Port        | How to start                                   |
| ------------------------- | ----------- | ---------------------------------------------- |
| Redis + messenger-service | 6379 / 3100 | `docker compose up -d redis messenger-service` |
| Auth-service (NestJS)     | 3001        | `cd apps/auth-service && npm run start:dev`    |
| Ops-console (Next.js)     | 3002        | `cd apps/ops-console && npm run dev`           |
| Metro / Expo              | 8081        | `npm run start` (root)                         |
| Supabase (local)          | 54321–54327 | Started by Docker Desktop with project         |

### WiFi ADB (Pixel 6a)

```bash
adb connect 192.168.4.195:<port>   # port shown in Wireless Debugging screen
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001
adb reverse tcp:3002 tcp:3002
adb reverse tcp:3100 tcp:3100
```

### Ops-console admin account

- Phone: `+880188888888` · Password: `bravo123` · OTP: any 4-8 digits
- Call sign: `WOLF` · Role: `ADMIN`
- Mint new token if needed: `cd apps/auth-service && node scripts-mint-ops-token.mjs OPS-01`

---

## 9. Architecture Summary

```
Mobile (React Native)
  └── AgentNavigator (onboarding + dashboard + messenger + intel)
  └── MainNavigator (client: bookings, secure, messenger, profile)

Auth-service (NestJS :3001)
  ├── /auth/*          — register, login, verify, refresh
  ├── /agents/*        — onboarding, KYC, docs, upload, jobs
  ├── /ops/*           — admin dashboard, bookings, jobs, agents, missions
  └── /uploads/*       — static file serving (dev only)

Ops-console (Next.js :3002)
  ├── /login           — OTP login
  ├── /register        — OTP admin registration
  ├── /agents          — roster + approval
  ├── /live/:id        — mission detail + deployment checklist
  ├── /bookings        — queue + approval
  └── /jobs            — pipeline

Messenger-service (Docker :3100)
  └── Socket.io relay + Redis pub/sub for E2E encrypted messages

Database (Supabase Postgres :54322)
  └── users, agents, agent_kyc_checks, agent_documents,
      agent_review_pipeline, agent_deployment_checks,
      lite_bookings, jobs, missions, mission_crew,
      admin_users, conversations, messages,
      cpo_pool, vehicle_pool,
      booking_cpo_assignments, lite_booking_audit
```

---

## 10. Client Booking → Payment → Dispatch → Live Tracking ✅

> Built 2026-04-27. End-to-end client mission lifecycle wired against
> auth-service `/bookings/*` and ops-console `/ops/bookings/*`.

### Full client lifecycle

| Stage             | Status | Trigger                                    | App screen                                     | Web screen                     |
| ----------------- | ------ | ------------------------------------------ | ---------------------------------------------- | ------------------------------ |
| `PENDING_OPS`     | ✅     | Client books in wizard                     | `OpsRoomReview` (pending, locked)              | `/bookings/:id` Approve/Reject |
| `OPS_APPROVED`    | ✅     | Ops clicks Approve & Publish               | `OpsRoomReview` polls 4s, opens auto-pay sheet | —                              |
| `PAYMENT_PENDING` | ✅     | App calls `/bookings/:id/pay-with-credits` | Countdown 5s + paid snapshot 2.2s              | —                              |
| `CONFIRMED`       | ✅     | Backend debits BC, transitions             | `BookingConfirmation` (Awaiting team)          | Team & Dispatch picker appears |
| `LIVE`            | ✅     | Ops clicks Dispatch                        | `LiveTracking` (real route, animated)          | Assigned Team card             |
| `COMPLETED`       | ⏳     | (Pending — see §11)                        | —                                              | —                              |

### App changes ([src/screens/booking/](src/screens/booking/), [src/screens/ops/](src/screens/ops/), [src/screens/liveops/](src/screens/liveops/))

- **Resume gate** ([BookingHomeScreen.tsx:51-91](src/screens/booking/BookingHomeScreen.tsx#L51-L91)): on focus, fetches `/bookings`, finds the first non-terminal booking, routes by status — `PENDING_OPS/OPS_APPROVED/PAYMENT_PENDING → OpsRoomReview`, `CONFIRMED → BookingConfirmation`, `LIVE → LiveTracking`. Tracks already-shown IDs in a Set so back-navigation isn't a trap.
- **One-mission-at-a-time CTA**: Hero card flips from "Book Now" to "View Active Mission" while a booking is in flight. FAB icon swaps `shield-plus → crosshairs-gps`.
- **Status normalizer** ([bookingStatus.ts](src/screens/booking/bookingStatus.ts)): backend UPPERCASE → display config (`PENDING OPS / APPROVED / PAYMENT DUE / LIVE / …`) with chip color, `isActive` boolean, `resumeTargetFor()`.
- **Auto-pay countdown sheet** ([OpsRoomReviewScreen.tsx:66-148](src/screens/ops/OpsRoomReviewScreen.tsx#L66-L148)): 5-second visible countdown showing `YOU HAVE / DEDUCTING / REMAINING`, then `Charging…`, then `PAYMENT CAPTURED · WAS / DEDUCTED / NEW BALANCE` for 2.2s before navigating. On `400 insufficient_credits` swaps to a **Top Up Now** sheet with route to `CreditPaywall`. Hardware back / swipe-back blocked through the entire flow.
- **CONFIRMED auto-skip**: re-entering `OpsRoomReview` on a paid booking no longer fires payment again — polling routes straight to `BookingConfirmation` (fixes "Cannot pay booking in state CONFIRMED" loop).
- **TRACK gating** ([BookingConfirmationScreen.tsx](src/screens/booking/BookingConfirmationScreen.tsx)): Track button shows "AWAITING DISPATCH" with hourglass icon and `disabled` until backend status flips to `LIVE`. Polls `/bookings/:id/team` + `/bookings/:id` every 5s; stops once `LIVE && cpos.length > 0`.
- **LiveTracking honors real status** ([LiveTrackingScreen.tsx](src/screens/liveops/LiveTrackingScreen.tsx)): header reads `LIVE OPERATION` only when `status='LIVE'`; otherwise yellow `AWAITING DISPATCH` banner. Origin/dest read from booking pickup/dropoff (no more canned DIFC→Palm). Track points interpolated between real coords, `vehicleLabel` from `team.vehicle.call_sign`. Removed hardcoded `R. Al-Rashid / M. Khaskun / Toyota LC300` fallback team.

### Backend changes ([apps/auth-service/](apps/auth-service/src/))

- **`POST /bookings/:id/pay-with-credits`** ([booking.controller.ts](apps/auth-service/src/booking/booking.controller.ts), [booking.service.ts](apps/auth-service/src/booking/booking.service.ts#L189-L240)): transitions `OPS_APPROVED → PAYMENT_PENDING → CONFIRMED`, calls `wallet.debitForBooking`, throws `400 insufficient_credits` on shortfall (booking _stays_ in `PAYMENT_PENDING` for retry). Auto-assignment removed from this path — booking sits at `CONFIRMED` with no team until ops dispatches.
- **`POST /ops/bookings/:id/dispatch`** ([ops.service.ts:dispatchBooking](apps/auth-service/src/ops/ops.service.ts)): takes `{cpoIds, vehicleId}` body, validates `status === CONFIRMED && cpoIds.length === cpo_count && vehicleId`, calls `cpoAssign.assignSpecific()` + `vehicles.assignSpecific()` (which lock-and-claim with `SKIP LOCKED`, throw `cpo_unavailable` / `vehicle_unavailable` if any chosen unit was taken in parallel), transitions `CONFIRMED → LIVE`, audits `booking.dispatch`.
- **`GET /ops/pool/cpos?region=` and `/ops/pool/vehicles?region=`**: read-only pool listings for the dispatch picker.
- **`GET /ops/bookings/:id`** now returns `{booking, audit, job, team: {cpos, vehicle}}` so the web detail page can render an Assigned Team card.
- **State machine** ([state-machine.service.ts](apps/auth-service/src/booking/state-machine.service.ts)): added `CONFIRMED → LIVE` for actor `OPS_HANDLER` (alongside the existing `CPO` actor for self-dispatch via agent app).
- **CPO pool ↔ agents sync** ([ops.service.ts:mirrorAgentToPool](apps/auth-service/src/ops/ops.service.ts)): when `approveAgent()` runs, the agent is mirrored into `cpo_pool` with `cpo_pool.id = agent.user_id`, so registered CPOs (e.g. Ranak) appear in the dispatch picker automatically. One-time backfill SQL synced 21 existing approved CPO agents.

### Ops console — Team & Dispatch picker ([apps/ops-console/src/app/bookings/[id]/page.tsx](apps/ops-console/src/app/bookings/[id]/page.tsx))

- New right-column card visible **only** when `status === CONFIRMED && team.cpos.length === 0`:
  - Lists all available CPOs in the booking's region (multi-select, hard-capped at `cpo_count`).
  - Lists all available vehicles in the region (single-select).
  - **Status pill** above the dispatch button — yellow `! NEEDS X more CPOs / 1 vehicle` until selection is exact, then green `✓ READY · N CPO + 1 VEHICLE LOCKED`.
  - Dispatch button is visibly dimmed (opacity 0.4 + `not-allowed` cursor) until ready, no more silent dead clicks.
- New **Assigned Team** card: shows once any CPO + vehicle is locked to the booking, regardless of status. Stays visible after `LIVE` so ops can see who's deployed.

### Database

- One-time mirror SQL: `INSERT INTO cpo_pool ... FROM agents WHERE type='cpo' AND status IN ('APPROVED','ACTIVE')` keyed on `agent.user_id`. ON CONFLICT DO NOTHING for idempotency.
- Pool seed: 8 fresh AE CPOs (`CPO 60`–`CPO 67`) + 5 vehicles (`VEH 20`–`VEH 24`). Total available now: **13 CPOs · 8 vehicles** in AE.
- Stale-data cleanup: 18 `PENDING_OPS / OPS_APPROVED / PAYMENT_PENDING` test bookings from earlier runs (Apr 24) bulk-cancelled. Pending queue back to 0.
- Ranak (`a056fa4b-...`): renamed in both `agents.display_name` and `cpo_pool.display_name` to `Ranak`, call_sign `CPO 01`.

### Bug fixes shipped along the way

| Bug                                                                            | Fix                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Hero "Book Now" hardcoded 3 fake completed bookings                            | Wired `useBookingStore` + real `/bookings` list with status normalizer                    |
| Resume gate trapped user on every Home re-focus                                | `seenRef: Set<string>` filters already-routed IDs in this session                         |
| App didn't redirect after ops approval                                         | Added 4s poll + countdown + visible "PAID" snapshot before nav                            |
| "Cannot pay booking in state CONFIRMED" modal on app re-entry                  | OpsRoomReview polling routes CONFIRMED → BookingConfirmation directly, no payment retry   |
| `AWAITING OPS APPROVAL` shown even after ops approved (status was CONFIRMED)   | LiveTracking now reads real `activeBooking.status` instead of hardcoding "LIVE OPERATION" |
| BookingConfirmation showed dummy `R. Al-Rashid / M. Khaskun / VEH 11` fallback | Removed; placeholder "Awaiting team assignment" + 5s poll instead                         |
| Dispatch button looked clickable when disabled (silent no-op)                  | Visible dimming + status pill listing exactly what's missing                              |
| Ranak (registered agent) not appearing in dispatch picker                      | One-time SQL sync + auto-mirror in `approveAgent()`                                       |
| 4× CPO bookings hit "CPO pool exhausted"                                       | Seeded extra UAE units (12 → 13 available)                                                |

### Test path verified

1. Client makes booking → `PENDING_OPS`. ✅
2. Phone shows `OpsRoomReview` (pending, hardware-back blocked). ✅
3. Ops clicks Approve & Publish on web → `OPS_APPROVED`. ✅
4. Phone polls (≤4s) → countdown sheet (5s) → `pay-with-credits` (200 OK) → "PAID" snapshot (2.2s) → `BookingConfirmation`. ✅
5. Ops opens booking detail → picks N CPOs + 1 vehicle → status pill green → DISPATCH MISSION → LIVE. ✅
6. Backend transitions `CONFIRMED → LIVE`, claims units, audits. ✅
7. Phone polls (≤5s) → team appears, status flips, TRACK button enabled. Tap TRACK → LiveTracking with `LIVE OPERATION` red dot, real route from booking coords. ✅

---

## 11. Job-Driven Dispatch + Mission Completion (Apr 27 evening) ✅

Major rewrite: the manual cpo_pool dispatch picker is replaced by an
applications-driven flow. Agents see published jobs, apply, ops picks
from applicants only. Dispatch creates a messenger group; completion
distributes credits and dissolves the group.

### Backend (auth-service)

| Endpoint                               | Notes                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /agents/me/jobs/:jobId/apply`    | Idempotent on (job, agent). Validates agent is APPROVED/ACTIVE and job is PUBLISHED.                                                                                                                                        |
| `POST /agents/me/jobs/:jobId/withdraw` | Allowed while application is `PENDING` or `SHORTLISTED`.                                                                                                                                                                    |
| `GET /agents/me/applications`          | Agent's own applications + linked job summary.                                                                                                                                                                              |
| `GET /agents/me/available-jobs`        | Now includes `applied: boolean` + `application_status` per row.                                                                                                                                                             |
| `GET /ops/bookings/:id/applicants`     | Joins `job_applications` ↔ `agents` for the dispatch picker.                                                                                                                                                                |
| `POST /ops/bookings/:id/dispatch`      | **Body changed**: `{applicationIds[], vehicleId}` (was `cpoIds[]`). Marks selected ASSIGNED, others REJECTED. Creates the mission group conversation.                                                                       |
| `POST /ops/bookings/:id/complete`      | **NEW**. Distributes escrowed BC even-split to assigned CPOs, releases units to pool, dissolves the mission group on the agent side (ops admin keeps the conversation + envelopes for audit), transitions LIVE → COMPLETED. |
| `wallet.creditForBooking()`            | New helper mirroring `debitForBooking` but on the credit side; emits `payout` ledger row per agent.                                                                                                                         |

State machine ([state-machine.service.ts](apps/auth-service/src/booking/state-machine.service.ts)) added `LIVE → COMPLETED` for actor `OPS_HANDLER` (alongside existing `CPO`).

DB migrations in this batch:

- `lite_bookings.conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL` + index.

Logic in [ops.service.ts:dispatchBooking](apps/auth-service/src/ops/ops.service.ts):

1. Verifies all picked applications belong to the booking's job.
2. `cpoAssign.assignSpecific(bookingId, agentIds)` — locks via `cpo_pool` (each agent's `user_id` is their `cpo_pool.id` thanks to the mirror).
3. `vehicles.assignSpecific(bookingId, vehicleId)`.
4. Bulk-rejects all other PENDING/SHORTLISTED applications for that job.
5. `jobs.status = DISPATCHED`, `slots_filled = N`.
6. `lite_bookings.status = LIVE`.
7. `conversations.create(adminUserId, 'group', [...agentIds, adminUserId], 'Mission BS-XXXXXXXX')` — ops becomes admin, CPOs become members. Stored as `lite_bookings.conversation_id`.

[ops.service.ts:completeBooking](apps/auth-service/src/ops/ops.service.ts):

1. Verifies booking is `LIVE`.
2. Loads assigned CPOs.
3. **Even-split payout**: `perAgent = floor(total_eur / cpo_count)`, remainder accrues to platform fee. One `wallet.creditForBooking` call per CPO.
4. `cpoAssign.release` + `vehicles.release` (units back to `available`).
5. `DELETE FROM conversation_members WHERE conversation_id = $1 AND role = 'member'` — agents drop out of the mission group on next `listMine` poll. Conversation row, message envelopes, and the ops admin membership are retained for audit. Title is suffixed with `· COMPLETED` so ops's chat list visually marks the room as closed.
6. `lite_bookings.status = COMPLETED`, audit row `booking.complete` with the payout breakdown.

### Mobile app

- [JobMarketplaceScreen.tsx](src/screens/agent/JobMarketplaceScreen.tsx) — removed hardcoded sample jobs; reads `application_status` from the API and renders a per-row Apply button with five distinct visual states:
  - `null/WITHDRAWN/REJECTED` initial → purple **Apply** with bolt icon.
  - `PENDING/SHORTLISTED` → green **"Applied · tap to withdraw"** with check icon.
  - `ASSIGNED` → blue **"On Team"** with shield-check, disabled.
  - `REJECTED` (post-decision) → red **"Not Selected"**, disabled.
  - Mid-request → opacity-dimmed `…`.
  - Tapping toggles between apply/withdraw via the new endpoints.
- [BookingConfirmationScreen.tsx](src/screens/booking/BookingConfirmationScreen.tsx) — TRACK button stays disabled with hourglass + "AWAITING DISPATCH" until status becomes `LIVE`. Polls `/bookings/:id/team` every 5s until `(LIVE || COMPLETED) && cpos > 0`. Auto-popToTop on `COMPLETED`.
- [LiveTrackingScreen.tsx](src/screens/liveops/LiveTrackingScreen.tsx) — header reads "LIVE OPERATION" only when status === `LIVE`; otherwise yellow "AWAITING DISPATCH" banner above the (frozen) map. CHAT tab now reads `activeBooking.conversation_id` and shows "Mission group · N members" pointer to the Messenger tab while group exists. Polls every 5s and `popToTop()`s on `COMPLETED`.

### Ops console (web)

- [bookings/[id]/page.tsx](apps/ops-console/src/app/bookings/[id]/page.tsx) — Team & Dispatch card replaced. Now lists **applicants only** (no raw cpo_pool), auto-refreshes every 6s as new applies arrive. Each row shows `agent_call_sign · display_name · Tier X · jobs · ★ rating · applied Nm ago`. Empty state explains the job is on the agent feed and the list updates as agents apply.
- Status pill: `! NEEDS X more applicants AND 1 vehicle` (yellow) → `✓ READY · N APPLICANT + 1 VEHICLE LOCKED` (green). Dispatch button visibly dimmed (opacity 0.4) when not ready — fixed the silent dead-click bug.
- New **Assigned Team** card: shows whenever a team exists, regardless of status (so post-LIVE you can still see who's deployed).
- New **Mission Live** card on `LIVE` bookings: big green **"COMPLETE MISSION → PAYOUT"** button with a confirmation prompt. Shows the escrow total + member count it'll distribute across.
- New **Mission Completed** card on `COMPLETED` bookings: green confirmation, points to the audit timeline for payout breakdown.

### CPO Pool ↔ Agents mirror

[ops.service.ts:mirrorAgentToPool](apps/auth-service/src/ops/ops.service.ts) is now called inside `approveAgent()` so future approvals show up in the dispatch picker automatically. One-time SQL backfill synced 21 already-approved CPO agents into `cpo_pool` with `cpo_pool.id = agent.user_id`. Ranak (`piyaldeb78@gmail.com`) shows as `CPO 01 · Ranak`.

### E2E test

[scripts/e2e-booking-lifecycle.ts](scripts/e2e-booking-lifecycle.ts) covers the new lifecycle end-to-end:

1. Register admin + agent + client (OTP_DEV_BYPASS).
2. Fast-track agent to `ACTIVE` + mirror into `cpo_pool` + seed a vehicle.
3. Top up client wallet.
4. Client books → `PENDING_OPS`.
5. Ops approves → job auto-published.
6. Client `pay-with-credits` → `CONFIRMED`. Asserts NO team rows yet (auto-assignment is gone).
7. Agent calls `/agents/me/jobs/:jobId/apply` → `PENDING`. Asserts available-jobs feed reflects `applied=true`.
8. Ops fetches `/ops/bookings/:id/applicants` → 1 row.
9. Ops dispatches via `applicationIds + vehicleId` → `LIVE` + conversation created. Asserts admin role for ops + member role for agent.
10. Ops completes → asserts payout count + per-agent BC delta + conversation retained for ops + zero `member`-role rows remaining + cpo_pool row back to `available`.

Run: `npx tsx scripts/e2e-booking-lifecycle.ts` (auth-service must be up on :3001 with OTP_DEV_BYPASS=true).

---

## 12. Tomorrow's Test Punch-List (2026-04-28)

Run through these in order on the device + ops console. Auth-service / ops-console / Metro need to be running; reset the DB if you want a clean queue (the cancelled stale bookings are still in the audit log).

### A) Cold-path: book → live → complete (happy path)

- [ ] Open the app as **client** → Secure tab → **Book Now**.
- [ ] Complete the booking wizard with 1× CPO, 1× vehicle, region AE.
- [ ] App lands on `OpsRoomReview` (yellow, locked, hardware-back blocked, no chevron). Status pill = `Pending`.
- [ ] On the web ops console (`localhost:3002/bookings`) find the new `PENDING_OPS` row → open it → click **APPROVE & PUBLISH**.
- [ ] App polls within 4s, opens **auto-pay countdown sheet** showing `YOU HAVE / DEDUCTING / REMAINING`. After 5s, sheet flips to **Charging…** then **PAYMENT CAPTURED · WAS / DEDUCTED / NEW BALANCE** for ~2.2s.
- [ ] App auto-routes to `BookingConfirmation`. The header is green "BOOKING CONFIRMED · Paid". Assigned Team card shows **"Awaiting team assignment"**. TRACK button reads **AWAITING DISPATCH** with hourglass icon (disabled).
- [ ] Switch to **Ranak's** device (or another logged-in agent) → Job Marketplace → confirm the new job appears with the **Apply** button.
- [ ] Tap Apply → button flips to green **"Applied · tap to withdraw"**.
- [ ] Back on web: refresh booking detail. Team & Dispatch card now shows the agent in the applicants list (no more raw cpo_pool). Pick the agent + a vehicle. Status pill turns green **"READY · 1 APPLICANT + 1 VEHICLE LOCKED"**. Click **DISPATCH MISSION → LIVE**.
- [ ] Web: state machine progresses to step 6/LIVE. New **Assigned Team** card appears with the chosen CPO + vehicle. **Mission Live** card replaces the dispatch picker.
- [ ] App (client side) within 5s: Awaiting Team placeholder is replaced with the real CPO + vehicle. TRACK button enables (green, crosshairs icon).
- [ ] Tap TRACK → LiveTracking opens with red **LIVE OPERATION** header, real route from booking pickup→dropoff, vehicle dot animating along it.
- [ ] On both devices, switch to **Messenger** tab → there should be a new conversation **"Mission BS-XXXXXXXX"** with ops admin + agent. Send messages from both sides; verify they're delivered.
- [ ] Web: click **COMPLETE MISSION → PAYOUT**. Confirm prompt → submit.
- [ ] App: within 5s, LiveTracking pops back to home. Active-mission gate releases (Hero card flips back to "Book Now"). Ranak's wallet balance increased by the payout amount.
- [ ] Agent device: Messenger tab → "Mission BS-XXXXXXXX" conversation is **gone** (no membership row).
- [ ] Ops device: Messenger tab → conversation is **retained** with title "Mission BS-XXXXXXXX · COMPLETED" and full message history readable for audit.

### B) Insufficient funds path

- [ ] Drain the client's wallet to 0 BC (via DB or by completing a previous mission first).
- [ ] Make a new booking → ops approves → app countdown runs.
- [ ] At 0s, payment fails → sheet flips to **"INSUFFICIENT BRAVO CREDITS"** with `WAS / NEED / SHORT` math + **TOP UP NOW** button.
- [ ] Tap "I'll top up later" → booking sits at `PAYMENT_PENDING` in DB.
- [ ] Re-enter the app → resume gate routes back to OpsRoomReview → countdown re-fires → still insufficient.
- [ ] Top up via Credits screen → re-enter Secure → countdown succeeds.

### C) Withdraw + reject

- [ ] Two agents apply to the same job.
- [ ] Agent A withdraws (button shows "Apply" again on their feed).
- [ ] Ops dispatches with Agent B's application → Agent A's feed eventually shows the job has slots filled. Agent B sees **"On Team"**.
- [ ] If a third agent had applied (pending) but wasn't picked, their feed shows **"Not Selected"**.

### D) Cancellation paths

- [ ] Web: ops rejects a `PENDING_OPS` booking → app polling sees `CANCELLED`, OpsRoomReview shows red "BOOKING REJECTED · TAP TO RESTART" CTA.
- [ ] Verify the rejected job application doesn't reappear in any agent's feed.

### E) Multi-CPO mission (cpo_count > 1)

- [ ] Make a 4× CPO booking (the available pool now has 12 free, plenty of room).
- [ ] Have multiple agents apply.
- [ ] Web: dispatch picker enforces "exactly 4" — try clicking with fewer than 4 → button stays dimmed; status pill is yellow.
- [ ] Pick 4 → dispatch → all 4 land in the messenger group with ops as admin.
- [ ] Complete → payout splits 4-way, remainder rounds to platform fee.

### F) Edge / regression sanity

- [ ] Resume gate doesn't trap on `CANCELLED` or `COMPLETED` rows.
- [ ] FAB shows `crosshairs-gps` only while a non-terminal booking exists.
- [ ] Hardware back is blocked on OpsRoomReview during pending + countdown + paid-hold.
- [ ] Closing the app mid-LIVE and reopening → resume gate routes straight to LiveTracking.

### G) Run the e2e script (no manual taps required)

- [ ] `npx tsx scripts/e2e-booking-lifecycle.ts` from repo root → expect green check at each stage and `✓ booking lifecycle e2e PASSED` at the end.

### Known caveats

- LiveTracking telemetry is still simulated (8s/step interpolation between booking coords). Real per-CPO GPS comes when the agent mobile app pushes telemetry.
- Group chat uses the standard messenger surface; the LiveTracking CHAT tab is a pointer, not an inline thread (intentional — `messenger func will same`).
- Platform fee = the integer remainder of `total_eur / cpo_count`. For exact splits the platform takes 0; for un-even ones (e.g. 100 BC across 3 CPOs) the platform pockets 1 BC.

---

## 14. 2026-04-30 — Mission Closeout & Ops-Dashboard Hardening ✅

> Focus pass: every functionality below is paired with the **ops dashboard**
> surface that it lights up. The pattern is consistent — backend writes the
> truth into shared tables (`missions`, `mission_payouts`, `agents`,
> `conversations`, `conversation_members`), the ops console surfaces it
> reactively via SWR polling, the agent mobile catches up on next listMine
> / `/agents/me` poll. No new push channel was introduced.

### A. Mission group dissolution — per-side, audit-grade

On `END MISSION → PAYOUT`, the mission's group conversation is **kept** for ops
and **removed** for the crew, instead of the previous full-cascade `DELETE`.

| Side                       | Behaviour                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Ops admin (role='admin')   | Membership row + conversation row + every `message_envelope` retained. Title gets ` · COMPLETED` suffix.                     |
| Each agent (role='member') | `conversation_members` row deleted → falls out of `/conversations/mine` → mobile prune step removes it from the local store. |

- Wired in [ops.service.ts:completeBooking](apps/auth-service/src/ops/ops.service.ts) (DELETE FROM conversation_members WHERE role='member').
- Mobile prune in [MessengerHomeScreen.tsx](src/screens/messenger/MessengerHomeScreen.tsx) — listMine miss + UUID-shape guard removes the local row so the chat list updates without app restart.
- **Ops dashboard relation**: completed mission rooms appear in the ops Messenger list with a clear `· COMPLETED` title; clicking them shows full transcript for compliance/dispute review. Future agents can no longer leak group history once dispatched-then-completed elsewhere.

### B. Mission group typing / active / read-receipts (group-aware)

Mobile `ChatScreen` previously gated presence/typing/read on a single `peer`,
which is undefined for groups → mission-group surfaces silently dead.

- [ChatScreen.tsx](src/screens/messenger/ChatScreen.tsx): `groupPeers` memo over `conversation.participants` minus self → presence subscribe + setActivity + typing all fan to every member.
- [productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts) inbound `typing` handler now also writes `s.typing[<groupConvId>]` for every conversation containing the sender (was: synthetic `direct:<uid>` only → never matched group ids).
- Ops [MessengerProvider.tsx](apps/ops-console/src/components/messenger/MessengerProvider.tsx) raises `setActivity('active')` at unlock time (was: only while the dock was open). `away` flushes on lock/unmount.
- Ops [MissionGroupPanel.tsx](apps/ops-console/src/components/messenger/MissionGroupPanel.tsx) dock no longer downgrades to `away` on close — the session-level state owns the lifecycle.
- **Ops dashboard relation**: MissionGroupPanel header on `/live/[id]` now reads `N active` / `Ranak typing…` instead of the perpetual `no one active`. Dock bubbles render `✓✓` on read.

### C. Mission completion flow

- **In-place complete** ([live/[id]/page.tsx](apps/ops-console/src/app/live/[id]/page.tsx)): `END MISSION → PAYOUT` is now an action button, not a Link — calls `opsApi.completeBooking(bookingId)` then `mutate()`. The badge flips to `COMPLETED` reactively, the live page stays mounted, no navigation. A small `REVIEW PAYOUTS` ghost link sits next to it for the deduction-required flow on `/bookings/[id]`.
- **Wallet ledger description** uses `Mission payout · MSN-XXXXXXXX` (mission `short_code`) instead of the booking-id slice — matches what ops sees on the web.
- **Agent stats bump** in [completeBooking](apps/auth-service/src/ops/ops.service.ts): `agents.jobs_total += 1` and `duty_hours_mtd += <hours>` for every paid CPO. `computeDutyHours()` caps at 24 h. Existing 3 completions backfilled in DB.
- **Mission summary system broadcast**: per-agent `mission_complete` card posted to each paid CPO's Bravo System DM with payout / distance / `pickup → dropoff` route. Survives the group dissolution as the agent's audit trail.
- Mobile [Earnings recent payouts](src/screens/agent/EarningsScreen.tsx) rows are now tappable → [MissionSummaryScreen.tsx](src/screens/agent/MissionSummaryScreen.tsx) (route, distance, duration, payout, deduction reason). Endpoint: `GET /agents/me/payouts/:bookingId/summary`.
- **Ops dashboard relation**: status badge on `/live/[id]` now shows `COMPLETED` instead of hardcoded `LIVE`; activity feed gets `WOLF closed booking … · paid out … BC across N agent(s)`; agent's mobile `JOBS COMPLETED` and `DUTY HOURS · MTD` reflect the truth.

### D. Live-page completed view

- `mission.service.ts` gets `listClosed()` returning `COMPLETED|ABORTED` ordered by `ended_at`, capped at 50.
- Controller exposes `GET /ops/missions?status=completed`.
- Ops live list `/live` gets **Active / Completed tabs** ([page.tsx](apps/ops-console/src/app/live/page.tsx)) — pills color-coded (green for completed, red for aborted).
- Detail page status badge shows actual mission status; clicking a completed mission opens the full read-only post-mortem (map + crew + audit + messenger archive).
- **Ops dashboard relation**: completed missions are first-class on `/live` now, not lost to the `Active` filter. Closed-mission count visible in the tab header.

### E. Routes — always-on alternatives + style cycler

Mapbox returns 0–2 alternatives organically; on dense city pairs (Dhaka,
Dubai inner) it usually returns just 1. The picker used to show a single
row with no option to compare.

- `MAPBOX_ACCESS_TOKEN` added to [auth-service/.env](apps/auth-service/.env) — was missing entirely; service was falling back to straight-line haversine and returning `polyline: null` (no line drawn).
- [mapbox-directions.service.ts](apps/auth-service/src/ops/mapbox-directions.service.ts) — `getRouteAlternatives` now backfills with synthetic via-point detours: midpoint of the corridor offset perpendicular by ~25 % of the distance (clamped to 1.5–6 km) on either side. Dedupe by 5 % distance/duration delta. Always returns up to 3 distinct routes.
- Ops live page: alternatives drawn on the map by default (was: only when picker was open).
- Picker UI redesigned aggressively — tab strip (FASTEST / ALT 1 / ALT 2), oversized distance + ETA metrics, per-option compare row, color-matched `→ DISPATCH ALT N` button.
- BravoMap: selected route 6px solid + glow, on top; non-selected 2.5px **dashed** at 0.45 opacity — visually obvious which is the chosen path.
- New [BravoMap](apps/ops-console/src/components/BravoMap.tsx) prop `styleId: 'dark' | 'streets' | 'satellite'` + a small DARK / STREETS / SAT cycler FAB on the live page (mirrors mobile location picker). `setStyle()` swaps re-apply user layers via a `styleNonce` bump.
- **Ops dashboard relation**: every `/live/[id]` page now shows three colored route lines + the picker as a primary-action surface. Re-routes audit-emit `Route updated by WOLF · X km · Y min` → activity feed.

### F. SQLCipher concurrency fix

Group sends fanned to N peers in a tight loop, each updating per-peer
Signal session state. Default `journal_mode=DELETE` had any inbound
envelope handler racing the loop → red `database is locked` errors.

- [crypto/db.ts](src/modules/messenger/crypto/db.ts) sets `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL` at open. WAL allows one writer alongside multiple readers; busy_timeout makes any rare collision wait instead of erroring.
- **Ops dashboard relation**: indirect — fewer "group send failed" red bubbles in the ops Messenger Dock means ops can rely on chat as a real comms channel.

### G. Touchpoint matrix

| Functionality                | Backend                              | Ops console surface                      | Agent mobile surface                     |
| ---------------------------- | ------------------------------------ | ---------------------------------------- | ---------------------------------------- |
| Per-side group dissolution   | `completeBooking`                    | Messenger list keeps `· COMPLETED` rooms | Chat list prunes on listMine             |
| Group typing / active / read | gateway forwards by peer             | Mission Group Dock header + ticks        | ChatScreen typing dots + presence        |
| In-place mission complete    | `POST /ops/bookings/:id/complete`    | `END MISSION → PAYOUT` button            | Earnings updates on next refresh         |
| Mission summary broadcast    | `system_broadcasts` insert           | — (audit log)                            | Bravo System DM card                     |
| Agent stats bump             | `UPDATE agents` in completion        | —                                        | JOBS COMPLETED · DUTY HOURS              |
| Wallet ledger w/ MSN-XXX     | `wallet.creditForBooking`            | —                                        | Recent Payouts row title                 |
| Mission summary screen       | `GET /agents/me/payouts/:id/summary` | —                                        | Tap recent payout                        |
| Always-on route alts         | `mapbox-directions.service`          | Live map shows 3 routes                  | —                                        |
| Map style cycler             | —                                    | DARK/STREETS/SAT FAB                     | (already on app)                         |
| Active/Completed tabs        | `?status=completed`                  | Live list tab strip                      | —                                        |
| Status badge                 | —                                    | `LIVE` / `COMPLETED` / `ABORTED` pill    | —                                        |
| SQLCipher WAL                | —                                    | —                                        | No more "database is locked" red bubbles |

---

## 15. Next Up (after today's verification)

| Item                                                              | Why                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Real telemetry from agent app → backend                           | Replace the simulated dot with the assigned CPO's real GPS                  |
| Push notifications for dispatch / new application / mission close | Right now everything is poll-based; iOS/Android FCM not wired               |
| Per-application rate negotiation                                  | Currently agents apply at the job's default rate; allow custom rate offer   |
| Stripe top-up live path                                           | `confirmIntent` exists but the dev flow uses the BC seeding shortcut        |
| Real S3 upload for KYC + booking-related media                    | Still on disk under `auth-service/uploads/`                                 |
| Booking cancellation post-dispatch (refund flow)                  | Currently no path back from LIVE except COMPLETED. Need cancel-with-refund. |

---

## 16. 2026-05-01 — Sealed Sender v2 (outer ECIES) + persistent blob-cache purge ✅

> Closes the last two `Phase-2` items in MESSENGER_SPEC_COVERAGE §2.
> Commit `6871cd1`. 76/76 client-crypto tests + 46/46 server tests + a live wire-shape smoke against the running stack are all green.

### A. Sealed Sender v2 — outer ECIES wrap

The relay no longer sees ANY field that links an envelope back to its sender.

**Wire change (hard cut):** every `envelope.send` / `envelope.deliver` frame
and every `POST /envelopes` body now carries a single `outerSealed` (base64)
field instead of the previous `{ciphertext, senderAddressHint}` pair. The
libsignal `SessionCipher` output **and** the sender's Signal address now
travel encrypted inside an X25519 + AES-256-GCM envelope keyed off the
recipient's identity public key (Signal's UnidentifiedSenderMessage v2
shape).

**Wire format (binary, before base64):**

```
[ ver=0x02 (1B) ‖ ephPub (32B) ‖ iv (12B) ‖ AES-256-GCM ct + 16B tag ]
```

**Crypto details:**

- `eph_priv = randomBytes(32); eph_pub = curve.keyPair(eph_priv).pubKey`
- `dh   = X25519(recipient.identityPub, eph_priv)`
- `salt = SHA-256(eph_pub ‖ recipient.identityPub)` — binds derivation context
- `prk  = HMAC-SHA256(salt, dh)`
- `okm  = HMAC-SHA256(prk, "Bravo-SealedSender-v2" ‖ 0x01)`
- `aes  = AES-256-GCM(okm, iv, inner, AAD = eph_pub ‖ recipient.identityPub)`

**Files touched:**

- New module: [src/modules/messenger/crypto/outerEcies.ts](src/modules/messenger/crypto/outerEcies.ts) + ops-console mirror at [apps/ops-console/src/lib/messenger/outerEcies.ts](apps/ops-console/src/lib/messenger/outerEcies.ts).
- Wire mirrors: [transport/protocol.ts](src/modules/messenger/transport/protocol.ts), [apps/messenger-service/src/gateway/protocol.ts](apps/messenger-service/src/gateway/protocol.ts), [apps/ops-console/src/lib/messenger/protocol.ts](apps/ops-console/src/lib/messenger/protocol.ts).
- Server DTO + service + types + store + controller + gateway: all updated; `senderAddressHint` is gone, the size cap is now 700 KB to fit the outer wrap.
- Client runtime: [productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts) wraps on every send (1:1, group fan-out, reactions, rehandshake nudge) and unwraps on `envelope.deliver` + `drainRelay`. Ops-console [runtime.ts](apps/ops-console/src/lib/messenger/runtime.ts) + [groupClient.ts](apps/ops-console/src/lib/messenger/groupClient.ts) match.

### B. Persistent blob cache + purge wiring

The `MediaBlobCache` (SQLCipher BLOB column, LRU-evicted, 200 MB default cap)
already existed but wasn't fed by any purge path. It is now wired into three
flows so cached attachment ciphertext doesn't outlive its bubble.

**Files touched:**

- Schema bump v3 → v4 with forward-only `ALTER TABLE messages ADD COLUMN media_object_key TEXT` migration in [src/modules/messenger/crypto/db.ts](src/modules/messenger/crypto/db.ts).
- `LocalMessage.media_object_key` field in [store/types.ts](src/modules/messenger/store/types.ts) + persistence in [sqlMessageStore.ts](src/modules/messenger/store/sqlMessageStore.ts). Inbound + outbound message paths in [productionRuntime.ts](src/modules/messenger/runtime/productionRuntime.ts) stamp the R2 object key when the sealed envelope carries an attachment.
- `ExpirySweeper` ([expirySweeper.ts](src/modules/messenger/runtime/expirySweeper.ts)) gains a `purgeBlob` callback that fires alongside the existing `retract`.
- `productionRuntime`'s SQL mirror loop also calls `cache.remove()` for each `media_object_key` when a conversation is removed (clear-chat) or a single message is removed.

### C. Tests

- **76/76** client crypto unit tests: `npm run test:crypto` from repo root. Adds 8 [`outerEcies.test.ts`](src/modules/messenger/__tests__/outerEcies.test.ts) cases (round-trip, ephemeral freshness, wrong-recipient rejection, AES-GCM tag tamper, AAD-bound ephemeral-pubkey swap, version mismatch, PreKeyWhisper preservation, short-wire rejection) and 6 [`mediaBlobCachePurge.test.ts`](src/modules/messenger/__tests__/mediaBlobCachePurge.test.ts) cases (media expiry purges, non-media skipped, rejected purge non-fatal, retract + purge in parallel, multi-message purge, not-yet-expired skipped).
- **46/46** server tests: `cd apps/messenger-service && npx jest`. Rewritten [envelope.service.spec.ts](apps/messenger-service/src/relay/envelope.service.spec.ts) verifies the persisted Redis row carries no `senderAddressHint` / `sender` / `senderUserId` / `submitterUserId` / `ciphertext` field, and the fan-out frame matches.
- **Live wire smoke** ([scripts/smoke-wire-v2.mjs](scripts/smoke-wire-v2.mjs)): mints two test JWTs, in-process X3DH between two real libsignal identities, posts a real `outerSealed` to the running messenger-service, inspects the Redis row directly via `redis-cli`, pulls back as the recipient, unwraps + decrypts, asserts byte-equal plaintext. Also verifies DTO rejection of empty / oversize / past-deadline payloads.

**Run the wire smoke:**

```bash
node scripts/smoke-wire-v2.mjs
# Expect:
#   ✓ Redis row clean — outerSealed=… (no sender fields)
#   ✓ recovered plaintext byte-for-byte: "live-smoke-…"
#   PASS — Sealed Sender v2 wire end-to-end
```

### D. Ops-dashboard relation

Indirect — the relay's `redis-cli get env:<id>` no longer leaks any sender
address. Existing surfaces (Mission Group panel, ChatScreen ticks, presence)
are unchanged because the recovery happens client-side: the unwrap restores
the same `(sender, ciphertext)` tuple the older code received via the hint,
so all higher-level handlers keep working untouched.

### Pre-flight before first run on a fresh machine

The Sealed Sender v2 path needs a Curve25519 keypair distributed across
auth-service + the two clients. The dev keypair already in `.env` works
out-of-the-box; rotate before staging.

```bash
# Generate a fresh keypair (one-time):
node -e "const {AsyncCurve25519Wrapper}=require('@privacyresearch/curve25519-typescript'); \
  const w=new AsyncCurve25519Wrapper(); \
  const s=require('crypto').randomBytes(32); \
  w.keyPair(s.buffer.slice(s.byteOffset,s.byteOffset+32)).then(k=>console.log({ \
    priv:Buffer.from(k.privKey).toString('base64'), \
    pub:Buffer.from(k.pubKey).toString('base64')}))"

# Distribute:
#   priv → apps/auth-service/.env  (SENDER_CERT_PRIVATE_KEY_B64)
#   pub  → root .env               (EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64)
#   pub  → apps/ops-console/.env   (NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64)
```

---

## 17. SQA Step-by-Step Test Guide (2026-05-01)

> Audience: SQA engineer pulling fresh from `omnidevxstudiobit/Bravo_Secure`,
> setting up a clean local stack, and validating every user-facing surface
> across the three roles (**ops**, **client**, **agent**) plus calling.
>
> Total test time: ~90 minutes for a full pass. Three devices (or two
> physical phones + one Pixel emulator) cover every flow including 3-way
> group calls.

### 17.0 Prerequisites

| Item                            | Required                                                        | How to get                                                                                                              |
| ------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Git access**                  | Read access to `omnidevxstudiobit/Bravo_Secure`                 | Ranak grants.                                                                                                           |
| **Node 20+**                    | yes                                                             | https://nodejs.org/                                                                                                     |
| **Docker Desktop**              | yes (Redis + messenger-service)                                 | https://www.docker.com/products/docker-desktop                                                                          |
| **Supabase CLI**                | yes (`npx supabase start` brings local Postgres up on `:54322`) | `npm i -g supabase` or `npx supabase`                                                                                   |
| **Java 17 + Android Studio**    | for Android device/emulator builds                              | https://developer.android.com/studio                                                                                    |
| **Xcode 15+**                   | iOS only                                                        | App Store. macOS host required.                                                                                         |
| **3× test devices**             | for full call-test coverage                                     | 1 Pixel emulator + 2 physical Androids works. iOS sim does NOT support `react-native-webrtc` camera; use a real iPhone. |
| **Twilio account (test creds)** | for SMS OTP                                                     | If unavailable, set `OTP_DEV_BYPASS=true` in `apps/auth-service/.env` and any 4–8 digits will pass.                     |

**Network requirement for group calls (mediasoup SFU):** UDP ports
**40000-49999** must be open on the host running `messenger-service`.
On the same LAN as the test devices this is automatic; over a NAT/firewall
set `SFU_ANNOUNCED_IP=<host-public-ip>` in `apps/messenger-service/.env`.

### 17.1 Pull + bootstrap

```bash
# 1. Pull latest
git clone https://github.com/omnidevxstudiobit/Bravo_Secure.git
cd Bravo_Secure
# (or `git pull origin main` if you already have a clone)

# 2. Install deps everywhere
npm install                                      # RN client
( cd apps/auth-service      && npm install )
( cd apps/messenger-service && npm install )     # builds mediasoup C++ worker
( cd apps/ops-console       && npm install )

# 3. Copy + edit env files
cp .env.example .env
cp apps/auth-service/.env.example      apps/auth-service/.env       2>/dev/null || true
cp apps/messenger-service/.env.example apps/messenger-service/.env  2>/dev/null || true
cp apps/ops-console/.env.example       apps/ops-console/.env        2>/dev/null || true
# Set OTP_DEV_BYPASS=true in apps/auth-service/.env to skip Twilio.
# The default dev sender-cert keypair is fine for local; flip before staging.

# 4. iOS only: install pods
( cd ios && pod install )                        # macOS host only
```

### 17.2 Boot the stack (5 terminals, in this order)

```bash
# Terminal 1 — Postgres (Supabase local)
npx supabase start                               # binds 54321–54327

# Terminal 2 — Redis + messenger-service in Docker
docker compose up -d redis messenger-service
docker compose logs -f messenger-service         # watch boot, look for "Nest application successfully started"

# Terminal 3 — auth-service
cd apps/auth-service && npm run start:dev        # binds :3001

# Terminal 4 — ops-console (Next.js)
cd apps/ops-console && npm run dev               # binds :3002

# Terminal 5 — Metro bundler + RN
npm run start                                    # then `a` for Android, `i` for iOS
# OR for a real Android device:
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001
adb reverse tcp:3002 tcp:3002
adb reverse tcp:3100 tcp:3100
npm run android
```

**Smoke check before logging in:**

```bash
curl -fsS http://127.0.0.1:3001/auth/health      # auth-service
curl -fsS http://127.0.0.1:3100/sfu/stats        # messenger-service (returns 401 unauth — that means it's up)
redis-cli ping                                   # → PONG
node scripts/smoke-wire-v2.mjs                   # → PASS — Sealed Sender v2 wire end-to-end
( cd apps/messenger-service && npx jest )        # → 46/46 pass
npm run test:crypto                              # → 76/76 pass
```

### 17.3 Test accounts

A clean DB has no users. Create three accounts via the registration flows
(or seed via the e2e helper) before testing:

| Role            | Account                                                                       | How to create                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ops admin**   | phone `+880188888888` · password `bravo123` · OTP any 4–8 digits (dev bypass) | On `localhost:3002/register` use phone+password+OTP, then `cd apps/auth-service && node scripts-mint-ops-token.mjs OPS-01` to bind admin role. |
| **Client**      | phone `+8801712345678` · password `client123`                                 | In the mobile app: open app → "Get Started" → phone-first registration.                                                                        |
| **Agent (CPO)** | phone `+8801812345678` · password `agent123`                                  | In the mobile app: open app → choose **Agent** at first launch → CPO type → register.                                                          |

**Or** run the auto-seed: `npx tsx scripts/e2e-booking-lifecycle.ts` registers
all three plus seeds a job, vehicle, and wallet. Reuse the printed JWTs.

### 17.4 OPS — step-by-step (web, `localhost:3002`)

> Hat: ops admin reviewing agents, approving bookings, dispatching missions, monitoring live ops, completing payouts.

| #   | Step                                                                                                            | Expected                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open `localhost:3002/login`, enter ops phone + password, submit OTP.                                            | Lands on `/dashboard` with KPI tiles (no dummy data — empty until seeded).                                                                                  |
| 2   | `/agents` → click the pending agent row.                                                                        | Right column shows **KYC Documents** (4 slots) + **Compliance Pack** (6 slots). Each slot has a **VIEW** button.                                            |
| 3   | Click **VIEW** on each KYC doc.                                                                                 | Slot border turns green; pipeline step `kyc` flips `in_progress` → `done`. Mobile agent sees the dot move within 3s.                                        |
| 4   | Click **APPROVE** with notes (e.g. "Cleared").                                                                  | All 5 pipeline steps flip to `done` atomically. Agent status flips to `ACTIVE` server-side. Agent app sees "ACTIVE" badge within 3s.                        |
| 5   | `/bookings` — wait for the client to submit a booking. Click the new `PENDING_OPS` row → **APPROVE & PUBLISH**. | Booking transitions `PENDING_OPS → OPS_APPROVED`. Client app fires its auto-pay countdown sheet within 4s.                                                  |
| 6   | Refresh the booking detail. After client pays it should be `CONFIRMED`.                                         | Right column shows **Team & Dispatch** card — applicants list (empty until agents apply).                                                                   |
| 7   | Wait for agent(s) to tap Apply on the Job Marketplace.                                                          | Applicants list refreshes every 6s. Each row shows `agent_call_sign · display_name · Tier X · jobs · ★ rating · applied Nm ago`.                            |
| 8   | Pick the right number of CPOs (matches `cpo_count`) + 1 vehicle from the AE pool.                               | Status pill flips green: `✓ READY · N APPLICANT + 1 VEHICLE LOCKED`. Dispatch button is no longer dimmed.                                                   |
| 9   | Click **DISPATCH MISSION → LIVE**.                                                                              | Booking transitions `CONFIRMED → LIVE`. **Assigned Team** card appears. **Mission Live** card replaces the picker with `END MISSION → PAYOUT` (red).        |
| 10  | Open the **Messenger Dock** in the bottom-right (or `/live/[id]` page) → click the new mission group.           | Group conversation `Mission BS-XXXXXXXX` is created with ops as admin + each picked agent. Header reads `N active`.                                         |
| 11  | Send a text message in the group.                                                                               | Bubble appears instantly on every member's mobile within ~1s. Double-tick on read.                                                                          |
| 12  | While other members are typing, watch the header.                                                               | Should read `Ranak typing…` (or whoever). Auto-clears within 6s if frame is dropped.                                                                        |
| 13  | Tap the **voice call** icon (1:1 with one specific crew member from the chat list).                             | See [§17.7 Calling](#177-calling-end-to-end-tests-1-of-2-required) for the full call flow.                                                                  |
| 14  | Click **END MISSION → PAYOUT** with the confirmation.                                                           | Booking transitions `LIVE → COMPLETED`. Each paid CPO gets `total_eur / cpo_count` floor-credited. Wallet ledger row reads `Mission payout · MSN-XXXXXXXX`. |
| 15  | Check the Messenger list.                                                                                       | Mission group title now reads `Mission BS-XXXXXXXX · COMPLETED`. Conversation + every message stays for ops audit.                                          |
| 16  | `/live` → switch to **Completed** tab.                                                                          | Just-completed mission row visible (green `COMPLETED` pill). Click → opens read-only post-mortem (map + crew + audit + messenger archive).                  |

### 17.5 CLIENT — step-by-step (mobile)

> Hat: client booking a CPO + vehicle, paying with Bravo Credits, tracking the mission live, chatting with the assigned crew.

| #   | Step                                                                                                                                                | Expected                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Cold-launch the app. Tap **Get Started** → enter phone + password → submit OTP.                                                                     | Lands on the **Secure** tab home. Hero card reads "Book Now". Wallet shows 0 BC.                                                                                         |
| 2   | Open **Wallet → Top up** (dev shortcut). Add 200 BC.                                                                                                | Balance reflects within 2s. Ledger shows the deposit row.                                                                                                                |
| 3   | **Book Now** → wizard: pickup + dropoff (Mapbox autocomplete) → date + time → service options (1 CPO, 1 vehicle, region AE, duration 4h) → confirm. | Backend writes `lite_bookings` row with `status=PENDING_OPS`. App routes to `OpsRoomReview` (yellow, hardware-back blocked, no chevron).                                 |
| 4   | **Wait** while ops approves on web (see §17.4 step 5). Don't navigate.                                                                              | Polling every 4s. When ops approves, an **auto-pay countdown sheet** opens: `YOU HAVE / DEDUCTING / REMAINING` for 5s.                                                   |
| 5   | Watch the sheet.                                                                                                                                    | Flips to `Charging…` then `PAYMENT CAPTURED · WAS / DEDUCTED / NEW BALANCE` for 2.2s.                                                                                    |
| 6   | App auto-routes to `BookingConfirmation`.                                                                                                           | Header reads green "BOOKING CONFIRMED · Paid". Assigned Team card shows "Awaiting team assignment". TRACK button reads **AWAITING DISPATCH** (hourglass icon, disabled). |
| 7   | Wait for ops to dispatch.                                                                                                                           | Within 5s of ops clicking dispatch, Assigned Team card swaps to the real CPO + vehicle. TRACK button enables (green, crosshairs icon).                                   |
| 8   | Tap **TRACK**.                                                                                                                                      | LiveTracking opens with red **LIVE OPERATION** header. Real route from booking pickup→dropoff. Vehicle dot animating along the polyline.                                 |
| 9   | Tap the **CHAT** row in LiveTracking.                                                                                                               | Routes to Messenger → `Mission BS-XXXXXXXX` group. You + ops admin + all assigned CPOs are members.                                                                      |
| 10  | Send a message.                                                                                                                                     | Bubble appears in <1s on every member. Single-tick → double-tick when ops/agent reads. Typing dot lights up while they compose.                                          |
| 11  | Tap the **voice call** icon on the chat header (1:1 to one CPO, picked via the chat list — group calls covered separately in §17.7).                | See [§17.7 Calling](#177-calling-end-to-end-tests-1-of-2-required).                                                                                                      |
| 12  | Wait for ops to end mission (web step 14).                                                                                                          | Within 5s, LiveTracking pops back to Home. Hero card flips back to "Book Now".                                                                                           |
| 13  | Open **Messenger** tab.                                                                                                                             | The mission group is **gone** from the client's list (membership row deleted server-side). Only ops retains it for audit.                                                |
| 14  | Open **Wallet**.                                                                                                                                    | Balance reduced by the booking total minus any platform-fee rounding. Audit row reads `Mission BS-XXXXXXXX · debited`.                                                   |

### 17.6 AGENT (CPO) — step-by-step (mobile)

> Hat: a CPO completing onboarding, applying to jobs, getting dispatched, working a mission group, completing the assignment, getting paid.

| #   | Step                                                                                                                                                                                                                                                                            | Expected                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cold-launch the app. Tap **Agent** at the role-picker.                                                                                                                                                                                                                          | AgentTypeSelect screen with CPO / Driver / etc. Tap **CPO**.                                                                                                                                                                                                                    |
| 2   | Walk through the 9-screen onboarding: registration wizard → upload 4 KYC docs (Gov ID, POA, SIA, Police) via DocumentPicker → coverage (countries + services) → availability → upload 6-slot compliance pack (SIA, Passport, Insurance, DBS required; First Aid + CV optional). | Each upload hits `POST /agents/me/upload` (or `…/kyc/:kind/upload`). Files saved under `auth-service/uploads/{userId}/`. Pipeline `docs` step flips `in_progress`.                                                                                                              |
| 3   | Land on **AgentAdminApproval** (live polling every 3s).                                                                                                                                                                                                                         | Pipeline pills show progress as ops VIEWs each doc on the web. LIVE dot + "Last updated <ts>" visible.                                                                                                                                                                          |
| 4   | Wait for ops to APPROVE (see §17.4 step 4).                                                                                                                                                                                                                                     | Status flips directly to `ACTIVE`. App auto-routes to **AgentDashboard** (real name, ON DUTY toggle, Messenger + Intel tiles).                                                                                                                                                  |
| 5   | Open **Job Marketplace**.                                                                                                                                                                                                                                                       | List shows live `PUBLISHED` jobs from the DB. Each row has an **Apply** button (purple bolt icon).                                                                                                                                                                              |
| 6   | Tap **Apply** on a target job.                                                                                                                                                                                                                                                  | Button flips to green **"Applied · tap to withdraw"**. Backend writes `job_applications` row with `status=PENDING`.                                                                                                                                                             |
| 7   | Wait for ops to dispatch with you on the team (see §17.4 steps 7–9).                                                                                                                                                                                                            | Within 6s of dispatch, Apply button on the targeted job flips to blue **"On Team"** (shield-check icon). Other agents see **"Not Selected"**.                                                                                                                                   |
| 8   | Open **Messenger** tab.                                                                                                                                                                                                                                                         | New conversation `Mission BS-XXXXXXXX` is at the top. Members: ops admin + you + every other dispatched CPO.                                                                                                                                                                    |
| 9   | Tap the conversation, send a message, attach a photo via the paperclip.                                                                                                                                                                                                         | Photo encrypts locally (AES-256-CBC), uploads encrypted blob to R2 (or MinIO in local dev), key + IV ride inside the sealed envelope. Recipients tap to view → blob decrypts client-side. **Verify the R2 object is unreadable** (open it raw in MinIO browser → random bytes). |
| 10  | Set a 30-second TTL on a message via the composer's clock icon.                                                                                                                                                                                                                 | Message bubble shows live countdown `30s / 29s / …`. Bubble auto-removes from both your and recipient's screen at 0s. **Verify on the relay side**: `redis-cli keys env:*` → the matching envelope's TTL drops.                                                                 |
| 11  | Watch presence + typing.                                                                                                                                                                                                                                                        | Header reads `N active` while ops is online. `Ranak typing…` lights up while they compose.                                                                                                                                                                                      |
| 12  | When ops triggers `END MISSION → PAYOUT`.                                                                                                                                                                                                                                       | Within 5s, the mission group **disappears** from your Messenger list (membership row deleted).                                                                                                                                                                                  |
| 13  | Open **Bravo System** DM.                                                                                                                                                                                                                                                       | New `mission_complete` card with route + distance + payout amount + duration. Acts as your audit trail.                                                                                                                                                                         |
| 14  | Open **Wallet**.                                                                                                                                                                                                                                                                | Balance increased by `floor(total_eur / cpo_count)`. Ledger row reads `Mission payout · MSN-XXXXXXXX`.                                                                                                                                                                          |
| 15  | Open **AgentDashboard**.                                                                                                                                                                                                                                                        | `JOBS COMPLETED` and `DUTY HOURS · MTD` ticked up to reflect the just-paid mission.                                                                                                                                                                                             |
| 16  | **Earnings** screen → tap the recent payout row.                                                                                                                                                                                                                                | Routes to `MissionSummaryScreen`: route map + distance + duration + payout breakdown + deduction reason (if any).                                                                                                                                                               |

### 17.7 Calling end-to-end tests (1-of-2 required)

> The messenger ships with two call paths: **1:1 voice/video** (peer-to-peer
> RTCPeerConnection over DTLS-SRTP) and **group calls (3+ members)** via
> the in-process **mediasoup SFU**. Both must be verified.

#### 17.7.A — 1:1 voice + video (two devices)

Pre-flight: both devices logged in (e.g. agent + client), both have a 1:1
or `direct:` conversation between them. Same Wi-Fi or both reachable on the
LAN of the messenger-service host.

| #   | Step                                                                      | Expected                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device A opens the chat with Device B → tap the **phone** icon top-right. | Routes to `CallScreen` with state `dialing`. App displays "Calling B…" + cancel button.                                                                                                                                                                                           |
| 2   | Device B receives the incoming offer over the same WS.                    | Full-screen "Incoming voice call from A" with **ACCEPT** + **DECLINE**.                                                                                                                                                                                                           |
| 3   | B taps ACCEPT.                                                            | Both devices enter `ringing → connecting → connected`. ICE candidates trickle on the same `call.ice` WS frames. **DTLS-SRTP verification runs**: `verifyDtlsSrtp()` walks `getStats()`, asserts every transport reports `dtlsState === 'connected'` and a non-empty `srtpCipher`. |
| 4   | Look at the **AES badge** in the call header.                             | Renders the negotiated cipher, e.g. `AES_CM_128_HMAC_SHA1_80`. If the badge is missing the call must NOT have surfaced media — `verifyDtlsSrtp` failure is a hard fail.                                                                                                           |
| 5   | Speak into A's mic.                                                       | Audio comes out of B's speaker. Mute toggle silences locally; remote sees a muted icon next to your tile.                                                                                                                                                                         |
| 6   | Repeat with the **video** icon instead — both cameras + audio.            | Both video tracks render, AES badge present, mute + camera toggle work.                                                                                                                                                                                                           |
| 7   | Either side taps the red hangup.                                          | Both devices return to the chat screen. Backend emits `call.hangup` to peer. CallsLog screen shows the call entry with duration + AES cipher.                                                                                                                                     |

**NAT-traversal failure path (Agora fallback):**
Force one device onto a hostile NAT (mobile data behind carrier-grade NAT
is the canonical case). The 1:1 call should:

- ICE-connection times out at 12 s.
- App auto-issues `GET /agora/token` (server-side endpoint TBD; until shipped,
  the Agora project must be in **Testing** mode and the fallback may surface
  as a "Could not reach peer — falling back to relay" toast).

#### 17.7.B — Group calls via mediasoup SFU (three devices required)

Pre-flight on the messenger-service host:

```bash
# Confirm the SFU started workers
curl -s http://127.0.0.1:3100/sfu/stats
# Expect: {"rooms":0,"participants":0,"workers":N,"restartTotals":0}
# where N = os.cpus().length

# Confirm UDP 40000-49999 are open on the host firewall.
# If host is behind NAT, set SFU_ANNOUNCED_IP=<public-ip> in .env.
```

Devices: A (client) + B (ops admin) + C (agent). All three are members of
the same `Mission BS-XXXXXXXX` mission group from §17.4.

| #   | Step                                                                                                         | Expected                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device A opens the mission group → tap the **phone** icon.                                                   | A's app calls `POST /sfu/rooms` (server creates Router on a Worker, returns `roomId`), then sends `sfu.join`. Server creates send + recv `WebRtcTransport` per A. App opens `GroupCallScreen` with one tile (A) waiting.                                                                                                                        |
| 2   | Devices B + C open the same group → tap the **phone** icon (each).                                           | Each runs `Device.load(routerRtpCapabilities) → createSendTransport → produce(audio,video) → consume(<every existing producer>) → consumer.resume`. Three tiles light up across all three devices.                                                                                                                                              |
| 3   | Each member should hear the other two and see their video.                                                   | Adaptive grid: 1 → 2 → 3 columns. Local PiP. Mute / video / hangup / invite buttons live. **Verify on the SFU**: `curl http://127.0.0.1:3100/sfu/stats` → `{"rooms":1,"participants":3,"workers":N}`.                                                                                                                                           |
| 4   | Member B mutes the mic.                                                                                      | Producer pauses on B's send transport. A + C see the muted icon update on B's tile within ~500 ms via `sfu.consumer.resume` semantics.                                                                                                                                                                                                          |
| 5   | Member C taps hangup.                                                                                        | C's `sfu.leave` fires. Server tears down C's transports + producers. A + B see C's tile drop (server fans `sfu.participant.left`). The room continues with 2 members.                                                                                                                                                                           |
| 6   | Member A taps hangup.                                                                                        | Same teardown. Last member leaves → server auto-closes the Router. `/sfu/stats` returns to `{"rooms":0,"participants":0}`.                                                                                                                                                                                                                      |
| 7   | **Worker death recovery test**: while the call is live, kill a mediasoup Worker process via OS task manager. | Server's `SfuWorkerPool` notices `worker.died` → exponential backoff restart (1s → 2s → 4s → … capped at 30s, max 3 restarts per slot per 5-min window). `restartTotals` increments in `/sfu/stats`. The active call's tiles drop (mediasoup Workers don't migrate live connections); both members see `sfu.error` and return to the dashboard. |

#### 17.7.C — DTLS / SRTP wire smoke (no devices)

Even without phones, you can confirm the SFU + Sealed Sender wire shapes
are correct:

```bash
# 1. SFU signalling smoke (3 fake sockets, room create + join + fanout + leave + cleanup)
ALICE_JWT=… BOB_JWT=… CARLA_JWT=… node scripts/e2e-sfu-smoke.mjs   # → PASS

# 2. Sealed Sender v2 wire smoke (single envelope round-trip)
node scripts/smoke-wire-v2.mjs   # → PASS — Sealed Sender v2 wire end-to-end

# 3. Inspect Redis directly during a live test (in another terminal):
redis-cli keys 'env:*'                     # list active envelopes
redis-cli get env:<id> | jq                # inspect one — must contain `outerSealed`
                                           # MUST NOT contain `senderAddressHint`,
                                           # `sender`, `senderUserId`, `submitterUserId`,
                                           # or `ciphertext`. Anything else = fail.
```

### 17.8 Bug-report template

When something fails, file with:

1. **Role + step** from the table above (e.g. "§17.5 step 8").
2. **What happened** vs. **what you expected**.
3. **Logs**:
   - `docker compose logs -f messenger-service | tail -200`
   - `auth-service` terminal output around the failure
   - device's React-Native log (`adb logcat | grep -i bravo` for Android)
4. **Network state**:
   - `redis-cli keys 'env:*' | wc -l` — pending envelope count
   - `redis-cli keys 'pending:*'` — per-device queues
5. **Reproducibility**: 1× / sometimes / always
6. **Affected platforms**: Android only? iOS only? Both? Web ops console?

### 17.9 Known caveats (not bugs)

- **LiveTracking telemetry is simulated** (8s/step interpolation between booking coords). Real per-CPO GPS push is on §15's roadmap.
- **Push notifications**: dispatch / new application / mission close events are poll-based today. iOS/Android FCM not yet wired. Don't expect background notifications until §15 ships.
- **iOS sim camera**: `react-native-webrtc` cannot bind the camera in iOS simulator. Use a real iPhone for video tests.
- **Agora fallback**: `/agora/token` server endpoint is not yet implemented. The 1:1 fallback path issues the call but the Agora SDK won't actually relay until that endpoint is shipped. NAT-traversal-failure tests should be deferred or run with both devices on the same LAN.
- **Group calls require host LAN reachability** (or a public `SFU_ANNOUNCED_IP` + UDP 40000-49999 forwarded). Cellular-only phones behind carrier-grade NAT will fail the media plane until TURN-over-TCP is wired.
- **Wire format is a hard cut at commit `6871cd1`**: any envelope that was sitting in Redis from a pre-deploy client (encoded with the old `{ciphertext, senderAddressHint}` shape) will fail to unwrap on the new client. **Drain the relay before deploy** (`redis-cli flushdb` against the messenger-service Redis is the simplest path in dev) or accept that any in-flight messages from before this commit are lost.

---
