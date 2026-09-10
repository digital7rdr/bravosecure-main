# GF-2 — Group key material rides a fire-and-forget WS lane; a zombie socket silently forks members off the group key

## Verdict

**CONFIRMED** (mechanism exactly as described; only the line numbers drifted).

- `packages/messenger-core/src/transport/client.ts:319-323` — the only failure signal is socket state:
  ```ts
  send(frame: ClientFrame): void {
    if (!this.socket?.connected) {
      throw new Error('transport not open');
    }
    this.socket.emit(frame.event, (frame as {data?: unknown}).data ?? {});
  }
  ```
  `socket.emit` on a connected-but-frozen fd buffers and returns `void`. There is no ack, no callback, no throw.
- Every group key-material fan-out uses `try transport.send(...) catch relay.send(...)`, then counts it delivered. Ten sites in `src/modules/messenger/runtime/productionRuntime.ts`:
  `:2036` (`reshareGroupKeyState`), `:2099` (`sendKeyRequest`), `:2178` (leave-triggered rekey), `:3628` (`createGroupChat`), `:3778` (ops-room bootstrap create), `:3870` (`removeGroupMember` — used for BOTH `remove` and `rekey`), `:4029` (`leaveGroup`), `:4135` (`addGroupMember` — BOTH `add` and `rekey`), `:4361` + `:4468` (`ensureCallGroupKey` resync + mint).
- The repo already knows this is wrong — the group **text** path was fixed for exactly this reason and says so verbatim at `productionRuntime.ts:2631-2637`:
  > `// Group fan-out always uses HTTP. The WS path here used to // increment 'delivered' on a pure transport.send() (no ack) // — half-dead sockets that buffered the frame but never // shipped it would fool us into flipping to 'sent' ... HTTP returns a real 200 + retractToken, so we know the relay accepted it.`
- No outbox row is ever written for key material. `SqlOutboxStore.enqueue` is called only from the text/media/reaction paths (`productionRuntime.ts:2571`, `:2597`, `:2866`, `:3332`); `grep enqueue` finds zero calls in any group-admin closure. So a peer missed at fan-out time is lost permanently — nothing replays it.
- Only a **0-total** rekey retries, once: `productionRuntime.ts:3941-3944` and `:4243-4246` (`if (rekeyDelivered === 0) { rekeyDelivered = await fanOutRekey(); }`). A 5-of-6 fan-out is treated as success and the 6th member is silently on the old epoch key.

## Mechanism

1. Device A is admin of group G at epoch E. Its WS socket has been frozen by Doze / a NAT rebind; socket.io's heartbeat has not yet expired, so `this.socket.connected === true`.
2. A adds/removes a member (or the reshare/self-heal engine fires). `broadcastToGroup` seals **one pairwise envelope per recipient** and calls the site's `deliver` closure for each.
3. Each `deliver` runs `transport.send({event: 'envelope.send', ...})`. `client.ts:320` sees `connected === true`, so it does not throw; `socket.emit` writes into the dead fd's buffer and returns. The `catch { await relay.send(...) }` HTTP fallback **never runs**.
4. `delivered += 1` for every peer. `broadcastToGroup` returns `recipients === N`, no failures.
5. The caller therefore skips every safety net: `createGroupChat` does not throw (`:3652`), `addGroupMember`/`removeGroupMember` skip the single B-10 retry and never call `store.setError` (`:3941`, `:4243`), `ensureCallGroupKey` does not fail closed (`:4480`).
6. A then rotates locally and fail-closed (`stateAfterRekey` at `:3956` / `:4258`) — correct policy, but now **nobody else has the new key**. The socket eventually reconnects; socket.io's buffered frames are dropped on reconnect (they are not replayed), and there is no outbox row, so the key material is gone.
7. Every subsequent group message from A is undecryptable for the whole roster. The receive-side heal (`key-request`) is the only recovery, and GF-3 documents that it is itself unreliable.

Secondary (independent of the zombie socket): even on a healthy socket, a **per-peer** failure — 429, unprovisioned device, transient DNS — is only pushed onto a `failures[]` array that is logged and discarded. Nothing retries that one peer.

## Fix

Route key material through the **exact durable path group text already uses**: persist a per-recipient outbox row before the submit, submit over HTTP (`POST /envelopes`, where a 200 is a real accept), drop the row on 200, leave it for `drainOutbox` on failure. No new wire field, no new server endpoint, no schema migration, no change to the sealed envelope, the AAD, or the epoch guard.

