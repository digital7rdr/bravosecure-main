# Brutal Audit — Backup & Message Restoration

**Date:** 2026-05-23
**Scope reviewed:**

- `src/modules/messenger/backup/*` (13 files)
- `apps/messenger-service/src/backup/*`
- `src/screens/messenger/BackupSetupScreen.tsx`
- `src/screens/messenger/BackupRestoreScreen.tsx`
- `src/modules/messenger/runtime/keychain.ts`

**Compared against:** WhatsApp Encrypted Backup white paper, Signal SVR2, OWASP key-storage cheat sheet, NIST SP 800-63B, RFC 9106.

---

## Headline

The cryptographic core is genuinely solid — Argon2id, AES-256-GCM, per-row subkeys, Merkle-signed roots, sealed-envelope archive, ratchet snapshots, sealed-sender preserved end-to-end.

**But there are five gaps that an industry-standard review would flag as ship-blocking, plus a long tail of moderate gaps.** Most of them are _operational_ and _authentication-adjacent_, not crypto-primitive.

---

## P0 — Ship-blockers vs. industry standard

### P0-1. Brute-force throttle is **client-self-reported**, not server-enforced

**Files:** [backupClient.ts:128](src/modules/messenger/backup/backupClient.ts#L128), [identityBackup.ts:264](src/modules/messenger/backup/identityBackup.ts#L264), [backup.service.ts:300-325](apps/messenger-service/src/backup/backup.service.ts#L300-L325)

The flow on wrong password:

1. Client GETs `/backup/identity/bundle`, gets the wrapped bytes.
2. Client tries AES-GCM unwrap. On failure, **client voluntarily POSTs `/backup/identity/fail`**.
3. Server increments `failed_attempts`.

A malicious client (curl, modified APK, stolen JWT) simply **never calls `/fail`**, GETs the bundle infinitely, and runs Argon2 offline at whatever rate they want. The 5-attempt / 1-hour lockout the UI promises does not exist for an attacker who controls the client.

**WhatsApp/Signal SVR2 standard:** the server holds an HSM-protected secret that's part of the KDF; offline cracking is mathematically impossible without HSM access; the throttle is enforced inside the HSM, not by trust.

**Minimum fix without an HSM:** make the server enforce attempts via a _server-side_ verification challenge — client sends `HMAC(derived_key, server_nonce)` to a `/verify` endpoint; the server bumps the counter on every `/verify` failure regardless of client cooperation, and **never returns the wrapped bundle until `/verify` succeeds**. The comment at [backup.service.ts:222-228](apps/messenger-service/src/backup/backup.service.ts#L222) even acknowledges this design — but the code at [backup.service.ts:265](apps/messenger-service/src/backup/backup.service.ts#L265) abandons it and returns the bundle directly.

### P0-2. No server-side rate-limit on `/backup/identity/bundle` or `/backup/identity/fail`

No `@nestjs/throttler`, no per-IP limit, no per-account download budget. A stolen JWT can pull the (admittedly opaque) wrapped bundle thousands of times per second to feed offline attacks across distributed crackers. JWT alone is not a substitute for rate-limiting on a credential-derivation endpoint.

**Industry standard:** N requests/min per account, N requests/min per IP, exponential backoff. NestJS has `@nestjs/throttler` — apply at minimum to `/backup/identity/*`, `/backup/identity/fail`, `/backup/identity/sessions`.

### P0-3. Minimum password length is **6 characters**, no strength meter, no breached-password check

**File:** [BackupSetupScreen.tsx:60](src/screens/messenger/BackupSetupScreen.tsx#L60) — `MIN_PASSWORD = 6`.

Argon2id at 64 MiB / 3 iter is good. But a 6-char alphanumeric password has ~10¹⁰ space; even at 100 ms per guess (offline, GPU farm rented for Argon2id RFC 9106 second profile, realistic ~10 H/s/GPU), recovery is hours. The KDF cannot save a weak password.

**Industry standard (NIST SP 800-63B / OWASP 2024):** minimum 8 chars, no max < 64, check against [HIBP top-1M passwords](https://haveibeenpwned.com/Passwords) (or local bloom filter of top-100k), strength meter (zxcvbn). This is the difference between "WhatsApp parity" and "actually safe."

### P0-4. Master key cached in OS keychain bypasses the password entirely on the same device

**Files:** [keychain.ts:81](src/modules/messenger/runtime/keychain.ts#L81), [backupBoot.ts:165-178](src/modules/messenger/backup/backupBoot.ts#L165) — `saveMirrorMasterKey` / `loadMirrorMasterKey`.

After setup or restore, the _raw_ 32-byte master key is base64'd into `react-native-keychain` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Cold-start auto-resumes the mirror from this — no password ever required again on this device.

This is a deliberate UX choice (and the bootBoot comment explains the prior-state-was-worse trade), but the threat-model regression is real:

- An attacker with **physical device + unlock** (e.g. coerced fingerprint, shoulder-surfed PIN) gets full backup-master-key access without ever needing the backup password. With the password gate, even physical+unlocked still required the password.
- `react-native-keychain` defaults on Android use the **AndroidKeyStore RSA wrap of a raw value**, not StrongBox/TEE-native AES — extraction is possible on rooted devices. iOS Keychain is hardware-backed but readable when device is unlocked.
- The mirror master key is **the same key that unwraps message-mirror rows AND identity**. A keychain compromise = full plaintext history.

**Industry standard (WhatsApp 64-digit / Signal SVR2):** the master key is **never** cached at rest in a form that can be used without user proof. WhatsApp's "passkey backup" requires biometric every session. Signal's SVR2 requires PIN entry to derive the wrap key.

**Minimum fix:** require biometric (`react-native-keychain` `accessControl: BIOMETRY_CURRENT_SET`) before reading the cached master key, OR cache only an _intermediate_ key derived from the master key + a device-unique secret with shorter validity, OR drop the cache and prompt for the password on cold start. At least make it user-configurable.

### P0-5. No backup of group-recipient identity / sender keys, and group rekey on member-removal is not part of the snapshot

**File:** [messageMirror.ts:469-478](src/modules/messenger/backup/messageMirror.ts#L469) — `serializeGroupState` ships `{groupId, owner, members, masterKeyB64, epoch, name}`.

The group master key is stored. But:

- **`epoch` is a number in the snapshot** but is not bound to a _signed_ statement of group state at that epoch. A server replay of an older group_state row pre-removal could give a restored device a master key that has since been rotated, letting a removed-but-archived peer's old messages "still belong" cryptographically. WhatsApp / Signal Sender Keys handle this via signed epoch transitions; you don't.
- The snapshot doesn't include the per-member **chain index** the receiver needs to detect a skipped message in the group's chain.
- No verification that the restored `members` list matches the server's authoritative roster — a malicious server can serve a fork of the group state.

The Merkle commit covers only `messages_backup` rows, not `conversation_backups` (where `group_state` lives) — see [backupMerkle.ts:45-49](src/modules/messenger/backup/backupMerkle.ts#L45). That means the strongest integrity protection you have **deliberately excludes group membership**.

---

## P1 — Significant gaps

### P1-1. No AAD (Additional Authenticated Data) on backup rows

**File:** [messageMirror.ts:344-346](src/modules/messenger/backup/messageMirror.ts#L344) — AES-GCM ciphertext has no AAD binding `message_id`, `conversation_id`, `sender_id`, `msg_created_at`. A server that swaps the `envelope_meta.wrappedSubkey` between two of the same user's rows can cause the wrong subkey to decrypt the wrong row — both will fail GCM auth, but a sophisticated cross-graft attack on identical sizes could produce confusion.

**Fix:** Bind row metadata into AAD: `additionalData = sender_id || ":" || conversation_id || ":" || message_id || ":" || msg_created_at`.

### P1-2. Merkle commit does not cover conversations, sealed-archive, ratchet snapshots, or group state

**File:** [backupMerkle.ts:65-93](src/modules/messenger/backup/backupMerkle.ts#L65). Only the message rows are committed. A server that omits / reorders sealed-envelope archive rows, swaps group membership, or rolls back the ratchet-session snapshot is not detected.

**Fix:** Extend the signed commit to a top-level root over `{messages_root, conversations_root, sealed_archive_root, sessions_seq}` so the entire backup snapshot is integrity-bound.

### P1-3. Fresh-device restore cannot detect server rollback

**File:** [merkleCommit.ts:196-203](src/modules/messenger/backup/merkleCommit.ts#L196) — rollback detection uses a _locally cached `seq`_ in AsyncStorage. The comment correctly notes "fresh-device restore can't catch a replay." That means a malicious server can serve a stale (legitimately-signed) commit on a new device and the client has no way to know.

**Industry mitigations:**

- Include a **trusted timestamp** in the signed commit (Roughtime, signed timestamps from N independent servers, or even just `Date.now()` from the user's auth service signed with the auth service's static key checked against the device clock with a tolerance). Reject commits older than X days.
- Surface the _commit age_ to the user on restore: "Last backup: 2 days ago — continue?" — gives them a chance to detect "but I sent messages yesterday."

Currently `sentAtMs` is in the digest but **nothing checks it** at restore.

### P1-4. `backupClient` uses AsyncStorage for the access token

**File:** [backupClient.ts:28](src/modules/messenger/backup/backupClient.ts#L28) — `await AsyncStorage.getItem('auth:access_token')`.

AsyncStorage on Android is plaintext SharedPreferences — readable from any process with the same UID, recoverable from any backup that includes app data, recoverable from rooted devices. The JWT is the **only** server-side gate on `/backup/identity/bundle`; if you're already moving secrets to react-native-keychain elsewhere, the auth token needs to be there too (or use the existing `EncryptedSharedPreferences` shim).

### P1-5. No per-user storage quota or write rate-limit on `/backup/messages`

**File:** [backup.service.ts:600](apps/messenger-service/src/backup/backup.service.ts#L600). A compromised client (or a misbehaving one) can write unbounded ciphertext. Combined with no `sweepMessagesBackup` (only `sweepSealedArchive` exists), `messages_backup` grows forever.

WhatsApp caps at a per-account hard ceiling (~250 GB) and enforces a server-side cap. You have batch-size limits but no rolling quota.

### P1-6. Sealed-envelope archive retention is `90d` hard-coded — and isn't bound to the user's local "disappearing message" timer

**File:** [backup.service.ts:897](apps/messenger-service/src/backup/backup.service.ts#L897). If a user sends a 7-day disappearing message, the relay's opaque copy still lives in `sealed_envelope_archive` for 90 days, recoverable by anyone who steals the user's password. The disappearing-message contract leaks via the archive.

**Fix options:**

- (a) encrypt the archive row with a fresh per-envelope key the recipient also holds locally, so once locally deleted, the archive is undecryptable; or
- (b) propagate disappearing-message TTLs server-side so archive sweeps respect them.

### P1-7. No verification step between backup setup and the first remote crypto write

**File:** [identityBackup.ts:206-243](src/modules/messenger/backup/identityBackup.ts#L206) — `setupBackup()` generates a master key, wraps + uploads, returns. There's no "test restore" or "write canary row + read it back" before declaring success. If the upload succeeds but the row is silently corrupted (PostgREST bytea/JSON confusion you already hit once at [backup.service.ts:927-944](apps/messenger-service/src/backup/backup.service.ts#L927)), the user thinks they're protected but their next restore returns garbage.

**Fix:** Run a self-test: after `putIdentity`, immediately call `getIdentityBundle` + verify unwrap round-trips. Reject setup if it doesn't.

### P1-8. Ratchet-snapshot upload has no automatic cadence

**File:** [ratchetSnapshot.ts:26-27](src/modules/messenger/backup/ratchetSnapshot.ts#L26) — comment says "the cadence is wired by the runtime." Grepping the runtime: there's no caller of `setSnapshotTransport` or anything that uploads on a schedule. The snapshot infrastructure is built and tested but never **scheduled**. On a reinstall the user gets back zero ratchets, the recovery comments admit messages will fail with `DoCipher status 2`, and the existing comment in [BackupRestoreScreen.tsx:273-275](src/screens/messenger/BackupRestoreScreen.tsx#L273) blames "your reinstall window."

**Fix:** Wire the snapshot upload into the mirror flush hook (or every `BACKUP_INTERVAL_MS = 60_000`).

### P1-9. Argon2 parameters not version-rotatable

**File:** [backupCrypto.ts:54-61](src/modules/messenger/backup/backupCrypto.ts#L54) — `DEFAULT_KDF_PARAMS` is fixed. When OWASP raises the recommendation (likely from 64 MiB → 128 MiB / 4 iter in ~2027), existing backups become weaker and there's no rotation path. The server stores `kdf_params` per row, so the read path is fine, but `refreshIdentityBackup` reuses the original `liveKdfParams` ([identityBackup.ts:330](src/modules/messenger/backup/identityBackup.ts#L330)) so the params never upgrade.

**Fix:** Add a "rewrap on next unlock if params < current minimum" flow.

### P1-10. Identity restore overwrites the just-installed identity, but the OPK private halves are not retired

**File:** [identityBackup.ts:184-191](src/modules/messenger/backup/identityBackup.ts#L184) — `reinstallIdentity` calls `storePreKey` for every recovered OPK, but the fresh runtime already installed a _new_ set of OPKs at step 1 of `handleRestore` ([BackupRestoreScreen.tsx:148-156](src/screens/messenger/BackupRestoreScreen.tsx#L148)). Both sets sit in SQLCipher; the restored bundle is then re-published. If any peer used a NEW (fresh-runtime) OPK before the publish, that session's OPK private is still in the store — but the bundle publish moved on to advertise the restored set. The cleanup path is unclear.

**Fix:** Audit `reinstallIdentity` to truncate-then-write the OPK table, not upsert.

---

## P2 — Operational / UX gaps

### P2-1. No multi-device support / linked devices

Single-device, password-only. WhatsApp / Signal support QR-pair linked devices. Restoration is by password only — no out-of-band channel.

### P2-2. No recovery phrase / mnemonic

Password loss = data loss with zero recovery. Signal/WhatsApp use 64-digit recovery codes or 12-word phrases as a backup-of-backup. You don't.

### P2-3. No cloud-native backup target (iCloud / Google Drive)

All backups live in Supabase. If your Supabase project is permanently lost, every user's backup is gone. Industry standard: optional iCloud / Google Drive as an extra durability layer (the user already trusts these vendors for OS-level device backups).

### P2-4. No backup encryption-key escrow / corporate recovery

For an app named "Bravo Secure" with what looks like operational/agent use cases (per `CLAUDE.md` mentions of ops-console, missions, agents), there's no provision for organization-controlled key escrow. Signal-grade end-to-end is right for B2C but may be wrong for B2B compliance.

### P2-5. No backup health / "last successful upload" indicator in UI

The user can't tell whether the mirror is currently caught up. There's an internal `surfaceBackupBehind()` flag ([messageMirror.ts:487](src/modules/messenger/backup/messageMirror.ts#L487)) but it surfaces as an error string — not a settings-screen "Backed up: just now" indicator. WhatsApp shows exact last-backup timestamp and size; you don't.

### P2-6. No SQLCipher database export

There's no "export my chats" feature (encrypted file with a fresh password). Users wanting an air-gapped backup or migrating off Bravo have no path.

### P2-7. `disposeMirror` does not clear the keychain master-key cache

[messageMirror.ts:179-192](src/modules/messenger/backup/messageMirror.ts#L179) — disposes in-memory state but does not call `clearMirrorMasterKey`. On logout, the next user (or the same user re-logging in) inherits the keychain entry until [keychain.ts:96](src/modules/messenger/runtime/keychain.ts#L96) is explicitly invoked. Verify `signOut` calls it; the audit trail in the comments doesn't make this clear.

### P2-8. `liveKdfParams` round-trip is `as unknown as KdfParams` cast

[identityBackup.ts:255](src/modules/messenger/backup/identityBackup.ts#L255) — accepts whatever the server returns with no schema validation. A malicious server can ship `{algo: 'argon2id', memoryKib: 8, iterations: 1}` and the next restore happily uses the weakened params. Validate min thresholds: `memoryKib >= 32*1024 && iterations >= 2`.

### P2-9. No audit log of backup operations

No record of which device, which IP, set up / restored / forgot the backup. A user whose account was compromised has no way to see "your backup was downloaded from IP X at time Y."

---

## What's good (so a fix order is realistic)

- Argon2id, AES-256-GCM, IV-prefix format are correct.
- Two-layer wrap (password → master → bundle) lets password rotation be cheap.
- Per-row subkey wrapping ([messageMirror.ts:340-365](src/modules/messenger/backup/messageMirror.ts#L340)) is better than WhatsApp's old single-key model.
- Atomic restore with tuple cursors ([restoreMessages.ts:188-322](src/modules/messenger/backup/restoreMessages.ts#L188)) — solid engineering.
- Same-key F6 guard preventing accidental data wipe on re-setup ([backup.service.ts:166-199](apps/messenger-service/src/backup/backup.service.ts#L166)).
- Sealed-envelope archive closes the reinstall-window gap honestly (best-in-class — Signal doesn't even do this).
- Merkle signed commit is rare and well-implemented for the message subset.
- Catch-up sweep on `setMirrorKey` is the right idempotency hook.

---

## Suggested fix order (effort vs. risk)

| #   | Fix                                                                                      | Effort        | Closes                                      |
| --- | ---------------------------------------------------------------------------------------- | ------------- | ------------------------------------------- |
| 1   | **P0-1, P0-2** — server-enforced `/verify` + `@nestjs/throttler` on `/backup/identity/*` | 1-2 days      | Offline-cracking door                       |
| 2   | **P0-3** — password policy + zxcvbn + HIBP bloom filter                                  | 1 day         | Weak-password vector                        |
| 3   | **P0-4** — biometric gate on keychain master-key cache, or prompt-on-cold-start opt-in   | 1 day         | Physical-device compromise                  |
| 4   | **P1-1, P1-2** — AAD on rows, Merkle covers everything                                   | 2-3 days      | Server tampering surface                    |
| 5   | **P1-8** — wire ratchet snapshot upload cadence                                          | 0.5 day       | Reinstall-window message loss               |
| 6   | **P1-3** — timestamp-bound commits + restore-time freshness check                        | 1 day         | Fresh-device rollback attack                |
| 7   | **P0-5, P1-7, P1-9**                                                                     | 2-3 days each | Group integrity, setup canary, KDF rotation |
| 8   | P2 items                                                                                 | Backlog       | UX / operational maturity                   |

---

## Summary by severity

- **P0 (ship-blockers):** 5 issues — server-trust-but-don't-verify throttle, no rate limiting, weak password policy, keychain master-key bypass, group state not signed.
- **P1 (significant):** 10 issues — missing AAD, partial Merkle coverage, no fresh-device rollback detection, plaintext JWT storage, no quota, archive vs. disappearing-message mismatch, no setup canary, missing ratchet snapshot cadence, KDF non-rotatable, OPK reinstall race.
- **P2 (operational/UX):** 9 issues — no multi-device, no recovery phrase, no cloud-native target, no escrow, no health indicator, no DB export, dispose doesn't clear keychain, no KDF param validation, no audit log.

**Crypto primitives:** correct. **Authentication & operational hardening:** below industry standard for a "Secure" branded product.
