# Messenger Message Pipeline — Verification Loop & Simplification Work Order

> **This file is the executable companion to `docs/handoffs/FABLE_BRIEF_MESSAGE_PIPELINE_SIMPLIFICATION.md`.**
> The brief is _evidence_ (a read-only audit). **This file is the work.** Everything in the brief that is still
> outstanding has been re-verified against the current tree and turned into a numbered, independently-shippable
> work item below.
>
> **Golden rule:** a message-pipeline change is not "done" until the §9 sign-off holds. The reason this file
> exists is measurable: **no test imports `productionRuntime.ts`**, so a change there ships with a green suite and
> breaks something two days later in a different subsystem. That is not hypothetical — it happened on 2026-07-18
> (`b034b36`, a _call_ fix) and produced **B-124 + B-125 (CRITICAL data loss)** 48 hours later.

**Owner docs:** bug history = `sqa.md` (B-124…B-129); the evidence pack = `docs/handoffs/FABLE_BRIEF_MESSAGE_PIPELINE_SIMPLIFICATION.md`;
architecture constraints = `CLAUDE.md` **Security constraints** (call-key namespace, sender-cert order, AAD binding are stop-conditions).
Structural template for this file = `docs/runbooks/BACKUP_LOOP.md`.

---

## How to use this file (read this first if you are a fresh session)

1. **Do not re-audit.** §3 and §6 are already verified. Line numbers are stamped with the commit they were
   measured at; re-grep the **symbol** before you touch anything (see §11 trap 1).
2. **Pick the lowest unchecked box in §6 and do only that.** The order is a dependency order, not a
   preference. Work items are numbered `W0`…`W26`.
3. **Every work item is exactly one commit.** A commit that moves code must not also change behaviour.
4. **Run §5 (caller completeness) for every item that changes a shared symbol.** It is not optional; skipping
   it is precisely how B-124 shipped.
5. **Tick the box in §6 and update the status column in §3 in the same commit** that does the work. This file
   is the progress ledger — if it is stale, the next session repeats your work.
6. When you finish an item, run §7 gates and check §9. If a gate is red, **do not commit** (`CLAUDE.md` rule 7).

> ### ⚠️ CONCURRENCY — check before you touch `productionRuntime.ts`
>
> **More than one agent session has been editing this repo at the same time**, and it has already caused a
> near-miss. On 2026-07-21 a session ran `git checkout -- productionRuntime.ts` to restore a file after a
> mutation-proof and **destroyed another session's in-flight B-127 fix**; it was only recovered because a
> byte-copy happened to exist. Before editing this file:
>
> ```bash
> git status --short && ls -la --time-style=full-iso src/modules/messenger/runtime/productionRuntime.ts && date
> ```
>
> If the mtime is within a few minutes of now, or `git status` shows untracked modules/tests you did not
> create (`inboundGroupCreateGate.ts`, `groupCreateGate.test.ts` were the tell), **stop and ask** — do not
> commit that file, and never `git checkout --` it. For a mutation proof, copy the file aside and restore
> from the copy; do not use `git checkout`.
>
> **RESOLVED 2026-07-21 (late):** the concurrent session's B-127 fix (`inboundGroupCreateGate.ts`) was finished-but-uncommitted and green in the tree for ~25 min. It was isolated (my one overlapping hunk removed by hand), committed on its own as `66f8546` with its authorship noted, then my hunk restored and committed as `74edde2`. `productionRuntime.ts` is free again. Lesson stands: never `git checkout --` or `git add .` a file a parallel session may hold.

**Ground truth as of the last update to this file:**

| Fact                    | Value                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline commit         | `09ee39d` (branch `fix/b121-b123-ios-group-video`)                                                                                                                              |
| Brief was written at    | `cea64f8` — **every line number in the brief is ≥ +16 off**                                                                                                                     |
| Commits since the brief | **73** as of W0. The brief's own line numbers are now far more than +16 off — treat every stamped line in the brief AND in this file as a hint, and re-grep the symbol          |
| Unpushed                | all of the above — **nothing has reached `origin/main`**                                                                                                                        |
| `productionRuntime.ts`  | **8,031 lines — EXACTLY what it was when the brief was written.** 79 commits, 8 modules extracted, and the file is dead flat. Every line extraction removed, bug fixes put back |
| `messengerStore.ts`     | **1,703 lines** (was 1,586 — it GREW by 117; the M11/W16 extraction has not happened, and fixes landed on top)                                                                  |
| Test count              | **1,950** in the `messenger-crypto` project (was 1,811 at baseline)                                                                                                             |

---

## 0. When this loop applies (trigger files)

Run it if your change touches any of:

- **Runtime core:** `src/modules/messenger/runtime/productionRuntime.ts` (**8,047 lines**), `runtime.ts`,
  `receiveTransaction.ts`, `messagingLogic.ts`, `groupConversationUpsert.ts`, `decryptFailureSignal.ts`,
  `firstMessageRetryBudget.ts`, `bootGroupStashDrain.ts`, `undeliverableResend.ts`, `envelopeDelivered.ts`
- **Store / persistence:** `src/modules/messenger/store/messengerStore.ts` (**the real one — 1,586 lines**),
  `sqlMessageStore.ts`, `sqlOutboxStore.ts`, `seenEnvelopeStore.ts`, `src/modules/messenger/crypto/db.ts`
