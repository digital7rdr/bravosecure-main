# OR-2 - Every messaging send-recovery path is timer-driven, so a locked screen freezes all of them

## Verdict

**CONFIRMED-WITH-DRIFT.** The mechanism is exactly as described; only the "inline-reconnect gate"
sub-claim needs a nuance, and the `fetchWithTimeout` sub-claim is real but **not fixable where the
audit points**. Evidence from the current tree:

1. WS ack watchdog is a plain `setTimeout` — `src/modules/messenger/runtime/productionRuntime.ts:2955`:
   `const ackTimer = setTimeout(() => { ... }, wsAckDeadlineMs());` with
   `WS_ACK_FLOOR_MS = 5_000 / WS_ACK_CEILING_MS = 20_000` (`:266-267`). Nothing else re-drives it.
2. Outbox retry tick is a plain `setInterval` — `productionRuntime.ts:1612`:
   `const outboxRetryTimer = setInterval(() => { void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow); }, 60_000);`
3. `fetchWithTimeout` aborts on a timer — `packages/messenger-core/src/transport/fetchWithTimeout.ts:32`:
   `const timer = setTimeout(() => controller.abort(), timeoutMs);` and `relayClient.ts:204` routes
   every relay POST through it, so the 20 s deadline is unenforced while the activity is paused.
4. The team already proved timers are frozen in this exact state, in its own comment at
   `client.ts:564-568`: _"React Native freezes JS timers while the Android host activity is paused,
   which is exactly the locked-screen state where calls were dying."_ B-100/B-101 event-drove only
   the **auth renewal** off that clock — `client.ts:853-857`:
   `const onManagerPing = (): void => { this.lastServerSignalAt = Date.now(); this.maybeRenewSocketAuth(); };`
   No send/outbox work hangs off it.
5. The timer-free reconnect is call-only — `client.ts:1059` `if (this.opts.hasLiveCall?.()) { this.scheduleServerReconnect(); }`
   and `client.ts:1095-1097` `if (this.serverReconnectAttempts === 0 && this.opts.hasLiveCall?.() && nowMs - this.lastImmediateReopenAt > IMMEDIATE_REOPEN_FLOOR_MS)`.
6. **Drift:** the audit says "fire `httpFallback` for pending unacked ids". `httpFallback` is a
   per-send closure inside `sendText` (`productionRuntime.ts:2886`) and is unreachable from the
   AppState handler. The durable-outbox row already carries the identical payload
   (`sqlOutbox.enqueue({... payload: JSON.stringify({outerSealed, expiresAtSec})})`,
   `productionRuntime.ts:2867-2877`) and `drainOutbox` ships it over the same HTTP relay — so the
   correct lever is `drainOutbox`, not a re-plumbed closure.
7. **Second-order defect found while verifying (must be fixed or leg B is worthless):**
   `productionRuntime.ts:7393-7401` guards the drain with a **bare boolean**
   `let drainOutboxInflight = false; ... if (drainOutboxInflight) {return;} drainOutboxInflight = true;`.
   A relay POST whose `fetchWithTimeout` abort timer is frozen does not settle while locked, so the
   flag latches and _every_ subsequent drain (including the new ones this spec adds) returns
   immediately. This is verbatim the failure mode the transport already learned about and guards
   against with a wall clock — `client.ts:580-583`: _"a wall-clock guard, never a bare boolean: an
   ack lost while the screen is locked never settles (its reject timer is frozen), and a latched
   flag would kill renewal for the whole call."_

## Mechanism

1. User taps send. `sendText` seals, writes the durable outbox row, `transport.send()` emits
   `envelope.send` over the WS, arms `ackTimer` (5–20 s), and `trackPending()`s the clientMsgId.
   The bubble stays `status: 'sending'`.
2. User locks the screen (or the app is backgrounded) within that window. Android pauses the host
   activity; RN's Timing module stops the JS timer queue. `ackTimer`, the 60 s `outboxRetryTimer`,
   and any in-flight `fetchWithTimeout` abort timer are all suspended.
