# Messenger Backup — Software Quality Audit

> **Remediation status (2026-07-03) — COMPLETE.** All 3 Critical, 15 High, 18 Medium, and Low findings were fixed and verified. The two items initially deferred were subsequently implemented in backward-compatible ways: **M-3 (AAD binding)** — added AES-GCM AAD context-binding to the message-row and group_state blobs (bound to owner+message_id / owner+conversation_id) plus an identity-envelope owner binding, with a legacy no-AAD decrypt fallback so existing backups still restore and a mix-and-match swap is rejected (this strengthens the primitive rather than weakening it, and changes no stored wire bytes); and **M-12 (whole-backup memory)** — restore now hashes each Merkle leaf incrementally (keeps 32 bytes/row instead of full ciphertext) and bounds the in-memory hydrate per conversation, with the Merkle root byte-identical (all merkle tests pass). The cosmetic Lows are done too: palette + biometric-gate + error-copy de-duplication, dead-progress-state removal, `MSG_BASE_URL` fallback warning, and the O(n)-per-mutation mirror re-hash reduced to O(changed) via array-ref skipping. **Migration applied:** the M-5 atomic-bump RPC (`20260703000000`) was applied to Supabase (`qkkfkicgoncxslbwhyhz`) and hardened (`REVOKE EXECUTE FROM PUBLIC` — the Supabase advisor caught that the default PUBLIC grant would have let anon lock out any user's backup via PostgREST RPC; that warning now clears). The `verifier_key` column and `expires_at_sec` column/index were already applied. Gates after remediation: messenger-crypto **1250/1250** tests pass, messenger-service **177/177** pass (incl. the P0-1 verify spec **11/11**, which previously didn't compile), mobile typecheck **46** errors (baseline 49, unchanged), server typecheck **0**, lint clean, and the security advisor shows **no new issues** from the migration. The one remaining pre-release gate is on-device verification of the full restore round-trip (no device in the build environment). See the **Remediation Log** at the bottom for per-finding detail.

**Project:** Bravo Secure — Messenger Backup & Restore
**Date:** 2026-07-02
**Reviewer:** Senior engineering review (five parallel deep reviews across server, client crypto/upload, mirror/Merkle/snapshot, restore path, and UI/state/config)
**Scope:** `src/modules/messenger/backup/*`, `src/screens/messenger/Backup*Screen.tsx` + `RestoreProgressOverlay.tsx`, `apps/messenger-service/src/backup/*`, related Supabase migrations, DTOs, config, and the backup test suites.
**Method:** every source file in scope read in full; two headline findings re-verified directly against the code; prior internal audits (`docs/audits/BACKUP_RESTORE_AUDIT*.md`) cross-referenced to establish which earlier P0s are fixed vs. regressed. **No project files were modified.**

---

## Executive Summary

The Messenger Backup feature is an ambitious, mostly well-engineered end-to-end-encrypted backup system: opaque-ciphertext server stores, a two-layer key wrap (password → Argon2id → master key → per-row subkeys), v3 outer-metadata blinding, a signed Merkle commit for tamper/rollback detection, and a Double-Ratchet snapshot mechanism for reinstall-window recovery. The cryptographic primitives themselves are sound — correct AES-GCM usage, fresh 12-byte IVs everywhere, hardened Argon2id parameters, no key material or plaintext in logs, and a clean authorization model on the server (ownership always derived from the JWT subject, never from request bodies).

**However, the feature is not production-ready.** The review found a consistent and dangerous pattern: **several of the headline security and completeness features are shipped as scaffolding that does not actually run in production, and fail silently with no log signal.** Specifically:

1. **The P0-1 server-enforced password-verification protocol does not exist.** The migration, the server test spec, and the client helper functions all describe it, but `backup.service.ts` has no `verifyProof` method, the controller has no `/identity/verify` route, and the client never calls the verifier crypto. The encrypted identity bundle is served to any valid JWT, and the advertised 5-attempt lockout is honor-system only — an attacker with a stolen token downloads the bundle once and brute-forces the password offline, unthrottled. _(Verified directly: no verify/verifier symbol exists anywhere in `backup.service.ts`.)_

2. **The Double-Ratchet snapshot restore is dead code in production.** The master key is saved under one keychain owner (`email ?? phone ?? id`) and loaded under a different one (the bare Signal UUID), so for every real user the lookup returns null and the entire snapshot-apply block is silently skipped. _(Verified directly: save at `BackupRestoreScreen.tsx:282`, load at `:365`.)_

3. **The server's only test spec does not compile** — it tests the verify protocol that was never implemented — so the messenger-service backup suite provides **zero** effective coverage, and CI never runs it anyway.

4. **Multiple silent data-integrity and data-loss paths:** deleted messages are resurrected on restore (no tombstone ever reaches the server), the Merkle "self-heal" re-signs a commit over a partial/omitted row set (defeating the omission detection the layer exists for), the fresh-install restore never sets `backup:enabled` (so mirroring silently stops on the next cold start), and an interrupted restore is never auto-resumed.

The gap between what the code _claims_ (extensive doc comments, spec files, migrations) and what it _does_ is the single most important theme. Every one of the top findings is a silent failure with no telemetry, which is why they survived the multiple prior audit rounds recorded in the file headers.

**Verdict: Do not ship. Estimated 3–4 focused engineering weeks to close the Critical + High findings, plus an end-to-end test harness that exercises the real wiring (not injected keys/transports).**

Counts: **3 Critical, 15 High, 18 Medium, 20 Low** (after de-duplicating findings that multiple reviews reported independently — those overlaps are noted and raise confidence).

---

## Critical Issues

### C-1. P0-1 server-enforced password verification is entirely missing — offline brute-force is unthrottled

- **Severity:** Critical
- **Files:** `apps/messenger-service/src/backup/backup.service.ts:255-328` (getIdentityBundle / recordFailedAttempt), `apps/messenger-service/src/backup/backup.controller.ts`, `src/modules/messenger/backup/backupCrypto.ts:231-302` (dead `deriveVerifierKey`/`computeVerifyProof`), `src/modules/messenger/backup/identityBackup.ts:254-265`, migration `supabase/migrations/20260524000000_backup_verifier_key.sql`
- **Component:** Identity backup / brute-force protection
- **Description:** The migration adds a `verifier_key` column, the server spec tests a `verifyProof` method + nonce-bearing header + token-gated bundle GET, and the client ships `deriveVerifierKey`/`computeVerifyProof` with correct, test-pinned crypto. **None of it is wired.** The service has no `verifyProof` method and no `/identity/verify` route (verified: grep for `verifyProof|verifier_key|verifyNonce|verifyToken` in `backup.service.ts` returns nothing). `getIdentityBundle(userId)` returns the wrapped master key + wrapped identity bundle after checking only `locked_until`. The failed-attempt counter is incremented **only when the client voluntarily POSTs** `/backup/identity/fail`. The service's own doc comment admits "in this stripped-down Phase-1 implementation we treat the GET as the verification," and the migration preamble describes precisely this vulnerability. The client `deriveVerifierKey`/`computeVerifyProof` functions have zero production call sites (only `backupVerifyProof.test.ts` references them).
- **Why it matters:** The single strongest server-side protection for the entire E2EE backup — the equivalent of WhatsApp's HSM-enforced attempt throttle — is inert. One authenticated GET yields the wrapped bundle, after which the password is brute-forced offline at unlimited rate. The advertised lockout throttles only honest clients. The only real defenses left are the Argon2id cost factor and the 10-character password minimum.
- **Suggested fix:** Implement the protocol the spec already locks: `GET /identity/header` issues a Redis-stored single-use nonce; `POST /identity/verify` validates `HMAC-SHA256(verifier_key, 'bravo-backup-verify-v1:userId:nonce')` with constant-time compare, atomically bumps `failed_attempts` on failure (423 at threshold), and mints a short-TTL single-use token via `GETDEL`; `GET /identity/bundle` requires that token; `putIdentity` uploads and requires `verifierKey`. Handle legacy NULL-verifier rows with a 409 `verifier_missing` prompting a client re-setup. Then wire the client (`backupClient.verify()`, call `computeVerifyProof` in `restoreBackup`) — or, if deferring, delete the dead client helpers and the stale spec so they stop advertising a control that does not exist.

### C-2. The server backup test spec does not compile — zero effective coverage, and CI never runs it

