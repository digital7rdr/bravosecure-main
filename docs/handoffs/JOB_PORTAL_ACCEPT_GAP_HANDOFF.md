# Job Portal — "Service provider can't accept the job" + make it its own menu

**Date:** 2026-07-10 · **Status:** ROOT-CAUSE ANALYSIS (no code changed) · **Severity:** P0 (flow dead-ends)
**Reporter symptom (verbatim intent):** _"Client sends a request → ops-console accepts the mission →
the service provider **can't accept the job** shown in the Job Portal. Because they can't accept, the
next process (crew assignment) can't be completed. Also: the Job Portal is shown **inside** the Missions
screen — make it its own top-level menu."_

**Method:** end-to-end code trace (mobile → auth-service → ops-console) + a 4-agent parallel audit with
adversarial verification (17 agents; **0 findings refuted**, all facts CONFIRMED, corrections folded in below).
Every claim below cites `file:line`.

> **➡ Follow-up spec:** the desired marketplace behavior (visible to all agencies → first-come claim →
> disappears for everyone → agency-cancel relists it) plus the full race-condition analysis lives in
> `docs/planning/JOB_PORTAL_MARKETPLACE_SPEC.md`. That doc supersedes §5 Fix A's sketch with the complete design.

---

## 1. TL;DR (plain English)

Think of the app as a **notice-board**. When ops clicks **"Approve & publish"**, the job gets pinned to
the board so agencies can see it. The problem: **the Job Portal is a glass display case, not a notice-board
with a pen.** The agency can _look_ at the open job through the glass, but there is **no "Accept" button on
it at all**, and even if there were, the card doesn't carry the ID that any accept endpoint needs. So the
booking just sits there at `OPS_APPROVED`/`DISPATCHING`, the agency can't claim it, no crew gets assigned,
and the whole mission stalls.

There are actually **three different "job" systems** in the codebase that all use the word "job," and the
Job Portal is wired to the one that has **no accept path**. The two systems that _do_ have an accept path
(the auto-dispatch push "IncomingOffer", and the legacy "apply to a published job") are either not reachable
by the agency, or are conditional/push-only and frequently never fire.

**Two fixes are needed:**

1. **Restore accept** — give the Job Portal a real "Accept job" action wired to a backend claim endpoint
   that reuses the existing escrow/FSM `accept` transaction (§5, Fix A).
2. **Promote the menu** — extract the Job Portal out of the Missions screen into its own screen + dashboard
   menu entry (§5, Fix B).

---

## 2. The three parallel "job" systems (root of the confusion)

| #   | System                   | Table(s)                            | How an agency "accepts"                                                                           | Mobile surface                                                                        | Reachable by agency?                                                                         |
| --- | ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A   | **Auto-dispatch (Lite)** | `lite_bookings` + `dispatch_offers` | Push offer → tap **Accept** → `POST /dispatch/offers/:id/accept` (`api.ts:1555`)                  | `IncomingOffer` screen + dashboard live-offer banner (`AgentDashboardScreen.tsx:745`) | ✅ but **only when an offer is pushed** (conditional — see §4)                               |
| B   | **Legacy job board**     | `jobs` + `job_applications`         | Two-step: **apply** → `POST /agents/me/jobs/:jobId/apply` (`api.ts:695`) → ops shortlists/assigns | `JobMarketplace` → `JobDetail`                                                        | ❌ **not surfaced on the agency dashboard** (never navigated to from `AgentDashboardScreen`) |
| C   | **"Job Portal" browse**  | `lite_bookings` (read-only)         | **— none —** (display only)                                                                       | Section inside `OrgMissionsScreen` (`:324-350`)                                       | ✅ visible, ❌ **not actionable**                                                            |

The **Job Portal the user is looking at is system C.** It shows the same `lite_bookings` rows as system A,
but has no accept action, and its data can't drive system B (different table + ID space). That is the crux.

---

## 3. What actually happens when ops clicks "Approve & publish"

1. Ops-console: on a `PENDING_OPS` booking, ops sees **"Approve & publish"**
   (`apps/ops-console/src/app/bookings/[id]/page.tsx:386,654`) → confirm modal →
   `opsApi.approveBooking(id, dress, notes)` (`:111`).
