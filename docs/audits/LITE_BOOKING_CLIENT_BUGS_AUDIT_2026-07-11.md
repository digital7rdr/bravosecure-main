# Lite CPO Booking — Client-Side Bug Audit (OTP · API · Status)

**Date:** 2026-07-11 · **Branch:** `main` @ `387beab` (v1.0.109 / vc136)
**Scope:** the **CLIENT (principal) side** of the "Lite" auto-dispatch CPO booking flow —
the three founder-reported symptoms:

1. **OTP not showing** on the client interface.
2. **API "sometimes not working"** (intermittent failures).
3. **Client dashboard statuses not updating.**

**Method:** first-hand end-to-end code trace (client screens → `authHttp` interceptor →
`GET /bookings/:id` → mission/booking FSM → verify-code / OTP delivery), corroborated by a
4-stream parallel deep-trace with **adversarial per-finding verification** (10 findings
CONFIRMED at source, 1 REFUTED — noted in §6). **Audit only — no code changed.** Every claim
cites `file:line` in the current tree.

**Companion docs:** `docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md` (2026-07-05
plan; several items here are regressions/gaps _inside_ features it lists as "shipped"),
`docs/audits/TRIAGE_AUDIT_2026-07-11.md` (B-76 CPO-finish token-clear is the **same**
mechanism that bites the client — LB-API1).

---

## 0. Executive summary

The Lite client is **poll-driven with no server push**, and its screens make **inconsistent
decisions about `booking.status` vs `mission_status`**. That one seam — plus a
recently-introduced crew-insert bug — produces all three symptoms:

- The booking FSM **deliberately stays `CONFIRMED`** for the _entire_ mission
  (`DISPATCHED → PICKUP → LIVE`); only `GET /bookings/:id` surfaces the live `mission_status`
  (`booking.service.ts:137,607-612`), and the **list** endpoint never does
  (`toClientBooking` at `:1093-1137` sets no mission field). Screens/steppers that key off
  `booking.status` therefore look **frozen**, and the **verify-guard OTP card** — gated to
  the `DISPATCHED/PICKUP` window — becomes **unreachable** on any path that routes off
  `booking.status`.
- For the **normal auto-dispatch flow the verify-code backend is fine** (a lead with
  `is_lead = TRUE` exists by `DISPATCHED`), so "OTP not showing" there is a **client
  reachability/window** problem (LB-OTP1) plus a **silent-dots amplifier**: the card
  swallows _every_ error into permanent placeholder dots with no error state (LB-OTP2). A
  separate **legacy ops/admin job-board** dispatch path inserts crew without `is_lead`
  (`ops/job-feed.service.ts:291-296`) → verify-code 400s forever for those bookings, which
  the silent-dots card hides (LB-OTP4 — narrow, legacy-only).
- On a **401 / refresh blip / single-device takeover / a 502 during a Contabo auth
  redeploy**, the interceptor **hard-clears both tokens without inspecting the failure**
  (`api.ts:98-101`); no client booking screen classifies session-loss, so the user is
  silently token-wiped mid-flow and _every_ subsequent call 401s — "the API stopped
  working." The live screen runs **3 concurrent poll loops**, widening the refresh-race
  window.
- The **login OTP dev auto-fill is dead**: the client already reads `res.devOtpCode`
  (`LoginScreen.tsx:295`) but the server **never returns it** (`auth.service.ts:266,278`), so
  in QA the code neither auto-fills nor arrives if Twilio can't reach the number.

### Findings table

