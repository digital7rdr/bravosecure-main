# XO-5 — 1:1 send flips the bubble to 'failed' while its outbox row stays 'pending' and auto-sends later

## Verdict

**CONFIRMED** (line numbers drifted by ~0; the mechanism is exactly as described, and it is
**1:1-only** — the group path was already fixed).

Evidence from the current tree:

1. `src/modules/messenger/runtime/productionRuntime.ts:2918-2931` — the 1:1 `httpFallback` catch:
   ```ts
   } catch (e) {
     useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
     ...
     if (sqlOutbox) {
       sqlOutbox.recordAttempt(clientMsgId, target.userId, target.deviceId,
         {unreachable: isUnreachableError(e)}).catch(err =>
         console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
     }
     throw e;
   }
   ```
   The bubble is set to `'failed'` **unconditionally and synchronously**, before `recordAttempt`
   (fire-and-forget) has even run.
2. `src/modules/messenger/store/sqlOutboxStore.ts:226-237` — for an unreachable error `recordAttempt`
   only pushes `next_retry_at` and returns `{attempts: row.attempts, failed: false}`; the row keeps
   `status = 'pending'`. `dueRows()` (`:113-120`, `WHERE status = 'pending' AND next_retry_at <= ?`)
   will therefore re-ship it on the next reconnect or on the 60 s timer
   (`productionRuntime.ts:1612-1615`). Split state confirmed: bubble `failed`, row `pending`.
3. The group path already does the right thing —
   `productionRuntime.ts:2737-2740`: _"Leave the bubble in its durable 'sending' state (re-assert so
   the write-through subscriber re-persists the queued row)"_ → `updateMessageStatus(..., 'sending')`
   when `delivered === 0`. So the fix direction is already blessed in-repo; 1:1 was simply never
   migrated.
4. The drain also already does the right thing — `productionRuntime.ts:7509-7522` only surfaces
   `'failed'` when `recordAttempt` returned `failed === true` (budget exhausted) **and** the bubble
   is still `'sending'` (L17 no-downgrade guard). So the _only_ place that manufactures the split is
   the immediate 1:1 send.
5. The duplicate is real and un-coalescable: `clientMsgId = msgId` (`:2378-2384`) is minted per
   compose, and the relay dedups on `(recipient, clientMsgId)`. A re-typed message gets a **new**
   `msgId`, so the queued original and the re-typed copy both deliver. The sanctioned recovery
   (`ChatScreen.tsx:738-741`, "flip the EXISTING bubble to `sending` and re-send under the SAME id")
   preserves the id — but only if the user taps the chip instead of retyping.

## Mechanism

1. User sends a 1:1 message. `sendText` appends the bubble as `'sending'` (`:2760-2787`), seals it,
   and enqueues a durable outbox row (`:2857-2878`).
2. `transport.send()` is attempted. Either it throws (socket down → `catch` at `:2991` →
   `await httpFallback()`), or it succeeds but no `envelope.accepted` arrives inside
   `wsAckDeadlineMs()` → the ack watchdog fires `void httpFallback()` (`:2985-2989`).
3. The device is on a dead/flaky link, so `relay.send()` rejects with an RN offline error
   (`Network request failed`) or the SN-01 `AbortError`.
4. `httpFallback`'s catch runs: bubble → `'failed'` (red bubble + "Tap to retry" chip,
   `ChatScreen.tsx:2420-2429`), and the banner `sendErrorText(e, 'Send failed')`
   (`ChatScreen.tsx:685`) fires.
5. `recordAttempt(..., {unreachable: true})` runs a tick later and **deliberately does not** consume
   the retry budget (SN-04) — the row stays `pending` with a bumped `next_retry_at`.
6. The user sees "failed", does not trust the chip, and re-types the message. New `msgId` ⇒ new
   `clientMsgId`.
7. Network returns → `drainOutbox` ships the original row, flipping the _original_ bubble to `'sent'`
   (`:7485-7487`), and the re-typed copy also ships. **Recipient gets the message twice; relay dedup
   cannot help because the two copies carry different `clientMsgId`s.**

