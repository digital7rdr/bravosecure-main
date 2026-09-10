# Message notifications — "stuck on the first message" (B-710)

**Date:** 2026-08-30 · **Trigger:** founder report —
_"The first incoming message appears in the notification. When a second/third message arrives,
the notification may remain stuck on the first message… new notifications sometimes arrive late…
multiple messages arrive together… background/killed behaviour is inconsistent."_

**Method:** 5 parallel lane auditors (warm-background · killed/headless · server push ·
foreground/read-state · ordering & dedupe), every headline claim re-verified by hand against
source, and the display layer reproduced empirically with a scratch Jest probe before any
fix was written.

**Verdict: the founder is describing at least six distinct defects, not one.** The
MessagingStyle card that WhatsApp-style grouping depends on was already built and correct;
everything around it — which draw wins, which rows reach it, whether it is ever erased, and
whether the notifier is even listening — was not.

---

## 0. The pipeline, and where it breaks

```
sender ─► relay (envelope.service) ─┬─► WS envelope.deliver ──────────────► warm client
                                    └─► sendChatWake ──► FCM ──► device ──► fcmHeadless (killed)
                                                                        └─► fcmBootstrap (warm bg)
                                            │                                    │
                                     2 s debounce                        headlessDrain → runtime boot
                                     collapse msg-wake:<sender>                  │
                                            │                            store commit
                                            ▼                                    ▼
                                    ONE content-free wake        backgroundMessageNotifier.onStoreChange
                                                                                 │
                                                                    showMessageNotif → notifee card
```

Six failure points, marked below as **F1…F6**, sit on the right-hand half of that diagram —
between "a message is in the store" and "the shade shows it".

---

## 1. Findings

### F1 · P0 · A killed-app wake ERASED the conversation card it was meant to back up

`fcmHeadless.ts:410-415` resolves a DM's conversation id **locally**:

```ts
if (!convId && senderUserId) {
  const resolved = await resolveDirectConversation(senderUserId);
  convId = resolved?.id ?? undefined;
```

and `mutedLookup.ts:166-171` returns the **server-UUID row** in preference to the synthetic
`direct:` slot — the exact id `backgroundMessageNotifier` posts its rich card under. The wake
then drew on that id with **no body and no style**, and `notifee.displayNotification` on an
existing id _replaces_. A card reading _"Alex · Hey / Are you there? / I need to talk"_ became
**"New secure message — Open Bravo Secure to read it"**, and stayed there.

That is the founder's symptom in the most literal available sense: the notification does not
just fail to update, it goes **backwards**.

Reproduced directly:

| draw               | id             | rendered                                                       |
| ------------------ | -------------- | -------------------------------------------------------------- |
| 1 (store notifier) | `bravo-msg-C1` | title `Alex`, card `["Hey"]`                                   |
| 2 (wake, no body)  | `bravo-msg-C1` | title `Alex`, body `Open Bravo Secure to read it`, **no card** |

**A note left in `callNotification.ts` said this could not happen.** It reasoned that the
server never puts a `conversationId` on a chat wake — true (`messenger.gateway.ts:1408`,
`envelope.controller.ts:128` pass only `senderUserId`) — and concluded the ids therefore never
collide. The client resolves one itself, so the conclusion did not follow. The **warm** lane
had already spotted this and refuses the guessed DM (_"NEVER the ambiguous resolved DM"_); the
two lanes had drifted.

Same mechanism, worse variant: under sealed sender a **group** message resolves to the
sender's DM, so Bob's group post overwrote Bob's 1:1 card and captioned it with the wrong
thread.

### F2 · P0 · One killed-app wake silenced the foreground cue lane for the rest of the process

`startBackgroundMessageNotifier` returned early on `running` and left `headlessMode` set:

```ts
if (running || Platform.OS !== 'android') {
  return;
}
running = true;
headlessMode = opts?.headless === true;
```

The FCM headless task runs in the app's **own** JS VM, so the flag outlives the wake, and
`headlessDrain.ts:235` starts the notifier `{headless: true}`. When the user then opens the
app, `startFcmBootstrap`'s `startBackgroundMessageNotifier()` hits that early return.

The flag is load-bearing twice:

