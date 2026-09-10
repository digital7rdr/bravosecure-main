# XO-2 — Offline-composed sends fail-fast with no outbox row when the sender-cert cache is cold

## Verdict

**CONFIRMED** (with minor drift: line numbers moved; the live `SenderCertCache` is the
`packages/messenger-core` copy, not `src/modules/messenger/runtime/certCache.ts`).

1. The cert cache is memory-only — nothing hydrates it from disk, so an offline app launch
   guarantees a miss:
   `packages/messenger-core/src/runtime/certCache.ts:26`
   `  private current: IssuedCert | null = null;`
   (`src/modules/messenger/runtime/index.ts:22` → `export { SenderCertCache } from '@bravo/messenger-core';`,
   and `productionRuntime.ts:52` imports it from there. The identically-named
   `src/modules/messenger/runtime/certCache.ts` is a stale duplicate with no importers —
   it lacks `getIssued()`/`revokeCurrentAndInvalidate()` which `productionRuntime.ts:2481,4653` call.)

2. A miss with no network throws, and the 30 s negative cache makes every subsequent compose
   throw instantly: `packages/messenger-core/src/runtime/certCache.ts:64-67`
   `      if (this.lastFailureErr && Date.now() - this.lastFailureAt < NEGATIVE_CACHE_MS) { throw this.lastFailureErr; }`

3. **1:1** — the cert fetch is the first statement inside the try whose catch flips the bubble
   to `failed` and rethrows, and the durable enqueue is _after_ that try:
   `src/modules/messenger/runtime/productionRuntime.ts:2796-2840`
   `        cert = await certCache.get();` … `      } catch (e) {`
   `        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');`
   `        throw e;`
   `      }`
   The `sqlOutbox.enqueue({... payload: JSON.stringify({outerSealed, expiresAtSec})})` block only
   starts at `:2865`. So: bubble `failed`, **zero** outbox rows, nothing to drain.

4. **Group** — same shape, and worse: the cert fetch rides inside the group-admin-lock prep block,
   whose catch flips to `failed` before `sendOne` (and therefore before any per-peer enqueue) has
   run for _any_ member: `productionRuntime.ts:2467-2491`
   `            const c = await certCache.getIssued();` … `        } catch (e) {`
   `          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');`
   `          throw e;`
   `        }`
   The A4 deferred-row recovery at `:2564-2595` is _inside_ `sendOne`, so it never gets a chance.

5. The recovery machinery the fix needs **already exists** and is proven — `DeferredOutboxPayload`
   (`:7379`), `resealDeferredGroupRow` (`:786`), and the drain's `if (payload.deferred)` branch
   (`:7426`). XO-2 is the gap where that machinery is not reached, not a missing mechanism.

6. The boot sweep confirms the end state is permanent loss-of-queue, not just a cosmetic status:
   `:1635` `            if (m.status === 'sending' && !outboxIds.has(m.id)) { st.updateMessageStatus(cid, m.id, 'failed'); }`
   — a `failed` bubble with no row is only recoverable by a manual retry tap.

## Mechanism

1. User launches the app with no connectivity (airplane mode / dead zone / Doze-frozen radio).
   `SenderCertCache.current` is `null` — it is a plain in-memory field, never persisted.
2. User types a message and hits send. `sendText` canonicalises the conversation id, computes
   `expiresAtSec`/`replyMeta`, and appends the optimistic bubble (`status: 'sending'`) — this part
   is correct (M-15/P1-1).
3. **1:1:** `cert = await certCache.get()` → `getIssued()` → `client.issueCert(...)` → `fetch`
   rejects (`Network request failed`). The catch at `:2837` flips the bubble to `failed` and
   rethrows. `ChatScreen`'s catch (`ChatScreen.tsx:684`) shows a "Send failed" banner.
   **`sqlOutbox.enqueue` at `:2865` is never reached.**
4. **Group:** `certCache.getIssued()` inside `runWithGroupAdminLock` rejects. The catch at `:2488`
   flips to `failed` and rethrows — _before_ `Promise.allSettled(participants.map(sendOne))`, so
   not one of the N per-peer rows (nor the A4 deferred rows) is written.
5. `SenderCertCache` arms its 30 s negative cache, so messages 2..N in the same burst throw in
   microseconds — the user gets a wall of red bubbles, one per line typed.
6. Connectivity returns. `socket.on('connect')` fires `drainOutbox(...)` (`:1134`, `:1601`) and the
   60 s timer (`:1613`) fires it too — but `dueRows()` returns nothing, because nothing was ever
   enqueued. **Nothing auto-sends.** Every message needs a manual retry tap.