Secondary defect on the same lines: a _semantic_ rejection (relay `400 invalid_outer_sealed` /
`outer_sealed_too_large` / `expires_in_past`, see `apps/messenger-service/src/relay/envelope.service.ts:77-84`)
is treated as a budget-consuming transient — the row is retried ~10 times over ~30 min before it is
ever marked `failed`, even though it can never be accepted.

## Fix

Principle: **the outbox owns the terminal decision.** The bubble goes `'failed'` only when the row
is genuinely not going to be retried (no row at all / semantic rejection / budget exhausted). When
the row is still queued, the 1:1 path mirrors the group path — leave the bubble `'sending'` and
**do not throw** (the group `delivered === 0` branch already returns without throwing, `:2740`).
Not throwing is what keeps `sendMedia`'s catch (`:3151-3159`) and `ChatScreen`'s banners
(`:685`, `:753`) from re-manufacturing the same split — no edits needed in those files.

### 1. `src/modules/messenger/store/sqlOutboxStore.ts`

**1a. Add a semantic-rejection classifier next to `isUnreachableError`.**

Anchor (verbatim, end of `isUnreachableError`):

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

Insert immediately after:

```ts
/**
 * XO-5 — did the relay REJECT this envelope on its merits, so that retrying
 * the identical bytes can never succeed?
 *
 * `EnvelopeService.submitEnvelope` answers 400 for `invalid_recipient`,
 * `invalid_outer_sealed`, `outer_sealed_too_large` and `expires_in_past` — all
 * deterministic validation of the bytes we already sealed. 401 (token refresh),
 * 429 (throttle) and 5xx are deliberately excluded: those are transient and
 * must keep their retry budget.
 *
 * Matched on `.name` rather than `instanceof RelayHttpError` for the same
 * reason `firstMessageRetryBudget` does it — the store must not import the
 * transport layer, and there are two structurally identical error classes.
 */
export function isPermanentRelayRejection(e: unknown): boolean {
  const err = e as {name?: string; status?: number} | null | undefined;
  if (err?.name !== 'RelayHttpError') {
    return false;
  }
  return err.status === 400 || err.status === 413;
}
```

**1b. `recordAttempt` reports whether the row is still queued, and honours a permanent rejection.**

