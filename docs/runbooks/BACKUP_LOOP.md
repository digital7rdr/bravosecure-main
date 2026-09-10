# Messenger Backup — Module Verification Loop

> **Run this loop EVERY time you touch the messenger backup module** — before you start
> (baseline) and after any change (regression). It is the module-specific companion to the
> repo-root `LOOP.md`: the root loop tells you _how_ to work; this loop tells you _what to
> prove works_ for backup/restore, and — critically — **which invariants keep the
> `root_mismatch` restore dead-end from ever coming back**.
>
> **Golden rule:** a backup change is not "done" until the §6 sign-off holds. The
> `root_mismatch` class has shipped FIVE times (B-45r3 → B-50 → B-67 → B-81 → B-94); each
> narrow patch left a structural window open. The invariants in §2 are the contract that
> closes the class — do not trade any of them away for a quick fix.

**Owner docs:** bug history = `sqa.md` (B-45, B-50, B-67, B-81, B-94); server audit =
`docs/audits` + `docs/audits/MESSENGER_BACKUP_AUDIT.md` remediation notes; architecture constraints =
CLAUDE.md **Security constraints** (Merkle/S8 items are stop-conditions).

---

## 0. When this loop applies (trigger files)

Run it if your change touches any of:

- **Mirror / ledger:** `src/modules/messenger/backup/messageMirror.ts`, `mirrorLedger.ts`,
  `mirrorBootstrap.ts`, `backupBoot.ts`, `backupFlags.ts`, `merkleLeafCache.ts` (B-687)
- **Merkle / integrity:** `src/modules/messenger/backup/merkleCommit.ts`, `backupMerkle.ts`,
  `restoreMessages.ts`, `restoreResume.ts`
- **Background restore (BR-1/BR-2, 2026-07-24):** `restoreBackground.ts` (the post-identity
  orchestrator: snapshot → auto-resumed walk → archive drain → mirror hand-off),
  `src/screens/messenger/RestoreActivityBanner.tsx`
- **Identity / crypto:** `identityBackup.ts`, `backupCrypto.ts`, `backupWireV3.ts`,
  `sessionRatchetRecovery.ts`, `ratchetSnapshot*.ts`, `httpSnapshotTransport.ts`,
  `archiveReplay.ts`
- **Client plumbing:** `backupClient.ts`, `src/modules/messenger/crypto/db.ts` (schema —
  `mirror_flushed` lives here), `src/modules/messenger/runtime/keychain.ts` (mirror key,
  seq HMAC keys)
- **Screens:** `src/screens/messenger/BackupSetupScreen.tsx`, `BackupRestoreScreen.tsx`,
  `RestoreProgressOverlay.tsx`
- **Server:** `apps/messenger-service/src/backup/**` (controller, service, DTOs), any
  `supabase/migrations/**` touching `identity_backups`, `messages_backup`,
  `conversations_backup`, `backup_merkle_commits`, `backup_session_snapshots`

---

## 1. The pipeline in one screen (reference)

