# B-121 Messenger Reliability — Implementation Plan (50 findings)

**Generated:** 2026-07-20 · **Tree:** `E:\Bravo Secure` · **Branch base:** `main`

- **40 findings** scheduled across **8 waves** / **25 work items**.
- **10 findings** are architecture-gated → **NEEDS-APPROVAL** (bottom of this doc), not in a wave.
- **6 findings** are duplicates of another finding and are implemented as part of it (no separate work).
- Wave disjointness is **machine-verified**: no two items in the same wave edit the same file.

The binding constraint is `src/modules/messenger/runtime/productionRuntime.ts` (8031 lines,
**28 of 50 findings**). It is serialized into an 8-link chain: `RT-1 → RT-2 → … → RT-8`.
Exactly one item per wave may hold it. Everything else is scheduled around that chain.

---

## 0. Rules every implementing agent must follow

1. **You own exactly the files listed in your item.** Do not touch any other production file.
   Test files are exempt from the exclusion set _except_ where two items are told to edit the same
   test file (never happens in this plan — each item's new tests are its own).
2. **`npm run typecheck` must stay ≤ 47** (`.tsc-baseline.json`). Never run `npm run tsc:rebaseline`.
3. **`packages/messenger-core/__tests__/logAudit.test.ts` must stay green.** No new log line may
   carry a body, reaction, payload, key bytes, retract/ack token, or plaintext.
4. **SCHEMA_VERSION is claimed, not chosen.** Only three items bump it, in this order:
   `STORE-1` → **v15**, `RT-6` → **v16**, `RT-7` → **v17**. Read the current constant before
   editing; if it is not what this plan says, stop and report. Every new `ALTER` must sit **after**
   the v7 rebuild block.
5. **BACKUP_LOOP.md is mandatory** for `RT-6` and `RT-7` (they write `messages` rows / add
   serialized columns). Run §4 gates + the §5 idle-boot silence probe. If a new column enters
   `serializeMessage`, `versionHash` changes for **every row** and the next boot re-mirrors all
   history — the B-94 `root_mismatch` factory. See the hard gate on RT-7.
6. **Never import `Alert` from `react-native`** (use `@utils/alert`). **No `react-native-reanimated`**
   (worklets babel plugin is absent).
7. Anything touching `packages/messenger-core/**` must also pass
   `cd apps/ops-console && npm run typecheck` (shared consumer).
8. If your spec's fix collides with reality (anchor text moved, another item already refactored the
   region), **stop and report** — do not improvise a merge.

---

## 1. Wave plan

### Wave 1 — 13 items (10 client, 3 server) · trivial + independent-file work lands first

| itemId      | findings                                                                      | complexity | one-line                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **STORE-1** | OM-07, XO-3, XO-5, GF-1(client store), SRV-01(client store), OR-1(store half) | large      | One coherent outbox retry/backpressure layer: status-based failure classification, a real backoff ladder, `Retry-After`, a send pacer, and `kickPending()`. |
| **RT-1**    | OR-4, OR-6                                                                    | small      | Bounded re-run coalescer for both drains + drain the outbox on foreground resume.                                                                           |
| **MS-1**    | OM-06, XO-4                                                                   | trivial    | `messengerStore`: monotonic status ladder + recency-guarded `last_message`/MRU.                                                                             |
| **GRP-1**   | GF-4                                                                          | small      | Home-sync roster overwrite prefers local crypto membership over the stale server roster.                                                                    |
| **VID-1**   | GCV-1                                                                         | small      | Pin 640×480 capture constraints at all 5 `getUserMedia` sites.                                                                                              |
| **VID-2**   | GCV-4, GCV-2, GCV-5                                                           | small      | Group-call tile: selfie mirror follows the lens, `objectFit` policy, live page geometry.                                                                    |
| **CALL-A**  | NA-01, NA-03, NA-04                                                           | medium     | Incoming-call cache merge, bootstrap ordering, and unconditional bring-to-foreground on Telecom answer.                                                     |
| **CALL-B**  | NA-06                                                                         | small      | Single ringtone: native-ring ownership observable, in-app tone yields to it.                                                                                |
| **CALL-C**  | NA-05                                                                         | small      | Call-setup send budget 12s→40s, terminality-gated abandon, `cancelPending`, watchdog at answer-delivery.                                                    |
| **PATCH-1** | GCV-3                                                                         | small      | _(optional, P3)_ rotation-aware dims in the react-native-webrtc patch.                                                                                      |
| **RELAY-1** | SRV-01(server), GF-1(edit 5), SRV-05(part A)                                  | trivial    | Raise the `POST /envelopes` and ack throttles.                                                                                                              |
| **GW-1**    | SRV-04                                                                        | trivial    | Pass `conversationId` as arg 6 of the group VoIP wake.                                                                                                      |
| **WS-1**    | OR-5, SRV-07                                                                  | small      | Route `WS_SESSION_RECOVERY` through config, gate `connectionStateRecovery` on it, add the jti check.                                                        |

---

#### STORE-1 — outbox retry, backpressure, pacing

- **Findings:** OM-07, XO-3, XO-5, GF-1 (§3 store + §1 pacer + §2 relayClient), SRV-01 (File 2 + File 3), OR-1 (§1)
- **Files (exclusive):**
  - `src/modules/messenger/store/sqlOutboxStore.ts`
  - `src/modules/messenger/crypto/db.ts` ← **claims SCHEMA_VERSION 14 → 15**
  - `packages/messenger-core/src/transport/relayClient.ts`
  - `src/modules/messenger/runtime/relaySendPacer.ts` _(new)_
  - `src/modules/messenger/runtime/outboxDrainBudget.ts` _(new)_
- **Dependencies:** none (code). **Deploy order:** RELAY-1 should reach staging first so the pacer is sized against the deployed cap.
- **Scope:** every edit is **additive and back-compatible** — `recordAttempt` gains optional opts
  (`transient`, `deferMs`, `backpressure`, `permanent`) and a **widened return** (`{attempts, failed, queued}`),
  new exports (`classifyOutboxFailure`, `isPermanentRelayRejection`, `isBackpressureError`,
  `clearUnreachableBackoff`, `kickPending`, `pendingMessageIds`), `RelayHttpError.retryAfterMs`, and an
  optional `RelayHttpClientOptions.sendGate`. **No `productionRuntime.ts` call site changes** —
  those are RT-2. The tree stays green with zero adoption.
- **Reconciliations this item must make (three specs disagree):**
  1. **One column, not two.** OM-07 wants `outbox.unreachable_attempts`; XO-3 wants
     `outbox.soft_attempts`. Ship **`soft_attempts`** only (XO-3 explicitly subsumes OM-07;
     OM-07 must not be implemented independently).
  2. **One 429 seam, not three.** GF-1's `deferMs`, SRV-01's `backpressure`, and XO-3's
     `server-transient` are the same path. Ship `recordAttempt({transient?, deferMs?, permanent?})`
     where a 429/5xx/`no_token` is `transient` (never burns `attempts`) and an explicit `deferMs`
     (from `Retry-After`) overrides the computed backoff, clamped to 300 s.
  3. **Pacer window must match the server.** RELAY-1 ships `SEND_THROTTLE = 300 / 60 s`
     (SRV-01's shape, **not** GF-1's 120/10 s). Size the pacer at
     `RELAY_SEND_WINDOW_MS = 60_000`, `BUDGET = 240` (80 % headroom).
  4. **OM-07's mandatory companion.** `clearUnreachableBackoff()` must exist, or a growing offline
     backoff parks rows past reconnect — trading a battery bug for minutes-late sends.
- **Test:**
  `npx jest --selectProjects=messenger-crypto sqlOutboxStore outboxDrainBudget relaySendPacer transportClients` →
  `npm run test:crypto` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck`
- **Device gate (deferred to the release APK):** in-place APK upgrade must show **no**
  `no such column: soft_attempts` in logcat and queued rows must still drain.
- **Audit-was-wrong flags:** OM-07's proposal is incomplete without the unpark; GF-1's and
  SRV-01's headline remedy (`POST /envelopes/batch`) is **FORBIDDEN** and is rejected here.

#### RT-1 — drain coalescing + resume trigger _(productionRuntime chain link 1)_

- **Findings:** OR-4, OR-6
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/rerunCoalescer.ts` _(new)_
- **Dependencies:** none
- **Scope:** `createRerunCoalescer(run, maxReruns = 2)` wired into both `coalescedDrain` and
  `drainOutbox`; hoist a `drainOutbox(...)` kick above the `resumeAction` branch in the
  AppState-`active` handler (OR-6). Keep the loop body of `drainOutbox` as a single per-row
  lambda — RT-3 and RT-4 depend on that shape.
