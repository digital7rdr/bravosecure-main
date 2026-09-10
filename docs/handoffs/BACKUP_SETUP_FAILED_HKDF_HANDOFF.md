# Backup "Setup failed. Please try again." — Root Cause & Fix Handoff

|              |                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Date**     | 2026-07-04                                                                                                                                                                                                                                                                                                                                                                                   |
| **Build**    | v1.0.92 (vc118) / v1.0.93 (vc119) — any build containing the P0-1 backup remediation (`4025d6c`, 2026-07-03)                                                                                                                                                                                                                                                                                 |
| **Screen**   | Settings → Chat Backup (`BackupSetupScreen`, SETUP mode) — red inline error **"Setup failed. Please try again."** after tapping **ENABLE BACKUP**                                                                                                                                                                                                                                            |
| **Severity** | **CRITICAL** — the entire encrypted-backup feature (setup **and** restore) is inoperative on every physical device running v1.0.92+                                                                                                                                                                                                                                                          |
| **Status**   | Round 1 ✅ fixed (v1.0.94, HKDF → `@noble`, §1–§8). Round 2 ✅ fixed (v1.0.95, verify-proof HMAC, §9). Round 3 ✅ **FIXED 2026-07-05, shipped v1.0.97 (vc123)** — `rows_count_grew` self-heal + background commit + setup drain + 5 s debounce, per the §10 spec (all four changes + tests); gates green (crypto 1355/1355, full 1664, tsc 46 ≤ 49, lint 0). PENDING device QA (§11 step 6). |
| **Bug id**   | B-45 (logged in `sqa.md`; B-44's tester remedy was hard-blocked by this bug until now)                                                                                                                                                                                                                                                                                                       |

---

## 1. Plain-English summary

Enabling chat backup needs four cryptographic tools: **argon2** (turn the password into a key), **AES-GCM** (lock the backup with that key), **HMAC** (prove things), and — new since 2026-07-03 — **HKDF** (derive a special "verifier key" the server uses to check your password without ever seeing it).

The phone's crypto toolbox is a library called `react-native-quick-crypto`. Think of it as a toolbox that was shipped **with some drawers glued shut**: the HKDF drawer literally exists in the code but is **commented out** by the library authors. Our app already knew about two other glued drawers (HMAC signing and SHA hashing) and worked around them years-of-commits ago — but the brand-new backup code reached for the HKDF drawer, which nobody had ever opened before. The drawer doesn't open, the code throws an error one step after the password is derived, and the screen collapses every possible error into the generic copy **"Setup failed. Please try again."**

Nothing is wrong with the server, the database, the migrations, or the user's password. The request **never leaves the phone**.

The fix is one small function: derive the verifier key with `@noble/hashes` (a pure-JS crypto library the app already uses for exactly this kind of workaround) instead of the glued-shut drawer.

---

## 2. Symptom

- User opens **Settings → Chat Backup**, enters a password twice (strength "Good"), taps **ENABLE BACKUP**.
- After ~2–3 seconds (the argon2 derive), the red error **"Setup failed. Please try again."** appears.
- Retrying never helps. Affects **every device** on v1.0.92/93, both fresh accounts and the B-44 legacy-row re-setup path.

The generic copy comes from the error funnel:

- `src/screens/messenger/BackupSetupScreen.tsx:237-239` — `handleEnable`'s catch does `setErr('setup_failed: ' + e.message)`.
- `src/modules/messenger/backup/backupErrorCopy.ts:20,28-29` — `humanizeBackupError` maps anything with the `setup_failed` prefix to the one generic sentence. **Every distinct failure in the setup path renders identically in the UI**; the real reason only exists in logcat.

### Expected logcat signature (to confirm on-device)

```
adb logcat | grep "bravo.backup.setup"
# expected:
[bravo.backup.setup] setup failed: "subtle.importKey()" is not implemented for HKDF
```

(If the import were somehow served, the follow-up would be `'subtle.deriveBits()' for HKDF is not implemented.` — same root cause.)

---

## 3. Root cause

`setupBackup()` calls `deriveVerifierKey()`, which uses **WebCrypto HKDF** — an algorithm the on-device WebCrypto polyfill (`react-native-quick-crypto@0.7.17`) **does not implement**. The call throws, the setup aborts client-side, and no request ever reaches the server.

### Exact failure chain

1. `BackupSetupScreen.handleEnable` → `setupBackup(store, pwd, ownerUserId)` — `src/screens/messenger/BackupSetupScreen.tsx:192`
2. `setupBackup` derives the password key via argon2 (works — native module, in use since June), then:
   `src/modules/messenger/backup/identityBackup.ts:258` → `deriveVerifierKey(derivedRaw)`
3. `deriveVerifierKey` — `src/modules/messenger/backup/backupCrypto.ts:344-367`:
   ```ts
   const ikm = await subtle.importKey('raw', derivedKey.buffer, 'HKDF', false, ['deriveBits']);   // ← THROWS HERE
   const bits = await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', ...}, ikm, 256);
   ```
4. On device, `globalThis.crypto.subtle` is **react-native-quick-crypto 0.7.17** (installed by `src/modules/messenger/crypto/polyfills.ts:60`). In its source, HKDF is **commented out** in both relevant switches:
   - `node_modules/react-native-quick-crypto/lib/commonjs/subtle.js:426-427` — `importKey`: `// case 'HKDF':` → falls to `default:` → **`throw new Error('"subtle.importKey()" is not implemented for HKDF')`** (line 432).
   - `node_modules/react-native-quick-crypto/lib/commonjs/subtle.js:313-315,319` — `deriveBits`: `// case 'HKDF':` → **`'subtle.deriveBits()' for HKDF is not implemented.`**
   - (`Algorithms.js:53,65` _does_ list HKDF as a recognized name, so normalization passes and the throw comes from the switch — the error message above is exact.)
5. The app's polyfill layer (`src/modules/messenger/crypto/polyfills.ts`) already shims two other known holes in quick-crypto 0.7.17 — HMAC `subtle.sign/verify` (lines 62-148) and SHA `subtle.digest` (lines 150-221) — but has **no HKDF shim**. This bug is the third instance of the identical failure class.

### Why this is new in v1.0.92

The P0-1 backup remediation (`4025d6c`, 2026-07-03, `docs/audits/MESSENGER_BACKUP_AUDIT.md` C-1) introduced the verifier-key protocol. `deriveVerifierKey` is **the first and only code in the mobile app that uses HKDF through WebCrypto**:

- libsignal does HKDF manually via `subtle.sign(HMAC)` (which is shimmed — see the comment at `polyfills.ts:63-67`).
- Media HMAC keys use pure-JS `@noble/hashes` `hkdf()` — `src/modules/messenger/media/aesCbc.ts:41-43,155` (proven working on-device by the v1.0.91 media builds).
- Sealed-sender does a manual single-block HKDF via HMAC — `src/modules/messenger/crypto/outerEcies.ts:387-398`.

The old (pre-P0-1) setup path was argon2 + AES-GCM + fetch only — that's why the 5 legacy `identity_backups` rows on staging (created in June) exist at all. P0-1 added exactly one new primitive to the setup path, and that primitive is the broken one.

---

## 4. Evidence

1. **Server never saw the request.** `docker logs bravo-staging-msgr --since 36h | grep -iE 'putIdentity|BackupService'` on Contabo (94.136.184.52) shows only `backup.init-ok`, `backup.archive probe-ok`, and the archive sweep — **zero `putIdentity` lines**. For a user with an existing row (every B-44 tester), `BackupService.putIdentity` logs on _every_ invocation — success or failure (`apps/messenger-service/src/backup/backup.service.ts:277` "rotating master key" / `:306` "re-setup with same master key" / `:266,324` errors). Therefore the handler never ran → the failure is client-side, before the network.
2. **Server/DB/migrations are healthy** — independently verified in B-44 (2026-07-04, `sqa.md`): container rebuilt with the P0-1 code, both migrations applied, Supabase reachable (`backup.init-ok host=qkkfkicgoncxslbwhyhz.supabase.co`).
3. **The probe on the same screen succeeded seconds earlier.** The screen reached SETUP mode via `GET /backup/identity/header` (`BackupSetupScreen.tsx:118-150`), so auth token, `MSG_BASE_URL`, TLS, and connectivity were all fine. Only the POST path — the one that runs `deriveVerifierKey` first — dies.
4. **Library source** confirms HKDF commented out (quick-crypto 0.7.17, paths above), and `polyfills.ts` confirms no HKDF shim.
5. **Why every gate stayed green:** under Jest, `react-native-quick-crypto` is mocked (`src/modules/messenger/__tests__/__mocks__/react-native-quick-crypto.ts`, mapped in `package.json:199-200`) and `globalThis.crypto.subtle` is **Node ≥18's real WebCrypto, which fully implements HKDF**. `backupVerifyProof.test.ts`, `backupHardening.test.ts`, and the 1246-test crypto suite all pass in an environment where the bug cannot reproduce. Same story as the previous two shims ("worked in Jest, threw on Hermes").

---

## 5. Blast radius

| Surface                                                                  | Impact                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backup setup** (`setupBackup`)                                         | Dead on all devices — the screenshot bug.                                                                                                                                                                                                                                                                                 |
| **Backup unlock/restore** (`restoreBackup`, `identityBackup.ts:327-329`) | Also dead for any post-P0-1 backup: the same `deriveVerifierKey` runs before `/verify`. (On staging today it fails earlier with `verifier_missing` because all rows are legacy — B-44 — which masked this.)                                                                                                               |
| **B-44 tester remedy**                                                   | Hard-blocked. The documented remedy ("re-setup via Settings → Chat Backup") cannot succeed until this is fixed, and the "wipe + start fresh" path dead-ends the same way at the re-setup step.                                                                                                                            |
| **`refreshIdentityBackup`** (OPK-refill re-upload)                       | Moot — it reuses a pinned verifier key, but only runs after a successful setup/restore.                                                                                                                                                                                                                                   |
| **`computeVerifyProof`** (HMAC)                                          | **Not** affected — HMAC import/sign is shimmed (`polyfills.ts:98-132`); once HKDF is fixed the rest of the verify flow should work.                                                                                                                                                                                       |
| **Message mirror**                                                       | Never enabled (no `setMirrorKey`), so no history is being backed up from v1.0.92+ devices at all.                                                                                                                                                                                                                         |
| ⚠️ **Flag to verify separately**                                         | `packages/messenger-core/src/calls/sframe.ts:167-169` also uses `subtle.importKey('HKDF') + deriveBits`. Group calls demonstrably work on device (native FrameCryptor path), which suggests this JS path doesn't run on mobile — but confirm before assuming, since it would throw identically if ever reached on Hermes. |

Data-safety note: no data was corrupted or lost. The failure happens before any server write; existing legacy rows are untouched. Hygiene nit: because the throw happens at `identityBackup.ts:258`, the `derivedRaw.fill(0)` / `verifierKey.fill(0)` on lines 260-261 never run — the derived key stays un-zeroed in memory on the failure path (fix along the way with a `try/finally`).

---

## 6. How to fix

### Option A (recommended): derive the verifier key with `@noble/hashes`

Replace the WebCrypto-HKDF body of `deriveVerifierKey` in `src/modules/messenger/backup/backupCrypto.ts:344-367` with the pure-JS HKDF the app already ships and already trusts (`aesCbc.ts` uses it for media HMAC keys; `@noble/hashes` is audited and runs identically on Hermes and Node):

```ts
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';

export async function deriveVerifierKey(derivedKey: Uint8Array): Promise<Uint8Array> {
  if (derivedKey.length !== KEY_BYTES) {
    throw new Error(`verifier_key_wrong_length:${derivedKey.length}`);
  }
  // RFC 5869 HKDF-SHA256, empty salt, info='bravo-backup-verifier-v1', L=32.
  // Pure JS (@noble) — quick-crypto 0.7.17 has no subtle HKDF (see polyfills.ts).
  return hkdf(
    sha256,
    derivedKey,
    undefined,
    new TextEncoder().encode(VERIFIER_HKDF_INFO),
    KEY_BYTES,
  );
}
```

**Byte-compatibility notes (this is a locked crypto contract — see CLAUDE.md stop conditions):**

- The output must be byte-for-byte identical to WebCrypto's `HKDF-SHA256, salt=empty, info='bravo-backup-verifier-v1', L=32`. It is: RFC 5869 defines empty salt as HashLen zero bytes, and `@noble/hashes` `hkdf(sha256, ikm, undefined, info, 32)` implements exactly that. **Prove it in a test** (see §7) rather than asserting it.
- No server change, no migration, no wire change: the derivation runs client-side only; the server just stores the 32 bytes and HMAC-verifies proofs against them (`backup.service.ts`, domain tag `bravo-backup-verify-v1`).
- There are **no production verifier rows yet** (all 5 staging rows are legacy `NULL` — B-44), so even a hypothetical drift would strand nothing. But don't rely on that; pin the vector.
- While in the function, wrap the caller's derive in `try/finally` so `derivedRaw.fill(0)` runs on the failure path too (`identityBackup.ts:255-261`).

### Option B (defensive, optional add-on): shim HKDF in `polyfills.ts`

Follow the existing HMAC-shim pattern (`polyfills.ts:79-148`): intercept `subtle.importKey(format='raw', alg='HKDF')` (stash raw bytes in a WeakMap; quick-crypto throws before returning a key, so the shim must short-circuit rather than call through), and route `subtle.deriveBits({name:'HKDF'})` to `@noble/hashes` `hkdf()`. This future-proofs any other module (e.g. `sframe.ts`) that reaches for subtle HKDF on Hermes. Option A alone fixes the bug; Option B alone would too. A is smaller and keeps the backup module self-contained; do A now, consider B as hardening.

### Not recommended

Upgrading `react-native-quick-crypto` to 1.x for its fuller subtle implementation — far bigger risk surface (it underpins libsignal, SQLCipher hashing, media crypto) for a one-function bug. Don't couple that migration to this fix.

---

## 7. Verification checklist (Change-safety gates)

1. **Direct test (write it first, watch it fail):** in `src/modules/messenger/__tests__/backupVerifyProof.test.ts`, add a cross-implementation vector test — `deriveVerifierKey(ikm)` must equal Node WebCrypto's `subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt: new ArrayBuffer(0), info: 'bravo-backup-verifier-v1'}, key, 256)` for a fixed ikm, plus one RFC 5869 test vector. This pins byte-compatibility with the pre-fix contract forever. (The existing determinism/info-binding tests at `:78-93` must stay green.)
2. **Regression suite:** `npm run test:crypto` (this is a sealed/backup-crypto change → crypto project is the mandated regression gate), then `npm test`.
3. **Typecheck:** `npm run typecheck` (≤ baseline 96) — no ops-console impact expected.
4. **On-device (the gate that actually catches this class):** rebuild the staging APK, then on a physical device:
   - Settings → Chat Backup → set password → **ENABLE BACKUP** → expect the "Backup enabled" alert with message/conversation counts (not "Setup failed").
   - Confirm the server saw it: `docker logs bravo-staging-msgr | grep putIdentity` → a `rotating master key` or `re-setup with same master key` line; Supabase `identity_backups` row for the account has `verifier_key` **non-null** and `updated_at` = today.
   - Kill + relaunch → Settings → Chat Backup → UNLOCK mode → correct password unlocks + restores; wrong password fails with **"Wrong password"** (not `verifier_missing`, not "Setup failed") and bumps `failed_attempts`.
   - This simultaneously closes B-44's pending retest.
5. **Log-audit:** the fix touches key-material code — do not log `derivedKey`/verifier bytes; `npm run test:crypto` includes the logAudit test.

## 8. Hardening follow-ups (separate, small)

- **Boot-time HKDF self-test** next to the SHA-256 self-test (`polyfills.ts:234-253`): derive a known HKDF vector at startup and set `__bravo_crypto_self_test_failed__` on mismatch/throw. This class of bug (Jest-green, Hermes-dead) has now shipped three times; a 5-line canary catches the whole class at boot instead of in a user flow.
- **Keep the raw error code reachable in QA builds:** `humanizeBackupError` correctly hides internals from users, but consider appending the raw code in `__DEV__`/staging builds (e.g. small grey `code: setup_failed: "subtle.importKey()"…` under the error) — this bug took server-log forensics to diagnose because the UI erased the only distinguishing signal.
- **Verify `sframe.ts`** (`packages/messenger-core/src/calls/sframe.ts:167`) is truly unreachable on Hermes, or fix it the same way.

---

## 9. Round 2 (2026-07-04, post-v1.0.94 retest) — "Restore failed: Exception in HostFunction: Invalid Hash Algorithm!"

### Plain-English summary

The round-1 fix worked: **backup setup now succeeds** (the screenshot proves it — a backup exists to restore, and the flow got all the way to the restore step, which was impossible before). But un-blocking the road exposed the **next pothole a few meters further**: the restore step uses a second crypto tool — **HMAC**, the "prove you know the password" stamp — and that call tripped over a different hole in the _same_ broken toolbox.

Same toolbox analogy: the HMAC drawer isn't glued shut — the app's workaround (the "shim" in `polyfills.ts`) opens it fine. But the workaround has a reading bug: when the code asks for HMAC using the **short spelling** (`'HMAC'` as a plain string — perfectly legal), the workaround looks for the hash name inside the string, finds nothing, and asks the native library for a hash called **"" (empty string)**. The native library answers with exactly the error on the screen: **"Invalid Hash Algorithm!"**. When the code asks using the **long spelling** (`{name:'HMAC', hash:'SHA-256'}` — the form libsignal uses on every message), it works — which is why messaging never showed this and why the bug hid until the brand-new P0-1 restore code, the app's only short-spelling caller, first executed on a device.

Why round 1 didn't catch it: §5 claimed HMAC was safe _"because the shim handles it"_ — true for the long form, wrong for the short form. And Jest can't see it for the same reason as round 1: Node's real WebCrypto accepts the short form (the hash is remembered from key-import), and `polyfills.ts` never loads under Jest.

### Exact failure chain

1. Setup (fixed in round 1) succeeds → server row now has a verifier key.
2. Unlock/restore → `restoreBackup` → `computeVerifyProof` — `src/modules/messenger/backup/backupCrypto.ts:391` (pre-fix): `subtle.sign('HMAC', key, msg)` — **string-form algorithm**.
3. Polyfill HMAC shim (`polyfills.ts`) intercepts: `hashName('HMAC')` → `typeof alg === 'string'` branch sets the hash source to `''`, and because `''` **is** a string, the `?? 'SHA-256'` fallback never fires → returns `''`.
4. `createHmac('', keyBytes)` → quick-crypto native `EVP_get_digestbyname('')` → null → throws **"Invalid Hash Algorithm!"** → RN surfaces it as `Exception in HostFunction: …` → the restore overlay renders `Restore failed: <message>`.

### The fix (implemented 2026-07-04, shipped v1.0.95 / vc121)

1. **`computeVerifyProof` → `@noble/hashes` `hmac(sha256, verifierKey, msg)`** (`backupCrypto.ts`) — same pure-JS route as round 1 and the same one `merkleCommit.ts` / `ratchetSnapshotScheduler.ts` already use. Byte-identical HMAC-SHA256; the existing "client proof matches server HMAC byte-for-byte" test in `backupVerifyProof.test.ts` pins the contract against Node's `createHmac`. The backup password path now touches **zero** `subtle` hash/HMAC/HKDF calls: argon2 (native, proven) + `@noble` HKDF + `@noble` HMAC + AES-GCM via subtle (exercised daily by messaging).
2. **Polyfill hardening** (`polyfills.ts`): the shim now records the hash bound at `importKey` time in a WeakMap (`hmacKeyHashName`) and string-form `sign`/`verify` resolve `hashName(alg) || imported-hash || 'sha256'` — the WebCrypto-correct behavior. No future string-form caller can reach `createHmac('')` again. Object-form (libsignal) behavior unchanged.

### Sweep result — no third landmine found

Audited every crypto primitive the setup/restore/mirror paths touch: Merkle hashing = `@noble` `sha256` (`backupMerkle.ts:34`); Merkle signature = curve25519 via the libsignal wrapper (proven daily by sender certs); snapshot seq tag = `@noble` `hmac` (`merkleCommit.ts:23`, `ratchetSnapshotScheduler.ts:61`); row/bundle crypto = subtle AES-GCM (proven daily by groupCrypto/outerEcies); argon2 = native (proven by round-1 setup success). `computeVerifyProof` was the last subtle hash-family call in the backup feature.

### Retest (unchanged from §7 step 4 — now expected to pass end-to-end)

Enable backup → success alert → kill + relaunch → Settings → Chat Backup → UNLOCK with the correct password → messages restore; wrong password → "Wrong password" (a clean 401, **not** a crash overlay) and `failed_attempts` bumps on the server row.

> **⚠️ SUPERSEDED by §10:** the v1.0.95 retest got past the password proof (rounds 1+2 confirmed fixed) and then failed at the NEXT stage — the Merkle integrity gate. Read on.

---

## 10. Round 3 (2026-07-05, post-v1.0.95 retest) — "Restore failed: backup.merkle_mismatch:rows_count_mismatch" ← OPEN, root-caused

### Plain-English summary

Rounds 1 and 2 are genuinely fixed — the password derive works, the server accepts the password proof, the encrypted bundle unwraps. The failure moved a **third** time, to the last checkpoint before messages are written to the phone: the **integrity check**. And this time it is not a broken crypto library — it is a **design flaw in the backup's own tamper-detection**, and the live server data proves it fires on perfectly healthy accounts.

Analogy: the phone keeps a vault of sealed envelopes (your mirrored messages) at the post office (the server), and every so often it signs a **receipt** saying "my vault contains exactly N envelopes". At restore time the phone counts the envelopes it gets back and, if the number doesn't match the last signed receipt, it assumes the post office tampered with the vault and **refuses the restore**. The flaw: the phone keeps **adding envelopes continuously** (every message you send/receive is mirrored within ~1.5 s), but it only signs a new receipt **30 seconds after** a batch — and, crucially, when you background or kill the app, the pending envelopes are force-mailed but the pending **receipt is thrown away** (`messageMirror.ts` AppState handler flushes the row queues and does nothing about the pending Merkle timer). So the vault almost always contains MORE envelopes than the last receipt says. The restore then treats **your own newest messages as evidence of tampering** and refuses. Retrying can never fix it on an idle account, because a new receipt is only ever signed after a new flush.

### Live-data proof (Supabase, 2026-07-05 ~11:10 UTC — this is not a theory)

```sql
-- The diagnostic query (run via Supabase MCP execute_sql):
select c.user_id, c.row_count as committed_rows, c.seq, to_timestamp(c.sent_at_ms/1000) as committed_at,
  (select count(*) from messages_backup m where m.owner_user_id = c.user_id) as server_rows,
  (select count(*) from messages_backup m where m.owner_user_id = c.user_id
     and m.mirrored_at > to_timestamp(c.sent_at_ms/1000)) as rows_after_commit
from backup_merkle_commits c order by c.sent_at_ms desc;
```

| account (user_id prefix) | committed_rows (signed) | server_rows (actual) | rows mirrored AFTER last commit | restore outcome                                               |
| ------------------------ | ----------------------- | -------------------- | ------------------------------- | ------------------------------------------------------------- |
| `fe4ddc14…`              | **3** (seq 9, 08:40)    | **14**               | 11 (last write 10:27)           | ❌ `rows_count_mismatch` — the screenshot (10:28 local retry) |
| `79d63649…`              | **27** (seq 5, 10:46)   | **28**               | 1 (write 10:51)                 | ❌ would fail right now                                       |
| `3165d0e1…`              | 11 (11:05)              | 11                   | 0                               | ✅ would pass                                                 |
| `49baff75…`              | 57 (June)               | 57                   | 0                               | ✅ would pass                                                 |

Half the accounts with backups are in the failing state **through normal use, with zero tampering**. `fe4ddc14…` mirrored rows for ~2 hours (writes at 09:xx–10:27) without a single new commit landing (last commit 08:40) — the commit pipeline demonstrably lags or dies in practice.

### Exact mechanics (all file:line references verified this session)

1. **The gate:** `restoreMessages.ts:565-606` — after paging all rows, `verifyMerkleCommit` runs; `rows_count_mismatch` throws `MerkleCommitMismatchError` (`restoreMessages.ts:601-603`; message template `backup.merkle_mismatch:<reason>` at `:115` — exactly the screenshot text). `merkleCommit.ts:350-351` returns that reason whenever `fetched-row-count !== commit.rowCount`. Per the H-4 remediation, a count mismatch is deliberately **excluded** from the self-heal that equal-count root drift gets (`restoreMessages.ts:580-599` — `recommitAndReverify` only runs for `root_mismatch` with equal counts).
2. **The committer:** `commitMerkleRoot` (`merkleCommit.ts:123-249`) page-walks the SERVER's `/backup/messages` and signs `(root, rowCount, seq, sentAtMs)` with the identity key. So `committed_rows` = server rows **at the moment the commit runs**.
3. **The lag:** commits run (a) once at setup (`BackupSetupScreen.tsx` `handleEnable`, right after `backupNow()`) and (b) via a **30-second non-resetting debounce** after each mirror flush (`messageMirror.ts:57-70`, `MERKLE_DEBOUNCE_MS = 30_000`). The mirror itself flushes rows on a **1.5 s** debounce (`FLUSH_DEBOUNCE_MS`, `:83`).
4. **The kill-window bug:** the AppState background handler (`messageMirror.ts:118-131`) force-flushes the message + conversation queues (so rows DO reach the server on backgrounding) but does **not** fire or fast-forward the pending Merkle timer — and RN timers don't run in the background. Net effect: backgrounding within 30 s of activity **guarantees** the server ends up ahead of the signed count. This is the dominant real-world trigger (QA: send a test message → immediately background/kill).
5. **The setup-order bug:** `handleEnable` runs the initial `commitMerkleRoot` immediately after `backupNow()` — but `backupNow` only **enqueues** rows into the 1.5 s-debounced mirror queue. The commit walks the server before most flushes land, signing a near-empty baseline (account `fe4ddc14…`: committed **3**, server **14**). The after-flush hook is then the only thing that can catch up.
6. **Retry can't heal:** a new commit only ships after a new **flush**; an idle account (no new messages) never re-commits, so the mismatch is permanent until chat activity + ≥30 s of foreground time happen to coincide.
7. **Why rounds 1–2 never saw this:** this code never executed on a device before — round 1 unblocked setup, round 2 unblocked the password proof; each fix exposed the next never-run stage. Round 3 is different in kind: not a missing primitive, but an **invariant (`server rows == last signed count`) that normal asynchronous operation violates**, enforced as a hard anti-tamper gate.

### Security analysis — which direction is actually dangerous (read before fixing)

- **`fetched < committed` (server returned FEWER rows than signed): dangerous.** This is genuine omission/rollback — exactly what the Merkle layer exists to catch. **Keep the hard fail.** (Deletions do NOT shrink the set: delete-for-everyone mirrors a `status='deleted'` **tombstone row** — `messageMirror.ts:282-322` — which mutates/adds rows, never removes them. `messages_backup` has no TTL column and no retention sweep yet — verified against the live schema — so nothing legitimately deletes rows today.)
- **`fetched > committed` (server returned MORE rows than signed): the normal honest-lag state** — every extra row is one this device mirrored after its last receipt. A malicious server cannot exploit tolerance here: it has no master key, so any row it injects fails per-row AES-GCM decryption during restore and is skipped (`counts.skipped`). Under the CURRENT code, injected junk (or ordinary lag) instead **bricks the restore** — i.e. the hard gate in this direction only ever converts an availability non-issue into a denial of service against the user's own backup.
- The seq anti-rollback gates (signed `seq` + HMAC-tagged local anchor, `merkleCommit.ts:355-369`) are independent of this and stay intact.

### The fix — ✅ IMPLEMENTED 2026-07-05 exactly as specified below, shipped v1.0.97 (vc123). Implementation notes: `verifyMerkleCommit` now returns a distinct `rows_count_grew` reason for the fetched > committed direction (`merkleCommit.ts`), which `restoreMessages.ts` routes into the existing `recommitAndReverify` self-heal alongside equal-count `root_mismatch`; `messageMirror.ts` gained `fireMerkleHookNow()` (AppState background fires the pending commit, only when one is owed) + `drainMirrorOutbox()` (used by `BackupSetupScreen.handleEnable` before the baseline commit) + `MERKLE_DEBOUNCE_MS` 30 s → 5 s. Tests: `merkleRecommitReconcile.test.ts` (+3 direction/self-heal) and new `messageMirrorMerkleFlush.test.ts` (4). Original spec kept below for the record:

1. **Extend the existing self-heal to the `fetched > committed` direction** — `restoreMessages.ts:580-604` + `merkleCommit.ts:334-354`: when the signature verifies, `identityPrivKey` is available (both restore paths pass it — H-13), and `fetched > commit.rowCount`, call the existing `recommitAndReverify` over the fetched leaves (it already takes `leaves` — M-12) instead of hard-failing. Log loudly (`[restore] rows_count grew committed=N fetched=M — re-committing (post-commit mirror lag)`). Keep the hard fail for `fetched < committed`. Update the H-4 comment to document the direction asymmetry (H-4's intent — never re-sign over a REDUCED set — is preserved).
2. **Fire the Merkle hook on backgrounding** — `messageMirror.ts:118-131`: in the AppState handler, after the forced flushes, clear `merkleHookDebounce` and invoke `merkleAfterFlushHook()` immediately (fire-and-forget with catch, same as the timer body at `:64-70`). This closes the kill-window at the source.
3. **Fix the setup-order race** — `BackupSetupScreen.tsx` `handleEnable`: run the initial `commitMerkleRoot` only after the mirror outbox from `backupNow()` has actually flushed (either await a drain — the mirror exposes flush internals — or simply drop the immediate commit and rely on the after-flush hook with a short first-commit debounce). Baseline must not be born stale.
4. **(Optional, cheap)** shrink `MERKLE_DEBOUNCE_MS` 30 s → 5 s — one curve25519 sign + one small POST per burst is negligible; the window shrinks 6×.
5. **Investigate the 2-hour commit gap** on `fe4ddc14…` (writes 09:xx–10:27, last commit 08:40): with a live mirror the 30 s hook should have fired many times. Capture logcat for `[bravo.backup.mirror] merkle hook failed:` (the hook swallows errors — `messageMirror.ts:67-69`) and verify the plain-boot path actually installs the hook (`startMirrorBootstrap` → `setMerkleAfterFlushHook`; check `backupBoot.ts` resume branches; cross-ref `docs/audits/MSG_BACKUP_AUDIT_2026-07-02.md` finding B-BK1 "boot sweep never wired"). If boot never installs the hook, fix that too — otherwise commits only ever happen in the session that ran setup.
6. **Tests to write first:** (a) `verifyMerkleCommit`/restore self-heal path for `fetched > committed` with a valid sig + priv key → restore succeeds and a fresh commit ships; (b) `fetched < committed` → still hard-fails; (c) AppState background → merkle hook fires (mirror test harness exists in `__tests__`); (d) setup path → initial commit runs over the flushed set, not the pre-flush server state. Suites: `messageMirror`/`merkleCommit`/`restoreMessages` tests under `src/modules/messenger/__tests__/`.

### Immediate tester workaround (no code, works today)

On the affected device: **send (or receive) any one message, then keep the app in the foreground for ~60 seconds** (1.5 s flush + 30 s commit debounce + upload), then retry UNLOCK + RESTORE — the fresh commit reconciles the count and the restore passes. Alternative: "Forgot password — wipe + start fresh" (this device still holds all messages locally; they re-mirror after the new setup). This also heals the two currently-broken staging accounts (`fe4ddc14…`, `79d63649…`) — the re-commit must come from the phone (only it holds the signing key; the server cannot repair this).

---

## 11. Fix playbook for a fresh session (everything you need, in order)

You are fixing **B-45 round 3** (§10). Rounds 1–2 are already fixed and shipped — do not touch `deriveVerifierKey`, `computeVerifyProof`, or the polyfills HMAC/digest shims except as regression surface. Read `CLAUDE.md` first (gates + security stop-conditions; the Merkle layer is integrity-relevant, so keep the direction asymmetry of §10 intact — do NOT weaken `fetched < committed`).

1. **Files to change (spec in §10 "The fix"):** `src/modules/messenger/backup/restoreMessages.ts` (:580-604 gate), `src/modules/messenger/backup/merkleCommit.ts` (verify + reason surface), `src/modules/messenger/backup/messageMirror.ts` (:57-70 debounce, :118-131 AppState hook), `src/screens/messenger/BackupSetupScreen.tsx` (initial-commit ordering), plus `backupBoot.ts` if step 5 of §10 finds the hook uninstalled on plain boot.
2. **Write the failing tests first** (§10 fix step 6), then implement, then gates: `npm run test:crypto` (mandatory regression for backup changes) → `npm test` → `npm run typecheck` (error count must stay ≤ `.tsc-baseline.json`, currently 49; the run itself exits non-zero because of ~46 PRE-EXISTING errors in news/ops screens — count them, don't panic) → `npx eslint <changed files>`.
3. **Diagnose/verify against live data:** Supabase MCP `execute_sql` with the query in §10 — before the fix it shows the broken accounts; after an on-device retest the mismatched accounts should read `committed_rows == server_rows`.
4. **Server/DB facts you'd otherwise rediscover:** no server deploy and no DB migration are needed (the gate is client-side; `putMerkleCommit`/`getMerkleCommit` endpoints are fine). Staging box: `ssh -i C:\Users\User\.ssh\bravo-staging.pem admin@94.136.184.52`; messenger container `bravo-staging-msgr` (`docker logs`), Caddy has no access logs. `BackupService.putIdentity` logs every call for an existing-row user — useful to confirm client requests are arriving at all.
5. **Build + ship (the exact flow that worked for v1.0.94/95):** bump `versionCode`/`versionName` in `android/app/build.gradle` AND `"version"` in `app.json` (check the current values first — parallel sessions ship builds too; v1.0.96/vc122 was taken by the B-46 build on 2026-07-05, so the next free is likely v1.0.97/vc123). In PowerShell, set `EXPO_PUBLIC_API_BASE_URL=https://auth.94-136-184-52.sslip.io`, `EXPO_PUBLIC_MSG_BASE_URL=https://relay.94-136-184-52.sslip.io`, `EXPO_PUBLIC_AUTO_DISPATCH=true`, `EXPO_PUBLIC_DEPT_CHAT_V2=true`, `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_ANON_KEY` (values in `package.json` `apk:staging`; do NOT add a Mapbox token — removed intentionally), then `cd android; .\gradlew.bat assembleRelease` **in the foreground** (~1-6 min; background runs get killed). Distribute: `npx firebase-tools appdistribution:distribute android\app\build\outputs\apk\release\app-release.apk --app 1:150226560672:android:ff3a71dcdb542556818bc5 --groups qa` with `GOOGLE_APPLICATION_CREDENTIALS` = the repo-root `bravo-734da-*.json`. Commit: `git add -f android/app/build.gradle` (android/ is gitignored; `MainActivity.kt` is force-tracked — never let it go untracked, HEAD once broke because of it); multiline commit messages via `git commit -F <file>` (PS 5.1 mangles quotes).
6. **Device QA protocol (closes B-44 + B-45):** enable backup → success alert → send a message → background the app → reopen → kill → relaunch → Settings → Chat Backup → UNLOCK with correct password → **messages restore with no `merkle_mismatch`** → wrong password → "Wrong password". Then run the §10 SQL — counts must match. Also fresh-install restore on a second device if available.
7. **Round-4 watchlist (stages after the Merkle gate that have still never executed on a device):** deferred SQLCipher hydrate (`restoreMessages.ts:611-621`), ratchet-snapshot apply (`sessionRatchetRecovery.ts` — the C-3/B-BK3 owner-key fix is in but device-unproven), sealed-archive drain (outerEcies unseal — daily-proven crypto, un-proven volume path), conversation restore + group_state decrypt. If a 4th failure appears, it is most likely one of these — same diagnostic method: the overlay error text → grep the message template → file:line → check what that stage assumes.
8. **Standing hardening items (§8, still open):** boot-time HKDF/HMAC self-test; QA-build raw error code under the humanized copy (this saga cost three round-trips largely because the UI collapses every failure into one string); `sframe.ts:167` subtle-HKDF flag; and when Phase-2 retention sweeps for `messages_backup` are ever added, they MUST re-commit (or exclude swept rows) — otherwise they resurrect this exact bug in the dangerous `fetched < committed` direction.

---

## Appendix: file/line index

| What                                  | Where                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error funnel (UI)                     | `src/screens/messenger/BackupSetupScreen.tsx:237-239`, `src/modules/messenger/backup/backupErrorCopy.ts:20`                                                                                                   |
| Throwing call                         | `src/modules/messenger/backup/backupCrypto.ts:344-367` (`deriveVerifierKey`), called from `identityBackup.ts:258` (setup) and `identityBackup.ts:327` (restore)                                               |
| Broken library switches               | `node_modules/react-native-quick-crypto/lib/commonjs/subtle.js:313-319` (deriveBits), `:426-432` (importKey); version 0.7.17                                                                                  |
| Polyfill (no HKDF shim)               | `src/modules/messenger/crypto/polyfills.ts` (HMAC shim :62-148, digest shim :150-221)                                                                                                                         |
| Working in-repo HKDF patterns         | `src/modules/messenger/media/aesCbc.ts:41-43,155` (@noble), `src/modules/messenger/crypto/outerEcies.ts:387-398` (manual HMAC)                                                                                |
| Test-environment masking              | `src/modules/messenger/__tests__/__mocks__/react-native-quick-crypto.ts`, `package.json:199-200`                                                                                                              |
| Server-side (healthy, never reached)  | `apps/messenger-service/src/backup/backup.service.ts:229-328` (`putIdentity` — logs every call for existing-row users)                                                                                        |
| Related bug log                       | `sqa.md` B-44 (verifier_missing hard cut — its remedy is blocked by this bug)                                                                                                                                 |
| P0-1 origin                           | `docs/audits/MESSENGER_BACKUP_AUDIT.md` C-1 + Remediation Log; commit `4025d6c` (2026-07-03)                                                                                                                  |
| **Round 3: Merkle gate (OPEN)**       | `restoreMessages.ts:565-606` (gate + self-heal branch), `:115` (error template), `merkleCommit.ts:123-249` (committer), `:334-354` (count check), `:350-351` (`rows_count_mismatch`)                          |
| Round 3: lag sources                  | `messageMirror.ts:57-70` (30 s commit debounce), `:83` (1.5 s flush debounce), `:118-131` (AppState flushes rows but NOT the commit), `BackupSetupScreen.tsx` `handleEnable` (initial commit races the flush) |
| Round 3: live evidence                | Supabase `backup_merkle_commits` vs `messages_backup` counts (query in §10); accounts `fe4ddc14…` (3 vs 14) and `79d63649…` (27 vs 28) broken on 2026-07-05                                                   |
| Round 3: tombstones (why "<" is real) | `messageMirror.ts:282-322` (`mirrorRemoval` upserts a `status='deleted'` row — deletions never shrink the server set)                                                                                         |
