# Job Portal → open marketplace: claim / disappear / relist — spec + race-condition analysis

**Date:** 2026-07-10 · **Status:** ✅ IMPLEMENTED (same day — see box) · **Builds on:**
`docs/handoffs/JOB_PORTAL_ACCEPT_GAP_HANDOFF.md` (root cause of "SP can't accept"; read it first)

> **DELIVERY (2026-07-10, same session).** §6 checklist items 1–5 + 8–11 shipped; as-built deltas vs this spec:
>
> - **Endpoints live in the dispatch module** (module-cycle + guard reuse): claim =
>   `POST /dispatch/open-jobs/:bookingId/claim`, withdraw = `POST /dispatch/bookings/:bookingId/withdraw`
>   (both OrgManagerGuard + IdempotencyInterceptor, `dispatch-jobs.controller.ts`).
> - **Claims are AUTO-bookings only** (spec §2 step 2 upheld — review finding D5 reversed an earlier
>   draft that normalised legacy rows): a legacy `OPS_APPROVED` booking's client never consented to
>   charge-on-accept (their flow pays via an explicit PAYMENT_PENDING step), so claiming one would be an
>   un-consented wallet debit. Legacy rows render browse-only ("VIA OPS ASSIGNMENT"); the server 409s
>   `job_not_claimable`. An auto booking parked at `OPS_APPROVED` (engine dark / frame lost) IS claimable —
>   the claim performs the OPS_APPROVED→DISPATCHING start itself, audited as its own timeline hop.
> - **`can_accept` DTO field skipped** — the card derives claimability client-side from `job.status` +
>   `dispatch_mode` (both now in the DTO); the server-side consent/status gates stay authoritative.
> - **Withdraw does NOT re-enter `offerNext`** — the portal is the re-offer surface (a fresh OFFERED row
>   minted while the expiry sweep is dark would bench that agency forever — LM-B2 class).
> - **Deadlock discipline:** claim locks booking→offers while accept locks offer→booking, so both paths
>   re-run once on a Postgres 40P01 (`retryOnDeadlock`); every guard re-evaluates on the re-run.
> - **Bonus fix (same session):** client "cancel search" 403 — `BookingService.cancel` now answers
>   idempotent success for already-ended bookings (CANCELLED/NO_PROVIDER/AGENCY_NO_SHOW) and
>   FindingDetailScreen gained a confirm popup + terminal-status routing.
> - **Post-implementation adversarial review (52-agent, 8 angles × verify):** 48 candidates → 10
>   confirmed findings → ALL FIXED same session:
>   D1 stale Idempotency-Key replay (per-tap nonce on claim/withdraw keys); D2 relisted booking had no
>   terminal driver (NEW `relist-timeout.service.ts` sweep → `noProvider()` → R12 refund; TTL env
>   `DISPATCH_RELIST_TTL_MINUTES`, default 60); D3 innocent raced agencies were permanently excluded
>   (settleWonOffer's sibling-retire now stamps `CANCELLED`, not `SUPERSEDED` — R9 + ranking exclusions
>   only read culpable statuses); D4 `cancel`/`adminCancel`/`abandonUnstarted` now refund a
>   (relist-only) HELD hold with their flips; D5 claims restricted to `dispatch_mode='auto'` (charge-on-
>   accept consent exists) — legacy rows render browse-only ("VIA OPS ASSIGNMENT"), 409
>   `job_not_claimable` server-side; + OPS_APPROVED→DISPATCHING claim hop audited (LM-V6) and
>   AgencyAcceptedScreen now routes DISPATCHING→FindingDetail / NO_PROVIDER→NoDetail when the agency
>   withdraws while the client waits.
> - Tests: 33 claim/withdraw/R12/D3/D4/D5 specs + 5 relist-sweep specs + 3 idempotent-cancel specs;
>   auth-service 100 suites / 1766 tests green; mobile booking project 139 green; tsc 46 ≤ 47 baseline.
> - **Remaining:** crew-SLA relist policy P2 (kept terminal, per spec default); two-device golden-path
>   QA (§6 gates).

