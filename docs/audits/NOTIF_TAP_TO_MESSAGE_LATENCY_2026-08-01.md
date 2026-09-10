recv the 

uop

# Notification-tap → message latency (5–10 s) — causes & fixes

**Date:** 2026-08-01 · **Status:** **FIXES IMPLEMENTED 2026-08-01 (same day) — see sqa.md B-352/B-353.**
Shipped: E2 (`transportConnectFreshToken.test.ts`), E1+F1 (`notifLatencyBootInvariants.test.ts`,
plus the B-353 dead-`livePublishOwnBundle` fix found en route), C1 (guess-route
navigate-first — `notifTapNavContract.test.ts` updated), D1 (`authStore.initialize.test.ts`),
A1 (server constant — **deploy owed**), B1 `[NOTIFLAT]` probes. Corrections from
implementation: **E4 was wrong** (the AppState probe already drains immediately at
`productionRuntime.ts` — the 3 s timer is only the socket-rebuild verdict) and **E3 is
already handled** (foreground calls `forceReconnect`, which resets the backoff counter).
Device pass + A1 deploy still owed; the B/P1 headless-lean-runtime work remains open.
**Symptom (founder report):** send someone a message → recipient's notification appears →
they tap it → app opens, shows **"Connecting… / Reconnecting…"**, and the message takes
**5–10 seconds** to appear. **The same delay happens when the app is opened normally from
the launcher after a notification arrived** — the tap is just one entry point, not the
cause. WhatsApp/Signal render it instantly. Make it industry-grade.

> Line numbers below were verified on `main` @ d4cf7e1 (2026-08-01). They go stale fast in
> this repo — **re-grep the symbol before acting on any of them.**

---

## 0. TL;DR — the one-paragraph diagnosis

The app already has the _correct_ industry architecture on paper: the server sends a
**data-only, high-priority FCM wake with no message content** (a security rule we must
keep), and a **Signal-style headless drain** is supposed to fetch + decrypt + store the
message _at push time_ so that a tap only has to render what is already on disk. The 5–10 s
happens because (a) the headless drain frequently bails or times out, so nothing is
pre-fetched, and (b) the tap-time path is a **long serial chain** — a blocking `/auth/me`
network call, a deliberately-delayed FCM bootstrap, an up-to-6 s navigation hold, a runtime
boot with ~1 s of keygen plus an awaited network POST _before_ the socket even opens, a
WebSocket handshake that uses a **stale JWT and gets rejected** (that rejection IS the
"Connecting → Reconnecting" banner), and a chat screen that is gated on the _whole_ runtime
being ready instead of on the local database. WhatsApp's rule is the opposite: **render
from local storage immediately; the network catches up in the background.**

**Key discriminator:** the founder confirms the delay ALSO occurs on a plain launcher open
(no notification tap). A launcher open skips Phase C (tap routing) entirely — so the 5–10 s
is dominated by **Phase D (blocking boot) + Phase E (stale-JWT reconnect cycle) + Phase F
(ready-gate before render)**, with **Phase B (failed pre-fetch)** explaining why there was
nothing on disk to show instantly. Phase C's 6 s hold is real but additive, not the root.
For a _backgrounded_ (not killed) app, the same E-causes apply: the socket dropped while
backgrounded, the token may have expired meanwhile (E2), and resume pays the 2 s reopen
floor (E3) plus the 3 s probe timer (E4) before the drain even fires.

**Analogy:** the message is a parcel. Signal/WhatsApp have the courier deliver the parcel
to your doorstep the moment the doorbell (push) rings — when you open the door, it's
already there. Our app rings the doorbell, and only when you open the door does it start
the van, drive to the depot, argue with the security guard about an expired badge
(JWT reject → "Reconnecting…"), and _then_ drive the parcel over.

---

## 1. What "industry grade" (WhatsApp / Signal) actually does