```ts
const foregroundUi = !headlessMode && AppState.currentState === 'active'; // false
function isBackgrounded() {
  if (headlessMode) return s !== 'active';
} // false when active
if (!foregroundUi && !isBackgrounded()) {
  continue;
} // → drops EVERY message
```

With the app **on screen**, both read false and every inbound message was dropped: no in-app
banner, no receive tone, no shade banner — until sign-out or process death. Three of the five
lanes reached this finding independently.

### F3 · P1 · The card was draw-ordered, never send-ordered, and never deduped

`thread.push(...)` with no sort and no `messageId` check. Reproduced:

| input                                 | card rendered             | shade header (`Notification.when`)        |
| ------------------------------------- | ------------------------- | ----------------------------------------- |
| m1 (t=1000), m3 (t=3000), m2 (t=2000) | `["one", "three", "two"]` | **2000** — regressed to the older message |
| m1 drawn twice                        | `["Hey", "Hey"]`          | —                                         |

`Notification.when` is Android's shade sort key, so the second row is _literally_ "an older
notification overwriting a newer one" — the founder's requirement 6, violated. And the 7-row
cap `shift()`s index 0, which is only "the oldest" while pushes are in order: one out-of-order
or duplicated draw and the cap evicts the **newer** message.

### F4 · P1 · Only the newest row of a store commit ever reached the card

```ts
const tail = fresh.reduce((a, b) => (b.created_at >= a.created_at ? b : a));
if (!tail.sender_id || tail.sender_id === 'self') {
  continue;
}
```

One banner per conversation per commit. When a drain commits several messages at once — the
offline catch-up, _exactly_ the "10 messages while I was away" case — the messages in between
never reached the card, and `rememberSeen` had already watermarked them so nothing could ever
show them again.

The self-send filter also ran **after** the newest row was chosen, so an outbound row landing
in the same commit (an outbox drain, a send from another device) made the whole conversation
`continue` — burning the inbound messages with it.

### F5 · P1 · Nothing observed `EventType.DISMISSED`

Both notifee handlers filter to `PRESS`/`ACTION_PRESS`. A swiped-away banner therefore left
`msgThreads` and `activeMsgNotifIds` populated, so:

- the next message re-rendered up to seven **previously dismissed** previews onto the lock
  screen, and
- the group summary kept counting banners that were gone ("2 conversations" over one).

This was also the stated reason F1's guard had been removed, so it had to be fixed first.

### F6 · P1 · The 10 s alert-collapse window was GLOBAL

`lastWakeAlertAt` is one module scalar. Any alerted wake silenced **every** conversation's
banner for the next ten seconds. A message from Bo, three seconds after a wake from Alex,
posted silent. The window exists to collapse one message's generic wake into its own named
upgrade — and both halves of that pair always share a `senderUserId`, which the store notifier
had but was not forwarding.

### Server-side (contributing, not sufficient on their own)

| #   | Finding                                                                                                                                                                                                                          | File                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| S1  | `sendEachForMulticast` **resolves** on per-token failure; the guard keyed on the throw, so a quota block or `SENDER_ID_MISMATCH` left the 2 s window armed and coalesced the rest of the burst behind a wake that reached nobody | `push.service.ts:809-812, 865` |
| S2  | Per-response error codes were discarded unless they were one of two dead-token codes — `sent=N/M` was the only ops signal, so the founder's report was **not falsifiable from server logs**                                      | `push.service.ts:803-808`      |
| S3  | `sentAtMs` was dropped from `scheduleTrailingChatWake`'s signature, so the trailing wake stamped `Date.now()` at fire time — the only orderable field in the payload, invented, ~2 s wrong, and identical for messages 2..N      | `push.service.ts:701, 882-885` |

---

## 2. Checked and explicitly FINE — do not "fix" these

- **The MessagingStyle card itself.** Accumulation, the `person: {name: 'You'}` shape, the
  group summary and `shortcutId` are all correct and pinned.
- **The 1.5 s per-thread alert floor.** WhatsApp-parity burst coalescing; messages inside it
  update the shade silently, which is the intended behaviour, not a bug.
- **The 2 s server debounce and `collapseKey: msg-wake:<sender>`.** Correct coalescing. The
  collapse key does **not** degrade to the recipient — `conversationId` is `''`, which is falsy
  under `||`, so it falls to the sender.
