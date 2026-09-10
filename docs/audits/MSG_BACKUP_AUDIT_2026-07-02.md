# Message Backup Audit — 2026-07-02

**Scope:** the encrypted message-backup pipeline end-to-end — live mirror (`src/modules/messenger/backup/*`),
boot orchestration (`backupBoot.ts`), setup/unlock/restore screens, Merkle integrity layer, ratchet-snapshot
capture/apply, and the server side (`apps/messenger-service/src/backup/*`).

**Reported symptoms:**

1. **Backup is very slow.**
2. **Backup is not 100% synced** (server copy is missing messages / restore doesn't match the device).

**Verdict: both symptoms are real and code-caused.** 15 findings below — 3 Critical, 5 High, 7 Medium.
Every finding cites file:line evidence. No fixes have been applied; this is an audit document.

---

## Executive summary (plain English)

Think of the backup as a **conveyor belt** that carries each message from your phone to the server.

- **Why it's not 100% synced:** the belt has three holes.
  (1) On a normal app start the "sweep the floor for anything the belt missed" step **never runs** — the
  sweeper is plugged in _after_ the switch that turns it on was already flipped (B-BK1). Every message that
  arrived while the app was killed falls through this hole **permanently**.
  (2) When the server rejects a batch for certain reasons, the belt either **throws those 50 messages away
  and remembers them as "already shipped"** so they can never be re-sent (B-BK2b), or **jams forever
  retrying the same bad batch**, blocking everything behind it (B-BK2a).
  (3) After a fresh-install restore, the "restore my secure call/ratchet state" step looks for its key in the
  **wrong drawer** (UUID instead of email), finds nothing, and silently skips — so a whole class of archived
  messages can't be decrypted and shows up as "skipped" (B-BK3).

- **Why it's slow:** the belt moves **50 messages every 1.5 seconds** no matter what (the server accepts 500
  per trip — B-BK5), and every ~30 seconds a "verification" step **re-downloads your entire backup from the
  server** just to recompute a checksum (B-BK4). On top of that, several events (unlock, queue overflow,
  finishing a restore) trigger a **full re-encrypt + re-upload of your entire history from scratch**
  (B-BK6, B-BK7). Restore is slow for its own reason: it replays the server's sealed-envelope archive **one
  envelope at a time, sequentially**, with no progress shown (B-BK8).

---

## Symptom → finding map

