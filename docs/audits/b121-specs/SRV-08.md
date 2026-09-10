# SRV-08 - HTTP-submitted envelopes get no delivery receipt; group ticks cap at 'sent'

## Verdict

**CONFIRMED** — the defect reproduces exactly as described, and it is server-side.

1. `apps/messenger-service/src/relay/envelope.controller.ts:78-83` — `send()` calls
   `this.envelopes.submitEnvelope({recipient, outerSealed, clientMsgId, expiresAtSec})`,
   deliberately omitting `submitter` (comment at `:74-77`: _"Sealed Sender: we intentionally
   do NOT pass caller identity into the service"_).
2. `apps/messenger-service/src/relay/envelope.service.ts:234-236` — the receipt hook is gated:
   `if (input.submitter) { await this.store.storeSubmitter(envelopeId, input.submitter, effectiveTtl); }`.
   No submitter ⇒ no `submitter:{envelopeId}` key.
3. `apps/messenger-service/src/relay/envelope.service.ts:376-377` — on ack,
   `const submitter = await this.store.takeSubmitter(envelopeId); if (submitter) {…}` — the
   `envelope.delivered` / `envelope.undeliverable` emit and the durable
   `addPendingDelivered` queue are both inside that `if`. HTTP submits fall through silently.
4. Only the WS lane populates it — `apps/messenger-service/src/gateway/messenger.gateway.ts:1094`:
   `submitter: {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId}`.
5. Client-side this is _load-bearing for groups_: `src/modules/messenger/runtime/productionRuntime.ts:2631-2634`
   — _"Group fan-out always uses HTTP. The WS path here used to increment `delivered` on a pure
   `transport.send()`…"_ — every group envelope goes through `relay.send(...)` at `:2639`.
6. The rest of the group tick pipeline is already wired and works: `:2706-2716` sets
   `firstEnvelopeId` on the bubble (`updateMessageEnvelopeId`), and
   `src/modules/messenger/runtime/envelopeDelivered.ts:35-49` (`applyEnvelopeDelivered`) flips
   `sent → delivered` by `msg.envelope_id`. It is never invoked for group sends because the
   frame never arrives. Same for the reconnect outbox drain (`productionRuntime.ts:7476-7500`)
   and the 1:1 HTTP fallback (`:2890-2905`).

Corroborating internal record: `docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md:296`
— _"group fan-out / HTTP-fallback sends never get `envelope.delivered` at all (their bubbles cap
at 'sent')"_.

## Mechanism

1. User sends a group message. `productionRuntime.sendText` group branch encrypts one sealed
   envelope per participant and, for each, calls `relay.send(...)` — **HTTP**, never WS
   (`productionRuntime.ts:2639`). Same for the 1:1 WS-ack-timeout fallback (`httpFallback`,
   `:2890`) and every `drainOutbox` re-ship (`:7476`).
2. `EnvelopeController.send` verifies the JWT (rate-limit) and then calls `submitEnvelope`
   **without** `submitter`.
3. `submitEnvelope` persists `env:{id}`, `retract:{token}→id`, mints the ack token, archives,
   fans out — but skips `storeSubmitter` because `input.submitter` is undefined.
4. Recipient pulls, decrypts, and acks. `EnvelopeService.ack` hard-deletes, then
   `takeSubmitter(envelopeId)` returns `null` (no such key) ⇒ **no** `envelope.delivered`,
   **no** `envelope.undeliverable`, **no** `addPendingDelivered` durable queue entry.
5. Sender's bubble stays `sent` forever unless the recipient happens to send a plaintext
   read-receipt (`read-receipt` frame → `read`). With read receipts off, or in a group where
   nobody opens the thread, the tick is permanently stuck at one tick.
   Symmetrically, a `disposition:'discarded'` ack (terminal decrypt failure) produces **no**
   `undeliverable` signal, so `src/modules/messenger/runtime/undeliverableResend.ts` never
   fires for group/HTTP sends — a destroyed group message is silently lost behind a ✓.

## Fix

### Architectural gate (read first)

