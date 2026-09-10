# Call & Message Edge-Case Audit vs Industry Standard (WhatsApp / Signal) — 2026-07-28

**Method.** An industry benchmark of 38 call + 40 message edge cases was assembled from
WhatsApp/Signal documented behaviour and standard mobile interruption-testing checklists
(sources at bottom). Two codebase sweeps then mapped every case to evidence: the
`sqa.md` bug log (B-01…B-322), `docs/runbooks/MESSAGE_LOOP.md` (M1–M16), the call/notification
audits under `docs/audits/`, and the regression suites. Status below is **evidence-backed** —
"handled" means a mechanism + test/bug-fix was found, not that it was assumed.

**Legend.** ✅ handled (evidence) · 🟡 partial / caveat · 🔴 gap or known-broken ·
🔒 arch-gated (CLAUDE.md security stop-condition — needs architecture decision, not code) ·
📱 fixed but device-verify pending.

---

## Part 1 — MESSAGING

### 1.1 Send / offline / retry

| #     | Edge case (industry std)                                 | Status                     | Evidence                                                                                                                                                                                       |
| ----- | -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS-01 | Offline send → durable queue, auto-retry w/ backoff      | ✅                         | `SqlOutboxStore` writes BEFORE wire, deletes only on `envelope.accepted`; 1s→5m backoff; reconnect + foreground drain kicks (`resumeOutboxKick`, `outboxKickThrottle`)                         |
| MS-02 | App killed mid-send → resends exactly once after restart | 🟡                         | Enqueue-before-send + boot replay covers the send; **but no background/killed/reboot pipeline (OR-1 open)** — queued sends wait for the next manual app open (no WorkManager / BOOT_COMPLETED) |
| MS-03 | Send prepared offline (no cert / no session at launch)   | ✅                         | `deferredOutbox` persists the INTENT, re-seals on reconnect; reseal keeps COMPOSE timestamp (`outboxResealTimestamp`)                                                                          |
| MS-04 | Queued-row cert expiry (silent loss behind ✓)            | ✅                         | Reseal at drain, `OUTBOX_CERT_RESEAL_MARGIN_SEC` (SN-06/XO-1)                                                                                                                                  |
| MS-05 | One black-holing peer starves all sends (head-of-line)   | ✅                         | Per-recipient outbox lanes + bounded parallelism (`outboxLanes`, GF-6); drain wall-clock budget (OM-07)                                                                                        |
| MS-06 | Manual retry actually delivers (relay dedup trap)        | ✅                         | B-122 — fresh wire id when relay accepted the original; `freshSession:true` on `undelivered` retries                                                                                           |
| MS-07 | Rapid-burst / double-tap send races                      | ✅📱                       | B-72/73/74, `composerSendRace`; burst ordering B-318 (compose-time AAD ts) — device verify pending                                                                                             |
| MS-08 | Client-side rate limiting vs relay 429                   | ✅                         | `relaySendPacer` (300/60s bucket), `gatewayErrorPolicy` (B-241)                                                                                                                                |
| MS-09 | Send failure UX honesty (red bubble ⇒ truly failed)      | ✅                         | XO-5 queued-bubble rule; B-317 LRU-eviction false-red fixed 📱                                                                                                                                 |
| MS-10 | Max payload caps (text length / attachment size)         | ✅ (2026-07-28 fix-all s1) | **No send-side text-body cap and no attachment-size refusal found** — only `MAX_GROUP_FANOUT` 250 + cache-side 50MB cap                                                                        |

### 1.2 Receive / dedup / ordering