**Requested behavior (user's words, distilled):**

1. A job listed on the Job Portal is **visible to ALL agencies**.
2. When **one agency accepts**, the job moves to that agency's **Missions menu** (`NEEDS CREW`), where they
   **assign CPOs** — and the job **disappears from the portal for everyone**.
3. If the accepting agency **cancels**, the job **reappears in the Job Portal**.
4. Analyze **race conditions** (two agencies accepting at once, cancel vs. crew-assign, etc.).

---

## 1. TL;DR — the design falls out of the status machine

The portal feed is **status-driven**: `browseOpenJobs` lists `lite_bookings WHERE status IN
('PENDING_OPS','OPS_APPROVED','DISPATCHING')` (`agent.service.ts:774`). The Missions `NEEDS CREW` bucket is
`assigned_provider_user_id = org AND status = 'CONFIRMED' AND no mission` (`org-mission.service.ts:75-93`).
That means **three of the four requirements are automatic side-effects of one status transition** — the same
`DISPATCHING → CONFIRMED` single-writer UPDATE the offer-accept already performs (`dispatch.service.ts:1194-1201`):

| Requirement                                           | Mechanism                                                                                                                                                                                                                                     | New code needed?            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Visible to all agencies                               | Already true — `browseOpenJobs` has **no org/eligibility filter**; every `company` agent sees every open job (`agent.service.ts:748-796`)                                                                                                     | None                        |
| Accept → lands in that agency's Missions `NEEDS CREW` | `acceptTxn`'s UPDATE sets `status='CONFIRMED', assigned_provider_user_id=<org>` — exactly the `needs_crew` predicate                                                                                                                          | **Claim endpoint** (§2)     |
| Accept → gone from portal for everyone                | `CONFIRMED` falls out of the portal's `WHERE` set — every agency's next fetch drops it                                                                                                                                                        | None (but see R8 staleness) |
| Agency cancels → reappears in portal                  | `CONFIRMED → DISPATCHING (SYSTEM)` is already FSM-legal (`state-machine.service.ts:63`) and puts the row back in the `WHERE` set. The arrival-no-show `reDispatch` (`arrival-noshow.service.ts:125-176`) is the exact, battle-tested template | **Withdraw endpoint** (§3)  |

So the build is: **one claim endpoint + one withdraw endpoint + portal UI wiring** — everything else reuses
transitions that already exist and are already guarded.

---

## 2. Claim ("Accept job") — first-come-first-served

`POST /agents/me/open-jobs/:bookingId/accept` (company-only guard, mirroring `browseOpenJobs`'s
`agent.type==='company'` check, `agent.service.ts:755-757`; `Idempotency-Key: claim-<bookingId>` from mobile).

**One transaction** (all steps reuse existing code — see 🔒 note):

1. `SELECT ... FROM lite_bookings WHERE id=$1 FOR UPDATE` — the serialization point for every race in §5.
2. Status gate: require `dispatch_mode='auto'` and status ∈ `{OPS_APPROVED, DISPATCHING}`.
   - If `OPS_APPROVED`: flip → `DISPATCHING` first (FSM-legal SYSTEM transition, `state-machine.service.ts:49`).
   - If `PENDING_OPS`: **409 `job_not_approved`** — visible in the portal but not claimable until ops approves
     (render the card with a disabled "Awaiting ops approval" state).
3. Eligibility gate (server-side, claim-time): agency `ACTIVE`, DPA accepted, not suspended — reuse the
   ranking SQL's eligibility predicates minus distance/region (`dispatch.service.ts:122-183`). Region is
   deliberately NOT enforced (the portal is a cross-region browse; staging has
   `DISPATCH_DISABLE_REGION_FILTER` for the same reason).
4. Insert the claim's `dispatch_offers` row **directly as `ACCEPTED`** (rank 0, `responded_at=NOW()`)
   — _not_ `OFFERED` — so the 8-second offer-expiry sweep can never race it (see R7).
5. Run the **existing accept block verbatim** (`acceptTxn`, `dispatch.service.ts:1087-1210`): escrow hold /
   re-point (`:1140-1193`), the single-writer `UPDATE ... SET status='CONFIRMED',
assigned_provider_user_id=$2, crew_deadline_at=NOW()+15min WHERE id=$1 AND status='DISPATCHING'`
   (`:1194-1201`; 0 rows ⇒ 409 `job_taken`), supersede sibling `OFFERED` rows (`:1205-1210`), accept
   accounting, audit rows, `providerAccepted` client push (`accept()` `:1074-1084`).

**Mobile:** "Accept job" CTA on `OpenJobCard` (`OrgMissionsScreen.tsx:76-96` — today a dead `<View>`; copy the
`JobCard` press pattern `:98-142`) → on success navigate/refresh the Missions board where the job now sits in
`NEEDS CREW` → existing assign-crew sheet (`:249-267` → `POST /org/bookings/:bookingId/crew`) finishes the flow.
On 409 `job_taken`/`booking_state_changed_concurrently`: toast "Another agency took this job", remove the card,
refresh the feed.

> 🔒 **Arch stop-condition (same as the handoff §5):** this touches escrow + booking FSM. The claim **must**
> factor and call `acceptTxn`'s money+FSM block — `assigned_provider_user_id` has exactly **one writer** today
> (`dispatch.service.ts:1196`) and must stay that way. No parallel UPDATE, no new charge path.

---

## 3. Withdraw ("agency cancels") — relist to the portal

`POST /org/bookings/:bookingId/withdraw` (OrgManagerGuard, tenant-scoped: booking's
`assigned_provider_user_id` must equal the caller's org — same IDOR pattern as `assertOrgScope`).

**Model it 1:1 on `reDispatch`** (`arrival-noshow.service.ts:125-176`), which already performs this exact
relist safely:

1. `SELECT ... FOR UPDATE` the booking; require `status='CONFIRMED'` and caller = assigned provider.
2. Lock the non-ABORTED mission `FOR UPDATE` if one exists (`:141` — same booking→mission lock **order**;
   see R5 deadlock note):
   - **Phase 1 (recommended):** if a mission exists (crew already assigned) → **409 `crew_already_assigned`**
     — withdraw is pre-crew only. Post-crew exits stay with the existing paths (crew-edit F4 / ops abort).
   - **Phase 2 (optional):** allow pre-`PICKUP` withdraw by copying `reDispatch`'s mission-ABORT +
     stand-down-crew block — LM-B1's `missions_booking_active_uq` partial index (non-ABORTED rows only)
     makes the next agency's crew-assign work (verified live: `org-mission.service.ts:71-72,119-120`).
3. `this.fsm.assert('CONFIRMED','DISPATCHING','SYSTEM')` + the guarded UPDATE clearing
   `assigned_provider_user_id`, `crew_deadline_at`, resetting `dispatch_started_at`
   (`arrival-noshow.service.ts:147-155` verbatim).
4. Mark this agency's `ACCEPTED` offer `SUPERSEDED` (as `reDispatch` does) — this also feeds R9.
5. **Escrow: hold stays `HELD`** — client is never re-charged; the next claim **re-points** the hold via the
   existing Step-16 branch (`dispatch.service.ts:1179-1192`). Zero new money code.
6. After commit: audit row + client wake ("agency withdrew — searching again") + optionally re-enter
   `offerNext` when `AUTO_DISPATCH_ENABLED` (push offers and portal claims coexist safely — R3).
7. Require a `reason` string; count withdrawals into `reliability_breaches` (same field `reDispatch` bumps)
   so serial withdraw-ers rank lower / can be cooled down.

The moment step 3 commits, the booking is `DISPATCHING` → **back in every agency's portal feed automatically**.

---

## 4. Policy decisions (defaults chosen, flag if you disagree)

| #   | Question                                                                                                                                                 | Default in this spec                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Can the withdrawing agency re-claim its own relisted job?                                                                                                | **No** — claim excludes providers with a `SUPERSEDED/REJECTED/EXPIRED` offer on this booking (same exclusion the cascade uses, `dispatch.service.ts:182-183`) |
| P2  | Crew-SLA timeout (accepted, never crewed in 15 min): stays terminal `AGENCY_NO_SHOW` + full refund (`crew-sla.service.ts:143-172`, FSM `:58`) or relist? | **Keep terminal for now** (policy already shipped & refunds correctly). Optional later: relist with a `relist_count` cap (e.g. 2) then `NO_PROVIDER`+refund   |
| P3  | `PENDING_OPS` rows in the portal?                                                                                                                        | Keep visible, card disabled ("awaiting ops approval"); claim 409s server-side                                                                                 |
| P4  | Relisted-job shelf life                                                                                                                                  | New sweep: `DISPATCHING` + `dispatch_started_at` older than config TTL (e.g. 30–60 min) + no live offer → `noProvider()` — **but see R12 first (refund gap)** |

---

## 5. Race-condition analysis

Legend: ✅ = safe with existing machinery · 🔧 = safe only if the fix follows the prescription · 🐞 = real gap
found (pre-existing or widened by this feature).

### R1 — Two agencies tap Accept on the same job simultaneously ✅🔧

Both claims hit `SELECT ... FOR UPDATE` on the booking (§2 step 1) — Postgres serializes them. The winner's
UPDATE flips `DISPATCHING→CONFIRMED`; the loser's status gate (or the `WHERE status='DISPATCHING'` conditional,
0 rows) throws → **409 `job_taken`**. Belt-and-braces: `dispatch_offers_one_live_per_booking` prevents two live
offer rows, and the escrow idempotency anchor (`SELECT booking_id FROM escrow_holds` under the booking lock,
`dispatch.service.ts:1147-1151` + `ON CONFLICT (booking_id) DO NOTHING` `:1176`) makes a double-charge
structurally impossible. **Exactly one agency wins; the client is charged exactly once.**

### R2 — Claim vs. client-cancel at the same instant ✅

Same shape as the fixed LM-B4 TOCTOU (go-live vs cancel). Both paths take the booking row lock and run
status-guarded conditional UPDATEs — one wins:

- Cancel wins → booking `CANCELLED` → claim's gate sees a non-claimable status → 409; no charge ever happens
  (escrow runs _after_ the gate, inside the same txn that would roll back).
- Claim wins → booking `CONFIRMED` → the client's cancel re-checks under its own lock (`booking.service.ts`
  `FOR UPDATE` + `CANCELLABLE` re-check, per the LM-B4 fix) and follows the post-accept refund/window policy.

