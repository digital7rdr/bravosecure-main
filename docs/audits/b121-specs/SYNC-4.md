# SYNC-4 - Delete-for-everyone: additive inner `redact` directive on the reaction fan-out machinery

## Verdict

**CONFIRMED** (line numbers drifted; mechanism exact).

- Delete is local-only and self-labels as such. `src/screens/messenger/ChatScreen.tsx:1669-1672`:
  `<TouchableOpacity style={styles.sheetRow} onPress={() => deleteMessage(actionMsg)} …>` →
  `<Text style={[styles.sheetRowText, {color:'#f87171'}]}>Delete (this device)</Text>`. The handler
  (`ChatScreen.tsx:775-783`) does exactly two things: `runtime?.discardOutboxForMessage(msg.id)` and
  `useMessengerStore.getState().removeMessage(conversationId, msg.id)`. No envelope is emitted.
- Retract is pre-fetch only. `packages/messenger-core/src/transport/relayClient.ts:141`
  `async retract(retractToken: string)` → server `apps/messenger-service/src/relay/envelope.service.ts:489-499`:
  `consumeRetractToken` → `if (!envelopeId) return {retracted: false}` → `this.store.get(envelopeId)` →
  `if (!env) return {retracted: false}`. Once the recipient has pulled + ACKed (`DEL env:{id}`), retract is a no-op.
- Zero edit/delete-for-everyone surface anywhere: `grep -rn "editMessage|deleteForEveryone|delete_for_everyone|revokeMessage" src/ packages/ apps/messenger-service/src` returns **nothing**.
- The pattern the audit says to mirror exists and is production-grade:
  `productionRuntime.ts:3275 sendReaction` (per-recipient fan-out via `reactionRecipients`, group stamp,
  durable `sqlOutbox.enqueue`, `trackPending`, HTTP fallback) + receive apply at `:6601` (group-stamped)
  and `:7261` (1:1), both behind the `isPeerBlocked` gate.
- The resurrection guard the fix needs also already exists: `isRestoreTombstoned(...)` is consulted on
  BOTH append sites (`productionRuntime.ts:7241` group, `:7311` 1:1), loaded at boot (`:421`).

## Mechanism

1. Alice sends a message in a 1:1 or group. It is submitted to the relay, fetched by every recipient,
   ACKed, and hard-deleted server-side (`envelope.service.ts` `ack` → `DEL env:{id}` + `ZREM pending:*`).
   Each recipient now holds an independent SQLCipher row keyed by Alice's `clientMsgId`.
2. Alice long-presses the bubble → "Delete (this device)". `deleteMessage` drops the local row and any
   still-queued outbox row. **Nothing crosses the wire.**
3. Bob/Carol keep the row forever. There is no protocol message that could ever remove it —
   `SealedPayload` (`packages/messenger-core/src/crypto/sealedSender.ts:194-270`) has no field that
   means "remove". `retract` cannot help: the envelope was already ACK-deleted, so
   `consumeRetractToken` returns nothing and `retract` answers `{retracted:false}` without error.
4. Divergence is permanent and one-directional: the deleter's history is a strict subset of every
   peer's. A backup restore reinstates the deleter's own view (mirror tombstone), but never converges
   the peers. Same hole for edits (no edit protocol at all).
5. The user-visible consequence the founder reported as "Android ↔ iPhone not synchronized": two
   devices in the same thread legitimately show different message sets, with no way to reconcile.

## Fix

