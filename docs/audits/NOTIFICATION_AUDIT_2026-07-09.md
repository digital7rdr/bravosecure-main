# Notification System — Full-Stack Audit (2026-07-09)

**Build audited:** mobile v1.0.102 / versionCode 128 (repo HEAD `12894de`) · messenger-service + auth-service + ops-console at same HEAD
**Trigger:** user report (physical Android device, 2026-07-09) — five complaints, all reproduced against code:

1. Incoming call while app is closed does **not ring**; a notification appears only **after** the call.
2. Tapping a message notification opens **"Chat hit an error"**.
3. Notifications are generic ("New secure message / Open Bravo Secure to read it") — user wants **Telegram-style** (sender name, avatar, preview, inline reply, mark-as-read).
4. In-app **bell** (notification center) **not synced** — on mobile AND the ops-console webapp.
5. **"Notification is not smooth"** — perf/UX jank.

**Method:** 53-agent audit workflow — 7 parallel domain auditors (call-ring, tap-error, telegram-parity, bell-mobile, bell-webapp, backend-pipeline, smoothness), **every finding independently adversarially verified** (a second agent re-read the cited code trying to refute it), plus a completeness critic. Raw verdicts: 39 CONFIRMED, 5 PARTIAL (kept with corrections), 1 REFUTED (dropped — §9). Cross-dimension duplicates merged below → **36 findings (N-01…N-36): 13 P1 · 13 P2 · 10 P3**.

**Role note:** this is an SQA audit — findings + recommended fixes for the dev handoff. No fixes were applied.

---

## 1. Executive summary

All five complaints are **fully explained by confirmed, code-verified defects**. None of them is the old B-48 token bug — the B-48 server fixes (twin-reap, VOIP fallback) and the client `ensurePushRegistered`-on-WS-connect fix are all **present and correct in vc128**. The remaining breaks are structural:

| #   | Complaint                                           | Most likely root cause (verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Call doesn't ring when app closed; notif after call | `handleCallOffer` queues the offer + fires the FCM VoIP wake **only** in the `peer_offline` branch, but a killed app's socket stays "online" up to **~55 s** (heartbeat 30 s + grace 25 s) — the offer is emitted into a dead socket, **no wake, no queue, no trace** (N-01). The after-the-call notification is the complementary regime: a wake that lands within its 30 s validity after the caller hung up rings up to 45 s with **no cancel push**, and un-purged Redis offers **replay dead calls** on app open; the missed-call replay is **dead code** (45 s payload TTL == the >45 s age threshold) (N-02, N-03).                                                                                                                                                    |
| 2   | Notification tap → "Chat hit an error"              | The deep-link navigates to `Chat` passing **only `{conversationId}`** through an untyped `navigationRef` cast; the route requires `name` (and `isGroup`). `ChatScreen` unconditionally renders `initials(name)` → `name.split(/\s+/)` on `undefined` → render TypeError → the 'Chat' error boundary. **Deterministic on every tap that resolves a conversation; Retry re-crashes** (N-07).                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Generic banners vs Telegram                         | Every message banner funnels through `showMessageNotif`, which hardcodes the generic title/body and accepts **no** body/person/style/actions/badge params — while notifee 9.1.8 supports all of it and sender/conversation names are **locally resolvable on every path including killed** (the handlers already parse the persisted vault that contains them). The generic banner is a **composition gap, not an E2EE constraint** — only killed-app preview _text_ is genuinely blocked by the no-headless-decrypt design (N-10, N-12, N-13).                                                                                                                                                                                                                               |
| 4   | Bell not synced (mobile + webapp)                   | There is **no notification model anywhere**: no server inbox (event details live in Redis with a **5-minute TTL**; no notifications table, no `/me/notifications`); the purpose-built mobile inbox (ActivityBell/ActivityCenter/activityStore) is **dead code** — never mounted, no route, `recordActivity()` has **zero production callers**; the live Dashboard bell lights its dot from messenger unread but opens a **hardcoded empty drawer** with a no-`onPress` "Mark all read"; the webapp "bell" is a static link to `/live` badged with the **unacked-SOS count**, which **drifts forever** because cancelled SOS never get `acknowledged_at`. The two bells count different things against no shared store — sync is architecturally impossible today (N-18…N-26). |
| 5   | Not smooth                                          | Every backgrounded message is **posted twice** to the same notifee id with no `onlyAlertOnce` → double sound + heads-up + generic→named title flicker per message (N-29); group wakes **misroute to the sender's 1:1** (duplicate banners, wrong tap target, wrong mute, lingering banner) (N-11); every inbound append still does a **full-store diff walk + one SQL txn** (M-14 residual, N-30); a permanently-denied `POST_NOTIFICATIONS` is **silently swallowed** with no indicator or Settings deep-link (N-31).                                                                                                                                                                                                                                                        |

**Two coupling warnings for the fix plan (§6):** (a) adding clock-skew tolerance to the VoIP wake (N-03) **widens** the orphan late-ring window unless the cancel push (N-02) ships with it; (b) fixing the tap crash (N-07) by passing `name` alone still deep-links group messages into the wrong 1:1 thread (N-11) — resolve `name`+`isGroup` from the same store row used by the exists-check AND make ChatScreen self-heal params from the store.

---

## 2. What is already working (verified — do NOT re-fix)

- **B-48 fixes all present in vc128:** `ensurePushRegistered()` re-registers on WS `connected` (`productionRuntime.ts:1027` → `fcmBootstrap.ts:68-76`); server twin-reap + chat-wake VOIP fallback live in `push.service.ts`. Handlers registered at bundle entry before any early return (`index.js:46-50`).
- **Manifest gates declared:** `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT` (`AndroidManifest.xml:40`), `FOREGROUND_SERVICE_PHONE_CALL`; `bravo-messages` channel pre-created; native `BravoRingtone` module registered.
- **M-03 (direct threads):** banners keyed `bravo-msg-<conversationId>` with dismiss-on-read works for 1:1 on every path. **M-05 exists-check** landed (`fcmBootstrap.ts:606-641`) — no phantom-thread minting (but see N-07: the thread it opens then crashes).
- **Smoothness fixes that ARE in:** `useCountdown` 1 Hz-per-bubble P1 genuinely fixed (single shared tick, `ChatScreen.tsx:2146-2215`); `markRead` is one bulk commit (`updateMessageStatusBulk`); row UPDATEs route through the 50 ms `upsertCoalesced` batcher; headless wakes deliberately never boot the runtime; runtime boot/drain are singleton/coalesced.
- **Commit `12894de` (obsidian redesign) is exonerated** for complaint 2 — it touched only Splash/DepartmentChannels/DepartmentChat/Files screens; `ChatScreen` is the only screen wrapped with boundary label 'Chat'.

---

## 3. Findings index

