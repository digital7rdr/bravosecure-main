# Production Sync & Readiness Audit — Secure Transfer · Executive Protection · Secure Pro

**Date:** 2026-08-05 · **Method:** founder-mandated 3-agent trio (critic / edge-cases /
regression+distribution), every P0/P1 claim re-verified first-hand against both sides of the
code before inclusion. Static contract audit + live staging probes; **no device lane was
exercised** (no phone attached).

**Question asked:** are all functions perfectly synced with all endpoints, and will
production go smoothly?

**Answer in one line:** the API contracts are in materially good sync (every mobile and
ops-console call maps to a live route; zero path/verb/DTO mismatches on shipped flows) —
but production is **NO-GO until the rogue deploy machine is fenced** (it wiped staging
twice in 24 h, the second time DURING this audit), and five product-level gaps
(one dead officer-response seam, silent crewed-cancel, missing client escrow controls,
one raw money error, dark notification backfills) should be scheduled consciously.

> ## ⚑ REMEDIATION STATUS — 2026-08-05, same session
>
> **A second trio ran over the FIX DIFF and found six regressions in the fixes
> themselves** — all corrected before commit. Three would have shipped user-visible
> damage: Pro "COVERED UNTIL" rendering a day late (the field's meaning changed to
> an exclusive end; a derived `covered_until` column now serves every display), an
> ops-deactivated add-on becoming an unrecoverable wizard dead-end (the new server
> reject needed the client to FILTER, not just re-price), and a deliberate same-day
> re-subscribe silently no-op'ing behind a day-bucketed idempotency key. Also fixed:
> a declined officer could never un-decline, an agency that had accepted but not yet
> crewed still got no cancel wake, and the `dispute-opened` wake tapped into a screen
> that does not exist in the agency shell. **This is why the trio runs on the fix,
> not just on the audit.**
>
> **All ten bugs (B-377…B-386), B-387 (found during migration prep — see below), and
> the whole P2/P3 tail (C-4…C-8, E-9…E-14, R-3, R-4, R-6) are FIXED**, trio-reviewed,
> and pinned by four new regression suites
> (`booking.executive-validation`, `serverWakeKindParity`, `transferTime`,
> `auditFixPins`). Gates at fix time: booking 575 · auth-service 1993 ·
> messenger-crypto 4155/411 suites (clean run; run 2's lone failure passes in
> isolation = the known B-126 moving flake) · app messenger screens 175 · mobile
> tsc ≤ baseline · auth-service tsc 0 · lint 0 errors. Migration
> `20260805013000_audit-fixes-b377-b386.sql` ships with it. Per-fix detail: `sqa.md`
> B-377…B-386 and `docs/planning/BUILD_RUNBOOK.md` (2026-08-05 entry).
>
> **The NO-GO blocker below is UNCHANGED and remains founder-only** (rotate the key
> or make that machine pull). Its damage window is now contained to ≤5 min by the
> box-side self-heal watchdog + post-deploy feature probes — see §0.
>
> **B-387 — a real money finding surfaced while preparing the migration.** A
> read-only probe of the live ACTIVE Pro plans showed the founder's own plan
> (4 000 BC paid for 2026-08-03 → 2026-11-03) carrying `current_period_end =
activated_at + 30 days`, i.e. dated to expire **two months early**, taking his
> family members' access with it. No committed code writes a 30-day period there —
> his activation hit an intermediate build during the 2026-08-03 Pro session. The
> migration was rewritten to DERIVE the period from the paid proposal
> (`coverage_end + 1 day`), which repairs this and B-383 in one value-idempotent
> statement. Full entry: `sqa.md` B-387.
>
> **Device pass is still NOT exercised** (no phone attached this session).

---

## 0 · LIVE INCIDENT DURING AUDIT — the #1 production risk demonstrated itself

**B-376 recurrence #2.** At 00:14 IST tonight — hours after the first restore — the same
stale machine deployed again: sshd logged its **ED25519 key
(`SHA256:LmTaeKZnQf2ynlViKjw1rnqwroq1I1IvHXwcTALZNv0`) from `82.38.84.176`** at
00:14:00/00:14:09/00:15:46; the stale image built 00:14:25 and went live 00:14:27.
`/pro-applications/me` 404'd again, `calculateExecutive` vanished from dist, box tree
reverted to July. **This time their build SUCCEEDED** (their pure checkout compiles), so
the stale image actually served — worse than recurrence #1 where the broken build left the
good container running.