Anchor (verbatim):

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean},
  ): Promise<{attempts: number; failed: boolean}> {
```

Replace with:

```ts
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
    opts?: {unreachable?: boolean; permanent?: boolean},
  ): Promise<{attempts: number; failed: boolean; queued: boolean}> {
```

Anchor (verbatim):

```ts
if (!row) {
  // Already removed via markDelivered, or never existed. No-op.
  return {attempts: 0, failed: false};
}
```

Replace with:

```ts
if (!row) {
  // Already removed via markDelivered, or never existed. No-op.
  return {attempts: 0, failed: false, queued: false};
}
// XO-5 — the relay rejected the bytes, not the network. Retrying the same
// envelope can only fail the same way, so terminate now instead of burning
// ~30 min of backoff with the bubble stuck mid-flight.
if (opts?.permanent) {
  await this.db.execute(
    `UPDATE outbox SET status = 'failed'
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
    [clientMsgId, peerUserId, peerDeviceId],
  );
  return {attempts: row.attempts, failed: true, queued: false};
}
```

Anchor (verbatim, inside the `opts?.unreachable` branch):

```ts
      return {attempts: row.attempts, failed: false};
    }
    const nextAttempts = row.attempts + 1;
```

Replace with:

```ts
      return {attempts: row.attempts, failed: false, queued: true};
    }
    const nextAttempts = row.attempts + 1;
```

Anchor (verbatim):

```ts
      return {attempts: nextAttempts, failed: true};
    }
```

Replace with:

```ts
      return {attempts: nextAttempts, failed: true, queued: false};
    }
```

Anchor (verbatim, last return of the method):

```ts
    return {attempts: nextAttempts, failed: false};
  }
```

Replace with:

```ts
    return {attempts: nextAttempts, failed: false, queued: true};
  }
```

**1c. Boot sweep must not treat a terminally-failed row as "still in flight".**

This hole exists today but XO-5 widens it: after the fix many more bubbles are killed while
`'sending'`, and `allMessageIds()` counts `status='failed'` rows, so such a bubble would hydrate as
a permanently-spinning clock with no retry chip. Single caller
(`productionRuntime.ts:1631`), so tighten in place.

Anchor (verbatim):

```ts
  /**
   * Audit MSG-07 (2026-07-02): every message_id that still has ANY outbox row
   * (pending or failed). The boot sweep flips hydrated 'sending' bubbles with
   * NO row here to 'failed' — a crash between append and enqueue left them
   * permanently stuck in 'sending' with no retry path.
   */
  async allMessageIds(): Promise<Set<string>> {
    const result = await this.db.execute('SELECT DISTINCT message_id FROM outbox');
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{message_id: string}>;
    return new Set(rows.map(r => r.message_id));
  }
```

Replace with:

```ts
  /**
   * Audit MSG-07 (2026-07-02): every message_id that still has a RETRIABLE
   * outbox row. The boot sweep flips hydrated 'sending' bubbles with no row
   * here to 'failed' — a crash between append and enqueue left them
   * permanently stuck in 'sending' with no retry path.
   *
   * XO-5 — 'failed' rows are excluded: `dueRows` will never pick them up, so a
   * bubble whose only rows are terminal must get the retry chip rather than a
   * clock that never resolves. A bubble that reached at least one peer is
   * already 'sent', so this can never downgrade a delivered group message.
   */
  async pendingMessageIds(): Promise<Set<string>> {
    const result = await this.db.execute(
      "SELECT DISTINCT message_id FROM outbox WHERE status = 'pending'",
    );
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{message_id: string}>;
    return new Set(rows.map(r => r.message_id));
  }
```

No schema change: `outbox.status` already exists and is written by the current `recordAttempt`
(`UPDATE outbox SET attempts = ?, status = 'failed'`). **No SQLCipher migration / schema version
bump is required.**

### 2. `src/modules/messenger/runtime/productionRuntime.ts`

**2a. Import the new classifier.**

Anchor (verbatim, line 87):

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
```

Replace with:

```ts
import {
  SqlOutboxStore,
  isUnreachableError,
  isPermanentRelayRejection,
} from '../store/sqlOutboxStore';
```

**2b. The 1:1 `httpFallback` catch — the core fix.**

Anchor (verbatim):

```ts
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          // Pop on terminal failure too so the LRU doesn't accumulate
          // dead entries (Fix #8).
          clearPending(clientMsgId);
          // Don't delete the outbox row — the next connect-drain will
          // retry with exponential backoff (recordAttempt). SN-04: an
          // unreachable network reschedules without burning an attempt.
          if (sqlOutbox) {
            sqlOutbox.recordAttempt(clientMsgId, target.userId, target.deviceId,
              {unreachable: isUnreachableError(e)}).catch(err =>
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
          }
          throw e;
        }
```

Replace with:

```ts
        } catch (e) {
          // Pop the pending entry (and its ack watchdog) either way so the
          // LRU doesn't accumulate dead entries (Fix #8).
          clearPending(clientMsgId);
          // XO-5 — the outbox owns the terminal decision. Don't delete the
          // row: the next connect-drain retries with exponential backoff
          // (SN-04 reschedules an unreachable network without burning an
          // attempt). While the row is still 'pending' the bubble MUST stay
          // 'sending' — a 'failed' bubble over a row that auto-sends later
          // invites a re-typed duplicate, and a re-type mints a fresh
          // clientMsgId that the relay's (recipient, clientMsgId) dedup
          // cannot coalesce. Mirrors the group path's delivered===0 branch,
          // which already returns queued instead of throwing.
          let queued = false;
          if (sqlOutbox) {
            try {
              const res = await sqlOutbox.recordAttempt(
                clientMsgId, target.userId, target.deviceId,
                {unreachable: isUnreachableError(e), permanent: isPermanentRelayRejection(e)},
              );
              queued = res.queued;
            } catch (err) {
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err));
            }
          }
          if (queued) {
            console.warn('[bravo.send] relay unreachable — message queued for retry, clientMsgId=', clientMsgId);
            return;
          }
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw e;
        }
