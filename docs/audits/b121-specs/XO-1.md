# XO-1 — 1:1 and reaction outbox rows ship a dead sender cert, message destroyed silently behind a 'sent' tick

## Verdict

**CONFIRMED** (send-side mechanism reproduced verbatim in the current tree). The _second_ half of
the audit's proposed fix (HTTP submitter mapping) is **arch-FORBIDDEN as written** and is excluded
from this spec — see §Fix / "Deliberately out of scope".

Evidence from the current tree:

1. `src/modules/messenger/runtime/productionRuntime.ts:2867-2874` — the 1:1 enqueue persists
   nothing but the sealed bytes: `payload: JSON.stringify({outerSealed, expiresAtSec}),`
2. `src/modules/messenger/runtime/productionRuntime.ts:3332-3339` — the reaction enqueue is worse:
   `payload: JSON.stringify({outerSealed}),`
3. Contrast the group site `productionRuntime.ts:2619-2626`, which SN-06 already fixed:
   `payload: JSON.stringify({ outerSealed, expiresAtSec, certExpSec, sealedBody, attachment: opts.attachment, groupId: conversationId, kind: 'text', clientMsgId, })`
4. `src/modules/messenger/runtime/outboxCertFreshness.ts:37` — `if (certExpSec === undefined) {return false;}`
   ⇒ every 1:1/reaction row is classified **fresh forever**, so the drain takes the
   `outerSealed = payload.outerSealed;` branch at `productionRuntime.ts:7467` and ships the dead cert.
5. Receiver destroys it pre-decrypt: `packages/messenger-core/src/crypto/senderCert.ts:117`
   `if (claims.exp + tolerance < now) {throw new CryptoError('sender cert expired');}` (tolerance
   default 120s, `:114`), and the throw path in `productionRuntime.ts:5546` does
   `await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded');`
6. The sender is never told, because the drain ships over HTTP and
   `apps/messenger-service/src/relay/envelope.controller.ts:78-83` deliberately omits the submitter
   (`// Sealed Sender: we intentionally do NOT pass caller identity into the service`), so
   `envelope.service.ts:376` `const submitter = await this.store.takeSubmitter(envelopeId);`
   returns `null` and the `envelope.undeliverable` emit at `:381` never fires.

Net: cert TTL ≈ 1h (`SenderCertCache` refreshes at `REFRESH_MARGIN_SEC = 10 * 60`,
`packages/messenger-core/src/runtime/certCache.ts:14`). Any 1:1 message or reaction that sits in
the outbox longer than that is destroyed on arrival while the sender's bubble reads 'sent'.

Also confirmed: **only 4 `sqlOutbox.enqueue` call sites exist** (`:2571` group-deferred, `:2602`
group-sealed, `:2867` 1:1, `:3332` reaction). Group admin/rekey envelopes never enqueue at all —
that is GF-2, not XO-1.

## Mechanism

1. User sends a 1:1 message (or taps a reaction). `sendText` seals with a cert fetched at
   `productionRuntime.ts:2800` (`cert = await certCache.get();`) and enqueues an outbox row whose
   payload is `{outerSealed, expiresAtSec}` — **no `certExpSec`, no re-mint inputs**.
2. The WS `envelope.send` at `:2936` is fire-and-forget; the row is only deleted by
   `handleAccepted` or by `httpFallback`'s `markDelivered`. Device goes offline (flight, tunnel,
   overnight dead zone) before either lands, so the row survives.
3. SN-04 (`sqlOutboxStore.ts:235-244`) correctly refuses to burn the retry budget while
   unreachable, so the row is still `status='pending'` hours later — by design.
4. Connectivity returns. `drainOutbox` (`productionRuntime.ts:7394`) parses the payload, evaluates
   `isStoredCertStale(payload.certExpSec)` at `:7446` with `certExpSec === undefined` → `false` →
   takes the else branch `:7466-7469` and ships `payload.outerSealed` verbatim over
   `relay.send` (HTTP).
