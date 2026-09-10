# Messenger notification latency & smoothness — root causes and fix plan (2026-08-29)

**Status:** root causes below; **fixes S-1/S-2/S-3/S-5/S-6/S-7 IMPLEMENTED 2026-08-29**
(same session, two parallel workers + adversarial critic loop — see §8 for the
implementation record and the decisions it forced). S-0 (device measurement)
and S-4 (server debounce, number-gated) remain owed. Logged as **B-692** in `sqa.md`.
**Complaint (founder):** "the notification is not live — when someone messages it takes
time to appear; the notification animation feels laggy; when we message and someone
messages, the notification should update immediately like WhatsApp, including the audio."

Built from a two-agent decomposition: a full pipeline trace (server FCM fan-out →
client display → animation) plus a mine of the entire QA history (B-352, B-323..331,
B-336, B-490..503, N-01..N-36, GAP-1..4, M16). Every claim below carries file:line.
Line numbers go stale fast in this repo — **re-grep the symbol before trusting one.**

---

## 0. Plain-English summary

Think of the notification pipeline as a doorbell. On WhatsApp/Signal, the bell rings
the instant someone presses it, and only _afterwards_ does the butler check who it is
and update the name on the screen. In Bravo, on a phone where the app is killed, the
bell is wired **behind** the butler: nothing rings until the app has fully woken up,
opened the encrypted database, restored its crypto identity, connected to the server,
downloaded and decrypted the message — up to **8 seconds** of silence before anything
appears. That is the single biggest reason it doesn't feel "live."

Four more things stack on top:

1. **The server deliberately holds back rapid messages.** Message #2+ from the same
   sender inside 2 seconds gets its push delayed up to 2 s (a cost-saving debounce).
2. **A 10-second silence rule.** Once one banner has alerted for a conversation, every
   further message in the next 10 seconds updates silently — no sound, no heads-up.
   In a live back-and-forth, only ~1 message in 10 s actually alerts. This _reads_ as
   "the notification isn't updating."
3. **When the app is open, there is no in-app notification at all.** No banner, no
   receive sound, no haptic — the only feedback is the chat-list row changing. The
   WhatsApp comparison ("audio these things") is mostly _this gap_, not a slow path.
4. **The "laggy animation" is mostly an absence.** There is no message-banner
   animation to be smooth or laggy. What the eye catches instead: (a) system banners
   appearing late (the latency above), (b) delayed messages **skipping** the bubble
   entrance animation and popping in abruptly, and (c) per-message JS-thread work
   (full chat-list re-sort + a whole-store scan) stealing frames from whatever _is_
   animating. The chat-open slide stutter is separate and already fixed as B-691
   (device pass owed).

---

## 1. The pipeline, stage by stage

An incoming message reaches the user through one of three lanes:

| Lane                | Trigger                                                                 | Display path                                                                        |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Foreground**      | WS frame (immediate) or `onMessage` FCM (`fcmBootstrap.ts:462,630-649`) | store update → chat list row. **No banner, no sound.**                              |
| **Warm background** | `setBackgroundMessageHandler` (`fcmBootstrap.ts:2582,2755-2864`)        | banner **first**, then pull — correct order                                         |
| **Killed**          | headless task → `handleHeadlessFcm` (`fcmHeadless.ts:39,268-363`)       | **full runtime boot + drain first**, banner only after (or generic fallback at 8 s) |

Server side is healthy in shape: pushes are data-only, `priority:'high'`, sent
fire-and-forget so the sender is never blocked (`messenger.gateway.ts:1408-1412`,
`envelope.controller.ts:128-132`, `push.service.ts:770-792`), and live WS delivery to
an online recipient is immediate (`envelope.service.ts:331`). The problems are in the
timers and in what the client does before drawing.

---

## 2. Root causes, ranked

### RC-1 (P0) — killed-app lane: drain-before-draw, 8-second budget

