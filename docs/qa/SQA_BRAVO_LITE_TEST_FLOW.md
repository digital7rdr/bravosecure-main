# Bravo Lite — SQA Full Test Flow (Staging)

> Owner: SQA
> Branch: `main` · Commit at time of writing: `aaed185`
> Target environment: **STAGING** (no local stack required)
> Estimated full pass: **~90 min** with 3 devices + 1 laptop with a browser

This document walks the SQA tester end-to-end through every shipping feature of Bravo Lite **against the live staging environment**: setup → login per role (ops · client · agent/CPO) → 3-role flows → messenger → 1:1 + group calls → security smokes → bug report template.

---

## 0. Test scope

In scope:

- **Mobile** (React Native / Expo `apk:staging` build) — agent + client roles
- **Ops Console** — ops admin role
- **Auth-service** — auth, agents, bookings, ops, wallet (staging)
- **Messenger-service** — relay, WS, SFU (staging)
- **Postgres** (Supabase managed) + **Redis** (staging EC2)

Out of scope (known caveats, not bugs — see §10):

- Live per-CPO GPS telemetry (still simulated)
- FCM / APNs push notifications
- `/agora/token` 1:1 NAT fallback
- Real S3 (currently disk-on-server for uploads)

---

## 1. Staging endpoints (single source of truth)

| Service                                  | URL                                        | Notes                                                   |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| **Ops Console (web)**                    | `https://ops.94-136-184-52.sslip.io`       | Vercel-hosted. Opens at `/login`.                       |
| **Auth-service**                         | `https://auth.94-136-184-52.sslip.io`      | `/auth/health` → `200`.                                 |
| **Messenger-service (relay + WS + SFU)** | `https://relay.94-136-184-52.sslip.io`     | `/sfu/stats` → `401` (auth required) = up.              |
| **Supabase (Postgres)**                  | `https://qkkfkicgoncxslbwhyhz.supabase.co` | Managed. SQA does not need direct DB access.            |
| **Staging host (Contabo VPS)**           | `94.136.184.52`                            | Asia/India region, 4 vCPU / 8 GB, instance `203344471`. |

All mobile builds (`apk:staging` / `eas:build:staging`) **already bake these URLs in** — SQA does not have to configure anything.

> **No localhost. No docker compose. No Supabase CLI. No Metro.**
> If you find yourself running any of those, you are off the script — stop and re-read this section.

---

## 2. Pre-requisites

| Item                                         | Required               | Notes                                                                                    |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| Modern Chrome / Edge / Firefox               | Yes                    | For ops console                                                                          |
| **3 test devices**                           | For full call coverage | 1 emulator + 2 physical Androids works; iOS sim can't bind camera — use a real iPhone    |
| Bravo Lite **staging APK**                   | Android devices        | Latest `apk:staging` build (EAS channel `preview-staging`) installed on every test phone |
| Bravo Lite **staging IPA**                   | iOS devices            | Latest `preview-staging-device` build via TestFlight / EAS internal distribution         |
| Phone signal                                 | Yes                    | OTP delivered via Twilio Verify to the real phone number you register                    |
| Stable internet on the laptop **and** phones | Yes                    | All three must reach `*.94-136-184-52.sslip.io`                                          |

> **Network for group calls:** UDP **49160-49200** (TURN media relay) plus TURN **3478** / TURNS **5349** must be reachable from your test devices to `94.136.184.52`. Carrier-grade NAT (some 4G networks) will fail the media plane. If group calls don't connect, switch to Wi-Fi.

---

## 3. Smoke-check the staging stack before logging in

Run from any terminal (laptop):

```bash
curl -fsS https://auth.94-136-184-52.sslip.io/auth/health     # → 200, JSON body
curl -fsS -o /dev/null -w "%{http_code}\n" \
         https://relay.94-136-184-52.sslip.io/sfu/stats       # → 401 (auth required = service up)
curl -fsS -o /dev/null -w "%{http_code}\n" \
         https://ops.94-136-184-52.sslip.io/login             # → 200
```

