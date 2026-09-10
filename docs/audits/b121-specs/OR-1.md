# OR-1 — Outbox has no background / killed / reboot send pipeline (and no resume-drain on foreground or network-regain)

## Verdict

**CONFIRMED-WITH-DRIFT.** The structural claim is exactly right; two of the audit's details are
imprecise, and the audit _missed_ the cheapest and most impactful part of the same defect.

Evidence from the current tree:

1. There are exactly **three** `drainOutbox` trigger sites, all inside the live JS runtime:
   - boot — `src/modules/messenger/runtime/productionRuntime.ts:1601`
     `void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);`
   - WS `'connected'` — `productionRuntime.ts:1133-1135`
     `if (sqlOutbox) { void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow); }`
   - a 60 s interval — `productionRuntime.ts:1612-1614`
     `const outboxRetryTimer = setInterval(() => { void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow); }, 60_000);`
2. **Zero Bravo-owned receivers / scheduled jobs.** `android/app/src/main/AndroidManifest.xml`
   contains `<uses-permission>`, one `<activity>`, four `<service>` entries (`.CallForegroundService`,
   `io.wazo.callkeep.*`, `app.notifee.core.ForegroundService`) and **no `<receiver>` element at all**.
   `package.json` has no `expo-task-manager`, `expo-background-fetch`, or any WorkManager JS wrapper,
   and no Bravo Kotlin file references `HeadlessJsTaskService`
   (`android/app/src/main/java/com/bravosecure/app/` = battery-opt / call-FGS / frame-cryptor /
   ringtone modules only).
3. **The killed-app FCM path never touches the outbox** and says so:
   `index.js:42-46` — “`handleHeadlessFcm` is SLIM BY DESIGN: it ONLY draws the notifee message
   banner / full-screen call ring … It NEVER boots the messenger runtime, SQLCipher, or the WS —
   that 2nd-VM contention with the foreground app is exactly why the old `registerHeadlessTask` path
   was removed.” `src/modules/messenger/push/fcmHeadless.ts` has no import of the outbox/runtime.
4. **DRIFT (a):** the audit calls `:1612` a “FOREGROUND interval”. It is a plain JS `setInterval`; on
   Android it keeps firing while the app is _backgrounded but alive_ and only dies when the OS
   freezes or kills the process. The real boundary is **process death**, not backgrounding.
5. **DRIFT (b) — WorkManager and `RECEIVE_BOOT_COMPLETED` are ALREADY in the build.** The merged
   manifest (`android/app/build/intermediates/merged_manifest/…/AndroidManifest.xml`) shows
   `androidx.work:work-runtime:2.8.0` contributing
   `<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>` (blame report line 189) plus `androidx.work.impl.background.systemalarm.RescheduleReceiver` with a `BOOT_COMPLETED`
   intent-filter (merged manifest line 607-616), and notifee contributing
   `app.notifee.core.RebootBroadcastReceiver` on the same action. So the native half of the audit's
   fix needs **no new gradle dependency and no new permission** — and, decisively, **no custom
   `BOOT_COMPLETED` receiver either**: WorkManager persists enqueued work in its own DB and
   `RescheduleReceiver` re-enqueues it after reboot. See Phase 2.
6. **DRIFT (c) — the audit missed the bigger warm-path hole.** `AppState 'active'`
   (`productionRuntime.ts:1428-1488`) calls `coalescedDrain()` (the **receive**-side relay pull) three
   times and `flushPendingReadReceipts()` — but **never `drainOutbox`**. Same for the NetInfo
   connectivity-regain handler (`:1298-1352`), which only calls
   `void transport.notifyNetworkChange()`. So even a _warm_ app that regains connectivity waits for
   the 60 s tick, and — worse — `dueRows()` filters on `next_retry_at <= now`
   (`src/modules/messenger/store/sqlOutboxStore.ts:119`) while the `unreachable` branch pushes
   `next_retry_at` out by up to `5 * 60_000` (`sqlOutboxStore.ts:59,236-243`). A device that comes
   back from a dead zone can therefore sit **up to ~5 minutes with live connectivity and an
   un-shipped message**, on every trigger path including WS reconnect.

