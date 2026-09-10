# Warm-Start / Offline-First Remediation Spec — Opus 5 build doc

**Date:** 2026-08-15 · **Source:** 5-lane codebase audit vs the founder's warm-start spec
(startup, connection manager, sync/dedup, calls/notifications, persistence/auth).
**Branch at audit time:** `fix/calling-b419-b427`.

> **This was a BUILD SPEC. 10 of 17 fixes are now IMPLEMENTED** (2026-08-15,
> branch `fix/calling-b419-b427`, four commits `408625d3`, `6830bcd0`,
> `5a8ea10c`, `390125e5`). Line numbers were accurate on 2026-08-15 and go stale
> fast — **re-grep every symbol before editing** (MESSAGE_LOOP rule).

## STATUS — 2026-08-15

| Fix                                      | State                                          | Commit     |
| ---------------------------------------- | ---------------------------------------------- | ---------- |
| FIX-01 tokens → keychain                 | ✅ DONE                                        | `408625d3` |
| FIX-02 offline boot / claims session     | ✅ DONE                                        | `408625d3` |
| FIX-03 offline-aware reconnect           | ✅ DONE                                        | `6830bcd0` |
| FIX-04 relay tuple cursor + ack logging  | ⛔ NOT DONE — arch-gated                       | —          |
| FIX-05 SYNCING→SYNCED signal             | ✅ DONE (UI signal only — see round-2 note)    | `6830bcd0` |
| FIX-06 unread recompute from SQL         | ⛔ NOT DONE — schema v21                       | —          |
| FIX-07 durable `call.answer`             | ✅ DONE (needs deploy)                         | `390125e5` |
| FIX-08 app-wide connection indicator     | ⛔ NOT DONE — design-gated                     | —          |
| FIX-09 conversation metadata → SQLCipher | ⛔ NOT DONE — schema v21                       | —          |
| FIX-10 persist directory names           | ⛔ NOT DONE — rides FIX-09                     | —          |
| FIX-11 boot probe budget                 | ✅ DONE                                        | `390125e5` |
| FIX-12 lock fails closed                 | ✅ DONE                                        | `5a8ea10c` |
| FIX-13 housekeeping                      | ✅ DONE (mmkv left)                            | `5a8ea10c` |
| FIX-14 stale-ring hygiene                | ✅ DONE                                        | `5a8ea10c` |
| FIX-15 call-state probe                  | ⛔ NOT DONE — arch-gated, needs a server route | —          |
| FIX-16 1:1 cold-start runtime kick       | ✅ DONE                                        | `390125e5` |
| FIX-17 iOS tap route                     | ⛔ NOT DONE — device-blocked (B-122/B-239)     | —          |

**Gate state at the last commit:** mobile typecheck 44 (baseline 47);
messenger-service 587/587; messenger-crypto run twice with only the two failures
that were already red on HEAD (`restoreStreamingWalk`,
`transportClientSocketIo`) plus one suite that MOVES between runs (the known
B-126 flake); app messenger screens only `companyShelfWorkspaceScope`, also red
on HEAD.

**NOTHING was device-verified — no build was produced this session.** Each
commit message lists the device checks it owes. The founder's standing rule
means these are not done until exercised on hardware.

### Audit round 2 — 2026-08-15, same session

An adversarial review of the whole range (10 finder lenses + 3 verifiers) plus a
manual regression sweep produced **13 verified findings; 12 were fixed the same
day, 1 accepted with rationale**. The serious ones, so nobody re-learns them:

1. **FIX-03's park could stick forever** on networks where Android's
   connectivity validation never succeeds (the 204-probe endpoint firewalled:
   corporate/hotel networks) — `isInternetReachable` stays false, the only
   un-park lane never fired, and the messenger was dead until app restart on a
   network class where the old B-14 ladder reconnected fine. Fixed three ways:
   `netOnline = true` moved ahead of the positive branch's early-returns, an
   un-park escape hatch on `isConnected` alone **while parked** (the handshake
   itself is the reachability probe), and the resume park branch now spends one
   `NetInfo.fetch()` instead of trusting the stale flag.
2. **Parking flipped a healthy socket's state to `disconnected`**, which made
   the correcting NetInfo event force-rebuild it (pongFresh reads
   `state === 'connected'`) — the exact churn the filter exists to prevent.
   Park no longer touches a connected socket's state.
3. **FIX-12 had fixed only the boot read** — the AppState-resume re-lock still
   ran the old `getItem().catch(() => null)` fail-open and overwrote the
   correct in-memory state. Both paths now share one module-scoped resolver.
4. **notifee's `date` is a STRING on Android** (native `putString`), so the
   sweep's age lane was dead code on device and its test passed vacuously with
   a number fixture. Coerced; fixture now feeds device-shaped strings.
5. **The durable-answer rehydrate left the session at `ringing`+`rehydrated`**,
   so `gcCallTombstones` force-ended the LIVE call at 300s. A delivered answer
   now runs `trackCallAnswer` (promote to active + link the socket).
6. **`sessionUnverified` was only cleared by `applyMe`** — `recheckMembership`
   (the promised healer once the revalidate ladder expires) installed the
   verified user without clearing it, permanently disabling snapshot
   persistence for the process (self-perpetuating degraded boots). Every
   server-authoritative user install now clears it.
7. **tokenVault's failed-write shadow**: a keystore write failure during
   rotation left the OLD pair in the keychain shadowing the NEW pair in
   legacy storage → 401 storm → forced sign-out. New invariant: legacy
   presence wins (it is newer by construction) and re-migration self-heals.
   Two further stale-load races (set/clear vs in-flight load) fixed with an
   epoch guard.
8. **FIX-02's degraded boot ran the messenger on a degenerate `user.id`
   ownerKey** when no pin existed — messages received that boot landed in a
   DB orphaned forever once the real key was pinned. The messenger configure
   now defers entirely on an unpinned degraded boot and re-runs when
   verification lands (`sessionUnverified` added to the effect deps).
9. **FIX-05 honesty**: the spec table said DONE, but the tap-route 6s race in
   `fcmBootstrap` was never rewired — deliberately left: `startTapTimePull()`'s
   promise already resolves on drain completion, so the 6s is a CAP on a hung
   pull, not a blind guess; `syncState` was only ever needed by the UI. The
   table now says "UI signal only". Also: ChatScreen's `syncState`
   subscription re-rendered a populated chat twice per drain cycle — now
   pinned to 'synced' whenever messages exist.
10. **Accepted, not fixed**: while signed out the first token read still runs
    the full B-15b retry ladder (~300ms) — softened with a `knownEmpty`
    fast-path (after one authoritative-empty pass, later reads skip the
    sleeps), but the first pre-auth request per process keeps the ladder:
    correctness against flaky keystores outranks 300ms once per boot.

Also fixed in round 2: the stale-ring sweep is now wired on **foreground**
(AppState active) as its contract required, not just boot; and the FIX-14
mirror flag updates at Settings-toggle time.

### Why the remaining 7 were not attempted

- **FIX-04 / FIX-15** are the two genuine architecture-gated items. FIX-04
  changes the relay pull cursor (dwell/ack/envelope-ID semantics are a CLAUDE.md
  stop condition) and FIX-15 adds a new call-state route that exposes ring-window
  metadata. Both need the System Architecture Documentation checked first, and
  both need a coordinated messenger-service deploy. FIX-04 is also the structural
  root of B-262 and deserves its own session.