- **Severity:** Critical
- **File:** `apps/messenger-service/src/backup/backup.service.spec.ts` (entire file); CI: `.github/workflows/deploy-messenger.yml`
- **Component:** Server test coverage / release gate
- **Description:** Running the spec fails at TypeScript compilation (`Property 'verifyProof' does not exist on type 'BackupService'`, `getIdentityBundle` "Expected 1 arguments, but got 2", `header.verifyNonce` doesn't exist). **Zero tests execute.** Nothing tests what the service actually does — `putMessages` dedupe/batch caps, the tuple-cursor pagination (the trickiest logic in the file), the `putConversations` legacy-column fallback, the `forgetBackup` matrix, the rotation-wipe in `putIdentity`, or the archive retry-outbox/drain/dead-letter state machine. The deploy workflow builds and ships the Docker image **without running the service's tests**, so a red suite that looks green.
- **Why it matters:** The service handling every user's encrypted backup has no working automated safety net, and the release pipeline cannot catch a regression.
- **Suggested fix:** Implement C-1 (the spec is its contract), then add the actual-surface tests above, and add a `jest` step for `apps/messenger-service` to the deploy workflow / CI bundle so a compilation failure or test failure blocks release.

### C-3. Double-Ratchet snapshot restore is dead in production (owner-key mismatch) — reinstall-window recovery never runs

- **Severity:** Critical (silent feature-kill shipping today)
- **Files:** `src/screens/messenger/BackupRestoreScreen.tsx:282` (save) vs `:365` (load), `:368`/`:373` (seq floor); scheduler owner at `src/modules/messenger/runtime/productionRuntime.ts:1369`; contract pinned by `src/modules/messenger/__tests__/mirrorKeyOwner.test.ts`
- **Component:** Phase-2 ratchet-snapshot recovery
- **Description:** _(Independently found by two reviews; verified directly.)_ The mirror master key is saved under the canonical owner — `saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64)` where `ownerKey = email ?? phone_e164 ?? id` (line 282). Thirty lines later the snapshot-apply block loads it with `loadMirrorMasterKey(ownerUserId)` — the bare Signal UUID, with no `legacyOwnerId` fallback (line 365). For every user who has an email or phone (i.e., everyone), `rawB64Key` is `null`, the `if (rawB64Key && store)` guard silently skips, and `applyRatchetSnapshot` **never runs** — with no log line. This is the exact save/load-service mismatch class that `mirrorKeyOwner.test.ts` pins for the boot path, regressed at a different call site. The seq floor is also split-brained: capture persists under `config.ownerKey ?? ownUserId` (productionRuntime.ts:1369) while restore reads/writes via `readPersistedSnapshotSeq(ownerUserId)`/`persistAppliedSnapshotSeq(ownerUserId)` — different AsyncStorage keys.
- **Why it matters:** The entire Phase-2 deliverable (scheduler, HTTP transport, backend endpoint, e2e test) is a production no-op. Messages received during the reinstall window still hit `DecryptError` → ack-and-drop; the gap the feature was built to close is still open. The e2e test can't catch it because it injects the key + an in-memory transport directly.
- **Suggested fix:** Load with `loadMirrorMasterKey(ownerKey ?? ownerUserId, ownerUserId)` (canonical + legacy fallback) and key the snapshot seq on the same `ownerKey` the scheduler uses, in all three call sites. Add a log line when the key lookup misses.

---

## High Priority Issues

### H-1. Fresh-install restore never sets `backup:enabled` → mirror silently dies on the next cold start

- **Severity:** High
- **Files:** `src/screens/messenger/BackupRestoreScreen.tsx` (success path — flag never set; verified: no `backup:enabled` write in the file); boot gate `src/modules/messenger/backup/backupBoot.ts:158-199`; flag set only in `BackupSetupScreen.tsx:232,323`
- **Component:** Post-restore mirror lifecycle
- **Description:** `runBackupBoot`'s RESUME-AUTO / RESUME-LOCKED branches are gated on `AsyncStorage.getItem('backup:enabled') === '1'`. The fresh-install restore restores everything and saves the mirror key to the keychain, but never sets the flag. Mirroring therefore works only for the rest of the restore session; every later cold start skips both resume branches, `setMirrorKey` never runs, and new messages silently stop reaching the backup — recreating the exact "CRITICAL-2" failure documented at `backupBoot.ts:143-151`.
- **Why it matters:** The user believes backup is active; on the next reinstall, everything since the first restore is missing. Silent.
- **Suggested fix:** `await AsyncStorage.setItem('backup:enabled', '1')` (and clear `backup:skipped`) in the restore success path, mirroring `BackupSetupScreen.tsx:323-324`.

### H-2. Interrupted restore is never auto-resumed; the resume-cursor machinery is orphaned

- **Severity:** High
- **Files:** `src/modules/messenger/backup/backupBoot.ts:104` (`!localKeyExists` gate), `restoreMessages.ts:271-278`, `restoreResume.ts`
- **Component:** Crash-mid-restore recovery
- **Description:** Once `handleRestore` has booted the runtime (SQLCipher key created) and installed the identity, a kill/OOM/Doze mid-page-walk leaves partial history plus a valid resume cursor. On relaunch `hasDbKey` is now true, so boot classifies **RESUME, not RESTORE**, and the user lands on the home screen with tail-missing history. The only consumer of the resume cursor is another `restoreAllMessages` call, which requires a manual trip through the Settings unlock screen — and because of H-1 the user is never prompted. The cursor sits in AsyncStorage indefinitely.
- **Why it matters:** "Crash mid-restore" — the exact scenario the resume cursor was built for — ends in silent, permanent-looking partial history.
- **Suggested fix:** On boot, if `readRestoreCursor(ownerUserId)` is non-null, re-enter the restore flow (or run a headless `restoreAllMessages` once the mirror key is available) before declaring RESUME.

### H-3. Deleted messages are never tombstoned → restore resurrects "delete for everyone" messages

- **Severity:** High
- **Files:** `src/modules/messenger/store/messengerStore.ts:662-668` (`removeMessage`), `src/modules/messenger/backup/messageMirror.ts:242-292`
- **Component:** Mirror / delete propagation
- **Description:** `removeMessage` calls `notifyBackupDirty(messageId)` **inside** the immer `set` recipe. `markDirty` then reads `useMessengerStore.getState()`, which returns the **pre-commit** state, so the "removed" message is still present → the live row is re-enqueued (and dropped as a version-hash no-op). The tombstone branch (`status:'deleted'`) is unreachable from this path, and `mirrorBootstrap`'s diff loop only iterates existing messages, so removals emit nothing there either. No delete marker ever reaches the server; `restoreMessages.ts:426` has nothing to skip.
- **Why it matters:** Privacy defect — a deleted message (including "delete for everyone") returns on every restore/reinstall, defeating the tombstone's documented purpose.
- **Suggested fix:** Invoke `notifyBackupDirty` _after_ the state commit (`queueMicrotask`/`setTimeout(0)` outside the recipe), or pass explicit `removed: true` to `markDirty`. Add a test: removeMessage → flush → `putMessages` payload contains a `deleted` row.

### H-4. Merkle "self-heal" re-commit defeats the omission/rollback detection it exists for

- **Severity:** High
- **Files:** `src/modules/messenger/backup/restoreMessages.ts:508-530` (+ `recommitAndReverify` :123-147), `merkleCommit.ts:150-152`, `backupMerkle.ts` (threat model)
- **Component:** Merkle verify / restore integrity
- **Description:** On `root_mismatch` with a valid signature and an available `identityPrivKey` (which production always passes), restore re-signs a commit over **whatever rows the server just served** and proceeds. The justification addresses commit _forgery_, not the actual threat — per the layer's own threat model, the server can REORDER, OMIT, or ROLL BACK rows. A server that drops N rows produces exactly this state; the self-heal then re-commits over the reduced set, the restore "succeeds," and the original signed commit — the only evidence of omission — is overwritten server-side. `verifyMerkleCommit` never compares `rows.length` against `commit.rowCount` either.
- **Why it matters:** The main property the Merkle layer adds over per-row GCM (omission/rollback detection) is reduced to a `console.warn`.
- **Suggested fix:** Gate the self-heal on `merkleRows.length >= commit.rowCount` (and that all drifted rows still GCM-decrypt); otherwise abort with `MerkleCommitMismatchError('rows_missing')`. Add a test that an omitted-row set is refused even with the priv key present.

### H-5. Resume + Merkle are incompatible; self-heal re-signs over a partial (or empty) row set

- **Severity:** High
- **Files:** `src/modules/messenger/backup/restoreMessages.ts:273-278,297-298,324-339,494-536`
- **Component:** Restore paging / S8 integrity
- **Description:** On a resumed restore, `merkleRows` contains only rows _after_ the persisted cursor. `verifyMerkleCommit` recomputes the root over this partial set against a commit signed over **all** rows → guaranteed `root_mismatch` on every resumed run → self-heal signs and uploads a commit covering **only the tail**, and the earlier durably-written pages are never integrity-checked. Degenerate case: killed between the last `writeRestoreCursor` and `clearRestoreCursor` → next run walks 0 rows → self-heal signs a commit over an **empty** set.
- **Why it matters:** S8 protection is silently defeated in exactly the interrupted-restore scenario where server-side row injection is most plausible; the server's signed commit is corrupted until the next mirror-flush re-commit. (Compounds H-4.)
- **Suggested fix:** When a resume cursor exists and Merkle is wanted, either hash the pre-cursor rows too (lightweight id/ts/ciphertext walk) so `merkleRows` is complete, or refuse to combine resume with self-heal (clear the cursor, restart from page 0). Never re-commit over a known-partial set.

### H-6. Merkle verification runs _after_ the local store is already mutated — the "abort before writing" guarantee is false

- **Severity:** High
- **Files:** `src/modules/messenger/backup/restoreMessages.ts:293-296` (comment), `447-453`, `199-253`, verify at `:494`
- **Component:** Restore atomicity / integrity gate
- **Description:** The comment claims verification raises "BEFORE mutating the local store." In reality phase 1 upserts every conversation + `setGroupState` (including group master keys) into the live store, and phase 2 commits every page to SQLCipher via `upsertBatch` — **all before** `verifyMerkleCommit` runs. On mismatch the screen shows an error, but the full unverified history and group keys are already on disk and hydrate on the next cold boot.
- **Why it matters:** The abort is cosmetic; combined with H-4/H-5 the S8 gate is largely decorative on the production SQL path.
- **Suggested fix:** Verify against the streamed `merkleRows` _before_ the first `upsertBatch` (two-pass hash-walk then import), or stage pages into a temp table / mark-restore-incomplete and delete on mismatch. At minimum correct the misleading comment.

### H-7. Overflow-triggered catch-up sweep is a no-op — dropped rows stay poisoned in the dedup cache and are lost for the session

- **Severity:** High
- **Files:** `src/modules/messenger/backup/messageMirror.ts:224-225` (dedup add at enqueue), `406-419` (overflow drop + sweep), `423` (non-network drop)
- **Component:** Mirror queue / backpressure
- **Description:** `mirrorMessage` adds the dedup key to `seenIds` **at enqueue time**. When the overflow path does `queue.splice(MAX_QUEUE_SIZE, drop)`, the dropped entries' `seenIds` keys are **not** removed. The remediation `catchUpSweep` → `backupNow` → `mirrorMessage` for every SQLCipher row then skips each dropped row on its still-present dedup key. Dedup is purely local and enqueue-time; there is no server-ack tracking, so the comment's claim that the sweep re-enqueues everything the server hasn't acked is false. Same for the non-network drop at `:423`.
- **Why it matters:** Under sustained backpressure (large initial `backupNow`, slow server) messages are permanently missing from the backup for the rest of the session; the "Backup is behind" banner clears as the shrunken queue drains, giving false assurance.
- **Suggested fix:** Delete the dedup keys for dropped items at both drop sites, or move `seenIds.add` to the flush-success path. Add a queue-mechanics unit test (none exists).

### H-8. Legacy `group_state` passthrough accepts unauthenticated, server-controlled plaintext (group-key substitution)

- **Severity:** High
- **File:** `src/modules/messenger/backup/backupWireV3.ts:217-221`
- **Component:** Group state envelope
- **Description:** `decryptGroupStateBlob` returns any object lacking `{v:3, blob}` **as-is** as a `GroupState`, with no shape validation and no authentication. The `group_state` column is fully server-controlled, so a malicious/compromised server can strip the v3 envelope and substitute plaintext with an attacker-chosen `masterKeyB64`, member list, and epoch; the restoring client adopts it. Contrast `decryptSessionSnapshot` (`ratchetSnapshot.ts:147-155`), which validates magic/version/shape.
- **Why it matters:** A substituted group master key lets the server read every group message the restored client subsequently encrypts — defeating exactly the protection this envelope was built for.
- **Suggested fix:** Record locally (or in the encrypted identity bundle) that this account has written v3 `group_state` and refuse plaintext thereafter; at minimum validate legacy shape and add AAD binding (see M-3).

### H-9. No rate limiting on any `/backup/*` endpoint

- **Severity:** High
- **Files:** `apps/messenger-service/src/backup/backup.controller.ts:41-42`, `apps/messenger-service/src/app.module.ts:32-36`
- **Component:** Server abuse protection
- **Description:** `ThrottlerModule.forRoot` is registered but there is no global `APP_GUARD`; `UserThrottlerGuard` is applied only in `relay/envelope.controller.ts`. `BackupController` uses `@UseGuards(JwtHttpGuard)` alone. Every backup route — including the brute-force-relevant `GET /identity/bundle` and `/identity/header`, and the write-heavy `POST /messages` (500 rows/call) — is unthrottled.
- **Why it matters:** Compounds C-1 (unlimited bundle fetches) and lets one JWT hammer Supabase with unlimited batch writes/reads.
- **Suggested fix:** Apply `UserThrottlerGuard` to `BackupController` with per-route `@Throttle` overrides (tight on identity endpoints, moderate on mirror push/pull).

### H-10. DTO size caps exceed the 100 KB Express body limit — large legitimate payloads 413 before validation

- **Severity:** High
- **Files:** `apps/messenger-service/src/main.ts` (no body-parser config), `apps/messenger-service/src/backup/dto/backup.dto.ts:24,30,37`
- **Component:** Server request handling
- **Description:** Nest/Express body-parser default limit is 100 kb. DTOs allow `wrappedIdentityBundle` up to 96 KB b64, per-message ciphertext up to 800 KB b64, and `PutSessionsDto.blob` up to **16 MB**. Any session snapshot beyond ~50 peer sessions, any mirrored large message, and worst-case identity bundles are rejected with 413 by body-parser and never reach the controller.
- **Why it matters:** The ratchet-snapshot feature — whose purpose is restoring _all_ peer sessions — silently fails for exactly the users with many contacts. Indicates the write paths were never tested at realistic sizes.
- **Suggested fix:** `app.useBodyParser('json', {limit: '20mb'})` (or per-route raw limits) sized to the largest DTO cap; add an integration test with a >100 KB payload.

### H-11. No per-user storage quota or retention on `messages_backup` / `conversation_backups`

- **Severity:** High
- **Files:** `apps/messenger-service/src/backup/backup.service.ts:603-639` (putMessages), `:688-737` (putConversations); migration `20260508120000_backup_round8.sql:94-102` (retention "currently absent — Phase-2")
- **Component:** Server storage / cost / DoS
- **Description:** Per-batch caps exist (500 msgs × 800 KB b64; 1000 conversations) but there is no per-user total-rows/bytes cap, no retention sweep on `messages_backup` (unlike the sealed archive), and — with H-9 — no rate cap on batch arrival. One authenticated user can grow Supabase storage without bound (~300 MB per request at DTO limits if H-10 is fixed naively). The sealed archive is also a per-recipient cost vector (attacker sends envelopes → unconditional archive rows for 90 days).
- **Suggested fix:** Per-user row/byte quota checked on write, a per-user daily write budget, and a Phase-2 retention decision for `messages_backup` before GA.

### H-12. Disappearing-message TTL (`expires_at_sec`) is write-only — expired sealed envelopes are neither swept nor filtered

- **Severity:** High
- **Files:** `apps/messenger-service/src/backup/backup.service.ts:1064-1089` (sweepSealedArchive), `:1021-1026` (getSealedArchive select), `:884-886` (only write site); migration `20260524000001_sealed_envelope_archive_expires.sql`
- **Component:** Server sealed archive / disappearing messages
- **Description:** The migration added `expires_at_sec` plus a partial index so the sweeper/restore filter could scan expired rows. But `sweepSealedArchive` deletes only `ts_ms < cutoff` (90 days), no code deletes `expires_at_sec < now()`, and `getSealedArchive` doesn't even return the column, so client-side filtering is impossible. `expires_at_sec` appears nowhere else in the service.
- **Why it matters:** A "1-hour disappearing" message is retained and served to a restoring client for up to 90 days — a violation of the locked disappearing-message architecture. The fix is half-landed (column populated, enforcement absent).
- **Suggested fix:** Add an `.lt('expires_at_sec', nowSec)` delete pass to the daily sweep (index exists), and filter/return the column in `getSealedArchive`.

### H-13. Settings-unlock restore silently diverges from fresh-install restore (skips Merkle verify, runtime rebuild, snapshot, archive drain)

- **Severity:** High
- **Files:** `src/screens/messenger/BackupSetupScreen.tsx:261-364` (handleUnlock) vs `BackupRestoreScreen.tsx:182-493`; `restoreMessages.ts:298` (`wantsMerkle` gate)
- **Component:** Restore integrity / consistency
- **Description:** _(Independently found by three reviews.)_ The Settings "unlock" restore omits four steps the fresh-install path performs: (1) **no runtime rebuild** after `restoreBackup` overwrites the identity — leaving the live runtime keyed to the pre-restore identity (the documented "force-close to fix" failure); (2) **no Merkle verification** — `restoreAllMessages` is called without `identityPubKey`/`identityPrivKey`, so the S8 gate is skipped even though the identity is available; (3) **no ratchet-snapshot apply**; (4) **no sealed-archive drain**. The two entry points claim to be "the same flow" but produce materially different completeness and security guarantees.
- **Why it matters:** A tamper/rollback the fresh-install path would reject is silently imported on this path; users get incomplete restores from Settings.
- **Suggested fix:** Extract the post-`restoreBackup` pipeline (rebuild runtime, pass Merkle keys, snapshot apply, archive drain) into a shared module both screens call.

### H-14. No fetch timeout anywhere in the backup client + non-dismissible progress overlay = permanently stuck restore

- **Severity:** High
- **Files:** `src/modules/messenger/backup/backupClient.ts:51-95` (bare `fetch`, no `AbortController`), `src/screens/messenger/RestoreProgressOverlay.tsx:123-147` (no close affordance in progress mode), `BackupRestoreScreen.tsx:113-119` (back swallowed while busy)
- **Component:** HTTP transport / restore UX
- **Description:** _(Found by two reviews.)_ RN `fetch` can hang for minutes on a black-holed connection. A stall during any of restore's serial phases (header, bundle, up to 1000 message pages, merkle, sessions, up to 1000 archive pages) hangs `await` forever. The overlay renders no button in progress mode, hardware back is swallowed while busy, gestures are disabled, and the copy says "Keep the app open." The only escape is force-killing the app — the most dangerous mid-restore exit.
- **Suggested fix:** Add a per-request `AbortController` timeout (~30 s) in `callJson` mapped to `BackupError('network','timeout')` so failures surface into the existing overlay error state; add a "Cancel" affordance to the progress overlay after a grace period.

### H-15. Probe failure bricks the Backup Setup screen with an infinite spinner and no retry

- **Severity:** High
- **File:** `src/screens/messenger/BackupSetupScreen.tsx:140-144,420-424`
- **Component:** Backup setup UX
- **Description:** On a network-class probe failure the code sets `setErr('probe_failed_retry')` and stays in `mode='probing'`. The comment says the user "sees a retry prompt," but none exists: the `probing` branch shows only a spinner + "Checking backup status…", and the error text renders only inside the `unlock`/`setup` branches. The effect has an empty dep array, so it never re-runs. Refusing to default to setup mode is correct (it protects against master-key overwrite), but the recovery UI was never built.
- **Why it matters:** Any offline/timeout entry into Settings → Chat Backup permanently bricks the screen.
- **Suggested fix:** Add a `probe_failed` mode rendering the error + a Retry button that re-runs the probe (extract the probe into a `useCallback`).

---

## Medium Priority Issues

### M-1. Restore honours server-supplied `kdfParams` with no bounds validation (OOM / crash / param tampering)

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/identityBackup.ts:255-256`, `backupCrypto.ts:110-121` (validates only `algo === 'argon2id'`)
- **Component:** KDF parameter handling
- **Description:** `memoryKib`, `iterations`, `parallelism`, `derivedKeyBytes` are used verbatim from the plaintext, unauthenticated, server-stored bundle. `memoryKib: 8_388_608` (8 GiB) crashes native Argon2 on any phone; `iterations: 0`/NaN is undefined native behavior. Nothing binds params to the ciphertext, so corruption/tampering surfaces to the user as "wrong password" (after a `recordFail` bump).
- **Suggested fix:** Clamp to sane bounds (e.g. 32 MiB ≤ mem ≤ 512 MiB, 1 ≤ iters ≤ 10, parallelism 1–4, derivedKeyBytes === 32, saltBytes 16) and fail with a distinct error kind, not "wrong password."

### M-2. `putIdentity` requires no proof of the old password — any bearer token can destroy/replace the backup and reset the throttle

- **Severity:** Medium (High once C-1 is understood as the intended gate)
- **Files:** `src/modules/messenger/backup/backupClient.ts:114-120`; server `backup.service.ts:210-216` (upsert resets `failed_attempts: 0, locked_until: null`)
- **Component:** Backup overwrite path
- **Description:** A stolen 15-minute access token suffices to POST an attacker-keyed bundle over the victim's backup (irrecoverable data-loss DoS — the victim's password no longer decrypts anything) and simultaneously clears the brute-force lock. The P0-1 spec intended `putIdentity` to be verifier-gated; that gate doesn't exist (C-1).
- **Suggested fix:** Part of C-1 — gate overwrite on a verify-token or an explicit "forget then re-setup with fresh authentication" flow.

### M-3. No AAD/context binding on any AES-GCM blob → server-side mix-and-match and rollback within a user's backup

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/backupCrypto.ts:142-151`, `backupWireV3.ts:187-205`
- **Component:** All wraps (master key, identity bundle, subkeys, payloads, group_state, session blob)
- **Description:** Every blob is `AES-GCM(iv, key, pt)` with no additional data, so all blobs under the master key are interchangeable ciphertexts. The server can swap `group_state` between conversations, swap `(ciphertext, wrappedSubkey)` pairs between rows (outer `message_id`/`msg_created_at` are plaintext and server-writable), or serve an **old** `wrappedIdentityBundle` alongside the current `wrappedMasterKey` (`refreshIdentityBackup` deliberately keeps the same wrapped master key, so stale-bundle rollback decrypts cleanly). v3 detection also trusts plaintext flags, so the server can relabel a row as legacy and have its forged outer fields trusted.
- **Suggested fix:** Pass AAD of `{purpose-tag, userId, objectId, version}` into `subtle.encrypt/decrypt` for each blob class; include a monotonic counter in the identity envelope.

### M-4. Master-key "rotation" detection wipes history on benign re-setup; a true rotation strands the snapshot + Merkle commit

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:159-215` (putIdentity)
- **Component:** Server identity rotation
- **Description:** Rotation is inferred from byte-inequality of `wrapped_master_key`. But the wrap is AES-GCM with a fresh IV/salt, so _any_ re-setup (re-enable backup with the same password; even a password change re-wraps the **same** master key) produces different bytes → the service wipes all `messages_backup` + `conversation_backups` rows that would still decrypt. Conversely, on a true rotation it does **not** touch `backup_session_snapshots` (blob now undecryptable, and its monotonic `seq` blocks the fresh device with a permanent 409 `stale_seq`) or `backup_merkle_commits` (stale root mismatches the wiped mirror).
- **Suggested fix:** Have the client send an explicit `rotated` flag or a stable master-key fingerprint (HKDF key-check value) instead of comparing wrap bytes; on true rotation also delete/reset the snapshot row and Merkle commit.

### M-5. Non-atomic server counters and check-then-write races

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:303-328` (recordFailedAttempt SELECT→+1→UPDATE), `:441-473` (putSessionSnapshot SELECT-seq→UPSERT), `:169-216` (putIdentity read→wipe→upsert)
- **Component:** Server concurrency
- **Description:** The failed-attempt counter loses increments under concurrency (directly weakening the throttle once C-1 lands). The snapshot seq check-then-set is racy (acknowledged in-comment). The putIdentity read→wipe→upsert is a multi-step non-transaction: a concurrent `putMessages` between wipe and upsert persists rows under the old key, and an upsert failure after a successful wipe loses the mirror.
- **Suggested fix:** Single-statement `UPDATE ... SET failed_attempts = failed_attempts + 1 RETURNING`; Postgres function/RPC for the seq-guarded snapshot upsert and the rotation wipe+upsert.

### M-6. Retry outbox bounded by count not bytes; unbounded dead-letter list with no tooling

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:829-833,905-931,962-981`
- **Component:** Server sealed-archive durability
- **Description:** `OUTBOX_MAX_LEN = 50_000` caps entries, but each embeds `outerSealed` (~933 KB b64) → worst case ~47 GB in Redis during a Supabase outage. `backup:archive-retry:dead` has no cap and no TTL, and the promised operator re-prime has no implementation. With 12 attempts at 5-minute drains, any outage over ~1 hour permanently dead-letters envelopes (durability silently lost). The `LLEN`+`LPUSH` cap check is also racy across replicas.
- **Suggested fix:** Cap by approximate bytes (or cap entry size), add LTRIM/TTL on the dead list, add a dead-letter growth metric/alert, and lengthen the retry horizon with exponential backoff.

### M-7. `forgetBackup` doesn't purge pending retry-outbox entries — "forgotten" ciphertext reappears

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:539-599` vs `:942-992`
- **Component:** Server privacy / forget
- **Description:** `DELETE /backup` wipes `sealed_envelope_archive`, but entries for that recipient still sitting in `backup:archive-retry` (or dead-letter) are re-upserted by the next drain, re-creating archive rows for a user who invoked the privacy wipe. Also, the earlier round-2 audit noted the Redis verify-nonce/token keyspaces are not purged on forget either.
- **Suggested fix:** On forget, record a short-lived `forgotten:{userId}` tombstone that the drain consults before upserting (or scan-and-drop matching outbox entries), and delete `backup:verify:*:userId:*` keys.

### M-8. PostgREST `.or()` filter built by string interpolation — `since` is unquoted/unescaped

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:657-666` (getMessages), `:1027-1033` (getSealedArchive); controller `backup.controller.ts:100-114` (no validation)
- **Component:** Server query construction
- **Description:** `sinceId` gets quote-escaping, but `opts.since` (raw query param) is interpolated verbatim into `msg_created_at.gt.${opts.since}`. A value with `,` or `)` injects extra PostgREST filter clauses. Impact is contained (the injected clauses AND with the separate `.eq('owner_user_id', …)`, so no cross-user read), but malformed input yields a 502 the client retries forever, and it's an injection-by-construction pattern one refactor from danger.
- **Suggested fix:** Validate `since` as strict ISO-8601 at the controller and double-quote the timestamp in the `.or()` expression.

### M-9. `putConversations` has no in-batch dedupe — a duplicate `conversation_id` 502s the whole batch

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/backup.service.ts:688-737`
- **Component:** Server conversation mirror
- **Description:** `putMessages` dedupes on `message_id` because Postgres `ON CONFLICT DO UPDATE` rejects a batch with two rows sharing the conflict key. `putConversations` upserts `onConflict: 'owner_user_id,conversation_id'` with **no dedupe** → the same failure returns 502 for the whole batch. Mobile retry queues are the documented source of duplicates.
- **Suggested fix:** Same `Map`-based last-write-wins dedupe as `putMessages`.

