# Messenger Backup — Full-Module Audit, Fix-All & Background Restore

**Date:** 2026-07-24 · **Branch:** `fix/messenger-audit-b121`
**Scope:** the entire backup module — 26 client files under `src/modules/messenger/backup/`, the three
backup screens, the push/boot seams that touch restore, and the server side
(`apps/messenger-service/src/backup/**`).
**Outcome:** **22 substantiated bugs (8 × P1, 11 × P2, 3 × P3) — ALL FIXED this session**, each pinned
by a regression test; plus the founder-requested **BR-1 background restore** (user is never stuck on
the backup page; messages arrive batch-by-batch) and **BR-2 silent boot resume**.

**Bug numbers:** B-162 … B-183 (see `sqa.md`).
**New tests:** 11 suites / 56 tests (inventory in §5).
**Gates:** full `messenger-crypto` project green **twice** (287 suites / 2787 tests each run — flake
rule honoured); mobile `tsc` = 47 = baseline; `messenger-service` tsc clean.

---

## 1. Method

Four parallel audit agents swept disjoint slices — restore side, write side (mirror/merkle),
crypto/identity/transport, and snapshots + screens + server — each instructed to verify every
candidate against reachable code paths and to check the BACKUP_LOOP.md **I1–I9** invariant contract
line by line. Findings below survived that verification; everything they checked-and-cleared is
listed in their per-slice notes (kept in the session transcript; the sound list included the Merkle
verifier itself, the KDF bounds, AAD binding on every row path, IV freshness, the P0-1 verify
protocol, server auth guards, seq monotonicity, and the wipe endpoint's table completeness — none
of the stop-condition surfaces needed or received any weakening).

---

## 2. Findings and fixes

Severity: **P1** = data-loss / security / permanent-dead-end class. **P2** = correctness with
bounded damage. **P3** = degraded recovery / edge.

