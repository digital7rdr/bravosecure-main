# Bravo Credits (BC) — Top-Up / Deduction / Manage / Add Audit

> **REMEDIATED 2026-07-05 (same day)** — every finding below was fixed in the
> follow-up commit; see §6 _Remediation log_ at the bottom for what changed
> where. The findings sections are kept as written for the audit record.

**Date:** 2026-07-05 · **Auditor:** Claude (full-repo + live-DB audit)
**Scope:** every code path that mints, debits, refunds, escrows, expires, or displays Bravo Credits — mobile (`src/`), ops console (`apps/ops-console/`), auth-service backend (`apps/auth-service/`), Supabase schema + live staging data.
**Product rule under test:** _all currency is represented as **BC**, with **1 unit of currency = 1 BC**, purchase reachable from anywhere, and BC calculation intact end-to-end._

---

## 1. Verdict summary

| Question                                                       | Verdict                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is every amount displayed as BC?                               | ❌ **No** — 32 hard fiat renders (AED/€/$/EUR) + 13 "cr"/"credits" soft violations remain                                                          |
| Is 1 currency = 1 BC enforced?                                 | ❌ **No** — three conflicting conversion regimes coexist (1:1, 10 BC/USD, marketing packages)                                                      |
| Is the BC calculation intact (client promise == server award)? | ❌ **No** — every CreditsScreen package and the paywall discount tier award different credits than promised                                        |
| Is purchase reachable from anywhere?                           | ⚠️ **Client role: yes (5 entry points). Agent/CPO/agency roles: no path at all. Pro paywall: orphaned.**                                           |
| Is the ledger/debit machinery itself sound?                    | ✅ **Largely yes** — booking debit, escrow, refunds, payouts, expiry are transactional, idempotent, and well-tested (2 races + hygiene gaps noted) |
| Ops "manage/add credits" surface                               | ⚠️ **Does not exist** — no admin grant/adjust lever; dispute-resolve endpoint has no console UI                                                    |

---

## 2. How the money actually moves (verified architecture)

### 2.1 Top-up (purchase)

1. Mobile calls `POST /wallet/topup` (`src/services/stripe.ts:63` → `apps/auth-service/src/wallet/wallet.controller.ts:44`).
2. Server computes credits **itself**: `computeCreditsForFiat()` (`wallet.service.ts:1286`) = `round(amount / FX[currency] × creditsPerUsd)` with `creditsPerUsd = BRAVO_CREDITS_PER_USD ?? 10` (`config/configuration.ts:83`, `.env` currently `=10`) and FX defaults `aed 3.67 / eur 0.9259 / sar 3.75 / gbp 0.787 / bdt 110` (flagged in-code as _demo placeholders_).
3. Stripe enabled → PENDING ledger row + PaymentIntent; settled by **webhook** (`handleStripeEvent`) _or_ **client confirm** (`POST /wallet/topup/confirm` — server re-verifies the intent against Stripe, never trusts the client). Stripe disabled → immediate local credit (dev fallback).
4. Every positive delta mints a `wallet_credit_batches` row with a **12-month TTL**; debits consume batches FIFO-by-expiry; a cron sweep expires remainders and writes an `expire` ledger row.

### 2.2 Deduction (spend)

- **Booking:** `POST /booking/:id/pay-with-credits` → `booking.service.ts:366 payWithCredits` — single transaction, `FOR UPDATE` on booking **and** payer wallet, FSM state guard, family-payer resolution + spend-limit, ledger insert + balance decrement + FIFO batch consumption all atomic. Cost = `Math.round(total_eur)` → **1 EUR-unit = 1 BC** (matches `pricing.service.ts` BASE_RATE_EUR 86 and the client mirror `src/screens/booking/pricing.ts` BASE_RATE_BC 86).
- **Pro subscription:** `subscription.service.ts:52` — `debitForFeature` (locked, tx-bound) of `PRO_MONTHLY_BC = 2000`, tier flip in the same transaction.
- **Escrow (auto-dispatch):** `holdToEscrow` / `refundEscrowHold` / `releaseEscrowHold` / `settleEscrowSplit` / `clawbackReleasedHold` (`wallet.service.ts:443-881`) — paired ledger rows, conservation checked (`gross == provider + client + fee`), idempotent via `FOR UPDATE` status gates + `ux_wallet_tx_payout`.
- **Stale payment sweep:** PAYMENT_PENDING > 15 min → CANCELLED (`payment-pending-expiry.service.ts`), Redis-locked, race-safe.