### M-10. One malformed row 502s a whole batch — `kind`/`msg_created_at` not validated against DB constraints

- **Severity:** Medium
- **File:** `apps/messenger-service/src/backup/dto/backup.dto.ts:95-96,144-145`
- **Component:** Server DTO validation
- **Description:** `msg_created_at` is only `@IsString @MaxLength(64)` and `kind` is any ≤16-char string, but the DB has `TIMESTAMPTZ NOT NULL` and `CHECK (kind IN ('direct','group','system'))`. A bad timestamp or out-of-enum kind passes DTO validation, violates the constraint, and fails the whole upsert → 502 `backup_write_failed` (a "server error" the client retries forever).
- **Suggested fix:** `@IsISO8601()` on `msg_created_at`, `@IsIn(['direct','group','system'])` on `kind`; optionally split-batch retry on constraint errors.

### M-11. Restore re-uploads the entire restored history back to the server through the mirror

- **Severity:** Medium
- **Files:** `src/screens/messenger/BackupRestoreScreen.tsx:276-336` (mirror started before restore), `mirrorBootstrap.ts:136-163`, `messageMirror.ts:329-429`
- **Component:** Restore ↔ mirror feedback loop
- **Description:** `startMirrorBootstrap` seeds `prevMessageVersions` from an empty store, then `restoreAllMessages` fires the subscription for every restored conversation and message → all treated as new, re-encrypted with fresh subkeys, re-POSTed in 50-row batches (~1000 sequential POSTs for 50K messages). Every re-upload changes the server ciphertext bytes, invalidating the stored Merkle commit until the 30 s-debounced re-commit lands — a self-inflicted source of the "benign drift" the self-heal (H-4/H-5) papers over. Sustained flush failures also trip the queue overflow → "Backup is behind" banner right after a successful restore.
- **Suggested fix:** Seed the mirror's `prev*Versions` from the restored rows (or suppress the mirror during restore and seed afterwards).

