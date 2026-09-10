# GF-1 — Per-user 30/10s `POST /envelopes` throttle vs. unpaced per-member HTTP fan-out

## Verdict

**CONFIRMED** (mechanism reproduced end-to-end in the current tree; the audit's _proposed_ fix is
partly forbidden — see §Fix note).

Evidence from the current tree:

1. `apps/messenger-service/src/relay/envelope.controller.ts` — the cap is real and per-handler:
   `@Throttle({default: {limit: 30, ttl: 10_000}})` immediately above `@Post()` / `async send(`.
   Keyed on the authenticated user: `UserThrottlerGuard.getTracker` returns
   `` `user:${caller.claims.sub}` `` (`apps/messenger-service/src/common/guards/user-throttler.guard.ts`).
   `@nestjs/throttler` v6 `generateKey` is
   `` `${context.getClass().name}-${context.getHandler().name}-${name}` `` → the bucket is
   _exclusively_ `EnvelopeController.send` per user; `GET /envelopes` (120/10s) and ack (60/10s)
   do **not** share it, so no other traffic dilutes it and none of it helps.
2. `src/modules/messenger/runtime/productionRuntime.ts`, group fan-out:
   `const results = await Promise.allSettled(participants.map(sendOne));` — N _simultaneous_
   `relay.send()` calls, one per member, with zero pacing. `sendOne` comments confirm the lane:
   `// Group fan-out always uses HTTP.`
3. `packages/messenger-core/src/transport/relayClient.ts` (the client productionRuntime actually
   imports — `RelayHttpClient` comes from `@bravo/messenger-core`, line ~49) has **no** 429 branch
   and **no** `Retry-After` read. Its error path is
   `throw new RelayHttpError(res.status, msg, code);` — status is captured, nothing else.
4. `src/modules/messenger/store/sqlOutboxStore.ts` — `isUnreachableError` regex is
   `/network request failed|network error|failed to fetch|abort|timed? ?out|econnrefused|econnreset|enotfound|enetunreach|ehostunreach/i`.
   A Nest `ThrottlerException` surfaces as `"ThrottlerException: Too Many Requests"` → **no match**
   → `recordAttempt` takes the budget-burning branch (`nextAttempts >= MAX_ATTEMPTS` where
   `MAX_ATTEMPTS = BACKOFF_MS.length + 5` = 10) → row flips `status='failed'`, and
   `dueRows()` selects `WHERE status = 'pending'` only ⇒ **auto-retry stops permanently**.
5. The real recovery cadence is the 60s tick: `const outboxRetryTimer = setInterval(() => { void
drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow); }, 60_000);`.
6. **Server already emits the signal we need** — `@nestjs/throttler@6` sets it unconditionally
   (`res.header(\`Retry-After${getThrottlerSuffix(throttler.name)}\`, timeToBlockExpire)`, and
`getThrottlerSuffix('default') === ''`), so the header is literally `Retry-After`, in seconds.
   No server wire change is required for the client half.

Secondary confirmation of severity: the 429 also skips `push.sendChatWake` (it is called _after_ a
successful `submitEnvelope`), so a throttled tail member gets **no envelope and no notification**
until the next drain tick.

## Mechanism

1. User sends one message to a group of N members. `sendOne` is mapped over `participants` and all
   N promises are started with `Promise.allSettled` — each does per-peer encrypt + `wrapOuter` +
   `sqlOutbox.enqueue` + `relay.send()`.
2. All N `POST /envelopes` land inside one 10s throttler window on the same
   `EnvelopeController-send-default-user:<sub>` key.
3. Members 1..30 get 202. Members 31..N get **429** with `Retry-After: <sec>`.
4. Client side, 429 becomes `RelayHttpError(429, 'ThrottlerException: Too Many Requests')`:
   - `retractToken` / `envelopeId` lost for those peers (ticks stay dark);
   - `push.sendChatWake` never fires for them (no banner on a killed device);
   - the catch calls `sqlOutbox.recordAttempt(..., {unreachable: isUnreachableError(e)})` →
     `unreachable` is **false** → `attempts += 1` and `next_retry_at = now + BACKOFF_MS[...]`.