- **FIX-06 / FIX-09 / FIX-10** all want SQLCipher schema v21 and should land as
  ONE migration, not three. FIX-09 additionally changes what the chat list paints
  on the first frame, which is exactly the warm-start property the founder cares
  about — it needs a device pass, not a green suite.
- **FIX-08** is design-gated (`DESIGN_REVIEW_LOOP.md`) and its main risk is a
  false "Offline" for Secure-only users who have no messenger runtime at all.
- **FIX-17** cannot be verified: the iOS lane is blocked on an Apple
  developer-account action (B-122) and staging VoIP tokens (B-239). Landing
  unverifiable iOS code would be the same mistake as the "skeleton" header
  FIX-13 just corrected.

---

## 0. How to run this doc — the per-fix 3-agent loop

For **each** FIX-NN, spawn three Opus 5 agents and iterate until convergence:

| Agent                | Role                                                                              | Contract                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Editor**           | Senior engineer. Implements the fix exactly as scoped, minimal diff, repo idioms. | Writes the failing regression test FIRST (RED), then the fix (GREEN), then mutation-proves the test by reverting the fix. Runs the fix's Gates before handing off.                                                                                                                         |
| **Critic**           | Adversarial reviewer. Assumes the Editor's diff is wrong.                         | Re-derives the fix from the evidence; runs the CLAUDE.md self-diff rule — for every piece of state the diff deletes/moves/rewrites, enumerate live consumers first; runs the MESSAGE_LOOP §5 caller-completeness sweep on every shared symbol touched. Rejects with specifics or approves. |
| **Edge-Case Hunter** | Hostile QA. Ignores the happy path entirely.                                      | Walks the fix's "Edge cases" list PLUS invents new ones (offline, mid-kill, race, headless JS context, token expiry mid-flow, storage write failure). Each edge case must map to a test or an explicit documented non-goal.                                                                |

**Convergence:** loop Editor → Critic → Edge-Case Hunter until BOTH reviewers pass the
same diff with zero new findings. Then run the global gates (below). Do not batch
fixes into one diff — one FIX-NN per loop, one commit per fix.

### Global guardrails (apply to every fix — from CLAUDE.md, non-negotiable)

1. **Messenger gate:** any touch of `src/modules/messenger/**` or `src/screens/messenger/**` →
   `npx jest --selectProjects messenger-crypto` **twice** (flake rule B-126/B-153) AND
   `npx jest --selectProjects app --testPathPattern "screens/messenger"`. 100% green.
2. **Typecheck baseline:** `npm run typecheck` must not exceed 47; ops-console has its own baseline.
3. **Security stop conditions:** FIX-04 and anything touching relay dwell / ack tokens /
   envelope IDs / auth tokens / sealed-sender is **arch-gated** — verify against the System
   Architecture Documentation BEFORE writing code. Never weaken `verifyMerkleCommit`,
   `verifySenderCert`, or any existing check.
4. **Regression contract (B-143+):** a bug is not fixed until a test would catch it coming
   back, proven RED first. Static source scans must strip comments, use `\r?\n` (files are
   CRLF), and anchor on the shape the code uses.
5. **No test imports `productionRuntime.ts`** — a green suite is NOT evidence for changes
   there. Manual smoke (boot, 1:1 send/recv, group send/recv) is part of the gate; since
   this session is **no-build**, the Editor must list the exact device-verify steps owed.
6. Never log plaintext bodies, key material, or token values — `logAudit.test.ts` enforces.

---

## 1. Verdict vs the founder's spec — do we have all?

| Spec § | Requirement                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | UI renders immediately from local state                  | **PARTIAL** — yes with `auth:user_snapshot`; snapshot-less boot blocks on `/auth/me` (FIX-02)                                                                                                                                                                                                                                                                                                                                                              |
| 2      | WS init in background after render                       | **YES** — `void transport.connect()` (`productionRuntime.ts:1665`), mutation-pinned                                                                                                                                                                                                                                                                                                                                                                        |
| 3      | Single global connection state                           | **PARTIAL** — 6-state union exists; no AUTHENTICATING/SYNCING; banner on only 2 screens (FIX-05, FIX-08)                                                                                                                                                                                                                                                                                                                                                   |
| 4      | Offline launch usable                                    | **PARTIAL** — no crash; snapshot-less lane bounces to login (FIX-02); backupBoot 30 s hold (FIX-11)                                                                                                                                                                                                                                                                                                                                                        |
| 5      | Background reconnection (backoff+jitter, no dup sockets) | **YES** backoff/jitter/cap + 3-layer single-socket; **NO** offline pause (FIX-03)                                                                                                                                                                                                                                                                                                                                                                          |
| 6      | Background→foreground resume                             | **PARTIAL** — reconnect+drain+receipts yes; never consults NetInfo (FIX-03)                                                                                                                                                                                                                                                                                                                                                                                |
| 7      | Missed-event sync w/ server-authoritative cursor         | **PARTIAL** — relay mailbox works; cursor is a raw ms timestamp, no seq, no gap detection (FIX-04)                                                                                                                                                                                                                                                                                                                                                         |
| 8      | No duplicate messages                                    | **YES** — 4 dedup layers incl. SQL UNIQUE on `envelope_id` (strongest area)                                                                                                                                                                                                                                                                                                                                                                                |
| 9      | Local persistence, secrets in secure storage             | **FAIL on secrets** — JWTs in plain AsyncStorage (FIX-01); convo metadata/PII plaintext (FIX-09)                                                                                                                                                                                                                                                                                                                                                           |
| 10     | Auth restoration, offline ≠ logout                       | **PARTIAL** — expired-vs-transient distinction exists but only on the snapshot path (FIX-02)                                                                                                                                                                                                                                                                                                                                                               |
| 11     | Server health ≠ app availability                         | **YES** — no blocking modal anywhere on the boot path                                                                                                                                                                                                                                                                                                                                                                                                      |
| 12     | Messenger opens from cache                               | **YES** — list+unreads from persisted vault; previews show `(encrypted)` until SQLCipher hydrate (accepted, MSG-10 security)                                                                                                                                                                                                                                                                                                                               |
| 13     | Calls: native push, state validation, no resurrection    | **PARTIAL** — killed-app Android ring is fully WS-free (data-FCM → notifee FSI + native ringtone); answer still needs the WS (correctly gated, but unvalidated — FIX-15); no boot stale-ring sweep, ring handler skips dead-call checks (FIX-14); iOS chain wired but unverified (B-122 BLOCKED, B-239)                                                                                                                                                    |
| 14     | Notification tap doesn't wait for WS                     | **YES** — tap-time pull w/ 6 s race (the race itself is the smell → FIX-05)                                                                                                                                                                                                                                                                                                                                                                                |
| 15     | Network changes                                          | **PARTIAL** — Wi-Fi↔cell handled + captive-portal noise filter; no offline branch (FIX-03)                                                                                                                                                                                                                                                                                                                                                                 |
| 16     | Lifecycle                                                | **YES** Android; iOS background modes missing (B-109, OPEN P0 — out of scope here, logged)                                                                                                                                                                                                                                                                                                                                                                 |
| 17     | NestJS sync endpoint                                     | **PARTIAL** — `GET /envelopes?after=<ms>` + WS `envelope.pull`; no seq cursor (FIX-04); ack/submit idempotent                                                                                                                                                                                                                                                                                                                                              |
| 18     | One connection manager                                   | **YES** — `TransportClient` singleton, B-152 test-pinned                                                                                                                                                                                                                                                                                                                                                                                                   |
| 19     | Stress tests                                             | 1–4 pass on the warm path (Test 2 fails on the snapshot-less lane → FIX-02). Test 5 **PASS** (tap-time pull, navigate-first, `fcmBootstrap.ts:1627,1684-1700`). Test 6 **PARTIAL** (ring yes; answer can sit 45 s on a dead call → FIX-15). Test 7 **mostly PASS** (1:1 ICE-restart w/ 30 s budget, group re-join with resurrection gate, duplicate-session guards) — residue: replayed `call.offer` resurrection relies on server tombstone only → FIX-14 |