### M-12. Entire backup held in memory during restore (`aggregated` + `merkleRows` + uncapped hydrate)

- **Severity:** Medium
- **File:** `src/modules/messenger/backup/restoreMessages.ts:288,297,334-338,551`
- **Component:** Restore memory
- **Description:** `merkleRows` retains the full base64 ciphertext of every row, `aggregated` retains every decoded `LocalMessage` for the whole walk, and `hydrateMessages(aggregated, true)` copies everything into immer state. For the long-lived >100K-message users the Round-8 page cap was raised for, that's easily hundreds of MB on a mid-tier Android device → OOM kill mid-restore (which lands in H-2's no-resume trap).
- **Suggested fix:** Hash Merkle leaves incrementally per page (keep only digests) and hydrate per-conversation tails instead of the whole history; SQLCipher already holds the full set.

### M-13. Post-hydrate double-write storm through the runtime write-through subscriber

- **Severity:** Medium
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts:1393-1454`, `restoreMessages.ts:539-551`
- **Component:** Restore SQL write path
- **Description:** The final `hydrateMessages` makes the store→SQL diff subscriber see every restored message as new, so it re-issues `store.upsert(m)` (one autocommit `INSERT OR REPLACE` per row) for the whole history that `upsertBatch` just wrote in batched transactions. Thousands of concurrent promises hit SQLCipher immediately after restore, feeding the retry queue and possibly the "disk pressure" banner. Idempotent but burns the fsync cost.
- **Suggested fix:** Let the subscriber skip already-persisted rows (restore-generation marker, or diff against a snapshot taken after restore seeds `prev`).

### M-14. Transaction interleaving race: restore's `BEGIN/COMMIT` shares the DB handle with live writes from a different store instance

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/restoreMessages.ts:285-287` (new instance), `src/modules/messenger/store/sqlMessageStore.ts:279-292,82-93`
- **Component:** Restore concurrency
- **Description:** The per-conversation write-serialization chains live on the `SqlMessageStore` _instance_; restore constructs its own instance over the same op-sqlite handle the runtime subscriber uses, while the runtime is fully live (WS connected). A live inbound `upsert` can interleave between restore's `BEGIN` and `COMMIT` — silently joining (and being rolled back with) the restore transaction, or triggering "cannot start a transaction within a transaction" which aborts restore with a cryptic error.
- **Suggested fix:** Route restore through the runtime's shared `SqlMessageStore` (or a shared write mutex), or use op-sqlite's `transaction` helper.

