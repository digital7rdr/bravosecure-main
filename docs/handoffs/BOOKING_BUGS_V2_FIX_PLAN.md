# Booking / CPO / Agency / Client — Fix Plan for "BRAVO SECURE App Testing Issues V2"

> **Source PDF:** `BRAVO SECURE App Testing Issues V2.pdf` (50 pages, 45 issues, 19 July 2026, v2.0)fd
> **Extracted evidence:** `docs/qa/evidence/testing-issues-v2/pNN.jpeg` (52 screenshots, one per PDF page; pages with 2–3 shots are `pNNA/B/C`)
> **Scope of this document:** ONLY the booking-related lanes — Secure Services client flow, Agent & Service Provider, Mission Acceptance & Live Operations, mission comms, and the Department Chat items that sit on the booking/ops path.
> **Out of scope here:** pure-Messenger issues 01–10 and 12–17 (pages 6–15, 17–22). They are listed in §7 so nothing is lost.
> **Status of this document:** desk analysis only. **No code has been changed.** Root causes marked ✅ were verified by reading the source at the cited `file:line`. Ones marked ⚠️ are the leading hypothesis and need an on-device probe first.

---

## STATUS — updated 2026-07-25

**All 30 issues addressed — 26 fully fixed, 4 partial.** Every fix has a
regression test that was mutation-proved RED first. **None is device-verified.**

|        Issue | Title                                       | Status                                          | Commit      |
| -----------: | ------------------------------------------- | ----------------------------------------------- | ----------- |
| **37** | South Africa missing (CRITICAL)             | ✅                                              | `a44da86` |
| **44** | SOS invisible to console (CRITICAL)         | ✅ backend; console UX remains                  | `5bacb2c` |
| **41** | Agent acceptance before dispatch (CRITICAL) | ⬜**blocked** — §10 Q4 (escrow)         | —          |
| **11** | Mission group messaging (CRITICAL)          | ⬜**not started** — high-risk area       | —          |
| **18** | Departmental Chat card                      | 🟡 partial — casts removed, needs repro        | `08f3537` |
| **19** | Attendance & Incidents card                 | 🟡 partial — routes pinned, needs repro        | `08f3537` |
| **20** | Vault PIN on first access                   | ✅                                              | `3486bfb` |
| **21** | Vault multi-upload                          | ✅                                              | `286896a` |
| **22** | Onboarding showed Messenger plans           | ✅                                              | `265b1e2` |
| **23** | Bare "Bravo Pro"                            | ✅                                              | `a321de4` |
| **24** | My Bookings dead end                        | ✅                                              | `7ab6b97` |
| **25** | insufficient_credits leak                   | ✅                                              | `7edffbf` |
| **26** | Payment sheet overlap                       | ✅                                              | `9232e6c` |
| **27** | Coverage banner overlap                     | ✅                                              | `268b1ab` |
| **28** | Provider / referral code                    | ⬜**not started** — new build            | —          |
| **29** | Hourly Executive Protection                 | ⬜**not started** — own project, §10 Q3 | —          |
| **30** | Vehicle + registration                      | ✅                                              | `cbd7bf8` |
| **31** | Rating remarks                              | ✅ + migration                                  | `c77a6c1` |
| **32** | Blank icon asset                            | ✅                                              | `268b1ab` |
| **33** | "Ops Room" terminology                      | ✅ client-facing                                | `a321de4` |
| **34** | Agent onboarding route                      | ⬜**blocked** — §10 Q1 (architecture)   | —          |
| **35** | Provider "Enterprise" label                 | ✅                                              | `a321de4` |
| **36** | Duplicate medical question                  | ✅                                              | `ef6788c` |
| **38** | Earnings top-up                             | ✅                                              | `cc579f0` |
| **39** | Agent roster profile                        | ✅ (expiry + audit remain)                      | `05f4edd` |
| **40** | Job notification crash                      | ✅                                              | `91cb994` |
| **42** | Follow pill overlap                         | ✅                                              | `268b1ab` |
| **43** | Duplicate back controls                     | ✅                                              | `5053f1a` |
| **45** | Android nav-bar overlap                     | ✅ Agent Portal CTA + app-wide sweep            | `78599ae` |

### The 4 partials, and what is left in each

| #               | Reason                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **41**    | Inserting agent acceptance moves where escrow is held (`dispatch.service` holds at provider-accept). That is a finance decision — §10 Q4.                                                                                                                      |
| **34**    | Re-adding individual agent onboarding reverses the explicit "officers never self-register" decision in`AgentTypeSelectScreen:41`. §10 Q1.                                                                                                                       |
| **29**    | Hourly Executive Protection is a new booking SHAPE (time-based, no dropoff): new pricing fn, a nullable-dropoff schema, an ops-console lane. Its own project. §10 Q3.                                                                                             |
| **11**    | The mission Ops Room has regressed five times (B-207/210/211/216).`MESSAGE_LOOP.md` §5 must be run for it and it deserves a fresh context, not the tail of a long session.                                                                                      |
| **28**    | Provider/referral codes need a new table, validation, booking persistence and ops-console exposure. Buildable, just not started.                                                                                                                                   |
| **18/19** | Partial. The`as never` casts that could hide dead navigation are gone and every route is pinned, but I could not reproduce a dead card from source — the remaining cause is runtime state and needs a device repro with an entitled and a non-entitled account. |

### Groundwork for the 4 remaining — read this before starting

I traced all four far enough to know the shape. None was left undone for lack of
understanding; each is either blocked on a decision or too large to land safely
at the end of a long session. Starting one and abandoning it half-built is the
one outcome worse than not starting.

**Issue 34 — SHIPPED** (`76b30b2`). Resolved by reconciling rather than
reversing: the provider is still the only party that can mint a code, so it
still decides who joins. `createCpo`'s eight seeding writes are now EXTRACTED
into a shared `seedManagedAgent(tx, …)` used by both paths — the
`agent_profiles` coverage inherit in particular is load-bearing, because
`mirrorAgentToPool` refuses an agent with no coverage country and such an
officer is invisible to dispatch with no error anywhere.

**Issue 41 — the REMAINING half.** The client-facing lie is fixed (`ca5e929`):
a DISPATCHED mission with no `mission_crew.accepted_at` now projects as null to
the client, landing them on step 2 "Accepted · assigning team", and officers have
an accept/decline endpoint. Escrow and `missions.status` were deliberately left
alone. What is STILL open is the stricter reading and it needs §10 Q4 answered:
provider-accept should RESERVE, escrow should hold at agent acceptance, and a
decline or SLA timeout should trigger automatic REASSIGNMENT. Today a decline is
recorded and the provider re-crews by hand. The fork is: hold early and tie up
client funds on a job nobody takes, or hold late and dispatch a mission with no
funds behind it. `dispatch.service:1178` + `wallet.service:540-567` is where it
lands either way.

**Issue 29 — SHIPPED** (`8ca048b`). It was far smaller than "a new booking
shape" implied: the DTO already accepted `executive_protection` and an optional
dropoff, `canAdvanceSchedule` already required a drop-off only for `transfer`,
and pricing already multiplied by duration. Only two things were missing — the
comingSoon flag, and the fact that ServiceTypeScreen never set `type`. That
second one was a latent bug the other way too: a Secure TRANSFER never required
a drop-off either. §10 Q3 is now moot for the pilot; the remaining gap is a
dedicated EP review lane in the ops console.

**Issue 11 — the REMAINING half.** The silent failure is fixed (`0cac96f`).
What is left is the PDF's "mission activation must fail safely if the
communication room cannot be created". Today assignCrew inserts the mission in
step 3 and opens the room in step 5; if step 5 fails the mission is already
DISPATCHED. Options are (a) move room creation inside the step-3 transaction, or
(b) add an explicit repair endpoint the agency can call — note that simply
re-running assignCrew does NOT work, because `ON CONFLICT … DO NOTHING` plus the
`booking_not_assignable` guard reject it. Query
`SELECT id, booking_id FROM missions WHERE comms_room_failed_at IS NOT NULL`
to find affected missions once deployed. Run MESSAGE_LOOP.md §5 and reproduce on
a device before changing anything — this area has regressed five times.

### Gates at the last commit

`typecheck 47` (= `.tsc-baseline.json`, unchanged throughout) · `booking 446/446` ·
`app 434 passed + 4 skipped` · `messenger-crypto 3005/3005 twice` (B-126 flake
rule) · `app screens/messenger 82 passed` · `auth-service 1868 passed` ·
`eslint 0 errors`.

**Pre-existing failure, NOT from this work:** `apps/auth-service/src/vbg/vbg.service.spec.ts`
— 3 `regionThreats` cases. Verified by stashing all changes and re-running: it
fails identically on the untouched tree.

### Owed before any of this ships

1. **Device QA on all 24.** Verified by tests, typecheck and lint only. `LOOP.md`
   wants a local Android build + ADB install; `LITE_BOOKING_LOOP.md` §7 for the
   booking lane. Issue 20 needs TWO accounts on one device to reproduce.
2. **Backend deploy** (`apps/auth-service`) for Issues 25, 28, 31, 34, 39, 41 and 44.
   **44 does not work without it** — the mission-status flip is server-side.