Restored again at ~00:5x IST (envs backed up, poisoned dirs **quarantined** to
`/home/admin/quarantine-stale-20260805/`, clean tree re-extracted from main `61fa10d`,
rebuild was 100% cache-hit = byte-identical to the verified good image). Probes green:
pro-applications 401, hourly-checkin 401, dist-has-pro, healthy. Tripwire note left at
`/home/admin/bravo/STOP--STALE-DEPLOY--READ-ME.md`.

**Containment added after this incident (2026-08-05):**

1. `deploy-staging.sh` now runs **feature-route probes** after the health check —
   auth-service must answer `/pro-applications/me` with 401, not 404 — and refreshes a
   box-side pristine snapshot after every green deploy.
2. A **self-heal watchdog** runs on the box every 5 minutes
   (`/home/admin/bravo-watchdog/watchdog.sh`, cron). It fires only on the stale
   signature (`/ready` 200 **and** `/pro-applications/me` 404, or the `pro-applications`
   source directory missing), then quarantines the poisoned tree, restores the snapshot,
   and rebuilds. Verified both ways: silent no-op on a healthy box, and a forced run
   restored the service to `ready=200 / feat=401`.
3. A tripwire note sits at `/home/admin/bravo/STOP--STALE-DEPLOY--READ-ME.md` (box-root
   files survive the per-service rsyncs).

This caps the outage window at ~5 minutes; it does **not** remove the cause.

**Why the guard didn't save us:** the stale-checkout guard (61fa10d) lives in the repo —
the rogue machine runs a **pre-guard copy** of `deploy-staging.sh`. No code change can fix
this. **Founder action required (pick one):**

1. Remove/rotate that ED25519 key from the box's `~/.ssh/authorized_keys` (identify the
   owner via the fingerprint above — evidence suggests the same machine as the `siraajul`
   iOS pushes), or
2. Get that machine to `git pull --rebase origin main` once (the guard then protects every
   future run).

Until then, **any deploy from that machine re-wipes staging** — and the same class of
accident would take production down the day it exists.

---

## 1 · Endpoint sync verdict (critic agent, verified)

Global validation context: `ValidationPipe {whitelist: true, forbidNonWhitelisted:
STRICT_VALIDATION}` — strict on staging, strip-mode in prod default. **Every client body
field was checked against its DTO: zero undeclared fields** → no 400-on-staging /
silent-strip-in-prod divergence on any shipped flow. Every idempotency key the mobile app
sends matches the interceptor's format gate and targets a route that mounts the
interceptor; the money double-submit paths (pay-with-credits, offer accept, pro activate,
hourly check-in) are interceptor + DB-constraint protected.

| Surface                                           | Verdict                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lite booking (19 client routes)                   | **SYNCED** — incl. cancel, rating, verify-code, not-my-guard; `list` params ignored server-side (C-6, P2)                                                        |
| Agent/CPO mission lifecycle (25+ routes)          | **SYNCED** — incl. hourly-checkin full contract (idempotency key read, error codes `hour_not_elapsed`/`lead_only` handled on-screen)                             |
| Dispatch offers / claim / withdraw / room-intents | **SYNCED** — CoarseOffer carries `task_type`/`has_transport`                                                                                                     |
| Org/agency (20+ routes)                           | **SYNCED**                                                                                                                                                       |
| Executive Protection cross-cut                    | **SYNCED** — add-on catalogue ids+rates byte-identical client↔server; create/estimate validation mirrored; `hourly_checkins` served to all four reader endpoints |
| Secure Pro (10 client + 19 ops routes)            | **SYNCED** — DTOs match incl. services allow-list                                                                                                                |
| Family (12 routes)                                | **SYNCED** — shapes + error codes mapped in UI                                                                                                                   |
| Ops-console fetch layer (~80 paths)               | **SYNCED** — zero 404 paths                                                                                                                                      |

### Verified contract findings

