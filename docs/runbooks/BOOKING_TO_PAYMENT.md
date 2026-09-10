# Booking → Payment → Live Ops (End-to-End)

Full trace of a Bravo Secure Lite booking, from the first tap on **Secure** in
the tab bar to a vehicle streaming GPS fixes on the client's map. Every hop
lists the file, the endpoint, and the column/table it reads or writes.

All endpoints below are on **auth-service** (`http://10.0.2.2:3001` from the
emulator, `https://auth.bravosecure.app` in prod) unless stated otherwise.

---

## 0. Prerequisites — run these once

### Apply the migration

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260423160000_wallet_assignment_telemetry.sql
```

This creates:

| Table                     | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `wallet_balances`         | One row per user. Holds BC balance + Stripe customer id.        |
| `wallet_transactions`     | Append-only ledger (`topup` / `payment` / `refund` / `payout`). |
| `cpo_pool`                | Roster of close-protection officers, seeded with 5 rows.        |
| `vehicle_pool`            | Roster of armored vehicles, seeded with 4 rows.                 |
| `booking_cpo_assignments` | Many-to-many join for N-CPO bookings.                           |
| `mission_telemetry_last`  | Latest GPS fix per booking (Redis Stream fallback).             |

### Environment

**`apps/auth-service/.env`** (git-ignored):

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…          # from `stripe listen` or dashboard
BRAVO_CREDITS_PER_USD=10
```

**Mobile `.env`** (git-ignored):

```
EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…
```

If `STRIPE_SECRET_KEY` is blank the server runs in **fallback mode**:
`/wallet/topup` still mints a succeeded ledger row and credits BC locally,
but no PaymentIntent is created. Useful for demos without Stripe access.

### Stripe webhook (only when using real Stripe)

```
stripe listen --forward-to localhost:3001/wallet/stripe-webhook
```

Copy the `whsec_…` into `STRIPE_WEBHOOK_SECRET`.

---

## 1. Build the booking — Lite wizard

| Step | Screen                     | Writes to                                           |
| ---- | -------------------------- | --------------------------------------------------- |
| 1    | `ZoneMapScreen`            | `bookingStore.draft.region`                         |
| 2    | `ServiceTypeScreen`        | `draft.service`                                     |
| 3    | `BaselinePackageScreen`    | `draft.cpo_count` / `vehicle_count` / `driver_only` |
| 4    | `CustomizeAddOnsScreen`    | `draft.add_ons[]`                                   |
| 5    | `BookingDateTimeScreen`    | `draft.pickup_time`, `draft.pickup.address`         |
| 6    | `BookingHomeScreen` review | Triggers `bookingStore.confirmBooking()`            |

`confirmBooking()` in `src/store/bookingStore.ts` posts to:

```
POST /bookings         (authHttp — Bravo JWT)
```

Handled by `BookingController.create` →
`BookingService.create` in `apps/auth-service/src/booking/booking.service.ts`.

What happens server-side, in order:

1. Validates `pickup_time` is ≥ 3 hours out (`MIN_LEAD_HOURS`).
2. Resolves add-ons from `lite_booking_add_ons`.
3. `PricingService.calculate` computes `rate_eur_per_hour`, `total_eur`,
   `total_aed`.
4. FSM asserts the `DRAFT → PENDING_OPS` transition.
5. Inserts a row into `lite_bookings` with status `PENDING_OPS`.
6. Writes two audit rows to `lite_booking_audit`.
7. **Auto-assigns the team** (Phase-1 shortcut so the confirmation
   screen has real rows):
   - `CpoAssignmentService.assign` — locks N CPOs via
     `SELECT … FOR UPDATE SKIP LOCKED`, writes `booking_cpo_assignments`,
     flips `cpo_pool.availability` to `on_mission`.
   - `VehiclePoolService.assign` — same lock-and-claim on `vehicle_pool`,
     writes `lite_bookings.vehicle_id`.
   - If either pool is exhausted we log a warning but still return the
     booking — ops can resolve manually.

Response:

```json
{ "booking": { "id": "uuid", "status": "PENDING_OPS", ... } }
```

The client navigates to **CreditPaywall** if the client's BC balance is
short, otherwise straight to **BookingConfirmation**.

---

## 2. Pay with Bravo Credits — the Paywall

File: `src/screens/booking/CreditPaywallScreen.tsx`.

User picks a package (`500 BC`, `1,000`, `1,500`, `2,500`). Tapping
**TOP UP N BC** opens a themed confirmation sheet. The real charge runs
in `runPayment`:

```ts
const {charged, result} = await topUpAndCharge({
  amountFiat: pkg.priceUsd,
  currency: 'usd',
});
```

`topUpAndCharge` lives in `src/services/stripe.ts`. It:

1. `POST /wallet/topup` via `walletHttp` (our Bravo-JWT axios client).
2. If the server returned `client_secret`, calls
   `initPaymentSheet(...) + presentPaymentSheet()` from
   `@stripe/stripe-react-native`.