7. On next launch the MSG-07 sweep (`:1631-1639`) is a no-op for these rows (they are already
   `failed`), so the state is stable and permanently manual.

Net effect: the durable outbox — the whole "WhatsApp keeps it, we lose it" defence — is bypassed
for exactly the case it was built for. SN-04's "an unreachable network must not consume the retry
budget" (`sqlOutboxStore.ts:235`) is likewise dead code for offline-_composed_ sends; it only ever
protects sends that got as far as having a cert.

## Fix

Reach the _existing_ deferred-row machinery when cert/crypto prep fails, for both lanes. No schema
change: `outbox.payload` is a free-form JSON `TEXT` column (`src/modules/messenger/crypto/db.ts:210`),
so the new shape rides the current `SCHEMA_VERSION = 14` (`db.ts:54`) with no migration.
No wire-format change: the drain re-seals into the **identical** `outerSealed` bytes the live path
produces, so `apps/messenger-service` and older peers see nothing new.

### File 1 (NEW) — `src/modules/messenger/runtime/deferredOutbox.ts`

Pure module, type-only imports (erased at compile) so it loads in the `messenger-crypto` Jest
project — `productionRuntime.ts` cannot be imported there (transitively pulls
`@op-engineering/op-sqlite`; see the note in
`src/modules/messenger/__tests__/directConvoAadId.test.ts:18-25`). Same rationale as the existing
`outboxCertFreshness.ts`.

```ts
/**
 * XO-2 — deferred outbox payloads.
 *
 * A send whose crypto prep could not run (no sender cert on an offline launch,
 * no session) is persisted as an INTENT; the drain re-seals it with a fresh
 * cert + session when connectivity returns. A4 already did this per-peer inside
 * the group fan-out; this module generalises the shape and moves the drain's
 * routing decision somewhere testable.
 *
 * Kept free of native/runtime imports (type-only imports are erased) so it can
 * be unit-tested without standing up productionRuntime — same rationale as
 * `outboxCertFreshness.ts`.
 */

import type {SealedAttachment} from '../crypto';
import {isStoredCertStale} from './outboxCertFreshness';

/** A4 — group per-peer deferred row. `sealedBody` is already master-key-wrapped. */
export interface DeferredGroupOutboxPayload {
  deferred: true;
  sealedBody: string;
  expiresAtSec?: number;
  attachment?: SealedAttachment;
  groupId: string;
  kind: 'text' | 'admin';
  clientMsgId: string;
}

/**
 * XO-2 — 1:1 deferred row. There is no group master key to wrap under, so the
 * row carries the send intent. It sits in the SQLCipher outbox beside the same
 * text already persisted in the SQLCipher `messages` row, so this adds no new
 * at-rest exposure class. Never log `body`.
 */
export interface DeferredDirectOutboxPayload {
  deferred: true;
  direct: true;
  body: string;
  expiresAtSec?: number;
  attachment?: SealedAttachment;
  replyTo?: {msgId: string; preview: string};
  clientMsgId: string;
}

export type DeferredOutboxPayload = DeferredGroupOutboxPayload | DeferredDirectOutboxPayload;

/** Everything a stored outbox payload may carry, in any generation of the shape. */
type ParsedOutboxPayload = Partial<DeferredGroupOutboxPayload> &
  Partial<DeferredDirectOutboxPayload> & {
    outerSealed?: string;
    certExpSec?: number;
  };

export function isDeferredDirect(p: DeferredOutboxPayload): p is DeferredDirectOutboxPayload {
  return (p as DeferredDirectOutboxPayload).direct === true;
}

/**
 * A deferred row that carries neither a group body nor a direct body can never
 * be re-sealed. Only reachable after an app DOWNGRADE past a newer payload
 * shape; the drain drops it (and surfaces a retry chip) instead of looping.
 */
export function isUnresealableDeferred(p: ParsedOutboxPayload): boolean {
  if (p.deferred !== true) {
    return false;
  }
  if (p.direct === true) {
    return typeof p.body !== 'string';
  }
  return typeof p.sealedBody !== 'string' || typeof p.groupId !== 'string';
}

export type OutboxDrainAction =
  | {mode: 'ship'; outerSealed: string; expiresAtSec?: number}
  | {mode: 'reseal'; payload: DeferredOutboxPayload; staleCert: boolean}
  | {mode: 'drop'; reason: 'corrupt' | 'unresealable' | 'no_payload'}
  | {mode: 'fail'; reason: 'cert_expired_unresealable'};

/**
 * Decide what the drain should do with one stored payload. Preserves the
 * pre-existing semantics exactly:
 *   - unparseable JSON  → drop (was: catch around JSON.parse)
 *   - `deferred: true`  → re-seal (A4)
 *   - stored bytes with a stale cert → re-seal when re-mintable, else fail
 *     loudly rather than ship a dead envelope (SN-06)
 *   - neither sealed nor deferred → drop
 * Rows written before SN-06 carry no `certExpSec` and stay on the ship path
 * (`isStoredCertStale(undefined) === false`) — no upgrade hazard.
 */
export function planOutboxDrain(raw: string, nowMs: number = Date.now()): OutboxDrainAction {
  let parsed: ParsedOutboxPayload;
  try {
    parsed = JSON.parse(raw) as ParsedOutboxPayload;
  } catch {
    return {mode: 'drop', reason: 'corrupt'};
  }
  if (!parsed || typeof parsed !== 'object') {
    return {mode: 'drop', reason: 'corrupt'};
  }
  if (parsed.deferred === true) {
    if (isUnresealableDeferred(parsed)) {
      return {mode: 'drop', reason: 'unresealable'};
    }
    return {mode: 'reseal', payload: parsed as DeferredOutboxPayload, staleCert: false};
  }
  if (typeof parsed.outerSealed === 'string') {
    if (isStoredCertStale(parsed.certExpSec, nowMs)) {
      if (typeof parsed.sealedBody !== 'string' || typeof parsed.groupId !== 'string') {
        return {mode: 'fail', reason: 'cert_expired_unresealable'};
      }
      return {
        mode: 'reseal',
        payload: parsed as unknown as DeferredGroupOutboxPayload,
        staleCert: true,
      };
    }
    return {mode: 'ship', outerSealed: parsed.outerSealed, expiresAtSec: parsed.expiresAtSec};
  }
  return {mode: 'drop', reason: 'no_payload'};
}
```