| ID          | Symptom              | Sev    | Verdict     | One-line                                                                                                                                                                                  |
| ----------- | -------------------- | ------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LB-OTP1** | OTP not showing      | **P0** | CONFIRMED   | Verify-guard card only mounts in the `DISPATCHED/PICKUP` window, which is skipped on resume + on fast pickup→live advance → OTP never shown                                               |
| **LB-OTP2** | OTP not showing      | **P1** | CONFIRMED   | `VerifyGuardCard` swallows _every_ `getVerifyCode` error into permanent placeholder dots (no error/loading distinction) → any upstream blip reads as "OTP never shows"                    |
| **LB-OTP3** | OTP not showing      | **P1** | CONFIRMED   | Login OTP dev-autofill is dead: client reads `res.devOtpCode` but the server never returns it; no SMS autofill; login resend is a dead-end                                                |
| **LB-OTP4** | OTP not showing      | **P2** | CONFIRMED   | **Legacy ops/admin job-board** dispatch inserts crew without `is_lead` (`ops/job-feed.service.ts`) → verify-code 400s forever for those bookings only                                     |
| **LB-API1** | API intermittent     | **P0** | CONFIRMED   | Any refresh failure (network blip / timeout / 502 during auth redeploy / takeover) hard-clears both tokens; no client booking screen routes to re-auth → silent, self-perpetuating logout |
| **LB-API2** | API intermittent     | **P1** | CONFIRMED   | Booking poll errors are swallowed (`catch{}`, dots, `s.error` never rendered) with no reconnecting state → a transient outage looks like a permanently dead screen                        |
| **LB-ST1**  | Status not updating  | **P0** | CONFIRMED   | Home dashboard **polls nothing** (focus-only) and the list carries only the frozen `booking.status` → "Mission in Progress / Confirmed" never advances                                    |
| **LB-ST2**  | Status not updating  | **P1** | CONFIRMED   | `BookingConfirmation` feeds the stepper `mission={undefined}` → frozen at "assigning team" through the whole `DISPATCHED/PICKUP` window; Track button disabled until `LIVE`               |
| **LB-ST3**  | Status not updating  | **P1** | CONFIRMED   | LiveTracking auto-poll **stops** at the 30-min cap — including all terminal navigations — so a mission completing after 30 min never even reaches the completion screen                   |
| **LB-ST4**  | Status not updating  | **P2** | CONFIRMED   | LiveTracking's exponential-backoff is unreachable dead code (`loadActiveBooking` never rejects), so a failing poll hammers every 5 s and never surfaces the error                         |
| ~~LB-API3~~ | ~~API intermittent~~ | —      | **REFUTED** | Double-submit on `/dispatch/request` — the paywall CTA _is_ re-entrancy guarded; not a real defect (see §6)                                                                               |

> **One change fixes most of this.** **Route off `mission_status`, not `booking.status`,
> everywhere, and put `mission_status` on the list DTO** — one `liveTargetFor(booking)`
> helper used by `resumeTargetFor`, `BookingConfirmation`, and Home — which resolves LB-OTP1,
> LB-ST1, and LB-ST2 together. Give the verify card a real error state (LB-OTP2) and set
> `is_lead` on the legacy job-board insert (LB-OTP4) to close the OTP gaps entirely.

---

## 1. How the client watches a booking (reference)

| Client screen                   | Reads                                          | Refresh mechanism                                                                             |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `BookingHomeScreen` (dashboard) | `GET /bookings` **list** — booking status only | **focus only** (`useFocusEffect → loadBookings`, `:115-158`); **no interval**                 |
| `FindingDetailScreen`           | `GET /bookings/:id`                            | poll; routes on `CONFIRMED → AgencyAccepted`                                                  |
| `AgencyAcceptedScreen`          | `GET /bookings/:id`                            | 5 s poll; **auto-advances to LiveTracking the moment `mission_status` appears** (`:56-61`) ✅ |
| `BookingConfirmationScreen`     | `GET /bookings/:id` + team                     | poll; feeds stepper `mission={undefined}` (`:272`); Track gated on `LIVE/SOS` (`:114,180`) ❌ |
| `LiveTrackingScreen`            | `GET /bookings/:id` + telemetry + verify-code  | booking poll (`:216-275`, 30-min cap), telemetry poll, GPS push, WS                           |

**Backend contract.** `booking.service.getById` returns the row **plus** `mission_status`
from the newest non-`ABORTED` mission (`booking.service.ts:596-613`). The **list** endpoint
maps `toClientBooking` (`:1093-1137`) with **no mission field**. The booking FSM stays
`CONFIRMED` through the mission; it flips to `LIVE` only on the lead CPO's go-live. The
verify-code endpoint requires a lead crew row: `mc.is_lead = TRUE AND mc.status <> 'off'`,
else `400 no_crew_assigned` (`booking.service.ts:1155-1164`).

---

## 2. Symptom 1 — "OTP is not showing"

> For the **normal auto-dispatch flow the verify-code backend works** — by `DISPATCHED` a
> lead with `is_lead = TRUE` exists, so `GET /bookings/:id/verify-code` returns 200. So
> "OTP not showing" there is a **client reachability/window** issue (LB-OTP1), amplified by a
> card that **silently shows dots on any failure** (LB-OTP2). LB-OTP4 is a narrow legacy-path
> backend bug.

### LB-OTP1 · Verify card window skipped on resume + fast advance — **P0** · CONFIRMED

**Problem.** The verify code often never appears even for normally-assigned missions.

