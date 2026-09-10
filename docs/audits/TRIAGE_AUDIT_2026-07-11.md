# Post-Pull Triage Audit — 2026-07-11

**Scope:** three founder-reported problems after pulling `main` @ `06dbfdd` (v1.0.107 / vc133):

1. Messenger **backup became very slow** (and possibly no longer accurate) right after the rapid-burst fix `3ae4790` (B-72/73/74).
2. Bravo Lite: **CPO sometimes cannot finish a mission** — API error, intermittent.
3. **Mapbox sometimes doesn't load** — "load failed" message or blank screen, intermittent.

**Method:** 3 parallel code-trace investigations + staging-log forensics (SSH to `bravo-staging-auth` on Contabo) + an empirical Node repro of the deadlock candidate. Key claims re-verified against source by a second pass.
**Mode:** audit only — **no fixes applied.** Bugs logged as **B-75 / B-76 / B-77** in `sqa.md`.

| #    | Finding                                                                                                                                                     | Severity                                 | Verdict                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| B-75 | `3ae4790` makes `saveIdentity` self-deadlock the global txn chain → messenger persistence freezes; backup stalls/ships incomplete, restore hangs            | **P0 / CRITICAL**                        | **CONFIRMED** (code-traced + Node repro)        |
| B-76 | Mission finish fails on session revocation (single-device takeover / one-strike refresh), 15 s timeout lost-200s, and an uncaught post-commit escrow settle | **HIGH** (P1; escrow leg = money impact) | ROOT-CAUSED (top cause log-verified)            |
| B-77 | Map boot has zero recovery path — one failed style/tile/CDN fetch = permanent blank; error events dropped; Android WebView error callbacks unreachable      | **HIGH** (P1)                            | **CONFIRMED** (long-standing, not a regression) |

---

## B-75 — Global txn-chain deadlock introduced by the B-72 fix (`3ae4790`) ⚠️ P0

**User symptom:** backup "so so slow" after pulling the rapid-burst fix; previously fast and 100% accurate.

**What actually broke:** not backup itself — the **entire messenger write path**. Once the chain deadlocks, inbound messages stop committing for the rest of the app process; backup then mirrors a frozen/incomplete dataset and restore hangs with a stuck progress %.

### Mechanism

`3ae4790` changed `SqlCipherProtocolStore.saveIdentity` (`src/modules/messenger/crypto/sqlCipherStore.ts:237-238`): when `isInsideRatchetTxn()` is false it no longer opens its own raw `BEGIN IMMEDIATE` — it queues a transaction on the **global `txnChain`** via `runWithRatchetTxn`.

But `runOnTxnChain` (`src/modules/messenger/runtime/receiveTransaction.ts:133-143`) runs its work **on that same chain without setting `_txnOpen`**. So `saveIdentity` reached from inside `runOnTxnChain` work sees `isInsideRatchetTxn() === false` and **enqueues itself behind the very chain item that is awaiting it**. Circular wait → the module-level chain freezes **permanently**.

**Deadlock call path (all verified at source):**

1. Inbound decrypt failure classified `rebuild` → `runDecryptRecovery` — `productionRuntime.ts:5747`
2. `await runOnTxnChain(() => own.closeSession(...))` / `await runOnTxnChain(() => own.initOutgoingSession({...}))` — `productionRuntime.ts:5860, 5864`
3. → `SessionBuilder.processPreKey` — `packages/messenger-core/src/crypto/sessionManager.ts:99-131`
4. → libsignal **awaits** `storage.saveIdentity(...)` — `libsignal-protocol-typescript/lib/session-builder.js:72`
5. → `saveIdentity` → `runWithRatchetTxn` → `txnChain.then(...)` appends behind the still-running step-2 work → **deadlock**.

The comment at `receiveTransaction.ts:133-139` documents the invariant the fix broke: _"those operations call saveIdentity internally, which opens its own BEGIN (and our serialization guarantees only ONE BEGIN is open at a time)."_ After `3ae4790` that internal `saveIdentity` no longer opens its own BEGIN — it queues on the chain it's already occupying.

**Empirical proof:** a ~50-line Node script mirroring `receiveTransaction.ts` + the new `saveIdentity` verbatim prints `TIMEOUT_DEADLOCK`, and every later `runWithRatchetTxn` caller hangs forever (scratchpad `chain_deadlock_repro.js`).

**Trigger plausibility:** high on this test setup — B-74 (same commit) documents live `No record for <userId>.1` recovery events, i.e. `runDecryptRecovery` was firing during the very session that produced the fix.

### Why it reads as "backup slow / not accurate"