- **C-1 [P1] Officer accept/decline endpoint has no client.** `POST
/agents/me/missions/:id/respond` (agent.controller.ts:392) is the ONLY writer of
  `mission_crew.accepted_at` (agent.service.ts:1327) — and no shipped screen calls it.
  `clientMissionStatus` (booking.service.ts:831-868) therefore never reports DISPATCHED:
  the client rail shows "Accepted · assigning team" through the entire dispatched phase,
  then jumps to PICKUP. The officer has no accept/decline UI at all. _(Merges with R-1 —
  same seam, see §2.)_
- **C-2 [P1] Client escrow controls unreachable.** `POST /bookings/:id/confirm-complete`,
  `POST /bookings/:id/dispute`, `GET /bookings/:id/escrow` have zero mobile callers (the
  only client `/dispute` call is attendance's). A client who had a bad mission cannot
  dispute before the sweep auto-releases escrow to the agency; money moves on timer alone.
- **C-3 [P1] `family_spend_limit_exceeded` renders raw.** Thrown at
  booking.service.ts:469 (auto create) and :645 (pay-with-credits); zero client handlers —
  a capped family member sees the snake_case code as the alert text, on both the exec
  wizard (ExecReviewScreen:165) and the standard pay path.
- **C-4 [P2] Dead client functions target removed routes** (`openReview`, `decide`,
  `bumpStats` — api.ts:756-766). No callers today; B-376-class landmine. Delete them.
- **C-5 [P2] TripSummary renders `payment_method`/`notes`** which `toClientBooking` never
  returns — "Payment —" on every trip; client-typed notes never shown back to the client
  (they DO reach CPO/org/ops).
- **C-6 [P2] `bookingApi.list({status,page})`** — server ignores both, hardcoded LIMIT 50.
- **C-7 [P2] Ops booking-detail team block reads only the legacy pool**
  (ops.service.ts:197 `cpoAssign.getForBooking`) — for auto-dispatched bookings (crew in
  `mission_crew`) it's empty; the client-facing equivalent was already fixed to prefer
  mission crew, the ops one wasn't.
- **C-8 [P2] `GET /org/missions/:id/live` omits `mission.pickup_at`/`live_at`** that the
  shared `MissionDeploymentResponse` type declares (org-mission.service.ts:204-213 vs
  agent.service.ts:1188). No reader breaks today; latent drift in a promised same-shape
  contract.
- **C-9 [P2] No server-side tier gate on `/family/*`** (JwtAuthGuard + throttle only) — a
  Lite user calling the API directly can build a family. **Founder to confirm intent:** if
  family is Pro-only, the gate is currently client-side only.

## 2 · Distribution to all actors (regression+distribution agent, verified)

Full four-actor matrix traced (server write → push kind → wake meta → tap route → screen
render). Lite lifecycle, exec fields, and the Pro application lifecycle are **fully
distributed** — every exec detail (task_type, transfer legs, duration, hourly rows)
verified present at client, CPO, agency, and ops read endpoints AND their renderers.

### Verified distribution findings

- **R-1 [P1] Officer decline is silent to the agency.** The server emits
  `mission-accepted`/`mission-declined` (booking-push-bridge.service.ts:221-228) but NO
  client handler exists (grep: only a test references the kinds; wake-meta map has no
  entry; bell backfill would render the raw kind string). An officer declines → the agency
  that must re-crew hears nothing → the client waits on "assigning team" indefinitely.
  Combined with C-1 (no client can even SEND accept/decline), the whole Issue-41 seam is
  dead end-to-end: server half shipped, client half never did.
- **R-2 [P1] Client cancel of a crewed booking wakes nobody.** Cancel is allowed through
  DISPATCHED/PICKUP (exactly while crew may be en route); the cancel transaction flips
  missions to ABORTED in-SQL (booking.service.ts:1088-1098) but never calls
  `missionAborted` push (only arrival-no-show and ops-abort do). A killed/backgrounded CPO
  app keeps navigating to a cancelled mission; the accepted agency learns only on poll.
- **R-3 [P2] Family invites are dark** — no push either direction; invitee discovers the
  invite only if they visit Profile.
- **R-4 [P2] Bell backfill (`activitySync` KIND_META) missing 9 kinds** — all 7 `pro-*`
  plus `detail-enroute`/`detail-live` render as raw machine strings for users who missed
  the live push (Doze/reinstall).
- **R-5 [P2] Stale installed base degrades exec silently.** Old CPO/agency builds
  (≤v1.0.219) receive exec missions but have no hourly-confirm UI → client watches "0/N
  confirmed" all mission. No crash (unknown push kinds fall through safely — verified
  serverWakeNotifications.ts:316; no strict JSON parsers). v1.0.220 400s on exec create
  (known, documented). **Mitigation: force-update or minimum-version gate before exec GA.**