**If any of the three fails — stop. File a bug against Infra; do not start functional testing.**

---

## 4. Test accounts (staging)

Staging uses **real Twilio Verify** — OTPs are sent to the actual phone number you register. There is **no dev bypass** on staging. Use a phone number you control or use the SQA pool.

| Role            | Login surface                                  | Credentials            | Initial provisioning                                                                 |
| --------------- | ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| **Ops admin**   | `https://ops.94-136-184-52.sslip.io/login`     | Phone + password + OTP | Provisioned by Infra. If you don't have an account, ask Ranak to mint one. See §5.A. |
| **Client**      | Mobile app → role-picker → **Client**          | Phone + password + OTP | Self-register from the app. See §6.A.                                                |
| **Agent (CPO)** | Mobile app → role-picker → **Agent** → **CPO** | Phone + password + OTP | Self-register from the app, then waits for ops approval. See §7.A.                   |

> Per-role login flows are written out step-by-step in **§5.A, §6.A, and §7.A** below — do not skip these. Each role boots into a different surface and has a different first-screen.

---

## 5. OPS flow — web (`https://ops.94-136-184-52.sslip.io`)

Hat: ops admin. Reviews agents, approves bookings, dispatches missions, monitors live ops, completes payouts.

### 5.A — How to log in as **Ops Admin**

| #   | Step                                                                        | Expected                                                                                                                            |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Open `https://ops.94-136-184-52.sslip.io/login` in Chrome/Edge.             | Login screen renders with phone, password, "SEND OTP" button. No console errors in DevTools.                                        |
| L2  | Enter your ops phone (e.g. `+880188888888`) + password. Click **SEND OTP**. | Twilio sends a 6-digit code to that phone within ~10s. Button disables + shows countdown.                                           |
| L3  | Type the 6-digit code from the SMS → **VERIFY**.                            | Redirects to `/dashboard`. Top-right shows your ops call-sign (e.g. `OPS-01`).                                                      |
| L4  | First-time only: if you don't have an ops account, ping Ranak.              | He runs `node scripts-mint-ops-token.mjs OPS-XX` against the staging auth-service and DMs you the temp password. Then repeat L1–L3. |
| L5  | KPI tiles render (empty until seeded — **no dummy data**).                  | Sidebar lists: Dashboard · Agents · Bookings · Live · Messenger · Wallet · Audit.                                                   |

**If you can't log in:** check (a) the phone number is exactly `+<country><number>` with no spaces, (b) the OTP hasn't expired (10 min TTL), (c) `auth/health` still returns 200 from §3.

### 5.B — Ops functional flow (after login)