**Root cause.** The card mounts **only** while the mission is en route/arriving
(`LiveTrackingScreen.tsx:645`, `missionStatus === 'DISPATCHED' || 'PICKUP'`), and the client
only reliably reaches LiveTracking in that window on the pristine foreground path
(`AgencyAccepted` auto-advances on any truthy `mission_status`, `:56-61`). Two ways it's lost:

- **Resume dead-zone:** after a background/kill during `CONFIRMED`,
  `resumeTargetFor('CONFIRMED')` routes to `BookingConfirmation`, not LiveTracking
  (`bookingStatus.ts:65`), and its Track button is gated `LIVE/SOS` only
  (`BookingConfirmationScreen.tsx:114,180`) — so the client can't reach the card during
  `DISPATCHED/PICKUP` at all.
- **Fast-advance race:** the CPO can flip `PICKUP → LIVE` via the waypoint/telemetry path
  (`mission-lead.service.ts:89-95`) between the client's 5 s polls; the first `mission_status`
  the client sees is already `LIVE`, so the card (gated `DISPATCHED/PICKUP`) never mounts —
  and the poll loop only leaves the screen on COMPLETED/CANCELLED/ABORTED, never on `LIVE`.

**Reproduction.** Submit → agency accepts → background the client app → agency assigns crew
(mission `DISPATCHED`) → reopen: resumes onto `BookingConfirmation`, Track greyed, no verify
code for the entire en-route/arrival window.

**Fix (verified better than a naive gate widen).** **Decouple the handover from the transient
`DISPATCHED/PICKUP` states:** keep `VerifyGuardCard` mounted while the mission is not yet
`COMPLETED` **and** the handover hasn't been confirmed (`LiveTrackingScreen.tsx:645`). Combine
with the LB-ST cross-cutting fix (route off `mission_status`) so resume/track paths reach
LiveTracking whenever a mission exists.

**Files to change.**

- `src/screens/liveops/LiveTrackingScreen.tsx` (`:645` render gate)
- `src/screens/booking/bookingStatus.ts` + `BookingConfirmationScreen.tsx` (routing — shared with LB-ST1/ST2)

---

### LB-OTP2 · Verify card swallows every error into permanent silent dots — **P1** · CONFIRMED

**Problem.** When the verify-code fetch fails for _any_ reason, the card shows `· · · · · ·`
forever with no error, no toast, and nothing in logs — indistinguishable from "still
loading." This is the mechanism that turns _any_ upstream blip (LB-OTP4's 400, a 5xx, an auth
blip from LB-API1) into a silent, permanent "OTP not showing."

**Root cause.** `VerifyGuardCard.pull()` does `try { setCode(data.code) } catch { retry in
15s }` — the catch is **empty** (`LiveTrackingScreen.tsx:841-852`); `code` stays `null`, so
the render always paints the placeholder dots (`:880`). There is no tri-state (loading vs
"awaiting crew" 400/404 vs hard error 5xx), no bounded backoff, and no logging.

**Fix.** Give the card an explicit tri-state: loading vs "awaiting crew" (400
`no_crew_assigned`/404) vs error (5xx/network) with a visible "couldn't load your code —
retry" affordance and a bounded backoff; log unexpected statuses. Don't paint the same
placeholder for a hard failure and for loading.

**Files to change.** `src/screens/liveops/LiveTrackingScreen.tsx` (`:838-856`).

---

### LB-OTP3 · Login OTP dev-autofill is dead; no SMS autofill; dead resend — **P1** · CONFIRMED

**Problem.** On login the OTP code never appears on the QA device, so the tester can't get
past the OTP screen.

**Root cause.** The client already has a dev auto-fill hook — `LoginScreen.tsx:295` acts on
`res.devOtpCode` — but the **server never returns it**: `auth.service.ts:266` (invalid-cred)
and `:278` (success) return only `{userId, otpSentTo}`, and `auth.controller.ts:161-162`
passes that through verbatim. `api.ts:236` types `devOtpCode?` optional but nothing populates
it, so every login is forced to OTP entry (`:303`). Meanwhile `OtpService.send` for
`devReturnCode` just returns without surfacing the code (`otp.service.ts:27-30`), and the OTP
screen itself has **no SMS autofill** (only numpad + clipboard, `OTPVerificationScreen.tsx:176-185`).
In production it depends on Twilio Verify actually reaching the number
(`otp.service.ts:36-58`, `TWILIO_VERIFY_SID` at `configuration.ts:56`). The **login** resend
is a dead-end (alert to "go back and sign in again", `OTPVerificationScreen.tsx:237-248`).