| #     | Edge case                                               | Status | Evidence                                                                                                                                   |
| ----- | ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| MR-01 | Duplicate envelope dedup (persistent across restart)    | ✅     | `seenEnvelopeStore` (SQLCipher, spans 30-day dwell); re-decrypt would burn the ratchet key — P0-N6                                         |
| MR-02 | Dedup at store level + content-divergent fork           | 🟡     | `appendMessageDedup` (M12 `X`→`X#n`); B-138 hydration dedup; **no DB `UNIQUE(envelope_id)` — app-layer only (M8 partial, migration owed)** |
| MR-03 | Out-of-order arrival → correct splice + still notifies  | ✅     | Binary splice on `created_at`; B-132 per-convo seen-set; M16 both directions                                                               |
| MR-04 | Clock-skewed peer pins rows at bottom                   | ✅     | `orderingClock` display clamp (OM-02), AAD windows untouched                                                                               |
| MR-05 | One stuck head envelope starves the HTTP drain          | ✅📱   | B-315 in-run paging cursor + redrain nudge                                                                                                 |
| MR-06 | Crash between ratchet advance and plaintext write       | ✅     | Whole receive critical section in ONE txn; ROLLBACK undoes ratchet (P0-N14)                                                                |
| MR-07 | WS and HTTP receive paths behave identically            | ✅     | M5 fully shared (dedup, ack rule, trust anchor, cert admission, in-flight guard)                                                           |
| MR-08 | Transient failures leave envelope redeliverable         | ✅     | M6 — `LeaveOnRelayError` for clock-skew/future AAD; storage-full/`SQLITE_BUSY` classified transient                                        |
| MR-09 | Decrypt failure → visible placeholder, session recovery | ✅     | `decryptFailureSignal` gap marker; `runDecryptRecovery`; session-wipe protection (P0-1)                                                    |
| MR-10 | Recipient-destroyed envelope → sender auto-resend       | ✅     | B-46 `undeliverableResend` (bounded; direct-only, refuses media/groups/expired)                                                            |
| MR-11 | ACKed-but-never-rendered message                        | 🔴     | **B-262 — P0 DATA LOSS, OPEN** (server forensics done; blocked on sender-bubble confirmation)                                              |
| MR-12 | Stuck global error banner across chats                  | 🔴     | B-262a — decrypt banner has no matching clear site; persists for process lifetime                                                          |
| MR-13 | Receive-side flood control                              | 🟡     | Drain page caps + budgets only; no inbound rate limiting (low risk — relay paces)                                                          |
| MR-14 | Memory↔disk consistency on rollback                     | 🟡     | M9 residue: ROLLBACK undoes SQL but not the Zustand append; M12 residue: inbound lanes upsert pre-append object (id fork)                  |

### 1.3 Ticks / receipts / multi-device

| #     | Edge case                                              | Status | Evidence                                                                                                                                                           |
| ----- | ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MT-01 | One-tick-rule on every surface incl. unknown status    | ✅     | `messageTicks`, `tickIcon`, B-131 list/chat parity                                                                                                                 |
| MT-02 | Status ladder monotonic (no delivered→sent downgrade)  | ✅     | `messageStatusMonotonic` (XO-4)                                                                                                                                    |
| MT-03 | Delivered tick under sealed sender (HTTP submits)      | ✅     | `httpReceiptReconcile` — anonymous capability poll via retract token                                                                                               |
| MT-04 | Undeliverable leg parity with delivered                | ✅     | B-143 `envelopeLegParity`; group semantics deliberately pessimistic (any-leg-destroyed ⇒ undelivered)                                                              |
| MT-05 | Group read = ALL members read (WhatsApp rule)          | ✅     | B-116 aggregation; B-186 owner-key/UUID id-space fix + late-member deadlock fix                                                                                    |
| MT-06 | Group ✓✓ = ALL legs delivered                          | 🔴     | **B-187 OPEN — first-leg-wins: ✓✓ means "≥1 member has it"**; truthful rule needs per-recipient retract-token map (schema bump). `groupTickFirstLegWins` DOCUMENTS |
| MT-07 | Read receipts survive backup restore                   | ✅     | `receiptRestoreFidelity`                                                                                                                                           |
| MT-08 | Read-receipt privacy toggle (WhatsApp/Signal setting)  | 🔴     | Not found — no user-facing receipts on/off switch                                                                                                                  |
| MT-09 | Multi-device: sync of messages/read-state, ring parity | 🔴     | `EXPO_PUBLIC_MULTI_DEVICE` default OFF (CRIT-7); no cross-device edit/delete sync protocol (SYNC-4 🔒)                                                             |

### 1.4 Mutations: edit / delete / reactions / replies / forward

| #     | Edge case                                                  | Status                                                                                                     | Evidence                                                                                                                            |
| ----- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MM-01 | Edit window (WA: 15min) + authorship auth                  | ✅                                                                                                         | `messageMutationGate` — 15min send-side; receiver checks authorship (correct for 30-day dwell); "edited" handling in mutation lanes |
| MM-02 | Delete-for-everyone window (WA: ~60h) + tombstone          | ✅                                                                                                         | 48h send-side window; delete-beats-edit LWW; unknown target → durable stash, never drop; persistence proven vs real SQLite          |
| MM-03 | Mutation arrives before target / target off-window         | ✅                                                                                                         | Three-tier apply + `pendingMutationStore` (30-day retention, re-gated on replay)                                                    |
| MM-04 | Reaction before target, idempotent merge                   | ✅                                                                                                         | `reactionMerge` (one-emoji-per-reactor), `pendingReactionStore` capped, B-135 in-txn ack                                            |
| MM-05 | Reaction/reply to a deleted-for-everyone message           | ✅ (2026-07-28 fix-all: 3-tier reaction guards + startReply/preview tombstone guards)                      | No `deleted_for_all` guard in reaction lanes; no reply-to-retracted guard; `previewForReply` empty for voice/video notes            |
| MM-06 | Reaction envelope bound to its conversation                | 🔒                                                                                                         | B-128 part 2 — reaction AAD is `{to, ts}` only; conversation checks INERT (sealed-sender AAD stop-condition)                        |
| MM-07 | Group reply carries quote on the wire                      | ✅                                                                                                         | B-144 fixed at 5 sites + 8-site census ratchet (`replyWireParity`); B-145 preview cap both sides                                    |
| MM-08 | Reply-jump reliability                                     | 🟡                                                                                                         | `replyJumpParity` ✅; but jump resolves on `m.id` only — an M12-forked id (`X#n`) can never be jump-targeted                        |
| MM-09 | Forwarding as first-class (label, count, re-encrypt rules) | 🟡 (2026-07-28 fix-all: `isForwarded` wire flag + chip + v19 persist + backup; forward-COUNT still absent) | `forwardTo` exists but **no forwarded flag/label, no forward-count**, no forward-specific handling                                  |
| MM-10 | Group mutation membership gates                            | ✅                                                                                                         | B-128 part 1 (reaction membership), B-136 non-member text → `discarded` not false ✓✓                                                |