### File 2 — `src/modules/messenger/runtime/productionRuntime.ts`

#### 2a. Imports

Anchor (existing import of the freshness helper — locate by content near the other
`./outboxCertFreshness` import):

```ts
import {isStoredCertStale} from './outboxCertFreshness';
```

Insert after it:

```ts
import {
  isDeferredDirect,
  planOutboxDrain,
  type DeferredDirectOutboxPayload,
  type DeferredGroupOutboxPayload,
  type DeferredOutboxPayload,
} from './deferredOutbox';
```

> If `isStoredCertStale` is imported as part of a multi-name import, add the new import as a
> separate statement adjacent to it. After this change `isStoredCertStale` is only used inside
> `deferredOutbox.ts` — drop it from `productionRuntime.ts`'s imports so lint stays clean.

#### 2b. Delete the inline deferred-payload type; re-point the reseal signature

Anchor (verbatim, `productionRuntime.ts:7370-7391`):

```ts
/**
 * A4 — a DEFERRED outbox row. Written by the group fan-out when a peer's
 * session/seal/encrypt failed at send time, so there is NO ready outerSealed.
 * The drain re-establishes the session and re-seals with a FRESH AAD timestamp
 * via the injected `reseal` callback, then ships. Distinguished from a normal
 * sealed row by `deferred: true`. The stored `sealedBody` is the group
 * master-key-wrapped inner envelope (reused as-is); only the per-peer
 * sealed-sender outer wrap is re-minted.
 */
interface DeferredOutboxPayload {
  deferred: true;
  sealedBody: string;
  expiresAtSec?: number;
  attachment?: SealedAttachment;
  groupId: string;
  kind: 'text' | 'admin';
  clientMsgId: string;
}
type ResealDeferredFn = (
  row: {peerUserId: string; peerDeviceId: number; clientMsgId: string},
  payload: DeferredOutboxPayload,
) => Promise<{outerSealed: string; expiresAtSec?: number}>;
```

Replacement:

```ts
type ResealDeferredFn = (
  row: {peerUserId: string; peerDeviceId: number; clientMsgId: string},
  payload: DeferredOutboxPayload,
) => Promise<{outerSealed: string; expiresAtSec?: number}>;
```

(The shape docs move with the interfaces into `deferredOutbox.ts`. Check whether
`SealedAttachment` still has another consumer in `productionRuntime.ts`; if not, drop it from the
type imports.)

#### 2c. Teach the reseal callback the 1:1 shape (and register media grants)

Anchor (verbatim, `productionRuntime.ts:786-812`):