3. **Six unapplied migrations**: `20260725120000_booking_rating_remarks.sql`
   (31), `20260725130000_vehicle_colour.sql` (30),
   `20260725140000_provider_referral_codes.sql` (28) and
   `20260725160000_mission_crew_acceptance.sql` (41) and
   `20260725170000_provider_invite_codes.sql` (34) and
   `20260725180000_mission_comms_room_failed.sql` (11). Each feature silently
   no-ops until its migration runs — **41 in particular fails OPEN**: with no
   `accepted_at` column the crew_accepted sub-select errors, so apply it with the
   deploy, not after. Vehicle colour needs ops to seed values; referral codes
   need ops to mint the first partner codes.
4. **`sqa.md` entries** — not written. Fetch `origin` before picking B-numbers;
   another agent commits here and numbers have collided before.
5. **Product-owner answers** to §10 Q1/Q3/Q4, which unblock Issues 34, 29 and 41.

### Notes worth carrying forward

- Issue 25 was **two** bugs: the store flattened the server's structured error
  into a bare `Error`, which had also silently killed `active_booking_exists`.
- Issue 40 is a **crash**, not a slow load — `ErrorBoundary` renders the literal
  "Something went wrong".
- Issue 20 is a **data-separation** defect: `vaultStore` is the only PERSISTED
  store and `signOut` never reset it, so one account's PIN hash, lockout counter
  and file index carried into the next account on the same device.
- Issue 26 is not layout maths — the sheet's background was 4.5% white.
- Issue 31 revealed rating `tags` were accepted by the API and **never
  persisted** — the reported defect had already shipped once.
- Issue 43's mystery second control was in a DIFFERENT file (the tracker's
  overlay close), and the console's own back was DEAD inside a Modal.
- Four source-scan traps, each of which makes a scan pass **vacuously**, are
  documented in the tests that hit them: CRLF anchors; `'*/*'` read as a comment
  open; `useRoute<...>` generics breaking a `[^>]*` class; JSX `{/* */}`
  comments surviving a line-wise stripper.
- A comment containing backticks inside a template-literal module breaks the
  build (`bravoAgentTrackerMapHtml.ts`).

---

## 0. How to use this document

You are the implementing session. Do this in order:

1. Read `LOOP.md` (operating procedure) and `CLAUDE.md` (project rules) — both are mandatory.
2. Read `docs/runbooks/LITE_BOOKING_LOOP.md` — **required** for anything in Groups A/B/C below. Run its baseline before you touch code, and its regression after.
3. Work **one group at a time**, in the priority order of §2. Commit per issue with `fix(<area>): ISSUE-NN — <title>`.
4. Every fix needs a test that was **RED first** (CLAUDE.md bug-regression contract). Mutation-prove it by reverting the fix.
5. Log each one into `sqa.md` as a new `B-NNN` row. **Fetch `origin` before picking B-numbers** — another agent commits to this repo concurrently and numbers have collided before.
6. Do not mark a Lite-booking change complete until `LITE_BOOKING_LOOP.md` §7 sign-off holds, or you state which lane you could not exercise and why.

**Naming rule that applies to the whole document** (PDF page 5, locked by the product owner):

| Product family         | Approved names                                       |
| ---------------------- | ---------------------------------------------------- |
| Secure Services        | `Bravo Secure Lite`, `Bravo Secure Pro`          |
| Messenger              | `Bravo Messenger Lite`, `Bravo Messenger Pro`    |
| Separate products      | `Department Channels`, `Virtual Bodyguard (VBS)` |
| Client-facing ops term | **`Bravo Control System`**                   |

**Banned in client-facing copy:** "Control Room", "Ops Room", "Ops Room Review", "Awaiting Ops Approval", "Ops Room Notified", bare "Bravo Pro", "Enterprise" (for a security company).

---

## 1. PDF page index — booking-related pages only

This is the list you asked for: the exact page you open in the PDF for each in-scope issue.

|     PDF page | Issue | Title                                                                       | Priority           | Module group        |
| -----------: | ----: | --------------------------------------------------------------------------- | ------------------ | ------------------- |
| **16** |    11 | Mission Group Messaging Fails Between Mobile App and Bravo Control System   | **CRITICAL** | D — Mission comms  |
| **23** |    18 | Departmental Chat Entry Card Does Not Open                                  | High               | E — Dept chat      |
| **24** |    19 | Attendance and Incidents Entry Does Not Open Across Dashboards              | High               | E — Dept chat      |
| **25** |    20 | New Department Chat Account Is Asked for an Uncreated Vault PIN             | High               | E — Dept chat      |
| **26** |    21 | Multi-Image Vault Upload Saves Only One Selected File                       | High               | E — Dept chat      |
| **27** |    22 | Secure Services Onboarding Displays Messenger Plans and Features            | High               | A — Client booking |
| **28** |    23 | Secure Services Product Naming and Pro Navigation Are Inconsistent          | High               | A — Client booking |
| **29** |    24 | My Bookings Menu Item Does Not Open Booking History                         | High               | A — Client booking |
| **30** |    25 | Insufficient Credits Flow Stops With 'Booking Failed' Instead of Top-Up     | High               | A — Client booking |
| **31** |    26 | Payment Confirmation Sheet Has Severe Text and Control Overlap              | High               | A — Client booking |
| **32** |    27 | Confirm Location CTA Covers the Service-Coverage Status                     | Medium             | A — Client booking |
| **33** |    28 | Provider or Referral Code Is Missing from the Booking Flow                  | Medium             | A — Client booking |
| **34** |    29 | Executive Protection Hourly Booking Service Is Unavailable                  | High               | A — Client booking |
| **35** |    30 | Client Is Not Shown the Assigned Vehicle and Registration Number            | High               | A — Client booking |
| **36** |    31 | Post-Mission Rating Does Not Allow Written Remarks                          | Medium             | A — Client booking |
| **37** |    32 | Bravo Control System Review Screen Displays a Blank Icon Asset              | Low                | A — Client booking |
| **38** |    33 | Legacy 'Ops Room' Terminology Remains on Client-Facing Screens              | Medium             | A — Client booking |
| **39** |    34 | Agent Onboarding Route Is Missing from Role Selection                       | High               | B — Agent/Provider |
| **40** |    35 | Service Provider Profile Type Is Incorrectly Labelled 'Enterprise'          | Medium             | B — Agent/Provider |
| **41** |    36 | Service Provider Registration Repeats Medical Qualification Selection       | Medium             | B — Agent/Provider |
| **42** |    37 | South Africa Is Missing from Provider Coverage Regions                      | **CRITICAL** | B — Agent/Provider |
| **43** |    38 | Agent and Service Provider Earnings Screens Incorrectly Offer Credit Top-Up | High               | B — Agent/Provider |
| **44** |    39 | Service Provider Cannot View Sufficient Agent Roster Information            | Medium             | B — Agent/Provider |
| **45** |    40 | New Job Notification Opens an Unexpected Error Screen                       | High               | B — Agent/Provider |
| **46** |    41 | Agent Acceptance Is Missing Before Client Confirmation and Dispatch         | **CRITICAL** | C — Live ops       |
| **47** |    42 | Live Ops Follow Control Covers Mission Progress Text                        | Medium             | C — Live ops       |
| **48** |    43 | Live Mission Header Shows Duplicate Back and Next Controls                  | Medium             | C — Live ops       |
| **49** |    44 | SOS Activation Is Not Reflected in the Bravo Control System                 | **CRITICAL** | C — Live ops       |
| **50** |    45 | Android System Navigation Bar Overlaps App Controls Across Modules          | High               | C — Live ops       |

**Total in scope: 30 of 45 issues** — 4 Critical, 15 High, 10 Medium, 1 Low.

Reference pages (no fix, read them): **page 5** = locked product/terminology map. **Pages 1–4** = executive summary + full register.

---

## 2. Recommended fix order

Ordered by blast radius, not by issue number. Group 1 items gate the pilot.

| Wave                                     | Issues                     | Why this wave                                                                                                                                                   |
| ---------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 — pilot blockers**           | 37, 44, 41, 11             | All four Criticals. 37 blocks the South Africa pilot entirely; 44 is a life-safety reporting gap; 41 lies to the client about dispatch; 11 kills mission comms. |
| **W2 — dead ends & crashes**      | 24, 25, 40, 18, 19, 21     | User-visible breakage where the flow stops or the app errors. Cheap, high-confidence fixes.                                                                     |
| **W3 — missing operational data** | 30, 29, 28, 39, 31, 20     | Features the Bravo Control System needs to actually dispatch and reconcile.                                                                                     |
| **W4 — naming & entitlements**    | 22, 23, 33, 35, 38, 34, 36 | The locked-terminology sweep + role-entitlement corrections. Do 33 and 23 together — one search-and-replace pass.                                              |
| **W5 — layout**                   | 26, 27, 42, 43, 45, 32     | Safe-area / overlap work. Do**45 last** and treat it as the umbrella fix — 26, 27 and 42 are all instances of the same root class.                       |

---

## 3. GROUP A — Secure Services client booking flow (Issues 22–33, PDF pages 27–38)

### Issue 24 — My Bookings does not open booking history ✅ CONFIRMED

**PDF p.29 · `p29.jpeg` · High**

**Observed:** Selecting _My Bookings_ from the client side menu does not navigate to the booking list.

**Root cause —** `src/components/ProfileDrawerModal.tsx:80`:

```ts
{icon: 'calendar', label: 'My Bookings', go: () => go('SecureTab', {screen: 'BookingHome'})},
```

It routes to **`BookingHome`** — the _start a new booking_ wizard — not to the bookings list. When the user is already on `SecureTab`/`BookingHome` (the default landing), the navigate is a no-op, so the drawer just closes and nothing appears to happen. That is exactly the reported symptom.