| ID   | Sev | Complaint | Verdict   | Title                                                                                                                                                                  |
| ---- | --- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-01 | P1  | 1         | CONFIRMED | 1:1 VoIP wake suppressed by zombie "online" socket (~55 s window) — call rings nowhere, no trace                                                                       |
| N-02 | P1  | 1         | CONFIRMED | No cancel/missed-call push; missed-call replay is dead code (TTL bug); stale offers ghost-ring                                                                         |
| N-03 | P1  | 1         | CONFIRMED | 30 s wake expiry vs raw device clock, zero skew tolerance — silent drop, no fallback                                                                                   |
| N-04 | P2  | 1         | CONFIRMED | Caller-side masking: failed/denied wakes leave caller in "calling…" with zero feedback (critic G-1)                                                                    |
| N-05 | P3  | 1         | CONFIRMED | Android 14+ full-screen-intent runtime grant never checked (latent for Play rollout)                                                                                   |
| N-06 | P3  | 1         | CONFIRMED | VoIP wake budget (6/min/pair) silently swallows legitimate redials                                                                                                     |
| N-07 | P1  | 2         | CONFIRMED | Notification tap crashes ChatScreen: deep-link omits required `name` param → `initials(undefined)`                                                                     |
| N-08 | P2  | 2         | CONFIRMED | Deep-link also omits `isGroup` — push-opened groups render/behave as 1:1                                                                                               |
| N-09 | P3  | 2\*       | PARTIAL   | msg-wake tap has no nav-ready wait (call path polls 8 s; message path no-ops)                                                                                          |
| N-10 | P1  | 3         | CONFIRMED | Zero Telegram-parity features despite notifee 9.1.8 supporting all of them                                                                                             |
| N-11 | P1  | 3+5       | CONFIRMED | Group wake misroutes to sender's existing 1:1 — wrong keying, wrong tap, wrong mute, lingering banner                                                                  |
| N-12 | P2  | 3         | CONFIRMED | Killed/warm-FCM banner omits the locally-resolvable conversation name (~15-line fix)                                                                                   |
| N-13 | P2  | 3         | CONFIRMED | Killed-app call notification always "from Bravo contact" — skips the local-name lookup the warm path does                                                              |
| N-14 | P2  | 3         | PARTIAL   | Muted groups still banner on killed AND backgrounded paths; muted 1:1 wrongly silences that sender's group messages                                                    |
| N-15 | P2  | 3         | PARTIAL   | `sendChatWake` conversationId/senderName params are dead — payload contract unmet, docstring false                                                                     |
| N-16 | P3  | 3         | CONFIRMED | No notification-privacy setting (Signal-style name/content tiers) — visibility hardcoded                                                                               |
| N-17 | P3  | 3         | CONFIRMED | No app badge count despite `unread_count` already tracked                                                                                                              |
| N-18 | P1  | 4         | CONFIRMED | Purpose-built notification center is dead code: ActivityBell unmounted, no route, store has zero writers                                                               |
| N-19 | P1  | 4         | CONFIRMED | Dashboard bell: dot = messenger unread, but drawer hardcoded empty + dead "Mark all read"                                                                              |
| N-20 | P1  | 4         | CONFIRMED | No durable server-side inbox — events live in Redis 5 min; missed push = permanently lost                                                                              |
| N-21 | P1  | 4         | CONFIRMED | `incident` push class has no client handler — Dept-Chat incident notifications dropped end-to-end                                                                      |
| N-22 | P2  | 4         | CONFIRMED | Three screens ship decorative bells with hardcoded always-lit dots and no onPress                                                                                      |
| N-23 | P1  | 4         | CONFIRMED | Ops-console bell is a static link to /live badged with global unacked-SOS count only                                                                                   |
| N-24 | P1  | 4         | CONFIRMED | SOS badge drifts forever: cancelled SOS never `acknowledged_at`; phantom rows hidden from /live and /sos default view                                                  |
| N-25 | P2  | 4         | CONFIRMED | Webapp has no realtime notification channel; messenger signal gated behind manual vault unlock; 5 s poll everywhere                                                    |
| N-26 | P1  | 4         | CONFIRMED | No shared notification model — every event class lands on at most one surface; two bells count different things                                                        |
| N-27 | P2  | 4         | CONFIRMED | Server-event wakes are normal-priority and hydration blob TTL (300 s) < FCM TTL (600 s) — deterministic loss window (B-52 pattern; dispatch-offer subcase arguably P1) |
| N-28 | P3  | 4         | CONFIRMED | Messenger unread has no tab-bar badge                                                                                                                                  |
| N-29 | P1  | 5         | CONFIRMED | Backgrounded message = two full-alert posts (no `onlyAlertOnce`) — double sound/heads-up + title flicker                                                               |
| N-30 | P2  | 5         | CONFIRMED | M-14 residual: every inbound append = full-store diff walk + one SQL txn (drain of N = N walks + N txns)                                                               |
| N-31 | P2  | 5         | CONFIRMED | Permanently-denied POST_NOTIFICATIONS / blocked channel silently swallowed — no indicator, no Settings link                                                            |
| N-32 | P2  | 5         | CONFIRMED | No server-side burst batching; collapseKey degrades to per-sender and merges distinct chats                                                                            |
| N-33 | P3  | 5         | CONFIRMED | Every msg-wake JSON.parses the entire persisted vault twice (three times with tap) — no cache                                                                          |
| N-34 | P3  | 5         | CONFIRMED | No badge management + foreground blanket-cancels only the store-notifier's banners — divergent shade state                                                             |
| N-35 | P3  | 5         | CONFIRMED | Ops-console polish: fake "● STREAM" label on 5 s poll, non-clickable rows, 10-row cap, blocking `window.prompt/confirm`                                                |
| N-36 | P2  | other     | CONFIRMED | Chat wakes are Android-only — iOS DATA tokens ignored by `sendChatWake` (latent for iOS launch)                                                                        |

\* N-09 retagged: it cannot produce "Chat hit an error" (a not-ready navigate is a console-error no-op, never mounts Chat).

---

## 4. Complaint 1 — killed-app call never rings; notification only after the call

### N-01 (P1) — Zombie "online" socket suppresses the 1:1 VoIP wake