### 2.3 Add (credit)

- **Mission payout:** ops `completeBooking` (`ops.service.ts:1180-1286`) — even split of `round(total_eur)`, per-officer deduction overrides (bounded `0..evenSplit`, reason required), aggregated per payee (org-as-payee), `creditForBooking` idempotent per (user, booking). Agent-side `disburseMissionPayout` (`agent.service.ts:1457`) is the simple even-split twin; both are mutually idempotent via the same index.
- **Refunds:** `refundForBooking` (amount derived **server-side** from the original payment rows — caller can't inflate it) + escrow refund/split paths. Idempotent via `ux_wallet_tx_booking_refund`.
- **Promo:** `POST /wallet/redeem-promo` — per-user PK guard against double redeem.
- **Ops manual grant/adjust:** **none exists** (see F-14).

### 2.4 Wire representation

`toClientTx` (`wallet.service.ts:1303-1313`) maps every ledger row to `currency: 'BC'` before it leaves the server — the wire contract is BC-first. ✅

---

## 3. Findings

Severity: **C** = breaks the stated product rule / money integrity now · **H** = user-visible defect or real risk · **M** = correctness/hygiene gap · **L** = polish.

### F-01 (C) — Top-up packages promise credits the server does not award

`src/screens/wallet/CreditsScreen.tsx:63-68` sells fixed packages (500 BC / AED 500, 1,200 BC / AED 1,000, 3,000 BC / AED 2,400, 10,000 BC / AED 7,500) but the client only sends the **fiat amount** (`topUpAndCharge({amountFiat: pkg.priceAed, currency:'aed'})`, line 127). The server ignores the package and computes `round(amount / 3.67 × 10)`:

| Package promises      | Server actually awards |
| --------------------- | ---------------------- |
| 500 BC (AED 500)      | **1,362 BC**           |
| 1,200 BC (AED 1,000)  | **2,725 BC**           |
| 3,000 BC (AED 2,400)  | **6,540 BC**           |
| 10,000 BC (AED 7,500) | **20,436 BC**          |

The success alert then reports the _package_ number (`CreditsScreen.tsx:138`), not the server's `credits_awarded`. UI, receipt, and wallet all disagree.
**Live evidence:** staging wallet `1eccd303…` holds one topup ledger row of exactly **5,450 BC** = `round(2000/3.67×10)` against a balance of 2,000 — the mismatch is already materialized in data.

### F-02 (C) — "1 currency = 1 BC" is violated by the top-up conversion itself

Three regimes coexist:

1. **Bookings/payouts:** `total_eur` ⇄ BC at **1:1** ✅ (server `payWithCredits`, `completeBooking`; client `pricing.ts` "BC is 1:1 with EUR in Phase 1").
2. **Top-up server math:** **1 USD = 10 BC** (`BRAVO_CREDITS_PER_USD=10` in `apps/auth-service/.env`; default `?? 10` in `configuration.ts:83` and duplicated in `stripe.client.ts:46`) plus a placeholder FX table.
3. **Client paywalls:** `src/screens/booking/creditMath.ts:21` hardcodes `BC_PER_USD = 10` (USD packages), while `CreditsScreen` uses AED marketing packages that match _neither_.

**Fix path for the stated rule (1 currency = 1 BC):** set `BRAVO_CREDITS_PER_USD=1` **and** pin the charge currency the wallet is denominated in (or set the FX entry for the charge currency to 1), change `creditMath.ts` `BC_PER_USD` to 1, and rebuild the CreditsScreen packages as `credits == price`. Note this makes topping up ~10× more expensive per BC than today unless booking prices are rescaled — a product decision that must be made **once, consistently**, then encoded in one shared constant (server-authoritative, client-mirrored, contract-tested).

### F-03 (H) — Double-credit race between webhook and client confirm

`confirmIntent` (`wallet.service.ts:998-1005`) and `handleStripeEvent` (`:1056-1063`) both do `SELECT` (status=pending) → `UPDATE … SET status='succeeded' WHERE id=$1` → `applyCreditDelta`. Neither UPDATE carries `AND status='pending'`, and nothing is row-locked, so a webhook landing concurrently with the mobile confirm can credit the same top-up **twice**. Fix: `UPDATE … WHERE id=$1 AND status='pending' RETURNING id` and only credit when a row came back (both paths), ideally inside one transaction with `applyCreditDelta`.

### F-04 (H) — Purchase is NOT reachable for agent/CPO/agency roles

All four purchase screens (`Credits`, `PaymentMethods`, `CreditPaywall`, `ProPaywall`) are registered **only** in `BookingNavigator` (client `SecureTab`). `AgentNavigator`, `CpoNavigator`, and `DepartmentalNavigator` register none of them (`MainNavigator.tsx:561-575` routes non-client roles to different shells). `EarningsScreen` shows balances but offers no top-up. If "purchase from anywhere" includes provider roles, this is the biggest gap.
**Client-role entry points (working):** Secure-home "My Credits" (`BookingHomeScreen.tsx:282`), Profile wallet "Top Up" (`ProfileScreen.tsx:223`), Profile → Billing → Payment Methods / Transaction History (`ProfileScreen.tsx:86-89`), booking-flow insufficient-credits catch (`CustomizeAddOnsScreen.tsx:168`), OpsRoom review "TOP UP NOW" sheet (`OpsRoomReviewScreen.tsx:517`).

### F-05 (H) — Pro subscription purchase is orphaned; `tier_insufficient` is a dead end

- `ProPaywall`'s only inbound edge is `ProLandingScreen.tsx:144`, and **nothing navigates to `ProLanding`**.
- Profile "UPGRADE" goes `ProRetainers → ProClientProfile`, never the paywall.
- `api.ts:61-71` emits `onTierInsufficient` on 403 `tier_insufficient` — **no subscriber exists**, so Pro-gated actions fail silently with no purchase route.

### F-06 (H) — Credit batches + vault-storage endpoints don't exist (silent 404s)

`walletApi.getCreditBatches()` → `/wallet/credits/batches` and `purchaseVaultStorage/getVaultStorage` → `/vault/storage*` have **no backend route anywhere** (`grep apps/` = zero matches; marked "Phase-1 placeholders" at `api.ts:1280`). Consequence: the CreditsScreen "CREDIT BATCHES" section and the earliest-expiry warning **never render** — users cannot see the 12-month expiry the backend enforces, so credits will vanish (sweep writes an `expire` row) with no advance warning UI.

### F-07 (H) — Currency-display violations (the "everything is BC" sweep)

32 hard fiat renders + 13 "cr"/"credits" renders. Highest-traffic offenders:

_Mobile:_ `CreditsScreen.tsx:64-67,259,341` (AED package prices + "Top Up · AED …" CTA), `CreditsScreen.tsx:323` (history rows print `tx.currency` — fine today because the server sends 'BC', but typed to carry fiat), `FileVaultPurchaseScreen.tsx:151-153` (€/AED), `ProDashboardScreen.tsx:113` (AED 2,400/month), `ProTeamConfigScreen.tsx:59,82` (€/mo), `TripHistoryScreen.tsx:92` (AED), `IncomingOfferScreen.tsx:183` + `AgentDashboardScreen.tsx:443` + `EarningsScreen.tsx:72` + `AgentCoverageScreen.tsx:34` (agent AED rates), `ProfileScreen.tsx:210` (wallet chip renders fiat code / 'cr'), `ProRetainersScreen.tsx:23-25` ("credits"), paywall USD strings (`creditMath.ts:32-35`, `CreditPaywallScreen.tsx:508,538`, `ProPaywallScreen.tsx:167`).
_Ops console:_ `dashboard/page.tsx:28,62` (AED + GMV KPI), `bookings/page.tsx:63`, `bookings/[id]/page.tsx:495,592-599,653` (EUR/AED pricing card + invoice total), `live/[id]/page.tsx:236,507`, `live/wall/page.tsx:255` (hardcoded "AED 128k"), `agents/*` rate labels, `dispatch-inspector/[id]/page.tsx:109,148`.
_"cr" family:_ `BookingHomeScreen.tsx:351`, `TripSummaryScreen.tsx:151`, `AddOnsScreen.tsx:85,181`, `TripHistoryScreen.tsx:69`, `ProActivityHistoryScreen.tsx:48`, `AgentHomeScreen.tsx:62`, `IndividualProfileScreen.tsx:268,279`, `CorporateProfileScreen.tsx:50`, alerts at `CreditsScreen.tsx:105` and `BookingConfirmationScreen.tsx:209`.
_Latent risk:_ both `formatCurrency()` helpers (`src/utils/currency.ts:28`, `src/utils/helpers.ts:42`) emit fiat via `Intl.NumberFormat` — currently test-only; delete or convert to a BC formatter before someone wires them in.
_(Compliant: ~35+ sites already render "BC", incl. the whole ops payout modal, CreditPaywall tables, agent earnings, OpsRoomReview.)_

### F-08 (M) — Paywall discount tier promises 2,500 BC, server awards 2,375

`creditMath.ts:35`: the "5% off" package charges $237.50 but the server awards `round(237.50 × 10) = 2,375 BC`, not the promised 2,500. Discounts require server-side package SKUs (server must own the credits-per-package mapping, e.g. via a `package_id`), not client-side price math.

### F-09 (M) — `debitForBooking` has a TOCTOU race and is unused in production

`wallet.service.ts:888-907`: balance check without `FOR UPDATE`/transaction; ledger insert and balance decrement are separate statements. Two concurrent calls could overdraw; a crash between statements desyncs ledger↔balance. Its only callers are its own spec — `payWithCredits` correctly inlines a locked version. Delete it or rewrite on the `debitForFeature` pattern before anyone reuses it.

### F-10 (M) — `applyCreditDelta` paths are not atomic

Top-up settle (webhook/confirm), promo redeem, and fallback top-up run `insertTx` → `UPDATE wallet_balances` → `INSERT wallet_credit_batches` as **separate statements outside a transaction** (`wallet.service.ts:1094-1114`). A crash mid-sequence yields a succeeded ledger row with no balance bump (or balance without batch). Wrap settle+credit in one `withTransaction`.

### F-11 (M) — No DB-level negative-balance backstop

`wallet_balances.bravo_credits INTEGER NOT NULL DEFAULT 0` has **no `CHECK (bravo_credits >= 0)`** (`20260423160000_wallet_assignment_telemetry.sql:14-20`). Non-negativity relies entirely on app-side locked guards; raw scripts (`scripts/e2e-*.ts` write balances directly) or a future unguarded path can drive wallets negative silently. Add the CHECK (exempt or separately handle the platform-fee account, which may legitimately front clawback shortfalls — `wallet.service.ts:853-866`).

### F-12 (M) — Ledger↔balance drift exists in staging and nothing watches for it

Live probe: **8 of 51 wallets** have `balance ≠ Σ succeeded ledger` (7 seeded wallets balance 2,000 vs ledger 5,450 — the F-01 conversion mismatch materialized; one organic-looking −224). 0 negative balances. There is no reconciliation job/alert; drift is only logged opportunistically (`debitBatchesFifo` warn). Add a nightly reconciliation query (balance vs ledger vs batches) with alerting.

### F-13 (M) — History screen misclassifies payouts for agents

`CreditsScreen.tsx:153-154, 312-323`: `payout` rows (money **in** for a CPO/org) render with a debit arrow and a **−** sign and are summed into "SPENT". `expire` rows fall into the same else-branch by luck. Classify by sign or by type-set {topup, refund, payout} = credit.

### F-14 (M) — "Manage/add" does not exist as an ops surface

There is **no endpoint and no console UI** for ops to grant/adjust/deduct arbitrary BC. All ops money motion is a side-effect of booking lifecycle (complete/dispute/abort), correctly guarded (`JwtAuthGuard + CsrfGuard + AdminGuard`, `@RequireRoles('SUPERVISOR','ADMIN')`, region-scoped). Additionally: `POST /ops/disputes/:id/resolve` (the one admin money lever) has **no ops-console UI**, and `finance/page.tsx` is a "BACKEND PENDING" stub. If manual adjustment is wanted, build it as a new guarded endpoint writing a distinct `type` with mandatory reason + audit row — never raw SQL.

### F-15 (L) — Hygiene

- **Promo schema drift:** `promo_codes`/`promo_redemptions` exist in the live DB but in **no migration** — a fresh environment breaks `redeem-promo`. Also `redeemPromo`'s `max_redemptions` check-then-increment isn't atomic (small oversell window), and its ledger insert + credit aren't transactional (F-10 family).
- **Stripe-disabled fallback mints free BC** (`wallet.service.ts:239-259`): correct for dev, but nothing but `STRIPE_SECRET_KEY`'s presence gates it — a misconfigured prod deploy becomes an infinite money printer. Gate on `NODE_ENV`/explicit flag. (Key currently set; it's an `sk_test_` key; `.env` is not git-tracked ✅.)
- `sweepExpiredCredits` hardcodes `fiat_currency:'usd'` on expire rows (`wallet.service.ts:1203`).
- `CreditPaywallScreen` success shows `afterBalance = balance + pkg.credits` (client promise, line 93/151) though line 122 already has the server's `credits_awarded`.
- `creditsPerUsd` default is duplicated (`configuration.ts:83` and `stripe.client.ts:46`) — one source of truth.
- FX defaults are marked "demo placeholders — finance/CFO-signed rates required" (`configuration.ts:162`, `wallet.service.ts:1267-1270`); still true.
- Two payout margin models coexist: legacy complete pays ~100% of `total_eur` to crew (platform keeps rounding dust + explicit deductions), escrow release takes `feePct`. Intentional per Step-11 design, but document it.
- Ops payout overrides silently no-op if the agent-side even-split already paid (idempotency wins) — accepted design, worth an ops-console hint.