```
WRITE SIDE (live device)
  store mutation ──► mirrorBootstrap diff ──► mirrorMessage(owner, msg)
        │                                        │  dedup: seenIds (in-memory)
        │                                        │  hydrated at boot from mirror_flushed (B-94)
        │                                        ▼
        │                            queue ── 1.5s flush debounce ──► putMessages (AES-GCM,
        │                                        │                    fresh IV per upload!)
        │                                        ├─ on success: bump flushEpoch,
        │                                        │  record versions → mirror_flushed,
        │                                        │  set merkle-pending flag        (B-94)
        │                                        ▼
        │                            5s merkle debounce ──► commitMerkleRoot:
        │                                 walk server pages → root → sign(seq) →
        │                                 putMerkleCommit → clear pending flag
        │                                 ONLY if flushEpoch unchanged            (B-94)
        ▼
BOOT (RESUME-AUTO): startMirrorBootstrap → setMirrorKey → catch-up sweep:
   hydrate dedup from mirror_flushed → backupNow (only CHANGED rows enqueue) →
   drain → if pending flag set: commit NOW (heals a prior kill-window)          (B-94)

RESTORE SIDE (fresh install or unlock)
  header → password → verifyProof → identity bundle → walk messages →
  verifyMerkleCommit(rows, signed commit)
     ├─ ok                → hydrate SQLCipher → seed mirror_flushed (B-94) → done
     ├─ rows_count_grew   → self-heal IFF additive-prefix reproduces signed root (B-45r3/P2-B-1)
     ├─ stale_seq on any commit → adopt server seq+1, retry ONCE (B-50, B-67 for snapshots)
     ├─ root_mismatch (equal count) → B-81 repair IFF this device has local history:
     │      purge ledger → full re-upload → drain-check → direct sign → retry once
     │      repair REFUSED (fresh device) → B-463 direct-sign heal IFF identityPrivKey:
     │      commitMerkleRoot(server walk) → retry verify ONCE (shared budget w/ B-311/312;
     │      per-row GCM auth still gates every hydrated row — substitutions skip + surface)
     ├─ rows_count_mismatch → B-311/B-312 direct-sign heal (same shape) → retry ONCE
     └─ anything else     → hard fail (tamper posture — do NOT soften)

BACKGROUND RESTORE (BR-1/BR-2, 2026-07-24)
  The identity phase (password → verifyProof → identity install → runtime
  rebuild) stays ON the restore/unlock screen. Everything after hands off to
  restoreBackground.ts and the user lands on MessengerHome immediately:
     snapshot apply → walk (auto-resume P2-B-6 windows, B-81 repair once)
       → archive drain (loops cap-hit windows) → mirror hand-off
  Batch-by-batch paint: the VERIFIED flush hydrates the store per batch
  (M-13 suppressed, yield per batch) — nothing paints before
  verifyMerkleCommit passes; the H-6 defer-write posture is untouched.
  RestoreActivityBanner (MessengerHome) renders running/error+retry/done.
  Boot: RESTORE-RESUME first tries a SILENT resume (keychain mirror key +
  local identity keypair → runner, no password); falls back to the screen.
  Mirror hand-off: unlock path defers setMirrorKey to the runner (the wired
  sweep must never race the walk — B-170); fresh-install path runs one
  explicit ledger-seeded sweep so live-received rows mirror in-session.
```

---

### 1b. B-687 — the Merkle leaf cache (SHADOW MODE, 2026-08-28)