- **The wake payload's contents.** `kind`, `conversationId`, `senderUserId`, `sentAtMs` — no
  message content, no key material. Deliberately left alone (requirement 3).
- **Row-level dedupe.** `seen_envelopes` (SQLCipher, 35 d), the `(conversation_id, id)` primary
  key and the `envelope_id` unique index are solid. The message row could never duplicate; only
  the _notification_ could.

---

## 3. Fixes

| #   | Fix                                                                                                                                                                                                                                                                             | Where                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| F1  | A guessed conversation id no longer **keys** a banner — it rides as `convRouteHint` for the tap only. Both wake lanes now agree. Plus defence in depth: a body-less draw on a conversation-keyed id **re-renders the retained card** instead of erasing it, and never re-alerts | `fcmHeadless.ts`, `fcmBootstrap.ts`, `callNotification.ts` |
| F2  | A warm start **promotes** a notifier that came up headless (one-way; a headless start never demotes a live one)                                                                                                                                                                 | `backgroundMessageNotifier.ts`                             |
| F3  | Card insertion is timestamp-ordered and deduped by `messageId`; the collapsed line and `Notification.when` come from the **newest** row and can never regress; only a _real_ send time reaches the shade header (B-323 holds)                                                   | `callNotification.ts`                                      |
| F4  | The notifier feeds the **whole** commit into the card via `preceding`, capped at the card size, alerting once for the newest; the self-send filter runs **before** the newest row is chosen                                                                                     | `backgroundMessageNotifier.ts`                             |
| F5  | `noteMessageNotifDismissed` is wired into both notifee handlers ahead of their PRESS filters                                                                                                                                                                                    | `callNotification.ts`, `fcmBootstrap.ts`                   |
| F6  | The collapse window is **sender-scoped** when the sender is known; a wake that names none still arms a global window, so N-29 protection stays wide exactly where the two halves cannot be matched                                                                              | `callNotification.ts`                                      |
| +   | A headless **hydration hold**: draws are suppressed between a headless start and `armBackgroundMessageNotifier()`, so the runtime's history replay can no longer re-banner a one-row conversation (the `list.length > 1` guard could not catch that shape)                      | `backgroundMessageNotifier.ts`, `headlessDrain.ts`         |
| +   | The killed lane names its sender to `cueDeliveredSince`, so the one-cue-one-wake ledger is live there instead of inert                                                                                                                                                          | `fcmHeadless.ts`                                           |
| S1  | A zero-success multicast counts as a failure and releases the window; `no-tokens` releases it too                                                                                                                                                                               | `push.service.ts`                                          |
| S2  | Per-response error **codes** are logged (codes and counts only — never a token, never a payload)                                                                                                                                                                                | `push.service.ts`                                          |
| S3  | The trailing wake carries the accept time of the message that scheduled it                                                                                                                                                                                                      | `push.service.ts`                                          |

---

## 4. Deferred — deliberately NOT built

- **Multi-device read-clear — DESCOPED BY THE FOUNDER, 2026-08-31.** Asked directly, the answer
  was: _"no we don't need for now, this app can run only one device."_ **The product is
  single-device. Do not build multi-device sync, and do not treat its absence as a defect.**

  For the record, so nobody re-derives it: reading on phone A does not clear phone B's banner,
  because there is no self-sync envelope of any kind — a search for `syncMessage`, `sync.read`,
  `selfSync`, `sentTranscript`, `linkedDevice`, `companionDevice` across `src/`,
  `apps/messenger-service/src/` and `packages/messenger-core/src/` returns **zero hits** — and
  read receipts are addressed to the message's AUTHOR only (`messenger.gateway.ts:3097` queues
  to `data.to`). Under E2EE the server cannot be the sync channel, so devices would have to send
  each other encrypted sync messages; that needs per-device addressing, and
  `X-Signal-Device-Id` is hardcoded `'1'` in at least four subsystems (push `fcmBootstrap.ts:2538`,
  backup `backupClient.ts:37`, media, vault). It is a Phase-2 architecture change touching the
  envelope layout, not a bug fix.

  **The one consequence to be aware of under the single-device decision:** push tokens are keyed
  `<userId>:<deviceId>` (`push.service.ts:479`), so a second login **evicts the first device's
  token** and that device silently stops receiving pushes (the code notes this at
  `fcmBootstrap.ts:1583`). That is correct behaviour for a single-device product — but there is
  no warning to the user when it happens. Not logged as a bug; noted here as known behaviour.