---

## 4. What is verified GOOD ✅

- **`payWithCredits`** — fully transactional, double-device race closed, family spend-limits enforced, FSM-guarded (`booking.service.ts:366-468`).
- **Escrow machinery** — paired debit/credit rows, conservation (`gross == provider + client + fee`) asserted in code and tests, `FOR UPDATE` idempotency gates, clawback shortfall handling.
- **Idempotency indexes** exist and exactly match the `ON CONFLICT` predicates (`ux_wallet_tx_payout`, `ux_wallet_tx_booking_refund`, `ux_mission_payouts_unique`).
- **Refund amounts derived server-side** from original payment rows — tamper-proof.
- **Client-confirm re-verifies with Stripe**; webhook is HMAC-verified (timing-safe compare, 5-min tolerance).
- **Auth:** every wallet route JWT-guarded and self-scoped; every ops money route SUPERVISOR/ADMIN + region-scoped; RLS deny-by-default on wallet tables.
- **Wire contract is BC** (`toClientTx` → `currency:'BC'`).
- **Expiry policy** (12-month batches, FIFO consumption, sweep + `expire` audit rows) is implemented and tested — only its _visibility_ is broken (F-06).
- **Tests green** (2026-07-05): `apps/auth-service` `wallet.service.spec` — pass (34 cases incl. escrow conservation, FX, expiry sweep); mobile Jest `app` project (`creditMath`, `CreditsScreen.topup`, `proPaywallFlow`, `pricing`) — pass, exit 0.
- **Live DB:** 0 negative balances across 51 wallets.