Design constraints honoured (per the batch architecture ruling #7): the directive is a **purely inner
`SealedPayload` field** riding the existing `POST /envelopes` / `envelope.send` path. **Zero server
changes.** The relay sees one more opaque pairwise ciphertext. Idempotency is the relay's existing
`(recipient, clientMsgId)` SET-NX. Server-side copy purge continues to go through the capability
token only (`relay.retract`), never a sender-identified delete.

Scope of this increment: **delete-for-everyone only**. Edits are a sibling field on the same
machinery (§Follow-up).

---

### 1. `packages/messenger-core/src/crypto/sealedSender.ts` — the wire field

**Anchor A** (inside `interface SealedPayload`):

```ts
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
```

**Replace with:**

```ts
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
  /**
   * SYNC-4 — delete-for-everyone directive. Empty-body envelope whose only
   * payload is "remove the message I authored under `targetMsgId`". Applied
   * only when the receiver can attribute `targetMsgId` to THIS sender, so a
   * group member cannot erase another member's history.
   */
  redact?: {targetMsgId: string};
```

**Anchor B** (inside `interface SealOptions`):

```ts
  reaction?:     {targetMsgId: string; emoji: string; remove?: boolean};
```

**Replace with:**

```ts
  reaction?:     {targetMsgId: string; emoji: string; remove?: boolean};
  redact?:       {targetMsgId: string};
```

**Anchor C** (inside `sealPayload`):

```ts
if (opts.reaction) {
  wrapped.reaction = opts.reaction;
}
```

**Replace with:**

```ts
if (opts.reaction) {
  wrapped.reaction = opts.reaction;
}
if (opts.redact) {
  wrapped.redact = opts.redact;
}
```

**Anchor D** (the key allow-list):

```ts
const SEALED_PAYLOAD_KEYS = new Set([
  'v',
  'cert',
  'body',
  'attachment',
  'expiresAtSec',
  'clientMsgId',
  'group',
  'replyTo',
  'reaction',
  'control',
  'groupCallPresence',
  'aad',
]);
```

**Replace with:**

```ts
const SEALED_PAYLOAD_KEYS = new Set([
  'v',
  'cert',
  'body',
  'attachment',
  'expiresAtSec',
  'clientMsgId',
  'group',
  'replyTo',
  'reaction',
  'redact',
  'control',
  'groupCallPresence',
  'aad',
]);
```

**Anchor E** (inside `isSealedPayload`, after the reaction block):

```ts
if (o.control !== null && o.control !== undefined) {
  if (o.control !== 'rehandshake') {
    return false;
  }
}
```

**Replace with:**

```ts
if (o.redact !== null && o.redact !== undefined) {
  if (typeof o.redact !== 'object') {
    return false;
  }
  const d = o.redact as Record<string, unknown>;
  if (typeof d.targetMsgId !== 'string' || d.targetMsgId.length === 0) {
    return false;
  }
  if (Object.keys(d).length !== 1) {
    return false;
  }
}
if (o.control !== null && o.control !== undefined) {
  if (o.control !== 'rehandshake') {
    return false;
  }
}
```

`SEALED_VERSION` stays **3**. Bumping it would make every _ordinary_ message unreadable by the current
fleet (`unsealPayload` rejects `parsed.v > SEALED_VERSION`); the field is optional and additive, which
is precisely the compat model the file already documents for `attachment` / `aad` / `replyTo`.

**Apply the identical five edits to `src/modules/messenger/crypto/sealedSender.ts`** (anchors at
:207, :247, :278, :473-476, and the `o.control` block at ~:531). That file is a legacy duplicate —
`src/modules/messenger/crypto/index.ts` re-exports `@bravo/messenger-core`, so production never loads
it — but three tests import it directly (`__tests__/sealedSender.test.ts`,
`directConvoAadRoundtrip.test.ts`, `outerEcies.test.ts`) and the two copies are kept byte-parallel by
convention. No production effect.

#### Back-compat for old peers — explicit

An older client that receives a `redact` envelope hits `isSealedPayload` → unknown key → `false` →
`unsealPayload` throws `CryptoError('sealed payload shape invalid')`. Traced through the current tree
that lands in `handleDeliver`'s catch-all (`productionRuntime.ts:5655-5668`, "Non-rotation failure …
Drop the envelope so the relay stops redelivering"), then ACK with `disposition: 'discarded'`
(`:5682-5686`). The relay emits `envelope.undeliverable` to the sender; `applyEnvelopeUndeliverable`
finds no bubble for a directive `clientMsgId` and `selectUndeliverableResend` returns `skip` (no
message row). Net effect on an old peer: **the delete silently does not apply; nothing else breaks** —
no redelivery loop (the envelope is acked away), no session rebuild (this is post-decrypt, not a
`DecryptError`), only a `noteUndecryptable` counter bump (`sessionRatchetRecovery.ts:54`, console-only).
Ops-console degrades the same way (`apps/ops-console/src/lib/messenger/runtime.ts:917` → `catch … return null`).
**Rollout order:** merge + redeploy ops-console (it path-aliases the same package) before the mobile
build that emits redacts, otherwise redacts sent to ops users are discarded.

---

### 2. `src/modules/messenger/runtime/redactRegistry.ts` — NEW (authorship-bound tombstones)

A redact can legitimately arrive **before** the message it targets (independent envelopes, independent
fan-out timing). Applying it blindly would let any group member suppress a message they merely know
the `clientMsgId` of. This module binds the tombstone to the claimed author so the pending case stays
safe. Deliberately mirrors `src/modules/messenger/backup/restoreTombstones.ts` (owner-scoped
AsyncStorage set, bounded, fail-open when uninitialised) — **no SQLCipher schema change, no
`SCHEMA_VERSION` bump.**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * SYNC-4 — persistent record of "message id X was redacted by author Y".
 *
 * Two jobs: (1) suppress a message whose delete-for-everyone directive won the
 * race against the message itself, (2) survive the relay redelivering the
 * original after the row was already removed. Keyed by author so a group member
 * cannot redact a message they did not write — the pending case is exactly
 * where the author cannot be checked against a local row.
 *
 * Owner-scoped and capped, same shape as restoreTombstones.
 */
const KEY_PREFIX = 'messenger.redacted.v1:';
const MAX_ENTRIES = 20_000;

let cached: Map<string, string> | null = null;
let ownerKey = '';

function keyFor(ownerUserId: string): string {
  return `${KEY_PREFIX}${ownerUserId}`;
}

/** Load the owner's redact map into memory. Call once on runtime build. */
export async function loadRedacts(ownerUserId: string): Promise<void> {
  if (cached && ownerKey === keyFor(ownerUserId)) {
    return;
  }
  ownerKey = keyFor(ownerUserId);
  if (!ownerUserId) {
    cached = new Map();
    return;
  }
  try {
    const raw = await AsyncStorage.getItem(ownerKey);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    cached = new Map(
      Array.isArray(arr)
        ? arr.filter(
            (e): e is [string, string] =>
              Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string',
          )
        : [],
    );
  } catch {
    cached = new Map();
  }
}

/** Persist "targetMsgId was redacted by authorUserId". Idempotent. */
export async function recordRedact(targetMsgId: string, authorUserId: string): Promise<void> {
  if (!targetMsgId || !authorUserId || !cached) {
    return;
  }
  if (cached.get(targetMsgId) === authorUserId) {
    return;
  }
  cached.set(targetMsgId, authorUserId);
  if (cached.size > MAX_ENTRIES) {
    cached = new Map(Array.from(cached).slice(cached.size - MAX_ENTRIES));
  }
  try {
    await AsyncStorage.setItem(ownerKey, JSON.stringify(Array.from(cached)));
  } catch {
    // Best-effort — the in-memory map still suppresses for this session.
  }
}

/** Synchronous hot-path read. Fail-open when uninitialised — never drop a live message. */
export function isRedactedBy(
  targetMsgId: string | undefined | null,
  senderUserId: string,
): boolean {
  if (!targetMsgId || !cached || cached.size === 0) {
    return false;
  }
  return cached.get(targetMsgId) === senderUserId;
}

/** Test-only — clears the in-memory map. */
export function _resetRedactRegistryForTests(): void {
  cached = null;
  ownerKey = '';
}
```

---

### 3. `src/modules/messenger/runtime/productionRuntime.ts`

#### 3a. Boot load

**Anchor:**

```ts
await loadRestoreTombstones(config.ownUserId).catch(() => {
  /* empty set */
});
```

**Replace with:**

```ts
await loadRestoreTombstones(config.ownUserId).catch(() => {
  /* empty set */
});
await loadRedacts(config.ownUserId).catch(() => {
  /* empty map */
});
```

Add to the existing import at `:85`:

```ts
import {isRestoreTombstoned, loadRestoreTombstones} from '../backup/restoreTombstones';
import {loadRedacts, recordRedact, isRedactedBy} from './redactRegistry';
```

#### 3b. Send — `sendRedact`, sibling of `sendReaction`

**Anchor** (the closing lines of `sendReaction`, immediately before `discardOutboxForMessage`):

```ts
// Best-effort fan-out — one bad recipient (no session, OPK
// exhausted) must not drop the reaction for everyone else.
await Promise.allSettled(recipients.map(sendOneReaction));
```

Insert the new runtime method **after** `sendReaction`'s closing `},` (i.e. immediately before the
`// Audit MSG-05 — drop the durable outbox rows …` comment that precedes `discardOutboxForMessage`):

