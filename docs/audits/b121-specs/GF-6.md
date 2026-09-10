# GF-6 - Outbox drain is fully serial: one 20s-timeout peer head-of-line-blocks every queued message

## Verdict

**CONFIRMED** (audit line numbers are ~0-off; the code is at `productionRuntime.ts:7394-7529`).

Evidence from the current tree:

1. `src/modules/messenger/runtime/productionRuntime.ts:7403-7406` — one flat serial loop over every
   due row, regardless of recipient:
   ```ts
   const rows = await outbox.dueRows();
   if (rows.length === 0) {return;}
   console.log(`[messenger.outbox] draining ${rows.length} row(s)`);
   for (const row of rows) {
   ```
2. `src/modules/messenger/store/sqlOutboxStore.ts` `dueRows()` selects **all** pending rows across
   all conversations and peers — `WHERE status = 'pending' AND next_retry_at <= ? ORDER BY created_at ASC`
   — so a group fan-out to 30 members plus every other queued 1:1 lands in the same single file.
3. `packages/messenger-core/src/transport/fetchWithTimeout.ts:18` — `export const TRANSPORT_TIMEOUT_MS = 20_000;`
   and its own header already names this exact defect:
   _"because `drainOutbox` iterates serially behind a single inflight guard, one hung request freezes
   every queued retry to every peer."_ SN-01 bounded the hang at 20s; it did not remove the serialism.
4. `productionRuntime.ts:7393` — `let drainOutboxInflight = false;` plus the 60s retry timer at
   `:1611-1614` means the worst case is not just slow, it is _starving_: a 25-row queue where 5 peers
   black-hole costs 100s of wall clock, and the periodic tick that would have retried is a no-op for
   the whole duration (`if (drainOutboxInflight) {return;}` at `:7400`).
5. The re-seal branches make it worse, not better: a DEFERRED row (`:7423`) and a stale-cert row
   (`:7452`) each do `ensureOutgoingSession` + `certCache.get()` + `own.encrypt` + a keys fetch
   **before** the 20s relay POST — all inside the same serial file.

Nothing in the current tree parallelises or partitions the drain. CONFIRMED.

## Mechanism

1. Device reconnects (or the 60s tick fires). `drainOutbox` sets `drainOutboxInflight = true` and
   pulls **every** due row with `dueRows()` — 1:1 rows, group fan-out rows, reaction rows, all
   interleaved in `created_at` order.
2. Row 1 targets peer A, whose device/network is black-holing. `relay.send` → `RelayHttpClient.request`
   → `fetchWithTimeout(..., 20_000)`. Android OkHttp has no read timeout, so the request sits until
   the `AbortController` fires at 20s.
3. Because the loop is `for (const row of rows) { ... await relay.send(...) ... }`, rows 2..N — which
   target completely unrelated, perfectly healthy peers — do not start until row 1 aborts.
4. On abort, `isUnreachableError(e)` matches `AbortError`, so `recordAttempt({unreachable: true})`
   does **not** burn the retry budget; it only pushes `next_retry_at`. Correct for peer A, but the
   20s was still spent on the critical path of everyone else.
5. With k flaky peers in the queue the whole drain costs `k × 20s`. During that window
   `drainOutboxInflight` is `true`, so the 60s timer and every `socket.on('connect')` drain
   (`:1134`, `:1601`) return immediately — the queue is frozen behind the slowest recipient.
6. User-visible: messages to healthy contacts stay on a single tick for minutes after the network is
   back. This is the "messages sit in sending after reconnect" founder complaint class.
7. Second-order: a deferred/stale-cert row adds `ensureOutgoingSession` (keys HTTP) + `certCache.get()`
   (auth-service HTTP) + `wrapOuter` in front of its 20s POST, so a single unprovisioned group member
   can cost 40-60s of head-of-line block on its own.

## Fix

Bounded concurrency of **4 lanes**, where a lane is one `(peerUserId, peerDeviceId)` pair. Ordering
within a peer is preserved exactly as today (lanes are processed serially inside themselves, and
`dueRows()` already hands them to us in `created_at ASC` order).

