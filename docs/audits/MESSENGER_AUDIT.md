# Messenger Module Audit — Full E2EE Stack, Notifications & Smoothness

**Date:** 2026-07-06 · **Auditor:** Claude (8 parallel deep-trace agents + live evidence) · **Ref:** [`docs/qa/MESSENGER_TEST_PLAN.csv`](../qa/MESSENGER_TEST_PLAN.csv) (349 tests, 11 areas)

**Scope:** everything the test plan covers — 1:1 & group messaging, delivery lifecycle, transport/offline, media & vault, calls (1:1 + SFU), presence/typing/receipts, backup, identity/session, settings/disappearing/mute, **plus** the two explicit asks: the messenger **notification pipeline** end-to-end and **messaging smoothness** (perf).

**Method:** static deep-trace of every test's Expected Result against real code (file:line anchors), full test-suite runs, and live staging evidence (Contabo containers + Supabase). **No devices were attached this session** (BlueStacks off), so nothing here is an on-device execution pass — the plan's Status column stays empty for the tester; this audit says whether the _code can pass_ each test.

---

## 1. Executive summary

**Verdict: the messenger core is production-grade; the edges are not.** Of 349 planned tests, **285 (82%)** are code-verified as implementable-as-expected, **44** hit a finding, **20** are device-only. There are **0 P0s** (nothing loses committed messages or breaks E2EE), **18 P1s**, and ~30 P2s.

The strongest subsystems are exactly the security-critical ones (all verified by trace, not assumption):

- Sealed sender + sender-cert verification is unconditional; no skip branches anywhere.
- **Rekey-on-removal genuinely rotates the group master key**; the removed member is excluded from fan-out, fails `groupDecrypt`, and is refused key-reshare.
- The relay never sees plaintext or key material; 30-day dwell enforced both sides (relay TTL == sealed-AAD max age).
- Exactly-once delivery: durable outbox (enqueue-before-send), server `clientMsgId` dedup, persistent 35-day `seen_envelopes`, B-46 auto-resend and B-47 first-contact recovery chains intact.
- Vault MFA gate is **not bypassable**: only two URL-minting routes exist; namespaces mutually unreachable; fails closed on missing secrets.
- All 10 named call regressions (B-16/17/19/20/21, B-05, sfuDispatcher, SFrame fail-closed, TDZ, roster race) are still fixed in code.
- Push payloads are fully opaque (data-only, ids only, text drawn client-side post-decrypt).

The P1s cluster in four themes: **(a)** notification UX correctness (one root cause: `msg-wake` has no conversationId and the client never resolves it locally), **(b)** two privacy toggles that don't actually enforce (last-seen, block), **(c)** unreachable UI for existing crypto (group remove-member, wipe-at-rest, OTP screen), and **(d)** six perf landmines that will show as jank at scale.

## 2. Suite & live evidence (2026-07-06)