**Symptom:** call to a recently-killed/OS-frozen app: no ring, no notification, no replay on reconnect; caller sits in "calling…".
**Root cause:** `handleCallOffer` runs the Redis pending-offer queue **and** `sendVoipWake` only inside the `peer_offline` branch (`apps/messenger-service/src/gateway/messenger.gateway.ts:1038-1101`). Offline-ness = `hub.deviceIsOnline` = bare `fetchSockets()` room membership (`socket-hub.ts:44-48`) — no liveness check. With `pingInterval=30000` + `pingTimeout=25000` (`configuration.ts:16-26`, wired at `redis-io.adapter.ts:83-84`; grace deliberately raised 10→25 s for B-05), a socket whose process died **without a FIN** (Doze, radio asleep, network switch, OEM freeze) stays "online" up to ~55 s. During that window the offer is emitted into the dead room via a fire-and-forget `emit` with no delivery ack (`:2138-2160`) — wake and queue both skipped, so there is also no replay and no `call.missed` later. `connectionStateRecovery` is configured but inert by default (stock adapter, `WS_SESSION_RECOVERY` off; `redis-io.adapter.ts:64-77,107-110`), and `handleDisconnect` compensates nothing for the callee (it only fires `bye` for calls the disconnecting socket _owns_; the callee socket isn't associated until `call.answer`, `:1123`).
**Qualifier (verified):** a _clean_ swipe-kill with live network sends a TCP FIN and reaps in ~RTT → `peer_offline` → wake correctly sent. The silent window applies to ungraceful drops — which on physical devices under Doze/OEM killers is the common case.
**Contrast / fix pattern already in-repo:** the group `sfu.ring` path emits WS **and** fires `sendVoipWake` unconditionally (`:1613-1625`), deduped client-side by callId (`bravo-call-<callId>` notif id; foreground `onMessage` ignores voip-wake, `fcmBootstrap.ts:220`).
**Fix:** always queue the pending offer + fire `sendVoipWake` on `call.offer` regardless of the online probe (mirror the sfu.ring path); and/or gate "online" on last-pong recency.

### N-02 (P1) — No cancel/missed-call push; missed-call replay dead code; stale offers ghost-ring

Four verified legs (this is the "notification appears only after the call"):

- **(a) No cancel push:** `handleCallHangup` does only `trackCallEnd` + `forwardToDevice` (`messenger.gateway.ts:1161-1184`) — no `pendingOfferKey` purge, no FCM. `trackCallEnd` is per-node in-memory only. Grep of `apps/messenger-service/src/push` for cancel/hangup: zero; the client headless handler has **no cancel kind it could even receive** (`fcmHeadless.ts:39-128`).
- **(b) Ghost replay:** the queued offer (SET `EX 45`, `:1062-1081`) is not purged on hangup, and the reconnect drain replays any offer aged ≤45 s as a live `call.offer` **without checking the ended-call registry** (`:576-587`) — a callee opening the app within 45 s rings for a call already dead. Group: `sfu.ring.cancel` fans WS-only (`:1631-1655`) — a killed device woken by push keeps its full-screen ring until the local 45 s `timeoutAfter` (`callNotification.ts:316`).
- **(c) Missed-call replay unreachable:** `call.missed` is emitted only when the payload is still readable AND `ageSec > 45` (`:546-570`) — but the payload expires at exactly 45 s (`EX 45`), so `raw` is null past 45 s and the loop `continue`s silently (`:553`). The window where both hold is milliseconds. The index key lives 60 s (`:1076-1079`), so 46–59 s reconnects enumerate callIds whose payloads are gone. The client consumer that would show the missed-call notif + bubble (`callDispatcher.ts:168-186`) is starved — **missed calls to killed apps vanish without trace**.
- **(d) Late wake = silence:** a wake landing past its 30 s exp is dropped by verification with no UI (`fcmHeadless.ts:62-65`; also warm path `fcmBootstrap.ts:1001-1004`), even though the client at that point knows a call was attempted.
  **Fix:** on hangup/ring-cancel to an offline target: purge `pendingOfferKey` + send a data-only `call-cancel` push (collapseKey `voip-cancel:<callId>`) that dismisses the ring headlessly; split freshness from retention for missed-calls (slim `{callId, from, kind, at}` marker with long TTL; drain emits `call.missed` from markers); on a stale/no_key verdict render a missed-call notification instead of nothing (resolve the name locally — `callerName` is deliberately not on the wire).

### N-03 (P1) — 30 s exp against raw device clock, zero skew tolerance

Server stamps `exp = server_now + 30 s` and FCM ttl 30 s (`push.service.ts:104, 827-828, 853-857`); client compares to raw `Date.now()` with no allowance (`voipWakeVerify.ts:309-310`) and production is fail-closed (`LEGACY_FALLBACK=false`; the legacy env flag rescues only `malformed`/`no_key` — a `stale` verdict **hard-drops regardless**). A device clock ≥~30 s fast (documented prior incident: the 1:1 "stale" clock-drift case) or FCM deferral + headless bundle-eval time past 30 s kills **every** killed-app ring on that device, silently (`[fcm-headless] voip-wake DROPPED reason=stale` in adb only). Foreground calls work (WS path skips HMAC verify), making this maddening to triage.
**⚠ Fix coupling:** widening exp / adding skew tolerance **extends** the orphan late-ring window that the 30 s exp currently bounds — ship skew tolerance **together with** the N-02 cancel push + hangup purge.
**Fix:** ±90-120 s skew allowance (or server issue-time for relative freshness); degrade stale/no_key to a missed-call notification.

### N-04 (P2) — Caller never learns the ring was lost (critic G-1)

After queueing, `handleCallOffer` returns `undefined` to hide `peer_offline` from the caller "if we managed to queue + fire push" (`messenger.gateway.ts:1095-1100`) — but the wake is `void …​.catch(() => {})` (`:1091-1094`), so budget-denied / token-less / FCM-failed wakes still leave the caller in "calling…" indefinitely. Neither party gets any signal. **Fix:** surface `sendVoipWake`'s `{sent:0, reason}` to the caller path (e.g. `recipient unreachable` hint).

### N-05 (P3) — Android 14+ FSI runtime grant never checked

Manifest declares `USE_FULL_SCREEN_INTENT` (`AndroidManifest.xml:40`) and `fullScreenAction` is set unconditionally (`callNotification.ts:321-324`), but nothing inspects the runtime grant (default-deny for Play-delivered non-dialer apps since 2024). Latent while distribution is Firebase sideload; user-visible on Play rollout. Note (verifier): notifee does **not** expose an FSI grant field — needs a small native `NotificationManager.canUseFullScreenIntent()` check + `Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` deep-link; heads-up + BravoRingtone fallback already exists but is never escalated/messaged.

### N-06 (P3) — Wake budget swallows legit redials

`consumeVoipWakeBudget`: 6/min per (sender,recipient) pair (`push.service.ts:671-706`); denial returns `{sent:0}` which every caller void-swallows. Rapid redial through a flaky window burns budget on undeliverable wakes, then blocks deliverable ones. **Fix:** don't charge budget for `sent=0` outcomes; same-callId repeats free.

### Diagnostic caveat (critic G-3 — include in retest)

None of these fixes can ring a **force-stopped** app: Android delivers no FCM at all in stopped state (user Force-stop, aggressive OEM battery managers). Device triage before judging the fixes: check OEM battery-optimization/autostart settings and capture logcat during a test call to separate this environmental mode from the code defects.

---

## 5. Complaint 2 — notification tap → "Chat hit an error"

### N-07 (P1, borderline P0) — deep-link omits required `name`; `initials(undefined)` throws at render

**Deterministic on every tap that resolves a conversation** (the common case), on all three entries — notifee `onForegroundEvent`, `onBackgroundEvent`, and the cold-launch `getInitialNotification` synthetic PRESS (`fcmBootstrap.ts:800-825`) — all funnel into the same handler.
**Chain (every link verified):** `fcmBootstrap.ts:630-634` navigates `Main > MessengerTab > Chat` with `{conversationId}` **only**, through an untyped cast (`:629` — `navigationRef as unknown as {navigate…}`), so TS never flagged it. Route contract requires `name: string; isGroup: boolean` (`src/navigation/types.ts:54`). `ChatScreen.tsx:111` destructures `name` (undefined) → header unconditionally renders `initials(name)` (`:1124`) → `initials()` calls `name.split(/\s+/)` with no guard (`:2403-2405`) → render TypeError → caught by `withScreenErrorBoundary(ChatScreenInner, 'Chat')` (`:1606`) → "Chat hit an error" (`withScreenErrorBoundary.tsx:71`). **Retry remounts with the same params → re-crashes; only Back works.**
**Not a hydration race** (verifier-strengthened): there is **no early return** pre-ready — `ChatScreen.tsx:982-989` only computes a status label rendered in the _same_ tree as the header, so the crash fires on the very first render regardless of runtime readiness. Introduced with the deep-link in `fffe40a`; survived the `dd8c184` M-05 remediation (which added only the exists-check around the same crashing navigate). Every in-app caller passes `name`+`isGroup` (`MessengerHomeScreen.tsx:322`, NewChatScreen, GroupsScreen, OpsMissionDetailScreen); the notification path is the only one that doesn't.
**Fix (two layers + G-2 coordination):**

1. At the deep-link: resolve `name` + `isGroup` from the **same store row the exists-check already fetched** (`useMessengerStore.getState().conversations[convId]` at `:616`, persisted slice at `:622-623`) — `{conversationId, name: resolved ?? '', isGroup: type !== 'direct'}`.
2. Harden ChatScreen: derive header fields from `conversations[conversationId]` with route params as fallback; guard `initials(name?: string)`. Add a regression test rendering ChatScreen with `{conversationId}` only.
   ⚠ Passing `name` alone fixes the crash but still deep-links group messages into the wrong 1:1 (N-11) — do both.

### N-08 (P2) — missing `isGroup` degrades push-opened groups

Once N-07 is fixed, group threads opened from a notification render as 1:1: header shows OnlineDot/PeerPresencePill instead of the member stack (`ChatScreen.tsx:1125,1133-1137`), bubbles lose sender labels (`:1310-1315`), the group roster-hydration effect early-returns (`:349-351` — its own comment says it exists for the push-tap entry), and `groupPeers` (presence subscribe, typing/read fan-out) collapses to a single peer (`:232-241`). Sending is safe (runtime re-derives group-ness from the store, `productionRuntime.ts:2110-2115`). **Fix:** included in N-07's store-derived params; longer-term prefer `conversation?.type` over the route param.

### N-09 (P3) — msg-wake tap doesn't wait for nav readiness

Call branch polls `waitReady(8000)` (`fcmBootstrap.ts:750-759`); msg branch navigates immediately (`:627-641`). Corrected mechanism (verifier): RN6 never throws on a not-ready ref — the navigate is a console-error **no-op** (the catch is dead code for this path), so the tap is silently swallowed on a too-early cold launch. Cannot cause complaint 2 (Chat never mounts). **Fix:** reuse `waitReady()` in the msg branch, fall back to MessengerHome.

---

## 6. Complaint 3 — Telegram-style notifications

### N-10 (P1) — zero parity features; most blockers are composition, not E2EE

`showMessageNotif` (`callNotification.ts:132-167`) is the single funnel for all message banners: title fallback `'New secure message'` (`:152`), fixed body `'Open Bravo Secure to read it'` (`:153`), no actions/style/largeIcon/group/badge params at all. Zero uses of `AndroidStyle.MESSAGING`, `AndroidPerson`, quick-reply input actions, `groupId/groupSummary`, `badgeCount` anywhere in src/ — while installed notifee 9.1.8 supports all of them (`NotificationAndroid.d.ts:60,137,157,472,625-633`). Same-id replacement means the 2nd…Nth message silently replaces the banner with identical generic text.
**Key fact:** on the **warm background path the runtime already decrypts** during the same FCM wake (`fcmBootstrap.ts:1112-1126` pullEnvelopes → store) and `backgroundMessageNotifier` reads plaintext tails (`:76-92`) yet still posts a generic body — the in-code rationale (`callNotification.ts:113-115`) is true only for the killed path. **Preview text on the warm path is a policy choice.**
**Gap matrix → staged plan (all within security bounds — locally-derived data only, nothing new on the wire):**
| Feature | Blocker | Approach | Effort |
|---|---|---|---|
| Sender/conversation name in title | none — data already parsed (N-12/N-13) | pass persisted `name` as title on all paths | S |
| Preview text (warm/backgrounded) | policy only | `AndroidStyle.MESSAGING` from store tail, accumulate ~5 lines/conv; gate behind privacy setting (N-16) | M |
| Inline Reply / Mark-as-read | none while runtime alive | notifee `input` action → `runtime.sendText`; `read-<cid>` → `markRead`+dismiss; no-op gracefully when killed | M |
| Conversation grouping + summary | none | `groupId='bravo-messages'` + one `groupSummary` | S |
| Badge count | none (N-17) | `android.badgeCount` from `unread_count`; `notifee.setBadgeCount` iOS later | S |
| Avatars | product-level: no profile-photo model (`avatar_url` never populated; in-app avatars are initials+color) | Person name-only or generated initials bitmap | M |
| Killed-app preview text | **real constraint:** deliberate no-headless-SQLCipher design; `configureMessengerRuntime` lives in MainNavigator | Signal-style slim headless drain under a cross-context mutex — keychain ACL already permits headless access (`keychain.ts:74-80`) | L (separate decision) |

### N-11 (P1, also complaint 5) — group wake misroutes to the sender's existing 1:1

Sealed sender: the wake carries only `senderUserId` (`push.service.ts:614-618`; both callers — `envelope.controller.ts:94-96` (ALL group fan-out) and `messenger.gateway.ts:927-929` — omit conversationId, so it is **always ''** on the wire). Both client handlers then run `resolveDirectConversationId(sender)` (`fcmHeadless.ts:100-102`, `fcmBootstrap.ts:1101`; `mutedLookup.ts:71-86`) which returns the 1:1 **whenever one exists** — a group message from an existing 1:1 contact is misclassified. Consequences: banner keyed `bravo-msg-<directCid>` collides with real 1:1 banners; **tap opens the 1:1 where there is no new message**; mute is checked against the 1:1; the miskeyed banner survives reading the group and clears only by opening the unrelated 1:1 (`ChatScreen.tsx:308-309`); warm path additionally posts the correct group-keyed banner → **two banners for one message**. M-05's fix only prevents minting _nonexistent_ threads, not misrouting to existing ones.
**Verifier bonus:** the muted-1:1-silences-groups failure is even independent of resolution — `isConversationMuted` has an unconditional `senderUserId` branch (`mutedLookup.ts:52-55`) that suppresses whenever _any_ direct thread with that peer is muted. Fix must target that branch specifically.
**Fix:** when the wake can't be proven 1:1, fall back to the sender-keyed generic banner and route tap to Messenger home; suppress the FCM banner when the runtime is alive (store notifier posts the correct one); drop senderUserId-based mute suppression for heuristic resolutions. Complete fix = killed-path headless drain (see N-10 last row).

### N-12 (P2) — killed/warm-FCM banner omits the locally-available name (merged w/ backend P3 duplicate)

Both FCM handlers call `showMessageNotif` **without title** (`fcmHeadless.ts:109`, `fcmBootstrap.ts:1107`) even though they already parsed the persisted vault that **contains the conversation name** (`mutedLookup.ts:17-21` interface simply omits `name`; partialize keeps names — `messengerStore.ts:1094-1113`). Precedent explicitly allows local-name titles (`backgroundMessageNotifier.ts:12-14`; `callNotification.ts:135` docstring). **Fix (~15 lines):** return `{id, name}` from the resolver; pass as title; keep visibility PRIVATE.

### N-13 (P2) — killed-app call says "from Bravo contact"

`fcmHeadless.ts:72` reads `data.callerName` which the server **never sends** (privacy by design — `push.service.ts:837-852`: payload has `fromUserId`+`callKind` only); the warm handler resolves the local name (`fcmBootstrap.ts:1014-1031`), the headless one doesn't, though the same vault it already reads has direct-conversation names keyed by peer userId. **Fix:** `resolveDirectPeerName(fromUserId)` in mutedLookup; use before falling back.

### N-14 (P2) — muted groups still banner on killed AND backgrounded paths

Group mute is enforced only post-decrypt in `backgroundMessageNotifier` (`:90`) — i.e. only the notifier's own _upgrade_ banner is withheld; the FCM background handler's banner (`fcmBootstrap.ts:1101-1103`) and the killed path (`fcmHeadless.ts:94-107`) can only test the sender's 1:1 (`mutedLookup.ts:41-61` — a group's `is_muted` is structurally unreachable without a conversationId the wire never carries; the comment at `:49` claiming conversationId is "present for group wakes" is false). Inversion: muting a person's DM silences their group messages; muting the group doesn't. Note: `MESSENGER_AUDIT.md:139` already documents "Fixed (warm)… killed-path residual" — but "warm" is itself optimistic (backgrounded leaks too). **Fix:** persisted sender→group-membership index for the killed path, or low-importance channel for unresolvable wakes; drop the DM-mute proxy (N-11).