```ts
    sendRedact: async (peer, conversationId, targetMsgId) => {
      if (!peer.userId) {return;}
      const store0 = useMessengerStore.getState();
      const target = store0.messages[conversationId]?.find(m => m.id === targetMsgId);
      // Why: only the author may delete for everyone — the receive side
      // enforces the same rule, this is the local half of the gate.
      if (target && target.sender_id !== 'self') {return;}

      const cert = await certCache.get();
      const {reactionRecipients, isGroupConversation} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      const recipients = reactionRecipients(store0, conversationId, ownAddress.userId, peer);
      const redactIsGroup = isGroupConversation(store0, conversationId);

      const sendOneRedact = async (to: SessionAddress): Promise<void> => {
        if (!to.userId) {return;}
        await ensureOutgoingSession(own, keys, to, ownStore);
        const clientMsgId = makeId();
        const sealed = sealPayload(cert, '', {
          redact: {targetMsgId},
          ...(redactIsGroup ? {group: {groupId: conversationId, kind: 'text' as const, clientMsgId}} : {}),
          aad: {to, ts: Date.now()},
        });
        const ct = await own.encrypt(to, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, to, peerIdentityCache, PEER_IDENTITY_TTL_MS);
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert,
        });
        if (sqlOutbox) {
          try {
            await sqlOutbox.enqueue({
              clientMsgId,
              conversationId,
              messageId:    clientMsgId,
              peerUserId:   to.userId,
              peerDeviceId: to.deviceId,
              payload:      JSON.stringify({outerSealed}),
            });
          } catch { /* enqueue best-effort */ }
        }
        let redactDelivered = false;
        try {
          transport.send({
            event: 'envelope.send',
            data: {to, outerSealed, clientMsgId, urgent: false},
          });
          trackPending(clientMsgId, {conversationId, messageId: clientMsgId, peer: to});
        } catch {
          try {
            await relay.send({recipient: to, outerSealed, clientMsgId, urgent: false});
            redactDelivered = true;
          } catch { /* socket down + HTTP failed — leave the row for drainOutbox */ }
        }
        if (redactDelivered && sqlOutbox) {
          sqlOutbox.markDelivered(clientMsgId, to.userId, to.deviceId).catch(() => { /* best-effort */ });
        }
      };

      await Promise.allSettled(recipients.map(sendOneRedact));

      // Pre-fetch copies still parked on the relay: the capability token is
      // the only sanctioned server-side purge (Sealed Sender preserved).
      if (target?.retract_token) {
        try { await relay.retract(target.retract_token); } catch { /* already fetched — dwell handles it */ }
      }
      if (target?.media_object_key) {
        if (mediaCache) { try { await mediaCache.remove(target.media_object_key); } catch { /* LRU catches it */ } }
        try { await mediaClient.purge(target.media_object_key); } catch { /* non-owner 403 / offline */ }
      }
      try { await sqlOutbox?.deleteByClientMsgId(targetMsgId); } catch { /* best-effort */ }
      useMessengerStore.getState().removeMessage(conversationId, targetMsgId);
    },
```