### R3 — Claim vs. auto-dispatch offer-accept (both engines live) ✅

If `AUTO_DISPATCH_ENABLED` and agency X holds a live `OFFERED` row while agency Y claims from the portal: both
serialize on the booking lock. If Y's claim commits first, it **supersedes X's OFFERED row** in the same txn
(`:1205-1210`); X's accept then fails the offer-win conditional (`WHERE status='OFFERED'`, `:1107-1111`) →
neutral `offer_not_available` → X's IncomingOffer shows its existing "passed" state. If X accepts first, Y's
claim 409s `job_taken`. **The two accept surfaces compose without new locking.**

### R4 — Double-tap / network-retry by the same agency ✅

`Idempotency-Key: claim-<bookingId>` (same pattern as `accept-${offerId}` / `crew-${bookingId}`,
`api.ts:923-926,1555-1560`) collapses retries onto the first response; a genuinely second attempt finds
`status≠'DISPATCHING'` → 409, mapped to a friendly "already yours — check Missions" when
`assigned_provider_user_id` is the caller.

### R5 — Withdraw vs. crew-assign (two managers of the same org) 🔧

Both must serialize on the booking row. `assignCrew`'s gate is a conditional UPDATE on `lite_bookings`
(acquires the row lock; `org-mission.service.ts:274`), and withdraw takes `FOR UPDATE` explicitly — so one
always sees the other's outcome: crew-assign wins → withdraw 409 `crew_already_assigned` (Phase 1); withdraw
wins → crew-assign's gate finds `status≠'CONFIRMED'` → existing `booking_not_assignable` error, already mapped
in the UI (`OrgMissionsScreen.tsx:36`). **Deadlock discipline:** withdraw must lock **booking first, then
mission** — the same order as `reDispatch` (`arrival-noshow.service.ts:127-141`) and `assignCrew`. Never invert.