```ts
const resealDeferredGroupRow: ResealDeferredFn = async (row, payload) => {
  const peer: SessionAddress = {userId: row.peerUserId, deviceId: row.peerDeviceId};
  await ensureOutgoingSession(own, keys, peer, ownStore);
  const freshCert = await certCache.get();
  const sealed = sealPayload(freshCert, payload.sealedBody, {
    expiresAtSec: payload.expiresAtSec,
    clientMsgId: payload.clientMsgId,
    attachment: payload.attachment,
    group: {groupId: payload.groupId, kind: payload.kind, clientMsgId: payload.clientMsgId},
    aad: {
      to: peer,
      ts: Date.now(),
      sender: ownAddress,
      conversationId: payload.groupId,
      groupId: payload.groupId,
    },
  });
  const ct = await own.encrypt(peer, sealed);
  const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
    ownStore,
    keys,
    peer,
    peerIdentityCache,
    PEER_IDENTITY_TTL_MS,
  );
  const outerSealed = await wrapOuter({
    recipientIdentityKeyB64: recipientIdKeyB64,
    sender: ownAddress,
    ciphertext: ct,
    cert: freshCert,
  });
  return {outerSealed, expiresAtSec: payload.expiresAtSec};
};
```

Replacement (rename `resealDeferredGroupRow` → `resealDeferredRow`; the name is now a lie
otherwise — update the three call sites at `:1134`, `:1601`, `:1613`):

```ts
const resealDeferredRow: ResealDeferredFn = async (row, payload) => {
  const peer: SessionAddress = {userId: row.peerUserId, deviceId: row.peerDeviceId};
  await ensureOutgoingSession(own, keys, peer, ownStore);
  const freshCert = await certCache.get();
  const sealed = isDeferredDirect(payload)
    ? sealPayload(freshCert, payload.body, {
        expiresAtSec: payload.expiresAtSec,
        clientMsgId: payload.clientMsgId,
        attachment: payload.attachment,
        replyTo: payload.replyTo,
        aad: {
          to: peer,
          ts: Date.now(),
          sender: ownAddress,
          conversationId: directConvoAadId(ownAddress.userId, peer.userId),
        },
      })
    : sealPayload(freshCert, payload.sealedBody, {
        expiresAtSec: payload.expiresAtSec,
        clientMsgId: payload.clientMsgId,
        attachment: payload.attachment,
        group: {groupId: payload.groupId, kind: payload.kind, clientMsgId: payload.clientMsgId},
        aad: {
          to: peer,
          ts: Date.now(),
          sender: ownAddress,
          conversationId: payload.groupId,
          groupId: payload.groupId,
        },
      });
  const ct = await own.encrypt(peer, sealed);
  const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
    ownStore,
    keys,
    peer,
    peerIdentityCache,
    PEER_IDENTITY_TTL_MS,
  );
  const outerSealed = await wrapOuter({
    recipientIdentityKeyB64: recipientIdKeyB64,
    sender: ownAddress,
    ciphertext: ct,
    cert: freshCert,
  });
  // Why: a deferred row was queued OFFLINE, so the live path's pre-fanout
  // registerGrants never ran (or ran and failed). Without this the recipient
  // 403s on the attachment under strict grant mode.
  if (payload.attachment?.objectKey) {
    try {
      await mediaClient.registerGrants(payload.attachment.objectKey, [peer.userId]);
    } catch (e) {
      console.warn('[messenger.media] registerGrants (deferred drain) failed:', asErrorMessage(e));
    }
  }
  return {outerSealed, expiresAtSec: payload.expiresAtSec};
};
```

`mediaClient` is in scope (declared at `:493`, factory level).

#### 2d. 1:1 — defer instead of fail-fast

Anchor (verbatim, `productionRuntime.ts:2831-2840` — the tail of the crypto-prep block; the
`catch` body alone is NOT unique, the `wrapOuter` call above it makes it so):

```ts
        outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
      } catch (e) {
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
        throw e;
      }
```

Replacement:

```ts
        outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
      } catch (e) {
        // XO-2 — crypto prep failed (cold/negative-cached sender cert on an
        // offline launch, or X3DH/seal). Persist the send INTENT so the drain
        // re-mints a fresh cert + session and ships when connectivity returns,
        // mirroring the A4 group deferred row. Only fall back to `failed` when
        // there is no durable queue to hand it to.
        let deferredQueued = false;
        if (sqlOutbox) {
          const deferredPayload: DeferredDirectOutboxPayload = {
            deferred:   true,
            direct:     true,
            body:       text,
            expiresAtSec,
            attachment: opts.attachment,
            replyTo:    replyMeta,
            clientMsgId,
          };
          try {
            await sqlOutbox.enqueue({
              clientMsgId,
              conversationId,
              messageId:    msgId,
              peerUserId:   target.userId,
              peerDeviceId: target.deviceId,
              payload:      JSON.stringify(deferredPayload),
            });
            deferredQueued = true;
          } catch (enqErr) {
            console.warn('[messenger.outbox] direct deferred enqueue failed:', asErrorMessage(enqErr));
          }
        }
        if (deferredQueued) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
          return;
        }
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
        throw e;
      }
```

