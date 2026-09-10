# Secure Services — Adversarial System Audit

> **Date:** 2026-08-28 · **Repo:** `main` @ `e9146751` (app v1.0.265 / vc309)
> **Method:** static source audit only — no runtime, no device, no live DB/Redis/Stripe. Six
> parallel adversarial investigators (money, FSM/concurrency, authz/IDOR, dispatch-fraud/GPS,
> infra/Redis/cron, mobile/test-reality), each required to cite `file:line` and tag every
> dynamic claim **CONFIRMED** (code unambiguously proves it) / **PLAUSIBLE** (strongly implied,
> not executed) / **UNVERIFIED** (needs runtime/device/DB). Findings below carry the tag their
> investigator assigned; items the lead **independently re-verified** are marked ✔︎verified.
> **Standard applied:** prove it or treat it as unverified. Tests and "FIXED" labels were not
> trusted.

---

## A. Executive Summary

**Overall risk rating: HIGH. Release recommendation for production money movement + real
close-protection missions: NO.** Not on "insufficient evidence" alone — on a set of
**CONFIRMED, code-proven, currently-reachable defects** that defeat the two properties this
product exists to guarantee: _the client's money is safe_, and _a verified protector actually
showed up_.

The engine's **happy-path concurrency and tenant-isolation core is genuinely well-built** —
the accept/cancel/crew-SLA/expiry race matrix is almost entirely prevented by disciplined
`FOR UPDATE` + conditional-`UPDATE` guards and partial-unique indexes; pre-accept offer
privacy is structurally coarse and fail-closed; the ops-console is CSRF/XSS/authz-clean;
guards re-read authority from the DB every request. The failures are concentrated in five
places: **the payment/identity proof of a completed mission**, **the Stripe money lifecycle**,
**operational resilience (Redis, sweeps, kill-switch)**, **sign-out/SOS lifecycle seams on
mobile**, and **the fact that the mission state machine is decorative in production**.

**Top 10 risks (ranked):**

1. **An accepted agency can be paid for a mission that never happened, with an unverified
   guard.** The proof-of-completion gate reads only lead-fabricated telemetry, its identity
   check is a permanent no-op, and the mission can be driven to COMPLETED without ever going
   LIVE (FRAUD-1 + FRAUD-2 + FSM-2). _Money + safety._ **P0.**
2. **Credit creation from nothing via card chargeback** — the Stripe webhook ignores
   `charge.refunded` / `dispute.funds_withdrawn`, so reversed fiat leaves minted credits
   intact (MON-1). _Money._ **P1.**
3. **A brief Redis outage crash-loops every auth-service pod** → full platform outage
   including auth, bookings, and SOS (INFRA-1). _Availability/safety._ **P1.**
4. **Escrow can strand permanently** in `review_required` with no operator exit and blind
   reconciliation (MON-2), and other stranding paths exist (INFRA-3/5/6). _Money._ **P1.**
5. **The mission state machine is dead code**; the live pipeline is guarded only by the
   actor-blind DB trigger, which is looser than the intended graph (FSM-1). _Correctness
   root cause._ **P1.**
6. **The legacy job board leaks exact pickup + dropoff GPS** of principals to every
   authenticated agent pre-assignment (FRAUD-4). _Privacy/safety._ **P1.**
7. **Emergency call log (who you called in a crisis, incl. next-of-kin) survives sign-out and
   account removal** → next user on a shared device reads it (MOB-1). _Privacy._ **P1.**
8. **The SOS screen tells the principal "GPS coordinates sent" while sending none, and
   freezes the live location stream at the moment of panic** (MOB-3). _Safety._ **P1.**
9. **Cross-user SOS forgery** — `POST /sos/raise` trusts a caller-supplied `bookingId` with no
   ownership check, letting anyone flip a stranger's live mission to SOS and spam its crew
   (AUTHZ-1). _Safety/integrity._ **P2.**
10. **Operational off-switches don't mean what they say** — the kill-switch covers only client
    submissions and fails open on Redis loss; turning `AUTO_DISPATCH` off strands in-flight
    money (INFRA-4 + INFRA-3). _Money/operational._ **P2.**

**Money risk:** HIGH — one external credit-creation path (MON-1), one insider payout-fraud
path (FRAUD-1/2), permanent-strand paths (MON-2, INFRA-3/5/6), and two latent conservation
bombs that arm the instant finance sets non-zero fee/FX values (MON-5/6). No system-wide
conservation invariant exists and the only reconciliation job effectively never runs.

**Security risk:** MEDIUM-HIGH — the tenant core is probe-resistant, but **there is no
per-request RLS**: the backend runs as a single BYPASSRLS role, so every `WHERE org_user_id=…`
is the _only_ boundary, and three are missing (AUTHZ-1/2/3). One is a live cross-user IDOR.

**Operational risk:** HIGH — INFRA-1 (crash-loop), INFRA-2 (lost-frame dispatch), INFRA-4/5/6
(kill-switch + liveness + reconciliation gaps). Money-moving sweeps have zero liveness
alerting; a 100%-failing payout sweep still reports healthy.

**Privacy risk:** MEDIUM-HIGH — FRAUD-4 (exact coords to non-winning agents), MOB-1 (emergency
PII across accounts). Pre-accept auto-dispatch privacy itself is strong.

**Safety risk:** HIGH — this is a close-protection product and the identity/telemetry controls
that would prove a real, correct guard arrived are either not enforced server-side (FRAUD-2),
fabricable (FRAUD-1), or actively misreported to the principal (MOB-3). SOS is the single most
defect-dense surface in the system (AUTHZ-1, MOB-3/4, INFRA-8, FSM-2).

**Mitigating context (does not change the verdict):** auto-dispatch has **shipped dark** (not
flag-flipped in production), and the money rails are **credit-only with no fiat cash-out path
found** — so the _immediate_ blast radius of the money findings is bounded and most arm at
cut-over. The release question is precisely whether to flip this on for real money and real
missions, and the answer is no.

---

## B. Architecture Map

```
                    ┌───────────────── MOBILE (React Native, repo root src/) ─────────────────┐
                    │  Client shell (BookingNavigator/SecureShell)  │  Agency (AgentNavigator) │
                    │  CPO (CpoNavigator)                            │  ops-console (Next.js)   │
                    └──────────┬─────────────────────────────┬───────────────────┬────────────┘
        JWT (per-req re-read)  │  FCM opaque {eventId,class}  │  X-Org-Context     │ Csrf+Admin
                    ┌──────────▼─────────────────────────────▼───────────────────▼────────────┐
                    │             auth-service (NestJS)  — single BYPASSRLS DB role            │
                    │  booking · dispatch · org · agents · ops · wallet · settlement · family  │
                    │  pro-applications · pro-management · protection · attendance · incident  │
                    │  sos · telemetry · compliance · events · notifications                   │
                    │  Guards: Jwt · OrgManager · CpoSession · Admin(+RequireRoles) · Csrf      │
                    └───┬───────────────┬───────────────┬──────────────┬─────────────┬─────────┘
                        │               │               │              │             │
              Postgres (Supabase   Redis (locks,    Stripe        FCM/push       Sentry
              pooler; FORCE-RLS    pub/sub,         (top-up       (opaque wake   (no-op unless
              zero-policy;         killswitch,      ONLY; no      + hydrate      DSN set)
              app-enforced)        push blobs,      Connect/      GET /events)
                                   idempotency)     payout rail)
              15 setInterval+Redis-lock sweeps (offer-expiry, crew-sla, arrival-noshow,
              relist, scheduled, slo, privacy-purge, escrow-release, escrow-recon,
              payment-pending, booking-reminder, drift-janitor, wallet-expiry, pro-lapse,
              attendance-rollup)   +  Redis pub/sub: dispatch:ops-approved, push:events
```