5. Relay accepts (200 + envelopeId + retractToken); the drain flips the bubble to `'sent'` at
   `:7485-7487` and deletes the row at `:7500`. **The sender's local state is now final and wrong.**
6. Recipient pulls/receives. `verifySenderCert` (`productionRuntime.ts:5479` for WS deliver,
   `:7653` for the pull drain) throws `sender cert expired`. Both paths ack
   `disposition: 'discarded'` (`:5546`, `:7706`) — the envelope is hard-deleted from the relay and
   the plaintext never reaches libsignal, so no decrypt-failure placeholder, no `pendingGroupEnvelope`
   stash, nothing.
7. Server: `EnvelopeService.ack` sees `disposition === 'discarded'` and tries
   `this.hub.emitToDevice(submitter, 'envelope.undeliverable', …)` — but `takeSubmitter` returns
   `null` because the HTTP controller never called `storeSubmitter`. **Silence.**
8. Result: message gone on both sides, sender shows a delivered single-tick. Reactions are the
   same but with zero UI trace at all.

## Fix

**Strategy:** kill the loss _at the source_ by mirroring SN-06 onto the two uncovered enqueue sites
— persist `certExpSec` plus the re-mint inputs, and generalise the existing group re-seal callback
to handle 1:1 and reaction rows. Receiver-side `verifySenderCert` is untouched (CLAUDE.md stop
condition). No wire-format change, no server change, no schema migration.

**Deliberately out of scope (arch-gated):** the audit's `+ MSG-03` half — passing
`{userId, deviceId}` as an HTTP submitter — is **FORBIDDEN** by the batch architecture ruling
(`MESSENGER_BACKEND.md:137` "rate-limit only — we do NOT persist submitter identity";
`SIGNAL_PROTOCOL_IMPLEMENTATION.md:514` "deliberately drops submitter identity before storage").
It belongs to OM-03 and needs an amendment for the compliant shape (an opaque delivery-receipt
capability handle, mirroring `retractToken`). Once XO-1 lands, that half is a _safety net for a
residual_, not the primary fix — see §Blast radius.

---

### File 1 — `src/modules/messenger/runtime/outboxCertFreshness.ts` (extend)

Add the payload-shape type + a pure decision function so the drain's branching is unit-testable
(the module's own header states this is exactly why it exists — `productionRuntime.ts` cannot be
imported under Jest, cf. `src/modules/messenger/__tests__/bootGroupStashDrain.test.ts:12`).

**Anchor** (end of file, after `isStoredCertStale`):

```ts
export function isStoredCertStale(
  certExpSec: number | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (certExpSec === undefined) {
    return false;
  }
  const nowSec = Math.floor(nowMs / 1000);
  return certExpSec - nowSec <= OUTBOX_CERT_RESEAL_MARGIN_SEC;
}
```

**Append:**

```ts
/**
 * The subset of a stored outbox payload the staleness decision reads.
 *
 * XO-1 — SN-06 only taught the GROUP enqueue to persist `certExpSec` + re-mint
 * inputs, so 1:1 and reaction rows were classified fresh forever and shipped a
 * dead cert. Both now persist `resealKind` plus whatever that kind needs to be
 * re-sealed.
 */
export interface StoredOutboxCertInputs {
  certExpSec?: number;
  /** Group rows (SN-06 sealed + A4 deferred): master-key-wrapped inner body. */
  sealedBody?: string;
  groupId?: string;
  /** XO-1 — 1:1 text/media rows. `body` may legitimately be ''. */
  resealKind?: 'direct' | 'reaction';
  body?: string;
  /** XO-1 — reaction rows carry only the directive. */
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
}

export type SealedOutboxAction = 'ship' | 'reseal' | 'unresealable';

/**
 * What the drain should do with a row that already holds sealed bytes.
 *
 * `unresealable` means the cert is dead AND the row predates the metadata that
 * would let us re-mint. Shipping it is the silent-loss-behind-a-tick this whole
 * mechanism exists to kill, so the caller fails loudly instead.
 */
export function resolveSealedOutboxAction(
  payload: StoredOutboxCertInputs,
  nowMs: number = Date.now(),
): SealedOutboxAction {
  if (!isStoredCertStale(payload.certExpSec, nowMs)) {
    return 'ship';
  }
  const canReseal =
    (payload.resealKind === 'direct' && typeof payload.body === 'string') ||
    (payload.resealKind === 'reaction' && payload.reaction !== undefined) ||
    (payload.sealedBody !== undefined && payload.groupId !== undefined);
  return canReseal ? 'reseal' : 'unresealable';
}
```