Returning (not throwing) is deliberate: `ChatScreen.tsx:684` would otherwise paint a "Send failed"
banner over a message that is queued and healthy, and `sendMedia`'s catch (`:3151-3159`) would
flip the bubble back to `failed`. A `sending` bubble with a durable row is the correct WhatsApp
clock-icon state.

#### 2e. Group — take the cert fetch out of the admin lock, defer on failure

Anchor (verbatim, `productionRuntime.ts:2467-2491`):

```ts
try {
  const prep = await runWithGroupAdminLock(conversationId, async () => {
    // Re-read the master key INSIDE the lock so a rekey that just
    // committed is reflected (fresh key, not the pre-lock snapshot).
    const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
    const innerEnvelope = JSON.stringify({
      groupId: conversationId,
      kind: 'text',
      clientMsgId,
      body: text,
    });
    const sb = masterKey
      ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope))
      : innerEnvelope;
    const c = await certCache.getIssued();
    return {cert: c.cert, certExpSec: c.expiresAt, sealedBody: sb, sealedTs: Date.now()};
  });
  cert = prep.cert;
  sealedBody = prep.sealedBody;
  sealedTs = prep.sealedTs;
  certExpSec = prep.certExpSec;
} catch (e) {
  useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
  throw e;
}
```

Replacement:

```ts
try {
  const prep = await runWithGroupAdminLock(conversationId, async () => {
    // Re-read the master key INSIDE the lock so a rekey that just
    // committed is reflected (fresh key, not the pre-lock snapshot).
    const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
    const innerEnvelope = JSON.stringify({
      groupId: conversationId,
      kind: 'text',
      clientMsgId,
      body: text,
    });
    const sb = masterKey
      ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope))
      : innerEnvelope;
    return {sealedBody: sb, sealedTs: Date.now()};
  });
  sealedBody = prep.sealedBody;
  sealedTs = prep.sealedTs;
} catch (e) {
  useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
  throw e;
}
// XO-2 — the cert fetch is now OUTSIDE the admin lock: it is pure
// network, holds no group state, and its failure has a recovery the
// rekey serialisation must not be blocked on.
try {
  const c = await certCache.getIssued();
  cert = c.cert;
  certExpSec = c.expiresAt;
} catch (e) {
  // XO-2 — no sender cert (cold cache on an offline launch, or the 30s
  // negative window). The master-key-wrapped body already exists, so
  // queue one deferred row per member — the same shape the A4 per-peer
  // path writes — and leave the bubble 'sending'. The drain re-mints a
  // fresh cert + per-peer AAD and ships when connectivity returns.
  if (sqlOutbox) {
    const deferredPayload: DeferredGroupOutboxPayload = {
      deferred: true,
      sealedBody,
      expiresAtSec,
      attachment: opts.attachment,
      groupId: conversationId,
      kind: 'text',
      clientMsgId,
    };
    const rowJson = JSON.stringify(deferredPayload);
    for (const userId of participants) {
      try {
        await sqlOutbox.enqueue({
          clientMsgId,
          conversationId,
          messageId: msgId,
          peerUserId: userId,
          peerDeviceId: 1,
          payload: rowJson,
        });
      } catch (enqErr) {
        console.warn('[messenger.outbox] group deferred enqueue failed:', asErrorMessage(enqErr));
      }
    }
    useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
    return;
  }
  useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
  throw e;
}
```

`peerDeviceId: 1` matches the live fan-out (`sendOne` builds `{userId, deviceId: 1}` at `:2509`).

#### 2f. Drain — route through `planOutboxDrain`

Anchor (verbatim, `productionRuntime.ts:7408-7475`) — the JSON.parse block through the
`else { … dropping row with no payload … continue; }` branch. Replacement:

```ts
      const plan = planOutboxDrain(row.payload);
      if (plan.mode === 'drop') {
        console.warn(`[messenger.outbox] dropping ${plan.reason} row ${row.clientMsgId}`);
        if (plan.reason === 'unresealable') {
          // L17 — never DOWNGRADE a bubble that already reached a peer.
          const cur = useMessengerStore.getState()
            .messages[row.conversationId]?.find(m => m.id === row.messageId);
          if (cur?.status === 'sending') {
            useMessengerStore.getState().updateMessageStatus(
              row.conversationId, row.messageId, 'failed',
            );
          }
        }
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
        continue;
      }
      try {
        // A4/XO-2 — a DEFERRED (or stale-cert, SN-06) row has no shippable
        // bytes yet: re-seal now with a fresh cert + session + AAD timestamp
        // via the injected crypto callback. No callback on this drain (no
        // crypto context) ⇒ leave the row for a drain that has one. A re-seal
        // throw falls to the catch below → recordAttempt → next drain.
        let outerSealed: string;
        let expiresAtSec: number | undefined;
        if (plan.mode === 'fail') {
          // Stale cert and nothing to re-mint from. Shipping would be the
          // silent-loss-behind-a-tick SN-06 exists to kill: fail loudly.
          throw new Error(`outbox_${plan.reason}`);
        } else if (plan.mode === 'reseal') {
          if (!reseal) { continue; }
          if (plan.staleCert) {
            // warn, not log: release builds strip console.log.
            console.warn(`[messenger.outbox] re-sealing stale-cert row ${row.clientMsgId}`);
          }
          const sealedNow = await reseal(
            {peerUserId: row.peerUserId, peerDeviceId: row.peerDeviceId, clientMsgId: row.clientMsgId},
            plan.payload,
          );
          outerSealed  = sealedNow.outerSealed;
          expiresAtSec = sealedNow.expiresAtSec;
        } else {
          outerSealed  = plan.outerSealed;
          expiresAtSec = plan.expiresAtSec;
        }
        const r = await relay.send({
```

…and the remainder of the try/catch (from `const r = await relay.send({` onward) is unchanged.

**Back-compat / wire format.** Nothing crosses the wire that did not before: the drain emits the
same `outerSealed` string the live send path emits, over the same `POST /envelopes`. No server
change, no new envelope kind, no AAD change (the deferred re-seal stamps `aad.ts = Date.now()`,
exactly as A4 already does — see OM-05 below). Old **rows** written by the current build parse
identically (`deferred:true` + `groupId` → group branch; `outerSealed` → ship branch;
`certExpSec` absent → ship, per `isStoredCertStale(undefined) === false`). Old **builds** reading a
new `direct: true` row is only reachable via an app downgrade: that build's reseal would call
`sealPayload(cert, undefined, …)` and throw, burning attempts until the row flips to `failed` with
a retry chip — degraded but not silent, and the bubble text survives in the `messages` table.

## Blast radius

**Files edited**

- `src/modules/messenger/runtime/deferredOutbox.ts` (new, pure)
- `src/modules/messenger/runtime/productionRuntime.ts` — `sendText` 1:1 prep-catch,
  `sendText` group prep block, `resealDeferredGroupRow`→`resealDeferredRow` (+3 call sites at
  `:1134`, `:1601`, `:1613`), `drainOutbox`, the `DeferredOutboxPayload`/`ResealDeferredFn` decls,
  imports.
- No change to `sqlOutboxStore.ts`, `certCache.ts`, `crypto/db.ts`, `relayClient.ts`, or anything
  under `apps/messenger-service`.

**Schema**: none. `outbox.payload` is `TEXT NOT NULL` holding free-form JSON
(`crypto/db.ts:204-216`); `SCHEMA_VERSION` stays 14.

**Behaviour changes a reader should expect**

- 1:1 sends no longer throw out of `sendText` when crypto prep fails _and_ the outbox is
  available. `ChatScreen.tsx:684` stops banner-ing that case; `sendMedia`'s catch (`:3151`)
  stops flipping media bubbles to `failed` for it. Both are intended.
- A deterministic prep failure (e.g. a peer with genuinely no prekeys, ever) now takes the
  MAX_ATTEMPTS road to `failed` instead of failing immediately. Same terminal state, slower —
  this is exactly the trade A4 already made for the group lane.
- Group: the cert fetch leaves the per-group admin lock. Verify against the P2-4 rationale
  (`:2450-2457`): the lock exists to serialise the _master-key read + groupEncrypt_ against a
  same-device rekey. The cert is device-scoped and carries no group state, so this is safe — and
  it stops a 30 s negative-cache throw from being taken while holding the lock.

**Overlapping findings (edit-conflict risk)**

- **OM-05** ("reuse compose `sentAtMs` as `aad.ts` at re-seal") edits the _same_
  `resealDeferredGroupRow` body — direct textual conflict, and XO-2 adds a second `aad` block
  there. Land XO-2 first, then OM-05 on top of both branches. (Per the batch architecture ruling
  OM-05 is NOT-COVERED/needs approval anyway.)
