# SRV-01 - Per-user 30/10s send throttle is below the cost of ONE group fan-out; 429s burn the outbox retry budget

## Verdict

**CONFIRMED** (mechanism exactly as described; the audit's _proposed_ fix is architecturally
forbidden — see §Fix for the compliant replacement).

Evidence from the current tree:

1. `apps/messenger-service/src/relay/envelope.controller.ts:67` — `@Throttle({default: {limit: 30, ttl: 10_000}})` on `@Post()` `send`.
2. `apps/messenger-service/src/common/guards/user-throttler.guard.ts:25` — `if (caller?.claims?.sub) return \`user:${caller.claims.sub}\`;` → the bucket is per _submitting user_, so every recipient of a fan-out draws from the same 30.
3. `src/modules/messenger/runtime/productionRuntime.ts` (group send) — `const MAX_GROUP_FANOUT = 250;` … `const results = await Promise.allSettled(participants.map(sendOne));` and inside `sendOne`: `// Group fan-out always uses HTTP.` followed by `const r = await relay.send({recipient: peer, outerSealed, clientMsgId, expiresAtSec});`. N recipients = N `POST /envelopes` fired simultaneously.
4. The WS lane is not an escape hatch: `apps/messenger-service/src/gateway/ws-rate-limiter.ts:120` — `'envelope.send': {refillPerSec: 3, capacity: 30}` — identical budget.
5. `src/modules/messenger/store/sqlOutboxStore.ts:74` — `isUnreachableError` matches only `/network request failed|network error|failed to fetch|abort|timed? ?out|econn…/i`. A Nest `ThrottlerException: Too Many Requests` body and the relay's own `relay_queue_full` (`envelope.service.ts`: `throw new HttpException('relay_queue_full', HttpStatus.TOO_MANY_REQUESTS)`) match **neither**, so `recordAttempt` takes the budget-consuming branch.
6. `src/modules/messenger/store/sqlOutboxStore.ts:59-60` — `const BACKOFF_MS = [1_000, 4_000, 15_000, 60_000, 5 * 60_000];` / `const MAX_ATTEMPTS = BACKOFF_MS.length + 5;` → 10 throttled attempts flip the row to `'failed'`, and `dueRows()` selects `WHERE status = 'pending'` only. The message is then permanently undelivered to that peer with no automatic recovery.

## Mechanism

1. User posts to a group of N members. `productionRuntime.sendText` (group branch) builds one
   sealed envelope per recipient and fires **N concurrent** `POST /envelopes`
   (`Promise.allSettled(participants.map(sendOne))`). This is forced: the relay is deliberately
   group-blind, so there is no server-side fan-out to amortise the cost.
2. `UserThrottlerGuard` buckets all N requests under `user:<claims.sub>`. The first 30 in the
   10 s window are accepted; requests 31…N return **429**.
3. Each 429 lands in `sendOne`'s catch. The outbox row was already enqueued (P0-N4), so the
   message is not lost _yet_ — but `recordAttempt(..., {unreachable: isUnreachableError(e)})`
   evaluates `isUnreachableError` to **false** for a 429, so `attempts` is incremented and the
   row is rescheduled on the `BACKOFF_MS` ladder.
4. `drainOutbox` re-ships sequentially with **no limit on `dueRows()`** and no throttle
   awareness. A backlog of >30 due rows reproduces step 2 on every drain tick, so the same rows
   keep collecting _rejected_ attempts.
5. After 10 such attempts (`MAX_ATTEMPTS`) `recordAttempt` sets `status='failed'`. `dueRows()`
   never selects `'failed'` again, so only a manual `resetFailed`/tap-to-retry recovers it.
   `drainOutbox`'s L17 guard means the bubble often still shows ✓ (a sibling peer succeeded),
   so **the loss is invisible to the sender** — the audit's "P1 group messages silently missing
   for a subset of members".