3. If the server returned `fallback: true`, skips PaymentSheet — the
   wallet is already credited.

### Server path — `/wallet/topup`

`apps/auth-service/src/wallet/wallet.service.ts` → `WalletService.topUp`:

1. Computes BC awarded via `computeCreditsForFiat` (1 USD = 10 BC by default).
2. Ensures a `wallet_balances` row exists.
3. **Stripe disabled** (fallback):
   - Inserts a `wallet_transactions` row with `status = 'succeeded'`.
   - Runs `UPDATE wallet_balances SET bravo_credits = bravo_credits + N`.
   - Returns `{ fallback: true, credits_awarded, balance }`.
4. **Stripe enabled**:
   - `stripe.ensureCustomer(userId, existing)` — creates a `cus_…` on first
     top-up, stores on `wallet_balances.stripe_customer_id`.
   - `stripe.createPaymentIntent({ amountCents, currency, customer, metadata })`
     via a raw-fetch client (`src/wallet/stripe.client.ts`, no SDK dependency).
   - Inserts `wallet_transactions` with `status = 'pending'` +
     `stripe_intent_id`.
   - Returns `{ client_secret, intent_id, customer_id, credits_awarded,
balance }`. **The balance has not moved yet.**

### Stripe webhook — settles the pending ledger row

When the user completes PaymentSheet, Stripe POSTs to
`/wallet/stripe-webhook` (public, no JWT). `WalletController.stripeWebhook`
pulls `req.rawBody` (enabled via `rawBody: true` in `main.ts`), verifies
the HMAC signature (`StripeClient.verifyWebhook`), and dispatches the event
to `WalletService.handleStripeEvent`:

| Event                           | Effect                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `payment_intent.succeeded`      | `wallet_transactions.status = 'succeeded'`, then `UPDATE wallet_balances` to credit BC. |
| `payment_intent.payment_failed` | `wallet_transactions.status = 'failed'`. No credit.                                     |
| anything else                   | Ignored.                                                                                |

The ledger is the source of truth — client balance reads are just
`SELECT bravo_credits FROM wallet_balances WHERE user_id = …`.

### After the charge, client-side

```ts
useWalletStore.setState(st => ({
  ...st,
  balance: {
    bravo_credits: (st.balance?.bravo_credits ?? 0) + result.credits_awarded,
    currency: st.balance?.currency ?? 'AED',
  },
}));
await loadBalance(); // pull the authoritative balance from /wallet/balance
setSuccess(true);
```

On the success sheet the **Confirm Booking →** CTA calls
`bookingStore.confirmBooking()` and navigates to `BookingConfirmation`.

---

## 3. Booking Confirmation

File: `src/screens/booking/BookingConfirmationScreen.tsx`.

On mount we hit:

```
GET /bookings/:id/team        (authHttp)
```

`BookingService.getTeam` returns:

```json
{
  "cpos": [
    {
      "id": "uuid",
      "call_sign": "CPO 44",
      "display_name": "R. Al-Rashid",
      "role": "Senior CPO · Armed",
      "armed": true,
      "female": false,
      "specialties": ["armed", "exec_protection"]
    }, ...
  ],
  "vehicle": {
    "id": "uuid",
    "call_sign": "VEH 11",
    "make_model": "Toyota Land Cruiser 300",
    "plate": "A 4439",
    "armored": true,
    "armor_grade": "B6",
    "capacity": 5
  }
}
```

Those rows were written back in step 1 — this is a pure read.
If the team is empty (rare race or cold start), the screen shows the
Phase-1 demo crew so it never feels broken.

---

## 4. Live Ops — real telemetry

File: `src/screens/liveops/LiveTrackingScreen.tsx`.

Two concurrent hooks:

1. `assignmentApi.getTeam(bookingId)` — same endpoint as above, powers
   the **Team** tab.
2. `useLiveTelemetry(bookingId)` — polls:
   ```
   GET /telemetry/:bookingId/latest    (authHttp, every 5 s)
   ```
   Returns `{ latest: { lat, lng, eta_minutes, recorded_at, source } | null }`.

When the poll returns `null` (no fix yet), the screen falls back to the
canned simulated track so the vehicle dot keeps moving during demos.

### Telemetry ingest — agent side

The assigned CPO's companion app writes fixes with:

```
POST /telemetry/:bookingId/ping
Body: { lat, lng, heading_deg?, speed_kph?, eta_minutes? }
```

Auth rule: the caller's `sub` must match a `cpo_pool.id` that appears in
`booking_cpo_assignments` for this booking. Other users → 403
`not_assigned_to_booking`.

Server path — `TelemetryService.ping` in
`apps/auth-service/src/telemetry/telemetry.service.ts`:

1. Appends to Redis Stream `telemetry:{bookingId}` with
   `XADD MAXLEN ~ 500 * …` (~50 minutes at 6-second cadence).
