# SYNC-3 - Delivered/undeliverable receipts never fire for HTTP-submitted envelopes (all group sends, all outbox drains, every WS-ack-timeout fallback, every B-46 auto-resend)

## Verdict

**CONFIRMED** (mechanism exactly as described; the audit's _proposed fix_ is rejected — see §Fix).

Evidence from the current tree:

1. `apps/messenger-service/src/relay/envelope.controller.ts:78-83` — the HTTP submit builds the service input with **no `submitter` field**:
   `const res = await this.envelopes.submitEnvelope({ recipient: dto.recipient, outerSealed: dto.outerSealed, clientMsgId: dto.clientMsgId, expiresAtSec: dto.expiresAtSec, });`
   with the preceding comment `// Sealed Sender: we intentionally do NOT pass caller identity into the service`.
2. `apps/messenger-service/src/gateway/messenger.gateway.ts:1094` — the WS lane **does** pass it: `submitter:    {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},`.
3. `apps/messenger-service/src/relay/envelope.service.ts:234-236` — the mapping is only written when the field is present: `if (input.submitter) { await this.store.storeSubmitter(envelopeId, input.submitter, effectiveTtl); }`.
4. `apps/messenger-service/src/relay/envelope.service.ts:376-392` — the entire receipt fan-out is gated on that mapping: `const submitter = await this.store.takeSubmitter(envelopeId); if (submitter) { … 'envelope.undeliverable' … / … 'envelope.delivered' … }`. No mapping ⇒ **no `envelope.delivered`, no `envelope.undeliverable`, and no `addPendingDelivered`/`addPendingUndeliverable` durable queue entry either**.
5. `apps/messenger-service/src/relay/envelope.store.ts:334-337` even documents the hole as intended: _"a missing key returns null (the most common reason is a sender that submitted via HTTP … those senders don't have a live socket to notify, so silent skip is correct)"_ — which is false today: HTTP submitters are almost always WS-connected (group fan-out uses HTTP by design while the socket is up).

Client side confirms the receipts are wanted and would light up for free:

- Group fan-out is HTTP-only and already records the envelope id — `src/modules/messenger/runtime/productionRuntime.ts:2641-2651` (`await relay.send({...})` … `return {status: 'ok', userId, retractToken: r.retractToken, envelopeId: r.envelopeId}`) and `:2896-2900` (`updateMessageEnvelopeId`).
- 1:1 WS-ack-timeout fallback is HTTP — `productionRuntime.ts:2886-2905` (`const httpFallback = async () => { const r = await relay.send({...}) … updateMessageEnvelopeId … }`).
- Outbox drain is HTTP — `productionRuntime.ts:7488-7491`.
- B-46 auto-resend is HTTP — `productionRuntime.ts:869` (`const r = await relay.send({recipient: peer, outerSealed, clientMsgId: newClientMsgId, expiresAtSec});`). So even the _recovery_ send for an undeliverable message is itself receipt-blind.
- The sender-side handlers already exist and key purely off `envelopeId` — `productionRuntime.ts:5134-5147` (`case 'envelope.delivered': applyEnvelopeDelivered(...)`, `case 'envelope.undeliverable': applyEnvelopeUndeliverable(...) + deps.resendUndeliverable(...)`).

Net effect, confirmed: for **every group message** and **every message that took the outbox/fallback path**, the bubble is stuck at single-tick `sent` forever unless a read-receipt arrives, and the `decryptFailureSignal` "honest red icon" + B-46 auto-resend are completely dead.

---

## Mechanism

1. Sender composes. For a group, `sendGroupMessage` fans out N per-recipient sealed envelopes and **always** uses `relay.send()` (HTTP `POST /envelopes`) — see the comment at `productionRuntime.ts:2632-2637` ("Group fan-out always uses HTTP"). For 1:1, the WS `envelope.send` is tried first; if the `envelope.accepted` watchdog expires, `httpFallback()` runs the same HTTP submit. The durable outbox drain and the B-46 resend also use HTTP unconditionally.
2. `EnvelopeController.send` verifies the JWT (guard), then calls `EnvelopeService.submitEnvelope` **without** `submitter`.
3. `submitEnvelope` therefore skips `store.storeSubmitter(...)`; no `submitter:{envelopeId}` key is written.
4. Client stores the returned `envelopeId` on the local row (`updateMessageEnvelopeId`) and paints `sent`.
5. Recipient pulls/receives, decrypts, and acks: `POST /envelopes/:id/ack` with `disposition: 'delivered' | 'discarded'` (`productionRuntime.ts:5683-5685`, `:7880-7881`).
6. `EnvelopeService.ack` hard-deletes, then `takeSubmitter(envelopeId)` returns **null** → the whole `if (submitter) {…}` block is skipped. Nothing is emitted, nothing is queued.
7. Sender never receives `envelope.delivered` → bubble never reaches ✓✓. Sender never receives `envelope.undeliverable` → `applyEnvelopeUndeliverable` never flips the bubble to `undelivered`, the honest red icon never paints, and `resendUndeliverable` (B-46) never fires — so a message destroyed by recipient identity churn is silently lost behind a lying single tick.

Aggravating factor: group messages are the single largest lane through this hole, and group rows have **no** undeliverable-resend path at all (`undeliverableResend.ts:16-18`), so the receipt is the only truth signal that could exist.

---

## Fix

### Why the audit's proposed fix is rejected

The audit says: _"carry the caller's own JWT identity as submitter on HTTP submit (parity with WS)"_. That is a 3-line diff and it works — but the architecture gate for this batch rules it **FORBIDDEN as literally proposed**, on `MESSENGER_BACKEND.md:137` ("JWT verified — rate-limit only, we do NOT persist submitter identity"), `:156`, and `SIGNAL_PROTOCOL_IMPLEMENTATION.md:514` ("deliberately drops submitter identity before storage"). Only an **anonymous capability handle** is allowed.

**Flag for the architecture owner (do not silently fix, do not use as licence):** the gate's premise that the WS binding is merely "an in-memory socket binding that dies with the connection" is **factually wrong in the current tree**. `EnvelopeStore.storeSubmitter` (`envelope.store.ts:316-326`) writes `submitter:{envelopeId} = "{userId}:{deviceId}"` into **Redis** with the envelope's full dwell TTL (up to 30 days), and `addPendingDelivered` (`envelope.store.ts:361+`) keeps a 7-day Redis set **keyed by the sender's userId**. So the deployed P0-T6 / RELAY-C3 code already stores exactly the linkage the docs forbid. The design below does **not** extend that, and it gives a clean path to delete both (follow-up, not this ticket).

### Chosen design — anonymous, envelope-id-keyed receipt subscription

The capability is _knowledge of the `envelopeId`_ (a random UUIDv4 minted by the relay and returned only to the submitter; the recipient also knows it, and learns nothing new from it since they caused the outcome). The relay stores **only an outcome enum** at rest — no user id, no device id, no correlator across envelopes. Routing is a socket.io room, i.e. in-memory socket state that dies with the connection.

Properties: no wire-format change to the envelope, no new response field, **no SQLCipher migration**, no server DTO change, purely additive on both ends, and old clients/old servers keep today's exact behaviour.

---

#### 1. `apps/messenger-service/src/relay/envelope.store.ts`

**Anchor A** (module-scope key helper, near the bottom):

```ts
function submitterKey(envelopeId: string): string {
  return `submitter:${envelopeId}`;
}
```

**Insert after it:**

```ts
/**
 * SYNC-3 — anonymous receipt outcome. Value is the outcome enum ONLY;
 * no user/device tuple, so this key adds no sender↔envelope linkage.
 */
function receiptOutcomeKey(envelopeId: string): string {
  return `rcpt:out:${envelopeId}`;
}
```

**Anchor B** (the RELAY-C3 doc block inside the class):

```ts
  /**
   * Audit RELAY-C3 (2026-07-02): make the delivered ("double-tick") receipt
```

**Insert immediately before that comment:**

```ts
  /**
   * SYNC-3 — record the ack outcome under the envelope id so a submitter
   * that had no live socket (or was killed) can reclaim the receipt on its
   * next `receipt.subscribe`. Non-destructive on read; the TTL is the only
   * eviction. Stores an enum, never an address.
   */
  private static readonly RECEIPT_OUTCOME_TTL_SEC = 7 * 24 * 3600;

  async recordEnvelopeOutcome(
    envelopeId: string,
    outcome: 'delivered' | 'undeliverable',
  ): Promise<void> {
    await this.redis.client.set(
      receiptOutcomeKey(envelopeId),
      outcome,
      'EX', EnvelopeStore.RECEIPT_OUTCOME_TTL_SEC,
    );
  }

  async readEnvelopeOutcomes(
    envelopeIds: string[],
  ): Promise<Array<{envelopeId: string; outcome: 'delivered' | 'undeliverable'}>> {
    if (envelopeIds.length === 0) return [];
    const raws = await this.redis.client.mget(...envelopeIds.map(receiptOutcomeKey));
    const out: Array<{envelopeId: string; outcome: 'delivered' | 'undeliverable'}> = [];
    for (let i = 0; i < envelopeIds.length; i++) {
      const raw = raws[i];
      if (raw === 'delivered' || raw === 'undeliverable') {
        out.push({envelopeId: envelopeIds[i]!, outcome: raw});
      }
    }
    return out;
  }
```

---

#### 2. `apps/messenger-service/src/gateway/socket-hub.ts`

**Anchor:**

```ts
  userRoom(userId: string): string {
    return `u:${userId}`;
  }
```

**Insert after:**

```ts
  /**
   * SYNC-3 — per-envelope receipt room. Membership is transient socket
   * state (dies with the connection); the room name carries no identity.
   */
  receiptRoom(envelopeId: string): string {
    return `rcpt:${envelopeId}`;
  }

  emitToReceiptRoom(envelopeId: string, event: string, data: unknown): void {
    this.server?.to(this.receiptRoom(envelopeId)).emit(event, data);
  }
```

Also update the `Room keys:` doc list in that file's header comment with `` `rcpt:{envelopeId}` — targets whoever subscribed to this envelope's receipt ``.

---

#### 3. `apps/messenger-service/src/relay/envelope.service.ts`

**Anchor** (inside `ack`, the whole submitter branch):

```ts
const submitter = await this.store.takeSubmitter(envelopeId);
if (submitter) {
  if (disposition === 'discarded') {
    // Handoff §3.6(c) — the recipient destroyed the message; tell
    // the sender the truth instead of painting ✓✓.
    this.hub.emitToDevice(submitter, 'envelope.undeliverable', {envelopeId});
    try {
      await this.store.addPendingUndeliverable(submitter.userId, envelopeId);
    } catch {
      /* best-effort — the live emit may have landed */
    }
  } else {
    this.hub.emitToDevice(submitter, 'envelope.delivered', {envelopeId});
    // Audit RELAY-C3 — also queue it so a sender who was offline at this
    // moment still gets the double-tick on their next connect (the live
    // emit above is fire-and-forget with no delivery guarantee).
    try {
      await this.store.addPendingDelivered(submitter.userId, envelopeId);
    } catch {
      /* best-effort — the live emit may have landed */
    }
  }
}
```

**Replace with** (adds an `else` branch only — the WS lane is byte-for-byte unchanged, so no double emit is possible):

```ts
const submitter = await this.store.takeSubmitter(envelopeId);
if (submitter) {
  if (disposition === 'discarded') {
    // Handoff §3.6(c) — the recipient destroyed the message; tell
    // the sender the truth instead of painting ✓✓.
    this.hub.emitToDevice(submitter, 'envelope.undeliverable', {envelopeId});
    try {
      await this.store.addPendingUndeliverable(submitter.userId, envelopeId);
    } catch {
      /* best-effort — the live emit may have landed */
    }
  } else {
    this.hub.emitToDevice(submitter, 'envelope.delivered', {envelopeId});
    // Audit RELAY-C3 — also queue it so a sender who was offline at this
    // moment still gets the double-tick on their next connect (the live
    // emit above is fire-and-forget with no delivery guarantee).
    try {
      await this.store.addPendingDelivered(submitter.userId, envelopeId);
    } catch {
      /* best-effort — the live emit may have landed */
    }
  }
} else {
  // SYNC-3 — HTTP-submitted envelope (all group fan-out, every outbox
  // drain, every WS-ack-timeout fallback, every B-46 auto-resend). There
  // is no submitter mapping by design (Sealed Sender: the relay must not
  // persist who sent what), so route the receipt through the anonymous
  // envelope-id room instead and record the outcome for a submitter that
  // is offline right now.
  const outcome = disposition === 'discarded' ? ('undeliverable' as const) : ('delivered' as const);
  await this.store.recordEnvelopeOutcome(envelopeId, outcome);
  this.hub.emitToReceiptRoom(envelopeId, `envelope.${outcome}`, {envelopeId});
}
```

**Add a public replay method** (used by the gateway). Anchor on the `flushPendingDelivered` doc comment; insert this method immediately **before** it:

```ts
  /**
   * SYNC-3 — replay recorded ack outcomes for the envelope ids a submitter
   * claims to be waiting on. Knowledge of the (random UUID) envelope id is
   * the capability; the relay learns no identity and stores none. Read is
   * non-destructive — the client's applyEnvelopeDelivered /
   * applyEnvelopeUndeliverable are idempotent and the key TTLs out.
   */
  async replayEnvelopeReceipts(
    envelopeIds: string[],
  ): Promise<Array<{envelopeId: string; event: 'envelope.delivered' | 'envelope.undeliverable'}>> {
    const rows = await this.store.readEnvelopeOutcomes(envelopeIds);
    return rows.map(r => ({envelopeId: r.envelopeId, event: `envelope.${r.outcome}` as const}));
  }
```

---

#### 4. `apps/messenger-service/src/gateway/ws-rate-limiter.ts`

**Anchor:**

```ts
  'envelope.ack':      {refillPerSec: 6,  capacity: 60},
```

**Insert after:**

```ts
  // SYNC-3 — receipt-room subscription. A client subscribes once per HTTP
  // submit plus one batch per reconnect, so this budget is far above
  // legitimate use; it exists to stop an envelope-id enumeration loop.
  'receipt.subscribe': {refillPerSec: 2,  capacity: 20},
```

---

#### 5. `apps/messenger-service/src/gateway/messenger.gateway.ts`

**Anchor** (the start of the envelope send handler):

```ts
  @SubscribeMessage('envelope.send')
  async handleEnvelopeSend(
```

**Insert the new handler immediately before it:**

```ts
  /**
   * SYNC-3 — subscribe to the ack outcome of envelopes this socket
   * submitted over HTTP (group fan-out, outbox drain, WS-fallback,
   * B-46 resend). The relay never stored who submitted them, so the
   * capability is knowledge of the random UUID envelope id. Joining
   * the room is transient socket state; nothing is persisted. Any
   * outcome already recorded is replayed immediately so a submitter
   * that was offline at ack time still gets its tick.
   */
  @SubscribeMessage('receipt.subscribe')
  async handleReceiptSubscribe(
    @MessageBody() data: {envelopeIds?: string[]},
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return;
    if (this.rateGate(client, 'receipt.subscribe')) return;
    const ids = Array.isArray(data?.envelopeIds) ? data.envelopeIds : [];
    const wanted = ids
      .filter(id => typeof id === 'string' && UUID_RE.test(id))
      .slice(0, MAX_RECEIPT_IDS_PER_CALL);
    if (wanted.length === 0) return;

    let joined = Array.from(client.rooms).filter(r => r.startsWith('rcpt:')).length;
    const accepted: string[] = [];
    for (const id of wanted) {
      if (joined >= MAX_RECEIPT_ROOMS_PER_SOCKET) break;
      const room = this.hub.receiptRoom(id);
      if (!client.rooms.has(room)) {
        await client.join(room);
        joined += 1;
      }
      accepted.push(id);
    }

    try {
      const replays = await this.envelopes.replayEnvelopeReceipts(accepted);
      for (const r of replays) {
        client.emit(r.event, {envelopeId: r.envelopeId});
      }
    } catch (e) {
      this.logger.warn(`[SYNC-3] receipt replay failed: ${(e as Error).message}`);
    }
  }
```

Module-scope constants next to the file's other caps:

```ts
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_RECEIPT_IDS_PER_CALL = 128;
const MAX_RECEIPT_ROOMS_PER_SOCKET = 256;
```

(`UUID_RE` — reuse if the file already has an equivalent; check before adding.)

---

#### 6. Protocol types — `apps/messenger-service/src/gateway/protocol.ts`, `packages/messenger-core/src/transport/protocol.ts`, `src/modules/messenger/transport/protocol.ts`

Mirror `ClientPresenceSubscribe` in each:

```ts
/**
 * SYNC-3 — ask the relay to route this envelope's ack outcome
 * (`envelope.delivered` / `envelope.undeliverable`) back to this socket.
 * Needed only for HTTP-submitted envelopes; the WS submit path is wired
 * server-side. Carries no identity — the envelope id is the capability.
 */
export interface ClientReceiptSubscribe {
  event: 'receipt.subscribe';
  data: {envelopeIds: string[]};
}
```

and add `| ClientReceiptSubscribe` to the `ClientFrame` union in each file. **No `ServerFrame` change** — the server re-uses the existing `ServerEnvelopeDelivered` / `ServerEnvelopeUndeliverable` frames, which the client already handles.

---

#### 7. `src/modules/messenger/transport/client.ts`

**Anchor:**

```ts
  subscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.send({event: 'presence.subscribe', data: {userIds}});
  }
```

**Insert after:**

```ts
  subscribeReceipts(envelopeIds: string[]): void {
    if (envelopeIds.length === 0) {return;}
    this.send({event: 'receipt.subscribe', data: {envelopeIds}});
  }
```

---

#### 8. New module `src/modules/messenger/runtime/receiptSubscription.ts`

Pure + store-only, so it runs under the `messenger-crypto` Jest project (same shape as `envelopeDelivered.ts`).

```ts
/**
 * SYNC-3 — receipt-room bookkeeping for HTTP-submitted envelopes.
 *
 * The relay does not (and must not) persist who submitted an envelope over
 * HTTP, so the sender has to opt in to its own delivered/undeliverable
 * receipt by presenting the envelope ids it is waiting on. This module owns
 * the two selections:
 *   - `pendingReceiptEnvelopeIds` — rebuilt from the store on reconnect, so
 *     an app that was killed between submit and ack still reclaims the tick.
 *   - a bounded in-memory set for ids observed during this process run.
 */

import {useMessengerStore} from '../store/messengerStore';

export const MAX_RECEIPT_SUBSCRIPTIONS = 200;

const live = new Set<string>();

/** Note an envelope id we just submitted over HTTP. Bounded FIFO. */
export function noteOutboundEnvelope(envelopeId: string): string[] {
  if (!envelopeId || live.has(envelopeId)) {
    return [];
  }
  live.add(envelopeId);
  while (live.size > MAX_RECEIPT_SUBSCRIPTIONS) {
    const oldest = live.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    live.delete(oldest);
  }
  return [envelopeId];
}

/**
 * Envelope ids whose bubble is still awaiting a receipt: our own outbound
 * rows sitting at `sent`. `delivered` / `read` / `undelivered` are already
 * settled; `sending` / `failed` never reached the relay.
 */
export function pendingReceiptEnvelopeIds(limit = MAX_RECEIPT_SUBSCRIPTIONS): string[] {
  const store = useMessengerStore.getState();
  const ids: string[] = [];
  for (const list of Object.values(store.messages)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (!msg?.envelope_id) {
        continue;
      }
      if (msg.sender_id !== 'self') {
        continue;
      }
      if (msg.status !== 'sent') {
        continue;
      }
      ids.push(msg.envelope_id);
      if (ids.length >= limit) {
        return ids;
      }
    }
  }
  for (const id of live) {
    if (ids.length >= limit) {
      break;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Test seam — drops the in-memory set. */
export function resetReceiptSubscriptions(): void {
  live.clear();
}
```

_(Confirm the sentinel for own messages before writing: `decryptFailureSignal.ts` builds placeholder rows with `sender_id` and `applyEnvelopeDelivered` scans `msg.envelope_id`; use whatever `LocalMessage.sender_id` value the outbound writer uses — `'self'` per `undeliverableResend.ts`'s "own outbound 1:1 TEXT rows only" selector. Match `selectUndeliverableResend`'s own predicate exactly rather than re-deriving it.)_

---

#### 9. `src/modules/messenger/runtime/productionRuntime.ts`

**(a)** Import next to the existing `decryptFailureSignal` import (`:81`):

```ts
import {noteOutboundEnvelope, pendingReceiptEnvelopeIds} from './receiptSubscription';
```

**(b)** A single local helper, defined next to `flushPendingReadReceipts` (`:934`):

```ts
// SYNC-3 — HTTP-submitted envelopes carry no submitter mapping on the
// relay, so ask for their receipts explicitly. Best-effort: a closed
// socket just means the reconnect batch below picks them up.
const subscribeReceipts = (envelopeIds: string[]): void => {
  if (envelopeIds.length === 0) {
    return;
  }
  try {
    transport.subscribeReceipts(envelopeIds);
  } catch {
    /* socket down — reconnect batch retries */
  }
};
```

**(c)** Call it at each site that already records the envelope id after an HTTP submit — four sites, one line each, immediately after the existing `updateMessageEnvelopeId(...)`:

- `:2899-2900` (1:1 `httpFallback`) — after `useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, r.envelopeId);`
- `:2703-2705` (group fan-out, `firstEnvelopeId`) — after `useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, firstEnvelopeId);`
- `:872` (B-46 resend) — after `if (r.envelopeId) {st2.updateMessageEnvelopeId(conversationId, message.id, r.envelopeId);}`
- `:7488-7491` (outbox drain) — after its `updateMessageEnvelopeId` call

each as:

```ts
subscribeReceipts(noteOutboundEnvelope(r.envelopeId));
```

**(d)** Reconnect batch. **Anchor** in the `onStateChange` `state === 'connected'` branch (`:1203-1206`):

```ts
// Audit MSG-06 / P2-7 — flush read receipts that couldn't be sent
// while the socket was down. Entries are removed per-peer only
// after their emit succeeded; failures stay queued (durably) for
// the next reconnect/foreground flush.
flushPendingReadReceipts();
```

**Insert after it:**

```ts
// SYNC-3 — re-arm receipt routing for every HTTP-submitted envelope
// still sitting at single-tick `sent`. Covers the app-killed case:
// the relay recorded the outcome anonymously and replays it on
// subscribe. Bounded to the 200 most recent.
try {
  subscribeReceipts(pendingReceiptEnvelopeIds());
} catch {
  /* store mid-swap during owner switch */
}
```

---

### Back-compat (explicit)

| Combination                 | Behaviour                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New client → **old server** | `receipt.subscribe` is an unhandled socket.io event. `TransportClient.send` uses `socket.emit(...)` with **no ack callback** (`transport/client.ts:113-120`), so it is silently dropped — no error, no timeout. Client behaves exactly as today.   |
| Old client → **new server** | Never sends `receipt.subscribe`; the new `else` branch writes one small Redis key that nobody reads (TTLs out in 7 days) and emits into an empty room. Zero behaviour change. WS-submitted envelopes take the _unchanged_ `if (submitter)` branch. |
| New ↔ new                   | Receipts fire for HTTP-submitted envelopes.                                                                                                                                                                                                        |

No `SendEnvelopeDto` change, no `StoredEnvelope` change, no HTTP response-shape change, **no SQLCipher schema bump** (the client stores nothing new — `envelope_id` already exists on `LocalMessage`), no `ServerFrame` addition.

---

## Blast radius

**Server**

- `envelope.store.ts` — 2 new methods + 1 key helper. No change to any existing method. `purgeRecipientQueue`'s pipeline (`:570 pipe.del(submitterKey(id))`) does **not** need `rcpt:out:*` cleanup: the outcome key is only ever written _at ack_, and purge only touches un-acked envelopes.
- `envelope.service.ts` — `ack()` gains an `else` branch (the `if (submitter)` path is unchanged, so `envelope.delivered`/`envelope.undeliverable` cannot double-fire); one new public method. Callers of `ack()`: `EnvelopeController.ack` and the WS `envelope.ack` handler — both unchanged.
- `socket-hub.ts` — 2 additive methods. `SpyHub` in `envelope.service.spec.ts` overrides only `emitToDevice`; it must gain an `emitToReceiptRoom` override or the spec will hit `this.server === null` (harmless no-op, but the assertion needs the spy).
- `messenger.gateway.ts` — one new `@SubscribeMessage`. Room-count discipline mirrors `MAX_MISSIONS_PER_SOCKET` (`:1040`). Socket.io rooms are per-socket Sets; 256 is cheap. Redis-adapter broadcast cost per receipt is one cross-node publish — same as every other `hub.emitTo*`.
- `ws-rate-limiter.ts` — one map entry; `ws-rate-limiter.spec.ts` may assert the key set (check).

**Client**

- `productionRuntime.ts` — 4 one-line call sites + 1 helper + 1 reconnect hook. No change to `handleAccepted`, `handleDeliver`, or the ack path.
- New pure module + transport method. `applyEnvelopeDelivered` / `applyEnvelopeUndeliverable` / `resendUndeliverable` are **untouched** — they light up for free.

**Overlapping findings (coordinate edits)**

- Anything else editing `EnvelopeService.ack` or `EnvelopeController.send` (the audit's OM-03 / SRV-08 are the _same_ defect under different names — fold them into this spec, do not implement three variants).
- **SRV-01/GF-1** (`POST /envelopes/batch`) would touch `EnvelopeController.send` and `submitEnvelope`; that finding is arch-FORBIDDEN in its proposed form, but if a throttle-only variant lands it edits the same decorator block.
- **GF-2/SYNC-2** (durable group key fan-out) adds outbox rows on the same HTTP lane — it _benefits_ from this fix and should not re-implement receipts.
- **SYNC-4** (delete-for-everyone) rides `envelope.{delivered,undeliverable}`-adjacent machinery; keep the frame shapes stable.

**What could regress**

1. **Double receipts** if someone "simplifies" the `if/else` into two unconditional paths. `applyEnvelopeUndeliverable` is idempotent (returns 0 once the row is `undelivered`) and B-46's budget is `MAX_AUTO_RESENDS_PER_MESSAGE = 1`, so the damage would be bounded — but the `else` structure must be preserved.
2. **Group ticks are still first-recipient-only.** `productionRuntime.ts:2696-2705` records only `firstEnvelopeId` (pre-existing MSG-03 limitation). After this fix a group bubble flips to ✓✓ when the _first_ recipient acks, which is more honest than "never" but is **not** "all members delivered". Call this out in the PR; a per-member receipt model is a separate ticket.
3. Room accumulation on a very long-lived socket — capped at 256, and the cap silently truncates rather than erroring (the recorded outcome + next reconnect batch is the safety net).
4. `client.rooms` scan per `receipt.subscribe` is O(rooms); with the 256 cap and a 2/s rate limit this is negligible.

---

## Tests

**Server (`apps/messenger-service`, `npm test` from that dir)**

- `apps/messenger-service/src/relay/envelope.service.spec.ts` (existing — extend; add an `emitToReceiptRoom` override to `SpyHub`):
  - `submit WITHOUT submitter → ack('delivered') → hub received {room: 'rcpt:{envelopeId}', event: 'envelope.delivered', data: {envelopeId}}` and `store.readEnvelopeOutcomes([id])` returns `[{envelopeId, outcome: 'delivered'}]`.
  - same with `disposition: 'discarded'` → `envelope.undeliverable` + outcome `'undeliverable'`.
  - `submit WITH submitter → ack` → the existing `emitToDevice` assertion still holds **and** `emitToReceiptRoom` was **not** called (no double receipt) **and** no `rcpt:out:*` key was written.
  - `replayEnvelopeReceipts` is non-destructive: two consecutive calls return the same rows.
  - `replayEnvelopeReceipts` for an unknown/never-acked id returns `[]` (no oracle beyond "acked or not", which the submitter already knows).
  - Sealed-sender regression: assert no Redis key created by the new path contains the submitter's userId (extend the existing "no sender hint anywhere on the wire" assertions in this file).
- **New** `apps/messenger-service/src/gateway/messenger.gateway.receipts.spec.ts` (follow `messenger.gateway.privacy.spec.ts` / `messenger.gateway.envelope-wake.spec.ts` wiring):
  - `receipt.subscribe` with 3 valid ids joins 3 `rcpt:` rooms and replays any recorded outcome as `envelope.delivered` / `envelope.undeliverable` on the socket.
  - non-UUID / non-string ids are dropped; an all-garbage payload joins nothing.
  - `>MAX_RECEIPT_IDS_PER_CALL` is truncated; `>MAX_RECEIPT_ROOMS_PER_SOCKET` stops joining without throwing.
  - missing `client.data` (unauthenticated) → returns without joining.

**Mobile (`npx jest --selectProjects=messenger-crypto`)**

- **New** `src/modules/messenger/__tests__/receiptSubscription.test.ts`:
  - `pendingReceiptEnvelopeIds` returns only own outbound rows at `sent` with an `envelope_id`; excludes `delivered`, `read`, `undelivered`, `sending`, `failed`, and inbound rows.
  - honours the `limit` and prefers newest-first.
  - `noteOutboundEnvelope` is idempotent for a repeated id and evicts FIFO past `MAX_RECEIPT_SUBSCRIPTIONS`.
- `src/modules/messenger/__tests__/envelopeDelivered.test.ts` + `decryptFailureSignal.test.ts` (existing) — run unchanged as the regression lock that the receipt handlers still behave (this fix adds no new handling code, which is the point).
- Optional integration lock in `src/modules/messenger/__tests__/` (there is already a transport-frame test pattern in `callFrameRouter.test.ts`): assert `TransportClient.subscribeReceipts([])` emits nothing and `subscribeReceipts(['a'])` emits `{event: 'receipt.subscribe', data: {envelopeIds: ['a']}}`.

**Gates (CLAUDE.md §Change safety)**
`npm run test:crypto` → `npm test` → `npm run typecheck` (≤ 47) → `cd apps/messenger-service && npm test`. Device smoke: send a **group** message from A, confirm B receives; A's bubble must reach ✓✓ (previously stuck at ✓). Then wipe B's app data, resend, and confirm A's bubble goes red/`undelivered` and B-46 fires one auto-resend.

---

## Risk

Things a reviewer should be suspicious of:

1. **Is the anonymous handle actually anonymous?** Grep the diff for `claims.sub`, `userId`, `deviceId` inside anything that reaches `redis.client.set`. The only new key must be `rcpt:out:{envelopeId} = 'delivered'|'undeliverable'`. If a reviewer finds themselves reaching for `caller.claims.sub` in `envelope.controller.ts`, the design has been quietly reverted to the FORBIDDEN variant.
2. **Envelope-id as capability.** A JWT-authenticated attacker who _guesses_ a UUIDv4 (122 bits) learns one bit: "acked or not". Rate-limited at 2/s. Acceptable, but confirm `envelopeId` is `randomUUID()` (it is — `envelope.service.ts:88`) and not derived from anything guessable.
3. **The `if/else` must stay exclusive.** Any refactor that makes both branches run reintroduces double receipts.
4. **This is not full group-delivery semantics.** ✓✓ on a group bubble after this fix means "the first recipient acked". Do not let a reviewer (or a release note) claim otherwise.
5. **The pre-existing contract violation.** `submitter:{envelopeId}` (Redis, up to 30-day TTL) and `pending_delivered:{userId}` (Redis, 7 days) already persist sender identity against `MESSENGER_BACKEND.md:137`/`:156`. This spec does not touch them and does not make them worse — but the architecture owner should be told, and removing them (routing the WS lane through the same anonymous room) is the obvious follow-up ticket.
6. **Server deploys before clients.** Verified safe in both directions above, but re-check that the ops-console (`apps/ops-console`, which also speaks this protocol via `socket.io-client` + `@bravo/messenger-core`) is unaffected — it never sends `receipt.subscribe` and therefore keeps today's behaviour; it does **not** need to ship in lockstep.
7. **Scope honesty.** This is a medium change (~9 files), not the 3-line diff the audit implies. If the architecture owner signs off on the literal "submitter identity on HTTP submit" variant instead, the whole client-side half (items 6-9) disappears and the fix collapses to `envelope.controller.ts` + one spec. Get that decision _before_ implementing.