- **Inbound stops existing:** every receive txn (`productionRuntime.ts:5735`, group `:6041`) queues behind the dead chain → never commits → never reaches Zustand → the mirror (`src/modules/messenger/backup/mirrorBootstrap.ts:142-173`) never ships it → **silently missing from backup**.
- **SQLCipher goes stale:** the 50 ms coalesced flush (`sqlMessageStore.ts:120` → `upsertBatch` → `runWithRatchetTxn` at `:332`) hangs and also occupies the per-conversation chain (`:84-95`), stalling even plain sent-message upserts. `backupNow`'s catch-up sweep (`mirrorBootstrap.ts:200-242` → `loadAll`, an unchained SELECT) then reads a **frozen snapshot**.
- **Restore hangs:** `restoreMessages.ts:598, :729` per-page `upsertBatch` → dead chain → stuck forever at "Saving restored messages…" with frozen % — the most literal "backup got very slow" experience.
- **Verify stays green on an incomplete backup:** the Merkle hook (`mirrorBootstrap.ts:102-114`, 5 s debounce in `messageMirror.ts:61`) keeps signing the partial send-side set — the "100% accurate before" guarantee is gone with no red flag.

### Secondary cost (even before any deadlock)

libsignal's **encrypt** path fire-and-forgets `saveIdentity` on **every outbound message** (`session-cipher.js:83`). Post-`3ae4790` each send appends a full `BEGIN IMMEDIATE…COMMIT` txn to the global FIFO (previously a fast autocommit-style write). Awaited X3DH `saveIdentity` calls (~17 sites, e.g. `productionRuntime.ts:757…4311`) now wait FIFO-depth × per-txn cost. Once the chain is dead, these entries accumulate unboundedly.

### Ruled out

- Backup code calling the chain: zero `saveIdentity|runWithRatchetTxn|runOnTxnChain` matches under `src/modules/messenger/backup/`.
- The 50 ms flush being new: it has ridden the chain since `a854139` (P0-1, v1.0.104, 2026-07-09) — pre-dates the fast baseline.
- Other commits: `git diff 7790903..3ae4790 --stat` shows the entire delta since v1.0.106 is `3ae4790`'s 7 files; only `sqlCipherStore.ts` is runtime-relevant to this path.
- Test-coverage gap: the new B-72 tests (`receiveTransaction.test.ts:317-390`) cover saveIdentity-vs-flush and saveIdentity-inside-`runWithRatchetTxn`, but **not** saveIdentity-inside-`runOnTxnChain` — the exact escape.

### Fix direction (not applied)

Make chain residency visible: `runOnTxnChain` sets an "executing on chain" flag (sibling of `_txnOpen`) so `saveIdentity` called from chain-resident work runs its body with its own raw `BEGIN IMMEDIATE` (safe — the chain already guarantees exclusivity; this is the pre-`3ae4790` contract `runOnTxnChain` was designed around). Alternative: make `runWithRatchetTxn` re-entrant (run inline when already on-chain). Add the missing regression test: `runOnTxnChain(work)` where `work` awaits `store.saveIdentity(...)` must complete. Fold in `identityBackup.ts:207` (`reinstallIdentity` raw `BEGIN`) which also violates the P0-1 one-runner doctrine and can collide with chained saveIdentity txns during restore.

### Retest

On the fixed build: force a decrypt-recovery (fresh reinstall peer → burst), then confirm (1) inbound still renders afterwards, (2) `backupNow` completes at normal speed, (3) restore progress advances, (4) `adb logcat | grep -E "recovery|coalesced flush|backupNow"` shows no stalls.

---

## B-76 — Lite CPO "Finish mission" intermittent API error · HIGH

**User symptom:** sometimes the CPO cannot finish the mission; app shows an API error.

### Flow (verified)

- Client: `AssignedMissionDetailScreen.tsx:403-410` → `runAction('finish')` `:103-127` → `POST /agents/me/missions/:id/complete` (`src/services/api.ts:799-801`, `Idempotency-Key: complete-${missionId}`, 15 s axios timeout, no auto-retry; catch re-loads truth then `Alert('Could not advance', <raw message>)`).
- Server: `agent.controller.ts:362-371` → `agent.service.ts:1377-1390 missionComplete` → `flipMissionStatus(…,'COMPLETED',['LIVE','SOS'])` `:1413-1490` → `completeMissionCore` `:1501-1570` (txn) → settle **outside** the txn: `settleEscrowOnFinish` `:1557` (escrow) or `disburseMissionPayout` `:1559` (legacy, fully caught).
- FSM races are deliberately NOT errors: the conditional `UPDATE … WHERE status IN ('LIVE','SOS')` no-ops and returns `{ok:true}` — double-tap / ops-completed-first / drift janitor are all safe.