| Check                         | Result                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| messenger-crypto Jest project | **152 suites / 1368 tests — all pass**                                                                                                                     |
| apps/messenger-service        | **20 suites / 195 tests — all pass** (re-run post lite-mission pull: still green)                                                                          |
| Contabo containers            | all 6 healthy; msgr image 2026-07-05T19:37Z (yesterday's deploy)                                                                                           |
| Relay health                  | 0 undeliverable/discarded envelopes in 7 days; WS churn 13 open/13 close per 24 h (no flapping); offline flush observed live ("flush 5 pending envelopes") |
| Push telemetry (7 d)          | **35× `push.chat.no-tokens` vs 7× delivered** — see §4                                                                                                     |
| Supabase                      | all 7 backup migrations applied; no schema drift found in messenger scope                                                                                  |

## 3. Per-area verdicts (mapped to the test plan)

| Area                                               | Tests   | Code-verified | Findings | Device-only | Verdict                                                                                                                                       |
| -------------------------------------------------- | ------- | ------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1:1 Text & Delivery Lifecycle                      | 32      | 24            | 3        | 5           | **PASS w/ P2s** — outbox/ticks/B-46/B-47 solid; cosmetic truth gaps (offline bubble shows `failed`, no scroll-to-unread, clock-drift reorder) |
| Connection, Transport & Offline                    | 30      | 26            | 4        | 0           | **PASS w/ P2s** — exactly-once verified; slate offline banner is dead UI                                                                      |
| Group Messaging & Rekey                            | 32      | 25            | 5        | 2           | **PASS w/ FINDINGS** — crypto right; remove-member UI missing (M-09); key envelopes not outboxed                                              |
| Identity & Session Lifecycle                       | 28      | 20            | 6        | 2           | **PASS w/ FINDINGS** — probe/rotation/purge right; wipe & OTP UI unreachable (M-10/11)                                                        |
| Media & Encrypted Attachments                      | 33      | 30            | 1        | 2           | **PASS** — AES-256-CBC per-file + encrypt-then-MAC verified; truncation probe inert (P2)                                                      |
| File Vault MFA Gate                                | 36      | 30            | 6        | 0           | **PASS w/ FINDINGS** — server gate sound; FileViewer fake-vault regression (M-02)                                                             |
| Voice/Video Calls (1:1 + SFU)                      | 36      | 24            | 7        | 5           | **STRONG PASS w/ FINDINGS** — all regressions fixed; ICE-restart retry deadlock (M-12)                                                        |
| Presence, Typing & Read Receipts                   | 25      | 20            | 3        | 2           | **CONDITIONAL PASS** — last-seen privacy leak (M-06)                                                                                          |
| Backup — Setup/Verifier/Enable                     | 35      | 32            | 2        | 1           | **PASS w/ FINDINGS** — P0-1 verify real; double-tap enable race (M-01)                                                                        |
| Backup — Restore/Unlock/Mirror                     | 31      | 28            | 3        | 0           | **PASS w/ P2s** — Merkle-verify-before-write, tombstones, lockout all real                                                                    |
| Settings, Disappearing, Mute/Pin & Stop-Conditions | 31      | 26            | 4        | 1           | **CONDITIONAL PASS** — block not enforced (M-07), B-26 residual (M-08)                                                                        |
| **Total**                                          | **349** | **285**       | **44**   | **20**      |                                                                                                                                               |

## 4. Notifications — dedicated audit (explicit ask)

**Pipeline verdict: architecture coherent and B-48 fully present in the repo**; server side already live on Contabo (VOIP-fallback, both-keyspace dead-token reap, tombstone GC, budget-gated HMAC-signed VoIP wakes). Killed-app handler registered at bundle entry (`index.js:46`), slim notifee tap handler at entry, native ringtone module + silent v2 channel + 45 s auto-stop, full-screen-intent manifest bits present. **Opacity PASS** — no plaintext/sender-name/keys ever ride FCM.

**⚠️ Ship gate: none of the client fixes exist on devices until an APK ≥ v1.0.99 (vc125) is built and installed.** Devices on ≤vc122 stay silent when killed regardless of the live server fix.

**The P1 family (one root cause):** sealed sender means the server can't put `conversationId` on a `msg-wake`, and the client doesn't resolve it locally from `senderUserId` before drawing. Consequences:

- **M-03** banners never collapse per conversation and never clear on read (`dismissMessageNotif` cancels ids that never exist) — `fcmBootstrap.ts:1006-1012`, `callNotification.ts:165-173`
- **M-04** muted **groups** still push (mute lookup falls back to direct-peer matching only) — `mutedLookup.ts:34-41`
- **M-05** tapping a group-message notification opens a **phantom 1:1 thread** with the sender — `fcmBootstrap.ts:549-560`

Fix direction for all three: resolve conversationId locally against the persisted store before drawing (the pattern already exists in `mutedLookup.ts`).

**Live telemetry finding (staging):** 7-day logs show pushes skipped for "no tokens" 35× vs 7 delivered, and the token GC drops **freshly-registered (~90 s old) tokens** as revoked (`push.gc.summary scanned=N dropped=N`, 100% drop rate; same device hash under two accounts). Timeline for sub `c700ccde`: register 20:33:44 → WS drain works → GC revokes token 20:35:17 → every later message `no-tokens`. Root-cause classification: the reap triggers on FCM's _not-registered/invalid_ response — **BlueStacks instances without proper Play Services mint tokens FCM rejects**, so this is primarily a _staging-environment_ blind spot, not a prod defect — but it means **killed-app push is untestable on the current BlueStacks fleet** and the B-48 device smoke needs at least one real device (or Play-enabled emulator). Residual real gap (P2): a user whose registration failed once (offline at login) and whose app is then killed stays push-invisible until next app open — all retries require the app to be opened.

Also noted (P2): no foreground in-app banner when the app is open on another screen (WhatsApp parity gap); calls to a rebooted-never-unlocked device drop fail-closed (documented P1-N11 trade-off); lite-mission commits added LM-N2/N3 (server-wake tap routing + iOS APNs fan-out) — additive, does not address the family above.

## 5. Smoothness — dedicated audit (explicit ask)

**Verdict: architecturally strong — typical threads (≤200 messages) should hold ~60 fps.** The classic RN chat optimizations are all in place and verified: tuned FlatList windows + `maintainVisibleContentPosition`, field-compared memoized bubbles, narrow Zustand selectors + frozen singletons, 200-row boot cap + keyset pagination on an indexed `(conversation_id, created_at)`, single-flight coalesced drain (50/page), JSI-native crypto, parallel group-text fan-out, debounced markRead/search/persist, batched refcounted presence.

**But six P1 landmines will surface as jank at scale:**

| ID   | Finding                                                                                                                                                                                                                          | Anchor                                                                    | Symptom                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| M-13 | `useCountdown` subscribes **every mounted bubble** to a 1 Hz tick whose snapshot always changes; `React.memo` can't block hook-driven self-renders. The in-code comment claiming otherwise is wrong.                             | `ChatScreen.tsx:2156, :1694`                                              | rhythmic ~1 Hz hitch while scrolling; constant JS churn in any open chat. **One-line fix** (subscribe only when `expires_at` set) |
| M-14 | Unbatched per-message store commits: markRead/read-receipts/drain flip rows one-by-one; each commit walks **all** in-memory messages + one fsync'd SQL upsert. The purpose-built `upsertCoalesced` batcher has **zero callers**. | `productionRuntime.ts:4050-4063, 1528-1637`; `sqlMessageStore.ts:107-123` | opening a chat with 50 unread = 50 full-store diffs + 50 transactions on the JS thread                                            |
| M-15 | Optimistic bubble waits on cert fetch + X3DH before appending; a pre-append throw (30 s cert negative-cache) **loses the typed text** — no failed bubble, no retry chip.                                                         | `productionRuntime.ts:2498, 2065`; `certCache.ts:42-52`                   | cold-path sends feel dead for 1-2 RTTs; rare hard text loss                                                                       |
| M-16 | Group **create** fan-out is fully sequential (1 X3DH RTT per member); group _text_ was parallelized, create never was.                                                                                                           | `groupClient.ts:177-196`                                                  | 20-30-member create = 20-30 serial RTTs behind the spinner (GRP-26)                                                               |
| M-17 | No media download concurrency queue — every image bubble auto-loads on mount (known gap M12, still open).                                                                                                                        | `useAttachmentUri.ts:162-164`                                             | media-heavy thread open = 15-20 parallel download+decrypt pipelines vs scroll (MEDIA-25)                                          |
| M-18 | MessengerHome subscribes to whole store maps (`conversations`, `presence`, `messages`) — full Home re-render on every event anywhere, even buried under ChatScreen.                                                              | `MessengerHomeScreen.tsx:51,53,194`                                       | 50-envelope drain = ~50 hidden screen renders                                                                                     |

P2 tier: double SQL write per inbound; O(#convs) selector scan per commit; media send blocks on full encrypt+upload with whole file in memory; base64 thumbs resident in store + rebuilt per render; console logs survive release builds (no `transform-remove-console`); `adjustResize` + manual keyboard padding both armed; expiry sweeper scans everything at 1 Hz forever; stale `jumpToMessage` closures after pagination; inline `renderItem`.

**Highest-leverage two fixes: M-13 (one line) and wiring `upsertCoalesced` into the write-through subscriber (M-14).**

## 6. Consolidated P1 register (18 — none P0)

| ID         | Area     | Finding                                                                                                                                                                                                            | Anchor                                                             | Impacted tests                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------- |
| M-01       | Backup   | Double-tap ENABLE runs `setupBackup` twice → master-key rotation server-wipes first upload's mirror (busy set _after_ biometric await; unlock path does it right)                                                  | `BackupSetupScreen.tsx:177-192`                                    | BKSET-27, weakens BKSET-01/14             |
| M-02       | Vault    | FileViewer "Move to Vault" writes pretend-encrypted rows (`keyB64:''`, plaintext temp URI → plain AsyncStorage). Third path missed by audit-S1 fix                                                                 | `FileViewer.tsx:72-90`                                             | VAULT-19/20/28/35                         |
| M-03       | Notif    | Message banners never collapse per conversation, never clear on read                                                                                                                                               | `fcmBootstrap.ts:1006-1012`                                        | 1TO1-28/29, GRP-17                        |
| M-04       | Notif    | Muted groups still raise push banners                                                                                                                                                                              | `mutedLookup.ts:34-41`                                             | SET-19/20                                 |
| M-05       | Notif    | Group-message notification tap opens phantom 1:1 thread                                                                                                                                                            | `fcmBootstrap.ts:549-560`                                          | 1TO1-28, GRP-17/19                        |
| M-06       | Privacy  | "Show last seen" never enforced — gateway emits `lastSeenMs` unconditionally; `last_seen_visible` read nowhere in messenger-service                                                                                | `messenger.gateway.ts:1912-1920`, `presence.service.ts:85-101`     | PRES-18, SET-09                           |
| M-07       | Privacy  | Block is directory-only — no enforcement on delivery, presence, typing, receipts; inbound resurrects the removed thread                                                                                            | `envelope.service.ts` (no refs), `messengerStore.ts:539-633`       | SET-10, PRES-19                           |
| M-08       | Delete   | B-26 residual: sealed-archive replay resurrects locally-deleted **inbound** messages after reinstall+restore (replay path skips tombstones)                                                                        | `BackupRestoreScreen.tsx:399-443` → `productionRuntime.ts:275-281` | SET-29                                    |
| M-09       | Group    | "Remove from group" has no UI entry — admin-remove crypto unreachable from messenger (org intent drains only)                                                                                                      | `ChatInfoScreen.tsx:294-319`                                       | GRP-20/25                                 |
| M-10       | Identity | "Remove account from this device" (`wipeAtRest`) has no caller — at-rest destroy unreachable                                                                                                                       | `authStore.ts:565-581`                                             | IDN-03/20                                 |
| M-11       | Identity | OTP entry bypassed — LoginScreen auto-verifies with `devOtpCode ?? DEV_LOGIN_OTP`; no OTP screen; would fail outright against live Twilio                                                                          | `LoginScreen.tsx:293-300`                                          | IDN-12/28                                 |
| M-12       | Calls    | 1:1 ICE-restart **retry** deadlock: PC parked in `have-local-offer`, no rollback in retry path → lost first reoffer = call dies at 30 s (B-24 field pattern). Unit test pins a re-implemented copy, can't catch it | `callController.ts:983-1048`                                       | CALL-05/20                                |
| M-13..M-18 | Perf     | See §5                                                                                                                                                                                                             |                                                                    | 1TO1-15, NET-19, IDN-27, GRP-26, MEDIA-25 |

## 7. P2/P3 register (condensed — full details in agent traces)

- **1:1/Transport:** offline bubbles flip `failed` in ~5 s instead of holding `sending` (self-heals, no dup) · slate "Offline —" banner unreachable (only `reconnecting` ever shows) · narrow tick-regression race on crash-recovery replay (self-corrects next reconnect) · sender clock drift reorders merged thread (`aad.ts` trusted, no server-ts reconciliation) · no scroll-to-first-unread (always `scrollToEnd`) · no-refresh-hook handshake reject retries forever (prod wires the hook) · **hidden:** read receipts silently lost on half-dead socket + flush clears queue on throw + queue is memory-only.
- **Group/Identity:** group TTL setting local-only (never broadcast) · group tick flips `read` off a single member's receipt · reaction-before-target dropped forever · concurrent cross-op admin rekeys can fork the key (reactive heal exists) · **group create/add/rekey/reshare envelopes are fire-and-forget WS, no outbox row** (text has one) · no proactive rehandshake on own rotation · `signOut` reentrancy · wipe leaves per-compartment + Merkle-HMAC keychain keys · HTTP-submitted envelopes get no delivered/undeliverable feedback (B-46 blind for fallback/drain sends) · runtime boots before `must_set_password` gate · [P3] pre-fix raw-JSON rows unmigrated; dept-filter needs live fetch.
- **Media/Vault:** `/vault/storage/*` backend does not exist (purchase golden path can't pass) · truncation HEAD probe inert vs real S3 (signs GET, sends HEAD → 403 → "accept") · VaultScreen stays visible after background-relock (no `isUnlocked` self-guard) · 50 MB cap plaintext-vs-ciphertext boundary · media sends not serialized (mic live during send).
- **Calls:** group mute not signalled (no glyph on remote tiles) · host never sees callee Decline (no-op handlers, pills removed) · caller-cancel writes notification but no Missed bubble when no controller mounted · hardware-Back on ringing 1:1 minimizes instead of declining (A rings 45 s) · dial double-tap mints two callIds · mic-denial shows wrong copy · force-killed device writes no own call record.
- **Presence/Settings:** away peer = amber dot but green "Online" pill · stale typing after 6 s auto-stop (no re-arm) · privacy-toggle burst race (no latest-wins) · read-receipt fan-out `volatile` (dropped frame = grey tick forever; presence got the durable fix, receipts didn't) · no receipt flush on foreground-regain · muted lookup scans all owners' vaults (shared-device leakage) · **no FLAG_SECURE anywhere** (screenshots/recents expose plaintext).
- **Backup:** resume-from-cursor deliberately dormant (restarts page 0, idempotent — plan text outdated) · `nonce_expired` friendly copy unreachable · mid-session remote wipe only handled at mount · Settings "Forgot" skips M-17 local cleanup (stale flags → future restore orphans).
- **Ops/test hygiene:** Jest teardown leak warnings in both backend suites · staging BlueStacks fleet can't receive FCM (see §4) — killed-app tests need a real device.

**Test-plan corrections found:** GRP-09/21 (self-leave now auto-rekeys: epoch +2, G-03) · CALL-28 (server acks ping since B-05 fix) · SET-18 (mechanism differs, behavior met) · BKRES-08/30 (cursor-resume disabled by design, H-5). The plan should be updated before the device run.

## 8. Release gates & recommended order

1. **Build + distribute APK v1.0.99 (vc125)** — carries the B-48 client fix family, ringtone module, and every mobile finding fix that follows. Nothing client-side lands on devices without it.
2. Fix the notification P1 family (M-03/04/05 — one shared root cause) and the two privacy P1s (M-06/07) before any external beta: they're user-visible trust issues.
3. M-13 + M-14 (perf, tiny diffs, biggest smoothness win) and M-12 (call reliability under handover).
4. Decide product intent on M-09/M-10/M-11 (UI for remove-member / wipe / OTP): the backends exist; the plan tests are unexecutable until the UI ships or the plan is re-scoped.
5. Device run of the 349-test plan on ≥1 real Android device (+ BlueStacks for multi-account), including the backup on-device restore round-trip (last open P0-1 remediation gate) and the killed-app push smoke.

## 9. Remediation log — 2026-07-06 (same day)

All 18 P1s and the safe P2s were remediated the same day across 8 parallel fixer agents + 3 core-runtime fixes by the coordinating session. Gates after remediation: mobile tsc **47 ≤ baseline 49**; messenger-crypto **all green**; messenger-service **22 suites / 218 tests green** (+23 privacy tests). Shipped in APK **v1.0.100 / versionCode 126**.

| ID   | Status          | What changed                                                                                                                                                                                                                       |
| ---- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-01 | ✅ Fixed        | `handleEnable` sets busy + `!setupOk` guard BEFORE the biometric await → double-tap can't run `setupBackup` twice / rotate the master key.                                                                                         |
| M-02 | ✅ Fixed        | FileViewer "Move to Vault" fails closed (no empty-key/plaintext-uri vault rows); routed through `resolveVaultMoveAction`.                                                                                                          |
| M-03 | ✅ Fixed        | Notifications key by `bravo-msg-<conversationId>` (collapse + dismiss-on-read work) via local sealed-sender→conversation resolution; sender-keyed fallback when unresolvable.                                                      |
| M-04 | ✅ Fixed (warm) | New `backgroundMessageNotifier` gates muted/active/self conversations on the warm path. Killed-path group mute stays generic (sealed-sender limit, documented).                                                                    |
| M-05 | ✅ Fixed        | Notification tap opens a thread only when `conversationId` resolves in-store, else → Messenger home (no phantom 1:1).                                                                                                              |
| M-06 | ✅ Fixed        | messenger-service strips `lastSeenMs` from snapshot + broadcast when the subject's `last_seen_visible=false` (new `UserPrivacyService`, service-role Supabase, 60 s cache).                                                        |
| M-07 | ✅ Fixed        | **Server**: blocked → typing/receipt drop, presence snapshots plain offline. **Client**: new `blockedPeers` set (persisted + server-refreshed) drops inbound from blocked peers at the receive path so the thread can't resurrect. |
| M-08 | ✅ Fixed        | New `restoreTombstones` set captures `status='deleted'` ids during mirror restore; the receive path (1:1 + group) refuses to re-append them, so the sealed-archive replay no longer resurrects deleted messages.                   |
| M-09 | ✅ Fixed        | ChatInfoScreen shows "Remove from group" for group admins → `removeGroupMember` (the correct rekey crypto is now reachable from the UI).                                                                                           |
| M-10 | ✅ Fixed        | ProfileScreen "Sign out & remove data from this device" → `signOut({wipeAtRest:true})` (double-confirm).                                                                                                                           |
| M-11 | ✅ Fixed        | New `OtpVerifyScreen`; LoginScreen keeps the staging dev-OTP auto-verify but routes to the real 6-digit entry when `devOtpCode` is absent (prod / live Twilio).                                                                    |
| M-12 | ✅ Fixed        | `callController` retry rolls back the parked `have-local-offer` restart offer then re-fires → ICE-restart recovers after a lost reoffer; the mirror test now exercises the real gate.                                              |
| M-13 | ✅ Fixed        | `useCountdown` passes a no-op subscribe + constant snapshot for un-armed bubbles → no more 1 Hz all-bubble re-render.                                                                                                              |
| M-14 | ✅ Fixed        | `updateMessageStatusBulk` flips a whole slot in one commit; the write-through subscriber routes row UPDATEs through `upsertCoalesced` (one txn per 50 ms burst).                                                                   |
| M-15 | ✅ Fixed        | 1:1 optimistic bubble appended BEFORE the crypto awaits; a first-contact/seal/wrap throw flips it to `failed` (retry chip) instead of losing the typed text.                                                                       |
| M-16 | ✅ Fixed        | `broadcastToGroup` fan-out parallelised (`Promise.allSettled`, chunks of 8) — group create no longer O(N) serial RTTs.                                                                                                             |
| M-17 | ✅ Fixed        | Module-level max-4 semaphore around media auto-download (no more unbounded parallel decrypt on media-heavy thread open).                                                                                                           |
| M-18 | ✅ Fixed        | MessengerHome drops whole-map `messages`/`presence` subscriptions (per-row `RowOnlineDot`, search reads `getState()`), keeps `conversations` via `useShallow`.                                                                     |

**Also fixed (P2):** durable read-receipt fan-out (queued, no more permanent grey tick); receipt flush on foreground-regain; stale-typing re-emit after 6 s; privacy-toggle latest-wins guard; dot/pill "Away" parity; VaultScreen relock self-guard + VaultLock header parity; ranged-GET truncation probe; 50 MB plaintext/ciphertext boundary; `jumpToMessage` ref-mirror; expiry-sweeper idle backoff; `transform-remove-console` in prod; `signOut` reentrancy; wipe-at-rest per-compartment + Merkle-HMAC keys; backup "Forgot" M-17 cleanup; `nonce_expired` copy; mid-session backup-delete focus-refetch; cross-owner muted-lookup scope; owner-scoped conversation resolution.

**Deferred (product decision / cross-service, tracked, NOT in this build):** `/vault/storage/*` purchase backend · FLAG_SECURE (breaks the QA screenshot workflow) · call record on force-kill · killed-path group-mute suppression (sealed-sender limit) · HTTP-submitter delivered/undeliverable feedback · group key-envelope outboxing · cross-op rekey fork · group-TTL broadcast · reaction-before-target replay · clock-drift server-ts reconciliation · slate offline-banner wiring · no-scroll-to-unread. See §7/§8.

**Deploy record (2026-07-06):**

- **messenger-service → Contabo staging (LIVE + verified).** Rebuilt `bravo/messenger-service:staging`, recreated `bravo-staging-msgr`; Nest started clean (listening :3100, WS gateway up, clients reconnecting, zero boot errors). Compiled privacy code confirmed in `dist/users/user-privacy.service.js` + enforcement markers in `dist/gateway/messenger.gateway.js` and `dist/gateway/presence.service.js`. The container already carries `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, so last-seen/block enforcement is **active** (not fail-open). Rollback: `bravo/messenger-service:rollback-20260706-110911`; src backup `~/msgr-src-predeploy-20260706-110911.tgz`.
- **APK v1.0.100 / versionCode 126** built via `gradlew assembleRelease` (patch-package + RNCallKeep dual-`@ReactMethod` fingerprint gate passed) and distributed to Firebase App Distribution **qa** group.

---

_Full per-finding traces (SUPPORTED anchors for all 285 verified tests) live in the audit agents' outputs; this document is the canonical register. Related: [`CREDITS_BC_AUDIT.md`](CREDITS_BC_AUDIT.md), `sqa.md` bug log B-01..B-49._