### F1. `src/modules/messenger/runtime/productionRuntime.ts` — new shared helper

Insert immediately **before** `const reshareGroupKeyState = async (` (which sits just after the `pruneCooldownMap` definition around `:1974`). It must be after `let sqlOutbox: SqlOutboxStore | null = null;` (`:970`) lexically for readability; all ten call sites are below it.

Anchor (verbatim, unique):

```ts
  const reshareGroupKeyState = async (
    state: GroupState,
    targetUserIds?: string[],
  ): Promise<number> => {
```

Insert above it:

```ts
/**
 * GF-2 — durable delivery of ONE group key-material / admin envelope.
 *
 * Why: `transport.send` only throws when the socket is ALREADY closed
 * (messenger-core client.ts), so a half-dead fd buffered the frame while the
 * fan-out counted it delivered — a member silently forked off the group key
 * with nothing to replay it. Group TEXT already solved this: a per-peer
 * outbox row written before the submit, and HTTP where a 200 is a real
 * accept. Key material takes the identical path — same sealed pairwise
 * envelope, same relay endpoint, no new wire format and no server change.
 *
 * The row stores ONLY the ECIES-sealed outer envelope (never `sealedBody`),
 * so no group key is duplicated at rest beyond `group_master_keys`.
 */
const deliverGroupAdminEnvelope = async (args: {
  peer: SessionAddress;
  cert: string;
  certExpSec?: number;
  ct: Ciphertext;
  clientMsgId: string;
  groupId: string;
}): Promise<void> => {
  const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
    ownStore,
    keys,
    args.peer,
    peerIdentityCache,
    PEER_IDENTITY_TTL_MS,
  );
  const outerSealed = await wrapOuter({
    recipientIdentityKeyB64: recipientIdKeyB64,
    sender: ownAddress,
    ciphertext: args.ct,
    cert: args.cert,
  });
  if (sqlOutbox) {
    try {
      await sqlOutbox.enqueue({
        clientMsgId: args.clientMsgId,
        // Why: namespaced so "Clear chat" (deleteByConversation) can't drop a
        // pending key row, and so the drain's bubble updates never match.
        conversationId: `groupkey:${args.groupId}`,
        messageId: args.clientMsgId,
        peerUserId: args.peer.userId,
        peerDeviceId: args.peer.deviceId,
        payload: JSON.stringify({
          outerSealed,
          certExpSec: args.certExpSec,
          keyMaterial: true,
          urgent: false,
        }),
      });
    } catch (e) {
      console.warn('[group-admin.outbox] enqueue failed:', asErrorMessage(e));
    }
  }
  try {
    await relay.send({
      recipient: args.peer,
      outerSealed,
      clientMsgId: args.clientMsgId,
      urgent: false,
    });
    if (sqlOutbox) {
      sqlOutbox
        .markDelivered(args.clientMsgId, args.peer.userId, args.peer.deviceId)
        .catch(e => console.warn('[group-admin.outbox] markDelivered failed:', asErrorMessage(e)));
    }
  } catch (e) {
    if (sqlOutbox) {
      sqlOutbox
        .recordAttempt(args.clientMsgId, args.peer.userId, args.peer.deviceId, {
          unreachable: isUnreachableError(e),
        })
        .catch(err =>
          console.warn('[group-admin.outbox] recordAttempt failed:', asErrorMessage(err)),
        );
    }
    throw e;
  }
};
```

`SessionAddress`, `Ciphertext`, `wrapOuter`, `recipientIdentityKeyB64Cached`, `peerIdentityCache`, `PEER_IDENTITY_TTL_MS`, `isUnreachableError`, `asErrorMessage`, `relay`, `sqlOutbox` are all already in scope in this factory — no new imports.

### F2. Ten call sites — swap the WS-swallow closure for the helper

Each site currently does `certCache.get()`. Change to `certCache.getIssued()` so `certExpSec` can be persisted (`IssuedCert` = `{cert, expiresAt}`; `getIssued` is `packages/messenger-core/src/runtime/certCache.ts:57`).

**(a) `reshareGroupKeyState`** — anchor:

```ts
const cert = await certCache.get();
// G-05 — owner signs fresh; a member relays the persisted owner signature.
```

→

```ts
const issuedCert = await certCache.getIssued();
const cert = issuedCert.cert;
// G-05 — owner signs fresh; a member relays the persisted owner signature.
```

and its `deliver` body — anchor:

```ts
        deliver: async (peer, ct, clientMsgId) => {
          try {
            const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
              ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
            );
            const outerSealed = await wrapOuter({
              recipientIdentityKeyB64: recipientIdKeyB64,
              sender:                  ownAddress,
              ciphertext:              ct,
              cert,
            });
            try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
            catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-reshare:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
```

→

```ts
        deliver: async (peer, ct, clientMsgId) => {
          try {
            await deliverGroupAdminEnvelope({
              peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId,
              groupId: state.groupId,
            });
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-reshare:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
```

**(b) `sendKeyRequest`** — identical shape; the block is uniquely identified by its warn tag `'[group-key-request:runtime] delivery failed'`. Same replacement with `groupId` (the function parameter) and `certExpSec: issuedCert.expiresAt`; change its `const cert = await certCache.get();` the same way.

**(c) leave-triggered rekey `deliverFn`** — anchor:

```ts
const deliverFn = async (
  peer: SessionAddress,
  ct: Ciphertext,
  clientMsgId: string,
): Promise<void> => {
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
    cert,
  });
  try {
    transport.send({
      event: 'envelope.send',
      data: {to: peer, outerSealed, clientMsgId, urgent: false},
    });
  } catch {
    await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
  }
};
```

→

```ts
const deliverFn = async (
  peer: SessionAddress,
  ct: Ciphertext,
  clientMsgId: string,
): Promise<void> => {
  await deliverGroupAdminEnvelope({
    peer,
    cert,
    certExpSec: issuedCert.expiresAt,
    ct,
    clientMsgId,
    groupId: cur.groupId,
  });
};
```

**(d) `createGroupChat`** — anchor the whole `deliver:` closure that begins `console.log('[group-create:runtime] deliver →', peer.userId, '/', peer.deviceId);`. Replace its body between the `try {` and the `delivered += 1;` with a single `await deliverGroupAdminEnvelope({peer, cert, certExpSec: issuedCert.expiresAt, ct, clientMsgId, groupId: state.groupId});`. Keep the surrounding `try/catch` that pushes to `failures` and the `delivered += 1;`. Keep the `console.log('[group-create:runtime] sent via …')` lines dropped (they described the WS/HTTP branch that no longer exists).

**(e) ops-room bootstrap** (`bootstrapAssignedGroup`, warn tag `'[ops-room:bootstrap]'`) — same swap, `groupId: state.groupId`.

**(f) `removeGroupMember` `deliverFn`** — anchored by the preceding `const plan = planRemoveAndRekey(cur, removedUserId);`. Replace the body with:

```ts
const deliverFn = async (
  peer: SessionAddress,
  ct: Ciphertext,
  clientMsgId: string,
): Promise<void> => {
  try {
    await deliverGroupAdminEnvelope({
      peer,
      cert,
      certExpSec: issuedCert.expiresAt,
      ct,
      clientMsgId,
      groupId,
    });
  } catch (e) {
    throw new Error(asErrorMessage(e));
  }
};
```

**(g) `leaveGroup` `deliverFn`** — same replacement, `groupId`.

**(h) `addGroupMember` `deliverFn`** — anchored by the preceding `const plan = planAddAndRekey(cur, newMember);`. Same replacement as (f).

**(i) + (j) `ensureCallGroupKey`** resync (`'[call-adhoc-key:runtime] resync delivery failed'`) and mint (the `failures.push(\`${peer.userId}: ${asErrorMessage(e)}\`)`closure after`const state = makeNewGroup({name: 'Call'`) — same swap, `groupId: existing.groupId`and`groupId: state.groupId` respectively.

**Explicitly NOT changed:** `broadcastGroupCallPresence` (`:3525`) is ephemeral presence, not key material — a stale queued presence frame is worse than a dropped one. `setResendSignalHandler`'s text retransmit (`:2272`) belongs to the OM/text family. The 1:1 text WS path (`:2936`) already has the ack watchdog + outbox and is untouched.

### F3. `src/modules/messenger/runtime/productionRuntime.ts` — `drainOutbox` learns key rows

Anchor:

```ts
let payload: {
  outerSealed?: string;
  expiresAtSec?: number;
  certExpSec?: number;
} & Partial<DeferredOutboxPayload>;
```

→

```ts
let payload: {
  outerSealed?: string;
  expiresAtSec?: number;
  certExpSec?: number;
  keyMaterial?: boolean;
  urgent?: boolean;
} & Partial<DeferredOutboxPayload>;
```

