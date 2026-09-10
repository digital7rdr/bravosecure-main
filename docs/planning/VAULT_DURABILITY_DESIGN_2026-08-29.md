# Vault Durability — Design & Build Plan (2026-08-29)

**Founder ask (B-696):** the vault PIN — and the vault's contents — must follow the
_person_, not the install. Today deleting the app (or even a plain sign-out) destroys
the PIN **and the only copy of every vault file's AES key**, leaving the server-side
ciphertext permanently undecryptable. Approved by the founder 2026-08-29: _"do it all
steps. first write down a md file how you gonna build the thing completely without
breaking anything existing functionality. then build it."_

**Related open bugs:** B-696 (this design), B-697 (staging MFA/attestation regression —
NOT fixed by this design; the move-to-vault MFA gate is untouched and still requires
the server env fix), B-695 (call-screen name — unrelated, separate fix).

---

## 0. Summary — four phases, strictly additive

| Phase | What                                                                                                                                                      | Where                      | Survives                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| **A** | Owner-scoped vault stash: sign-out stashes the vault slice per owner instead of destroying it; sign-in adopts it back                                     | client only                | sign-out/sign-in on the same device |
| **B** | Server-side PIN **verifier** (argon2id hash of the PIN, auth-service): after reinstall the user re-enters their same PIN once and the local gate re-mints | auth-service + client      | reinstall / new device (PIN gate)   |
| **C** | Forgot-PIN reset done RIGHT (the audit-S2 way): account password + server OTP + single-use action token; **files are kept**                               | auth-service + client      | a forgotten PIN                     |
| **D** | E2E-encrypted vault index blob (file keys + albums) under an HKDF subkey of the **backup master key**, synced to messenger-service                        | messenger-service + client | reinstall / new device (the FILES)  |

**Non-goals:** no change to the vault MFA action-token gate (`MfaGuard`, single-use
proofs — CLAUDE.md stop-condition, stays byte-identical); no change to per-file
AES-256-CBC encryption or upload paths; no change to the Merkle/mirror pipeline
(Phase D deliberately lives OUTSIDE `backup/**` — see §6.1); no PIN-derived file
encryption (a 6-digit PIN cannot protect keys offline; see §2.3).

---

## 1. Current state (verified, file:line)

- PIN hash + per-file AES keys + albums live ONLY in zustand persist
  `bravo-vault-v1` on AsyncStorage — `src/modules/messenger/vault/vaultStore.ts:591-607`
  (partialize), `:49-50` (keyB64/ivB64 "stays on device").
- `allowBackup="false"` (`android/app/src/main/AndroidManifest.xml:121`) → uninstall
  destroys it. No copy exists anywhere else: zero vault references in
  `src/modules/messenger/backup/**`; server-side `vault_items` was DROPPED
  (`supabase/migrations/20260707061830_webapp_audit_drop_legacy_tables.sql:22`);
  `VaultService` is a pure R2 presigner with no DB (`apps/messenger-service/src/vault/vault.service.ts`).
- signOut resets the store UNCONDITIONALLY (`src/store/authStore.ts:1001-1005`),
  outside the `wipeAtRest` gate (`:954`) — while SQLCipher chat history deliberately
  survives a plain sign-out (`:948-953`). Rationale (Issue 30/20): the store is
  account-unscoped, so the next account inherited the previous user's PIN + files.