6. Even short of exhaustion the delay is real: with N=50 and the ladder above, the tail
   recipients land at 1 s → 4 s → 15 s → 60 s → 5 min. "Staggered by minutes" is literal.
7. Secondary UI damage on the 1:1 path: `httpFallback`'s catch does
   `updateMessageStatus(conversationId, msgId, 'failed')` unconditionally, so a transient 429
   paints a red bubble for a message the drain will deliver.

## Fix

Two independent halves. Half A raises the server ceiling **blindly** (no correlation signal —
see §Risk for why the audit's batch endpoint is rejected). Half B makes the client treat a 429
as backpressure rather than a delivery rejection — which is correct regardless of where the
ceiling sits.

---

### File 1 — `apps/messenger-service/src/relay/envelope.controller.ts`

**Insertion anchor** (insert the new const immediately _after_ this class, i.e. between
`PurgeStaleRecipientDto` and the `/**\n * HTTP surface for the relay.` block):

```ts
class PurgeStaleRecipientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  supersededIdentity!: string;
}
```

**Insert:**

```ts
/**
 * SRV-01 — burst budget for `POST /envelopes`.
 *
 * The relay is deliberately group-blind: one group post is N independent
 * per-recipient sealed envelopes submitted as N unrelated requests. The old
 * 30/10s bucket therefore sat BELOW the cost of a single legitimate send —
 * the client caps fan-out at MAX_GROUP_FANOUT = 250
 * (`src/modules/messenger/runtime/productionRuntime.ts`), so a large-group
 * post could not clear the bucket for ~84 s and every 429 burned an outbox
 * retry attempt until the row went terminal.
 *
 * The window is WIDENED, not shaped. Nothing here learns which submits belong
 * to the same fan-out, so the relay still sees N unrelated ciphertexts and no
 * membership set. Sustained rate 3/s → 5/s; burst ceiling 30 → 300 so one
 * maximum-size fan-out fits in a single window. Body size (700 KB) and the
 * per-recipient pending ceiling (P0-7, 10 000) remain the hard DoS walls.
 */
const SEND_THROTTLE = {
  limit: Number.parseInt(process.env['RELAY_SEND_THROTTLE_LIMIT'] ?? '', 10) || 300,
  ttl: Number.parseInt(process.env['RELAY_SEND_THROTTLE_TTL_MS'] ?? '', 10) || 60_000,
};
```

**Edit anchor** (the P0-5 doc block + decorator, verbatim from the current tree):

```ts
   * Audit P0-5 — `POST /envelopes` is the highest-volume relay surface
   * and the prime DoS target (one POST = 1 sealed-archive write + 1
   * FCM push + N Redis writes). Tightened cap of 30 sends per 10 s per
   * authenticated user — well above any legitimate keyboard-driven
   * cadence and well below the rate at which a stolen token could
   * torch FCM quota.
   */
  @Throttle({default: {limit: 30, ttl: 10_000}})
```

**Replace with:**

```ts
   * Audit P0-5 — `POST /envelopes` is the highest-volume relay surface
   * and the prime DoS target (one POST = 1 sealed-archive write + 1
   * FCM push + N Redis writes). Capped per authenticated user; see
   * SEND_THROTTLE above for the SRV-01 fan-out sizing and the operator
   * overrides (`RELAY_SEND_THROTTLE_LIMIT` / `RELAY_SEND_THROTTLE_TTL_MS`).
   */
  @Throttle({default: SEND_THROTTLE})
```

**Back-compat:** none needed. No wire field, no DTO change, no route change. A raised ceiling
is transparent to every existing client (old clients simply stop receiving 429s), which is the
required ordering since the server deploys first.

---

### File 2 — `packages/messenger-core/src/transport/relayClient.ts`

Carry the relay's own `Retry-After` on the thrown error so the client can reschedule at the
window boundary instead of hot-looping.

**Anchor A:**

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

**Replace with:**

```ts
export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    // Why: SRV-01 — a 429 carries the relay's own window remainder; the outbox
    // reschedules on it instead of guessing a backoff against a full bucket.
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}
```

**Anchor B** (inside `private async request<T>`):

```ts
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code);
```

**Replace with:**

```ts
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code, parseRetryAfterMs(res));
```

**Anchor C** (end of file):

```ts
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
```

**Insert after it:**

```ts
/**
 * `Retry-After` as milliseconds, or undefined when the header is absent or
 * not the delta-seconds form. Typed structurally so the response fakes in
 * `__tests__/transportClients.test.ts` (which carry no `headers`) stay valid.
 */
function parseRetryAfterMs(res: {
  headers?: {get?(name: string): string | null};
}): number | undefined {
  const raw = res.headers?.get?.('Retry-After');
  if (!raw) {
    return undefined;
  }
  const secs = Number.parseInt(raw, 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}
```

**Back-compat:** the 4th constructor arg is optional and positional-last; the field is optional.
`src/modules/messenger/crypto/ownIdentityRotation.ts` and
`src/modules/messenger/__tests__/ownIdentityRotation.test.ts` construct/inspect
`RelayHttpError` and are unaffected. **Do not touch**
`src/modules/messenger/transport/relayClient.ts` — it is a dead duplicate (no importer:
`grep -rn "transport/relayClient" src/ | grep -v packages/` returns nothing); the live client is
the `@bravo/messenger-core` one.

---

### File 3 — `src/modules/messenger/store/sqlOutboxStore.ts`

**Anchor A:**

```ts
export function isUnreachableError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /network request failed|network error|failed to fetch|abort|timed? ?out|econnrefused|econnreset|enotfound|enetunreach|ehostunreach/i.test(
    msg,
  );
}
```

**Insert immediately after:**

```ts
/**
 * SRV-01 — server backpressure, not a delivery rejection.
 *
 * The relay is group-blind, so one group post is N independent
 * `POST /envelopes` calls; a burst can trip the per-user throttler (429) or
 * the per-recipient queue ceiling (`relay_queue_full`, also 429). Neither
 * says anything about THIS envelope's validity, so — exactly like SN-04's
 * offline case — the attempt budget must not be spent on it. Without this a
 * large fan-out burned all MAX_ATTEMPTS within minutes and the row flipped to
 * 'failed', which `dueRows` never re-selects.
 */
export function isBackpressureError(e: unknown): boolean {
  if ((e as {status?: unknown} | null | undefined)?.status === 429) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /too many requests|throttler|rate.?limit|relay_queue_full/i.test(msg);
}

/** `retryAfterMs` off a RelayHttpError, when the relay supplied one. */
export function retryAfterMsOf(e: unknown): number | undefined {
  const v = (e as {retryAfterMs?: unknown} | null | undefined)?.retryAfterMs;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Floor for a backpressure reschedule — matches the relay's throttle window. */
const BACKPRESSURE_MIN_DELAY_MS = 10_000;
```

**Anchor B** (`recordAttempt` signature):

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean},
  ): Promise<{attempts: number; failed: boolean}> {
```

**Replace with:**

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean; backpressure?: boolean; retryAfterMs?: number},
  ): Promise<{attempts: number; failed: boolean}> {
```

**Anchor C** (the SN-04 branch head — the two lines only, leave the surrounding comment block intact):

```ts
    if (opts?.unreachable) {
      const delay = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
```

**Replace with:**

```ts
    // SRV-01 — a 429 is the relay asking us to slow down, not rejecting the
    // envelope; it gets SN-04's budget-free reschedule. The delay honours the
    // server's own Retry-After when present, floored at the throttle window so
    // we don't hot-loop against a still-full bucket.
    if (opts?.unreachable || opts?.backpressure) {
      const delay = opts?.backpressure
        ? Math.max(opts.retryAfterMs ?? 0, BACKPRESSURE_MIN_DELAY_MS)
        : BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
```

**No schema/migration.** Both branches write only the pre-existing `next_retry_at` / `attempts`
columns; no new column, so the SQLCipher schema version (currently v14, `mirror_flushed` ledger
era) is untouched. State this explicitly in the PR — reviewers will look for a bump.

---

### File 4 — `src/modules/messenger/runtime/productionRuntime.ts` (4 edits)

**Anchor 1** (import, ~line 87):

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
```

**Replace with:**

```ts
import {
  SqlOutboxStore,
  isUnreachableError,
  isBackpressureError,
  retryAfterMsOf,
} from '../store/sqlOutboxStore';
```

**Anchor 2** (group `sendOne` catch):

```ts
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {unreachable: isUnreachableError(e)})
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
```

**Replace with:**

```ts
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {
      unreachable: isUnreachableError(e),
      backpressure: isBackpressureError(e),
      retryAfterMs: retryAfterMsOf(e),
    })
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
```

**Anchor 3** (1:1 `httpFallback` catch — status + recordAttempt together):

```ts
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          // Pop on terminal failure too so the LRU doesn't accumulate
          // dead entries (Fix #8).
          clearPending(clientMsgId);
          // Don't delete the outbox row — the next connect-drain will
          // retry with exponential backoff (recordAttempt). SN-04: an
          // unreachable network reschedules without burning an attempt.
          if (sqlOutbox) {
            sqlOutbox.recordAttempt(clientMsgId, target.userId, target.deviceId,
              {unreachable: isUnreachableError(e)}).catch(err =>
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
          }
          throw e;
        }