Trust-elevating fact: **no per-request RLS / `SET ROLE`** (`database.service.ts:28`,
`dispatch.service.ts:558`). Tenant isolation is 100% application-enforced; a missing `WHERE`
has no DB backstop.

---

## C. Endpoint Authorization Matrix (compact)

| Controller (prefix)                                                 | Guards                                 | Role model                                   | Tenant/ownership binding                                                                                                                                        | Verdict                                                  |
| ------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------ |
| `bookings/*`, `wallet/*`, `family/*`, `events/*`, `notifications/*` | Jwt (+Throttler/Idempotency)           | self                                         | `WHERE client_id/user.sub`; events keyed `push-event:${sub}:${id}`                                                                                              | ✅ (money keys stable)                                   |
| `dispatch/offers                                                    | jobs                                   | room-intents/\*`                             | Jwt+OrgManager+Throttler                                                                                                                                        | resolved org                                             | **ownership-before-status** (accept/reject/withdraw/getFullOffer) | ✅ probe-resistant |
| `agents/*` (CPO)                                                    | Jwt+CpoSession                         | self/lead                                    | mission owner checks; **lead-gate is UI-only client-side** (server enforcement UNVERIFIED)                                                                      | ⚠️ verify server lead-gate                               |
| `sos/*`                                                             | Jwt+Throttler                          | self                                         | cancel/status bound; **`raise` unbound** (AUTHZ-1)                                                                                                              | ⚠️ IDOR                                                  |
| `org/*`, `org/workspace/*`                                          | Jwt+OrgManager(+DeptChatV2)            | manager                                      | `assertOrgScope`; **`editShift`/`reviewSession` miss dept filter** (AUTHZ-3)                                                                                    | ⚠️                                                       |
| `incidents/*`, `attendance/*`, `protection/*`                       | Jwt+DeptChatV2/CpoSession(+OrgManager) | member/mgr/cpo                               | mostly org+dept scoped; ownership-before-status                                                                                                                 | ✅ (B-610 fixed)                                         |
| `ops/*` (12 controllers)                                            | Jwt+**Csrf**+Admin                     | `@RequireRoles` (re-read from `admin_users`) | region scope **selective** — missing on rejectBooking, adminCancel/forceAssign, SOS ack/escalate/resolve, waypoint, mission-messages, job-feed writes (AUTHZ-2) | ⚠️ region gaps                                           |
| Public by design                                                    | HMAC / token                           | —                                            | `wallet                                                                                                                                                         | subscription/stripe-webhook`, `auth/admin/accept-invite` | ✅ (but MON-1 lifecycle gap)                                      |

Full inventory: 49 controllers, ~130 routes. Undocumented/dead: `OpsDashboard`/`OpsMissionDetail`
mobile screens are registered but unreachable (MOB-13). No debug/test money endpoints found.

---

## D. FSM Matrix + DB-trigger disagreement

**Booking FSM** (`booking/state-machine.service.ts`) — 11 states, actor-aware, `CANCELLABLE`
excludes LIVE. Well-enforced (`FOR UPDATE`→assert→conditional UPDATE almost everywhere).
DB trigger `lite_bookings_fsm_check` mirrors the transition _set_ (pinned by
`state-machine.drift.spec.ts`) but is **actor-blind** and **does not constrain INSERT**.

**Mission FSM** (`ops/mission-state-machine.service.ts`) — 6 states; declares a `SYSTEM` actor
that appears in **zero** transitions. **Decorative in production (FSM-1):** `assert` is called
only from `ops/mission.service.ts`, whose forward methods (`pickup/goLive/complete/triggerSos`)
have **no production caller**. The live pipeline (`agent.service.ts`, `mission-lead.service.ts`,
`sos.service.ts`, sweeps) uses raw conditional UPDATEs with hand-coded `allowedFrom` lists.

| Mission transition | TS FSM                | DB trigger          | Production reality                       |
| ------------------ | --------------------- | ------------------- | ---------------------------------------- |
| DISPATCHED→PICKUP  | ✅ AGENT              | ✅                  | raw UPDATE, no assert                    |
| DISPATCHED→SOS     | ❌                    | ✅                  | **live & exploitable (FSM-2)**           |
| DISPATCHED→LIVE    | ❌                    | ✅                  | only via ops INSERT-as-LIVE              |
| PICKUP→COMPLETED   | ❌ (H1: must go LIVE) | ✅                  | app `allowedFrom` blocks CPO path        |
| SOS→COMPLETED      | ✅                    | ✅                  | live — enables the never-live completion |
| any→ABORTED        | ✅ OPS/ADMIN only     | ✅ any non-terminal | sweeps abort as raw UPDATE, no actor     |

**Pro-application FSM** — the cleanest in the repo (compare-and-swap everywhere); no DB trigger
(app-only, defense-in-depth gap, no illegal path found).

---

## E. Money Flow

```
 CLIENT wallet ──payment(−)──► ESCROW acct (…e5) ──escrow_release(−gross)──► AGENCY wallet (+to_provider)
      ▲   ▲                         │                                           └─ PLATFORM FEE (…fe) (+fee)
      │   │                         ├─refund──► CLIENT wallet (+)     [no-show / no-provider / pre-crew cancel / abort-pre-LIVE / stale]
      │   │                         └─split(partial)──► CLIENT + AGENCY   [post-crew cancel w/fee / abort mid-LIVE pro-rata]
      │   └── topUp(+) ◄── Stripe payment_intent.succeeded   [ONLY Stripe surface; chargeback NOT handled ← MON-1]
      └────── clawback ◄── dispute upheld after RELEASE  [PLATFORM FEE acct fronts shortfall → can go NEGATIVE, no recovery ← MON-3]
```

Charge occurs **only at accept**. Conservation invariant `gross = to_provider + platform_fee`
holds in each release txn but is **never asserted system-wide** (MON-8). Fees/FX ship 0/demo.
No fiat payout rail (no Stripe Connect) — "payout" is a credit balance.

---

## F. Trust-Boundary Map (failure modes)

| Boundary                       | Server trusts                    | Forgeable / failure                                                                          | Finding     |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| Client → mission telemetry     | lead-posted GPS as proof of work | fully fabricable; no plausibility gate on `pushTelemetry`                                    | FRAUD-1     |
| Device → `is_mocked`           | client self-report               | spoofable; plausibility is teleport-only (900 km/h, 10 km accuracy slack, first-fix trusted) | FRAUD-3     |
| Client → verify code           | nothing (no submit endpoint)     | identity never proven server-side; no payout linkage                                         | FRAUD-2     |
| Caller → `sos/raise` bookingId | ownership not checked            | forge SOS into any active mission                                                            | AUTHZ-1     |
| Stripe → webhook               | only `payment_intent.*`          | `charge.refunded`/dispute ignored                                                            | MON-1       |
| API → Redis                    | lock held, pub/sub delivered     | outage crash-loops pods; lost frame drops dispatch; fail-open killswitch                     | INFRA-1/2/4 |
| App FSM ← DB trigger           | trigger enforces graph           | actor-blind, INSERT-unconstrained, looser than TS                                            | FSM-1/10    |
| DB role                        | app enforces every WHERE         | BYPASSRLS, no per-request RLS; missing WHERE = exposure                                      | AUTHZ arch  |