| #   | Step                                                                                          | Expected                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | After L1–L5 you are on `/dashboard`.                                                          | KPI tiles render (empty until seeded — **no dummy data**).                                                                                                         |
| 2   | `/agents` → click the pending agent row.                                                      | Right column shows **KYC Documents** (4 slots) + **Compliance Pack** (6 slots). Each has a **VIEW** button.                                                        |
| 3   | Click **VIEW** on each KYC doc.                                                               | Slot border turns green. `kyc` pipeline step → `in_progress` → `done`. Mobile agent sees the dot move within 3s.                                                   |
| 4   | Click **APPROVE** with notes (e.g. "Cleared").                                                | All 5 pipeline steps flip to `done` atomically. Agent status → `ACTIVE`. Agent app sees badge within 3s.                                                           |
| 5   | `/bookings` → wait for client booking. Open new `PENDING_OPS` row → **APPROVE & PUBLISH**.    | Booking: `PENDING_OPS → OPS_APPROVED`. Client app fires auto-pay countdown within 4s.                                                                              |
| 6   | Refresh booking detail after client pays.                                                     | Status `CONFIRMED`. Right column shows **Team & Dispatch** card (applicants list empty until agents apply).                                                        |
| 7   | Wait for agent(s) to tap Apply on Job Marketplace.                                            | List auto-refreshes every 6s. Rows show `agent_call_sign · display_name · Tier X · jobs · ★ rating · applied Nm ago`.                                              |
| 8   | Pick exactly `cpo_count` CPOs + 1 vehicle from the AE pool.                                   | Status pill turns green: `✓ READY · N APPLICANT + 1 VEHICLE LOCKED`. Dispatch button no longer dimmed.                                                             |
| 9   | Click **DISPATCH MISSION → LIVE**.                                                            | Booking: `CONFIRMED → LIVE`. **Assigned Team** card appears. **Mission Live** card replaces picker with red `END MISSION → PAYOUT`.                                |
| 10  | Open the **Messenger Dock** (bottom-right) **or** `/live/[id]` → click the new mission group. | New group conversation `Mission BS-XXXXXXXX` with ops admin + each picked agent. Header reads `N active`.                                                          |
| 11  | Send a text message in the group.                                                             | Bubble lands on every member's mobile within ~1s. Single-tick → double-tick on read.                                                                               |
| 12  | While another member is typing, watch the header.                                             | Reads e.g. `Ranak typing…`. Auto-clears within 6s if frame dropped.                                                                                                |
| 13  | Tap the **voice call** icon on a 1:1 chat with one CPO.                                       | See §9.                                                                                                                                                            |
| 14  | Click **END MISSION → PAYOUT** + confirm.                                                     | Booking: `LIVE → COMPLETED`. Each paid CPO credited `floor(total_eur / cpo_count)`. Ledger row: `Mission payout · MSN-XXXXXXXX`. Remainder rounds to platform fee. |
| 15  | Check Messenger list.                                                                         | Mission group title now reads `Mission BS-XXXXXXXX · COMPLETED`. **Conversation + all messages retained for ops audit.**                                           |
| 16  | `/live` → switch to **Completed** tab.                                                        | The just-completed mission appears with green `COMPLETED` pill. Click → read-only post-mortem (map + crew + audit + messenger archive).                            |

---

## 6. CLIENT flow — mobile

Hat: client booking a CPO + vehicle, paying with Bravo Credits, tracking live, chatting with crew.

### 6.A — How to log in as **Client** (mobile)

| #   | Step                                                                                                                                                                      | Expected                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L1  | Install the latest staging APK / IPA on the device. Cold-launch the app.                                                                                                  | Splash → role-picker screen: **Client** · **Agent**.                                         |
| L2  | Tap **Client** → **Get Started**.                                                                                                                                         | Phone-entry screen.                                                                          |
| L3  | New user: enter phone (e.g. `+8801712345678`) + create a password → **REGISTER**. Existing user: tap **I already have an account** → enter phone + password → **LOG IN**. | Staging auth-service writes/verifies the row, then triggers Twilio Verify OTP to that phone. |
| L4  | Enter the 6-digit OTP from SMS → **VERIFY**.                                                                                                                              | App stores JWT in Keychain. Routes to **Secure** tab.                                        |
| L5  | First-time only: app fingerprints the device and registers for biometric.                                                                                                 | Subsequent launches resume the session via biometric (no OTP re-prompt).                     |

**If you can't log in:**

- OTP not arriving: check the phone has signal; Twilio Verify TTL is 10 min.
- "Phone already registered": you previously registered — use **LOG IN** instead of **REGISTER**.
- "Invalid credentials": password reset is **not yet wired in staging** — ask Ranak to clear the row in `auth.users` for your phone.

### 6.B — Client functional flow (after login)