```

**Replace with:**

```ts
        } catch (e) {
          // SRV-01 — a 429 is backpressure with a queued retry behind it, not a
          // terminal failure; keep the bubble 'sending' so the drain finishes it
          // instead of flashing red and self-healing.
          useMessengerStore.getState().updateMessageStatus(
            conversationId, msgId, isBackpressureError(e) ? 'sending' : 'failed',
          );
          // Pop on terminal failure too so the LRU doesn't accumulate
          // dead entries (Fix #8).
          clearPending(clientMsgId);
          // Don't delete the outbox row — the next connect-drain will
          // retry with exponential backoff (recordAttempt). SN-04: an
          // unreachable network reschedules without burning an attempt.
          if (sqlOutbox) {
            sqlOutbox.recordAttempt(clientMsgId, target.userId, target.deviceId, {
              unreachable:  isUnreachableError(e),
              backpressure: isBackpressureError(e),
              retryAfterMs: retryAfterMsOf(e),
            }).catch(err =>
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
          }
          throw e;
        }
```

`throw e` is deliberately unchanged: the watchdog call site already swallows it
(`void httpFallback().catch(...)`), and the WS-throw call site (`await httpFallback()`) keeps
today's propagation.

**Anchor 4** (`drainOutbox` catch):

```ts
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {unreachable: isUnreachableError(e)},
);
```

**Replace with:**

```ts
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {
    unreachable: isUnreachableError(e),
    backpressure: isBackpressureError(e),
    retryAfterMs: retryAfterMsOf(e),
  },
);
```

---

### Deliberately NOT done (and why)

- **`POST /envelopes/batch` — rejected.** `docs/architecture/MESSENGER_SPEC_COVERAGE.md`: "each
  group message becomes N pairwise sealed Signal envelopes, one per recipient. **The relay sees
  N unrelated ciphertexts**" and "Server has **zero group awareness** — no `/groups` endpoint,
  no group tables, nothing"; `MESSENGER_BACKEND.md`: "Group membership | **No**". A single
  request binding N envelopes hands the relay the membership set — the exact property Sealed
  Sender + group-blindness exist to deny. Same objection applies to "fan-out-aware throttle
  shaping": any signal that says "these N are one fan-out" _is_ the membership signal.
  If a batch endpoint is still wanted it needs a written amendment with a correlation analysis,
  per the `ARCHITECTURE_AMENDMENT_SFRAME.md` sign-off process. The blind ceiling raise above is
  the compliant equivalent (no doc pins the rate-limit value; `MESSENGER_BACKEND.md` pins rate
  limits only for `/auth/register` and `/auth/login`).
- **Client-side pacing of the fan-out — deferred.** With the ceiling at 300/60 s the whole
  `MAX_GROUP_FANOUT = 250` fits in one window, so pacing would add latency for no gain, and
  Half B already covers the residual (several large groups inside one minute). Follow-up if
  telemetry shows sustained 429s: a token-bucket in front of `relay.send` sized from the
  `Retry-After` the server already returns.

## Blast radius

**Files/functions**

| File                                                      | Function                                                                  | Change                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| `apps/messenger-service/src/relay/envelope.controller.ts` | `EnvelopeController.send` decorator                                       | throttle values only    |
| `packages/messenger-core/src/transport/relayClient.ts`    | `RelayHttpError` ctor, `RelayHttpClient.request`, new `parseRetryAfterMs` | additive optional field |
| `src/modules/messenger/store/sqlOutboxStore.ts`           | `recordAttempt`, new `isBackpressureError` / `retryAfterMsOf`             | additive optional opts  |
| `src/modules/messenger/runtime/productionRuntime.ts`      | import, group `sendOne`, `httpFallback`, `drainOutbox`                    | 4 call-site edits       |

**Callers to re-check**

- `recordAttempt` has exactly 3 call sites, all in `productionRuntime.ts` (lines ~2659, ~2927,
  ~7504) — all covered above. The opts bag is optional, so any future caller is unaffected.
- `RelayHttpError` consumers: `src/modules/messenger/crypto/ownIdentityRotation.ts` (switches on
  `.status` 404/other) and `ownIdentityRotation.test.ts`. Both unaffected by a new optional
  field.
- `@bravo/messenger-core` is also consumed by `apps/ops-console`. `RelayHttpError` is re-exported
  through `packages/messenger-core/src/index.ts:175`; the change is source-compatible.
- `GlobalHttpThrottlerGuard` explicitly **skips** routes whose controller binds a
  `ThrottlerGuard` subclass, and `EnvelopeController` binds `UserThrottlerGuard` — so the new
  per-route values are the _only_ limit on this route. No stacking, no double-count.

**Persisted schema / wire format**

- No SQLCipher migration (see File 3). No relay Redis key change. No DTO/field added to
  `POST /envelopes`. Server-first deploy is safe in both directions.

**Overlapping findings**

- **OM-03 / SYNC-3 / SRV-08** edit the same `EnvelopeController.send` body (submitter identity).
  That proposal is FORBIDDEN as literally stated; if a compliant capability-handle variant
  lands, it will textually conflict with this file's doc block — land SRV-01 first (decorator
  only) to keep the merge trivial.
- **GF-2 / SYNC-2** (durable transport for group key material) edits the same
  `productionRuntime` fan-out / `drainOutbox` / `SqlOutboxStore` surface. Expect conflicts in
  `sendOne` and `drainOutbox`; the two changes are complementary (GF-2 adds rows, SRV-01 stops
  those rows dying on 429) but must be sequenced, not merged blind.
- **SRV-04** (other relay-controller finding) — same file, likely trivial merge.

**What could regress**

- The DoS posture stated in P0-5 loosens: burst 30 → 300 per user per window. Sustained rate
  only rises 3/s → 5/s. Concretely, a stolen token can now fire 300 chat-wake FCM pushes in one
  burst instead of 30. Mitigated by the unchanged 700 KB body cap, the unchanged 10 000
  per-recipient pending ceiling (P0-7), and the ability to dial both numbers down via env at
  runtime without a redeploy of the client.
- Throttler storage is the default in-memory `ThrottlerStorageService` (no Redis storage
  configured in `app.module.ts`), so the effective ceiling is _per replica_ — with K replicas
  behind the LB the real per-user burst is K×300. This is pre-existing (it was K×30) but the
  absolute number is now large enough to be worth stating in the PR.
- `isBackpressureError`'s regex could over-match a genuine terminal error whose message happens
  to contain "rate limit". The `status === 429` check fires first for real relay errors; the
  regex is the fallback for wrapped/serialised errors. Over-matching costs an extra retry, not a
  lost message (rows stay `pending` and keep draining), so it fails soft.

## Tests

**A. `apps/messenger-service/src/relay/envelope.controller.spec.ts`** (existing, jest project =
the messenger-service `testRegex: .*\.spec\.ts$`; run `cd apps/messenger-service && npm test`).
Add at the top of the file `import 'reflect-metadata';` if not already pulled in, then a new
describe:

```ts
// @nestjs/throttler writes `THROTTLER:LIMIT` + name / `THROTTLER:TTL` + name onto the
// handler function. The constants aren't exported from the package index, so the
// literal keys are inlined here.
describe('EnvelopeController — SRV-01 fan-out burst budget', () => {
  it('admits a full MAX_GROUP_FANOUT (250) fan-out inside one throttle window', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', EnvelopeController.prototype.send);
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', EnvelopeController.prototype.send);
    expect(limit).toBeGreaterThanOrEqual(250);
    expect(ttl).toBeGreaterThanOrEqual(10_000);
  });

  it('keeps the sustained rate bounded (no unlimited bucket)', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', EnvelopeController.prototype.send);
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', EnvelopeController.prototype.send);
    expect(limit / (ttl / 1000)).toBeLessThanOrEqual(10);
  });
});
```

**B. `packages/messenger-core/__tests__/transportClients.test.ts`** (existing, jest project
`messenger-crypto`; run `npm run test:crypto`). Extend the local `reply()` helper with an
optional headers arg and add to the `RelayHttpClient` describe:

```ts
it('carries Retry-After off a 429 as retryAfterMs', async () => {
  fetchMock.mockResolvedValueOnce({
    ...reply(429, {message: 'ThrottlerException: Too Many Requests'}),
    headers: {get: (h: string) => (h === 'Retry-After' ? '7' : null)},
  });
  const c = new RelayHttpClient(base);
  const err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
  expect(err).toBeInstanceOf(RelayHttpError);
  expect(err.status).toBe(429);
  expect(err.retryAfterMs).toBe(7000);
});