### 1.5 Disappearing / privacy / block

| #     | Edge case                                               | Status | Evidence                                                                                                                                                                      |
| ----- | ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP-01 | Per-chat TTL, expiry sweep, server-side purge           | ✅     | `expirySweeper` + `/envelopes/retract` + media cache purge; B-160 cost fix                                                                                                    |
| MP-02 | Clock skew must not insta-burn short-TTL messages       | ✅📱   | B-316 — 5-min grace at BOTH live + stash sites (`expiredEnvelopeGate`)                                                                                                        |
| MP-03 | TTL change propagates cross-device / to peer            | 🔴     | TTL is local per-conversation state; **no TTL-change control envelope found**                                                                                                 |
| MP-04 | View-once media / screenshot guard (WA 2026 std)        | 🔴     | Not implemented anywhere                                                                                                                                                      |
| MP-05 | Block: inbound drop incl. already-stashed messages      | ✅     | `blockedPeers` (owner-scoped, fails open by design); B-141 stash re-gate; optimistic block w/ rollback                                                                        |
| MP-06 | Block: sender side (you are blocked → one tick forever) | 🟡     | Not explicitly handled; sealed sender makes relay-side signalling impossible by design — silent non-delivery is the observed behaviour. Needs a product decision, likely fine |
| MP-07 | Locally-deleted rows must not resurrect via restore     | ✅     | `restoreTombstones` (M-08, 20k cap)                                                                                                                                           |
| MP-08 | Presence/last-seen privacy + retention                  | ✅     | B-146 privacy strip vs retention; B-147 future-skew window; server reaper real (B-150 retracted)                                                                              |
| MP-09 | Typing indicator lifecycle                              | ✅     | Cleared on switch/draft-clear/roster change (B-117); group label                                                                                                              |
| MP-10 | No plaintext in logs (bodies/keys/media)                | ✅     | `logAudit` static gate over 3 roots (one known hole: multi-line log calls)                                                                                                    |

### 1.6 Media / voice notes

| #     | Edge case                                          | Status                                                                     | Evidence                                                                                          |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| MD-01 | Encrypted attachments, per-file key in-band        | ✅                                                                         | AES-CBC, key+iv only inside sealed envelope (`mediaClient`, `aesCbc`)                             |
| MD-02 | Upload: progress, cancel, retry, truncation detect | ✅                                                                         | `uploadProgress` clamp/quantise; length probe + fresh-key retry; inactivity-based ceiling (SN-02) |
| MD-03 | Resumable / chunked upload (kill-mid-upload)       | 🔴                                                                         | Single PUT; every retry replays ALL bytes (header admits "no Range resume")                       |
| MD-04 | Download failure classes + tap-to-retry            | ✅                                                                         | `attachmentError` 403/404/offline/unavailable                                                     |
| MD-05 | Ciphertext cache bounded (LRU 200MB/50MB)          | 🟡                                                                         | `mediaBlobCache` ✅; minor: over-cap `put` doesn't invalidate an existing smaller row             |
| MD-06 | Voice-note recorder interruption lifecycle         | ✅                                                                         | B-148 ×4 (session release, stop re-entrancy, unmount, real duration); B-149 plaintext cleanup     |
| MD-07 | Multi-photo albums, viewer paging                  | ✅                                                                         | B-288, B-287/293–296                                                                              |
| MD-08 | Proactive free-space check before download/backup  | ✅ (2026-07-28 fix-all: download precheck → 'no_space'; restore warn-only) | Only reactive `SQLITE_FULL`/507 handling                                                          |

### 1.7 Groups