3. The socket fd was already half-dead (Doze froze it, an AP roam killed the route, the gateway's
   revoked-jti sweep dropped it). socket.io buffered the emit; the server never received it.
   `envelope.accepted` never arrives, so `handleAccepted` → `clearPending` never runs.
4. Nothing left can act. Application frames can't wake JS (nothing is being delivered to us).
   socket.io's own reconnect is on its ~500 ms timer — frozen. The `disconnect` event _is_ delivered
   while locked, but `client.ts:1059` only reacts to it when `hasLiveCall()` is true, which it is
   not. The Manager `'ping'` clock keeps running (`client.ts:853`) but only drives auth renewal.
5. Result: the message sits at one tick indefinitely. On unlock, the frozen timers all fire at once
   — ack watchdog → HTTP fallback → the message finally lands, minutes-to-hours late. To the user
   and the peer this is "the message never sent".
6. Amplifier: if a relay POST was already in flight at lock time, `drainOutboxInflight` stays `true`
   for the whole lock, so even a drain that _is_ reachable is swallowed.

## Fix

Four legs. **Legs A–C are the fix and should ship together; leg D is optional and carries a
thundering-herd cost — see Risk.** No wire-format change, no schema change, no server change.

### 1. NEW `src/modules/messenger/runtime/sendRecoveryClock.ts`

Mirrors `callResumeGuard.ts`: pure, node-safe, unit-testable without the RN/native graph.

```ts
/**
 * OR-2 — the send-recovery clock.
 *
 * B-100/B-101 event-drove the CALL paths off the server's engine.io ping
 * because RN freezes JS timers while the Android host activity is paused.
 * Every MESSAGING recovery path was left on a timer: the 5-20s WS ack
 * watchdog, the 60s outbox tick, and `fetchWithTimeout`'s abort. Send +
 * lock onto a half-dead fd and nothing retries until unlock. These pure
 * helpers hold the two decisions that let the outbox drain ride the same
 * always-running clock the auth renewal already uses.
 */

/**
 * Minimum gap between server-signal-driven drains. The server's engine.io
 * heartbeat is ~25s, so in the silent locked case this is effectively "one
 * drain per heartbeat"; in a busy foreground chat it coalesces the
 * per-frame signals down to the same cadence.
 */
export const SIGNAL_DRAIN_MIN_INTERVAL_MS = 20_000;

/**
 * How long a drain may go without progress before another drain is allowed
 * to supersede it. Must exceed TRANSPORT_TIMEOUT_MS (20s) with margin: a
 * single slow-but-alive relay POST is not stuck. Measured against a
 * per-ROW heartbeat, not the drain start, so a long queue of slow rows
 * never trips it.
 */
export const DRAIN_STUCK_MS = 45_000;

export function shouldDrainOnServerSignal(lastDrainAt: number, now: number): boolean {
  return now - lastDrainAt >= SIGNAL_DRAIN_MIN_INTERVAL_MS;
}

/**
 * Whether a new drain may take the slot. `owner` is 0 when free.
 * Why a wall clock and never a bare boolean: a relay POST whose
 * `fetchWithTimeout` abort timer is frozen by a locked screen never
 * settles, and a latched flag would kill every later drain for the whole
 * lock — the same lesson `maybeRenewSocketAuth`'s REAUTH_STUCK_MS encodes.
 */
export function canStartDrain(owner: number, heartbeatAt: number, now: number): boolean {
  if (owner === 0) {
    return true;
  }
  return now - heartbeatAt >= DRAIN_STUCK_MS;
}
```

### 2. `packages/messenger-core/src/transport/client.ts` — expose the always-running clock (leg B seam) + extend the immediate-reopen gate (leg D)

**Anchor** (in `TransportClientOpts`, verbatim current code):

```ts
  hasLiveCall?: () => boolean;
}
```

**Replace with:**