it('leaves retryAfterMs undefined when the response carries no headers', async () => {
  fetchMock.mockResolvedValueOnce(reply(429, {message: 'Too Many Requests'}));
  const c = new RelayHttpClient(base);
  const err = await c.send({recipient: {userId: 'b', deviceId: 1}, outerSealed: 'x'}).catch(e => e);
  expect(err.retryAfterMs).toBeUndefined();
});
```

(The second case pins that the existing header-less `reply()` fakes elsewhere in this file keep
working — a regression guard on `parseRetryAfterMs`'s optional chaining.)

**C. `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** (existing, jest project
`messenger-crypto`; the file already ships a hand-rolled fake DbHandle — reuse it). Add:

```ts
describe('SRV-01 — relay backpressure does not consume the retry budget', () => {
  it('classifies a 429 RelayHttpError and a relay_queue_full as backpressure, not unreachable', () => {
    const e429 = Object.assign(new Error('ThrottlerException: Too Many Requests'), {status: 429});
    expect(isBackpressureError(e429)).toBe(true);
    expect(isUnreachableError(e429)).toBe(false);
    expect(isBackpressureError(new Error('relay_queue_full'))).toBe(true);
    expect(isBackpressureError(new Error('No record for U.1'))).toBe(false);
  });

  it('never marks a row failed no matter how many 429s it takes', async () => {
    // enqueue one row, then recordAttempt({backpressure:true}) 20x
    // (2x MAX_ATTEMPTS) and assert attempts stays 0 and status stays 'pending'.
  });

  it('reschedules on the server Retry-After, floored at the throttle window', async () => {
    // recordAttempt({backpressure:true, retryAfterMs: 30_000}) → next_retry_at ≈ now+30_000
    // recordAttempt({backpressure:true, retryAfterMs: 1_000})  → next_retry_at ≈ now+10_000
  });

  it('still burns the budget for a genuine server rejection', async () => {
    // recordAttempt({}) x MAX_ATTEMPTS → {failed: true}, status 'failed' (unchanged behaviour)
  });
});
```