5. Because the throttle is _per user, per 10s_, a 10-member group absorbs only ~3 messages per 10s
   from one sender. Realistic bursts (a reply chain, a photo + caption, a rekey fan-out sharing the
   same bucket — there are 19 `relay.send(` call sites in `productionRuntime.ts`, including the
   `urgent: false` group-control/rekey/receipt sends) put the whole fan-out over the line.
6. Repeat the burst ~10 times and a given member's row exhausts `MAX_ATTEMPTS` → `status='failed'`.
   `dueRows()` never returns it again. That member **never** receives the message; the sender's
   bubble stays 'sent' because of the L17 no-downgrade guard (at least one other peer succeeded),
   so the loss is _silent on both ends_.
7. Even in the non-terminal case, the tail waits for the 60s `outboxRetryTimer` — which is the
   founder complaint "some members receive noticeably later".
8. `drainOutbox` itself is a second burst source: it is serial, but a backlog of >30 due rows
   (exactly what a big group produces) 429s its own tail on the same pass, compounding step 6.

## Fix

**Note on the audit's proposal.** The audit says "server batch endpoint (`POST /envelopes/batch`)
or fan-out-aware throttle shaping". Both are **FORBIDDEN** by the batch architecture ruling (#11):
a request that binds N per-recipient envelopes together destroys
`MESSENGER_SPEC_COVERAGE.md:66` ("the relay sees N unrelated ciphertexts") and
`MESSENGER_BACKEND.md:162` ("Group membership | **No**"); a throttle told "these N are one
fan-out" carries the same membership signal. What **is** allowed is a _blind_ flat cap raise (the
number is code, not contract) plus the client half. That is what this spec does. Do **not**
implement `/envelopes/batch` under this finding.

Five edits, no schema migration, no wire-format change.

---

### 1. NEW `src/modules/messenger/runtime/relaySendPacer.ts`

Pure module (no imports) so it unit-tests in the `messenger-crypto` project — same pattern as
`outboxCertFreshness.ts` / `undeliverableResend.ts` / `firstMessageRetryBudget.ts`.