**Fix.** (a) In dev modes, have the server return `devOtpCode` on the login/register response
(gate on `devBypass`/`devReturnCode`) so the existing client autofill lights up. (b) Add
Android **SMS Retriever/User-Consent** autofill for production. (c) Add a real
`POST /auth/resend-otp` and wire the login resend to it. (d) Confirm the staging OTP mode.

**Files to change.**

- `apps/auth-service/src/auth/auth.service.ts` (`:266,278` — include `devOtpCode` in dev) + `auth.controller.ts` (+ `resend-otp`) **(deploy)**
- `src/screens/auth/OTPVerificationScreen.tsx` (SMS autofill; wire resend), `src/screens/auth/LoginScreen.tsx` (already reads `devOtpCode`), `src/services/api.ts` (`:236` type)
- staging env / `configuration.ts` (`TWILIO_VERIFY_SID` or `OTP_DEV_RETURN_CODE`)

---

### LB-OTP4 · Legacy ops/admin job-board dispatch omits `is_lead` → verify-code 400s forever — **P2** · CONFIRMED

**Problem.** Bookings crewed via the **legacy ops-console admin job-board** (not the primary
auto-dispatch or marketplace-then-assign flows) can never show the client a verify code.

**Root cause.** `JobFeedService.dispatch` inserts crew with
`INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign)` — it **omits
`is_lead`** (`apps/auth-service/src/ops/job-feed.service.ts:291-296`), which then defaults
FALSE (`migration 20260428100000:12`, `is_lead BOOLEAN NOT NULL DEFAULT FALSE`; no trigger
derives it from the `role='LEAD'` TEXT column). The verify-code lookup requires
`mc.is_lead = TRUE` (`booking.service.ts:1160`) → permanent `400 no_crew_assigned`, hidden by
LB-OTP2's silent dots. **Scope is narrow:** this is an admin/ops-only endpoint
(`ops.controller.ts:295`); the primary auto-dispatch (`org-mission.service.ts:428-431`) and
`ops.service.ts:1010` both set `is_lead` correctly.

**Fix.** Add `is_lead` (and `team_idx`) to the job-feed INSERT so slot 0 is the lead
(mirror `assignCrew`); optionally a `role='LEAD'` fallback in the verify-code lookup; backfill
any already-dispatched job-board `mission_crew` rows. **Keep the server `mc.is_lead = TRUE`
identity gate intact — fix the writer, not the check.**

**Files to change.**

- `apps/auth-service/src/ops/job-feed.service.ts` (`:291-296`) **(deploy)**
- optional: `apps/auth-service/src/booking/booking.service.ts` (`:1155-1164` fallback) + backfill migration

---

## 3. Symptom 2 — "Sometimes the API is not working"

### LB-API1 · Any refresh failure hard-clears both tokens → silent, self-perpetuating logout — **P0** · CONFIRMED

**Problem.** Intermittently, client calls start failing and the app behaves as if the whole
API is down (or it bounces to login) with no clear reason.

**Root cause.** On a 401 the interceptor refreshes + replays once; if the refresh **throws
for any reason** it runs `AsyncStorage.multiRemove(['auth:access_token','auth:refresh_token'])`
(`api.ts:98-101`) — it only logs the message and **never inspects the status**, so a network
blip, the 15 s refresh timeout (`:37`), or a **502 during a Contabo auth redeploy** is treated
exactly like a genuine `invalid_refresh` and destroys a still-valid refresh token. Then
`refreshAccessToken` throws `'No refresh token'` on every subsequent call (`:33-34`) →
re-wipes → **self-perpetuating**; the request interceptor sends no Authorization header
(`:21-26`) so everything 401s. Crucially it **does not mutate Zustand auth state**, so
`RootNavigator` keeps the user on the booking screen with no tokens rather than showing a
login. And **no client booking screen consumes `isAuthLostError`** — its only importer is the
CPO screen `AssignedMissionDetailScreen.tsx:18,122` — so the raw 401 surfaces as a generic
error or a frozen poll.