### R6 — Withdraw vs. crew-SLA cron firing at the 15-min deadline ✅ (policy note)

Both are `CONFIRMED → X` status-guarded transitions under the booking lock — exactly one wins. Withdraw wins →
relist (hold stays HELD). SLA wins → `AGENCY_NO_SHOW`, terminal + full refund (`crew-sla.service.ts:143-172`).
Divergent outcomes are acceptable under P2's default; revisit if P2 flips to relist-with-cap.

### R7 — Claim vs. the 8-second offer-expiry sweep 🔧 (designed away)

The sweep expires only `status='OFFERED'` rows (`expire()`, `dispatch.service.ts:864-887`). §2 step 4 inserts
the claim's offer row **directly as `ACCEPTED` inside the claim txn**, so there is no OFFERED window for the
sweep to race. Do **not** implement claims as "insert OFFERED, then accept it" — that recreates the TTL race
the 2-second accept-grace only papers over.

### R8 — Stale portal on other devices ("ghost jobs") 🐞 UI gap, must fix with this feature

`OrgMissionsScreen`'s 10-second focus poll refreshes **only the missions board** (`load()`,
`OrgMissionsScreen.tsx:216-220`); the portal feed (`loadOpen`) refreshes only on mount, region-chip change, or
pull-to-refresh (`:191-194,286`). A job claimed elsewhere lingers on other agencies' screens indefinitely; their
Accept then 409s. Fix: (a) poll `loadOpen()` on the same interval (or piggyback the new standalone
JobPortalScreen with its own 10 s poll), and (b) on 409 `job_taken`, remove the card locally + trigger a refetch.
Server-side correctness is unaffected — this is purely presentation staleness.