Anchor (inside the SN-06 stale-cert branch):

```ts
          if (isStoredCertStale(payload.certExpSec)) {
            // No crypto context on this drain — leave the row for one that has
            // it, exactly as the deferred branch above does.
            if (!reseal) { continue; }
```

→

```ts
          if (isStoredCertStale(payload.certExpSec)) {
            // GF-2 — a key-material row deliberately persists no re-mintable
            // body (we never duplicate the group key at rest), so a dead cert
            // means the recipient destroys it before decrypt. Shipping it is
            // the silent loss SN-06 exists to prevent: drop the row and let the
            // receive-side key-request self-heal re-solicit the key.
            if (payload.keyMaterial) {
              console.warn(`[messenger.outbox] dropping stale-cert key row ${row.clientMsgId}`);
              await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
              continue;
            }
            // No crypto context on this drain — leave the row for one that has
            // it, exactly as the deferred branch above does.
            if (!reseal) { continue; }
```

Anchor (the submit + bubble updates):

```ts
        const r = await relay.send({
          recipient:    {userId: row.peerUserId, deviceId: row.peerDeviceId},
          outerSealed,
          clientMsgId:  row.clientMsgId,
          expiresAtSec,
        });
        // Success — flip UI + drop the row. updateMessageStatus is
        // idempotent if the original send already flipped to 'sent'
        // (e.g. WS path won the race).
        useMessengerStore.getState().updateMessageStatus(
          row.conversationId, row.messageId, 'sent',
        );
        if (r.retractToken) {
```

→

```ts
        const r = await relay.send({
          recipient:    {userId: row.peerUserId, deviceId: row.peerDeviceId},
          outerSealed,
          clientMsgId:  row.clientMsgId,
          expiresAtSec,
          urgent:       payload.urgent,
        });
        // GF-2 — a key-material row has no bubble; the store updates below
        // would only fire notifyBackupDirty on a messageId the mirror can't
        // resolve.
        if (payload.keyMaterial) {
          await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
          continue;
        }
        // Success — flip UI + drop the row. updateMessageStatus is
        // idempotent if the original send already flipped to 'sent'
        // (e.g. WS path won the race).
        useMessengerStore.getState().updateMessageStatus(
          row.conversationId, row.messageId, 'sent',
        );
        if (r.retractToken) {
```

`urgent: payload.urgent` is `undefined` for every pre-existing text row → `JSON.stringify` drops the key → the server DTO default (urgent) applies → byte-identical behaviour for the existing queue. No upgrade hazard.

### Schema / migration / wire format

- **No migration.** The `outbox` DDL (`src/modules/messenger/crypto/db.ts:204-216`) is unchanged; `conversation_id` and `message_id` are plain `TEXT NOT NULL` with no FK, and the PK is already the composite `(client_msg_id, peer_user_id, peer_device_id)` needed for per-peer key rows. `SCHEMA_VERSION` stays **14**.
- **No wire change.** The envelope bytes, the sealed-sender AAD, the sender-cert binding and `POST /envelopes` are all untouched. Old peers cannot tell the difference — a receiver sees the identical sealed envelope, only routed through the HTTP submit instead of the WS submit. Both funnel into the same `EnvelopeService.submitEnvelope` (`apps/messenger-service/src/relay/envelope.service.ts:261` still does `tryFanOut`, so a connected recipient is still pushed live — no added latency).
- **Server deploy ordering: none required.** Client-only change.

### Architecture-gate compliance (batch constraint #4, GF-2/SYNC-2 — ALLOWED-WITH-CONSTRAINT)