2. Backend `OpsService.approveBooking` (`apps/auth-service/src/ops/ops.service.ts:214`):
   - Locks the booking `FOR UPDATE`, flips it → **`OPS_APPROVED`** (in-txn).
   - **Always** calls `JobFeedService.publishFromBooking` → inserts a **legacy `jobs` row** (`status='PUBLISHED'`)
     (`ops.service.ts:286`; `job-feed.service.ts:64-109`). _This is system B._
   - **Only if** `dispatch_mode === 'auto'` **and** `booking_mode !== 'later'`, publishes `{bookingId}` on the
     `dispatch:ops-approved` Redis channel (`ops.service.ts:268-275`). _This tries to start system A._
3. `OpsApprovedDispatchService` consumes that frame → `DispatchService.start()` → booking `OPS_APPROVED → DISPATCHING`
   → offers to the nearest eligible agency (`apps/auth-service/src/dispatch/ops-approved-dispatch.service.ts:80-101`).
   **BUT this subscriber ships _dark_** — it does nothing unless `AUTO_DISPATCH_ENABLED === 'true'`
   (`ops-approved-dispatch.service.ts:40-44,59-61`; flag default **off**, `config/configuration.ts:123`).

So after "Approve & publish", the booking is `OPS_APPROVED` (or `DISPATCHING` if auto is on). The **only**
surface that reliably shows it to the agency is the **Job Portal (system C)** — which cannot accept it.

---

## 4. Root causes — why the agency can't accept

> **Direct vs contributing (from the adversarial verification):** RC-1 and RC-2 are the **direct** cause of
> "can't accept _from the Job Portal_" — the portal is a display-only browse that **was never the accept
> surface, by design**. RC-3 is the **contributing** cause: the accept path that _is_ intended for an agency
> (the auto-dispatch offer) is conditional and frequently never fires, so there is no fallback when the portal
> can't act. Fixing only the menu placement (RC-NAV) changes nothing about accept.

### RC-1 (P0) — The Job Portal card is display-only. There is no accept/apply button.

`OpenJobCard` renders the open job as a plain `View` with **no `onPress` and no accept control**
(`src/screens/agent/OrgMissionsScreen.tsx:76-96`). The surrounding section (`:324-350`) is explicitly labeled
a _"testing affordance"_ (`:8-10,159`). The only interactive "accept-like" control on this screen is the
**assign-crew** sheet, and that operates on `data.needs_crew` — jobs the agency has **already accepted**
(`confirm()` → `orgApi.assignCrew`, `:249-267`) — not on the `openJobs` browse feed. **Result:** the user
taps an open job and nothing happens; there is no way to accept.

### RC-2 (P0) — Even with a button, the Job Portal's data is wired to no accept endpoint.

`getOpenJobs` → `GET /agents/me/open-jobs` → `AgentService.browseOpenJobs` returns rows from **`lite_bookings`**
carrying **only `booking_id`** — no `job_id`, no `offer_id` (`api.ts:1028-1042`; backend `agent.service.ts:748-796`).

- System B's accept (`applyToJob`) needs a **`jobs.id`** and requires `job.status='PUBLISHED'`
  (`agent.service.ts:926-943`) — a `lite_bookings.booking_id` is the wrong ID for the wrong table.
- System A's accept (`/dispatch/offers/:id/accept`) needs a **`dispatch_offers.id`**, which the portal never fetches.

So a naïve "Accept" button on `OpenJobCard` would have **nothing to call**. The portal is architecturally
orphaned from every accept path.

> **Privacy contract (LB1):** the open-jobs feed is **coarse by design** — it deliberately withholds exact
> pickup/dropoff, full addresses, and client identity pre-accept (`agent.service.ts:741-747`, SQL truncates
> `pickup_address` to its zone). The fix (§5 Fix A) must preserve this: the accept decision is made on coarse
> data (exactly as the offer-accept is), and precise details are revealed only _after_ ownership is granted.

### RC-3 (P0) — The agency's only real accept path (auto-dispatch offer) is push-only and conditional.