- **Skipping the wake when the recipient is live on the socket.** Would cut FCM high-priority
  quota burn (a plausible cause of progressive lateness within a long session), but a lost
  socket emit would then produce **no notification at all**. Rejected on "never lose a message".
- **A client-side dedupe on the FCM push identity.** `RemoteMessage.messageId` is never read. A
  retried push re-runs the wake; the notifee id keeps it to one shade row, so this is battery,
  not correctness.
- **Reading the shade back with `getDisplayedNotifications()`** to retain a card across process
  death. Costs a native round-trip inside the Doze budget and depends on notifee preserving the
  style in its returned payload — unverified. The F1 keying fix makes it unnecessary.
- **iOS.** `dismissMessageNotif` is Android-gated and the store notifier never starts on iOS.
  Out of scope for an Android founder device; logged here so it is not mistaken for working.

---

## 4b. The critic round — nine defects in the FIRST CUT of this fix

Two adversarial critics read the diff with instructions to assume it was wrong. They found
nine real defects in it, two of them P0. All are fixed and pinned; recorded here because
several are traps worth not re-deriving.

| #      | Defect in my own fix                                                  | Why it was wrong                                                                                                                                                                                                                                                                                                                                                                                                                             | Resolution                                                                                                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **Retention keyed on "no body" instead of on `wakeFallback`**         | The STORE lane also draws body-less — `previewForNotif` returns undefined when the user turns content previews OFF (applied live), and for any row with no renderable preview (a call record, a tombstone). So turning previews off would **re-render the very previews that setting exists to withhold**, take the silent path, and never add the new row: a thread frozen on old content, which is the symptom this whole fix is about     | Gated on `p.wakeFallback`. Only a draw that is content-free _because it cannot decrypt_ may re-render                                                                                                                                                                                             |
| **C2** | **The `hydrationHold` I added could swallow a real message entirely** | `getMessengerRuntime` fires `void transport.connect()` **un-awaited**, and the gateway flushes pending envelopes as soon as the socket authenticates — so the wake's own message can commit _inside_ the hold. `rememberSeen` had already watermarked it, the hold suppressed the draw, `pullEnvelopes` then found an empty relay and reported `'drained'`, and `fcmHeadless` skipped its fallback. **Zero notification for a real message** | **REVERTED.** It also could stick ON (its one release runs after an awaited build that can reject and is cached-rejecting for the process). The residual defect it targeted is logged as **B-712** with the correct fix shape: a hydration signal from the store's bulk loader, not a time window |
| C3     | `preceding` was dropped whenever the NEWEST row had no preview        | It is only read on the body-bearing branch, and `rememberSeen` had already watermarked the batch — F4 reintroduced through a different door                                                                                                                                                                                                                                                                                                  | The newest row that _does_ have a preview is promoted to carry the banner                                                                                                                                                                                                                         |
| C4     | `genericWakeIdBySender` recorded ordinary banners as "generic wakes"  | Keyed on `!style`, which is also true of a previewless store draw. That **orphaned** the real sender-keyed wake (map overwritten) and let an unrelated later message **cancel a live conversation banner**                                                                                                                                                                                                                                   | Records only `!style && wakeFallback && !conversationId`; retires only when the superseding draw actually has content                                                                                                                                                                             |
| C5     | The retained branch stamped a send time for a row it did not render   | `Math.max(cardWhenMs, sentAtMs)` published the _incoming_ message's time on a card containing only older rows — B-323's rule inverted                                                                                                                                                                                                                                                                                                        | The retained path uses only the retained rows' own times                                                                                                                                                                                                                                          |
| C6     | `serialiseMsgDraw` had no timeout                                     | A `displayNotification` that never settles — the wedged-binder case `awaitPendingCues` already defends against, made likelier by remote Person icons — would block that conversation's banners **for the life of the process**. One hung avatar fetch used to cost one banner                                                                                                                                                                | Each chain link is bounded (5 s); a wedge degrades to one lost banner, then normal service                                                                                                                                                                                                        |
| C7     | Dismissing the GROUP SUMMARY left every child accumulator behind      | Android delivers the delete intent for the summary row only, but the whole group leaves the shade with it                                                                                                                                                                                                                                                                                                                                    | The summary id clears all accumulators                                                                                                                                                                                                                                                            |
| C8     | `dismissMessageNotif`'s `retire()` did not clear the two new maps     | `msgThreadTitles` grew per conversation forever; `genericWakeIdBySender` kept pointing at a just-cancelled id, so the next card for that sender fired a cancel at a dead id                                                                                                                                                                                                                                                                  | Both retired alongside                                                                                                                                                                                                                                                                            |
| C9     | Batching broke the one-cue-one-wake ledger                            | N rows collapsed into one `post()` minted **one** token while the server still fires a wake per message, so wakes 2..N drew generic fallbacks for rows already in the card                                                                                                                                                                                                                                                                   | One token per **message**, not per draw                                                                                                                                                                                                                                                           |