## Mechanism

Outbound rows land in the durable outbox before the wire send
(`sqlOutboxStore.ts:18` “enqueue() — runtime writes BEFORE `transport.send()`”), and are deleted only
on a real ack (`markDelivered`). A row survives in `outbox` when the WS `envelope.accepted` never
arrives or the HTTP fallback throws (`productionRuntime.ts:3372`
`/* socket down + HTTP failed — leave the row for drainOutbox */`).

Failure sequence today:

1. User sends while offline / on a flaky link. `relay.send` throws; `isUnreachableError(e)` is true
   (`sqlOutboxStore.ts:71-75`), so `recordAttempt` **does not** burn the attempt budget but **does**
   push `next_retry_at = now + BACKOFF_MS[attempts]`, saturating at **5 min**
   (`sqlOutboxStore.ts:235-245`). The bubble stays `'sending'`.
2. User backgrounds the app. The 60 s interval keeps ticking while the process lives, so the row
   eventually ships **if** the process survives and connectivity returns.
3. **Process dies** (swipe-away, low-memory kill, OEM power manager, reboot). Every drain trigger
   dies with it: the interval is a JS timer, the WS `'connected'` handler needs a socket, the boot
   drain needs the app to be launched. There is no receiver, no job, no headless entry that reads
   `outbox`.
4. FCM wakes the process headless for _incoming_ traffic only, and `handleHeadlessFcm` deliberately
   does not boot SQLCipher (`index.js:42-46`), so even that wake ships nothing.
5. **Reboot** additionally guarantees nothing runs until the user manually opens the app — no
   `BOOT_COMPLETED` receiver exists.
6. Independently of (3)/(4): even when the app _is_ alive, foregrounding it or regaining the network
   does not drain the outbox, and the 5-minute `unreachable` backoff is never cleared by the
   connectivity signal that made it obsolete. Net user-visible symptom: “I sent it, came back to the
   app, and it still shows one tick for minutes.”

## Fix

### Assessment first — the audit's proposed fix is the wrong shape, and I recommend NOT shipping it

The audit says: “network-constrained one-shot job + BOOT_COMPLETED receiver scheduling the same job;
guard SQLCipher with a cross-process mutex like the mirror ledger.” Three concrete problems:

- **A drain is not a pure read.** `drainOutbox` re-seals two classes of row _in place_:
  the A4 deferred branch (`productionRuntime.ts:7426-7433`) and the SN-06 stale-cert branch
  (`:7446-7465`, `isStoredCertStale(payload.certExpSec)`). Certs live ~1 h, so **any row older than
  ~1 h takes the re-seal path**, and `resealDeferredGroupRow` (`:786-…`) calls
  `ensureOutgoingSession(...)` + `own.encrypt(peer, sealed)` — i.e. it **advances the Double Ratchet
  send chain and writes session state into the same SQLCipher DB**. A background writer doing that
  concurrently with the foreground process is exactly the corruption class the project already
  removed the headless task for (`index.js:44-46`; `docs/architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md:436`
  “the headless task was removed because a 2nd JS VM fought the SQLCipher lock”).
- **A cross-process mutex is necessary but not sufficient.** `drainOutboxInflight`
  (`productionRuntime.ts:7393`) is a _module-level_ boolean — a second JS VM gets its own copy and
  the guard silently evaporates. And the mutex would have to cover the ratchet transaction, which
  §15 of the architecture doc already flags as having an unguarded `BEGIN` on the shared handle.
- **Half of it is already there and the other half is redundant.** WorkManager + `RECEIVE_BOOT_COMPLETED`
  - a `BOOT_COMPLETED`-triggered `RescheduleReceiver` are already merged into the APK from
    `androidx.work:work-runtime:2.8.0`; a hand-written boot receiver is not needed at all.