The steady-state commit's server walk is O(entire history) per flush burst. A
persistent leaf cache (`merkle_leaves`, schema v22) now captures each flush
batch's leaves from the EXACT uploaded bytes (timestamp transformed via
`pgTimestamptzText` to the Postgres `to_json` form the server returns — the
partner-audit make-or-break finding: the client's `toISOString()` string does
NOT round-trip). **The cache is OBSERVATIONAL ONLY**: every commit still walks
the server (byte-identical behavior, pinned by the "shipped commit is
byte-identical" test), then — epoch-gated, same guard as the pending-flag
clear — compares the cache root against the walk root, logs
`[backup.merkle.shadow] match=…`, and rebuilds the cache from the walk on
divergence. A dirty flag (raised BEFORE `putMessages`, raise-first like the
pending flag; only clearable by the flush that raised it or a walk rebuild)
marks the cache untrusted after any kill/failure window.

**THE FLIP IS LIVE (2026-08-29, founder-approved in lieu of the multi-day
soak).** Ambient commits cache-sign (`[backup.merkle.flip] cache-signed`) ONLY
for an owner in `auditedLeafCacheOwners` — armed exclusively by an epoch-clean
shadow verdict (match=true, or a successful walk rebuild) — with a clean dirty
flag and a non-empty cache; every guard failure falls back to the walk (I8
direction). **Every session's first ambient commit therefore re-audits against
a full server walk** — the soak, made permanent. Boot-heal and repair walk by
construction (repair's ledger purge raises dirty; the wasDirty rule keeps later
flushes from clearing it, so the repair's own commit must walk). The
p.rows/p.leaves restore paths are byte-untouched and never audit or arm
(`!p.rows` gates the shadow block). Device-proven 01:39 08-29: walk 8.7 s →
match=true → cache-signed at 0.8–0.9 s covering mid-burst row growth. Suite:
`merkleLeafCacheShadow.test.ts` (27, incl. 6 flip pins, mutation-proven).

## 2. Invariants — the "never again" contract

Any change that breaks one of these re-opens the `root_mismatch` class. Check each one
against your diff, and keep the pinned test green (listed per invariant).

| #      | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Pinned by                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | **Idle boots upload NOTHING.** The catch-up sweep must hydrate its dedup from `mirror_flushed` and skip every row whose current version already reached the server. Re-uploading an unchanged row re-encrypts it (fresh IV → new server bytes) and re-opens the drift window.                                                                                                                                                                                                                                                                                                                                                    | `mirrorLedgerBootSweep.test.ts` ("skips unchanged rows", "idle boots are silent"); `convMirrorLedger.test.ts` (B-648 — CONVERSATION rows too: they share the ledger under a `conv:` id namespace) |
| **I2** | **Every flush owes a commit.** The persistent pending flag is raised **BEFORE** `putMessages` (B-173 strengthened it from "after upload + ledger write": the old order left a kill window where server bytes changed with no surviving flag → no boot heal). A failed upload leaves the flag set — the extra healing commit is the safe direction. Only a commit whose server-walk saw no interleaved flush (flush-epoch guard) may clear it. Commits are **single-flight** (B-167): concurrent entry points serialize in arrival order so a slow stale walk can never re-sign an old root over a newer commit via the I6 adopt. | `mirrorLedgerBootSweep.test.ts`, `mirrorSessionHygiene.test.ts` ("BUG-7"), `merkleCommitSingleFlight.test.ts`                                                                                     |
| **I3** | **Never weaken `verifyMerkleCommit`.** The VERIFIER stays byte-untouched: equal-count divergence, count shrink, bad sig all return `ok:false` exactly as before. `rows_count_grew` self-heals ONLY with the additive-prefix proof. What the RUNNER may do with a failed verdict is a separate, explicitly-audited list: B-81 repair (local truth), B-311/B-312/B-463 direct-sign heal (identity-key-gated, one per start, per-row GCM still gates hydration, verifier re-runs on the retry). Adding to that list is a founder/architecture decision — B-463's was signed off 2026-08-16.                                         | `merkleRecommitReconcile.test.ts`, `merkleSeqTamper.test.ts`, `restoreBackgroundRunner.test.ts`                                                                                                   |
| **I4** | **Repair never launders.** `repairBackupCommit` runs only on a device holding local history + unlocked mirror; it purges the ledger, re-uploads EVERYTHING, aborts on an undrained outbox, and signs directly (`commitMerkleRootNow`), never via the ambient hook. A fresh device refuses with zero side effects.                                                                                                                                                                                                                                                                                                                | `backupRepairCommit.test.ts`, `mirrorLedgerBootSweep.test.ts` ("purges the ledger")                                                                                                               |
| **I5** | **Server wipe ⇒ ledger purge.** Every path that wipes or rotates the server mirror (forget/wipe on either screen, fresh `setupBackup`) must `clearFlushedForOwner` — a stale ledger makes the sweep skip rows the server no longer holds (silent restore data loss).                                                                                                                                                                                                                                                                                                                                                             | code-review checklist (grep `clearFlushedForOwner` call sites)                                                                                                                                    |
| **I6** | **Seq counters adopt, never hammer.** Any 409 `stale_seq` (merkle commits AND ratchet snapshots) adopts `currentSeq + 1`, re-signs, retries exactly once. No infinite retry loops (B-67's 4s hammer froze snapshots + drained batteries).                                                                                                                                                                                                                                                                                                                                                                                        | `merkleStaleSeqAdopt.test.ts`, `ratchetSnapshotScheduler.test.ts`                                                                                                                                 |
| **I7** | **Restore seeds the ledger — with EXACTLY the verified flushed rows.** The seed lives INSIDE `restoreAllMessages`' verified flush (B-163 moved it from the screens): it records only rows the Merkle gate covered and the flush durably wrote. It must NEVER be a post-hoc `loadAll()` — that marked archive-replayed and live-received rows as "flushed" though the mirror never got them, so the sweep skipped them forever and the next restore lost them. Every restore entry point gets it for free by routing through the walk (the old unlock path skipped seeding entirely — B-170).                                     | `restoreBatchHydrate.test.ts` ("BUG-B"), `mirrorLedgerBootSweep.test.ts`                                                                                                                          |
| **I8** | **Ledger is best-effort, never authoritative for content.** A missing/failed ledger degrades to re-upload (pre-B-94 behaviour) — NEVER to skipping an upload it can't prove happened.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `mirrorLedgerBootSweep.test.ts` ("degrades … DB unavailable")                                                                                                                                     |
| **I9** | **No plaintext in logs or ledger.** `mirror_flushed` stores FNV hashes only; log lines carry counts/seqs/kinds only. The static log-audit test enforces this.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `logAudit.test.ts`                                                                                                                                                                                |

---

## 3. Failure-class history (read before "fixing" anything here)

| Bug              | Date  | Root cause                                                                                                                                                                                                                                                                                                                  | Fix                                                                                                                                                                                                                                                                   |
| ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-45 r3**      | 07-05 | Rows uploaded continuously, signed count trailed on a 30s debounce; AppState background flushed rows but abandoned the commit timer                                                                                                                                                                                         | Direction-aware `rows_count_grew` self-heal (additive-prefix proof), commit-on-background, drain-before-baseline, debounce 30s→5s                                                                                                                                     |
| **B-50**         | 07-06 | Fresh install ships commit `seq=1`; server monotonic guard 409s; client mapped every 409 to `verifier_missing` → hard `root_mismatch` on a healthy backup                                                                                                                                                                   | `stale_seq` kind + adopt `currentSeq+1`, retry once (`merkleStaleSeqAdopt.test.ts`)                                                                                                                                                                                   |
| **B-67**         | 07-10 | Ratchet-snapshot upload path lacked the B-50 adopt — infinite 4s retry, snapshots frozen at old seq                                                                                                                                                                                                                         | Same adopt-and-retry in `ratchetSnapshotScheduler.ts`                                                                                                                                                                                                                 |
| **B-81**         | 07-11 | Re-mirrors re-encrypt (fresh IV) and the commit trails by debounce + server walk; kill in the window → equal-count drift → permanent restore dead-end (verifier hard-fails, nothing re-commits)                                                                                                                             | `repairBackupCommit` on the owner device + one auto-retry on the restore screen                                                                                                                                                                                       |
| **B-94**         | 07-17 | **The drift factory:** in-memory-only dedup meant EVERY boot sweep re-uploaded the entire history, re-opening the B-81 window on every single launch; a fresh-install restore hitting the drift had no repair path                                                                                                          | Persistent `mirror_flushed` ledger (schema v14) + pending-commit flag with flush-epoch guard + boot heal + restore-side seeding + ledger purge on wipe/rotate/repair                                                                                                  |
| **B-162..B-183** | 07-24 | Full-module audit: 22 bugs incl. concurrent-commit stale-root laundering (B-167), cross-user flush contamination (B-168), false tombstones for SQL-evicted rows (B-169), ledger seed over-marking (B-163), unlock-path sweep-vs-walk race + missing I7 seed (B-170), wipe leaving the mirror live under the old key (B-172) | Single-flight commits, session-generation guard + flush-time owner gate, tombstone fallback removed, in-walk verified-only seeding, unlock via the BR-1 runner, `resetMirrorForWipe` on all wipe/rotate paths; full register `docs/audits/BACKUP_AUDIT_2026-07-24.md` |

Pattern to internalize: **B-45/B-50/B-81 patched the restore side; the class only died when
the WRITE side stopped manufacturing drift (B-94).** If you see a new `root_mismatch`, first
ask "what is writing server bytes without a covering commit?", not "how do I make restore
tolerate it?" — tolerating it is usually laundering (I3/I4).

---

## 4. Automated gates (run all, in this order)

```bash
# 1. The backup/merkle suites — fastest signal
npx jest --selectProjects messenger-crypto --testPathPattern \
  "mirrorLedgerBootSweep|messageMirrorMerkleFlush|backupRepairCommit|merkle|backupHardening|restoreDeferResume|ratchetSnapshotScheduler|wipeAtRest|backupKdfHardening|restoreBackgroundRunner|restoreBatchHydrate|mirrorSessionHygiene|backupClientErrorMap|httpSnapshotTransportFetch|restoreTombstoneOwnerCache|archiveReplayCapResume|identityBackupZeroize|backupBootRestoreResume|backupScreenWiring"

# 2. Full crypto project (the pre-existing suite-level flake reruns green in isolation;
#    0 failing TESTS is the bar)
npm run test:crypto

# 3. Server backup spec (from apps/messenger-service)
cd apps/messenger-service && npm test -- --testPathPattern backup

# 4. Type + lint gates (baseline in .tsc-baseline.json)
npm run typecheck   # error count must be ≤ baseline
npm run lint        # your files must add zero problems
```

---

## 5. Device / data verification

### 5.1 Idle-boot silence check (I1/I2 — the B-94 regression gate)

1. Install the build, unlock backup, let it settle (60s), then **relaunch the app** and
   capture logcat:
   `adb logcat -s ReactNativeJS | grep -E "bravo.backup|backup.merkle"`
2. **Expected on the second launch:** `catch-up sweep starting` → `catch-up sweep done`
   with **NO** `flushed N messages` and **NO** merkle commit between them (unless a pending
   flag from a killed session is being healed — that logs exactly one commit).
3. **Forbidden:** `flushed <full-history-count> messages` on every launch — that is the
   drift factory back from the dead.
4. **B-687 shadow lines (expected, read them):** after any commit, one
   `[backup.merkle.shadow] match=true|false cacheRows=N walkRows=M` (or `unusable dirty=…`
   on first run / after a kill window, followed once by `cache rebuilt from walk`). A
   `match=false` that RECURS after a rebuild — with no `unusable` line between — is a
   transform/round-trip drift: capture it verbatim and do NOT flip the cache
   authoritative. **Expected, NOT divergence (critic P2s, encode in any soak analysis):**
   (a) every account's FIRST commit after the B-687 rollout logs one `match=false` or
   `unusable` + `cache rebuilt` (initial backfill) — the flip criterion is "zero
   divergences AFTER each account's first rebuild line"; (b) every network-blip retry
   produces one `unusable dirty=true` + rebuild (the flag is raised before the upload and
   only a walk rebuild clears a prior failure's flag — complete-but-dirty, by design).

### 5.2 Kill-window heal check (I2)

1. Send a message; within ~2s (after `flushed 1 messages`, before the 5s commit) force-kill:
   `adb shell am force-stop com.bravosecure.app`.
2. Relaunch → expect one merkle commit during the sweep (`pending` heal).
3. Reinstall + restore → must succeed (no `root_mismatch`).

### 5.3 Restore round-trip gate (always run before release)

> **⚠️ B-463 — BEFORE any `adb uninstall` of a device that is the account's ONLY install:
> cold-boot the app once and let it sit ~30s.** The boot sweep heals any pending
> (uncommitted) flush from the previous session. Uninstalling first destroys the pending
> flag AND the local history the B-81 repair needs — if the last session died inside the
> flush→commit window, the backup becomes a permanent `root_mismatch` dead-end with no
> in-contract recovery (this is exactly how the founder's history got stranded on
> 2026-08-16).

1. `adb uninstall` → install → sign in → restore with the backup password.
2. Expect a clean restore. `root_mismatch` on the FIRST try on a fresh install means the
   write side drifted — investigate with §5.4 before touching the verifier.
3. On the owner's own device, a `root_mismatch` should trigger `Repairing backup
integrity…` then a successful retry (B-81); a SECOND mismatch after a repair is a real
   integrity signal — stop and escalate.

### 5.4 SQL drift probes (Supabase — read-only)

> **⚠️ B-463 — the `rows_after_commit` probe is BLIND to byte drift.** `messages_backup`
> has no `updated_at` (the column is `mirrored_at`), and the `putMessages` upsert does not
> set it — so ON CONFLICT re-encrypts keep the ORIGINAL `mirrored_at`. A drifted account
> reads `rows_after_commit = 0`. Until fix F1 (bump `mirrored_at` in the upsert row)
> ships, the ONLY trustworthy drift probe is the root recompute below.

```sql
-- Commit vs actual rows, per account (count drift only — see warning above):
SELECT c.user_id, c.row_count AS committed, c.seq, c.updated_at,
       (SELECT count(*) FROM messages_backup m WHERE m.owner_user_id = c.user_id) AS actual
FROM backup_merkle_commits c ORDER BY c.updated_at DESC;

-- NEW rows after the last signed commit (INSERTS only; updates are invisible pre-F1):
SELECT m.owner_user_id, count(*) AS rows_after_commit
FROM messages_backup m
JOIN backup_merkle_commits c ON c.user_id = m.owner_user_id
WHERE m.mirrored_at > c.updated_at
GROUP BY m.owner_user_id;

-- BYTE-EXACT drift probe (B-463, proven against a matching control account):
-- computes the client's exact leaf set; reduce the pairwise tree off-DB and
-- compare against backup_merkle_commits.root_b64. Recipe: leaf =
-- sha256(head || sha256(utf8(b64ct))) with head =
-- 'BRAVO_BACKUP_MERKLE_LEAF_V1\n<message_id>\n<ts_str>\n'; node =
-- sha256('BRAVO_BACKUP_MERKLE_NODE_V1\n' || L || R), duplicate-last-odd;
-- sort by (ts_str, message_id) COLLATE "C".
SELECT count(*) AS n,
       string_agg(encode(digest(
         convert_to('BRAVO_BACKUP_MERKLE_LEAF_V1' || E'\n' || message_id || E'\n'
                    || (to_json(msg_created_at)#>>'{}') || E'\n', 'UTF8')
         || digest(convert_to(translate(encode(ciphertext,'base64'), E'\n', ''), 'UTF8'), 'sha256'),
       'sha256'), 'hex'), ''
       ORDER BY (to_json(msg_created_at)#>>'{}') COLLATE "C", message_id COLLATE "C") AS leaves_hex
FROM messages_backup WHERE owner_user_id = :owner;
```

Non-zero `rows_after_commit` that persists for more than ~10s of activity = a client not
honouring I2 — but pre-F1 a ZERO here proves nothing (B-463). The root recompute is the
arbiter. (Historic recipe notes: sqa.md §B-81; the working end-to-end run: sqa.md §B-463.)

---

## 6. Sign-off criteria

- [ ] §4 gates all green (0 failing tests; tsc ≤ baseline; lint adds nothing)
- [ ] §5.1 idle-boot silence verified on-device (or explicitly stated as not exercisable)
- [ ] §5.3 fresh-install restore round-trip verified (ditto)
- [ ] Every §2 invariant re-checked against the diff — name any you touched in the
      commit/PR body and why the change preserves it
- [ ] Nothing in the diff softens `verifyMerkleCommit`, `verifyProof`, the biometric gate,
      or seq monotonicity (CLAUDE.md stop-conditions — architecture approval required)
- [ ] `sqa.md` updated if a bug was found/fixed; this file updated if an invariant changed