---

## 5. Priority fix list

| #   | Action                                                                                                                                                                                                                                                                              | Fixes            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Decide the peg once (recommend **1 fiat unit = 1 BC** per product rule), set `BRAVO_CREDITS_PER_USD=1`, align `creditMath.BC_PER_USD`, rebuild CreditsScreen packages as `credits == price`, add a contract test asserting client package credits == `computeCreditsForFiat` output | F-01, F-02, F-08 |
| 2   | Make top-up settle atomic + status-guarded (`AND status='pending' RETURNING`)                                                                                                                                                                                                       | F-03, F-10       |
| 3   | Register a top-up route for agent/CPO navigators (or explicitly document provider wallets as payout-only)                                                                                                                                                                           | F-04             |
| 4   | Wire `ProPaywall` (Profile UPGRADE → paywall) + subscribe to `onTierInsufficient`                                                                                                                                                                                                   | F-05             |
| 5   | Implement `GET /wallet/credits/batches` (data already exists) so expiry is visible; delete or implement vault-storage endpoints                                                                                                                                                     | F-06             |
| 6   | BC-ify the 45 display violations behind one shared `formatBc()` helper; delete the fiat `formatCurrency` helpers                                                                                                                                                                    | F-07             |
| 7   | `CHECK (bravo_credits >= 0)` + nightly ledger↔balance reconciliation with alert                                                                                                                                                                                                     | F-11, F-12       |
| 8   | Delete `debitForBooking`; fix history sign logic; migration for promo tables; gate the no-Stripe fallback                                                                                                                                                                           | F-09, F-13, F-15 |