`fcmHeadless.ts:276-298` races `headlessDrainAndNotify()` against
`HEADLESS_DRAIN_BUDGET_MS = 8000` (`fcmHeadless.ts:37`). Before any banner exists,
`headlessDrain.ts:179-197` serially runs: AsyncStorage read + restore-mode check +
keychain `hasDbKey()` + up to **3000 ms** waiting on store hydration
(`headlessDrain.ts:78`) → notifier start with a full per-conversation watermark
baseline (`backgroundMessageNotifier.ts:351-353`) → full runtime boot (SQLCipher
open, libsignal identity install ~1 s, an **awaited** `publishOwnBundle` network
POST, WS handshake) → `pullEnvelopes()` network + per-envelope decrypt + persist.
Only on failure/timeout does the generic fallback banner post
(`fcmHeadless.ts:299-359`).

This is the Signal model inverted: Signal posts a placeholder immediately and
upgrades it with the decrypted text. Here the user sees **nothing for 0–8 s**.
Known-open item — the NOTIF_TAP audit's own §4 P1-5 calls the lean headless path
"the highest-leverage fix" (`docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md`),
and spec item 5.4 (lean headless runtime) is still open. The `[NOTIFLAT]` bail
probes (`headlessDrain.ts:102-131`) have shipped since 2026-08-01 and have **never
been read off a phone**.

### RC-2 (P1) — the 10-second alert throttle silences a live conversation

`ALERT_BURST_MS = 10_000` (`callNotification.ts:133`) feeds `shouldAlert()`
(`:135-155`) → `onlyAlertOnce: !alertNow` (`:349`), keyed **per conversation**. Any
banner within 10 s of the previous alert for that conversation posts as a silent
shade update — no heads-up, no sound, no vibration. WhatsApp's equivalent window is
well under a second. History: this is the N-29 fix for the double-sound-per-message
defect (B-56), later corrected by B-235 (evict-expired-only, never `clear()` the
map). The _dedupe intent_ (one message must never alert twice) is right; the
_granularity_ (one conversation may alert at most every 10 s) is what the founder is
feeling.

### RC-3 (P1) — foreground: no in-app banner, no receive sound — a feature gap

The foreground `msg-wake` branch only pulls (`fcmBootstrap.ts:630-649`); the store
notifier explicitly bails when foregrounded (`backgroundMessageNotifier.ts:245`,
`isBackgrounded()` at `:101-105`). A sweep of the tree finds **no in-app message
banner component** (only Connection/Premium/CallQuality/RestoreActivity/
NotificationPermission banners and the 1:1 call banner). Sound: `bravoTones.ts`
implements call ringback/ringtone only (`:202-233`); the repo's only audio assets
are `ringback.wav` and `ringtone.wav`. Haptics fire on **send** only
(`ChatScreen.tsx:900,936`) — nothing on receive. So with the app open, a message in
another conversation produces zero audible/visible feedback beyond the list row.

### RC-4 (P2) — server chat-wake debounce: a 2-second floor for bursts

`CHAT_DEBOUNCE_SEC = 2` (`push.service.ts:164`, applied `:704-720`): the second
message from the same sender inside 2 s returns `{sent:0}` and rides a trailing
`setTimeout(..., 2000)` (`:883-888`). Already cut 6 s → 2 s by B-352 A1 (deployed);
the code's own comment names it "the LATENCY FLOOR for every message after the first
in a burst." `collapseKey: msg-wake:<conv>` (`:788`) additionally coalesces Doze
bursts to a single wake — correct for wake semantics, but it means a burst yields
one late banner, not N live ones.

### RC-5 (P2) — banner display is gated on the serialized receive commit

The banner posts inside `onAfterCommit` (`backgroundMessageNotifier.ts:324-337` →
`receiveTransaction.ts:267-281`), and every inbound envelope is serialized through
the single global `txnChain` (`receiveTransaction.ts:50`) — one libsignal decrypt +
SQLCipher write + COMMIT at a time. This is **correct** (M16: no banner for an
uncommitted message) and must not be un-gated; but it means burst-N notification
latency scales linearly with N, and a wedged frame can block the chain up to
`CHAIN_FRAME_FORCE_MS = 120_000` (`:73-74`).

### RC-6 (P2) — per-message JS-thread jank robs whatever is animating

Two synchronous costs run on **every** store commit:

- `MessengerHomeScreen.tsx:516-524` re-runs map + filter + **full sort** of the
  conversation list (the `conversations` map is replaced by immer on every commit —
  the file's own B-655 note at `:575-583`). The comparator calls `Date.parse()` on
  ISO strings twice per comparison (`conversationListOrder.ts:14-24`) — ≈1,300
  parses per message at 100 conversations. No cached sort key.
- `backgroundMessageNotifier.ts:195-338` is a synchronous Zustand subscriber that
  diffs `Object.entries(state.messages)` (`:209`), builds prior-id Sets
  (`:224-226`), and reduces the **entire** conversations map for the badge
  (`:279-281`) — foreground included: the `:245` bail happens _after_ the diff work.

Neither delays the store update itself (Zustand commit is synchronous; the F4
store→UI path is an exonerated dead end), but both burn JS-thread frames exactly
when a banner/bubble animation wants them.

### RC-7 (P3) — delayed messages skip the entrance animation

`ChatScreen.tsx:3117-3119`: a bubble animates in only if
`Date.now() - created_at < 2000`. Any message delayed by RC-1/RC-4/RC-5 beyond 2 s
**pops in with no animation** — which is precisely the "abrupt/janky" feel. (The
animation itself is healthy: `Animated.spring` on opacity/scale/translateY, all
`useNativeDriver: true`, `ChatScreen.tsx:3120-3137`.)

### RC-8 (P3) — one extra native round-trip before every banner

`callNotification.ts:330-333` awaits `syncMsgSummary()` (itself a notifee call)
**before** the actual `displayNotification` at `:334`. Same class as the Phase-4
lesson "never pay a bridge round-trip before ringing."

---

## 3. Already fixed — do not re-fix

| What                                                                                                                                                                                  | Fixed as                                 | Note                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Stale-JWT WS handshake designed-to-fail; awaited bundle publish ahead of hydration; nav held 6 s on tap; `/auth/me` blocking Main; server 6 s debounce → 2 s; invisible headless bail | **B-352** (six causes, 2026-08-01)       | code fixed + A1 deployed; **device pass still owed** — no measured delta exists   |
| Notifications stamped draw-time not send-time                                                                                                                                         | B-323                                    |                                                                                   |
| Killed-app group banner misrouted to sender's 1:1                                                                                                                                     | B-324                                    | client-side drain fix; convId on the wire is arch-gated — do not revive           |
| Chat from notification renders only after foreground drain                                                                                                                            | B-325                                    | ingest starts at wake time                                                        |
| Ring dedup ate deliberate re-rings                                                                                                                                                    | B-336                                    | `ringId` per fan-out, device-verified                                             |
| Notification ⇔ committed message, both directions                                                                                                                                     | **M16** (`MESSAGE_LOOP.md:220`, W28+W29) | pinned by `backgroundMessageNotifier.test.ts`, mutation-proved                    |
| Double sound per message; whole-map `clear()` re-alerting                                                                                                                             | N-29 + B-235                             | the current `onlyAlertOnce: !alertNow` + evict-expired-only shape is load-bearing |
| Chat-open slide stutter (mount effects inside the 220 ms window)                                                                                                                      | **B-691** (2026-08-29)                   | `useOpenTransitionGate`; device A/B owed                                          |

---

## 4. How to solve — proposals, ranked by leverage

> Ordering rule this repo has paid for repeatedly (B-279, B-412, spec §21.6): on this
> surface, **measure before rebuilding**. S-0 is not optional garnish — items S-1/S-4
> are explicitly number-gated by their own docs.

### S-0 — Read the probes that already exist (half a day, zero risk)

Release APK on a real phone (never BlueStacks — FCM tokens are reaped ~90 s there;
swipe-kill, never Force-stop — a force-stopped app receives no FCM by Android
design). Capture:

- `[NOTIFLAT]` (5 bail sites, `headlessDrain.ts:102-131`) — killed-lane bail rate
  and stage timings. Success criterion per the audit: "the notification shows real
  message text," and how long that takes.
- `[NOTIFHEALTH]` boot probe; the owed **B-352 device pass** (killed-app tap → chat
  < ~2 s; no "Reconnecting…" on stale-token cold boot).
- Targets to beat: push received → _something visible_ **< 1.5 s**; real decrypted
  text **< 4 s** killed / **< 2 s** warm; foreground receive → row update + sound
  **< 300 ms**.

### S-1 (P0) — killed lane: placeholder-first, upgrade-later (the Signal model)

Post a **content-free** placeholder banner ("New message" / app name, existing
channel) immediately on FCM receipt in `handleHeadlessFcm`, _then_ run the drain
and **upgrade** the same notification id with the decrypted sender/text when the
commit lands; cancel/replace on success, keep on failure.

Constraints that make this safe:

- **M16 is about message-content banners.** A generic placeholder tied to no
  specific message doesn't violate "never notify an uncommitted message" — the
  current 8-s-timeout fallback banner is already exactly this shape
  (`fcmHeadless.ts:299-359`). The _per-message_ body banner stays `onAfterCommit`.
- **No plaintext or `senderName` may ride the push** (N-15, security constraint) —
  the placeholder must be generic by construction.
- Alert once: the placeholder alerts (sound/vibration); the upgrade posts with
  `onlyAlertOnce`-equivalent silence so the user doesn't hear two sounds (the N-29
  class). Use the same notification id for placeholder and upgrade.