1. **Push is a trigger, never the content.** High-priority data-only FCM wakes the app;
   the app fetches over its own channel. A push notification should never be the source
   of truth for message content. _(We already do this — `push.service.ts:656` sends
   data-only with `priority:'high'`.)_
2. **Fetch–decrypt–store happens at PUSH time, in the background,** before the user ever
   taps. Signal's `FcmReceiveService` wakes a retriever that pulls over the websocket and
   writes to the local DB, then the notification is drawn _with the decrypted preview_.
   By tap time the message is local. _(We have this lane — `fcmHeadless.ts` /
   `headlessDrain.ts` — but it is slow and fragile; see causes B1–B4.)_
3. **The UI renders from the local DB, unconditionally.** The chat opens instantly from
   SQLite/SQLCipher; connection state is a cosmetic banner, never a gate. Sync/dedup by
   message ID reconciles later.
4. **Cold boot never blocks on the network.** Cached credentials render the UI; token
   refresh and profile fetch happen in the background.
5. **Reconnect is aggressive on foreground.** On app-resume the socket reconnects
   immediately with a valid token (refreshed proactively if near expiry), small capped
   backoff, no stacked sleeps.

Every cause below is a place where we deviate from one of those five rules.

---

## 2. The verified end-to-end timeline in THIS app (killed-app worst case)

```
sender hits send
  └─ [A1] server may DEBOUNCE the push up to 6 s (burst case)          push.service.ts:138
FCM arrives on killed device
  └─ [B] headless drain races an 8 s budget; on ANY bail → generic     fcmHeadless.ts:37,168
     banner, NOTHING pre-fetched
user taps the notification
  └─ [D1] cold start: fonts gate → /auth/me NETWORK call blocks        authStore.ts:238
     RootNavigator → permsShown read → MainNavigator mounts →
     ownerKey read → runAfterInteractions → startFcmBootstrap →
     getInitialNotification finally replayed                           MainNavigator.tsx:398-507
  └─ [C1] tap routing may HOLD navigation up to 6 s (guessed conv)     fcmBootstrap.ts:931
  └─ [C2] nav-ready poll: 100 ms ticks, 20 s ceiling                   fcmBootstrap.ts:1231
meanwhile, in parallel, the runtime boots
  └─ [E1] serial AsyncStorage reads → ~1 s libsignal keygen →          productionRuntime.ts:523-541
     [E2] AWAITED network POST publishOwnBundle →                      productionRuntime.ts:672
     [E3] WS connect with the ON-DISK (often stale) JWT →              client.ts:786
          gateway REJECTS → state 'reconnecting'  ← THE BANNER         client.ts:712
          → refresh roundtrip → sleep 400·attempt → reopen             client.ts:715-727
     [F1] inbound frames BUFFERED until SQLCipher hydration done       productionRuntime.ts:1329,2159
     [F2] drain → decrypt → store commit → ChatScreen unblocks only    productionRuntime.ts:2368
          at setReady(true) ("Initializing secure session…" until)     chatScreenLogic.ts:80
message finally renders                                    ≈ 5–10 s after the tap
```

---

## 3. Cause catalogue — every plausible contributor, with its fix

Ranked within each phase. **Impact** = realistic seconds it can add to the founder's repro.

### Phase A — before the push even leaves the server

| #  | Cause                                                                                                                                                                                                                                                                          | Evidence                                                                      | Impact   | Fix                                                                                                                                                                                                                                          |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 | **6 s chat-wake debounce.** The first message pushes immediately, but any message inside the 6 s window is _not_ pushed — it waits for a trailing wake at window end. Message #2 of a burst can have its notification (and therefore the whole flow) start ~5 s late. | `push.service.ts:138` (`CHAT_DEBOUNCE_SEC=6`), `:684-693`, `:846-862` | 0–6 s   | Shrink the window (WhatsApp coalesces at ~1–2 s), or debounce only the*visible banner* and always send the silent wake immediately so the device can pre-fetch. The wake is data-only and collapse-keyed, so per-message wakes are cheap. |
| A2 | FCM delivery itself (Doze, OEM battery killers, throttling of high-priority quota).                                                                                                                                                                                            | platform; see also memory: push-token GC reaping                              | variable | Already high-priority + data-only (correct). Keep an eye on`delivery data` in Firebase console; nothing to change in code. Not the primary suspect — the founder's notification _does_ arrive.                                          |