---

## 6. Remediation log (2026-07-05)

| Finding   | Fix                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01/F-02 | Peg hard-coded: `WalletService.computeCreditsForFiat` now returns `round(amount)` (1 fiat unit = 1 BC, FX table kept for receipt metadata only); `BRAVO_CREDITS_PER_USD` removed from config/env/StripeClient; `creditMath.BC_PER_USD = 1`; CreditsScreen packages rebuilt as `credits == charge` (500/1,000/2,500/7,500), success alert shows server `credits_awarded` |
| F-03      | New `settlePendingTopup()` — status-guarded `UPDATE … AND status='pending' RETURNING` inside one transaction, shared by webhook + client-confirm; race test added                                                                                                                                                                                                       |
| F-04      | `Credits` + `PaymentMethods` registered in `AgentNavigator` (agency role) + Top-Up button on `EarningsScreen`. **CPO shell intentionally excluded** — §35A §D capability lockdown forbids the wallet in the managed-guard build (enforced by `cpoCapability.test.ts`; CPO payouts land on the org wallet anyway)                                                        |
| F-05      | `onTierInsufficient` subscriber in `MainNavigator` (client shell) → routes to `ProPaywall`; `ProRetainersScreen` footer gained a direct "Subscribe to Bravo Pro" link                                                                                                                                                                                                   |
| F-06      | `GET /wallet/credits/batches` implemented (`WalletService.listBatches`, mobile `CreditBatch` shape); `walletApi.getCreditBatches` moved to the auth-service client. Vault-storage endpoints deliberately left as placeholders (File-Vault MFA is a locked security surface — separate work)                                                                             |
| F-07      | All fiat/"cr" render sites converted to BC across mobile + ops console (BC values sourced from `*_eur` fields, never `total_aed`); `formatCurrency` helpers rewritten as BC formatters                                                                                                                                                                                  |
| F-08      | Discount tier removed — every package charges exactly its credits; contract test asserts client packages == server award                                                                                                                                                                                                                                                |
| F-09      | Dead racy `debitForBooking` deleted (with its spec); `payWithCredits` remains the locked booking-debit path                                                                                                                                                                                                                                                             |
| F-10      | `applyCreditDelta` now transactional (`creditDeltaTx`); fallback top-up + promo redeem + settle paths all single-transaction                                                                                                                                                                                                                                            |
| F-11      | Migration `20260705000000_wallet_bc_audit_guards.sql`: `CHECK (bravo_credits >= 0)` (platform escrow/fee accounts exempt) — **applied to live Supabase**                                                                                                                                                                                                                |
| F-12      | `WalletService.reconcileBalances()` (detection-only) piggybacked on the hourly expiry cron; warns per drifted wallet                                                                                                                                                                                                                                                    |
| F-13      | History rows classify {topup, refund, payout} as credits — agent payouts no longer shown as "spent"                                                                                                                                                                                                                                                                     |
| F-14      | `POST /ops/wallets/:userId/adjust` (SUPERVISOR/ADMIN, ±100k cap, mandatory reason, idempotency-key, ops_audit row) + Credit Adjustment card on the ops-console Finance page                                                                                                                                                                                             |
| F-15      | Promo tables codified in the same migration; `redeemPromo` fully transactional with `FOR UPDATE` (no oversell); no-Stripe fallback top-up blocked in production unless `ALLOW_NO_STRIPE_TOPUP=1`; expire ledger rows stamp the wallet currency                                                                                                                          |