Triggers that make it "sometimes": single-device takeover on multi-device same-account QA
(`auth.service.ts:109-121` revokes the other device's jti + refresh row), one-strike refresh
rotation + 15-min TTL (`:91`), and auth-redeploy 502s. The live screen's **3 concurrent poll
loops** (booking `:216-275`, telemetry, GPS push) widen the race and the blast radius.

**Reproduction.** Start a booking on client device A → sign into the **same** client account
on device B (or push an auth redeploy) → A's next poll 401s → refresh fails → tokens wiped →
screen errors / silently stuck.

**Fix.**

1. In `api.ts:98-101`, only clear tokens on a genuine auth failure (a 401/`token_revoked` on
   `/auth/refresh`), **not** on a network/timeout/5xx error — retry those instead.
2. Wire `isAuthLostError(e)` into the booking screens' catch blocks → route to a clean
   re-auth banner (the B-76 pattern) and flip Zustand auth state so `RootNavigator` reacts.
3. Server: a short refresh **reuse-grace window** so one lost response doesn't dead-end.

**Files to change.**

- `src/services/api.ts` (`:98-101` — classify before clearing)
- `src/services/authError.ts` (exists) wired into `FindingDetailScreen`, `AgencyAcceptedScreen`, `BookingConfirmationScreen`, `LiveTrackingScreen`
- `apps/auth-service/src/auth/auth.service.ts` (refresh reuse-grace) **(deploy)**

---

### LB-API2 · Swallowed poll errors → a transient outage looks like a dead screen — **P1** · CONFIRMED

**Problem.** When the API blips, the client shows a frozen "Finding your detail…" / "Awaiting
team…" / verify-code dots with no indication anything is wrong.

**Root cause.** Poll loops swallow errors with no visible state:
`FindingDetailScreen.tsx:56` (`catch { /* transient */ }`), `AgencyAcceptedScreen.tsx:71`,
`BookingConfirmationScreen.tsx:80,207` (`.catch(() => undefined)`), verify card
`LiveTrackingScreen.tsx:849-851` (empty catch → dots), and `loadActiveBooking` sets
`s.error` (`bookingStore.ts:128`) that LiveTracking never renders. A persistent 4xx/5xx is
indistinguishable from "still loading" (and compounds LB-OTP1 and LB-API1).

**Fix.** Adopt the tracker's stale/reconnecting pill (`AgentLiveTrackerScreen.tsx`): after N
consecutive failures show a "reconnecting… / couldn't reach Bravo — retry" affordance; keep
the silent retry, add the visible state; render `bookingStore.error`.

**Files to change.** `FindingDetailScreen.tsx`, `AgencyAcceptedScreen.tsx`,
`BookingConfirmationScreen.tsx`, `LiveTrackingScreen.tsx`.

---

## 4. Symptom 3 — "Dashboard statuses are not updating"

### LB-ST1 · Home dashboard polls nothing and only sees the frozen `booking.status` — **P0** · CONFIRMED

**Problem.** On the client Home/dashboard, an in-progress booking shows "Mission in
Progress / Confirmed" and never advances while the guard dispatches, arrives, or goes live.

**Root cause.**

- `BookingHomeScreen` refreshes **only on focus** (`useFocusEffect → loadBookings`,
  `:115-158`) — **no `setInterval` anywhere in the file**; a user sitting on the dashboard
  sees a snapshot from arrival. The row chip and hero pill both read
  `describeStatus(b.status)` (`:336`, `:169`).
- The list endpoint carries only `lite_bookings.status`, which **stays `CONFIRMED` for the
  whole mission** (`booking.service.ts:585-593` → `toClientBooking` `:1093-1137` never sets
  `mission_status`; only `getById` attaches it at `:612`). So even a fresh fetch shows
  `CONFIRMED` the entire time — mission progress is structurally invisible on the dashboard.

**Fix (verified).** Add `mission_status` to the list DTO — join the newest non-`ABORTED`
mission per booking (the exact subquery `getById` uses at `:607-611`) and add
`mission_status` to the client `Booking` type; then poll while an active booking exists and
map mission phases (`DISPATCHED/PICKUP/LIVE`) to live labels in `describeStatus`.

**Files to change.**

- `apps/auth-service/src/booking/booking.service.ts` (`list()` — attach `mission_status`) **(deploy)**
- `src/services/api.ts` (`Booking` type / list shape)
- `src/screens/booking/BookingHomeScreen.tsx` (poll the active booking), `src/screens/booking/bookingStatus.ts` (`describeStatus` mission labels)

---

### LB-ST2 · `BookingConfirmation` stepper is fed `mission={undefined}` → frozen through dispatch — **P1** · CONFIRMED

**Problem.** After a resume during `DISPATCHED/PICKUP`, the client sits on
`BookingConfirmation` with the stepper stuck at "Accepted → assigning team" even though the
team is assigned and en route, Track disabled.

**Root cause.** `BookingConfirmationScreen.tsx:272` literally passes `mission={undefined}`
(with `booking={{status}}`) to `MissionStepper`, so `journeyStep('CONFIRMED', undefined)` hits
`missionJourney.ts:69` → step 2 "assigning team"; the `LIVE/PICKUP/DISPATCHED` steps
(`missionJourney.ts:64-66`) are only reachable when a `mission` arg is supplied. The screen
_fetches_ `mission_status` (`:113`) but never feeds it to the stepper or uses it to advance;
`dispatchedLive` excludes `DISPATCHED/PICKUP` (`:114`). Same seam as LB-OTP1.

**Fix.** Feed the real mission (or `mission_status`) into `MissionStepper`, relabel via
`mission_status`, and auto-route to `LiveTracking` when a mission exists (shared with LB-OTP1
/ LB-ST1 `liveTargetFor`).

**Files to change.** `BookingConfirmationScreen.tsx` (`:113-114,180,272`), `bookingStatus.ts`.

---

### LB-ST3 · LiveTracking poll (and all terminal navigations) die at the 30-min cap — **P1** · CONFIRMED

**Problem.** On a long booking, the live status/telemetry stops updating after 30 minutes —
and worse, a mission that **completes after that cap never routes the client to the completion
screen**.

**Root cause.** At `Date.now() - startedAt > HARD_CAP_MS` (30 min, `:222`) the tick calls
`setPollCapped(true)` and **returns with no reschedule** (`:267-269`), killing the loop. All
terminal `navigation.replace` branches (COMPLETED → `MissionComplete`, CANCELLED →
`TripSummary`, ABORTED / AGENCY_NO_SHOW) live **inside** `tick()` (`:237-266`), so once the
loop stops none can fire; the WS `onStatus` handler (`:360`) only calls `loadActiveBooking`
and never navigates. The user is stranded on a live map with an armed EMERGENCY button until
they hit the manual "tap to retry" banner (`:654-660`).

**Fix.** After the cap, keep polling at a **slow cadence** (the pattern `FindingDetail`
already uses — `SLOW_POLL_MS` after its own cap) so terminal navigations still fire; reserve
the manual banner for a true idle timeout.

**Files to change.** `src/screens/liveops/LiveTrackingScreen.tsx` (`:216-275`).

---

### LB-ST4 · LiveTracking exponential backoff is unreachable dead code — **P2** · CONFIRMED

**Problem / root cause.** The booking poll intends exponential backoff on failure
(`LiveTrackingScreen.tsx:210-214` comment; `:220,226-229`), but `loadActiveBooking` has an
internal try/catch that sets `s.error` and resolves via `finally` — it **never rejects**
(`bookingStore.ts:122-132`). So `await loadActiveBooking; backoff = 5_000` always succeeds and
the `catch { backoff = min(backoff*2, 60_000) }` (`:227-229`) is **unreachable**. Net effect:
a failing poll hammers the server every 5 s indefinitely and the captured `s.error` is never
shown (ties into LB-API2).

**Fix.** Either surface the error from `loadActiveBooking` (return/throw a status) so the
backoff path runs, or delete the dead branch and render `bookingStore.error`.

**Files to change.** `src/screens/liveops/LiveTrackingScreen.tsx`, `src/store/bookingStore.ts`.

---

## 5. The one seam behind LB-OTP1 + LB-ST1 + LB-ST2

The booking FSM stays `CONFIRMED` through the whole mission, and only `getById` exposes the
live `mission_status`, but the client's navigation/display is split between `booking.status`
and `mission_status`:

- `AgencyAccepted` gets it right (routes off `mission_status`, `:56-61`).
- `BookingConfirmation`, `resumeTargetFor`, and Home get it wrong (route/display off
  `booking.status`; the list never carries `mission_status`).

**Recommended single change:** a `liveTargetFor(booking)` helper returning `LiveTracking`
whenever `mission_status ∈ {DISPATCHED,PICKUP,LIVE,SOS}`, used by `resumeTargetFor`,
`BookingConfirmation`, and Home's `goToBooking`; **and** attach `mission_status` to the list
DTO. That removes the OTP dead-zone and the frozen-status perception in one coherent move.

---

## 6. Verification status (adversarial pass)

10 of 11 traced findings were **CONFIRMED** by an independent re-trace at HEAD `387beab`
(LB-OTP1/2/3/4, LB-API1/2, LB-ST1/2/3/4). One candidate was **REFUTED and dropped:**

- ~~`dispatch-request-raw-throttle-and-double-submit`~~ — the double-submit half is **false**:
  every `confirmBooking` caller is re-entrancy-guarded (e.g. `CreditPaywallScreen` CTA
  `disabled={activating}`). Raw 429/throttle _strings_ exist but don't cause the
  "intermittent API" symptom. Left as a P2 copy-polish item only, not a bug.

**Retest matrix (2 client devices + 1 CPO device):**

| Case                                                                        | Today                                                             | After fix                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Background client during `CONFIRMED`, assign crew, reopen                   | BookingConfirmation, Track greyed, **no OTP**                     | resumes into LiveTracking, OTP shown                                   |
| CPO advances PICKUP→LIVE fast (or via waypoint path)                        | client's first observed status is LIVE → verify card never mounts | card stays until handover confirmed                                    |
| Verify-code endpoint returns any non-2xx                                    | permanent silent dots, no error                                   | tri-state: loading / awaiting-crew / retry error                       |
| Booking dispatched via **legacy ops/admin job-board**                       | verify card stuck on dots (400 `no_crew_assigned`)                | code shown; handover works                                             |
| Sit on Home dashboard through dispatch→live                                 | frozen "Mission in Progress"                                      | advances "Searching → Team en route → Protection active"               |
| Same client account signed into a 2nd device mid-booking (or auth redeploy) | 1st device silently token-wiped / errors                          | clear "signed in elsewhere — re-authenticate" prompt; no wipe on a 502 |
| Client login on a Twilio-unreachable number (staging)                       | OTP never appears, resend dead-ends                               | dev code auto-fills / SMS autofilled; working resend                   |
| Long mission > 30 min on LiveTracking                                       | status freezes; completion screen never shown                     | keeps updating; completion still routes                                |

**Deploy note:** LB-OTP3, LB-OTP4, LB-API1 (server half) and LB-ST1 have a server component
requiring a **Contabo `auth-service` redeploy** (rebuild via `docker-compose.staging.yml`;
honor the messenger JWT-drift rule if any auth env changes). LB-OTP1/LB-OTP2/LB-ST2/LB-ST3 are
client-only.

---

## 7. Files-to-change index (by priority)

**P0**

- `src/screens/booking/bookingStatus.ts` + `BookingConfirmationScreen.tsx` — `liveTargetFor` / route off `mission_status` (LB-OTP1, LB-ST2)
- `src/screens/liveops/LiveTrackingScreen.tsx` — keep verify card mounted until handover/COMPLETED (LB-OTP1)
- `src/services/api.ts` — classify refresh failure before clearing tokens (LB-API1); list `mission_status` type (LB-ST1)
- booking screens — wire `isAuthLostError` → re-auth (LB-API1)
- `apps/auth-service/src/booking/booking.service.ts` — attach `mission_status` to `list()` (LB-ST1) **(deploy)**
- `src/screens/booking/BookingHomeScreen.tsx` — poll the active booking (LB-ST1)

**P1**

- `src/screens/liveops/LiveTrackingScreen.tsx` — verify card tri-state / real error state (LB-OTP2); slow-poll after cap (LB-ST3)
- `apps/auth-service/src/auth/{auth.service,auth.controller}.ts` — return `devOtpCode` in dev + `resend-otp` (LB-OTP3) **(deploy)**; refresh reuse-grace (LB-API1)
- `src/screens/auth/OTPVerificationScreen.tsx` (+ `LoginScreen.tsx`, `api.ts`) — SMS autofill / resend (LB-OTP3)
- `FindingDetailScreen.tsx`, `AgencyAcceptedScreen.tsx`, `BookingConfirmationScreen.tsx`, `LiveTrackingScreen.tsx` — reconnecting state (LB-API2)

**P2**

- `apps/auth-service/src/ops/job-feed.service.ts` — set `is_lead` on the legacy job-board insert (LB-OTP4) **(deploy + backfill)**
- `src/screens/liveops/LiveTrackingScreen.tsx` + `src/store/bookingStore.ts` — fix/remove dead backoff, surface `error` (LB-ST4)
- booking submit / `api.ts` — friendly 429 copy (former LB-API3, polish only)

> **Change-safety (per CLAUDE.md):** each fix lands with a direct test + the closest
> regression suite (`npm test -- --selectProjects=booking` for backend; mobile
> `npm run typecheck` ≤ baseline 47), targeted-first then broad, and UI changes get a 2-device
> golden-path + error-path smoke before "done." The `is_lead` insert change is
> security-adjacent to the verify-code identity gate — keep the `mc.is_lead = TRUE` server
> check intact; only fix the _writer_.

---

## 8. Remediation — 2026-07-11 (same day)

All 10 confirmed findings fixed, plus the founder's follow-up bug (**leave the app → get a
push at each step → tap deep-links to that stage**). The `mc.is_lead = TRUE` verify-code
identity gate was left intact — only the writer was fixed.