### Phase B — at push receipt (killed app): the pre-fetch that should make taps instant

| #  | Cause                                                                                                                                                                                                                                                                                               | Evidence                                                                                              | Impact             | Fix                                                                                                                                                                                                                                                                                                     |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 | **The headless drain frequently bails → nothing is pre-fetched.** Guards: restore mode, missing local DB key, missing persisted runtime config; plus a 3 s Zustand-hydration wait inside an 8 s total budget. Any bail → generic banner and a tap that must do _everything_ from scratch. | `headlessDrain.ts:95-115` (guards), `:71-85` (3 s wait); `fcmHeadless.ts:37,168-171` (8 s race) | the whole 5–10 s  | This is the highest-leverage fix: make the killed-lane drain**reliably succeed**. Instrument bail reasons (`console.warn` survives release), then attack each guard. When the notification shows _real message text_, tap-time is already instant — that's the observable success criterion. |
| B2 | **The headless drain boots the FULL production runtime** (`buildProductionRuntime`) inside the headless VM — keygen, bundle publish, full SQLCipher hydrate — just to pull a few envelopes. Heavy → often loses the 8 s race on mid-tier devices.                                        | `headlessDrain.ts:165` → `productionRuntime.ts:512`                                              | 0–8 s             | Build a**lean headless runtime**: skip signed-pre-key rotation checks, skip `publishOwnBundle`, skip full conversation hydration — open DB, pull, decrypt, write, notify. Signal's background retriever is exactly this narrow.                                                                |
| B3 | Duplicate/last-writer-wins background handlers:`index.js:47` registers the slim killed-VM handler, but `fcmBootstrap.ts:1650` re-registers at module top level once the app has run warm — behaviour differs by VM temperature, making the lane hard to reason about and test.                 | `index.js:44-51`, `fcmBootstrap.ts:1650`                                                          | indirect           | Unify into one handler with an explicit cold/warm branch, so the killed lane is a first-class tested path rather than a displaced default.                                                                                                                                                              |
| B4 | Headless work runs*after* Android already spent time instantiating the RN VM (known RNFirebase issue: bundle spin-up before the handler fires, worst on low-end devices).                                                                                                                         | RNFirebase discussion#4470 (sources §6)                                                              | 1–20 s on low-end | Keep the headless bundle path lean (inline requires already help); measure VM-start→handler-start with a`[LAGDIAG]` warn.                                                                                                                                                                            |

### Phase C — tap → navigation

| #  | Cause                                                                                                                                                                                                                                                                         | Evidence                                                                              | Impact  | Fix                                                                                                                                                                                                                                           |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | **Navigation deliberately HELD up to 6 s** when the wake's conversation was a sealed-sender guess or absent: `Promise.race([pullSettled, 6000ms])` _blocks routing_.                                                                                                | `fcmBootstrap.ts:931` (`GUESS_ROUTE_PULL_WAIT_MS=6000`), `:936`, `:1244-1250` | 0–6 s  | Never hold navigation. Navigate**immediately** to MessengerHome (or the guessed chat with a skeleton) and _re-route/refine_ when the pull settles. WhatsApp opens the conversation shell instantly and lets content stream in.        |
| C2 | Tap routing can't even*start* until `startFcmBootstrap` runs — which sits behind `/auth/me` (network) → `permsShown` read → MainNavigator mount → ownerKey read → `runAfterInteractions`. The `getInitialNotification()` replay is at the END of that chain. | `MainNavigator.tsx:398-507`, `fcmBootstrap.ts:1484-1492`                          | 1–3 s+ | Capture`getInitialNotification` / initial intent **early (index.js / App mount)** into a pending-route slot; consume it the moment the navigator is ready. Registration of the _capture_ must not wait for the messenger bootstrap. |
| C3 | 20 s nav-ready poll at 100 ms granularity (adds up to ~100 ms slop; mostly a smell, not seconds).                                                                                                                                                                             | `fcmBootstrap.ts:1231-1238`                                                         | ~0.1 s  | Replace polling with a nav-ready callback/promise.                                                                                                                                                                                            |