#### 3c. Receive — one block covers both lanes

`conversationId` is already resolved for group **and** direct at this point (`:6586-6592`), and the
envelope is fully authenticated by then (cert `:6405`, device pin `:6425`, AAD `:6440`).

**Anchor:**

```ts
  if (unwrapped.reaction && unwrapped.group?.groupId) {
    // Audit P2-9 — apply the M-07 blocked-peer gate BEFORE the reaction
    // lands (blocked peers could previously patch reactions unimpeded).
    if (isPeerBlocked(peer.userId)) {
```

**Insert immediately BEFORE it:**

```ts
// SYNC-4 — delete-for-everyone. Empty-body control envelope; handled here
// (before the group-parse path) for both lanes, since `conversationId` is
// already resolved to the group id when the sender stamped one.
if (unwrapped.redact) {
  if (isPeerBlocked(peer.userId)) {
    console.log('[recv.redact.blocked] peer=' + peer.userId.slice(0, 8));
    return;
  }
  await applyRedact(conversationId, peer.userId, unwrapped.redact.targetMsgId);
  return;
}
```

#### 3d. Receive — suppress a resurrected original

Two append sites already gate on `isRestoreTombstoned`. Add the authorship-bound gate beside each.

**Anchor (group append):**

```ts
if (isRestoreTombstoned(groupMsg.id)) {
  console.log('[group:recv.tombstoned] msgId=' + groupMsg.id.slice(0, 8));
  return;
}
```