---

## G. Finding Register

Severity: **P0** catastrophic/immediate · **P1** critical · **P2** high · **P3** medium ·
**P4** low. Full per-finding detail (repro, root cause, fix, regression-test status) for P0–P2;
P3–P4 are one-liners with the citation.

### P0

**AUD-P0-1 — Paid for a mission that never happened, with an unverified guard**
(cluster: FRAUD-1 + FRAUD-2 + FSM-2). **CONFIRMED ✔︎verified.** _Money + safety._

- **Mechanism.** (a) The proof-of-completion payment gate
  (`agents/proof-of-completion.service.ts:54-99`) reads only data the assigned **lead**
  manufactures: pickup/live timestamps it stamps, and `mission_telemetry` rows it inserts via
  `mission-lead.service.ts:206-213` with **no mock/plausibility gate**. Thresholds (150 m
  arrival / 5 pings / 300 s on-task) are all satisfiable by fabricated fixes at the known
  pickup coordinate. (b) Check 5 (identity handshake) is a **permanent PASS — a bare comment,
  no code** (`:101`), and **no endpoint anywhere accepts a submitted verify code** (grep of the
  whole tree; the code is read-only via two GETs). (c) A mission can reach COMPLETED **without
  ever going LIVE**: the SOS flip allows `DISPATCHED→SOS` (`agent.service.ts:1448-1449`,
  excludes only `SOS/COMPLETED/ABORTED`) and `missionComplete` accepts `['LIVE','SOS']`
  (`:1556`), so `DISPATCHED→SOS→COMPLETED` bypasses the H1 "must go live first" rule and
  terminally completes the booking (`completeMissionCore` flips booking from `LIVE|CONFIRMED`,
  `:1730-1744`).
- **Exploit.** An onboarded, accepted agency's lead taps PICKUP → go-live → POSTs 5 telemetry
  samples at the pickup point (no vehicle, no guard) → waits 5 min → Finish. `runProofGate`
  returns pass → escrow → PENDING_RELEASE → auto-released to the agency after the dispute
  window (`escrow-release-sweep.service.ts:72-96`) unless the client disputes. The client paid
  for and received no protection; identity of whoever (if anyone) attended was never verified.
- **Prereq / exploitable now:** yes for any accepted agency (insider, attributable). Bounded
  per booking; not anonymous.
- **Root cause:** the payment gate trusts a lead-writable table; the one reality-binding check
  (identity) is disabled; the mission FSM that would forbid never-live completion is decorative
  (FSM-1).
- **Fix (all three):** (1) apply the mock/teleport/displacement gate to `pushTelemetry` and
  exclude flagged fixes from proof counting; require real displacement across the LIVE window,
  not N pings at one point. (2) Add a server endpoint that accepts the verify code, re-derives
  it, and records a verified-arrival fact that proof check 5 consults before any auto-release.
  (3) SOS reachable only from `PICKUP|LIVE`; `SOS→COMPLETED` requires `live_at IS NOT NULL`.
- **Regression tests:** none exist for any of the three. Add: proof gate FAILs on zero-variance
  telemetry; proof gate holds without a verified handshake; `DISPATCHED→SOS→COMPLETED` rejected.

### P1

**AUD-P1-1 — Credit creation via Stripe chargeback/refund (MON-1). CONFIRMED ✔︎verified.**
`wallet/wallet.service.ts:1236-1242` early-returns on any event that isn't
`payment_intent.succeeded|payment_failed` ("charges, disputes… out of scope for Phase 1"). Top
up → spend BC → file a card chargeback: Stripe pulls the fiat, the BC balance is untouched. No
`charge.refunded`/`dispute.funds_withdrawn` handler; MON-8 makes it invisible to reconciliation.
_Fix:_ handle refund/dispute events, mint a compensating debit (allow negative), freeze spend
while a dispute is open. _No regression test / no dispute fixture._ Bounded per chargeback,
attributable; **externally triggerable.**

**AUD-P1-2 — Redis outage crash-loops every pod → full outage incl. SOS (INFRA-1). CONFIRMED
✔︎verified.** Every sweep but `booking-reminder` ticks `void this.sweepOnce()` and awaits the
lock `set` **outside** its try block (`offer-expiry.service.ts:64,85`; identical across 11
sweeps). No `process.on('unhandledRejection')` anywhere (grep: only comments in the one fixed
sweep). Node 20 default = process exit; systemd `Restart=always` → crash-loop for the Redis
outage duration. `payment-pending-expiry` is not flag-gated, so it's reachable on **every**
deploy regardless of auto-dispatch. _Fix:_ try/catch each `sweepOnce` + a process-level handler
in `main.ts`; `.catch` on lock acquisition.

**AUD-P1-3 — Escrow strands permanently in `review_required`, invisible to reconciliation
(MON-2). CONFIRMED.** Set on any proof-gate FAIL (`agent.service.ts:2085-2089`) — including
ordinary weak-GPS completions, not just fraud. No code ever clears it; the release sweep skips
it (`escrow-release-sweep.service.ts:76`); `confirmComplete`/`openDispute`/`completeBooking`/
`resolveDispute` all reject a HELD hold on a COMPLETED booking — **no admin endpoint exits it**.
Reconciliation only checks terminal holds, so a stranded HELD produces zero drift. _Fix:_ an ops
"resolve review" endpoint (release or refund, both terminal) + a recon check for non-terminal
holds older than N days.

**AUD-P1-4 — Mission FSM is decorative; only the actor-blind DB trigger governs missions
(FSM-1). CONFIRMED ✔︎verified.** Enables AUD-P0-1's never-live completion and removes the
actor discipline the TS graph intends. _Fix:_ route the live writers through `missionFsm.assert`
with the true actor (or make the DB trigger actor-aware and delete the dead methods); add a
source-scan pin "every mission status writer asserts."

**AUD-P1-5 — Legacy job board leaks exact pickup + dropoff GPS pre-assignment (FRAUD-4).
CONFIRMED.** `agents/agent.service.ts:698-766` (`GET /agents/me/available-jobs`, JWT-only)
returns `pickup_lat/lng, dropoff_lat/lng` to **any** authenticated agent for every published
job, before applying. Contrast the correctly-coarse auto-dispatch offer. _Safety/privacy_ for a
close-protection principal. _Fix:_ make the legacy feed coarse (zone/bucket); reveal exact coords
only to the assigned agency, audited, mirroring `getFullOffer`.

**AUD-P1-6 — Emergency call log crosses account boundaries on a shared device (MOB-1).
CONFIRMED ✔︎verified.** `emergencyCallLog` persists to AsyncStorage `bravo-emergency-call-log`
unscoped; `clear()` has no production caller; `signOut` never resets it; even account-removal
(`wipeAtRest`) misses it. `CallsLogScreen` merges it unconditionally, so user B sees user A's
crisis calls incl. next-of-kin labels. _Fix:_ clear it in `signOut` (or owner-key it) + extend
`storeReset.test.ts`. Same class as the earlier secureProStore PII leak (documented wipe never
wired).

