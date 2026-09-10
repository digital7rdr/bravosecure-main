# XO-4 - Late outbox drain / duplicate `envelope.accepted` rewinds a `delivered`/`read` bubble back to `sent`

## Verdict

**CONFIRMED** (line numbers drifted by ~0; content matches exactly).

1. `src/modules/messenger/store/messengerStore.ts:730-741` — the store action has **no**
   ordering guard at all:
   ```ts
   updateMessageStatus: (conversationId, messageId, status) =>
     set(s => {
       const msg = s.messages[conversationId]?.find(m => m.id === messageId);
       if (msg) {msg.status = status;}
   ```
2. `src/modules/messenger/runtime/productionRuntime.ts:7482-7487` — the outbox drain flips to
   `'sent'` unconditionally, and the comment itself asserts an idempotency that the store does
   not provide:
   ```ts
   // Success — flip UI + drop the row. updateMessageStatus is
   // idempotent if the original send already flipped to 'sent'
   // (e.g. WS path won the race).
   useMessengerStore.getState().updateMessageStatus(row.conversationId, row.messageId, 'sent');
   ```
   `updateMessageStatus` is idempotent for `sent → sent`, but it is _not_ safe for
   `delivered → sent` or `read → sent`, which is exactly the surviving-sibling-row case.
3. A **second, unguarded** site with the same defect: `productionRuntime.ts:5324-5333`
   (`handleAccepted`) — `store.updateMessageStatus(entry.conversationId, entry.messageId, 'sent');`
   with no read of the current status. A late `envelope.accepted` (WS reconnect replay, or an
   accepted that races the HTTP fallback before `clearPending`) repaints an already-delivered
   bubble.
4. The guard exists _ad hoc_ at every OTHER site, proving the invariant is intended but not
   enforced centrally: `runtime/envelopeDelivered.ts:41` (`if (msg.status === 'sent')`),
   `runtime/decryptFailureSignal.ts:125` (`if (msg.status === 'sent' || msg.status === 'delivered')`),
   `productionRuntime.ts:695` (`if (msg && msg.status === 'sending')`),
   `productionRuntime.ts:7516-7518` (L17: `if (cur?.status === 'sending')`).
   The drain-success path and `handleAccepted` are the two that were missed.
5. `updateMessageStatusBulk` (`messengerStore.ts:743-754`) has the same shape; today it is only
   ever called with `'read'` (`productionRuntime.ts:4521`) so it cannot currently regress, but it
   is the same latent hole.

Nothing in the tree ranks statuses: `grep -rn "statusRank\|STATUS_RANK\|isStatusRegression"
src/ packages/` returns zero hits.

## Mechanism

Group send is per-recipient: one bubble, N durable outbox rows (`sqlOutboxStore`, composite PK
`(clientMsgId, peerUserId, peerDeviceId)`). 1:1 sends leave one row.

1. User sends to a group of 3. Peers A and B are reachable; the fan-out flips the bubble to
   `'sent'` (`productionRuntime.ts:2742`) and records `firstEnvelopeId` (`:2716`). Peer C's row
   stays in the outbox (offline / unprovisioned / `DEFERRED`).
2. Peer A's device acks the relay → the relay emits `envelope.delivered { envelopeId }` →
   `applyEnvelopeDelivered` advances the bubble **`sent → delivered`** (`envelopeDelivered.ts:42`).
   Peer A then opens the chat → `recordReadReceipts` / `updateMessageStatusBulk('read')` →
   bubble is **`read`**.
3. Minutes/hours later peer C comes online. `drainOutbox` (`productionRuntime.ts:7398+`) picks up
   C's row, re-seals if the cert aged out (SN-06), `relay.send` succeeds, and then runs
   `updateMessageStatus(row.conversationId, row.messageId, 'sent')` at `:7485` —
   **unconditionally**. The store assigns `msg.status = 'sent'`.
4. The user watches a double-blue-tick bubble collapse back to a single grey tick. Worse: the
   change is durable — the immer commit changes the message object identity, so the
   write-through subscriber (`productionRuntime.ts:1821-1826`) calls
   `sqlMessages.upsertCoalesced(m)` and persists `sent` into SQLCipher, and
   `notifyBackupDirty` re-ships the downgraded row to the backup mirror. A restart does not heal
   it: `envelope.delivered` was already consumed and never replays, and
   `applyEnvelopeDelivered` will not re-fire, so the bubble is stuck at `sent` forever.
5. The 1:1 variant of the same class: `handleAccepted` (`:5333`) on a late/duplicate
   `envelope.accepted` after the HTTP fallback already shipped and the peer already delivered.

Blast is user-visible-only (no crypto/wire impact), which is why it is a P3 — but it is
permanent per message and it is one of the "my ticks are lying" complaints.