- **It is arch-gated.** Per the batch constraints, OR-1 is **NOT-COVERED (needs human approval)**,
  with one **FORBIDDEN** sub-part (relaxing keychain accessibility so a boot-time process can unlock
  the store — `src/modules/messenger/runtime/keychain.ts:83-84`
  `accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`,
  `securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE`). It also needs a JWT minted with no user
  present (15-min TTL + Redis jti allowlist), and it must be checked against the `BACKUP_LOOP.md`
  I1–I9 invariants, which are written for a single-process writer.

So: **ship Phase 1 now** (pure JS, no arch gate, no schema change, ~35 lines) — it removes the entire
_warm_ latency class and shrinks OR-1's residual to “process is dead”. **Phase 2 is a separate,
architecture-approved change** and is specified at the end as a design, not as a diff.

---

### Phase 1 (ship in this batch)

#### 1. `src/modules/messenger/store/sqlOutboxStore.ts` — new `kickPending()`

Anchor (verbatim, end of `resetFailed`, currently the last method in the class):

```ts
  async resetFailed(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE outbox
          SET attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?
          AND status = 'failed'`,
      [Date.now(), clientMsgId, peerUserId, peerDeviceId],
    );
  }
}
```

Replacement (append the new method before the closing brace; `resetFailed` itself is unchanged):

```ts
  async resetFailed(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE outbox
          SET attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?
          AND status = 'failed'`,
      [Date.now(), clientMsgId, peerUserId, peerDeviceId],
    );
  }

  /**
   * OR-1 — connectivity just came back, so the offline backoff that
   * `recordAttempt({unreachable:true})` scheduled is stale by definition.
   * Pull every still-pending row forward to `now` so the next `dueRows()`
   * sees it instead of waiting out up to 5 minutes of dead time.
   *
   * Deliberately narrow: `attempts` is untouched (the retry budget still
   * means what it meant) and `status='failed'` rows are excluded — those
   * are server-rejected and only `resetFailed` may revive them.
   */
  async kickPending(now: number = Date.now()): Promise<void> {
    await this.db.execute(
      `UPDATE outbox SET next_retry_at = ?
        WHERE status = 'pending' AND next_retry_at > ?`,
      [now, now],
    );
  }
}
```

No schema change: `next_retry_at` and `status` already exist, so `SCHEMA_VERSION = 14`
(`src/modules/messenger/crypto/db.ts:54`) stays put. No wire change, so no back-compat concern.

#### 2. `productionRuntime.ts` — throttled kick+drain helper next to `drainOutbox`

Anchor (verbatim):

```ts
let drainOutboxInflight = false;
async function drainOutbox(
```

Insert immediately **above** it:

```ts
// OR-1 — a connectivity/foreground signal is the moment the `unreachable`
// backoff becomes meaningless, but socket.io flaps several times per handover,
// so the kick is throttled while the drain itself stays unthrottled.
const OUTBOX_KICK_MIN_INTERVAL_MS = 15_000;
let lastOutboxKickAt = 0;
export function _resetOutboxKickThrottle(): void {
  lastOutboxKickAt = 0;
}
function kickAndDrainOutbox(
  outbox: SqlOutboxStore,
  relay: RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): void {
  const now = Date.now();
  if (now - lastOutboxKickAt >= OUTBOX_KICK_MIN_INTERVAL_MS) {
    lastOutboxKickAt = now;
    void outbox
      .kickPending()
      .catch(() => {
        /* best-effort — the plain drain below still runs */
      })
      .finally(() => {
        void drainOutbox(outbox, relay, isOurEpoch, reseal);
      });
    return;
  }
  void drainOutbox(outbox, relay, isOurEpoch, reseal);
}
```

#### 3. `productionRuntime.ts` — drain on foreground resume

Anchor (verbatim, inside the `s === 'active'` branch):

```ts
// Audit P2-7 — foreground is a flush point for queued read receipts
// (no-op when the socket isn't connected; the onStateChange
// 'connected' branch flushes after the reconnect instead).
flushPendingReadReceipts();
```

Replacement:

```ts
// OR-1 — foreground is also a flush point for the OUTBOX. Only the
// receive-side coalescedDrain() ran here, so a message queued while the
// app was backgrounded/offline sat on the 60s timer even though the user
// is staring at the thread.
if (sqlOutbox) {
  kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
}
// Audit P2-7 — foreground is a flush point for queued read receipts
// (no-op when the socket isn't connected; the onStateChange
// 'connected' branch flushes after the reconnect instead).
flushPendingReadReceipts();
```

`sqlOutbox` is declared at `productionRuntime.ts:970` (`let sqlOutbox: SqlOutboxStore | null = null;`)
and `resealDeferredGroupRow` at `:786`, both above the `AppState.addEventListener` at `:1428`, so the
closure captures them without TDZ — the same shape the WS-`'connected'` site at `:1133` already uses.

#### 4. `productionRuntime.ts` — drain on connectivity regain

Anchor (verbatim, end of the NetInfo handler):

```ts
        void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
      }
    });
```

Replacement:

```ts
        void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
        // OR-1 — this fires in the background too, where the AppState twin
        // never runs. The socket may take seconds to re-handshake; the HTTP
        // relay path the drain uses does not need it.
        if (sqlOutbox) {
          kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
        }
      }
    });
```

Note the placement: it goes **after** the `pongFresh` / `hasLiveCall()` early-returns, so a healthy
in-call socket is untouched — only a genuine route change reaches this line.

#### 5. `productionRuntime.ts` — clear the stale backoff on WS reconnect

Anchor (verbatim, unique — the sibling at `:1601` is unguarded):

```ts
if (sqlOutbox) {
  void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
}
```

Replacement:

```ts
if (sqlOutbox) {
  kickAndDrainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
}
```

#### 6. `productionRuntime.ts` — reset the throttle on runtime teardown

Anchor (verbatim, in `disposeLiveRuntime`):

```ts
liveAppStateSub?.remove?.();
liveAppStateSub = null;
```

Replacement:

```ts
liveAppStateSub?.remove?.();
liveAppStateSub = null;
lastOutboxKickAt = 0;
```

Leave the boot drain at `:1601` and the 60 s tick at `:1612` as plain `drainOutbox` — boot already
re-reads every row and a periodic tick must respect backoff or the throttle is pointless.

---

### Phase 2 (architecture-gated — do NOT implement in this batch)

If and only if approved, the **only** safe native increment is a _read-only shipper_, not a runtime:

- **Do NOT write a `BOOT_COMPLETED` receiver.** `androidx.work:work-runtime:2.8.0` is already merged
  in, already brings `RECEIVE_BOOT_COMPLETED`, and already registers
  `androidx.work.impl.background.systemalarm.RescheduleReceiver` on `BOOT_COMPLETED` — WorkManager
  persists enqueued work and re-schedules it itself after a reboot. A hand-rolled receiver duplicates
  that and adds a cold-start attack surface for nothing. The audit's "BOOT_COMPLETED receiver
  scheduling the same job" is redundant in this build.
- So the whole native surface is: enqueue a `OneTimeWorkRequest` with
  `Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED)` from the JS side whenever the
  outbox becomes non-empty (and cancel it when the outbox drains empty), backed by a `Worker` that
  starts a headless JS task. `BOOT_COMPLETED` is delivered only _after_ first user unlock, so
  credential-encrypted storage is available — no `directBootAware`, and therefore **no
  keychain-accessibility change** (that sub-part stays FORBIDDEN).
- The task must ship **only** rows where `payload.outerSealed` exists **and**
  `isStoredCertStale(payload.certExpSec) === false` — pure `SELECT` → `POST /envelopes` →
  `DELETE`. Deferred rows and stale-cert rows are **skipped and left for the foreground**, because
  they mutate the ratchet. That single rule is what makes the SQLCipher contention tractable.
- Cross-process guard: the mutex must be a **file lock in the app sandbox** taken by both the
  foreground runtime and the job (the module-level `drainOutboxInflight` boolean cannot see across
  VMs), and it must be checked against `docs/runbooks/BACKUP_LOOP.md` I1–I9 (second writer vs.
  `mirror_flushed` ledger / flush-epoch guard) before merge.
- Open product/arch questions to answer in the amendment: how the job obtains a JWT with no user
  present (15-min access TTL + Redis jti allowlist), and whether shipping is even desirable while the
  user has not returned to the app.

Smallest correct increment = **Phase 1 only**. Follow-up ticket = Phase 2 amendment.

## Blast radius

- `src/modules/messenger/store/sqlOutboxStore.ts` — additive method only. Existing callers
  (`enqueue`, `dueRows`, `markDelivered`, `deleteByClientMsgId`, `deleteByConversation`,
  `recordAttempt`, `resetFailed`) are untouched. The one behavioural nuance: `kickPending` moves
  `next_retry_at` for **server-rejected** pending rows too (rows that failed with a non-unreachable
  error and still have budget). That is intentional — a connectivity change is new information — but
  it means a peer with a hard `410 unprovisioned` will burn its 10-attempt budget faster during a
  network-flappy session. Bounded by `OUTBOX_KICK_MIN_INTERVAL_MS`; call it out in review.
- `src/modules/messenger/runtime/productionRuntime.ts` — four call sites plus one helper.
  `drainOutbox` itself is unchanged, so the SN-06 cert-freshness path, the A4 deferred re-seal, the
  L17 group-downgrade guard, and `recordAttempt`'s SN-04 semantics all keep their current behaviour.
- **More frequent re-seals.** Kicking rows forward means the SN-06 stale-cert branch
  (`:7446`) and `resealDeferredGroupRow` run sooner and possibly more often. Each re-seal calls
  `certCache.get()` and `ensureOutgoingSession` → the peer's OPK is popped unless
  `peerIdentityCache` (8 min TTL, `:774-776`) covers it. Watch for OPK-pool pressure on a device that
  churns networks with a large deferred queue.
- **Overlaps with other findings in this batch:** anything editing the AppState-`'active'` branch or
  the NetInfo handler (call-continuity / resume work, B-100/B-101 lineage) collides textually with
  edits 3 and 4. OM-05 (re-seal `aad.ts`) and OM-02 (display-timestamp clamp) both touch
  `drainOutbox`'s re-seal region — sequence OR-1 first (it does not modify `drainOutbox`) or expect a
  merge in `productionRuntime.ts:7394-7529`.
- **No wire change, no schema change, no envelope/AAD/cert change.** No CLAUDE.md stop condition is
  crossed by Phase 1. Nothing is logged that could trip
  `packages/messenger-core/__tests__/logAudit.test.ts` (`kickPending` logs nothing; the drain's
  existing warns carry only `clientMsgId`/peer ids, unchanged).
- **Regression candidates:** (a) a drain storm if the throttle is dropped in review — a captive
  portal can emit NetInfo events every few hundred ms; (b) `drainOutboxInflight` already serialises
  concurrent drains, so edits 3/4/5 firing together are coalesced, not stacked; (c) `isOurEpoch()`
  guards inside both closures already bail after logout — do not remove them.

## Tests

Jest project **`messenger-crypto`** (`npm run test:crypto`) — `testMatch` covers
`src/modules/messenger/__tests__/**/*.test.ts`.

1. **`src/modules/messenger/__tests__/sqlOutboxStore.test.ts`** (existing; extend the hand-rolled
   `makeFakeDb` with a branch for `UPDATE outbox SET next_retry_at = ? WHERE status = 'pending' AND next_retry_at > ?`):
   - `kickPending()` pulls a pending row whose `next_retry_at` is `now + 300_000` back to `now`;
     a subsequent `dueRows(now)` returns it (before the kick, `dueRows(now)` returns `[]`).
   - `kickPending()` leaves `attempts` unchanged (assert the exact prior value).
   - `kickPending()` does **not** touch a `status: 'failed'` row — after the kick, `dueRows` still
     excludes it and only `resetFailed` revives it.
   - `kickPending()` does not push a row whose `next_retry_at` is already in the past _forward_
     (guarded by `next_retry_at > ?`); assert the original `created_at`-ordered `dueRows` sequence
     is stable.
2. **`src/modules/messenger/__tests__/outboxKickThrottle.test.ts`** (new): import
   `_resetOutboxKickThrottle` and drive `kickAndDrainOutbox` against a stub `SqlOutboxStore`
   (`kickPending` spy, `dueRows` → `[]`) and a stub relay:
   - two calls 1 s apart ⇒ `kickPending` called **once**, `dueRows` called **twice**.
   - a third call after advancing fake timers past `OUTBOX_KICK_MIN_INTERVAL_MS` ⇒ `kickPending`
     called twice.
   - `_resetOutboxKickThrottle()` re-arms the kick immediately (proves edit 6).
   - `isOurEpoch() === false` ⇒ the drain returns without calling `relay.send` (existing guard,
     assert it survives).
     Follow `callResumeGuard.test.ts`'s style: exercise the real helper, stub only the I/O edges.
3. **Regression suites to run:** `npm run test:crypto` (whole `messenger-crypto` project — in
   particular `sqlOutboxStore.test.ts`, `outboxCertFreshness.test.ts`, `archiveReplayDrain.test.ts`,
   `bootGroupStashDrain.test.ts`, `restoreResume.test.ts`, `callResumeGuard.test.ts`), then
   `npm test`. `npm run typecheck` must stay ≤ 47 (`.tsc-baseline.json`).
4. **Device probe (cannot be covered by Jest — state it explicitly if not run):** airplane-mode →
   send 3 messages → confirm 1-tick → background the app 2 min → airplane-mode off → foreground.
   Expect all three to flip to `sent` within ~2 s of foreground, not after 60 s. Second probe:
   same setup, but re-enable the network while the app is still backgrounded — the NetInfo path
   should ship them without a foreground transition. Third probe (documents the _residual_):
   airplane-mode, send, **swipe the app away**, re-enable the network, wait 10 min — the message
   still will not ship until the app is opened. That is Phase 2 and must be recorded as a known gap.

## Risk

- **Reviewer suspicion #1 — is `kickPending` too broad?** It clears the future `next_retry_at` for
  _all_ pending rows, not just the ones parked by `unreachable`. There is no column recording _why_
  a row was backed off, and adding one is a schema bump; the throttle is what keeps this safe.
  If a reviewer wants it narrower, the cheap variant is to only kick rows with `attempts = 0`
  (the pure-offline case) — weaker, but zero risk of accelerating a server-rejection budget burn.
- **Reviewer suspicion #2 — NetInfo chattiness.** Edit 4 sits inside a handler whose comments
  (`:1309-1321`) document that Android emits flapping `isInternetReachable` events. It is placed
  after the `pongFresh` and `hasLiveCall()` early-returns and behind the 15 s throttle; confirm both
  guards are still upstream of the new lines after any rebase, or a captive portal turns into a
  drain loop during a call.
- **Reviewer suspicion #3 — hidden re-seal amplification.** Faster drains mean the SN-06 stale-cert
  re-mint (`:7459` `console.warn('[messenger.outbox] re-sealing stale-cert row …')`) and the A4
  deferred re-seal run more often. Grep a release logcat for that warn during the device probe; a
  burst means OPK pressure, not correctness loss.
- **Reviewer suspicion #4 — the audit's own fix.** If anyone tries to implement the WorkManager job
  as written (“cross-process mutex like the mirror ledger”), it will re-open the exact failure the
  project already paid for. The load-bearing constraint is that `drainOutbox` **writes ratchet
  state** via `resealDeferredGroupRow` for any row older than the ~1 h cert TTL. Any Phase-2 job that
  does not hard-skip deferred + stale-cert rows should be rejected on sight.
- **Reviewer suspicion #5 — throttle state and multi-account.** `lastOutboxKickAt` is module-level
  and therefore shared across a logout→login epoch flip; edit 6 resets it. If edit 6 is dropped, the
  worst case is one skipped kick within 15 s of login (boot drain still runs) — harmless, but the
  reset makes the invariant explicit.
