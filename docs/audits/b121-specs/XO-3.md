# XO-3 — Server-side rejections (5xx / 429 throttle / local `no_token`) burn the outbox retry budget and permanently kill auto-retry

## Verdict

**CONFIRMED** (mechanism reproduced exactly; audit's line numbers drift by ~0, its
_proposed_ fix is incomplete — see "Fix" note on OM-07 coupling).

Evidence from the current tree:

1. `src/modules/messenger/store/sqlOutboxStore.ts:71-75` — the ONLY budget exemption is
   message-shaped network classification:
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
   No HTTP status is consulted anywhere in the file.
2. `packages/messenger-core/src/transport/relayClient.ts:225` throws
   `new RelayHttpError(res.status, msg, code)` where `msg` is the server body's `message`.
   A Nest 429 body is `"ThrottlerException: Too Many Requests"` and a 500 body is
   `"Internal server error"` — **neither matches the regex above** → both take the
   budget-burning branch.
3. `packages/messenger-core/src/transport/relayClient.ts:197` —
   `if (!token) {throw new RelayHttpError(401, 'no_token');}`. This throw happens _inside_
   `send()`, i.e. **before** `let res = await send();` returns, so the `res.status === 401`
   refresh-and-retry branch at `:212` never runs. `'no_token'` does not match the regex →
   burns budget. The existing test at
   `src/modules/messenger/__tests__/sqlOutboxStore.test.ts:344` asserts exactly this
   (`isUnreachableError(new Error('no_token'))` → `false`).
4. `src/modules/messenger/store/sqlOutboxStore.ts:59-60` —
   `const BACKOFF_MS = [1_000, 4_000, 15_000, 60_000, 5*60_000]; const MAX_ATTEMPTS = BACKOFF_MS.length + 5;`
   → 10. `:247-256` flips `status='failed'` at that point, and `dueRows` (`:119`) selects
   `WHERE status = 'pending'` only. With the 60s drain tick (`productionRuntime.ts:1612-1614`)
   the budget exhausts in ≈29 minutes of relay unavailability, after which **nothing
   auto-sends ever again** — only `resetFailed` (tap-to-retry, one bubble at a time) revives a row.
5. The 429 is not hypothetical and is partly **self-inflicted**:
   `apps/messenger-service/src/relay/envelope.controller.ts:67` —
   `@Throttle({default: {limit: 30, ttl: 10_000}})` keyed on `claims.sub`
   (`apps/messenger-service/src/common/guards/user-throttler.guard.ts:25`), while group
   fan-out issues one `POST /envelopes` **per member** (`productionRuntime.ts:2639`).
   There is a second, unrelated 429: `apps/messenger-service/src/relay/envelope.service.ts:220`
   `throw new HttpException('relay_queue_full', HttpStatus.TOO_MANY_REQUESTS)` — also
   transient, also currently budget-burning.
6. The server **does** emit a usable `Retry-After`
   (`@nestjs/throttler@6.5.0`, `dist/throttler.guard.js:121`:
   `res.header(\`Retry-After${getThrottlerSuffix(throttler.name)}\`, timeToBlockExpire)`;
our throttler name is `default`so the suffix is empty → header is literally`Retry-After`, value in seconds). The client **discards it** — `RelayHttpError`
(`relayClient.ts:59-64`) carries only `status`, `message`, `code`; response headers are
   never read.

## Mechanism

1. A row is enqueued to `outbox` before the WS send (`sqlOutboxStore.enqueue`).
2. It fails to ack, so the drain path takes over. There are three failure sites, all
   identical in this respect:
   - `productionRuntime.ts:7501-7507` (`drainOutbox` catch),
   - `:2652-2663` (group HTTP fan-out catch),
   - `:2918-2930` (1:1 HTTP-fallback catch).
     Each calls `outbox.recordAttempt(..., {unreachable: isUnreachableError(e)})`.
3. The failure is a _server answer_, not a _missing_ answer:
   - relay redeploy / restart / upstream blip → 500/502/503/504,
   - own fan-out or a burst trips 30-per-10s → 429 `ThrottlerException`,
   - recipient queue at ceiling → 429 `relay_queue_full`,
   - access token not yet hydrated / mid-refresh / post-logout race → local
     `RelayHttpError(401, 'no_token')` thrown before any socket is opened.
