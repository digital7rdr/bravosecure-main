# SYNC-2 — Group key/state fan-out is fire-and-forget, so the fail-closed epoch rotate strands members

## Verdict

**CONFIRMED-WITH-DRIFT.** The defect is real and present. Drift: (a) the line numbers moved (~3940–3960
and a _second, identical_ rotate at ~4241–4258); (b) the audit's "server-side twin" framing and its
`apps/messenger-service` file hint are **wrong** — nothing in the relay needs to change; the relay
already stores-and-forwards with 30-day dwell. The whole defect and the whole fix are client-side.

Evidence from the current tree:

1. `src/modules/messenger/runtime/productionRuntime.ts:3940-3949` — the epoch rotate is gated on
   nothing durable:
   ```ts
   let rekeyDelivered = await fanOutRekey();
   // B-10 — 0-peer redistribution: do NOT silently proceed. Retry once
   // before the new epoch takes effect, then surface if still 0.
   if (rekeyDelivered === 0) {
     rekeyDelivered = await fanOutRekey();
   }
   if (rekeyDelivered === 0) {
     store.setError('Group key update reached no members — they may miss new messages until they refetch');
   ```
   …then `const stateAfterRekey = applyAdminAction(stateAfterRemove, plan.rekey, ownAddress.userId);
store.setGroupState(stateAfterRekey);` runs unconditionally. Same shape again at `:4241-4258`
   (`addGroupMember`).
2. `delivered` is incremented by a fire-and-forget WS emit. `productionRuntime.ts:3930-3932`:
   ```ts
   deliver: async (peer, ct, clientMsgId) => {
     try { await deliverFn(peer, ct, clientMsgId); delivered += 1; }
   ```
   and `deliverFn` (`:3858-3879`) ends with
   `try { transport.send({event: 'envelope.send', data: {...}}); } catch { await relay.send(...); }`.
3. `packages/messenger-core/src/transport/client.ts:319-326` — `send()` throws **only** on
   `!this.socket?.connected`, then `this.socket.emit(...)` with no ack:
   ```ts
   send(frame: ClientFrame): void {
     if (!this.socket?.connected) {
       throw new Error('transport not open');
     }
     this.socket.emit(frame.event, (frame as {data?: unknown}).data ?? {});
   ```
   A half-dead socket (Doze, dead NAT binding, deploy-time drop) reports `connected === true`, buffers
   the frame, never ships it — and `delivered += 1` fires. No outbox row exists, so nothing ever retries.
4. Contrast the group **text** path, which already got this right:
   `productionRuntime.ts:2600-2646` enqueues a per-peer `sqlOutbox.enqueue({...})` row _before_
   shipping and then uses HTTP: _"Group fan-out always uses HTTP. The WS path here used to increment
   `delivered` on a pure transport.send() (no ack) — half-dead sockets that buffered the frame but
   never shipped it would fool us into flipping to 'sent'…"_. **Key material is the only group traffic
   still on the lane that comment describes as broken.**
5. The read-side backstop is dead: GF-3 confirms `requestGroupKeyResyncImpl` skips any group that still
   holds _any_ master key (`productionRuntime.ts:~2130`), i.e. exactly the post-missed-rekey case.

## Mechanism

1. Admin removes/adds a member. `removeGroupMember` (or `addGroupMember`) runs the two-step plan under
   `runWithGroupAdminLock`.
2. Step 2 fans the `rekey` admin envelope out via `broadcastToGroup`. Each per-peer copy is handed to
   `deliverFn`, which wraps it and calls `transport.send(...)`.
3. Member M's device is Dozed / on a stale cellular binding / mid-deploy. The socket object still reads
   `connected === true`. `emit` buffers into socket.io's internal queue and the frame dies with the
   connection.
4. `deliverFn` returns normally → `delivered += 1` → `rekeyDelivered > 0` → no retry, no error banner.
5. The sender rotates locally: `applyAdminAction(...)` → `store.setGroupState(stateAfterRekey)` →
   `disposeGroupKey(cur.masterKeyB64)`. Epoch is now E+1 with a new master key. **This is correct and
   must stay** (the removed member must not keep reading), but it is now unrecoverable for M.
6. Nothing persists the undelivered rekey. There is no outbox row, so neither the reconnect drain
   (`:1601`), the boot drain (`:1134`), nor the 60s timer drain (`:1613`) knows it exists.