### Cross-cutting (LB-OTP1 · LB-ST1 · LB-ST2)

- `src/screens/booking/bookingStatus.ts` — `resumeTargetFor` is now mission-aware (3rd arg)
  and a new `liveTargetFor(booking)` routes to `LiveTracking` whenever `mission_status ∈
{DISPATCHED,PICKUP,LIVE,SOS}`, so resume + deep-link land on the live stage instead of the
  `BookingConfirmation` dead-zone.
- `apps/auth-service/src/booking/booking.service.ts` — `list()` now attaches `mission_status`
  (one batched newest-non-ABORTED-mission query), so the dashboard/resume see the live phase.
- `src/screens/booking/BookingHomeScreen.tsx` — polls the active booking on an 8 s cadence
  (was focus-only) and passes `mission_status` to the router.
- `src/screens/booking/BookingConfirmationScreen.tsx` — auto-`replace`s to `LiveTracking` the
  moment a mission appears, and feeds the real `mission_status` into `MissionStepper` (was
  `mission={undefined}` → frozen at "assigning team").

### LiveTracking robustness (LB-OTP2 · LB-API2 · LB-ST3 · LB-ST4)

- `src/store/bookingStore.ts` — `loadActiveBooking` clears `error` on success and returns a
  success boolean (was void, never signalled failure).