System A's accept works **only** when a `dispatch_offer` is created **and delivered** to _this_ agency. That
requires **all** of: `AUTO_DISPATCH_ENABLED=true` (`configuration.ts:123`); `dispatch_mode='auto'` &
`booking_mode!='later'` (`ops.service.ts:268-270`); this agency is the **nearest eligible** candidate
(in-region + DPA-accepted + not on cooldown, `dispatch.service.ts` ranking SQL `:122-183`); the agency acts
within the **30 s offer TTL**; and the push actually reaches the app (killed/backgrounded apps never get the
offer wake — known gap **LM-N1**, `docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md`). If any link
fails, there is **no offer to accept** — and the Job Portal, the one always-visible surface, can't stand in.
(Live staging already shows this failure mode: **76/171 bookings died `NO_PROVIDER`**, same audit §2.)
A booking only enters this path when it was created with `autoDispatch:true` — the client `POST /dispatch/request`
route sets it (`apps/auth-service/src/dispatch/client-dispatch.controller.ts:62`); a legacy booking
(`dispatch_mode` null) never produces an offer at all, so its agency accept surface is _only_ the dead Job Portal.

### RC-4 (P1) — The legacy "apply" path exists but is unreachable for agencies + isn't a one-tap accept.

`approveBooking` always publishes a legacy `jobs` row (system B), and `JobMarketplace`/`JobDetail` implement
apply/withdraw (`JobDetailScreen.tsx:284`, `JobMarketplaceScreen.tsx:249`). But **`AgentDashboardScreen` never
navigates to `JobMarketplace`** — an agency (`agent.type==='company'`, `AgentDashboardScreen.tsx:469`) only gets
cards for **Missions → `OrgMissions`** (`:479`), Compliance, Roster, Departmental, Messenger, Region, Earnings.
And even if reached, apply is a **two-step** flow (agent applies → ops must shortlist/assign), not the one-tap
"accept → crew" the user expects.

### RC-NAV (P1) — The Job Portal is embedded in the Missions screen, not its own menu.

It renders as a section _inside_ `OrgMissionsScreen` (`:324-350`), reached only via the dashboard's **"Missions"**
card (`AgentDashboardScreen.tsx:479` → route `OrgMissions`, `AgentNavigator.tsx:189-193`). There is **no dedicated
"Job Portal" dashboard entry and no standalone route**.

### Why "the next process can't be completed"

The mission lifecycle is: booking **accepted → `CONFIRMED` → appears in `needs_crew` → assign crew →
mission created (`DISPATCHED`)**. The `assignCrew` step is already built and works (`OrgMissionsScreen.tsx:249-267`
→ `POST /org/bookings/:bookingId/crew`). But it only lights up **after** a booking is accepted into
`CONFIRMED`/`needs_crew`. Because RC-1..RC-3 block the accept, the booking never leaves `OPS_APPROVED`/`DISPATCHING`,
never reaches `needs_crew`, and the crew-assign → mission chain never starts. **The dead-end is entirely at the
accept step.**

---

## 5. How to fix

### Fix A (P0) — Make the Job Portal a real, one-tap accept surface ⭐ recommended

Turn the Job Portal into a genuine **pull marketplace**: an eligible agency claims an open booking directly,
which lands it in `needs_crew` so the existing assign-crew flow finishes the job.

**A1 · Backend — new claim endpoint that REUSES the existing accept transaction.**
Add `POST /agents/me/open-jobs/:bookingId/accept` (provider/company-only guard, mirror `browseOpenJobs`'s
`agent.type==='company'` check, `agent.service.ts:755-757`). Implement `DispatchService.claimOpenBooking(bookingId, providerUserId)` by **factoring `acceptTxn` (`dispatch.service.ts:1087-1140`)** so the money + FSM steps are
reused verbatim, not reinvented:

1. Lock the booking `FOR UPDATE`; require `dispatch_mode='auto'` and status ∈ `{OPS_APPROVED, DISPATCHING}`;
   validate the provider is eligible (region + DPA + not on cooldown — reuse the ranking eligibility predicates,
   `dispatch.service.ts:122-183`).