4. `isUnreachableError` returns `false` for all four → `recordAttempt` takes the
   budget branch: `attempts += 1`, backoff scheduled.
5. The drain re-fires on the 60s interval, on every reconnect, and at boot. Each pass
   burns another attempt. Backoff caps at 5 min, so the effective cadence is
   60s,60s,60s,60s,5m,5m,5m,5m,5m ≈ **29 min to exhaustion**.
6. At `attempts >= 10` the row is written `status='failed'`. `dueRows` filters on
   `status='pending'` → the row is now invisible to every automatic drain, forever.
   The bubble shows a failed state and the only recovery is per-bubble tap-to-retry
   (`resetFailed`).
7. Group amplification: a >30-member group send from one sender guarantees a 429 tail on
   the very first message; each burst repeats it, so a specific member's row can exhaust
   its budget while the same message is fine for everyone else — "some members never get it".

## Fix

Four files. Principle: **`attempts` is the budget for _semantic_ rejections only**
(400 `invalid_recipient` / `invalid_outer_sealed` / `outer_sealed_too_large`, 404, local
crypto failures). Anything that means "the server is alive and told us to come back later"
(5xx, 408, 425, 429) or "we have no credential right now" (401) reschedules **without**
burning budget, honouring `Retry-After` when present.

> **Coupling note (must be shipped together):** the existing no-budget branch
> (`sqlOutboxStore.ts:235-244`) reads `BACKOFF_MS[Math.min(row.attempts, …)]` but never
> increments anything — with `attempts` frozen at 0 the delay is **always 1 s** (this is
> finding **OM-07**). Routing 429/5xx into that branch as-is would turn a relay outage into
> a 60s-tick hammer with zero escalation, i.e. it would make GF-1/SRV-01 _worse_. XO-3
> therefore adds the `soft_attempts` counter that OM-07 also needs; OM-07's backoff half is
> subsumed here. Do not implement XO-3 without it.

---

### 1. `packages/messenger-core/src/transport/relayClient.ts` — surface `Retry-After`

**Anchor A** (verbatim, current):

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
    // Why: XO-3 — the relay's own throttler answers 429 with Retry-After;
    // the durable outbox reschedules on it instead of guessing.
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}
```

Back-compat: the 4th parameter is optional; the two existing external constructions
(`src/modules/messenger/__tests__/ownIdentityRotation.test.ts:46,54`) are unaffected, and
`src/modules/messenger/crypto/ownIdentityRotation.ts:76` only reads `.status`.

**Anchor B** (verbatim, current — inside `request`):

```ts
const msg =
  typeof parsed === 'object' && parsed && 'message' in parsed
    ? String((parsed as {message: unknown}).message)
    : text || res.statusText;
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code);
```

**Replacement:**

```ts
const msg =
  typeof parsed === 'object' && parsed && 'message' in parsed
    ? String((parsed as {message: unknown}).message)
    : text || res.statusText;
const code =
  typeof parsed === 'object' && parsed && 'code' in parsed
    ? String((parsed as {code: unknown}).code)
    : undefined;
throw new RelayHttpError(res.status, msg, code, parseRetryAfterMs(res));
```

**Insertion** — new module-level helper, immediately above the existing `safeJson`
at the bottom of the file:

```ts
/**
 * XO-3 — RFC 7231 `Retry-After`: either delta-seconds or an HTTP-date.
 * Returns undefined when absent/unparseable/non-positive so callers fall
 * back to their own backoff. `headers` is duck-typed because the transport
 * test harness mocks `fetch` with plain objects.
 */