## Fix

Enforce the ladder **once, in the store**, rather than adding a 6th ad-hoc call-site guard. This
also fixes `handleAccepted` for free without touching the WS frame handler.

The ladder is `sending < sent < delivered < read`. `failed` and `undelivered` are deliberately
**off-ladder**: they are terminal-ish signals whose own call sites already gate them
(`productionRuntime.ts:695`, `:7518`, `decryptFailureSignal.ts:125`), and a retry legitimately
re-enters the ladder at `sending` **from** them (`ChatScreen.tsx:741`, only reachable when
`msg.status` is `'failed' | 'undelivered'` per `ChatScreen.tsx:705`). Ranking them would break
retry (`failed → sending`) and would break the honest `sending → failed` transition. So the rule
is: _block only when BOTH the current and next status are on the forward ladder and next is
lower._

Transitions this newly blocks (all of them bugs): `delivered → sent`, `read → sent`,
`read → delivered`, `sent → sending`, `delivered → sending`, `read → sending`.
Transitions it leaves untouched: everything involving `failed`/`undelivered` in either position,
and every forward move.

### File 1 — `src/modules/messenger/store/messengerStore.ts`

**Insertion (new helper).** Anchor — the end of `notifyBackupRemoved` immediately followed by the
next doc block (unique as a pair):

```ts
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * Audit P0-S3 / P0-S5 — pluggable sink for the on-disk wrapped
```

Insert between them:

```ts
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * XO-4 — outbound delivery progress is monotonic. A late outbox drain
 * (a group sibling row that only reaches its peer hours later) and a
 * duplicated `envelope.accepted` both re-assert 'sent' on a bubble the
 * recipient has already delivered/read, and the write-through
 * subscriber then persists the downgrade — so the tick never recovers.
 *
 * Only the forward ladder is ranked. 'failed'/'undelivered' stay
 * off-ladder: they are terminal signals gated at their own call sites,
 * and a retry legitimately re-enters the ladder at 'sending' from one
 * of them (ChatScreen retrySend).
 */
const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  sending: 1, sent: 2, delivered: 3, read: 4,
};

export function isStatusRegression(current: MessageStatus, next: MessageStatus): boolean {
  const a = STATUS_RANK[current];
  const b = STATUS_RANK[next];
  return a !== undefined && b !== undefined && b < a;
}

/**
 * Audit P0-S3 / P0-S5 — pluggable sink for the on-disk wrapped
```

`MessageStatus` is already imported type-only at `messengerStore.ts:7`; no new import.

**Edit 1 — `updateMessageStatus`.** Anchor:

```ts
    updateMessageStatus: (conversationId, messageId, status) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.status = status;}
```

Replacement (only the assignment line changes; `notifyBackupDirty` below it stays exactly where
it is and stays **unconditional**):

```ts
    updateMessageStatus: (conversationId, messageId, status) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg && !isStatusRegression(msg.status, status)) {msg.status = status;}
```

**Edit 2 — `updateMessageStatusBulk`.** Anchor:

```ts
for (const m of list) {
  if (wanted.has(m.id) && m.status !== status) {
    m.status = status;
    notifyBackupDirty(m.id);
  }
}
```

Replacement:

```ts
for (const m of list) {
  if (wanted.has(m.id) && m.status !== status && !isStatusRegression(m.status, status)) {
    m.status = status;
    notifyBackupDirty(m.id);
  }
}
```

(Behaviour-neutral today — the sole caller passes `'read'`, the top rank — but it closes the
same hole for any future caller.)

### No other production file changes

`productionRuntime.ts:7485` and `:5333` are left **verbatim**. The store guard is what makes the
comment at `:7482-7484` ("`updateMessageStatus` is idempotent…") actually true. Adding a
call-site `if (cur?.status === 'sending' || cur?.status === 'sent')` at `:7485` as well would be
redundant and would drift from the store rule; do not do both.

### Schema / migration / wire format

**None.** No SQLCipher schema change (`sqlMessageStore` persists the same `status` TEXT column,
same value set), no `sqlOutboxStore` change, no AsyncStorage `partialize` change (messages are
not persisted there), no relay DTO change, no new envelope field, no server change. Back-compat
with older clients and with the deployed relay is therefore total — this is a pure client-local
render/persistence-ordering fix. Rows already persisted in the downgraded `sent` state stay
downgraded (see Risk).

### Why the guard must NOT also gate `notifyBackupDirty`

`notifyBackupDirty(messageId)` currently fires on **every** `updateMessageStatus` call regardless
of whether anything changed, and `productionRuntime.ts:2737-2739` deliberately re-asserts
`'sending'` with the comment "re-assert so the write-through subscriber re-persists the queued
row". Keep it unconditional so this fix is a strict no-op for the backup mirror
(`BACKUP_LOOP.md` I1/I2 untouched — no new flush, no new commit obligation, and no _removed_
dirty-mark either).