2. If `OPS_APPROVED`, first flip → `DISPATCHING` (reuse `start()`'s guarded transition, `:440`).
3. Upsert a `dispatch_offers` row for **this** provider (rank 0), then run the **same** offer-win + escrow-hold
   - `DISPATCHING→CONFIRMED` + `crew_deadline_at` + supersede-siblings block already in `acceptTxn`
     (`:1087-1210`). `adminForceAssign` (`:1028-1046`) is the existing precedent for "run the accept saga on the
     agency's behalf" — model the new method on it.

- **Single-writer invariant (must route through it):** the **only** place a booking ever gets an org as its
  provider is `acceptTxn`'s `UPDATE lite_bookings SET status='CONFIRMED', assigned_provider_user_id=$2, crew_deadline_at=…`
  (`dispatch.service.ts:1194-1201`). A pull-accept **must** reuse this exact UPDATE (+ its escrow-hold at
  `:1140-1193`), never a parallel one — otherwise escrow/ownership can desync.
- **Reuse, don't duplicate:** `holdToEscrow` (`:1156`), `fsm.assert('DISPATCHING','CONFIRMED')` (`:1133`), the
  audit rows (`accept()` `:1074-1084`), and the `providerAccepted` client push.

> 🔒 **STOP-CONDITION / arch-review gate.** This touches **escrow holds, the booking FSM, and dispatch-offer
> handling** — all in the CLAUDE.md "Security constraints → Stop conditions" list. The implementation **must**
> call/factor the existing `acceptTxn` money+FSM steps (exactly-once via the conditional offer-win + escrow
> `ON CONFLICT (booking_id) DO NOTHING`), and must **not** introduce a new charge path. Get architecture sign-off
> before enabling. Add the same race/idempotency tests as `dispatch.service.spec.ts` (double-tap, two-pod).

**A2 · Backend — expose the accept handle on the browse feed.** Extend `OpenJobDto` + `browseOpenJobs`
(`agent.service.ts:748-796`, `api.ts:1028-1042`) with a `can_accept` flag (eligible + still open) so the card can
enable/disable the button correctly.

**A3 · Mobile — wire the button.** Give `OpenJobCard` (`OrgMissionsScreen.tsx:76-96`) an **"Accept job"** CTA
(copy the `JobCard` `TouchableOpacity`+press pattern, `:98-142`) calling `agentApi.acceptOpenJob(booking_id)`;
on success refresh the board (`load()`) — the booking now appears under **NEEDS CREW** and the existing
`assignCrew` sheet completes the mission. Map server errors with the existing `ASSIGN_ERRORS` pattern (`:29-43`)
plus a new `booking_not_claimable` (raced/withdrawn).

**Alternative (if pure push-dispatch must be preserved instead of pull):** don't add a claim endpoint; instead
(a) ensure `AUTO_DISPATCH_ENABLED=true` for the environment, (b) seed DPA-accepted in-region agencies so offers
have a candidate, (c) fix offer delivery to backgrounded/killed apps (**LM-N1**), and (d) make the Job Portal
card a **shortcut into `IncomingOffer`** when a live offer exists for this agency. This keeps the ranked-offer
model but is less "portal-native" than Fix A.

### Fix B (P1) — Promote the Job Portal to its own menu

1. **Extract** the Job Portal section (`OrgMissionsScreen.tsx:324-350` + its region-chip state `:159-194` and
   styles `:485-492`) into a new `src/screens/agent/JobPortalScreen.tsx`. Remove the embedded section from
   `OrgMissionsScreen` so the Missions board stays purely NEEDS CREW / ACTIVE / RECENT + assign-crew.
2. **Register** the route: add `JobPortal: undefined;` to `AgentStackParamList` (`src/navigation/types.ts`, near
   `OrgMissions` `:306`) and a `<Stack.Screen name="JobPortal" .../>` in `AgentNavigator.tsx` (beside `OrgMissions`
   `:189-193`).
3. **Add the dashboard menu card.** In `AgentDashboardScreen.tsx`, add a tile to the **`isOrg`** card array
   (beside the `Missions`/`Roster` cards, `:479-485`) — e.g. `{key:'portal', icon:'briefcase-search-outline',
title:'Job Portal', sub:'Browse & accept open jobs', onPress:()=>navigation.navigate('JobPortal')}`. Gate on
   `isOrg` (`agent.type==='company'`) to match the backend company-only guard.
4. **Naming guard:** keep this distinct from the legacy `JobMarketplace` route (individual-CPO apply board) to
   avoid two "job" menus.

---

## 6. Verification plan

**Backend (auth-service):**

- `npm test -- --selectProjects=booking` (regression) + new specs for `claimOpenBooking`: eligible provider
  claims `OPS_APPROVED`/`DISPATCHING` → `CONFIRMED` + escrow HELD once; ineligible/region-mismatch rejected;
  double-tap / two-pod race → exactly one winner, no double escrow charge; claim on a terminal booking → 409.
- Confirm escrow conservation via the existing reconciliation cron path.

**Mobile:**

- `npm run typecheck` ≤ baseline 47; unit test for the new `acceptOpenJob` api wrapper + `OpenJobCard` button
  enabled/disabled by `can_accept`.
- Device/dev-server golden path: ops "Approve & publish" → job appears in Job Portal → tap **Accept** → booking
  moves to **NEEDS CREW** → assign crew + leader → **mission created (`DISPATCHED`)**. Error path: two agencies
  race the same job → one gets "reassigned/claimed elsewhere," board refreshes.
- Nav: **Job Portal** appears as its own dashboard card for a `company` account, opens the standalone screen,
  and no longer renders inside Missions; a `cpo`/individual account does **not** see it.

**Backend/ops-console redeploy** required (auth-service touched) — Contabo, per `skills/deployment.md`.

---

## 7. Files involved

| Concern                             | File(s)                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Job Portal (embedded, display-only) | `src/screens/agent/OrgMissionsScreen.tsx:76-96,159-194,324-350`                                                               |
| Browse feed API + DTO               | `src/services/api.ts:691-693,1028-1042`                                                                                       |
| Browse feed backend (lite_bookings) | `apps/auth-service/src/agents/agent.service.ts:748-796`                                                                       |
| Accept transaction to reuse         | `apps/auth-service/src/dispatch/dispatch.service.ts:1028-1140`                                                                |
| Ops "Approve & publish"             | `apps/ops-console/src/app/bookings/[id]/page.tsx:111,386,654`; `apps/auth-service/src/ops/ops.service.ts:214-289`             |
| Legacy jobs publisher (system B)    | `apps/auth-service/src/ops/job-feed.service.ts:64-109`                                                                        |
| Auto-dispatch gate (dark flag)      | `apps/auth-service/src/dispatch/ops-approved-dispatch.service.ts:40-101`; `apps/auth-service/src/config/configuration.ts:123` |
| Agency dashboard menu               | `src/screens/agent/AgentDashboardScreen.tsx:469-510,745`                                                                      |
| Navigation                          | `src/navigation/AgentNavigator.tsx:157-193`; `src/navigation/types.ts:297-306`                                                |

**Related known issues (do not re-fix here):** LM-N1 (offer push to backgrounded apps), NO_PROVIDER funnel /
DPA seeding — see `docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md`.

---

## 8. Adversarial verification summary

A 17-agent audit (4 parallel investigators over mobile-nav, mobile-accept-paths, backend chain, ops-console;
then 13 skeptic verifiers, one per P0/P1 claim) produced: **0 REFUTED**, all cited facts CONFIRMED, 11 PARTIAL.
Every PARTIAL agreed the code facts were literally accurate and only sharpened the _framing_ — folded in above:

- **Direct vs contributing.** The direct cause of "can't accept from the Job Portal" is the display-only card
  over a browse-only feed (RC-1/RC-2); the auto-dispatch conditionality (RC-3) is why the _intended_ path is
  also empty. (§4 intro now states this.)
- **The portal was never the accept surface — by design (LB1 coarse/privacy).** So "just add a button" is
  necessary but not sufficient and must not leak pre-accept PII. (RC-2 note + Fix A privacy note added.)
- **Single writer of `assigned_provider_user_id`.** The only org-becomes-provider transition is `acceptTxn`
  at `dispatch.service.ts:1194-1201`; any fix must reuse it. (Fix A now pins this invariant.)
- **How a booking becomes `auto`.** `POST /dispatch/request` sets `autoDispatch:true`
  (`client-dispatch.controller.ts:62`); legacy bookings never offer, so their only agency surface is the dead
  portal. (RC-3 note added.)