- **R-6 [P3] Legacy job-feed detail omits the exec brief** (agent.service.ts:846-860
  SELECT lacks task_type/exec_transport) — solo agents on the legacy lane apply partially
  blind; post-assignment deployment payload is complete.

## 3 · Production readiness checklist (verified)

| #   | Item                         | Verdict                                                                                                                                                                                                                                                                                |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Wire compat (installed base) | **OK** with 2 knowns: v1.0.220 exec-create 400s; R-5 stale-build degradation. No 'lux' left anywhere in live code paths (plan-card key only, never sent). Old clients: `service` defaults to `secure_transfer`; unknown push kinds no-op; response fields additive.                    |
| 2   | Migrations                   | **OK** — both exec migrations idempotent; `mission_hourly_checkins` UNIQUE + RLS on; Pro/family tables migrated; no unmigrated SELECT found.                                                                                                                                           |
| 3   | Config/env                   | **OK** — no new `process.env` reads in exec/pro/family server code; nothing new needed on the box.                                                                                                                                                                                     |
| 4   | Deploy pipeline              | **GUARDED but bypassable** — stale-checkout guard correct for machines that HAVE it (§0). Gap: post-deploy check is health-only; add a feature-route probe (401-not-404) per feature family.                                                                                           |
| 5   | Boot wiring / failure modes  | **OK** — all new modules imported in app.module.ts; Redis down ⇒ booking rests at OPS_APPROVED (no stuck charge); push publishes try/caught; killswitch fails safe.                                                                                                                    |
| 6   | Regression pins              | **Mostly present** (family refund B-374/375, hourly, exec pricing, wizard seeds, Issue-41 server half, push opacity). **Unpinned:** per-hour notification-id rule; no producer↔consumer diff of server-emitted kinds vs client wake-meta (the exact escape hatch R-1 slipped through). |
| 7   | Cross-product regression     | **CLEAN** — all 3 waypoint sites verified guarded `!== 'executive_protection'` (ops.service.ts:1049, job-feed.service.ts:308, org-mission.service.ts:483); Lite draft residuals restored; estimate back-compat kept; linked-member payer logic additive.                               |

## 4 · Edge cases — money / time / state (edge-cases agent, verified)

**Swept clean (the founder's "properly calculated" question — verified YES on the core
paths):** exec pricing lockstep is byte-identical client↔server and pinned on both sides;
payWithCredits is FOR-UPDATE single-txn (two-device double-debit closed); the escrow charge
is exactly-once; every refund path conserves gross and credits the family payer with
charge-time membership; the hourly-checkin ±120 s boundary agrees on both sides (pinned at
57'/59'); cancel is TOCTOU-proof and idempotent; create double-tap is idempotency-keyed
with an `active_booking_exists` backstop; the Pro FSM blocks accept-after-reject /
cancel-from-ACTIVE / double-activate; keyboard rule B-184 holds across all new screens
(zero banned patterns); wizard draft seeding/restore is pinned by tests.

### Verified edge findings

- **E-1 [P1] Pro "Pay & Activate" has no staleness gate.** `activate()`
  (pro-applications.service.ts:362-393) checks FSM + proposal existence only — the
  `valid_until` expiry check that `accept()` performs (line 325) is absent, and neither
  `coverage_start` nor `coverage_end` is compared to now. A client who accepted then
  stalled (e.g. topping up) can be debited the FULL period total for partially-elapsed or
  fully-elapsed coverage; with elapsed coverage the next read's `sweepExpired` flips the
  plan EXPIRED immediately and there is no refund path from ACTIVE.