Import `isBackpressureError` alongside the existing
`import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';`.

**D. Regression suites (per CLAUDE.md change-safety gates)**

- `npm run test:crypto` (messenger-crypto — covers B and C plus the whole sealed-sender path).
- `cd apps/messenger-service && npm test` (covers A plus `envelope.service.spec.ts` and
  `global-http-throttler.guard.spec.ts`).
- `npm run typecheck` — must not exceed `.tsc-baseline.json` (47); this change adds no new
  errors (all additions are optional params/fields).
- `cd apps/messenger-service && npm run typecheck`.
- Device smoke (cannot be done in CI): send in a ≥35-member group on one device and confirm
  every member receives it in one pass, with **zero** `[messenger.outbox] retry failed …
Too Many Requests` lines in logcat.

## Risk

Things a reviewer should be suspicious of:

1. **"Did this smuggle in a correlation signal?"** — Confirm the diff adds no header, no body
   field, no batch route, and no code path where the server can tell that two submits belong to
   the same group. It should be a decorator value change and nothing more on the server side.
   This is the one thing that would make the change architecturally non-compliant.
2. **The DoS relaxation is real, not cosmetic.** 300-per-window is a 10× burst increase on the
   highest-cost relay route (sealed-archive write + FCM push + Redis writes each). Verify you
   are comfortable with 300 FCM chat-wakes per user per minute per replica, and that
   `RELAY_SEND_THROTTLE_LIMIT` is actually wired into the staging env so it can be dialled down
   without a redeploy.