```ts
/**
 * GF-1 — client-side pacing for `POST /envelopes`.
 *
 * The relay caps that handler at 30 submits / 10s per authenticated user
 * (`envelope.controller.ts`, keyed on `claims.sub`), and a group fan-out issues
 * one submit PER MEMBER in parallel. Without pacing, any group larger than the
 * cap 429s its own tail; the 429 then burns the outbox retry budget and the
 * tail waits for the 60s drain tick.
 *
 * Sealed Sender note: this is a purely local budget. Nothing about the group,
 * its size, or its membership is communicated to the relay — the submits stay
 * N independent, unrelated requests, exactly as before.
 */

/** Server window for the `POST /envelopes` bucket. Mirrors the @Throttle ttl. */
export const RELAY_SEND_WINDOW_MS = 10_000;
/**
 * Submits we allow ourselves per window. Deliberately below the server cap
 * (120/10s after the raise in edit 5) so clock skew and a concurrent second
 * device on the same account don't push us over.
 */
export const RELAY_SEND_BUDGET_PER_WINDOW = 90;
/** Bounds on a server-supplied `Retry-After` before we trust it. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 60_000;

export interface RelaySendBucket {
  tokens: number;
  windowStartMs: number;
  cooldownUntilMs: number;
}

export function createRelaySendBucket(nowMs: number = Date.now()): RelaySendBucket {
  return {tokens: RELAY_SEND_BUDGET_PER_WINDOW, windowStartMs: nowMs, cooldownUntilMs: 0};
}

/** True for a relay rejection caused by the per-user submit throttle. */
export function isRateLimitError(e: unknown): boolean {
  return (e as {status?: unknown} | null)?.status === 429;
}

/** Parsed `Retry-After` (ms) carried on a `RelayHttpError`, when present. */
export function retryAfterMsOf(e: unknown): number | undefined {
  const v = (e as {retryAfterMs?: unknown} | null)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function clampRetryAfterMs(ms: number | undefined): number {
  if (ms === undefined) {
    return RELAY_SEND_WINDOW_MS;
  }
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/**
 * Reserve one submit slot. Mutates the bucket; returns how long the caller must
 * wait before issuing the request. Fixed-window, matching the server's storage
 * model (`@nestjs/throttler` increments a per-key counter with a ttl).
 */
export function reserveSendSlot(b: RelaySendBucket, nowMs: number = Date.now()): number {
  if (nowMs - b.windowStartMs >= RELAY_SEND_WINDOW_MS) {
    b.windowStartMs = nowMs;
    b.tokens = RELAY_SEND_BUDGET_PER_WINDOW;
  }
  let readyAt = nowMs;
  if (b.tokens <= 0) {
    b.windowStartMs += RELAY_SEND_WINDOW_MS;
    b.tokens = RELAY_SEND_BUDGET_PER_WINDOW;
    readyAt = b.windowStartMs;
  }
  b.tokens -= 1;
  return Math.max(0, Math.max(readyAt, b.cooldownUntilMs) - nowMs);
}

/** A 429 landed anyway — drop the rest of this window and honour Retry-After. */
export function noteThrottled(
  b: RelaySendBucket,
  retryAfterMs: number | undefined,
  nowMs: number = Date.now(),
): void {
  b.tokens = 0;
  b.windowStartMs = nowMs;
  b.cooldownUntilMs = Math.max(b.cooldownUntilMs, nowMs + clampRetryAfterMs(retryAfterMs));
}

const bucket = createRelaySendBucket();

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Gate every relay submit through the shared bucket. Wired as
 * `RelayHttpClientOptions.sendGate` so ALL 19 `relay.send(...)` call sites in
 * productionRuntime (fan-out, drain, receipts, rekey/admin control sends) share
 * one budget — they all share one server bucket.
 */
export async function withRelaySendSlot<T>(fn: () => Promise<T>): Promise<T> {
  const delayMs = reserveSendSlot(bucket);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  try {
    return await fn();
  } catch (e) {
    if (isRateLimitError(e)) {
      noteThrottled(bucket, retryAfterMsOf(e));
    }
    throw e;
  }
}

/** Test / runtime-teardown hook — drops any accumulated cooldown. */
export function resetRelaySendPacer(nowMs: number = Date.now()): void {
  const fresh = createRelaySendBucket(nowMs);
  bucket.tokens = fresh.tokens;
  bucket.windowStartMs = fresh.windowStartMs;
  bucket.cooldownUntilMs = fresh.cooldownUntilMs;
}
```

---

### 2. `packages/messenger-core/src/transport/relayClient.ts` — surface `Retry-After`, add `sendGate`

**Anchor (verbatim):**

```ts
export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}
```

**Replacement:**

```ts
export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    /** GF-1 — parsed `Retry-After` (ms) when the relay throttles a submit. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}
```

Additive optional parameter — the only other construction site,
`throw new RelayHttpError(401, 'no_token');`, is unaffected.

**Anchor (verbatim, inside `RelayHttpClientOptions`):**

```ts
  refreshToken?: () => Promise<void>;
}
```

**Replacement:**

```ts
  refreshToken?: () => Promise<void>;
  /**
   * GF-1 — optional gate awaited around each `POST /envelopes`. Lets the host
   * runtime pace submits under the relay's per-user throttle without every
   * call site knowing about it. Absent → unchanged behaviour (ops-console).
   */
  sendGate?: <T>(fn: () => Promise<T>) => Promise<T>;
}
```

**Anchor (verbatim, end of `send`):**

```ts
  }): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> {
    return this.request('POST', '/envelopes', input);
  }
```

**Replacement:**

```ts
  }): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> {
    const submit = (): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> =>
      this.request('POST', '/envelopes', input);
    return this.opts.sendGate ? this.opts.sendGate(submit) : submit();
  }
```