- **Note:** OR-6 is subsumed by OR-1's AppState wiring in RT-2; land the one-liner here anyway so
  the trivial win is in the tree from wave 1, then let RT-2 replace it with the throttled
  `kickAndDrainOutbox`.
- **Test:** `npx jest --selectProjects=messenger-crypto rerunCoalescer resumeOutboxKick callResumeGuard` →
  `npm run test:crypto` → `npm run typecheck`

#### MS-1 — store invariants

- **Findings:** OM-06, XO-4
- **Files:** `src/modules/messenger/store/messengerStore.ts`
- **Dependencies:** none. **Land early** — later outbox/retry items inherit the monotonic invariant.
- **Scope:** `isStatusRegression` ladder (`sending < sent < delivered < read`, with
  `failed`/`undelivered` deliberately **off-ladder**) in `updateMessageStatus`/`Bulk`;
  `supersedesLastMessage(cur, next)` gating the preview write and MRU re-splice at **both**
  `appendMessage` write sites (incl. the direct→UUID reroute branch). Unread badge still bumps.
- **Test:** `npx jest --selectProjects=messenger-crypto messageStatusMonotonic appendMessageDedup envelopeDelivered decryptFailureSignal undeliverableResend groupReadReceipts conversationTtl hydrateLastMessage directConversationMerge groupConversationUpsert` →
  `npx jest --selectProjects=app conversationListOrder` → `npm run test:crypto` → `npm run typecheck`
- **Audit-was-wrong flag:** OM-06's symptom wording is off — Home re-sorts by
  `last_message.created_at`, so a stale insert makes the thread **sink**; the move-to-front is only
  visible in ChatScreen's raw-order list.

#### GRP-1 — group roster overwrite

- **Findings:** GF-4
- **Files:** `src/modules/messenger/runtime/pendingRosterIntents.ts`, `src/screens/messenger/MessengerHomeScreen.tsx`, `src/screens/messenger/ChatScreen.tsx`
- **Dependencies:** none
- **Scope:** optional `cryptoMembers` arg on `resolveRosterOverwrite`; prefer
  `Object.keys(groups[gid].members)` when local group state exists, server roster as fallback.
- **Test:** `npx jest --selectProjects=messenger-crypto pendingRosterIntents conversationIntents` →
  `npm run test:crypto` → `npm run typecheck`
- **Audit-was-wrong flag (important):** the audit's literal "union server ∪ crypto" fix is **WRONG** —
  it resurrects a removed member on non-adder devices (the P1-5 privacy defect) and revives a union
  that was deliberately reverted. Do **not** implement the audit's version.

#### VID-1 — capture constraints