function parseRetryAfterMs(res: Response): number | undefined {
  const headers = (res as unknown as {headers?: {get?: (name: string) => string | null}}).headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  if (!raw) {
    return undefined;
  }
  const secs = Number(raw);
  if (Number.isFinite(secs)) {
    return secs > 0 ? Math.round(secs * 1000) : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  const delta = at - Date.now();
  return delta > 0 ? delta : undefined;
}
```

Do **not** touch the legacy duplicate `src/modules/messenger/transport/relayClient.ts` — it
is imported by nothing outside its own `transport/index.ts` (verified: no importer in
`src/`, `apps/`); editing it is drive-by churn.

Wire format: unchanged. No request field added, no response field added — we only read a
header the server already sends. Old servers that omit `Retry-After` simply yield
`undefined` and the client falls back to its own escalating backoff.

---

### 2. `src/modules/messenger/store/sqlOutboxStore.ts` — classify by status; separate soft counter

**Anchor A** (verbatim, current — end of the `isUnreachableError` block):

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

**Insertion immediately after it:**

```ts
/**
 * XO-3 — how a send failure should be charged.
 *
 *   'unreachable'       — we never got an answer (SN-04).
 *   'server-transient'  — the relay answered "later": 5xx, 408/425, its own
 *                         429 throttle or `relay_queue_full`, or we had no
 *                         access token to present (401 / local `no_token`).
 *   'rejected'          — a semantic refusal that retrying cannot fix
 *                         (400 invalid_recipient / outer_sealed_too_large,
 *                         404, local crypto failures).
 *
 * Only 'rejected' consumes the 10-attempt budget. Status is duck-typed off
 * `RelayHttpError` so this store keeps no dependency on the transport layer.
 */
export type OutboxFailureKind = 'unreachable' | 'server-transient' | 'rejected';

export interface OutboxFailure {
  kind: OutboxFailureKind;
  /** HTTP status when the relay answered; 0 for local/unreachable failures. */
  status: number;
  /** Server-supplied Retry-After, clamped to the backoff ceiling. */
  retryAfterMs?: number;
}

/** Statuses below 500 that still mean "come back later", not "never". */
const SOFT_STATUSES = new Set([401, 408, 425, 429]);

export function classifyOutboxFailure(e: unknown): OutboxFailure {
  const status =
    typeof (e as {status?: unknown} | null)?.status === 'number'
      ? (e as {status: number}).status
      : 0;
  if (isUnreachableError(e)) {
    return {kind: 'unreachable', status};
  }
  if (status >= 500 || SOFT_STATUSES.has(status)) {
    const raw = (e as {retryAfterMs?: unknown} | null)?.retryAfterMs;
    const retryAfterMs =
      typeof raw === 'number' && raw > 0
        ? Math.min(raw, BACKOFF_MS[BACKOFF_MS.length - 1])
        : undefined;
    return {kind: 'server-transient', status, retryAfterMs};
  }
  return {kind: 'rejected', status};
}
```

(`BACKOFF_MS` is already declared above this point in the file, so the clamp resolves.)

**Anchor B** (verbatim, current — the SN-04 no-budget branch and its signature):

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean},
  ): Promise<{attempts: number; failed: boolean}> {
    const existing = await this.db.execute(
      `SELECT attempts FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
    const row = existing.rows?.[0] as unknown as {attempts: number} | undefined;
```

**Replacement:**

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean; transient?: boolean; retryAfterMs?: number},
  ): Promise<{attempts: number; failed: boolean}> {
    const existing = await this.db.execute(
      `SELECT attempts, soft_attempts FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
    const row = existing.rows?.[0] as unknown as {attempts: number; soft_attempts?: number} | undefined;
```

**Anchor C** (verbatim, current — the whole `if (opts?.unreachable)` block):

```ts
if (opts?.unreachable) {
  const delay = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)];
  await this.db.execute(
    `UPDATE outbox SET next_retry_at = ?
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
    [Date.now() + delay, clientMsgId, peerUserId, peerDeviceId],
  );
  return {attempts: row.attempts, failed: false};
}
```

**Replacement:**

```ts
// XO-3 — a 5xx / 429 / no_token is the relay saying "later", not "no".
// Charging it to the budget turned a ~30-min relay outage (or one group
// fan-out tripping the 30-per-10s POST throttle) into a permanent
// 'failed' row that no automatic drain will ever look at again.
//
// OM-07 — the SN-04 branch used to index BACKOFF_MS by `attempts`, which
// this branch never increments, so the delay was pinned at 1s forever.
// `soft_attempts` is the escalating counter for BOTH no-budget classes;
// a server-supplied Retry-After overrides it (clamped to the 5m ceiling).
if (opts?.unreachable || opts?.transient) {
  const softAttempts = (row.soft_attempts ?? 0) + 1;
  const delay =
    opts.retryAfterMs && opts.retryAfterMs > 0
      ? opts.retryAfterMs
      : BACKOFF_MS[Math.min(softAttempts - 1, BACKOFF_MS.length - 1)];
  await this.db.execute(
    `UPDATE outbox SET soft_attempts = ?, next_retry_at = ?
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
    [softAttempts, Date.now() + delay, clientMsgId, peerUserId, peerDeviceId],
  );
  return {attempts: row.attempts, failed: false};
}
```

**Anchor D** (verbatim, current — `resetFailed`'s UPDATE):

```ts
      `UPDATE outbox
          SET attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
```