### R9 — Withdrawing agency instantly re-claims its own job ✅ (by policy P1)

Withdraw marks the agency's offer `SUPERSEDED` (§3 step 4); the claim eligibility check reuses the cascade's
exclusion (`dispatch.service.ts:182-183`), so the same org can't ping-pong the job. The auto-cascade already
excludes them for the same reason.

### R10 — Escrow across claim → withdraw → re-claim ✅ (existing Step-16 machinery)

First claim: client debited once, hold `HELD` (`:1140-1178`). Withdraw: hold untouched. Second agency's claim:
the `existing` branch **re-points** the hold (`UPDATE escrow_holds SET offer_id=$2, provider_user_id=$3 WHERE
booking_id=$1 AND status='HELD'`, `:1187-1191`) — release pays the agency that actually serves. Idempotency
anchor guarantees no second debit (`:1147-1151`). **No new money code, no double-charge, no orphaned credits
in this loop.**

### R11 — Withdraw after a mission exists (Phase 2 only) ✅ with LM-B1 fix (verified live)

Historic trap: `missions.booking_id` UNIQUE dead-ended any relist after a mission existed (LM-B1). The shipped
fix replaced it with `missions_booking_active_uq` (unique on non-ABORTED only) and newest-non-ABORTED reads
(`org-mission.service.ts:71-72,119-120`). `reDispatch` already exercises exactly this abort-mission-and-relist
path in production. Phase 2 withdraw must copy `reDispatch` wholesale (mission ABORT + crew stand-down +
waypoint/deploy-check reset), not reimplement.

### R12 — Relisted job that nobody re-claims 🐞 **money gap — found by this analysis, pre-existing**

A relisted booking is `DISPATCHING` **with a persisted `HELD` hold** — violating the codebase's founding
assumption that a DISPATCHING booking is uncharged ("money only moves at accept", `dispatch.service.ts:923-924`):

- `noProvider()` flips `DISPATCHING → NO_PROVIDER` and **never touches `escrow_holds`**
  (`dispatch.service.ts:889-921`) → the client's credits strand `HELD` forever on a terminal booking.
- This hazard **already exists today** on the arrival-no-show relist path (cascade exhausts → `noProvider()`);
  agency-withdraw + the P4 shelf-life sweep widen its surface.