7. M reconnects. It never receives the rekey. Every subsequent group message from anyone is wrapped
   under E+1's key. `parseGroupMessage` returns `{ok:false, reason:'no_key'}` → stashed in
   `pendingGroupEnvelopeStore` → deleted after 3 boots (GF-3). M's thread goes permanently silent while
   every other member sees the messages as delivered.
8. Same mechanism, no rotate involved, for `create` (initial key distribution), `add`, `leave`, the
   member-driven `leave`-rekey handler, and the reshare/key-request self-heal — all nine admin fan-out
   sites use the identical `transport.send`-then-`relay.send`-on-throw shape.

## Fix

**Design:** make key-material fan-out use the _exact_ durability contract the group-text path already
uses — enqueue a per-peer outbox row, ship over HTTP for a real 200, delete the row on accept, leave it
for the backoff drain otherwise. The fail-closed rotate then stays byte-for-byte as it is, because every
intended recipient now provably holds either a relay 200 or a durable retry row.

Nothing about key derivation, epoch monotonicity, the `create`/`key-request` unwrapped exception,
`verifySenderCert`, or `verifySealedAad` changes. No wire-format change: the bytes the relay sees are
identical to what `broadcastToGroup` already produces today. No server change. No schema change (the
`outbox` table and the `kind: 'text' | 'admin'` deferred-payload discriminator already exist).

Architecture note: cleared by batch memo §4 (ALLOWED-WITH-CONSTRAINT) — one sealed pairwise envelope per
recipient, no aggregation, no new server endpoint/table, key material at rest only in SQLCipher, never
logged.

---

### File 1 — `packages/messenger-core/src/groups/groupClient.ts`

The runtime cannot build a deferred outbox row without `sealedBody`, which `broadcastToGroup` computes
internally (and which encodes the `skipGroupKey` rule for `create`/`key-request`). Re-deriving it in the
runtime would duplicate that rule and mint a different `clientMsgId`. Pass it out instead — additive
4th argument, so every existing 3-arg `deliver` callback stays assignable.

**Anchor A** (in `BroadcastParams`):

```ts
deliver: (recipient: SessionAddress, ciphertext: Ciphertext, clientMsgId: string) =>
  Promise<void | {envelopeId?: string}>;
```

**Replacement:**

```ts
deliver: (
  recipient: SessionAddress,
  ciphertext: Ciphertext,
  clientMsgId: string,
  meta: BroadcastDeliverMeta,
) => Promise<void | {envelopeId?: string}>;
```

**Insertion** — immediately above `export interface BroadcastParams {`:

```ts
/**
 * Per-recipient context handed to `deliver` alongside the ciphertext.
 *
 * Why: a host that persists an outbox row for redelivery needs the exact inner
 * body that was sealed (group-key-wrapped, or plaintext for `create` /
 * `key-request`) so it can re-seal to the same peer later without re-deriving
 * the wrap rule.
 */
export interface BroadcastDeliverMeta {
  sealedBody: string;
  kind: 'text' | 'admin';
  expiresAtSec?: number;
}
```

**Anchor B** (inside `sendOne`):

```ts
const out = await params.deliver(peer, ct, clientMsgId);
```

**Replacement:**

```ts
const out = await params.deliver(peer, ct, clientMsgId, {sealedBody, kind, expiresAtSec});
```

Export it from `packages/messenger-core/src/groups/index.ts` and `packages/messenger-core/src/index.ts`
next to the existing `BroadcastParams` / `BroadcastResult` type exports.

**Back-compat:** none needed — this is a compile-time-only, host-local callback. Ops-console's
`groupClientAdapter.ts` / `MissionGroupPanel.tsx` callbacks take 3 params and remain valid TypeScript.
No wire field, no persisted field, no peer-visible change.

---

### File 2 — `src/modules/messenger/runtime/productionRuntime.ts`

**2a. New factory-scoped helper.** Insert directly after `resealDeferredGroupRow` (which ends with
`return {outerSealed, expiresAtSec: payload.expiresAtSec};\n  };`, ~line 812) so it sees `own`, `keys`,
`ownStore`, `ownAddress`, `certCache`, `relay`, `peerIdentityCache`, `sqlOutbox`:

```ts
// SYNC-2/GF-2 — durable delivery for group KEY/STATE envelopes.
//
// Why: `transport.send` only throws when the socket object is closed, so a
// half-dead socket swallows a rekey while the caller counts it delivered —
// and the fail-closed local rotate then strands that member with no retry
// path. Group TEXT already solved this (enqueue-then-HTTP); key material now
// uses the same contract, so the rotate below it is safe.
const deliverGroupAdminDurable = async (
  peer: SessionAddress,
  ct: Ciphertext,
  clientMsgId: string,
  meta: {sealedBody: string; kind: 'text' | 'admin'; expiresAtSec?: number},
  groupId: string,
  issued: {cert: string; expiresAt: number},
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
    cert: issued.cert,
  });
  if (sqlOutbox) {
    await sqlOutbox.enqueue({
      clientMsgId,
      conversationId: groupId,
      messageId: `admin:${clientMsgId}`,
      peerUserId: peer.userId,
      peerDeviceId: peer.deviceId,
      payload: JSON.stringify({
        outerSealed,
        expiresAtSec: meta.expiresAtSec,
        certExpSec: issued.expiresAt,
        sealedBody: meta.sealedBody,
        groupId,
        kind: meta.kind,
        clientMsgId,
      }),
    });
  }
  try {
    await relay.send({
      recipient: peer,
      outerSealed,
      clientMsgId,
      expiresAtSec: meta.expiresAtSec,
    });
    if (sqlOutbox) {
      sqlOutbox
        .markDelivered(clientMsgId, peer.userId, peer.deviceId)
        .catch(e =>
          console.warn('[messenger.outbox] admin markDelivered failed:', asErrorMessage(e)),
        );
    }
  } catch (e) {
    if (sqlOutbox) {
      sqlOutbox
        .recordAttempt(clientMsgId, peer.userId, peer.deviceId, {
          unreachable: isUnreachableError(e),
        })
        .catch(err =>
          console.warn('[messenger.outbox] admin recordAttempt failed:', asErrorMessage(err)),
        );
    }
    throw e;
  }
};
```

Notes on the choices, so a reviewer does not have to reverse-engineer them:

- `messageId: 'admin:' + clientMsgId` is synthetic. `outbox.message_id` is `NOT NULL`, and the drain's
  `updateMessageStatus` / `updateMessageEnvelopeId` are both `find`-then-mutate no-ops when the id
  matches nothing (`messengerStore.ts:730-733`), so no phantom bubble appears.
- `conversationId: groupId` matches the group-text convention and keeps
  `deleteForConversation` semantics coherent.
- Enqueue is `await`ed and **not** swallowed: for key material, a failed durable write must fail the
  peer loudly rather than ship undurably. It surfaces through the caller's existing
  `rekeyFailures` / `failures` array.
- HTTP-only (no `transport.send`) — that is what buys the real accept. This is the same trade the
  group-text path already made.

**2b. Adopt at every admin fan-out site.** Each site's local `deliverFn` / inline `deliver` closure is
replaced. Pattern, shown for the rekey step in `removeGroupMember`:

_Anchor_ (the `deliverFn` at ~`:3858`, the whole `const deliverFn = async (peer: SessionAddress, ct:
Ciphertext, clientMsgId: string): Promise<void> => { … };` block, plus its sibling
`const cert = await certCache.get();` at ~`:3846`):

_Replacement:_

```ts
const issued = await certCache.getIssued();
const cert = issued.cert;
const sessionLike = own;
const deliverFn = async (
  peer: SessionAddress,
  ct: Ciphertext,
  clientMsgId: string,
  meta: BroadcastDeliverMeta,
): Promise<void> => {
  await deliverGroupAdminDurable(peer, ct, clientMsgId, meta, groupId, issued);
};
```

and each `deliver:` wrapper gains the 4th arg it forwards:

```ts
            deliver: async (peer, ct, clientMsgId, meta) => {
              try { await deliverFn(peer, ct, clientMsgId, meta); delivered += 1; }
              catch (e) { rekeyFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
            },
```

Sites to convert, all in `productionRuntime.ts` (locate by the `transport.send({event: 'envelope.send'`

- `catch { await relay.send(` pair — there are nine):