**Open bugs that ARE this spec:** B-262 (P0, message ACKed+deleted, never rendered),
B-109 (P0, iOS lock kills socket), B-352 (fixed, device-verify owed), B-438 residuals.

---

## 2. Fix list (ranked)

---

### FIX-01 · P0 · Auth tokens out of plain AsyncStorage

**Files:** `src/services/api.ts:269-278` (`tokenStore`), ~28 direct `auth:access_token`
readers (`services/supabase.ts:51`, `navigation/MainNavigator.tsx:521`,
`push/fcmBootstrap.ts:2057`, `push/voipPush.ts:207`, `push/headlessDrain.ts:148`,
`push/pendingActions.ts:127`, `push/serverWakeNotifications.ts:55`,
`backup/backupClient.ts:34`, `vault/vaultOps.ts:27`, `webrtc/agoraStart.ts:25`,
`store/activitySync.ts:117,160`, …). Keychain helper: `src/modules/messenger/runtime/keychain.ts:82-119`.

**Problem:** JWT access + refresh tokens live in plain AsyncStorage (Android
SharedPreferences/RKStorage — readable by any file-level forensic path), while every
other secret uses react-native-keychain with `SECURE_HARDWARE`. Spec §9 explicitly fails.

**Required behavior:** tokens stored via keychain (same discipline as
`bravo.messenger.dbkey.*`); ALL readers go through `tokenStore` (no direct AsyncStorage
key access anywhere); silent one-time migration of existing tokens; headless/killed-app
JS contexts (fcmHeadless, headlessDrain, voipPush) still able to read tokens.

**Editor brief:**

- First: land a static source-scan test that fails on any `auth:access_token` /
  `auth:refresh_token` literal outside `api.ts` (CRLF-safe, comment-stripped) — RED now.
- Convert `tokenStore` internals to keychain (generic-password, service e.g.
  `bravo.auth.tokens`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — NOT passcode-gated: headless
  drain runs before first unlock is not acceptable to break; verify keychain access from
  a headless context on Android before choosing the accessibility class).
- Migration: on first `get()`, if keychain empty and AsyncStorage has tokens → move, then
  `multiRemove` the old keys. Idempotent, race-safe (single-flight).
- Sweep all 28 readers to `tokenStore.get()`; delete the raw literals.

**Critic brief:**

- Enumerate every consumer of the two AsyncStorage keys (grep, not the list above) —
  prove each is migrated or unaffected. This is a B-339-class deletion; the caller sweep
  is the whole review.
- Keychain reads are async and slower than AsyncStorage: check the request interceptor
  (`api.ts:108`) hot path — cache the access token in memory with invalidation on
  `set()`/`clear()`, or measure that per-request keychain reads don't regress send latency.
- Verify logout (`emitAuthLost`, `multiRemove` at `api.ts:232-243`) clears the keychain
  entry too — a stale keychain token resurrecting a session is a sev-1 regression.

**Edge-Case Hunter brief:**

- Headless FCM context before first device unlock (keychain accessibility!). Kill the app,
  send a push, verify drain still authenticates.
- Migration races: two JS contexts (foreground + headless) migrating simultaneously.
- Keychain write failure mid-migration (old keys already removed?) — must not strand the
  user logged out; order = write new, verify readback, then remove old.
- Backup/restore of Android app data: keychain doesn't restore — document that this
  forces re-login after device transfer (expected, but state it).
- Token refresh single-flight (`api.ts:138,163-166`) under the new async store.

**Gates:** new scan test + `authStore.initialize` tests; messenger gate (fcmBootstrap/
headlessDrain touched); typecheck; device-verify owed: killed-app push drain + logout/login.

---

### FIX-02 · P1 · Snapshot-less offline boot must not bounce a valid session to login

**Files:** `src/store/authStore.ts:303-330` (esp. `:316 await applyMe()`),
`src/navigation/index.tsx:56-85`, snapshot writer `authStore.ts:931-941`,
test `src/store/__tests__/authStore.initialize.test.ts`.

**Problem:** with tokens present but no `auth:user_snapshot` (fresh build upgrade,
snapshot write blip, shape-check rejection at `:84`), boot blocks on `/auth/me`
("Verifying session…", up to 15 s axios timeout) and, offline, lands on the Auth stack
with `isAuthenticated=false` — despite valid tokens. The transient-vs-401 distinction
exists (`:307-312`, `:322-327`) but is unreachable without a snapshot.

**Required behavior:** offline/transient `applyMe` failure with tokens present →
authenticated-degraded boot (decode minimal identity from the JWT claims if they carry
`id`/`role`, else a "limited" landing that retries), background re-verify; only a
definitive 401/403 signs out. Snapshot write becomes verified (readback) instead of
fire-and-forget `.catch(()=>{})`.

**Editor brief:**

- Extend `initialize()`: on snapshot-miss, attempt JWT-claims fallback (check what the
  access token actually carries — inspect `apps/auth-service` JWT payload first; do NOT
  invent claims). If claims suffice for `RootNavigator` routing (`id`, `role`), set
  authenticated + fire background `applyMe` exactly like the snapshot path.
- If claims are insufficient: keep the blocking path but cap it (e.g. 4 s race), and on
  timeout render an authenticated shell with a retry loop rather than AuthNavigator.
