# SRV-05 - Ack throughput (6/s) is an order of magnitude below the connect-time flush, so deep backlogs never drain

## Verdict

**CONFIRMED** (mechanism is real and worse than the audit describes — there is a third amplifier the
audit missed).

Evidence from the CURRENT tree:

1. `apps/messenger-service/src/relay/envelope.controller.ts:156-158` —
   `@Throttle({default: {limit: 60, ttl: 10_000}})` / `@Post(':id/ack')`. Per-user (not per-IP:
   `apps/messenger-service/src/common/guards/user-throttler.guard.ts:25` → `` `user:${caller.claims.sub}` ``),
   per-route bucket. Hard ceiling **60 acks / 10 s = 6/s**, and `@nestjs/throttler` v6 blocks for the
   full `ttl` once tripped.
2. `apps/messenger-service/src/gateway/ws-rate-limiter.ts:121` —
   `'envelope.ack': {refillPerSec: 6,  capacity: 60},` — the WS lane is capped identically.
3. `apps/messenger-service/src/gateway/messenger.gateway.ts:716-717` —
   `const PAGE_SIZE = 1000;` / `const MAX_PAGES = 20; // 20k envelopes ceiling`. Every envelope in
   that flush is `client.emit('envelope.deliver', …)` in a tight synchronous loop (`:735-742`).
4. The client acks **one HTTP POST per envelope**, and does so _concurrently_:
   `src/modules/messenger/transport/client.ts:403` `this.opts.onFrame(frame)` →
   `src/modules/messenger/runtime/productionRuntime.ts:989` `void handleServerFrame(frame, {…})`
   (fire-and-forget) → `productionRuntime.ts:5685`
   `await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, disposition);`.
   The WS `envelope.ack` handler (`messenger.gateway.ts:1141`) is **dead** for mobile — `grep -rn
"envelope.ack" src/ packages/` finds only type declarations, never an emit. Every ack is HTTP.
5. Failure is swallowed, not retried: `productionRuntime.ts:5692`
   `console.warn('[messenger.deliver] ACK FAILED …')` and `:7881`
   `try { await relay.ack(env.envelopeId, env.ackToken, disposition); } catch { /* redelivery ok */ }`.
6. **Missed by the audit** — `productionRuntime.ts:1369-1379` `liveReplayArchive` builds a synthetic
   `envelope.deliver` frame with **no `ackToken`**, and `handleDeliver` still POSTs an ack for it. With
   `relay.requireAckToken` defaulting to `true` (`envelope.service.ts:56`) such an ack can never
   succeed — it is either a silent no-op (`envelope.service.ts:341-348`, envelope not in Redis) or a 403. Every archive-replay envelope therefore burns one of the 60 tokens for nothing, starving the
   real acks during exactly the restore/bootstrap window where the backlog is deepest.

## Mechanism

1. Device reconnects after being offline (or reinstalls). `flushPendingOnConnect` pages the pending
   ZSET at 1000/page up to 20 pages and emits every envelope as an `envelope.deliver` frame with no
   pacing.
2. `socket.onAny` hands each frame to `dispatchFrame`, which calls `void handleServerFrame(...)` —
   nothing awaits it. N frames ⇒ N in-flight promises. The decrypt is serialised by the receive txn
   chain, but each promise reaches its own `relay.ack(...)` POST independently.
3. The relay's ack bucket for that user admits 60 requests, then returns 429 for the remainder of the
   10 s window (and re-blocks on every subsequent burst).
4. Every 429 is caught and discarded. The envelope stays in `pending:{user}:{dev}` and its `env:{id}`
   payload stays in Redis.
5. Next connect, `flushPendingOnConnect` re-emits exactly those envelopes. The client's persistent
   `seenEnvelopes` gate (`productionRuntime.ts:7627`) stops re-decryption, so nothing corrupts — but
   the client re-acks them, hits the same wall, and clears at most ~60 per burst per session.