| #   | Step                                                                                                                              | Expected                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | After L1–L5 you are on **Secure** tab.                                                                                            | Hero card: "Book Now". Wallet: 0 BC.                                                                                                            |
| 2   | **Wallet → Top up** → enter `200` → confirm via test Stripe card `4242 4242 4242 4242` exp `12/34` cvc `123`.                     | Balance updates to 200 BC within 2s. Ledger shows deposit.                                                                                      |
| 3   | **Book Now** → wizard: pickup + dropoff (Mapbox autocomplete) → date + time → 1 CPO, 1 vehicle, region AE, duration 4h → confirm. | Backend writes `lite_bookings.status=PENDING_OPS`. App routes to `OpsRoomReview` (yellow, **hardware-back blocked**, no chevron).               |
| 4   | Wait for ops to approve (§5.B step 5). **Do not navigate.**                                                                       | Polls every 4s. On approval: auto-pay countdown sheet opens — `YOU HAVE / DEDUCTING / REMAINING` for 5s.                                        |
| 5   | Watch the sheet.                                                                                                                  | Flips to `Charging…` then `PAYMENT CAPTURED · WAS / DEDUCTED / NEW BALANCE` for 2.2s.                                                           |
| 6   | App auto-routes to `BookingConfirmation`.                                                                                         | Green header: "BOOKING CONFIRMED · Paid". Assigned Team: "Awaiting team assignment". TRACK button: **AWAITING DISPATCH** (hourglass, disabled). |
| 7   | Wait for ops dispatch.                                                                                                            | Within 5s of dispatch, Assigned Team card shows real CPO + vehicle. TRACK button enables (green, crosshairs).                                   |
| 8   | Tap **TRACK**.                                                                                                                    | LiveTracking opens. Red **LIVE OPERATION** header. Real route from pickup→dropoff. Vehicle dot animating along polyline.                        |
| 9   | Tap **CHAT** row in LiveTracking.                                                                                                 | Routes to Messenger → `Mission BS-XXXXXXXX` group. Members: you + ops + all assigned CPOs.                                                      |
| 10  | Send a message.                                                                                                                   | Bubble lands in <1s. Single-tick → double-tick on read. Typing dot lights when peer composes.                                                   |
| 11  | Tap **voice call** in chat header (1:1 to one CPO).                                                                               | See §9.                                                                                                                                         |
| 12  | Wait for ops to end mission (§5.B step 14).                                                                                       | Within 5s, LiveTracking pops back to Home. Hero card flips back to "Book Now".                                                                  |
| 13  | Open **Messenger** tab.                                                                                                           | Mission group is **gone** from client's list (server-side membership row deleted). Only ops retains it.                                         |
| 14  | Open **Wallet**.                                                                                                                  | Balance reduced by booking total minus platform-fee rounding. Audit row: `Mission BS-XXXXXXXX · debited`.                                       |

### Edge — Insufficient credits

| #   | Step                                                                                            | Expected                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Drain wallet to 0 BC. Make a new booking. Ops approves.                                         | Countdown runs. At 0s, payment fails. Sheet flips to **INSUFFICIENT BRAVO CREDITS** with `WAS / NEED / SHORT` math + **TOP UP NOW** button. |
| A2  | Tap "I'll top up later".                                                                        | Booking sits at `PAYMENT_PENDING` in DB.                                                                                                    |
| A3  | Re-enter app → resume gate routes to `OpsRoomReview` → countdown re-fires → still insufficient. | Behaviour identical.                                                                                                                        |
| A4  | Top up via Credits screen → re-enter Secure tab.                                                | Countdown succeeds. Booking → CONFIRMED.                                                                                                    |

### Edge — Cancel / reject

| #   | Step                                                                     | Expected                                                                                       |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| B1  | Ops rejects a `PENDING_OPS` booking on web.                              | App polling sees `CANCELLED`. OpsRoomReview shows red "BOOKING REJECTED · TAP TO RESTART" CTA. |
| B2  | Verify any rejected job applications don't reappear in any agent's feed. | Empty.                                                                                         |

### Edge — Resume / regression sanity

- [ ] Resume gate doesn't trap on `CANCELLED` or `COMPLETED` rows.
- [ ] FAB shows `crosshairs-gps` only while a non-terminal booking exists.
- [ ] Hardware back blocked on OpsRoomReview during pending + countdown + paid-hold.
- [ ] Kill app mid-`LIVE` and reopen → resume gate routes straight to LiveTracking.

---

## 7. AGENT (CPO) flow — mobile

Hat: CPO completing onboarding, applying to jobs, getting dispatched, working a mission group, completing, getting paid.

### 7.A — How to log in as **Agent / CPO** (mobile)