### N-15 (P2) — `sendChatWake`'s conversationId/senderName are dead params (retagged from complaint 2)

Signature accepts them (`push.service.ts:562-565`), docstring claims they're sent (`:558`, false), but **no caller ever supplies them** — grep-verified. The PUSH-B2 comment (`:623-628`) documents the omission as deliberate under sealed sender; `collapseKey` degrades to `msg-wake:<senderUserId>` (`:629`). The M-05 exists-check prevents phantom navigation, so this does **not** cause complaint 2; residue = killed-app group banners can't be conv-keyed (N-11/N-14) and per-conversation collapse degrades to per-sender. **Fix:** decide the contract — opaque per-conversation collapse hint (HMAC) from the sender client, or delete the dead params + fix docstrings and make client-side resolution the documented design.

### N-16 (P3) — no notification-privacy setting

Visibility hardcoded at all three display sites (`callNotification.ts:159, 232, 295` — messages PRIVATE, missed PRIVATE, calls PUBLIC); no name/content tier anywhere (SettingsScreen's notification toggles are server-side _category_ prefs only, never read by push display). Blocks the preview upgrade for a confidentiality-first app. **Fix:** Signal-style 3-tier setting, default "Name only"; ship before/with the MessagingStyle upgrade.

### N-17 (P3) — no badge count

`Conversation.unread_count` exists and is maintained (`types/index.ts:202`; bumped `messengerStore.ts:90/:579`, reset `:98`); zero badge code in src/. notifee supports both platforms. Effort S; Android badges launcher-dependent.

---

## 7. Complaint 4 — bell not synced (mobile + webapp)

The complaint is **structural**: three disjoint pipelines, no shared store, and the one purpose-built inbox is dead code.

### N-18 (P1) — mobile notification center is dead code (three-part orphaning)

(1) `ActivityBell.tsx` imported by **zero** files (its own header comment "mounted in all three role shells" is false); (2) `ActivityCenterScreen` registered in **no** navigator; (3) the store's only writers `recordActivity()/append()` (`activityStore.ts:100-102`) have **zero production callers** — only the unit test. The documented writer (`serverWakeNotifications.showServerWakeNotification`, `:91-186`) draws notifee banners but never appends a row, contradicting the store's own doc comment (`activityStore.ts:7-10`). `MainNavigator.tsx:296` even `setOwner()`s the store on login — it sits owned-but-empty forever. **Fix:** call `recordActivity()` from `showServerWakeNotification` + foreground onMessage; register the route; mount ActivityBell in the three role shells (replacing N-22's fakes). _Wiring the writer alone changes nothing visible — no shipped screen reads the store; mount + route are prerequisites._

### N-19 (P1) — Dashboard bell: unread dot + hardcoded empty drawer

Dot = summed messenger `unread_count` (`DashboardScreen.tsx:207-210`, rendered `:405-408`); drawer body = hardcoded "You're all caught up." (`:554-559`; comment `:549-553` admits it stays empty "until a /me/notifications history endpoint exists"); **"Mark all read" `TouchableOpacity` has no `onPress`** (`:544-546`). Two data sources glued to one control — the literal "bell not synced". Booking/mission/payout/SOS never light the dot (nothing writes the activity store). **Fix:** render real data (messenger unread list or activity rows once wired); wire mark-all-read; long-term back with the server feed (N-20).

### N-20 (P1) — no durable server-side inbox; 5-minute Redis TTL is the only record

`BookingPushBridge` stores the event detail with `EX 300` (`booking-push-bridge.service.ts:35, 63-67`) and publishes an opaque `{userId, eventClass, eventId}`; the **only** read path is `GET /events/by-id/:eventId` (`events.controller.ts:27-45`) within 5 min. No notifications table (grep of all migrations), no `/me/notifications`, no read-state anywhere. Any wake the device misses (B-48/B-52 token class, Doze, reinstall, killed >5 min) is **permanently unrecoverable**. The three surfaces have three disjoint sources (mobile dot = messenger unread; mobile inbox = never-written store; webapp = unacked-SOS KPI). **Fix:** notifications table (user_id, event_class, kind, refs, created_at, read_at) written by `BookingPushBridge.publish` alongside the Redis blob; `GET /me/notifications?since=` + `POST /me/notifications/read`; mobile fetches on foreground + WS reconnect merging into activityStore (dedupe by eventId); webapp same endpoint. Metadata-only payloads (P0-N8).

### N-21 (P1) — `incident` class dropped end-to-end

Server publishes `incident` (kinds `incident-submitted`/`incident-status`; `incident.service.ts:140, 261` → `booking-push-bridge.service.ts:205-214`; live on main, forwarded to FCM with no whitelist), but `AGENT_WAKE_META` (`serverWakeNotifications.ts:57-81`) has no incident kinds → `return false` (`:185`) → both handlers log "unknown background wake kind, no action" (`fcmBootstrap.ts:1136-1137`, `fcmHeadless.ts:124-125`). Org managers get **nothing** when a CPO files an incident. Same drift class CRIT-5 was meant to prevent. **Fix:** add both kinds to the meta table + a table-driven parity test against the server's kind list.

### N-22 (P2) — three decorative bells with always-lit dots

`OpsDashboardScreen.tsx:84-87` (TouchableOpacity, no onPress, unconditional notifDot #EF4444 at `:237`), `AgentHomeScreen.tsx:98-103` (same; dot `:102`, style `:210`), `JobMarketplaceScreen.tsx:296-300` (bell in a plain View — not even tappable; dot `:299`, violet `:469`). All three ship on live routes (`AgentNavigator.tsx:139,159`; `BookingNavigator.tsx:232`). The dot state is a lie baked into JSX. **Fix:** replace with ActivityBell once wired; until then remove the hardcoded dots.

### N-23 (P1) — ops-console bell = SOS-count link

`Shell.tsx:296-310` ("Audit fix 4.6" comment): `unackedSos = dash?.kpis?.sos_active` from the 5 s `useDashboard` poll (`api.ts:1125-1134`); bell = `<Link href="/live">` + badge (`:371-382`). No dropdown, no list, no read state. auth-service has no notifications route (full `ops.controller.ts` route list verified); `live_feed_events` has no read/seen column or admin scoping (`ops-audit.service.ts:133-171`); `opsApi.activity()` (`api.ts:606`) has **zero call sites** (the dashboard card gets activity rows inline via `/ops/dashboard`). **Fix:** per-admin notifications model (table + `GET /ops/notifications` + read route + dropdown), or minimally a dropdown over `GET /ops/activity` with a localStorage last-seen watermark, SOS as a red sub-badge.

### N-24 (P1) — SOS badge phantom drift

Chain: client false-alarm `cancel()` sets `status='false_alarm', resolved_at=NOW()` but never `acknowledged_at` (`sos.service.ts:164-171`); the KPI counts `WHERE acknowledged_at IS NULL` with **no resolved filter** (`ops.service.ts:117`) → cancelled SOS inflate the badge **forever**; `ackSos` is the **sole** `acknowledged_at` writer (`mission.service.ts:646-667`; resolve/escalate/abort never stamp it — `abort()` `:420-478` also strands open SOS rows); the bell's click target `/live` lists **missions only** (`live/page.tsx:20-158`), and `/sos` defaults to `active` = `resolved_at IS NULL` (`ops-data.service.ts:308-312`) which **hides** resolved-but-unacked rows — the only way to clear the badge is undiscoverable (switch to 'all', ACK an already-resolved row). Bonus: the subquery ignores `regionClause` unlike sibling KPIs — region-scoped operators count other regions' SOS. **Fix:** count `acknowledged_at IS NULL AND resolved_at IS NULL`; stamp/exclude in `cancel()`; `abort()` auto-resolves its SOS rows; point the bell at `/sos`.

### N-25 (P2) — no realtime for the webapp; message signal gated behind vault unlock

The console's only socket.io connection is the messenger transport (`transport.ts:109`; handlers `:132-160` — no notification events either direction); the runtime pumps only after **manual vault unlock** (`MessengerProvider.tsx:63-86`); incoming-message signal exists only as MissionGroupPanel's local "OPEN CHAT · N NEW" on Live Ops; Shell topbar/nav have no unread badge; browser Notification API unused; everything else is SWR polling (5 s/2 s) with `refreshWhenHidden=false` — backgrounded tabs stop updating entirely. **Fix:** `ops-notify` server event alongside `live_feed_events` inserts + Shell subscription; messenger unread badge on the nav item; optional browser notifications for SOS.

### N-26 (P1 — raised by verifier) — no shared notification model; coverage matrix

Three unrelated pipelines: (A) BookingPushBridge → FCM tray (booking/dispatch/mission/payout/sos/agent/incident) — nothing queryable behind it; (B) OpsAuditService → `live_feed_events` → webapp 10-row dashboard card (job feed, mission lifecycle, geofence, auth) — global, no read state, mobile never reads it; (C) messenger envelopes → mobile tray + in-app unread; webapp only inside the unlocked dock. Bell-visible coverage: **SOS is the only class on both surfaces** (and its counts drift, N-24); messages/calls appear on **no** bell; **incident on no surface at all** (N-21); mobile bell permanently zero (N-18). **Fix:** one fan-out point writing per-recipient notification rows (see N-20) — both bells read the same model and sync by construction.

### N-27 (P2) — server-event wakes: normal priority + blob TTL < FCM TTL

Only `sos` is high-priority (`push.service.ts:189-194`); everything else rides `priority: normal, ttl 10 min` (`:301-308`) — Doze defers normal-priority FCM to maintenance windows. Detail blob lives **300 s** (`booking-push-bridge.service.ts:35`) < FCM's 600 s: deliveries in the 5–10 min window **deterministically hydrate to 404** and render nothing (`serverWakeNotifications.ts:94-109→144→185`; no retry, no fallback banner). `dispatch-offer` — a 30-second-response revenue flow — rides this path (**arguably P1**; exact B-52 pattern). **Fix:** high priority for time-critical classes; blob TTL ≥ FCM TTL (or Postgres persistence per N-20); generic "You have an update" banner on hydration miss.

### N-28 (P3) — no messenger tab badge

Unread pipeline is sound (append bump `messengerStore.ts:642-644`, zeroing `:449-473`, warm pull, cold-start catch-up) but `CustomTabBar` renders no badge (grep 0 hits in `MainNavigator.tsx`); only Dashboard shows unread (dot `:407` + "N UNREAD" pill `:498`). **Fix:** badge on the Messenger tab from the same selector.

---

## 8. Complaint 5 — "notification is not smooth"

### N-29 (P1) — double post + re-alert per backgrounded message (merged w/ server-side no-WS-dedup)

Server fires a chat-wake on **every** envelope send with no recipient-online check — `deliveredNow` is computed and ignored (`envelope.service.ts:248-250`; WS `messenger.gateway.ts:927-929`; HTTP `envelope.controller.ts:94-96` even declares deliveredNow in its return type). On a backgrounded-but-warm app the same message posts **twice**: FCM handler posts a generic banner (`fcmBootstrap.ts:1107`), then after `pullEnvelopes` decrypts, `backgroundMessageNotifier` re-posts with the conversation-name title (`:91`). Direct chats: same notifee id, but **no `onlyAlertOnce` anywhere** (grep 0 hits; `callNotification.ts:150-163`, channel sound 'default' `:124`) → re-posting an existing id **re-plays sound + heads-up** → double ding + generic→named title flicker per message; a burst of N = up to 2N alerts on one banner slot. Groups: the two posts have **different ids** (miskeyed direct vs group, N-11) → two simultaneous banners, and the stale generic one lingers. The `push.service.ts:609-611` comment claiming data-only gives "exactly one banner in every app state" is false on this path.
**Fix:** `onlyAlertOnce: true` in `showMessageNotif` (one line, biggest UX win); skip the FCM-handler banner when the runtime is alive (let the store notifier own it); server: skip/delay the wake when `deliveredNow` to a live socket.

### N-30 (P2) — M-14 residual: full-store diff + one txn per inbound append

Fixed halves verified in: bulk markRead (`productionRuntime.ts:4076-4091`), UPDATE coalescer (`:1585-1590`). Remaining: every receive site commits one `appendMessage` per message (`:2223, 2495, 5715, 6299, 6688, 6744` — no bulk-append API); the write-through diff has **no `list === prevList` reference skip** — every commit iterates ALL conversations rebuilding a Map+Set each (`:1578-1581`; ~4k objects walked per commit at 20 threads × 200 cap); new rows bypass the coalescer — `store.upsert` = one implicit txn per message (`:1592-1599`; `sqlMessageStore.ts:96-98`). A 50-message drain = 50 full-store walks + 50 txns serialized on the JS thread → messages "stutter in". `MESSENGER_AUDIT.md:149` overstates M-14 as fully fixed. **Fix:** one-line reference skip (immer keeps untouched lists referentially equal — biggest win); `appendMessagesBulk`; route drain INSERTs through `upsertBatch`.

### N-31 (P2) — denied notifications are a silent dead end

Only onboarding handles blocked→Settings (`PermissionsScreen.tsx:57-72,156-165` — never reachable post-onboarding; the 4th request site, CpoActivation, also onboarding-only). Post-login, after NEVER_ASK_AGAIN the re-request resolves instantly and the result is **only console.logged** (`fcmBootstrap.ts:112-115`); `notifee.getNotificationSettings`/`openNotificationSettings` used nowhere, so a blocked `bravo-messages` **channel** is also undetectable; no screen renders a disabled-notifications banner. To the user this is exactly "notifications are broken". **Fix:** on MessengerHome focus check permission + channel-blocked; dismissible banner → `notifee.openNotificationSettings()`.

### N-32 (P2) — no burst batching; collapseKey merges distinct chats

Every accepted send = one immediate FCM per recipient device; only rate caps exist (HTTP 30/10 s; WS token-bucket + Redis gate), no coalescing. `collapseKey` is always `msg-wake:<senderUserId>` (conversationId never supplied) — one sender active in a group AND a 1:1 collapses to a single surviving wake on Dozed devices; on awake devices the cost is N re-alerts (see N-29) + N `pullEnvelopes` wake-ups. **Fix:** per-(recipient,sender) 5–10 s Redis debounce (first wake already triggers a pull that drains the burst); client `onlyAlertOnce`.

### N-33 (P3) — vault double-parse per wake

`resolveDirectConversationId()` + `isConversationMuted()` each independently `AsyncStorage.getItem('messenger-store-v1')` + `JSON.parse` the whole persisted blob (`mutedLookup.ts:27-39`) — the store's own comment says it can be **multi-MB** (`messengerStore.ts:13-19`). Sealed-sender 1:1 wakes pay 2 parses inside the Doze-budgeted handler; a wake-then-tap pays a 3rd via `conversationExists`. **Fix:** parse once per wake and share; longer-term a tiny dedicated push-routing slice.

### N-34 (P3) — badge/clear-on-open inconsistency

No badge code at all; `backgroundMessageNotifier` cancels ALL of its own banners on AppState 'active' **regardless of read state** (`:110-112`, tracking only `postedConvos` `:33-36`) while FCM-posted banners survive foregrounding until their thread opens (`ChatScreen.tsx:308-309`) — two banner populations with different clear semantics. **Fix:** single clear-on-read semantics + `setBadgeCount` from store unread.

### N-35 (P3) — ops-console polish

Hardcoded "● STREAM" label over a 5 s poll (`dashboard/page.tsx:124`); activity rows are plain divs (no link/read state, contrast Approval Queue's `<Link>`s); 10-row cap server-side with no view-all page (`GET /ops/activity` live but zero client consumers); badge rides the full 8-subquery dashboard payload; `window.prompt/confirm` block the UI thread in the SOS flow (`sos/page.tsx:53-67`). **Fix:** deep-link rows, Activity page over the existing endpoint, honest last-updated stamp (or true socket), cheap count route, modal pattern from live/[id].

---

## 9. Out of complaint scope but confirmed

### N-36 (P2) — chat wakes are Android-only

`sendChatWake` filters `platform==='android'` (`push.service.ts:596`) with no APNs branch (contrast `sendDataOnlyToUser`'s LM-N3 iOS path `:325-343`); the B-48 VOIP fallback is also android-only (`:574-575`, spec-locked). Aggravating: iOS-only DATA records make `records.length > 0`, skipping the VOIP fallback → silent `sent=0`. Latent total message-notification outage for the iOS launch. **Fix:** mirror LM-N3 (APNs content-available + `apns-collapse-id`).

### Dropped after adversarial verification (do not act on)

- **`wake-key-store-skipped-empty-userid` — REFUTED.** The claimed race (VoIP wake key skipped when authStore has no user id) is unreachable: `startFcmBootstrap`'s sole caller is gated on a hydrated `user?.id` (`MainNavigator.tsx:261`, deps `[user?.id]`); `restoreSession/verifyOtp` set user before `authenticated` flips; the only reachable skip (concurrent sign-out) is correct behavior. At most a P3 hardening nit (add a `console.warn`).
- Sub-claims dropped from kept findings: "MESSENGER_AUDIT overstates M-04" (the doc already records the killed-path residual — though "Fixed (warm)" is optimistic, see N-14); "Doze defers rings arbitrarily late" (the 30 s exp bounds displayed rings — N-02d); "the catch swallows the msg-tap drop" (RN6 no-ops, never throws — N-09); `chatwake-conversationid-dead-param` as a complaint-2 cause (retagged N-15 → complaint 3).

### Code-comment falsities to correct while fixing

- `ActivityBell.tsx:2-3` — "mounted in all three role shells": mounted nowhere.
- `push.service.ts:609-611` — "exactly one banner in every app state": false on warm background (N-29).
- `push.service.ts:558` docstring — data block does NOT carry conversationId/senderName in practice (N-15).
- `backgroundMessageNotifier.ts:16-17` — killed group wakes "stay generic sender-keyed": false when the sender has an existing 1:1 (N-11).
- `mutedLookup.ts:49` — conversationId "present for group wakes": it never is.

---

## 10. Recommended fix order (dev handoff)

**Wave 1 — the two user-facing breaks (S, ship together in one APK + one server deploy):**

1. N-07/N-08: deep-link passes store-derived `name`+`isGroup`; ChatScreen self-heals params; `initials()` guard; regression test. _(fixes "Chat hit an error")_
2. N-01: always-send the 1:1 VoIP wake + queue (mirror sfu.ring). **Server-only.**
3. N-02(a,b): purge pending offer on hangup + `call-cancel` data push, headless dismiss; drain checks ended-call state.
4. N-02(c): missed-call marker with long TTL → `call.missed` replay actually fires.
5. N-03: exp skew tolerance ±90-120 s + stale/no_key → missed-call fallback. **Must ship with #3 (coupling).**
6. N-29 quick win: `onlyAlertOnce: true` (one line).

**Wave 2 — Telegram parity + routing correctness (M):** 7. N-12/N-13: local names in killed/warm banner titles (~15 lines each). 8. N-11 + N-14: heuristic-resolution fallback (sender-keyed banner, tap → Messenger home), kill the `mutedLookup.ts:52-55` DM-mute proxy, suppress FCM banner when runtime alive. 9. N-10 items 2-5: MessagingStyle preview (warm path) behind N-16 privacy setting; inline Reply/Mark-as-read; grouping + summary; badge (N-17). 10. N-31: denied-permission banner + settings deep-link.

**Wave 3 — the bell (M-L, one design):** 11. N-20/N-26: durable notifications table + `/me/notifications` + `/ops/notifications` (single fan-out point). 12. N-18/N-19/N-22: wire recordActivity, mount ActivityBell + route ActivityCenter, replace fake bells, real Dashboard drawer. 13. N-21: incident kinds in AGENT_WAKE_META + server/client parity test. 14. N-23/N-24/N-25: ops bell dropdown + fixed SOS KPI + ops-notify socket event. 15. N-27: priority classes + blob TTL ≥ FCM TTL.

**Wave 4 — perf + platform (S-M):** 16. N-30 (reference-skip + bulk append), N-32 (wake debounce), N-33, N-34, N-35, N-28, N-04, N-06, N-05, N-36, N-15 contract decision, N-09, N-16 if not done in Wave 2.

## 11. QA retest protocol (after Wave 1)

1. **Force-stop triage first (critic G-3):** on the test device check OEM battery optimization/autostart; a force-stopped app receives NO FCM by OS design — test with app _swiped away_ (not Force-stopped), logcat attached.
2. Killed-app 1:1 call ≤55 s after swipe-kill (the old silent window): must ring. Server: `docker logs bravo-staging-msgr | grep push.voip`; device: `adb logcat | grep -E '\[fcm-headless|bravo.callnotif'`.
3. Caller hangs up before answer → callee's ring must dismiss (cancel push) and a Missed-call notification must appear; reopen app 2-10 min later → missed-call bubble present (marker replay).
4. Skew device: set device clock +2 min → killed-app call must still ring (or degrade to missed-call, not silence).
5. Notification tap (1:1 and group, foreground/background/cold): opens the correct thread, **no error boundary**, group renders member stack + sender labels.
6. Backgrounded message: exactly ONE alert sound, no title flicker; muted group: no banner in any app state.
7. Bell (after Wave 3): booking/mission/incident events appear in ActivityCenter and ops bell within one poll/socket tick; SOS badge clears on resolve/cancel.

---

## 12. Remediation log — 2026-07-09 (same day)

**Status: 30 of 36 findings fixed + verified, including the durable server-side notification inbox (N-20) with its DB migration applied to Supabase. Build bumped to v1.0.103 / vc129. On-device retest (§11) still required after the APK build + backend deploy.**

Gates (all green): mobile `tsc` **47 = baseline** (no new errors); messenger-crypto **1449/1449**; messenger-service **219/219** (+1 new N-32 debounce test); auth-service **1716/1716** (full suite — confirms the new `NotificationsModule` + the `BookingPushBridge` DI change across 6 modules boot cleanly); ops-console **production build passes** + `tsc` clean. Supabase migration `n20_notifications_inbox` applied (table verified). Pre-existing flaky/env failures in the `app` Jest project (`uploadAvatar` needs a live Edge Function; `authStore.recheckMembership`) are unrelated — those files are untouched.

### Additionally fixed (second pass)

| ID      | What shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Files                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| N-20/26 | **Durable server notification inbox.** New `notifications` table (migration applied); `NotificationsService` + `NotificationsController` (`GET /me/notifications`, `POST /me/notifications/read`); written at the single `BookingPushBridge.publish` fan-out point (metadata-only). Mobile `activitySync` fetches on foreground + drawer-open and merges into `activityStore` with a since-watermark; mark-all-read persists to the server. Both bells now reflect a real, backfillable source. | `notifications/*.ts`, `booking-push-bridge.service.ts`, `app.module.ts`, `activitySync.ts`, `MainNavigator.tsx`, `DashboardScreen.tsx` |
| N-23    | Ops-console bell is now a **dropdown notification centre** over the live activity feed with a per-browser unread watermark; actionable SOS count kept as a red sub-badge.                                                                                                                                                                                                                                                                                                                       | `NotificationBell.tsx`, `Shell.tsx`                                                                                                    |
| N-31    | In-app "notifications are off" banner with a Settings deep-link (checks notifee auth status + blocked Messages channel on focus), mounted on Messenger home.                                                                                                                                                                                                                                                                                                                                    | `NotificationPermissionBanner.tsx`, `MessengerHomeScreen.tsx`                                                                          |
| N-35    | Honest "RECENT" label replacing the fake "● STREAM" real-time claim on the polled dashboard card.                                                                                                                                                                                                                                                                                                                                                                                               | `dashboard/page.tsx`                                                                                                                   |

### Fixed

| ID         | What shipped                                                                                                                                                                                                                                                                                                          | Files                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| N-01       | 1:1 `call.offer` now **always** queues the offer + fires the VoIP wake (mirrors the group `sfu.ring` path), not only on the racy `peer_offline` probe — kills the zombie-socket no-ring window.                                                                                                                       | `messenger.gateway.ts` handleCallOffer                                         |
| N-02       | New `sendCallCancel` data push on caller-hangup dismisses a killed device's ring + posts Missed-call; queued offer purged on hangup (no ghost replay); reconnect drain rewritten to emit `call.missed` from a slim 6h **missed-marker** (the old payload-based emit was dead code). Answer/hangup clean up artifacts. | `messenger.gateway.ts`, `push.service.ts`, `fcmHeadless.ts`, `fcmBootstrap.ts` |
| N-03       | Wake `exp` check now allows ±90s clock skew; a truly-stale wake degrades to a Missed-call notification instead of silent drop. Test updated to the new contract.                                                                                                                                                      | `voipWakeVerify.ts`, `fcmHeadless.ts`                                          |
| N-07/08/09 | Notification-tap deep-link now resolves + passes `name`+`isGroup` (from store or persisted slice) and waits for nav readiness; `initials()` guards `undefined`; ChatScreen header prefers the store name. Fixes "Chat hit an error".                                                                                  | `fcmBootstrap.ts`, `ChatScreen.tsx`, `mutedLookup.ts`                          |
| N-10       | Sender-name titles on every path; opt-in MessagingStyle preview; inline **Reply** + **Mark-as-read** actions; `badgeCount`.                                                                                                                                                                                           | `callNotification.ts`, `backgroundMessageNotifier.ts`, `fcmBootstrap.ts`       |
| N-11/14    | Mute is now keyed strictly off a resolved `conversationId` (kills the DM-mute-silences-groups inversion); group FCM banner is deferred to the store notifier when the runtime is alive (no duplicate/mis-routed group banner). Tests updated.                                                                         | `mutedLookup.ts`, `fcmBootstrap.ts`, `fcmHeadless.ts`                          |
| N-12/13    | Killed/warm banners + the killed-app call notification resolve the contact's local name from the persisted vault.                                                                                                                                                                                                     | `mutedLookup.ts`, `fcmHeadless.ts`, `fcmBootstrap.ts`                          |
| N-16       | "Show message preview" toggle (default OFF — name-only, no plaintext in notifications).                                                                                                                                                                                                                               | `MessengerSettingsScreen.tsx`, `backgroundMessageNotifier.ts`                  |
| N-17       | Launcher `badgeCount` from total unread.                                                                                                                                                                                                                                                                              | `callNotification.ts`, `backgroundMessageNotifier.ts`                          |
| N-18/19    | `recordActivity()` now populates the in-app bell on every warm server-event wake; the Dashboard notification drawer renders those rows with a working "Mark all read" (was a hardcoded empty state).                                                                                                                  | `serverWakeNotifications.ts`, `DashboardScreen.tsx`, `activityStore.ts`        |
| N-21       | `incident-submitted`/`incident-status` added to the client wake meta table + tap routing (were dropped as "unknown kind").                                                                                                                                                                                            | `serverWakeNotifications.ts`, `fcmBootstrap.ts`                                |
| N-22       | Removed the three hardcoded always-lit fake bell dots.                                                                                                                                                                                                                                                                | `OpsDashboardScreen.tsx`, `AgentHomeScreen.tsx`, `JobMarketplaceScreen.tsx`    |
| N-24       | SOS KPI now counts only actionable alerts (`acknowledged_at IS NULL AND resolved_at IS NULL`) — cancelled SOS no longer inflate the badge forever; ops bell repointed to `/sos` so badge + click target share one source.                                                                                             | `ops.service.ts`, `Shell.tsx`                                                  |
| N-27       | Time-critical wake classes (dispatch/incident/sos) ride FCM high priority; hydration blob TTL raised 300→900s so a 5–10 min delivery no longer 404s to a blank banner.                                                                                                                                                | `push.service.ts`, `booking-push-bridge.service.ts`                            |
| N-29       | `onlyAlertOnce: true` on message + server-wake notifications — a re-post no longer replays sound/heads-up (kills the double-alert).                                                                                                                                                                                   | `callNotification.ts`, `serverWakeNotifications.ts`                            |
| N-30       | M-14 residual: `list === prevList` reference-skip in the write-through diff — inbound append is now O(changed) not O(all conversations).                                                                                                                                                                              | `productionRuntime.ts`                                                         |
| N-32       | Per-(recipient, sender) chat-wake debounce (6s) coalesces bursts. New test.                                                                                                                                                                                                                                           | `push.service.ts`, `push.service.spec.ts`                                      |
| N-33       | Persisted-vault parse memoized by raw string (one parse per wake, not 2–3).                                                                                                                                                                                                                                           | `mutedLookup.ts`                                                               |
| N-36       | `sendChatWake` now delivers to iOS DATA tokens via APNs content-available (was Android-only).                                                                                                                                                                                                                         | `push.service.ts`                                                              |

### Remaining (6 scoped follow-ups — lower-value / need native or larger refactor)

- **N-18 (remainder)** — mount `ActivityBell` + register `ActivityCenterScreen` in the **agent/ops** shells (the writer, server sync, and the client Dashboard drawer are done; the client bell is fully functional).
- **N-25** — a true `ops-notify` WebSocket for the ops bell (today it rides the existing 5s dashboard poll — "realtime feel", not a socket).
- **N-28** — messenger tab-bar unread badge (the Dashboard bell dot already signals cross-screen unread).
- **N-05** — Android 14 full-screen-intent runtime-grant check (needs a small native `canUseFullScreenIntent()` module).
- **N-35 (remainder)** — replace the SOS-page `window.prompt/confirm` with the in-app modal pattern.
- **N-04 / N-06 / N-15** — caller-side failed-wake feedback, redial-vs-budget, dead-param/contract cleanup.

### Notes / coupling honored

- N-03 skew tolerance shipped **together with** the N-02 cancel push + hangup purge (the fix-interplay the critic flagged: widening `exp` alone would enlarge the orphan late-ring window).
- N-10 message-content preview is **opt-in, default off** (respects the `backgroundMessageNotifier` privacy test's "no plaintext in a banner" guarantee; N-16 surfaces the toggle).
- N-11 residual: a group message from a contact you also DM can still key/deep-link to that 1:1 on the sealed-sender killed path (can't be distinguished without the headless-drain); the mute inversion and duplicate-banner are fixed.

---

_Full agent transcripts: workflow `wf_6ae4c107-02b` (7 auditors, 45 verifiers, 1 critic; 53 agents, ~3.5M tokens). All evidence line numbers verified against HEAD `12894de` on 2026-07-09. Remediation same day._