### Phase D — app cold boot (everything before messenger code even runs)

| #  | Cause                                                                                                                                                                                                                    | Evidence                                                             | Impact     | Fix                                                                                                                                                                                                                    |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | **Blocking `/auth/me` network roundtrip on the critical path.** `Main` (and therefore ALL messenger boot + tap routing) mounts only after the roundtrip completes. On a weak connection this alone is seconds. | `authStore.ts:233-241`; gate at `src/navigation/index.tsx:56-74` | 0.5–5 s   | **Optimistic boot:** if a token + cached user exist on disk, mount `Main` immediately and run `/auth/me` in the background (sign out on definitive 401). This is the single biggest violation of rule §1.4. |
| D2 | Fonts gate renders`null` until 6 Manrope files load; i18n init; misc entry work.                                                                                                                                       | `App.tsx:50-62`                                                    | 0.1–0.5 s | Preload via native asset linking / accept fallback font on first frame. Standard RN TTI work (Hermes + inlineRequires — verify enabled).                                                                              |
| D3 | `startFcmBootstrap` deferred behind `InteractionManager.runAfterInteractions`.                                                                                                                                       | `MainNavigator.tsx:479-507`                                        | 0.1–1 s   | Fine for FCM*token* work, wrong for tap routing — decouple (see C2).                                                                                                                                                |

### Phase E — connect/auth: the literal "Connecting… / Reconnecting…" the founder sees

| #  | Cause                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                                           | Impact    | Fix                                                                                                                                                                                                                                                                                                                                                           |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 | **Serial pre-connect awaits:** 4 AsyncStorage reads → `installIdentity` (~1 s pure-JS libsignal keygen path) → signed-pre-key rotation check → **awaited network POST `publishOwnBundle`** → only THEN `transport.connect()`.                                                                                                                                                      | `productionRuntime.ts:523-541`, `:541`, `:558`, `:672`, `:1548`                          | 1–3 s    | Parallelise the AsyncStorage reads; open the socket as early as its token allows; make`publishOwnBundle` fire-and-forget (it's already best-effort on failure — `:695-701` — so it shouldn't be awaited on success either); skip keygen when an identity already exists on disk.                                                                        |
| E2 | **Stale-JWT handshake → reject → "Reconnecting…" → refresh → reopen.** The WS auths with whatever token is on disk (no expiry check). After a cold start the token is often expired, so the FIRST connect is _designed_ to fail: `setState('reconnecting')`, refresh roundtrip, `400·attempt` ms sleep, reopen. **This is exactly the banner sequence in the founder's report.** | `MainNavigator.tsx:455` (getToken = raw AsyncStorage), `client.ts:786`, `:695-727`, `:712` | 1–4 s    | **Proactively check `exp` locally** (decode the JWT — no network needed) and refresh _before_ the handshake when expired/near-expiry. Alternatively let the gateway accept the connection and demand a token upgrade in-band. Kills both the wasted roundtrip and the scary banner. Related known class: memory `messenger-ws-jwt-secret-drift`. |
| E3 | Reconnect ladder can stack sleeps: exponential base to 30 s max,`IMMEDIATE_REOPEN_FLOOR_MS=2000` even on the fast path, plus the `400·attempt` refresh sleep.                                                                                                                                                                                                                                       | `client.ts:823`, `:1112-1154`, `:66`                                                         | 0.5–30 s | On**app-foreground / notification-tap**, reset attempts and reconnect immediately (0 floor) — resume is a strong signal the network changed. Keep backoff for true background churn.                                                                                                                                                                   |
| E4 | AppState-active "probe" branch delays its extra drain behind a hard 3 s`setTimeout`.                                                                                                                                                                                                                                                                                                                   | `productionRuntime.ts:1744-1754`                                                                 | 0–3 s    | Make the probe drain immediate on foreground; 3 s is a background-era constant.                                                                                                                                                                                                                                                                               |

