# Lite CPO Booking — Module Verification Loop

> **Run this loop EVERY time you touch the Lite (auto-dispatch) CPO booking module** — before
> you start (baseline) and after any change (regression). It is the module-specific companion
> to the repo-root `LOOP.md`: the root loop tells you _how_ to work; this loop tells you _what
> to prove works_ for Lite booking, across all three actors + money + notifications.
>
> **Golden rule:** a Lite-booking change is not "done" until **every lane below is green on a
> 3-device run** (client + agency + CPO) OR you have explicitly stated which lane you could not
> exercise and why. Type-checks and unit tests prove code correctness, **not** flow correctness.

**Owner docs:** flow = `docs/qa/LITE_BOOKING_SIMULATION_A_TO_Z.md`; current bug state =
`docs/audits/LITE_BOOKING_CLIENT_BUGS_AUDIT_2026-07-11.md` (B-82) + `sqa.md`; deep plan =
`docs/planning/LITE_MISSION_AUDIT_AND_IMPROVEMENT_PLAN.md`.

---

## 0. When this loop applies (trigger files)

Run it if your change touches any of:

- **Client:** `src/screens/booking/**`, `src/screens/liveops/LiveTrackingScreen.tsx`,
  `src/store/bookingStore.ts`, `src/screens/booking/bookingStatus.ts`,
  `src/services/api.ts` (booking/dispatch/verify methods), `src/screens/auth/OTPVerificationScreen.tsx`.
- **Agency (service provider):** `src/screens/agent/**` (Dashboard, IncomingOffer, OrgMissions,
  OrgMissionDetail, AgentLiveTracker, OrgRoster, Earnings).
- **CPO:** `src/screens/cpo/**` (OnDutyHome, AssignedMissionDetail, CpoLiveTracker), `AgentLiveTrackerScreen`.
- **Backend:** `apps/auth-service/src/{dispatch,booking,org,agents,ops,wallet,escrow}/**`,
  `apps/auth-service/src/ops/booking-push-bridge.service.ts`, and any `supabase/migrations/**`
  touching `lite_bookings`, `missions`, `mission_crew`, `dispatch_offers`, `escrow_holds`.
- **Notifications:** `src/modules/**/serverWakeNotifications.ts`, `fcmBootstrap.ts`,
  `apps/auth-service/src/push/**`.

---

## 1. The flow in one screen (reference)

```
CLIENT books ──► DISPATCHING ──► (offer) ──► AGENCY accepts ──► CONFIRMED (escrow HELD)
   │                                                              │
   │                                          AGENCY assigns crew ▼  mission DISPATCHED
   │                                                              │
CLIENT watches (live) ◄── CPO: Pickup ─► PICKUP ─► Go-Live ─► LIVE ─► Complete ─► COMPLETED
                                                              │
                                          escrow RELEASED ► agency wallet (payout)
```

**Booking FSM** (`booking/state-machine.service.ts`): `DRAFT → DISPATCHING → CONFIRMED → LIVE → COMPLETED`;
branches `→ NO_PROVIDER`, `→ AGENCY_NO_SHOW`, `CONFIRMED → DISPATCHING` (re-dispatch), `* → CANCELLED` (window-gated).
**Mission FSM** (`ops/mission-state-machine.service.ts`): `DISPATCHED → PICKUP → LIVE → COMPLETED` (+ `SOS`, `ABORTED`).
**Key invariant:** the booking stays `CONFIRMED` while the mission advances — the client only
sees `DISPATCHED/PICKUP/LIVE` via `mission_status` on `GET /bookings/:id` (**not** on the list).

**Endpoint map (auto path):** `POST /dispatch/request` → `POST /dispatch/offers/:id/accept` →
`POST /org/bookings/:bookingId/crew` → `POST /agents/me/missions/:id/{pickup,go-live,complete}` →
client `GET /bookings/:id` (poll) · `GET /bookings/:id/verify-code` · `POST /bookings/:id/cancel`.

---

## 2. The loop (run in order)

```
Baseline ─► Exercise the 5 lanes ─► Automated gates ─► Data + log probes ─► Regression watchlist ─► Sign-off
   ▲                                                                                                  │
   └──────────────────────────── fix, then re-run the affected lane ◄───────────────────────────────┘
```