Two safety properties make this crypto-safe with no protocol change:

- `packages/messenger-core/src/crypto/sessionManager.ts:66-82` — `withLock` keys the ratchet mutex on
  `` `${address.userId}.${address.deviceId}` ``, i.e. **exactly the lane key**. Two lanes can never
  contend on the same Double Ratchet chain. (Its own header: _"Different peers still run in parallel;
  ops to ONE peer queue."_)
- `src/modules/messenger/crypto/sqlCipherStore.ts:250-256` — every off-chain explicit `BEGIN` is
  queued on the single `txnChain` (`runWithRatchetTxn`), so 4 concurrent re-seals serialise at the
  SQLite layer instead of throwing "cannot start a transaction within a transaction" (the B-72 class).
  `drainOutbox` is fully off-chain, so this is path (3) — no B-75 deadlock risk.
- `packages/messenger-core/src/runtime/certCache.ts` `getIssued()` already dedupes concurrent fetches
  through `this.inflight`, so 4 lanes re-sealing at once still make **one** `/sender-cert` call.

### File 1 (new): `src/modules/messenger/runtime/outboxLanes.ts`

Pure module, no native/runtime imports — same rationale and shape as the existing
`src/modules/messenger/runtime/outboxCertFreshness.ts` (which is unit-tested standalone).

```ts
/**
 * GF-6 — partition the due outbox into per-recipient lanes and run a bounded
 * number of them at once.
 *
 * The drain used to be one flat serial loop over every due row. Each relay POST
 * is capped at TRANSPORT_TIMEOUT_MS (20s, SN-01), so a single black-holing peer
 * stalled every queued message to every OTHER peer for 20s — and the drain's
 * `drainOutboxInflight` guard meant the 60s retry tick and every reconnect drain
 * were no-ops for the whole stall.
 *
 * Lanes are keyed `${peerUserId}.${peerDeviceId}` — byte-identical to the
 * SessionManager per-address ratchet mutex key — so parallel lanes can never
 * touch the same Double Ratchet chain, and per-peer send order is preserved
 * (rows arrive from `dueRows()` in created_at order and a lane runs serially).
 *
 * Kept out of productionRuntime.ts so the scheduling can be unit-tested without
 * standing up the messenger runtime.
 */

/**
 * How many recipients we ship to at once.
 *
 * Sized against the relay's own cap: `POST /envelopes` is throttled at 30 per
 * 10s per user (`apps/messenger-service/src/relay/envelope.controller.ts`
 * `@Throttle({default: {limit: 30, ttl: 10_000}})`). Four lanes drains a
 * 30-member fan-out ~4x faster while staying inside a cadence the relay accepts
 * on a normal-latency link, and `isRelayThrottled` below backs the pass off if
 * we ever do overrun it.
 */
export const OUTBOX_DRAIN_LANE_LIMIT = 4;

/** Signal from a lane worker: keep going, or abandon the whole drain pass. */
export type LaneStep = 'continue' | 'stop';

export interface PeerAddressedRow {
  peerUserId: string;
  peerDeviceId: number;
}

export function outboxLaneKey(row: PeerAddressedRow): string {
  return `${row.peerUserId}.${row.peerDeviceId}`;
}

/**
 * Group rows into per-recipient lanes. Lane order follows first appearance, so
 * with a `created_at ASC` input the oldest-waiting recipients start first; row
 * order inside a lane is unchanged.
 */
export function groupRowsByPeer<T extends PeerAddressedRow>(rows: readonly T[]): T[][] {
  const lanes = new Map<string, T[]>();
  for (const row of rows) {
    const key = outboxLaneKey(row);
    const existing = lanes.get(key);
    if (existing) {
      existing.push(row);
    } else {
      lanes.set(key, [row]);
    }
  }
  return Array.from(lanes.values());
}

/**
 * Run `worker` over every row, at most `limit` lanes concurrently, one row at a
 * time within a lane. A worker that returns 'stop' halts the pass: no further
 * rows are started in ANY lane (used for the epoch bail and the 429 backoff).
 *
 * `worker` is expected never to throw — the caller owns per-row error handling.
 * A throw is still contained so one bad row cannot reject the whole drain.
 */
export async function runOutboxLanes<T>(
  lanes: readonly T[][],
  limit: number,
  worker: (row: T) => Promise<LaneStep>,
): Promise<void> {
  if (lanes.length === 0) {
    return;
  }
  let cursor = 0;
  let stopped = false;
  const pump = async (): Promise<void> => {
    while (!stopped) {
      const lane = lanes[cursor++];
      if (!lane) {
        return;
      }
      for (const row of lane) {
        if (stopped) {
          return;
        }
        let step: LaneStep;
        try {
          step = await worker(row);
        } catch {
          step = 'continue';
        }
        if (step === 'stop') {
          stopped = true;
          return;
        }
      }
    }
  };
  const width = Math.min(Math.max(1, limit), lanes.length);
  await Promise.all(Array.from({length: width}, () => pump()));
}

/**
 * True when the relay rejected us with 429. Duck-typed on `RelayHttpError.status`
 * so this module stays free of transport imports.
 *
 * Matters because `isUnreachableError` does NOT match a 429 message, so a
 * throttled attempt would otherwise consume the 10-attempt retry budget and
 * eventually flip a perfectly deliverable bubble to 'failed'.
 */
export function isRelayThrottled(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {status?: unknown}).status === 429;
}
```

### File 2: `src/modules/messenger/runtime/productionRuntime.ts`

**(a) import.** Anchor (line 88, verbatim):

```ts
import {isStoredCertStale} from './outboxCertFreshness';
```

Replace with:

```ts
import {isStoredCertStale} from './outboxCertFreshness';
import {
  groupRowsByPeer,
  runOutboxLanes,
  isRelayThrottled,
  OUTBOX_DRAIN_LANE_LIMIT,
  type LaneStep,
} from './outboxLanes';
```

**(b) loop head → lane scheduler.** Anchor (verbatim, `:7403-7407`):

```ts
    const rows = await outbox.dueRows();
    if (rows.length === 0) {return;}
    console.log(`[messenger.outbox] draining ${rows.length} row(s)`);
    for (const row of rows) {
      if (!isOurEpoch()) {return;}
```

Replace with:

```ts
    const rows = await outbox.dueRows();
    if (rows.length === 0) {return;}
    const lanes = groupRowsByPeer(rows);
    console.log(`[messenger.outbox] draining ${rows.length} row(s) across ${lanes.length} peer lane(s)`);
    // Why: sibling group-fanout rows share a clientMsgId; with lanes they can now
    // settle out of order, so a terminal-failure row must not downgrade a bubble a
    // sibling already shipped in THIS pass (L17).
    const shippedThisPass = new Set<string>();
    const shipRow = async (row: OutboxRow): Promise<LaneStep> => {
      if (!isOurEpoch()) {return 'stop';}
```

**(c) every loop-control statement inside the body changes from statement form to a returned
`LaneStep`.** The body between the anchor above and the anchor in (d) is otherwise **unchanged**.
Exact substitutions, in file order:

| current (verbatim)                                                                                                                                     | replacement                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);`<br>`        continue;` (corrupt-payload branch, `:7415-7416`) | same `markDelivered` line, then `        return 'continue';`   |
| `          if (!reseal) { continue; }` (deferred branch, `:7424`)                                                                                      | `          if (!reseal) { return 'continue'; }`                |
| `            if (!reseal) { continue; }` (stale-cert branch, `:7455`)                                                                                  | `            if (!reseal) { return 'continue'; }`              |
| `          await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);`<br>`          continue;` (no-payload branch, `:7478-7479`)  | same `markDelivered` line, then `          return 'continue';` |

No other line in the body moves. (`markDelivered` on the success path at `:7500` is unchanged.)

**(d) success bookkeeping + throttle-aware catch + close the lambda.** Anchor (verbatim,
`:7500-7529`):

```ts
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
      } catch (e) {
        // SN-04 — a drain that fails because the device is offline must not
        // consume the retry budget; only server-rejected attempts do.
        const {attempts, failed} = await outbox.recordAttempt(
          row.clientMsgId, row.peerUserId, row.peerDeviceId,
          {unreachable: isUnreachableError(e)},
        );
        console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} terminal=${failed}: ${asErrorMessage(e)}`);
        if (failed) {
          // L17 — don't DOWNGRADE a bubble that already reached at least one
          // peer. In a group, one permanently-unprovisioned member exhausting
          // MAX_ATTEMPTS must not flip the whole message to 'failed' when the
          // other members received it (the send path already set 'sent', or a
          // sibling peer-row drained to 'sent'). Only surface 'failed' when the
          // message never reached anyone — i.e. it is still 'sending'.
          const cur = useMessengerStore.getState()
            .messages[row.conversationId]?.find(m => m.id === row.messageId);
          if (cur?.status === 'sending') {
            useMessengerStore.getState().updateMessageStatus(
              row.conversationId, row.messageId, 'failed',
            );
          }
        }
      }
    }
  } finally {
    drainOutboxInflight = false;
  }
}
```