- The deeper fix behind it — the **lean headless runtime** (spec 5.4: skip the
  awaited `publishOwnBundle`, trim the 3 s hydration wait, defer the watermark
  baseline) — is real but is a spec task; ship placeholder-first independently.

### S-2 (P1) — per-message alert dedupe instead of the per-conversation 10 s gag

Change `shouldAlert`'s key from conversation id to **message id** (or
`convId:msgId`), keeping the B-235 evict-expired-only map and the
`onlyAlertOnce: !alertNow` wiring exactly as they are. Result: every _new_ message
alerts (WhatsApp behaviour); a re-post of the _same_ message (the N-29 double-post)
still can't double-sound. Keep a short per-conversation floor (~1–2 s) only if
device testing shows notifee rate-limiting misbehaving under bursts. **Do not**
revert to unconditional `onlyAlertOnce: true` — documented dead end (over-suppresses
while an old banner sits in the shade).

### S-3 (P1) — build the foreground layer: in-app banner + receive sound + haptic

This is a feature, not a bug fix — it's the visible half of "like WhatsApp":

- **In-app banner** for messages arriving in a _different_ conversation than the one
  on screen: top-slide overlay, transform/opacity only, `useNativeDriver: true` (or
  reanimated), obsidian/cobalt design system, auto-dismiss ~3.5 s, tap navigates via
  `navigateOnce` (NAV loop N-invariants apply — this is a tappable navigating
  surface). Suppress for the active conversation — note `setActiveConversation(id,
{skipUnreadClear:true})` at ChatScreen mount is the suppression key and its
  **immediate timing must stay** (B-691 critic note).
- **Receive tone + light haptic**, and optionally a WhatsApp-style subtle send tone:
  extend `bravoTones.ts` with a short message tone asset; respect mute
  (`mutedLookup.ts`) and an in-app-sounds setting.
- Wiring point: a foreground branch in the store notifier — i.e. _remove_ the
  blanket `:245` foreground bail and route foreground events to the in-app layer
  instead of notifee. `backgroundMessageNotifier.ts` is MESSAGE_LOOP §0 trigger
  territory: §5 caller-completeness sweep + §7 gates + M16/M2 pins apply.

### S-4 (P2) — server debounce: shrink or scope the 2 s floor

Options, in order of safety: (a) drop `CHAT_DEBOUNCE_SEC` 2 → 1 (the trailing timer
already guarantees delivery, this halves the floor); (b) skip the debounce entirely
when the recipient has **no** live WS socket (the killed phone is exactly who needs
the wake _now_; Doze bursts still coalesce via `collapseKey`). Deploy-order applies
(server change, manual Contabo deploy). Number-gate it: only worth touching if S-0
shows the floor actually surfacing in the founder's repro.

### S-5 (P2) — take the per-message jank off the JS thread