| #   | Step                                                                                                                                                            | Expected                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Install the latest staging APK / IPA on the device. Cold-launch.                                                                                                | Splash → role-picker: **Client** · **Agent**.                                                                                                             |
| L2  | Tap **Agent**.                                                                                                                                                  | AgentTypeSelect screen: **CPO** · **Driver** · etc. Tap **CPO**.                                                                                          |
| L3  | New CPO: enter phone (e.g. `+8801812345678`) + create password → **REGISTER**. Existing CPO: tap **I already have an account** → phone + password → **LOG IN**. | Twilio Verify OTP sent to the phone.                                                                                                                      |
| L4  | Enter the 6-digit OTP → **VERIFY**.                                                                                                                             | JWT stored in Keychain. **First-time** registrants land on the 9-screen onboarding wizard; **returning approved CPOs** land directly on `AgentDashboard`. |
| L5  | First-time only: walk through the wizard (see §7.B step 2).                                                                                                     | Routes to `AgentAdminApproval` until ops approves.                                                                                                        |

**If you can't log in:**

- Same Twilio / TTL / phone-already-registered guidance as §6.A.
- If you log in but get stuck on `AgentAdminApproval` for >30s after ops approved you, force-quit + reopen — the dashboard route fires on the next poll.

### 7.B — Agent functional flow (after login)

| #   | Step                                                                                                                                                                                                                                          | Expected                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | After L1–L5, first-time CPOs land on the onboarding wizard.                                                                                                                                                                                   | 9 screens total.                                                                                                                                                                                                                                                             |
| 2   | Walk through the wizard → upload 4 KYC docs (Gov ID, POA, SIA, Police) via DocumentPicker → coverage (countries + services) → availability → upload 6-slot compliance pack (SIA, Passport, Insurance, DBS required; First Aid + CV optional). | Each upload hits `POST /agents/me/upload` (or `…/kyc/:kind/upload`). Files saved under staging auth-service `uploads/{userId}/`. `docs` pipeline step → `in_progress`.                                                                                                       |
| 3   | Land on **AgentAdminApproval** (polls every 3s).                                                                                                                                                                                              | Pipeline pills track ops VIEWs in real time. LIVE dot + "Last updated <ts>" visible.                                                                                                                                                                                         |
| 4   | Wait for ops APPROVE (§5.B step 4).                                                                                                                                                                                                           | Status → `ACTIVE`. App auto-routes to **AgentDashboard** (real name, ON DUTY toggle, Messenger + Intel tiles).                                                                                                                                                               |
| 5   | Open **Job Marketplace**.                                                                                                                                                                                                                     | Live `PUBLISHED` jobs render. Each row has purple **Apply** (bolt).                                                                                                                                                                                                          |
| 6   | Tap **Apply**.                                                                                                                                                                                                                                | Button → green **"Applied · tap to withdraw"**. Backend writes `job_applications.status=PENDING`.                                                                                                                                                                            |
| 7   | Wait for ops to dispatch with you on the team (§5.B steps 7–9).                                                                                                                                                                               | Within 6s, Apply on targeted job → blue **"On Team"** (shield-check). Other applicants see **"Not Selected"** (red).                                                                                                                                                         |
| 8   | Open **Messenger** tab.                                                                                                                                                                                                                       | New conversation `Mission BS-XXXXXXXX` at top. Members: ops admin + you + every dispatched CPO.                                                                                                                                                                              |
| 9   | Tap the conversation. Send a message. Attach a photo via paperclip.                                                                                                                                                                           | Photo encrypts locally (AES-256-CBC), encrypted blob uploads to staging R2, key+IV ride inside sealed envelope. Recipient taps → decrypts client-side. **Verify R2 object raw bytes are unreadable** (Infra can pull the raw object from the staging bucket — looks random). |
| 10  | Set a 30s TTL on a message via composer clock icon.                                                                                                                                                                                           | Bubble shows live countdown `30s / 29s / …`. Auto-removes from both screens at 0s.                                                                                                                                                                                           |
| 11  | Watch presence + typing.                                                                                                                                                                                                                      | Header: `N active` while ops online. `Ranak typing…` lights when peer composes.                                                                                                                                                                                              |
| 12  | Ops triggers `END MISSION → PAYOUT`.                                                                                                                                                                                                          | Within 5s, the mission group **disappears from your Messenger list** (membership row deleted).                                                                                                                                                                               |
| 13  | Open **Bravo System** DM.                                                                                                                                                                                                                     | New `mission_complete` card: route + distance + payout amount + duration. Your audit trail.                                                                                                                                                                                  |
| 14  | Open **Wallet**.                                                                                                                                                                                                                              | Balance up by `floor(total_eur / cpo_count)`. Ledger: `Mission payout · MSN-XXXXXXXX`.                                                                                                                                                                                       |
| 15  | Open **AgentDashboard**.                                                                                                                                                                                                                      | `JOBS COMPLETED` and `DUTY HOURS · MTD` ticked up.                                                                                                                                                                                                                           |
| 16  | **Earnings** → tap the recent payout row.                                                                                                                                                                                                     | Routes to `MissionSummaryScreen`: route map + distance + duration + payout breakdown + deduction reason if any.                                                                                                                                                              |