The audit's literal remedy — _"pass the caller's JWT identity as submitter"_ — is **rejected**
by this batch's architecture ruling (§1: passing `{userId, deviceId}` on `POST /envelopes` is
FORBIDDEN; only an _anonymous capability handle_ is allowed). Deciding doc lines:
`docs/architecture/MESSENGER_BACKEND.md:137` (_"JWT verified (rate-limit only — we do NOT
persist submitter identity)"_), `:156` (Sender user id → **No**), and the sanctioned pattern at
`:192` (_"`POST /envelopes/retract` accepts the capability token issued on submit … no sender
identity needed → preserves Sealed Sender"_).

**Drift note the reviewer must see:** the batch ruling assumed the WS lane's submitter binding
is "an in-memory socket binding that dies with the connection". In the current tree it is **not** —
`envelope.store.ts:316-326` writes `submitter:{envelopeId} = "{userId}:{deviceId}"` into Redis
with the full envelope TTL (up to 30 days), and `envelope.store.ts:378-386` writes
`delivered-pending:{userId}` sets with a 7-day TTL. That was an owner-approved audit fix
(P0-T6, `docs/audits/MESSENGER_AUDIT_FIXES.md:181-188`). So "identity parity for HTTP" would
add no _new class_ of storage — but it would multiply the identity-linked key population by
the group fan-out factor N and by every outbox re-ship, which is precisely the direction the
ruling forbids. **Do not take the 3-line parity shortcut.**

The design below therefore uses the capability handle the relay **already mints and already
returns to the submitter on the HTTP path**: the **retract token**. No new identity is stored,
no new token is minted, the submit/pull/ack wire shapes are unchanged, and the mobile
SQLCipher schema needs no bump (`src/modules/messenger/crypto/db.ts:144` already has
`retract_token TEXT`, and `updateMessageRetractToken` is already called on both the group
(`productionRuntime.ts:2714`) and 1:1-HTTP (`:2896`) paths).

Delivery model: **sender-pulled** receipts (poll on reconnect / foreground), not a server
push. That keeps the gateway untouched and adds zero new sender-addressed emit path.

---

### 1. `apps/messenger-service/src/relay/envelope.store.ts`

**(a) Non-consuming retract-token lookup.** Anchor (verbatim, current tree):

```ts
  async consumeRetractToken(token: string): Promise<string | null> {
    const id = await this.redis.client.get(retractKey(token));
    if (!id) return null;
    await this.redis.client.del(retractKey(token));
    return id;
  }
```

Insert immediately **after** that method:

```ts
  /**
   * SRV-08 — resolve a retract token WITHOUT consuming it. The token is the
   * only capability the relay hands the submitter on the HTTP path, so it
   * doubles as the possession proof for a delivery-receipt query. Read-only:
   * `retract:{token}` survives ack (only `retract()` deletes it), so a token
   * still resolves after the envelope itself is gone.
   */
  async peekRetractToken(token: string): Promise<string | null> {
    return this.redis.client.get(retractKey(token));
  }

  /**
   * SRV-08 — record the ack outcome under the envelope id so a submitter that
   * has no live socket (every HTTP submit: group fan-out, WS-ack fallback,
   * outbox drain) can still learn `delivered` / `undeliverable`. The value is
   * one byte of state keyed by a random uuid — no user id, no device id, no
   * link to either party. 7-day TTL mirrors PENDING_DELIVERED_TTL_SEC.
   */
  private static readonly RECEIPT_TTL_SEC = 7 * 24 * 3600;

  async setReceiptOutcome(
    envelopeId: string,
    outcome: 'delivered' | 'undeliverable',
  ): Promise<void> {
    await this.redis.client.set(
      receiptKey(envelopeId),
      outcome === 'undeliverable' ? 'u' : 'd',
      'EX', EnvelopeStore.RECEIPT_TTL_SEC,
    );
  }

  async getReceiptOutcome(envelopeId: string): Promise<'delivered' | 'undeliverable' | null> {
    const raw = await this.redis.client.get(receiptKey(envelopeId));
    if (raw === 'd') return 'delivered';
    if (raw === 'u') return 'undeliverable';
    return null;
  }
```

**(b) Key helper.** Anchor:

```ts
function submitterKey(envelopeId: string): string {
  return `submitter:${envelopeId}`;
}
```

Insert after it:

```ts
/**
 * SRV-08 — ack-outcome flag, keyed by the random envelope uuid. Holds a
 * single character ('d' | 'u'); readable only by a caller that can present
 * the matching retract token.
 */
function receiptKey(envelopeId: string): string {
  return `rcpt:${envelopeId}`;
}
```

**(c) Aux-key hygiene.** Anchor inside `purgeRecipientQueue`:

```ts
pipe.del(envKey(id));
pipe.del(ackTokenKey(id));
pipe.del(submitterKey(id));
```

Replace with:

```ts
pipe.del(envKey(id));
pipe.del(ackTokenKey(id));
pipe.del(submitterKey(id));
pipe.del(receiptKey(id));
```

(Purged envelopes were never acked, so the key normally does not exist; the DEL is defensive
and free inside the existing pipeline.)

### 2. `apps/messenger-service/src/relay/envelope.service.ts`

Anchor (verbatim, inside `ack()`):

```ts
    try {
      const submitter = await this.store.takeSubmitter(envelopeId);
```

Insert a separate best-effort block **immediately before** that `try` (so a submitter-emit
throw can never skip the receipt write):

```ts
// SRV-08 — record the outcome under the envelope id so a submitter with no
// live socket can reconcile it later by presenting its retract token. Every
// HTTP submit lands here (group fan-out, WS-ack fallback, outbox drain);
// those envelopes carry no submitter mapping by design, so this is the only
// path by which their sender can ever leave the single-tick state. Stores
// no identity — one flag byte keyed by a random uuid.
try {
  await this.store.setReceiptOutcome(
    envelopeId,
    disposition === 'discarded' ? 'undeliverable' : 'delivered',
  );
} catch (e) {
  this.logger.warn(
    `[SRV-08] receipt-outcome write failed for ${envelopeId}: ${(e as Error).message}`,
  );
}
```

Add the query method next to `retract()` (anchor: the line `  async retract(retractToken: string): Promise<{retracted: boolean}> {`
— insert the new method **above** it):

```ts
  /**
   * SRV-08 — capability-scoped delivery-receipt query. Auth is the retract
   * token, exactly like `retract()`: the relay learns nothing about who is
   * asking, and a caller who cannot present the token learns nothing at all.
   * Unknown / expired / already-retracted tokens are simply omitted from the
   * response, so the endpoint is not an envelope-existence oracle beyond what
   * holding the token already implies.
   */
  async receipts(
    retractTokens: string[],
  ): Promise<{receipts: Array<{retractToken: string; envelopeId: string; status: 'delivered' | 'undeliverable'}>}> {
    if (!Array.isArray(retractTokens) || retractTokens.length === 0) {
      return {receipts: []};
    }
    if (retractTokens.length > 100) {
      throw new BadRequestException('too_many_receipt_tokens');
    }
    const out: Array<{retractToken: string; envelopeId: string; status: 'delivered' | 'undeliverable'}> = [];
    for (const token of retractTokens) {
      if (!/^[0-9a-f-]{36}$/i.test(token)) continue;
      const envelopeId = await this.store.peekRetractToken(token);
      if (!envelopeId) continue;
      const status = await this.store.getReceiptOutcome(envelopeId);
      if (!status) continue;
      out.push({retractToken: token, envelopeId, status});
    }
    return {receipts: out};
  }
```

`BadRequestException` is already imported at `envelope.service.ts:1`.

### 3. `apps/messenger-service/src/relay/envelope.controller.ts`

Add a DTO next to the existing `RetractDto` (anchor — the class declaration block that must
stay above `@Controller`):

```ts
/**
 * SRV-08 — receipt query body. Capability auth only (the retract tokens);
 * `@CurrentCaller` is intentionally unused, matching `retract`.
 */
class ReceiptsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({each: true})
  @Matches(/^[0-9a-f-]{36}$/i, {each: true})
  retractTokens!: string[];
}
```

Extend the `class-validator` import (anchor
`import {IsString, Matches, MinLength, MaxLength} from 'class-validator';`) to:

```ts
import {IsString, Matches, MinLength, MaxLength, IsArray, ArrayMaxSize} from 'class-validator';
```

Add the route immediately after `retract()`:

```ts
  /**
   * SRV-08 — pull delivery outcomes for envelopes this caller submitted over
   * HTTP (group fan-out, WS-ack fallback, outbox drain). Those submits carry
   * no submitter mapping by design, so there is no socket to push
   * `envelope.delivered` to; the sender reconciles by presenting the retract
   * tokens it already holds. Same capability model as `retract` — no
   * `@CurrentCaller`, JWT is rate-limit only.
   */
  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post('receipts')
  @HttpCode(HttpStatus.OK)
  async receipts(
    @Body() dto: ReceiptsDto,
  ): Promise<{receipts: Array<{retractToken: string; envelopeId: string; status: 'delivered' | 'undeliverable'}>}> {
    return this.envelopes.receipts(dto.retractTokens);
  }
```

> **Route-order note:** `@Post('receipts')` must be declared before/independently of
> `@Post(':id/ack')` — it already is by literal-vs-param precedence in Nest, but keep it above
> `purge-stale-recipient` for readability, same as `retract`.

### 4. `packages/messenger-core/src/transport/relayClient.ts`

Anchor (verbatim):

```ts
  async retract(retractToken: string): Promise<{retracted: boolean}> {
    return this.request('POST', '/envelopes/retract', {retractToken});
  }
```

Insert after it:

```ts
  /**
   * SRV-08 — reconcile delivery outcomes for HTTP-submitted envelopes. The
   * relay records no submitter for those, so there is no `envelope.delivered`
   * push; the sender presents the retract tokens it already stores per bubble.
   * Unknown/expired tokens are omitted from the response.
   */
  async receipts(
    retractTokens: string[],
  ): Promise<{receipts: Array<{retractToken: string; envelopeId: string; status: 'delivered' | 'undeliverable'}>}> {
    return this.request('POST', '/envelopes/receipts', {retractTokens});
  }
```

**Back-compat:** new client against an old relay gets HTTP 404 → `RelayHttpError(404)`. The
caller (§6) swallows it and sets a session-scoped disable flag so it is attempted at most once
per runtime epoch. Old client against a new relay: endpoint unused, `rcpt:*` keys are written
and TTL out unread. No existing wire field changes shape.

> `src/modules/messenger/transport/relayClient.ts` is a **stale duplicate** — nothing imports
> it (`productionRuntime.ts:48-59` imports `RelayHttpClient` from `@bravo/messenger-core`).
> Do **not** edit it; do not delete it either (out of scope, that is a separate dead-code task).

### 5. New file `src/modules/messenger/runtime/receiptReconcile.ts`

Kept out of `productionRuntime.ts` for the same reason as `envelopeDelivered.ts` (see its
header): the `messenger-crypto` Jest project runs under Node and cannot load op-sqlite.

```ts
/**
 * SRV-08 — sender-side reconciliation of delivery receipts for envelopes that
 * were submitted over HTTP.
 *
 * Group fan-out, the 1:1 WS-ack fallback and every outbox re-ship all use
 * `relay.send` (HTTP). Those submits carry no submitter mapping — Sealed
 * Sender — so the relay has no socket to push `envelope.delivered` to. The
 * relay instead records the ack outcome under the envelope id; the sender
 * presents the retract token it already persists on the bubble
 * (`retract_token`, SQLCipher schema `messages`) to read it back.
 *
 * Reuses the existing tick handlers so status-transition rules live in exactly
 * one place: `applyEnvelopeDelivered` (sent → delivered, never regresses read)
 * and `applyEnvelopeUndeliverable`.
 */

import {useMessengerStore} from '../store/messengerStore';
import {applyEnvelopeDelivered} from './envelopeDelivered';
import {applyEnvelopeUndeliverable} from './decryptFailureSignal';

export const RECEIPT_RECONCILE_MAX_TOKENS = 100;

export function collectPendingReceiptTokens(
  limit: number = RECEIPT_RECONCILE_MAX_TOKENS,
): string[] {
  const {messages} = useMessengerStore.getState();
  const tokens: string[] = [];
  for (const list of Object.values(messages)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (msg.status !== 'sent') continue;
      if (!msg.retract_token || !msg.envelope_id) continue;
      tokens.push(msg.retract_token);
      if (tokens.length >= limit) return tokens;
    }
  }
  return tokens;
}

export function applyReceiptOutcomes(
  receipts: Array<{envelopeId: string; status: 'delivered' | 'undeliverable'}>,
): number {
  let applied = 0;
  for (const r of receipts) {
    applied +=
      r.status === 'undeliverable'
        ? applyEnvelopeUndeliverable(r.envelopeId)
        : applyEnvelopeDelivered(r.envelopeId);
  }
  return applied;
}
```

### 6. `src/modules/messenger/runtime/productionRuntime.ts`

**(a)** Extend the runtime-module import block (anchor — the existing named import of
`applyEnvelopeUndeliverable` at `:80`) by adding:

```ts
import {collectPendingReceiptTokens, applyReceiptOutcomes} from './receiptReconcile';
```

**(b)** Add the driver near `drainOutbox` (module scope, so the epoch guard pattern matches).
Anchor: `let drainOutboxInflight = false;` — insert **above** it:

```ts
let receiptReconcileInflight = false;
let receiptReconcileUnsupported = false;

async function reconcileReceipts(relay: RelayHttpClient, isOurEpoch: () => boolean): Promise<void> {
  if (receiptReconcileInflight || receiptReconcileUnsupported) {
    return;
  }
  const tokens = collectPendingReceiptTokens();
  if (tokens.length === 0) {
    return;
  }
  receiptReconcileInflight = true;
  try {
    const res = await relay.receipts(tokens);
    if (!isOurEpoch()) {
      return;
    }
    applyReceiptOutcomes(res.receipts);
  } catch (e) {
    // Why: an old relay has no /envelopes/receipts — stop asking for the rest
    // of this runtime epoch instead of one 404 per reconnect.
    if (e instanceof RelayHttpError && e.status === 404) {
      receiptReconcileUnsupported = true;
    }
  } finally {
    receiptReconcileInflight = false;
  }
}
```

`RelayHttpError` must be added to the `@bravo/messenger-core` import list at `:47-59`.
`receiptReconcileUnsupported` / `receiptReconcileInflight` must be reset in the existing
runtime `_reset` / dispose path alongside `drainOutboxInflight`.

**(c)** Trigger 1 — reconnect. Anchor (verbatim, inside `onStateChange`):

```ts
if (sqlOutbox) {
  void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
}
```

Append immediately after:

```ts
// SRV-08 — HTTP-submitted envelopes (all group fan-out, the WS-ack
// fallback, every outbox re-ship) get no `envelope.delivered` push
// because the relay stores no submitter for them. Reconcile their
// ticks by capability token on every reconnect.
void reconcileReceipts(relay, isOurEpoch);
```

**(d)** Trigger 2 — foreground. Anchor (verbatim, inside the AppState `'active'` branch):

```ts
// Audit P2-7 — foreground is a flush point for queued read receipts
// (no-op when the socket isn't connected; the onStateChange
// 'connected' branch flushes after the reconnect instead).
flushPendingReadReceipts();
```

Insert immediately **before** that comment:

```ts
void reconcileReceipts(relay, isOurEpoch);
```

**(e)** Tighten the group tick capture so `envelope_id` and `retract_token` always come from
the _same_ participant result (`applyEnvelopeDelivered` matches on `envelope_id`, the receipt
query keys on `retract_token`; today they are captured by two independent `if (!first…)`
guards and could in principle diverge). Anchor (verbatim):

```ts
if (!firstRetractToken && r.value.retractToken) {
  firstRetractToken = r.value.retractToken;
}
```

Replace with:

```ts
// SRV-08 — pair the retract token with the envelope id from the
// SAME participant: the receipt query resolves token → envelopeId
// server-side and the tick handler matches on `envelope_id`.
if (!firstRetractToken && r.value.retractToken && r.value.envelopeId) {
  firstRetractToken = r.value.retractToken;
}
```

(The `firstEnvelopeId` guard 10 lines below is left untouched; both now latch on the first
result carrying an `envelopeId`, and `relay.send` always returns them together.)

### Schema / migration

**None.** `retract_token` and `envelope_id` already exist on the mobile `messages` table
(`src/modules/messenger/crypto/db.ts:144`), are already mirrored to backup
(`src/modules/messenger/backup/messageMirror.ts:788`, `backupWireV3.ts:108`) and already
restore (`restoreMessages.ts:549`). No SQLCipher version bump, no backup wire-format change,
no `BACKUP_LOOP.md` invariant touched.

## Blast radius

**Server**

- `EnvelopeStore` — 3 new methods + 1 key helper + 1 line in `purgeRecipientQueue`. No existing
  method changes behavior.
- `EnvelopeService.ack` — one additive best-effort block. The submitter path is byte-identical,
  so the WS lane (P0-T6 / RELAY-C3 / handoff §3.6(c)) is unchanged. New `receipts()` method.
- `EnvelopeController` — one new route + DTO. `send`, `pull`, `ack`, `retract`,
  `purge-stale-recipient` untouched.
- New Redis key population: one 2-byte key per acked envelope, 7-day TTL. Same order of
  magnitude as the existing `delivered-pending:*` sets; it is per-envelope rather than
  per-sender, so on a large deployment size it against Redis maxmemory before shipping.

**Client**

- `packages/messenger-core/src/transport/relayClient.ts` — additive method.
- `productionRuntime.ts` — 2 call sites (reconnect, foreground), 1 module-scope helper, 1
  two-line tightening in the group fan-out result loop. No change to any send path.
- New dependency-light module `receiptReconcile.ts`.

**Overlapping findings**

- **OM-03 / SYNC-3** — the audit says "likely ONE shared fix". This spec _is_ that fix for the
  sender-tick half: OM-03/SYNC-3 must consume `reconcileReceipts` rather than re-proposing an
  identity submitter. Whoever owns them edits the same `ack()` region and the same
  `onStateChange('connected')` block — sequence, don't parallelise.
- **SRV-01 / GF-1** (batch envelopes) — same controller, and the batch verdict is FORBIDDEN;
  do not let a batch endpoint reintroduce a fan-out-correlating submit.
- **RELAY-C3 / handoff §3.6(c)** — `flushPendingDelivered` still runs for WS submits; a WS
  bubble can now be flipped by both the push and the poll. Both are idempotent
  (`applyEnvelopeDelivered` returns 0 on a non-`sent` bubble).
- **undeliverableResend.ts** — will now start firing for group/HTTP sends that were previously
  invisible. That is the intended behavior, but it means a real behavior change for group
  messages that the recipient destroyed: verify the resend path is group-safe before shipping.

**What could regress**

- A `read` bubble must never regress to `delivered`. Guarded inside `applyEnvelopeDelivered`
  (`envelopeDelivered.ts:41-46`) — do not bypass it.
- `expirySweeper.ts:129-142` consumes `retract_token` to retract on burn. `peekRetractToken` is
  read-only, so it cannot break that; but after a retract the token is gone and any pending
  receipt for it silently drops (correct — the message is being destroyed anyway).
- The 100-token cap means a sender with >100 stuck `sent` bubbles reconciles the newest 100 per
  trigger. Acceptable; note it rather than raising the cap.

## Tests

**Server — `apps/messenger-service/src/relay/envelope.service.spec.ts`** (existing file, uses an
in-memory redis double; follow the `audit P0-T6` describe block at `:429-500`):

1. `SRV-08 — ack writes rcpt:{envelopeId}='d' for an HTTP submit (no submitter)` — submit with
   no `submitter`, ack with token, assert `await redis.get('rcpt:' + envelopeId) === 'd'`.
2. `SRV-08 — discarded ack writes 'u'` — same with `disposition: 'discarded'`.
3. `SRV-08 — receipts() resolves by retract token and returns delivered` — assert the returned
   row is `{retractToken, envelopeId, status: 'delivered'}`.
4. `SRV-08 — receipts() omits an unacked envelope` — submit, do not ack, expect `receipts: []`.
5. `SRV-08 — receipts() omits an unknown/garbage token` — random uuid ⇒ `[]`; malformed string
   ⇒ `[]` (no throw).
6. `SRV-08 — receipts() rejects >100 tokens` — expect `BadRequestException`.
7. `SRV-08 — peekRetractToken does NOT consume` — call `receipts()` twice, then assert
   `retract(token)` still returns `{retracted: false}`/`{retracted: true}` per envelope state
   (i.e. the token was not eaten by the query).
8. **Sealed-sender guard (must-have):** `SRV-08 — receipt path stores no submitter identity` —
   after an HTTP submit + ack, assert `await redis.get('submitter:' + envelopeId) === null`
   **and** that no key in the fake redis contains the submitter's userId. This is the
   regression fence against someone "simplifying" this back into the forbidden parity fix.
9. `SRV-08 — WS submit still emits envelope.delivered` (regression on P0-T6): submit _with_
   `submitter`, ack, assert the hub emit still fires **and** the rcpt key is also written.

**Server — `apps/messenger-service/src/relay/envelope.controller.spec.ts`** (existing, plain
constructor injection): 10. `SRV-08 — POST /envelopes/receipts forwards tokens and does not read the caller` — assert
`envelopes.receipts` was called with the token array and that the controller method's
signature takes no `@CurrentCaller` (call it with only the DTO).

**Mobile — new `src/modules/messenger/__tests__/receiptReconcile.test.ts`** (Jest project
`messenger-crypto`; mirror the layout of `envelopeDelivered.test.ts` and
`decryptFailureSignal.test.ts`, which already seed `useMessengerStore` directly): 11. `collectPendingReceiptTokens` returns only `sent` bubbles that have BOTH `retract_token`
and `envelope_id`; skips `sending` / `failed` / `delivered` / `read`. 12. `collectPendingReceiptTokens` caps at `RECEIPT_RECONCILE_MAX_TOKENS`. 13. `applyReceiptOutcomes` flips `sent → delivered` for `status:'delivered'`. 14. `applyReceiptOutcomes` flips to the undelivered state for `status:'undeliverable'`. 15. `applyReceiptOutcomes` leaves a `read` bubble alone (delegated guard, assert it holds). 16. `applyReceiptOutcomes` is idempotent across two calls with the same payload.

**Commands (in order):** `npm test -- --selectProjects=messenger-crypto` (or
`npm run test:crypto`), then `cd apps/messenger-service && npm test`, then `npm run typecheck`
(baseline 47, must not increase) and `cd apps/ops-console && npm run typecheck`.
Also re-run `packages/messenger-core/__tests__/logAudit.test.ts` — nothing added here may log a
retract token (it is a capability) or a user id.

## Risk

1. **The reviewer's first question must be: does this store submitter identity?** It must not.
   Grep the diff for `claims.sub`, `caller`, `signalDeviceId` inside `envelope.controller.ts
send()` and `envelope.service.ts submitEnvelope()`. Test #8 is the fence.
2. **Capability conflation.** The retract token now grants two powers: destroy the envelope,
   and read one bit of delivery state. The second is strictly weaker than the first and the
   token is held only by the sender, so there is no privilege escalation — but if a future
   change ever hands a retract token to a third party (a shared-device sync, an export), it
   now also leaks delivery status. Never log the token (`logAudit` gate) and never return it
   from any endpoint other than submit.
3. **Metadata surface.** `rcpt:{uuid} = 'd'` is unlinked to any party, but it is a _new_
   server-side fact that persists 7 days past the envelope's hard-delete. Argue this explicitly
   against `MESSENGER_BACKEND.md:156` before merging — it is arguably weaker than the existing
   `delivered-pending:{userId}` sets, but it is an addition and this is a CLAUDE.md stop
   condition area (_"relay dwell semantics, ack/retract tokens, or envelope ID handling"_).
   **This spec is architecture-gated and needs sign-off before code lands.**
4. **Poll, not push.** Group ticks now update on reconnect and on foreground, not instantly. A
   user watching a group thread on a stable socket may wait until the next foreground
   transition. If instant ticks are required, the follow-up (arch-gated separately) is a WS
   `receipt.subscribe {retractTokens}` handler that joins `rcpt:{token}` socket.io rooms +
   `SocketHub.emitToRoom` at ack — still identity-free, and it reuses the Redis adapter for
   cross-replica fan-out. Do **not** ship that in the same change.
5. **Redis growth.** One key per acked envelope for 7 days is a real (if small) capacity delta
   on a busy relay. Confirm against the box's maxmemory policy; the existing
   `PendingQueueFullError` machinery does not cover this key class.
6. **First-participant semantics for groups is unchanged and still a half-truth** — a group
   bubble flips to `delivered` when _one_ member acks, because only `firstEnvelopeId` /
   `firstRetractToken` are stored. That is today's shipped model (MSG-03) and this change does
   not make it worse, but do not let anyone claim SRV-08 delivers per-member group receipts. A
   per-member receipt map is the OM-03 follow-up and needs a `LocalMessage.receipts` field
   (see `docs/handoffs/IOS_GROUPCALL_AND_MESSENGER_PARITY_B111_B117_2026-07-18.md:201`).
7. **`undeliverableResend` waking up for groups** is the biggest behavioral surprise in this
   diff. Verify the group resend path end-to-end (or gate it to 1:1 for this increment) before
   declaring done.