- Cache the sort key: precompute a numeric timestamp on the conversation row (or
  memoize `Date.parse` in a Map) so `compareConversationsForList` stops parsing ISO
  strings ~1,300× per message (`conversationListOrder.ts:14-24`).
- Hoist the notifier's foreground bail **above** the diff work
  (`backgroundMessageNotifier.ts:209-245`) — but the W29 seen-set must still be
  maintained while foregrounded, or messages seen in-app will banner falsely on the
  next backgrounding (the B-132 class in reverse). Maintain the watermark cheaply;
  skip only the banner-side Set/filter/badge-reduce work. Mutation-prove against
  `backgroundMessageNotifier.test.ts`.
- Keep identity disciplines (`sameIdSet`, N-30 referential stability) — NAV loop.

### S-6 (P3) — let delayed messages still animate

Key the bubble entrance on _insertion into the visible list_ (e.g. an
insertion-time stamp or first-render flag) instead of `Date.now() - created_at <
2000` (`ChatScreen.tsx:3117-3119`), so a message delayed by the pipeline still
slides in instead of popping. Cap it (don't animate a 50-row drain — only the tail
few) to avoid animating history backfill.

### S-7 (P3) — un-await the summary round-trip

Fire `syncMsgSummary()` after (or in parallel with) `displayNotification`
(`callNotification.ts:330-334`). One bridge round-trip saved on every banner's
first paint.

---

## 5. Dead ends — do not re-propose (with sources)

1. "Make the AppState-active probe drain immediately" — it already does
   (NOTIF_TAP audit E4).
2. "Reset reconnect backoff on foreground" — already done via `forceReconnect` (E3).
3. "A 30 s Merkle loop steals the thread" — no such loop; real cadence is 5 s
   debounced post-flush (audit + DEAD_PHONE plan §374).
4. The store→UI path (F4) — Zustand is synchronous; persist/ack debounces don't
   gate rendering.
5. GPU/render-thread cost — measured dead twice (B-279).
6. Unconditional `onlyAlertOnce: true` — over-suppresses (tried, corrected);
   wholesale `shouldAlert` map `clear()` — B-235.
7. Client-side group resolution from sender id / putting `conversationId` on the
   push wire — unresolvable by construction / arch-gated topology disclosure (B-324).