**Replace with:**

```ts
if (isRestoreTombstoned(groupMsg.id) || isRedactedBy(groupMsg.id, peer.userId)) {
  console.log('[group:recv.tombstoned] msgId=' + groupMsg.id.slice(0, 8));
  return;
}
```

**Anchor (1:1 append):**

```ts
if (isRestoreTombstoned(oneToOneMsg.id)) {
  console.log('[recv.text.append.tombstoned] msgId=' + oneToOneMsg.id.slice(0, 8));
  return;
}
```

**Replace with:**

```ts
if (isRestoreTombstoned(oneToOneMsg.id) || isRedactedBy(oneToOneMsg.id, peer.userId)) {
  console.log('[recv.text.append.tombstoned] msgId=' + oneToOneMsg.id.slice(0, 8));
  return;
}
```

#### 3e. `applyRedact` helper — beside `applyReaction`

**Anchor** (the `applyReaction` docblock opener):

```ts
/**
 * Fold a reaction patch into an existing local message. The message
```

**Insert immediately BEFORE it:**

```ts
/**
 * SYNC-4 — apply a delete-for-everyone directive.
 *
 * Authorship is the whole security surface: a redact is honoured only for a
 * message the SAME peer authored. When the target row exists we check it
 * directly; when it hasn't arrived yet we persist the (id → author) claim and
 * the append sites re-check it, so a group member can never suppress another
 * member's message by racing the fan-out.
 */
async function applyRedact(
  conversationId: string,
  fromUserId: string,
  targetMsgId: string,
): Promise<void> {
  const store = useMessengerStore.getState();
  const msg = store.messages[conversationId]?.find(m => m.id === targetMsgId);
  if (msg && msg.sender_id !== fromUserId) {
    console.log('[recv.redact.denied] convId=' + conversationId.slice(0, 16));
    return;
  }
  await recordRedact(targetMsgId, fromUserId);
  if (msg) {
    store.removeMessage(conversationId, targetMsgId);
  }
}
```

`store.removeMessage` already fans the change into SQLCipher (the live subscriber at `:1854-1870`
`store.remove(cid, m.id)` + media-cache purge + `deleteTempBytes`) **and** into the backup mirror
(`notifyBackupRemoved` → `status='deleted'` tombstone), so a later restore stays converged with zero
extra work. That is why no schema change is needed.

---

### 4. `src/modules/messenger/runtime/runtime.ts` — interface + loopback stub

**Anchor (interface):**

```ts
  sendReaction(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
    emoji:          string,
    remove?:        boolean,
  ): Promise<void>;
```

**Replace with:**

```ts
  sendReaction(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
    emoji:          string,
    remove?:        boolean,
  ): Promise<void>;

  /**
   * SYNC-4 — delete-for-everyone. Fans an empty-body `redact` directive to
   * every recipient of the original, retracts any still-queued relay copy,
   * and removes the local row. Author-only; a no-op on someone else's
   * message. Optional so the loopback runtime can omit the wire half.
   */
  sendRedact?(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
  ): Promise<void>;
```

**Anchor (loopback stub):**

```ts
    // Loopback has no durable outbox — nothing to discard (MSG-05).
    discardOutboxForMessage: async () => { /* no-op */ },
```

**Replace with:**

```ts
    // Loopback redact: no peers to notify — drop the local row only.
    sendRedact: async (_peer, conversationId, targetMsgId) => {
      useMessengerStore.getState().removeMessage(conversationId, targetMsgId);
    },
    // Loopback has no durable outbox — nothing to discard (MSG-05).
    discardOutboxForMessage: async () => { /* no-op */ },
```

---

### 5. `src/screens/messenger/ChatScreen.tsx` — two delete affordances