```ts
  hasLiveCall?: () => boolean;
  /**
   * OR-2 — "is there an unacked outbound message right now?".
   *
   * Same rationale as `hasLiveCall`, for the send path: a message handed
   * to a half-dead fd has only frozen timers left to rescue it, so the
   * one reconnect attempt that can still run (from the `disconnect`
   * event, which IS delivered while locked) must not be call-only.
   * Optional: omitted → unchanged behaviour.
   */
  hasPendingOutbound?: () => boolean;
  /**
   * OR-2 — fires on EVERY inbound signal from the server: application
   * frames AND the engine.io protocol ping socket.io's Manager re-emits.
   * This is the only clock that keeps running while RN has the JS timer
   * queue frozen, so background send-recovery work (outbox drain) must
   * hang off it rather than a `setInterval`. Callers MUST throttle — this
   * fires once per frame. Errors are swallowed.
   */
  onServerSignal?: () => void;
}
```

**Anchor** (the Manager ping binding, verbatim):

```ts
const onManagerPing = (): void => {
  this.lastServerSignalAt = Date.now();
  this.maybeRenewSocketAuth();
};
```

**Replace with:**

```ts
const onManagerPing = (): void => {
  this.lastServerSignalAt = Date.now();
  this.maybeRenewSocketAuth();
  this.fireServerSignal();
};
```

**Anchor** (inside `socket.onAny`, verbatim):

```ts
this.lastServerSignalAt = Date.now();
this.maybeRenewSocketAuth();
// Recovery offset arrives as the LAST arg when recovery is on.
```

**Replace with:**

```ts
this.lastServerSignalAt = Date.now();
this.maybeRenewSocketAuth();
this.fireServerSignal();
// Recovery offset arrives as the LAST arg when recovery is on.
```

**Insert** the two private helpers immediately after `msSinceServerSignal()`:

```ts
  /** OR-2 — notify the runtime that the server was heard from. Never throws. */
  private fireServerSignal(): void {
    if (this.closedByUser) {return;}
    try { this.opts.onServerSignal?.(); } catch { /* subscriber fault — keep the socket healthy */ }
  }

  /**
   * OR-2 — may this drop take the timer-free reopen path? A live call
   * (B-101) or an unacked outbound message are the two states where the
   * ordinary (RN-frozen) backoff timer is not good enough.
   */
  private needsImmediateReopen(): boolean {
    try {
      return !!(this.opts.hasLiveCall?.() || this.opts.hasPendingOutbound?.());
    } catch { return false; }
  }
```

**Anchor** (in the `disconnect` handler, verbatim):

```ts
if (this.opts.hasLiveCall?.()) {
  this.scheduleServerReconnect();
}
```

**Replace with:**

```ts
if (this.needsImmediateReopen()) {
  this.scheduleServerReconnect();
}
```

**Anchor** (in `scheduleServerReconnect`, verbatim):

```ts
    if (this.serverReconnectAttempts === 0
        && this.opts.hasLiveCall?.()
        && nowMs - this.lastImmediateReopenAt > IMMEDIATE_REOPEN_FLOOR_MS) {
```

**Replace with:**

```ts
    if (this.serverReconnectAttempts === 0
        && this.needsImmediateReopen()
        && nowMs - this.lastImmediateReopenAt > IMMEDIATE_REOPEN_FLOOR_MS) {
```

Back-compat: both new opts are optional. `apps/ops-console/src/lib/messenger/runtime.ts` (the only
other `new TransportClient` site) passes neither and is byte-identical in behaviour.

### 3. `src/modules/messenger/runtime/productionRuntime.ts` — leg C (stuck guard)

**Anchor** (verbatim):

```ts
let drainOutboxInflight = false;
async function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  if (drainOutboxInflight) {return;}
  drainOutboxInflight = true;
  try {
    const rows = await outbox.dueRows();
```

**Replace with:**