### Phase F — fetch → decrypt → render

| #  | Cause                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                           | Impact   | Fix                                                                                                                                                                                                                                |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 | **ChatScreen is gated on the WHOLE runtime being ready** ("Initializing secure session…" until `setReady(true)`), which fires only after connect + full SQLCipher hydrate block. Even a message **already on disk** (successful headless drain!) waits behind network + hydration. | `productionRuntime.ts:2368`, `useMessenger.ts:33`, `chatScreenLogic.ts:80`; hydrate block `productionRuntime.ts:1855-2159` | 1–5 s   | **Render from disk first** (rule §1.3): let ChatScreen read the target conversation from SQLCipher as soon as the DB key is available, independent of transport readiness. This also makes B1's pre-fetch actually pay off. |
| F2 | Inbound WS frames buffered until`depsReady` — envelopes delivered by the server's connect-flush sit in a queue until the _entire_ hydrate block finishes.                                                                                                                                    | `productionRuntime.ts:1329-1332`, released `:2159`                                                                             | 0.5–2 s | Prioritise: wire the receive path before the long-tail hydration (group key unwrap, outbox scan), or hydrate the tapped conversation first.                                                                                        |
| F3 | Bootstrap drain can pull up to 1000 envelopes in 12 ms cooperative slices before the tapped message's turn.                                                                                                                                                                                       | `productionRuntime.ts:9378-9400`, `:9333`, `:9438`                                                                           | 0–2 s   | Drain newest-first / target-conversation-first when a tap target is known.                                                                                                                                                         |
| F4 | Store→UI path itself is clean: in-memory Zustand update is synchronous; the 500 ms persist debounce and 200 ms ack/read-receipt debounces do NOT gate rendering.                                                                                                                                 | `messengerStore.ts:72`, `ackQueue.ts:29`                                                                                       | ~0       | No action — do not chase these.                                                                                                                                                                                                   |

### Non-causes (checked, ruled out — do not re-propose without new evidence)

- **No 30 s full-Merkle re-download loop exists in the client today** (the old audit
  finding is stale): the only messenger `setInterval`s are the 4 s heartbeat, 60 s outbox,
  and expiry sweeper. Merkle work is debounce-driven (`messageMirror.ts:62,69`).
- Presence 3 s clear-debounce affects dots only, not message display (`productionRuntime.ts:1203`).
- GPU / render-thread cost: already measured dead (CLAUDE.md B-279 section).

---

## 4. Ranked fix plan (what to do, in order)

**P0 — kills the visible symptom (target: tap → message < 1.5 s warm-cache, < 3 s cold):**

1. **E2 — proactive local JWT-expiry check before the WS handshake.** Removes the
   designed-to-fail first connect that _is_ the "Connecting → Reconnecting" banner. Small,
   isolated, no security-model change (uses the existing single-flight refresh).
2. **D1 — optimistic boot from cached session;** `/auth/me` moves off the critical path.
3. **C1 — never hold navigation** on the 6 s guess wait; navigate now, refine later.
4. **F1 — render the chat from SQLCipher immediately,** independent of transport `ready`.

**P1 — makes taps _instant_ the WhatsApp way (content already local at tap time):** 5. **B1/B2 — make the killed-lane headless drain reliably succeed** (instrument bail
reasons; lean runtime for the headless VM). Success is observable: the notification
shows real message text. 6. **E1 — de-serialise runtime boot** (parallel reads, fire-and-forget `publishOwnBundle`,
connect earlier). 7. **A1 — shrink/split the 6 s server push debounce** (silent wake immediately, banner
debounced). 8. **E3/E4 — foreground = reconnect NOW** (reset attempts, drop the 2 s floor and the 3 s
probe timer on resume/tap).