### Edge — Apply / withdraw / reject

| #   | Step                                                   | Expected                                                 |
| --- | ------------------------------------------------------ | -------------------------------------------------------- |
| C1  | Two agents apply to the same job.                      | Both see green "Applied · tap to withdraw".              |
| C2  | Agent A withdraws.                                     | Button reverts to purple "Apply" on A's feed.            |
| C3  | Ops dispatches Agent B.                                | B's button → blue "On Team". A's row shows slots filled. |
| C4  | A third agent who applied (pending) but wasn't picked. | Their feed shows red **"Not Selected"** (disabled).      |

### Edge — Multi-CPO (`cpo_count > 1`)

| #   | Step                                                                 | Expected                                                                             |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1  | Client makes a 4× CPO booking (region has 12+ free, plenty of room). | Booking flows normally.                                                              |
| D2  | Multiple agents apply. Ops dispatch picker enforces "exactly 4".     | Try with fewer → button stays dimmed, pill yellow. Pick 4 → green, dispatch enabled. |
| D3  | Dispatch → all 4 land in the messenger group with ops as admin.      | All 4 see the group at top of Messenger.                                             |
| D4  | Complete mission.                                                    | Payout splits 4-way, integer remainder rounds to platform fee.                       |

---

## 8. Messenger feature checklist (cross-cutting)

Verified inside §5–§7 above; this is a quick checklist to confirm coverage:

- [ ] 1:1 chat: bubble in <1s, single → double-tick on read, typing dot, presence dot
- [ ] Group chat: same, with `N active` header + per-peer typing fan-out
- [ ] Attachments: encrypted-at-rest in staging R2 (Infra verifies raw object)
- [ ] Disappearing messages: TTL countdown visible, auto-purge on both sides
- [ ] Mission group dissolution on completion:
  - [ ] Agent side: group disappears from list
  - [ ] Ops side: group title gets ` · COMPLETED`, all message history retained
- [ ] System DM: `mission_complete` card delivered to each paid CPO
- [ ] WAL mode + busy_timeout: no `database is locked` red bubbles even on group fan-out

---

## 9. Calling — end-to-end (1 of 2 paths required, both recommended)

Bravo Lite ships two call paths:

- **1:1 voice/video** — peer-to-peer RTCPeerConnection over DTLS-SRTP
- **Group calls (3+ members)** — mediasoup SFU inside staging messenger-service

Both must be verified before sign-off.

### 9.A — 1:1 voice + video (two devices)

Pre-flight: A + B logged in, share a 1:1 / `direct:` conversation, both reachable on the public internet to `relay.94-136-184-52.sslip.io`.