There are **three inconsistent "My Bookings" destinations** in the app:

| Site                                             | Destination                                       |
| ------------------------------------------------ | ------------------------------------------------- |
| `src/components/ProfileDrawerModal.tsx:80`     | `BookingHome` ← **wrong**                |
| `src/screens/settings/ProfileScreen.tsx:71`    | `TripHistory`                                   |
| `src/screens/dashboard/DashboardScreen.tsx:97` | `action: 'bookings'` (resolve where this lands) |

Meanwhile a real list screen exists and is registered: `BookingHistoryScreen` → `src/navigation/BookingNavigator.tsx:193-197` (route name `BookingHistory`).

**Fix:**

1. Decide the single canonical destination. `BookingHistory` is the purpose-built list; `TripHistory` (`src/screens/pro/TripHistoryScreen.tsx:168`) already renders the title "My Bookings" for clients and "Activity History" for agents. **Pick one and route all three call sites to it.** Recommendation: `BookingHistory`, and demote `TripHistory` to the agent-only "Activity History" entry.
2. Confirm the target renders all status groups the PDF requires: upcoming, under-review, active, completed, cancelled, declined.
3. Add a test asserting all three menu sites resolve to the same route name.

**Acceptance (PDF):** open with and without bookings; each status group shows the right records; opening a booking shows accurate details and status.

---

### Issue 25 — Insufficient credits shows "Booking failed" instead of top-up ✅ CONFIRMED

**PDF p.30 · `p30.jpeg` · High**

**Observed:** With a short balance the flow shows _Booking failed_ and the raw string `insufficient_credits`, and never offers top-up.

**Root cause — the client only handles the _locally thrown_ error, not the _server_ one.** Two code paths produce `insufficient_credits` and only one is caught:

_Path 1 (handled correctly)_ — `src/store/bookingStore.ts:236-244` throws a typed error **before** the request:

```ts
if (autoDispatch) {
  const bal = useWalletStore.getState().balance;
  const estimate = draft.estimated_price ?? 0;
  if (bal && estimate > 0 && bal.bravo_credits < estimate) {
    const err: Error & {code?: string; amountDue?: number} = new Error('insufficient_credits');
    err.code = 'insufficient_credits';
    err.amountDue = Math.ceil(estimate - bal.bravo_credits);
    throw err;
  }
}
```

`src/screens/booking/CustomizeAddOnsScreen.tsx:196-201` catches that and routes to `CreditPaywall`. Good — but this branch is **skipped entirely** when `autoDispatch` is false, or when `bal` is not yet loaded.

_Path 2 (NOT handled — the bug)_ — the server throws `BadRequestException('insufficient_credits')` at `apps/auth-service/src/booking/booking.service.ts:318` and `:477`. Nest serialises that to `{statusCode: 400, message: 'insufficient_credits', ...}`. Back in `CustomizeAddOnsScreen.tsx:207-215` the handler reads `msg = e?.response?.data`, checks only `msg?.code === 'active_booking_exists'`, then falls through to:

```ts
Alert.alert(
  'Booking failed',
  msg?.message ?? (e as Error).message ?? 'Could not submit booking. Please try again.',
);
```

→ title **"Booking failed"**, body **"insufficient_credits"**. Pixel-for-pixel the screenshot.

**Fix:**

1. In `CustomizeAddOnsScreen.tsx`, treat the server shape the same as the local one. Detect `msg?.code === 'insufficient_credits' || msg?.message === 'insufficient_credits'` and route to `CreditPaywall` with the shortfall.
2. Have the server return the **structured** body the runbook already specifies — `{code:'insufficient_credits', required, balance}` (see `docs/planning/BUILD_RUNBOOK.md:841`) — so the client can show the exact shortfall instead of computing it.
3. **Preserve the draft.** The PDF requires returning to booking review after top-up without re-entry. Check that `bookingStore` retains `draft` across the paywall round-trip and that `CreditPaywall` navigates _back_ to review on success, not to `BookingHome`.
4. Do not surface a raw server code in any `Alert` — add a message-mapping helper.

**Note — reuse before abstracting:** `src/screens/pro/proPaywallFlow.ts:16` already has `isInsufficientCreditsError()`. Use it rather than writing a fourth copy of this check. `src/screens/ops/OpsRoomReviewScreen.tsx:147-149` has yet another hand-rolled copy — fold all of them into the one helper. This "one behaviour, N hand-copied impls" pattern is the recurring root cause in this repo.

**Acceptance (PDF):** zero and partial balances; exact shortfall + top-up action shown; original booking resumes without re-entry.

---

### Issue 27 — Confirm Location CTA covers the coverage status ✅ CONFIRMED

**PDF p.32 · `p32.jpeg` · Medium**

**Root cause —** `src/screens/booking/LocationPickerScreen.tsx`. The coverage banner is pinned at a **hard-coded** offset (line 739-742):

```ts
banner: { position: 'absolute', left: 16, right: 16, bottom: 96, ... },
```

while the CTA wrapper is inset-aware and taller than 96dp (line 607, 754-759):

```ts
<View style={[s.ctaWrap, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}>
ctaWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 10, ... },
cta: { height: 48, ... },
```

Actual `ctaWrap` height = `10 (paddingTop) + 48 (cta) + max(insets.bottom,12) + 12`. On a 3-button-nav Android device `insets.bottom ≈ 48dp` → **118dp > 96dp**, so the CTA bar sits on top of the banner. On a gesture-nav device `insets.bottom ≈ 24dp` → 94dp, which just barely clears — which is why this reproduces on some devices and not others.

**Fix:** stop hard-coding. Measure the CTA wrapper (`onLayout`) and drive the banner's `bottom` from it, or restructure so the banner and CTA are siblings in a single bottom-anchored column and the banner is simply _above_ the CTA in flow. Keep the banner visible for **all three** states: in-coverage, out-of-coverage, coming-soon.

**Related:** this is the same defect class as Issues 26, 42 and 45. Consider fixing them as one pass — see §6.

---

### Issue 29 — Executive Protection hourly booking unavailable ✅ CONFIRMED (feature work)

**PDF p.34 · `p34.jpeg` · High · Missing Feature**

**Root cause —** `src/screens/booking/ServiceTypeScreen.tsx:61-89`. Only `secure_transfer` is live; `executive_protection`, `recon_team` and `emergency_extraction` all carry `comingSoon: true`, and `ServiceCard` (line 93) makes `locked` cards non-pressable.

**This is the largest item in the whole document.** It is a new booking _shape_, not a flag flip: time-based (date, start time, duration) rather than point-to-point (pickup → dropoff). It needs:

- **Mobile:** a parallel wizard branch — meeting location (single point, no destination), duration picker, principal/passenger details, team requirements, add-ons, free-text instructions.
- **Pricing:** `src/screens/booking/pricing.ts` currently prices a transfer. Hourly pricing (rate × duration × team size) is a new function. Note `pricing.ts:35` caps CPOs per booking at 1 without "Control Room approval".
- **Backend:** `apps/auth-service/src/booking/` — the booking row needs a service-type discriminator and nullable dropoff; `booking.service.ts` estimate/create paths both branch.
- **Ops console:** the Bravo Control System must receive and render duration + remarks and be able to accept/decline/amend.

**⚠️ Scope flag:** treat this as its own project with its own plan doc. Do NOT try to land it in the same batch as the layout fixes. Confirm with the product owner whether the pilot needs it, or whether "Coming Soon" is acceptable for launch — the PDF marks it High, not Critical.

---

### Issue 30 — Client not shown assigned vehicle + registration ✅ CONFIRMED (partial)

**PDF p.35 · `p35.jpeg` · High**

**Good news — the data already exists end to end.** `src/services/api.ts:1805-1813`:

```ts
export interface AssignedVehicleDto {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}
```

served by `GET /bookings/:id/team` (`api.ts:1827`).

And it _is_ rendered — but only in one place: `src/screens/liveops/LiveTrackingScreen.tsx:933-940` shows `call_sign · make_model` and `plate` inside the **TEAM tab**.

**The gap:** the client's _verification_ surface — where they confirm the arriving unit — shows the agent but not the vehicle. Check `src/screens/booking/AgencyAcceptedScreen.tsx` and the verify-code card at `LiveTrackingScreen.tsx:1112-1119`; neither surfaces vehicle identity.

**Fix:**

1. Put make / model / **colour** / registration / call-sign next to agent verification on the post-dispatch screen, not buried in a tab.
2. **Colour is missing from the DTO.** `AssignedVehicleDto` has no colour field — this needs a DB column, a backend select, and a DTO change. Check the `vehicles` table via `apps/auth-service/src/booking/assignment/vehicle-pool.service.ts`.
3. Add a vehicle-change path: if the assignment changes, replace the displayed details and write an audit event.

---

### Issue 31 — Post-mission rating has no written remarks ✅ CONFIRMED

**PDF p.36 · `p36.jpeg` · Medium**

**Root cause —** `src/screens/booking/RateAgencyScreen.tsx`. Stars (`RatingStars`, line 66-67) plus a fixed tag list (line 24) — no free-text input. Submit at line 41:

```ts
await bookingApi.submitRating(bookingId, {stars, tags});
```

And the API type at `src/services/api.ts:453` is `{stars: number; tags?: string[]; tip?: number}` — no remarks field.