**P2 — polish:** 9. C2 early initial-notification capture; C3 nav-ready callback; F2/F3 prioritised
hydration/drain; D2 font/TTI work; B3 handler unification.

**Guardrails (security constraints — unchanged):**

- **Never put plaintext message content in the FCM payload** (`push.service.ts:646-650`
  rule stands; Signal solves latency with fetch-at-push, not content-in-push).
- No "skip in dev" branches on `verifySenderCert` / sealed-sender AAD / the WS auth gate —
  E2 _pre-refreshes_ the token; it must not weaken the gateway's rejection of bad tokens.
- Message-pipeline changes (B, E, F) trigger `docs/runbooks/MESSAGE_LOOP.md` + the §5
  caller-completeness sweep; no test imports `productionRuntime.ts`, so green suites are
  not evidence there.

---

## 5. How to measure (before touching anything)

1. `console.warn` survives release (`babel-plugin-transform-remove-console` keeps `warn`)
   — tag probes `[NOTIFLAT]`: (a) FCM receipt in the bg handler, (b) headless-drain outcome
   - bail reason, (c) tap timestamp, (d) `navigate('Chat')` dispatched, (e) WS
     `connecting/reconnecting/connected` transitions with cause, (f) first message-store
     commit for the target conversation, (g) ChatScreen first content frame.
2. Correlate with the relay's own logs (release builds strip `console.log`; the relay log
   was decisive in B-272/273).
3. Repro matrix: killed vs backgrounded app × fresh vs stale token (force by editing token
   `exp`) × single message vs burst (exposes A1) × Wi-Fi vs LTE. Interleave OLD/NEW runs
   (thermal drift lies — CLAUDE.md measurement trap).
4. Baseline the timeline BEFORE any fix so each P0 item can show its own delta.

---

## 6. Sources (web research)

- [Firebase: About FCM messages — data vs notification, priority, Doze batching](https://firebase.google.com/docs/cloud-messaging/concept-options)
- [Firebase: Android message priority — high priority for IM apps](https://firebase.google.com/docs/cloud-messaging/android-message-priority)
- [Firebase blog: Handle FCM messages on Android (post-then-fetch pattern)](https://firebase.blog/posts/2018/09/handle-fcm-messages-on-android/)
- [Firebase: E2E-encrypted push payloads (data messages required)](https://firebase.google.com/docs/cloud-messaging/encryption)
- [Signal-Android #11095 — background message retrieval / websocket wake mechanics](https://github.com/signalapp/Signal-Android/issues/11095)
- [Signal wiki — notification troubleshooting, background websocket mode](https://signal.miraheze.org/wiki/How_to_solve_Signal_notification_issues_on_Android)
- [RNFirebase discussion #4470 — headless task fires long after VM spin-up on low-end devices](https://github.com/invertase/react-native-firebase/discussions/4470)
- [RNFirebase discussion #6995 — setBackgroundMessageHandler side effects in killed state](https://github.com/invertase/react-native-firebase/discussions/6995)
- [socket.io discussion #4335 — fast mobile reconnect after resume](https://github.com/socketio/socket.io/discussions/4335)
- [socket.io-client #326 — exponential backoff not resetting](https://github.com/socketio/socket.io-client/issues/326)
- [ConnectyCube: push notifications in chat apps — push as trigger, DB as source of truth](https://connectycube.com/2025/12/18/push-notifications-in-chat-apps-best-practices-for-android-ios/)
- [GetStream: chat application architecture — durable store, dedup-on-reconnect](https://getstream.io/blog/chat-application-architecture/)
- [Callstack: optimize Android startup with Hermes + inlineRequires](https://www.callstack.com/blog/optimize-android-app-startup-time-with-hermes)