| #     | Edge case                                            | Status | Evidence                                                                                                                             |
| ----- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| MG-01 | Membership change mid-flight, out-of-order admin ops | ✅     | Epoch monotonicity (G1), `pendingAdminActionStore` replay                                                                            |
| MG-02 | Rekey on removal incl. leaver-can't-authorize        | ✅     | `applyGroupAdmin` leave-rekey delegation; partial-rekey now visible                                                                  |
| MG-03 | Key fan-out reliability                              | 🔒     | **GF-2 — ALL key material fan-out is fire-and-forget**; zombie socket can swallow a rekey (master-key stop-condition)                |
| MG-04 | Stale-key self-heal                                  | 🔴     | GF-3 — resync path is dead code + stash deleted after 3 boots ⇒ permanent per-member loss                                            |
| MG-05 | Envelope-before-key stash                            | ✅     | `pendingGroupEnvelopeStore` + boot/live drains; B-142 fail-loud                                                                      |
| MG-06 | Group create/hijack protection                       | ✅     | B-127 P0 fixed (`inboundGroupCreateGate`); residual: B-298 create-branch epoch rollback 🔒                                           |
| MG-07 | Member add approval / permissions model              | 🔒     | B-221/222 — no request/approval mechanism; Add UI dead-ends for non-admins                                                           |
| MG-08 | Human names everywhere (no raw ids)                  | 🔴     | B-223/224/226 — raw userId/hex codes persisted in system bubbles + 7 surfaces                                                        |
| MG-09 | Call-key namespace isolation from chat groups        | 🔒     | **M4 VIOLATED** — call keys aliased onto real chat ids, no teardown/TTL; "every new consumer of `state.groups[id]` is a fresh B-124" |

### 1.8 Notifications (message-side)

| #     | Edge case                                                | Status                                                                                                                                                          | Evidence                                                                                                             |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| MN-01 | Notify iff committed (no ghost banners, no misses)       | ✅                                                                                                                                                              | M16 both directions, mutation-proved                                                                                 |
| MN-02 | Per-chat grouping, Person model, summary                 | ✅                                                                                                                                                              | GAP-1/2 shipped 2026-07-27 (`msgNotifConversationShape`) 📱                                                          |
| MN-03 | Reply / mark-read from notification survive process kill | ✅                                                                                                                                                              | Durable `pendingActions` queue drained via outbox                                                                    |
| MN-04 | Badge accuracy incl. muted chats                         | ✅                                                                                                                                                              | N-17/B-231; BS-MUTE-UNREAD                                                                                           |
| MN-05 | Tap routing correct incl. cold start                     | 🔴                                                                                                                                                              | B-54 fixed, but **B-227 — cold-launch deep-link dropped** (8s wait vs 10–25s measured launch)                        |
| MN-06 | Killed-app push shows (non-decrypting) banner            | ✅                                                                                                                                                              | `fcmHeadless` generic banner                                                                                         |
| MN-07 | iOS message notifications                                | 🟡 (rows were STALE — or3IosBannerLane already pinned the lane; explicit registerDeviceForRemoteMessages landed 2026-07-28; iOS build/APNs cert still external) | **IOSMSG-1/2/3 — iOS shows ZERO message notifs** (early return, no permission request, apns-priority 10 vs needed 5) |
| MN-08 | Missed push ≠ lost notification (server inbox)           | 🔴                                                                                                                                                              | GAP-3 — migration written, NOT applied                                                                               |
| MN-09 | Re-alert suppression bounds                              | 🟡                                                                                                                                                              | B-235 — 500-entry map `clear()` forgets in-flight windows; B-234 iOS payload cast rejects banner                     |

### 1.9 Identity / restore / boot

| #     | Edge case                                                       | Status                                                                   | Evidence                                                                                         |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| MI-01 | Peer reinstall → safety-number change surfaced, sessions resume | ✅                                                                       | Recorded always + banner; strict send-gate behind flag (WhatsApp-parity default); persisted acks |
| MI-02 | Identity flip on existing row rejected (TOFU)                   | ✅                                                                       | `strictIdentityTrust` (P0-1/P0-S6)                                                               |
| MI-03 | Prekey exhaustion under offline burst                           | 🟡                                                                       | Rotation primitives wired; exhaustion path untested/unverified                                   |
| MI-04 | Restore: ordering, receipts, tombstones, live interleave        | ✅                                                                       | B-78, `restoreBatchHydrate`, `receiptRestoreFidelity`, M15 stash gates                           |
| MI-05 | First-boot drain must not starve JS thread                      | ✅                                                                       | B-155 cooperative yield; B-310 Merkle 9.5s stall fixed 📱                                        |
| MI-06 | Drafts persist across restart (WA std)                          | ✅ (2026-07-28 fix-all: SQLCipher drafts table + sink + composer wiring) | Draft is route-param + local state only — no store slice, no persistence                         |
| MI-07 | Contact normalization (E.164, double-prefix)                    | ✅                                                                       | B-154 `phoneNormalize`                                                                           |
| MI-08 | Link preview robustness                                         | ✅                                                                       | B-151/157 (attr order, no negative caching, shared in-flight)                                    |