For each lane: do the **action**, confirm the **expect**, and actively look for the **watchpoint**
(a known failure mode — if you see it, it's a bug: log it in `sqa.md` and stop the lane).

---

### Lane A — CLIENT (user) POV

The user must: **book → cancel while waiting → move around freely → get a notification at every
step → get the team (verify) code → be charged the correct amount.**

| #   | Action                                                                                                   | Expect                                                                             | Watchpoint (known bug)                                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1  | Book a Secure Transfer (now), pay screen → Submit                                                        | booking `DISPATCHING`; "Finding your detail…"                                      | throttle 429 shown raw on rapid re-submit                                                 |
| A2  | The **price on the paywall == the amount actually deducted**                                             | credits debited == quoted **total** (not per-hour)                                 | **LM-M1**: per-hour shown, total charged                                                  |
| A3  | While `DISPATCHING`, tap **Cancel**                                                                      | free cancel; booking `CANCELLED`; **full refund** to credits; offers superseded    | **LM-B2/B8**: dangling offer benches the agency; created-at cancel window traps scheduled |
| A4  | Re-book; **background / kill / reopen** at each stage (DISPATCHING, CONFIRMED, DISPATCHED, PICKUP, LIVE) | app resumes to the **right live screen** every time; never a dead "assigning team" | **LB-OTP1 / LB-ST2**: resume lands on BookingConfirmation, Track greyed, stuck            |
| A5  | Watch the **dashboard/home** during dispatch → live                                                      | status advances (Searching → Team en route → Protection active)                    | **LB-ST1**: home polls nothing + shows frozen `CONFIRMED`                                 |
| A6  | On LiveTracking during `DISPATCHED/PICKUP`                                                               | **6-digit verify (team) code shows** and matches the CPO's                         | **LB-OTP1/2/4**: card unreachable / permanent dots / 400 no_crew_assigned                 |
| A7  | **Notification at each step**: accepted, crew assigned, en route, live, completed, refund/cancel         | a push (foreground + **killed-app**) lands for every transition                    | **LM-N4**: completion, refund, crew-assigned, escrow are **silent** today                 |
| A8  | Mission completes                                                                                        | routes to MissionComplete → rate → invoice/receipt                                 | **LB-ST3**: after 30-min poll cap, completion never routes                                |
| A9  | Try to cancel once **LIVE**                                                                              | **blocked** (cannot cancel a live protection detail)                               | **LM-B4**: LIVE-cancel TOCTOU strands the principal                                       |

---

### Lane B — AGENCY (service provider) POV

The agency must: **get the job → assign a CPO → monitor the mission → receive a smooth
top-up / payout distribution.**

| #   | Action                                                                   | Expect                                                                            | Watchpoint                                                                    |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| B1  | Agency app open + dispatch-eligible (DPA accepted + region set + ≥1 CPO) | Incoming Offer card appears (area, price, 30 s countdown)                         | candidate pool empty if `dpa_accepted_at IS NULL` → `NO_PROVIDER`             |
| B2  | Offer wakes a **backgrounded/killed** agency app                         | high-priority push + deep-link to IncomingOffer                                   | **LM-N1**: `dispatchOffer` wake not routed to a killed app                    |
| B3  | **Accept** before timer                                                  | booking `CONFIRMED`; escrow **HELD**; 15-min crew SLA starts; siblings superseded | affordability error leaks client `insufficient_credits` to agency (**LM-B7**) |
| B4  | **Assign a CPO** (assign sheet → lead → confirm)                         | mission `DISPATCHED`; crew + waypoints + deploy checks; `is_lead=TRUE` set        | assign-sheet availability is guesswork (no on-duty/armed truth)               |
| B5  | **Monitor** the live mission (monitor mode)                              | live map + status pills track PICKUP→LIVE→COMPLETED; SOS visible                  | frozen nav-param snapshot; monitor hides SOS (**LM-A1/F5**)                   |
| B6  | Crew never assigned within 15 min                                        | `AGENCY_NO_SHOW` → **auto full refund** to client                                 | —                                                                             |
| B7  | **Top-up / distribution:** after completion + dispute window             | escrow **RELEASED** → agency wallet (gross/fee/net); payout smooth                | **LM-B3**: waypoint-advance sets `review_required` → sweep never releases     |
| B8  | Wallet top-up                                                            | credits minted (no Stripe at booking)                                             | without `STRIPE_SECRET_KEY`, top-ups mint free credits (staging)              |

---

### Lane C — CPO POV

The CPO must: **receive the assigned job → run a live mission → real-time GPS → control the
mission (pickup / go-live / complete).**

| #   | Action                                | Expect                                                                              | Watchpoint                                                                             |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1  | CPO On Duty; agency assigns them      | "New mission" → AssignedMissionDetail (pickup, dropoff, deploy checks, verify code) | OnDuty tab loads once; no deep-link to the mission (**LM-C1/N2**)                      |
| C2  | Killed-app mission-dispatched push    | wakes + deep-links to the mission                                                   | iOS gets zero server wakes (**LM-N3**)                                                 |
| C3  | Tap **Pickup** (within 20 min)        | mission `DISPATCHED → PICKUP`; `pickup_at` stamped; client verify code matches      | advance via waypoint/telemetry path **doesn't** stamp / flip booking (**LM-B3**)       |
| C4  | **Real-time GPS** on the live tracker | CPO dot moves on the client's + agency's map at ~10 s cadence; ETA updates          | GPS only while tracker modal open; background location no-op (**LM-C5**)               |
| C5  | Tap **Go-Live**                       | mission `PICKUP → LIVE`; booking `CONFIRMED → LIVE`                                 | go-live gate: deploy checks never enforced (**LM-C2**)                                 |
| C6  | Tap **Complete**                      | mission+booking `→ COMPLETED`; escrow release starts                                | **B-76**: session revoke / 15 s timeout / uncaught escrow settle → "Could not advance" |
| C7  | Lead phone dies mid-mission           | any crew can request completion → agency confirms                                   | lead-only finish = dead end (**LM-C7**)                                                |
| C8  | SOS during mission                    | SOS reaches agency + ops; CPO can close a de-escalated SOS                          | lead can't close SOS (**LM-B10**)                                                      |

---

### Lane D — MONEY (escrow → payout) — must be **accurate**

| #   | Check                                                | Expect                                                                         |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1  | quoted total == escrow `HELD` == client wallet debit | equal to the cent (**LM-M1** guard)                                            |
| D2  | cancel (pre-crew / post-crew / no-show / abort)      | correct refund/split; wallet **conserved** (sum in == sum out)                 |
| D3  | completion                                           | escrow `HELD → PENDING_RELEASE → RELEASED`; agency wallet credited gross − fee |
| D4  | reconciliation cron                                  | daily read-only reconciliation green; no stranded `HELD` holds                 |
| D5  | no double-charge / double-payout                     | idempotency keys honored; re-tap is a no-op                                    |

---

### Lane E — NOTIFICATIONS — **everyone gets one at every step**

The user's requirement: _every actor gets a notification at every step._ Verify a push
(foreground **and** killed-app) fires for each event, and that tapping it deep-links.

| Event                                                             | To           | Status today                                           | Must be              |
| ----------------------------------------------------------------- | ------------ | ------------------------------------------------------ | -------------------- |
| offer                                                             | agency       | push exists, wake not routed to killed app (**LM-N1**) | wakes + deep-links   |
| provider accepted / re-dispatching / no-provider / agency-no-show | client       | push exists                                            | ✅ + deep-link       |
| crew assigned ("detail being prepared")                           | client       | **silent** (CPO-only) (**LM-N4**)                      | add push             |
| mission dispatched / aborted                                      | CPO          | push exists (android)                                  | ✅ + iOS (**LM-N3**) |
| en route / go-live / complete                                     | client       | poll-only, no push                                     | add push             |
| escrow released                                                   | agency       | **silent**                                             | add push             |
| refund issued / dispute open-resolve                              | both         | **silent**                                             | add push             |
| SOS                                                               | agency + ops | crew-only today (**F5**)                               | fan-out to agency    |

> Notification bridge lives in `apps/auth-service/src/ops/booking-push-bridge.service.ts`; tap
> routing in `src/modules/**/serverWakeNotifications.ts` + `fcmBootstrap.ts`. No push tap
> deep-links today except chat/call (**LM-N2**).

---

## 3. Automated gates (run these on every change)

```bash
# Mobile (client) booking logic + types
npm test -- --selectProjects=booking          # jest projects: app | messenger-crypto | booking
npm run typecheck                              # must stay ≤ 47 baseline (.tsc-baseline.json)
npm run lint                                    # (or lint:fix) on changed files

# Backend (dispatch / booking / org / ops / escrow)
cd apps/auth-service && npm test               # runs dispatch.*.spec, org-mission.*.spec, booking.*, ops.*, escrow-*, crew-sla, arrival-noshow
cd apps/auth-service && npm run build          # nest build must pass
```

Targeted-first when iterating a single area, e.g.:
`cd apps/auth-service && npm test -- dispatch.claim-withdraw arrival-noshow crew-sla escrow-release-sweep`.

> Backend booking-flow specs have carried **3 pre-existing failures on some HEADs** — confirm
> they are pre-existing (git stash + run on clean HEAD) before blaming your change.

---

## 4. Data probes (staging — Supabase MCP)

Run before/after a backend change; drift here = a real flow leak.

```sql
-- status distribution (funnel health)
SELECT status, count(*) FROM lite_bookings GROUP BY status ORDER BY 2 DESC;
-- booking↔mission drift (LM-B3 / drift janitor should keep this empty)
SELECT b.id, b.status, m.status AS mission_status
  FROM lite_bookings b JOIN missions m ON m.booking_id=b.id
 WHERE b.status='CONFIRMED' AND m.status IN ('LIVE','COMPLETED');
-- stranded escrow (money leak)
SELECT status, count(*) FROM escrow_holds GROUP BY status;
SELECT * FROM escrow_holds WHERE status='HELD' AND created_at < now()-interval '1 day';
-- verify-code readiness: every active mission has a lead (LB-OTP4)
SELECT m.id FROM missions m
 WHERE m.status IN ('DISPATCHED','PICKUP','LIVE')
   AND NOT EXISTS (SELECT 1 FROM mission_crew mc WHERE mc.mission_id=m.id AND mc.is_lead=TRUE AND mc.status<>'off');
-- offers rotting (cascade health)
SELECT status, count(*) FROM dispatch_offers GROUP BY status;
```

Also check advisors: `mcp__supabase__get_advisors` (security + performance) after any migration.

---

## 5. Log / device probes

- **Client API health (LB-API1):** watch for the token-clear cascade — `adb logcat | grep -E "\[api\].*(refresh failed|clearing tokens|No refresh token)"`.
  Any `clearing tokens` on a **network/timeout/502** (not a real `token_revoked`) is the LB-API1 bug.
- **Backend (Contabo, SSH):** `docker logs bravo-staging-auth --since 30m | grep -E "no_crew_assigned|review_required|settleEscrow|AGENCY_NO_SHOW|missionComplete"`.
- **Killed-app push:** send an offer / mission-dispatched to a force-stopped app on the Redmi/Pixel and confirm delivery (per `dev-phone-and-build-setup`).
- **GPS realtime (Lane C4):** on `/live` (ops or client map) confirm the CPO dot advances; `adb logcat | grep -Ei "watchPosition|telemetry|/live"`.

---

## 6. Regression watchlist (must NOT reappear)

Before declaring done, re-confirm each **B-82** finding is still fixed / not reintroduced
(`docs/audits/LITE_BOOKING_CLIENT_BUGS_AUDIT_2026-07-11.md`):

- **LB-OTP1** verify card reachable on resume + fast advance · **LB-OTP2** card has a real error state
- **LB-OTP3** login OTP surfaces (`devOtpCode` / SMS autofill) · **LB-OTP4** marketplace/job-board crew has `is_lead`
- **LB-API1** refresh failure does **not** wipe tokens on a network blip · booking screens route on `isAuthLostError`
- **LB-ST1** dashboard polls + shows `mission_status` · **LB-ST2** confirmation stepper advances · **LB-ST3** long-mission completion still routes
- Prior P0s from the plan: **LM-B1** re-dispatch dead-end · **LM-B3** dual advance path · **LM-B4** LIVE-cancel · **LM-M1** price==charge.

---

## 7. Sign-off (exit criteria)

The change is done only when ALL are true:

- [ ] Lanes A–E exercised on a **3-device run** (client + agency + CPO), golden path + ≥1 error path (offline / no-provider / abort / cancel).
- [ ] Client is **charged exactly the quoted total**; wallet conserved on every cancel/refund/payout.
- [ ] The **verify (team) code** shows for the client and matches the CPO.
- [ ] A **notification fired at every step for every actor** (or the still-silent ones are documented as known LM-N4 gaps, not new regressions).
- [ ] `npm test -- --selectProjects=booking` + `apps/auth-service` tests green; `npm run typecheck` ≤ 47; lint clean.
- [ ] SQL probes (§4) show no new booking↔mission drift and no stranded `HELD` escrow.
- [ ] If a backend change: **Contabo `auth-service` redeployed** (rebuild via `docker-compose.staging.yml`; honor the messenger JWT-drift rule if auth env changed) and `/ready` green.
- [ ] Any new failure logged in `sqa.md` with a bug number; the audit doc updated if a root cause changed.

> If any lane cannot be exercised in the current environment (e.g. native GPS needs a device),
> **say so explicitly** — do not claim the lane passed.