2. Sets a 24-hour TTL on the key so stale mission streams get GCed.
3. Upserts `mission_telemetry_last` so `/latest` still returns the most
   recent fix if Redis goes down mid-mission.

### Read path — client

`/telemetry/:bookingId/latest`:

- Tries `XREVRANGE telemetry:{id} + - COUNT 1` first.
- Falls back to `SELECT * FROM mission_telemetry_last WHERE booking_id = $1`.
- Returns `null` if neither source has a fix.

`/telemetry/:bookingId/recent?count=60` mirrors the above but returns a
chronologically-ordered window (oldest → newest) for drawing a trail.

---

## 5. Cancellation — pool release

`POST /bookings/:id/cancel` → `BookingService.cancel`:

1. FSM asserts the current state allows `→ CANCELLED`.
2. `UPDATE lite_bookings SET status = 'CANCELLED'`.
3. `Promise.allSettled([cpoAssign.release(id), vehicles.release(id)])` —
   flips CPOs back to `available`, vehicle back to `available`, deletes
   `booking_cpo_assignments` rows.
4. Appends an audit row.

Credit refunds are not automated in Phase 1 — ops manually call
`WalletService.debitForBooking` in reverse (future: `/wallet/refund`
endpoint).

---

## 6. End-to-end test matrix

| Scenario                                              | Expected                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Create booking with enough BC                         | `PENDING_OPS` + team auto-assigned.                                              |
| Create booking short on BC                            | Paywall → `/wallet/topup` → PaymentSheet → booking confirms.                     |
| `/wallet/topup` with `STRIPE_SECRET_KEY` unset        | Server credits locally, returns `fallback: true`.                                |
| `/wallet/topup` with Stripe configured, card declined | `payment_intent.payment_failed` webhook → ledger row `failed`, no BC credited.   |
| CPO pool empty                                        | Booking still persists; warning logged; `/bookings/:id/team` returns `cpos: []`. |
| `/telemetry/:id/ping` from non-assigned user          | 403.                                                                             |
| LiveTracking before first fix                         | Simulated dot moves; real fix takes over on first ping.                          |
| Cancel an active booking                              | Pool rows released; audit row present.                                           |

---

## 7. Quick debug checklist

| Symptom                                | Likely cause                                                                                      | Fix                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Top-up failed · 404`                  | `/wallet/topup` not mounted                                                                       | Check `WalletModule` is in `AppModule.imports`.                                                              |
| `Top-up failed · 401`                  | Client sent a Supabase JWT to auth-service                                                        | Ensure client uses `walletHttp` (Bravo JWT) not `api`.                                                       |
| Webhook returns `bad_signature`        | Raw body mangled by a middleware                                                                  | Confirm `rawBody: true` on `NestFactory.create`.                                                             |
| CPOs never assigned                    | Empty pool for that region                                                                        | Re-run the migration or insert rows into `cpo_pool`.                                                         |
| LiveTracking dot never moves           | No real fixes AND simulator paused                                                                | Check the agent app is posting `/telemetry/:id/ping` and/or the emulator is awake.                           |
| Webhook settles but BC balance still 0 | Webhook signature matched but `wallet_transactions.stripe_intent_id` didn't match any pending row | Check `WalletService.handleStripeEvent` log — usually means the PaymentIntent was minted by a different env. |

---

## 8. File map

### Backend (`apps/auth-service/src/`)

```
booking/
  booking.controller.ts        # /bookings + /bookings/:id/team
  booking.service.ts           # create / cancel / getTeam / assignment wiring
  pricing.service.ts           # fare calc
  state-machine.service.ts     # lite_booking_status transitions
  assignment/
    cpo-assignment.service.ts  # N-CPO picker with specialty preference
    vehicle-pool.service.ts    # armored-vehicle picker

wallet/
  wallet.controller.ts         # /wallet/balance | /transactions | /topup | /stripe-webhook
  wallet.service.ts            # ledger + balance mutations + webhook handler
  stripe.client.ts             # raw-fetch Stripe shim + HMAC verifier

telemetry/
  telemetry.controller.ts      # /telemetry/:id/ping | /latest | /recent
  telemetry.service.ts         # Redis Stream writes + Postgres fallback
```

### Migrations (`supabase/migrations/`)

```
20260423113000_booking_module.sql                   # lite_bookings family
20260423160000_wallet_assignment_telemetry.sql      # wallet + pool + telemetry
```

### Mobile (`src/`)

```
services/
  api.ts          # authHttp (Bravo JWT) + api (Supabase JWT)
  stripe.ts       # creditsApi + useTopUpFlow + usePaymentFlow
screens/booking/
  CreditPaywallScreen.tsx        # BC top-up wizard
  BookingConfirmationScreen.tsx  # pulls team via /bookings/:id/team
screens/liveops/
  LiveTrackingScreen.tsx         # pulls team + polls /telemetry/:id/latest
store/
  bookingStore.ts                # draft + confirmBooking()
  walletStore.ts                 # balance + transactions
```