---

## Part 2 — CALLS

### 2.1 Ring / offer / answer lifecycle

| #     | Edge case (industry std)                                         | Status | Evidence                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-01 | Incoming call, app killed → push wake + ring                     | ✅     | B-53 (device-verified vc130): zombie-socket suppression, offer queue + VoIP wake always; HMAC-signed wakes w/ nonce replay window; N-03 90s clock-skew tolerance; native-bounded ringtone (45s) |
| CR-02 | Cancel push — killed device must stop ringing                    | ✅     | N-02 cancel push + hangup purge of pending offers; no-sig hangup branch dismisses looping ring (`callHangupWhileRinging`)                                                                       |
| CR-03 | Android 14+ full-screen-intent denied                            | ✅     | B-63 — `canUseFullScreenIntent()` + Settings deep-link in reliability card                                                                                                                      |
| CR-04 | Lock-screen answer + foreground handoff                          | ✅     | P1-BR-8 posture; NA-04 `bringAppToForeground` on BOTH branches (CallKeep bare-intent trap avoided)                                                                                              |
| CR-05 | Unanswered ring timeout + missed-call row                        | ✅     | `callRingState` 45s both sides, writes `missed_call_*`, emits hangup                                                                                                                            |
| CR-06 | Busy callee → caller told                                        | ✅     | `call.hangup{reason:'busy'}`; restore-mode busy-reject (B-107)                                                                                                                                  |
| CR-07 | Call waiting: 2nd 1:1 during a call                              | ✅📱   | B-238-CW non-destructive banner on both screens (`callWaiting`)                                                                                                                                 |
| CR-08 | Glare: incoming during outgoing boot window                      | ✅📱   | B-322 — route-name fallback closes the ~6s `getActiveCall()` null window                                                                                                                        |
| CR-09 | Renegotiation glare (both reoffer)                               | ✅     | Stable-state-only rule + rollback incl. `have-remote-offer` edge                                                                                                                                |
| CR-10 | Answer races: silent-resolve, watchdog inversion, WS-down answer | ✅     | B-274 two honest outcomes; B-130 timer ordering (50s>40s>20s) mutation-proved; NA-05 answer queued across ring window                                                                           |
| CR-11 | Answer-from-notification stuck (null controller)                 | ✅📱   | **B-319** — `controllerReady` gate at both assignment sites + latch re-fire (`89c2448`, v1.0.184) — device verify PENDING                                                                       |
| CR-12 | Notification param clobber / duplicate accept                    | ✅     | B-102 latch + sticky SDP ref; callId-deduped accept (Telecom+notifee)                                                                                                                           |
| CR-13 | Double-tap dial mints two calls                                  | ✅     | CALL-17 launch latch + registry handoff                                                                                                                                                         |
| CR-14 | Stale/dead offer must not ghost-answer                           | ✅     | B-110 — 6s TURN ceiling + STUN fallback + 45s accept-intent expiry                                                                                                                              |
| CR-15 | Offer authenticity before ringing                                | ✅     | S7 — signed AAD sender-cert verify gates CallScreen wake                                                                                                                                        |
| CR-16 | Declined vs missed vs busy distinguished                         | ✅     | Typed `HangupReason`; junk chat-row side effect killed (B-134)                                                                                                                                  |
| CR-17 | Blocked contact never rings                                      | ✅     | P1-11 server drops offer + filters ring + no wake                                                                                                                                               |
| CR-18 | Multi-device ring / "answered elsewhere"                         | ⚫     | N/A by design — single device per account (B-71 eviction); `answeredElsewhere` code path dormant, no producer                                                                                   |
| CR-19 | Headless answer/decline without launching app UI                 | 🔴     | Parity items 9/10 scored ❌ — Answer launches the app (Telecom `reportIncomingCall` never fired headless); headless decline endpoint shipped but end-to-end unverified                          |

### 2.2 Busy / concurrent-call guards

| #     | Edge case                                | Status | Evidence                                                                                                                                                                           |
| ----- | ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CB-01 | Dial over any live call blocked          | ✅📱   | B-320 — combined 1:1+group check above the group branch; same-room rejoin allowed; stale-registry orphan leave fixed                                                               |
| CB-02 | Two stacks sharing one audio session     | ✅     | B-243 arbiter — all four stop sites funnelled; bare `InCallManager.stop()` banned by scan (device QA owed)                                                                         |
| CB-03 | Group ring during a 1:1                  | 🟡     | B-306 parked ring (45s TTL, one navigation actor) + B-321 minimized-consume 📱; **real call-waiting UI for group rings = open feature work**; parked-TTL missed bubble absent (P3) |
| CB-04 | Group ring during a group call           | 🔴     | OPEN (W4.2/W4.3) — rings into call audio                                                                                                                                           |
| CB-05 | System call UI raised before busy branch | 🔴     | W4.2 — busy device still gets a system call surface; FCM wake path has no active-call check                                                                                        |