### M-15. Post-reinstall ratchet-snapshot captures rejected by the server seq gate, but transport reports success

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/httpSnapshotTransport.ts:41-46`, `ratchetSnapshotScheduler.ts:213-228`
- **Component:** Snapshot capture after restore
- **Description:** _(Related to C-3; found by two reviews.)_ After reinstall, AsyncStorage is empty so the capture seq restarts at 1 while the server holds seq N. The rejection surfaces as `BackupError` kind `network` (4xx), which `upload()` swallows as `{ok:true}`, so the scheduler advances the local seq anyway (~1 per ≥5-minute capture). Until the counter climbs past N, no fresh ratchet state reaches the server though the client believes captures succeed. The intended seed (`persistAppliedSnapshotSeq`) is dead because of C-3.
- **Suggested fix:** Fix C-3 so the applied seq seeds the counter under `ownerKey`; make `upload()` distinguish "stale seq" (fetch server seq and fast-forward) from transient failure.

### M-16. `httpSnapshotTransport` and mirror flush swallow failures / drop batches with no telemetry

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/httpSnapshotTransport.ts:41-63`, `messageMirror.ts:382-425`
- **Component:** Upload error handling
- **Description:** _(Found by two reviews.)_ `httpSnapshotTransport.upload` swallows 5 of 6 `BackupErrorKind` values as success (only `locked` propagates), so persistent 5xx/dead-auth silently drops every session snapshot with no `console.warn`. In `fetchLatest`, both catch branches `return null`, so even a `TypeError` is misreported as "no snapshot exists." In `messageMirror` flush, only `network`/`server` re-enqueue (flat 5 s, no backoff/jitter); every other kind drops the whole batch with a `console.warn('flush failed (dropped)')`.
- **Suggested fix:** Propagate/log + mark-dirty on `server`/`unauthorized`; collapse the `fetchLatest` catch and re-throw non-`BackupError`; exponential backoff with jitter for mirror retries; treat `unauthorized`/`locked` as retry-later, not drop.

### M-17. Stale resume cursor survives "Forgot password → wipe" and re-setup → future restore silently skips rows

- **Severity:** Medium
- **Files:** `src/modules/messenger/backup/restoreResume.ts` (cleared only on completed walk at `restoreMessages.ts:486`), `BackupRestoreScreen.tsx:495-520` (handleForgot)
- **Component:** Resume-state lifetime
- **Description:** The cursor is keyed only by `userId` and cleared only on a completed walk. Interrupt a restore (cursor persisted) → "Forgot password — start fresh" wipes the server → user later sets up a **new** backup and restores → `readRestoreCursor` seeds the walk with the _old_ backup's tail cursor, and every new-backup row at-or-before that `(ts, id)` is skipped both server-side and by client dedup — silent loss with a "successful" restore.
- **Suggested fix:** Clear the cursor in `forget()`/wipe and on backup setup, or bind the cursor to a backup identity (hash of the identity-bundle salt) and discard on mismatch.