### Ranked root causes

**#1 — Session revocation (HIGH confidence, log-verified).** OTP login passes `evictOtherDevices=true` (`auth.service.ts:322`) — any fresh login of the same CPO account on a second phone/emulator revokes the mission device's jti (B-71's fix exempted only `web`; phone↔phone eviction is by design). Also one-strike refresh rotation (`auth.service.ts:94-101,336-337`; 15 min access TTL): one lost refresh response leaves a dead refresh token, and `api.ts:100` then **hard-clears both tokens** → the next Finish tap surfaces a raw 401-family alert. Staging logs show the exact pattern on the mission-running CPO `72fa6d91`: missions from device `7ca7ab44` (login 21:22), then fresh OTP logins on `417b3c4d` at 22:08:42 and 22:09:20 → first device revoked mid-mission. QA regularly hops the same account across devices, which is precisely the trigger.
_Fix direction:_ client should treat refresh-failure/`token_revoked` as an explicit re-auth flow (banner + OTP re-login) instead of a raw "Could not advance" alert; optionally a short server-side reuse-grace window on rotation.

**#2 — 15 s client timeout / deploy-window lost-200 (MEDIUM confidence).** The finish handler runs ~20-30 sequential Contabo→Supabase round trips on the legacy payout path before responding; staging auto-redeploys on every push to main (containers observed at 10-26 h uptime). Timeout or restart mid-call → client shows an error while the server completes anyway; the screen's reconciliation `load()` then shows COMPLETED — transient/cosmetic but reported as "cannot finish".
_Fix direction:_ respond right after the flip txn and settle asynchronously (UI already reconciles), or lengthen the timeout for this call.

**#3 — Uncaught post-commit `settleEscrowOnFinish` (LOW likelihood, HIGH impact).** `agent.service.ts:1556-1560` awaits it bare — a proof-gate (PostGIS) or `escrow_holds` UPDATE failure throws **after** the mission is COMPLETED: client sees an API error for a finish that landed, and **the escrow stays HELD** (stranded money until manual/reconciliation sweep). No occurrences in the current log window, but it is the only genuinely uncaught 500 on the path.
_Fix direction:_ wrap in the same best-effort catch as `disburseMissionPayout` and let `EscrowReconciliationService` sweep stranded holds.

**Ruled out:** FSM state races / double-tap (server no-ops), `not_assigned_to_mission`/`lead_only` (no delete path / deterministic), payout constraint or `cpo_pool` payee failures (fully caught; phantom-payee already fixed), attendance/checkout/time-window gates (none exist on this endpoint).

**Side finding (staging):** emulator GPS sits ~12,400 km from pickup, so every staging mission fails the proof gate with `never_reached_pickup,insufficient_telemetry,too_short` → `review_required` and escrow never auto-releases for test missions.

### Retest

Reproduce cause #1 deterministically: start a mission on device A, OTP-login the same CPO on device B, tap Finish on A → expect the raw 401 alert. After a fix, expect an explicit re-auth prompt instead. For #2, finish a mission during a staging deploy window and confirm the UI reconciles to COMPLETED without a scary alert.

---

## B-77 — Mapbox intermittent "load failed" / blank map · HIGH

**User symptom:** sometimes maps show "load failed" or a blank screen.

### Verdict

Not a fresh regression — no map-surface file changed since `11d3314` (2026-07-06). The intermittency is environmental exposure (network blips, token pressure, WebGL context loss) of a **long-standing zero-recovery design**: one failed fetch at map boot = permanently dead map.

### Map surfaces (all `WebView source={{html}}`, mapbox-gl v3.9.0 from CDN, token = `EXPO_PUBLIC_MAPBOX_TOKEN` baked at bundle time)

| Surface                                           | Screen                                                            | HTML builder                        |
| ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Live route (client)                               | `LiveTrackingScreen.tsx:46,473,681`                               | `bravoLiveRouteMapHtml.ts:118`      |
| Agent tracker (CPO)                               | `AgentLiveTrackerScreen.tsx:53,589-597,696`                       | `bravoAgentTrackerMapHtml.ts:248`   |
| Location picker                                   | `LocationPickerScreen.tsx:35,69-85,325`                           | `bravoLocationPickerMapHtml.ts:118` |
| VBG key points                                    | `VbgKeyPointsMap.tsx:7,30,65` (VBG Home/Nearby/GeoRisk)           | `vbgKeyPointsMapHtml.ts:82`         |
| Intel feed (Leaflet, unpkg+jsdelivr CDNs)         | `IntelFeedScreen.tsx:42,276-301`                                  | `bravoMapHtml.ts:18,117,167,169`    |
| Job marketplace/detail heroes (Static Images API) | `JobMarketplaceScreen.tsx:139-156`, `JobDetailScreen.tsx:337-341` | `src/modules/news/mapbox.ts:84-157` |