### 2.3 Network resilience / reconnect

| #     | Edge case                                      | Status                                                                                    | Evidence                                                                                                                             |
| ----- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CN-01 | Mid-call ICE failure → reconnect not kill      | ✅                                                                                        | B-108 — `everConnected` gate + budget-as-sole-authority (1:1) / restart loop + health probe (group); never-connected keeps fail-fast |
| CN-02 | ICE-restart reoffer lost (peer asleep)         | ✅                                                                                        | M-12 interval re-send while `'reconnecting'`                                                                                         |
| CN-03 | Restart racing remote teardown                 | ✅📱                                                                                      | B-307 — teardown wins, quiet catch when terminal                                                                                     |
| CN-04 | Network-switch survival (WiFi↔LTE)             | 🟡                                                                                        | ICE restart machinery ✅; **F-3 open: TURN creds fetched once, restart reuses possibly-dead relays**                                 |
| CN-05 | Locked-phone reconnect (RN timers frozen)      | ✅                                                                                        | LC-1..5 — event-driven reconnect, wall-clock guards/budgets, rejoin hub across minimize                                              |
| CN-06 | NetInfo flap must not kill healthy call socket | ✅                                                                                        | LC-3/B-58 — liveness from inbound-signal clock + resume guard + 12s server grace                                                     |
| CN-07 | Auth token expiry mid-call (15-min JTI wall)   | ✅                                                                                        | B-100 deployed — in-place WS `auth.refresh`, renewal off Manager `ping`                                                              |
| CN-08 | TURN blocked / relay policy                    | ✅                                                                                        | B-41 — `'all'` default + env escape hatch                                                                                            |
| CN-09 | Bandwidth adaptation                           | 🟡 (2026-07-28 fix-all: quality banner ✅ both screens; audio-only fallback still absent) | Sender tuning (600k/32k, maintain-framerate) + 1s stats ✅; **no auto audio-only fallback, no user-facing quality banner**           |
| CN-10 | Clock drift                                    | ✅                                                                                        | N-03 wake skew; B-303 monotonic watchdog                                                                                             |

### 2.4 Audio routing / interruptions

| #     | Edge case                                       | Status                                                                                                                    | Evidence                                                                                                                                                                 |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CA-01 | Headset connected at call start → correct route | ✅                                                                                                                        | B-251/B-297 shared decision; B-309 evidence-settled opening route (verified vs Telecom/Agora/WhatsApp policy)                                                            |
| CA-02 | Route sticky across lock/app-switch             | ✅                                                                                                                        | B-278 — belief-cache invalidation on transitions                                                                                                                         |
| CA-03 | Mid-call BT/wired connect/disconnect            | ✅                                                                                                                        | Last-connected-wins + fall down chain (B-309 rules); SCO churn de-dupe                                                                                                   |
| CA-04 | Route picker usable early in call               | 🔴                                                                                                                        | **B-236u — ~11s empty-device-list dead window, taps dropped, no queue-and-apply**; BT auto-select hazard (buds in pocket = silence, no UI indication)                    |
| CA-05 | GSM/PSTN call arrives mid-VoIP-call             | 🟡                                                                                                                        | Audio-focus LOSS → mute + banner, GAIN → resume (both screens) — **reactive only: no PHONE_STATE observation, no hold, no auto-resume contract, no busy to VoIP caller** |
| CA-06 | Hold semantics                                  | 🔴                                                                                                                        | Not implemented (no `setOnHold`, no CallKit hold handler)                                                                                                                |
| CA-07 | DND / silent mode                               | 🟡 (2026-07-28 fix-all: DND reliability row + settings deep link, NEW APK required; DND-bypass call channel still absent) | Call channel does NOT bypass DND (only SOS does); no ringer-mode read; a DND phone silently misses calls with no surfacing                                               |
| CA-08 | Alarm/notification audio focus share            | ✅                                                                                                                        | Focus listeners both screens; speaker-on-reacquire re-apply                                                                                                              |
| CA-09 | iOS group-call audio routing                    | 🔴                                                                                                                        | B-114 — `chooseAudioRoute` is Android-only no-op; iOS group audio out the earpiece                                                                                       |
| CA-10 | Proximity sensor (screen off at ear)            | ❓                                                                                                                        | Not audited — likely InCallManager default; verify on device                                                                                                             |