```

Notes on this block:

- The bubble is **not** re-asserted to `'sending'` in the queued branch: it was appended as
  `'sending'` (`:2760-2787`) and nothing in this path changed it, so the write-through mirror
  already holds the right row. (The group path re-asserts only because its `delivered === 0` branch
  can be reached after other code touched the row.) Avoiding the redundant `updateMessageStatus`
  also avoids a needless `notifyBackupDirty` re-flush.
- `queued === false` when `sqlOutbox` is null/undefined or the enqueue silently failed
  (`recordAttempt` returns `{queued: false}` for a missing row), so the "no durable row" case keeps
  today's exact `'failed'` + throw behaviour. This is the load-bearing safety property.
- `httpFallback` is `async`, so `await`ing `recordAttempt` here is legal. Both call sites tolerate a
  non-throwing return: `:2996` `await httpFallback()` simply falls through to the (flag-gated, best
  effort) multi-device block, and `:2985` `void httpFallback().catch(...)` is unaffected.

**2c. Drain — let a semantic rejection terminate immediately.**

Anchor (verbatim):

```ts
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {unreachable: isUnreachableError(e)},
);
```

Replace with:

```ts
const {attempts, failed} = await outbox.recordAttempt(
  row.clientMsgId,
  row.peerUserId,
  row.peerDeviceId,
  {unreachable: isUnreachableError(e), permanent: isPermanentRelayRejection(e)},
);
```

The existing `if (failed)` block below (with its L17 `cur?.status === 'sending'` no-downgrade guard)
already does the right thing and is unchanged.

**2d. Boot sweep uses the retriable-only set.**

Anchor (verbatim):

```ts
const outboxIds = await sqlOutbox.allMessageIds();
```

Replace with:

```ts
const outboxIds = await sqlOutbox.pendingMessageIds();
```

### Deliberately NOT changed

- **Group `sendOne` catch (`:2652-2663`)** — keep `{unreachable}` only, no `permanent`. That call
  site discards the result (fire-and-forget `.catch`), so terminating a row there would leave the
  aggregate bubble on `'sending'` with a row `dueRows` never returns and no drain pass to run the
  L17 flip. Group termination stays owned by `drainOutbox`.
- **`ChatScreen.tsx`** — no edit. Because the queued path no longer throws, neither the
  `'Send failed'` banner (`:685`) nor `'Retry failed'` (`:753`) fires for a queued message, and
  `sendMedia`'s `:3157` `'failed'` flip is not reached.
- **Wire format / server** — nothing. No new field, no DTO change, no `apps/messenger-service`
  edit. Old and new clients are indistinguishable on the wire.

## Blast radius

**Files edited (2):**

- `src/modules/messenger/store/sqlOutboxStore.ts` — `recordAttempt` (return shape + `permanent`),
  `allMessageIds` → `pendingMessageIds`, new `isPermanentRelayRejection`.
- `src/modules/messenger/runtime/productionRuntime.ts` — import line ~87, 1:1 `httpFallback` catch
  (~2918), drain `recordAttempt` (~7504), boot sweep (~1631).

**Callers of the changed functions (complete):**

- `recordAttempt` → 3 sites, all in `productionRuntime.ts` (~2659 group, ~2927 1:1, ~7504 drain).
  Return widening is additive; the group site destructures nothing and the drain destructures
  `{attempts, failed}` — both compile unchanged.
- `allMessageIds` → exactly 1 site (`productionRuntime.ts:1631`), verified by repo-wide grep. Rename
  is safe and keeps `npm run deadcode` clean.
- `isUnreachableError` → 3 sites + `sqlOutboxStore.test.ts`. Untouched.

**Persisted state:** none added. `outbox.status` already exists and is already written. No SQLCipher
schema version bump, no migration.

**Wire format:** unchanged in both directions. Server deploy ordering is a non-issue.

**Overlapping findings — coordinate edits:**

- Anything else touching the 1:1 `httpFallback` block or `drainOutbox` (SN-04/SN-06 follow-ups,
  OM-\* ordering work that re-times `sentAtMs`) will conflict textually.
- **XO-4 / OM-06** if they touch `updateMessageStatus` call sites in `productionRuntime.ts`.
- **OR-\* offline-retry findings** — they share `drainOutbox` and `recordAttempt`. If a sibling
  finding also adds a field to `recordAttempt`'s `opts`, merge the object literals rather than
  duplicating the parameter.
- No overlap with the group-fanout (GF-\*), sealed-sender (AAD), or call findings.

**What could regress:**

1. **Silent stall.** A 1:1 send that fails offline now shows a clock and _no banner at all_. If the
   outbox is unavailable for a reason `recordAttempt` doesn't detect, the message is silently stuck
   until the next boot sweep. Guarded by the `queued === false ⇒ old behaviour` fallback.
2. **Lost retry affordance.** `'sending'` has no retry chip (`ChatScreen.tsx:705` gates on
   `failed`/`undelivered`), so the user can no longer force an immediate resend. The 60 s drain
   timer (`:1612-1615`) and the reconnect drain cover it; `MAX_ATTEMPTS` still terminates a
   genuinely dead row and hands back the chip.
3. **Backup mirror.** More rows now persist with `status='sending'`. `updateMessageStatus` already
   drives `notifyBackupDirty`; this change _reduces_ status churn (one fewer flip per offline send),
   so `BACKUP_LOOP.md` I1 ("idle boots upload nothing") is not touched. Worth a sanity check that
   the sweep rename doesn't alter what the mirror re-flushes at boot.
4. **`permanent` mis-classification.** If the relay ever returns 400 for a transient condition, that
   message becomes terminally failed instead of retried. Verified against
   `apps/messenger-service/src/relay/envelope.service.ts:77-84` — all `POST /envelopes` 400s are
   deterministic validation; 429 throttle (`envelope.controller.ts:67`) and 401 are excluded.

## Tests

Jest project: **`messenger-crypto`** (`src/modules/messenger/__tests__/**/*.test.ts`) — run with
`npm run test:crypto`.

### Existing — `src/modules/messenger/__tests__/sqlOutboxStore.test.ts` (must be updated)

1. The fake DB (`makeFakeDb`) will throw `unhandled SQL` on the two new statements. Add, **before**
   the existing `UPDATE outbox SET attempts = ?, status = 'failed'` branch:
   ```ts
   if (trimmed.startsWith("UPDATE outbox SET status = 'failed'")) {
     const [cmid, uid, did] = params;
     const match = table.find(r => sameKey(r, cmid, uid, did));
     if (match) {
       match.status = 'failed';
     }
     return {rows: []};
   }
   ```
   and, alongside the other `SELECT` branches:
   ```ts
   if (trimmed.startsWith('SELECT DISTINCT message_id FROM outbox')) {
     const rows = table
       .filter(r => !/status = 'pending'/.test(trimmed) || r.status === 'pending')
       .map(r => ({message_id: r.message_id}));
     return {rows};
   }
   ```
2. `'an unreachable failure reschedules without incrementing attempts'` asserts
   `expect(res).toEqual({attempts: 0, failed: false})` — update to
   `{attempts: 0, failed: false, queued: true}`.
3. New assertions in the `SN-04` describe (or a new `XO-5` describe):
   - unreachable → `res.queued === true`, row `status === 'pending'`.
   - budget exhaustion (10 plain `recordAttempt` calls) → `last.queued === false`,
     `last.failed === true`, row `status === 'failed'`.
   - `recordAttempt` on a non-existent row → `{attempts: 0, failed: false, queued: false}`.
   - `{permanent: true}` → returns `{failed: true, queued: false}`, row `status === 'failed'`,
     `attempts` unchanged, and `dueRows()` no longer returns it.
   - `pendingMessageIds()` excludes a message whose only row is `'failed'` and includes one with a
     `'pending'` row.
4. New `describe('XO-5 — isPermanentRelayRejection classification')`, mirroring the existing
   `isUnreachableError` `test.each` style:
   - permanent: `Object.assign(new Error('invalid_outer_sealed'), {name: 'RelayHttpError', status: 400})`,
     `... {status: 413}`.
   - **not** permanent: `status: 429`, `status: 401`, `status: 500`, a plain
     `new TypeError('Network request failed')`, and `{name: 'MediaHttpError', status: 400}`
     (name-guard proves the classifier can't be tripped by a sibling error class).

### New — `src/modules/messenger/__tests__/queuedSendBubbleState.test.ts`

Pure unit test of the decision, no runtime bootstrap (follow the harness in
`outboxCertFreshness.test.ts` / `undeliverableResend.test.ts`). Drive a `SqlOutboxStore` over the
same fake DB plus a stub status-setter, and assert the composed rule:

- `enqueue` → `recordAttempt({unreachable: true})` → `queued === true` ⇒ **no** `'failed'` write and
  the row is still returned by `dueRows(now + 10 min)` (the "auto-sends later" half of the split).
- `recordAttempt({permanent: true})` ⇒ `queued === false` ⇒ `'failed'` written **and** `dueRows`
  empty — bubble and row agree.
- No outbox row at all ⇒ `queued === false` ⇒ `'failed'` written (pre-fix behaviour preserved).
- Regression assertion for the finding itself: after an unreachable failure there is **no**
  `(status === 'failed', row.status === 'pending')` combination — assert both together in one
  expectation so a future edit that re-introduces the split fails loudly.

### Regression suites to run

- `npm run test:crypto` (direct + the whole messenger suite; `sqlOutboxStore`,
  `outboxCertFreshness`, `undeliverableResend`, `sqlMessageStoreResend`, `archiveReplayDrain` all
  sit on this path).
- `npm test` afterwards (the `app` project owns `ChatScreen` tests).
- `npm run typecheck` — must not exceed the `.tsc-baseline.json` count (47).
- No `apps/messenger-service` suite needed: server untouched.

### Device probe (state it explicitly if not run)

Airplane-mode send in a 1:1 thread → bubble must show the clock, no red/`Tap to retry`, no
"Send failed" banner; disable airplane mode → the same bubble advances to a single tick with **one**
copy at the recipient.

## Risk

Things a reviewer should be suspicious of:

1. **The `queued === false` fallback is the whole safety net.** If `recordAttempt` ever returns
   `queued: true` for a row that `dueRows` will not pick up, the bubble spins forever. Check every
   `return` in `recordAttempt` pairs `queued: true` with a row left at `status='pending'`.
2. **Not throwing changes the `sendText` contract.** Verify no other caller of `runtime.sendText`
   relies on the throw to signal non-delivery. Current callers: `ChatScreen.handleSend`,
   `ChatScreen.retrySend`, `sendMedia` (`productionRuntime.ts:3143`), plus the forward path — none
   branch on delivery beyond setting a banner. Confirm with a fresh grep before landing.
3. **`isPermanentRelayRejection` is name+status matched, not `instanceof`.** Deliberate (the store
   must not import the transport, and there are duplicate error classes), but it means a future
   error class named `RelayHttpError` with a 400 anywhere in the pipeline will terminate a row.
   The `MediaHttpError` negative test guards the realistic case.
4. **Silence is now the offline UX.** The product question "should an offline send show a
   one-time 'queued, will send when you're back online' toast?" is deliberately left out of this
   diff. If the answer is yes, the follow-up is a `queued` marker on the resolved send (not a
   thrown error) consumed by `ChatScreen` — additive, no re-work of this fix.
5. **The `pendingMessageIds` rename is a behaviour change, not a rename.** It is the one part of
   this diff that can _add_ `'failed'` bubbles at boot (for messages whose rows are all terminal).
   That is the intended MSG-07 semantics, but it should be eyeballed against a group send where one
   member is permanently unprovisioned — confirm that case leaves the bubble `'sent'` (it does: L17
   sets `'sent'` as soon as one peer succeeds, and the sweep only touches `'sending'`).
6. **Security surface: none.** No crypto, no AAD, no sender cert, no envelope shape, no dwell/ack
   semantics, no vault gate. The only new log line prints `clientMsgId` (an opaque uuid already
   logged verbatim at `:7508` and `:2960`) — no plaintext, no key bytes, so
   `packages/messenger-core/__tests__/logAudit.test.ts` is unaffected.