- **Required with this feature:** teach `noProvider()` (and verify `BookingService.cancel`'s
  DISPATCHING-with-hold branch, `booking.service.ts:608-740`) to refund a `HELD` hold when one exists —
  `HELD → REFUNDED` is a legal hold transition (`20260620000002_escrow_integrity.sql`). Add a test:
  claim → withdraw → TTL sweep → `NO_PROVIDER` → hold REFUNDED, wallet balance restored.

### R13 — Claim on a `PENDING_OPS` job (ops hasn't approved yet) ✅ by §2 step 2

Server-side status gate 409s; the card is disabled client-side. Ops approval later flips it claimable — no race:
approval (`OPS_APPROVED`) and claim serialize on the booking row like everything else.

---

## 6. Implementation checklist

**Backend (`apps/auth-service`)**

1. `DispatchService.claimOpenBooking(bookingId, providerUserId)` — §2 (factor `acceptTxn`; 🔒 arch review).
2. `POST /agents/me/open-jobs/:bookingId/accept` controller route (company guard + IdempotencyInterceptor).
3. `OrgMissionService.withdrawBooking(orgUserId, bookingId, reason)` — §3 (clone `reDispatch`, Phase 1 gate).
4. `POST /org/bookings/:bookingId/withdraw` (OrgManagerGuard).
5. R12 fix: refund `HELD` hold in `noProvider()`; verify client-cancel path.
6. (P4) relist shelf-life sweep, only after R12 lands.
7. `browseOpenJobs`: add `can_accept` (status+eligibility) and `claimed_by_me` hints to the DTO.

**Mobile** 8. `agentApi.acceptOpenJob(bookingId)` + `orgApi.withdrawBooking(bookingId, reason)` in `src/services/api.ts`. 9. Accept CTA on `OpenJobCard` + 409 handling + feed poll fix (R8). 10. Withdraw affordance on the `NEEDS CREW` card / `OrgMissionDetail` (confirm dialog + reason sheet —
reuse the decline-reason chip pattern planned in LM-A3). 11. Standalone `JobPortalScreen` + dashboard menu entry — already specced in the handoff §5 Fix B.

**Tests (concurrency-first — mirror `dispatch.service.spec.ts` patterns)**

- Two parallel claim txns → exactly one `CONFIRMED`, one 409, single escrow debit (R1).
- Claim ∥ client-cancel; claim ∥ offer-accept; withdraw ∥ assignCrew; withdraw ∥ crew-SLA (R2/R3/R5/R6).
- claim → withdraw → second-agency claim → hold re-pointed, no double charge (R10).
- claim → withdraw → sweep → `NO_PROVIDER` → hold refunded (R12).
- Withdrawing org excluded from re-claim (R9). Portal feed drops/regains the row across the cycle (§1).

**Gates:** `npm test -- --selectProjects=booking` · mobile `npm run typecheck` ≤ baseline 47 · device smoke:
two agency devices — A and B both see the job; A accepts → B's portal drops it (≤10 s) + B's accept 409s
cleanly; A assigns crew; separately A withdraws → job reappears on B; B accepts and crews it.

---

## 7. Files

| Concern                   | File(s)                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claim txn to factor/reuse | `apps/auth-service/src/dispatch/dispatch.service.ts:1087-1210` (single writer `:1194-1201`; escrow `:1140-1193`; supersede `:1205-1210`) |
| Relist template           | `apps/auth-service/src/dispatch/arrival-noshow.service.ts:125-176`                                                                       |
| FSM transitions reused    | `apps/auth-service/src/booking/state-machine.service.ts:49,52,58,63`                                                                     |
| Portal feed               | `apps/auth-service/src/agents/agent.service.ts:748-796`; `src/services/api.ts:691-693,1028-1042`                                         |
| Missions buckets          | `apps/auth-service/src/org/org-mission.service.ts:53-98`                                                                                 |
| R12 refund gap            | `apps/auth-service/src/dispatch/dispatch.service.ts:889-921`; `apps/auth-service/src/booking/booking.service.ts:608-740`                 |
| Portal UI + poll gap      | `src/screens/agent/OrgMissionsScreen.tsx:76-96,191-220,286,324-350`                                                                      |
| Crew-SLA policy (P2)      | `apps/auth-service/src/dispatch/crew-sla.service.ts:143-172`                                                                             |