### 2.5 OS lifecycle / background

| #     | Edge case                                        | Status | Evidence                                                                                                             |
| ----- | ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| CL-01 | Backgrounded call stays alive (typed FGS)        | ✅     | `phoneCall\|microphone\|camera` FGS full-duration both call kinds; B-70 manifest fix; B-69 camera-type ratchet       |
| CL-02 | Zombie FGS notification                          | ✅     | B-64 — native-first hangup action + zombie-session end                                                               |
| CL-03 | System PiP for video calls                       | 🔴     | LC-15 — not implemented; in-app `FloatingCallOverlay` only                                                           |
| CL-04 | Camera pause on background, resume on foreground | ✅     | LC-12/13 + producer.pause                                                                                            |
| CL-05 | Minimized 1:1 keeps protections                  | 🟡     | LC-11 — budget pause + camera recovery live in unmounted screen scope                                                |
| CL-06 | Doze/OEM kill prevention                         | 🟡     | LC-8 — dismissible battery card only; nothing on call path re-checks                                                 |
| CL-07 | Telecom integration for group calls              | 🔴     | LC-10 — never registered; loses OS keep-alive; non-Telecom accept of Telecom ring leaks permanent-ringing connection |
| CL-08 | Process death holding call FGS                   | 🔴     | B-68 — crash class, open (blocked on crash-buffer capture)                                                           |
| CL-09 | Mic/cam permission denial                        | ✅     | `requestMultiple` + rationale + classified getUserMedia errors                                                       |
| CL-10 | Calls suppressed during backup restore           | ✅     | B-107 — busy-reject before ring surface, group rings ignored, FCM CALL branch skipped                                |

### 2.6 Group calls / encryption

| #     | Edge case                                                | Status                                                                                                                                   | Evidence                                                                                                                                                                  |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CG-01 | Full join/leave state model + room cap                   | ✅                                                                                                                                       | 12-state terminal model; `room_full` at 10 both sides; kicked-vs-leave classified                                                                                         |
| CG-02 | Late join to in-progress room (no ghost rooms)           | ✅                                                                                                                                       | by-conversation probe, idempotent createRoom                                                                                                                              |
| CG-03 | Host leaves / ends                                       | ✅                                                                                                                                       | `ended-by-host` teardown; B-213 cold-launch pop fallback                                                                                                                  |
| CG-04 | Rejoin after minimize/navigate keeps timer+roster        | ✅                                                                                                                                       | B-33; LC-4 rejoin hub                                                                                                                                                     |
| CG-05 | E2E key absent → fail closed, resolve on arrival         | ✅                                                                                                                                       | `groupCallKeyWait` 25s ceiling; B-111-A iOS honest refusal                                                                                                                |
| CG-06 | **Roster change forks SFrame epoch → silent members**    | 🔒                                                                                                                                       | **B-237 CONFIRMED, unfixed** — miss ONE admin envelope = stranded forever (text works, calls silent); heal only when owner hosts. Master-key stop-condition → arch review |
| CG-07 | Mid-call invite keyed before ring                        | ✅📱                                                                                                                                     | B-300 (P0) — `ensureCallGroupKey` union before `sfu.ring`, fail-closed                                                                                                    |
| CG-08 | Ring honesty (phantom ring, host-end cancel, ghost ring) | ✅                                                                                                                                       | B-299 split exits; B-12 ring-cancel + missed bubble; B-247 ring set                                                                                                       |
| CG-09 | Post-host-hangup "call back" refused                     | ✅ (2026-07-28 fix-all s1: server corpse reap + ring-cancel `endRoomIfEmptyByHost`; deploy owed)                                         | B-238 root-caused: dead-room corpse                                                                                                                                       |
| CG-10 | Ring token blackout (killed members never ring)          | 🟡 (2026-07-28 fix-all s2: fan-out summary warn + boot APNs probe + `/push/token-health`; the OPS half — tokens + APNs env — still owed) | B-239                                                                                                                                                                     |
| CG-11 | Escalation 1:1→group atomic + route/key handoff          | ✅📱                                                                                                                                     | B-301 (keepAlive ride-through), B-302 route seed, B-124/125 key-namespace aliases replaced                                                                                |
| CG-12 | Call-time key-mismatch surfaced to user                  | 🔴                                                                                                                                       | Not found — B-237's fix direction explicitly proposes it; today = silent frame drops                                                                                      |
| CG-13 | Mute/camera state sync + restore rehydration             | ✅                                                                                                                                       | `call.media-state` re-bound on remount; CALL-N11 registry rehydration (dup m-line trap)                                                                                   |
| CG-14 | Tile lifecycle (pause placeholder, stall, prune)         | ✅                                                                                                                                       | 10+ pinned tile tests; B-17 class closed                                                                                                                                  |