**Replacement:**

```ts
      `UPDATE outbox
          SET attempts = 0, soft_attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
```

Also update the header docblock line `4. recordAttempt() — bumps 'attempts' …` is left as
is (still accurate); no other doc edit required.

---

### 3. `src/modules/messenger/crypto/db.ts` — schema v15 (`outbox.soft_attempts`)

**Anchor A:** `const SCHEMA_VERSION = 14;` → `const SCHEMA_VERSION = 15;`

**Anchor B** — add the version note to the schema-history docblock, after the `14 —` entry:

```
 *  15 — adds outbox.soft_attempts (XO-3/OM-07, escalating backoff counter
 *       for retries that must NOT consume the 10-attempt budget: offline
 *       (SN-04) and server-transient 5xx/429/401)
```

**Anchor C** (verbatim, current — the outbox DDL):

```ts
  `CREATE TABLE IF NOT EXISTS outbox (
     client_msg_id   TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     message_id      TEXT NOT NULL,
     peer_user_id    TEXT NOT NULL,
```

…through…

```ts
     status          TEXT NOT NULL DEFAULT 'pending',
     PRIMARY KEY (client_msg_id, peer_user_id, peer_device_id)
   )`,
```

**Replacement:** insert one column line before `status`:

```ts
     soft_attempts   INTEGER NOT NULL DEFAULT 0,
     status          TEXT NOT NULL DEFAULT 'pending',
     PRIMARY KEY (client_msg_id, peer_user_id, peer_device_id)
   )`,
```

**Anchor D** (verbatim, current — the tail of `runMigrations`):

```ts
  if (fromVersion < 14) {
    // B-94 — mirror_flushed is created idempotently by the DDL block
```

**Insertion:** a new branch appended after the closing `}` of the `< 14` block, i.e. as the
last statement in `runMigrations`:

```ts
if (fromVersion < 15) {
  // XO-3 / OM-07 — `attempts` is the semantic-rejection budget; the
  // no-budget retries (offline + server-transient) need their own
  // escalating counter. Existing rows start at 0, which is exactly the
  // behaviour they had before the upgrade.
  try {
    await db.execute('ALTER TABLE outbox ADD COLUMN soft_attempts INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (!/duplicate column|already exists/i.test(msg)) {
      throw e;
    }
  }
}
```

Ordering is safe: the DDL block runs before `runMigrations` (`db.ts:425` loop → `:442`), and
migrations run ascending, so the `< 7` composite-PK table rebuild (which creates
`outbox_v7` without the column) completes before this ALTER adds it. A fresh install gets
the column from the DDL and the ALTER is swallowed by the `duplicate column` guard.
`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 0` is legal in SQLite (constant default).

---

### 4. `src/modules/messenger/runtime/productionRuntime.ts` — use the classifier at all

three failure sites, and stop the sweep when the relay says "later"