Replace with:

```ts
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
        shippedThisPass.add(row.clientMsgId);
        return 'continue';
      } catch (e) {
        // SN-04 — a drain that fails because the device is offline must not
        // consume the retry budget; only server-rejected attempts do.
        // GF-6 — a 429 is the relay pacing us, not rejecting the envelope, so it
        // is budget-free too; the pass stops and the 60s tick picks it back up.
        const throttled = isRelayThrottled(e);
        const {attempts, failed} = await outbox.recordAttempt(
          row.clientMsgId, row.peerUserId, row.peerDeviceId,
          {unreachable: throttled || isUnreachableError(e)},
        );
        console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} terminal=${failed}: ${asErrorMessage(e)}`);
        if (failed) {
          // L17 — don't DOWNGRADE a bubble that already reached at least one
          // peer. In a group, one permanently-unprovisioned member exhausting
          // MAX_ATTEMPTS must not flip the whole message to 'failed' when the
          // other members received it (the send path already set 'sent', or a
          // sibling peer-row drained to 'sent'). Only surface 'failed' when the
          // message never reached anyone — i.e. it is still 'sending'.
          const cur = useMessengerStore.getState()
            .messages[row.conversationId]?.find(m => m.id === row.messageId);
          if (!shippedThisPass.has(row.clientMsgId) && cur?.status === 'sending') {
            useMessengerStore.getState().updateMessageStatus(
              row.conversationId, row.messageId, 'failed',
            );
          }
        }
        return throttled ? 'stop' : 'continue';
      }
    };
    await runOutboxLanes(lanes, OUTBOX_DRAIN_LANE_LIMIT, shipRow);
  } finally {
    drainOutboxInflight = false;
  }
}
```

**(e) `OutboxRow` type import.** `productionRuntime.ts:87` currently reads:

```ts
import {SqlOutboxStore, isUnreachableError} from '../store/sqlOutboxStore';
```

`OutboxRow` is **not** imported today (the old `for (const row of rows)` inferred it). The `shipRow`
lambda needs the name, so extend that same line — do not add a second import statement:

```ts
import {SqlOutboxStore, isUnreachableError, type OutboxRow} from '../store/sqlOutboxStore';
```

### Not needed

- **No schema change / no migration.** `dueRows()`, the `outbox` table, and the composite PK are
  untouched; grouping happens in memory after the SELECT.
- **No wire-format change.** Same `POST /envelopes` body, same order-independent server semantics
  (the relay already dedups on `(recipient, clientMsgId)`), so old servers and old peers are
  unaffected. Nothing to deploy server-side.
- **No crypto change.** No AAD field, no envelope shape, no cert handling, no `verifySealedAad` /
  `verifySenderCert` touch. Purely a client-side scheduling change.

## Blast radius

**Edited:**

- `src/modules/messenger/runtime/productionRuntime.ts` — `drainOutbox` only (`:7394-7529`) plus one
  import line. Signature unchanged, so the three call sites are untouched: `:1134` (reconnect),
  `:1601` (boot), `:1613` (60s timer). All three are `void drainOutbox(...)` fire-and-forget.
- `src/modules/messenger/runtime/outboxLanes.ts` — new.

**Reached but unchanged (verified safe under concurrency):**

- `SqlOutboxStore.recordAttempt` / `markDelivered` — every statement is keyed on the full composite
  PK `(client_msg_id, peer_user_id, peer_device_id)`, so two lanes never write the same row. They do
  hit the same SQLCipher connection concurrently; op-sqlite serialises statements and none of these
  opens an explicit `BEGIN`, so there is no nested-transaction hazard.
- `SessionManager.encrypt` / `initOutgoingSession` — per-address mutex, lane key is identical.
- `SqlCipherProtocolStore.saveIdentity` — off-chain path queues on `txnChain`; 4 concurrent callers
  serialise there. (This is the B-72 fix doing its job; it is why this change is safe today and would
  **not** have been before 2026-07-11.)
- `SenderCertCache.getIssued` — `inflight` dedup means 4 lanes → 1 cert fetch.
- `peerIdentityCache` (`productionRuntime.ts:775`) — plain `Map`, no inflight dedup, so 4 lanes can
  each issue a `keys` fetch for their own distinct peer. Different keys, no lost update. Same peer
  cannot be concurrent (one lane). Acceptable; do not add dedup in this change.
- `useMessengerStore` mutations (`updateMessageStatus` / `updateMessageRetractToken` /
  `updateMessageEnvelopeId`) — synchronous Zustand `set` calls in a single-threaded VM. The only
  read-modify-write is the L17 `find(...)` → `updateMessageStatus('failed')`, and the new
  `shippedThisPass` set closes the sibling race the lanes introduce.

**Overlapping findings (same function — sequence these, do not merge blindly):**

- **OM-05** (re-use compose `sentAtMs` at re-seal) edits `resealDeferredGroupRow` at
  `productionRuntime.ts:786-812`, which `drainOutbox` calls through the `reseal` param. Adjacent, not
  conflicting, but both land in the same file.
- **GF-2 / SYNC-2** (group key material over the durable outbox) _adds rows_ to this queue; it is the
  finding that most benefits from GF-6, and it will edit the enqueue side of the same module.
- **SRV-01 / GF-1** (fan-out throttle) touches the relay-side `@Throttle` this spec's
  `OUTBOX_DRAIN_LANE_LIMIT` is sized against. If SRV-01 raises the server cap, GF-6 needs no change;
  if SRV-01 is dropped, GF-6's `isRelayThrottled` backoff is the only thing keeping a 30-member
  fan-out from burning retry budget — **do not drop that half of this fix.**
- **SN-06 / SN-04** already live inside the anchored region; the anchors above quote their current
  text so a conflict is loud rather than silent.

**What could regress:**

- Relay 429s if lane width is set too high (mitigated by width 4 + the `stop`-on-429 backoff).
- Cross-peer _global_ ordering is no longer `created_at ASC` at the wire. Per-peer ordering — the
  only one that is observable to any single recipient — is preserved.
- Peak memory/CPU during a large drain rises ~4x (4 concurrent seals). Bounded and small.

## Tests

Jest project: **`messenger-crypto`** (`testMatch: src/modules/messenger/__tests__/**/*.test.ts`).

**New — `src/modules/messenger/__tests__/outboxLanes.test.ts`:**

`groupRowsByPeer`

1. Rows for 3 distinct peers produce 3 lanes; each lane holds only its own peer's rows.
2. Same `peerUserId`, different `peerDeviceId` → **two** lanes (matches the ratchet lock key).
3. Within a lane, input order is preserved (feed `created_at`-ascending rows, assert lane array order).
4. Lane order follows first appearance, so lane[0] contains the oldest row overall.
5. `groupRowsByPeer([])` → `[]`.

`runOutboxLanes` 6. **No intra-lane concurrency:** worker records `laneKey` on entry/exit; assert the per-lane active
count never exceeds 1 for any lane. 7. **Bounded width:** 10 lanes, `limit: 4` → observed max concurrent workers === 4; all 10 lanes run. 8. **Head-of-line block is gone (the regression test for this finding):** lane A's first row returns a
promise that never resolves until the test releases it; assert lanes B/C/D fully complete
(`worker` called for every one of their rows) _before_ releasing A. This fails on the current
serial code and passes after the fix. 9. `'stop'` from any worker halts the pass: assert no further worker invocations after the stop, in
any lane, and that `runOutboxLanes` resolves (does not hang). 10. `runOutboxLanes([], 4, w)` resolves and never calls `w`. 11. `limit` greater than `lanes.length`, and `limit: 0`, both resolve and process every row exactly once. 12. A worker that **throws** does not reject `runOutboxLanes` and does not abort its lane.

`isRelayThrottled` 13. `new RelayHttpError(429, 'ThrottlerException')`-shaped object (`{status: 429}`) → `true`. 14. `{status: 500}`, `{status: 401}`, `new Error('Network request failed')`, `null`, `undefined`,
`'429'` (string) → all `false`. 15. Cross-check with the real sibling: `isUnreachableError` from `../store/sqlOutboxStore` returns
`false` for a 429 message — the assertion that documents _why_ `isRelayThrottled` has to exist.

**Existing — must stay green (regression):**

- `src/modules/messenger/__tests__/sqlOutboxStore.test.ts` (per-peer row isolation, backoff, MAX_ATTEMPTS).
- `src/modules/messenger/__tests__/outboxCertFreshness.test.ts` (SN-06 branch this diff moves around).
- `src/modules/messenger/__tests__/groupBroadcast.test.ts`, `firstMessageDrop.test.ts`,
  `envelopeDelivered.test.ts` — the send/fan-out flows that feed the outbox.
- Full `npm run test:crypto`, then `npm test`.
- `npm run typecheck` must not exceed the `.tsc-baseline.json` count (47).

**Device probe (state honestly if not run):** queue ≥10 messages across ≥3 conversations with the
device in airplane mode, add one peer that is provisioned-but-black-holing, re-enable network, and
confirm every reachable peer's bubble flips to ✓ within one drain rather than after `k × 20s`.

## Risk

Things a reviewer should be suspicious of:

1. **The `continue` → `return 'continue'` rewrite.** Four sites. Miss one and it becomes a
   `continue` inside a `for` that no longer exists (compile error — good) or, worse, an early
   `return` that silently drops the rest of a lane. Read all four against the table above.
2. **`if (!isOurEpoch()) {return;}` semantics.** In the old loop it aborted the entire drain. It must
   become `return 'stop'`, not `return 'continue'` — otherwise a runtime rebuild (logout→login) keeps
   shipping under the dead epoch.
3. **`shippedThisPass` only closes half the L17 race.** If the failing sibling settles _before_ the
   succeeding one, the bubble still momentarily shows 'failed' and is then corrected to 'sent' — that
   is pre-existing behaviour, not new. Do not try to fix it here.
4. **Lanes do not stop on a failed row.** Row 2 for a peer still ships after row 1 failed, exactly as
   today, so a peer can receive out-of-order. Making lanes stop-on-first-failure would be _more_
   correct for ordering but would reintroduce head-of-line blocking per peer for up to
   `MAX_ATTEMPTS`. Deliberately out of scope — flag if a reviewer wants it, it needs a product call.
5. **`OUTBOX_DRAIN_LANE_LIMIT = 4` vs `@Throttle({limit: 30, ttl: 10_000})`.** On a fast link 4 lanes
   can exceed 3 req/s. The `stop`-on-429 path is what makes that self-limiting rather than
   budget-burning. If someone deletes `isRelayThrottled` as "unrelated", the concurrency change
   becomes a bubble-marked-failed generator. Keep them together.
6. **SQLCipher pressure.** 4 concurrent re-seals all funnel `saveIdentity` through the single
   `txnChain`. That is correct but it lengthens the chain — the same chain the coalesced message
   flush, backup mirror and restore use. Watch for the B-75 symptom ("backup got slow") in the
   post-change device probe; if it appears, drop the limit to 3 rather than bypassing the chain.
7. **Not a fix for the 20s itself.** A single black-holing peer still costs that peer 20s per attempt.
   GF-6 only stops it from being everyone else's 20s.