- **E-2 [P2] Lite add-on resolution silently drops ids; booking persists the raw list.**
  `resolveAddOns` (booking.service.ts:1372-1386) filters inactive/out-of-region ids with
  no error (exec's `resolveExecAddOns` 400s by contrast) while line 545 persists the
  unfiltered `dto.add_ons` — a booking can advertise an add-on nobody was charged for.
  The client add-on catalogue is also compiled-in (CustomizeAddOnsScreen hardcodes
  120/100/90/75) against an ops-editable DB table: latent until the first price edit.
- **E-3 [P2] Family cap/hold/revoke ignored at charge time.** `settleWonOffer`
  (dispatch.service.ts:1196-1243) debits the stamped `payer_user_id` with only a balance
  gate — spend limit is not re-checked, holds are not consulted, and a revoked member's
  charge escapes `spent_credits` accounting entirely (the UPDATE matches no active row). A
  holder who cut a member off still eats that member's pending scheduled booking days
  later. (Refunds do return to the holder — money is charged against will, not lost.)
- **E-4 [P2] Exec transfer pickup time is same-day-only.** The time picker stamps the
  chosen clock time onto the START date (ExecTransportScreen.tsx:170-177). Overnight
  blocks (e.g. 22:00 + 6 h): a next-day transfer time is unexpressible — it 400s
  `exec_transport_time_out_of_window` at the last wizard step with no field-level
  explanation, or (within the −2 h window) silently books the leg ~24 h early.
- **E-5 [P2] Pro plans lose their advertised final day.** `current_period_end` is set to
  midnight at the START of `coverage_end` (pro-applications.service.ts:380) while mission
  dates treat `coverage_end` as inclusive (:427-430) and the UI shows "covered until" that
  day — `sweepExpired` expires the plan the moment the last day begins.
- **E-6 [P2] Legacy cancel window anchored to `created_at`, not confirmation.**
  booking.service.ts:1026-1028: non-auto bookings measure the 1-h window from creation —
  a booking approved+paid a day after creation is uncancellable at the moment it becomes
  CONFIRMED, while the error message says "within 1 hour(s) of confirmation". (Exec on the
  legacy lane inherits this.)
- **E-7 [P2] Exec create() validation has zero test coverage.** All eight `exec_*` reject
  codes exist only in booking.service.ts — no spec exercises them. Pricing is pinned;
  the reject-never-reprice layer is not. A refactor can reopen silent-reprice silently.
- **E-8 [P2] `female_cpo`/`medical` add-ons are charged but unenforceable at crew
  assignment** — documented in-code (org-mission.service.ts:423-435): only `armed` has an
  authoritative per-CPO column; nothing ties the 120/90 BC-hr premiums to actual crew
  capability.
- **E-9..E-14 [P3]** — estimate() doesn't mirror create()'s reject rules (create is the
  safe side); messenger-tier subscribe lacks a server idempotency guard (sequential replay
  double-charges, value delivered); Pro "past date" checks use the UTC day; unbounded
  `notes` DTO + untruncated CPO brief render; exec screen re-declares `MIN_LEAD_HOURS`
  locally; pax→vehicle floor is client-only (API-only reachability). Details in the agent
  annex; all confirmed, none launch-blocking.

## 5 · Verdict

**Endpoint sync: PASS** — the three products' client↔server contracts are consistent;
nothing a user taps today calls a dead route, and no body/DTO drift exists on shipped
flows.

**Production go/no-go:**

- **NO-GO blocker (ops, not code):** the unfenced deploy machine (§0). One `authorized_keys`
  edit or one `git pull` on that machine clears it. Add the post-deploy feature-route probe
  at the same time.
- **P1s to schedule consciously before GA (logged B-377..B-381):** the officer-response
  seam (C-1+R-1, B-377) and crewed-cancel silence (R-2, B-378) — both degrade the core
  "everyone always knows" promise; escrow client controls (C-2, B-379) — money currently
  moves on timer alone; raw family money error (C-3, B-380); Pro activation staleness
  gate (E-1, B-381) — the one path where a client can be debited for elapsed coverage.
- **P2s logged B-382..B-386:** exec overnight transfer dead-end (E-4), Pro final-day
  expiry (E-5), family charge-time re-check (E-3), Lite add-on silent drop (E-2), legacy
  cancel anchor (E-6). Remaining P2/P3 hygiene (C-4..C-9, R-3..R-6, E-7..E-14) tracked in
  this document; can ride normal releases.

**Honest coverage limits:** static audit + staging probes only — no device pass (3-device
booking lanes, hourly confirm tap, keyboard/fontScale device checks all still pending
since the exec ship); messenger relay internals, Stripe money-in, and iOS push lane not in
scope.