**Anchor A** (verbatim, current — import line 87):

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
```

**Replacement:**

```ts
import {SqlOutboxStore, isUnreachableError, classifyOutboxFailure} from '../store/sqlOutboxStore';
```

(`isUnreachableError` stays imported — it is still used by other call sites in the file if
any remain after this change; if the three sites below are its only consumers, drop it from
the import to keep lint clean. Verify with a grep at implementation time.)

**Anchor B** (verbatim, current — group fan-out catch, ~`:2652-2663`):

```ts
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {unreachable: isUnreachableError(e)})
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
```

**Replacement:**

```ts
if (sqlOutbox) {
  const f = classifyOutboxFailure(e);
  sqlOutbox
    .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {
      unreachable: f.kind === 'unreachable',
      transient: f.kind === 'server-transient',
      retryAfterMs: f.retryAfterMs,
    })
    .catch(err =>
      console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)),
    );
}
```

**Anchor C** (verbatim, current — 1:1 HTTP-fallback catch, ~`:2926-2930`):

```ts
if (sqlOutbox) {
  sqlOutbox
    .recordAttempt(clientMsgId, target.userId, target.deviceId, {
      unreachable: isUnreachableError(e),
    })
    .catch(err => console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
}
```

**Replacement:**

```ts
if (sqlOutbox) {
  const f = classifyOutboxFailure(e);
  sqlOutbox
    .recordAttempt(clientMsgId, target.userId, target.deviceId, {
      unreachable: f.kind === 'unreachable',
      transient: f.kind === 'server-transient',
      retryAfterMs: f.retryAfterMs,
    })
    .catch(err => console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
}
```

**Anchor D** (verbatim, current — `drainOutbox` catch, ~`:7501-7508`):

```ts
      } catch (e) {
        // SN-04 — a drain that fails because the device is offline must not
        // consume the retry budget; only server-rejected attempts do.
        const {attempts, failed} = await outbox.recordAttempt(
          row.clientMsgId, row.peerUserId, row.peerDeviceId,
          {unreachable: isUnreachableError(e)},
        );
        console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} terminal=${failed}: ${asErrorMessage(e)}`);
```

**Replacement:**

```ts
      } catch (e) {
        // SN-04 + XO-3 — neither an unreachable device nor a relay that
        // answered "later" (5xx, its own 429 throttle, or a missing access
        // token) may consume the retry budget; that budget is reserved for
        // semantic rejections a retry cannot fix.
        const f = classifyOutboxFailure(e);
        const {attempts, failed} = await outbox.recordAttempt(
          row.clientMsgId, row.peerUserId, row.peerDeviceId,
          {
            unreachable:  f.kind === 'unreachable',
            transient:    f.kind === 'server-transient',
            retryAfterMs: f.retryAfterMs,
          },
        );
        console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} class=${f.kind} status=${f.status} terminal=${failed}: ${asErrorMessage(e)}`);
        if (f.kind === 'server-transient') {
          // XO-3 — every remaining row would hit the same wall (the relay is
          // down, or the 30-per-10s per-user throttle window is closed), and
          // hammering it deepens the throttle. Stop the sweep and re-enter
          // once the window reopens; rows keep their next_retry_at so a
          // premature re-entry is a cheap no-op.
          scheduleTransientRedrain(outbox, relay, isOurEpoch, reseal, f.retryAfterMs);
          return;
        }