---

### File 2 — `src/modules/messenger/runtime/productionRuntime.ts`

#### 2a. Import the new helper

**Anchor:**

```ts
import {isStoredCertStale} from './outboxCertFreshness';
```

**Replace with:**

```ts
import {isStoredCertStale, resolveSealedOutboxAction} from './outboxCertFreshness';
```

(`isStoredCertStale` stays imported — it is still the primitive `resolveSealedOutboxAction` builds
on, and removing it would be a drive-by; if lint flags it as unused after this change, drop it.)

#### 2b. Widen the re-seal payload type + rename the callback

**Anchor** (`:7379-7391`):

```ts
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

**Replace with:**

```ts
interface OutboxResealPayload {
  deferred?: true;
  /** XO-1 — absent ⇒ group row (SN-06 / A4), the only shape before this fix. */
  resealKind?: 'direct' | 'reaction';
  expiresAtSec?: number;
  attachment?: SealedAttachment;
  clientMsgId: string;
  /** group rows */
  sealedBody?: string;
  groupId?: string;
  kind?: 'text' | 'admin';
  /** 1:1 rows */
  body?: string;
  replyTo?: {msgId: string; preview: string};
  /** reaction rows */
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
  group?: {groupId: string; kind: 'text'; clientMsgId: string};
}
type ResealOutboxFn = (
  row: {peerUserId: string; peerDeviceId: number; clientMsgId: string},
  payload: OutboxResealPayload,
) => Promise<{outerSealed: string; expiresAtSec?: number}>;
```

Flat single interface rather than a discriminated union: the drain reads one loose JSON blob and
the callback branches once, so a union would force casts at every touchpoint for zero safety gain.

#### 2c. Generalise the re-seal callback

**Anchor** (`:786-812`, the whole `resealDeferredGroupRow` const):

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

**Replace with:**

```ts
const resealOutboxRow: ResealOutboxFn = async (row, payload) => {
  const peer: SessionAddress = {userId: row.peerUserId, deviceId: row.peerDeviceId};
  await ensureOutgoingSession(own, keys, peer, ownStore);
  const freshCert = await certCache.get();
  let sealed: string;
  if (payload.resealKind === 'direct') {
    sealed = sealPayload(freshCert, payload.body ?? '', {
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
    });
  } else if (payload.resealKind === 'reaction') {
    if (!payload.reaction) {
      throw new Error('outbox_reseal_missing_reaction');
    }
    sealed = sealPayload(freshCert, '', {
      reaction: payload.reaction,
      ...(payload.group ? {group: payload.group} : {}),
      aad: {to: peer, ts: Date.now()},
    });
  } else {
    if (payload.sealedBody === undefined || payload.groupId === undefined) {
      throw new Error('outbox_reseal_missing_group_body');
    }
    sealed = sealPayload(freshCert, payload.sealedBody, {
      expiresAtSec: payload.expiresAtSec,
      clientMsgId: payload.clientMsgId,
      attachment: payload.attachment,
      group: {
        groupId: payload.groupId,
        kind: payload.kind ?? 'text',
        clientMsgId: payload.clientMsgId,
      },
      aad: {
        to: peer,
        ts: Date.now(),
        sender: ownAddress,
        conversationId: payload.groupId,
        groupId: payload.groupId,
      },
    });
  }
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

Note the AAD shapes are copied **verbatim** from each original send site — direct keeps
`directConvoAadId(self, peer)` (`:2826`), reaction keeps the bare `{to, ts}` the current reaction
send uses (`:3313`). Do not "improve" the reaction AAD here; that is a separate change and would
break the receiver's expectations for a reaction envelope.

Also update the doc block immediately above (lines 778-785) — change "re-seal + ship a DEFERRED
group outbox row" to note it now also re-mints stale-cert 1:1 and reaction rows (XO-1).

#### 2d. Rename the three call sites

`:1134`, `:1601`, `:1613` — `drainOutbox(…, resealDeferredGroupRow)` → `drainOutbox(…, resealOutboxRow)`.
No other behaviour change; all three drains already pass the callback, so 1:1 rows get re-mint
coverage on reconnect, boot, and the 60s live timer alike.

#### 2e. Persist `certExpSec` + re-mint inputs at the 1:1 enqueue

**Anchor A** (`:2794-2800`):

```ts
      let outerSealed: Awaited<ReturnType<typeof wrapOuter>>;
      let cert: Awaited<ReturnType<typeof certCache.get>>;
      try {
        // P1-1 — fetch the sender cert INSIDE the try so an offline reject (or
        // its 30s negative cache) flips the already-appended bubble to `failed`
        // instead of throwing before any bubble/outbox row exists.
        cert = await certCache.get();
```

**Replace with:**

```ts
      let outerSealed: Awaited<ReturnType<typeof wrapOuter>>;
      let cert: Awaited<ReturnType<typeof certCache.get>>;
      // XO-1 — persisted with the row so the drain can tell a still-valid
      // envelope from one whose cert has aged out (SN-06 parity for 1:1).
      let certExpSec: number;
      try {
        // P1-1 — fetch the sender cert INSIDE the try so an offline reject (or
        // its 30s negative cache) flips the already-appended bubble to `failed`
        // instead of throwing before any bubble/outbox row exists.
        const issued = await certCache.getIssued();
        cert       = issued.cert;
        certExpSec = issued.expiresAt;
```

**Anchor B** (`:2865-2878`):

```ts
if (sqlOutbox) {
  try {
    await sqlOutbox.enqueue({
      clientMsgId,
      conversationId,
      messageId: msgId,
      peerUserId: target.userId,
      peerDeviceId: target.deviceId,
      payload: JSON.stringify({outerSealed, expiresAtSec}),
    });
  } catch (e) {
    console.warn('[messenger.outbox] enqueue failed:', asErrorMessage(e));
  }
}
```

**Replace with:**

```ts
if (sqlOutbox) {
  try {
    await sqlOutbox.enqueue({
      clientMsgId,
      conversationId,
      messageId: msgId,
      peerUserId: target.userId,
      peerDeviceId: target.deviceId,
      // XO-1 — carry the re-seal inputs alongside the sealed bytes. A
      // sender cert lives ~1h; a row queued through a longer offline
      // stretch used to be re-shipped verbatim with a dead cert, which
      // the recipient destroys BEFORE libsignal decrypt while the relay
      // still answers 200 — silent loss behind a 'sent' tick. Same shape
      // (and same callback) the group SN-06 path already uses.
      payload: JSON.stringify({
        outerSealed,
        expiresAtSec,
        certExpSec,
        resealKind: 'direct',
        body: text,
        attachment: opts.attachment,
        replyTo: replyMeta,
        clientMsgId,
      }),
    });
  } catch (e) {
    console.warn('[messenger.outbox] enqueue failed:', asErrorMessage(e));
  }
}
```

`text`, `opts.attachment`, `replyMeta` (`:2325`) and `clientMsgId` (`= msgId`, `:2384`) are all in
scope at this point.

#### 2f. Persist `certExpSec` + directive at the reaction enqueue

**Anchor A** (`:3275-3277`):

```ts
    sendReaction: async (peer, conversationId, targetMsgId, emoji, remove = false) => {
      if (!peer.userId) {return;}
      const cert = await certCache.get();
```

**Replace with:**

```ts
    sendReaction: async (peer, conversationId, targetMsgId, emoji, remove = false) => {
      if (!peer.userId) {return;}
      // XO-1 — expiry rides with the row so a reaction queued through a long
      // offline stretch is re-minted rather than destroyed on arrival.
      const issuedCert = await certCache.getIssued();
      const cert       = issuedCert.cert;
```

**Anchor B** (`:3329-3341`):

```ts
if (sqlOutbox) {
  try {
    await sqlOutbox.enqueue({
      clientMsgId,
      conversationId,
      messageId: clientMsgId,
      peerUserId: to.userId,
      peerDeviceId: to.deviceId,
      payload: JSON.stringify({outerSealed}),
    });
  } catch {
    /* enqueue best-effort */
  }
}
```

**Replace with:**

```ts
if (sqlOutbox) {
  try {
    await sqlOutbox.enqueue({
      clientMsgId,
      conversationId,
      messageId: clientMsgId,
      peerUserId: to.userId,
      peerDeviceId: to.deviceId,
      payload: JSON.stringify({
        outerSealed,
        certExpSec: issuedCert.expiresAt,
        resealKind: 'reaction',
        reaction: {targetMsgId, emoji, remove},
        ...(reactionIsGroup
          ? {group: {groupId: conversationId, kind: 'text' as const, clientMsgId}}
          : {}),
        clientMsgId,
      }),
    });
  } catch {
    /* enqueue best-effort */
  }
}
```

#### 2g. Route the drain's stale branch through the pure decision

**Anchor** (`:7434-7469`, the `else if (payload.outerSealed)` block — keep the existing SN-06
comment, replace the branching body):

```ts
if (isStoredCertStale(payload.certExpSec)) {
  // No crypto context on this drain — leave the row for one that has
  // it, exactly as the deferred branch above does.
  if (!reseal) {
    continue;
  }
  if (payload.sealedBody === undefined || payload.groupId === undefined) {
    // Stale cert and nothing to re-mint from. Shipping would be the
    // silent-loss-behind-a-tick this fix exists to kill: fail loudly.
    throw new Error('outbox_cert_expired_unresealable');
  }
  // warn, not log: release builds strip console.log
  // (transform-remove-console excludes only error/warn), and a
  // re-mint is a rare, operationally significant event we need to be
  // able to confirm from a release logcat.
  console.warn(`[messenger.outbox] re-sealing stale-cert row ${row.clientMsgId}`);
  const sealedNow = await reseal(
    {peerUserId: row.peerUserId, peerDeviceId: row.peerDeviceId, clientMsgId: row.clientMsgId},
    payload as DeferredOutboxPayload,
  );
  outerSealed = sealedNow.outerSealed;
  expiresAtSec = sealedNow.expiresAtSec;
} else {
  outerSealed = payload.outerSealed;
  expiresAtSec = payload.expiresAtSec;
}
```

**Replace with:**

```ts
// XO-1 — the group row was the only shape SN-06 could re-mint; 1:1
// and reaction rows now persist their own inputs, so the decision
// moved into a pure, unit-testable helper.
const action = resolveSealedOutboxAction(payload);
if (action === 'ship') {
  outerSealed = payload.outerSealed;
  expiresAtSec = payload.expiresAtSec;
} else {
  // No crypto context on this drain — leave the row for one that has
  // it, exactly as the deferred branch above does.
  if (!reseal) {
    continue;
  }
  if (action === 'unresealable') {
    // Stale cert and nothing to re-mint from. Shipping would be the
    // silent-loss-behind-a-tick this fix exists to kill: fail loudly.
    throw new Error('outbox_cert_expired_unresealable');
  }
  // warn, not log: release builds strip console.log
  // (transform-remove-console excludes only error/warn), and a
  // re-mint is a rare, operationally significant event we need to be
  // able to confirm from a release logcat.
  console.warn(`[messenger.outbox] re-sealing stale-cert row ${row.clientMsgId}`);
  const sealedNow = await reseal(
    {peerUserId: row.peerUserId, peerDeviceId: row.peerDeviceId, clientMsgId: row.clientMsgId},
    payload as OutboxResealPayload,
  );
  outerSealed = sealedNow.outerSealed;
  expiresAtSec = sealedNow.expiresAtSec;
}
```

Also update the local `payload` declaration at `:7408`:

```ts
let payload: {
  outerSealed?: string;
  expiresAtSec?: number;
  certExpSec?: number;
} & Partial<DeferredOutboxPayload>;
```

→ (only the type name changes; `certExpSec` stays on the inline literal because
`OutboxResealPayload` describes the _re-seal inputs_, not the freshness metadata)

```ts
let payload: {
  outerSealed?: string;
  expiresAtSec?: number;
  certExpSec?: number;
} & Partial<OutboxResealPayload>;
```

and the deferred-branch cast at `:7430` `payload as DeferredOutboxPayload` → `payload as OutboxResealPayload`.

---

### Schema / migration

**None.** `outbox.payload` is an opaque `TEXT NOT NULL` column
(`src/modules/messenger/crypto/db.ts:204-216`); the change lives entirely inside the JSON. No
`SCHEMA_VERSION` bump (currently 14, `db.ts:54`).

### Wire format / back-compat

**No wire change.** `relay.send({recipient, outerSealed, clientMsgId, expiresAtSec})` is byte-identical;
`apps/messenger-service` is untouched. Old peers receive an ordinary sealed envelope with a _valid_
cert instead of a dead one — strictly better.

**Forward/backward local compat:**

- New build reading a pre-fix row: `certExpSec === undefined` → `resolveSealedOutboxAction` returns
  `'ship'` → unchanged legacy behaviour. Deliberate — failing closed on missing metadata would
  strand an existing queue on first launch after update (same call SN-06 made,
  `outboxCertFreshness.ts:29-31`). Bounded one-time residual.
- Old build reading a new row (downgrade / rollback APK): reads `payload.outerSealed` +
  `payload.expiresAtSec`, ignores the extra keys. Safe.

## Blast radius

**Files edited**

- `src/modules/messenger/runtime/outboxCertFreshness.ts` — additive only; `isStoredCertStale` and
  `OUTBOX_CERT_RESEAL_MARGIN_SEC` keep their signatures, so the existing
  `__tests__/outboxCertFreshness.test.ts` stays green unmodified.
- `src/modules/messenger/runtime/productionRuntime.ts` — `resealDeferredGroupRow` →
  `resealOutboxRow` (1 definition + 3 call sites), `DeferredOutboxPayload` → `OutboxResealPayload`
  (1 definition + 2 casts + 1 type reference), `ResealDeferredFn` → `ResealOutboxFn`, plus the four
  edits at `:2794`, `:2867`, `:3277`, `:3332` and the drain branch at `:7446`.

**Functions whose behaviour changes**

- `drainOutbox` — the sealed branch now can re-mint 1:1 and reaction rows. Group behaviour is
  bit-identical (`resolveSealedOutboxAction` returns exactly what the old inline test returned for
  group shapes).
- `sendText` (1:1 leg) and `sendReaction` — now call `certCache.getIssued()` instead of
  `certCache.get()`. `get()` delegates to `getIssued()` (`packages/messenger-core/src/runtime/certCache.ts:42`),
  so the inflight-coalescing and 30s negative cache are unchanged; the group path already uses
  `getIssued()` (`productionRuntime.ts:2481`). Note the LOCAL legacy copy
  `src/modules/messenger/runtime/certCache.ts` has no `getIssued` — it is dead
  (`runtime/index.ts:22` re-exports the core class, and `productionRuntime.ts:52` imports from
  `@bravo/messenger-core`). Do not "fix" it; it is not on this path.
- Re-sealed 1:1 envelopes carry `aad.ts = Date.now()` at drain time, so a re-minted message lands
  with a drain-time timestamp on the receiver. That is **OM-05** (already an accepted, separately
  tracked defect on the group path) — this change extends it to 1:1 re-mints. Losing the message
  is strictly worse than mis-ordering it; call it out rather than block on it.

**Overlapping findings — coordinate edits**

- **OM-01** is the same fix. Treat OM-01 and XO-1 as one change; do not schedule both.
- **XO-2** (`certCache.get()` reject → 'failed' with no outbox row) edits the _same_ try block at
  `:2796-2840`. Land XO-1 first, then XO-2 rebases onto `getIssued()`.
- **XO-3** (status-classified retry budget) edits the `catch` at `:7501-7524` — same function,
  different hunk. `outbox_cert_expired_unresealable` must stay in the budget-burning class.
- **XO-5** / **XO-4** touch `updateMessageStatus` calls in the same `drainOutbox` body.
- **OM-03** owns the residual (a message destroyed for a _non-cert_ reason — identity mismatch,
  AAD skew, epoch — still produces no `envelope.undeliverable` over HTTP). Arch-gated.
- **SYNC-7** reaction reliability work will touch `sendReaction`.

**What could regress**

1. Group drain path — if `resolveSealedOutboxAction` mis-classifies a group row (e.g. a group row
   that also happens to set `body`), a group message would take the wrong re-seal branch. Guard: the
   `resealKind` check is evaluated first and group rows never write `resealKind`.
2. Duplicate delivery — the re-mint reuses `row.clientMsgId`, so the relay's `(recipient,
clientMsgId)` dedup coalesces a re-mint with an original that actually landed. Unchanged from the
   group SN-06 path, but it is the thing to check in review.
3. Reaction rows have `messageId === clientMsgId` and no bubble; the L17 `'failed'` guard at
   `:7516-7522` finds no message and no-ops. Correct, but confirm it does not throw.
4. Plaintext-at-rest: the 1:1 payload now stores `body` (and reaction directives) in the outbox.
   Same SQLCipher DB that already holds `messages.content`, and the A4 group-deferred path already
   persists a plaintext send-intent (`:2513-2517`) — no new exposure class, but it _is_ a new copy.
   `deleteByConversation` (clear-chat) and `markDelivered` both purge it.

## Tests

Jest project **`messenger-crypto`** (`testMatch: src/modules/messenger/__tests__/**/*.test.ts`).
`productionRuntime.ts` cannot be imported under Jest, so runtime behaviour is covered through the
extracted pure helper — the same pattern `bootGroupStashDrain` / `outboxCertFreshness` already use.

**1. `src/modules/messenger/__tests__/outboxCertFreshness.test.ts`** (existing — extend, do not
rewrite; the 7 existing `isStoredCertStale` cases must stay green):

```ts
import {resolveSealedOutboxAction} from '../runtime/outboxCertFreshness';
```

Add a `describe('XO-1 — sealed outbox row action', …)` with:

- fresh cert + any shape → `'ship'` (assert for a group row, a `resealKind: 'direct'` row and a
  `resealKind: 'reaction'` row).
- `certExpSec === undefined` (pre-fix row) → `'ship'` — upgrade safety, explicitly asserted for a
  1:1-shaped payload.
- stale cert + `{resealKind: 'direct', body: 'hi'}` → `'reseal'`.
- stale cert + `{resealKind: 'direct', body: ''}` → `'reseal'` (media caption is legitimately empty;
  a truthiness check here would silently drop every image send — this is the assertion that pins
  `typeof payload.body === 'string'`).
- stale cert + `{resealKind: 'reaction', reaction: {targetMsgId: 'm1', emoji: '👍'}}` → `'reseal'`.
- stale cert + `{resealKind: 'reaction'}` with no `reaction` → `'unresealable'`.
- stale cert + `{sealedBody, groupId}` → `'reseal'` (group regression — must equal today's behaviour).
- stale cert + `{outerSealed}` only (the exact pre-fix 1:1 row, now aged) → `'unresealable'`.
- boundary: `certExpSec = nowSec + OUTBOX_CERT_RESEAL_MARGIN_SEC` with a direct payload → `'reseal'`;
  `+ MARGIN + 1` → `'ship'`.

**2. `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** (existing): add one case that
enqueues a payload containing `certExpSec` / `resealKind` / `body` and asserts `dueRows()` returns
the JSON round-tripped byte-identical — proves the opaque TEXT column needs no migration.