| #   | Step                                                                         | Expected                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device A: open chat with B → tap **phone** icon top-right.                   | Routes to `CallScreen` `state=dialing`. "Calling B…" + cancel.                                                                                                                                                                    |
| 2   | Device B: receives incoming offer over the same WS.                          | Full-screen "Incoming voice call from A" with **ACCEPT** + **DECLINE**.                                                                                                                                                           |
| 3   | B taps ACCEPT.                                                               | Both: `ringing → connecting → connected`. ICE candidates trickle on `call.ice` WS frames. **`verifyDtlsSrtp()` runs**: `getStats()` walks all transports, asserts every `dtlsState === 'connected'` and a non-empty `srtpCipher`. |
| 4   | Check the **AES badge** in the call header.                                  | Renders negotiated cipher, e.g. `AES_CM_128_HMAC_SHA1_80`. **Missing badge = hard fail** (call must not surface media if `verifyDtlsSrtp` failed).                                                                                |
| 5   | Speak into A's mic.                                                          | Audio comes out of B's speaker. Mute toggle silences locally; remote sees muted icon on your tile.                                                                                                                                |
| 6   | Repeat with the **video** icon — both cameras + audio.                       | Both video tracks render. AES badge present. Mute + camera toggle work. Remote camera off → placeholder shows.                                                                                                                    |
| 7   | Either side taps red hangup.                                                 | Both return to chat. Backend emits `call.hangup` to peer. CallsLog screen shows entry with duration + AES cipher.                                                                                                                 |
| 8   | Gesture-minimize the call (swipe down) → navigate elsewhere → tap mini-pill. | Call stays alive in background; tap returns to full CallScreen. Hang up still works.                                                                                                                                              |

### 9.B — Group calls via mediasoup SFU (3 devices)

Pre-flight (run from laptop, using any logged-in user's JWT):

```bash
JWT=<paste from devtools → localStorage or app log>
curl -s -H "Authorization: Bearer $JWT" https://relay.94-136-184-52.sslip.io/sfu/stats
# Expect: {"rooms":0,"participants":0,"workers":N,"restartTotals":0}
# N = os.cpus().length on the staging host
```

Devices A (client) + B (ops) + C (agent), all members of the same `Mission BS-XXXXXXXX` group from §5.B.

| #   | Step                                                                                                                                           | Expected                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Device A: open mission group → tap **phone** icon.                                                                                             | A's app calls `POST /sfu/rooms` (server creates Router on a Worker, returns `roomId`), then `sfu.join`. Server creates send + recv `WebRtcTransport` per A. A's `GroupCallScreen` opens with one tile waiting.                                                                                                   |
| 2   | Devices B + C: open same group → tap **phone**.                                                                                                | Each runs `Device.load(routerRtpCapabilities) → createSendTransport → produce(audio,video) → consume(<every existing producer>) → consumer.resume`. Three tiles light up on all three.                                                                                                                           |
| 3   | Each member hears the other two and sees their video.                                                                                          | Adaptive grid 1 → 2 → 3 cols. Local PiP. Mute / video / hangup / invite buttons live. **Verify**: `curl -H "Authorization: Bearer $JWT" https://relay.94-136-184-52.sslip.io/sfu/stats` → `{"rooms":1,"participants":3}`.                                                                                        |
| 4   | B mutes the mic.                                                                                                                               | B's producer pauses. A + C see muted icon on B's tile within ~500ms via `sfu.consumer.resume`.                                                                                                                                                                                                                   |
| 5   | C taps hangup.                                                                                                                                 | `sfu.leave` fires. Server tears down C's transports + producers. A + B see C's tile drop (`sfu.participant.left` fan-out). Room continues with 2.                                                                                                                                                                |
| 6   | A taps hangup.                                                                                                                                 | Same teardown. Last member leaves → server auto-closes Router. `/sfu/stats` → `{"rooms":0,"participants":0}`.                                                                                                                                                                                                    |
| 7   | **Worker death recovery** (Infra only — not part of normal SQA pass): Infra kills a mediasoup Worker on the staging host while a call is live. | Server's `SfuWorkerPool` sees `worker.died` → exponential backoff restart (1s → 2s → 4s → … capped 30s, max 3 restarts per slot per 5-min window). `restartTotals` increments in `/sfu/stats`. Active call tiles drop (Workers don't migrate live connections); members see `sfu.error` and return to dashboard. |

### 9.C — Wire smoke (no devices, laptop only)