**Anchor (verbatim, error path in `request`):**

```ts
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code);
```

**Replacement:**

```ts
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code, parseRetryAfterMs(res));
```

**Insertion (module scope, next to `safeJson`):**

```ts
/**
 * GF-1 — `@nestjs/throttler` sets `Retry-After` (seconds) on every 429 it
 * raises. HTTP-date form is accepted too, per RFC 9110.
 */
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.('Retry-After');
  if (!raw) {
    return undefined;
  }
  const secs = Number.parseInt(raw, 10);
  if (Number.isFinite(secs) && secs >= 0) {
    return secs * 1_000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
```

> `src/modules/messenger/transport/relayClient.ts` is a **stale duplicate** — nothing on the send
> path imports it (`productionRuntime.ts` imports `RelayHttpClient` from `@bravo/messenger-core`;
> only `runtime/certCache.ts` pulls a _type_ out of `../transport`). Leave it untouched: editing it
> is a drive-by with no behavioural effect.

---

### 3. `src/modules/messenger/store/sqlOutboxStore.ts` — a 429 must not burn the budget

**Anchor (verbatim):**

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean},
  ): Promise<{attempts: number; failed: boolean}> {
```

**Replacement:**

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    /**
     * GF-1 — `deferMs` reschedules WITHOUT consuming the budget, after an
     * explicit delay (the relay's `Retry-After`). Same non-burning posture as
     * SN-04's `unreachable`, but server-timed rather than backoff-timed.
     */
    opts?: {unreachable?: boolean; deferMs?: number},
  ): Promise<{attempts: number; failed: boolean}> {
```

**Anchor (verbatim, the SN-04 branch head):**

```ts
    if (opts?.unreachable) {
      const delay = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
```

**Replacement:**

```ts
    if (opts?.unreachable || opts?.deferMs !== undefined) {
      const delay = opts?.deferMs ?? BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
```

The SQL underneath (`UPDATE outbox SET next_retry_at = ? WHERE ...`) is unchanged, so the existing
fake-DB harness in `sqlOutboxStore.test.ts` already handles it and **no migration / schema version
bump is needed** — `recordAttempt` adds no columns.

---

### 4. `src/modules/messenger/runtime/productionRuntime.ts`

**(4a) import.** Anchor (verbatim):

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
import {isStoredCertStale} from './outboxCertFreshness';
```

Replacement:

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
import {
  withRelaySendSlot,
  isRateLimitError,
  retryAfterMsOf,
  clampRetryAfterMs,
  resetRelaySendPacer,
} from './relaySendPacer';
import {isStoredCertStale} from './outboxCertFreshness';
```

**(4b) wire the gate.** Anchor (verbatim):

```ts
const relay = new RelayHttpClient({
  baseUrl: config.messengerBaseUrl,
  getToken: config.getToken,
  refreshToken: config.refreshToken,
  signalDeviceId,
});
```

Replacement:

```ts
const relay = new RelayHttpClient({
  baseUrl: config.messengerBaseUrl,
  getToken: config.getToken,
  refreshToken: config.refreshToken,
  signalDeviceId,
  // Why: GF-1 — every submit in this runtime shares ONE server bucket
  // (30/10s per user on EnvelopeController.send), so they must share one
  // client budget or a group fan-out 429s its own tail.
  sendGate: withRelaySendSlot,
});
```

**(4c) early re-drain slot.** Insertion at module scope, immediately after the existing
`let liveHeartbeat: ReturnType<typeof setInterval> | null = null;`:

```ts
// GF-1 — a throttled submit carries `Retry-After` (typically <10s), but the
// only retry cadence is the 60s outbox tick. This slot lets a 429 book an
// early, self-guarded drain instead of stranding the tail for a minute.
let liveScheduleOutboxDrain: ((delayMs: number) => void) | null = null;
```

Anchor (verbatim, the drain timer block):

```ts
const outboxLive = sqlOutbox;
const outboxRetryTimer = setInterval(() => {
  void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow);
}, 60_000);
liveDisposers.push(() => {
  try {
    clearInterval(outboxRetryTimer);
  } catch {
    /* ignore */
  }
});
```

Replacement:

```ts
const outboxLive = sqlOutbox;
const outboxRetryTimer = setInterval(() => {
  void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow);
}, 60_000);
liveDisposers.push(() => {
  try {
    clearInterval(outboxRetryTimer);
  } catch {
    /* ignore */
  }
});
let earlyDrainTimer: ReturnType<typeof setTimeout> | null = null;
liveScheduleOutboxDrain = (delayMs: number) => {
  if (earlyDrainTimer) {
    return;
  }
  earlyDrainTimer = setTimeout(
    () => {
      earlyDrainTimer = null;
      if (!isOurEpoch()) {
        return;
      }
      void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow);
    },
    Math.min(Math.max(delayMs, 500), 30_000),
  );
};
liveDisposers.push(() => {
  if (earlyDrainTimer) {
    try {
      clearTimeout(earlyDrainTimer);
    } catch {
      /* ignore */
    }
  }
  earlyDrainTimer = null;
  liveScheduleOutboxDrain = null;
  resetRelaySendPacer();
});
```

**(4d) group fan-out catch.** Anchor (verbatim):

```ts
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {unreachable: isUnreachableError(e)})
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
throw e;
```

Replacement:

```ts
const throttledMs = isRateLimitError(e) ? clampRetryAfterMs(retryAfterMsOf(e)) : undefined;
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {
      unreachable: isUnreachableError(e),
      deferMs: throttledMs,
    })
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
if (throttledMs !== undefined) {
  liveScheduleOutboxDrain?.(throttledMs);
}
throw e;
```

**(4e) `drainOutbox` catch.** Anchor (verbatim):

```ts
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {unreachable: isUnreachableError(e)},
);
```

Replacement:

```ts
const throttledMs = isRateLimitError(e) ? clampRetryAfterMs(retryAfterMsOf(e)) : undefined;
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {unreachable: isUnreachableError(e), deferMs: throttledMs},
);
if (throttledMs !== undefined) {
  liveScheduleOutboxDrain?.(throttledMs);
}
```

(The `if (failed)` block that follows is unchanged; with `deferMs` set, `failed` is always
`false` on a 429, so the L17 no-downgrade path is untouched.)

---

### 5. `apps/messenger-service/src/relay/envelope.controller.ts` — blind flat cap raise

**Anchor (verbatim):**

```ts
  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post()
```

**Replacement:**

```ts
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Post()
```

and extend the existing docblock sentence above it (keep the P0-5 rationale, add one line):

```
   * GF-1 — raised 30 → 120 to match the `GET /envelopes` cap. 30/10s was
   * calibrated for keyboard cadence and did not account for group fan-out,
   * which the relay itself forces onto one HTTP submit PER MEMBER: a 31-member
   * group could never deliver one message inside a window. The limit stays
   * flat and per-user — the relay is told nothing about group identity or
   * size (Sealed Sender / group-blindness invariants unchanged).
```

**Back-compat / deploy ordering (explicit):**

- **No wire-format change.** No new field, header, endpoint, or DTO. `Retry-After` is already
  emitted by the deployed server.
- **Server deployed first (the normal order):** old clients immediately benefit from 120/10s —
  groups up to ~120 members fan out live with no client change at all.
- **New client against an OLD (30/10s) server:** the pacer's 90/window budget still overshoots, so
  429s still occur — but they no longer burn the retry budget, they honour `Retry-After`, the
  pacer cools down for the rest of the window, and an early drain is booked. Self-correcting, and
  strictly better than today.
- **Old client against the NEW server:** unchanged behaviour, higher ceiling.

## Blast radius

**Files edited**

| File                                                      | Change                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/modules/messenger/runtime/relaySendPacer.ts`         | NEW, pure module                                                                     |
| `packages/messenger-core/src/transport/relayClient.ts`    | `RelayHttpError.retryAfterMs`, `parseRetryAfterMs`, `sendGate` option, `send()` gate |
| `src/modules/messenger/store/sqlOutboxStore.ts`           | `recordAttempt` opts `deferMs`                                                       |
| `src/modules/messenger/runtime/productionRuntime.ts`      | import, `sendGate` wiring, `liveScheduleOutboxDrain`, 2 catch blocks                 |
| `apps/messenger-service/src/relay/envelope.controller.ts` | `@Throttle` limit 30 → 120                                                           |

**Functions affected**

- `RelayHttpClient.send` — now goes through the gate for _every_ caller in the mobile runtime
  (all 19 `relay.send(` sites: group fan-out, `drainOutbox`, receipts/reactions with
  `urgent:false`, rekey/admin control fan-outs at ~2037/2100/2179/2273/3039/3530/3634/3780/3875/
  4031/4140/4362/4469, `undeliverableResend` at ~869, ownIdentityRotation's relay use at ~7988).
  `RelayHttpClient.pull` / `ack` / `retract` / `purgeStaleRecipientQueue` are **not** gated —
  correct, they are separate server buckets.
- `ops-console` also imports `RelayHttpClient` from `@bravo/messenger-core` — it passes no
  `sendGate`, so its behaviour is byte-identical. `retryAfterMs` is purely additive there.
- `SqlOutboxStore.recordAttempt` — 3 call sites (group fan-out, 1:1 send path ~2919, `drainOutbox`).
  Only the two burst paths pass `deferMs`; the 1:1 site keeps today's args (a 1:1 send is one
  submit and cannot self-throttle).

**Persistence / wire**

- **No SQLCipher schema change, no migration, no schema-version bump.** No new outbox column;
  `deferMs` is a runtime argument only.
- **No relay wire change.** Nothing new is sent to the server; only an existing response header is
  read.

**Overlapping findings — coordinate before merging**

- **XO-3 (P2)** edits the _same_ `recordAttempt` classification (5xx / `no_token` should also
  reschedule without burning). This spec deliberately introduces `deferMs` as the seam XO-3 should
  reuse: XO-3 adds the 5xx/`no_token` classifier and calls `recordAttempt(..., {deferMs})` — no
  further signature change. **Merge GF-1 first**, then XO-3.
- **SRV-01 (P1)** is the server-side restatement of this finding. Edit 5 _is_ SRV-01's whole
  compliant surface; SRV-01's batch endpoint is forbidden. Do not double-apply.
- **OM-07 (P3)** fixes the `BACKOFF_MS[row.attempts]` frozen-at-1s bug in the _same_ `if
(opts?.unreachable)` branch this spec widens. Same 4 lines — conflict is guaranteed. OM-07 must
  rebase onto the `opts?.unreachable || opts?.deferMs !== undefined` condition and must not
  override an explicit `deferMs`.
- **XO-5 / XO-4 (P3)** touch the bubble-status transitions immediately after these catches
  (`productionRuntime.ts:~2919`, `messengerStore.updateMessageStatus`). Adjacent lines, different
  statements.
- **OR-4 / OR-6** add extra `drainOutbox()` trigger points; they compose with `liveScheduleOutboxDrain`
  (both are idempotent behind `drainOutboxInflight`).

**What could regress**

- Every relay submit now passes through an `async` gate. When the bucket has tokens the added
  latency is one microtask (`reserveSendSlot` returns 0 → no `sleep`). Under load it deliberately
  delays — a >90-member group's tail is now _slower to attempt_ but _faster to arrive_ (no 429, no
  60s tick).
- The pacer is module-global. `_resetMessengerRuntime()` must clear it — hence
  `resetRelaySendPacer()` on the disposer, or a stale cooldown from a previous session throttles
  the first sends of the next one.
- RN freezes timers when the app is backgrounded. A fan-out that backgrounds mid-pace stalls its
  own `sleep`; recovery is the existing durable outbox (rows are enqueued **before** `relay.send`),
  so nothing is lost — it degrades to the pre-fix drain path.

## Tests

Jest project for 1–3 is `messenger-crypto` (`npm run test:crypto`); 4 is the messenger-service
suite (`cd apps/messenger-service && npm test`).

**1. NEW `src/modules/messenger/__tests__/relaySendPacer.test.ts`**

- `reserveSendSlot` returns `0` for the first `RELAY_SEND_BUDGET_PER_WINDOW` calls at a fixed
  `nowMs`, and `RELAY_SEND_WINDOW_MS` for call `N+1` (the fan-out tail is _paced_, not rejected).
- Call `2 * BUDGET + 1` at a fixed `nowMs` → delay is `2 * RELAY_SEND_WINDOW_MS` (windows chain,
  no unbounded pile-up on one window).
- A fresh window: after `nowMs + RELAY_SEND_WINDOW_MS`, the budget is refilled and delay is `0`.
- `noteThrottled(b, 7_000, t)` → the next `reserveSendSlot(b, t)` returns `7_000`.
- `noteThrottled(b, undefined, t)` → falls back to `RELAY_SEND_WINDOW_MS`.
- `clampRetryAfterMs(1)` → `RETRY_AFTER_MIN_MS`; `clampRetryAfterMs(600_000)` → `RETRY_AFTER_MAX_MS`
  (a hostile/buggy header cannot park the client for 10 minutes).
- `isRateLimitError({status: 429})` true; `{status: 500}`, `{status: 403}`, `new Error('nope')`,
  `null`, `undefined` all false.
- `retryAfterMsOf` returns `undefined` for `NaN` / `0` / `-1` / a string.
- `withRelaySendSlot` with `jest.useFakeTimers()`: a rejecting fn with `{status: 429,
retryAfterMs: 5000}` rethrows AND arms the cooldown (assert via a subsequent
  `withRelaySendSlot` not resolving until timers advance 5s). Call `resetRelaySendPacer()` in
  `afterEach`.

**2. NEW `packages/messenger-core/__tests__/relayRetryAfter.test.ts`**
(follow `fetchWithTimeout.test.ts`'s `global.fetch` mocking style)

- A 429 response with `Retry-After: 7` → the thrown error is `RelayHttpError`, `status === 429`,
  `retryAfterMs === 7000`.
- A 429 with an HTTP-date `Retry-After` → `retryAfterMs` is a positive number.
- A 429 with **no** `Retry-After` → `retryAfterMs === undefined` (and nothing throws while
  parsing).
- A 500 → `retryAfterMs === undefined`, existing `status`/`message`/`code` extraction unchanged
  (regression guard on the shared error shape).
- `sendGate` is honoured: construct with `sendGate: jest.fn(fn => fn())`, call `send(...)`, assert
  the gate ran exactly once and the resolved value is untouched.
- `sendGate` is **not** applied to `pull` / `ack` / `retract` (separate server buckets) — assert
  the gate mock was not called for those.
- Omitting `sendGate` leaves `send` behaviour identical (ops-console back-compat).

**3. EDIT `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`**
Add a `describe('GF-1 — throttled attempts defer without consuming the budget')`:

- `recordAttempt('m1','alice',1,{deferMs: 7000})` → `{attempts: 0, failed: false}`, row `status`
  still `'pending'`, `next_retry_at ≈ now + 7000` (the existing fake DB already handles
  `UPDATE outbox SET next_retry_at = ?`).
- Loop `MAX_ATTEMPTS + 2` times with `{deferMs: 7000}` → row is **never** `'failed'` and
  `dueRows(now + 8000)` still returns it (this is the exact permanent-loss path GF-1 describes).
- `{unreachable: true, deferMs: 7000}` → `deferMs` wins over the `BACKOFF_MS` value.
- Regression: `recordAttempt(..., {})` and `recordAttempt(...)` still burn the budget and still
  flip to `'failed'` at `MAX_ATTEMPTS` (the existing tests cover this — assert they are unchanged).

**4. EDIT `apps/messenger-service/src/relay/envelope.controller.spec.ts`**
Add `describe('GF-1 — submit throttle ceiling')`:

```ts
import {Reflect as _r} from 'reflect-metadata'; // only if not already global
// THROTTLER_LIMIT / THROTTLER_TTL come from '@nestjs/throttler'
```

- Read the `@Throttle` metadata off `EnvelopeController.prototype.send` and assert
  `{default: {limit: 120, ttl: 10_000}}` — a guard so nobody silently lowers it back under the
  fan-out size without reading this finding.
- Assert `GET` (`pull`) is still `120/10_000` and `ack` still `60/10_000` (they are separate
  buckets; the raise must not have leaked).

**Regression gates to run**

- `npm run test:crypto` (mandatory — touches `packages/messenger-core/src/transport`).
- `npm test` (full) before declaring done.
- `npm run typecheck` — must stay ≤ the `.tsc-baseline.json` count (47).
- `cd apps/messenger-service && npm test`.
- Device smoke (per CLAUDE.md §UI/feature verification): send a burst of 5 messages into a
  ≥10-member group; every member receives within seconds and no bubble parks in 'sending'. Then
  airplane-mode one member's device and confirm the pre-existing offline path still works.

## Risk

Things a reviewer should push on:

1. **Is the pacer budget (90) actually below the server cap (120)?** If someone lowers the server
   cap later without touching `RELAY_SEND_BUDGET_PER_WINDOW`, the client silently returns to
   429-land. Test 4 is the tripwire; the constants should be cross-referenced in comments both
   ways. Also note the throttler uses **in-memory** storage (`ThrottlerModule.forRoot` has no
   `storage:` option), so with >1 messenger-service replica the _effective_ per-user cap is
   `120 × replicas` and unevenly distributed — the client budget must stay below the _single_
   replica cap, not the aggregate. It does.
2. **Unbounded deferral.** A 429 now never exhausts the budget. If the relay were misconfigured to
   429 permanently, rows would retry forever instead of flipping to 'failed'. This mirrors the
   accepted SN-04 tradeoff for `unreachable`, and `clampRetryAfterMs` caps the retry rate at
   1/minute/row, but it _is_ a change in terminal-state semantics. If a reviewer wants a bound, the
   cheapest correct one is a consecutive-defer counter in the outbox row — that needs a schema
   version bump and should be a separate change, not smuggled in here.
3. **Monkey-patch avoidance.** The `sendGate` option is deliberately opt-in on a _shared_ package.
   Confirm ops-console (`apps/ops-console`) never sets it and its `npm run typecheck` still passes
   — the option is optional so it should, but the shared-package edit is the widest-reach part of
   this diff.
4. **`sealedTs` / AAD age under pacing.** The per-peer AAD timestamp is stamped at encrypt time,
   before the gate. A >90-member group's tail now ships its envelope up to ~10s later per extra
   window. The receiver's `verifySenderCert` tolerance is +120s and certs live ~1h, so this is
   comfortably inside tolerance for any realistic group — but it is a real (small) widening of the
   compose→ship gap and interacts with OM-05's re-seal discussion. It does **not** touch
   `verifySealedAad`, the envelope shape, or the AAD binding, and adds no "skip" branch.
5. **Timer-based pacing in React Native.** `setTimeout` is frozen when the app backgrounds. The
   durable outbox covers it (rows exist before the submit), but a reviewer should confirm the
   fan-out's `Promise.allSettled` can't be observed as "stuck sending" longer than before on a
   backgrounded device — worst case it degrades to the pre-fix drain path.
6. **The audit's own fix is partly forbidden.** Anyone reading `messenger_audit_2026-07-19.md:173`
   or `:405` will see "batch endpoint" as the headline remedy. It is **not** implementable without
   an architecture amendment (it re-relates the N per-recipient ciphertexts the relay is
   contractually blind to). Reject any PR under GF-1/SRV-01 that adds `POST /envelopes/batch`.
7. **Nothing new is logged.** `console.warn` lines are unchanged and carry only ids/counts — no
   plaintext, no key bytes; `logAudit.test.ts` should stay green, but re-run it.