**Anchor (handler):**

```ts
  const deleteMessage = (msg: LocalMessage) => {
    setActionMsg(null);
```

**Insert immediately AFTER the `deleteMessage` function's closing `};`:**

```ts
const deleteForEveryone = (msg: LocalMessage) => {
  setActionMsg(null);
  if (!runtime?.sendRedact || !conversationPeer) {
    return;
  }
  Alert.alert(
    'Delete for everyone?',
    'This message will be removed from this chat on every device.',
    [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void runtime.sendRedact?.(conversationPeer, conversationId, msg.id).catch(() => {
            Alert.alert('Delete failed', 'Could not reach the other devices. Try again.');
          });
        },
      },
    ],
  );
};
```

`conversationPeer` is declared at `:914` (`const conversationPeer = conversation?.peer;`), above the
action sheet — no reordering needed.

**Anchor (action sheet row):**

```tsx
<TouchableOpacity
  style={styles.sheetRow}
  onPress={() => deleteMessage(actionMsg)}
  activeOpacity={0.7}
>
  <Icon name="trash-can-outline" size={20} color="#f87171" />
  <Text style={[styles.sheetRowText, {color: '#f87171'}]}>Delete (this device)</Text>
</TouchableOpacity>
```

**Replace with:**

```tsx
{
  actionMsg.sender_id === 'self' && !!conversationPeer && (
    <TouchableOpacity
      style={styles.sheetRow}
      onPress={() => deleteForEveryone(actionMsg)}
      activeOpacity={0.7}
    >
      <Icon name="delete-forever-outline" size={20} color="#f87171" />
      <Text style={[styles.sheetRowText, {color: '#f87171'}]}>Delete for everyone</Text>
    </TouchableOpacity>
  );
}
<TouchableOpacity
  style={styles.sheetRow}
  onPress={() => deleteMessage(actionMsg)}
  activeOpacity={0.7}
>
  <Icon name="trash-can-outline" size={20} color="#f87171" />
  <Text style={[styles.sheetRowText, {color: '#f87171'}]}>Delete for me</Text>
</TouchableOpacity>;
```

`Alert` is already the branded `@utils/alert` import (`ChatScreen.tsx:9`) — do **not** import from
`react-native` (B-88 static sweep).

---

### Product decisions taken (flag if the founder disagrees)

1. **No time window** on delete-for-everyone. WhatsApp caps at ~2 days; a receiver-side window would
   be enforced against `aad.ts` vs `created_at`, which OM-02 already proves is clock-skew-unreliable —
   a skew-driven "window expired" would re-create exactly the divergence we are removing. A
   _sender-side UI only_ window can be added later as one predicate on the menu row.