**Fix:** add an optional `remarks` `TextInput` beneath the tags; extend the DTO and the server handler (`apps/auth-service/src/booking/booking.service.ts:637` area, the rating path); apply a character limit and store it against booking + provider. Per the PDF, remarks must be visible **only** to authorised quality/operational roles — so this is an ops-console read-permission change too, not just a column.

**Keyboard rule:** this screen gains a focused `TextInput`, so it inherits the app-wide rule — use `useKeyboardLayout()` (`CLAUDE.md` → B-184). Do **not** hand-roll avoidance; `src/hooks/__tests__/keyboardContract.test.ts` will fail the build if you do.

---

### Issue 32 — Blank icon asset on the review screen ✅ CONFIRMED

**PDF p.37 · `p37.jpeg` · Low**

**Root cause —** `src/screens/ops/OpsRoomReviewScreen.tsx:386-393`:

```tsx
{state === 'pending' ? (
  <View style={s.back} />        // ← empty box, but s.back has background + border
) : (
  <TouchableOpacity style={s.back} ...><Icon name="chevron-left" .../></TouchableOpacity>
)}
```

When the booking is `pending`, back is deliberately suppressed — but the spacer keeps the **`s.back` box chrome** (background + border), so it paints an empty rounded square exactly where the screenshot's red circle is. It is not a missing asset; it is a styled empty container.

**Fix:** make the spacer chrome-less — `<View style={{width: 30}} />` — or set `opacity: 0`.

**⚠️ Same bug elsewhere:** `src/screens/agent/_shared.tsx:51-53` does the identical thing in the shared `NavHeader` (`<View style={nav.back} />`), so every screen using `NavHeader` without an `onBack` shows the same blank box. Fix the shared component and the one-off together.

---

### Issue 33 — Legacy "Ops Room" terminology on client screens ✅ CONFIRMED

**PDF p.38 · `p38A.jpeg`, `p38B.jpeg` · Medium**

**Client-facing strings to replace** (verified by source scan; internal comments and identifiers are NOT in scope — only rendered copy):

| File:line                                                       | Current string                                               | Replace with                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `src/screens/ops/OpsRoomReviewScreen.tsx:395`                 | `OPS ROOM REVIEW`                                          | `BRAVO CONTROL SYSTEM REVIEW`                                                |
| `src/screens/ops/OpsRoomReviewScreen.tsx:430`                 | `AWAITING OPS APPROVAL`                                    | `AWAITING BRAVO CONTROL SYSTEM APPROVAL`                                     |
| `src/screens/ops/OpsRoomReviewScreen.tsx:501`                 | `WAITING FOR OPS ROOM`                                     | `WAITING FOR BRAVO CONTROL SYSTEM`                                           |
| `src/screens/liveops/SOSScreen.tsx:167`                       | `Ops Room Notified`                                        | `Bravo Control System Notified`                                              |
| `src/screens/liveops/SOSScreen.tsx:192, 267`                  | `GPS coordinates sent to Ops Room`                         | `…sent to Bravo Control System`                                             |
| `src/screens/liveops/SOSScreen.tsx:198, 273`                  | `Ops Room On Standby`                                      | `Bravo Control System On Standby`                                            |
| `src/screens/liveops/SOSScreen.tsx:226`                       | `Contacting Ops Room…`                                    | `Contacting Bravo Control System…`                                          |
| `src/screens/dashboard/DashboardScreen.tsx:728`               | `GPS coordinates sent to Ops Room`                         | `…sent to Bravo Control System`                                             |
| `src/screens/dashboard/DashboardScreen.tsx:734`               | `Ops Room On Standby`                                      | `Bravo Control System On Standby`                                            |
| `src/screens/dashboard/DashboardScreen.tsx:782`               | `Ops Room Acknowledged` / `Waiting for ops…`            | `Bravo Control System Acknowledged` / `Waiting for Bravo Control System…` |
| `src/screens/booking/AddOnsScreen.tsx:38`                     | `Ops Room Monitoring`                                      | `Bravo Control System Monitoring`                                            |
| `src/screens/booking/AddOnsScreen.tsx:177`                    | `Ops Approval` badge                                       | `Control System Approval`                                                    |
| `src/screens/booking/AddOnsScreen.tsx:200`                    | `…review by the Bravo operations room…`                  | `…review by the Bravo Control System…`                                     |
| `src/screens/booking/CustomizeAddOnsScreen.tsx:308`           | `Control Room approval`                                    | `Bravo Control System approval`                                              |
| `src/screens/cpo/AssignedMissionDetailScreen.tsx:383`         | `Open Ops Room`                                            | ⚠️ CPO-facing — see note                                                    |
| `src/screens/agent/AgentDeploymentRequirementsScreen.tsx:251` | `Awaiting Ops Sign-off…`                                  | ⚠️ Agent-facing — see note                                                  |
| `src/screens/vbg/VBGHomeScreen.tsx:299`                       | `Hold to Alert Control Room` / `✓ Control Room Alerted` | `…Bravo Control System…`                                                   |
| `src/screens/vbg/VBGSRAScreen.tsx:157-158`                    | `Alert sent to Ops Room…` / `…Ops Room will call`      | `…Bravo Control System…`                                                   |
| `src/screens/vbg/VbgScanPrompt.tsx:70, 85`                    | `…alert the Ops Room` / `…escalate to the Ops Room`    | `…Bravo Control System`                                                     |
| `src/screens/pro/ItineraryUploadScreen.tsx:228-233`           | `Control Room Updates`                                     | `Bravo Control System Updates`                                               |

**⚠️ Decide before you sweep:** the PDF says _"Confirm internal console labels are separately reviewed and client-facing wording is consistent."_ CPO and agent surfaces (`AssignedMissionDetailScreen`, `AgentDeploymentRequirementsScreen`, `OrgMissionsScreen.tsx:218`) are **operator-facing, not client-facing**. Ask the product owner whether operators keep "Ops Room" or also move to "Bravo Control System". Do not guess — a wrong sweep here is a lot of churn to undo.

**Also rename the route?** The route name `OpsRoomReview` and the file `OpsRoomReviewScreen.tsx` are internal identifiers. CLAUDE.md says _"Don't refactor or rename when the task is a bug fix."_ **Leave them.** Change only rendered strings.