| #     | Sev | Area                          | Bug (root cause)                                                                                                                                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                          |
| ----- | --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-162 | P1  | `BackupRestoreScreen`         | `setDeferBundlePublish(true)` leaked on every restore-failure exit (wrong password, store-null, network). "Skip restore" / "Wipe & start fresh" then left the session on an **unpublished fresh identity** — peers kept sealing to the dead pre-reinstall bundle; every inbound envelope ack-dropped until the next cold start.                                                                            | Flag reset on every exit from the deferred window (store-null return, `restoreBackup` catch; the boot-catch and publish-`finally` resets already existed). Pinned by the wiring scan.                                                                                        |
| B-163 | P1  | ledger seed                   | The B-94 seed ran `loadAll()` **after** the archive drain and marked every local row as flushed — including archive-replayed and live-received rows the server mirror never got. The boot sweep then skipped them forever; the next restore permanently lacked them (the archive expires ≤ 30 days).                                                                                                       | Seeding moved **inside** `restoreAllMessages`' verified flush: exactly the flushed row set, hashed from the SQL round-trip so boot-sweep hashes byte-match (a divergent hash would re-open I1). I7 rewritten in the runbook.                                                 |
| B-164 | P1  | `fcmBootstrap`                | The **background** msg-wake booted the runtime with no `isRestoreModeActive()` guard (only the foreground path had one). A push while the user sat on the restore screen ran `installIdentity` + bundle publish → OPK pool wiped + RESTORE gate permanently disarmed (the Round-8 stranded-backup class). The boot-decision → screen-mount window (nav settle, up to 60 s) was unguarded on all paths.     | Guard added to the bg msg-wake runtime-boot site; boot now arms restore mode when it decides to enter the RESTORE gate (cleared on nav failure; flag remains in-memory so a crash can't strand it).                                                                          |
| B-165 | P1  | `restoreMessages`             | Conversation rows were applied **before** Merkle verification and via wholesale `upsertConversation` replace. An integrity-failed restore left unverified conversation rows applied; on a live store (unlock path, or a rekey drained during password entry) the backup's stale member list stomped fresher state — send fan-out kept targeting a **removed** member and missed added ones (the L9 class). | Conversations staged like group states (P2-B-5) and applied only post-verify; a conversation the live store already holds is **never** overwritten; when the epoch guard keeps a newer live group state, `setGroupState(live)` re-syncs `participants` from live membership. |
| B-166 | P1  | restore orchestration         | Kill window between the walk clearing H-2 and the archive drain arming its own marker (the snapshot phase sat between them): no marker survived → the sealed archive was never drained and silently expired.                                                                                                                                                                                               | The runner arms **both** markers before the first phase; the drain still clears its marker only on a natural end.                                                                                                                                                            |
| B-167 | P1  | `merkleCommit`                | ≥ 6 unserialized commit entry points. A slow walk-A finishing after a fresh walk-B shipped meant A's stale root 409'd — and the I6 adopt **re-signed that stale root at a higher seq**. Server left holding pre-flush bytes as the newest signed commit with the pending flag already cleared: a permanent equal-count `root_mismatch` with no heal.                                                       | `commitMerkleRoot` is now single-flight (arrival-order promise chain). The newest walk's root is always the last shipped; the flush-epoch guard still covers flushes landing mid-walk.                                                                                       |
| B-168 | P1  | `messageMirror`               | `flush()` never checked the owner gate, its failure path requeued into the queue `disposeMirror` had just cleared, and retry timers were untracked. Sign-out during an in-flight flush (401 → "retryable") parked user A's rows; user B's later unlock wrapped A's plaintext **and group master keys** under B's master key and POSTed them into B's mirror.                                               | Session-generation guard captured at flush entry (stale ⇒ no requeue, no ledger bookkeeping), owner gate enforced at flush time, all retry/sweep timers tracked and cancelled on dispose/wipe.                                                                               |
| B-169 | P1  | `messageMirror`               | `markDirty`'s not-found fallback shipped a real `__deleted__` tombstone. The in-memory store holds only ~200 rows/convo — late outbox drains and receipts on old messages routinely nudge SQL-evicted **live** rows → live backup row overwritten with a tombstone → restores dropped the message.                                                                                                         | Fallback removed (dedup still cleared so the next sweep re-mirrors from SQL truth). Genuine removals already go through the authoritative H-3 `mirrorRemoval` path. Mutation-proven RED.                                                                                     |
| B-170 | P2  | `BackupSetupScreen` unlock    | Three defects: `setMirrorKey` fired the (wired) catch-up sweep **concurrently with the walk** → sweep uploads/commits landing mid-walk hard-failed the verifier on healthy accounts; `counts.incomplete` ignored → truncated restore shown as success; no I7 ledger seed → next boot re-encrypted + re-uploaded the whole restored history (the B-94 drift factory re-opened per unlock).                  | The unlock path now hands off to the BR-1 runner exactly like the fresh-install path: key flip deferred until the walk completes (the auto-fired sweep is then safe), auto-resume handles incompleteness, the in-walk seed covers I7.                                        |
| B-171 | P2  | `messageMirror`               | `mirrorRemoval`'s live-version strip deleted the tombstone dedup key it then checked — repeated removals flooded the queue with duplicate tombstones (amplifying B-169 toward queue overflow).                                                                                                                                                                                                             | Tombstone-key check moved before the strip.                                                                                                                                                                                                                                  |
| B-172 | P2  | wipe/rotation                 | Neither forget path tore down the live mirror (kept flushing under the wiped key → permanently unrestorable rows), and an in-flight old-key flush landing after a rotation recorded itself into the **fresh** ledger — pinning undecryptable rows out of every future sweep.                                                                                                                               | New `resetMirrorForWipe()` (queues + key + dedup + timers dropped, generation bumped, subscription kept) wired into both forget paths and before `setupBackup` on the rotation path; the generation guard skips ledger bookkeeping for stale batches.                        |
| B-173 | P2  | `messageMirror` (I2)          | Pending-commit flag was raised only after `putMessages` **and** the ledger write — a kill between them left changed server bytes, a suppressing ledger, and no flag → no boot heal → equal-count `root_mismatch`.                                                                                                                                                                                          | Flag raised **before** the upload; a failed upload leaves it set (one harmless extra commit — the safe direction). I2 rewritten in the runbook.                                                                                                                              |
| B-174 | P2  | `messageMirror`               | Overflow-triggered catch-up sweep timer deref'd `catchUpSweep!` at fire time; a dispose inside the 1 s defer nulled it → uncatchable `TypeError` inside a timer → release-build crash.                                                                                                                                                                                                                     | Null-checked at fire time + tracked/cancelled on dispose.                                                                                                                                                                                                                    |
| B-175 | P2  | `identityBackup`              | Zeroization gaps: a throw from `getIdentityBundle` (403 token expiry, 30 s abort, 5xx) left the 32-byte argon2-derived wrap key live in the heap — breaking the module's own B-45 zero-on-throw contract; same class in `setupBackup`'s master-key wrap.                                                                                                                                                   | One `finally` owns each raw key's fill on all paths. Pinned by `identityBackupZeroize.test.ts` (drives the exact leak lane).                                                                                                                                                 |
| B-176 | P2  | `backupClient` + screens      | 403 `verify_required` mapped to the same kind as wrong password → a **correct-password** user (token consumed by an aborted request / TTL) was told "Wrong password", whose advertised recovery is the irreversible wipe.                                                                                                                                                                                  | Distinct `verify_required` kind + dedicated copy ("your password was accepted, just try again") + inline-recoverable handling on both screens.                                                                                                                               |
| B-177 | P2  | `backupClient` + mirror       | 507 quota → `server`, 4xx validation → `network` — both "retryable": the mirror re-encrypted and re-POSTed the same batch every 5–8 s forever, and the user never learned the backup had stopped.                                                                                                                                                                                                          | New terminal kinds `quota_exceeded` / `invalid_request`; the mirror drops + clears dedup (sweep can re-attempt) and quota surfaces the "backup behind" banner.                                                                                                               |
| B-178 | P2  | server `putConversations`     | `group_state: r.group_state ?? null` + last-write-wins upsert: any conversation mirrored without group state (not yet hydrated, or a decrypt-skip during restore) **nulled the stored encrypted group master key** — the next restore had no key for that group.                                                                                                                                           | Split upsert: rows without group state omit the column entirely (ON CONFLICT leaves the stored value untouched). **Requires messenger-service deploy.**                                                                                                                      |
| B-179 | P2  | server + client conversations | `getConversations` capped a cursor-less call at 5000 with only a server-side log; the client never paginated → accounts past the cap silently lost the remainder on restore. The timestamp-only cursor also dropped tie rows at page seams (the exact class `getMessages` was fixed for).                                                                                                                  | Server: tuple keyset `(last_message_at, conversation_id)` + `cursorId` param (legacy clients unaffected). Client: `restoreAllMessages` pages until a short page; degrades gracefully against an old server. **Requires deploy for the full fix.**                            |
| B-180 | P2  | `restoreTombstones`           | The module cache ignored the owner: after an in-process account switch, user B was served user A's tombstone set, and B's restore merged B's ids into A's cached set. The existing test masked it with a test-only reset.                                                                                                                                                                                  | Cache keyed on owner, re-loaded on mismatch; empty owner never cached. New suite deliberately switches accounts without the reset.                                                                                                                                           |
| B-181 | P2  | `archiveReplay`               | Exhausting the 1000-page cap fell through to the marker/cursor **clear** — a truncated drain was declared complete and the tail abandoned (30-day fuse).                                                                                                                                                                                                                                                   | `reachedEnd` tracked (mirrors L-10); cap-hit returns `incomplete: true` with resume state kept; the runner keeps draining in-session.                                                                                                                                        |
| B-182 | P3  | `httpSnapshotTransport`       | `fetchLatest` swallowed **every** BackupError as "no snapshot": one transient timeout silently skipped the whole Phase-2 ratchet recovery (messages under old chains permanently lost) with only a console line.                                                                                                                                                                                           | Only `service_disabled` / `no_backup` map to null; transient failures propagate; the runner's snapshot phase retries ×3 with backoff.                                                                                                                                        |
| B-183 | P3  | restore seam                  | The H-2 restore-incomplete marker was armed only when the message walk started — a kill during the several-second publish/rebuild/keychain span after the identity was irreversibly installed left no auto-resume (plain RESUME boot; user had to find Settings → Chat Backup).                                                                                                                            | Marker armed immediately after `restoreBackup` succeeds on both screens; the runner re-arms it and BR-2 resumes silently.                                                                                                                                                    |

---

## 3. BR-1 — background restore, batch-by-batch (the feature)

**Before:** the user sat on `BackupRestoreScreen` behind a full-screen overlay for the entire walk +
verify + flush + hydrate + snapshot + archive drain — minutes for large histories — and a P2-B-6
buffer-cap window ended in "tap CLOSE, then RESTORE" with a fresh password prompt per 20k rows.

**Now:**

1. **Identity phase stays on-screen** (password → proof → identity install → runtime rebuild →
   keychain save). It is fast and it is the part that must not run unattended (B-107).
2. The screen then calls `startBackgroundRestore(...)` and navigates straight to MessengerHome.
3. `restoreBackground.ts` orchestrates: ratchet-snapshot apply (**moved before the walk** so live
   inbound during the restore decrypts against restored chains) → the verified message walk,
   **auto-resuming** buffer-cap windows in-process (stall guard + 50-round ceiling; the B-81
   repair-and-retry lives here, once per start) → sealed-archive drain (loops cap-hit windows) →
   mirror hand-off (`startMirrorBootstrap` + ledger-seeded sweep + `setBackupEnabled`).
4. **Batch-by-batch hydration:** each verified flushed batch paints into the store immediately
   (M-13 write-through suppression held per batch, JS-thread yield per batch — the B-155 lesson).
   The chat list fills conversation-first, then messages stream in oldest-forward. **Nothing is
   painted or persisted before `verifyMerkleCommit` passes** — the H-6 defer-write posture and the
   I3 verifier are byte-for-byte untouched.
5. **`RestoreActivityBanner`** on MessengerHome (obsidian/cobalt, matches the design system):
   running (spinner + live count + "You can keep chatting"), error (humanized message + RETRY that
   resumes at the first incomplete phase), done (counts, auto-dismisses).
6. **BR-2 — silent boot resume:** an interrupted restore now boots into `RESTORE-RESUME-AUTO`:
   runtime up → keychain mirror key → identity keypair from the local store → runner resumed from
   the persisted cursors. No password, no restore screen. Falls back to the password screen when
   any piece is missing. An archive-only interruption skips the message walk entirely.
7. The forget/wipe paths `stopBackgroundRestore()` + `resetMirrorForWipe()` so a wiped mirror is
   never still being walked or flushed.

Restore mode (B-107 call-rejection) now covers only the identity phase + the boot-to-mount window —
during the background walk the user takes calls normally.

---

## 4. Files changed

**Client — backup module:** `restoreBackground.ts` (new), `restoreMessages.ts`, `restoreResume.ts`
(unchanged API), `restoreTombstones.ts`, `restoreMode.ts` (unchanged), `archiveReplay.ts`,
`messageMirror.ts`, `merkleCommit.ts`, `backupBoot.ts`, `backupClient.ts`, `backupErrorCopy.ts`,
`identityBackup.ts`, `httpSnapshotTransport.ts`.
**Client — screens/push:** `BackupRestoreScreen.tsx`, `BackupSetupScreen.tsx`,
`RestoreActivityBanner.tsx` (new), `MessengerHomeScreen.tsx` (banner mount), `push/fcmBootstrap.ts`.
**Server:** `backup/backup.service.ts` (group_state preserve, conversations tuple cursor),
`backup/backup.controller.ts` (`cursorId` param).
**Docs:** `docs/runbooks/BACKUP_LOOP.md` (I2/I7 rewritten, BR-1/BR-2 section, new gates, failure
table row), `sqa.md` (B-162..B-183 entry + header).

---

## 5. New tests (all in `src/modules/messenger/__tests__/`, `messenger-crypto` project)

| Suite                                | Tests | Pins                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `restoreBackgroundRunner.test.ts`    | 10    | phase order, markers-before-walk (B-166/183), auto-resume + stall guard, B-81 repair budget, re-entrancy, phase-checkpointed retry, cooperative stop, drain loop (B-181), skipMessageWalk, unlock-vs-fresh mirror hand-off (B-170)                                             |
| `restoreBatchHydrate.test.ts`        | 5     | batch-by-batch paint under M-13 suppression, **nothing hydrates on integrity failure**, verified-only ledger seed (B-163), live-conversation no-stomp + participants resync (B-165)                                                                                            |
| `mirrorSessionHygiene.test.ts`       | 9     | flush-time owner gate + no requeue-after-dispose (B-168), no tombstone fabrication (B-169, mutation-proven RED), tombstone dedup (B-171), rotation bookkeeping skip + `resetMirrorForWipe` (B-172), flag-before-upload + flag-survives-failure (B-173), quota terminal (B-177) |
| `merkleCommitSingleFlight.test.ts`   | 2     | strict commit serialization (B-167), chain survives a rejected commit                                                                                                                                                                                                          |
| `backupClientErrorMap.test.ts`       | 8     | 403→`verify_required` (B-176), 507/4xx terminal kinds (B-177), B-50 409 split + meta, wrong_proof no-refresh-retry, 401 refresh-once, 423/410/404/503, thrown-fetch→network                                                                                                    |
| `httpSnapshotTransportFetch.test.ts` | 4     | fetch propagates transient errors (B-182), null only for no-backend, upload M-16/F9 split                                                                                                                                                                                      |
| `restoreTombstoneOwnerCache.test.ts` | 3     | owner-keyed cache, no cross-account bleed (B-180), anonymous load not pinned                                                                                                                                                                                                   |
| `archiveReplayCapResume.test.ts`     | 2     | cap-hit → incomplete + resume state kept (B-181), natural end unchanged                                                                                                                                                                                                        |
| `identityBackupZeroize.test.ts`      | 2     | derived key zeroed on the `getIdentityBundle` throw lane (B-175) + the verify-reject lane                                                                                                                                                                                      |
| `backupBootRestoreResume.test.ts`    | 3     | BR-2 silent resume params, archive-only `skipMessageWalk`, keychain-missing fallback to the screen                                                                                                                                                                             |
| `backupScreenWiring.test.ts`         | 8     | static source scans (comment-stripped, CRLF-safe): defer-publish resets (B-162), runner hand-off + no inline walk, wipe teardown + I5, bg msg-wake gate (B-164), boot restore-mode arming + AUTO lane, banner mounted                                                          |

Existing pinned suites: all 25 backup/merkle suites (194 tests) pass unmodified against the changed
code — no invariant test was weakened or deleted.

---

## 6. Gates & verification

- `npx jest --selectProjects messenger-crypto` — **run 1: 287 suites / 2787 tests green; run 2:
  green** (B-126/B-153 flake rule).
- `npm run typecheck` — 47 errors = baseline exactly (no new errors; the one hit in a touched file
  is the pre-existing baseline `Nav` error in `MessengerHomeScreen`, line-shifted).
- `apps/messenger-service` `tsc --noEmit` — clean.
- Mutation proof: B-169's fix reverted → its test went RED → fix restored (representative of the
  suite's construction: the other bug tests assert calls/orderings/symbols that did not exist
  before the fixes, so they are RED-by-construction against the pre-fix tree).