6. Same story on the HTTP catch-up lane: `drainRelay` pulls up to 500 envelopes per pass
   (`HARD_CAP_ITERATIONS = 10` × page 50, `productionRuntime.ts:7563/7575`) and acks each serially at
   `:7881`. Past 60 acks every ack 429s, so `drainRelay` re-pulls the same rows on the next pass and
   eventually trips its own "hitting the cap means ack is silently failing" breadcrumb at `:7902`.
7. Net effect for a user with, say, 4 000 dwelling envelopes: hours of connected time (best case,
   at the 6/s ceiling), constant re-pull bandwidth, constant Redis load, and — because
   `relay.maxPendingPerDevice` is 10 000 (`configuration.ts:86`) — a plausible path to
   `relay_queue_full` 429s for _senders_ addressing that device.

Why the tokenless archive-replay ack (evidence #6) matters: restore-after-reinstall replays the whole
Supabase `sealed_envelope_archive` through `handleDeliver`. Those acks are provably useless yet
consume the same 6/s budget the real relay drain needs, so the worst case (fresh install, deep
backlog, archive replay) is exactly where the throttle is most contended.

## Fix

Three parts. Part A alone raises the ceiling 4× and is one line per file (deployable immediately,
helps every already-shipped client). Part B removes provably-wasted requests (client one-liner).
Part C is the structural fix — a batch-ack endpoint that preserves the per-envelope P0-N9 possession
proof exactly. Parts A+B are the smallest correct increment; C is the one that makes a 20k backlog
actually drain.

Nothing here changes the envelope shape, the AAD, sealed-sender properties, dwell semantics, or the
ack-token contract. No persisted schema and no SQLCipher migration — the ack queue is in-memory only.

---

### A1. `apps/messenger-service/src/relay/envelope.controller.ts` — raise the single-ack cap

Anchor (verbatim, current):

```ts
  /**
   * Audit P0-5 — ack mirrors send cadence (one ack per delivered
   * envelope). 60/10s is roomy for a normal drain and well below the
   * cost of an abusive loop.
   */
  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Post(':id/ack')
```

Replacement:

```ts
  /**
   * Audit P0-5 — ack mirrors send cadence (one ack per delivered
   * envelope). SRV-05: 60/10s (6/s) was an order of magnitude under the
   * connect-time flush (up to 20k envelopes, messenger.gateway
   * flushPendingOnConnect), so a deep backlog 429'd, never drained, and
   * redelivered every session. An ack is ~6 cheap Redis ops with no push
   * and no archive write, so 240/10s is still far below the abuse
   * threshold that motivated the original cap.
   */
  @Throttle({default: {limit: 240, ttl: 10_000}})
  @Post(':id/ack')
```

### A2. `apps/messenger-service/src/gateway/ws-rate-limiter.ts` — keep the WS lane symmetric

Anchor:

```ts
  'envelope.ack':      {refillPerSec: 6,  capacity: 60},
```

Replacement:

```ts
  'envelope.ack':      {refillPerSec: 24, capacity: 240},
```

(The mobile client never emits `envelope.ack` today, but the handler exists and the doc comment at
`ws-rate-limiter.ts:111` promises symmetry with the HTTP cap — leave the two in step so a future WS
ack path doesn't inherit the bug.)

### B. `src/modules/messenger/runtime/productionRuntime.ts` — never POST a tokenless ack

`relay.requireAckToken` is `true` by default, so an ack with no token can only be a silent no-op or a 403. The only frames without an `ackToken` are the synthetic archive-replay frames built at
`productionRuntime.ts:1371`. Skip the request.

Anchor (in `handleDeliverInner`, the main ack site):

```ts
    const destroyedInfo = takeDestroyedEnvelope(frame.data.envelopeId);
    const disposition = (!handledOk || destroyedInfo) ? 'discarded' as const : 'delivered' as const;
    try {
      await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, disposition);
```

Replacement:

```ts
    const destroyedInfo = takeDestroyedEnvelope(frame.data.envelopeId);
    const disposition = (!handledOk || destroyedInfo) ? 'discarded' as const : 'delivered' as const;
    // Why: SRV-05 — a frame with no ackToken is an archive replay
    // (liveReplayArchive), never a relay delivery. With requireAckToken
    // the POST can only 403 or no-op, but it still burns the per-user
    // ack budget the real drain needs.
    try {
      if (!frame.data.ackToken) { return; }
      await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, disposition);
```

Apply the same `if (!frame.data.ackToken) { … }` guard to the three earlier ack sites in the same
function — `productionRuntime.ts:5405`, `:5448`, `:5540/:5546` — each currently reads

```ts
try {
  await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded');
} catch {
  /* non-fatal */
}
```

and becomes

```ts
if (frame.data.ackToken) {
  try {
    await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded');
  } catch {
    /* non-fatal */
  }
}
```

(Once Part C lands these all route through `enqueueAck`, which carries the same guard internally —
see C3. If C is shipped in the same change, do the guard once inside `enqueueAck` and skip the
per-site edits.)

### C1. `apps/messenger-service/src/relay/dto/ack-batch.dto.ts` — NEW

```ts
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

export class AckItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  envelopeId!: string;

  /**
   * Audit P0-N9 possession proof — REQUIRED on the batch path. There is
   * no legacy-client rollout window here (the endpoint ships with the
   * clients that call it), so batch acks are strictly token-only.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ackToken!: string;

  @IsOptional()
  @IsIn(['delivered', 'discarded'])
  disposition?: 'delivered' | 'discarded';
}

export class AckBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => AckItemDto)
  acks!: AckItemDto[];
}
```

### C2. `apps/messenger-service/src/relay/envelope.service.ts` — `ackBatch`

Insert immediately after the existing `async ack(...)` method (the one whose body ends with the
`[P0-T6] delivered-emit failed` warn). It **reuses `this.ack`** verbatim, so every security check —
recipient ownership, per-envelope `verifyAckToken`, `requireAckToken`, hard-delete, token delete,
submitter notify — is byte-identical to the single-ack path.

```ts
  /**
   * SRV-05 — batch ack. Each item is run through the SAME `ack()` above,
   * so the P0-N9 possession proof is still verified per envelope and no
   * ownership check is relaxed; the only thing batched is the HTTP
   * round-trip. Per-item failures are reported, never fatal: a stale or
   * forbidden entry must not block the rest of a drain.
   *
   * Sealed Sender is untouched — the caller is the RECIPIENT (already
   * identified by JWT on the single-ack route) and every envelope in the
   * batch is already known to the relay as queued for that device, so
   * grouping them reveals nothing the pending ZSET does not.
   */
  async ackBatch(
    caller: SessionAddress,
    items:  Array<{envelopeId: string; ackToken: string; disposition?: 'delivered' | 'discarded'}>,
  ): Promise<{results: Array<{envelopeId: string; status: 'ok' | 'forbidden' | 'error'}>}> {
    const results: Array<{envelopeId: string; status: 'ok' | 'forbidden' | 'error'}> = [];
    for (const item of items) {
      try {
        await this.ack(
          caller,
          item.envelopeId,
          item.ackToken,
          item.disposition === 'discarded' ? 'discarded' : 'delivered',
        );
        results.push({envelopeId: item.envelopeId, status: 'ok'});
      } catch (e) {
        const forbidden = e instanceof ForbiddenException;
        if (!forbidden) {
          this.logger.warn(`[SRV-05] batch ack item failed env=${item.envelopeId.slice(0, 8)}: ${(e as Error).message}`);
        }
        results.push({envelopeId: item.envelopeId, status: forbidden ? 'forbidden' : 'error'});
      }
    }
    return {results};
  }
```

Sequential (not `Promise.all`) on purpose: each `ack` is ~6 Redis round-trips against a local Redis,
so 100 items is single-digit-to-tens of ms, and serialising keeps one request from becoming a
100×-amplified Redis burst.

### C3. `apps/messenger-service/src/relay/envelope.controller.ts` — the route

Insert directly **above** the existing `@Post(':id/ack')` block (order is irrelevant to Nest here —
`ack-batch` is one segment, `:id/ack` is two — but keeping them adjacent keeps the throttle comments
together):

```ts
  /**
   * SRV-05 — batch ack. The connect-time flush can hand a device
   * thousands of envelopes at once (messenger.gateway
   * flushPendingOnConnect: 20 pages × 1000); one HTTP round-trip per
   * envelope could never keep up, so deep backlogs 429'd and redelivered
   * forever. Up to 100 acks per request, each carrying its own P0-N9
   * possession-proof token which is verified individually in
   * `EnvelopeService.ackBatch` — the proof is per envelope, exactly as
   * on the single-ack route. 30 requests/10 s × 100 = 3000 acks/10 s
   * ceiling, still a bounded per-user budget.
   */
  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post('ack-batch')
  @HttpCode(HttpStatus.OK)
  async ackBatch(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: AckBatchDto,
  ): Promise<{results: Array<{envelopeId: string; status: string}>}> {
    return this.envelopes.ackBatch(
      {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
      dto.acks,
    );
  }
```

plus the import next to the existing DTO import:

```ts
import {AckBatchDto} from './dto/ack-batch.dto';
```

### C4. `packages/messenger-core/src/transport/relayClient.ts` — `ackBatch`

Insert after the existing `async ack(...)`:

```ts
  /**
   * SRV-05 — batch ack. One request, up to 100 envelopes, each carrying
   * its own P0-N9 possession-proof token (the relay verifies them
   * individually — batching changes the transport, not the proof).
   *
   * Back-compat: an older relay has no `/envelopes/ack-batch` route and
   * answers 404. Callers must treat `RelayHttpError.status === 404` as
   * "server not upgraded yet" and fall back to per-envelope `ack()`.
   */
  async ackBatch(
    items: Array<{envelopeId: string; ackToken: string; disposition?: 'delivered' | 'discarded'}>,
  ): Promise<{results: Array<{envelopeId: string; status: string}>}> {
    return this.request('POST', '/envelopes/ack-batch', {acks: items});
  }
```

`src/modules/messenger/transport/relayClient.ts` is a stale duplicate (the runtime imports
`RelayHttpClient` from `@bravo/messenger-core` — `productionRuntime.ts:49/59`). Leave it alone; do not
drive-by-sync it.

### C5. `src/modules/messenger/transport/ackQueue.ts` — NEW (client-side coalescer)

```ts
import {RelayHttpClient, RelayHttpError} from '@bravo/messenger-core';

/**
 * SRV-05 — coalesce per-envelope acks into one `/envelopes/ack-batch`
 * request. The connect-time flush can deliver thousands of envelopes in
 * a burst and each one used to cost its own POST, blowing past the
 * relay's per-user ack budget; everything past the cap 429'd, was
 * swallowed, and redelivered on the next connect.
 *
 * Keyed on the RelayHttpClient instance so a logout/user-switch (which
 * builds a fresh client) starts with a clean queue.
 */

export interface AckItem {
  envelopeId: string;
  ackToken: string;
  disposition?: 'delivered' | 'discarded';
}

interface QueueState {
  pending: AckItem[];
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  batchless: boolean;
  retries: number;
}

const MAX_BATCH = 100;
const FLUSH_MS = 200;
const MAX_RETRIES = 3;

const queues = new WeakMap<RelayHttpClient, QueueState>();

function stateFor(relay: RelayHttpClient): QueueState {
  let s = queues.get(relay);
  if (!s) {
    s = {pending: [], timer: null, inflight: null, batchless: false, retries: 0};
    queues.set(relay, s);
  }
  return s;
}

/**
 * Queue one ack. Fire-and-forget by design — every call site already
 * treated a failed ack as "the relay will redeliver", and the receive-side
 * `seenEnvelopes` gate makes a redelivery cheap.
 */
export function enqueueAck(relay: RelayHttpClient, item: AckItem): void {
  if (!item.ackToken) {
    return;
  }
  const s = stateFor(relay);
  s.pending.push(item);
  if (s.pending.length >= MAX_BATCH) {
    void flushAckQueue(relay);
    return;
  }
  if (s.timer === null) {
    s.timer = setTimeout(() => {
      s.timer = null;
      void flushAckQueue(relay);
    }, FLUSH_MS);
  }
}

/** Flush now. Safe to call concurrently — overlapping calls share one run. */
export async function flushAckQueue(relay: RelayHttpClient): Promise<void> {
  const s = stateFor(relay);
  if (s.inflight) {
    return s.inflight;
  }
  if (s.pending.length === 0) {
    return;
  }
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }

  const run = async (): Promise<void> => {
    while (s.pending.length > 0) {
      const batch = s.pending.splice(0, MAX_BATCH);
      try {
        if (s.batchless) {
          await ackOneByOne(relay, batch);
        } else {
          await relay.ackBatch(batch);
        }
        s.retries = 0;
      } catch (e) {
        const status = e instanceof RelayHttpError ? e.status : 0;
        if (status === 404 || status === 405) {
          // Relay not upgraded yet — permanent for this session.
          s.batchless = true;
          s.pending.unshift(...batch);
          continue;
        }
        if (status === 429 && s.retries < MAX_RETRIES) {
          // Re-queue and let the throttle window pass. Anything still
          // unacked after the retries simply redelivers.
          s.retries += 1;
          s.pending.unshift(...batch);
          await new Promise(r => setTimeout(r, 10_000));
          continue;
        }
        // Drop this batch: the relay keeps the envelopes and redelivers.
        s.retries = 0;
      }
    }
  };

  s.inflight = run().finally(() => {
    s.inflight = null;
  });
  return s.inflight;
}

/** Teardown hook — drop anything still queued for a dead runtime. */
export function disposeAckQueue(relay: RelayHttpClient): void {
  const s = queues.get(relay);
  if (!s) {
    return;
  }
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.pending.length = 0;
}

async function ackOneByOne(relay: RelayHttpClient, batch: AckItem[]): Promise<void> {
  for (const item of batch) {
    try {
      await relay.ack(item.envelopeId, item.ackToken, item.disposition);
    } catch {
      /* relay redelivers */
    }
  }
}
```

### C6. `src/modules/messenger/runtime/productionRuntime.ts` — route the ack sites through the queue

Add to the import block:

```ts
import {enqueueAck, flushAckQueue, disposeAckQueue} from '../transport/ackQueue';
```

Then each of the five `relay.ack(...)` call sites becomes a queue push. Example, the WS deliver site
(`:5684-5693`):

```ts
enqueueAck(deps.relay, {
  envelopeId: frame.data.envelopeId,
  ackToken: frame.data.ackToken!,
  disposition,
});
```

and the drain site (`:7881`):

```ts
enqueueAck(relay, {envelopeId: env.envelopeId, ackToken: env.ackToken!, disposition});
```

(The non-null assertions are safe because `enqueueAck` early-returns on a falsy token — that is the
Part-B guard, now in one place. Prefer `ackToken: env.ackToken ?? ''` over `!` if the lint config
forbids non-null assertions.)

Then, at the end of `drainRelay` (just before the "hitting the cap" breadcrumb at `:7902`) and in the
`coalescedDrain` `finally` at `:1271`, add:

```ts
await flushAckQueue(relay);
```

and in the runtime teardown/disposers block (`productionRuntime.ts:332` area, the same place the
transport/NetInfo disposers are released):

```ts
disposeAckQueue(relay);
```

### Back-compat matrix (explicit — the server deploys before clients)

| client                 | server | behaviour                                                                                  |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------ |
| old (per-envelope ack) | new    | works, and now gets 240/10s instead of 60/10s (Part A)                                     |
| new (batch)            | old    | `POST /envelopes/ack-batch` → 404 → `batchless = true` → per-envelope acks for the session |
| new                    | new    | batched, up to 100 acks per request                                                        |

No wire field is added to any envelope, no `SealedAad` field changes, no Redis key shape changes, no
SQLCipher schema version bump (the queue is process memory only).

## Blast radius

**Server**

- `envelope.controller.ts` — one throttle constant, one new route, one new import. No change to
  `send`, `pull`, `retract`, `purge-stale-recipient`.
- `envelope.service.ts` — one new method that _calls_ the existing `ack()`. `ack()` itself is
  untouched, so `requireAckToken`, `verifyAckToken`, the recipient check, `takeSubmitter`,
  `addPendingDelivered` / `addPendingUndeliverable` all keep their current semantics.
- `ws-rate-limiter.ts` — one constant. `ws-rate-limiter.spec.ts:112` only asserts the key exists and
  the numbers are `> 0`, so it stays green.
- New DTO file; picked up by the global `ValidationPipe`
  (`main.ts:86`, `whitelist + forbidNonWhitelisted + transform`). Nested array validation needs both
  `@ValidateNested({each: true})` and `@Type(() => AckItemDto)` — both are in C1.

**Client**

- `packages/messenger-core/src/transport/relayClient.ts` — one added method; `ack()` unchanged, so
  ops-console (which consumes the same client and acks at trivial volume) is unaffected.
- `productionRuntime.ts` — five ack call sites in `handleDeliverInner` and `drainRelay`, plus one
  flush in `coalescedDrain`/`drainRelay` and one disposer. Semantics change from
  "await this one ack" to "queue it"; every one of those sites already ignored the result.

**Overlapping findings**

- **SRV-01 / GF-1** also edits `envelope.controller.ts` throttles and `DEFAULT_WS_LIMITS` — same two
  files, different constants. Land them together or expect a trivial conflict.
- **SRV-03** edits `flushPendingOnConnect` / the connect drain in `messenger.gateway.ts`; SRV-05 does
  _not_ touch the gateway, but both change what a reconnect costs — measure them together.
- **OM-03 / SYNC-3 / SRV-08** edits `POST /envelopes` in the same controller.
- Anything editing `drainRelay` or `handleDeliverInner` (GF-3 stash self-heal, OR-\* outbox work)
  collides at the same call sites.

**What could regress**

- An ack that is _queued but never flushed_ (app killed within the 200 ms window, or RN freezing
  timers while backgrounded) leaves the envelope on the relay. It redelivers, `seenEnvelopes` swallows
  the decrypt, and it re-acks — i.e. the pre-existing behaviour, not a new failure mode. The explicit
  flush at the end of `drainRelay` bounds it.
- Raising the ack cap raises the worst case a stolen token can do on this route: 240 Redis
  delete-sequences per 10 s per user, on that user's own queue only (the recipient check makes it
  self-harm, and a possession token is still required per envelope). This is strictly less dangerous
  than the `POST /envelopes` path, which stays at 30/10 s.
- Batching does **not** change the flush's memory profile — `flushPendingOnConnect` still emits up to
  20k frames into 20k concurrent `handleDeliverInner` promises. That is a separate (real) problem; do
  not claim SRV-05 fixes it.

## Tests

**`apps/messenger-service/src/relay/envelope.service.spec.ts`** (existing; Nest + `ioredis-mock`,
`RELAY_DISABLE_LUA_CAP=true` at the top). Add a `describe('SRV-05 — ackBatch')`:

- submit 3 envelopes to the same recipient, `pull` them (which mints ack tokens), call
  `ackBatch(recipient, [...3 items with the real tokens])` → all three `status: 'ok'`, and a
  subsequent `pull` returns `[]`.
- one item with a **wrong** `ackToken` → that item is `status: 'forbidden'` **and the envelope is
  still pullable** (proves the possession proof is enforced per item, not bypassed by batching); the
  other items in the same batch still come back `ok`.
- one item whose `recipient` is a _different_ device → `status: 'forbidden'`, envelope survives.
- an already-acked / unknown `envelopeId` → `status: 'ok'` (idempotent no-op, same as `ack()`), no
  throw.
- `envelope.delivered` is emitted to the submitter for `disposition: 'delivered'` and
  `envelope.undeliverable` for `'discarded'` — assert via the existing `SpyHub.emits`, one per item.

**`apps/messenger-service/src/relay/envelope.controller.spec.ts`** (existing; plain constructor
injection, no guards). Add:

- `ackBatch` forwards `{userId: caller.claims.sub, deviceId: caller.signalDeviceId}` and `dto.acks`
  verbatim to `envelopes.ackBatch`, and returns its result unchanged.
- (guard against a copy-paste regression) `ackBatch` never calls `push.sendChatWake`.

**`packages/messenger-core/__tests__/transportClients.test.ts`** (existing; `fetchMock` + `reply()`
helpers, jest project `messenger-crypto`). Add to the `RelayHttpClient` describe:

- `ackBatch` POSTs to `http://h/envelopes/ack-batch` with body `{acks: [...]}` and the
  `Authorization` / `X-Signal-Device-Id` headers.
- a 404 reply surfaces as `RelayHttpError` with `status === 404` (the signal the coalescer keys its
  fallback on).

**`src/modules/messenger/__tests__/ackQueue.test.ts`** (NEW; jest project `app`, follow the flat
`__tests__` layout, `jest.useFakeTimers()`):

- 250 `enqueueAck` calls against a stub client ⇒ exactly 3 `ackBatch` calls of 100/100/50, and **zero**
  `ack` calls.
- `enqueueAck` with an empty/undefined `ackToken` is dropped — no request at all (the archive-replay
  regression, Part B).
- stub `ackBatch` rejecting with `new RelayHttpError(404, 'not found')` ⇒ falls back to N single
  `ack()` calls with matching `(envelopeId, ackToken, disposition)` args, and never retries
  `ackBatch` again for that client.
- stub rejecting with `RelayHttpError(429, …)` ⇒ items are re-queued and retried after the 10 s
  timer, and give up (silently) after `MAX_RETRIES`.
- `disposeAckQueue` clears pending items and the pending timer (advance timers afterwards ⇒ no
  request).

**Regression suites to run** (CLAUDE.md change-safety gates):
`cd apps/messenger-service && npm test` (relay + gateway specs) → `npm run test:crypto`
(messenger-core transport/sealed-sender) → `npm test -- --selectProjects=app` → `npm run typecheck`
(must stay ≤ 47) → device smoke: reinstall a device with a >200-envelope backlog, connect, and confirm
`pending:{user}:{dev}` reaches 0 in one session and the "hitting the cap" breadcrumb at
`productionRuntime.ts:7902` never fires.

## Risk

- **"Batch ⇒ weakened possession proof."** The single most important review question. C2 must call
  `this.ack(...)` per item; the moment someone "optimises" it into a pipelined delete that verifies
  tokens in bulk (or worse, verifies only the first), P0-N9 is gone. Assert the wrong-token test
  above.
- **Sealed-sender correlation.** Batching _sends_ would be forbidden (it would hand the relay a group
  membership set). Batching _acks_ does not: every item is addressed to the caller, the caller is
  already JWT-identified on the ack route, and the relay already holds all of those ids together in
  `pending:{user}:{dev}`. A reviewer should confirm that reasoning rather than accept it by analogy to
  the send path.
- **Route shadowing.** `@Post('ack-batch')` vs `@Post(':id/ack')` — different segment counts, so no
  shadow, but if anyone later adds `@Post(':id')` it will swallow `ack-batch`. Worth an explicit
  controller test hitting the real route table if the project has an e2e harness.
- **Throttle blast radius.** Confirm `@nestjs/throttler` v6 keys per handler (it hashes class+handler+
  throttler name), i.e. the new 240/10 s bucket applies to `:id/ack` only and does not loosen
  `POST /envelopes` (30/10 s) or the pull cap (120/10 s).
- **Fire-and-forget acks.** Two call sites currently `await` the ack inside a `try/catch`. Converting
  them to `enqueueAck` removes that await; verify no site depended on the ack having completed before
  the next statement (in the current tree none do — the ack is always the last statement of its
  block).
- **The 429 retry sleeps 10 s inside the flush.** It holds `s.inflight`, which is intentional
  (subsequent `enqueueAck`s just accumulate), but it also means `await flushAckQueue(relay)` at the end
  of `drainRelay` can block for up to 30 s in the pathological case. If that matters, make the drain's
  flush non-awaited (`void flushAckQueue(relay)`).
- **Do not "fix" this by pacing the flush instead.** Pacing `flushPendingOnConnect` to 6/s would make
  a 20k backlog take ~55 minutes of connected time and would delay the _first_ message a user is
  waiting for. The ceiling is the bug; the flush is not.