Two smaller ones also fixed: the MR-19 warm fallback armed the _global_ gag on its
explicit-conversation branch by omitting `senderUserId`, and the re-anchored source scan read
**un-stripped** source (`.exec` takes the first match, and a comment block sits directly above
the call site — the documented prose-as-code trap) and accepted `senderUserId: undefined`, the
exact inert state it exists to reject.

**Method note worth keeping:** the defect that mattered most (C2) was surfaced not by a critic
but by a **mutation proof that came back GREEN** — the pin passed with the fix reverted, which
meant the fix was positioned after the effect it was meant to prevent. When a mutation proof is
green, suspect the fix, not the test.

## 5. Verification

- `messenger-crypto`: **571 suites / 7148 tests green**, two clean full runs (B-126 flake rule —
  the intervening runs each named a _different_ suite, and every one passed in isolation).
- `app` project: **239 suites / 3278 tests green** (full project, not just the messenger screens).
- `messenger-service`: full suite green, including 3 new chat-wake pins.
- `npm run typecheck`: **46 = baseline**. `apps/messenger-service` tsc: clean. ESLint: clean.
- **Every new pin was RED first.** The display-layer pins (`msgNotifLiveUpdate.test.ts`) were
  written before the fix and 12 of 20 failed. The notifier and server pins were
  mutation-proven afterwards by reverting each fix individually and verifying the mutation
  applied before believing the result.
- Two existing pins were **re-pointed, not deleted** — including the one whose own comment
  said _"if the ids collide, the downgrade becomes real, and THIS TEST MUST BECOME the
  assertion that the named card survives."_ That is exactly what happened.

### Owed

**A device pass.** None of this has been read off a phone yet — no device or emulator was
reachable from the build host. The matrix to run is §6. Until it is run, treat every claim above
as "green in tests, unproven on hardware".

---

## 6. Device test matrix (owed)

| #   | Case                                                                    | Expected                                                     |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | one message, app backgrounded                                           | one banner, sound, correct name + preview                    |
| 2   | two messages ~0.5 s apart                                               | ONE card, both rows, newest as the collapsed line, one sound |
| 3   | 10+ messages rapidly                                                    | one card, last 7 rows in send order, no duplicates           |
| 4   | messages while foregrounded, other thread                               | in-app banner + tone, no shade banner                        |
| 5   | app killed, one message                                                 | banner (generic if the drain fails, named if it succeeds)    |
| 6   | app killed, then opened, then a new message arrives **while on screen** | in-app cue fires — the F2 regression                         |
| 7   | poor network / airplane mode → reconnect with 10 queued                 | one card, all rows, no duplicate sounds                      |
| 8   | duplicate push (same message twice)                                     | one card row, one sound                                      |
| 9   | two conversations at once                                               | two banners + a "2 conversations" summary                    |
| 10  | swipe a banner away, then a new message                                 | card starts fresh — no resurrected old previews              |
| 11  | open the conversation                                                   | banner clears, summary count corrects                        |
| 12  | group chat, sender has a 1:1 too                                        | the group banner never overwrites the 1:1 card               |

Probe tags already in the tree: `[NOTIFLAT]`, `[NOTIFHEALTH]`, `[bgMsgNotifier]`.
`adb logcat | grep -E "bgMsgNotifier|fcm-headless|messageNotif|NOTIFLAT"`.