```ts
let drainOutboxSeq = 0;
let drainOutboxOwner = 0;
let drainOutboxHeartbeatAt = 0;
async function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  // OR-2 — wall-clock ownership, never a bare boolean. A relay POST whose
  // fetchWithTimeout abort timer is frozen by a locked screen never settles,
  // and a latched flag would swallow every drain for the whole lock — the
  // same trap maybeRenewSocketAuth's REAUTH_STUCK_MS guards against.
  const startedAt = Date.now();
  if (!canStartDrain(drainOutboxOwner, drainOutboxHeartbeatAt, startedAt)) {return;}
  const me = ++drainOutboxSeq;
  drainOutboxOwner = me;
  drainOutboxHeartbeatAt = startedAt;
  try {
    const rows = await outbox.dueRows();
```

**Anchor** (verbatim, the loop head):

```ts
    for (const row of rows) {
      if (!isOurEpoch()) {return;}
      let payload: {outerSealed?: string; expiresAtSec?: number; certExpSec?: number} & Partial<DeferredOutboxPayload>;
```

**Replace with:**

```ts
    for (const row of rows) {
      if (!isOurEpoch()) {return;}
      // OR-2 — a superseded (stuck) drain stops here rather than racing the
      // drain that took its slot; and each row refreshes the liveness stamp
      // so a long queue of slow-but-alive rows never looks wedged.
      if (drainOutboxOwner !== me) {return;}
      drainOutboxHeartbeatAt = Date.now();
      let payload: {outerSealed?: string; expiresAtSec?: number; certExpSec?: number} & Partial<DeferredOutboxPayload>;
```

**Anchor** (verbatim):

```ts
  } finally {
    drainOutboxInflight = false;
  }
}

async function drainRelay(
```

**Replace with:**

```ts
  } finally {
    if (drainOutboxOwner === me) {drainOutboxOwner = 0;}
  }
}

async function drainRelay(
```

Also update the stale name in the existing comment above `outboxRetryTimer`
(`// self-guarded (drainOutboxInflight)` → `// self-guarded (drain ownership)`).

Import at the existing import block:

```ts
import {canStartDrain, shouldDrainOnServerSignal} from './sendRecoveryClock';
```

### 4. `src/modules/messenger/runtime/productionRuntime.ts` — leg B (ping-clock drain) + leg D wiring

**Anchor** (verbatim, in the `new TransportClient({...})` options):

```ts
    hasLiveCall:    () => { try { return hasLiveCall(); } catch { return false; } },
```

**Replace with:**

```ts
    hasLiveCall:    () => { try { return hasLiveCall(); } catch { return false; } },
    // OR-2 — an unacked outbound message earns the same timer-free reopen a
    // live call gets: its ack watchdog and the 60s outbox tick are both
    // frozen while the screen is locked.
    hasPendingOutbound: () => pendingByClientMsgId.size > 0,
    // OR-2 — the server's engine.io ping is the only clock that survives a
    // locked screen (B-100/B-101 proved it for auth renewal). Ride it for
    // the outbox drain too, throttled to SIGNAL_DRAIN_MIN_INTERVAL_MS since
    // this also fires on every application frame. drainOutbox is
    // self-guarded and dueRows() is empty on an idle tick.
    onServerSignal: () => {
      if (!isOurEpoch() || !sqlOutbox) {return;}
      const now = Date.now();
      if (!shouldDrainOnServerSignal(lastSignalDrainAt, now)) {return;}
      lastSignalDrainAt = now;
      void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
    },
```

**Insert** next to `let sqlOutbox: SqlOutboxStore | null = null;` (same TDZ reason):

```ts
let lastSignalDrainAt = 0;
```

### 5. `src/modules/messenger/runtime/productionRuntime.ts` — leg A (the background flush)

**Anchor** (verbatim, the AppState handler tail):

```ts
    } else if (s === 'background' || s === 'inactive') {
      lastActivity = 'away';
      try { transport.setActivity('away'); } catch { /* socket not open */ }
    }
```