- Forgot-PIN is fail-closed by audit **S2** ("Vault PIN reset gadget — full vault
  takeover", `docs/audits/MESSENGER_AUDIT_FIXES.md:29-37`): the old flow accepted ANY
  email/phone + ANY 6-digit code, client-side only. Both screens now hard-disable with
  `VAULT_RESET_BACKEND_AVAILABLE = false` and the S2 row itself says: _"Re-enabled when
  auth-service ships a real `/auth/vault-reset/_` endpoint."\* That endpoint is Phase C.
- The PIN is a pure UX gate over PIN-independent file keys (`vaultStore.ts:29-34`) —
  so PIN durability needs NO key escrow, and a PIN reset need not touch files.
- The backup master key (raw, b64) is persisted per-owner in the OS keychain
  (`saveMirrorMasterKey`, `src/modules/messenger/runtime/keychain.ts:301-304`), saved at
  backup setup AND at restore (`BackupSetupScreen.tsx:250-252`,
  `BackupRestoreScreen.tsx:344-346`) — available in-session without the password, and
  re-established on a fresh install by the existing restore ceremony. This is Phase D's
  key anchor.

## 2. Security posture

### 2.1 Stop-condition compliance

- **MfaGuard / action tokens / File Vault MFA:** untouched. Phase D's new endpoints are
  deliberately NOT under the `/vault` controller (which applies `MfaGuard` class-wide
  with single-use proofs — `vault.controller.ts:23-24`); they follow the
  `backup_session_snapshots` precedent (`POST/GET /backup/identity/sessions` —
  JWT + throttle, no MFA), because the payload is E2E-encrypted client-side and the
  server stores an opaque blob. Same protection class, same guard set.
- **Encryption primitives:** none added. Phase D reuses `backupCrypto`'s existing
  AES-256-GCM (`aesGcmEncrypt/Decrypt`), HKDF-SHA256 (`@noble`, same as
  `deriveVerifierKey`), and AAD binding (`backupAad`) with a new info string
  `bravo-vault-index-v1` and AAD purpose `vault-index`. Server never sees key material.
- **No plaintext/key logging:** the sync module logs counts and seqs only
  (`logAudit.test.ts` covers `src/modules/messenger`).

### 2.2 The S2 constraint (why the reset flow looks like this)

The S2 gadget was: free-text identity + client-side "any 6 digits" + `changePin`
without old-PIN proof ⇒ anyone holding the unlocked phone owns the vault. The new flow
removes every leg:

1. **No free-text identity** — the reset is bound to the authenticated account (JWT);
   the OTP goes to the ACCOUNT's phone, server-side.
2. **Account password required** at reset request. An attacker holding the unlocked
   phone can read the OTP SMS on it — the password is the factor they do not have.
   (This matters doubly on staging, where `OTP_DEV_BYPASS=true` makes any code pass —
   sqa.md B-39.)
3. **Server-verified OTP** (`OtpService.check`, Twilio Verify in production).
4. **Single-use, 5-minute action token** between "OTP verified" and "new PIN set"
   (`signActionToken` purpose `vault-pin-reset` + Redis jti, the exact
   `biometric.assert`/MfaGuard pattern) — no client-side trust anywhere in the chain.
5. **Redis lockout** on password/OTP attempts (the TOTP pattern:
   `totp.service.ts:17-18, 72-75, 117-119` — 10 failures → 15 min, uniform error).
   Audit events for every step (`AuditEventType` union extended).

### 2.3 Why files ride the BACKUP key, not the PIN

A 6-digit PIN (10^6 space) cannot protect key material against offline brute force no
matter the KDF. Wrapping file keys under the PIN would turn a leaked server blob into
a crackable vault. The backup master key is random 32-byte, already the app's E2E
recovery story (messages have exactly this durability model), already re-established
by the password-gated restore ceremony. Consequence, stated honestly: **file
durability requires Secure Backup to be set up** — same as message history. A user
without backup gets Phases A–C (PIN durability + same-device stash) but their file
keys still live only on-device. The Backup screens already push users to set it up.

### 2.4 Accepted residual risks (documented, not new)

- The vault index (with file keys) sits in un-encrypted AsyncStorage TODAY; Phases A–D
  do not worsen the per-user posture, but the owner stash keeps a signed-out user's
  slice on the device. Stated precisely (review F7): the SQLCipher DB that also
  survives sign-out is ENCRYPTED with a keychain-held key, while these file keys are
  in the clear — the delta this design adds is that signed-out users' clear-text keys
  now linger too (pre-B-696 they were wiped, along with the files they opened).
  `allowBackup=false` bounds the blast radius to on-device attackers. Accepted by the
  founder as the cost of durability; the §9 follow-up (move the index into SQLCipher /
  a keychain-wrapped envelope) is the real closure and should not slip far.
- `wipeAtRest` (explicit "remove account") drops the owner's stash too — parity with
  the DB wipe.

---

## 3. Phase A — owner-scoped vault stash (client only)

**Goal:** plain sign-out stops destroying the vault; account isolation is preserved by
scoping, not by wiping. Prior art to mirror: `messengerStore.setOwner`
(`messengerStore.ts:1770-1815`, `vaultByOwner[prev]` snapshot; test `ownerVault.test.ts`).

### 3.1 Store changes (`vaultStore.ts`) — flat shape PRESERVED

Every consumer reads flat top-level fields (`files`, `albumState`, `pinHash`,
`biometricEnabled` — verified across VaultScreen/FilesScreen/FileViewer/Settings), and
`vaultStore.test.ts:176-186` pins the AsyncStorage record shape at key
`bravo-vault-v1` with `state.pinHash`. So:

- Keep the flat fields and persist name EXACTLY as-is.
- Add two persisted fields: `vaultOwner: string | null` (which owner the FLAT slice
  belongs to) and `ownerStashes: Record<string, OwnerStash>` where `OwnerStash` =
  `{pinHash, biometricEnabled, files, albumState, failedAttempts, lockoutUntil}` (the
  partialized set minus session-only fields).
- New actions:
  - `stashAndClearOwner()` — stash flat under `vaultOwner` (no-op if `vaultOwner` null
    **and** flat is pristine), then reset flat + `vaultOwner = null`. Called from
    signOut IN PLACE OF `reset()`.
  - `adoptVaultOwner(ownerKey: string)` — if `vaultOwner === ownerKey` no-op; else
    stash current flat under `vaultOwner` (if set), then flat = `ownerStashes[ownerKey]
?? initial`, delete the stash entry, `vaultOwner = ownerKey`.
    **Legacy claim rule:** `vaultOwner === null` with non-pristine flat data → the data
    belongs to whoever is adopting (today's wipe-on-signout guarantees flat data can
    only belong to the sitting user) → stamp, don't stash-under-null.
  - `dropOwnerStash(ownerKey)` — for the `wipeAtRest` lane.
- `reset()` keeps its exact literal shape (`vaultPinFirstAccess.test.ts:50-55` pins it)
  and remains the full-wipe primitive.

### 3.2 Wiring

- **Adoption:** `MainNavigator.tsx:634-694` — the existing owner-resolution effect that
  already calls `store.setOwner(ownerKey, userId)` and
  `useActivityStore.getState().setOwner(ownerKey)` gains
  `useVaultStore.getState().adoptVaultOwner(ownerKey)`, after vault hydration
  (`vaultPersistApi().onFinishHydration` guard, or a hydration-aware helper). Same
  `ownerKey` (`msg:ownerKey:${userId}` = email ?? phone ?? id) as every other
  owner-scoped surface.
- **Sign-out:** `authStore.ts:1001-1005` — swap `reset()` for `stashAndClearOwner()`.
  The Issue-30/20 property (next account sees `hasPin() === false`, no files) is
  preserved by the clear — pinned by a NEW test, and `vaultPinFirstAccess.test.ts`'s
  signOut source-scan is re-pointed to the new symbol (re-point, never delete).
- **wipeAtRest lane:** inside the gated block (`authStore.ts:954-970`), add
  `dropOwnerStash(ownerKeyForWipe)`.

### 3.3 Tests

- New `vaultOwnerStash.test.ts`: A(pin+files) → stashAndClear → flat empty/hasPin
  false → adopt(B) empty → adopt(A) restores byte-identically → wipeAtRest drops the
  stash → legacy-claim rule → session fields (unlock windows, pin-proof stamps) never
  stashed.
- Re-point `vaultPinFirstAccess.test.ts` (:38-48 signOut assertions → new symbol; the
  rest — storage key, reset literal, redirect dep array — unchanged and must stay
  green untouched).
- `vaultAlbumReset` / `vaultStore` suites: unchanged (partialize gains keys; their
  assertions are subset-based except the record-shape one, which still holds).

---

## 4. Phase B — server-side PIN verifier (auth-service + client)

**Goal:** after a reinstall, the user types their SAME PIN once; the server verifier
confirms it; the local Argon2 gate re-mints from the typed plaintext. No escrow — the
server stores only an argon2id hash and can never open anything.

### 4.1 Server (new module `apps/auth-service/src/vault-pin/`, biometric-module layout)

- **Table** (one migration, `supabase/migrations/<ts>_vault_pin_verifier.sql`):
  ```sql
  CREATE TABLE IF NOT EXISTS public.vault_pins (
    user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    verifier    text NOT NULL,              -- argon2id PHC (PasswordService)
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.vault_pins ENABLE ROW LEVEL SECURITY;  -- deny-by-default (house rule)
  REVOKE ALL ON public.vault_pins FROM anon, authenticated;
  ```
  (Attempt counting lives in Redis, TOTP-style — no counters in the table.)
- **Endpoints** (`@Controller('auth/vault-pin')`, `JwtAuthGuard`, `@Throttle` like
  `me/password` — `{limit: 5, ttl: 60_000}` on mutating routes):
  - `GET /auth/vault-pin` → `{exists: boolean}` (routing probe; `{limit: 20}`)
  - `POST /auth/vault-pin` `{pin, currentPin?}` → set/replace. Replace REQUIRES
    `currentPin` verify (or a valid reset token from Phase C). First set requires
    nothing beyond JWT. 403 `pin_mismatch` on wrong currentPin (counts toward lockout).
  - `POST /auth/vault-pin/verify` `{pin}` → `{ok: true}` | 403 `pin_invalid`
    (uniform whether locked or wrong — the TOTP anti-leak rule), Redis lockout
    `vaultpin-fail:` / `vaultpin-lock:` (10 fails → 15 min).
  - PIN format server-validated (`^\d{4,8}$`) — never logged; audit events
    (`auth.vault_pin.set|verify|reset`, extend `AuditEventType`) carry outcome only.
- `PasswordService` + `OtpService` re-provided locally in the module (AuthModule does
  not export them — house pattern, `pro-management.module.ts:17` precedent).

### 4.2 Client

- `authApi` gains `getVaultPinStatus() / setVaultPin(dto) / verifyVaultPin(dto)` +
  Phase C methods (`api.ts:456-459` changePassword is the wrapper template).
- **Sync on set/change:** `VaultNewPinScreen.handleComplete` (the ONLY
  setupPin/changePin caller) after local success calls `setVaultPin` best-effort.
  For the change lane the server needs `currentPin`: a new module-scoped, never-
  persisted holder (`vaultPinSession.ts`: `notePinProven(pin)` / `takeProvenPin()`,
  auto-cleared after 60 s — same window as `PIN_PROOF_WINDOW_MS`) is fed by
  `VaultLockScreen`'s successful verify, which is the only door to the change lane
  (the `vaultStore.ts` changePin invariant). Local-first: server failure never
  blocks vault usage.
  **AS BUILT (review F1):** the sync debt is two persisted per-owner flags —
  `pinSyncPending` (offline set/change, retry owed) and `pinServerDiverged`
  (the server provably holds a DIFFERENT verifier: an offline fresh setup over
  an existing account PIN, or a change whose old-pin proof no longer matched).
  `syncPinToServer` records them; `reconcileServerPin` (fired on every
  successful local unlock, replacing the doc's earlier "ensureServerPin"
  sketch) mints a missing verifier, and — ONLY while a debt is recorded, to
  spare the server lockout budget — verifies the local pin server-side:
  a match clears the debt, a mismatch confirms divergence and VaultLockScreen
  shows a ONE-SHOT prompt pointing at Forgot-PIN (the S2-sanctioned overwrite
  door; the app never silently overwrites the server verifier). Both flags
  ride the owner stash. Pinned by `vaultPinServerSync.test.ts`
  (mutation-proven RED on the debt-retry and the one-shot edge).
- **Re-adopt on reinstall:** concentrated in `VaultNewPinScreen` (zero changes to
  VaultLock's pinned redirect or `openVault`): on mount with `!hasPin()`, probe
  `getVaultPinStatus()`. If `exists`, render **"Enter your vault PIN"** mode: verify
  via `verifyVaultPin`; on ok → `setupPin(pin)` locally (re-mint) → forward per
  `next`. "Forgot PIN?" link → Phase C. If the probe fails (offline), fall through to
  today's fresh-setup UX — and the later best-effort `setVaultPin` for a user who
  ALREADY had a verifier sends no `currentPin`, so the server refuses the overwrite
  (fail-safe: a network blip can't let a fresh setup clobber the account verifier;
  the screen then surfaces the re-adopt path on next visit).

### 4.3 Tests

Server `vault-pin.service.spec.ts` (biometric.spec mocking style): first-set /
replace-requires-currentPin / verify ok+fail / lockout at 10 / uniform error / audit
emissions / reset-token acceptance (Phase C). Client: `vaultPinServerSync.test.ts`
(source-scan + unit: NewPin calls setVaultPin, offline fall-through, the no-currentPin
overwrite refusal path, holder never persisted — greppable absence in partialize).

---

## 5. Phase C — Forgot-PIN reset (the real `/auth/vault-reset/*`)

**Flow** (3 steps, all server-verified, S2 legs removed per §2.2):

1. `VaultForgotScreen` (rebuilt): shows the ACCOUNT's masked phone (no free-text
   identity), one input: **account password**. `POST /auth/vault-pin/reset/request
{password}` → verifies password (`PasswordService.verify` against
   `users.password_hash`), sends OTP to the account phone (`OtpService.send`), 200
   `{maskedPhone}`. Throttle `{limit: 3, ttl: 600_000}` + OTP send-cap + lockout on
   password failures.
2. `VaultOTPVerifyScreen` (rebuilt: ONE 6-digit code, not the email+phone pair):
   `POST /auth/vault-pin/reset/verify {code}` → `OtpService.check` → 200
   `{resetToken}` — `signActionToken` purpose `vault-pin-reset`, 5-min TTL, jti in
   Redis (`storeJti`), single-use.
3. `VaultNewPinScreen` (new `reset` mode, param `{resetToken, next}`):
   `POST /auth/vault-pin/reset/complete {resetToken, newPin}` → verify+burn token
   (`isJtiValid`+`revokeJti` — the MfaGuard consume pattern) → upsert verifier. Client
   then `setupPin(newPin)` locally. **Files and albums are KEPT** (the PIN is a gate,
   not a key — §1). Biometric consent resets with the new hash (setupPin already does).
4. Both screens drop `VAULT_RESET_BACKEND_AVAILABLE` and its support-mailto dead end;
   route params widened (`types.ts` + the three navigators already register the
   routes; `vaultBiometricToggle`'s cross-shell sweep keeps that honest). VaultLock's
   "Forgot PIN?" (`VaultLockScreen.tsx:400-405`, unpinned) carries `route.params`.

⚠️ Two suites use these screens' S2 comments as parser fixtures
(`sourceScanSafety.test.ts:61`, `messengerSafeAreaSweep.test.ts:45-46`) — check both
after editing; the S2 row in `MESSENGER_AUDIT_FIXES.md` gets an "re-enabled per design
doc §5" note. `docs/audits` S2 status + `vaultAlbumReset`'s "Used by the Forgot PIN
flow" stale docstring (`vaultStore.ts:154-158`) corrected to name signOut/wipe.

**Tests:** server spec (password wrong → uniform fail + lockout; token single-use;
token cross-purpose refused; complete without verify refused). Client:
`vaultForgotFlow.test.ts` render tests for the 3 screens' happy path + the
files-survive assertion (store files unchanged across reset), + navigation params.

---

## 6. Phase D — E2E vault index blob (files survive reinstall)

### 6.1 Why NOT the Merkle mirror

The backup runbook exists because the mirror/commit machinery shipped `root_mismatch`
five times. The vault index is one small opaque blob with no per-row history — it
needs none of that machinery, and touching `backup/**` would drag this change under
the full BACKUP_LOOP gate for zero benefit. The design therefore copies the OTHER
existing pattern: `backup_session_snapshots` (opaque bytea + monotonic seq + 409
`stale_seq` — `backup.service.ts:806-885`), in the vault module, with I6's
adopt-once discipline on the client.

### 6.2 Crypto

- `vaultIndexKey = HKDF-SHA256(masterKeyRaw, salt=∅, info='bravo-vault-index-v1', 32)`
  — `masterKeyRaw` from `loadMirrorMasterKey(ownerKey)` (keychain; present iff backup
  set up / restored). Same derivation family as `deriveVerifierKey`
  (`backupCrypto.ts:339-360`).
- Payload: `{v: 1, files: VaultFile[], albumState}` JSON →
  `aesGcmEncrypt(vaultIndexKey, bytes, backupAad('vault-index', ownerUserId))`.
- No mirror key ⇒ lane silently disabled (counts-only log line).

### 6.3 Server (messenger-service, `src/vault/` — NOT `backup/**`)

- Migration `supabase/migrations/<ts>_vault_index_blobs.sql`: clone of
  `backup_session_snapshots` (user_id PK → users CASCADE, `blob bytea`, `seq bigint`,
  touch trigger, `ENABLE ROW LEVEL SECURITY`, REVOKE anon/authenticated).
- `vault-index.controller.ts`: `@Controller('vault-index')` + `JwtHttpGuard` ONLY
  (§2.1) + `@Throttle({limit: 30, ttl: 10_000})`:
  - `POST /vault-index` `{blob: base64 ≤ 2 MiB, seq}` → seq must exceed stored, else
    409 `{error: 'stale_seq', currentSeq}` (putSessionSnapshot template).
  - `GET /vault-index` → `{blob, seq}`, or `null` when nothing was uploaded yet
    (the getSessionSnapshot convention; the client handles both null shapes).
- `vault-index.service.ts`: Supabase service-role client, `requireClient()` +
  missing-table 503 idiom from backup.service. DTO class-validated
  (`@IsBase64 @MaxLength`, `@IsInt @Min(0)`) — global `forbidNonWhitelisted` applies.
- Callers send `X-Signal-Device-Id` (JwtHttpGuard requires it; `'1'` like vaultClient).

### 6.4 Client (`src/modules/messenger/vault/vaultIndexSync.ts`)

- **Push:** store subscription on `files`/`albumState` reference change for the
  CURRENT owner → 5 s debounce → encrypt → POST `seq = lastSeq + 1`. On 409: GET,
  decrypt, MERGE (below), re-push with `currentSeq + 1`, ONCE (I6: adopt, never
  hammer). Persisted `indexSeq` per owner slice.
- **Pull:** `maybeRestoreVaultIndex()` — when adopted owner's `files` is empty, mirror
  key present, GET returns a blob → decrypt → merge → mark pushed. Wired at: (a) the
  MainNavigator adoption effect (after `adoptVaultOwner`), (b) BackupRestoreScreen
  success (right after its `saveMirrorMasterKey` — `:344-346`).
- **Merge rule (both directions):** files = union by `objectKey` (existing local row
  wins); albums = union by id, local name wins; assignments merged for surviving
  objectKeys (`pruneAssignments` on the result). Deletions: a locally-removed file
  wins over the server copy only via the normal push (removal bumps seq); pull-side
  merge never resurrects a file the local index already removed IN THIS SESSION
  (session-scoped `removedKeys` set, not persisted — best-effort; a true tombstone
  ledger is out of scope, and the worst case is a re-listed stale row whose open then
  fails, surfaced honestly).
- Logs: counts/seq only. Never the blob, names, or keys.

### 6.5 Tests

Client `vaultIndexSync.test.ts`: round-trip encrypt/decrypt with AAD; wrong-AAD
refused; merge rules incl. removal non-resurrection; 409 adopt-once; disabled-without-
key; debounce single-flight; no key/name in any log call (spy). Server
`vault-index.spec.ts`: put/get, stale_seq 409, owner isolation, size cap, missing
table 503.

---

## 7. No-breakage matrix (what stays byte-identical, and the pins that prove it)

| Existing behavior                                                                            | Preserved by                                                | Pin                                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Flat store fields (`files`, `pinHash`, …) + persist key `bravo-vault-v1`                     | Phase A adds fields, renames nothing                        | `vaultStore.test.ts:176-186`                             |
| `reset()` literal + full-wipe semantics (albums included)                                    | untouched; signOut just stops calling it                    | `vaultAlbumReset`, `vaultPinFirstAccess:50-55`           |
| Next-account isolation after sign-out (Issue 30/20)                                          | `stashAndClearOwner()` clears flat                          | re-pointed `vaultPinFirstAccess` + new `vaultOwnerStash` |
| VaultLock redirect effect + dep array; `openVault` routing; FilesScreen `guardLock` ordering | untouched (re-adopt lives inside VaultNewPinScreen)         | `vaultPinFirstAccess:63-169`, `vaultNavigation`          |
| Biometric consent rules (opt-in, `pinFresh()` gate)                                          | setupPin path unchanged                                     | `vaultBiometricOptIn`, `vaultBiometricToggle`            |
| Vault MFA gate, single-use proofs, `/vault` endpoints                                        | untouched (new endpoints live beside, not under, MfaGuard)  | `mfa.guard.spec`, `vaultOpenCeremony`                    |
| Move-to-vault refusals (`no_pin`, `company_file`, tier)                                      | `vaultOps.ts` untouched                                     | `vaultTierSurfaces`, `vaultCompanyFileRefusal`           |
| Backup mirror/Merkle invariants I1–I9                                                        | zero files under `backup/**` touched; blob lane is separate | BACKUP_LOOP §4 suites stay green                         |
| Brute-force lockout tiers (client)                                                           | untouched; server adds its OWN lockout                      | `vaultBruteForceLockout`                                 |
| Route registration across 3 shells                                                           | params widened only                                         | `vaultBiometricToggle:85-177` sweep                      |

## 8. Build & rollout order

1. **Phase A** (client) → full messenger gate.
2. **Migrations** (`vault_pins`, `vault_index_blobs`) via Supabase MCP.
3. **Phase B server** → auth-service tests; **Phase B client**.
4. **Phase C** (server routes + 3 screens).
5. **Phase D** (messenger-service module + client sync).
6. Gates: `messenger-crypto` ×2 (flake rule) + app `screens/messenger` + auth-service
   suite + messenger-service suite + both typechecks ≤ baseline + lint. Self-diff
   sweep (founder rule ×3): enumerate consumers of every changed symbol.
7. Deploy: auth-service + messenger-service to the staging box (manual tar flow);
   local APK build + adb install per LOOP.md. **Owed regardless of this design:** the
   B-697 staging env fix (`BIOMETRIC_DEV_BYPASS` effective again) or Move-to-Vault
   stays broken for everyone — this design does not and must not soften that gate.
8. Device verification: reinstall round-trip (set PIN + move file + backup on →
   uninstall → reinstall → restore backup → enter same PIN → files listed and
   openable); sign-out/sign-in round-trip; two-account isolation on one device.

## 9. Follow-ups (recorded, not built now)

- Move the vault index at rest into SQLCipher (or wrap with a keychain key) — closes
  the plaintext-AsyncStorage exposure predating this design.
- Server GC for orphaned R2 vault objects (no list endpoint exists; blob restores make
  orphans rarer but deletion-while-offline can still strand objects).
- iOS attestation (`apple_jwt_signing_pending`) — Phase B/C/D work on iOS, but
  Move-to-Vault itself stays gated on the B-697 env/attestation posture.