3. **Unbounded retries on a persistently-throttled relay.** Backpressure rows never go terminal
   by design (mirroring SN-04). If the relay is 429ing forever, those rows retry every ≥10 s
   until dwell expiry. `drainOutbox` runs on a 60 s tick with a `drainOutboxInflight` guard, so
   the real floor is 60 s — but confirm that guard is intact in the merged code.
4. **`dueRows()` still has no `LIMIT`.** This change makes a large backlog _survivable_ but not
   _paced_: a 500-row drain still fires 500 sequential POSTs. That is now mostly harmless
   (429s are free) but it is the reason a follow-up pacing ticket is worth filing.
5. **`isBackpressureError`'s `status` duck-type.** It reads `.status` off an `unknown`. Confirm
   nothing else in the codebase throws an object with `status: 429` meaning something else
   (grep found none). Note that `RelayHttpError(401, 'no_token')` and the `relay_queue_full`
   mapping in `envelope.service.ts` are the only 4xx shapes the outbox sees.
6. **Optional-chaining on `res.headers`.** `parseRetryAfterMs` must keep `?.get?.()`; the
   existing test fakes in `transportClients.test.ts` have no `headers` key and will throw a
   TypeError on a naive `res.headers.get(...)`. Test B's second case is there to catch exactly
   that.
7. **No schema bump is correct here.** If a reviewer asks for one, the answer is that
   `recordAttempt` writes only pre-existing `attempts` / `next_retry_at` columns. Do not add a
   migration "for safety" — BACKUP_LOOP.md invariants are written against the current schema
   version and a gratuitous bump costs a restore round-trip to re-verify.