- **Screens:** `src/screens/messenger/ChatScreen.tsx`, `MessengerHomeScreen.tsx`, `CallScreen.tsx`
- **Call→message seam:** `src/modules/messenger/webrtc/useGroupCall.ts`, `launchCall.ts`, `callDispatcher.ts`
- **Push:** `src/modules/messenger/push/backgroundMessageNotifier.ts`, `mutedLookup.ts`, `fcmBootstrap.ts`,
  `callNotification.ts`, `fcmHeadless.ts`, `headlessDrain.ts` — B-710 added the notification-liveness
  contract across these five (see CLAUDE.md's regression table row **Notification liveness B-710**).
  Two rules that bite hardest: a GUESSED conversation id may never KEY a banner (the client resolves
  one locally, so a content-free wake lands on the store notifier's own notifee id and REPLACES the
  card), and `headlessMode` must be PROMOTED by a warm start (the headless task shares the app's JS
  VM, and a stuck flag drops every message with the app on screen)
- **Shared crypto:** `packages/messenger-core/src/groups/**`, `crypto/senderCert.ts`
- **Peer identity / rotation (B-701):** `src/modules/messenger/crypto/peerIdentityCache.ts`,
  `peerRotationFlag.ts`, `peerIdentityRefresh.ts`

### Routing snippet to paste into `CLAUDE.md` (do this as part of **W0**)

```markdown
## Messenger message pipeline → run `docs/runbooks/MESSAGE_LOOP.md`

**Whenever you work on the messenger message pipeline — send, receive, the message store, the
receive transaction, notifications, or the call→message seam — read and run
[`docs/runbooks/MESSAGE_LOOP.md`](docs/runbooks/MESSAGE_LOOP.md) as part of the task.**
No test imports `productionRuntime.ts`, so a green suite is NOT evidence that a change there is
safe (a _call_ fix silently broke _messaging_ and produced CRITICAL data loss B-125 two days later).
That runbook holds the M1–M16 invariant contract, the ordered work items, and the
caller-completeness protocol that keeps the class dead. Trigger-file list is at its §0.
```

---

## 1. The pipeline in one screen (reference)

```
OUTBOUND
  ChatScreen.tsx  setText('') + inputRef.clear()   ← composer cleared BEFORE the await (B-73)
        │            route.params.isGroup ──────────────┐  (a NAV PARAM overrides the store)
        ▼                                              ▼
  sendText(convId, text, opts)  productionRuntime.ts:2295-3066 (772 L)
        │  :2350  topology  → messagingLogic.isGroupConversation   ← ONE rule (M1/M2) ✅
        │  :2371  TOFU gate → silent `return`  ⚠️ ABOVE the append (M3, flag-gated)
        ├── GROUP :2386-2760                    ├── 1:1 :2762-3066
        │     :2437 appendOptimistic ✅          │     :2764 throw ⚠️ ABOVE its append (M3)
        │     :2447/:2462 guards → failGroupSend │     :2803 appendOptimistic
        │     :2468 groupAdminLock (re-read key) │     X3DH → seal → wrap → ship → outbox
        ▼                                        ▼
  encrypt → wrapOuter → ship        ← 20 hand-rolled copies; only 3 write a durable outbox row

INBOUND (two independent implementations of the same job)
  WS   handleDeliver :5373 → handleDeliverInner :5388-5720 (333 L)
  HTTP drainRelay :7547-7923 (377 L)   ← the path users hit after being offline
        │   ~120 duplicated lines: unwrap + establish trustedPeer   (M5)
        │   11 relay.ack sites, 2 of them the near-identical terminal pair
        ▼
  runWithRatchetTxn(txnDb, () => doHandleIncoming(...))    productionRuntime.ts:5924
        │
        ▼  doHandleIncoming :6314-7337 (1024 L, 13 positional params)
           :6338 own.decrypt        ← first DB touch; ratchet advances INSIDE the txn
           :6395 markSeen           ← BEFORE cert verify (M6)
           :6421 verifySenderCert
           :6466 verifySealedAad    → :6526 clean `return` on clock skew = COMMIT + ack discarded ⚠️
           :6600 route (adopt sender's group.groupId verbatim)
           lanes: reaction / group-text / group-admin / 1:1-text
           :7269 / :7331  appendMessage → sqlMessages.upsert   (same txn, M9)
        │
        ▼  37 EXITS. A bare `return` COMMITS and ACKS. (M10)
           returns a PostTxnRequest — drains run OUTSIDE the txn (M13) ✅

PERSISTENCE FLOOR
  PRIMARY KEY (conversation_id, id)  db.ts:164  +  INSERT OR REPLACE  sqlMessageStore.ts:131
  ^ that is the ENTIRE exactly-once guarantee. It is DDL, not logic. No test runs real SQLite.
```

---

## 2. What is already done (do **not** redo these)

Five commits landed after the brief was written. They closed real ground:

| Commit    | What it actually changed                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3c41d2f` | **M1/M2 send-side + M3 group branch.** Deleted `sendText`'s inline `!!groupState` predicate; it now delegates to `messagingLogic.isGroupConversation`, which gained the `!isDirectRow` veto. Moved the empty-participants and fan-out-cap guards **below** the optimistic append behind `failGroupSend` (flips the bubble to `failed` first). Added `messageTopologyInvariants.test.ts` — the repo's first static source-scan of `productionRuntime.ts`. |
| `5a97038` | **Boot heal.** `pruneCallKeyContamination` (`messengerStore.ts:1375-1399`, wired at `:1299`) removes persisted `direct:`-prefixed `'Call'` aliases and the impossible `direct:<self>` row. 9 tests, negatives-first.                                                                                                                                                                                                                                     |
| `e64d56c` | **M1 residual + receiver-side containment.** Added `isDeviceLocalGroupId` (`messagingLogic.ts:88-90`) and made it the **first** statement of `isGroupConversation` — an id-SHAPE veto that works even when the conversation row is absent/untyped. Added a shape guard to `groupConversationUpsert.ts:77`. Logged **B-127 / B-128 / B-129**.                                                                                                             |
| `9c23add` | **B-129.** Rewrote the group-create epoch test (since folded into `groupCreateGate.test.ts` by the B-127 fix `66f8546`; the original file was deleted in `a0b84de`) — it was asserting a rule the code no longer had — and added a source-scanning **drift guard**. This is the in-house template for anti-drift.                                                                                                                                        |
| `09ee39d` | **B-126 partial.** Fixed a real order-dependent race in `groupBroadcast.test.ts` (`Promise.allSettled` resolution order ≠ member order, so `delivered[0]` handed bob carol's ciphertext → `Bad MAC`). 4 clean `test:crypto` runs after. **`incomingRingtone` still flakes** — different signature (suite-level, zero failed tests = teardown/open handle).                                                                                               |

**Invariant deltas:** M1 `NOT ENFORCED → ENFORCED (pinned)`. M3 `NOT ENFORCED → PARTIAL` (2 of 4 exits fixed).
M2 `5 copies → 5 copies, but the dangerous send-side one is gone`. Everything else is unchanged.

### Current size baseline (the shrink metric)

Re-measured after **79 commits**. The brief's success criterion is stated at its §9: **"no file over
~400 lines, no function over ~80."** Measured against that, not against ticked boxes:

| File                          |          Lines | vs the brief | vs ~400 target |     | Function             |     Lines | vs ~80 |
| ----------------------------- | -------------: | -----------: | -------------: | --- | -------------------- | --------: | -----: |
| `productionRuntime.ts`        |      **8,031** |    **±0** ⚠️ |        **20×** |     | `ChatScreenInner`    | **1,666** |    21× |
| `useGroupCall.ts`             |          4,529 |            0 |            11× |     | `doHandleIncoming`   |    ~1,024 |    13× |
| `ChatScreen.tsx`              |          3,218 |            0 |             8× |     | `sendText`           |   **808** |    10× |
| `messengerStore.ts` (module)  |      **1,703** |     **+186** |             4× |     | `MessageBubbleImpl`  |       515 |     6× |
| `runtime.ts`                  |            923 |            0 |             2× |     | `drainRelay`         |      ~377 |     5× |
| `sqlMessageStore.ts`          |            441 |          +29 |             1× |     | `handleDeliverInner` |      ~333 |     4× |
| `messagingLogic.ts`           |            197 |           +2 |             ✅ |     | `appendMessage`      |      ~213 |     3× |
| `src/store/messengerStore.ts` | 120 (**DEAD**) |            0 |             ✅ |     |                      |           |        |

**Modules extracted so far** (all Tier A — zero react-native imports, so the node jest project can load
them, which is the whole point): `senderCertAdmit.ts` (150), `inboundMessageBuilder.ts` (137),
`inTxnSenderClaims.ts` (84), `inboundRouting.ts` (49), `aadBinding.ts` (42), `ackDisposition.ts` (27).

> ## ⚠️ READ THIS BEFORE REPORTING PROGRESS
>
> **On the brief's own success measure, this campaign is at roughly zero.** `productionRuntime.ts` is
> **8,031 lines — the exact number in the brief's opening paragraph.** 79 commits, 8 modules extracted,
> and the file is dead flat: every line extraction took out, bug fixes put back. `sendText` **grew**
> (772 → 808). `messengerStore.ts` **grew by 186**. `ChatScreenInner` is untouched. **Not one file and
> not one function meets the target.**
>
> An earlier version of this table claimed "−78 ✅". That was measured mid-session and then quietly
> falsified by the next two commits, and a commit body (`W6`) carries a line count that was **asserted
> rather than measured**. Both are the same failure: reporting a number that flattered the work.
>
> **What HAS been delivered is real, but it is a different thing:** 22 bugs found and fixed
> (B-130…B-141 + earlier), a pre-push gate hole closed that let B-124 ship, and ~490 lines moved from
> untestable-by-construction into unit-tested modules. Say that. **Do not say the pipeline is simpler,
> and do not report ticked boxes as if they were the goal** — 29 of 45 items are ticked while the
> metric those items exist to move has not moved at all.
>
> The two items that would actually move it are **W24/S5** (the `doHandleIncoming` lane split) and
> **W27** (`planSend`), and both are still open. Everything cheaper has been done.

**Target:** no new file over ~250 lines, no new function over ~80. `productionRuntime.ts` must shrink
monotonically after **W12**; record its `wc -l` in each commit body from then on.

---

## 3. Invariants — the "never again" contract

`Status` is verified at `09ee39d`. `NEEDS TEST` means nothing asserts this today — **that is the work.**

| #       | Invariant                                                                                                                                                  | Status                                | Enforced at / violated at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Pinned by                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **M1**  | A conversation that denotes a 1:1 (`type === 'direct'` **or** a `direct:`-shaped id) must never enter the group fan-out, no matter what `groups[id]` holds | ✅ **ENFORCED**                       | `messagingLogic.ts:56` (id-shape veto) + `:63` (`hasGroupState && !isDirectRow`)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `messagingLogic.test.ts` (8 cases), `messageTopologyInvariants.test.ts`                                                                                                                                                             |
| **M2**  | Exactly **one** function answers "is this a group?" for message fan-out; call routing uses a **differently named** function                                | ✅ **ENFORCED on every message path** | Send (`3c41d2f`), read receipts (`a0b84de`), `directConversationSlots` + notifier (`aa41021`) all delegate to `messagingLogic.isGroupConversation`; the call-routing rival is renamed `shouldRouteCallViaSfu` (`b90e8f4`). **Remaining copies are deliberate and documented:** `setGroupState`'s participants-sync gate (narrow ON PURPOSE — §10 says widening it is net-negative), ChatScreen's display-only checks, and the dev-loopback `runtime.ts`. The `opts.isGroup` caller hint is still an override → **W27**                      | `messagingLogic.test.ts` · `messageTopologyInvariants.test.ts` · `groupReadReceipts.test.ts`                                                                                                                                        |
| **M3**  | `sendText` never throws or returns above the optimistic append                                                                                             | ✅ **ENFORCED**                       | All three exits closed: group branch (`3c41d2f`), 1:1 branch (`47f38da`), and the TOFU send-gate (`62cde6c`) — which sat above BOTH appends and silently destroyed the typed text, latent until `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE` is enabled. **`sendText` now has no exit above a bubble.**                                                                                                                                                                                                                                          | `messageTopologyInvariants.test.ts` — 8 M3 cases incl. the GENERAL rule (no bare `return;` above the first append, whatever its reason), all mutation-proved                                                                        |
| **M4**  | Group key material is never filed under a `direct:`-shaped id without an explicit ephemeral marker, and every ephemeral key has a teardown                 | 🔴 **VIOLATED**                       | 3 alias writes: `:4450` (`direct:<own>`), `:4458-4459` (originating 1:1 id), `:7033-7040` (receiver side). `GroupState` has **no** `isCallGroup`/`ephemeral` field. **No call-end teardown, no TTL.**                                                                                                                                                                                                                                                                                                                                       | **ARCH-GATED → §10**                                                                                                                                                                                                                |
| **M5**  | WS (`handleDeliverInner`) and HTTP (`drainRelay`) run the same validation set and the same ack rule                                                        | ✅ **FULLY SHARED**                   | dedup guard (`74edde2`) · ack rule (`d644e47`) · trust anchor (`3aad19c`) · **cert admission (`7fc4c0b`)** — the four divergences that mattered are gone and both paths now run the same code. in-flight guard placement closed too (**W22a**) — the drain now takes the marker at the top of its loop body like WS, with the whole body in ONE `try/finally`. **No known M5 divergence remains.**                                                                                                                                          | `receivePathParity.test.ts` (D1+D5, mutation-proved) · `ackDisposition.test.ts`                                                                                                                                                     |
| **M6**  | A **transient** verification failure (clock skew) must leave the envelope redeliverable                                                                    | ✅ **ENFORCED**                       | Both halves closed: cert clock-window failures leave-on-relay (`9a262a1`, W30) and the AAD `future` branch now THROWS `LeaveOnRelayError` instead of clean-returning (`4b9cd97`) — its own comment had conceded it destroyed the message. `stale` (>30d, expired/replayed) still drops by design, pinned. Bounded by the relay's 30-day dwell, not a retry budget                                                                                                                                                                           | `senderCertAdmit.test.ts` (6) · `receivePersistenceInvariants.test.ts` (future vs stale) — mutation-proved                                                                                                                          |
| **M7**  | Never log plaintext bodies, media, or key material                                                                                                         | ✅ **ENFORCED** (one known hole)      | `logAudit.test.ts` scans **5 roots** (`src/modules/messenger`, `apps/messenger-service/src`, `packages/messenger-core/src`, `apps/ops-console/src`, `apps/auth-service/src`) — up from 2. The **real leak** it missed (`apps/ops-console/src/lib/messenger/runtime.ts`, decrypted plaintext echoed through a `JSON.parse` SyntaxError) is fixed in `b75a307` and the root is now scanned (`b0505a3`). `CLAUDE.md:212`'s phantom test path fixed in `7884c8b`. **Remaining hole:** line-based regex cannot see a log call split across lines | `logAudit.test.ts` → **W1, W2** (both ✅)                                                                                                                                                                                           |
| **M8**  | N inbound envelopes → exactly N rows, in order, no duplicates                                                                                              | ✅ **ENFORCED (app layer)**           | DDL pinned against a REAL engine (`50d41fd`). Write side: all four inbound lanes persist the COMMITTED row (`11d572c`). Read side: hydration dedups on `envelope_id` as well as `id` (`ed76b66`) — previously a disk duplicate was re-created on EVERY restart and live dedup could never clear it. **Remaining (schema, not logic):** still no `UNIQUE` on `envelope_id`, so the DB itself cannot catch one — needs a migration + a de-dup sweep for existing installs                                                                     | `sqlMessageStoreEngine.test.ts` (real engine) · `appendMessageDedup.test.ts` (live + hydrate, both mutation-proved)                                                                                                                 |
| **M9**  | `appendMessage` is followed by `sqlMessages.upsert` in the **same** txn; the ack happens only after COMMIT                                                 | 🟡 **PARTIAL**                        | **Only outright violation CLOSED** (`d5044f2`, W9): both reaction lanes now persist in-txn instead of riding the deferred 50 ms subscriber (previously acked ✓✓ before the reaction was durable). **Residue:** asymmetric rollback — a ROLLBACK undoes the SQL write but not the Zustand append                                                                                                                                                                                                                                             | `receivePersistenceInvariants.test.ts` (mutation-proved)                                                                                                                                                                            |
| **M10** | A bare `return` in `doHandleIncoming` **commits and acks** — every early return is a decision to destroy or accept                                         | ✅ **PINNED**                         | Both 'unclear' exits resolved (`0ac3588`, W10+W11) and the exit set is now a **ratchet** (`452f9ab`, W20): 25 bare / 9 typed, destroyed-notes must reach an exit, no `relay.ack` inside the txn. A new silent exit fails the suite.                                                                                                                                                                                                                                                                                                         | `receivePersistenceInvariants.test.ts` — ratchet proved by injection                                                                                                                                                                |
| **M11** | An inbound append may not invent a conversation row without an explicit, auditable intent                                                                  | 🟡 **PARTIAL**                        | **Hole H1 closed** (`f06cbb5`, W15): a missed call from a cold contact no longer relies on `appendMessage`'s shadow-create — the dispatcher mints the row explicitly via the shared minter. **Still not enforced in the store itself:** the two inline branches remain, the direct branch still has no call sentinel (the group branch has had one since B-106), and `CallScreen.tsx`'s incoming call-record append still relies on the side effect                                                                                         | `missedCallConversationRow.test.ts` (H1) · `callGroupGhostGuards.test.ts` (group branch) · store extraction → **W16**                                                                                                               |
| **M12** | `appendMessage` must return the **effective** id (it can rewrite it) or downstream status updates silently no-op                                           | ✅ **ENFORCED**                       | Returns `string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | null` (`a395759`); both `sendText`branches patch via the returned id. Remaining follow-up: the INBOUND lanes still`upsert`the pre-append object, so a forked row could store`X#n`in memory and`X` on disk (the M8 memory↔disk item) | `appendMessageDedup.test.ts` — 4 contract cases incl. "the returned id is the one `updateMessageStatus` actually matches" |
| **M13** | Drains and replays run **outside** the receive txn, each opening its own                                                                                   | ✅ **ENFORCED**                       | `:7069`/`:7178` return `drain-group`; dispatched `void` at `:5967`; per-row txn at `:6230`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **NEEDS TEST** (the brief's claimed pin is wrong) → **W20**                                                                                                                                                                         |
| **M14** | Lock order is the same everywhere: global `txnChain` → finer lock                                                                                          | ✅ **ENFORCED (both pairs)**          | Pair 1 fixed as **B-130** (`404aab9`) — a real user-reported outage where a message burst silently stopped the receiver until restart. Pair 2 (`450d3b5`): the send path's session rebuild now takes the txn chain FIRST via `runOnTxnChain`, with the network fetch deliberately left outside. **Retires the last known instance of the family that produced P0-1 (2026-07-09), B-72, B-75 and B-130.**                                                                                                                                    | `receiveBurstDeadlock.test.ts` — 7 cases, both pairs mutation-proved                                                                                                                                                                |
| **M15** | The stash-drain replay applies the **same** gates as the live path                                                                                         | ✅ **ENFORCED**                       | All three missing drops added (`<W8b commit>`): expiry (M7), `isRestoreTombstoned` (M-08), `isPeerBlocked` (P2-9) — plus the membership gate it already had (P1-N4). **Blocking a peer now stops a stashed envelope rendering**; it did not before. All four use a plain `return`, because `drainPendingGroup` deletes the stash row only on a clean return                                                                                                                                                                                 | `stashDrainGateParity.test.ts` — 10 cases, RED-first, two mutation proofs (throw-instead-of-return; gate below the txn)                                                                                                             |
| **M16** | A notification never fires for a message that was not committed — and every committed message notifies                                                     | ✅ **BOTH DIRECTIONS ENFORCED**       | "committed ⇒ notified" (`365cb9a`, W29 — the tail-only watermark silently dropped late-drained messages) and "notified ⇒ committed" (`f38e472`, W28 — a rolled-back row left its banner and persisted badge behind)                                                                                                                                                                                                                                                                                                                         | `backgroundMessageNotifier.test.ts` — 4 M16 cases, each mutation-proved                                                                                                                                                             |

---

## 4. Failure-class history — read before "fixing" anything here

| Chain                           | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-130** (2026-07-21, live P0) | A 4–6 message burst silently stopped the receiver **until restart**. AB-BA between the global `txnChain` and the per-conversation write chain: receive took A→B, the coalesced flush took B→A. Nothing threw, so the receive txn's `await work()` never settled — no COMMIT, no ROLLBACK, no ack, and `txnChain` dead for the process lifetime. **The 2026-07-09 P0 fix created it**: it funnelled the flush into `runWithRatchetTxn` to stop a nested BEGIN but left the outer `chainOp` wrapping it. Fourth bug in this family.                                                                                                                                                                                                                                                                                                                                                         |
| **B-124 / B-125** (marquee)     | `b034b36` (2026-07-18) was a **call** fix. It shipped with 7 new passing tests and green gates. 2026-07-19: a real group named `"Call"` deleted on every boot. 2026-07-20: duplicate chat thread + **typed text destroyed on send**. The _write_ landed in the call subsystem; the _break_ landed in `sendText`. Nothing failed, because no test imports `productionRuntime.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **B-75**                        | `3ae4790` made `saveIdentity` queue its own txn on the global chain → self-deadlock → inbound stopped committing while backup mirrored a frozen snapshot **with a GREEN verify**. CRITICAL P0, same day. The new tests covered `saveIdentity`-inside-`runWithRatchetTxn` but **not** inside `runOnTxnChain`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **2026-07-09 P0**               | Two independent mutexes on one SQLCipher connection → a receive `BEGIN IMMEDIATE` landed inside an open flush txn, threw, and was acked `discarded` = **silent message destruction**. **This is M14, and M14 is still violated.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **`root_mismatch` ×5**          | `BACKUP_LOOP.md`: shipped five times because each fix patched the _read_ side while the _write_ side kept manufacturing drift. **Then the runbook was written and it stopped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **B-124 round 2**               | `5a97038`'s boot sweep was making B-124 **worse** until `e64d56c` landed: the sweep deleted the alias that `groupConversationUpsert`'s `'Call'` sentinel dereferenced, so the sentinel was _guaranteed_ to miss and re-mint the ghost every boot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **B-701** (2026-08-29, live)    | The identity-regen time-bomb fired: a reinstall rotated the founder's identity and a peer's device kept sealing into the DEAD ratchet — `ensureOutgoingSession`'s `hasSession` fast path never re-validated a cached session against the peer's CURRENT identity, and the receive-side heal only runs when the ROTATED device sends. 150 bundle fetches/10 min, 110-141 s sends, first-msg-recovery redelivery churn. Fix: the seal lane (server-first identity, ≤8 min fresh) NOTES a mismatch vs the trust row (`peerRotationFlag.ts`, zero extra network/OPK); `ensureOutgoingSession` consumes it ONE-SHOT and rebuilds via the extracted B-46 core (`rebuildOutgoingSessionWithBundle`); the ten `if (!had)` caller bypasses were dropped (ensure early-returns anyway — a bypass would starve the flag). M14 pins re-pointed at the core, strengthened (core may contain NO fetch). |

**Pattern to internalize:** we are currently patching the **read** side of the call-key contamination
(a topology veto + a boot heal) while the **write** side still files a throwaway `'Call'` key onto real chat ids
on every escalated call. That is the exact `root_mismatch` shape. **M4 is the write side. Until it is fixed,
every new consumer of `state.groups[id]` is a fresh B-124.**

---

## 5. The caller-completeness protocol — MANDATORY for every work item

When one function becomes several, **every existing caller must end up invoking all of the new pieces that
apply to it.** A caller that used to get five behaviours from one call and now gets three is a silent,
invisible regression — nothing fails to compile and no test goes red. Therefore:

1. **Enumerate the callers FIRST and paste the list into the commit body.**
   ```bash
   grep -rn "<symbol>(" src packages apps --include=*.ts --include=*.tsx | grep -v __tests__
   ```
   This repo hides callers well — **`productionRuntime.ts` loads siblings via lazy `require()` inside function
   bodies**, so a top-of-file import scan misses them (`:283`, `:290`, `:1416`, `:2352`, `:3302`).
2. **For each caller, state which new functions it must now call, in what order.** If a caller needs only a
   subset, say so **and say why**. An unstated subset is how behaviour gets dropped.
3. **Never leave the old function as a silent pass-through.** Either migrate every caller in the same commit,
   or the old name keeps its exact old behaviour by composing the new pieces. Half-migrated is the dangerous state.
4. **Watch the return value.** `appendMessage` can _rewrite_ the message id and returns `void` (M12). Any split
   must return the **effective** id.
5. **A change to a SHARED function reaches every caller.** Changing `messagingLogic.isGroupConversation` also
   changes reactions, the reaction wire stamp, and read-receipt acceptance. **Record a verdict per inherited
   caller — _fixes it / no change / regresses it_ — in the commit body before it lands.**
   _(`3c41d2f`'s commit body is the worked example. Copy its format.)_
6. **Verify mechanically.** After the cut, re-run the grep from step 1 and diff it against your list.

### Reference caller lists (verified at `9c23add` — re-grep, do not trust)

**`appendMessage` — 18 non-test call sites, 8 files:**
`productionRuntime.ts:2437, :2803, :3086, :6232, :6858, :7269, :7331` · `runtime.ts:794, :863, :890, :900` ·
`useGroupCall.ts:4467, :4524` · `callDispatcher.ts:137` · `CallScreen.tsx:1405` · `ChatScreen.tsx:834` ·
`decryptFailureSignal.ts:106` · `groupEventMessage.ts:89`

**`isGroupConversation` — TWO different exports, never interchangeable:**
`messagingLogic.ts:45` (message topology) vs `launchCall.ts:101` (SFU call routing, `>= 2 other members`).
Consolidating them **reroutes calls**. Rename, do not merge (**W4**).

**`doHandleIncoming` — 2 call sites, and they are not equivalent:**
`:5924` (full 13 args, inside `runWithRatchetTxn`) and `:5930` (last 4 args hard-coded `null` → **no
persistence, no dedup, no stash, no admin queue**). "It works in the loopback" is not evidence about production.

---

## 6. The work order

Each `W` is **one commit**. Tick the box and update §3 in the same commit.

### Phase 0 — Prerequisites (no production behaviour changes)

- [x] **W0 — Route this file from `CLAUDE.md`.** ✅ `<this commit>`. Pasted between the `BACKUP_LOOP.md` and
      `DESIGN_REVIEW_LOOP.md` blocks, matching their shape. Expanded past the §0 draft with the three things a
      fresh session most needs BEFORE it opens this file: that static source scans (not unit tests) are what
      pin the unreachable rules, that §5 caller-completeness is mandatory, and the two traps that have each
      cost a session — **B-126's ~50% `test:crypto` flake** (one red run is not evidence; run it twice) and
      stale line numbers (re-grep the symbol). Without this hop the runbook was unreachable: `CLAUDE.md`
      routes QA→`sqa.md`, booking→`LITE_BOOKING_LOOP.md`, backup→`BACKUP_LOOP.md`, design→`DESIGN_REVIEW_LOOP.md`,
      and messaging — the subsystem that actually produced the CRITICAL data loss — routed nowhere.
- [x] **W1 — Fix `CLAUDE.md:212`.** ✅ `7884c8b`. It cited `packages/messenger-core/__tests__/logAudit.test.ts`,
      which never existed.
- [x] **W2 — Widen the log-audit scanner (M7).** ✅ `7884c8b` + `b0505a3`. `7884c8b` added `CORE_ROOT` as a
      third root and collapsed the three identical bodies into `expectClean(root)`; green on the first run, so
      it was the pure ratchet predicted. `b0505a3` then added the two roots that actually mattered —
      `apps/ops-console/src` and `apps/auth-service/src` — because ops-console is where the **live** leak
      (B-133) was, and it survived precisely because nothing scanned `apps/`. Coverage is now 5 roots, up from
      2 at the start of the session. Four log **strings** were reworded to clear the prose false positives
      ("dropping before decrypt", "signature check unavailable"); **the ban list was not weakened** — that is
      the rule for this class, since each keyword dropped is a class of leak that stops being detectable.
      Mutation-proved: injecting `{plaintext: 'x'}` onto an ops-console log line turns the new root red.
      _Still open:_ the scanner is line-based regex and cannot see a multi-line log call — widening roots does
      not close that.
- [x] **W3 — Real SQLite engine for tests.** ✅ `50d41fd`. **No dependency needed after all** — Node 22+ ships `node:sqlite` and this repo runs Node 24, so no native compilation and no supply-chain addition. The brief's open question #1 is answered better than it was asked. Original text: Answer to the brief's open question #1 is **NO, it is
      not available**; `@op-engineering/op-sqlite` is a native RN module and cannot load in the
      `messenger-crypto` jest project (`testEnvironment: 'node'`, no RN preset). This is the **only** new
      infrastructure the whole plan needs. _Verify:_ `npm ls better-sqlite3`; no other change in the commit.

### Phase 1 — Free ratchets (mechanical, zero behaviour change)

- [x] **W4 ✅ `b90e8f4`** — Rename `launchCall.isGroupConversation` → `shouldRouteCallViaSfu` (M2).** Same body — the rule is
      *deliberately* different. Update its internal call site (`launchCall.ts:190`) and the doc references in
      `messagingLogic.ts:42`, `store/types.ts:133`, `AgentLiveTrackerScreen.tsx:665`, `CallScreen.tsx:1620`.
      **Nothing imports the symbol by name today\*\*, so this is mechanical.
      _Unchanged behaviour means:_ call routing decisions are byte-identical; only the identifier changed.
- [x] **W5 ✅ `0ad76b4`** — mirror corrected to model all THREE alias targets, plus a source-scanning drift guard so it cannot lie again. Fix the lying mirror `adhocCallKeyLookup.test.ts:~270` (B-129 class).** Its `adhocAliasTargets()`
      models **two** alias targets; `ensureCallGroupKey` actually files **three** (`:4449` minted, `:4450`
      `direct:<own>`, `:4458-4459` originating id). It is green while describing code that does not exist.
      Correct it **and\*\* add a source-scanning drift guard, copying `groupCreateGate.test.ts:213+` (the B-129 drift guard, re-targeted).
- [x] **W6 — Convert the lazy `require('./messagingLogic')` to static imports.** ✅ `<this commit>`. The item
      said "two"; there were **five** (`:295`, `:2364`, `:3352`, `:5214`, `:5268`) — three more were added by
      this session's own fixes, copying the shape that was already there. Now one static import at the top and
      six call sites. Provably cycle-free: **`messagingLogic.ts` has zero imports**, so it cannot participate
      in a cycle — the laziness never bought anything. Also dropped the `isGroupConvo` alias the destructure
      forced, so the M2 scan now pins the real exported name (an alias can be re-pointed at a different
      function while a name-based test stays green). New assertion: no `require('./messagingLogic')` may
      return, mutation-proved by reverting one site. Gates: crypto 216/216 + 1957 on the clean second run;
      typecheck 47 = baseline.
      **⚠️ Its claim "prerequisite for W7" is FALSE — verified, see W7.**

### Phase 2 — Live bugs the audit found (each test-first, each its own commit)

> These are **bugs**, not refactors. Several are more urgent than any extraction.

- [x] **W7 — Close the pre-push hole for `productionRuntime.ts`.** ✅ `<this commit>`. `.husky/pre-push` runs
      `jest --changedSince=origin/main --passWithNoTests`. **`readFileSync` creates no module-graph edge**, so
      the static-scan tests do _not_ close it. That is the literal hole B-106 went through.

  **The fix is an UNCONDITIONAL sweep, not the path trigger this item proposed.** A trigger list is one more
  thing that goes stale, and a stale list silently shrinks the sweep back toward the hole. `readFileSync` in
  a test file **is** the precise definition of "invisible to `--changedSince`", so the hook greps for it:
  every new scanner is picked up automatically, with no list to maintain. **22 suites / 238 tests / ~11s** —
  cheap enough that conditioning it would be false economy. Pinned by `prePushScanSweep.test.ts` (itself
  swept), which also pins the empty-list guard — without it a failed grep would make `jest` run the ENTIRE
  suite, and the natural fix for a suddenly-multi-minute push is to delete the step.

  **Proved with the real bug, not a synthetic one.** Re-inlining the `!!groupState` topology test that caused
  B-124 (CRITICAL data loss): under the old gate that diff passes **37/37 suites, 252/252 tests** and pushes
  clean. With the sweep, 2 tests fail. The scope is wider than this item asked for — it also covers
  `alert.test.ts`, `navigatorConfig`, `vaultMoveGuard`, `frameCryptorParity`, `groupCallVideoEncodings` and
  the rest, which all had the same invisibility and no one had noticed.

  **Measured at W6 — do not re-derive.** A `productionRuntime.ts`-only change selects **37 test files**, so
  the item's "zero tests" is wrong; what is actually true is worse and more specific: **none of the five
  static-scan suites are among them** (`messageTopologyInvariants`, `receivePersistenceInvariants`,
  `receivePathParity`, `receiveBurstDeadlock`, `logAudit`). Those are precisely the suites that exist to
  guard `productionRuntime.ts`, and they are precisely the ones that never run before a push.

  **Three fixes were tried and MEASURED TO FAIL — do not retry them:**

  | Attempt                                                           | Result | Why                                                                                                            |
  | ----------------------------------------------------------------- | :----: | -------------------------------------------------------------------------------------------------------------- |
  | The item's own suggestion: shared path constant both files import |   ❌   | Relatedness is "test transitively imports F", not "shares a dependency with F". A common leaf creates no edge. |
  | `require.resolve('../runtime/productionRuntime')` in the scanner  |   ❌   | Not counted as a dependency by jest's extractor.                                                               |
  | `jest.mock('../runtime/productionRuntime', () => ({}))`           |   ❌   | Also not counted.                                                                                              |

  The three failures share one root: nothing short of a **real executed import** makes a test related, and a
  test cannot import `productionRuntime.ts` — it pulls in react-native and dies in the node project (that is
  the whole reason the scanners read the file as TEXT). **The module graph cannot express this dependency at
  all**, which is why the fix had to leave the graph and sweep by file content instead.

- [x] **W8 ✅ `74edde2`** — the drain-path dedup read is guarded like the WS path; one SQLCipher hiccup no longer abandons a whole page (up to 1000 envelopes) on the offline-catch-up path. Pinned by `receivePathParity.test.ts`, mutation-proved (the two drain assertions fail pre-fix, both WS ones stay green). First of the M5 divergences closed.
- [x] **W8b — Stash-drain gate parity (M15).** ✅ `<this commit>`, logged as **B-141**. All three drops added
      to `replayGroupSealedDecode`, all with a plain `return` (a `throw` would replay the row
      `PENDING_GROUP_MAX_ATTEMPTS` times, re-parsing the group payload each pass, before deleting it anyway).
      Test written FIRST and observed red: 7 of 9 failed, and the 2 that passed were the controls asserting
      pre-existing behaviour. Two mutation proofs on the subtle assertions — `throw` instead of `return`, and
      the gate moved below the txn — each turns exactly one test red.

  **Two deviations from the item as written, both deliberate:**
  1. **Placement.** It said "after the `groupMsg` literal". Only `isRestoreTombstoned` needs the built row
     (it keys off `groupMsg.id`); expiry and blocked don't, so they go **above** the builder and skip
     constructing a row that is about to be discarded.
  2. **Dropping pre-txn skips the in-txn `markSeen`, which is safe and was verified, not assumed.**
     `markSeen` already ran unconditionally at `:6334` when the envelope was first received and stashed —
     the stash row, the seen row, and the relay ack commit atomically — so the call inside the replay txn is
     purely defensive. Had that not held, these drops would have made the relay re-push the envelope forever.

  **One hazard the item did not mention, checked and clear:** both gate caches **fail open** (a failed load
  leaves an empty set), so if the boot stash drain ran before `loadBlockedPeers`/`loadRestoreTombstones` the
  gates would silently no-op on exactly the path that matters most — the backlog a user may have blocked
  someone over. The loads are awaited at `:444-445`, the boot drain starts at `:~1735`. Now pinned by a test,
  since nothing else can see that ordering.

- [x] **W9 ✅ `d5044f2`** — `applyReaction` returns the patched row and BOTH reaction lanes upsert it in-txn. Pinned by the new `receivePersistenceInvariants.test.ts` (incl. an assertion that no BARE `applyReaction(` call survives — an uncaptured call cannot be persisted). Mutation-proved. Original text: `:7284` mutates the
      row but never calls `sqlMessages.upsert`; it rides the 50 ms deferred subscriber, i.e. **after** COMMIT
      and **after** the ack. Change `applyReaction` to return the patched `LocalMessage | null` and upsert it
      at the call site, matching `:7271`/`:7336`. **Do not use `upsertCoalesced`** — the point is that the
      write lands before COMMIT.
- [x] **W10 ✅ `0ac3588`** — a keys-service blip no longer PERMANENTLY destroys an owner-signed group-key create; transient (keys client present, lookup threw) now throws `LeaveOnRelayError`, permanent (no keys client) still drops. Deliberately not widened — turning every falsy resolve into leave-on-relay would loop forever on a genuinely unknown owner. Original text: `if (!ownerIdKeyB64) { warn; return; }`
      destroys an **owner-signed group-key create** — the exact envelope a keyless member needs — when the
      cause is a swallowed keys-service blip at `:6925-6932`. The WS path treats the identical condition as
      recoverable (`:5664-5666`). Split the causes: bare `return` only when `keys` is falsy; otherwise
      `throw new LeaveOnRelayError(envelopeId)` (already imported at `:33`; both ack sites already honour it).
- [x] **W11 ✅ `0ac3588`** — the sealed non-member group-text drop now notes the envelope, so it acks `discarded` like its legacy-plaintext twin instead of giving the sender a false ✓✓. Original text: The non-member group-text drop sends
      **`'delivered'`**, so the sender sees ✓✓ for a message that will never render. The semantically identical
      legacy drop at `:6824` _does_ call `noteDestroyedEnvelope`. Add the same call. Decide deliberately whether
      to also insert a placeholder, and apply one rule to **both** non-member drops.
- [x] **W12 — `recordReadReceipts` must delegate (M2, live `ops_channel` bug).** ✅ `a0b84de`. The new
      `ops_channel` case was RED first (`Expected "delivered", Received "read"` — it reproduced the blue-tick),
      then the store was switched to `messagingLogic.isGroupConversation` via a **static** import (messagingLogic
      is dependency-free, so no cycle and no lazy `require` needed). Inherited-caller verdicts are in the commit
      body. Gates: crypto 205/205 + 1823/1823 on a clean second run; typecheck 47 = baseline.
- [x] **W13 — leak FIXED ✅ `b75a307`; scanner widened ✅ `b0505a3`.** The `groupDecrypt`/`JSON.parse` shared try is split, so a malformed inner payload can no longer put decrypted plaintext into a `SyntaxError` message and out to the console. The scanner now covers `apps/ops-console/src` and `apps/auth-service/src`; the four keyword false positives were resolved by **rewording the log strings**, with the ban list left intact, and the new roots were mutation-proved with an injected `{plaintext: 'x'}` log line. Original text: `apps/ops-console/src/lib/messenger/runtime.ts`
      wraps `groupDecrypt` **and** `JSON.parse` in one try; if decrypt succeeds and parse fails, V8's
      `SyntaxError` message embeds a substring of the **decrypted plaintext** and it goes to `console.warn`.
      Split the try; the parse catch must log a **length**, never the error. Then widen `logAudit` to
      `apps/ops-console/src` and `apps/auth-service/src`, rewording (not deleting) the remaining
      keyword false positives.

### Phase 3 — Store contract (M11, M12)

- [x] **W14 ✅ `a395759`** — returns `string | null` (effective id, or null when deduped/rerouted). Also closed a latent hole in this session's own B-125 fix: `failGroupSend`/`failDirectSend` flipped the bubble using the PRE-rewrite id, so the very thing that keeps typed text on screen could itself have silently no-opped. **Wire identity deliberately unchanged** — `clientMsgId` must stay `msgId` (BS-REACT-AUTHOR + it is what collapses a group fan-out to one row), so outbox/pending are untouched and `localMsgId` sits alongside. **B-683 recorded exception (2026-08-27):** the GROUP tap-to-retry lane mints a fresh wire id when the prior attempt was relay-accepted — the relay's dedup memo survives the envelope's ack, so a same-id retry delivers nothing. Bounded to the all-legs-dead population (nobody holds the round-1 message), mirroring the 1:1 B-122 trade; a member's reaction/reply to the retried message misses the author's bubble (accepted, documented at the mint site). Full artifact reset precedes the fan-out (`resetWireArtifactsForResend`) — the retract slots are FIRST-WINS and a stale token turns every receipt probe 'unknown'. Original text: Change `messengerStore.ts:200` to
      `=> string | null` (`null` = deduped/dropped). Assign into a closure variable inside the `set()` and
      return it after. **Then migrate all four outbound holders** (`sendText` group, `sendText` 1:1, `sendMedia`,
      `runtime.ts` loopback) _and_ the inbound append→upsert pairs so SQLite stores the `#N`-suffixed id.
      ⚠️ **`failGroupSend` currently flips `updateMessageStatus(…, msgId, 'failed')` with the PRE-rewrite id** —
      the B-125 fix's own failure path silently no-ops if the id ever forks. Fix it here.
      Also add a `console.warn` on a miss in `updateMessageStatus` — a silent miss is what makes this invisible.
      **Run §5 in full. This is the highest-caller-count change in the plan.**
- [x] **W15 ✅ `f06cbb5`** — the dispatcher now mints the row explicitly through a new shared `directPlaceholderConversation()` that the store's shadow-create also uses (one minter, not two). **Discovered en route:** the `Bravo · ` prefix is load-bearing — `useRegisteredNames` backfills only that prefix, so `MainNavigator.tsx:610`'s hand-rolled `userId.slice(0, 8)` label creates rows whose name is **never** backfilled. One-line follow-up, left for its own commit. Superseded text: `callDispatcher.ts:137` and
      `CallScreen.tsx:1405` append an inbound call bubble with `sender_id = <peer>`, which trips the direct
      shadow-create at `:582` and manufactures a `Bravo · xxxxxxxx` chat row from a **missed call**. The group
      branch already has a `'Call'` sentinel; the direct branch has none. Make both call sites call
      `upsertConversation` explicitly first — copy the already-correct pattern at `MainNavigator.tsx:610-621`.
- [x] **W16 ✅ `d2cfa0a`** — `materialiseConversationForAppend()` returning `{kind: 'rerouted'|'row'|'none'}`. **Pure move, no behaviour change**; the two known divergences (reroute skips the mute check, and skips the typing-clear) are PRESERVED and now documented at the new function — each owed its own commit + test. The load-bearing early return is an explicit `'rerouted'` signal instead of a bare `return` 90 lines deep. Verified by regression breadth (7 appendMessage suites, 58 tests, unchanged). Original text: Move `:582-683` into one
      non-exported `ensureConversationRowForInboundAppend(s, id, msg)`. Keep the re-route inside it and return
      `'rerouted'` so `appendMessage` still early-returns. Also make Outcome D loud: today a direct-shaped id
      with a falsy `msg.peer` appends **with no conversation row at all** and no log line.
      ⚠️ **The re-route early `return` at `:626` is load-bearing and currently drifted** — it skips the
      typing-clear block (B-117) and uses an unread rule at `:619` that **omits the mute check** present at
      `:690`. **Do not "clean up" either divergence in the commit that moves the code.**

### Phase 4 — Locks and the persistence floor (M14, M8)

- [x] **W17 ✅ `404aab9` — and it was a LIVE P0 (B-130), not a latent one.** A 4–6 message burst silently stopped the receiver until restart. **The runbook's proposed fix here was WRONG** and would have traded a liveness bug for a retract-resurrection bug: dropping the outer `chainOp` breaks audit #18, because `remove()` is raw autocommit on chain B and never touches A, so a batch delayed behind a receive backlog would land after a later DELETE and `INSERT OR REPLACE` cleared messages back. The shipped fix instead **keeps** chain B and removes the flush's acquisition of A (raw `writeRows()`), killing the only B→A edge. Superseded text: Drop the outer `chainOp` at `sqlMessageStore.ts:120` and give
      `upsert`/`remove` the two-case guard `saveIdentity` already uses
      (`isInsideRatchetTxn()` → inline; else `runWithRatchetTxn`). ⚠️ **The unconditional form self-deadlocks** —
      `upsert` is called from _inside_ the receive txn at six sites. `runWithRatchetTxn` is FIFO across the whole
      connection, which is **strictly stronger** than the per-conversation chain it replaces.
      _Test first:_ the regression must **hang to timeout** on `09ee39d` before the fix.
- [x] **W18 — Kill AB-BA pair 2 (M14) — the pair the brief never found.** ✅ `450d3b5`, logged as **B-140**.
      `ensureOutgoingSession` / `forceRefreshOutgoingSession` took `SessionManager.locks` then `txnChain` (via
      `saveIdentity`), the inverse of the receive path. Now wrapped in `runOnTxnChain` (`:4800`, `:4829`,
      `:6007`, `:6011`) with `keys.fetchPeerBundleWithPoolSize` deliberately left OUTSIDE — holding the global
      chain across a network round-trip would trade a deadlock for a stall on every receive.
      **Retires the last known instance of the family behind P0-1 (2026-07-09), B-72, B-75 and B-130.**
- [x] **W19 (first half) ✅ `50d41fd`** — 9 cases against a real engine, incl. three that DOCUMENT sharp edges so a later fix has something to flip. The memory↔disk convergence half is still **W14**. Original text: New `sqlMessageStoreEngine.test.ts` adapting `better-sqlite3`
      (from **W3**) to the `DbHandle` shape, running the real DDL and the real `SqlMessageStore`. Assert:
      100 distinct envelopes → 100 rows; same `(conversation_id, id)` with different content → **1 row, first
      body gone** (lock the current silent-loss behaviour or fix it); same `envelope_id`, different id → 2 rows.
      Then close the memory↔disk divergence (depends on **W14**) and make `hydrateMessages` dedup on
      `envelope_id`, not just `id`, so a duplicate that reached disk does not resurface after every restart.

### Phase 5 — Inbound extraction (M5, M10, M13)

> **Do not start Phase 5 before W7.** Until the pre-push hole is closed, "gates green" on a
> `productionRuntime.ts`-only diff is meaningless.

- [x] **W20 ✅ `452f9ab`** — census pinned at **25 bare returns / 9 typed**, plus a window-free "every destroyed-note reaches an exit" rule and a "no `relay.ack` inside the txn" rule. **Proved it ratchets:** injecting one silent early return flips it to `Expected: 25, Received: 26`. This is the prerequisite for W23/W24 — moving code containing 25 message-destroying decision points is only safe once they are counted. Original text: Static scan asserting `doHandleIncoming` has exactly **27** bare
      `return;`, **9** typed `return {kind:`, and that every `noteDestroyedEnvelope(` sits within 6 lines above
      a `return;`. **When it fails, reclassify the new exit — never relax the constant.**
- [x] **W21 ✅ `d644e47`** — one shared `ackDispositionFor()`; **the first extraction that shrank `productionRuntime.ts`**. Carried one intended parity fix: the drain site now logs ACK ok/FAILED like the WS site always has (a drain ack failure was silently swallowed before). Pinned by a source scan that goes red if the inline ternary reappears in either variable spelling. Original text: One shared
      `ackTerminal(relay, envelopeId, ackToken, handledOk, leaveOnRelay, tag)` containing the
      `takeDestroyedEnvelope` + disposition computation currently duplicated at `:5698-5701` and `:7895-7897`,
      plus the ACK-ok/ACK-FAILED logging that is **WS-only today** (drain ack failures are invisible).
      Rename drain's `handled` → `handledOk` so a grep for one stops missing the other.
- [x] **W22a — Unify the in-flight guard placement (M5 D2).** DONE. The drain now takes
      `inFlightEnvelopes` at the TOP of its loop body, where the WS path already took it, with the
      ENTIRE 260-line body wrapped in ONE `try { … } finally { delete }`.

  Deferred three times for a good reason, and the reason dictated the shape: moving the `add` up means
  every `continue` in the unwrap and cert blocks — which previously ran BEFORE the add and so owed no
  release — now owes one. Hand-auditing them is how you miss one, and **a missed release leaves the id
  in the set for the PROCESS LIFETIME**, so that envelope can never be processed again until restart —
  permanent silent loss, strictly worse than the duplicated keys-service fetch it fixes. A `continue`
  inside a `try` still runs the `finally`, so the single wrapper is exhaustive **by construction**
  rather than by review. Pinned by `inFlightGuardParity.test.ts` (6 cases), mutation-proved on BOTH
  failure modes: release moved out of the `finally`, and the guard relocated back down.

  First attempt broke the build — the `finally` bound to the ack block instead of the new `try`, and a
  brace duplicated. Caught by typecheck (2 errors, not 47), restored from a scratchpad copy, redone
  with a brace matcher instead of hard-coded line numbers.

  > **W22 groundwork done (`3aad19c`).** The drain's hand-rolled trust-anchor fallback is DELETED — `resolveExpectedSenderIdentity` now takes `keys` as honestly optional and both paths make the identical call. I measured the two ~85-line cert blocks with a normalised diff: the ONLY remaining differences are comment wording, the WS-only `crashRecord`, and the `return`-vs-`continue` exit primitive. That makes the wholesale extraction mechanical rather than a judgement call — do the diff again first to confirm.

- [x] **W22 ✅ `7fc4c0b`** — `admitSenderCert()` now serves BOTH receive paths; **166 lines of duplicated SECURITY logic removed, productionRuntime.ts 8,023 → 7,903** (largest single reduction of the session). The function decides and never acks — verdict is `proceed | ack-discard | leave-on-relay`, the caller acks, and a test asserts the shared module contains no `relay.ack(`. Verification semantics unchanged (stop-condition respected). Four D5 scans, mutation-proved. **Remaining M5:** the in-flight guard placement → **W22a**. Original text: One function covering the
      guarded `wasSeen` gate, the `unwrapOuter` try/catch (**keep the WS-only `crashRecord`**), and the whole v3
      cert block. It must **return** a disposition, never ack itself. Adopt the WS variant wherever the two
      differ, and delete drain's hand-rolled local-trust fallback. This collapses **9 of the 11** ack sites into
      two. Then unify the in-flight guard to the WS placement (outermost).
      _Export as `__receivePathInternals` and pin with `receivePathParity.test.ts`._
- [~] **W23 — S1, S2, S3, S4 ALL DONE; only S5 remains.** S4 `3a0b1ac` (one inbound builder) · S1 `c87a628` (in-txn sender claims) · S2 `cc46943` (AAD binding + killed its mirror) · **S3 `6252beb`** (inbound routing — the B-124 adoption point, pinned as deliberate with containment documented as downstream). **Every seam the audit marked SAFE is now extracted.** What is left is S5, the lane split, which the audit rated 'medium — do last'. Original text: S4 `3a0b1ac` (one inbound builder), **S1 `c87a628`** (in-txn sender-claims check — two security rules that no test could reach), **S2 `cc46943`** (AAD conversation binding + killed its mirror). Remaining: S3 (the narrow pure routing slice) and **S5 (the lane split — the big one)**. Original text: `buildInboundMessage()` now serves all four inbound lanes (drained / legacy / live group / 1:1), replacing four drifted ~20-key literals. The legacy lane's RECEIVE-time `created_at` is PRESERVED as an explicit param, not normalised — that is a behaviour change owing its own commit. **productionRuntime.ts 8,047 → 8,023**, second extraction to shrink it. S1 (`openEnvelope`), S2 (bind) and S3 (the narrow `:6600-6608` pure routing slice) still to do. Original text:
  ⚠️ **The genuinely pure routing slice is `:6600-6608` ONLY.** The reaction lane immediately below it calls
  `applyReaction` and `return`s, and runs a side-effecting blocked-peer gate — extracting the wider range as
  a "decision function" silently drops those effects. S1's output **must carry the cert claims** across the
  boundary (the admin lane consumes them). **S4 (one shared `LocalMessage` builder, 16 literal sites, 3 of
  them the divergent group builders) is the highest-value pure cut in the file.**
- [~] **W24 — The lanes (seam S5) — ⛔ PARTLY ARCHITECTURE-GATED. Measured, do not re-plan from scratch.**
  `applyGroupText` / `applyGroupAdmin` / `applyDirect` / `applyReaction`, each owning its own writes.
  Re-point `tamperKeyDivergenceStash.test.ts` at the real extracted lane instead of its mirror.

  **`doHandleIncoming` is 1,064 lines. Where they actually are:**

  | Range            |    Lines | What                             | Safe to extract?                                                                                       |
  | ---------------- | -------: | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | `:6288-6689`     |     ~402 | preamble, markSeen, AAD, route   | mostly done via S1/S2/S3                                                                               |
  | `:6690-6872`     |     ~183 | parse-fail: no_key stash, tamper | ⚠️ the `no_key` branch emits `request-group-key`                                                       |
  | **`:6873-7243`** | **~371** | **admin lane**                   | ⛔ **ARCH-GATED — see below**                                                                          |
  | ~~`:7244-7301`~~ |      ~58 | group text lane                  | ✅ **DONE** → `runtime/applyGroupText.ts` (137 L, 17 real tests)                                       |
  | `:7266-7300`     |      ~50 | 1:1 reaction + 1:1 **text** lane | ✅ text lane **DONE** → `runtime/applyDirectText.ts`; reaction lane MERGED into `applyReactionLane.ts` |

  **The single largest lane cannot be split by an agent working under `CLAUDE.md` alone.** The admin lane
  performs `verifyGroupCreateSignature`, epoch-monotonicity enforcement (G1), master-key installation and
  supersession (`isGroupKeySuperseded`), and `applyAdminAction` (roster + rekey). That is verbatim three of
  `CLAUDE.md`'s stop-conditions — _"group master key distribution, rekey on member removal, or epoch
  handling"_ and _"sender-cert verification"_. It also contains the **B-127 P0 fix**. Moving it is not a
  neutral code move: the whole point of a split is that the pieces can be reasoned about separately, and
  these pieces are load-bearing for group security.

  > ### ⚠️ Consequence for the brief's target — say this out loud, do not bury it
  >
  > The brief wants **no function over ~80 lines**. Extracting every lane marked ✅ above takes
  > `doHandleIncoming` from 1,064 to roughly **900** — still **11× the target**. **The brief's target for
  > this function is unreachable without architecture sign-off on the admin lane.** That is a decision for
  > the owner, not a matter of effort or budget, and no amount of further agent work changes it. Anyone
  > reporting "S5 done" without that sign-off has either skipped the admin lane (fine — say so) or crossed
  > a stop-condition (not fine).

- [ ] **W25 — Pin M13 + harden the drain.** Move `drainPendingGroup`/`replayGroupSealedDecode` into an
      exported sibling so they can be tested; assert **N separate balanced `BEGIN…COMMIT` pairs**, max txn
      depth 1, and that a poison row does not abort the drain. Add the missing `.catch()` at `:5967` (the
      sibling boot-drain at `:1713` has one) and an in-flight guard keyed by `groupId`.

### Phase 6 — Outbound extraction (M3) and notifications (M16, M6)

- [x] **W26 ✅ `47f38da`** — the 1:1 `!target.userId` throw moved below the append behind a `failDirectSend` flip (mirror of `failGroupSend`); `messageTopologyInvariants.test.ts` now pins the 1:1 branch too (comment-stripped scan, mutation-proved). **Residue:** the TOFU gate at ~:2371 still returns silently, but it is dark behind `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE` (open question #5). Original text: Move the 1:1 `!target.userId` throw (`:2764`) below its append (`:2803`) and give
      the TOFU gate (`:2371`) a bubble + `failed` flip instead of a silent `return`. Extend
      `messageTopologyInvariants.test.ts` to the 1:1 branch — the refactor's most likely silent regression is
      re-hoisting a validation above the 1:1 append, and **nothing currently catches that**.
      Also fix `ChatScreen.retrySend`: its catch only calls `setError` and never flips to `failed`.
- [ ] **W27 — `planSend` + `appendOptimistic`.** A pure planner that validates **before** anything is appended,
      one shared optimistic writer for both branches, two thin transport executors. **This is the cut that kills
      the B-125 class structurally.** Close the `opts.isGroup === true` bypass at `:2354` at the same time —
      demote it to a tie-breaker used only when the conversation row is absent — and delete the inline nav-time
      copy at `MessengerHomeScreen.tsx:605` that feeds it.
- [x] **W28 ✅ `f38e472`** — `onAfterCommit(fn)` in receiveTransaction: queues inside a txn, drains after COMMIT, **discarded on rollback**, runs inline outside a txn so foreground/self-send paths are untouched. Two tests and the PAIR is the point — rollback ⇒ no banner, commit ⇒ exactly one. Without the control, "never notify at all" would pass. Mutation-proved. Original text: Add an `onAfterCommit(fn)` hook
      to `receiveTransaction.ts`, drained **only** on the COMMIT branch and cleared without running on ROLLBACK.
      Wrap the notifier's terminal `post()` in it. Keep `messagePostedGeneration++` synchronous or the
      `fcmBootstrap` fallback double-banners.
- [x] **W29 ✅ `365cb9a` — this was a live "I never got notified" bug, not a theoretical one.** Mutation-proved: reverted to tail-only detection the drained message yields `Expected 2, Received 1`. Also added the control the naive fix breaks (a status flip must NOT re-notify — it rewrites the row object but keeps its id). Superseded text: Replace `lastTailByConvo` with a bounded
      per-conversation **seen-id set**, so an out-of-order spliced (drained) message still notifies. Preserve
      the bulk-hydration suppression and the baseline seeding verbatim.
- [x] **W30 ✅ `9a262a1`** — the two clock-window cert failures now return `leave-on-relay` instead of ack-`discarded`; everything else stays terminal. **A four-site change in the brief became a ONE-site change** because W22 had already made the cert admission a single function. The classifier lives in `receiveTransaction.ts` (Tier A) — putting it in `senderCertAdmit.ts` made it untestable, since that module pulls react-native via crashlytics. Bound is the relay's 30-day dwell, not a retry budget. Original text: ⚠️ **Do NOT reorder `markSeen`/`verifySenderCert`** — that is a
      no-op for cert throws (already rolled back by the txn) and it breaks five clean-return branches that
      depend on the burned ratchet being deduped. Instead add `isTransientCertError` next to
      `isTransientSqlError`, matching **only** the two clock-window messages, and wire it at the four destroy
      sites to leave-on-relay. Separately make the AAD `reason === 'future'` branch **throw** instead of
      cleanly returning (its own comment at `:6506-6508` concedes it destroys the message). Bound it with the
      existing retry budget so a permanently-wrong clock degrades rather than loops for 30 days.

### Deferred / parked

- [ ] **`ChatScreenInner` (1,666 lines, zero tests).** Not in scope until Phase 6 lands. Its commits average
      **34.3 files each**, making any regression near-impossible to bisect. When you do get here, read the
      brief's §5.6 "ordering rules that look removable and are not" **first** — several are native crashes.
- [x] **B-127 (P0 SECURITY) ✅ `66f8546`** — fixed by the concurrent session; the decision now lives in
      `runtime/inboundGroupCreateGate.ts` (`decideGroupCreate`, imported at `:82`, used at `:~6973`). The
      predicted collision with W23/W24 did not materialise because the logic was extracted rather than
      inlined — S1–S4 landed around it cleanly.
- [~] **B-128 (P1 SECURITY) — part 1 fixed, part 2 arch-gated.** ✅ Part 1: the group-reaction lane now
  applies the P1-N4 membership gate it never had (a non-member who knew a groupId could react into any
  group; a removed member kept reacting forever). Mirrors the text lane including its `existing &&`
  fail-open, notes the drop so the sender is acked `discarded` not a false ✓✓, and bumps the M10 exit
  census 25 → 26 deliberately. Pinned by `groupReactionMembershipGate.test.ts`, RED-first, two mutation
  proofs. ⛔ Part 2 (reaction AAD is only `{to, ts}`, so `verifySealedAad`'s conversation/group checks are
  inert) is a **CLAUDE.md stop-condition** — sealed-sender envelope shape / AAD binding. **The part-1 gate
  does not substitute for it:** it is enforced by the receiver's group state, so it stops a stranger
  reacting into your group, but the envelope is still not cryptographically bound to a conversation.

---

## 7. Automated gates (run all, in this order)

```bash
# 1. The invariant suites — fastest signal, run these on EVERY work item
npx jest --selectProjects messenger-crypto --testPathPattern \
  "messageTopologyInvariants|messagingLogic|callKeyContaminationPrune|callGroupGhostGuards|groupCreateGate|appendMessageDedup|receiveTransaction|logAudit|\n   receivePathParity|receivePersistenceInvariants|receiveBurstDeadlock|stashDrainGateParity|groupReactionMembershipGate|\n   applyGroupText|applyDirectText|applyReactionLane|planSend|chatScreenLogic|inFlightGuardParity|drainPendingGroupGuards|prePushScanSweep"

# 2. Full crypto project — TWICE (see B-126 below)
npm run test:crypto
npm run test:crypto

# 3. App project
npx jest --selectProjects app

# 4. Type + lint gates
npm run typecheck   # must be <= .tsc-baseline.json = 47
npm run lint        # your files must add zero problems
```

> ### ⚠️ B-126 — a red run is not automatically evidence, and neither is a green one
>
> `npm run test:crypto` has a **pre-existing intermittent failure** (proven on a clean tree and at `cea64f8`).
> `09ee39d` fixed one real cause (a `Promise.allSettled` resolution-order race in `groupBroadcast.test.ts`),
> but **`incomingRingtone` still flakes** with a _different_ signature: suite-level failure with **zero failed
> tests**, i.e. teardown / open handle, consistent with the `A worker process has failed to exit gracefully`
> warning every run prints.
>
> **Rule: run the suite twice. A failure that names the same test both times is yours. A failure that moves is
> B-126.** Never dismiss a repeated failure as flake, and never claim green off a single run.

### Two gates that do NOT protect you

1. **`.husky/pre-push` selects zero tests for a `productionRuntime.ts`-only diff** (until **W7**).
2. **Two tsc baselines:** `.tsc-baseline.json` = **47** (pre-push) vs `.tsc-baseline` = **100**
   (`scripts/release-apk.ps1`). The release gate is 53 errors looser than the push gate.
3. **CI is dead** — GitHub Actions has been failing on account billing since ~2026-07-10, and the `TypeScript`
   job runs bare `tsc --noEmit` against 47 known errors so it can never pass. **0 of the last 100 commits went
   through a PR.** Local gates are the only gates.

---

## 8. Device / data verification

Unit tests verify code correctness, not feature correctness. For any item that changes send, receive, or
notification behaviour, exercise on a device (or state explicitly that you could not):

1. **1:1 golden path** — send + receive text both directions; ✓✓ appears; no duplicate bubble.
2. **Group golden path** — send + receive in a real group; reactions land on the author's own message.
3. **The B-124/B-125 regression** — start a 1:1 call, escalate it, end it, then **send a text in that same
   chat**. Expected: one thread only, message sends, no `no other participants` error, composer not emptied.
4. **Offline catch-up (the `drainRelay` path — this is the path users actually hit).** Kill the app, have a
   peer send 3 messages, relaunch. All 3 must land, in order, exactly once.
5. **Blocked-peer parity (W8b)** — block a peer who has a stashed group envelope, then trigger a key
   arrival/boot drain. The message must **not** render.
6. **Notification parity (W28/W29)** — background the app, receive a group message that arrives out of order
   (via drain). A banner must appear, and the badge must match the rendered unread count.

```bash
adb logcat -s ReactNativeJS | grep -E "bravo\.(send|drainRelay|group)|messenger\.deliver|store\.append"
```

---

## 9. Sign-off criteria

- [ ] §7 gates green — **crypto suite run twice**, same result, zero failing tests
- [ ] `npm run typecheck` ≤ 47; `npm run lint` adds nothing
- [ ] The §5 caller list is **in the commit body**, with a per-inherited-caller verdict
      (_fixes it / no change / regresses it_)
- [ ] Every §3 invariant the diff touches is re-checked and its **status column updated in this file**
- [ ] The work item's box in §6 is ticked **in the same commit**
- [ ] A new or modified test exercises the new behaviour, and (for a bug fix) it was **RED first** —
      mutation-prove it against `git show <baseline>:<file>`
- [ ] Nothing in the diff softens `verifySenderCert`, `verifySealedAad`, the membership gate, the blocked-peer
      gate, the epoch guard, or the file-vault MFA gate
- [ ] `sqa.md` updated if a bug was found or fixed
- [ ] If the change reaches backup (`notifyBackupDirty` fires on every status flip), **`BACKUP_LOOP.md` was
      also run**

---

## 10. Stop conditions — halt and ask a human

**Architecture-gated (`CLAUDE.md` stop-conditions). Do NOT do these unilaterally:**

1. **M4 — the call-key namespace.** Giving call keys their own namespace (`isCallGroup`/`ephemeral` on
   `GroupState`, or a separate `callKeys` map) is **the correct structural fix** and would retire all **8**
   `name === 'Call'` string sentinels. But `GroupState` is a **cross-device shape**, and host and receiver must
   agree on the slot or **every escalated call fails closed**. Escalate; do not implement.
2. **Any change to the wire stamp, sender-cert verification order, AAD binding, or group master-key
   distribution.**
3. **B-127** — the ungated `create` install. ✅ Fixed (`66f8546`) by a parallel session, extracted into
   `runtime/inboundGroupCreateGate.ts`. Residual B-127b (pre-emptive poison of a keyless slot) is still gated.
4. **B-128 part 2 — the reaction AAD.** Reaction envelopes seal with an AAD of only `{to, ts}`, so
   `verifySealedAad`'s conversation/group checks are inert for them. Part 1 (the membership gate) shipped and
   stops the practical attack, but it is **receiver-state enforcement, not a cryptographic binding** — do not
   close part 2 on part 1's strength.
5. **W24/S5 — the admin lane of `doHandleIncoming` (`:6873-7243`, ~371 lines).** Discovered while planning
   S5: this lane does `verifyGroupCreateSignature`, epoch-monotonicity (G1), master-key install/supersession,
   and `applyAdminAction` (roster + rekey) — three stop-conditions in one block, plus the B-127 fix. **It is
   the single biggest lane, so gating it puts the brief's "no function over ~80" target out of reach for this
   function without owner sign-off:** every remaining safe extraction still leaves `doHandleIncoming` around
   900 lines. Escalate the decision; do not quietly split it, and do not quietly report S5 as done.

**Already evaluated and REJECTED — do not re-propose:**

| Proposal                                                                                       | Why it is wrong                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suppress the group stamp for device-local ids (brief §9 item 3a)                               | `e64d56c` rejected this with evidence: the body is **group-encrypted before** the stamp and the AAD binds the same id, so suppressing the stamp leaves the AAD mismatched → **`conversation_mismatch` destroys every message**.                                                                                                                                                                     |
| "The B-10 comment at `ensureCallGroupKey` is false — restore it by deleting the `:4458` alias" | The comment is **stale prose, not a live contradiction**; the hazard it describes is still structurally prevented by the `isReal` guard. Deleting the alias **re-opens B-106** (a fresh `'Call'` group minted on every re-escalation, unbounded `groups[]` growth) **without touching B-124 at all**.                                                                                               |
| Split `setGroupState` into `setGroupKeyState` + `syncGroupMembership`                          | The participants sync is **already gated** on `type === 'group' \|\| 'ops_channel'`, so the hazard cannot occur. Splitting converts an _enforced_ invariant into a _convention_ across 11 call sites, three of which run **inside the receive txn**. Net risk strongly negative.                                                                                                                    |
| Make `runtime.ts` "adopt" the extracted send modules                                           | **The brief's framing here is wrong.** `runtime.ts` is the runtime **factory/dispatcher** plus an inline **loopback**; its `sendText` is unreachable in production (`buildRuntime` returns early for `mode === 'production'`, and a release build is always `'production'`). Its production importers want `getOwnCryptoStore`, not sending. Do not pull production code into the loopback harness. |
| Wire up `SqlMessageStore.wipe()`                                                               | Unreferenced dead code that deletes the entire messages table **outside** `chainOp`. Someone doing this refactor will be tempted. **Do not.**                                                                                                                                                                                                                                                       |

**Halt immediately if:** a check is "in the way" of a refactor; a cut requires a follow-up fix to be safe
(`git revert <sha>` must always be sufficient); or a static invariant test fails and the tempting fix is to
relax the assertion.

---

## 11. Traps (verified — every one of these has already cost someone a day)

1. **Line numbers rot fast.** `productionRuntime.ts` grew **+143% in 8 weeks**. The brief's numbers are ≥+16
   off; `sqa.md` entries from 2026-07-11 are ~170 rows off. **Anchor on symbols. Always re-grep.**
2. **Two files named `messengerStore.ts`.** `src/store/messengerStore.ts` (120 lines, **dead**, Twilio-era) vs
   `src/modules/messenger/store/messengerStore.ts` (**the real one**, 1,586). A grep-driven refactor hits the
   wrong one.
3. **Two files named `groupBroadcast.test.ts`** — `src/modules/messenger/__tests__/` (373 L) and
   `packages/messenger-core/__tests__/` (778 L). Same trap.
4. **Two exported `isGroupConversation`s with different rules.** See §5.
5. **`messageTopologyInvariants.test.ts` is brittle by design.** It depends on the literal strings
   `'sendText: async'`, `'sendMedia:'`, `'appendMessage(conversationId, msg)'`, `'participants.length === 0'`,
   `'MAX_GROUP_FANOUT'`, `'failGroupSend'`, `'isGroupConvo('`, `'hasGroupState && !isDirectRow'`.
   **Any cut to `sendText` or `messagingLogic` breaks it, and it must be updated in the same commit.**
   Its own header says: do not relax it.
6. **Static source scans do not close the `--changedSince` hole.** `readFileSync` creates no module edge (**W7**).
7. **Mirror tests lie.** `adhocCallKeyLookup.test.ts` is green while describing code that no longer exists
   (**W5**). `groupCreateEpochBootstrap.test.ts` was the same until `9c23add` fixed it **and added a drift
   guard** — copy that pattern for every mirror.
8. **`.eslintignore` excludes `apps/` entirely.** The backend is unlinted.
9. **The graph MCP reports line numbers 30–96 lines off on this file**, and on Windows stores backslash paths so
   a `file_path_pattern` filter silently returns zero hits and looks like "not indexed". Verify with grep.
10. **Every `s.messages` mutation is a disk write** (`productionRuntime.ts:1768`). A vanished conversation
    **key** deletes every persisted row for it, plus its media blob cache and decrypted temp files.
11. **Every status flip calls `notifyBackupDirty`.** A change that flips ticks more often multiplies
    backup-mirror traffic and Merkle recommits — the module `BACKUP_LOOP.md` guards.
12. **`dispatchFrame` does `void handleServerFrame(...)`.** Adding an `await` inside any switch case reorders
    it relative to every other frame class.

### The sibling-module conventions your new module must match

`src/modules/messenger/runtime/` holds 29 siblings, max 425 lines, 24 of 30 tested. **The `messenger-crypto`
jest project runs `testEnvironment: 'node'` with no RN preset — a module that transitively imports
`react-native` or React CANNOT be tested.** That is the real reason for `messagingLogic.ts`'s
"No React / react-native / store imports" header rule, and it must survive any consolidation.

- **Tier A (prefer):** zero imports, pure. `messagingLogic.ts`, `outboxCertFreshness.ts`, `receiveTransaction.ts`.
- **Tier B:** `import type` only.
- **Tier C (appliers):** one value import of `useMessengerStore`; call `.getState()` inside.
- **Never:** import `productionRuntime.ts` (circular), or React/react-native.
- State arrives as a **local structural interface**, not the store's real types.
- Decisions return **discriminated unions**; they do not mutate. Module-level mutable state pairs with an
  underscore-prefixed `_reset*()` test hook.
- Header doc-comment is **mandatory** and states **why + the bug ID**, never what the code does.
- New module → `src/modules/messenger/runtime/<camelCase>.ts`; its test →
  `src/modules/messenger/__tests__/<sameName>.test.ts` (there is **no** `runtime/__tests__/`).
- **Do not** add it to `runtime/index.ts` — that barrel re-exports only the factory.

---

## 12. Open questions — answered

| #   | Question                                                                 | Answer                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is an in-memory SQLite engine available for M8?                          | **NO.** Only `@op-engineering/op-sqlite`, a native RN module that cannot load in the node jest project. Adding `better-sqlite3` as a devDependency is **W3** — the single piece of new infrastructure the whole plan needs. |
| 2   | Is `runtime.ts` a second production implementation to delete?            | **NO — the brief's framing was wrong.** It is the factory/dispatcher plus a loopback; its `sendText` is unreachable in production. It cannot be deleted and must not adopt the extracted modules. See §10.                  |
| 3   | Veto or delete the `!!groupState` clause?                                | **Answered and shipped.** The clause stays (untyped/absent rows need it for an admin-create that lands before `/conversations/mine`), double-vetoed by a type veto **and** an id-shape veto.                                |
| 4   | Fix the `markSeen` order as part of this programme, or track separately? | **Neither, as posed.** Reordering is a no-op for cert throws and breaks five clean-return branches. The real fix is transient-error classification — **W30**.                                                               |
| 5   | Is `EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE` intended to ship?             | **STILL OPEN — ask the owner.** If yes, `sendText:2371` is a latent B-125 and **W26** must land first.                                                                                                                      |
| 6   | Priority between the live CRITICAL and the structural work?              | **Answered by events.** B-124/B-125 were fixed first, with the test that had never been written. That is the template: fix the live bug, pin it, then extract.                                                              |

---

**Remaining open question for the owner:** #5 above, plus whether **M4** (the call-key namespace) is approved.
M4 is the write side of the contamination that produced B-124/B-125. Until it is approved and done, this
runbook is doing what `BACKUP_LOOP.md` §3 warns against — patching the read side while the write side keeps
manufacturing drift.