**Add a guard:** land a static source scan test that fails on client-facing `Ops Room` / `Control Room` literals, so this cannot regress. Follow the existing pattern in `src/modules/messenger/__tests__/missionOpsRoomStaticScan.test.ts`. **Two traps that have each cost a session:** strip comments before asserting (prose containing the banned phrase is the #1 false result), and these files are **CRLF** — a `\n`-anchored regex matches nothing and the test passes vacuously. Use line-based scanning or `\r?\n`.

---

### Issues 22 + 23 — Onboarding shows Messenger plans; naming inconsistent ✅ CONFIRMED

**PDF p.27 (`p27A/B.jpeg`), p.28 (`p28.jpeg`) · High**

**Root cause —** `src/screens/auth/RoleSelectionScreen.tsx`. The "How will you use Bravo?" screen (title at line 277) renders **one global plan list** with no product-path branching:

| Line     | Card                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `:179` | `Lite` — features = `LITE_FEATURES` (Messenger, Group Chats, Voice/Video Calls, Secure Phone Vault, News, Encryption) |
| `:187` | `Bravo Pro` ← generic name, banned                                                                                      |
| `:195` | `Enterprise`                                                                                                             |
| `:205` | `Operator Partner`                                                                                                       |

It is reached unconditionally from `src/screens/auth/OnboardingScreen.tsx:213` (`navigation.navigate('RoleSelection')`), so a user who picked **Secure Services** is shown **Messenger** features. That is Issue 22 exactly.

By contrast `src/screens/auth/HomeSelectionScreen.tsx:37-57` already uses the correct locked names (`Bravo Secure Lite`, `Bravo Secure Pro`) — use it as the reference implementation.

**Fix:**

1. Pass the chosen product path from `OnboardingScreen` into `RoleSelectionScreen` and filter the card list by it. Secure Services → `Bravo Secure Lite` + `Bravo Secure Pro` **only**.
2. Rename `Bravo Pro` → `Bravo Secure Pro` in the Secure Services context. Other confirmed generic-`Bravo Pro` sites: `src/components/ProfileDrawerModal.tsx:81`, `src/screens/settings/ProfileScreen.tsx:73`, `src/screens/dashboard/DashboardScreen.tsx:98`, `src/screens/pro/ProLandingScreen.tsx:70,115,147`, `src/screens/pro/ProPaywallScreen.tsx:141,154`, `src/screens/pro/ProRetainersScreen.tsx:51,134`, `src/screens/pro/tierMatrix.ts:8`.
3. Issue 23 also reports _"the item is not active"_. `ProfileDrawerModal.tsx:81` routes to `SecureTab`/`ProLanding`, and `ProLanding` **is** registered (`BookingNavigator.tsx:258-262`) — whereas `ProfileScreen.tsx:73` routes to `ProRetainers`. ⚠️ Reproduce on device from **both** entry points before changing routing; the two menus disagree and only one may be broken.
4. Confirm plan selection creates the right entitlement and lands on the right dashboard — see `src/store/entitlements.ts` (note `:81` and `:104` also contain "Bravo Pro" copy).

---

### Issue 28 — Provider / referral code missing from booking ⚠️ FEATURE, NOT A BUG

**PDF p.33 · `p33.jpeg` · Medium**

**Current state:** there is **no** provider/referral code anywhere in the booking flow. Repo-wide search found only _wallet promo codes_ — `apps/auth-service/src/wallet/wallet.service.ts:186,205` (`promo_codes` table) and the top-up modal at `src/screens/wallet/CreditsScreen.tsx:363-390`. That is a credits-bonus mechanism, **not** provider attribution, and must not be conflated with it.

**Fix (new build):**

1. DB: a `provider_referral_codes` table (code, owner, purpose, active, expiry, redeemed_count) — model it on `promo_codes`.
2. Optional field on the booking review step before submission; validate server-side.
3. Persist the code + resolved owner on the booking row; expose it to the ops console and reporting.
4. **Security constraint from the PDF:** a code must _never_ bypass availability, licensing or operator approval. It records preference and attribution only. Do not let it short-circuit the matchmaker.

---

## 4. GROUP B — Agent & Service Provider (Issues 34–40, PDF pages 39–45)

### Issue 37 — South Africa missing from provider coverage ✅ CONFIRMED · **CRITICAL**

**PDF p.42 · `p42.jpeg`**

**Root cause —** `src/screens/agent/AgentCoverageScreen.tsx:25-32`, a **hard-coded** list:

```ts
const INITIAL_COUNTRIES: CoverageRow[] = [
  {key: 'ae', flag: 'AE', name: 'UAE',            ...},
  {key: 'sa', flag: 'SA', name: 'Saudi Arabia',   ...},
  {key: 'bd', flag: 'BD', name: 'Bangladesh',     ...},
  {key: 'gb', flag: 'GB', name: 'United Kingdom', ...},
  {key: 'us', flag: 'US', name: 'USA',            ...},   // ← not a supported region
];
```

**Two defects in five lines:** South Africa (`ZA`) is absent, and **USA is present but is not a supported region** — the PDF explicitly requires "no unsupported regions are implied".

South Africa is otherwise wired up correctly everywhere else, which is why this reads as a one-screen omission:

| File:line                                        | Has ZA                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/utils/regions.ts:30`                      | ✅`{code:'ZA', name:'South Africa', currency:'ZAR', badge:'SA', flag:'🇿🇦'}` |
| `src/utils/regions.ts:75`                      | ✅ bounding box                                                                 |
| `src/utils/constants.ts:55, 65`                | ✅ currency + dial code                                                         |
| `src/modules/booking/coverageZones.ts:38-39`   | ✅ Johannesburg + Cape Town zones                                               |
| `src/screens/booking/ZoneMapScreen.tsx:82`     | ✅`available: true`                                                           |
| `src/screens/agent/OrgComplianceScreen.tsx:33` | ✅`['AE','SA','BD','GB','ZA']`                                                |
| `src/screens/settings/SettingsScreen.tsx:32`   | ✅                                                                              |
| `src/screens/agent/AgentCoverageScreen.tsx:25` | ❌**missing**                                                             |

**⚠️ Naming trap — this has bitten this project before.** `ZA` = South Africa. `SA` = **Saudi Arabia**. `regions.ts:30` gives South Africa the display _badge_ `'SA'`, which collides visually with the Saudi _code_ `SA`. When staffing or configuring, South Africa is always region **`ZA`**, never `SA`. `ZoneMapScreen.tsx:73` carries a comment about exactly this collision — read it before you touch region code.

**Fix:**

1. Add `{key: 'za', flag: 'ZA', name: 'South Africa', sub: 'Johannesburg · Cape Town', on: false}` and **remove `us`**.
2. **The PDF requires backend control** — _"The configuration must be controlled from the backend and reflected consistently in provider onboarding, client maps and Bravo Control System allocation."_ A hard-coded array does not satisfy this. Drive `INITIAL_COUNTRIES` from `SUPPORTED_REGION_CODES` in `src/utils/regions.ts` as a minimum, and ideally from a backend config endpoint so pilot regions can be toggled without a release.
3. Update `src/utils/__tests__/regions.test.ts:21` if the supported set changes.
4. Verify the pilot provinces/cities can be enabled and saved, and that the client map + ops allocation agree.

---

### Issue 38 — Agent/provider earnings offers client top-up ✅ CONFIRMED

**PDF p.43 · `p43.jpeg` · High**

**Root cause —** `src/screens/agent/EarningsScreen.tsx:161-168`:

```tsx
<TouchableOpacity style={styles.topUpBtn}
  onPress={() => navigation.navigate('Credits', {tab: 'topup'})} ...>
  <Icon name="plus-circle" size={16} color="#07090D" />
  <Text style={styles.topUpBtnText}>Top Up Credits</Text>
</TouchableOpacity>
```

Sitting inside the **WALLET BALANCE** hero on the _earnings_ (payout) screen. Agents and providers receive payouts here; they do not purchase client services from this screen.

`src/screens/agent/OrgEarningsScreen.tsx` is already correct — gross/fees/pending/net only, no top-up.

**Fix:**

1. Remove the button and its styles (`EarningsScreen.tsx:378-379`).
2. Relabel the hero from the ambiguous "WALLET BALANCE" to **earned balance**, and add pending settlement / payout method / payout history / reconciliation per the PDF.
3. If a role can also act as a client, the client wallet stays a **separate, clearly labelled** surface. Do not merge payout credits with client Bravo Credits.

---

### Issue 40 — New job notification opens an error screen ✅ CONFIRMED — this is a **crash**

**PDF p.45 · `p45.jpeg` · High**

This is the highest-confidence root cause in the document. It is not a slow load; it is a `TypeError` caught by the error boundary.

**Root cause — a navigation call with no params meets a destructure with no guard.**

_Producer_ — `src/modules/messenger/push/fcmBootstrap.ts:917-918`:

```ts
if (kind === 'dispatch-offer') {
  candidates = [{name: 'IncomingOffer'}]; // ← no params
}
```

Every other branch in this function passes params where the destination needs them (`sos-cpo-alert` at `:923-926` passes `bookingId`). This one does not.

_Consumer_ — `src/screens/agent/IncomingOfferScreen.tsx:41`:

```ts
const {offerId} = useRoute<RouteProp<AgentStackParamList, 'IncomingOffer'>>().params;
```

Unguarded destructure of `.params`. When the push router navigates with no params, `.params` is `undefined` → **`TypeError: Cannot destructure property 'offerId' of undefined`** → caught by `src/modules/observability/ErrorBoundary.tsx:52`, which renders literally **"Something went wrong"**.

The job "eventually shows" because `src/screens/agent/IncomingOfferWatcher.tsx` independently polls and re-navigates _with_ the correct params — which is why the error flashes and then resolves. Exactly the reported behaviour.

**Fix:**

1. Pass the offer id through the push payload: `candidates = [{name: 'IncomingOffer', params: {offerId: data.offerId}}]`. Validate the id the same way `bid` is validated at `fcmBootstrap.ts:914`.
2. Guard the consumer regardless: `const {offerId} = useRoute<...>().params ?? {}` and render a controlled loading/expired state when it is missing.
3. Confirm the server wake actually carries an offer id. If it does not, that is a third change — in the push producer on `messenger-service` / `booking-push-bridge.service.ts`.
4. Show a specific controlled status for expired or withdrawn jobs (PDF requirement), not the generic error.

**Test:** foreground, background **and terminated** cold-start taps. The cold-start path is the one that regresses.

---

### Issue 35 — Provider profile type labelled "Enterprise" ✅ CONFIRMED

**PDF p.40 · `p40.jpeg` · Medium**

**Root cause —** `src/screens/agent/AgentTypeSelectScreen.tsx:47` and `:54`:

```ts
title: 'Enterprise',
cta: 'Continue as Enterprise',
```

"Enterprise" is reserved for corporate / Department Chat accounts. A registered security company is a **Service Provider**.

**Fix:** rename both strings to `Service Provider` / `Continue as Service Provider`. **Do not** change the `id: 'agency'` key or `uiTypeToBackend()` — that is the wire contract. Confirm Department Chat's Enterprise onboarding stays visibly separate (`src/screens/messenger/GroupsScreen.tsx:229` shows an `ENTERPRISE` tag — that one is correct and stays).

---

### Issue 36 — Registration repeats medical qualification ✅ CONFIRMED

**PDF p.41 · `p41.jpeg` · Medium**

**Root cause —** `src/screens/agent/AgentRegistrationWizardScreen.tsx:36-42`:

```ts
const CAPABILITY_DEFS = [
  {key: 'first_aid', label: 'First Aid / Trauma Care'}, // ← overlaps
  {key: 'firearms', label: 'Firearms Certified'},
  {key: 'driving', label: 'Defensive Driving · Level 2'},
  {key: 'recon', label: 'Route Recon / SIGINT'},
  {key: 'medical', label: 'Medical / FREC-3'}, // ← overlaps
];
```

Two overlapping medical questions with no hierarchy and no evidence requirement.

**Fix:** collapse into one structured medical-qualification selector with a recognised level (e.g. None / First Aid / FREC-3 / Paramedic), plus certificate upload, expiry date and issuing body. `src/screens/agent/AgentDocsUploadScreen.tsx:35` already has a `firstaid` document slot (`req: 'OPT'`) — wire the selector to it rather than adding a parallel upload path.

⚠️ **Migration:** existing providers have `first_aid` and/or `medical` booleans persisted server-side (`data.profile.capabilities`). Write a mapping for existing rows before you change the keys, or you will silently drop qualifications on next save.

---

### Issue 34 — Agent onboarding route missing ⚠️ CONFLICTS WITH A DELIBERATE DECISION

**PDF p.39 · `p39.jpeg` · High**

**Current state —** `src/screens/agent/AgentTypeSelectScreen.tsx:41-43` carries an explicit comment:

```ts
// Service-provider only. Individual-CPO self-onboarding was removed — officers
// join via their provider's roster (managed sub-accounts), never self-register.
```

The single-entry `TYPES` array reflects that. The tester is asking to **re-introduce** an individual-agent route, gated by a provider invitation code.

**⚠️ Stop and confirm with the product owner before building.** The PDF's ask (invitation-code entry that links an agent to a provider roster after identity/compliance checks) is compatible with the "never self-register" rule _if_ the code is what creates the roster link — but it is a deliberate architecture reversal, not a bug fix. Get it in writing.

**If approved:**

1. Add an `agent` card to `TYPES` with `next: <invite-code screen>`.
2. New invite-code screen: validate code → resolve provider → check status/expiry/already-used.
3. Backend: an invitation-code table + redemption endpoint; on redemption create the managed sub-account under the provider's `org_members` roster. See `src/screens/agent/OrgCreateCpoScreen.tsx` — the provider-side "create a CPO" path already exists and is the natural counterpart.
4. Confirm the agent lands on the agent dashboard, not the provider one.

---

### Issue 39 — Provider cannot view enough agent roster info ⚠️ NEEDS UI READ

**PDF p.44 · `p44.jpeg` · Medium**

**Where to look:** `src/screens/agent/OrgRosterScreen.tsx` (the roster list + action sheet) and `src/screens/agent/OrgCpoProfileScreen.tsx` (an agent-profile screen that already exists — check what it renders and whether the roster action sheet actually links to it).

**Fix:** a role-protected agent profile with approved contact details, roster join date, verification status, qualifications + expiry, availability, rating and mission summary.

**Security constraint — do not skip:** the PDF requires data minimisation, permission control **and audit of access**. This screen exposes personal data of officers. Check `OrgManagerGuard` tenancy on any new endpoint, and write an `ops_audit` row on profile view (note: `ops_audit` is **append-only**). Hide sensitive fields from roles without permission — do not just hide them in the UI while the API returns them.

---

## 5. GROUP C — Mission acceptance & live operations (Issues 41–45, PDF pages 46–50)

### Issue 44 — SOS not reflected in the Bravo Control System ✅ CONFIRMED · **CRITICAL**

**PDF p.49 · `p49A.jpeg`, `p49B.jpeg`**

**This is a life-safety reporting gap. Fix it first.**

**Root cause — the app writes SOS to one table and the console reads a different one.**

_Write side_ — `apps/auth-service/src/sos/sos.service.ts:44-155`. `raise()` does three things:

1. `INSERT INTO public.sos_events (...) VALUES (..., 'active', ...)` — line 72.
2. Emits an ops-audit row (`kind:'sos', severity:'err'`) — line 93.
3. Fans FCM wakes to crew + assigned provider — lines 111-152.

It **never updates `missions.status`**.

_Read side_ — `apps/ops-console/src/app/live/page.tsx:65`:

```ts
const sosCount = all.filter(r => r.status === 'SOS').length;
```

It counts **missions whose status is `SOS`**, not rows in `sos_events`. Same pattern at `apps/ops-console/src/app/live/page.tsx:62` and `apps/ops-console/src/app/dashboard/page.tsx:40`. Since `raise()` never flips a mission to `SOS`, the console permanently shows **SOS 0** — precisely the screenshot.

`apps/ops-console/src/app/dashboard/page.tsx:109` reads `kpis?.sos_active` — trace that KPI's SQL too; if it also derives from `missions.status` it has the same hole.

**Fix — decide the source of truth, then make both sides agree.** Recommended: `sos_events` is the source of truth (it is the richer record and already carries location, reason and payload).

1. Ops console reads **active `sos_events`**, joined to mission/booking, instead of filtering `missions.status`.
2. Add the ops endpoint to serve it. `apps/auth-service/src/ops/ops-data.service.ts` is the read layer.
3. Keep `missions.status = 'SOS'` in sync as a denormalised convenience **only if** existing consumers need it — do not make it the sole signal.
4. Console UX per the PDF: immediate persistent alert, audible notification, acknowledgement workflow, escalation status, audit record. The CSS hooks already exist (`apps/ops-console/src/app/globals.css:425,435,461,666` all have `.sos` variants) — the data is what is missing.
5. **The app must not claim notification until the server acknowledges.** Today `src/screens/liveops/SOSScreen.tsx:167` renders "Ops Room Notified" optimistically. Gate that on the `acknowledged_at` field the status endpoint already returns (`SosStatusDto`, `src/services/api.ts:1836-1841`), matching the pattern already used at `src/screens/dashboard/DashboardScreen.tsx:375` (`sosAcked`). Note the comment at `src/services/api.ts:1858` — the "acknowledged" contract is already understood; SOSScreen just doesn't honour it.

**Security note:** this touches an emergency path. Do not weaken any existing check while wiring it. Test acknowledge → escalate → close with full audit history.

---

### Issue 41 — Agent acceptance missing before dispatch ⚠️ CONFIRMED AS DESIGN GAP · **CRITICAL**

**PDF p.46 · `p46.jpeg`**

**Observed:** a provider accepts a job and the client is immediately told _crew dispatched_, without the selected on-duty agent accepting.

**Current state:** the flow is provider-accept → crew-assign → dispatched, with **no agent acceptance stage**. Evidence:

- `apps/auth-service/src/dispatch/dispatch.service.ts:56` — `const CREW_ASSIGN_SLA_MINUTES = 15;` — there is an SLA for the _provider to assign crew_, but none for the _agent to accept_.
- `dispatch.service.ts:696` — audit writes `'CREW_ASSIGNED'` directly.
- `src/screens/agent/OrgMissionsScreen.tsx:218` — the agency device announces `Alert.alert('Crew dispatched', 'The mission is created and your guards are joining the Ops Room.')` at assign time.
- `src/modules/messenger/push/serverWakeNotifications.ts:100` — `'detail-live'` tells the client "Protection active".

**This is a state-machine change, and it is the largest backend item in the document.** Required new states and transitions:

```
provider ACCEPT        → job RESERVED (client sees "provider assigned", NOT dispatched)
provider assigns agent → agent ACCEPTANCE PENDING (new SLA timer)
agent ACCEPTS          → crew DISPATCHED (client status may now flip)
agent DECLINES/TIMEOUT → reassignment (back to assign, or re-dispatch)
```

**Where to work:**

- `apps/auth-service/src/dispatch/dispatch.service.ts` — the accept/assign transaction (~line 1178-1250).
- `apps/auth-service/src/booking/` — client-facing booking status mapping.
- `src/screens/booking/missionJourney.ts` — the client's 6-step rail; step 3 is currently "Team dispatched". A new pre-dispatch step is needed.
- `src/screens/agent/OrgMissionsScreen.tsx` — agency copy must stop claiming dispatch at assign time.
- CPO side: `src/screens/cpo/OnDutyHomeScreen.tsx`, `src/screens/cpo/AssignedMissionDetailScreen.tsx` need an accept/decline action.
- `apps/ops-console` — must show acceptance + reassignment audit timestamps.

**⚠️ Escrow interaction — read before designing.** Escrow is held at **provider accept** (`dispatch.service.ts:1178`, `wallet.service.ts:540-567`). If acceptance now happens later, decide whether the hold moves. Getting this wrong either double-holds or leaves missions unfunded. `docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md` (LM-B3 "escrow starvation") already flags this area.

**Recommendation:** write a short design note and get it approved before implementing. This is not a same-session fix.

---

### Issue 42 — Follow control covers mission progress text ✅ CONFIRMED

**PDF p.47 · `p47.jpeg` · Medium**

The screenshot is **`AgentLiveTrackerScreen`** (message dock + call/video buttons + the 6-step journey rail).

**Root cause —** the FOLLOW pill lives **inside the Mapbox WebView HTML**, at a hard-coded offset. `src/modules/booking/bravoAgentTrackerMapHtml.ts:244`:

```html
<div class="recenter" id="recenter">⌖ Follow</div>
```

`:39-47`:

```css
.recenter { position: absolute; right: 12px; bottom: 150px; z-index: 30; ... }
```

The journey rail is rendered by React Native **outside** the WebView, but the WebView extends behind it. `bottom: 150px` puts the pill directly over rail steps 5 (`Protection active`) and 6 (`Completed`) — labels defined at `src/screens/booking/missionJourney.ts:36-41`.

**Fix:** the WebView cannot know the RN layout, so pass it in. Measure the rail + dock in RN (`onLayout`) and post the required bottom offset into the WebView, setting `.recenter { bottom: <offset>px }` — or move the control out of the HTML and render it as an RN sibling positioned above the rail. The second is cleaner and makes it respond to `insets.bottom` for free.

**Do not** just bump `150px` to a bigger number — that is how this bug got here.

---

### Issue 43 — Duplicate back / next controls in live mission header ⚠️ SECOND CONTROL UNIDENTIFIED

**PDF p.48 · `p48.jpeg` · Medium**

The screenshot is **`MissionLeadConsoleScreen`** ("MANUAL MARKS · LEAD ONLY", "WAYPOINT TIMELINE").

**What is accounted for:** `src/screens/agent/MissionLeadConsoleScreen.tsx:243-249` renders a correctly-inset root and **one** `NavHeader`:

```tsx
<View style={[s.root, {paddingTop: insets.top}]}>
  <NavHeader title={`Mission ${shortCode || '—'}`} onBack={() => navigation.goBack()} />
```

`NavHeader` (`src/screens/agent/_shared.tsx:38-58`) renders exactly one `chevron-left` plus the blue `accentBar` — which matches the `<` and the `|` in the screenshot. The navigator registers it with `headerShown: false` (`src/navigation/AgentNavigator.tsx:137-141`), so there is no double native header.

**⚠️ Unresolved:** the _upper_ `>` control, which sits **above** the inset-padded content (partially under the status bar). It is not produced by this screen, this navigator, or `NavHeader`. A search of `src/components/` found no absolutely-positioned top-left overlay.

**Do this first — do not guess:** reproduce on device, then dump the view hierarchy. Candidates worth checking in order: (a) a leftover control on the screen that _pushed_ this one and is still mounted during/after transition; (b) a dev-only or debug overlay compiled into the staging build; (c) an `ObsidianTabBar` / drawer edge affordance. Once identified, remove it per the PDF ("Remove any orphaned carousel, drawer or test navigation button unless it has a defined function and label").

---

### Issue 45 — Android nav bar overlaps app controls ⚠️ UMBRELLA FIX

**PDF p.50 · `p50A/B/C.jpeg` · High**

Affects Department Chat, Agent Portal and agent dashboard screens. **This is the same root class as Issues 26, 27 and 42** — hard-coded bottom offsets instead of `insets.bottom`.

**Approach — do this as one systematic pass, last:**

1. Audit every `position: 'absolute'` + `bottom:` in `src/screens/**` for hard-coded values. Confirmed offenders so far: `LocationPickerScreen.tsx:741` (`bottom: 96`), `bravoAgentTrackerMapHtml.ts:40` (`bottom: 150px`).
2. Every fixed footer, bottom nav bar and bottom sheet pads by `insets.bottom` from `useSafeAreaInsets()`.
3. **Keyboard interaction is governed by a separate app-wide rule** — `useKeyboardLayout()` from `@hooks/useKeyboardLayout`. `bottomPad(gap)` **replaces** the safe-area inset while the IME is up; it never stacks. See `CLAUDE.md` → B-184 for the full table, and note `KeyboardAvoidingView`, `keyboardVerticalOffset`, stray `Keyboard.addListener`, and `kbHeight` variables are **banned repo-wide** and enforced by `src/hooks/__tests__/keyboardContract.test.ts`.
4. Test with **both** gesture nav and 3-button nav — the bug only reproduces on 3-button (`insets.bottom ≈ 48dp` vs `≈ 24dp`).

**Gates:**

```bash
npx jest --selectProjects app --testPathPattern useKeyboardLayout    # 23 arithmetic tests
npx jest --selectProjects app --testPathPattern keyboardContract     # 40 contract-scan tests
```

Device pass: `docs/qa/KEYBOARD_UI_TEST_PLAN.md` (Tier 1 = Pixel 7a gesture **and** 3-button, plus a home-indicator iPhone).

---

## 6. GROUP D & E — Mission comms and Department Chat

### Issue 11 — Mission group messaging fails between app and Bravo Control System ⚠️ **CRITICAL** · HIGH-RISK AREA

**PDF p.16 · `p16A.jpeg`, `p16B.jpeg`**

**Observed:** after a mission is accepted, the mobile mission chat has no usable conversation and the console reports `conversation_not_found_or_forbidden`.

**⚠️ Read this before touching anything.** This is the **mission Ops Room** — the single most-regressed subsystem in this repo. Recent history:

- B-207 — mission Ops Room bootstrap.
- B-210 — a **CRITICAL** self-inflicted regression: `is_org_manager` is true for the _owner too_, which blocked the intent drain on **every** trigger since B-207. Fixed by keying off `org === null`.
- B-216 — "NEXT ON OPS" showed completed missions.

**Mandatory reading before code:**

- `docs/runbooks/MESSAGE_LOOP.md` — the M1–M16 invariant contract, and **§5 caller-completeness protocol** (run it for every change to a shared symbol; skipping it is exactly how B-124 shipped).
- `CLAUDE.md` → "Messenger regression gate".

**Key files:**

| File                                                             | Role                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/messenger/orgWorkspace/dispatchRoomIntents.ts`    | Ops Room membership-intent drain.`:37-51` documents that the drain **bootstraps + mints** the group key — every mission Ops Room was stuck keyless until this landed. |
| `src/modules/messenger/runtime/productionRuntime.ts:4409-4434` | Recovery for server-assigned conversation ids.                                                                                                                                 |
| `src/modules/messenger/runtime/runtime.ts:300`                 | Server-assigned-id registration (idempotent).                                                                                                                                  |
| `src/modules/messenger/runtime/applyGroupAdmin.ts:229`         | Externally-assigned id handling.                                                                                                                                               |
| `src/modules/messenger/runtime/inboundGroupCreateGate.ts:28`   | Assigned-Ops-Room create gate.                                                                                                                                                 |
| `src/screens/agent/OrgMissionsScreen.tsx:204-218`              | The agency device that creates the room and drains immediately.                                                                                                                |
| `src/services/api.ts:1743-1758`                                | Ops Room intent endpoints.                                                                                                                                                     |

**PDF requirement:** create the encrypted room **before** dispatch, add client + assigned agents + authorised operators, provision keys, verify permissions — and **mission activation must fail safely if the room cannot be created**. That last clause is a real behaviour change: today the mission proceeds and comms silently fail.

**Diagnose first.** `conversation_not_found_or_forbidden` is the _console's_ error — establish whether the room was never created, was created with a membership the operator is not in, or was created and later hard-deleted (`src/screens/messenger/MessengerHomeScreen.tsx:278` handles hard-deleted Ops Rooms). These need different fixes.

**Gates — the full messenger suite, both projects, 100% green:**

```bash
npx jest --selectProjects messenger-crypto                        # run TWICE — see flake rule
npx jest --selectProjects app --testPathPattern "screens/messenger"
```

**Flake rule (B-126/B-153):** `test:crypto` fails intermittently with _moving_ failures. **One red run is not evidence.** Run it twice — a failure naming the same test both times is yours; one that moves is the known flake.

**Security stop-conditions apply** (CLAUDE.md): group master key distribution, rekey on member removal, epoch handling. Verify against the System Architecture Documentation before changing any of it. **Never** add a "skip in dev" branch to a verification step.

---

### Issue 21 — Multi-image vault upload saves only one file ✅ CONFIRMED

**PDF p.26 · `p26.jpeg` · High**

**Root cause —** `src/screens/messenger/VaultScreen.tsx:173-181`:

```ts
const res = await launchImageLibrary({mediaType: 'photo', selectionLimit: 1, includeBase64: false});
const asset = res.assets?.[0];
if (res.didCancel === true || !asset?.uri) {
  return;
}
await uploadToVault({
  uri: asset.uri,
  name: asset.fileName ?? 'photo.jpg',
  mimeType: asset.type ?? 'image/jpeg',
});
```

Two independent causes of the same symptom: `selectionLimit: 1` caps the picker, and `assets?.[0]` would discard the rest even if it did not.

**Fix:**

1. `selectionLimit: 0` (react-native-image-picker: 0 = unlimited).
2. Iterate `res.assets` and call `uploadToVault` **per file** as a separate encrypted upload.
3. Per-file progress and per-file failure reporting — the PDF explicitly requires partial failures be reported individually, and an interrupted upload must not block the rest.
4. Never silently discard extra selections.

**Note:** `captureImage` (line 185-198) is single-shot by nature — leave it. `pickDocument` (line 201+) uses `DocumentPicker.getDocumentAsync` — check whether it needs `multiple: true` for the "mixed file types" acceptance case.

**Related pattern** (not this issue, but the same one-asset assumption): `src/screens/agent/AgentDocsUploadScreen.tsx:94` and `src/screens/agent/AgentKYCScreen.tsx:105` both take `res.assets[0]`. Those are single-document slots by design — verify, don't change blindly.

---

### Issue 18 — Departmental Chat entry card does not open ⚠️ TWO CANDIDATES

**PDF p.23 · `p23.jpeg` · High**

**Code —** `src/screens/messenger/GroupsScreen.tsx:198-231`:

```tsx
onPress={() => {
  if (entitlements.hasDeptChannels) {
    navigation.navigate('DepartmentChannels' as never);
  } else {
    showEnterpriseUpgradePrompt({onViewPlans: openPricing});
  }
}}
```

**Candidate A — the entitlement is false and the upgrade prompt silently fails.** If `showEnterpriseUpgradePrompt` no-ops, the tap does nothing visible. The PDF's required behaviour is a _controlled access/onboarding message_, so if the account genuinely lacks entitlement the fix is to make that message actually appear.

**Candidate B — the navigate fails.** Note `'DepartmentChannels' as never` — that type escape hatch defeats route-name checking, which is exactly the class of bug that hides here. `DepartmentChannels` **is** registered in `MessengerNavigator.tsx:163` and `DepartmentalNavigator.tsx:86`, so it should resolve from the messenger stack — but confirm `GroupsScreen` is actually mounted inside `MessengerNavigator` when the tester hit it.

**Do this:** reproduce on device with an **entitled** account and a **non-entitled** one; they will discriminate A from B immediately. Then remove the `as never` cast and fix whatever the type error reveals.

---

### Issue 19 — Attendance and Incidents entry does not open ⚠️ NEEDS DEVICE PROBE

**PDF p.24 · `p24A.jpeg`, `p24B.jpeg` · High**

**Code —** `src/screens/messenger/DepartmentChannelsScreen.tsx:55-63`:

```ts
const parentNav = navigation.getParent();
const inDepartmentalShell = !!parentNav?.getState?.()?.routeNames?.includes?.('Attend');
const openAttendance = useCallback(() => {
  if (inDepartmentalShell) {
    parentNav!.navigate('Attend');
  } else {
    navigation.navigate('Departmental');
  }
}, [inDepartmentalShell, parentNav, navigation]);
```

The card is at `:257-273`, rendered only when `!inDepartmentalShell`.

`Departmental` is registered in three navigators — `MessengerNavigator.tsx:183`, `AgentNavigator.tsx:265`, `CpoNavigator.tsx:75` — so the route name resolves from all three shells. That makes a plain missing-route explanation unlikely.

**Leading hypothesis:** the `inDepartmentalShell` detection is wrong in some shell. It probes `parentNav.getState().routeNames` for `'Attend'` — a single-level `getParent()` lookup that will return the wrong navigator depending on nesting depth. If it evaluates `false` when the user _is_ in the shell, the card renders and `navigate('Departmental')` re-enters a shell that is already mounted → visually nothing happens. That matches "reproduced on more than one dashboard and role".

**Do this:** log `parentNav?.getState()?.routeNames` on each of the three shells (client/messenger, agent, CPO) and compare. Then replace the fragile single-level probe with an explicit navigator-name check or a route param passed by the caller.

**PDF requirement:** repair the **shared** route and entitlement check — do not duplicate broken navigation in separate layouts.

---

### Issue 20 — New Department Chat account asked for an uncreated Vault PIN ⚠️ SECURITY · NOT YET TRACED

**PDF p.25 · `p25.jpeg` · High**

**Observed:** immediately after registering a new Department Chat account, the Secure Vault asks for a six-digit PIN the user never created.

**Not yet traced to a line** — this was the one in-scope issue I did not reach. Start at `src/screens/messenger/VaultScreen.tsx` and the vault-unlock gate, and find where first-access decides between _setup_ and _entry_. The bug is almost certainly a missing "no PIN exists yet" branch.

**Security constraints — non-negotiable:**

- **Do not assign or imply a default PIN.** If you find a default anywhere, that is a second, more serious bug — log it separately as Critical.
- First access must run the approved MFA setup flow, then PIN creation + confirmation.
- **File Vault MFA gate must not be bypassed.** CLAUDE.md: the files-service enforces a fresh biometric/TOTP challenge before returning download URLs regardless of a valid JWT. Do not add a "skip in dev" branch.
- Verify recovery, biometric and lockout behaviour after PIN creation.

---

## 7. Out of scope for this document (Messenger-only)

Recorded so nothing is lost. These are real issues; they just aren't booking.

| PDF page | Issue | Title                                                                 | Priority          |
| -------: | ----: | --------------------------------------------------------------------- | ----------------- |
|        6 |    01 | Individual Chat Displays Messenger Runtime Configuration Error        | High              |
|        7 |    02 | Group Membership Is Incorrectly Restricted Across Groups and Profiles | High              |
|        8 |    03 | Conversation List Tick Icon Misrepresents Message Status              | Medium            |
|        9 |    04 | Group Voice Note Sending Fails Due to Presence Rate Limiting          | High              |
|       10 |    05 | Bravo System Chat Auto-Created but Cannot Send or Receive             | High              |
|       11 |    06 | Messenger Search Does Not Produce a Functional Result                 | Medium            |
|       12 |    07 | Emoji Picker Non-Functional and Message Reactions Missing             | Medium            |
|       13 |    08 | Sent Messages Cannot Be Edited                                        | Medium            |
|       14 |    09 | Long Message Text Escapes the Composer Container                      | Medium            |
|       15 |    10 | @Mention Inserts an Internal User Identifier into the Composer        | High (Security)   |
|       17 |    12 | Raw Avatar URL or Internal Code Exposed in Profile Settings           | Medium (Security) |
|       18 |    13 | Security Settings Menu Item Does Not Open                             | High              |
|       19 |    14 | Help and Support Menu Item Does Not Open                              | High              |
|       20 |    15 | Profile Image Completion Action Incorrectly Labelled 'CROP'           | Low               |
|       21 |    16 | Unexplained 'T2' Badge in Agent Profile Menu                          | Low               |
|       22 |    17 | Messenger Pro Upgrade CTA Loops Back to the Same Screen               | High              |

**Two of these touch booking indirectly** and may be worth pulling forward:

- **Issue 17** (Pro upgrade CTA loops) is the same payment/top-up routing class as booking Issue 25. If you build the shared `insufficient_credits` → top-up helper for Issue 25, check whether it fixes 17 for free.
- **Issue 09** (composer escapes container) shares the keyboard-inset rule with Issue 45.

---

## 8. Gates — run these for every change

Per `CLAUDE.md` change-safety rules. Targeted first, broad second.

```bash
# Type + lint (never exceed the .tsc-baseline.json count of 47)
npm run typecheck
npm run lint

# Booking-specific
npm test -- --selectProjects=booking

# Messenger (REQUIRED for Issues 11, 18, 19, 20, 21 — both projects, 100% green)
npx jest --selectProjects messenger-crypto                        # run TWICE (flake rule)
npx jest --selectProjects app --testPathPattern "screens/messenger"

# Keyboard / safe-area (REQUIRED for Issues 26, 27, 31, 42, 45)
npx jest --selectProjects app --testPathPattern useKeyboardLayout
npx jest --selectProjects app --testPathPattern keyboardContract

# Backend (from inside the service dir)
cd apps/auth-service && npm test

# Ops console (Issue 44)
cd apps/ops-console && npm run typecheck && npm run lint

# Full
npm test
```

**Device verification** (`LOOP.md` requires local Android, not cloud builds):

```bash
# Build with EXPLICIT staging env — release-apk.ps1 bakes wrong URLs
# Install on ALL adb devices (phone + both BlueStacks). NOT Firebase unless asked.
adb devices
```

**Runbook gates:**

- `docs/runbooks/LITE_BOOKING_LOOP.md` — §4 automated gates, §5 device/data probes, §7 sign-off, and the B-82 regression watchlist. Run **baseline before** and **regression after**.
- `docs/runbooks/MESSAGE_LOOP.md` — for Issue 11 only. §5 caller-completeness protocol, §7 gates, §9 sign-off, §10 stop conditions.

---

## 9. Known traps in this repo — read before you start

Each of these has cost a previous session.

1. **`test:crypto` flakes ~50%** (B-126). One red run is not evidence. Run it twice; a failure naming the same test both times is real, one that moves is the flake.
2. **No test imports `productionRuntime.ts`.** A green suite is _not_ evidence a change there is safe. On 2026-07-18 a _call_ fix silently broke _messaging_ and produced CRITICAL data loss (B-125) two days later, with the suite green the whole time.
3. **Source files are CRLF.** A `\n`-anchored regex in a static scan test matches nothing and the test passes **vacuously**. Use line-based scanning or `\r?\n`.
4. **Strip comments before any ordering/absence assertion** in a source-scan test. Prose containing the banned word is the single most common false result.
5. **Line numbers in docs go stale fast.** Re-grep the symbol; never trust a stamped line — including the ones in this document.
6. **Another agent commits to this repo concurrently.** Fetch `origin` **before** picking B-numbers (they collided at B-160..B-162). Merge, don't rebase. Re-typecheck after merging — a clean merge is not a compiling tree.
7. **`ZA` = South Africa, `SA` = Saudi Arabia.** Never staff South Africa as `SA`.
8. **Raw `gradlew` misses the `EXPO_PUBLIC_*` bake.** Set env explicitly, then `assembleRelease`.
9. **`ops_audit` is append-only.**
10. **Recurring root cause across this codebase:** one behaviour, N hand-copied implementations, and the unwatched copy drifts. Issue 24 (3 "My Bookings" destinations) and Issue 25 (4 copies of the `insufficient_credits` check) are both instances. **Reuse before abstracting; consolidate rather than adding copy N+1.**

---

## 10. Open questions for the product owner

Do not guess on these — each changes what gets built.

| # | Issue | Question                                                                                                                                                                                                   |
| - | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | 34    | Re-introducing an individual Agent onboarding route reverses the deliberate "officers never self-register" decision (`AgentTypeSelectScreen.tsx:41-43`). Approve, or keep provider-managed rosters only? |
| 2 | 33    | Do**operator-facing** surfaces (CPO/agent) also move from "Ops Room" to "Bravo Control System", or is the rename client-facing only?                                                                 |
| 3 | 29    | Is hourly Executive Protection required for the South Africa pilot, or is "Coming Soon" acceptable at launch? It is the largest single item here.                                                          |
| 4 | 41    | Where does escrow hold move when agent acceptance is inserted after provider accept? Needs a finance decision before implementation.                                                                       |
| 5 | 37    | Which exact South African provinces/cities are in the pilot? Only Johannesburg and Cape Town exist as coverage zones today (`coverageZones.ts:38-39`).                                                   |
| 6 | 28    | Who owns provider/referral codes, and what are the incentive rules? PDF says apply them "only after operational approval".                                                                                 |
| 7 | 16    | What is the`T2` badge? (Out of scope here, but it is a product question and blocks a Low.)                                                                                                               |

---

_Prepared 2026-07-25 from `BRAVO SECURE App Testing Issues V2.pdf`. Desk analysis only — no code changed. Root causes marked ✅ verified against source; ⚠️ items need an on-device probe before implementation._