- **Findings:** GCV-1
- **Files:** `src/modules/messenger/webrtc/peerConnectionFactory.ts`, `src/modules/messenger/webrtc/useGroupCall.ts`
- **Dependencies:** none. **Must land before VID-2 is device-verified** (VID-2's "keep cover" option is only coherent once capture is pinned).
- **Scope:** exported `localVideoConstraints(facing)` used at all 5 capture sites (boot included,
  so the literal cannot drift).
- **Test:** `npx jest --selectProjects=messenger-crypto localVideoConstraints recoverCamera recoverGroupCamera groupCallVideoBoot` →
  `npm run test:crypto` → `npm run typecheck`
- **Note:** `recoverCamera.test.ts:61` and `recoverGroupCamera.test.ts:53` assert the buggy call verbatim and **must be updated**.

#### VID-2 — group-call tile geometry

- **Findings:** GCV-4, GCV-2, GCV-5 _(implement in that order)_
- **Files:** `src/components/FlexibleVideoTile.tsx`, `src/screens/messenger/GroupCallScreen.tsx`, `src/modules/messenger/webrtc/groupCallLayout.ts`
- **Dependencies:** none (co-verify with VID-1 on device)
- **Scope:** (a) `mirror={shouldMirrorTile(isSelf, call.isFrontCamera)}` — **the React key must not
  change** (re-keying re-opens BS-GC-BLACKVIDEO); (b) delete the dead ratio/`onDimensionsChange`
  machinery, keep the `minWidth/minHeight: 1` floor, add an `objectFit` prop, self tile `contain`;
  (c) `useWindowDimensions()` + `resolveGroupCallPageWidth`/`resolveGridSlotWidth` with a 0-width guard.
- **Test:** `npx jest --selectProjects=app FlexibleVideoTile GroupCallScreen` →
  `npx jest --selectProjects=messenger-crypto groupCallLayout groupCallCameraToggle groupCallTileBatch groupCallVideoStall` →
  `npm test` → `npm run typecheck` → `npm run lint` → `npm run deadcode`
- **Audit-was-wrong flag:** GCV-2 is **stronger** than audited — `aspectRatio` is inert in _every_
  slot, not just measured ones. Do **not** letterbox the hero (trades a 38 % crop for a 38 % dead band).

#### CALL-A — call answer path

- **Findings:** NA-01, NA-03, NA-04 _(in that order)_
- **Files:** `src/modules/messenger/push/fcmBootstrap.ts`, `src/modules/messenger/push/incomingCallCache.ts`, `src/modules/messenger/push/callKitBridge.ts`, `src/modules/messenger/runtime/callForegroundService.ts`, `android/app/src/main/java/com/bravosecure/app/BravoCallForegroundModule.kt`
- **Dependencies:** none. **Blocks CALL-D and PUSH-1** (same `fcmBootstrap.ts`).
- **Scope:** (a) field-wise merge in `setIncomingCallPayload` + `resolveIncomingCallRoute`;
  (b) hoist `installNotifeeHandlers()` to the top of `startFcmBootstrap` in a try/catch, collapse
  the register into one in-flight-guarded `registerPushTokens()` behind `fetchWithTimeout`, and
  **enqueue the durable pending-decline in the rich handler** (required rider — the hoist makes the
  rich `onBackgroundEvent` displace the slim one earlier and `notifee.onBackgroundEvent` is last-wins);
  (c) extract `onAnswer` into exported `handleSystemUiAnswer` and route the unconditional
  bring-forward through a new `BravoCallForegroundModule.bringCallUiToForeground()` that carries
  `MainActivity.EXTRA_CALL_LAUNCH`, with CallKeep as the fallback.
- **Test:** `npx jest --selectProjects=messenger-crypto incomingCallCacheMerge fcmBootstrapOrder callSystemUiAnswerForeground callForegroundBringToFront callAcceptLatch callHangupWhileRinging ringCancel groupRingDedup callRingState iceFailedReconnect fcmHeadlessRouting pushSlimBgHandler` →
  `npm run test:crypto` → `npm run typecheck`
- **Build note:** NA-04 adds a **native module** → APK rebuild required, and `android/` is
  `.gitignore`d → **`git add -f`** the Kotlin file.
- **Audit-was-wrong flag:** NA-04's literal fix is **insufficient** — CallKeep's `backToForeground()`
  warm branch sends a bare launcher intent, so `MainActivity.isCallLaunch` is false and
  `setCallLaunchFlags(false)` actively **clears** `showWhenLocked`/`turnScreenOn`; the lock-screen
  case stays behind the keyguard. The native path is mandatory.

#### CALL-B — ringtone ownership

- **Findings:** NA-06
- **Files:** `src/modules/messenger/push/incomingRingtone.ts`, `src/screens/messenger/CallScreen.tsx`, `src/screens/messenger/IncomingGroupCallScreen.tsx`
- **Dependencies:** none. **Blocks CALL-D** (same `CallScreen.tsx`).
- **Scope:** `isNativeRingActive` + `bindInAppRingOwnership` backed by an `activeRing` record cleared
  by the existing `dismissCallNotif` funnel; both ring screens stay silent while the native ring owns
  the callId. Do **not** implement the audit's `AppState === 'active'` gate — it silences the
  foreground-ring-then-Home case.
- **Test:** `npx jest --selectProjects=messenger-crypto incomingRingtone` →
  `npx jest --selectProjects=app inAppRingOwnership` → `npm run test:crypto` → `npm run typecheck`

#### CALL-C — call setup budget

- **Findings:** NA-05
- **Files:** `src/modules/messenger/webrtc/signallingClient.ts`, `src/modules/messenger/webrtc/callController.ts`
- **Dependencies:** none
- **Scope:** `CALL_SETUP_SEND_BUDGET_MS` 12 s → 40 s, abandon gated on **terminality** not the clock,
  `CallSignalling.cancelPending(callId)` called from `CallController.end()`, `sendAnswer` returns
  `Promise<boolean>` so `accept()` re-arms the extracted `armConnectingWatchdog()` at
  answer-delivery. Do **not** change the group budget (`useGroupCall.ts:4212`'s comment goes stale).
- **Test:** `npx jest --selectProjects=messenger-crypto webrtcSignalling callAnswerResend callController.connectingWatchdog ringTimeout callHangupWhileRinging callIceRestartRetry callBackgroundReliability iceFailedReconnect callDispatcherZombieEnd transportBestEffort` →
  `npm run test:crypto` → `npm run typecheck`
- **Note:** `webrtcSignalling.test.ts:123-154` pins the old 12 s budget and **must be updated**.
- **Audit-was-wrong flag:** the audit's proposed "buffer + re-send on next connected" is **already
  implemented** (`signallingClient.ts:214-218`). The real defect is the budget + watchdog arm point.

#### PATCH-1 — webrtc rotation patch _(OPTIONAL, P3)_

- **Findings:** GCV-3
- **Files:** `patches/react-native-webrtc+125.0.12.patch`
- **Dependencies:** none
- **Recommendation:** **consider closing instead of implementing.** GCV-2 (VID-2) deletes
  `onDimensionsChange`, which is the patch's only consumer, and the native emitter stays off.
  It is then correct-but-unused parity hygiene. Ship it only because CALL-A already forces an APK
  rebuild, so it is free. **Device gate is mandatory and inversion-detecting:** a temporary
  `Log.d` in `onFrameResolutionChanged` must print `640x480 rot=90`; if it prints `480x640 rot=90`
  the fix is inverted and must be deleted.
- **Test:** `npx jest --selectProjects=messenger-crypto webrtcViewRotationPatch groupCallLayout` →
  `npm run test:crypto` → `npm run typecheck`
- **Audit-was-wrong flag:** pixels are **never** rendered 90° wrong (SurfaceViewRenderer rotates
  them) — only the aspect _number_ is transposed, and it is inert today. This fixes **none** of the
  "dramatic zoom" complaints (that is VID-1/VID-2).

#### RELAY-1 — throttle ceilings

- **Findings:** SRV-01 (File 1), GF-1 (edit 5), SRV-05 (part A)
- **Files:** `apps/messenger-service/src/relay/envelope.controller.ts`, `apps/messenger-service/src/gateway/ws-rate-limiter.ts`
- **Dependencies:** none. **Deploy first**, before STORE-1/RT-2 ship to devices.
- **Scope:** `SEND_THROTTLE = {limit: 300, ttl: 60_000}` via `RELAY_SEND_THROTTLE_LIMIT` /
  `RELAY_SEND_THROTTLE_TTL_MS` (**SRV-01's shape wins; discard GF-1's 120/10 s**) so one
  `MAX_GROUP_FANOUT = 250` burst fits in a window at a 5/s sustained rate; ack throttle 60 → 240 /10 s
  and the WS `envelope.ack` bucket to `{refillPerSec: 24, capacity: 240}`.
- **Test:** `cd apps/messenger-service && npx jest src/relay/envelope.controller.spec.ts && npm test && npm run typecheck`
- **FORBIDDEN, do not implement:** `POST /envelopes/batch`. It binds N per-recipient ciphertexts
  into one request, handing the relay a membership set
  (`MESSENGER_SPEC_COVERAGE.md:66/69`, `MESSENGER_BACKEND.md:162`). A blind flat raise is the
  entire compliant surface of SRV-01/GF-1's server half.

#### GW-1 — group VoIP wake conversationId

- **Findings:** SRV-04
- **Files:** `apps/messenger-service/src/gateway/messenger.gateway.ts`
- **Dependencies:** none. **Land first in the gateway chain** (1–2 line diff).
- **Scope:** pass `data.conversationId` as arg 6 of `sendVoipWake` in `handleSfuRing` (the 6th param
  is already fully implemented and tested server-side), plus an optional 128-char bound.
- **Test:** `cd apps/messenger-service && npx jest src/gateway/messenger.gateway.calls.spec.ts src/push/push-chat-wake.spec.ts src/gateway/messenger.gateway.sfu-auth.spec.ts && npm test && npm run typecheck`

#### WS-1 — session recovery config

- **Findings:** OR-5, SRV-07 _(same defect — one diff, do not implement twice)_
- **Files:** `apps/messenger-service/src/config/configuration.ts`, `apps/messenger-service/src/main.ts`, `apps/messenger-service/src/gateway/redis-io.adapter.ts`, `apps/messenger-service/src/gateway/session-aware-redis-adapter.ts`, `apps/messenger-service/.env.example`, `infra/env/messenger.env.example`, `docker-compose.yml`
- **Dependencies:** none
- **Scope:** route `WS_SESSION_RECOVERY` through config → ctor arg, **gate the
  `connectionStateRecovery` server option on the same resolved flag** (closes SRV-07's dead-config
  half), strip the two unconditional `console.log`s, and add the **P0-6 jti-revocation check** in
  `doRestoreSession` (socket.io flushes missed packets in the Socket constructor _before_ the auth
  middleware runs — fail closed on a Redis throw). Document the var in all three templates.
- **Test:** `cd apps/messenger-service && npx jest src/gateway/session-aware-redis-adapter.spec.ts src/gateway/redis-io.adapter.spec.ts && npm test && npm run typecheck` →
  root `npm run test:crypto` → root `npm run typecheck`
- **Ops action (separate, after merge):** flip the flag box-side on **single-replica staging only**,
  then verify `docs/qa/MESSENGER_TEST_PLAN.csv` NET-29 / `TEST_PLAN.md` F2.
- **Audit-was-wrong flag:** OR-5's "env/ops change only" framing is **wrong** — flipping the flag
  activates ~225 lines of never-unit-tested code that overrides `broadcast()` for every WS event.
  SRV-07's own remedy ("just set it true") is **unsafe as written** without the jti gate.

---

### Wave 2 — 3 items

| itemId     | findings                                                     | complexity | one-line                                                                             |
| ---------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| **RT-2**   | OM-07, XO-3, XO-5, GF-1, SRV-01, OR-1 _(runtime call sites)_ | medium     | Adopt STORE-1's API at every `productionRuntime` outbox call site.                   |
| **CALL-D** | NA-02                                                        | small      | Terminal dead-offer state instead of "Answering…" forever.                           |
| **GW-2**   | SRV-02, SRV-03                                               | medium     | Replayed call offers become answerable; connect-time drains become peek-emit-remove. |

#### RT-2 — outbox call-site adoption _(chain link 2)_

- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`
- **Dependencies:** **STORE-1** (hard), RT-1
- **Scope:** wire `sendGate` into the `RelayHttpClient` construction; classify failures with
  `classifyOutboxFailure` at the drain and 1:1 catch; **XO-5** — keep the 1:1 bubble `'sending'`
  and return without throwing when `recordAttempt` reports `queued`, only flip to `'failed'` on
  no-row / semantic rejection / budget exhaustion; **OR-1** — throttled `kickAndDrainOutbox()`
  wired into AppState-`active` (replacing RT-1's raw OR-6 kick), the NetInfo regain branch, and the
  WS `connected` transition, plus `clearUnreachableBackoff()` on `connected`; **OM-07** —
  `shouldStopDrain` budget (30 s wall / 2 consecutive unreachable) in the drain loop;
  **GF-1/SRV-01** — book an early re-drain on `Retry-After` instead of waiting for the 60 s tick,
  and no red bubble on an HTTP-fallback 429. Tighten the MSG-07 boot sweep to `pendingMessageIds`.
- **Test:** `npx jest --selectProjects=messenger-crypto queuedSendBubbleState outboxKickThrottle sqlOutboxStore outboxDrainBudget relaySendPacer` →
  `npm run test:crypto` → `npm test` → `npm run typecheck`

#### CALL-D — dead-offer terminal state

- **Findings:** NA-02
- **Files:** `src/screens/messenger/CallScreen.tsx`, `src/modules/messenger/push/fcmBootstrap.ts`, `src/modules/messenger/push/incomingCallCache.ts`
- **Dependencies:** **CALL-A** (incomingCallCache, fcmBootstrap), **CALL-B** (CallScreen)
- **Scope:** 1 s-interval watchdog exiting on either `ACCEPT_INTENT_TTL_MS` or a new
  `incomingCallCache.isIncomingCallDead(callId)` tombstone probe; terminal `deadOffer` flag showing
  "Couldn't connect · missed call"; reuse `declineIncomingCallBestEffort(callId, 'failed')` for
  teardown, then pop and let the unmount effect file the leg as `'missed'`.
- **Test:** `npx jest --selectProjects=app CallScreen.deadOffer` →
  `npx jest --selectProjects=messenger-crypto callAcceptLatch callHangupWhileRinging callDispatcherZombieEnd callRingState callResumeGuard callController.ringTimeout` →
  `npm run test:crypto` → `npm run typecheck`

#### GW-2 — call-continuity + non-destructive drains

- **Findings:** SRV-02, SRV-03 _(SRV-02 first — both edit `deliverPendingCallOffer`)_
- **Files:** `apps/messenger-service/src/gateway/messenger.gateway.ts`, `apps/messenger-service/src/relay/envelope.service.ts`, `apps/messenger-service/src/relay/envelope.store.ts`
- **Dependencies:** GW-1 (same gateway file)
- **Scope:** (a) `rehydrateCallSession(callId, parsed.from, address)` in the replay loop (the
  persisted offer already carries caller+callee+callId — **no new Redis state**, which is what keeps
  this out of the arch gate), ended-tombstone skip, and a 15 s in-memory `peer_offline` answer hold
  flushed on the caller's reconnect; (b) convert `deliverPendingCallOffer`,
  `deliverPendingGroupRing` and `flushPendingDelivered` to **peek → emit → remove-what-emitted**,
  reusing `runWithReplicaLock` as the short-TTL claim in place of the up-front index `DEL`.
- **Test:** `cd apps/messenger-service && npx jest src/gateway/messenger.gateway.calls.spec.ts src/relay/envelope.service.spec.ts && npm test && npm run typecheck` →
  root `npm run test:crypto` → root `npm run typecheck`
- **Audit-was-wrong flag:** SRV-02's audit remedy ("persist ringing call-session state in Redis")
  is the **arch-gated** version (memo §9, NOT-COVERED). The rehydrate-from-existing-offer shape
  needs no new metadata and therefore needs no approval — implement that, not the audit's.

---

### Wave 3 — 3 items

| itemId      | findings                | complexity | one-line                                                                                      |
| ----------- | ----------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| **RT-3**    | OM-01, XO-1, XO-2       | medium     | Cert-freshness metadata at every enqueue site + deferred 1:1 rows + one drain-routing helper. |
| **RELAY-2** | SRV-05 (part C, server) | medium     | `POST /envelopes/ack-batch`.                                                                  |
| **GW-3**    | SRV-06                  | small      | Charge the VoIP wake budget once per callId, only when a push is dispatchable.                |

#### RT-3 — cert metadata + deferred outbox _(chain link 3)_

- **Findings:** OM-01, XO-1 _(literally the same fix — ONE change, not two)_, XO-2
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/outboxCertFreshness.ts`, `src/modules/messenger/runtime/deferredOutbox.ts` _(new)_, `src/modules/messenger/store/sqlOutboxStore.ts`
- **Dependencies:** RT-2 (chain), STORE-1 (sqlOutboxStore)
- **Scope:** persist `certExpSec` + re-seal inputs (`resealKind`, `body`, `replyTo`, `reaction`) at
  the 1:1 (`~2873`) and reaction (`~3338`) enqueue sites via `certCache.getIssued()`; rename
  `resealDeferredGroupRow` → `resealOutboxRow` with direct/reaction/group branches reproducing each
  send path's AAD byte-for-byte; enqueue a **deferred** row (bubble stays `'sending'`) on pre-ship
  crypto failure in both 1:1 and group lanes and move the group cert fetch **out of** the admin lock.
- **Hard instruction:** XO-1 proposes `resolveSealedOutboxAction()` and XO-2 proposes
  `planOutboxDrain()`. **Produce exactly ONE router** — `planOutboxDrain(row, payload, nowSec)` in
  `deferredOutbox.ts` returning `'ship' | 'reseal' | 'drop' | 'fail'` — and keep the drain's per-row
  work as a single `shipRow(row)` lambda so RT-4's lane scheduler is a ~20-line change.
- **No schema bump** (payload is opaque `TEXT` JSON; cert-less legacy rows keep the pre-fix path).
- **Test:** `npx jest --selectProjects=messenger-crypto outboxCertFreshness deferredOutbox sqlOutboxStore outboxEnqueueCertMetadata` →
  `npm run test:crypto` → `npm test` → `npm run typecheck`
- **Audit-was-wrong flag:** the second half of OM-01/XO-1 (HTTP `{userId, deviceId}` submitter
  mapping) is **FORBIDDEN** — it belongs to the deferred receipts gate (NEEDS-APPROVAL #1).
  Because of that, RT-3 is the **only compliant remedy** available for the stale-cert loss class.

#### RELAY-2 — ack batching (server)

- **Findings:** SRV-05 (part C, server half)
- **Files:** `apps/messenger-service/src/relay/envelope.controller.ts`, `apps/messenger-service/src/relay/envelope.service.ts`, `apps/messenger-service/src/relay/dto/ack-batch.dto.ts` _(new)_
- **Dependencies:** RELAY-1 (controller), GW-2 (envelope.service)
- **Scope:** `AckBatchDto` (≤ 100 items) + `EnvelopeService.ackBatch` that **loops the existing
  `ack()`** so the per-envelope P0-N9 possession proof is byte-identical.
- **Test:** `cd apps/messenger-service && npx jest src/relay && npm test && npm run typecheck`

#### GW-3 — VoIP wake budget

- **Findings:** SRV-06
- **Files:** `apps/messenger-service/src/gateway/messenger.gateway.ts`, `apps/messenger-service/src/push/push.service.ts`
- **Dependencies:** GW-2 (gateway). **Blocks PUSH-1** (push.service.ts).
- **Scope:** charge **once per callId** with bounded free retries, commit the charge only once a
  push is dispatchable (after the token lookup and the `fcmReady` check), raise the pair cap 6 → 10,
  leave the recipient-wide 30/min ceiling intact. Export `VOIP_WAKE_PAIR_CAP` /
  `VOIP_WAKE_RECIPIENT_CAP` so the spec's hard-coded loop bounds stop drifting.
- **Test:** `cd apps/messenger-service && npx jest src/push src/gateway && npm test && npm run typecheck` →
  root `npm run test:crypto`
- **Audit-was-wrong flag:** the audit's per-callId-bucket fix is **wrong** — a redial mints a
  _fresh_ callId (`useCall.ts:874`, and the gateway rejects duplicate callIds), so per-callId
  buckets cannot help redials and would delete the perimeter.

---

### Wave 4 — 2 items

| itemId     | findings   | complexity | one-line                                                                              |
| ---------- | ---------- | ---------- | ------------------------------------------------------------------------------------- |
| **RT-4**   | GF-6, GF-3 | medium     | Per-peer drain lanes (kills head-of-line blocking) + group decrypt-failure self-heal. |
| **PUSH-1** | OR-3       | small      | Visible iOS chat-wake banner + iOS notification authorization.                        |

#### RT-4 — drain lanes + group self-heal _(chain link 4)_

- **Findings:** GF-6, GF-3
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/outboxLanes.ts` _(new)_, `src/modules/messenger/runtime/groupConversationUpsert.ts`, `src/modules/messenger/runtime/bootGroupStashDrain.ts`
- **Dependencies:** RT-3 (must rebase onto its `shipRow` lambda)
- **Scope:** (a) `groupRowsByPeer` keyed `${peerUserId}.${peerDeviceId}` (byte-identical to
  SessionManager's per-address ratchet mutex key) + `runOutboxLanes` with
  `OUTBOX_DRAIN_LANE_LIMIT = 4`, a `shippedThisPass` set, and a stop-on-429 backoff;
  (b) thread a `divergence` flag from the tamper/key-divergence site into
  `selectKeyResyncCandidates` so a keyed-but-diverged group can still ask for a key, and spend a
  stash attempt **only** for structural replay failures or when the drain actually followed a key
  install (`ReplayNeedsKeyError` + `shouldBumpStashAttempt`, `keyChanged: false` on the boot path).
- **Constraint (arch memo §5):** keep the per-group 20 s cooldown, the signed key-request, and the
  responder-side roster/owner gates — the heal must not become a fan-out amplifier, and a failed
  decrypt must **not** relax `verifySealedAad`/`verifySenderCert`.
- **Test:** `npx jest --selectProjects=messenger-crypto outboxLanes groupConversationUpsert bootGroupStashDrain tamperKeyDivergenceStash groupSelfHeal groupRekeyConverge groupCreateEpochBootstrap pendingGroupEnvelopeStore sqlOutboxStore outboxCertFreshness groupBroadcast firstMessageDrop envelopeDelivered` →
  `npm run test:crypto` → `npm test` → `npm run typecheck`
- **Watch:** if the B-75 "backup got slow" symptom (txnChain pressure) appears on device, drop the
  lane limit to 3 — **never** bypass the chain.

#### PUSH-1 — iOS banner lane

- **Findings:** OR-3
- **Files:** `apps/messenger-service/src/push/push.service.ts`, `src/modules/messenger/push/fcmBootstrap.ts`
- **Dependencies:** GW-3 (push.service.ts), CALL-D (fcmBootstrap.ts)
- **Scope:** add a **constant-string** `aps.alert` (+ thread-id/sound) to the iOS chat wake and
  request iOS notification authorization client-side; every client draw path stays Android-only so
  exactly one banner exists in every state including force-quit. The `aps` block must contain no
  `senderUserId`.
- **Test:** `cd apps/messenger-service && npx jest src/push && npm test` →
  `npx jest --selectProjects=messenger-crypto or3IosBannerLane fcmHeadlessRouting backgroundMessageNotifier` →
  `npm run test:crypto` → `npm run typecheck`
- **Audit-was-wrong flag:** the audit's primary fix (headless minimal pull) is **rejected for this
  batch** — it is the OR-1 arch-gated 2nd-VM SQLCipher class _plus_ an unnamed second blocker (a
  killed device needs a headless access-token refresh, the B-71 revocation-loop class). This ships
  the audit's own stated fallback.

---

### Wave 5 — 1 item

#### RT-5 — fail closed on a missing group key _(chain link 5)_

- **Findings:** GF-5
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/messagingLogic.ts`, `src/screens/messenger/ChatScreen.tsx`
- **Dependencies:** **RT-4** (GF-3's self-heal must exist first — this converts silent corruption
  into a visible "can't send yet" dead-end), GRP-1 (ChatScreen)
- **Scope:** pure `groupSendBlockedReason` helper; **throw**, not fall back, in the group send prep
  when `masterKeyB64` is falsy; rate-limited `requestGroupKeyResync` fired from the catch **outside**
  the admin lock; pre-upload gate in `sendMedia`; ChatScreen composer/banner gate.
- **Arch note (memo §6 — ALLOWED, this is a strengthening):** preserve the documented exception —
  `create` and `key-request` are legitimately unwrapped; do **not** fail those closed or key
  distribution deadlocks.
- **Test:** `npx jest --selectProjects=messenger-crypto messagingLogic groupSendKeyGate groupPlaintextReject groupBroadcast groupConversationUpsert bootGroupStashDrain adhocCallKeyLookup groupCallKeyWait` →
  `npx jest --selectProjects=app sendErrorText` → `npm run test:crypto` →
  `npm test -- --selectProjects=app` → `npm run typecheck`

---

### Wave 6 — 1 item

#### RT-6 — receive-path ordering + durable reactions _(chain link 6)_

- **Findings:** OM-02, SYNC-7
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/runtime/orderingClock.ts` _(new)_, `src/modules/messenger/runtime/reactionMerge.ts` _(new)_, `src/modules/messenger/store/pendingReactionStore.ts` _(new)_, `src/modules/messenger/store/sqlMessageStore.ts`, `src/modules/messenger/crypto/db.ts` ← **claims SCHEMA_VERSION 15 → 16**
- **Dependencies:** STORE-1 (db.ts v15 must already exist), RT-5 (chain)
- **Scope:** (a) `orderingClock.ts` clamps the **ordering** timestamp to the server/receive
  reference **only in the impossible FUTURE direction** (2-min skew), threaded as an optional
  `serverTsMs` param into `handleIncoming`/`doHandleIncoming`/`replayGroupSealedDecode`;
  (b) `applyReaction` becomes async with a three-tier resolve (store window → `findReactionTarget`
  → durable `pending_reactions` stash) and **persists on every tier** (`sqlMessages.upsert` —
  missing today, which is why reactions vanish on every cold boot), replayed after each of the 4
  inbound upsert sites plus a boot sweep, with the M-07 blocked-peer gate re-applied at drain.
- **Hard constraints:**
  - **Display/ordering only.** The clamp must never be fed into `verifySealedAad`, `seenEnvelopes`
    dedup, or `expires_at`. `SEALED_AAD_FUTURE_MS` / `MAX_AGE_MS` / `SKEW_MS` must be **unchanged**
    (assert this in the test).
  - **Do NOT implement the audit's symmetric `|aad.ts − serverTs|` clamp** — it reverts MSG-01 and
    L18 (legitimately store-and-forwarded envelopes are arbitrarily older than the reference).
  - **SYNC-7 must not touch** `sendReaction`'s outbox enqueue hunk — RT-3 owns it.
- **Test:** `npx jest --selectProjects=messenger-crypto orderingClock appendMessageDedup reactionMerge pendingReactionStore pendingReactionApply receiveTransaction blockedPeersAndTombstones bootGroupStashDrain groupInboundBody sqlMessageStoreResend firstMessageDrop` →
  **BACKUP_LOOP §4:** `npx jest --selectProjects=messenger-crypto backupMerkle messageMirrorMerkleFlush mirrorLedgerBootSweep backupRepairCommit wipeAtRest` →
  `npm run test:crypto` → `npm test` → `npm run typecheck`

---

### Wave 7 — 1 item

#### RT-7 — per-recipient envelope ids for group read receipts _(chain link 7)_

- **Findings:** SYNC-1
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `src/modules/messenger/store/types.ts`, `src/modules/messenger/store/messengerStore.ts`, `src/modules/messenger/runtime/messagingLogic.ts`, `src/modules/messenger/runtime/envelopeDelivered.ts`, `src/modules/messenger/crypto/db.ts` ← **claims SCHEMA_VERSION 16 → 17**, `src/modules/messenger/store/sqlMessageStore.ts`
- **Dependencies:** RT-6 (db.ts, sqlMessageStore.ts), RT-5 (messagingLogic.ts), MS-1 (messengerStore.ts)
- **Scope:** persist an `envelope_ids` map (recipientUserId → envelopeId) via a widened
  `updateMessageEnvelopeId(…, recipientUserId?)`; match receipts through a pure
  `readReceiptEnvelopeMatch` (strict per-recipient binding, scalar fallback for legacy/1:1 rows);
  add `envelope_ids_json` + `receipts_json` columns.
- **🔴 HARD BACKUP GATE (B-94 `root_mismatch` class):** `messageMirror.ts:434` computes
  `versionHash` over `JSON.stringify(serializeMessage(msg))`. If `envelope_ids_json` or
  `receipts_json` enters `serializeMessage`, **every row's hash changes and the next boot
  re-mirrors the entire history.** Either keep both fields **out of** `serializeMessage`, or get
  explicit sign-off for a full re-mirror. Run `docs/runbooks/BACKUP_LOOP.md` §4 gates **and** the
  §5 idle-boot silence probe before declaring done.
- **Rejected alternative:** the audit's "match receipts by clientMsgId" would require adding
  `clientMsgId` to the read-receipt WS frame — a reader↔message correlator that breaks relay
  group-blindness and needs an architecture amendment.
- **Test:** `npx jest --selectProjects=messenger-crypto messagingLogic groupReadReceipts groupReceiptEnvelopeSet envelopeDelivered sqlMessageStoreResend appendMessageDedup messageStatusMonotonic` →
  **BACKUP_LOOP §4:** `npx jest --selectProjects=messenger-crypto backupMerkle messageMirrorMerkleFlush mirrorLedgerBootSweep backupRepairCommit` →
  `npm run test:crypto` → `npm test` → `npm run typecheck`

---

### Wave 8 — 1 item

#### RT-8 — ack coalescing + lock-screen send recovery _(chain link 8)_

- **Findings:** SRV-05 (parts B + C, client half), OR-2
- **Files:** `src/modules/messenger/runtime/productionRuntime.ts`, `packages/messenger-core/src/transport/relayClient.ts`, `src/modules/messenger/transport/ackQueue.ts` _(new)_, `src/modules/messenger/runtime/sendRecoveryClock.ts` _(new)_, `packages/messenger-core/src/transport/client.ts`
- **Dependencies:** **RELAY-2** (the `/envelopes/ack-batch` route must exist), STORE-1 (relayClient), RT-7 (chain)
- **Scope:** (a) `RelayHttpClient.ackBatch` + a 100-item/200 ms client coalescer that falls back to
  per-envelope acks on a 404 from an un-upgraded relay, and **skip the ack entirely when there is no
  `ackToken`** (archive-replay frames currently POST an ack that can only 403 while burning budget);
  (b) drain the durable outbox over HTTP on AppState `background`; add optional `onServerSignal` to
  `TransportClient` fired from the Manager `'ping'` + `onAny` (the only clock that survives a locked
  screen — proven by B-100/B-101) and hang a throttled `drainOutbox` off it; **upgrade RT-1's
  coalescer in-flight guard to wall-clock ownership** (`DRAIN_STUCK_MS > TRANSPORT_TIMEOUT_MS`) so one
  wedged POST cannot swallow every later drain — do **not** add a second guard; optionally extend
  the immediate-reopen gate with `hasPendingOutbound`.
- **Test:** `npx jest --selectProjects=app ackQueue` →
  `npx jest --selectProjects=messenger-crypto sendRecoveryClock transportServerSignal socketReauth transportServerReconnect transportSingleFlight sqlOutboxStore callResumeGuard archiveReplayDrain` →
  `npm run test:crypto` → `npm test` → `npm run typecheck` → `cd apps/ops-console && npm run typecheck`
- **Audit-was-wrong flag:** OR-2's audit remedy targets `fetchWithTimeout` — **not fixable in JS**
  (no timer can fire the abort while the screen is locked). Bounding the caller is the only lever.
  `httpFallback` is an unreachable per-send closure, so `drainOutbox` is the right target.

---

## 2. NEEDS-APPROVAL (10 findings) — do not schedule until the architecture owner answers

Each entry has the exact question. `docs/architecture/ARCHITECTURE_AMENDMENT_SFRAME.md` defines the
written-amendment + sign-off process for anything that changes the contract.

### 🔴 NA-GATE-1 — Delivery receipts for HTTP-submitted envelopes

- **Findings:** **OM-03 + SYNC-3 + SRV-08** — _one defect, three competing designs. Approve one; do not implement three._
- **Blast:** every group send, every outbox drain, every WS-ack-timeout fallback and every B-46
  auto-resend is permanently stuck at a single tick, and B-46 auto-recovery is completely dead.
- **Memo verdict:** §1 — the audit's `{userId, deviceId}` submitter is **FORBIDDEN**; only an
  **anonymous capability handle** is allowed. Also a CLAUDE.md stop condition (sealed-sender
  envelope shape) → needs verification **even in the compliant form**.
- **Designs on the table:**
  - **(A) OM-03 / SRV-08 — sender-pulled poll.** Relay stores `rcpt:{envelopeId}` = a 2-byte
    outcome (SRV-08) or `sha256hex(retractToken)|outcome` (OM-03); new `POST /envelopes/receipts`
    authed **only** by the retract token the sender already persists (no `@CurrentCaller`, same
    model as `/envelopes/retract`). Client reconciles on reconnect/foreground through the existing
    `applyEnvelopeDelivered`/`applyEnvelopeUndeliverable`. **No SQLCipher bump, no gateway change.**
  - **(B) SYNC-3 — anonymous receipt room.** Relay records the outcome and emits into socket.io room
    `rcpt:{envelopeId}`; the sender joins via a new `receipt.subscribe` WS frame. Push instead of
    poll; adds a wire frame and a gateway surface.
- **Questions to ask:**
  1. Approve design **(A)** (retract-token-gated poll) as the compliant "anonymous capability
     handle" contemplated by `MESSENGER_SPEC_COVERAGE.md:140`? If not, approve **(B)**'s new
     `receipt.subscribe` frame?
  2. (A) makes the retract token double as a _read_ capability. Acceptable, or must a **separate
     receipt token** be minted at submit? (A separate token costs a SQLCipher column, which — see
     §5 — changes `serializeMessage` and triggers a whole-history backup re-mirror. That is the
     reason both specs chose to reuse `retract_token`.)
  3. **Pre-existing compliance finding, flagged by all three specs and NOT fixed by any of them:**
     the memo's premise that the WS submitter binding is "in-memory and dies with the connection"
     is **factually wrong in the current tree**. `envelope.store.ts:316-326` writes
     `submitter:{envelopeId} = "{userId}:{deviceId}"` into **Redis with the full dwell TTL (up to
     30 days)**, and `addPendingDelivered` writes `delivered-pending:{senderUserId}` sets with a
     **7-day** TTL — both shipped as owner-approved audit fix P0-T6. Should this be filed as its
     own finding and removed?
- **Would occupy:** a new server item (`envelope.store.ts`, `envelope.service.ts`,
  `envelope.controller.ts`, ± gateway/protocol) and a productionRuntime chain link
  (+ `receiptReconcile.ts`, `relayClient.ts`). Deploy **server-first**.

### 🔴 NA-GATE-2 — Durable group key/state fan-out

- **Findings:** **GF-2 + SYNC-2** _(same fix — ONE PR)_
- **Blast:** a zombie socket silently swallows every key frame while the caller counts it delivered,
  then the fail-closed epoch rotate strands that member permanently — their thread goes silent
  forever and GF-3's read-side backstop is the only rescue.
- **Memo verdict:** §4 — **ALLOWED-WITH-CONSTRAINT**. The specs document compliance with all five
  constraints (one sealed pairwise envelope per recipient; no new server endpoint/table;
  `create`/`key-request` stay the only unwrapped kinds; key material only in SQLCipher and never
  logged; epoch monotonicity untouched — the outbox row stores only the ECIES `outerSealed`, never
  the group key).
- **Questions to ask:**
  1. Confirm sign-off that moving key fan-out from fire-and-forget WS to the **existing durable
     outbox + HTTP relay lane** (byte-identical envelopes, the same lane group _text_ already uses)
     stays inside §4.
  2. Which shape: **GF-2** (`productionRuntime.ts` only, new `deliverGroupAdminEnvelope` helper) or
     **SYNC-2** (additive `BroadcastDeliverMeta` 4th arg on `broadcastToGroup` in
     `packages/messenger-core`)? SYNC-2's is cleaner but widens the shared package.
  3. Confirm the accepted regression: group admin ops get slower on large rosters (N HTTP RTTs
     instead of N fire-and-forget emits) — group text already pays this.
- **Sequencing if approved:** must land **after RELAY-1** (it converts key fan-out into N HTTP
  submits) and **before/with RT-4** (GF-3 is its read-side complement). Would take a
  productionRuntime chain link.
- **Audit-was-wrong flag:** SYNC-2's audit framing ("server-side twin", `apps/messenger-service`
  file hint) is **wrong** — nothing in the relay changes; the whole fix is client-side.

### 🟠 NA-GATE-3 — Compose timestamp as `aad.ts` on re-seal

- **Findings:** **OM-05**
- **Blast:** a re-sealed row (deferred, or any row queued past the ~1 h cert TTL) is ordered at
  _drain_ time by the receiver and at _compose_ time by the sender — the two devices disagree
  forever, in 4 re-seal sites and 3 receive-side ordering sites.
- **Memo verdict:** §3 — **NOT-COVERED, needs human approval**; and **FORBIDDEN** if made to work
  by widening any acceptance window. This trips the CLAUDE.md **AAD binding** stop condition.
- **Question to ask:** may `SealedAad.ts` be reinterpreted from _"when this seal ran"_ to _"when the
  sender composed this message"_, carried through a clamp helper that guarantees the value stays
  inside the **existing, unmodified** `verifySealedAad` window (`SEALED_AAD_MAX_AGE_MS` minus a
  safety margin, never in the future)? The change strictly **narrows** the accept window and the
  re-seal still fetches a **fresh** sender cert.
- **Rejected alternative (do not counter-propose it):** the memo's "doc-safe" option — carry compose
  time as a new `SealedPayload` field — is **fleet-breaking**. `isSealedPayload` rejects any unknown
  top-level key, and a shape rejection throws out of `unsealPayload` → the drain acks **`discarded`**,
  so every message from an upgraded sender to a not-yet-upgraded receiver is **destroyed on the
  relay**. It needs a two-release rollout.
- **Interaction:** RT-6 (OM-02) must land as a **clamp ON** the `aad.ts`-derived value, not a
  replacement, or it silently reverts OM-05. RT-6's future-only clamp is compatible; a symmetric
  clamp would have fought it.

### 🟠 NA-GATE-4 — Headless FCM prefetch

- **Findings:** **OM-04**
- **Memo verdict:** §12 adjacency (OR-1's 2nd-JS-VM/SQLCipher class is NOT-COVERED, and relaxing
  keychain accessibility is FORBIDDEN outright).
- **Honest scope (the spec's own correction):** the audit's **headline outcome is not
  achievable** — delivery/ack/sender-tick without an app open is ack-gated and blocked by the
  fresh-install backup-restore probe ordering plus `installIdentity`/`publishOwnBundle` side
  effects. The spec ships only a bounded, **decrypt-free** prefetch of sealed envelopes into an
  owner-scoped AsyncStorage stage, consumed inside `drainRelay` **only when `relay.pull` fails**
  (i.e. the app is open but offline). No ack, no schema, no wire change, no SQLCipher, no identity
  install, no runtime boot in the headless VM.
- **Question to ask:** is a bounded (100 entries / 1 MB / 24 h), **key-free and decrypt-free**
  AsyncStorage stage written from the headless FCM VM acceptable, given it never opens SQLCipher and
  never touches the keychain? (Stored fields are exactly
  `{envelopeId, outerSealed, timestamp, ts}` — no ackToken, no senderUserId, no recipient.)
- **If approved:** takes a productionRuntime chain link (wraps the `relay.pull` call site + appends
  a loop tail) — land it as the **outermost** change in `drainRelay`.

### 🟠 NA-GATE-5 — Delete-for-everyone (`redact` directive)

- **Findings:** **SYNC-4**
- **Confirmed absence:** delete is local-only ("Delete (this device)"), retract is pre-fetch only,
  and **no edit/delete-for-everyone surface exists anywhere** in `src/`, `packages/` or `apps/`.
- **Memo verdict:** §7 — **ALLOWED-WITH-CONSTRAINT** if it is purely an inner `SealedPayload` kind
  on the existing `/envelopes` path; **NOT-COVERED** for anything the relay can interpret.
- **Questions to ask:**
  1. Approve an **additive optional inner** field `redact?: {targetMsgId}` in `SealedPayload`,
     fanned out per-recipient on the existing `sendReaction` machinery (durable outbox, group stamp,
     `trackPending`, HTTP fallback), with **zero server change** and the server-side copy still
     purged only via the capability token?
  2. **Rollout risk to accept:** `SEALED_PAYLOAD_KEYS` is a strict allow-list, so an upgraded sender
     talking to a not-yet-upgraded receiver gets the envelope **destroyed** (ack `discarded`), not
     deferred. Approve a two-release rollout (tolerant receivers ship first, emitters second)?
  3. Approve the authorship binding: an owner-scoped `redactRegistry` binds each tombstone to the
     claimed **author**, so a redact arriving _before_ its target cannot let a group member suppress
     someone else's message.
- **Coupling:** SYNC-5 hits the **identical** `SEALED_PAYLOAD_KEYS` wall. If the guard is relaxed,
  do it **once**, on one release train — not two independent edits.

### 🟠 NA-GATE-6 — Missed-call marker TTL

- **Findings:** **SYNC-5**
- **Blast:** a callee offline > 6 h loses the missed-call record permanently (the Redis marker is
  the only durable carrier; the FCM fallback writes no `call_meta` row).
- **Memo verdict:** §8(a) — **ALLOWED-WITH-CONSTRAINT**, hard-capped by dwell, but _"flag for
  approval if it goes to days"_. §8(b) (mint the missed call as a real E2EE envelope) is the
  **preferred** shape — but the spec found it **BLOCKED**: a new `callEvent` key makes old receivers
  throw inside the receive txn → rollback → 30-day relay redelivery **poison pill**.
- **Question to ask:** approve raising `MISSED_CALL_MARKER_TTL_SEC` from 6 h to an env-tunable
  **7-day** default, hard-clamped to `min(RELAY_DWELL_SECONDS, 30d)`? This lengthens a cleartext
  callee→caller metadata window in Redis, which is the only reason it needs sign-off. (Server-only;
  also caps the reconnect `call.missed` burst at the newest 50 and gates the client-side missed-call
  _notification_ — not the log row — to misses < 6 h old.)
- **Audit-was-wrong flag:** the audit's second clause is **wrong** — call bubbles **do** ride the
  E2EE backup mirror, so restore-time reconciliation already exists; only live multi-device sync is
  missing, and that is a product feature, out of scope.
- **Sequencing:** conflicts with GW-2's `deliverPendingCallOffer` rewrite — land **after** GW-2.

### 🟠 NA-GATE-7 — Typing-indicator conversation scope

- **Findings:** **SYNC-6**
- **Blast:** the gateway forwards `{from, state}` only, so the client fans the typing flag to both
  direct ids **and every conversation** whose participants include the sender — the leak is
  bidirectional (DM→group and group→DM) and ChatScreen paints a _named_ "Alice is typing" in the
  wrong chat.
- **Memo verdict:** §13 — **ALLOWED-WITH-CONSTRAINT** for 1:1 with an opaque per-pair id;
  **FORBIDDEN** if the value is a group conversation id the relay can cluster on.
- **Question to ask:** approve an opaque **16-hex `convTag` = sha256(domain | convKey | sortedPair)**
  that is **different for every recipient** (so the relay cannot cluster group members), forwarded
  verbatim by the gateway, never stored, never logged, never in Redis — with a legacy fan-out
  fallback when the tag is absent?
- **Audit-was-wrong flag:** the audit's literal fix (raw `conversationId` on the frame) is **NOT
  shippable** — it hands the relay a stable cross-member group id
  (`MESSENGER_SPEC_COVERAGE.md:69`, `MESSENGER_BACKEND.md:162`).
- **If approved:** touches the gateway + all four `protocol.ts` copies + `messagingLogic.ts` +
  a productionRuntime chain link + ChatScreen. Deploy **server-first**; back-compat holds in all
  four sender/server/receiver version combinations.

---

## 3. FORBIDDEN — reject these if anyone re-proposes them

| Proposal                                                                                                         | Origin                                      | Why                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /envelopes/batch` (N per-recipient envelopes in one request)                                               | GF-1 + SRV-01 audit remedy                  | Binds N ciphertexts the relay is contractually blind to → hands it a membership set. `MESSENGER_SPEC_COVERAGE.md:66/69`, `MESSENGER_BACKEND.md:162`. A fan-out-aware _throttle_ is the same signal and equally forbidden. Blind flat raise only.                                |
| `submitter: {userId, deviceId}` on `POST /envelopes`                                                             | OM-03 + SYNC-3 + SRV-08 + XO-1 audit remedy | `MESSENGER_BACKEND.md:137/156`, `SIGNAL_PROTOCOL_IMPLEMENTATION.md:514`. Anonymous capability handle only.                                                                                                                                                                      |
| WorkManager + `BOOT_COMPLETED` 2nd-process SQLCipher drain                                                       | OR-1 audit remedy                           | Memo §12 NOT-COVERED; the docs record this exact approach failing and being removed (2nd JS VM fought the SQLCipher lock). Relaxing keychain accessibility to enable it is **FORBIDDEN outright**. The boot receiver is also redundant (androidx.work 2.8.0 already merges it). |
| Headless minimal pull on FCM msg-wake                                                                            | OR-3 audit remedy                           | Same 2nd-VM class, plus a headless access-token refresh (B-71 revocation-loop class).                                                                                                                                                                                           |
| New top-level `SealedPayload` key (`sentAtMs`, `callEvent`, and `redact` without a staged rollout)               | OM-05, SYNC-5, SYNC-4                       | `isSealedPayload`'s strict allow-list → old receivers throw → the drain acks **`discarded`** → the message is **destroyed on the relay**, not deferred.                                                                                                                         |
| Raw `conversationId` on the typing frame                                                                         | SYNC-6 audit remedy                         | Group clustering signal. Opaque per-recipient tag only.                                                                                                                                                                                                                         |
| Weakening `verifySealedAad`, `verifySenderCert`, or the call-offer freshness check to make any of the above work | several                                     | CLAUDE.md "Never weaken transitions".                                                                                                                                                                                                                                           |
| `git commit --no-verify` / `npm run tsc:rebaseline` to get past a gate                                           | —                                           | CLAUDE.md change-safety rules.                                                                                                                                                                                                                                                  |

---

## 4. Duplicates / no-ops — do not open separate work items

| Finding            | Disposition                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OM-01**          | Duplicate of **XO-1** — literally the same fix.                                                                                                          | XO-1 conflictNotes: _"OM-01 is literally the same fix — schedule as ONE change, not two."_ Implemented once in **RT-3**.                                                                                                                                                                                                |
| **OM-07**          | **Subsumed by XO-3.** Must not be implemented independently.                                                                                             | XO-3 conflictNotes: _"OM-07 (same `if (opts?.unreachable)` block + same soft_attempts column — subsumed here, must not be implemented independently)."_ Its Part 2 (drain budget) and Part 3 (unpark) are carried in **STORE-1**/**RT-2**.                                                                              |
| **OR-6**           | **Subsumed by OR-1's** AppState-`active` wiring (same anchor, same call). Landed as a one-liner in **RT-1**, replaced by the throttled kick in **RT-2**. | OR-1 §3 edits the identical block.                                                                                                                                                                                                                                                                                      |
| **SRV-07**         | **Same defect as OR-5** — one diff.                                                                                                                      | SRV-07 conflictNotes: _"OR-5 is the SAME root cause … must be resolved by one diff."_ Both in **WS-1**. Also a prior sighting: LC-7 in `docs/audits/CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md:34`.                                                                                                                  |
| **SYNC-2**         | **Same fix as GF-2** — one PR.                                                                                                                           | SYNC-2 conflictNotes: _"GF-2 is the SAME edit described from the transport angle — must ship as ONE PR, not two."_ Both in **NA-GATE-2**.                                                                                                                                                                               |
| **SRV-08 / OM-03** | **Same fix as SYNC-3** — one design, not three.                                                                                                          | SYNC-3 conflictNotes: _"OM-03 and SRV-08 are the SAME defect under different names — fold them into this spec, do not implement three variants."_ All in **NA-GATE-1**.                                                                                                                                                 |
| **GCV-3**          | **Recommend CLOSE** rather than implement — rendered moot.                                                                                               | GCV-2 conflictNotes: _"GCV-3 is RENDERED MOOT by this fix: after the `onDimensionsChange` prop is dropped there is no consumer in the repo and the native emitter stays off — recommend closing GCV-3 rather than patching the fork."_ Kept as optional **PATCH-1** only because CALL-A already forces the APK rebuild. |
| **NA-05 (half)**   | The audit's proposed remedy is **already implemented**.                                                                                                  | `signallingClient.ts:214-218` already re-sends on reconnect (100 ms transport-state poll). Only the 12 s budget and the watchdog arm point are real.                                                                                                                                                                    |

**Nothing in the batch is REFUTED** — all 50 findings reproduce in the current tree
(37 `CONFIRMED`, 13 `CONFIRMED-WITH-DRIFT`).

---

## 5. Where the audit's proposed fix was found wrong (roll-up for the founder)

The spec pass rejected or materially rewrote the audit's remedy in **17 of 50** findings:

| #   | Finding                                     | The audit said                                                         | Reality                                                                                                                                                                                                             |
| --- | ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OM-02                                       | symmetric `\|aad.ts − serverTs\|` clamp                                | Would revert MSG-01 and L18 — legitimately store-and-forwarded envelopes are arbitrarily _older_ than the reference. **Future-only** clamp.                                                                         |
| 2   | OM-03 / SYNC-3 / SRV-08 / XO-1              | pass `{userId, deviceId}` submitter on HTTP                            | **FORBIDDEN**. Anonymous capability handle only.                                                                                                                                                                    |
| 3   | OM-04                                       | headless wake delivers + acks + moves the sender tick                  | Not achievable — ack is decrypt-gated and a headless runtime boot is blocked by restore ordering + identity side effects. Half is deferred.                                                                         |
| 4   | OM-05                                       | add a `sentAtMs` payload field                                         | **Fleet-breaking** — strict key allow-list ⇒ old receivers destroy the envelope.                                                                                                                                    |
| 5   | OM-06                                       | thread jumps to the top                                                | Home re-sorts by `last_message.created_at`, so it **sinks**.                                                                                                                                                        |
| 6   | OM-07                                       | index the backoff ladder correctly                                     | Incomplete — without `clearUnreachableBackoff()` on reconnect it trades a battery bug for minutes-late sends.                                                                                                       |
| 7   | GF-1 / SRV-01                               | `POST /envelopes/batch`                                                | **FORBIDDEN**. Blind flat throttle raise is the entire compliant surface.                                                                                                                                           |
| 8   | GF-4                                        | union server ∪ crypto rosters                                          | **WRONG** — resurrects a removed member on non-adder devices (P1-5 privacy defect) and revives a deliberately reverted union.                                                                                       |
| 9   | GCV-3                                       | pixels render 90° wrong, causes the zoom complaints                    | Pixels are never wrong (the renderer rotates); only the aspect number transposes, and it is **inert**. Effectively P3.                                                                                              |
| 10  | GCV-2                                       | aspectRatio inert in measured slots                                    | Stronger — inert in **every** slot.                                                                                                                                                                                 |
| 11  | SYNC-1                                      | match receipts by `clientMsgId`                                        | Would add a reader↔message correlator to the WS frame — breaks group-blindness.                                                                                                                                     |
| 12  | SYNC-2                                      | there is a server-side twin in `apps/messenger-service`                | **Wrong file hint** — the entire fix is client-side.                                                                                                                                                                |
| 13  | SYNC-5                                      | call bubbles have no restore path; mint missed calls as E2EE envelopes | Bubbles **do** ride the backup mirror; the E2EE option is **BLOCKED** by the payload allow-list (poison pill).                                                                                                      |
| 14  | SYNC-6                                      | put `conversationId` on the typing frame                               | **Not shippable** — group clustering signal. Opaque per-recipient tag instead.                                                                                                                                      |
| 15  | NA-04                                       | call `bringAppToForeground()` unconditionally                          | **Insufficient** — CallKeep's warm branch sends a bare launcher intent that _clears_ `showWhenLocked`; needs a native intent carrying `EXTRA_CALL_LAUNCH`.                                                          |
| 16  | NA-05                                       | buffer the frame and re-send on reconnect                              | **Already implemented.** The defect is the 12 s budget + watchdog arm point.                                                                                                                                        |
| 17  | OR-1 / OR-2 / OR-3 / OR-5 / SRV-02 / SRV-06 | see per-item flags above                                               | WorkManager arch-gated + redundant; `fetchWithTimeout` unfixable in JS; headless pull rejected; "env-only change" is 225 untested lines; call-state persistence unnecessary; per-callId budget cannot help redials. |

---

## 6. Cross-cutting execution notes

**Schema chain (single-writer discipline):**
`14 → 15` STORE-1 (`outbox.soft_attempts`) → `15 → 16` RT-6 (`pending_reactions` table) →
`16 → 17` RT-7 (`messages.envelope_ids_json`, `messages.receipts_json`).
Every `ALTER` goes **after** the v7 rebuild. There is no migration harness — the v15/v16/v17 ALTERs
are verified by an **in-place APK upgrade** device probe (no `no such column:` in logcat).

**Deploy ordering:**

1. **Server first:** RELAY-1 → GW-1 → GW-2 → RELAY-2 / GW-3 → PUSH-1 (server half).
2. **Client after:** the RT chain. Every client change in this plan is safe against the _old_ server
   (pacer over-conservative, `ackBatch` falls back on 404, `Retry-After` already emitted today).
3. **WS-1's flag flip is a separate ops action** on single-replica staging, after merge.

**Builds:** CALL-A (native Kotlin module) and PATCH-1 (patch-package) both require an **APK
rebuild**; `android/` is `.gitignore`d → `git add -f`. Everything else is JS/TS.

**Device-verification debt** (no device attached in the implementation environment — state this
explicitly in every sign-off): killed/locked-screen call answer with two-way audio and
`startForeground ok type=132/196` (CALL-A); single ringtone across the three ring states (CALL-B);
airplane-mode 70-min queue → all rows drain, nothing reaches `'failed'` (STORE-1/RT-2/RT-3);
≥10-member group burst with no bubble parked in `'sending'` (RELAY-1 + RT-4);
3-device group video for capture/tile geometry (VID-1/VID-2);
force-stop → relaunch reaction survival (RT-6); BACKUP_LOOP idle-boot silence (RT-6/RT-7).

**Suggested branch layout:** one branch per wave (`fix/b121-wave1` … `fix/b121-wave8`), items as
separate commits inside it, merged to `main` only on a fully green
`npm run test:crypto` + `npm test` + `npm run typecheck` (≤ 47) + `cd apps/messenger-service && npm test`.