**AUD-P1-7 — SOS screen shows false "coordinates sent" and freezes the live stream (MOB-3).
CONFIRMED.** `SOSScreen.tsx:127-131` raises with `{source,timestamp}` only — **no coordinates**
— while the UI asserts "GPS coordinates sent to Bravo Control System" (`:233-237,307-312`) over a
hardcoded mock map. Opening the screen unfocuses LiveTracking, clearing its `clientPing` watcher
(`LiveTrackingScreen.tsx:431-440`) — the principal's position stream to ops **freezes at the
moment of panic**. _Safety-critical false assurance._ _Fix:_ attach a best-effort fix to the
raise, keep a location push while SOS is focused, remove the false copy/mock map.

### P2 (high)

- **AUD-P2-1 (AUTHZ-1). CONFIRMED ✔︎verified.** `sos/sos.service.ts:107-127` resolves the
  mission by caller-supplied `bookingId` with no `client_id` predicate, then flips it to SOS and
  fans panic pushes to its crew+agency. Cross-user SOS forgery (UUID-gated, throttled). _Fix:_
  bind to a booking the caller owns.
- **AUD-P2-2 (AUTHZ-2). CONFIRMED+PLAUSIBLE.** Ops region-scope assert omitted on several
  region-bound mutations incl. money (`adminCancel`/`adminForceAssign` take no admin arg) and
  SOS (`ackSos`/`escalateSos`/`resolveSos`) and mission-messages/job-feed writes — a
  region-scoped OPS/SUPERVISOR can act cross-region. _Fix:_ thread `AdminContext` +
  `assertRegionScope` after the row read.
- **AUD-P2-3 (AUTHZ-3). CONFIRMED.** Attendance `editShift`/`reviewSession`
  (`attendance.service.ts:586,601,1211,1274`) omit the department forced-filter → a branch
  manager can alter/approve any department's sessions in the org. _Fix:_ pass `manager.department`.
- **AUD-P2-4 (INFRA-2). CONFIRMED.** OPS_APPROVED 'now' dispatch is fire-once Redis pub/sub; a
  lost frame leaves the booking stuck OPS_APPROVED with no automated recovery and no re-approve
  path. _Fix:_ a reconciling sweep for `OPS_APPROVED auto now, dispatch_started_at IS NULL`.
- **AUD-P2-5 (INFRA-3). CONFIRMED.** Flipping `AUTO_DISPATCH_ENABLED` off strands in-flight
  bookings and freezes HELD money (relist-refund/escrow-release/expiry all gate each tick on the
  flag; the janitor backstop excludes DISPATCHING). _Fix:_ gate only offer-_creating_ sweeps.
- **AUD-P2-6 (INFRA-4). CONFIRMED.** Kill-switch (`dispatch:enabled`) is checked only on client
  submit — not on portal claim (moves money), accept, ops-approve, cascade, cron, or
  force-assign — and fails **open** on Redis read error / restart (no TTL; dev Redis persistence
  off). _Fix:_ check it in `offerNext`/`claimOpenBooking`/scheduled sweep; persist in Postgres.
- **AUD-P2-7 (INFRA-5). CONFIRMED.** Money-moving sweeps (crew-sla refund, escrow-release
  payout, arrival, relist, recon) write liveness keys that **nothing reads**; only the offer
  sweep feeds `/ready`+SLO. A 100%-failing payout sweep reports healthy. _Fix:_ extend liveness
  to all five + a "rows due but overdue" DB probe.
- **AUD-P2-8 (INFRA-6). CONFIRMED/UNVERIFIED.** The escrow reconciliation sweep is 24 h with no
  eager first run and restarts reset the clock → in a near-daily-deploy shop it effectively never
  runs. _Fix:_ eager first pass + "last ran" gate.