```

(the existing `if (failed) { … }` block that follows is unchanged; the early `return`
still runs the `finally` that clears `drainOutboxInflight`.)

**Anchor E** (verbatim, current — module-level, immediately above `drainOutbox`):

```ts
let drainOutboxInflight = false;
async function drainOutbox(
```

**Insertion above it:**

```ts
/**
 * XO-3 — one-shot re-entry after the relay told us to back off. Honours
 * Retry-After when the server sent one, otherwise a 10s default; clamped so
 * a hostile/misconfigured header can neither hot-loop us nor park the queue.
 */
const TRANSIENT_REDRAIN_MIN_MS = 2_000;
const TRANSIENT_REDRAIN_MAX_MS = 60_000;
let transientRedrainTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTransientRedrain(
  outbox: SqlOutboxStore,
  relay: RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal: ResealDeferredFn | undefined,
  retryAfterMs?: number,
): void {
  if (transientRedrainTimer) {
    return;
  }
  const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 10_000;
  const delay =
    Math.min(Math.max(base, TRANSIENT_REDRAIN_MIN_MS), TRANSIENT_REDRAIN_MAX_MS) +
    Math.floor(Math.random() * 1_000);
  transientRedrainTimer = setTimeout(() => {
    transientRedrainTimer = null;
    if (!isOurEpoch()) {
      return;
    }
    void drainOutbox(outbox, relay, isOurEpoch, reseal);
  }, delay);
}
```

No wire-format change on the client→server direction. No server change at all: the throttle
value itself belongs to **SRV-01/GF-1**, not to XO-3.

## Blast radius

**Files edited**

- `packages/messenger-core/src/transport/relayClient.ts` — `RelayHttpError` ctor (optional
  4th arg), `request()` throw site, new private `parseRetryAfterMs`. Consumed by
  `productionRuntime`, `ownIdentityRotation.ts`, `apps/ops-console` (via
  `@bravo/messenger-core`). All existing consumers read only `.status`/`.code`/`.message`.
- `src/modules/messenger/store/sqlOutboxStore.ts` — new exported
  `classifyOutboxFailure`/`OutboxFailure`; `recordAttempt` opts widened (all new fields
  optional, so callers that pass only `{unreachable}` keep today's behaviour);
  two SQL strings changed (`SELECT attempts, soft_attempts`, `UPDATE … SET soft_attempts = ?, next_retry_at = ?`),
  one widened (`resetFailed`).
- `src/modules/messenger/crypto/db.ts` — `SCHEMA_VERSION` 14→15, one DDL column, one
  migration branch. Shared with the whole messenger DB; the bump forces `runMigrations`
  on every existing install's next boot. Nothing else keys off the number
  (only `db.ts:441-446` compares it).
- `src/modules/messenger/runtime/productionRuntime.ts` — three catch blocks + one new
  module-level helper/timer.

**Persisted schema:** yes — one additive, defaulted column. Forward-only, matching the v12
`ALTER TABLE … ADD COLUMN` pattern. Downgrade (older APK on a v15 DB) is benign: the older
`SELECT attempts FROM outbox` and `UPDATE outbox SET next_retry_at = ?` statements ignore
the extra column. `openCompartmentedDb` is dormant (no production caller) and runs no DDL,
so no second migration site.

**Wire format:** unchanged in both directions. `Retry-After` is a header the server already
emits; a server that omits it yields `undefined` and the client uses its own backoff. Old
clients against a new server: unaffected (nothing new is sent). New client against an old
server: unaffected.

**Overlapping findings**

- **OM-07** — same `if (opts?.unreachable)` block and the same `soft_attempts` column.
  Subsumed here; OM-07's remaining half (bounding per-sweep wall time) is independent.
- **GF-6 / SLOW-NETWORK §137** — `drainOutbox` serial-iteration and the global inflight
  guard; the new `return` on transient failures edits the same loop.
- **XO-5** — the `updateMessageStatus(..., 'failed')` at `:2919` sits three lines above
  Anchor C; whoever does XO-5 edits the same catch block.
- **GF-1 / SRV-01** — the 429 this fix stops charging is produced by the throttle those
  findings reshape; they are complementary, not conflicting (different files).
- **XO-1 / OM-01** — the stale-cert reseal branch inside the same `drainOutbox` try block
  (Anchor D is its catch).
- **OR-6** — adds another `drainOutbox()` call site; no textual overlap.

**Regression candidates**

- Rows that today die at `attempts=10` now stay `pending` indefinitely while a relay is
  permanently 5xx-ing or a device is permanently unauthorised. There is no dwell-based
  outbox prune in the store, so those rows persist (this is already true post-SN-04 for the
  offline class). Bounded cost: one 5-min-spaced attempt per row.
- The mid-sweep `return` means a single transient failure defers the rest of the backlog to
  the re-drain. Progress is still monotonic (one row advances per pass), and the 60s tick +
  reconnect drain remain as backstops.
- `SELECT attempts, soft_attempts` will throw `no such column` on any DB that reached the
  new code without the migration — impossible via `openCryptoDb`, but the hand-rolled fake
  DB in the unit test must be updated in lockstep or every `recordAttempt` test fails.

## Tests

Jest project **`messenger-crypto`** covers both touched test files
(`npm run test:crypto`).

### `packages/messenger-core/__tests__/transportClients.test.ts` (existing)

- Extend the local `reply()` helper to accept optional headers:
  ```ts
  function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: {get: (n: string) => lower[n.toLowerCase()] ?? null},
      text: async () => text,
    };
  }
  ```
  (existing callers pass two args and are unaffected).
- New assertions in the `RelayHttpClient` describe:
  - `429` + `Retry-After: 7` → thrown error has `status === 429` and `retryAfterMs === 7000`.
  - `503` with **no** `Retry-After` → `retryAfterMs === undefined`.
  - `Retry-After` as an HTTP-date ~30s in the future → `retryAfterMs` between 25000 and 31000.
  - `Retry-After: garbage` → `retryAfterMs === undefined` (must not throw).
  - Regression: the existing "throws RelayHttpError carrying the server code" and
    "throws 401 with no token" tests still pass unchanged.

### `src/modules/messenger/__tests__/sqlOutboxStore.test.ts` (existing)

- Update `makeFakeDb()`:
  - `INSERT OR IGNORE` push gains `soft_attempts: 0`.
  - branch `trimmed.startsWith('SELECT attempts FROM outbox')` →
    `'SELECT attempts, soft_attempts FROM outbox'`, returning
    `[{attempts: match.attempts, soft_attempts: match.soft_attempts}]`.
  - replace the SN-04 branch `'UPDATE outbox SET next_retry_at = ?'` with
    `'UPDATE outbox SET soft_attempts = ?, next_retry_at = ?'` (params
    `[soft_attempts, next_retry_at, cmid, uid, did]`).
  - `'UPDATE outbox SET attempts = 0'` branch also sets `match.soft_attempts = 0`.
- Keep every existing SN-04 test green (they pass `{unreachable: true}` and assert
  `attempts` stays 0 — unchanged semantics).
- New `describe('XO-3 — server-transient rejections do not consume the budget')`:
  1. `recordAttempt('m1','alice',1,{transient:true})` × 40 → `table[0].status === 'pending'`,
     `attempts === 0`, and `dueRows(now + 10min)` still returns the row.
  2. `{transient:true}` escalates: after 1 call `next_retry_at - now ≈ 1000`; after 5 calls
     `≈ 300000` (proves the OM-07 freeze is gone). Assert with a tolerance window.
  3. `{transient:true, retryAfterMs: 7000}` → `next_retry_at - now` in `[6900, 7100]`
     (Retry-After wins over the computed backoff).
  4. `{transient:true, retryAfterMs: 3_600_000}` → clamped to ≤ `300_000 + tolerance`.
  5. Semantic path unchanged: 10 × `recordAttempt(...)` with no opts → `failed === true`,
     `status === 'failed'`.
  6. `resetFailed` zeroes `soft_attempts` as well as `attempts`.
- New `describe('XO-3 — classifyOutboxFailure')` (table-driven, mirroring the existing
  `isUnreachableError` block):
  - `new RelayHttpError(500,'Internal server error')` → `'server-transient'`
  - `{status: 502}` / `{status: 503}` / `{status: 504}` → `'server-transient'`
  - `{status: 429, message: 'ThrottlerException: Too Many Requests'}` → `'server-transient'`
  - `{status: 429, message: 'relay_queue_full'}` → `'server-transient'`
  - `{status: 401, message: 'no_token'}` → `'server-transient'` ← the audit's named case
  - `{status: 400, message: 'invalid_recipient'}` → `'rejected'`
  - `{status: 400, message: 'outer_sealed_too_large'}` → `'rejected'`
  - `{status: 404}` → `'rejected'`
  - `new Error('outbox_cert_expired_unresealable')` → `'rejected'`
  - `new TypeError('Network request failed')` → `'unreachable'`
  - `Object.assign(new Error('Aborted'), {name:'AbortError'})` → `'unreachable'`
  - `{status: 429, retryAfterMs: 7000}` → `retryAfterMs === 7000`;
    `{status: 429, retryAfterMs: 10 * 60_000}` → clamped to `300_000`.
    Import `RelayHttpError` from `@bravo/messenger-core` (the `messenger-crypto` project maps
    that alias to `packages/messenger-core/src`) for at least one case, to prove the
    duck-typed read matches the real class.

### Migration

- `src/modules/messenger/__tests__/` has no `db.ts` migration harness today
  (`compartmentedDbHardening.test.ts` only fakes PRAGMA rows). Do **not** invent one for a
  single additive column; verify by device probe instead: install the previous APK, queue
  a few messages, upgrade in place, confirm boot has no `no such column: soft_attempts` in
  logcat and that queued rows still drain.

### Gates

- `npm run test:crypto` (direct + regression — both touched suites live there).
- `npm test` (full) before declaring done.
- `npm run typecheck` — must stay ≤ the `.tsc-baseline.json` count (47).
- `cd apps/messenger-service && npm test` — **no server file changes**, run only as a
  no-drift check.
- `packages/messenger-core/__tests__/logAudit.test.ts` must stay green: the new
  `console.warn` in `drainOutbox` adds only `class=`/`status=` — no body, no key material,
  no ArrayBuffer.

### Device probe (the actual complaint)

1. Queue ~10 messages, stop the staging messenger-service container (or `iptables -j REJECT`
   the port so the box answers 502 via nginx) for 40 minutes with the app foregrounded.
2. Restart it. **Expect:** every row drains automatically, no bubble ever reached 'failed',
   `SELECT status, attempts, soft_attempts FROM outbox` shows `attempts=0` throughout.
3. Send one message into a >30-member group; confirm the 429 tail members deliver on the
   re-drain (logcat `class=server-transient status=429`) rather than sticking.

## Risk

- **The `soft_attempts` column is the load-bearing part, not the classifier.** A reviewer
  should check that XO-3 was not merged without it: routing 429/5xx into the _existing_
  no-budget branch (`BACKOFF_MS[row.attempts]`, `attempts` never incremented → 1 s forever)
  converts a permanent-failure bug into a retry storm against a server that is already
  rate-limiting us. Verify the escalation assertion (test 2) actually exists.
- **`{unreachable, transient}` as two booleans** is a wart — `unreachable` now means "no
  answer" and `transient` "answer said later", and both spare the budget. Chosen over
  renaming the flag because `unreachable` is the SN-04 contract referenced by six existing
  tests and two other call sites. If a reviewer prefers one `noBudget` flag, that is a
  mechanical follow-up, not a behaviour change.
- **401 classified as transient** is the most debatable call. A genuinely revoked session
  now leaves rows `pending` forever instead of failing after ~29 min. This is deliberate
  (SN-04 already set that precedent for offline) but it means the _bubble_ state is the
  only user-visible signal — and today `:2919` flips it to 'failed' immediately anyway
  (**XO-5**). If XO-5 lands first, re-check that a permanently-unauthorised device does not
  leave bubbles in 'sending' with no escape hatch.
- **Unbounded soft retries.** No dwell-based prune exists on the `outbox` table, so a row
  that can never be sent lives forever at a 5-min cadence. Pre-existing post-SN-04, widened
  here to a second failure class. Worth a follow-up (prune rows older than the 30-day relay
  dwell), explicitly **out of scope** for XO-3.
- **Mid-sweep `return`.** The early exit is inside the `for` and before the `if (failed)`
  block; confirm the `finally` still clears `drainOutboxInflight` (it does — the `return`
  unwinds through it) and that no row was left with `status` bumped but `next_retry_at`
  untouched.
- **`transientRedrainTimer` is module-level**, like `drainOutboxInflight`. It is not parked
  on `liveDisposers`; correctness relies on the `isOurEpoch()` check inside the callback.
  A reviewer should confirm that guard is present and that a logout→login during the
  ≤61 s window cannot drain against a torn-down store.
- **`Retry-After` is attacker/misconfiguration-influenced** (any intermediary can set it).
  It is clamped to `[2s, 5min]` at two independent places (`classifyOutboxFailure` clamps to
  the backoff ceiling; `scheduleTransientRedrain` clamps the timer). Check both clamps
  survived review — an unclamped header could park the whole queue for hours.
- **No security surface is touched**: no verifier weakened, no envelope shape, AAD, cert,
  dwell, or token semantics changed. The only new data at rest is an integer retry counter.