**Replace with:**

```ts
    } else if (s === 'background' || s === 'inactive') {
      lastActivity = 'away';
      try { transport.setActivity('away'); } catch { /* socket not open */ }
      // OR-2 — the last window before RN freezes the JS timer queue. A
      // message handed to the WS moments ago has only its (now suspended)
      // 5-20s ack watchdog and the 60s outbox tick to rescue it, so a
      // half-dead fd swallows it until unlock. Ship the durable outbox over
      // HTTP right now; the relay dedups on (recipient, clientMsgId), so a
      // WS ack that lands anyway costs nothing. 'inactive' is excluded — iOS
      // fires it for every notification banner and control-centre pull.
      if (s === 'background' && sqlOutbox) {
        void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
      }
    }
```

### What is deliberately NOT changed

`fetchWithTimeout` (`packages/messenger-core/src/transport/fetchWithTimeout.ts:32`). The audit lists
it, and it is genuinely unenforced while the activity is paused — but **there is no JS mechanism to
fire an abort without a timer**. `AbortSignal.timeout()` is the same frozen queue; a wall-clock check
still needs something to run it. Replacing it would require a native module (out of scope, and it
would land in the same "2nd JS VM" territory the docs already record as failed, cf. OR-1). The
correct mitigation is leg C: bound the _caller_ so one wedged request can no longer starve every
later drain. State this explicitly in the PR rather than silently skipping it.

### Wire / schema