- **AUD-P2-9 (INFRA-8). CONFIRMED.** CPO-raised SOS fan-out is a drifted copy: 300 s blob TTL
  (dead-notification window vs the bridge's 900 s) and **no durable inbox row** — a Dozed device
  or a Redis blip loses the SOS alert entirely. _Fix:_ route through `BookingPushBridge.sosAlert`.
- **AUD-P2-10 (FSM-3). CONFIRMED (mechanism).** Sweep Redis locks are unfenced (no token, bare
  DEL); a long batch can lose its lock mid-run and a second pod double-cascades (`offerNext`
  after commit, offer accounting). Row-level guards save the money; the advertised multi-pod
  guarantee is false. _Fix:_ Lua check-and-del + token, TTL ≥ batch ceiling.
- **AUD-P2-11 (FSM-5). PLAUSIBLE.** `ops.rejectBooking` can CANCEL a CONFIRMED (crewed, HELD)
  booking without aborting the mission, superseding offers, or refunding escrow; the drift
  janitor heals the mission but **not** the hold. _Fix:_ share `booking.service.cancel`'s unwind
  or restrict reject to pre-accept states. _Reachability UNVERIFIED (console gating)._
- **AUD-P2-12 (MOB-2). CONFIRMED.** Protection-session GPS streamer is never stopped on
  sign-out; a high-accuracy watch keeps running and flushing under a cleared token. _Fix:_ stop
  it in `signOut`.
- **AUD-P2-13 (MOB-4). CONFIRMED.** "Cancel SOS" is `goBackOnce` only — no server call though
  `POST /sos/:id/cancel` exists; ops still holds an active SOS. `sosApi.raise` also carries no
  Idempotency-Key. _Fix:_ wire cancel with surfaced failure; key the raise.
- **AUD-P2-14 (MOB-5). CONFIRMED/PLAUSIBLE.** All GPS except the lead's FGS is foreground-only:
  `onDutyHeartbeat` keep-alive is a TODO no-op, so a backgrounded on-duty agency silently drops
  from the dispatch pool in <5 min while showing "Online"; a backgrounded CPO/client stops
  streaming mid-LIVE. _Fix:_ real background service or an honest "you stopped streaming" UI.
- **AUD-P2-15 (FRAUD-3). CONFIRMED.** `is_mocked` is client-self-reported
  (`agent.dto.ts:171`); plausibility is teleport-only (900 km/h, +10 km accuracy slack,
  first-fix trusted), so gradual spoofing biases dispatch offers to the spoofer. _Fix:_ server
  corroboration, accuracy ceiling, first-fix quarantine.
- **AUD-P2-16 (MON-3). CONFIRMED.** Clawback drives the platform-fee account negative with only
  a `log.warn` "recover from future payouts" that nothing implements. _Fix:_ payout-withholding
  ledger + recon check on negative account sign.
- **AUD-P2-17 (MON-4). PLAUSIBLE.** Family spend-cap TOCTOU: concurrent member spends read a
  stale `spent_credits` before the wallet lock → cap breached (no overdraft — real balance still
  gates). _Fix:_ `family_members FOR UPDATE` inside the charge txn.
- **AUD-P2-18 (FRAUD-7). PLAUSIBLE.** Offer budget isn't reset on arrival-no-show /
  claim-then-withdraw, so a griefing agency can burn a booking's 8-offer budget → strand the
  client at NO_PROVIDER (no fallback, `TODO(LB13)`). _Fix:_ don't count bystander rows; rate-limit
  claim/withdraw churn.

### P3 (medium) — one-liners

- **MON-5** clawback fee INSERT can violate `ux_wallet_tx_payout` and abort dispute-resolve —
  **arms when `platformFeePct>0`** (`wallet.service.ts:1048-1056`).
- **MON-6** accept charges raw EUR, ignoring `eur_per_bc` — diverges from affordability/legacy —
  **arms when peg ≠ 1** (`dispatch.service.ts:1185`).
- **MON-8** no system-wide conservation invariant; reconciliation partly cosmetic
  (`wallet.service.ts:1435`).
- **INFRA-7** unfenced lock pattern (generalized FSM-3). **INFRA-9** charge-failure/SLO alerting
  per-pod-blind, terminates in a Sentry that's a no-op without a DSN. **INFRA-10** janitor legacy
  refund is post-commit, non-retried (crash → money kept). **INFRA-11** idempotency interceptor
  fails closed on Redis and is non-atomic under a double-tap race. **INFRA-14** `/ready` couples
  the whole API to one sweep + pod-clock-sensitive. **INFRA-15 / MON-7** `ALLOW_NO_STRIPE_TOPUP=1`
  is a free-credit printer with no boot refusal.
- **FRAUD-6** `DISPATCH_DISABLE_REGION_FILTER` drops the whole eligibility clause (licence/
  insurance/armed), guarded only by `NODE_ENV!=='production'` (`dispatch.service.ts:137-142`).
- **FSM-4** `resolveSos`→`setStatus` TOCTOU can attempt COMPLETED→LIVE resurrection (blocked by
  the trigger at the cost of a 500). **FSM-8** `completeBooking` mission close can hit ABORTED
  history rows → trigger 500. **FSM-10** DB trigger doesn't constrain INSERT (mission born LIVE).
- **AUTHZ-4** money/pricing levers (wallet-adjust, `eur_per_bc`, permanent comp) are SUPERVISOR,
  not ADMIN, and wallet-adjust has no amount ceiling. **AUTHZ-5** any-admin (no `@RequireRoles`)
  on mission-message inject + SOS-ack.
- **MOB-6** activity-sync watermark global, never reset per user (B misses older notifications).
  **MOB-7** activity-feed wipe depends on one effect running. **MOB-8** `resumeTargetFor` called
  two-arg at two history call sites (LB-ST class; self-healing). **MOB-9** time-suffixed
  idempotency keys (`claim-…-Date.now()`) protect nothing; the pin is a hand-copied mirror.

### P4 (low) — one-liners

- **MON-9** unconditional escrow debit vs `ON CONFLICT` credit (latent desync). **MON-10**
  `refundForBooking` on an auto booking would double-refund (not currently reachable). **MON-11**
  stale in-txn balance reads (cosmetic).
- **INFRA-12** `payment-pending-expiry` swallows an in-txn audit error → silent rollback counted
  as success. **INFRA-13** event hydration IDOR **CLOSED** (recipient-bound key, 128-bit ids) —
  informational; minor "5-min TTL" doc drift. **INFRA-16** killswitch cache unbounded age; wallet
  drift probe warns-only; lock-less wallet/pro crons; unbounded expiry txn.
- **AUTHZ-6** input-validation gaps (inline body type skips ValidationPipe; missing ParseUUIDPipe
  → 500 not 400 on ops `:id`). **AUTHZ-7** ops-console **clean** (CSRF/XSS/httpOnly) —
  informational.
- **MOB-10** persisted `pendingProvider` routes into agency shell (UI-only, server-gated).
  **MOB-11** tokens degrade to plaintext AsyncStorage on keychain failure. **MOB-12** forged
  push `bookingId` navigates (API is the gate; no client leak). **MOB-13** dead ops screens
  registered. **MOB-14** silent-failure sweep: money paths clean; edges (duty toggle, dashboard
  SOS cancel, `loadMessages`) swallow.

### REFUTED (a sub-auditor claim the lead disproved)

- **FRAUD-5 (DPA not enforced) — REFUTED ✔︎verified.** The fraud auditor read the superseded
  eligibility function (`20260621100000`). The very next migration
  `20260622100000_privacy_consent.sql:33-41` does a `CREATE OR REPLACE` adding
  `dpa_accepted_at IS NOT NULL` as the first predicate; migrations apply in order, so the
  effective function **does** gate on DPA. No compliance gap here.

---

## H. Race-Condition Matrix (critical mutations)

| Pair                                           | Prevented by                                                        | Verdict                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| accept + client-cancel @ DISPATCHING→CONFIRMED | booking `FOR UPDATE` + `WHERE status='DISPATCHING'`                 | ✅ PREVENTED                                         |
| accept + offer-expire                          | shared `WHERE status='OFFERED'` + grace                             | ✅                                                   |
| accept + crew-SLA                              | crew-SLA re-locks booking, needs CONFIRMED + no mission             | ✅                                                   |
| crew-SLA + crew-assign                         | atomic conditional insert `WHERE CONFIRMED AND NOT EXISTS(mission)` | ✅                                                   |
| withdraw + relist                              | disjoint status scopes                                              | ✅                                                   |
| arrival-noshow + client-cancel                 | same lock order, both conditional                                   | ✅                                                   |
| complete + abort                               | conditional vs unconditional; trigger blocks illegal arm            | ⚠️ safe-on-data, 500-on-error                        |
| **SOS + complete**                             | —                                                                   | ❌ **LOGIC GAP (FSM-2)**                             |
| ops-approve + cancel                           | `FOR UPDATE` + `WHERE PENDING_OPS`                                  | ✅                                                   |
| two concurrent sibling-offer accepts           | booking guard + `one_live_per_booking` unique                       | ✅                                                   |
| two pods, same sweep                           | Redis lock (unfenced) + row re-check                                | ⚠️ PARTIAL (FSM-3) — money safe, cascades can double |
| double-tap same idempotency key                | interceptor caches after completion                                 | ⚠️ non-atomic (INFRA-11); DB guards backstop money   |

**Duplicate creation:** two missions/booking, two live offers, two escrow holds, duplicate crew
— all **blocked** by partial-unique indexes. ⚠️ _Caveat:_ a non-partial `missions_booking_id_bridge`
unique (compat migration, meant to be dropped) would **block re-dispatch re-crew** if still
present — UNVERIFIED, no drop migration in tree.

---

## I. Authorization Matrix (role × capability)

| Capability                    | Client                       | Agency mgr      | CPO                                     | OPS                              | SUPERVISOR                        | ADMIN        |
| ----------------------------- | ---------------------------- | --------------- | --------------------------------------- | -------------------------------- | --------------------------------- | ------------ |
| Book / pay / cancel own       | ✅ own                       | —               | —                                       | —                                | —                                 | —            |
| Accept offer / assign crew    | —                            | ✅ own org      | —                                       | —                                | —                                 | —            |
| Advance mission               | —                            | —               | ✅ lead (server-enforcement UNVERIFIED) | —                                | —                                 | —            |
| Raise SOS                     | ✅ **any booking (AUTHZ-1)** | ✅              | ✅                                      | via ops                          | ✅                                | ✅           |
| Approve/reject booking        | —                            | —               | —                                       | ✅ (reject unscoped)             | ✅ region                         | ✅ global    |
| Force-assign / admin-cancel   | —                            | —               | —                                       | —                                | ✅ (**region-unscoped**, audited) | ✅           |
| Wallet adjust / pricing / peg | —                            | —               | —                                       | —                                | ✅ (**no ceiling**)               | ✅           |
| Kill-switch / user-erase      | —                            | —               | —                                       | —                                | —                                 | ✅ only      |
| Cross-region act              | —                            | —               | —                                       | ❌ region-locked (gaps: AUTHZ-2) | ❌ (gaps)                         | ✅ by design |
| X-Org-Context                 | narrows only ✅              | narrows only ✅ | —                                       | —                                | —                                 | —            |

---

## J. Money-Invariant Matrix

| Operation               | Debit                    | Credit        | Idempotency barrier                                      | Reconciled?                          |
| ----------------------- | ------------------------ | ------------- | -------------------------------------------------------- | ------------------------------------ |
| top-up                  | —                        | user (+)      | Optional interceptor + status-guarded settle             | ⚠️ no chargeback (MON-1)             |
| accept charge           | client                   | escrow        | offer-win conditional + `escrow_holds.booking_id` UNIQUE | ✅ row-level                         |
| release                 | escrow                   | agency + fee  | `ux_wallet_tx_payout` + `FOR UPDATE` status guard        | partial (recon rarely runs, INFRA-6) |
| refund                  | escrow                   | client        | status guard + `ux_wallet_tx_booking_refund`             | terminal-only checks                 |
| split/partial           | escrow                   | client+agency | status guard (client leg no unique index)                | terminal-only                        |
| clawback                | agency (+fee acct front) | client        | none on fee INSERT (MON-5 latent)                        | ❌ negative acct unchecked (MON-3)   |
| **system conservation** | —                        | —             | —                                                        | ❌ **no global invariant (MON-8)**   |

---

## K. Data-Privacy Matrix (selected)

| Data                                      | Stored                       | Readers                            | Leak finding                                                            |
| ----------------------------------------- | ---------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Exact pickup/dropoff coords               | `lite_bookings`              | client, assigned agency, ops       | ✅ auto coarse; ❌ **legacy job board exposes to all agents (FRAUD-4)** |
| Principal identity/requirements           | `lite_bookings`              | assigned agency (`/full`, audited) | ✅ coarse pre-accept (`pickBooleanFlags`)                               |
| Emergency call log (numbers, next-of-kin) | AsyncStorage (mobile)        | on-device                          | ❌ **crosses accounts on sign-out (MOB-1)**                             |
| Live GPS telemetry                        | `mission_telemetry*`         | ops, agency monitor, client        | purged 24 h post-terminal; ❌ streamer runs post-logout (MOB-2)         |
| Push event blob                           | Redis 900 s, recipient-bound | recipient only                     | ✅ hydration IDOR closed (INFRA-13)                                     |
| Verify code                               | never stored (HMAC)          | client + lead (read-only)          | ✅ storage; ❌ never enforced (FRAUD-2)                                 |
| Wallet/payment                            | Postgres                     | self, ops finance                  | ✅ scoped                                                               |

---

## L. Background-Job Matrix (money/state-moving subset)

| Job                       | Interval | Lock (fenced?)               | Mutation                    | Money                                          | Flag-gated | Failure mode                                   | Liveness      |
| ------------------------- | -------- | ---------------------------- | --------------------------- | ---------------------------------------------- | ---------- | ---------------------------------------------- | ------------- |
| offer-expiry              | 8 s      | ⚠️ no token                  | expire→cascade              | —                                              | AUTO       | crash-loop (INFRA-1)                           | ✅ /ready+SLO |
| crew-sla                  | 60 s     | ⚠️                           | →AGENCY_NO_SHOW             | **refund (in-txn)**                            | AUTO       | crash-loop                                     | ❌ key unread |
| arrival-noshow            | 60 s     | ⚠️                           | →DISPATCHING, abort         | hold stays HELD                                | AUTO       | crash-loop; double-cascade (FSM-3)             | ❌            |
| relist-timeout            | 60 s     | ⚠️                           | →NO_PROVIDER                | **refund; sole unfreeze path**                 | AUTO       | crash-loop; **strands if flag off (INFRA-3)**  | ❌            |
| escrow-release            | 60 s     | ⚠️                           | RELEASE                     | **pays agency+fee**                            | AUTO       | crash-loop; per-row fail silent                | ❌            |
| escrow-recon              | 24 h     | ok                           | read-only audit             | —                                              | AUTO       | **never runs if restart<24h (INFRA-6)**        | ❌            |
| payment-pending-expiry    | 60 s     | ⚠️                           | →CANCELLED                  | —                                              | **none**   | crash-loop on every deploy                     | ❌            |
| drift-janitor             | 10 min   | partial                      | close orphans; stale-cancel | refund (in-txn); legacy post-commit (INFRA-10) | none       | DB errors escape                               | ❌            |
| ops-approved sub          | pub/sub  | per-booking (never released) | start()                     | —                                              | AUTO       | **at-most-once; lost frame strands (INFRA-2)** | ❌            |
| wallet-expiry / pro-lapse | 1 h      | **none**                     | expire / auto-renew debit   | **debits**                                     | env        | safe (`.catch` + `FOR UPDATE`)                 | ❌            |

---

## M. Test-Coverage Reality

| Invariant                                                  | What executes                                                                          | Verdict                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Client booking status/resume resolver                      | `bookingResume`, `missionJourney`                                                      | CONFIRMED (resolver); call-sites uncovered          |
| Mission FSM advance                                        | `missionAction` (pure selector) only                                                   | PARTIAL — `useMissionAdvance` untested              |
| **Money conservation / escrow / payout**                   | nothing on client; backend **mocked-pg (no real SQL)**                                 | **UNVERIFIED — nothing executes it**                |
| Idempotency contract                                       | hand-copied mirror of the builders                                                     | DECORATIVE                                          |
| IDOR / org scoping                                         | client narrowing tested; **server enforcement mocked-pg**                              | client ✅ / server UNVERIFIED                       |
| **Cross-user leakage**                                     | wallet/booking/securePro resets pinned; **emergencyCallLog & protection streamer NOT** | PARTIAL — the two live leaks are the untested seams |
| **Proof-gate (geofence/deploy checks/identity)**           | none; server mocked-pg                                                                 | **UNVERIFIED**                                      |
| LiveTracking / SOS / ProLiveMission / CpoProtectionSession | all source-scans; SOSScreen zero tests                                                 | **UNVERIFIED — screens never execute**              |
| Deep-link/push routing                                     | `resolveRoute`, `messengerDeepLink`, parity scans                                      | CONFIRMED                                           |

Backend specs are **mocked-pg — no test executes real SQL** (repo-documented: "2,100 green
tests missed 5 live DB-only defects"). The **3-device dispatch smoke has never been run**. The
`booking` Jest project covers only `screens/booking` + `screens/agent`. **The module's deepest
invariants — money, IDOR, proof-gate — are proven by nothing that executes.**

---

## N. Known-Risk Revalidation

| Prior claim                                   | Reality                                                 | Verdict                              |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| "review_required never auto-releases" (brief) | true AND has no operator exit + blind recon             | **worse than documented (MON-2)**    |
| DPA enforced in eligibility (brief)           | `CREATE OR REPLACE` in `20260622100000` adds it         | **VERIFIED true** (FRAUD-5 refuted)  |
| Proof-gate check 5 permanent pass (brief)     | confirmed; no verify-code submit endpoint exists        | **VERIFIED — and it's a P0 enabler** |
| Coarse pre-accept privacy (brief)             | structurally enforced, fail-closed audit                | **VERIFIED strong**                  |
| Mission FSM bypassed by sweeps (brief)        | worse — bypassed by the **entire** live pipeline        | **worse (FSM-1)**                    |
| Race matrix safe (implied)                    | happy-path prevented; SOS-complete gap + unfenced locks | **PARTIALLY true**                   |
| Event-hydration privacy                       | recipient-bound, IDOR closed                            | **VERIFIED**                         |
| Kill-switch stops dispatch (its own doc)      | only client submits; fails open                         | **FALSE (INFRA-4)**                  |

---

## O. Unverified Without Runtime/Device/DB

Prod env truth (`STRIPE_SECRET_KEY` set / `ALLOW_NO_STRIPE_TOPUP` unset / `AUTO_DISPATCH` state /
`SENTRY_DSN`); whether all migrations + the required index drops (`missions_booking_id_bridge`)
are actually applied; DB transaction isolation level (affects MON-4 window); real Stripe event
catalogue; sweep batch wall-time vs lock TTL (FSM-3 frequency); **server-side lead-only
enforcement of mission advance** (client gate is UI-only); whether `rejectBooking` is
console-gated to PENDING_OPS (FSM-5 reachability); end-to-end payout on fabricated proof
(proven by code path, not executed); post-logout streamer 401 behavior; whether BC can ever
leave as fiat (bounds MON-1/3 loss).

---

## P. Release Blockers

**MUST FIX BEFORE PRODUCTION:** AUD-P0-1 (fake/unverified mission payout — all three
mechanisms), MON-1 (chargeback), INFRA-1 (crash-loop), MON-2 (stranded escrow + operator exit),
FSM-1 (mission FSM), FRAUD-4 (coord leak), MOB-1 (emergency PII), MOB-3 (SOS false assurance),
AUTHZ-1 (SOS IDOR), INFRA-2/3/4 (dispatch recovery + kill-switch + flag-off strand), INFRA-5/6
(money-sweep liveness + reconciliation).

**MUST VERIFY BEFORE PRODUCTION:** server-side lead-only enforcement of mission advance; the
`missions_booking_id_bridge` drop; prod Stripe/topup env; migrations applied; `rejectBooking`
gating; run the 3-device smoke; a real-SQL integration pass on the money paths.

**CAN SHIP WITH MONITORING (after the above):** AUTHZ-2/3, INFRA-8/9/10/14, MON-3/4, FSM-3/5,
MOB-2/4/5, FRAUD-3/7 — once liveness/alerting and the fixes land.

**ACCEPTABLE TECH DEBT:** the P3/P4 register (latent fee/peg bombs MON-5/6 become MUST-FIX at the
moment finance sets non-zero values).

---

## Top-20 Damage Scenarios (ranked by Likelihood × Impact × Detectability × Recoverability)

_Detectability/Recoverability scored as risk — lower detectability and lower recoverability push
a scenario up._

1. **Redis blip → whole platform (incl. SOS) down** (INFRA-1). Likely, high impact, self-evident
   but self-amplifying via `/ready`, auto-recovers when Redis returns. **#1 on likelihood×impact.**
2. **Accepted agency paid for a never-happened / unverified-guard mission** (AUD-P0-1). Moderate
   likelihood (insider), catastrophic on safety+money, **low detectability** (looks complete),
   low recoverability (auto-released).
3. **Card chargeback mints free credits** (MON-1). Moderate likelihood, bounded per event, **zero
   detection** (recon blind), poor recoverability (no cash-out limits the ceiling).
4. **Escrow permanently stranded** (MON-2). High likelihood on weak-GPS traffic, money frozen,
   **no operator tool**, recon blind.
5. **Emergency call log leaks to next user on a shared device** (MOB-1). Moderate likelihood,
   privacy-severe, undetectable, irrecoverable once disclosed.
6. **SOS raised but principal position frozen + false "sent"** (MOB-3). Rare-but-worst-moment,
   safety-catastrophic, invisible to the user.
7. **Turning AUTO_DISPATCH off strands in-flight held money** (INFRA-3). Operator-triggered,
   money frozen, recoverable only by flipping back + manual sweep.
8. **Kill-switch fails to stop money movement / fails open** (INFRA-4). Incident-time, high
   impact (the one moment you rely on it), silent.
9. **Money-sweep dies; refunds/payouts stop for days under green /ready** (INFRA-5/6). Moderate,
   money-wide, **undetectable** until customers complain.
10. **Lost ops-approve pub/sub frame → protection detail never dispatches** (INFRA-2). Moderate,
    safety+product, silent, recoverable only by portal-claim luck or a 60-min janitor.
11. **Cross-user SOS forgery corrupts a stranger's mission + ops feed** (AUTHZ-1). Needs a UUID,
    throttled; integrity+safety; detectable in audit.
12. **Legacy job board harvests principals' exact routes** (FRAUD-4). Depends on legacy feed
    being populated; privacy/safety; silent.
13. **Region-scoped admin acts cross-region incl. escrow move** (AUTHZ-2). Insider, money+safety,
    auditable.
14. **Double-cascade / double-count from unfenced sweep lock under load** (FSM-3). Load-dependent,
    money-safe but offer-spam + accounting drift, hard to spot.
15. **GPS-spoofing agency biases offers to itself** (FRAUD-3). Moderate, dispatch-integrity,
    partially detectable via plausibility logs.
16. **Family cap breached by concurrent spends** (MON-4). Race-dependent, policy breach not
    overdraft, detectable in spend records.
17. **Clawback drives platform-fee account negative, never recovered** (MON-3). Rare, bounded
    loss, invisible (no sign check).
18. **Fee/peg set by finance instantly arms MON-5 (dispute-resolve DoS) + MON-6 (mis-charge).**
    Certain at cut-over if unfixed, money-correctness, detectable on first dispute.
19. **Branch manager alters another department's attendance/payroll** (AUTHZ-3). Insider,
    integrity, auditable.
20. **`ALLOW_NO_STRIPE_TOPUP=1` env leak → free-credit printer** (INFRA-15/MON-7). Low likelihood
    (config), catastrophic if it happens, no boot refusal to stop it.

---

## Final Question

> **Would you approve this system for production money movement and real-world close-protection
> missions today?**

**NO.**

Two independent grounds, either sufficient on its own:

1. **Confirmed release-blockers.** Setting aside everything that needs runtime to prove, the
   code alone establishes: an accepted agency can be paid for a mission that never happened with
   an unverified guard (P0); a card chargeback creates credits from nothing (P1); a routine
   Redis blip takes the whole platform — including SOS — offline (P1); escrow can strand with no
   operator exit and blind reconciliation (P1); a principal's crisis-call history and exact
   routes can leak (P1); and the SOS surface misreports itself at the worst possible moment (P1).
   For a product whose promise is _your money is safe and a real protector arrived_, these defeat
   the promise directly.

2. **Insufficient evidence.** The system's deepest invariants — money conservation, IDOR
   resistance, and the proof-of-completion gate — are **proven by nothing that executes**. The
   backend suite is mocked-pg (no real SQL runs), the safety-critical screens have no executing
   tests, and the 3-device cut-over smoke has never been run. A green suite is not evidence here,
   by this repo's own documented history.

The engine's concurrency and tenant-isolation _design_ is strong, and the fixes are mostly
localized. But "would you approve it **today**" is a factual question about the current tree, and
the answer is **NO — both blocked and unproven.**

---

---

## Q. Plain English — every problem, no jargon

**The one-sentence summary:** the app is well-built for the normal, everyday case, but it has
holes in exactly the two things it must never get wrong — _keeping the customer's money safe_
and _proving a real, correct bodyguard actually turned up_ — plus it falls over too easily and
leaks a few private things it shouldn't.

**The most serious — fix before this ever handles real money or real missions:**

- **A dishonest security company can get paid for a job it never did.** When a guard finishes a
  job, the app checks "did this really happen?" by looking at the guard's phone GPS. But the
  guard's own phone is the only thing providing that GPS, and the app doesn't check whether it's
  faked. So a company can tap "picked up," send five fake location pings from home, wait five
  minutes, tap "finished," and the customer's money is released to them. **Like a courier
  marking a parcel "delivered" from their sofa and still getting paid.**

- **The app never actually checks that the right bodyguard showed up.** There's a 6-digit code
  the customer is supposed to read to confirm their guard's identity. But nothing in the system
  ever checks that code — it's just shown on screen for people to eyeball. The payment doesn't
  depend on it at all. So a company could send a cheaper, unvetted person and still get paid.
  **Like a doorman who's given a password to check but is told he'll be paid whether or not he
  bothers to ask for it.**

- **A job can be marked "complete" without the guard ever going on duty.** Because of a loophole
  in how the app tracks a mission's steps, you can jump straight from "assigned" to "emergency"
  to "complete," skipping the "actually protecting the client" step entirely — and the customer's
  booking is used up and can't be refunded. **Like a taxi meter that can jump from "booked"
  straight to "trip finished" without the ride.**

- **Someone can top up with a card, spend the credits, then reverse the card charge and keep the
  credits.** The app listens for "your card payment succeeded" but ignores "the customer
  reversed the charge." So the money goes back to their bank while the credits stay in the app.
  **Like paying with a cheque that bounces after you've already walked out with the goods.**

- **A brief hiccup in one background system takes the whole app down.** There's a helper service
  (Redis) the app leans on constantly. If it stutters for even 30 seconds — a normal, routine
  event — the app doesn't shrug it off; it crashes and keeps crashing until the hiccup passes.
  While that happens, _nothing_ works: no login, no bookings, and **no SOS.** **Like a building
  where a flickering light switch trips the master breaker for the whole block.**

- **Customer money can get frozen with no way to release it.** If the automatic "did the job
  really happen?" check fails — which happens on ordinary bad-GPS days, not just fraud — the
  money is held in limbo. There is no button, anywhere, for staff to release it or refund it, and
  the system's own money-checker is blind to the problem. **Like a bank safe that locks a
  deposit inside and nobody has the combination.**

- **The app tells the customer their location was sent during an SOS when it wasn't — and it
  actually stops sending their location the moment they hit the panic button.** The most
  dangerous moment is exactly when the app goes quiet while claiming it isn't. **Like a car alarm
  that lights up "HELP IS COMING" but never made the call, and switches off your phone's GPS as
  it does.**

- **Private "who did you call in an emergency" history sticks around after you log out.** If two
  people use the same phone, the second person can see the first person's emergency call list —
  including next-of-kin names. Logging out and even "remove my account" don't wipe it. **Like a
  shared library computer that keeps the last reader's browsing history on screen.**

- **The old "job board" shows every security company the customer's exact pickup and drop-off
  address before anyone is even hired.** The newer system correctly hides this (it only shows a
  rough distance), but the older path still leaks precise home/destination coordinates to anyone
  with an agent login. **For a personal-protection product, that's handing a stranger the
  client's front door and schedule.**

**Serious, but a notch below:**

- **Anyone can trigger a fake SOS on someone else's job.** If a person knows another customer's
  booking reference, they can fire a false panic alarm into that stranger's live mission and spam
  the guards' phones. **Like being able to pull a fire alarm in a building you've never entered.**

- **The "off switches" don't fully switch things off.** Turning the dispatch system off is
  supposed to stop everything, but it only stops _new_ customer requests — money can still move
  and jobs can still be handed out through side doors. And if that helper service hiccups, the
  off-switch quietly flips back on by itself. **Like a shop's "CLOSED" sign that only locks the
  front door while the side doors stay open, and pops back to "OPEN" if the power blinks.**

- **The money-moving background jobs have no smoke alarm.** If the job that refunds customers or
  pays companies silently dies, the app still reports itself perfectly healthy. Money could stop
  moving for days before anyone notices — because the only thing that would catch it (a daily
  audit) is set up in a way that basically never runs.

- **Turning the dispatch system off strands money that's mid-flight.** The same jobs that refund
  or release held money only run while the system is "on." Switch it off with jobs in progress
  and that money freezes.

- **Staff permissions are looser than they should be in a few spots.** A regional operator can
  reach into another region's records (including moving money); a branch manager can edit another
  branch's attendance/timesheets; and big money levers (adjusting wallets, changing exchange
  rates) sit with a mid-level role instead of top admins, with no cap on the amounts.

- **The system leans entirely on the app to keep customers' data separate — there's no second
  lock.** Normally a database has its own built-in wall between different customers' data. Here,
  that wall is turned off, so the _only_ thing keeping your data from mine is the app remembering
  to ask the right question every single time. Most of the time it does — but a few places forget
  (that's how the SOS and attendance issues above happen), and there's no backstop when they do.

- **Fake GPS can tilt the system.** The app trusts the phone's word for "this location is real,"
  and its fraud check only catches teleporting-across-the-country speeds — so a company can drift
  a fake location slowly and make itself look like the nearest available guard.

**Lower-risk, but worth knowing:**

- Two "time bombs" are harmless today only because fees and exchange rates are set to zero/one —
  the moment finance sets real numbers, one path starts over/under-charging customers and another
  can jam the dispute process.
- The app kills its own live-tracking when phones go to sleep (except for the lead guard), so a
  backgrounded company quietly disappears from the "available" list, and a backgrounded guard or
  customer stops sharing location mid-mission — with no warning that it stopped.
- The safety net that's _supposed_ to prevent double-charging under rapid taps isn't airtight; a
  deeper database rule is what actually saves it today.

**The uncomfortable part: we can't fully prove any of this is safe.** The automated tests don't
actually exercise the real database, the safety-critical screens have no working tests at all,
and the full three-device real-world run has never been done. So "the tests pass" tells us very
little about the things that matter most here.

**Bottom line in one line:** the everyday experience is solid, but the money-safety and
did-a-real-guard-show-up guarantees have real holes, the app is too fragile operationally, and
we don't yet have proof it's safe — so it should **not** go live for real money or real
protection missions until the "fix first" list above is done and actually tested on real devices.

---

_Compiled 2026-08-28 from six parallel adversarial source investigations; the lead independently
re-verified the P0/P1 headline of each stream (MON-1, INFRA-1, AUTHZ-1, MOB-1, FSM-1/2, the DPA
function, the Stripe handler) and refuted one sub-auditor false-positive (FRAUD-5). All `file:line`
citations are to `main` @ `e9146751`; re-grep symbols before acting — line numbers age fast._