- Flip the existing test at `authStore.initialize.test.ts:137` ("no snapshot + transient
  failure → unauthenticated") to the NEW contract — this is the RED-first test.

**Critic brief:**

- The routing payload is rich (`account_kind`, `permitted_modules`, `workspaces`,
  `managed_org` — `authStore.ts:103-121`): verify which screens crash or mis-route on a
  claims-only user object. Every consumer of `user.*` on the boot path must tolerate the
  degraded shape or be gated.
- Security: confirm this cannot resurrect a REVOKED session — the background `applyMe`
  401/403 teardown (`:307-312`) must still fire and fully sign out mid-session.
- Check `biometricSignIn` (`authStore.ts:464-466`) interaction — it is network-mandatory.

**Edge-Case Hunter brief:**

- Expired access token + valid refresh token + offline (refresh fails transiently).
- Tokens present, snapshot present but shape-rejected (`:84`) — should now take fallback.
- Airplane-mode boot → connectivity returns 30 s later: does the degraded session heal
  without user action (listener on network regain or applyMe retry)?
- Role-change server-side while offline (agent → client): stale claims routing.
- Snapshot write failing forever (full disk): app must still work every boot via fallback.

**Gates:** authStore tests; app-project boot tests; typecheck; device-verify owed:
airplane-mode cold boot after clearing only `auth:user_snapshot`.

---

### FIX-03 · P1 · Offline-aware reconnect (pause when down, and consult NetInfo on resume)

**Files:** `src/modules/messenger/runtime/productionRuntime.ts:1685-1750` (NetInfo
listener — positive branch only), `:1821-1905` (AppState handler),
`packages/messenger-core/src/transport/client.ts:578-597` (`notifyNetworkChange`),
`:1156-1194` (B-14 reconnect timers), `:867-875` (socket.io options).

**Problem:** spec §5 "stop/reduce retries when genuinely offline" — there is no offline
branch anywhere: while the radio is down the client burns socket.io handshake attempts at
the 30 s ceiling plus the B-14 timer. And the AppState-active resume decision
(`decideResumeAction`) reads only `pongFresh` + `hasLiveCall()`, never NetInfo.

**Required behavior:** on NetInfo offline → transport enters a parked state (suspend
B-14 timer + socket.io reconnection, state stays `reconnecting`/`disconnected` for UI);
on regain → existing `notifyNetworkChange()` path (already correct). AppState-active
consults NetInfo before choosing probe/reconnect (skip a doomed handshake, park instead).

**Editor brief:**

- Add `notifyOffline()` (or a `setNetworkAvailable(bool)`) to `TransportClient`:
  cancels `reconnectTimer`, disables socket.io auto-reconnect while parked
  (`io.opts.reconnection=false` or disconnect+flag), records `parkedForNetwork=true`;
  `notifyNetworkChange()` clears it and force-reconnects (mostly existing code).
- Wire the negative branch in the NetInfo listener (`productionRuntime.ts:1685-1747`) —
  keep the existing captive-portal noise filter (`:1723-1725`) and the live-call
  server-silence judgment (`:1733-1740`) EXACTLY as is.
- In the AppState handler, feed `netinfo.isConnected===false` into `decideResumeAction`
  (`callResumeGuard.ts:45`) as a new input → `park`, not `reconnect`.

**Critic brief:**

- NetInfo lies (captive portals, Android chattiness — the code already distrusts it at
  `:1723`). Parking on a FALSE offline reading while a call is live is worse than the bug:
  verify `hasLiveCall()` overrides parking, and that the immediate-reopen floor for
  unacked sends (`client.ts:704-708`) still fires once network returns.
- `messenger-core` is shared with ops-console — confirm the new TransportClient surface
  is optional/no-op when the host never calls it (web has `navigator.onLine`, not NetInfo).
- Caller sweep on `decideResumeAction` (it has its own tests + callers).

**Edge-Case Hunter brief:**

- Offline → app backgrounded → network returns while backgrounded → foreground: parked
  flag must not survive into a dead state (resume path must re-check NetInfo fresh).
- Rapid flap (Wi-Fi↔cell↔off in <5 s): no timer leak, no double-park, single socket
  (generation counter still holds).
- NetInfo module missing (web/test fallback at `:1746-1750`) → feature must no-op.
- `isInternetReachable === null` (unknown) must be treated as ONLINE (current semantics).
- Parked while an `auth.refresh` was in flight — no stuck `REAUTH_STUCK_MS` state.

**Gates:** messenger-core transport tests (`transportReconnect`, `transportSingleFlight`,
`socketReauth` — all must stay green ×2); new park/unpark test; messenger gate.

---

### FIX-04 · P1 · Relay drain cursor + B-262 diagnosability ⚠️ ARCH-GATED

**Stop condition:** touches relay envelope handling and ack semantics — verify against
the System Architecture Documentation before ANY code. Do not change dwell, ack-token, or
envelope-ID semantics; this fix is paging + logging only.

**Files:** server `apps/messenger-service/src/relay/envelope.store.ts:182-216` (exclusive
ms-score `zrangebyscore`), `envelope.controller.ts:144-176`, gateway workaround
`messenger.gateway.ts:936-945`; reference tuple cursor `backup/backup.service.ts:1721-1744`;
client `productionRuntime.ts:9689-10129` (`drainRelay`, stuck-head step-past `:10087-10103`);
ack disposition `envelope.service.ts:410-490`, client `runtime/ackDisposition.ts:25`.

**Problem:** (a) the pull cursor is a raw epoch-ms with an EXCLUSIVE lower bound —
same-millisecond siblings at a page boundary are skipped for the rest of a drain run
(server side has a −1 ms step-back workaround; the client B-315 step-past does not);
(b) B-262 (P0 OPEN: message ACKed → hard-deleted → never rendered) is undiagnosable
because ack dispositions are not logged server-side.

**Required behavior:** tuple cursor `(timestamp, envelopeId)` on `GET /envelopes` and WS
`envelope.pull` exactly like the sealed-archive endpoint already does; client threads the
tuple through `drainRelay` including the stuck-head path; server logs one structured line
per ack: `{envelopeId, disposition, recipient, deviceId}` (IDs only — never content).

**Editor brief:**

- Server: extend the ZSET page to `(score, member)` ordering — fetch with inclusive score
  then filter `envelopeId > cursorId` for equal scores (mirror `backup.service.ts:1721-1744`).
  Keep `after=<ms>` working unchanged when no `afterId` is supplied (older clients!).
- Client: `drainRelay` carries `{cursorTs, cursorId}`; stuck-head step-past sets both.
- Ack logging: one `logger.log` in `envelope.service.ts` ack path with disposition —
  check `logAudit` rules, no payload fields.
- Backward compat is the whole game: old client + new server, new client + old server
  (staging deploys lag) must both behave exactly as today.

**Critic brief:**

- Prove no change to deletion semantics: ack still hard-deletes, dwell TTL untouched,
  possession-token check untouched (`:435-446`). Diff the ack function line-by-line.
- The gateway's `flushPendingOnConnect` −1 ms step-back (`:936-945`) becomes redundant —
  but do NOT remove it this pass (belt over suspenders; removal is a separate change).
- Redis ZSET member ordering for equal scores is lexicographic by member — verify
  envelope IDs (UUIDs) compare consistently between Redis ordering and the `>` filter.

**Edge-Case Hunter brief:**

- 1000 envelopes in the same millisecond (burst test) across a page boundary.
- Cursor envelope acked/expired between pages (tuple points at a deleted member).
- Mixed fleet: v(N) client against v(N+1) server and vice versa, plus the headless-drain
  context which persists no cursor (starts at 0 — must stay correct).
- `bootstrap=true` first-drain cap interaction (20 pages × 1000 server, 10 iters client).

**Gates:** messenger-service jest (`envelope.service`/gateway specs); client drain tests;
messenger gate ×2; ARCH sign-off recorded in the commit message.

---

### FIX-05 · P2 · A real SYNCING→READY signal (kill the 6-second guess)

**Files:** `productionRuntime.ts:9689-9754` (`drainRelay` returns void; empty page =
caught-up at `:9745-9754`), coalescer `:1615-1638`, store `messengerStore.ts:116-124`
(`ConnectionState`) + `:1561-1563`, consumer to fix: `push/fcmBootstrap.ts:1031-1056`
(tap-time pull `Promise.race` vs 6 s timeout), UI `ui/chatScreenLogic.ts:73-91`.

**Problem:** nothing publishes "drain finished / caught up", so notification-tap flows
race a 6 s timer, and an empty thread is indistinguishable from a still-draining one.
Spec §3 asks for a SYNCING state.

**Required behavior:** a store-level `syncState: 'idle'|'syncing'|'synced'` (do NOT
overload the transport `ConnectionState` union — it is messenger-core-shared and
test-pinned) set by the drain coalescer: `syncing` on drain start, `synced` on the
empty-page signal, back to `syncing` on any later drain. `startTapTimePull` awaits the
real completion (with the 6 s as a fallback cap, not the primary mechanism).

**Editor brief:**

- Emit from ONE place — the coalescer wrapper, not each of the five trigger sites.
- `drainRelay` resolves a `{caughtUp: boolean}` instead of void; coalescer maps it in.
- ChatScreen empty-state: "Syncing…" instead of "No messages" while `syncing` and the
  thread is empty (check `chatScreenLogic.ts` status builder; design tokens obsidian).
- Replace the `Promise.race` at `fcmBootstrap.ts:1051-1056` with await-on-synced + cap.

**Critic brief:**

- The coalescer collapses concurrent drains — verify re-run latching can't leave
  `syncing` stuck forever on a swallowed error (`pullEnvelopes` swallows at `:6334-6350`);
  every exit path must settle the state.
- Headless context: must NOT touch the store (store may be un-hydrated — B-361/B-363
  class); gate the publisher on foreground runtime.

**Edge-Case Hunter brief:**

- Drain error mid-page (network drop): state must resolve (to `idle`/`syncing`-retry, not
  stuck `syncing`).
- Reconnect during an in-flight drain (coalescer re-run) — exactly one terminal state.
- Cold start with `bravo.relay.bootstrap-done` unset (first-ever 1000-cap drain) — the
  long path is precisely where the signal matters; verify no premature `synced`.

**Gates:** new coalescer/syncState tests; messenger gate ×2; screens/messenger app tests.

---

### FIX-06 · P2 · Unread counts: one source of truth + self-heal

**Files:** `messengerStore.ts:1018` (increment), `:789`, `:1304` (zeroing), dedup-return
`:839/:845`; hydration seeds zero (`runtime/runtime.ts:949,968,1040`,
`groupConversationUpsert.ts:49,95`); badge sum `push/mutedLookup.ts:229-243`,
`push/backgroundMessageNotifier.ts:280`; backup mirror `backup/mirrorBootstrap.ts:92`,
`restoreMessages.ts:344`.

**Problem:** unread is a store counter persisted to AsyncStorage, never recomputed from
the SQLCipher DB; headless increments race the debounced persist; the notification badge
is a SECOND independent sum. Drift has no heal path (spec: "unread counts synchronize
correctly").

**Required behavior:** messages table carries a read watermark per conversation (or a
`read_at` fold), boot hydration recomputes `unread_count` from SQL instead of seeding 0/
trusting the vault blindly, and the badge derives from the same computation.

**Editor brief:**

- Smallest schema-true design: persist per-conversation `last_read_ts` (new SQLCipher
  table or column — schema v21, forward-only migration per `db.ts:879-1081` pattern) set
  where the store zeroes today (`:789`, `:1304`).
- Boot: `unread = COUNT(messages WHERE conversation_id=? AND created_ts > last_read_ts AND direction='in')`
  during the existing `loadRecent` hydrate — reconcile INTO the store one-commit
  (`hydrateMessages` invariant, N-30 referential stability must hold).
- Point the badge sum at the store's reconciled values instead of a parallel count.

**Critic brief:**

- One-commit hydration + referential stability are test-pinned
  (`bootstrapDrainYield.test.ts:181-226`) — the reconcile must not add a second `set`.
- Muted/active-thread suppression (`:1014-1017`, `activeConversationId`) must survive:
  the SQL recompute runs at boot when no thread is active, but verify a notification-tap
  boot straight into a chat doesn't double-zero or flash a count.
- Backup mirror carries `u:` (unread) — decide and document precedence on restore
  (mirror value vs recompute; recompute should win post-restore).

**Edge-Case Hunter brief:**

- Headless ingest of 5 messages while app killed → boot → recompute matches 5; then tap
  the thread → zero everywhere including badge.
- Disappearing messages expiring below the watermark.
- Restore-from-backup then live drain (both paths writing counts).
- Clock skew: `orderingClock` clamps sender time — recompute must use the same stored ts
  the UI orders by, not raw sender ts.

**Gates:** schema migration test; store tests; messenger gate ×2; device-verify owed:
kill-app burst → badge/count/list agree.

---

### FIX-07 · P2 · `call.answer` durability (server) — match its siblings

**Files:** `apps/messenger-service/src/gateway/messenger.gateway.ts:2998-3009`
(`flushPendingAnswers` — in-process `Map`); Redis-durable siblings: call.offer/missed
(`:641-668`, `:677-760`), group ring `:628`; store patterns `relay/envelope.store.ts:378-424`.

**Problem:** every recoverable call event is Redis-durable EXCEPT `call.answer`, which
lives in a per-process Map — lost on service restart or when the caller's reconnect lands
on a different replica. Caller rings forever against an answered call.

**Required behavior:** pending answers stored in Redis with a short TTL (an answer is
only meaningful within the ring window — mirror the offer's ring TTL), peek→emit→settle
drain on the caller's reconnect, exactly like the missed-call lane.

**Editor brief:**

- Copy the `delivered-pending` store shape (`envelope.store.ts:378-403`): key per
  recipient+device, TTL = ring window, cap small (answers are rare).
- Replace the Map read in `flushPendingAnswers` with the Redis drain; keep emit ordering
  vs `call.offer` flush (answer must never arrive before its offer on a cold flush).
- This is server-only — no client change, no envelope semantics touched.

**Critic brief:**

- Multi-replica: confirm the WS adapter (Redis) vs this store don't double-emit when both
  replicas flush; settle must be atomic (GETDEL pattern like `:342-362`).
- TTL choice: an answer for an already-timed-out call must NOT resurrect UI ("stale calls
  cannot be resurrected" — spec final criteria). Cross-check the client's stale-answer
  guard before assuming one exists.

**Edge-Case Hunter brief:**

- Answer arrives while caller offline → caller reconnects after ring timeout → must get
  call-ended semantics, not a live answer.
- Both legs on different replicas; service rolling restart mid-ring.
- Duplicate answer (answerer retries) — idempotent settle.

**Gates:** messenger-service gateway specs (add answer-durability spec); no client gates.

---

### FIX-08 · P2 · App-wide connection indicator

**Files:** `src/modules/messenger/ui/ConnectionBanner.tsx` (mounted only at
`ChatScreen.tsx:1820`, `MessengerHomeScreen.tsx:658`); state source
`messengerStore.ts:116-124`; unrelated NetInfo label `DashboardScreen.tsx:229-234`.

**Problem:** outside two messenger screens the user has zero connectivity feedback
(spec §11: subtle indicator, never blocking). Dashboard rolls its own NetInfo label.

**Required behavior:** one global, subtle, non-blocking indicator (top strip) driven by
the transport state + FIX-03's parked/offline knowledge, mounted once at the navigator
shell level; Dashboard's ad-hoc label folds into it.

**Editor brief:** DESIGN-GATED — read `DESIGN_REVIEW_LOOP.md` first; obsidian `#07090D`/
cobalt `#5B8DEF` tokens; mount in `MainNavigator` shell above the tab bar or under the
header, NOT per-screen; reuse `ConnectionBanner` copy/animation; respect safe-area via
the `useKeyboardLayout`/safe-area rules (no hand-rolled insets).

**Critic brief:** messenger store is owner-scoped — verify the banner reads a safe
selector when signed out / non-messenger products (Secure-only users have no runtime:
banner must not show "Offline" when the messenger runtime simply isn't booted). That
false-positive is the main way this fix ships a regression.

**Edge-Case Hunter brief:** product-gate screen (no tabs), full-screen call UI (banner
must not overlay call controls — calls have their own ReconnectingOverlay), keyboard up
(inset rule), fontScale 1.3, foldable width.

**Gates:** app-project render tests incl. keyboardContract; design review loop pass.

---

### FIX-09 · P2 · Conversation metadata out of plaintext AsyncStorage

**Files:** `messengerStore.ts:1830-1896` (persist vault: names, `phoneE164`, rosters,
member names, unreads), no SQLCipher `conversations` table exists (`crypto/db.ts`).

**Problem:** the messenger's social graph (peer phone numbers, group rosters, display
names) is the ONE non-reconstructable slice and it sits unencrypted in
`messenger-store-v1` — inconsistent with the SQLCipher discipline one directory over.

**Required behavior:** conversation metadata gets a SQLCipher home (`conversations`
table, schema v21+); the zustand persist keeps working as a fast boot cache but stops
carrying PII (ids + unreads + order only), with hydration merging SQL truth in the
existing one-commit pass.

**Editor brief:**

- New table mirroring `LocalConversation` durable fields; write-through from the store
  subscriber that currently persists the vault; hydrate alongside `loadRecent` at
  `productionRuntime.ts:2163` in the SAME one-commit `hydrateMessages`/sibling pass.
- Strip `phoneE164`, names, rosters from the AsyncStorage partialize (extend the MSG-10
  pattern at `:1874-1887`); one-time migration: on first boot with v21, upsert the
  existing vault rows into SQL, then persist the stripped shape.
- First-frame regression watch: the chat list currently renders names from the vault
  BEFORE the runtime boots. Stripped vault = no names until SQL hydrate. Mitigation
  decision (small: keep display-name only in the vault, move phone/roster to SQL) must be
  made explicitly with the founder's warm-start priority in mind — cache names, encrypt
  the graph.

**Critic brief:**

- This changes what's on screen at first paint — run the startup-lane checks (list
  renders names+unreads pre-runtime, `MessengerHomeScreen.tsx:173-180` hydration gate).
- Migration is a B-339-class move: enumerate every consumer of the vault fields being
  stripped (search `phoneE164`, roster reads in push/notification paths — headless
  contexts read the persisted vault WITHOUT SQLCipher access in some lanes; verify
  `backgroundMessageNotifier`/`mutedLookup` inputs survive).

**Edge-Case Hunter brief:**

- Headless drain boot with SQL available but vault stale (and vice versa).
- Restore-from-backup ordering (mirror carries conversation snapshots — precedence).
- Multi-owner vaults (`vaultByOwner`) — per-owner migration idempotency.
- Downgrade/upgrade loop (v21 → old APK → v21 again).

**Gates:** schema migration tests; store partialize scan test (CRLF rules); messenger
gate ×2; device-verify owed: cold-boot first-frame shows names + unreads.

---

### FIX-10 · P3 · Persist directory display names/avatars for offline boots

**Files:** `messengerStore.ts:224-243` (`directoryNames`/`directoryAvatars` excluded from
partialize by design), consumer screens render raw-id fragments offline.

**Problem:** every boot re-fetches `/users/profiles`; an offline boot shows raw-id
fragments for non-address-book peers — clashes with spec §1 ("restore last known user
profile"/contact cache).

**Required behavior:** names+avatars cached durably (coordinate with FIX-09: if a
SQLCipher `conversations`/`peers` table lands, THAT is the home — do not create a second
plaintext PII cache in AsyncStorage; avatars cache as URLs/small refs, not data-URIs).

**Editor brief:** fold into FIX-09's table if it shipped (add `display_name`,
`avatar_url` columns); TTL/refresh-on-fetch semantics = replace-on-success, never evict
on failure. If FIX-09 is deferred, park this with it — do NOT ship names into
AsyncStorage as a standalone.

**Critic brief:** privacy-strip rules exist for presence (B-146) — check no equivalent
policy forbids persisting directory data; verify signed-out wipe clears it
(`disposeLiveRuntime`/logout path).

**Edge-Case Hunter brief:** renamed peer while offline (stale name accepted), deleted
account avatars, 5k-contact orgs (row cap), avatar URL rot.

**Gates:** rides FIX-09's gates.

---

### FIX-11 · P3 · backupBoot's 30 s identity-header hold on the Secure-tab lane

**Files:** `src/modules/messenger/backup/backupBoot.ts:95-113` (awaited
`getIdentityHeader` BEFORE runtime boot at `:266`), abort at `backupClient.ts:168` (30 s),
parallel mitigation only via `useMessenger` on messenger screens.

**Problem:** on a reachable-but-hanging network, users landing on Secure/ProductGate (no
messenger screen mounted) wait up to 30 s before the runtime boots, because
`runBackupBoot` is the only builder on that lane.

**⚠️ BACKUP_LOOP-GATED:** read `docs/runbooks/BACKUP_LOOP.md` §2 invariants first. The
probe exists to protect a recoverable identity (RESTORE gate `:133-148`) — the fix must
not let `installIdentity` clobber a restorable identity (I-class invariant).

**Editor brief:** shorten the probe budget for the BOOT decision only (e.g. 8 s cap on
this call site, not on backupClient globally), and on timeout take the SAME conservative
branch the offline path takes today (`serverProbeUsable=false`). Do not reorder probe vs
runtime boot — that ordering is the safety property.

**Critic brief:** verify the timeout branch is truly identical to today's offline branch
(no new lane where a restorable identity gets overwritten); check the parallel
`getMessengerRuntime()` race noted in the audit (`useMessenger` vs RESTORE gate) is not
widened by a faster fall-through.

**Edge-Case Hunter brief:** hanging-then-succeeding probe at 9 s (result must be ignored
cleanly, no double-boot); fresh install w/ restorable server identity on flaky network —
restore must still be OFFERED, not skipped.

**Gates:** BACKUP_LOOP §4 (backup/merkle suites, then crypto project ×2); §6 sign-off or
stated exception.

---

### FIX-12 · P3 · BiometricGate fails OPEN on a storage read error (B-438 residual)

**Files:** `src/components/BiometricGate.tsx:307` (`.catch(() => null)` conflates
"AsyncStorage errored" with "lock not set" → lock silently disabled for that boot).

**Editor brief:** distinguish read-error from unset: on error, retry once, then FAIL
CLOSED (show the lock) when a previous boot had the lock enabled — persist a mirror flag
(`settings:biometricLock:lastKnown`) written on every toggle so the error path has a
local truth to fall back on. Keep the existing 6 s/8 s watchdogs untouched.

**Critic brief:** fail-closed + storage down = potential lockout loop — the watchdogs
(`:76`, `:94`) must still release to the auth fallback path; verify the other two B-438
residuals (re-lock over live call, RN Modal coverage) are logged as separate items, not
scope-crept here.

**Edge-Case Hunter brief:** storage error on the MIRROR flag too (both reads fail);
toggle-off then storage error (must not re-lock a user who disabled it); cold boot from
call notification with lock on (the owed B-438 device pass).

**Gates:** BiometricGate app-project tests; device-verify owed per B-438.

---

### FIX-13 · P3 · Housekeeping (bundle into one small pass)

1. **sqa.md doc rot:** B-155 header at `sqa.md:8187` still reads OPEN/TEST-DOCUMENTED;
   the fix landed (yield at `productionRuntime.ts:9781-9784`, test flipped). Correct the
   header, keep numbering consistent.
2. **`react-native-mmkv@3.2.0` dead dep** (`package.json:121`, zero imports): remove, or
   consciously adopt as the encrypted-KV tier (decision belongs to FIX-01's editor).
3. **Latent second socket:** `src/services/supabase.ts:72-97` unused `realtimeService`
   helpers would open a Phoenix WS if ever called — delete the helpers, keep the
   SOSScreen HTTP-broadcast use; add them to the deadcode gate.
4. **Three-compartment SQLCipher split is dead code** (`db.ts:778-822`,
   `keychain.ts:226-239`, production still on `getOrCreateDbKey` at `runtime.ts:1001`):
   file a decision item — wire it (arch-gated migration) or remove it. Do NOT silently
   wire in this pass.
5. **Stale "SKELETON… stays inert" header on a LIVE module:** `push/voipPush.ts:19-31`
   contradicts `RUNTIME_ENABLED = true` at `:42` — rewrite the header to describe the
   real state (wired, device-verify blocked on B-122).

**Critic/Edge-case:** trivial per item; the critic's only real job is confirming zero
production references before each deletion (knip + grep, comment-stripped, CRLF-safe).

**Gates:** `npm run deadcode`; typecheck; messenger gate if any messenger file moves.

---

## 3. Calls & notifications fixes (FIX-14 … FIX-17)

> Audit verdict for the calls lane: the killed-app Android ring chain is genuinely
> WS-independent (data-only FCM `push.service.ts:1200-1236` → bundle-entry handler
> `index.js:47` → `fcmHeadless.ts:73-125` → notifee FSI ring `callNotification.ts:478-598`
> → native ringtone `BravoRingtoneModule.kt:49-113`). Reject is WS-free via HTTP decline +
> durable pending-actions. Headless drain has the never-keygen pin and double-processing
> guards. Mid-call network drops get ICE restart (30 s budget) / SFU re-join with a
> resurrection gate. What's missing is VALIDATION and CLEANUP — the four fixes below.
> Open context riding alongside (not fixed here): B-346 (P0, all call types dead — client
> evidence owed), B-109 (P0, iOS lock kills socket), B-122 (BLOCKED, iOS killed-app),
> B-239 (iOS VoIP tokens), B-412 (notification-reliability class, probe-first).
> Note: **B-419..B-427 are the call-AUDIO cluster** (this branch's namesake) — none of
> them concern warm start; see `docs/qa/BRAVO_CHANNELS_VS2_CRITICAL_REVIEW_2026-08-13.md`.

---

### FIX-14 · P2 · Stale-ring hygiene: boot notification sweep + client-side dead-call guards

**Files:** ring handler `src/navigation/MainNavigator.tsx:612-812` (never consults
`isIncomingCallDead`/`wasRecentlyEnded` before ringing a replayed `call.offer`);
`src/modules/messenger/push/incomingCallCache.ts:48-64,108-111,142-145` (TTL 60 s,
tombstone 90 s); `wasRecentlyEnded` wired only on the OUTGOING boot branch
(`webrtc/useCall.ts:905-913`); `call.missed` posts a banner but doesn't dismiss a
displayed ring (`webrtc/callDispatcher.ts:231-262`); **no**
`notifee.getDisplayedNotifications`/boot sweep anywhere in `src/`.

**Problem:** spec §13 "avoid resurrecting ended calls / no stale notification" currently
rests ENTIRELY on the server's replay tombstone (`messenger.gateway.ts:737-742`) and the
45 s `timeoutAfter`. A Doze-deferred or OS-persisted `bravo-call-<id>` ring that outlives
those is never reconciled at launch, and a replayed offer re-rings with zero client check.

**Required behavior:** (a) on boot and on foreground, sweep displayed notifications:
any `bravo-call-<id>` whose id is tombstoned/dead/expired-TTL is cancelled; (b) the
in-app ring handler checks `isIncomingCallDead(callId) || wasRecentlyEnded(callId)`
before ringing; (c) `call.missed` dismisses a still-displayed ring for that id; (d) the
incoming boot branch gets the same `wasRecentlyEnded` guard the outgoing branch has.

**Editor brief:**

- Sweep helper in `push/callNotification.ts` (it owns the id scheme
  `bravo-call-<id>`): `notifee.getDisplayedNotifications()` → filter call ids → check
  against `incomingCallCache` dead-signals → `cancelNotification` + native ringtone stop
  via the existing `dismissCallNotif` funnel (`callNotification.ts:749-760`) — never a
  bare cancel that leaves the ringtone looping.
- Call it from the AppState-active handler (`productionRuntime.ts:1821-1905`) and once
  during FCM bootstrap start (`fcmBootstrap.ts:321-333` region) — NOT from the headless
  lane (no store there).
- Guard insertion in `MainNavigator.tsx:612-812`: a dead id → drop the frame, log
  `[callresume]`-style breadcrumb, no ring.
- RED-first: a test that replays a tombstoned `call.offer` through the ring handler and
  asserts no ring today (DOCUMENTS) → flips with the fix.

**Critic brief:**

- The dead-signal check must not eat a LEGITIMATE second call that reuses nothing but
  timing — key strictly by callId, never by peer.
- `dismissCallNotif` is the single teardown funnel — verify the sweep can't race
  `endActiveCall` (`callRegistry.ts:216-254`) into a double-stop (idempotency of the
  native module stop).
- B-58 regression watch: the sweep runs on AppState-active — prove it can NEVER touch the
  notification of a call the registry says is live (`hasLiveCall()` exclusion).

**Edge-Case Hunter brief:**

- Ring displayed → device reboots → app opens 10 min later (notifee persistence across
  reboot; cache/tombstone AsyncStorage still has the entry? TTLs expired → sweep must
  still catch it via TTL-expiry, not only tombstone).
- Offer replay arriving DURING the sweep (order: guard first, sweep idempotent).
- Two devices, same account: callee answered elsewhere — `call.missed`-equivalent path
  must clear this device's ring.
- Group ring ids (`groupCallRingDispatcher` keys) — in scope or explicitly out (state it).

**Gates:** messenger gate ×2 + app screens; device-verify owed: kill app mid-ring →
reopen after 2 min → no ring, no looping ringtone.

---

### FIX-15 · P2 · Call-state validation probe (answer must not sit on a dead call) ⚠️ ARCH-AWARE

**Files:** only calls HTTP route today is `POST /calls/:callId/decline`
(`apps/messenger-service/src/gateway/calls.controller.ts:44-77`); answer path waits on
transport + offer SDP (`webrtc/useCall.ts:318`, `CallScreen.tsx:1066-1114`) with the
45 s dead-offer watchdog as the only backstop (`CallScreen.tsx:1977-2019`); accept flow
`fcmBootstrap.ts:1860-1951`; server call session state `messenger.gateway.ts:641-760`
(`rehydrateCallSession`).

**Problem:** spec §13/§14 "validate the call state before allowing Answer" — there is no
client→server "is this call alive?" probe. If the caller hung up while the callee was
offline and the cancel push was lost, the callee taps Answer and sits on "Answering…" for
up to 45 s before `failed`.

**Required behavior:** a lightweight authenticated `GET /calls/:callId/state` (or WS verb
`call.state`) returning `ringing | answered-elsewhere | ended | unknown`, consulted
(a) in parallel with the answer navigation (never blocking the UI — navigate first,
validate in flight, tear down fast with an honest "Call ended" if dead), and (b) by
FIX-14's sweep as the authoritative source when reachable.

**Editor brief:**

- Server: expose the state the gateway already tracks for `rehydrateCallSession`/parked
  offers — read-only, no new state machine. Auth = same JWT guard as decline. `unknown`
  for anything outside the ring/session window (privacy: do not leak historic calls).
- Client: fire the probe from the accept handler (`fcmBootstrap.ts:1860-1951`) alongside
  `startTapTimePull`-style parallelism; result races the existing watchdog — a `ended`/
  `answered-elsewhere` verdict short-circuits to the SAME terminal teardown the watchdog
  uses (`declineIncomingCallBestEffort(callId,'failed')` path) with proper copy.
- Offline/probe-timeout = `unknown` = current behavior (watchdog). The probe only ever
  SHORTENS the dead wait, never blocks or extends anything.
- **Arch check first:** confirm with the System Architecture Documentation that exposing
  ring-window call state over HTTP is acceptable metadata (it parallels the existing
  decline route and missed-call markers — but verify, don't assume).

**Critic brief:**

- Race matrix: probe says `ringing` at t0, caller hangs up at t0+1 — the probe must never
  be treated as a lock; WS `call.hangup`/cancel push remain authoritative afterwards.
- `answered-elsewhere`: verify multi-device semantics actually exist server-side before
  inventing the enum value; if single-home (Call-sentinel M4-lite), collapse to `ended`.
- No plaintext/callee-graph leakage in logs (`logAudit`).

**Edge-Case Hunter brief:**

- Probe response arriving AFTER the user already connected (late `ended` must be ignored
  once the controller is live).
- Probe 404 vs 401 vs timeout — three different fallbacks, all must land on `unknown`.
- Answer tapped twice fast (markAccepted latch) + probe in flight.
- Killed-VM accept: probe requires a token read — coordinate with FIX-01's keychain
  tokenStore in headless context.

**Gates:** messenger-service gateway/controller specs (new state spec); client accept
tests; messenger gate ×2; device-verify owed: caller hangs up while callee airplane-mode
→ callee answers → fast honest teardown.

---

### FIX-16 · P3 · 1:1 answer cold-start parity: kick the runtime like the group path does

**Files:** group answer kicks the runtime to manufacture a socket
(`webrtc/useGroupCall.ts:1198-1211`, B-275); the 1:1 path only subscribes to the
transport registry (`CallScreen.tsx:227-228`) and relies on MainNavigator's configure
effect having run.

**Problem:** on a cold-VM answer, 1:1 call setup waits for whoever else boots the
runtime; if the navigator effect is slow (B-227 window: 10–25 s cold launches on low-end
hardware) the 40 s signalling budget burns down doing nothing.

**Editor brief:** mirror the B-275 pattern — on 1:1 accept intent with no live transport,
call the same runtime-kick helper the group path uses (extract it if it's inline; shared
symbol → MESSAGE_LOOP §5 caller sweep). No behavior change when a transport exists.

**Critic brief:** the kick must respect the config gate (`setMessengerConfigGate`,
B-272) and the restore gate (never boots a runtime the RESTORE flow is protecting —
same invariant as FIX-11); verify against `backupBoot.ts:133-148`.

**Edge-Case Hunter brief:** accept during active restore (must NOT kick — show the
existing restore-mode branch); double-kick (group + 1:1 rings overlapping); signed-out
stale notification tap (no owner key → no kick, clean drop).

**Gates:** messenger gate ×2; device-verify owed: kill app → 1:1 call → answer from
notification → connect time vs today.

---

### FIX-17 · P3 (iOS lane) · iOS notification-tap route + VoIP chain verification

**Files:** no `messaging().onNotificationOpenedApp` / `messaging().getInitialNotification`
anywhere in the repo (only notifee's, `fcmBootstrap.ts:1969`); iOS chat banners are
APNs-drawn server-side (`push.service.ts:800-830`); VoIP chain wired
(`plugins/withVoipCallKit.js:44-155`, `push/voipPush.ts:42` `RUNTIME_ENABLED=true`,
`push/callKitBridge.ts:66`) but stale "SKELETON… stays inert" header at
`voipPush.ts:19-31`; B-122 BLOCKED (Apple account), B-239 (BadDeviceToken).

**Problem:** iOS taps on APNs-drawn banners have no explicit deep-link route — they
depend on unverified notifee delegate swizzling. The whole iOS lane (spec §13/§16) is
coded but has never been proven on hardware.

**Editor brief:** add the RNFirebase iOS tap hooks (`onNotificationOpenedApp` +
`getInitialNotification`) funnelling into the SAME tap handler the Android path uses
(`fcmBootstrap` handlePress region) with idempotent double-fire protection vs notifee's
hook; fix the stale `voipPush.ts` header (FIX-13 item 5). Everything else on this lane is
device/account-gated — write the verification checklist, don't guess.

**Critic brief:** double-delivery is the trap — a tap surfacing through BOTH notifee and
RNFirebase must navigate once (key by messageId+timestamp latch). Confirm no Android
regression: the new hooks must be iOS-only or provably inert on Android.

**Edge-Case Hunter brief:** cold-start tap with both initial-notification APIs returning
the same event; tap while BiometricGate is up (nav-ready 20 s window, B-227 interaction);
VoIP push arriving while the app is foreground-active.

**Gates:** messenger gate ×2; typecheck; EXPLICITLY BLOCKED device verify: requires the
B-122 Apple account action + real iPhone — state it in the commit, do not claim done.

---

## 4. Execution order

1. **FIX-01** (P0 security, self-contained) → 2. **FIX-02** (biggest founder-visible
   warm-start win) → 3. **FIX-03** (pairs with FIX-02 for the offline story) →
2. **FIX-05** (small, unlocks honest UX) → 5. **FIX-14** (stale-ring hygiene; client-only,
   no server dependency) → 6. **FIX-04 + FIX-15** (both arch-gated server touches —
   schedule the architecture verification early, code later, deploy together) →
3. **FIX-06 → FIX-09/10** (schema v21 items together, one migration) → 8. **FIX-07**
   (server-only, independent — parallel with any client fix) → 9. **FIX-08** (after
   FIX-03 so it has real state to show) → 10. **FIX-16** (after FIX-14/15 so the kick
   lands on validated calls) → 11. **FIX-11, FIX-12, FIX-13, FIX-17** (small / lane-gated,
   anytime).

**Cross-fix dependency:** FIX-15's killed-VM probe reads a token → its headless lane
depends on FIX-01's keychain `tokenStore` (or must read through the same abstraction so
the migration carries it for free).

Every fix: one branch-commit, RED-first test named after this doc's FIX-NN (and a B-number
if sqa.md gets one), self-diff rule before commit, device-verify list stated explicitly
since this session ships NO build.