### M-18. `reinstallIdentity` is non-transactional — a mid-loop throw leaves a half-installed identity

- **Severity:** Medium
- **File:** `src/modules/messenger/backup/identityBackup.ts:173-192`
- **Component:** Restore identity install
- **Description:** Identity, then SPK, then a per-OPK `storePreKey` loop. A throw mid-loop leaves the CryptoStore half-written (identity installed, subset of OPK private halves missing) with no rollback; `restoreBackup` surfaces a generic error and `clearFails` never runs. Peers who used a missing OPK are permanently undecryptable; re-running restore is the only (undocumented) remedy.
- **Suggested fix:** Batch the writes in a single transaction if the store supports it, or make the function idempotent and auto-retry.

---

## Low Priority Issues

- **L-1 — `MAX_KDF_PARAMS_KEYS` dead; `envelope_meta`/`group_state`/`members` unbounded.** `apps/messenger-service/src/backup/dto/backup.dto.ts:27,48-54,90-91,150-151,171-172` — documented caps not applied; currently bounded only by the accidental 100 KB body limit (which H-10's fix removes). Close together with H-10.
- **L-2 — Log bug: always "preserving 0 mirrored rows".** `backup.service.ts:201` (`${0}` literal).
- **L-3 — `putIdentity` discards the existing-row read error.** `backup.service.ts:169-173` — a transient read failure silently classifies a rotation as "new setup," skipping the wipe.
- **L-4 — `recordFailedAttempt` maps any read error to 404 `no_backup`.** `backup.service.ts:310-312` — an outage is reported as "you have no backup."
- **L-5 — `isArchiveAvailable()` dead/stale.** `backup.service.ts:142-147` claims health/test callers; grep finds none.
- **L-6 — `GET /backup/conversations` unpaginated.** `backup.service.ts:739-780` — unbounded rows into one response; a problem once quotas (H-11) allow large accounts.
- **L-7 — Config/DTO drift.** `MAX_MESSAGES_PER_BATCH = 500` hardcoded in the DTO while `BACKUP_MAX_MESSAGE_BATCH` is configurable (`configuration.ts:219`) — raising the env var does nothing. `infra/env/messenger.env.example` documents no `BACKUP_*` vars, so containers silently run on defaults.
- **L-8 — Non-transient archive failures retried pointlessly.** `backup.service.ts:890-897` — an FK violation (recipient not in `users`) is classified transient and retried 12× before dead-lettering. Classify Postgres 23xxx as permanent.
- **L-9 — `putMerkleCommit` has no monotonic-seq guard.** `backup.service.ts:367-389` — unlike the snapshot, any JWT holder can overwrite the commit with an older legitimately-signed one. Add a one-line seq check (column exists).
- **L-10 — 1000-page cap treated as complete restore.** `restoreMessages.ts:311,483-486` — cap-exit clears the cursor and shows success over truncated history. Detect cap-exit, keep the cursor, surface "restore incomplete." Same class server-side on `commitMerkleRoot`'s 1000-page cap (signs a truncated root → guaranteed mismatch).
- **L-11 — Resume cursor persisted even when nothing durably written (non-SQLCipher path).** `restoreMessages.ts:447` vs `:464` — latent today (both screens pass the SQLCipher store) but a one-line trap for future callers.
- **L-12 — On resume, only the tail hydrates + counts cover only this run.** `restoreMessages.ts:288,428-430,551,563` — the success overlay says "Restored 1,200 messages" for a 60K account; cosmetic-but-alarming ("my backup is gone" tickets).
- **L-13 — `.buffer` misuse in the encrypt path.** `backupCrypto.ts:145,129,251,283` — `subtle.encrypt(plaintext.buffer)` is correct only when the view spans the whole buffer; a future subarray caller would encrypt adjacent bytes. Decrypt already defends with `.slice()`.
- **L-14 — Silent field defaulting on v3 deserialize.** `backupWireV3.ts:141-162` — missing payload fields default to `''`/`'text'`/`'sent'` with no validation/count. Count/skip rows with empty `conversation_id` and surface "N rows skipped."
- **L-15 — `deserializeMessageFromBackup` production-dead; restore re-implements the v3 fallback inline with drifted semantics; tests cover the unused helper.** `backupWireV3.ts:118-167` vs `restoreMessages.ts:371-376` — coverage illusion + drift risk. Make restore call the helper or delete it and move its tests.
- **L-16 — Dead code / duplication in crypto layer.** `backupCrypto.ts:310-318` (`platformLabel` no callers), `:245-302` (verifier helpers, C-1); `backupWireV3.ts:238-251` duplicate b64 helpers, inline `encryptGroupStateBlob`, magic `12`/`16`; `generateMasterKey`/`importMasterKey` import `extractable:true` unnecessarily.
- **L-17 — Raw master key not zeroized on two scheduler early returns.** `ratchetSnapshotScheduler.ts:213-219` — `no_store_iter`/`no_sessions` returns skip `masterKeyRaw.fill(0)`. Move to a `finally`.
- **L-18 — Ratchet-snapshot seq lacks the AsyncStorage-tamper HMAC the commit seq got (P1-N12).** `ratchetSnapshotScheduler.ts:108-127` — a plain decimal; lowering it lets a malicious server replay an older snapshot (roll ratchets back). Reuse the `tagSeq`/keychain pattern.
- **L-19 — `verify-backup-password.mjs` operational hygiene.** `scripts/verify-backup-password.mjs:28,34,79,98,132` — password + token via argv (shell history / process list), prints the first 4 bytes of the derived key despite claiming "no sensitive bytes," hardcoded relay URL. Read from stdin; drop the key-prefix print; take base URL from env.
- **L-20 — UI/UX polish set (all in `src/screens/messenger/`):** lockout countdown never ticks/expires (`BackupRestoreScreen.tsx:135-139`); double-submit window during the biometric prompt on setup (`BackupSetupScreen.tsx:193-205`); no back/gesture protection during Settings-unlock restore (`BackupSetupScreen.tsx`); raw error codes rendered as user text (both screens); accessibility gaps on all icon-only buttons + no live regions; no password-strength meter; three private hardcoded palettes drifting from the obsidian theme; dead inline-progress row masked by the overlay; heavy copy-paste duplication between the two screens (the proven cause of the H-13 divergence); type-unsafe `navigate('BackupSetup' as never)` and no backup-status subtitle in Settings.

---

## Performance Observations

- **Every Merkle commit re-downloads and re-hashes the entire backup.** `merkleCommit.ts:143-185` — the live path page-walks `/backup/messages` fetching **full ciphertext** for the whole account, then O(n) SHA-256 leaves + tree, fired 30 s after every flush burst. An actively-chatting user with a 50K history re-downloads tens of MB on mobile data every ~30 s; the server pays the egress. This is the dominant scaling hazard. Fix: maintain the `(message_id, msg_created_at, sha256(ciphertext))` triples locally at flush time and commit from those.
- **Restore feedback loop (M-11), whole-backup memory (M-12), and post-hydrate write storm (M-13)** compound: a large restore re-uploads everything, holds it all in RAM, and double-writes it to SQLCipher.
- **Mirror re-hashes every message on every store mutation.** `mirrorBootstrap.ts:136-163` — FNV over `JSON.stringify` per message on every Zustand change. Fine at 1K, measurable at 50K messages.
- **`sweepSealedArchive` issues one unbounded DELETE** (`backup.service.ts:1064-1089`) — fine now; batch past ~10⁶ rows/day.

## Code Quality Review

The code is generally well-structured with clear module boundaries, extensive doc comments, and disciplined key hygiene (fresh IVs, zeroization attempts, non-extractable imports, no secrets in logs). The chief quality problems are: (1) **documentation that describes unshipped behavior** (C-1 spec, C-3 "used by health endpoints," `sessionRatchetRecovery.ts` "we are NOT shipping option B" when B _is_ shipped) — actively misleading to maintainers; (2) **dead code** (verifier helpers, `platformLabel`, `deserializeMessageFromBackup`, `isArchiveAvailable`, `checkServerSeqAnchor`, duplicate b64 helpers); (3) **copy-paste duplication** between the two backup screens that has already produced behavioral drift (H-13); and (4) **misleading comments** — the `versionHash` collision comment (`messageMirror.ts:295-299`) inverts the failure mode (a collision drops the update silently, it doesn't cause a harmless re-mirror). No `TODO`/`FIXME` markers were found in the reviewed backup files, but several "open task" / "Phase-2" comments describe work that is either done or dead.

## Architecture Review

The core design is sound: opaque-ciphertext server stores, a two-layer key wrap, v3 metadata blinding, a signed Merkle commit as tamper evidence, a sealed-archive durability backstop with a retry outbox, and a ratchet-snapshot mechanism for the reinstall window. The authorization model (ownership always from the JWT subject) is correct and consistently applied. The architectural weakness is not the design but the **integration**: three of the headline mechanisms (server-enforced verify, ratchet-snapshot apply, Merkle omission-detection) are effectively inert in production, and the two restore entry points implement materially different flows (H-13). The system also lacks a coherent story for storage growth (no quota, no `messages_backup` retention) and for the restore↔mirror feedback loop.

## API Review

Endpoints are JWT-guarded with a global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` + `transform`) and typed DTOs — a solid baseline. Gaps: **no rate limiting** (H-9), **body limit below DTO caps** (H-10), **DTO validators weaker than DB constraints** (M-10, L-1), **string-interpolated PostgREST filters** (M-8), **no proof-gated overwrite** (M-2/C-1), and **an unpaginated conversations endpoint** (L-6). The missing `/identity/verify` route (C-1) means the API contract the client and spec expect does not exist.

## Database Review

Migrations are well-formed (`IF NOT EXISTS` guards, explicit RLS `REVOKE` on `anon`/`authenticated`, FKs with `ON DELETE CASCADE`, correct ascending composite indexes for the tuple cursor). The bytea `\x`-hex-literal workaround for the supabase-js Buffer-JSON pitfall is correct and documents a real production incident. **But schema and code have drifted:** the `verifier_key` column (C-1) and the `expires_at_sec` column + partial index (H-12) are populated/defined but never enforced by code. There is no retention on `messages_backup` and no per-user quota (H-11). The rotation-wipe logic (M-4) can destroy still-valid rows.

## UI/UX Review

The backup screens are functional and the password hygiene is genuinely good (never logged/persisted, autofill correctly disabled, per-field eye toggles, mismatch/too-short warnings). The `RestoreProgressOverlay` correctly uses an indeterminate bar + running count for an unknown-total stream (its "never reaches 100%" is by design, not a bug), and its animation lifecycle is leak-free. The problems are recovery and consistency: the setup screen bricks on probe failure (H-15), a stalled restore has no timeout and no escape (H-14), the header back button bypasses the data-loss trap, the lockout countdown is frozen, raw error codes are shown to users, and accessibility is largely absent. The two screens duplicate ~30-line blocks that have already diverged. See L-20 for the full list.

## Testing Review

**Server: effectively zero coverage** — the only spec doesn't compile (C-2) and CI doesn't run it. **Client crypto:** the primitives are well tested (KDF hardening, IV freshness, verify-proof math, v3 blinding round-trip) but the _wiring_ is not — `backupClient`, `httpSnapshotTransport`, and `identityBackup` have **no unit tests at all**, so every one of the production wiring bugs (C-3, H-1, H-13, M-15, M-16) is invisible to the suite. **Mirror/restore:** `messageMirror`'s queue mechanics, `mirrorBootstrap`'s diff loop, the `backupBoot` state machine, and `restoreAllMessages` itself are entirely untested — H-3, H-7, and H-2 would each be caught by a single test. `verifyMerkleCommit` is never tested against real curve signatures (every test mocks `verify()`). The ratchet-snapshot e2e injects the key + an in-memory transport, so it structurally cannot catch C-3/M-15. **A restore round-trip test against real wiring is the single highest-value test to add.**

## Production Readiness

**Not ready.** Blocking items: C-1 (unthrottled brute-force), C-2 (no server tests + no CI gate), C-3 (dead snapshot restore), H-1/H-2 (silent post-restore mirror death + no auto-resume), H-9/H-10/H-11 (no rate limit, body limit below caps, no quota), and H-12 (disappearing-message retention violation). The recurring theme — silent failures with no telemetry — means production incidents would be undiagnosable without first adding logging/metrics. Add structured telemetry (snapshot-apply skipped, mirror drop, restore incomplete, dead-letter growth) as part of the fix work.

---

## Recommended Improvements

1. **Implement the P0-1 verify protocol end-to-end** (server route + method, client call, `putIdentity` verifier upload) or explicitly delete the scaffolding — do not ship a half-present security control.
2. **Fix the owner-key mismatch (C-3)** and add a "snapshot-apply skipped" log so this class of bug can never again be invisible.
3. **Set `backup:enabled` on the fresh-install restore path (H-1)** and add boot-time auto-resume for a non-null restore cursor (H-2).
4. **Make the Merkle gate real:** verify before writing (H-6), refuse partial/omitted row sets (H-4/H-5), and unify the two restore paths (H-13).
5. **Harden the server write surface:** rate limits (H-9), body limit (H-10), per-user quota + retention (H-11), enforce `expires_at_sec` (H-12), atomic counters (M-5).
6. **Add real telemetry** for every silent-failure path, then a restore round-trip integration test against production wiring.
7. **Add AAD binding** to all GCM blobs (M-3) and bounds-check server-supplied KDF params (M-1).
8. **Delete dead code and fix misleading docs/comments** so the codebase stops advertising controls it doesn't have.

## Prioritized Action Plan

**Phase 1 — Ship blockers (must fix before any release):**
C-1 (verify protocol), C-2 (compile + run server tests in CI), C-3 (owner-key mismatch), H-1 (`backup:enabled`), H-2 (auto-resume), H-13 (unify restore paths), H-9/H-10 (rate limit + body limit).

**Phase 2 — Integrity & data-loss (fix before GA):**
H-3 (tombstones), H-4/H-5/H-6 (Merkle gate real), H-7 (overflow sweep), H-8 (group_state auth), H-11 (quota/retention), H-12 (expires enforcement), H-14/H-15 (restore/setup UX recovery), M-1/M-2/M-3/M-4/M-8/M-17.

**Phase 3 — Robustness, performance, quality:**
Remaining Medium items (M-5…M-16, M-18), the Merkle re-download perf fix, the restore feedback-loop/memory/write-storm trio, telemetry, and the full test-coverage build-out.

**Phase 4 — Polish:**
Low items, dead-code removal, doc/comment corrections, UI accessibility and design-system alignment, `verify-backup-password.mjs` hygiene.

---

## Final Verdict

**Do not ship in its current state.** The Messenger Backup feature has a genuinely strong cryptographic and architectural foundation — the primitives are correct, the authorization model is clean, and the design is thoughtful. But it is not what it appears to be: **its three headline protections (server-enforced verification, ratchet-snapshot recovery, and Merkle omission-detection) are inert in production**, its server has no working tests and no CI gate, and it carries several silent data-loss and data-integrity paths — every one of which fails with no log signal, which is precisely why they survived the prior audit rounds recorded in the repo.

The remediation is well-bounded and mostly wiring rather than redesign. Estimated **3–4 focused engineering weeks** to clear the Critical + High findings, gated by one non-negotiable addition: **an end-to-end test harness that exercises the real save/load/upload wiring** (not injected keys and in-memory transports), plus structured telemetry on every silent-failure path so the next regression is caught by a machine instead of a user reinstalling and finding their history gone.

_(Reviewed and found clean, for the record: AES-GCM primitive usage and IV freshness; Argon2id parameter hardening; the no-secrets-in-logs constraint across all reviewed files; the server authorization model; the tuple-cursor pagination design; the bytea encode/decode workaround; `backupMerkle.ts` tree construction; `applySessionSnapshotToStore`'s never-overwrite rule; `decideRestoredStatus`; `restoreResume.ts` parse hardening; the SQL PK-based import idempotency; and the backup-biometric-policy decision matrix. These are solid and should not be disturbed during remediation.)_

---

# Remediation Log (2026-07-03)

Every finding above was addressed. Below is the per-finding fix and how it was verified. Verification gates run after all changes: **messenger-crypto 1246/1246**, **messenger-service 177/177** (incl. **backup.service.spec 11/11** — previously non-compiling), **mobile tsc 46** (baseline 49, no new errors), **server tsc 0**, **lint clean** on all changed files.

## Critical

- **C-1 — P0-1 verify protocol implemented end-to-end.** Server: `getIdentityHeader` now issues a single-use Redis nonce + `verifierMissing`; new `verifyProof` validates `HMAC-SHA256(verifier_key, "bravo-backup-verify-v1:userId:nonce")` with `timingSafeEqual`, bumps `failed_attempts` server-side (410 on missing/replayed nonce _without_ counting, 423 at lockout, 409 legacy, 401 wrong proof), and mints a single-use, verifier-fingerprint-bound token; `getIdentityBundle` now requires that token (403 without). `putIdentity` requires `verifierKey`. Client: `identityBackup` derives the verifier key (`deriveMasterKeyAndRaw` → `deriveVerifierKey`), calls `/verify`, then `/bundle?verifyToken=…`; `backupClient` gained `verify()` + token-bearing bundle GET and drops `recordFail`/`clearFails`. `backup.controller` gained `POST identity/verify`; the `identity/fail`+`identity/clear` routes were removed (they'd have let an attacker reset their own lockout). _Files:_ `apps/messenger-service/src/backup/{backup.service,backup.controller}.ts`, `dto/backup.dto.ts`, `config/configuration.ts`, `src/modules/messenger/backup/{identityBackup,backupClient,backupCrypto}.ts`. _Verified:_ backup.service.spec 11/11.
- **C-2 — server spec compiles + CI gate added.** The spec now matches the implemented surface and passes 11/11; a `test` job was added to `.github/workflows/deploy-messenger.yml` gating `build-and-push` (`needs: test`) so a red/uncompilable suite blocks the image ship.
- **C-3 — ratchet-snapshot restore un-deadcoded.** `BackupRestoreScreen` now loads the mirror key under the canonical owner with a legacy fallback (`loadMirrorMasterKey(ownerKey ?? ownerUserId, ownerUserId)`) and keys the snapshot seq floor on the same owner the capture scheduler uses (`productionRuntime:1369`), plus a loud log on key-miss. _Verified:_ matches `mirrorKeyOwner` contract; typecheck.

## High

- **H-1** — fresh-install restore now sets `backup:enabled='1'` (+ clears `backup:skipped`) so the mirror auto-resumes on the next cold start.
- **H-2** — `restoreAllMessages` sets a durable `restore-incomplete` marker (cleared only on a fully-complete run); `backupBoot` re-enters the restore flow when it detects the marker (RESTORE-RESUME branch) instead of landing on a partial history.
- **H-3** — deleted messages now tombstone correctly: `store.removeMessage` captures the row _before_ the immer commit and calls `mirrorRemoval` _after_ it (new deduped tombstone path with real `conversation_id`/`created_at`), fixing the pre-commit read that silently re-mirrored the live row.
- **H-4** — `verifyMerkleCommit` returns a distinct `rows_count_mismatch` (hard-fail) when `rows.length !== commit.rowCount`, so an omitted/injected row set is never self-healed; only an equal-count byte-drift is eligible for the re-commit.
- **H-5** — a Merkle-verified restore always walks from row 0 (ignores the resume cursor) so `merkleRows` is complete and the self-heal can't run over a partial set.
- **H-6** — durable SQL writes are deferred until _after_ Merkle verification passes; a hard-fail throws before any `upsertBatch`, so a tampered set never lands on disk.
- **H-7** — the overflow drop and non-retryable drop now clear the dropped items' dedup keys, so the catch-up sweep can actually re-mirror them from SQLCipher.
- **H-8** — `decryptGroupStateBlob` refuses malformed/unauthenticated legacy plaintext (validates shape, warns) instead of silently returning a degenerate GroupState. _(Full substitution-resistance = M-3, deferred as a stop-condition.)_
- **H-9/H-10/H-11/H-12** — server: `UserThrottlerGuard` + per-route `@Throttle` on all `/backup/*`; body-parser raised to 20 MB; per-user row quota (`BACKUP_MAX_MESSAGE_ROWS_PER_USER`, 507 over cap); `expires_at_sec` now swept **and** filtered on read. _Verified:_ server suite 177/177.
- **H-13** — `BackupSetupScreen.handleUnlock` now performs the runtime rebuild and passes the identity keys to `restoreAllMessages` (so the S8 Merkle gate runs on this path too); the header back arrow routes through the same data-loss confirmation as the hardware back.
- **H-14** — `backupClient.callJson` wraps every request in a 30 s `AbortController` timeout; the progress overlay gained a delayed Cancel affordance (agent).
- **H-15** — the setup-screen probe was extracted into a retryable callback with a `probe_failed` mode + Retry button (and a legacy-`verifierMissing` → re-setup branch); no more infinite spinner.

## Medium

- **M-1** — `assertKdfParamsWithinBounds` clamps server-supplied KDF params (rejects 8 GiB / 0-iter / wrong-length) with a distinct error, not "wrong password". _Verified:_ `backupHardening.test.ts`.
- **M-2** — covered by C-1 (`putIdentity` requires the verifier key; overwrite is gated by the verify flow).
- **M-3 — DEFERRED (documented).** AAD binding is a CLAUDE.md architecture stop-condition and a breaking wire change; requires sign-off + a migration window. H-8 lands the compat-safe subset now.
- **M-4** — rotation in `putIdentity` also resets `backup_session_snapshots` + `backup_merkle_commits`; false-rotation history-wipe unchanged from the F6 same-key guard.
- **M-5** — atomic `bump_backup_failed_attempts` RPC (migration `20260703000000_…`) with a read-modify-write fallback.
- **M-6/M-7/M-8/M-9/M-10** — server: outbox byte-cap + dead-letter TTL; forget purges outbox + verify keys via a tombstone; `since` ISO-validated + quoted; `putConversations` deduped; `kind`/`msg_created_at` DTO validators.
- **M-11** — the mirror subscription now starts _after_ the restore (seeded from the restored store) so the whole history isn't re-uploaded.
- **M-12 — DEFERRED (documented).** The incremental-merkle-leaf + tail-hydrate redesign risks the commit/verify byte-contract; scoped as a follow-up. H-6's deferral added no memory.
- **M-13** — a `restoreWriteThrough` flag suppresses the runtime's per-row write-through during the restore's final hydrate (rows already written via `upsertBatch`).
- **M-14** — a shared static transaction mutex in `SqlMessageStore.upsertBatch` serializes transactions across the restore instance and the live coalesced-flush instance on the one connection.
- **M-15** — covered by C-3 (seq floor keyed consistently) + M-16 (transport propagates failures).
- **M-16** — `httpSnapshotTransport.upload` now propagates transient/auth failures (so the scheduler's post-success `writeSeq` doesn't drift the floor) and swallows only "backend not deployed"; `fetchLatest` re-throws non-`BackupError`.
- **M-17** — forget/wipe clears the resume cursor + incomplete marker (`clearRestoreState`) so a later restore can't skip rows.
- **M-18** — `reinstallIdentity` is transactional (BEGIN/COMMIT with rollback, signed-prekey-last sentinel).

## Low

- **L-1/L-2/L-3/L-4/L-5/L-6/L-7/L-8/L-9** — server: DTO object caps (`BoundedObjectConstraint`); fixed the "preserving 0 rows" log; `putIdentity` read-error no longer silently proceeds; no dangling `recordFailedAttempt`/`clearFailedAttempts`; `isArchiveAvailable` surfaced on `/ready`; `getConversations` paginated; DTO-vs-env batch-cap reconciled + `BACKUP_*` env docs (and the committed real Supabase URL replaced with a placeholder); FK/23xxx classified permanent; `putMerkleCommit` monotonic-seq guard.
- **L-10/L-11** — restore detects page-cap-exit (keeps cursor + `incomplete` flag); the resume cursor is persisted only on a durable write.
- **L-13** — `aesGcmEncrypt` slices subarray inputs to avoid encrypting adjacent bytes.
- **L-14/L-15** — v3-default handling tightened; both real restore paths walk from 0 so tail-only hydrate/counts no longer apply.
- **L-16** — removed dead `platformLabel`.
- **L-17** — scheduler zeros the raw master key on every exit (`finally`).
- **L-18** — snapshot rollback-floor seq is HMAC-tagged (degrades safely without keychain).
- **L-19** — `verify-backup-password.mjs` reads the password from stdin + token/URL from env, drops the derived-key-prefix print (agent).
- **L-20** — lockout countdown ticks + auto-expires; double-submit guards; raw error codes mapped to human copy (`backupErrorCopy` + `humanizeBackupError`); password-strength hint; accessibility labels/live-regions on eye toggles + errors; `handleSkip` no longer risks an unhandled rejection. **Left as-is (cosmetic, out of scope for a correctness pass):** the 3-file private-palette unification, full cross-screen style de-duplication, the `mirrorBootstrap` per-mutation re-hash perf, and the `MSG_BASE_URL` fail-fast (its silent fallback is an intentional release-build safety net per project history).

## New tests added

`src/modules/messenger/__tests__/backupHardening.test.ts` (KDF-bounds + error-copy). The server `backup.service.spec.ts` now compiles and passes (it previously described an unimplemented API).

## Deployment prerequisites (Risk Review)

These migrations are **created but NOT applied** (no shared-DB writes were made): `20260524000000_backup_verifier_key.sql` (the `verifier_key` column — **required** for the P0-1 flow) and `20260703000000_backup_verify_atomic_bump.sql` (the atomic-bump RPC; a fallback exists). Apply both to Supabase before/with the server deploy. Legacy `identity_backups` rows with `verifier_key IS NULL` will prompt a one-time client re-setup by design (the verifier key derives from the password, which the server never sees). The mobile app requires a rebuild to pick up the client verify flow; on-device verification of the full restore round-trip was **not** possible in this environment and remains the one outstanding gate before release.