None. No new events, no envelope-shape change, no AAD change, no relay route, no sealed-sender
semantics touched. Outbox SQLCipher schema unchanged (no version bump). The only server-visible
effect is additional `POST /envelopes` submissions carrying an **already-used** `clientMsgId`, which
the relay dedups on `(recipient, clientMsgId)` — the exact idempotency `fetchWithTimeout`'s own
header comment already relies on ("Server-side `(recipient, clientMsgId)` dedup makes retry-after-
timeout safe"). Old servers and old clients need no change; a client without this fix behaves as it
does today.

## Blast radius

- **`packages/messenger-core/src/transport/client.ts`** — `TransportClientOpts` (+2 optional
  fields), `onManagerPing`, `socket.onAny`, `disconnect` handler, `scheduleServerReconnect`, and two
  new private methods. Consumed by `productionRuntime.ts` and `apps/ops-console/src/lib/messenger/runtime.ts`
  (unaffected — passes neither new opt). Regression surface: every transport test in
  `packages/messenger-core/__tests__/transport*.test.ts` + `socketReauth.test.ts`; the `hasLiveCall`
  assertions there must keep passing unchanged (`needsImmediateReopen` is a superset with both new
  opts undefined).
- **`src/modules/messenger/runtime/productionRuntime.ts`** — `drainOutbox` (guard shape only, ship
  logic untouched), the `new TransportClient` options object, the AppState `background` branch, one
  new module-scope `let` triple + one function-scope `let`. Callers of `drainOutbox` unchanged:
  boot (`:1601`), 60 s tick (`:1613`), reconnect (`:1134`).
- **`disposeLiveRuntime()`** — needs no change: the new state is either transport-owned (torn down
  with the socket) or epoch-guarded (`isOurEpoch()` in `onServerSignal`). Note that
  `drainOutboxOwner`/`drainOutboxSeq` are module-scope like the boolean they replace, so a dispose
  mid-drain leaves the slot owned until the in-flight drain's `finally` or the 45 s stuck window —
  identical to today's behaviour with the boolean.
- **Overlapping findings.** OM-05 (re-seal at drain time with a fresh AAD ts) edits the _body_ of
  `drainOutbox`; this spec edits only its entry/exit guard and loop head — non-conflicting hunks but
  the same function, so land them in one branch or rebase carefully. OR-1 (WorkManager background
  drain) targets the same `drainOutbox`; if OR-1 is ever approved, its second process must respect
  the same ownership guard (and it can't — cross-process — which is another argument for OR-1's
  NOT-COVERED verdict). SRV-01/GF-1 (batch submit) would change what `drainOutbox` calls; unaffected
  by this diff. B-72's WS-flap regression is the thing most at risk of returning — see Risk.
- **Could regress:** (a) doubled `POST /envelopes` volume at every backgrounding, (b) reconnect
  churn from leg D on a rolling redeploy, (c) a drain now running concurrently with the boot drain
  if the first server signal lands during boot (already possible via the reconnect drain; the
  ownership guard covers it).

## Tests

Jest projects: `src/modules/messenger/__tests__/**` and `packages/messenger-core/__tests__/**` both
run under **`messenger-crypto`** (node env) — the `app` project explicitly ignores both paths
(`package.json` `testPathIgnorePatterns`). Run `npm run test:crypto`.

1. **NEW `src/modules/messenger/__tests__/sendRecoveryClock.test.ts`** — pure, no mocks.
   - `shouldDrainOnServerSignal(0, 0)` → `true` (cold start drains).
   - `shouldDrainOnServerSignal(t, t + 19_999)` → `false`; `t + 20_000` → `true`.
   - `canStartDrain(0, 0, now)` → `true` (slot free).
   - `canStartDrain(7, now - 44_999, now)` → `false` (a slow-but-alive drain is not stuck).
   - `canStartDrain(7, now - 45_000, now)` → `true` (a drain wedged past the window is superseded).
   - Assert `DRAIN_STUCK_MS > TRANSPORT_TIMEOUT_MS` by importing `TRANSPORT_TIMEOUT_MS` from
     `@bravo/messenger-core` — this is the invariant that keeps a single slow POST from being
     mistaken for a wedge, and it must fail loudly if either constant is retuned.

2. **NEW `packages/messenger-core/__tests__/transportServerSignal.test.ts`** — clone the fake-socket
   - `sharedManager` harness from `socketReauth.test.ts` verbatim (it already exposes
     `__fireManagerPing`, which is precisely the locked-screen clock).
   * _"fires onServerSignal from the Manager ping alone, with NO socket.io events and NO timer
     advance"_: connect, `socket.__fireManagerPing()`, assert the spy fired once. This is the
     decisive assertion — it is the one clock that survives a locked screen.
   * _"fires onServerSignal on an inbound application frame"_: `socket.__fireAny('presence', {})` →
     spy fired.
   * _"a throwing onServerSignal does not break renewal or the socket"_: subscriber throws; assert
     `auth.refresh` still emitted and `client.state === 'connected'`.
   * _"does not fire after close()"_: `client.close()`, then `__fireManagerPing()` → no additional
     call.
   * _"hasPendingOutbound drives a timer-free reopen with no live call"_: `hasLiveCall: () => false`,
     `hasPendingOutbound: () => true`; `socket.__fire('disconnect', 'transport close')`; with
     `jest.useFakeTimers()` and **zero** `advanceTimersByTime`, assert `mockSockets.length` grew.
     Mirror `transportServerReconnect.test.ts`'s style.
   * _"neither opt set → a `transport close` drop schedules nothing"_ (the unchanged-behaviour
     guard, so the herd protection is provably intact).
   * _"the immediate reopen is still floored"_: two `transport close` drops inside
     `IMMEDIATE_REOPEN_FLOOR_MS` with `hasPendingOutbound: () => true` → only one extra socket.

3. **EXTEND `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** — no change needed for the
   guard, but add one assertion that a freshly `enqueue`d row is returned by `dueRows(Date.now())`
   (the premise leg A depends on: `enqueue` sets `next_retry_at = now`, so a background flush
   actually picks up the message that was just WS-sent). If that assertion already exists, cite it
   instead of duplicating.

4. **Regression suites (must be green, unchanged):**
   `npm run test:crypto` — in particular `socketReauth.test.ts` (the ping listener must still be
   swapped, not stacked: `expect(sharedManager.__listenerCount('ping')).toBe(1)`),
   `transportServerReconnect.test.ts`, `transportSingleFlight.test.ts`, `callResumeGuard.test.ts`,
   `outboxCertFreshness.test.ts`, `archiveReplayDrain.test.ts`, `bootGroupStashDrain.test.ts`.
   Then `npm test`, then `npm run typecheck` (baseline 47, must not increase).

5. **Device probe (state it explicitly if it can't be run):** send a 1:1 message and lock the screen
   within 2 s; with the peer offline-then-online, confirm the bubble reaches one tick without
   unlocking the sender (logcat: `[messenger.outbox] draining 1 row(s)` while the screen is off),
   and that the peer receives exactly one copy. Second probe: airplane-mode ON at send, lock, wait
   90 s, airplane-mode OFF while still locked — the drain must fire off the first reconnect ping,
   not at unlock.

## Risk

- **Doubled relay submissions.** Leg A fires unconditionally on `background`, so every message
  in-flight at that instant gets one extra `POST /envelopes` even when the WS was perfectly healthy.
  This is deliberate — the discriminator we'd want ("is this fd actually dead?") is unknowable at
  that instant, and silent message loss is the worse failure — but a reviewer should confirm the
  relay's `(recipient, clientMsgId)` dedup really is hit (not just "usually") and that the second
  submission cannot mint a second `envelopeId`/`retractToken` that overwrites the first in the
  store. `updateMessageEnvelopeId` being last-write-wins is the specific thing to check: if the
  relay returns a _different_ envelopeId for a deduped submit, delivered/read ticks could bind to an
  id the recipient never acks. **If that is the case, leg A must gate on the dedup response shape
  before overwriting.**
- **Leg D is the weakest leg and the one to cut first.** Extending the timer-free reopen from
  "clients on a call" to "clients with an unacked message" widens the herd on a rolling redeploy —
  exactly the stampede `client.ts`'s jitter comment says B-14 exists to prevent, and adjacent to the
  sustained WS flapping SN-03/B-72 fixed. `IMMEDIATE_REOPEN_FLOOR_MS` (2 s) and the fact that only
  attempt #0 is immediate bound it, and legs A–C already deliver the message over HTTP without the
  WS — so if a reviewer is uncomfortable, **ship A–C and drop D**; the user-visible defect is still
  fixed.
- **The stuck-window number.** `DRAIN_STUCK_MS = 45_000` against a 20 s transport timeout: a genuinely
  slow link that takes 40 s per POST would still be judged alive (good), but a 50 s one would get a
  concurrent second drain re-shipping the same rows and double-bumping `recordAttempt`, which eats
  the retry budget faster (`MAX_ATTEMPTS = 10`). The `drainOutboxOwner !== me` check bounds this to
  one extra in-flight row, but the constant is a judgement call, not a derived value.
- **Signal-driven drains are not free.** `onServerSignal` fires on every application frame; the only
  thing keeping this from being a per-frame SQL SELECT is the runtime-side throttle. If someone
  later moves the throttle into `drainOutbox` or removes it, a busy group chat turns into a query
  storm. The throttle living in a named, tested pure module is the mitigation.
- **What this does NOT fix.** A device that is Doze-frozen hard (no engine.io pings delivered, no
  AppState event because the app was already backgrounded before the send — e.g. a share-sheet or
  notification-reply send) still has no recovery clock. That is OR-1's territory, and OR-1 is
  arch-gated (NOT-COVERED: 2nd JS VM vs. the SQLCipher lock; keychain accessibility must not be
  relaxed). Say so rather than claiming full coverage.
- **Security posture:** unchanged. No check is weakened, no envelope/AAD/cert path is touched, no
  new logging of bodies or key material (the new logs are the pre-existing
  `[messenger.outbox] draining N row(s)` count line). `src/modules/messenger/__tests__/logAudit.test.ts`
  (the static gate lives at that path in the current tree, not under `packages/`) still runs as part
  of `test:crypto`.