- **GF-5** ("fail closed when the local group master key is absent") edits the same
  `runWithGroupAdminLock` prep block (`const sb = masterKey ? … : innerEnvelope`). Textual
  conflict. GF-5 also _improves_ XO-2: with GF-5 landed, a deferred group row's `sealedBody` can
  never be plaintext.
- **OM-02** (clamp display/ordering timestamps) touches the store's message rows, not this path,
  but both change what a `sending` bubble looks like after a long offline stretch — verify
  together on device.
- Any finding touching `drainOutbox` (the SN-06 family) conflicts with §2f.

**What could regress**

- SN-06. §2f rewrites the stale-cert branch. `planOutboxDrain` must reproduce it byte-for-byte in
  behaviour: pre-SN-06 rows (no `certExpSec`) ship unchanged, stale+re-mintable re-seals,
  stale+not-re-mintable throws. Pinned by tests below.
- Duplicate delivery. The deferred row reuses the **same** `clientMsgId` as the bubble
  (`clientMsgId = msgId`, `:2384`), so the relay's `(recipient, clientMsgId)` dedup
  (`envelope.service.ts:157-164`) coalesces a deferred drain with any later manual retry under
  the same id. The ChatScreen retry chip mints a _fresh_ id and calls
  `deleteByClientMsgId` (`sqlOutboxStore.ts:177`) first — confirm that still runs so a queued
  deferred row cannot double-send alongside a manual retry.
- MSG-07 boot sweep (`:1631`) now correctly leaves these bubbles in `sending` because a row
  exists. If the enqueue silently fails (full disk), the old `failed` path still applies.
- Group epoch: a deferred group row's `sealedBody` was wrapped under the master key at compose
  time. If a rekey commits before the drain, the rotated members can't decrypt it. This is _not_
  new (A4 and the SN-06 re-mint already reuse `sealedBody`), but XO-2 widens the window from
  "one flaky peer" to "a whole overnight offline stretch". Flag to the architecture owner if the
  batch also lands a rekey change.

## Tests

Jest project: `messenger-crypto` (everything under `src/modules/messenger/__tests__/`).
`productionRuntime.ts` is not importable there (native `@op-engineering/op-sqlite`), which is why
the decision logic lives in `deferredOutbox.ts`.

**NEW `src/modules/messenger/__tests__/deferredOutbox.test.ts`**

- `isDeferredDirect` — true for a `{deferred, direct, body}` payload, false for a
  `{deferred, sealedBody, groupId}` payload.
- `isUnresealableDeferred` — false for both well-formed shapes; true for
  `{deferred: true, direct: true}` with no `body`; true for `{deferred: true}` with no
  `sealedBody`/`groupId`; false for a non-deferred payload.
- `planOutboxDrain` — SN-06 regression set (these must not change):
  - `{outerSealed: 'X'}` (pre-SN-06, no `certExpSec`) → `{mode: 'ship', outerSealed: 'X'}`.
  - `{outerSealed, certExpSec: now+3600, ...}` → `ship`.
  - `{outerSealed, certExpSec: now-3600, sealedBody, groupId}` → `{mode: 'reseal', staleCert: true}`.
  - `{outerSealed, certExpSec: now-3600}` (no `sealedBody`) →
    `{mode: 'fail', reason: 'cert_expired_unresealable'}`.
  - `{outerSealed, certExpSec: now + OUTBOX_CERT_RESEAL_MARGIN_SEC}` → `reseal` (boundary is stale).
- `planOutboxDrain` — XO-2 set:
  - a direct deferred payload → `{mode: 'reseal', staleCert: false}` and
    `isDeferredDirect(plan.payload) === true`.
  - a group deferred payload → `reseal`, `isDeferredDirect === false`.
  - `'{'` → `{mode: 'drop', reason: 'corrupt'}`; `'null'` → `drop/corrupt`.
  - `'{}'` → `{mode: 'drop', reason: 'no_payload'}`.
  - downgrade shape `{deferred: true, direct: true}` → `{mode: 'drop', reason: 'unresealable'}`.
- Log hygiene: assert `JSON.stringify(planOutboxDrain(...))` is only ever consumed as a value —
  i.e. add a test that the module exports no logging (`expect(String(planOutboxDrain)).not.toMatch(/console\./)`)
  so a future edit can't start printing `body`. (The repo-wide gate is
  `packages/messenger-core/__tests__/logAudit.test.ts`; keep `body` out of every `console.*`
  string in `productionRuntime.ts` too.)