| #   | Function                                      | approx line        | admin action                         |
| --- | --------------------------------------------- | ------------------ | ------------------------------------ |
| 1   | `createGroupChat`                             | 3617               | `create`                             |
| 2   | dept/ops group provisioning                   | 3768               | `create`                             |
| 3   | `removeGroupMember` step 1                    | 3858 (`deliverFn`) | `remove`                             |
| 4   | `removeGroupMember` step 2                    | 3930               | `rekey` **(SYNC-2's cited site)**    |
| 5   | `leaveGroup`                                  | 4018 (`deliverFn`) | `leave`                              |
| 6   | `addGroupMember` step 1                       | 4123 (`deliverFn`) | `add`                                |
| 7   | `addGroupMember` step 2                       | 4231               | `rekey` **(SYNC-2's second rotate)** |
| 8   | leave-observer auto-rekey                     | 2175 (`deliverFn`) | `rekey`                              |
| 9   | reshare (`isOwnerReshare`) / `sendKeyRequest` | 4357 / 4464        | `create` / `key-request`             |

**Explicitly OUT of scope:** the ad-hoc **call**-key distribution inside `ensureCallGroupKey`
(`~:4440-4520`, `[call-adhoc-key:runtime]`). That path is ephemeral — it already fails closed by
throwing when `delivered === 0`, and a drained redelivery ten minutes after the call ended is useless
noise. Leave it on the current lane; say so in the PR description.

**2c. Surface a terminally-failed key row.** In `drainOutbox`, inside the existing `if (failed) {` block,
before the `cur?.status === 'sending'` check:

_Anchor:_

```ts
        if (failed) {
          // L17 — don't DOWNGRADE a bubble that already reached at least one
```

_Insertion (first statement inside the block):_

```ts
        if (failed) {
          if (payload.kind === 'admin') {
            useMessengerStore.getState().setError(
              'A group key update could not be delivered to a member — ask them to reopen the chat',
            );
          }
          // L17 — don't DOWNGRADE a bubble that already reached at least one
```

`payload` is already in scope there and `kind` is already on `DeferredOutboxPayload`.

**2d. No other drain change is needed.** Admin rows written by 2a are _non-deferred_ rows carrying
`outerSealed` + `certExpSec` + `sealedBody` + `groupId` + `kind`, so they take the existing SN-06
branch: ship verbatim while the cert is fresh, otherwise re-mint through `resealDeferredGroupRow`, which
already handles `kind: 'admin'` (`:794` — `group: {groupId: payload.groupId, kind: payload.kind,
clientMsgId: payload.clientMsgId}`).

**Re-seal correctness for a rekey row.** `sealedBody` is the AES-GCM-wrapped inner envelope produced
under the **pre-rotation** master key (`groupClient.ts:157-160`). Re-sealing hours later re-wraps those
same already-encrypted bytes with a fresh pairwise ratchet message, a fresh cert and a fresh
`aad.ts`; the recipient still holds the old key and decrypts. Replay is a no-op:
`applyAdminAction` returns `state` unchanged when `action.atEpoch !== state.epoch`
(`groupClient.ts:468/489/506`), and the relay dedups on `(recipient, clientMsgId)`.

**Known, accepted gap (state it in the PR, do not silently paper over it):** `resealDeferredGroupRow`
does not stamp `aad.epoch`, while the live `broadcastToGroup` path does
(`groupClient.ts:~230`). This is inert today — `expectedEpoch` is passed by **no** call site in the tree
(`grep expectedEpoch` hits only the definition in `sealedSender.ts:430/519` and a unit test), so nothing
enforces it. Do **not** "fix" it by weakening the check; if you want parity, add `epoch` to the deferred
payload and stamp it in the reseal. That is a separate, optional hardening.

---

### Schema / migration

**None.** `outbox` already exists with the right shape and composite PK
(`src/modules/messenger/crypto/db.ts:204-218`), and `SCHEMA_VERSION` stays at 14. Admin rows are just
additional rows in that table. Key material at rest lands in the same SQLCipher DB that already stores
`masterKeyB64` via `groupMasterKeyStore` / `messengerStore` write-through — no new at-rest exposure class.

### Wire format

**Unchanged.** Same `POST /envelopes` body, same sealed-sender shape, same AAD binding. Old peers and the
already-deployed relay see exactly what they see today. The only observable difference is that key
envelopes now arrive over HTTP instead of WS, and may arrive later (on a drain) instead of never.

## Blast radius

**Files edited**

- `packages/messenger-core/src/groups/groupClient.ts` — `BroadcastParams.deliver` signature +
  `BroadcastDeliverMeta` + one call-site line in `sendOne`.
- `packages/messenger-core/src/groups/index.ts`, `packages/messenger-core/src/index.ts` — type export.
- `src/modules/messenger/runtime/productionRuntime.ts` — one new helper, nine deliver sites, one
  `drainOutbox` insertion.

**Callers of the changed signature:** `broadcastToGroup` is called from `productionRuntime.ts` (nine
sites, all converted) and from `apps/ops-console/src/lib/messenger/groupClientAdapter.ts` (consumed by
`MissionGroupPanel.tsx`). Ops-console's callback is 3-arity and compiles unchanged; run its
`npm run typecheck` anyway.

**Overlapping findings — coordinate, do not merge blindly:**

- **GF-2** is the _same edit_. These two audit entries are one defect described from two angles
  (GF-2 = the fire-and-forget transport; SYNC-2 = the rotate that is unsafe because of it). Ship ONE PR.
  Whichever wave picks it up owns both IDs.
- **GF-3** edits `requestGroupKeyResyncImpl` and `pendingGroupEnvelopeStore` retention in the same
  region. Complementary: GF-2/SYNC-2 stops manufacturing stranded members; GF-3 rescues the ones already
  stranded. Merge order does not matter but both touch `productionRuntime.ts` group section.
- **GF-1/SRV-01** — moving nine WS sites onto HTTP adds load against the
  `@Throttle({default: {limit: 30, ttl: 10_000}})` on `POST /envelopes`
  (`apps/messenger-service/src/relay/envelope.controller.ts:67`). This is a _net improvement_ (a 429 is
  now a durable retry instead of a silent loss) but it makes GF-1 fire more often on large groups. If
  GF-1's blind limit raise ships, ship it first or same-PR.
- **XO-1/SN-06** own `drainOutbox`'s cert-freshness branch; 2c inserts into the same function.
- **SYNC-1** edits the fan-out `results[]`/envelopeId persistence a few hundred lines up in the group
  **text** send. Different function, adjacent file region.

**What could regress**

- Group create / add / remove latency: HTTP per-peer round trip instead of a fire-and-forget emit. The
  group-text path already pays this and `broadcastToGroup` fans out at `FANOUT_CONCURRENCY = 8`.
- `deleteForConversation` (`DELETE FROM outbox WHERE conversation_id = ?`) now also drops pending admin
  rows for that group. Acceptable (the user cleared the conversation) but new behaviour.
- The MSG-07 boot sweep (`allMessageIds`) now sees `admin:*` ids. Harmless — it only _protects_ ids from
  being flipped to failed.
- `rekeyDelivered === 0` now means "not even the relay accepted it", which is strictly rarer than today.
  The existing double-fan-out retry becomes near-redundant; leave it (harmless, and it is the B-10 fix).

## Tests

Jest project **`messenger-crypto`** (`npm run test:crypto`) covers both
`src/modules/messenger/__tests__/**` and `packages/messenger-core/__tests__/**`.

**1. `packages/messenger-core/__tests__/groupBroadcast.test.ts`** (existing — extend)

- Assert `deliver` receives a 4th arg whose `sealedBody` is byte-identical for every recipient of one
  broadcast, and whose `kind === 'admin'` for an admin action / `'text'` otherwise.
- Assert that for `admin: {type:'create'}` and `{type:'key-request'}` the `sealedBody` parses as the raw
  inner JSON (unwrapped), and for `{type:'rekey'}` it parses as a group ciphertext
  (`isGroupCiphertext`) — locks the `skipGroupKey` rule to the value the outbox will persist.

**2. `src/modules/messenger/__tests__/groupAdminOutboxDurability.test.ts`** (new — the core regression)
Follow the fake-`DbHandle` pattern from `sqlOutboxStore.test.ts`. Drive `deliverGroupAdminDurable`'s
contract with a stub relay:

- relay resolves → exactly one row enqueued per peer, then `markDelivered` removes it; store size 0.
- relay rejects → the row **survives** with `attempts === 1` and a future `next_retry_at`; the helper
  rethrows so the caller's failure tally is honest.
- relay rejects with a network-shaped error (`'Network request failed'`) → `recordAttempt` is called
  with `{unreachable: true}` (budget not burned, per SN-04).
- enqueue rejects → the helper rejects and **`relay.send` is never called** (no undurable ship).
- N-peer fan-out with the same `clientMsgId` → N independent rows (composite PK), and
  `markDelivered` for one peer leaves the other rows intact.

**3. `src/modules/messenger/__tests__/groupRekeyStranding.test.ts`** (new — the SYNC-2 assertion proper)
Simulate the zombie socket: relay `send` rejects for peer B, resolves for peer A. Assert:

- the local rotate still happens (fail-closed preserved — `groups[gid].epoch` advanced, `masterKeyB64`
  changed). **This assertion must not be relaxed.**
- a pending outbox row for peer B exists after the rotate, carrying `kind:'admin'` and the
  pre-rotation `sealedBody`.
- feeding that row through a drain with a working relay ships it, and applying the resulting admin
  action on B's state (via `applyAdminAction`) converges B to the same epoch + `masterKeyB64` as the
  admin. This is the "no stranded member" proof.
- applying the same action a second time is a no-op (idempotent replay).

**4. `packages/messenger-core/__tests__/groupRekeyConverge.test.ts`** (existing) — must still pass
unchanged; it is the convergence oracle.

**5. Static/lint gates**

- `packages/messenger-core/__tests__/logAudit.test.ts` — the new helper must not log `sealedBody`,
  `outerSealed`, or any payload; only peer ids and error messages (it currently logs neither).
- `npm run typecheck` ≤ baseline 47 (`.tsc-baseline.json`); `cd apps/ops-console && npm run typecheck`.
- `npm run test:crypto` first (fast signal), then `npm test`.

**Device probe (owed, cannot be done in CI)** — audit §Phase E item 3: remove a member while one member
is Dozed; assert on logcat that the Dozed member receives the rekey on reconnect and that the
`pendingGroupEnvelopeStore` stash is not exhausted.

## Risk

Things a reviewer should be suspicious of:

1. **Did the rotate get "fixed" into a conditional?** It must not. `applyAdminAction` +
   `setGroupState` + `disposeGroupKey` must still run unconditionally after the fan-out. If the diff
   makes rotation depend on delivery, the removed member keeps reading — that is a privacy regression
   dressed up as a reliability fix. Reject it.
2. **Enqueue-before-ship ordering.** If any converted site ships first and enqueues after, a crash in
   between reproduces the original bug. Read the helper top-to-bottom.
3. **`certCache.get()` → `getIssued()` swap.** Nine sites; a missed one silently writes rows with
   `certExpSec: undefined`, which `isStoredCertStale` deliberately reports as _fresh_
   (`outboxCertFreshness.ts:36`) — so a long-queued key row would ship with a dead cert and be destroyed
   by the recipient's `verifySenderCert` while the relay returns 200. Grep for
   `certCache.get()` in the group-admin block after the change.
4. **Unbounded key-material rows.** `MAX_ATTEMPTS` is 10 with a 5-minute cap, so a permanently offline
   peer parks one `failed` row per rekey. Confirm `resetFailed`/pruning behaviour is acceptable and that
   a chatty rekey loop cannot inflate the table.
5. **Key material at rest.** `sealedBody` for a `create` action is _plaintext group state including
   `masterKeyB64`_. It is in SQLCipher (same DB as the existing key store), which is why this is
   acceptable — but verify no code path ever writes an outbox payload anywhere else (backup mirror,
   crash log, export). Cross-check against `docs/runbooks/BACKUP_LOOP.md` I1–I9 if the mirror touches
   the `outbox` table.
6. **The nine-site conversion is mechanical and therefore error-prone.** Each site has slightly
   different failure accounting (`delivered`/`failures`/`removeFailures`/`rekeyFailures`/silent).
   Preserve each one's semantics exactly; do not unify them in this PR.
7. **The audit's `apps/messenger-service` hint.** If a diff shows up touching the relay for SYNC-2, it is
   solving a different problem (that's SYNC-3/OM-03 territory, which the architecture memo rules
   FORBIDDEN in its literal form). Nothing server-side belongs in this change.

**Honest sizing:** this is a _medium_ change, not a one-liner — one messenger-core signature, one new
runtime helper, nine call-site conversions, two new test files. The smallest correct increment that
closes SYNC-2 specifically is sites **#4 and #7 only** (the two epoch rotators) plus the helper and the
tests; the other seven sites are the same class of bug and should ride along, but can be split into a
follow-up if the reviewer wants a tighter first diff.