**3. Regression suites to run, in order**

- `npx jest --selectProjects=messenger-crypto -t 'outbox'` (fail fast)
- `npm run test:crypto` (full messenger-crypto project — mandatory per CLAUDE.md for anything on the
  sealed-sender path). Must include `packages/messenger-core/__tests__/logAudit.test.ts` green —
  the new payload carries plaintext, so no new log line may reference `body`, `text`, `reaction` or
  `payload`.
- `npm test` (all projects).
- `npm run typecheck` — must not exceed the `.tsc-baseline.json` count (47).

**4. Device verification (state explicitly if not exercised)**

- Airplane mode → send a 1:1 text + an image + a reaction → keep offline **> 70 min** (past the ~1h
  cert TTL) → restore connectivity → assert on the _recipient_ that all three arrive, and in the
  sender's release logcat that `[messenger.outbox] re-sealing stale-cert row …` fired once per row.
- Control: same flow but < 10 min offline → no re-seal line, envelopes ship verbatim.
- Group regression: same 70-min flow in a 3-member group → still delivered (SN-06 path unchanged).

## Risk

Things a reviewer should be suspicious of:

1. **Did the AAD shapes get copied verbatim?** The reaction re-seal must keep the bare `{to, ts}`
   AAD; the direct re-seal must keep `directConvoAadId(self, peer)` — the symmetric id. Getting
   the latter wrong reproduces the P0-N2-follow-up bug (`:2814-2821`): every 1:1 rejected with
   `conversation_mismatch`, sender sees 'sent', receiver sees nothing. Exactly the failure this
   finding is about.
