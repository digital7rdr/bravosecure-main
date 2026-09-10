# 3-Device Auto-Dispatch Smoke + Staged Rollout (BUILD_RUNBOOK Step 28)

The scripted manual proof that the whole auto-dispatch loop works on real devices, plus the
staged rollout + kill-switch drill. Reuses the **Device & Identity Reference** in `sqa.md`
(BlueStacks serial ↔ account ↔ Signal userId). Log any defect to `sqa.md` per the SQA convention.

> Everything below runs **dark** until `AUTO_DISPATCH_ENABLED=true` AND the runtime
> kill-switch (`dispatch:enabled`) is on. Finance must sign off the FX / platformFeePct /
> cancelFeePct placeholders before the first flip.

---

## Pre-flight (seed the loop)

1. One agency (one email set, D5) with a **~10-CPO roster** (`POST /agents` company account →
   managed CPOs via `POST /org/cpos`). Region `AE`.
2. Agency compliance: a **VERIFIED non-expired licence + insurance** for the region and an
   **accepted DPA** (`agents.dpa_accepted_at`), else `is_eligible_for_dispatch` fails.
3. Agency device **on duty** with a fresh location near the test pickup (the duty heartbeat
   keeps `agents.last_location_at` fresh; a stale/mocked fix drops it from the pool).
4. Client wallet funded (escrow charges on accept).

The reusable seed shape is `apps/auth-service/test/fixtures/dispatch-seed.ts`.

---

## Golden path (LOCKED decisions D1–D8)

| #   | Actor  | Step                                                                                                                            | Expected                                                                                                                  |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client | Request close protection A→B, **now** (D1 auto), tick the **location-sharing consent**                                          | Booking → `DISPATCHING` (the "Finding an agency" screen)                                                                  |
| 2   | Server | Offer the **nearest on-duty eligible agency in-region**, COARSE (no exact pickup to offered/rejecting agencies — correction #3) | `dispatch_offers` row `OFFERED`; agency sees a coarse offer card                                                          |
| 3   | Agency | **Accept** (D3)                                                                                                                 | Booking → `CONFIRMED`; client **charged INTO ESCROW** (D2 — `escrow_holds.status='HELD'`); wallet debited once            |
| 4   | Server | Ops Room opens (`ensureBookingOpsRoom`, **metadata only**)                                                                      | Group created; **agency company device** owns the group-key rekey for added CPOs (correction #5)                          |
| 5   | Agency | **Assign crew + leader** (D7 — this creates the mission)                                                                        | `missions` row `DISPATCHED`; CPOs added; group rekeyed via the agency device's membership-intent drain (NOT a server add) |
| 6   | CPO(s) | See the assigned mission, join the Ops Room                                                                                     | CPOs receive the group key via the agency rekey (verify: server holds no key)                                             |
| 7   | Lead   | One-tap `DISPATCHED→PICKUP→LIVE` then **Finish** (D8)                                                                           | Proof-of-completion gate runs; on pass → `escrow_holds PENDING_RELEASE`                                                   |
| 8   | Server | Dispute window elapses → release sweep                                                                                          | Agency paid (`mission_payouts`), `escrow_holds RELEASED`, group dissolved, `agents.jobs_total` +1                         |
| 9   | Client | Rate the agency                                                                                                                 | `agents.rating` recomputed; the next ranking reflects it                                                                  |

**Verify throughout:** push wakes stay **opaque** `{userId,eventClass,eventId}` (P0-N8) — no
`kind`/`bookingId` leaks in the messenger-service consumer.

## Error path — no agency online

1. Take every agency in-region off duty (or none eligible).
2. Client requests → cascade exhausts → **`NO_PROVIDER`** (the "no agency available" screen).
3. **Assert the client wallet is unchanged (NO charge)** — money only moves at accept.

---

## Staged rollout

1. **Dark launch.** Code deployed; `AUTO_DISPATCH_ENABLED=true` but the runtime kill-switch
   OFF (`PUT /ops/dispatch/killswitch {enabled:false}`, ADMIN). Legacy admin job board live;
   the watchdog + reconciliation sweeps already run. Watch `/metrics` + the SLO Sentry alerts.
2. **Canary AE.** Flip the kill-switch ON. Because the ranking is region-scoped
   (`agents.region_code`), only regions with seeded eligible on-duty agencies actually
   dispatch — so seeding agencies in **AE only** confines the canary to AE while SA/BD/GB stay
   legacy (no eligible pool → `NO_PROVIDER`). (A finer per-region enable list is a follow-up.)
3. **Ramp.** Seed + verify agencies region-by-region (SA → BD → GB), watching the Step-26
   metric set (`dispatch_no_provider_rate{region}`, `dispatch_acceptance_rate`,
   `dispatch_charge_failure_rate`, watchdog liveness) + the SLO alerts at each stage.

### Kill-switch drill (rehearse the off-switch BEFORE you need it)

1. With canary traffic live, `PUT /ops/dispatch/killswitch {enabled:false}` (ADMIN).
2. Within ~2s (the killswitch cache TTL) every pod stops issuing NEW auto-offers; new
   `/dispatch/request` calls 400 `auto_dispatch_disabled` and the client falls back to the
   legacy booking flow.
3. **Assert in-flight escrow is untouched** — `HELD`/`PENDING_RELEASE` holds keep moving
   through their sweeps; no booking is stranded; no double-charge.
4. Flip back ON; confirm new requests resume auto-dispatch.

---

## Money + reconciliation guarantees (continuous)

- The daily `EscrowReconciliationService` asserts `sum(client debits)==held` and terminal
  `gross==to_provider+to_client+platform_fee`, increments `dispatch_money_drift_total` and
  pages Sentry on any drift (covered by `reconciliation.itest` + the unit spec).
- The §43 unit invariants still hold: double-tap accept → one hold; finish-with-failing-proof
  → `review_required`, never released; dispute-vs-release race → dispute freezes, no payout.