Note that a blocked write is already a full no-op for the SQL write-through: immer's `set` trap
skips `markChanged` when the assigned value equals the current one, and here we skip the
assignment entirely, so the message object keeps its identity, `list === prevList` holds at
`productionRuntime.ts:1815`, and no `upsertCoalesced` fires. Same as today's same-value case.

## Blast radius

**Changed:** `messengerStore.ts` — `updateMessageStatus`, `updateMessageStatusBulk`, plus one new
module-level helper.

**Every caller of `updateMessageStatus` re-checked (18 sites):**

| Site                                                                     | Transition                                 | Under the guard                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `productionRuntime.ts:696`                                               | `sending → failed` (guarded)               | unchanged (off-ladder target)                                                                                              |
| `productionRuntime.ts:874`                                               | `undelivered → sent` (auto-resend OK)      | unchanged (off-ladder source)                                                                                              |
| `productionRuntime.ts:1636`, `:2489`, `:2838`, `:2919`, `:3102`, `:3157` | `* → failed`                               | unchanged (off-ladder target)                                                                                              |
| `productionRuntime.ts:2739`                                              | group zero-reachable re-assert `'sending'` | no-op when already `sending` (as today); newly blocked only from `sent`/`delivered`/`read`, which is the desired behaviour |
| `productionRuntime.ts:2742`, `:2905`                                     | `sending → sent`                           | unchanged                                                                                                                  |
| `productionRuntime.ts:5333` (`handleAccepted`)                           | `sending → sent`                           | unchanged; **`delivered/read → sent` now blocked (bug fixed)**                                                             |
| `productionRuntime.ts:7485` (drain success)                              | `sending → sent`                           | unchanged; **`delivered/read → sent` now blocked (THE finding)**                                                           |
| `productionRuntime.ts:7519` (L17)                                        | `sending → failed` (guarded)               | unchanged                                                                                                                  |
| `envelopeDelivered.ts:42`                                                | `sent → delivered` (guarded)               | unchanged                                                                                                                  |
| `decryptFailureSignal.ts:126`                                            | `sent                                      | delivered → undelivered` (guarded)                                                                                         | unchanged (off-ladder target) |
| `runtime.ts:799/808/831` (loopback dev runtime)                          | `sending → sent → delivered`, `* → failed` | unchanged                                                                                                                  |
| `ChatScreen.tsx:741` (retry)                                             | `failed                                    | undelivered → sending`                                                                                                     | unchanged (off-ladder source) |
| `productionRuntime.ts:4521` (bulk)                                       | `* → read`                                 | unchanged (top rank)                                                                                                       |