8. Shipping `senderName` in pushes — N-15, social-graph leak to the relay.
9. Awaiting the missed-banner dismiss before the incoming card — Doze-budget bridge
   round-trip before ringing (Phase-4 DO-NOT-RE-ADD #12).
10. Buffering ring frames behind `depsReady` / shipping boot reorders 5.2/5.6/5.7
    without device numbers (spec §21.6 DO-NOT-RE-ADD).
11. `runAfterInteractions` deferral of lists — measured 2× worse (B-279).
12. Diagnosing killed-app push on BlueStacks / after Force-stop; trusting relay
    `sent=1/1` as "banner rendered" (B-336 lesson).

---

## 6. Invariants any fix on this surface must respect

- **M16** (MESSAGE_LOOP): a _message-content_ notification never fires before its
  commit, and every committed message notifies (W28/W29 pins, mutation-proved).
- **M2**: group-ness comes from `messagingLogic.isGroupConversation` — the
  `opts.isGroup` caller hint is a known open wart (W27), don't widen it.
- **Security:** no plaintext bodies, no `senderName`, no key material in any push
  payload or log (logAudit test enforces).
- `backgroundMessageNotifier.ts`, `fcmBootstrap.ts`, `mutedLookup.ts` are
  MESSAGE_LOOP §0 trigger files → §5 caller sweep, §7 gate order, §8 device smoke.
- Any tappable banner that navigates → NAV_RAPID_USE_LOOP (goBackOnce/navigateOnce,
  focus-scoped back handling).
- Messenger gate: both Jest projects green, crypto run **twice** (B-126 flake rule).
- Notification suppression for the on-screen conversation keeps its **immediate**
  mount timing (`skipUnreadClear` split, B-691) — only unread-clearing defers.

## 7. Related open items this plan should ride with

- **B-352 device pass** — owed since 2026-08-01; S-0 closes it.
- **Lean headless runtime** (spec 5.4 / audit B2) — the structural fix behind S-1.
- **Notifications inbox migration** (`20260727210000_notifications_inbox.sql`,
  GAP-3) — written, **never applied**; the durable answer to "a missed wake is lost
  forever," named in the docs as the real "notifications unreliable" root.
- **Killed-app notification icon check** (`ic_stat_bravo` post-R8) — owed from the
  W1 smoke.

## 8. Implementation record (2026-08-29, same session)

Built by two parallel workers, then an adversarial critic pass whose findings
were all fixed or deliberately dispositioned. Full log: `sqa.md` B-692.

**Shipped:**

- **S-1** — killed lane posts an instant SILENT "Checking for new messages…"
  placeholder (`showPendingWakeNotif`, LOW channel `bravo-messages-pending`,
  id `bravo-msg-pending`) and retires it on drained/fallback. Silent by
  construction: a sealed-sender wake is indistinguishable from a receipt wake,
  and an audible placeholder would ding for every read receipt (P2-BR-3).
  The audible fix for the killed lane's sound latency remains the lean
  headless runtime (spec 5.4, still open).
- **S-2** — the 10 s per-conversation gag is gone: `ALERT_FLOOR_MS=1500`
  per-thread floor + once-ever-per-`messageId` (recorded only on an ACTUAL
  alert) + a `wakeFallback` collapse window (10 s) that keeps a drain's named
  upgrades silent after a generic wake alerted. **Decision (critic F2):** the
  collapse window is deliberately GLOBAL — sealed sender makes a sender-keyed
  wake banner unmatchable to its conv-keyed upgrade, so scoping would
  resurrect the N-29 double-sound; accepted trade: on degraded lanes only,
  another conversation's alert can go silent ≤10 s (banner still shows).
- **S-3** — the foreground layer exists now: `InAppMessageBanner` (App.tsx
  overlay, native-driver, 3.5 s, cross-shell tap routing), receive tone
  (`assets/message.wav` + `messageTone.ts` one-shot player — never touches
  audio mode, silent during calls, 400 ms throttle) and a light haptic; the
  notifier routes foreground commits to it inside `onAfterCommit` (M16),
  W29 seen-set maintained, muted silent, `'unknown'` AppState keeps the old
  silent bail (critic F5). The in-app cue bumps `messagePostedGeneration`
  so the warm P2-6 fallback can't stack a notifee ding on top (critic F1,
  the loop's one P1). **F9:** sounds sit behind a compile-time kill switch
  (`IN_APP_MESSAGE_SOUNDS_ENABLED`); a user-facing setting is a follow-up.
- **S-5** — `conversationSortKey` memoises the ISO parse (bounded map);
  the notifier's badge whole-map reduce runs only on the notifee lane.
- **S-6** — bubble entrance keys on a live-arrival registry fed by
  ChatScreen's render diff, so pipeline-delayed messages animate instead of
  popping. **F7 (accepted, cosmetic):** a direct-slot merge can animate ≤3
  historical rows once; a time bound would re-introduce the created_at
  heuristic this fix removes.
- **S-7** — the group-summary sync moved behind the banner display.

**Verification:** messenger gate green (crypto full ×3 — the one real failure
was the subscription census catching the banner's new store subscription, now
ledgered; one `freeSpacePrecheck` red moved suites and was green in isolation
= the B-126 flake), app messenger screens 736 green, typecheck 47 = baseline,
**12 mutation proofs** (each grep-verified applied). New suites:
`msgBannerDismissBadge` (alert model rewrite), `headlessDrainNotify` +
`fcmHeadlessRouting` (placeholder lifecycle), `inAppMessageForegroundRouting`,
`messageToneGuards`, `InAppMessageBanner.test`, `chatLiveArrivalAnim` (scan),
`liveArrivals`, `conversationListOrder` (parse-once).

**Still owed:** S-0 device pass (read `[NOTIFLAT]`/`[NOTIFHEALTH]` off a real
phone, targets in §4); S-4 server debounce (number-gated on S-0); the in-app
sounds user setting; the lean headless runtime (spec 5.4).