| Symptom                                        | Findings                                    |
| ---------------------------------------------- | ------------------------------------------- |
| Not 100% synced (messages missing from backup) | **B-BK1**, **B-BK2**, B-BK9, B-BK10, B-BK11 |
| Not 100% synced (restore doesn't match device) | **B-BK3**, B-BK10, B-BK12, B-BK14           |
| Backup slow (upload)                           | **B-BK4**, **B-BK5**, B-BK6, B-BK7, B-BK13  |
| Restore slow                                   | **B-BK8**, B-BK4, B-BK15                    |

---

## CRITICAL

### B-BK1 — Catch-up sweep never runs on the normal boot path → messages received while the app was killed are permanently missing from the backup

**Files:** `src/modules/messenger/backup/backupBoot.ts:169-183`,
`src/modules/messenger/backup/messageMirror.ts:147-162`,
`src/modules/messenger/backup/mirrorBootstrap.ts:114-134`

The mirror's designed safety net for "messages that landed while the mirror was off" is the **catch-up
sweep**: when `setMirrorKey` flips the mirror from disabled → enabled it calls `catchUpSweep()`
(`messageMirror.ts:154-161`), which re-walks the full SQLCipher store and re-enqueues anything the server
doesn't have. The sweep callback is only installed inside `startMirrorBootstrap()`
(`mirrorBootstrap.ts:114-124`).

On the **RESUME-AUTO** path — the default cold-start path once the keychain holds the mirror key, i.e. what
happens on _every normal app launch_ — `backupBoot.ts` does:

```ts
setMirrorKey(masterKey); // backupBoot.ts:176 — catchUpSweep is still null here
startMirrorBootstrap(); // backupBoot.ts:177 — sweep wired AFTER the enable transition
```

At `setMirrorKey` time the module-level `catchUpSweep` is `null` (fresh JS context on cold start), so the
disabled→enabled transition fires **no sweep** — the code's own comment admits "if it isn't wired, the flip
is purely cosmetic" (`messageMirror.ts:145`). `startMirrorBootstrap()` then **seeds its diff state from the
current store snapshot without mirroring it** (`mirrorBootstrap.ts:128-134`) — everything already in the
store is marked "seen" and will never be enqueued.

**Consequence:** every message that arrived while the app was dead (relay drain at boot, FCM headless-wake
deliveries written straight to SQLCipher) is in the local store, marked seen, and **never reaches
`messages_backup`**. The only server-side copy is the sealed-envelope archive, which is **purged after 90
days** (`backup.service.ts:1064`) — after that the message is unrecoverable on reinstall. This is the
single biggest "not 100% synced" cause, and it compounds silently every day.

Note the asymmetry: the RESUME-LOCKED path (manual password unlock) _does_ run the sweep, because boot
called `startMirrorBootstrap()` first (`backupBoot.ts:188`) and the unlock screen calls `setMirrorKey`
later (`BackupSetupScreen.tsx:302`). So accounts where the user manually unlocks look fine in testing while
auto-resume accounts silently diverge — matching the "sometimes it's synced, sometimes not" feel.

**Fix direction:** wire `setCatchUpSweep` before `setMirrorKey` on RESUME-AUTO (or make
`startMirrorBootstrap` fire a sweep when the mirror is already enabled), and add a server-acknowledged
high-water mark so the sweep is cheap (see B-BK6).

---

### B-BK2 — Flush error handling both poisons the dedup (silent 50-message loss) and head-of-line blocks forever on a 4xx

**Files:** `src/modules/messenger/backup/messageMirror.ts:382-425`,
`src/modules/messenger/backup/backupClient.ts:88-92`,
`apps/messenger-service/src/backup/dto/backup.dto.ts:99-105`

Two distinct defects in `flush()`'s catch branch:

**(a) Infinite head-of-line retry on any 4xx.** `backupClient.callJson` classifies **every non-5xx, non-mapped
status as `kind: 'network'`** (`backupClient.ts:91`: `res.status >= 500 ? 'server' : 'network'`). The flush
retry set is `'network' || 'server'` (`messageMirror.ts:383`). So a **400 from the server's ValidationPipe**
(one row with `message_id` > 128 chars, ciphertext > the 800 KB DTO cap, batch shape drift — the DTO rejects
the _whole batch_, `backup.dto.ts:99-105`) is retried **forever**: re-pushed, re-batched from the FIFO head,
rejected again, every ~1.5–5 s, with no attempt counter and no backoff growth (`messageMirror.ts:421` vs the
immediate `scheduleFlush()` at line 428). One poison row **permanently stalls all backup progress** for every
session — the queue behind it never drains. From the outside this is exactly "backup is slow / stuck and not
synced". The same applies to any 403/429 from a proxy or future rate limiter.

**(b) Permanent silent loss + dedup poisoning on "fatal" kinds.** For every other error — `'unauthorized'`
(which happens when the access token expired **and the refresh call had a transient network blip**,
`backupClient.ts:65-75`), `'locked'` (423 after failed password attempts), `'no_backup'`,
`'service_disabled'`, or any local throw from the per-row encrypt `Promise.all` — the batch is **dropped**
(`messageMirror.ts:423`). But `mirrorMessage` already registered each row's `(owner, msgId, versionHash)` in
`seenIds` (`messageMirror.ts:222-225`) and the drop path never clears it. The same message version can
**never be re-enqueued** — `mirrorMessage` dedups it out, and even the catch-up sweep goes through
`mirrorMessage` (`mirrorBootstrap.ts:214`), so the sweep can't recover it either. Up to 50 messages vanish
from the backup per incident until the next full app restart clears the in-memory set. Also note one bad row
in the batch kills all 50 (single `Promise.all`, `messageMirror.ts:346`).

**Fix direction:** treat 4xx as fatal-for-this-batch (dead-letter the batch, don't retry-block); on ANY drop
path delete the dropped rows' `seenIds` entries; add per-row try/catch inside the encrypt map; add an
attempts counter with real backoff.

---

### B-BK3 — Ratchet-snapshot apply on restore reads the master key under the wrong owner → always skipped → archived messages undecryptable

**Files:** `src/screens/messenger/BackupRestoreScreen.tsx:365` (bug), `:282` (save site),
`src/modules/messenger/runtime/keychain.ts:306-332`,
`src/modules/messenger/runtime/productionRuntime.ts:1369`,
`src/modules/messenger/backup/ratchetSnapshotScheduler.ts:155-166`

The keychain mirror-key entry is canonically scoped by **ownerKey = email ?? phone ?? id** — the restore
screen itself documents this (`BackupRestoreScreen.tsx:52-60`) and saves the key under it:

```ts
await saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64); // :282 — saved under EMAIL
```

But 80 lines later, the Phase-2 ratchet-snapshot apply loads it under the **Signal UUID**, with no legacy
fallback param:

```ts
const rawB64Key = await loadMirrorMasterKey(ownerUserId); // :365 — looked up under UUID → null
```

`loadMirrorMasterKey` only falls back when a `legacyOwnerId` is passed (`keychain.ts:318`), which it isn't.
For every account whose ownerKey is an email/phone (i.e. all of them), `rawB64Key` is `null` and the entire
`applyRatchetSnapshot` block silently no-ops (the guard at `:366` just skips). The snapshot seq floor is
also read under the UUID (`:368`) while the capture scheduler writes it under ownerKey
(`productionRuntime.ts:1369` arms with `config.ownerKey ?? config.ownUserId`) — a second copy of the same
mismatch.

**Consequence:** the whole Phase-2 feature ("restore per-peer Double-Ratchet state so reinstall-window
envelopes decrypt") is **dead on the restore path** even though the capture side dutifully uploads snapshots
every 5 minutes. Every sealed-archive envelope encrypted under pre-reinstall ratchet state fails to decrypt
during the archive drain and is counted as "skipped" (`BackupRestoreScreen.tsx:440-445`) — directly visible
to the user as "restore is not 100%".

**Fix direction:** pass `ownerKey ?? ownerUserId` (plus `ownerUserId` as the legacy param) at `:365` and use
the same key for `readPersistedSnapshotSeq`/`persistAppliedSnapshotSeq`.

---

## HIGH

### B-BK4 — Merkle commit re-downloads the ENTIRE server-side backup every ~30 s of mirror activity

**Files:** `src/modules/messenger/backup/merkleCommit.ts:146-185`,
`src/modules/messenger/backup/messageMirror.ts:54-71`,
`src/modules/messenger/backup/mirrorBootstrap.ts:97-109`

Every successful flush schedules the Merkle hook (30 s debounce, `messageMirror.ts:57,381`). The hook calls
`commitMerkleRoot` **without pre-collected rows**, so it "page-cursors through /backup/messages"
(`merkleCommit.ts:161-184`) — downloading **every mirrored row including full ciphertext**, hashing, signing,
uploading a 200-byte commit.

- During the **initial upload** of an N-message history the hook fires roughly every 30 s while flushes
  continue; total re-downloaded volume is O(N²) in rows (each commit re-pulls everything uploaded so far).
  For 10k messages that is dozens of MB of _download_ competing with the upload on the same radio.
- In **steady state**, an active chat session re-downloads the whole history (tens of MB for a mature
  account) every 30 s of messaging. On mobile data this is the dominant "backup is slow / app is eating
  bandwidth" cost, and it slows the actual mirror flushes it runs alongside.

**Fix direction:** maintain the Merkle leaf set incrementally client-side (persisted), or have the server
return `(message_id, msg_created_at, sha256(ciphertext))` only (the leaf needs the hash, not the
ciphertext — `backupMerkle.ts:95-109`), or commit far less frequently (hourly / on background).

### B-BK5 — Upload throughput hard-capped at ~50 rows per 1.5 s while the server accepts 500 per batch

**Files:** `src/modules/messenger/backup/messageMirror.ts:83-85, 319-342, 428`,
`apps/messenger-service/src/backup/backup.service.ts:85` (`maxMessageBatchSize: 500`),
`apps/messenger-service/src/backup/dto/backup.dto.ts:31`

`MAX_BATCH = 50` and every batch waits for the full `FLUSH_DEBOUNCE_MS = 1500` before the next one ships
(`flush()` processes one 50-row batch then re-arms the 1.5 s timer, `:428`). Effective rate ≈ 25–30 rows/s
best case. A 10k-message initial backup takes **~6–8 minutes minimum** (hours on flaky networks with the
5 s retry), while WhatsApp ships an equivalent backup in seconds as a single archive. The server explicitly
allows 500-row batches — the client uses a tenth of that and inserts a mandatory idle gap between every
batch. The debounce is correct for _live trickle_ traffic but wrong for _bulk drain_.

**Fix direction:** when the queue is deep (> 1 batch), loop batches back-to-back at 250–500 rows with no
debounce; keep the 1.5 s debounce only for the live path.

### B-BK6 — Catch-up sweep re-encrypts and re-uploads the ENTIRE history every time it runs (no high-water mark), and overflow triggers it in a feedback loop

**Files:** `src/modules/messenger/backup/mirrorBootstrap.ts:189-231`,
`src/modules/messenger/backup/messageMirror.ts:406-419`

`backupNow` walks **all of SQLCipher** (`SqlMessageStore.loadAll()`, full-table load into memory —
`sqlMessageStore.ts:178-194`) and calls `mirrorMessage` for every row. There is no server-acknowledged
watermark and `seenIds` is in-memory only, so after any cold start a sweep re-wraps every message with a
**fresh random subkey** (new ciphertext bytes — even server-side dedup can't help) and re-uploads the whole
history. The comment at `messageMirror.ts:416` claims the sweep "will re-enqueue every message_id the server
doesn't yet acknowledge" — no such acknowledgment check exists.

Worse, the queue-overflow handler (`messageMirror.ts:410-419`) responds to backpressure by scheduling…
a full sweep — which re-enqueues the entire store into the already-overflowing queue, causing more overflow,
more drops of the newest 500+ entries, and another sweep. Under a slow server this loops until connectivity
improves, burning CPU/battery/data the whole time.

**Fix direction:** persist a per-message "mirrored-at version" (or a single `(created_at, id)` high-water
mark plus a dirty-set) in SQLCipher; sweep only unacknowledged rows; never trigger a full sweep from inside
the overflow path.

### B-BK7 — Every restore is followed by a full re-upload of the just-restored history

**Files:** `src/screens/messenger/BackupRestoreScreen.tsx:289` (bootstrap started) vs `:318`
(restore runs after), `src/modules/messenger/backup/mirrorBootstrap.ts:128-163`,
`src/modules/messenger/store/messengerStore.ts:917-947`

`startMirrorBootstrap()` runs **before** `restoreAllMessages`, so its diff seed snapshot is an **empty
store**. When the restore finishes it calls `hydrateMessages(aggregated, true)` — a Zustand set that fires
the mirror subscription, which diffs every restored message against the empty seed and enqueues **all of
them** (`mirrorBootstrap.ts:143-151`). The device then spends the next N minutes re-encrypting and
re-uploading the exact rows it just downloaded (at B-BK5's 50-per-1.5 s rate, with B-BK4's Merkle
re-downloads every 30 s). On a 10k-message account a "restore" is really a restore **plus** a ~7-minute
shadow re-backup the user never asked for.

**Fix direction:** start the mirror bootstrap _after_ `restoreAllMessages` (seed will then include restored
rows), or seed the diff map from the restored set.

### B-BK8 — Sealed-archive replay is strictly sequential, unbounded, redundant, and invisible to the user

**Files:** `src/screens/messenger/BackupRestoreScreen.tsx:399-422`,
`src/modules/messenger/runtime/productionRuntime.ts:1053-1069`

The restore's final phase drains up to 1000 pages × 500 envelopes and calls `replayArchivedEnvelope`
**one at a time** (`for … await` at `:405-411`). Each replay is a full sealed-sender unseal + Signal decrypt

- store write on the JS thread. Unlike `restoreAllMessages` (which got the `BS-RESTORE-YIELD` per-page yield
  fix, `restoreMessages.ts:481`), this loop has **no yield, no progress counter** (the overlay shows a static
  "Restoring server-side history…"), and no concurrency. For a 90-day archive of a busy account (tens of
  thousands of envelopes) this phase alone runs many minutes to tens of minutes and looks frozen.

It's also ~100% redundant work for a user whose mirror was healthy: every envelope that already restored
from `messages_backup` is re-unsealed anyway (dedup only kicks in at the store level after full decrypt).

**Fix direction:** filter the archive drain by the message-ids already restored, batch replays with a
per-page yield + progress emits, and consider capping the drain to the window since the last mirror
watermark.

---

## MEDIUM

### B-BK9 — Retry re-queue can ship an older message version AFTER a newer one → server row regresses

**Files:** `src/modules/messenger/backup/messageMirror.ts:384-385` (messages), `:497-501` (conversations),
`apps/messenger-service/src/backup/backup.service.ts:615-638`

On a transient flush failure the failed items are re-pushed to the **tail** of the queue. If a newer version
of the same message (status flip, reaction) was enqueued during the await, the _newer_ version ships first
and the re-queued _older_ version ships in a later batch. The server upsert is blind last-write-wins on
`(owner_user_id, message_id)` — the in-batch dedup (`backup.service.ts:615-618`) only protects within one
batch. Result: restored chats show stale statuses/reactions ("delivered" instead of "read", missing
reactions). `flushConversations` has the identical bug: its catch re-`set`s the failed snapshot over any
newer snapshot queued meanwhile (`:497-501`), regressing mute/pin/unread/group state.

### B-BK10 — Deletions are lost when the mirror is locked, and the archive replay resurrects deleted messages anyway

**Files:** `src/modules/messenger/backup/messageMirror.ts:251` (early return),
`src/screens/messenger/BackupRestoreScreen.tsx:399-422` (no tombstone filter),
`src/modules/messenger/backup/restoreMessages.ts:426` (mirror-side skip works)

Delete-sync relies entirely on `markDirty` shipping a `status:'deleted'` tombstone. If the user deletes a
message while the mirror is disabled (locked session), `markDirty` returns at `:251` **before** creating the
tombstone, and no later mechanism detects the deletion (the diff loop can't see absent rows; the catch-up
sweep only walks rows that exist). The deleted message stays in `messages_backup` and reappears on restore.
Separately — already logged in `sqa.md` (2026-06-15 session) — the sealed-archive replay path has **no
tombstone/deletion filter at all**, so even correctly-tombstoned messages resurrect via the archive drain.
The two restore sources disagree about deletions by design.

### B-BK11 — Overflow silently drops the newest 500+ queued rows; queue is unbounded until a network error

**Files:** `src/modules/messenger/backup/messageMirror.ts:85, 336, 406-419`

`MAX_QUEUE_SIZE = 500` is only enforced inside the network-failure catch. `backupNow` on a 100k-row store
happily builds a 100k-entry in-memory queue (each entry holding a full `LocalMessage`) — a real OOM risk on
low-end devices during initial backup. When overflow _does_ trip, the newest entries are cut and recovery is
delegated to the sweep (broken on the main path per B-BK1, and pathological per B-BK6). The only user signal
is a generic store error banner (`surfaceBackupBehind`, `:540-553`).

### B-BK12 — Restore-resume + Merkle self-heal interact to corrupt the signed commit (and the self-heal neutralizes S8 anyway)

**Files:** `src/modules/messenger/backup/restoreMessages.ts:271-278, 297, 508-530`,
`src/modules/messenger/backup/merkleCommit.ts:150-152`

A resumed restore (cursor from `restoreResume.ts`) walks only the **tail pages**, so `merkleRows` is
partial. Verification then root-mismatches against the full-set commit, and the Round-9 "self-heal"
re-commits a signed root **over the partial tail rows** — the server's commit now claims
`rowCount = tail-only` until some future full restore accidentally repairs it. More fundamentally: because
the restore always passes `identityPrivKey`, _any_ root mismatch — including genuine server tampering
(row omission/substitution) — is auto-"reconciled" by re-signing whatever the server returned
(`restoreMessages.ts:519-530`). The S8 integrity gate effectively cannot fail; only the seq-rollback check
retains teeth. Also, the resumed run hydrates only tail pages into the UI (`aggregated` holds this run's
rows only), so the user sees a partial chat list until the next cold boot.

### B-BK13 — Mirror diff subscription is O(entire store) on EVERY store update; unread-count changes re-upload conversation rows constantly

**Files:** `src/modules/messenger/backup/mirrorBootstrap.ts:136-163` (unselected subscribe),
`:70-80` (`convVersion` includes `unread_count`)

`useMessengerStore.subscribe(cb)` has no selector, so every store mutation (presence, typing, unread bumps,
every append) re-walks **all messages in all conversations**, JSON.stringifying 8 fields per message and
hashing. With ~20 chats × 200 hydrated messages that's ~4k stringify+hash ops per store update on the JS
thread — measurable jank and battery drain during bursts, and part of the "everything feels slow while
backup runs" perception. `convVersion` hashing `unread_count` means every received message while outside the
chat re-mirrors that conversation row to the server (a needless network write per message).

### B-BK14 — Unlock-path restore skips Merkle verification entirely

**File:** `src/screens/messenger/BackupSetupScreen.tsx:317-322`

`handleUnlock` calls `restoreAllMessages(masterKey, ownerUserId, {cryptoStore: store, onProgress})` without
`identityPubKey`, so `wantsMerkle` is false and the restore imports whatever the server returns with **no
integrity check** — inconsistent with the fresh-install path which verifies (BackupRestoreScreen passes both
keys). Given B-BK12 the practical delta is small today, but this is the path a user hits most often.

### B-BK15 — argon2id at 256 MiB on low-RAM devices makes unlock/restore slow or fail

**File:** `src/modules/messenger/backup/backupCrypto.ts:54-56`

`mem=256 MiB, iters=4` lands at ~2.4 s on Pixel-6-class hardware (documented in the module header) but on
2–3 GB budget Androids the single 256 MiB native allocation takes 5–15 s or gets the process killed under
memory pressure — perceived as "backup password screen hangs". Not a defect per se (it's the security
posture), but worth a device-tier fallback profile and a spinner-with-explanation, since it fronts every
restore and every manual unlock.

---

## What already works (verified, no action)

- Server-side paging uses a proper tuple cursor `(msg_created_at, message_id)` on both `/backup/messages`
  and `/backup/sealed-archive`, matching the client cursors (`backup.service.ts:641-684, 1012-1050`).
- `putIdentity` only wipes mirrored rows on a genuine key rotation (F6 guard, `backup.service.ts:169-201`).
- Archive writes have a Redis retry outbox with dead-lettering + replica lock (`backup.service.ts:829-1010`).
- Restore writes land in SQLCipher via per-page transactions with resume + a JS-thread yield per page
  (`restoreMessages.ts:447-482`).
- The restore-side tombstone skip for mirror rows works (`restoreMessages.ts:426`) — the gaps are B-BK10's.
- DTO validation caps exist on every backup endpoint (`backup.dto.ts`) — the issue is the client's reaction
  to a rejection (B-BK2), not the caps themselves.

## Suggested fix order

1. **B-BK1** (one-line ordering fix + sweep-on-already-enabled) — stops the ongoing daily data loss.
2. **B-BK2** (error classification + dedup un-poisoning + per-row encrypt isolation) — stops silent loss and
   permanent stalls.
3. **B-BK3** (ownerKey at `BackupRestoreScreen.tsx:365/368`) — makes restores actually complete.
4. **B-BK5 + B-BK4** (bulk-drain batching; incremental/leaner Merkle) — the two big "slow" wins.
5. **B-BK7 / B-BK6** (bootstrap ordering after restore; server-acked watermark for sweeps).
6. Remainder as capacity allows; B-BK12's self-heal semantics need an architecture decision (S8 is currently
   decorative).

_Fix-order note:_ B-BK1/B-BK6 interact — fixing B-BK1 alone makes every boot fire the (currently
full-re-upload) sweep, which would make the _slow_ symptom worse until B-BK6's watermark exists. Ship them
together or gate the boot sweep behind the watermark.