**EXTEND `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** (reuses the existing
hand-rolled `makeFakeDb`)

- Round-trip: `enqueue` a direct deferred payload → `dueRows()` returns it → `JSON.parse(row.payload)`
  → `planOutboxDrain(row.payload).mode === 'reseal'` and `isDeferredDirect` true.
- Group fan-out: enqueue the _same_ `clientMsgId` deferred payload for 3 distinct `peerUserId`s →
  3 independent rows (already covered for sealed rows; add the deferred variant so the XO-2 group
  branch's loop is pinned).
- SN-04 interaction: `recordAttempt(..., {unreachable: true})` on a deferred row leaves
  `attempts` at 0 and only pushes `next_retry_at` — proving an offline-composed row survives an
  arbitrarily long dead zone instead of aging into `failed`.

**Regression suites to run** (CLAUDE.md change-safety gates)

- `npm run test:crypto` (the `messenger-crypto` project — direct + regression).
- `npm test` (all projects) before declaring done.
- `npm run typecheck` — must stay at or below the `.tsc-baseline.json` count (47).
- `apps/messenger-service` suite is **not** required: no server file changes.

**Device verification (cannot be done in Jest — state so explicitly if skipped)**

1. Airplane mode → force-stop → launch app offline → send 3× 1:1 text + 1 image + 1 group text.
   Expect: 5 bubbles at `sending` (clock), no red banner, no `failed`.
2. `adb shell` the SQLCipher outbox (or the existing SQL probe) → confirm 3 direct rows + N group
   rows with `deferred:true`.
3. Kill the app while still offline, relaunch offline → bubbles still `sending` (MSG-07 sweep
   must not touch them).
4. Re-enable network → within one `connect` drain all bubbles flip to `sent`; the recipient device
   renders all of them (verifies the re-minted cert passes `verifySenderCert` and the AAD matches).
5. The image from step 1 downloads on the recipient (verifies the deferred `registerGrants`).

## Risk

- **The `planOutboxDrain` extraction is the risky part, not the deferral.** It rewrites the SN-06
  stale-cert branch. A reviewer should diff the branch table against `:7418-7475` line by line and
  confirm the five pinned cases above. If the reviewer wants a smaller diff, the fallback is to
  leave `drainOutbox`'s branches inline and only add the `isUnresealableDeferred` guard — cost is
  that XO-2's routing then has **no** unit-test coverage at all (productionRuntime is unimportable
  in Jest), which is a CLAUDE.md gate failure.
- **Plaintext at rest.** `DeferredDirectOutboxPayload.body` puts the message text in the outbox
  table. That table is inside the SQLCipher DB and the identical text is already persisted in
  `messages` in the same DB, so it is not a new exposure _class_ — but it is a new _location_, and
  `attachment.keyB64` (a per-file AES key) also lands there. The group A4 path already does both.
  Reviewer must confirm: (a) no `console.*` in the new code interpolates `body` or `attachment`;
  (b) `deleteByConversation` / `deleteByClientMsgId` (Clear chat, delete message) still wipe these
  rows — they key on `conversation_id` / `client_msg_id`, so they do, but verify.
- **Silent "success" on an expired TTL.** A disappearing message composed offline whose
  `expiresAtSec` has already passed by drain time is accepted by the relay as a no-op
  (`envelope.service.ts:127-147`, deliberate anti-enumeration behaviour) — the drain then flips the
  bubble to `sent` and deletes the row even though nothing was delivered. Pre-existing for all
  outbox rows; XO-2 makes it far more reachable. Worth its own finding, not worth widening this fix.
- **Group epoch drift** over a long deferral window (see Blast radius). If the reviewer is
  uncomfortable, the smallest mitigation is a compose-time epoch stamp on the deferred payload and
  a drop-with-`failed` at drain if the group has rekeyed — but that is a behaviour change to group
  key handling and hits the CLAUDE.md stop condition ("epoch handling"), so it should be a separate
  approved change, not smuggled into XO-2.
- **Not covered here (adjacent, deliberately out of scope):** healthy 1:1 rows still enqueue
  `{outerSealed, expiresAtSec}` with **no** `certExpSec` and no re-seal inputs (`:2865-2878`), so
  SN-06's stale-cert protection is group-only. A 1:1 row queued through a >1 h offline stretch is
  still shipped with a dead cert and destroyed on arrival behind a `sent` tick (B-46
  undeliverable-resend is the only net). That is the SN-06 family, not XO-2 — file it separately.
  It becomes a ~10-line change once XO-2 lands (store `certExpSec` + the direct re-seal fields on
  the healthy path too), at the cost of putting the plaintext body in the outbox for _every_ 1:1
  send rather than only failed ones.