2. **`verifySenderCert` and its 120s tolerance must be untouched.** No change to
   `packages/messenger-core/src/crypto/senderCert.ts`. Any diff there is an instant reject
   (CLAUDE.md stop condition + "never weaken transitions"). The fix is send-side only.
3. **No submitter identity was added to `POST /envelopes`.** If the diff touches
   `apps/messenger-service/src/relay/envelope.controller.ts` or `envelope.service.ts`, it has left
   XO-1's compliant scope and violates the Sealed Sender ruling.
4. **Plaintext leakage in logs.** The payload now contains `body`. The `console.warn` re-seal line
   must log only `row.clientMsgId`. Verify `logAudit.test.ts` still passes and that nobody added a
   `JSON.stringify(payload)` breadcrumb while debugging.
5. **`getIssued()` swap did not change failure semantics.** `get()` is now a thin wrapper over
   `getIssued()` in messenger-core — confirm the mobile build resolves `@bravo/messenger-core` and
   not the stale local `src/modules/messenger/runtime/certCache.ts` (which lacks `getIssued` and
   would blow up at runtime, not compile time, if an alias regressed).
6. **`certExpSec` definite-assignment.** TS may flag `let certExpSec: number;` as used-before-assigned
   if the try/catch narrowing differs from `cert`'s. It mirrors `cert` exactly, so it should be fine,
   but check the typecheck baseline did not move.
7. **This does not make the sender's tick honest in general.** It removes the _dominant_ silent-loss
   cause. A message destroyed for identity mismatch or AAD skew after an HTTP submit is still silent
   (OM-03, arch-gated). Do not close "zero silent failures" on the strength of this change.
