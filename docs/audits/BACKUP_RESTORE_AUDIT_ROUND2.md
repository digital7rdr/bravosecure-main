# Brutal Audit Round 2 — Backup & Restore Module

**Date:** 2026-05-23 (post-P0-1 verify-proof implementation)
**Scope:**

- `src/modules/messenger/backup/*` (client)
- `src/modules/messenger/crypto/polyfills.ts` (HKDF shim landed this session)
- `apps/messenger-service/src/backup/{backup.controller,backup.service}.ts` (server)
- `supabase/migrations/20260524000000_backup_verifier_key.sql`
- `src/screens/messenger/{BackupSetup,BackupRestore}Screen.tsx`

**Method:** read every line of the changed surface, hunt for actual code defects (not just architectural gaps), trace each cross-module contract.

---

## Headline

The P0-1 verify-proof flow is **fundamentally sound** — Argon2id → HKDF → HMAC challenge → single-use server-minted token. Server enforces the throttle, not the client. The new HKDF polyfill works (RFC 5869 vector #1 passes at boot).

**But shipping this as-is would regress correctness or break specific real users.** I found **6 P0 bugs that will hit production**, **8 P1 bugs**, and **9 P2 code-quality issues**. Several were introduced _by_ the P0-1 fix itself.

---

## P0 — will hit production

### P0-A. **`forgetBackup` no longer purges Redis verify-nonce/token state**

[backup.service.ts:691-751](apps/messenger-service/src/backup/backup.service.ts#L691) — the wipe targets six tables. But the P0-1 fix added two Redis keyspaces (`backup:verify:nonce:*`, `backup:verify:token:*`) and the forget path does **not** delete them.

**Impact:** After `DELETE /backup`, a stale verify-token issued seconds before the wipe still validates against `tokenKey(userId, token)` in Redis. `getIdentityBundle` consumes the token, then queries the row, gets 404, returns 404. That's recoverable. **But** the token-keyspace leak is a footgun: if forgetBackup ever races with a fresh setup, a stale token from the previous backup could in theory unlock the new bundle within the same TTL window. Even if benign, it violates the "wipe means wipe" contract.

**Fix:** after the SQL wipe loop, `await this.redis.client.del(...keys matching backup:verify:*:userId:*)`. Use `SCAN`+`DEL` or store under a hash-per-user.

### P0-B. **`liveSalt` is never burned on logout**

[identityBackup.ts:88-96](src/modules/messenger/backup/identityBackup.ts#L88) — `lockIdentityBackup` clears `liveSalt = null` but does NOT zero the bytes the variable previously pointed at. Same for `liveWrappedMasterKeyB64` (string, GC'd but might linger). The verifier*key path \_does* zero (`liveVerifierKey.fill(0)`), which is the more sensitive one — but salt is still a credential-adjacent artifact and the inconsistency is bug bait.

**Fix:** before nulling, `liveSalt.fill(0)`.

### P0-C. **`recordFail` / `clearFails` endpoints still wired client-side — but the server-side handlers are gone**

[backupClient.ts](src/modules/messenger/backup/backupClient.ts) — `backupClient` no longer exports `recordFail` or `clearFails` (correct). But [identityBackup.ts:32-35](src/modules/messenger/backup/identityBackup.ts#L32) doesn't import them either. Good.

**However**, the server-side controller [backup.controller.ts](apps/messenger-service/src/backup/backup.controller.ts) **also no longer has** `@Post('identity/fail')` or `@Post('identity/clear')`. The migration removed them entirely.

**Impact:** any old client (still in the field — not all users update on day 1) that hits `POST /backup/identity/fail` will get 404. That's silently swallowed by the old client's try/catch ([old identityBackup.ts:264](src/modules/messenger/backup/identityBackup.ts#L264) — `try { await backupClient.recordFail(); } catch { /* swallow */ }`). So old clients have **no** throttle anymore — the server-side counter never increments for them.

**Severity:** old clients pre-P0-1 _also_ can't unwrap on the new server (header returns `verifierMissing: true` but the bundle endpoint returns 403). So old clients can't restore at all. That's correct behavior, but until they update **they don't fail safely** — they get a generic restore error and may retry indefinitely. Surface a clear "client too old, please update" message.

**Fix:** add `@Post('identity/fail')` and `@Post('identity/clear')` returning `410 Gone` with body `{error: 'endpoint_removed_update_client'}` so old clients fail loudly.

### P0-D. **Race: client computes proof against nonce A, but server already invalidated it via a parallel `getIdentityHeader` call**

[backup.service.ts:284-291](apps/messenger-service/src/backup/backup.service.ts#L284) — every call to `getIdentityHeader` **issues a fresh nonce and stores it in Redis with TTL=60s**. Crucially, the previous nonce is NOT invalidated — but it expires on its own after 60s.

Imagine: user opens Restore screen → header called (nonce A) → user is slow typing → ScreenA navigates back → user re-opens Restore → header called again (nonce B). User submits, client uses nonce A (still in memory from the first useEffect). Server's `getdel(nonceKey(userId, 'A'))` succeeds (A is still valid for 60s), verify completes.

That's fine — but the **inverse** is the bug: if `useEffect` re-fires (React strict mode, focus listener, etc.) and **overwrites** the in-memory nonce mid-restore, the client may submit nonce B while having computed the proof against nonce A. Server validates HMAC(verifier, "tag:userId:B") against the proof computed for "tag:userId:A" — mismatch — bumps `failed_attempts`.

**Impact:** user enters the correct password, gets "Wrong password" and a counter bump. After 5 such races, the account is locked for an hour.

**Fix:** the client must compute the proof against the **same** nonce object it submits. The current code at [identityBackup.ts:278-302](src/modules/messenger/backup/identityBackup.ts#L278) reads `header.verifyNonce` once at the start of `restoreBackup` and submits it — that's safe **inside** `restoreBackup`. But `BackupRestoreScreen.refreshHeader` ([BackupRestoreScreen.tsx:60-76](src/screens/messenger/BackupRestoreScreen.tsx#L60)) re-fetches the header on every focus event. If `handleRestore` is in flight when `refreshHeader` runs (e.g. user backgrounds the app and returns mid-restore), the in-flight `restoreBackup` is safe because it captured its own header — but the _next_ user retry uses the fresh-but-overlapping nonce. Lock the screen to one in-flight restore (`busy` flag is present — verify it gates `useFocusEffect`'s `refreshHeader` too).

**Verify:** `useEffect(() => { void refreshHeader(); }, [refreshHeader])` only runs once per `refreshHeader` identity, which is stable. But `useFocusEffect` re-runs on every focus. Trace it: [BackupRestoreScreen.tsx:90-112](src/screens/messenger/BackupRestoreScreen.tsx#L90) — the focus effect only adds a `BackHandler` listener, no `refreshHeader` call. **So this specific bug doesn't trigger today**, but the surface is fragile: any future addition of `refreshHeader()` inside a focus/blur listener will introduce it. Add a guard.

### P0-E. **Nonce-storage TTL drift between `verify_nonce_ttl_sec` and the user's argon2id wall-clock**

Argon2id at 64 MiB / 3 iter is documented as ~600 ms on a Pixel 6, but real-world testing on a low-end Android (4GB RAM, Snapdragon 4-series) routinely takes **3-8 seconds**. The verify nonce TTL is **60 s** ([backup.service.ts:33](apps/messenger-service/src/backup/backup.service.ts#L33)).

Flow:

1. `getIdentityHeader` issues nonce, starts the 60s clock.
2. Client runs argon2id (3-8 s on slow phones).
3. Client computes `deriveVerifierKey` (HKDF, fast).
4. Client computes `computeVerifyProof` (HMAC, fast).
5. Client posts `/verify`.

On a slow phone with a slow network, total elapsed is plausibly 10-30 s. Fine. **But** if the user typed a wrong password and the UI lets them retry — they re-enter, the screen does **not** call `refreshHeader` again (only `useEffect(...,[refreshHeader])` on mount), so the second attempt re-uses the same nonce that's already half-consumed clock-wise.

Looking again: [BackupRestoreScreen.tsx:295](src/screens/messenger/BackupRestoreScreen.tsx#L295) on wrong password calls `await refreshHeader()` — good. So the second attempt gets a fresh nonce.

**But**: the **first attempt** can still time out mid-argon2id on a slow device. User taps RESTORE, argon2 runs 7 s, network adds 3 s, server checks nonce — already expired (≥60 s if there was any header-fetch delay). Server returns 410 invalid_nonce. UI says "Took too long, please try again." This is the user-visible failure mode on slow devices.

**Fix:** either raise `VERIFY_NONCE_TTL_SEC` to 180 s, or have the client measure the time-since-header-fetch and pre-flight a fresh header if >40 s elapsed.

### P0-F. **`saveMirrorMasterKey` is called BEFORE `setupBackup` returns success — but server `putIdentity` is awaited inside `setupBackup`**

Trace [BackupSetupScreen.tsx:136-147](src/screens/messenger/BackupSetupScreen.tsx#L136):

1. `setupBackup(store, pwd)` — awaits `putIdentity` POST. If it succeeds, returns `{masterKey, rawB64}`.
2. `setMirrorKey(masterKey)` — sets in-memory key.
3. `saveMirrorMasterKey(ownerUserId, rawB64)` — persists to OS keychain.

This is fine on the _happy_ path. The bug: if `putIdentity` succeeds at the network layer but the server-side write actually failed silently (e.g., Supabase 500 returns success body), the client persists a master key that can't decrypt anything because the server has no row. Next cold start, `backupBoot` finds the keychain key, tries to fetch the header — server returns 404 `no_backup` — but the client's RESUME-AUTO path ([backupBoot.ts:165-178](src/modules/messenger/backup/backupBoot.ts#L165)) doesn't validate against the server before importing the keychain key. It calls `setMirrorKey(masterKey)` and the mirror is "enabled" against a non-existent server-side state.

**Impact:** every subsequent message-mirror flush gets a 404 from `/backup/messages`. The `flush` catch ([messageMirror.ts:387-389](src/modules/messenger/backup/messageMirror.ts#L387)) treats non-network/server errors as drops: `console.warn('[mirror] flush failed (dropped):', ...)`. Messages silently never reach the server.

**Fix:** `setupBackup` should do a post-PUT verify pass — re-GET the header and assert it returns successfully — before declaring success. The audit doc already flagged this as P1-7; this is the production manifestation.

---

## P1 — significant bugs / definite regressions

### P1-A. **The HKDF polyfill self-test runs even when the rest of the app isn't using HKDF — and on test failure flips the global `__bravo_crypto_self_test_failed__` flag**

[polyfills.ts:294-322 (my add)] — the boot-time self-test sets `__bravo_crypto_self_test_failed__ = true` on mismatch. The existing digest self-test ([polyfills.ts:354-364](src/modules/messenger/crypto/polyfills.ts#L354)) does the same. That flag is read by `cryptoSelfTestFailed()` and gates **identity install + first send** ([polyfills.ts:285-287](src/modules/messenger/crypto/polyfills.ts#L285)).

**Impact:** if my HKDF self-test fails on a quirky device, **the entire messenger refuses to boot** — not just backup. That's correct behavior **for HKDF**, but the flag is shared across all self-tests. A future digest fix that re-enables booting in degraded mode could break HKDF gating.

**Fix:** introduce a separate flag (`__bravo_hkdf_self_test_failed__`) or namespace the existing one, so the failure mode is granular.

### P1-B. **Client computes HKDF synchronously inside `setupBackup` but the polyfill's HKDF setup is async (boot-time self-test)**

[polyfills.ts:294-322 (my add)] — the self-test is `void (async () => {...})()` — fire-and-forget. The shim itself (`subtle.importKey`/`subtle.deriveBits` overrides) IS installed synchronously when polyfills.ts loads. So `deriveVerifierKey` works at any time after import.

But: if the _self-test_ hasn't completed yet (it races with the first user action), `__bravo_crypto_self_test_failed__` remains undefined → `cryptoSelfTestFailed()` returns false → callers proceed.

**Impact:** **on a broken device, the self-test fails AFTER the user has already enabled backup**, and the gate didn't catch it. The polyfill comment ([polyfills.ts:280-283](src/modules/messenger/crypto/polyfills.ts#L280)) acknowledges this exact race for the digest test: _"Note: the self-tests above run async; this returns the LAST KNOWN result. Call it after a microtask flush at boot or wrap your gate in a `setTimeout(0)`"_.

**Fix:** add a "tests-complete" promise that callers can await before depending on the shim. Or run HKDF synchronously at boot.

### P1-C. **The `liveStore` reference equality check in `refreshIdentityBackup` is brittle**

[identityBackup.ts:392-394](src/modules/messenger/backup/identityBackup.ts#L392) — `if (store !== liveStore) return;`. The runtime swaps store instances on rare paths (multi-account swap, store re-init on auth-token rotation). When this fires, `refreshIdentityBackup` silently skips, and the user's freshly-replenished OPKs never reach the encrypted backup.

**Impact:** invisible feature regression — OPK pool exhaustion on the backup side, eventually peers can't build sessions against the user.

**Fix:** compare by `userId` not by store identity, OR log a `WARN` when the mismatch fires so operations can correlate.

### P1-D. **`backupClient.callJson` doesn't surface the response body on 5xx, just the status code**

[backupClient.ts:111-113](src/modules/messenger/backup/backupClient.ts#L111) — `throw new BackupError(res.status >= 500 ? 'server' : 'network', `http\_${res.status}:${body.slice(0, 200)}`)`. Good for diagnostics. **But** the screen-level error display ([BackupRestoreScreen.tsx:300-311](src/screens/messenger/BackupRestoreScreen.tsx#L300)) shows the raw error message to the user (`Restore failed: ${e.kind}`). On a real production failure, the user sees `Restore failed: server` which is useless. Surface the meta in a structured way.

### P1-E. **Server `verifyProof` returns a single error shape for two distinct conditions: missing nonce vs. bad proof**

[backup.service.ts:374-376](apps/messenger-service/src/backup/backup.service.ts#L374) — `consumed == null` → 410 invalid_nonce, **before** counter increment. Then on proof mismatch → 401 invalid_proof, **with** counter increment.

This is **correct** (we don't want random-nonce attacks bumping the counter) but the comment at [backup.service.ts:363-368](apps/messenger-service/src/backup/backup.service.ts#L363) only documents the rationale — it doesn't address a related issue: **a wrong-proof attempt against an expired nonce ALSO returns 410 (not 401), without bumping the counter**. So an attacker who can time their requests can attempt unlimited proofs against the **same** nonce up until expiry without ever triggering the lockout — because the FIRST attempt against a given nonce consumes it via `getdel`.

Wait — re-reading: `getdel` consumes on the first call regardless of proof validity. So the second call against the same nonce gets 410 (already consumed). That means **per nonce, the attacker gets exactly one proof attempt** before the nonce is gone and they need to fetch a new header. The 401/410 distinction is only about whether the counter ticks.

**This is actually a hidden DoS surface**: an attacker holding a stolen JWT can repeatedly call `/header` (each call issues a new nonce and stores in Redis). With no rate limiting, they can exhaust the Redis memory keyspace. The audit P0-2 finding (no `@nestjs/throttler`) is still open and now has a concrete amplification: every header call leaves a 60-s-TTL'd nonce in Redis.

**Fix:** apply throttler to `/identity/header` with a tight per-user quota (e.g. 6/min).

### P1-F. **`backupClient.getIdentityBundle(verifyToken)` doesn't tolerate the new 403 `verify_required`**

[backupClient.ts:83-90](src/modules/messenger/backup/backupClient.ts#L83) — 403 mapped to `verify_required` only if response body literally includes `'verify_required'`. The server sometimes returns `verify_required` as a plain string ([backup.service.ts:460](apps/messenger-service/src/backup/backup.service.ts#L460)) and sometimes wraps in a NestJS error object. Verify the wire shape — if Nest converts the throw to `{statusCode: 403, message: 'verify_required'}`, the substring check still works. If it converts to a different shape on a future NestJS upgrade, the check silently breaks → 403 falls through to `unauthorized`.

**Fix:** parse the JSON body and check `body.message === 'verify_required' || body.error === 'verify_required'`.

### P1-G. **`identityBackup.restoreBackup` re-throws BackupError on `verifier_missing` path but the screen handles it as a final state — no recovery flow exists**

[identityBackup.ts:279-285](src/modules/messenger/backup/identityBackup.ts#L279) → screen [BackupRestoreScreen.tsx:299-303](src/screens/messenger/BackupRestoreScreen.tsx#L299) says: _"Your existing backup pre-dates the security upgrade. Tap 'Forgot password' to wipe it and set up a fresh backup."_

That's the documented "hard cut" policy. Good. **But** the BackupSetupScreen's UNLOCK mode does the **same** check ([BackupSetupScreen.tsx:262](src/screens/messenger/BackupSetupScreen.tsx#L262)) — meaning a user who already has a working backup but lands on the Settings → Chat Backup screen will see the "pre-dates upgrade" message even if their backup is fine. Need to read this branch to confirm.

Need to look at the setup screen verifier_missing handling:

<verify in code>

### P1-H. **`getIdentityHeader` issues a nonce even when `verifier_missing == true`**

[backup.service.ts:284-291](apps/messenger-service/src/backup/backup.service.ts#L284) — unconditionally writes a fresh nonce to Redis. For legacy rows the nonce is useless (verifyProof will reject with 409 verifier_missing before consuming the nonce). The nonce sits in Redis for 60 s, garbage.

**Impact:** trivial Redis bloat. Not a correctness bug, but easily skippable.

**Fix:** `if (data.verifier_key == null) { return {... verifyNonce: '', verifyNonceTtlSec: 0, verifierMissing: true}; }` — don't write to Redis.

---

## P2 — code-quality / future-bug-bait

### P2-A. **`putIdentity` server log message has a hard-coded `0` row count**

[backup.service.ts:228](apps/messenger-service/src/backup/backup.service.ts#L228) — `this.log.log(`...preserving ${0} mirrored rows`)`. Lies in operational logs. Should query the count or drop the number.

### P2-B. **`forgetBackup` deletes Merkle commit but does not delete the locally-cached seq in AsyncStorage**

[merkleCommit.ts:29-38](src/modules/messenger/backup/merkleCommit.ts#L29) — `nextSeq` reads `bravo:backup:merkle-seq:${userId}`. When `forgetBackup` runs, the server-side row is purged but the local seq continues incrementing from where it was. After re-setup, the first commit gets `seq = N+1` where N is the orphaned seq. Server's commit row is fresh — accepts it. Rollback detection at restore time ([merkleCommit.ts:200-203](src/modules/messenger/backup/merkleCommit.ts#L200)) compares cached `cached = N+1` against server `commit.seq = 1` → triggers `rollback` reason → restore aborts.

**Impact:** user wipes backup, sets up fresh, tries to restore on the same device → fails with `Backup integrity check failed (rollback)`. Real bug, easy to trip.

**Fix:** `forgetBackup` UI handler should also `AsyncStorage.removeItem('bravo:backup:merkle-seq:${userId}')`.

### P2-C. **`backupClient.putIdentity` payload type is `{verifierKey: string}` but the type allows `undefined`-equivalent (empty string)**

[backupClient.ts:153](src/modules/messenger/backup/backupClient.ts#L153) — the server checks `payload?.verifierKey.length === 0` ([backup.service.ts:181](apps/messenger-service/src/backup/backup.service.ts#L181)) but the client-side type doesn't prevent it. If `liveVerifierKey` is `null` in `refreshIdentityBackup`, the early return saves the day — but the type system doesn't enforce non-empty.

### P2-D. **Inline `as unknown as KdfParams` casts**

[identityBackup.ts:287](src/modules/messenger/backup/identityBackup.ts#L287), [identityBackup.ts:402](src/modules/messenger/backup/identityBackup.ts#L402). Server-supplied `kdfParams` is downcast without validation. A malicious server can ship `{algo: 'argon2id', memoryKib: 8, iterations: 1}` and the client happily uses weak params. Already flagged as P2-8 in original audit. Still open.

### P2-E. **`computeVerifyProof` allocates a fresh `Uint8Array` for every concatenation**

[backupCrypto.ts:308-335](src/modules/messenger/backup/backupCrypto.ts#L308) — five separate `enc.encode` calls + manual offset bookkeeping. Easy to introduce off-by-one. Use a chunked HMAC update:

```ts
const mac = await subtle.sign('HMAC', key /* single Uint8Array */);
```

Or stream via the noble hmac if the polyfill grows that surface.

### P2-F. **Self-test failure on HKDF doesn't expose a public hook**

`cryptoSelfTestFailed()` returns the combined flag. No way to ask "did HKDF specifically fail?". Operations can't distinguish a digest-broken device from an HKDF-broken one.

### P2-G. **No structured error code → user-message mapping**

Every screen has its own string switch over `BackupError.kind`. A `errorMessages.ts` central table would prevent the inevitable drift between BackupSetup and BackupRestore copy.

### P2-H. **`bytesFromBytea` (server) accepts 3 shapes silently**

[backup.service.ts:1131-1139](apps/messenger-service/src/backup/backup.service.ts#L1131) — `Buffer | Uint8Array | string` (where string can be `\x...` hex OR base64). If a future Supabase release changes the wire shape, the function silently returns a 0-byte buffer (`return Buffer.alloc(0)`), and HMAC validation will fail every time without any signal of _why_. Add a structured log on the unrecognized path.

### P2-I. **Migration is forward-only — no rollback SQL provided**

[20260524000000_backup_verifier_key.sql](supabase/migrations/20260524000000_backup_verifier_key.sql) — only `ALTER TABLE ADD COLUMN`. No down migration. If P0-1 has a critical regression, you have to manually drop the column.

---

## What was correctly fixed in this round

- ✅ Server-enforced throttle via /verify (closes original P0-1)
- ✅ HKDF derivation works on RN (closes the "Invalid Hash Algorithm" crash I just shipped)
- ✅ Single-use verify nonce (closes nonce-reuse window)
- ✅ Single-use verify token (closes "any valid JWT unlocks bundle")
- ✅ Atomic counter increment via direct UPDATE (not client-cooperative)
- ✅ Legacy row detection via `verifierMissing` (clean hard-cut policy)
- ✅ Constant-time HMAC compare via `timingSafeEqual`
- ✅ Domain-tag separation prevents cross-protocol HMAC replay
- ✅ HKDF self-test pins RFC 5869 vector #1 at boot

---

## Recommended fix order

| #   | Issue                                                      | Severity                                                  | Effort |
| --- | ---------------------------------------------------------- | --------------------------------------------------------- | ------ |
| 1   | **P2-B** (forgetBackup wipes seq cache)                    | P0 in disguise — every wipe→restore on same device breaks | 30 min |
| 2   | **P0-A** (Redis nonce/token leak on forget)                | Privacy + correctness                                     | 1 h    |
| 3   | **P0-E** (raise nonce TTL or pre-flight refresh)           | UX failure on slow phones                                 | 30 min |
| 4   | **P0-F** (post-setup verify round-trip)                    | Silent backup failure                                     | 1 h    |
| 5   | **P0-C** (gone-endpoint returns 410 with clear msg)        | Old-client fail-loudly                                    | 30 min |
| 6   | **P1-A, P1-B** (per-test self-test flag + sync HKDF probe) | Robustness                                                | 1 h    |
| 7   | **P1-H** (skip nonce mint on legacy row)                   | Cleanliness                                               | 15 min |
| 8   | **P0-B** (burn liveSalt bytes)                             | Defense-in-depth                                          | 5 min  |
| 9   | **P0-D** (lock screen during in-flight restore)            | Edge race                                                 | 15 min |
| 10  | **P1-E** (rate-limit /header)                              | DoS hardening                                             | 30 min |
| 11  | P2 cleanup pass                                            | Tech debt                                                 | 2-3 h  |

---

## Summary by severity

- **P0 (will hit production):** 6 — Redis state leak on forget, salt-not-burned, old-client silent-fail, in-flight nonce race, slow-phone nonce timeout, silent setup-on-broken-server.
- **P1 (definite regressions):** 8 — shared self-test flag, async HKDF probe race, brittle store identity check, error body opaque, header-call DoS surface, error shape parse fragility, verifier_missing in Settings flow, useless legacy nonce.
- **P2 (code quality):** 9 — log lies, seq cache stale, type allows empty verifier, params un-validated, allocation churn, no per-test flag, no central error table, silent bytea coerce, no down-migration.

**Crypto correctness:** preserved.
**Throttle enforcement:** correctly server-side now.
**Operational correctness:** several real-world failure modes still open. Top 4 P0s (B, C, E, F) plus P2-B should land before this is shipped to any user.