### Ranked root causes

**#1 — Zero recovery path at map boot (HIGH confidence, code defect).** Mapbox GL does **not** retry a failed style fetch; one failed request for `mapbox-gl.js`, the style JSON, or first tiles kills the map until remount. There is **no RN-side watchdog** waiting for the `'ready'` postMessage, and the HTML's own error posts are **dropped by RN**: `LiveTrackingScreen.tsx:551-556` and `AgentLiveTrackerScreen.tsx:581-587` handle only `'ready'`; `VbgKeyPointsMap.tsx:49` only `console.warn`s; `bravoAgentTrackerMapHtml.ts` has no `map.on('error')` at all; `bravoLocationPickerMapHtml.ts` has neither `map.on('error')` nor a WebGL guard. Compounding: on Android, react-native-webview 13.15.0 dispatches `onHttpError`/`onError` **only for main-frame failures** (`RNCWebViewClient.java:222-273`) — and the main frame is inline HTML that cannot fail — so LocationPicker's "Map failed to load — check your connection." + RETRY overlay (`LocationPickerScreen.tsx:356`) is effectively **unreachable on Android**. Users get the eternal "LOADING MAP…" (`:350` — cleared only by `'ready'`, no timeout) or a blank navy rectangle (LiveTracking/AgentTracker/VBG have no overlay at all). Matches "sometimes load failed, sometimes blank" exactly.
_Fix direction:_ RN-side watchdog (no `'ready'` in ~10-15 s → failed/RETRY overlay and/or bump `webViewKey` to remount) + handle the already-posted `err`/`error` messages on all four GL surfaces; optionally in-page style-retry on `map.on('error')`.

**#2 — One shared, committed, unrotated pk token (MEDIUM confidence).** The same token serves all mobile GL loads, per-card marketplace Static Images, geocoding, Directions, ops-console, and the auth-service backend (`.env:34`, `.env.production:10`, `eas.json:30`, `apps/ops-console/.env.local:6`, `apps/auth-service/.env:77`). Quota/rate events on any consumer degrade all of them, and a 401/403/429 renders as cause #1's **silent blank** because the GL error event is dropped. Token rotation is still an open item from the 2026-07-04 Mapbox audit.
_Fix direction:_ rotate, split tokens per consumer with URL restrictions, surface GL `error` events so 401 is distinguishable from offline.

**#3 — Per-build token baking divergence (LOW-MED confidence, binary per build).** `eas.json` **production profile has no `env` block** (`eas.json:51-57`); the `apk:staging`/`apk:dist` scripts pass API/Supabase vars inline but **omit `EXPO_PUBLIC_MAPBOX_TOKEN`** — it rides solely on `.env`/`.env.production` reaching `expo export:embed` (the exact class of the known baked-env gotcha, cf. `3c7f0f5`). A build where dotenv doesn't reach the subprocess bakes `token=''` → that APK's GL maps are 100% blank while other builds work — reads as "intermittent" across builds/testers. **Diagnostic tell:** if Job Marketplace heroes show the shield fallback instead of route thumbnails, the token is missing at bake time (`mapbox.ts:74-76`); heroes fine but GL maps blank → network/WebGL class.
_Fix direction:_ pin `EXPO_PUBLIC_MAPBOX_TOKEN` explicitly in production/apk env paths and assert-non-empty at boot.

**Secondary (log-worthy):** unguarded `new mapboxgl.Map()` + GL JS v3's WebGL2 requirement — context-creation failure (emulator/BlueStacks, GPU-process crash recovery, low memory) throws before any postMessage (blank, no message); the `mapboxgl.supported` guard at `vbgKeyPointsMapHtml.ts:81` is dead code in v3 (API removed) and always posts a spurious `gl-unsupported`; Intel map depends on unpkg + jsdelivr at runtime with no error state (`IntelFeedScreen.tsx:294-300`). Renderer-crash remount (`onRenderProcessGone`) is the one failure mode that IS handled on all surfaces.

### Retest

Airplane-mode the device, open Live Tracking → today: blank forever even after connectivity returns; after fix: RETRY/auto-remount recovers. Then `adb shell settings put global http_proxy 127.0.0.1:1` style tile-blocking to confirm the GL `error` path surfaces a message instead of silence.