1. One sealed pairwise envelope per recipient, O(N), no aggregation — unchanged (`broadcastToGroup` still loops `targets`; we do **not** add a batch endpoint, see #11 FORBIDDEN).
2. No new server endpoint or table — none added.
3. `create` / `key-request` remain the only unwrapped kinds — untouched (`groupClient.ts:164` `skipGroupKey`).
4. Key material at rest: the outbox row holds only `outerSealed` (ECIES-to-recipient). `sealedBody` is deliberately **not** persisted for key rows, so no group key is duplicated at rest. Nothing new is logged; the new `console.warn`s carry only `clientMsgId` / peer ids and contain zero banned identifiers (`src/modules/messenger/__tests__/logAudit.test.ts:20-40`).
5. Epoch monotonicity: a retry cannot re-emit a stale-epoch key. `applyAdminAction` gates `add`/`remove`/`rekey`/`rename` on `if (action.atEpoch !== state.epoch) {return state;}` (`packages/messenger-core/src/groups/groupClient.ts:485/509/517/524`), and the `create` receive path drops replays: `productionRuntime.ts:6956` `DROP stale/replayed create … epoch ${action.state.epoch} < local ${existing.epoch}`. Neither is weakened. The B-42/fail-closed local rotate (`:3956`, `:4258`) is untouched.

## Blast radius

**Files edited:** `src/modules/messenger/runtime/productionRuntime.ts` only.

**Functions:** `reshareGroupKeyState`, `sendKeyRequest`, the leave-rekey signal handler, `createGroupChat`, the ops-room bootstrap, `removeGroupMember`, `leaveGroup`, `addGroupMember`, `ensureCallGroupKey`, `drainOutbox`. New: `deliverGroupAdminEnvelope`.

**Behavioural deltas a reviewer must accept:**

- Group admin/key fan-out moves from a WS emit to N HTTP submits. `POST /envelopes` is throttled at **30 requests / 10 s per user** (`apps/messenger-service/src/relay/envelope.controller.ts:67`). A create/rekey across a >30-member roster will now 429 some peers. **This is a feature of the fix, not a regression:** a 429 leaves the outbox row, and the drain retries with backoff, whereas today those peers were silently lost. It does, however, mean GF-2 and **GF-1/SRV-01 (raise the flat per-user throttle — verdict ALLOWED)** should ship together; ordering: GF-1 first, or GF-2 alone with the drain covering the shortfall.
- Group admin ops get slower on large rosters (N sequential-ish HTTP RTTs at `FANOUT_CONCURRENCY = 8`, `groupClient.ts:265`) instead of N fire-and-forget emits. Group text already pays this cost.
- Failure surfaces that were previously dark now fire: `createGroupChat` can throw `no member could be reached` where a zombie socket used to "succeed"; `removeGroupMember`/`addGroupMember` can now surface `store.setError('Group key update reached no members…')`; `ensureCallGroupKey` can now fail closed on a call escalation. **These are correct** — they were always the real outcome, just invisible. Expect a visible uptick in error banners on bad networks; that is the bug becoming honest.

**Overlapping findings:**

- **GF-3** (decrypt-failure self-heal / key-request cooldown) edits `sendKeyRequest` and `reshareGroupKeyState` — the same two functions. Sequence GF-2 first (it only replaces the `deliver` closure body) then GF-3 (which changes the trigger/cooldown logic).
- **GF-1 / SRV-01** — the throttle interaction above.
- **OM-05 / SN-06** — shares `drainOutbox`'s stale-cert branch; both edits are in the same `if (isStoredCertStale(...))` block. Coordinate.
- **SYNC-2** is the same finding under a different label; this spec covers it.

**What could regress:**

- `deleteByConversation` (Clear chat) and `deleteByClientMsgId` (tap-to-retry): key rows use the `groupkey:` namespace and a synthetic `messageId`, so neither can reach them. Verify.
- `allMessageIds()` (`sqlOutboxStore.ts:102`) feeds the MSG-07 boot sweep that flips hydrated `sending` bubbles with no row to `failed`. Key rows add ids that match no bubble — a superset, so the sweep only becomes _more_ conservative. Safe.
- The backup mirror is untouched: the messenger send outbox is a different table from the mirror outbox (`src/modules/messenger/backup/messageMirror.ts:318`). BACKUP_LOOP I1–I9 are not in play — but the `payload.keyMaterial` early-`continue` in the drain exists precisely to keep `notifyBackupDirty` from being called with an unresolvable messageId.
- Sender-cert freshness: unlike text rows, key rows carry no re-mintable body, so a long-offline queue drops them rather than re-seals. That is a deliberate trade (no key at rest) and relies on the GF-3 self-heal for the tail.

## Tests

Jest project **`messenger-crypto`** (`npm run test:crypto`), test dir `src/modules/messenger/__tests__/`.

**New — `src/modules/messenger/__tests__/groupKeyFanoutDurability.test.ts`**
Reuse `makeParty` from `./fixtures` and the fake-`DbHandle` engine pattern from `sqlOutboxStore.test.ts` (extend it to understand the `groupkey:` conversation delete). Wire `broadcastToGroup` (from `../groups`) with a `deliver` that mirrors `deliverGroupAdminEnvelope`: enqueue → fake relay → markDelivered / recordAttempt.

1. `deliver` counts a peer only when the fake relay resolves — a relay that **rejects** for peer B must leave `recipients === 1` for a 3-party group (proves the zombie-socket lie is gone: there is no code path that counts a non-200).
2. After that fan-out the outbox holds exactly **one** pending row, keyed `(clientMsgId, B, 1)`; peer A's row is gone.
3. A replay of that row against a now-healthy relay delivers and `dueRows()` returns `[]`.
4. The replayed `create` applied twice on B's state is idempotent, and a replayed `rekey` whose `atEpoch` is now stale is an inert no-op (`applyAdminAction` returns the same object) — the epoch guard survives retry.
5. `deleteByConversation(groupId)` leaves the `groupkey:${groupId}` row intact.

**Extend — `src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** 6. Add case: a row on `conversation_id = 'groupkey:G1'` is not removed by `deleteByConversation('G1')`.

**Extend — `src/modules/messenger/__tests__/outboxCertFreshness.test.ts`** 7. `isStoredCertStale` is unchanged; add a documentation-style assertion that `certExpSec === undefined` stays `false` (the existing-queue upgrade path the new key rows also rely on).

**Regression (must run, in this order):**

- `npx jest --selectProjects messenger-crypto -t group` (fast signal: `groupBroadcast`, `groupRekeyConverge`, `groupSelfHeal`, `groupCreateEpochBootstrap`, `bootGroupStashDrain`, `groupPlaintextReject`).
- `npm run test:crypto` (full `messenger-crypto` + `packages/messenger-core/__tests__`), including `logAudit.test.ts`.
- `npm test` (all three projects).
- `npm run typecheck` — must not exceed `.tsc-baseline.json` (**47**).

**Device smoke (cannot be done in CI, state it explicitly if skipped):** 3 devices, group of 3 — (a) create group with device B in airplane mode, restore network, confirm B receives the key on the drain without a manual rejoin; (b) add a 4th member, then kill device A between step 1 and step 2, relaunch, confirm the queued envelopes drain in order; (c) remove a member and confirm the removed device can no longer decrypt while the remaining two can.

## Risk

Things a reviewer should be suspicious of:

1. **Throttle cliff.** 30 req/10 s is the hard number. A 30+ member group create now partially 429s on the first attempt. Confirm the drain actually recovers it and that 429 is _not_ matched by `isUnreachableError` (`sqlOutboxStore.ts:74`) — it is not, so it consumes the 10-attempt budget. With backoff 1s/4s/15s/60s/5m×6 that is ~30 minutes of runway; check that is enough for your worst roster, or ship GF-1 first.
2. **Step-1/step-2 inversion (NOT fixed here — deliberate).** `add`+`rekey` and `remove`+`rekey` are two broadcasts. If step 1 fails for peer P but step 2 succeeds, P receives a `rekey` at an epoch it hasn't reached → `applyAdminAction` no-ops it → P stays on the old key even after the drained `add` arrives. This is **pre-existing** and is not made worse (today the same split happens), but the outbox makes it _look_ recoverable when it is not. The correct follow-up is an ordered per-(peer,group) admin queue, or excluding step-1 failures from the step-2 live fan-out. Track it separately; do not let this spec claim it.
3. **Key material at rest.** Confirm no reviewer "helpfully" adds `sealedBody` to the key row payload to enable re-seal. That would put the group master key in a second table with a lifetime independent of `group_master_keys` and survive a rotation — a forward-secrecy regression. The stale-cert drop is the intended cost.
4. **Latency-sensitive path.** `ensureCallGroupKey` now blocks on N HTTP RTTs before a call can go live. On a bad link this could push call setup past the ring window. Measure; if it hurts, the mitigation is to keep the live submit but _also_ keep the outbox row until the 200 lands (i.e. do not go back to WS-first).
5. **`certCache.getIssued()` swap.** It must return the SAME cert string that `broadcastToGroup` sealed the payload with — the cert is bound into the outer AAD (`wrapOuter({..., cert})`). Each site must capture `issuedCert` once, before `broadcastToGroup`, and pass `issuedCert.cert` as the `cert` param. A reviewer should check no site calls `getIssued()` inside the `deliver` closure, which could hand back a refreshed cert and break the AAD binding.
6. **Silent no-op if `sqlOutbox` is null.** The helper degrades to "HTTP-only, no durability" when the DB is not yet open (pre-unlock boot). That is strictly better than today, but it means the durability guarantee is not absolute — confirm the group-admin entry points are all gated behind an unlocked store.