- `src/screens/liveops/LiveTrackingScreen.tsx` — verify card kept mounted for the whole active
  mission (closes the fast-advance race) + tri-state (loading / awaiting-crew / error-with-retry)
  instead of silent dots; a "Reconnecting…" banner after 3 consecutive poll misses; the 30-min
  cap now **slows** to 30 s instead of stopping (so a late completion still routes); real
  backoff driven by the success flag; `BravoFont` + a11y on the card.

### Reliability + auth (LB-API1)

- `src/services/api.ts` — the interceptor only clears tokens on a genuine auth failure
  (401/403/no-token on refresh), **not** on a network/timeout/5xx blip; a new `onAuthLost`
  event fires when the session is genuinely lost.
- `src/navigation/MainNavigator.tsx` — subscribes `onAuthLost` → clean `signOut()` (guarded,
  fires once) so the app routes to login instead of sitting tokenless on a booking screen.

### OTP (LB-OTP3 · LB-OTP4)

- `apps/auth-service/src/auth/auth.service.ts` — `login` returns `devOtpCode` under
  `OTP_DEV_BYPASS` (config forces it FALSE in prod) so the client's existing auto-verify
  (`LoginScreen`) lights up and QA isn't stuck on an undeliverable SMS.
- `apps/auth-service/src/ops/job-feed.service.ts` — sets `is_lead` on the lead insert; new
  backfill migration `supabase/migrations/20260711120000_backfill_job_feed_is_lead.sql` repairs
  existing job-board missions.