### 2.7 iOS call parity (cluster)

| #     | Item                                    | Status                                                            |
| ----- | --------------------------------------- | ----------------------------------------------------------------- |
| CI-01 | Locked-iPhone ring (APNs VoIP cert/env) | 🔴 P-1 — blocked on org App ID + cert                             |
| CI-02 | iOS lock cuts the call                  | 🟡 B-109 — code landed, Mac prebuild + M1–M8 matrix unreported    |
| CI-03 | iOS group calls                         | 🔒 B-111-B — refuse by design until Swift FrameCryptor port       |
| CI-04 | iPhone camera never renders on Android  | 🟡 B-99 — VP8-first landed preventively; on-iPhone diagnosis owed |
| CI-05 | Cancel-to-iOS / wake parity             | 🟡 B-112/113 — server deployed, client rides unbuilt iOS build    |

---

## Part 3 — Ranked gaps (the industry-standard cases we do NOT meet)

### Tier 1 — data loss / dead features (act first)

1. **B-262 — 1:1 message ACKed then never rendered (P0 DATA LOSS, open).** One forensic bit missing (sender's bubble state).
2. **iOS message notifications are ZERO** (IOSMSG-1/2/3: early return, no permission request, wrong apns-priority) + **P-1** locked-iPhone ring dead. iOS is effectively not notified at all.
3. **B-237 SFrame epoch fork** — one missed admin envelope = permanently silent group calls for that member. 🔒 arch-gated (master-key stop-condition).
4. **GF-3 — group stale-key self-heal is dead code** + stash deleted after 3 boots ⇒ permanent per-member message loss. Companion: GF-2 fire-and-forget rekey fan-out 🔒.
5. **B-239 ring blackout** — token-health sweep + APNs env (ops action, not code).

### Tier 2 — honesty / trust of core indicators

6. **B-187 — group ✓✓ means "one member got it"** (first-leg-wins). WhatsApp semantics = all legs. Needs per-recipient retract-token map (schema bump).
7. **B-236u — audio route picker dead for first ~11s** + BT auto-select hazard (silent calls, no route indicator in UI).
8. **B-238 `not_host`** — "I call back and nothing happens."
9. **GSM/PSTN interaction is reactive-only** — no phone-state observation, no hold, no auto-resume, no busy signal (WhatsApp: pauses and offers resume).
10. **DND handling invisible** — calls silently don't ring in DND; industry surfaces this or requests bypass.
11. **B-262a** stuck global decrypt banner; **B-227** cold-launch notification deep-link dropped.

### Tier 3 — WhatsApp-parity features absent by design (product decisions needed)

12. **Multi-device**: flag OFF + single-device eviction — ring fan-out, read-state sync, mutation sync (SYNC-4 🔒) all N/A today. Fine if intentional; document it.
13. **No background send pipeline (OR-1)** — killed app ⇒ queued sends wait for next open (WhatsApp delivers via its push-triggered process).
14. **No server-side notification inbox (GAP-3)** — missed push = permanently lost signal; migration written, unapplied.
15. **Drafts don't persist** across restart (M-I06).
16. **Forwarding unlabelled** (no "Forwarded" tag/count); **view-once absent**; **disappearing-TTL change doesn't propagate** to peer devices; **no read-receipt privacy toggle**.
17. **Media**: no resumable/chunked upload (retries replay all bytes); no proactive free-space check; no send-side size/length caps.
18. **Calls**: no system PiP (LC-15); no hold (CA-06); no audio-only fallback or in-call quality banner (CN-09); no call-time safety-number surface (CG-12); group calls outside Telecom (LC-10).

### Device-verify queue (fixed in code, unproven on hardware)

B-313/315/316/317/318 (stability sweep, v1.0.184) · B-319/320/321/322 (`[CALLDIAG]` autoAccept signature) · B-306/307/308/AC-3 (`[ring.route] PARKED → [ring.handoff] consuming → [ring.screen] mounted`) · B-243 audio arbitration matrix · B-100/101 V1–V8 matrix · B-107 restore gate · B-102 rows blocked on rig.

---

### Benchmark sources

- WhatsApp Help Center — call waiting semantics; TechCrunch — edit 15-min window, delete-for-everyone 60h; androidpolice — multi-device "answered on another device"; WABetaInfo/Engadget 2026 — view-once text + new disappearing timers
- Signal — session reset / "Bad encrypted message" guidance (signalapp GitHub issues, @signalapp)
- element-hq riot-android VoIP checklist — glare tiebreaker, multi-device ring
- Interruption-testing checklists — Codoid, Testsigma, Testscenario, BrowserStack; DSDS GSM-data-drop analyses (gadgetroyale, Samsung community)