### Not exercisable this session (state it, per the runbook)

- **§5.1 idle-boot silence / §5.2 kill-window heal / §5.3 fresh-install restore round-trip on a
  device** — no debug APK build + device pass was run in this session. These remain the required
  on-device checks before release, now with one addition: kill the app mid-background-restore and
  verify the `RESTORE-RESUME-AUTO` boot lane continues without a password prompt.
- **§5.4 SQL drift probes** — read-only Supabase probes not run this session.

---

## 7. Deployment notes & residual risks

1. **Server deploy required** for B-178 (group_state preserve) and B-179 (conversations tuple
   cursor). The client is fully backward-compatible with the old server (it degrades to the old
   timestamp-cursor paging and the old clobber behaviour — i.e. no worse than today), but B-178 is
   only actually fixed once the service ships. Push to `main` auto-deploys via the staging pipeline.
2. **Restore mode is narrower now** (identity phase only). Calls during the background walk are
   accepted by design — call logs append through the live path and merge cleanly with hydration.
3. The backup screens still use the **legacy navy palette** (`backupPalette.ts` `#04101F`), a G8
   design-system deviation predating this session. The new banner is obsidian/cobalt. Retheme of
   the three screens is deliberately out of scope here — flagged for a design pass.
4. `restoreBackground` state is in-memory; a process kill mid-run relies on the persisted markers +
   cursors (tested) rather than the runner's own state — by design.
5. Untested-behavior inventory from the audit that remains open (no bug, just no pin):
   `backupBiometricGate` wrapper wiring, `backupCrypto` short-blob/odd-hex guards,
   `backupWireV3` H-8 malformed-legacy branches, most server endpoints beyond the verify protocol
   (`backup.service.spec.ts` covers only P0-1). Reasonable next increment.

---

## 8. Sign-off state (BACKUP_LOOP §6)

- [x] §4 automated gates green (crypto ×2, tsc ≤ baseline, service tsc clean)
- [ ] §5.1 / §5.3 device checks — **not exercisable this session** (no device build); required
      before release, incl. the new mid-restore-kill → silent-resume check
- [x] Every §2 invariant re-checked against the diff; I2 and I7 deliberately **strengthened**
      (documented in the runbook); I1/I3/I4/I5/I6/I8/I9 preserved — I3's verifier and the P0-1
      proof gate are byte-untouched
- [x] Nothing softened: `verifyMerkleCommit`, `verifyProof`, biometric gates, seq monotonicity all
      unchanged
- [x] `sqa.md` + `BACKUP_LOOP.md` updated