**Downstream of a status value** (all read-only consumers, no behaviour change beyond seeing the
correct value): `ChatScreen.tsx:2420` (retry chip shown for `failed|undelivered`), `:2661` (tick
icon), `undeliverableResend.ts:103` (`status !== 'undelivered'` → skip), `sqlMessageStore.ts:301`
(resend query for still-undelivered rows), `backup/messageMirror` (mirrors the row's status).
None of these gain a new reachable state; the guard only removes states that were wrong.

**Overlapping findings** — anything else in this batch that edits `drainOutbox`
(`productionRuntime.ts:7398-7529`) or `handleAccepted` (`:5324-5346`), notably the OM-_ outbox
family and OR-_ reliability items. This spec touches **neither function**, so the conflict
surface is limited to `messengerStore.ts:730-754`; only a finding that also rewrites
`updateMessageStatus*` conflicts. XO-4 should land **first** in the wave — later outbox/retry
work then inherits the invariant instead of re-deriving it.

**What could regress:** a legitimate backward transition that the ladder now forbids. I walked
all 18 call sites above and found none. The only theoretical one is `sent → sending`
(`:2739`), which is unreachable in the current code (that branch is only entered on a fan-out
where `delivered === 0`, and the bubble arrives there as `sending`) and would be a lie if it
were reachable.

## Tests

Jest project **`messenger-crypto`** (`testMatch: src/modules/messenger/__tests__/**/*.test.ts`,
node env). `messengerStore.ts` imports fine there provided AsyncStorage is mocked — copy the
mock block from `src/modules/messenger/__tests__/envelopeDelivered.test.ts:27-38`.
Do **not** import `productionRuntime.ts` (native `@op-engineering/op-sqlite`).

### New: `src/modules/messenger/__tests__/messageStatusMonotonic.test.ts`

Mirror the fixture style of `envelopeDelivered.test.ts` (`outboundMessage()` helper,
`beforeEach(() => useMessengerStore.getState().reset())`).

Assertions:

1. `it.each(['delivered', 'read'])('a late drain re-asserting sent does not rewind %s')` —
   append a bubble at that status, call
   `useMessengerStore.getState().updateMessageStatus('c1', id, 'sent')`, expect the status
   unchanged. _(This is the XO-4 regression lock — it must fail against the current tree.)_
2. `'read' → 'delivered'` is blocked; `'sent' → 'sending'` is blocked.
3. Forward ladder still works: `sending → sent`, `sent → delivered`, `delivered → read`.
4. Retry re-entry still works: `failed → sending` and `undelivered → sending` both apply.
5. Failure signals still apply over any ladder state: `sending → failed`, `sent → failed`,
   `delivered → undelivered` (this is `applyEnvelopeUndeliverable`'s contract — assert it via
   the store action AND via `applyEnvelopeUndeliverable(envelopeId)` so the two stay coupled).
6. `undelivered → sent` still applies (the bounded auto-resend success path,
   `productionRuntime.ts:874`).
7. Object identity: a blocked call leaves `useMessengerStore.getState().messages.c1[0]`
   **referentially identical** to the pre-call object (locks in "no SQL write-through, no
   spurious re-render").
8. `updateMessageStatusBulk('read')` still flips a mixed list of `sent`/`delivered` rows, and
   a hypothetical `updateMessageStatusBulk(ids, 'sent')` leaves a `read` row alone.
9. Unit-test the exported helper directly: `isStatusRegression` returns `true` for the six
   blocked pairs and `false` for every pair involving `failed`/`undelivered`.

### Existing suites to re-run (regression gate)

- `npx jest --selectProjects=messenger-crypto -t "envelope"` first, then specifically
  `src/modules/messenger/__tests__/envelopeDelivered.test.ts`,
  `decryptFailureSignal.test.ts`, `undeliverableResend.test.ts`, `groupReadReceipts.test.ts`,
  `appendMessageDedup.test.ts`, `conversationTtl.test.ts` — these are the suites that drive
  status transitions through the store.
- Then the full `npm run test:crypto` (CLAUDE.md change-safety gate 2/4).
- `npm run typecheck` must stay at or below the `.tsc-baseline.json` count (47). The helper is
  fully typed; expect no delta.
- No `apps/messenger-service` suite needed — no server change.
- Device smoke (state so if not run): group of 3, one member airplane-moded; send, let the two
  online members read it (double blue tick), bring the third online, confirm the tick does **not**
  drop to single grey — then kill/relaunch the app and confirm it is still blue (proves the SQL
  row was not downgraded).

## Risk

Things a reviewer should be suspicious of:

1. **The off-ladder decision.** `failed` and `undelivered` are intentionally _not_ ranked. If a
   reviewer wants "read must never become failed", that is a **different, larger** change: it
   would require re-checking `productionRuntime.ts:2838/2919/3102/3157` for a legitimate
   `delivered → failed`. Out of scope here; propose as a follow-up if the ticks-lie complaint
   recurs from that direction.
2. **`sent → sending` is now blocked** and `productionRuntime.ts:2739` relies on re-asserting
   `'sending'`. Verify by reading that branch that the bubble is always `sending` on entry
   (it is: the branch requires `delivered === 0`, and the only path that could have set `sent`
   earlier for the same `msgId` is a retry, which itself sets `sending` first at
   `ChatScreen.tsx:741`).
3. **Already-corrupted rows are not healed.** Messages downgraded to `sent` before this ships
   stay `sent` in SQLCipher and in the backup mirror — `envelope.delivered` never replays. No
   backfill is proposed (a migration that guesses `delivered` would be inventing a receipt).
   Accept the one-time cosmetic residue, or state it in the release note.
4. **Silent swallow.** A blocked transition is now silent. Deliberate — logging one would be
   noisy on every group drain, and the log-audit gate makes message-scoped logging risky. If a
   reviewer wants observability, a `console.warn` with only `messageId.slice(0,8)` + the two
   status strings is safe w.r.t. `packages/messenger-core/__tests__/logAudit.test.ts` (no
   plaintext, no key bytes), but I would leave it out.
5. **`notifyBackupDirty` stays unconditional** on purpose. Anyone "cleaning that up" into the
   `if` re-opens the `:2739` re-persist intent and touches the mirror path that
   `docs/runbooks/BACKUP_LOOP.md` governs. Leave it.
6. **Scope check:** the ops-console has its own optimistic list
   (`apps/ops-console/src/components/messenger/MissionGroupPanel.tsx:365` sets `status: 'sent'`)
   and no `delivered`/`read` ladder, so it is not affected. Mobile-only fix.

**Security:** none of the stop conditions are touched — no envelope shape, no AAD, no sender
cert, no dwell, no group key, no auth token, no vault gate. No new logging. The change is
strictly a client-side UI/persistence ordering guard.