---

## Cross-cutting notes

- B-75 must ship **before or with** the next APK: v1.0.107/vc133 (the rapid-burst build) carries the deadlock. Any device that hits one decrypt-recovery event stops persisting inbound messages until app restart — worse than the B-72 crash it replaced.
- B-76 #1 and the B-71 ops-console loop are the same root design (single-device takeover); the mobile leg was left by design, but the client-side error surfacing (raw alert, wiped tokens, no re-auth flow) is the actionable gap.
- B-77 is the third audit pass to flag token rotation; it is now also a triage-visible reliability issue, not just hygiene.

---

## Remediation — 2026-07-11 (same day)

All three fixed, then the diff was put through an adversarial multi-agent review (3 dimension reviewers → per-finding verification). The review surfaced **2 CONFIRMED findings, both on B-75** — the first-cut fix ran the recovery `saveIdentity` as raw autocommit, which dropped the P0-S6 atomicity of the `trusted_identities` UPSERT + `identity_rotations` INSERT (a real regression from pre-B-72). Both were fixed by switching context-2 to an atomic inline `BEGIN`. b76/b77 produced no confirmed findings.

### B-75 — FIXED (P0)

- `src/modules/messenger/runtime/receiveTransaction.ts`: `_onChainDepth` counter + `isOnTxnChain()` (set around a `runOnTxnChain` body), and a new `runRatchetTxnInline(db, work)` that opens `BEGIN IMMEDIATE`/`COMMIT` on the connection **without** appending to `txnChain` — only safe while `isOnTxnChain()` (the recovery frame holds the chain exclusively).
- `src/modules/messenger/crypto/sqlCipherStore.ts`: `saveIdentity` dispatches by context — (1) inside a receive txn → raw; (2) chain-resident recovery → `runRatchetTxnInline` (own atomic BEGIN; kills the deadlock **and** keeps the two writes atomic); (3) fully off-chain send → `runWithRatchetTxn`.
- Race-safety: `_txnOpen` is flipped **synchronously** before the inline `BEGIN` await, so the check-and-set is atomic on the event loop — a concurrently-interleaving off-chain `saveIdentity` sees the flag and joins (runs raw) instead of issuing a second, colliding `BEGIN`.
- Tests: 4 specs in `receiveTransaction.test.ts` (deadlock resolves; chain not frozen; `isOnTxnChain` scoping; **key-rotation atomicity** — UPSERT + rotation INSERT inside one BEGIN/COMMIT).
- Follow-up (not done): `identityBackup.ts:207` `reinstallIdentity` raw `BEGIN` — restore-time-only one-runner-doctrine violation; low risk, logged.

### B-76 — FIXED (server deploy pending)

- Client: `src/services/authError.ts` (`isAuthLostError`), `AssignedMissionDetailScreen.runAction` → clean sign-out on session loss, `api.ts missionComplete` timeout 30s.
- Server: `agent.service.settleEscrowOnFinish` best-effort + `log.error` (loud, since `EscrowReconciliationService` is read-only and won't auto-repair a stranded HELD hold).
- Tests: +1 server (`agent.mission-finish.spec.ts`), +4 client (`isAuthLostError.test.ts`).
- **Requires a Contabo `auth-service` deploy** for the server half.

### B-77 — FIXED

- `src/modules/maps/useMapReload.ts` (pure `mapHealthReducer` + hook), `src/modules/maps/MapFailedOverlay.tsx`; wired into `VbgKeyPointsMap`, `LiveTrackingScreen`, `AgentLiveTrackerScreen`, `LocationPickerScreen`; `vbgKeyPointsMapHtml.ts` `mapboxgl.supported` guard.
- Watchdog-driven (15s, one auto-remount, then RETRY) — deliberately not reacting to `map.on('error')` so a benign post-load tile 404 can't remount a working map.
- Tests: 7 `mapHealth.test.ts` specs. Token rotation + per-build env pinning remain open (pre-existing amplifiers).

### Gates

messenger-crypto 1588 tests green (1 pre-existing load-order flake suite), auth-service agent+escrow 382 green, booking 139 green, `isAuthLostError` 4/4, `mapHealth` 7/7; tsc **46 ≤ 47** baseline (stash-verified zero net new errors); ESLint clean on changed files.

### Remaining (manual)

- Rebuild + install the client APK (in progress: `npm run apk:staging` → Pixel 6a).
- Deploy the B-76 `auth-service` change to Contabo.
- On-device verify per the retest steps in each bug entry.