2. **The row is removed, not replaced with "This message was deleted."** That matches the existing
   local delete. A placeholder needs a rendered `type: 'system'` bubble style, which ChatScreen does
   not have yet (SN-11's `groupEventMessage.ts` system rows render as ordinary bubbles today). Ship
   the placeholder together with the system-bubble style as a separate UI task.
3. **Edits deferred.** They are a sibling optional field `edit?: {targetMsgId: string; body: string}`
   with an `applyEdit` that reuses the same authorship gate plus `store.updateMessage…`. Deliberately
   out of this increment: an edit needs an edited-at marker in the bubble, an edit history decision,
   and a mirror-version story — a product conversation, not a protocol one.

## Blast radius

**Files edited (7 + 1 new):**

| File                                                 | Change                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/messenger-core/src/crypto/sealedSender.ts` | `redact` on `SealedPayload` / `SealOptions` / `sealPayload` / key allow-list / `isSealedPayload` |
| `src/modules/messenger/crypto/sealedSender.ts`       | identical mirror (legacy duplicate, tests only)                                                  |
| `src/modules/messenger/runtime/redactRegistry.ts`    | **NEW**                                                                                          |
| `src/modules/messenger/runtime/productionRuntime.ts` | boot load, `sendRedact`, receive dispatch, 2 append gates, `applyRedact`                         |
| `src/modules/messenger/runtime/runtime.ts`           | interface + loopback stub                                                                        |
| `src/screens/messenger/ChatScreen.tsx`               | `deleteForEveryone` + 2 sheet rows                                                               |

**Untouched (deliberately):** `apps/messenger-service/**` (zero server change — no new route, no new
DTO field, no new relay semantics), `apps/ops-console/**` (it consumes the package and already
soft-drops unknown shapes), `src/modules/messenger/crypto/db.ts` (**no `SCHEMA_VERSION` bump** —
tombstones live in AsyncStorage, removal reuses the existing store subscriber).

**Functions whose behaviour changes:** `isSealedPayload` (one more accepted key),
`doHandleIncoming` (one new early-return branch, two widened gates), `removeMessage` gains a second
caller path. `sealPayload`/`unsealPayload` are on every message path — a mistake in Anchor D/E breaks
**all** messaging, which is why the direct test below asserts the negative cases.

**Overlaps with other findings in this batch:**

- **SYNC-1** edits `productionRuntime.ts:2706-2718` + `:5182` (per-recipient envelopeId set). Different
  region, but if SYNC-1 lands "match receipts by `clientMsgId`", it and this fix both start treating
  `clientMsgId` as the cross-device message handle — consistent, no conflict.
- **SYNC-7** wants a pending-reaction stash in `applyReaction`, immediately adjacent to `applyRedact`.
  Textual conflict risk in the same hunk; land one, rebase the other.
- **OM-05 / OM-02** touch `aad.ts` semantics at seal/display time; `sendRedact` stamps
  `aad: {to, ts: Date.now()}` like every other sender and inherits whatever they decide.
- **GF-2/SYNC-2** rework the fan-out durability of key material. `sendRedact` copies `sendReaction`'s
  outbox pattern verbatim, so any durability improvement they make to that pattern should be applied
  here in the same pass (or `sendRedact` factored onto their new helper).
- **XO-1** (stale cert on rows queued >1h) applies to redact outbox rows exactly as to text rows.

**What could regress:**

1. A typo in `SEALED_PAYLOAD_KEYS` breaks every inbound envelope fleet-wide.
2. `isRedactedBy` is consulted on the hot append path — it must stay a `Map.get` and must fail **open**
   when uninitialised (it does), or a boot-order change silently drops live messages.
3. `recordRedact` writes AsyncStorage on the receive path (inside `doHandleIncoming`, which runs inside
   the receive transaction) — it is awaited but is not a SQLCipher write, so it cannot deadlock the
   handle; still, a slow AsyncStorage write lengthens the txn window.
4. The 20 000-entry cap evicts oldest entries; a user past that in one install could see a very old
   redacted message resurrect on relay redelivery. Practically unreachable (dwell is 30 days).

## Tests

Follow the existing split: pure-shape + crypto → `messenger-crypto` project; runtime/store logic →
`messenger-crypto` project too (it matches `src/modules/messenger/__tests__/**`). No `app`-project test
is needed (ChatScreen has no existing test file; the change there is a menu row).

**1. `packages/messenger-core/__tests__/sealedSenderShape.test.ts` (existing — extend)**

- In `'round-trips every optional field'`: add `redact: {targetMsgId: 't9'}` to the `sealPayload` opts
  and `expect(p.redact).toEqual({targetMsgId: 't9'})`.
- New: `expect(() => unsealPayload(JSON.stringify({v:3,cert:'c',body:'',redact:{targetMsgId:1}}))).toThrow(CryptoError)`.
- New: `redact: {}` (missing `targetMsgId`) → throws.
- New: `redact: {targetMsgId:'t', extra:1}` → throws (the `Object.keys(d).length !== 1` guard).
- New: `redact: {targetMsgId:''}` → throws.
- Regression: an envelope with a genuinely unknown key (`{…, bogus: 1}`) still throws — the allow-list
  is not weakened.

**2. `src/modules/messenger/__tests__/redactRegistry.test.ts` (NEW)**
Copy the AsyncStorage in-memory mock from `blockedPeersAndTombstones.test.ts`.

- `isRedactedBy` returns `false` before `loadRedacts` (fail-open).
- `recordRedact('m1','alice')` → `isRedactedBy('m1','alice') === true`, `isRedactedBy('m1','bob') === false`.
- Survives `_resetRedactRegistryForTests()` + `loadRedacts(sameOwner)` (persistence).
- A different owner id loads an independent map.
- `recordRedact` past `MAX_ENTRIES` keeps the newest entry and drops the oldest.

**3. `src/modules/messenger/__tests__/redactApply.test.ts` (NEW)**
`applyRedact` is currently module-private; export it from `productionRuntime.ts` alongside the other
test-visible helpers, or (preferred, matching `messagingLogic.ts` / `groupEventMessage.ts` convention)
lift the 12-line body into `src/modules/messenger/runtime/redactApply.ts` and have `doHandleIncoming`
call it. Then assert against a real `useMessengerStore`:

- author redacts own message → row removed, `isRedactedBy(id, author)` true.
- **non-author redacts someone else's message → row still present, registry untouched** (the security
  assertion — this is the one a reviewer should demand).
- redact-before-target: apply with no row → registry records; a later append of that id **from the
  same author** is suppressed; the same id **from a different sender** is NOT suppressed.
- redact of a message authored by `'self'` arriving from a peer → denied.

**4. `src/modules/messenger/__tests__/sealedSender.test.ts` (existing, mobile copy)** — one assertion
that `sealPayload(cert, '', {redact:{targetMsgId:'x'}})` round-trips, to keep the duplicate honest.

**Regression suites to run, in order:**

```
npx jest --selectProjects=messenger-crypto -t redact      # fail-fast on the new tests
npm run test:crypto                                        # full crypto/regression (mandatory: envelope shape changed)
npm test                                                   # app + booking
npm run typecheck                                          # must stay <= 47 (.tsc-baseline.json)
cd apps/ops-console && npm run typecheck                   # it imports SealedPayload
```

Device smoke (per CLAUDE.md §UI verification — cannot be done in CI): 1:1 delete-for-everyone with the
peer foreground; with the peer offline then reconnecting (registry + relay redelivery path); group of
3 (assert all members lose the bubble); delete a photo message (assert the R2 purge and that the
thumbnail cache is gone); delete-for-everyone against a peer on an OLD build (assert graceful no-op,
no stuck thread).

## Risk

- **Highest-leverage line in the whole diff is Anchor D.** `SEALED_PAYLOAD_KEYS` is on every inbound
  envelope. Review it character by character; a typo bricks messaging fleet-wide with a symptom
  ("messages stopped appearing") that looks nothing like the cause.
- **The authorship gate is the security control, and it is fail-open by design in one case:** a redact
  whose target row is absent is _recorded_ without the author being provable, then re-checked at
  append. Convince yourself the append-side check (`isRedactedBy(id, peer.userId)`) is really reached
  on _both_ lanes and really compares against the ARRIVING message's sender — not the redact sender.
  If that comparison is dropped, any group member can suppress any message they know the id of.
- **Do not "simplify" by reusing `addRestoreTombstones`.** That set is author-less; using it here is
  exactly the hole above. It is a tempting 1-line shortcut in review.
- `SEALED_VERSION` must stay **3**. Anyone bumping it to 4 to "be correct about the format change"
  makes every ordinary message from the new build unreadable by the entire deployed fleet
  (`unsealPayload` rejects `v > SEALED_VERSION`).
- **Rollout ordering is real:** ops-console must be redeployed against the updated package before
  mobile emits redacts, or redacts to ops users are silently discarded (and counted as
  `noteUndecryptable`).
- `sendRedact` calls `relay.retract` — verify it uses the message's own `retract_token` and nothing
  else. Group rows only ever store the FIRST recipient's token (`productionRuntime.ts:2695-2696`,
  the SYNC-1 defect), so the group retract covers one recipient at most; correctness does not depend
  on it (the directive + registry do the work) but do not let a reviewer read it as a guarantee.
- **Architecture sign-off (light form) is still required**: this adds an optional field to the sealed
  payload, which is the CLAUDE.md stop condition "Sealed-sender envelope shape". The amendment text is
  one sentence — _"`redact` is a non-displayable inner `SealedPayload` field, relay-invisible, riding
  the existing pairwise sealed path exactly like `reaction`; server-side purge continues to use only
  the capability token"_ — but it must be signed per `ARCHITECTURE_AMENDMENT_SFRAME.md` before merge.
- Log-audit gate: `[recv.redact.denied]` / `[recv.redact.blocked]` must log **no** message ids beyond
  the existing truncated-id convention and never a body. Both lines above comply; keep them that way.