### Notifications + deep-link (founder follow-up · LM-N2/N4)

- `apps/auth-service/src/ops/booking-push-bridge.service.ts` + `agents/agent.service.ts` — new
  `detail-enroute` / `detail-live` client pushes on pickup + go-live (previously silent), so
  **every** step wakes the client.
- `src/modules/messenger/push/serverWakeNotifications.ts` — wake meta + activity-class for the
  two new kinds.
- `src/modules/messenger/push/fcmBootstrap.ts` — `routeServerWakeTap` now deep-links **directly
  to the exact stage screen** (`LiveTracking`/`MissionComplete`/`NoDetail`/`FindingDetail`/
  `TripSummary`/…) using the hydrated `bookingId`, with cold-start nav-readiness polling — so
  tapping any booking notification (even from a killed app) lands on that stage, not a generic
  Home that `seenRef` could strand.

### Design conformance

Touch-local style fixes applied (verify card `BravoFont` + a11y); the larger palette
consolidation is documented as a follow-up in
`docs/audits/LITE_BOOKING_DESIGN_CONFORMANCE_2026-07-11.md`.

### Gates

Mobile `booking` Jest **144/144** (incl. new `bookingResume.test.ts`), mobile `typecheck`
**≤ 47** baseline (0 net new), `apps/auth-service` build clean. Tests: +1 mobile spec.
**Deploy pending:** Contabo `auth-service` redeploy (LB-OTP3/OTP4/ST1/API1 server halves) +
apply the `is_lead` backfill migration. Device QA per `docs/runbooks/LITE_BOOKING_LOOP.md`
(3-device golden path + notification-tap-from-killed-app).