Infra-owned smoke test of the staging wire shapes. SQA does not need to run this unless explicitly asked.

---

## 10. Known caveats (not bugs — do not file)

- **LiveTracking telemetry is simulated** (8s/step interpolation between booking coords). Real per-CPO GPS push is on the roadmap.
- **Push notifications**: dispatch / new application / mission close events are poll-based today. iOS/Android FCM not yet wired. Don't expect background notifications.
- **iOS simulator camera**: `react-native-webrtc` cannot bind the camera in iOS sim. Use a real iPhone for video.
- **Agora 1:1 fallback**: `/agora/token` endpoint not yet implemented. NAT-traversal-failure tests should be deferred or run on Wi-Fi.
- **Group calls require UDP 49160–49200 reachability** (plus TURN 3478 / TURNS 5349) to `94.136.184.52`. Carrier-grade NAT (some 4G networks) will fail the media plane; TURN-over-TCP (3478/tcp) and TURNS (5349) are the fallbacks. Switch to Wi-Fi if calls don't connect.
- **Wire format is a hard cut**: pre-deploy envelopes (old `{ciphertext, senderAddressHint}` shape) will fail to unwrap on the current client. Infra drains the relay between deploys.
- **Finance / Analytics ops pages** are placeholders ("backend pending"). Empty states only — do not file as missing data.
- **Password reset** is not yet wired on staging. If you lock yourself out, ask Ranak to clear the auth row.

---

## 11. Bug report template

When something fails, file with:

1. **Role + step** from the tables above (e.g. "§6.B CLIENT step 8").
2. **What happened** vs. **what you expected**.
3. **Logs**:
   - Device RN log: `adb logcat | grep -i bravo` (Android) / Xcode console (iOS)
   - Ops console browser DevTools console + Network tab
   - For backend-side issues: Infra pulls `docker compose logs -f messenger-service` / auth-service logs on the staging EC2.
4. **Reproducibility**: 1× / sometimes / always
5. **Affected platforms**: Android only? iOS only? Both? Web ops console?
6. **Screenshots / screen-recordings** for any UI-visible defect.
7. **Account context**: which phone number you logged in with, which role, approximate UTC timestamp (so Infra can grep logs).
8. **Mission / booking ID** if applicable (visible in the ops console URL `/live/<id>` or app log).

---

## 12. Sign-off checklist

A full pass is complete when every box is ticked:

### Setup

- [ ] Staging endpoints all green per §3 (`auth/health` 200, `sfu/stats` 401, `ops/login` 200)
- [ ] Latest `apk:staging` build installed on every test phone

### Login (per role)

- [ ] Ops admin: §5.A steps L1–L5 — landed on `/dashboard`
- [ ] Client: §6.A steps L1–L5 — landed on Secure tab
- [ ] Agent (CPO): §7.A steps L1–L5 — landed on onboarding wizard (new) or `AgentDashboard` (returning)

### Ops (§5.B)

- [ ] Steps 1–16 all green
- [ ] Approve flow updates agent within 3s
- [ ] Dispatch picker enforces exact `cpo_count`
- [ ] Mission group title gets `· COMPLETED` suffix and retains history

### Client (§6.B)

- [ ] Steps 1–14 all green
- [ ] Insufficient credits edge (A1–A4)
- [ ] Cancel / reject edge (B1–B2)
- [ ] Resume gate doesn't trap on CANCELLED / COMPLETED

### Agent (§7.B)

- [ ] Steps 1–16 all green
- [ ] Apply / withdraw / reject edge (C1–C4)
- [ ] Multi-CPO mission edge (D1–D4)
- [ ] Attachment uploaded as encrypted blob (Infra-verified)
- [ ] Disappearing message removes from both sides

### Messenger (§8)

- [ ] All 7 checklist items green

### Calling (§9)

- [ ] 1:1 voice + video: AES badge present, mute / hangup / minimize work
- [ ] Group SFU: 3 tiles, mute fan-out, hangup teardown, room auto-close

**When all boxes are ticked, attach this filled checklist to the QA sign-off ticket.**