**Follow-up (same day, round 2):**

- **Multi-currency acceptance:** `POST /wallet/topup` now accepts every product-region currency (`usd, aed, eur, sar, gbp, bdt` — all Stripe 2-decimal). Under the 1:1 peg the award is `round(amount)` regardless of charge currency.
- **Agent-rate remnant CLOSED:** agent hourly rates and Est. Earnings now render in BC via the canonical platform ratio (350 AED ≡ 86 BC from `pricing.service.ts`; helpers `bcFromAed` in `src/screens/booking/pricing.ts` and `apps/ops-console/src/lib/bc.ts`) — no invented FX, same ratio every booking already uses.

**Deploy note:** ✅ **DEPLOYED to Contabo staging 2026-07-05 22:08Z** (full `apps/auth-service/src` sync → server image rebuild → restart; backup `~/auth-predeploy-backup-20260705-220756.tgz`, rollback image `bravo/auth-service:rollback-20260705`). Live-verified: container healthy, `/auth/health` 200 (local + public sslip.io), `/auth/login {}` → 400 (signal_device_id hotfix intact, ×4 in dist), `GET /wallet/credits/batches` + `POST /ops/wallets/:id/adjust` → 401 (routes wired), compiled dist carries `return Math.round(amount)` (1:1 peg) + the sar/gbp/bdt whitelist, no errors in logs. auth container runs `NODE_ENV=staging` with no Stripe key → the fallback top-up path stays active on staging (the new production gate does not bite). Supabase migration applied; both wallet idempotency indexes confirmed live. **Mobile APK rebuild still pending** for the client-side changes.

---

_Method note: backend money paths read line-by-line; UI/currency/entry-point/ops surfaces swept by three parallel exploration passes; schema verified against `supabase/migrations/` **and** the live Supabase instance (table existence, negative-balance probe, ledger reconciliation probe); wallet + credit-math test suites executed._
