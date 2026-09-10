# Messenger Reliability Audit — notifications · chat visibility · retry · duplicates · ticks · boot (B-703)

**Date:** 2026-08-29 (evening) · **Status:** decomposition complete; fixes landing one at a time —
see §9 for the running fix log. §§1–8 record the audit AS AUDITED (they are not rewritten as fixes
land, so a finding's text describes the bug, not today's code; §9 is the source of truth for what
has changed).
**Method:** six parallel audit agents (one per symptom lane), then two independent adversarial
critics who re-derived every headline claim from source. Verdicts below are the critics', not the
auditors'. All line numbers were re-grepped at HEAD `7335f945` — **they rot; re-grep the symbol
before acting on any of them.**

**Build context:** the founder's Redmi (2201116SG) runs **v1.0.272 (vc319), installed 18:33 today** —
the build WITH the B-701 sender rotation heal and the B-692 notification fixes. A clean boot capture
on it shows WS presence live within ~2 s. The complaints therefore span older builds AND whatever
still reproduces on v1.0.272; the §7 device pass discriminates.

**Founder's five complaints (verbatim intent):**

1. "The notification is not live — sometimes I don't get a notification at all."
2. "When I do get one, I can see the message IN the notification but NOT in the chat."
3. "A lot of the time a message fails to send — it asks me tap to retry."
4. "Sometimes messages are duplicated."
5. "Double tick should appear when the other person's device has internet — but it only appears
   when they open the messenger. Blue tick is fine." Plus: "check boot-up too."

---

## 1. TL;DR — symptom → most-probable causes (ranked per symptom)

| Complaint                           | Ranked causes (finding ids below)                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No notification**                 | **MR-1** (killed-lane wake fails silently — P0), **MR-11** (a chat left "active" is silenced — incl. pressing Home from inside a chat), **MR-10** (10 s global alert gag + named-banner downgrade in live exchanges), MR-22 (server debounce can swallow a wake permanently), MR-23 (MIUI force-stop/token lanes), plus KNOWN B-701 storms starving the warm lane (N-2)                                                                   |
| **In notification but not in chat** | **MR-2 + MR-3** (the conversation row is lost while the message row survives — thread invisible, tap lands on Home), **MR-8** (disappearing messages destroyed ≤1 s after the banner, banner never dismissed), MR-15 (deleted-thread replay banners orphan rows), MR-14 (Home-focus prune eats a newborn server room)                                                                                                                     |
| **Tap to retry**                    | **MR-4** (a server-ACCEPTED message flipped to failed — the race also makes the duplicate), **MR-6** (transient errors burn the 10-attempt budget → terminal failed in ~12 min), **MR-12** (boot races manufacture false failed chips), **MR-9** (dept channels: unmarked dead bubble), plus KNOWN B-701 "retrying…" whisper narrating slow-but-succeeding sends (R-5)                                                                    |
| **Duplicates**                      | **MR-4** (false-failed → tap → fresh wire id → peer sees it twice), **MR-7** (zero-tap: rollback-surviving bubble + discarded ack + auto-resend), **MR-5×MR-7** (lost killed-lane acks feed redeliveries into the MR-7 trigger — the one DURABLE no-tap duplicate), **MR-9** (dept re-type), plus B-18 twin conversation rows read as "duplicated" (D-8, benign)                                                                          |
| **Single tick stuck**               | **MR-5** (killed-lane ack batch dies with the frozen process — cleanest match for "✓✓ only when they open the app"), **MR-1** (failed drain = no ack), **MR-16** (WS-submit receipt hole, memoized 'unknown'), plus KNOWN: T-1 (every background ack producer is best-effort — B-692/DL-2 composite), B-701 leave-on-relay class (never acks, T-3), group ✓✓ poll ≤60 s (DL-6/T-2 — note the doc is stale, there are FOUR poll sites now) |
| **Boot**                            | **MR-12** (startup outbox drain vs hydration race), **MR-3** (rehydrate clobber), **MR-13** (backgroundBoot stomp → presence-invisible session), MR-17/MR-18 (stranded placeholder; 1-row re-banner per wake). The §4 safe-list covers what was checked and holds.                                                                                                                                                                        |

**The three structural patterns behind almost everything above:**

1. **Background lanes are best-effort with DESIGNED silent fallbacks** — the killed-lane drain treats
   "the function returned" as success (MR-1), retires its placeholder, flushes acks un-awaited
   (MR-5), and persists the conversation row on a debounce Android is free to freeze (MR-2).
2. **Status writes are store-first with silent misses** — `updateMessageStatus` & family no-op
   silently when the row isn't hydrated yet (the W14-promised warn never landed), which is how
   delivered messages end up wearing failed chips (MR-4, MR-12) and why none of it has ever
   appeared in a logcat.
3. **Row destruction never cleans up derived surfaces** — expiry, removeMessage, removeConversation
   and the prune all leave the posted banner (and sometimes SQL rows) behind (MR-8, MR-14, MR-15).

---

## 2. Verified wire topologies (compact; full detail in the agent transcripts)

**Notification path.** Server fires an FCM `msg-wake` on every accepted urgent submit,
_without consulting live-delivery success_ (`envelope.controller.ts:128-131`, `messenger.gateway.ts:1408`) —
so wake + WS-deliver concurrency is the NORM. 2 s per-(recipient,sender) debounce with a
process-local trailing timer; collapseKey coalescing. Killed: `index.js:47` → `handleHeadlessFcm` →
silent LOW "Checking…" placeholder → drain raced vs 8 s budget. Warm-background: handler defers to
the store notifier, pulls, and has a generation-compare fallback. Foreground: committed rows route
in-app via `onAfterCommit` (M16 holds at post time — banner body is ALWAYS a locally decrypted,
committed row; no content ever rides the push wire).

**Outbound state machine.** `sending → sent → delivered → read` is a monotonic ladder
(`STATUS_RANK`), but **'failed' and 'undelivered' are OFF-LADDER and can overwrite 'sent'/'delivered'**.
Nine 'failed' entry points (validation, group-key absent, crypto catch, HTTP-fallback catch, drain
terminal, unresealable, LRU evict, MSG-07 boot sweep, media). Auto-rescue reaches ONLY 'sending'
rows (outbox `pending`); **every 'failed' bubble is tap-only forever, by design**. There is no total
send timeout — a wedged crypto stage keeps a bubble at 'sending'/"retrying…" indefinitely.

**Dedup topology (relay → pixel).** Relay accept memo (30-day, per clientMsgId) → in-flight
registry (WS vs drain) → persistent seen-envelope store (35-day, `markSeen` inside the receive txn)
→ `appendMessage` memory dedup (id + envelope_id, **per conversation list**) → disk floor: PK
`(conversation_id, id)` **plus, since schema v20, a partial UNIQUE index on `envelope_id`** →
hydration dedup → ChatScreen byId render union.

**Delivered-receipt model.** The "receipt" IS the relay ack with disposition `'delivered'`,
emitted post-commit by both receive paths (same rule, M5). Server: WS submits get a live
`envelope.delivered` emit + a durable pendingDelivered replay; HTTP submits (ALL group legs) get an
anonymous receipt slot polled by the client (sealed-sender OM-03 forbids recording HTTP submitters —
**ARCH-GATED, do not propose recording them**). The client polls at FOUR sites: WS-connect, resume,
chat-open +600 ms, 60 s timer. Read receipts ride a separate always-durable plaintext WS frame —
their generation moment (chat open, foreground, live socket) guarantees ideal conditions, which is
exactly why blue works while ✓✓ doesn't: **✓✓'s generation is supposed to happen in the lanes that
are best-effort.**

**Boot order (verified).** Persist rehydrate (replaces `conversations` from the vault slice) →
MainNavigator configure → gate caches awaited FIRST (blocked/tombstones/receipts/call-registry) →
identity install → transport built (frames buffered until depsReady; call + group-ring exempt) →
connect (drain, outbox unpark, receipt poll) → SQL stores + **startup outbox drain (fire-and-forget)**
→ `loadRecent` → `hydrateMessages` (one commit; **never mints conversation rows**) → MSG-07
stuck-'sending' sweep → group keys → deferred stash drain → depsReady → notifier/FCM bootstrap.

---

## 3. Findings (consolidated, critic-verdicted, ranked)

Severity is graded against the founder's symptoms. NEW = not previously logged; KNOWN entries cite
their owner. Every finding is AUDIT-ONLY — fix planning is §8.

### P0

**MR-1 — Killed-lane wake: a failed fetch is reported and treated as success → engineered silence.**
NEW (mechanics of B-692 S-1's placeholder; the hole itself unlogged) · CONFIRMED by both an auditor
and an independent boot audit, then by the critic.
`headlessDrainAndNotify` returns `'drained'` whenever `pullEnvelopes` RESOLVES — and
`pullEnvelopes` catches EVERY drain error and resolves (`productionRuntime.ts:6765-6773`; a relay
5xx/DNS/token failure propagates through `rerunCoalescer.ts:93` into that swallow). Envelopes that
fail decrypt (leave-on-relay — the open B-701 residue class, transient-SQL, identity-unavailable)
`continue` and also count as drained. On `'drained'`, `fcmHeadless.ts:316-329` dismisses the
"Checking for new messages…" placeholder and returns — the fallback banner at `:338` is
unreachable, and `bannersPosted` is computed only for a log line. The server sends ONE wake per
message; nothing retries. **Plain English: the phone wakes, says "checking…", the check fails, and
the code cleans up the "checking" card and shows nothing — logging "drained".** Note the stale
comment at `productionRuntime.ts:1768` ("drainRelay swallows its own errors" — false) will mislead
the next reader. Device tell: `[bravo.pullEnvelopes] drain failed:` followed by
`[NOTIFLAT] msg-wake drained; bannersPosted= 0`.

### P1

**MR-2 — The killed lane saves the message but loses the thread's front door.** NEW · CONFIRMED.
The drain commits message rows in SQLCipher in-txn and ACKS the relay (durable, unredeliverable),
but the conversation-row mint + unread ride zustand persist behind a **500 ms trailing debounce
that RESETS on every `set()`** (`messengerStore.ts:26,2005`; `debouncedJsonStorage.ts:98-103` — no
flush hook; a drain burst pushes the flush further out). Android freezes the headless VM inside the
window → next boot: `hydrateMessages` never mints conversation rows (`:1972-1979`), the chat list
renders nothing, and the banner tap resolves `exists=false` → lands on MessengerHome
(`fcmBootstrap.ts:2019-2044`). **This is "in the notification but not in the chat", verbatim.**
Server-listed rooms re-mint on the next listMine; **client-minted groups and first-contact 1:1
slots have no listMine row — they heal only when the peer sends again.**

**MR-3 — Rehydrate REPLACES `conversations`; appends that beat it are clobbered.** NEW · CONFIRMED
(C-4 and BT-6 are one defect). `onRehydrateStorage` wholesale-replaces `conversations` from the
vault slice (`messengerStore.ts:2098-2115`) while unpersisted `messages` survive. The headless lane
waits for hydration but **fail-opens after 3 s** (`headlessDrain.ts:72-86`); the full boot has NO
gate at all (only fcmBootstrap's tap lane waits). A first-contact/new-group row minted by an early
ingest is clobbered by the late rehydrate → same invisible-thread outcome as MR-2, same heal
asymmetry (ChatScreen's B-18 slot merge rescues 1:1 history; **groups have no equivalent**).

**MR-4 — The accepted-then-failed race: one race manufactures the false retry chip AND the
duplicate.** NEW · CONFIRMED, every link. Slow link → ack watchdog (max(2.5 s, 4×RTT) ≤20 s) starts
the HTTP fallback → the LATE `envelope.accepted` lands mid-fallback: `handleAccepted`
(`productionRuntime.ts:7639-7661`) flips 'sent', records `envelope_id`, deletes the outbox row →
the fallback POST then fails → its catch (`:4642-4678`) gets `{queued:false}` from a rowless
`recordAttempt` and stamps **'failed' over 'sent'** (off-ladder, no status re-check; nothing aborts
the in-flight fallback — only the timer was cleared). The chip tap sees `prior.envelope_id` set →
B-122 lane mints a **fresh wire id** (`:4381-4394`) the relay cannot coalesce → **the recipient gets
the message twice.** Mitigating nuance: a read receipt on round 1 (keyed by the surviving
envelope_id) heals the chip before the tap.

**MR-5 — Killed-lane acks die with the frozen process → stuck single tick + redelivery fuel.**
NEW · CONFIRMED. `coalescedDrain` flushes the ackQueue in a `void`'d finally
(`productionRuntime.ts:1770-1773`); acks may still be on the queue's 200 ms timer
(`ackQueue.ts:63-67`); `headlessDrainAndNotify` resolves without awaiting any flush; Android
freezes the process with the batch-ack POST unsent. The relay never learns → **no
`envelope.delivered` to the sender (single tick persists) + the envelopes redeliver on next
connect.** This is the cleanest mechanical match for "✓✓ only when they open the app" — the
recipient's phone SHOWED the notification, but the ack died with the process.
**Composition (critic-found):** each lost ack becomes a redelivery; `wasSeen`'s error path degrades
to "process normally" (`:7707-7718`), and an old envelope past the hydrate window misses the memory
dedup → the in-txn insert hits the v20 UNIQUE index → non-transient → 'discarded' → MR-7's
auto-resend → **a DURABLE receiver duplicate with zero user action.**

**MR-6 — The send-retry budget burns on transient errors; ~12 minutes to a terminal false 'failed'.**
NEW · CONFIRMED-WITH-CORRECTION. `classifyOutboxFailure` (`sqlOutboxStore.ts:153-166`) has NO
transient-SQL arm — the receive side curates `TRANSIENT_SQL_ERROR_RE` (locked/busy/nested-txn/disk)
while the send side charges those same strings to the 10-attempt hard budget ('rejected',
`:390-399`; backoff `:67-68`). Keys-404 on a reseal (unprovisioned/reinstalling peer) burns the
same way. Ten rejected attempts ≈ 11-13 min → terminal 'failed' that only a tap reopens — on sends
that would have succeeded once the DB unclogged or the peer re-provisioned. Also (critic):
`markDelivered` sits INSIDE `shipRow`'s try (`:10208`) — a DELETE failure after a SUCCESSFUL
relay.send is charged as a send failure. Correction vs the auditor: cert negative-cache throws and
live-send crypto errors mostly do NOT reach this classifier; the burn lives in the drain.

**MR-7 — The zero-tap duplicate chain (rollback-surviving bubble → 'discarded' → auto-resend).**
NEW (compound of KNOWN parts M9 × B-46/B-683) · CONFIRMED-WITH-CORRECTION. The zustand append runs
INSIDE the receive txn; a ROLLBACK undoes SQL + markSeen but NOT the append (M9). A **non-transient**
throw after the append → ack `'discarded'` → server emits `envelope.undeliverable`
(`envelope.service.ts:470-475`) → the sender's **zero-tap** auto-resend (B-46 1:1 / B-683 §3b group)
mints a fresh wire id → receiver shows two bubbles (round 1 memory-only, gone on restart — the
restart test is the discriminator). Critic narrowed the trigger set: the async write-through UNIQUE
catch does NOT propagate, and disk-I/O/BUSY/locked are transient-classified; the reachable triggers
are the in-txn v20 UNIQUE throw (via the `wasSeen` degrade + MR-5's redeliveries) and any non-SQL
JS throw after the append. **D-3 correction:** the force-advance "zombie append" window is real but
lives in the LIVE lane (awaits from `:9050` with no `assertLive` until after the sync append at
`:9762`) — the stash lane the auditors cited IS guarded (`:8822`).

**MR-8 — Disappearing messages: admitted five minutes past expiry, destroyed with zero grace,
banner never taken down.** NEW · CONFIRMED and broader than filed. The receive gate admits up to
expiry+5 min (`expiredEnvelopeGate.ts:13-21` — B-316 skew grace); the sweeper deletes at
`expires_at <= now` on a 1 s tick with NO grace (`expirySweeper.ts:150-156`); boot purges expired
rows BEFORE hydration (`sqlMessageStore.ts:388-393`). So a TTL message delivered late banners with
full content and is destroyed ≤1 s later; a tap 10 s later opens an empty chat. **Broader class:**
`removeMessage`/`clearMessages`/`removeConversation`/the expiry sweep never dismiss a posted banner
(dismissal keys ONLY on `deleted_for_all` flips + thread activation,
`backgroundMessageNotifier.ts:199-234`) — every disappearing message that expires unread leaves its
content preview in the shade indefinitely: **the one place the burn never reaches.**

**MR-9 — Department channels: the dead bubble wears no marker and nothing re-sends when the key
arrives.** NEW · CONFIRMED-WITH-CORRECTION. ChatScreen gates the composer on a missing group key
("Waiting for the group key…", `ChatScreen.tsx:451-454,4241`); DepartmentChatScreen has NO gate —
the runtime appends, flips 'failed' (`productionRuntime.ts:3781-3797`), fires a fire-and-forget key
resync, throws; the screen alerts + restores the draft (`DepartmentChatScreen.tsx:1008-1015`) but
renders **only read ticks** (`:1625`) — no failed marker, no chip. The dead bubble looks sent; the
re-typed draft makes a visible duplicate. And in EVERY surface, nothing re-runs a 'failed' bubble
when the key lands (never enqueued — the throw precedes the outbox) — the resync fixes only the
NEXT send.

### P2

**MR-10 — The wake that duplicates, downgrades, and gags.** NEW · CONFIRMED, sharpened. The server
fires the FCM wake WITHOUT consulting whether live WS delivery succeeded — so for every HTTP-path
send (ALL group fan-out) a backgrounded-but-alive recipient ingests via WS, banners, and THEN the
wake handler compares a generation captured AFTER that post (`fcmBootstrap.ts:2843` — no entry
snapshot exists), sees "nothing new", and posts a second generic `wakeFallback` banner. Within
1.5 s it silently **REPLACES the named MessagingStyle card with generic "New secure message"** (same
notifee id); beyond 1.5 s it double-sounds AND stamps `lastWakeAlertAt` → **10 s of globally silent
named alerts** (`callNotification.ts:175,182`). In a live exchange this reads exactly as
"notifications not updating".

**MR-11 — A chat left "active" is a silenced chat.** NEW · CONFIRMED. `activeConversationId` is
mount/unmount-scoped, not focus-scoped (`ChatScreen.tsx:487-500`, plain `useEffect`). Two lanes:
(a) push ContactInfo/Settings/CallScreen over a chat → messages to that chat route "in-active-thread"
→ tone-only → the tone is globally OFF (`messageTone.ts:23`, founder veto) → no banner, no sound,
**no unread** (`messengerStore.ts:1069`); (b) **press Home from inside a chat** → notifier sees
`cid === active` + not-foreground → `continue`: no notifee, no tone, no unread — **the user's
busiest thread is precisely the silenced one.** Likely a top repro of "no notification". (The chat
list preview/reorder still updates — the message is not lost.)

**MR-12 — Boot manufactures false 'failed' chips (and the misses are unobservable).** NEW ·
CONFIRMED, contradiction resolved. The startup outbox drain (`productionRuntime.ts:2363`,
fire-and-forget) can ship rows BEFORE `hydrateMessages` (`:2427-2428`); its acceptance artifacts
are written store-first only (`:10186-10208`) and `updateMessageStatus`/`updateMessageEnvelopeId`
**silently no-op on a store miss** (`messengerStore.ts:1115-1116,1378-1379` — the warn W14 promised
at MESSAGE_LOOP.md:438 was never implemented); `markDelivered` really deletes the outbox row. The
MSG-07 sweep then sees 'sending' + no outbox row + no artifacts → **'failed' on a delivered
message**. (D-8's reading of the sweep TEXT was right — artifact-bearing rows flip to 'sent'; the
store-miss is what makes artifacts vanish.) Correction: this retry reuses the SAME wire id → relay
dedup answers the original accept → **no recipient duplicate, just the false chip.** R-4's kill
windows (pre-enqueue kill; kill inside the 50 ms coalesced store flush) land in the same sweep.

**MR-13 — The backgroundBoot stomp: a cold notification tap can pin the whole session
presence-invisible.** NEW · CONFIRMED-WITH-CORRECTION. `configureRuntimeFromPersisted` checks the
owner once then performs ~4 awaits (incl. a 3 s hydration wait) before writing
`configureMessengerRuntime({backgroundBoot:true})` with no re-check (`headlessDrain.ts:101-164`).
Critic's lane correction: RNFB never runs the bg handler while foregrounded — the REAL races are
(i) the killed-app notification tap (`ensureRuntimeForNotifAction`, `fcmBootstrap.ts:1331-1339`,
same unguarded pattern, races MainNavigator's configure on EVERY cold tap) and (ii)
wake-then-quick-open. A stomp builds the interactive session presence-'away', socket-invisible,
sync-suppressed — **no heal until process restart** (no AppState reconfigure exists). Symptom:
"peer never shows online after opening from a notification".

**MR-14 — The Home-focus prune eats a newborn server room, permanently.** NEW · downgraded P1→P2 by
the critic. Every UUID-keyed local conversation missing from ONE `/conversations/mine` response is
removed WITH its messages (SQL + media blobs, write-through removed-key branch
`productionRuntime.ts:2674-2687`) and durably tombstoned — no age/pending/unread guard exists
(`MessengerHomeScreen.tsx:388-406`). The envelope was acked → gone for good. Narrowing (critic):
client-minted groups are dashless 32-hex and can NEVER match `UUID_RE` — only server-minted rooms
(mission rooms, system channels) are exposed, and the server writes membership before fan-out, so
the race needs a listMine snapshot taken pre-commit landing post-fan-out. Real, narrow, permanent.

**MR-15 — Deleted-thread replay: rows and banners for a conversation that stays invisible.** NEW
facet of KNOWN B-594 · CONFIRMED. `appendMessage` pushes the message row BEFORE the
tombstone-suppression return (`messengerStore.ts:899-901` vs `:941`); during a sealed-archive
replay of a deleted conversation the rows persist (in-txn), the notifier — which has ZERO replay
awareness (no `isArchiveReplayInProgress` consultation anywhere in `push/`) — banners them, the
conversation row is never minted, the tap lands on Home, and the orphan rows REHYDRATE EVERY BOOT
(1-row orphans re-banner per killed wake — MR-18).

**MR-16 — WS-submitted 1:1s: a lost delivered frame is a permanent-per-session single tick.** NEW ·
CONFIRMED-WITH-CORRECTION. WS submits open NO server receipt slot (slot only when `input.receipt`;
the gateway passes none — `messenger.gateway.ts:1381-1393`, `envelope.service.ts:284-286`), so the
sender's poll answers `'unknown'`, and `httpReceiptReconcile` **memoizes 'unknown' for the whole
session** (`:81,119-121`). Correction: the initial ack-time queueing is durable; it's the REPLAY
emit that is fire-and-forget-then-delete (`envelope.service.ts:539-546`) — the loss needs both the
live emit AND one replay emit lost. Narrow; permanent per session; healed only by a read receipt.

### P3 (documented; not individually numbered)

- **MR-17** Stranded "Checking for new messages…" placeholder: dismissed only inside
  `fcmHeadless.ts`; a frozen VM strands it until the NEXT wake reposts the fixed id. Full boot never
  cancels it.
- **MR-18** 1-row conversation re-banners (and can re-SOUND — fresh VM, empty `alertedMessageIds`)
  on every killed wake; the B-698 fix exempted only `type==='system'` rows. Read status is never
  consulted.
- **MR-19** A failed/blocked notifee display still burns the generation bump (pre-try) → the warm
  fallback is suppressed → zero cue; a user-blocked channel no-ops WITHOUT throwing. The
  `messageId` record gates only sound (critic correction).
- **MR-20** AppState-'unknown' bail advances the watermark first → that message can never banner
  later (bounded to boot windows; B-692 critic F5 decision).
- **MR-21** The session-recovery resend lane ships `urgent:false` (never wakes a killed recipient)
  AND reuses the original clientMsgId — a relay dedup HIT returns the ORIGINAL accept without
  persisting the re-sealed copy → the whole B-30/B-701 recovery path can neither wake nor, in the
  dedup-hit case, deliver. (Flag-gated lane; needs a live trace.)
- **MR-22** Server debounce permanent swallows: the trailing wake is a process-local un-ref'd
  setTimeout (lost on deploy/crash with the Redis NX marker already burned); a token-less recipient
  holds the debounce armed; an HTTP-outbox retry hits the dedup memo ⇒ `wakeEligible:false` — the
  wake is never re-attempted (`push.service.ts:704-891`, `envelope.service.ts:170-188`).
- **MR-23** Platform lanes: MIUI force-stop = zero FCM by design (`batteryOptimization.ts` doc);
  exemption/autostart grant state on the founder's device UNVERIFIED (`[NOTIFHEALTH]` answers it);
  FCM token rotation while killed → no wake until next app-open re-register.
- **MR-24** Direct-slot reroute forks `conversation_id` on disk (memory=UUID, disk=`direct:<peer>`;
  M12 residue facet) — capped by ChatScreen's slot merge; wrong home preview/unread; any future
  surface reading one slot raw regrows the full B-695-class symptom.
- **MR-25** Hypotheses (no repro claimed): text stamped with an ad-hoc call-group id renders
  nowhere but banners (M4's write side is the machinery); account-switch in-flight receive banners
  into the new owner's store.
- **MR-26** B-702 residue (device-observed this session on v1.0.272): FCM `getToken` still on the
  namespaced RNFB API → deprecation warns at boot; the messaging module wasn't covered by the
  crashlytics-wrapper migration.
- **MR-27** Server dedup-memo soft spots (NX-expired race, corrupt payload) can mint two envelopes
  for one clientMsgId — absorbed client-side unless content diverges (the deliberate `#n` fork).

---

## 4. Verified SAFE / REFUTED (do not re-audit these)

- **R-10 REFUTED:** `ChatScreen.send()`'s null-runtime return cannot destroy typed text — the
  composer's submit gates on `composerEnabled`, which already encodes `runtime !== null`
  (`useMessenger.ts:47`); the `:889` check is dead belt-and-braces.
- **C-8 NEGATIVE (important):** a CONTENT banner cannot exist for an uncommitted row — receive-txn
  effects are owner-keyed, discarded on rollback/disown, spliced pre-COMMIT. And identity-regen
  (B-701) envelopes can never produce a content banner (content requires decrypt). **If the founder
  saw real text, the message decrypted and committed at least once** → the bug space is
  destruction-after-commit (MR-8/14/15) or an invisible thread (MR-2/3). Two pre-acknowledged
  cracks: the outside-txn immediate-run path (degraded/loopback boots), and the documented
  write-through post-rollback resurrection residual (`:2646-2651`).
- **D-4 NEGATIVE:** the OBSERVED B-701 `transient-sql` redeliver churn is dup-safe — the nested
  BEGIN fails as the txn's first statement, nothing renders until a clean pass renders once.
- **Boot safe-list (BT):** gate-cache loads still precede transport/drains/depsReady (M15/W8b
  holds); WS is built after identity install; boot sweeps run on REHYDRATED state; drained message
  rows are covered by the hydration merge (conversation rows are the exception — MR-2/3); the
  cold-tap route is B-324-defended; the 8 s budget can't half-commit (txn atomicity + ack
  post-commit); headless-vs-full-boot share one VM with epoch guards (bounded residual: one leaked
  SQLCipher handle per raced cold tap).
- **Send safe-list (R):** the pure half-dead-fd case without MR-4's race heals correctly (server
  dedup answers the original accept — no dup, no chip); offline sends hold at 'sending' with full
  edge-driven rescue; group fan-out excludes self; retries never re-append; the rotation-heal
  resend reuses the same clientMsgId.
- **Receipt safe-list (T):** ack-disposition honesty holds (both paths share `ackDispositionFor`;
  the W11 non-member drop acks 'discarded', never a false ✓✓); `resetWireArtifactsForResend`
  clears all round-1 artifacts so stale verdicts can't hit the resend generation; delivered→read
  regression is guarded.

---

## 5. Stale documentation found (fix the docs, not the code)

| Doc                                                   | Staleness                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MESSAGE_LOOP.md` §3 M8                               | "no UNIQUE on envelope_id" is CLOSED — schema v20 partial unique index + two-pass migration sweep (`crypto/db.ts:86-93,288-289,1143-1152`) |
| `MESSAGE_LOOP.md` §6 W14                              | the promised`console.warn` on an `updateMessageStatus` miss was never implemented — and that silence hides MR-12 in the field              |
| `docs/qa/MESSAGE_DELIVERY_LATENCY_2026-08-29.md` DL-6 | receipt-poll sites are FOUR now (connect / resume / chat-open+600 ms / 60 s) — the F-5 client half shipped                                 |
| `index.js:41-46`                                      | claims the headless handler "NEVER boots the messenger runtime" — false since the B-324/325 drain                                          |
| `productionRuntime.ts:1768` comment                   | "drainRelay swallows its own errors" — false; the swallow is in`pullEnvelopes`, which is exactly MR-1                                      |
| `sqa.md` B-692 entry                                  | cites`IN_APP_MESSAGE_SOUNDS_ENABLED`; the live switch is `messageTone.ts:23 soundsEnabled=false` (B-698 founder veto)                      |

---

## 6. Questions for the founder (each answer halves the search space)

1. **When a message was "in the notification but not in the chat" — was it the real message TEXT,
   or a generic card ("New secure message" / "Checking for new messages…")?** Real text ⇒
   MR-2/3/8/14/15 (post-commit destruction/invisibility). Generic ⇒ MR-1/MR-10's fallback lane —
   the message never landed, different bug family.
2. **A duplicated message: does it SURVIVE closing and reopening the app?** Survives ⇒ two real
   envelopes (MR-4 retry / MR-5×MR-7 durable). Vanishes ⇒ the memory-only rollback artifact (MR-7).
3. **"No notification": app fully closed, or after pressing Home from inside a chat?** The latter
   is MR-11 exactly.
4. **Do you use disappearing-message timers in the affected chats?** Yes ⇒ MR-8 jumps the queue.
5. **The tap-to-retry messages — did the peer sometimes turn out to HAVE the message?** Yes ⇒
   MR-4/MR-12 confirmed in the wild.

---

## 7. Device confirmation protocol (the owed S-0/F-0 pass covers most of it)

Rules: release APK, real phones (never BlueStacks for anything push-adjacent — tokens reaped),
swipe-kill never Force-stop. The probes have shipped since 2026-08-01 and have **never been read
off a phone**; v1.0.272 is on the founder's device now.

1. **MR-1:** swipe-kill; second device sends ONE message while the recipient's radio is cycling
   (airplane toggle at send time). Expect `[fcm-headless] wake`, placeholder, then
   `drain failed` + `msg-wake drain outcome= … bannerPosted= false` + empty shade. (The probe was
   `bannersPosted=` a count until MR-19 replaced it with the witness's boolean — grep `bannerPosted`.)
2. **MR-5/ticks:** swipe-kill recipient; send; recipient gets banner WITHOUT opening the app —
   watch the sender's tick. Then grep the recipient for ACK lines vs redelivery on next open.
   Pair with server `[submit]`/redeliver logs.
3. **MR-2/3:** first-ever message from a NEW peer / new client group to a swipe-killed device;
   wait for the banner; do NOT tap; open the app from the launcher → is the thread in the list?
   Then tap the banner → does it land on Home?
4. **MR-4:** sender behind a togglable network; kill connectivity 1-3 s after send (inside the
   watchdog→fallback window); expect 'sent'→'failed' flip and, after the tap, a recipient
   duplicate.
5. **MR-11:** open a chat, press Home (and separately: push Settings over it); peer sends to that
   chat → expect zero cue + zero unread until return.
6. **MR-10:** background the app 30 s (WS alive); one message → count shade entries/sounds; a
   second conversation's message inside 10 s → is its named banner silent?
7. **MR-8:** 30 s TTL thread, swipe-killed recipient, deliver ~2 min late → banner with text, empty
   chat, banner still in shade.
8. **MR-12:** queue a send in airplane mode, kill, restore network, relaunch on a large-history
   account → does a delivered message wear a chip? (`[messenger.outbox] draining` ordering vs
   hydrate logs.)
9. **`[NOTIFHEALTH]` boot line:** permission / msgChannel(BLOCKED?) / token reg / batteryExempt +
   MIUI autostart — answers MR-23 for this specific device.
10. **Outbox forensics:** `SELECT status, attempts, client_msg_id FROM outbox` — `failed` rows with
    `attempts>=10` confirm MR-6 in the wild.

---

## 8. Fix-planning notes (for tomorrow's session — NOTHING built tonight)

Suggested order, by founder-pain × risk (every messenger change runs MESSAGE_LOOP §5/§7 + the
regression gate; several touch the M-invariant surface):

1. **MR-1** killed-lane honesty: 'drained' must mean "ingested or genuinely nothing"; failed pulls
   / all-leave-on-relay outcomes keep the placeholder or post the fallback. Small blast radius
   (fcmHeadless/headlessDrain/pullEnvelopes outcome plumbing), huge symptom coverage.
2. **MR-5** await the ack flush before the headless task resolves (bounded by the 8 s budget) —
   directly attacks the ✓✓ complaint AND drains MR-7's trigger population.
3. **MR-4** re-check bubble/pending state (or the outbox-row deletion reason) before the fallback
   catch stamps 'failed'; never overwrite an accepted status from a stale catch.
4. **MR-2/MR-3** flush-on-mint (or mint conversation rows from hydration/SQL as WhatsApp does),
   and gate the full boot's ingest on rehydrate like the headless lane already tries to.
5. **MR-6** give the send classifier the receive side's transient-SQL arm + move `markDelivered`
   out of the try; **MR-12** land the W14 miss-warn first (observability), then order the startup
   drain after hydration.
6. **MR-9** port ChatScreen's key gate + failed-marker to DepartmentChatScreen; consider a
   key-arrival re-send sweep (design choice — it changes B-683 semantics).
7. **MR-10/MR-11** notification-layer surgery (focus-scoped active id; entry-time generation
   snapshot; never downgrade a named card). **MR-8** give the sweeper the same skew grace the gate
   has + dismiss banners on row destruction.
8. **ARCH-GATED (escalate, do not build):** anything touching sealed-sender receipt identity
   (OM-03), the identity-regen time-bomb (the REAL fix for the B-701/T-3 class), M4 call-key
   namespace, reaction AAD. The B-701 receive-side nested-txn residue (force-advanced frame leaves
   its txn open) remains OPEN and feeds MR-7/D-class — MESSAGE_LOOP territory.

**Known-open items this audit deliberately did NOT re-derive** (owned elsewhere): B-692 S-0 device
pass + S-4 server debounce; B-693 DL-1 (receive-chain serialization) + DL-2 (socket half-death);
B-701 receive residue; the identity-regen time-bomb; lean headless runtime (spec 5.4).

---

## 9. Fix log (updated as each finding is closed)

### MR-1 — FIXED (2026-08-29 evening). Killed-lane wake honesty.

`'drained'` now means _ingested_, not "the function returned". New Tier-A
`runtime/relayPullReport.ts` holds the report shape and the one classification rule;
`drainRelay` reports per-envelope accounting **by id** (a short page is re-pulled with the cursor
unmoved and acks on a 200 ms timer, so counters inflate up to 10× and a re-acked envelope could
mask a stuck one); `pullEnvelopes` still never throws but returns the report, and refuses a stale
one via a sequence stamp (a resolved `coalescedDrain` does not prove a drain ran — the epoch gate
bails synchronously). `headlessDrainAndNotify` classifies it; `fcmHeadless` falls through to the
fallback banner unless the drain finished **or** a real banner already posted.

**The discriminator, after three critic rounds.** The decision splits in two, and each half had a
plausible-looking refinement that reopened the P0 from a different side. Both are recorded here
because both will look like improvements again to the next reader:

- **Did the drain ingest everything it pulled?** `classifyPullReport` answers from the report alone:
  anything left on the relay is `'incomplete'`. It is deliberately NOT conditioned on how much the
  drain _did_ ingest. **Rejected refinement `acked === 0`:** silently-acked traffic is routine (an
  `alreadySeen` redelivery, a reaction, and above all **the rehandshake nudge that the
  leave-on-relay path itself sends**), so one such envelope beside the stuck one restored the
  original silence in exactly the B-701 population this fix exists for.
  A _skipped_ envelope is trusted only when the pass that held it has RELEASED it and `wasSeen`
  confirms it landed — `markSeen` commits at the end of that pass's receive txn, so re-checking
  mid-flight would demote a healthy concurrent deliver and post a generic banner that then gags the
  named one that pass is about to draw.
- **Does the user still owe a signal?** Only a POSTED banner suppresses the fallback.
  **Rejected refinement "did the notifier reach a verdict (post OR a muted/own withhold)":** in a
  fresh headless VM `messages` starts empty — they live in SQLCipher, not the persisted vault — so
  the runtime's own hydration replays history through the notifier. One thread whose only row the
  user sent reads as a withhold, which silenced the **first wake of every VM**: the killed-app case
  itself. Consequence, accepted deliberately: a wake that draws no banner while something is still
  stuck falls back generically, even when the row it ingested was muted. **Precisely stated** (the
  earlier wording here overstated it): the fallback still suppresses an _explicitly named_ muted
  conversation — P2-BR-5's gate is intact — and what it cannot mute is the AMBIGUOUS case, which is
  P2-BR-5's own documented trade, because the stuck envelope may belong to a different, unmuted
  thread. In production the wake never carries a `conversationId` (sealed sender denies the server
  one), so the ambiguous case is the only live one.

Pinned by `relayPullReport.test.ts` (the rule), `relayPullReportWiring.test.ts` (comment-stripped,
CRLF-safe source scan of the runtime bridge — no test can import `productionRuntime.ts`), and the
B-703 block in `headlessDrainNotify.test.ts` (the lane: the founder-symptom case, the silently-acked
compound, the clean-muted silence, the stuck-muted banner, and the H1 hydration case). Seven
mutations proved red across the three rounds — including the two that a green suite previously
survived: a hand-assembled clean report from `drainTotals`, and a tightened guard making the skip
re-check unreachable. Three existing pins re-pointed, none weakened: the B-315 drain-cursor exit
scan; W22a's release-exhaustiveness pin (the release is now pinned as the FIRST statement of the
`finally` — its original guarantee — with the new bookkeeping placed after it and forbidden from
containing `return`/`throw`/`continue`/`await`); and M5 D1, which correctly caught the new `wasSeen`
read and forced it into the W8 local-flag shape.

**Accepted residuals — deliberate, recorded so the next session does not re-derive them:**

| #     | Residual                                                                                                                                                                                                                                                                                                                     | Why accepted                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MR-1a | The suppression is **not scoped to this wake's conversation**: two overlapping wakes in one headless VM (A ingests and banners, B stays on the relay) leave B with no signal of its own. Boot hydration of a 1-row thread can post a banner and suppress the same way (this is MR-18's re-banner, seen from the other side). | Narrow, and closing it costs a second generic banner stacked on a named one. The proper close needs the notifier to expose _which conversation ids_ it posted for since a generation — not a bare count; do it with MR-10, which reworks that layer anyway.                                                                                                               |
| MR-1b | MR-19 coupling: `post()` bumps its generation **before** the display `try`, so a display that throws still counts as judged. A `'timeout'` whose only banner failed to display now shows nothing where it previously showed the fallback.                                                                                    | Pre-existing hole, now slightly more reachable. **MR-19's fix (bump after `showMessageNotif` resolves) is a prerequisite for calling MR-1 fully closed** — scheduled with the MR-10/MR-19 notification-layer step.                                                                                                                                                        |
| MR-1c | The warm background lane (`fcmBootstrap` ~`:2845`) still keys only on the posted-generation delta and ignores the pull REPORT.                                                                                                                                                                                               | Its generation check already covers "nothing drawn", and the killed lane was the P0. Its sibling gap — no ack flush — WAS a real bug and is fixed under MR-5. Fold the report in when MR-10 touches that file.                                                                                                                                                            |
| MR-1d | A permanently-stuck envelope (a rotated peer's undecryptable message can sit on the relay for the full 30-day dwell) makes every later wake `'incomplete'`, so a wake that draws no banner falls back generically — including for a muted thread.                                                                            | Bounded and deliberate: a wake fires only for a genuinely new accepted message, so "incomplete AND nothing posted" means a real new message is unseen. Per P2-BR-5 the banner wins over the drop. A persisted known-stuck-id set would additionally suppress repeats caused by the SAME envelope; deferred until the §7 device capture shows it matters.                  |
| MR-1e | `drainTotals` awaits one `wasSeen` read per skipped envelope, uncapped, on every drain exit.                                                                                                                                                                                                                                 | Practically bounded: skips are rare, and a still-held envelope short-circuits synchronously before any read. The bad case is a bootstrap page of 1000 racing a WS flush; revisit if the §7 capture shows drain-exit latency.                                                                                                                                              |
| MR-1f | A skip whose holder is STILL in flight is trusted, but owning an envelope is not the same as ingesting it: if that WS pass subsequently takes its own leave-on-relay arm, this wake already reported `'drained'` and retired the placeholder ⇒ silence.                                                                      | Strictly better than pre-fix (which was silent in every one of these cases), and the alternative — re-checking mid-flight — demotes healthy concurrent delivers and posts a generic banner that gags the named one the WS pass is about to draw (critic H3). Closing it properly needs the drain to learn that pass's OUTCOME, not just its liveness; revisit with MR-10. |
| MR-1g | The fallback's mute gate still suppresses an EXPLICITLY named muted conversation. So: wake names a muted conversation + the stuck envelope belongs to a different, unmuted thread ⇒ still silent.                                                                                                                            | Pre-existing (silent before this fix too) and currently unreachable in production — the server sends `conversationId: '' ` because sealed sender denies it the id (`push.service.ts:774`). It becomes reachable the moment a wake ever carries an explicit id, so it is recorded rather than assumed away.                                                                |

### MR-12 — FIXED (2026-08-30). The boot race that reds a delivered message, and the silence that hid it.

The startup outbox drain was kicked **before** hydration, fire-and-forget. It writes its
acceptance artifacts store-first (`updateMessageStatus('sent')`, `updateMessageEnvelopeId`), and
before hydration `s.messages` is EMPTY — so both writes silently missed, while `markDelivered`
durably deleted the outbox row. The MSG-07 boot sweep then found a hydrated `sending` row with no
outbox row and no artifacts, and gave it a retry chip: **a red chip on a message the relay had
accepted**. The retry itself is harmless (same wire id ⇒ the relay's dedup memo answers the original
accept, so no recipient duplicate) — the damage is the false chip and the loss of trust in it.

Two halves, both landed:

- **The ordering.** The kick moved below the hydrate and the MSG-07 sweep. It sits OUTSIDE the
  hydrate's `try` on purpose: a hydration failure must not also cancel outbound catch-up. Cost is
  one `loadRecent` of latency before crash-recovery replay begins.
- **The silence.** `updateMessageStatus` and `updateMessageEnvelopeId` now warn on a miss — the
  warn MESSAGE_LOOP W14 promised and that was never implemented. That omission is precisely why
  this class has never appeared in a device log: every symptom (MR-4's false chip, MR-12's, the
  drain-terminal downgrade) is one silent no-op upstream, and there was no way to see it.

Pinned by `statusWriteMissWarn.test.ts` — the warn fires with ids only and never on a hit (a warn
that fires on every legitimate write would just be noise), no content in the line (logAudit), and
two positional scans: no drain kick between the boot sweeps and the hydrate, and one after the
hydrate's catch. Anchored positionally because the same call text appears at several unrelated kick
sites; a bare `indexOf` finds one of those and proves nothing. Mutation-proved: moving the kick back
above the hydrate reds both scans.

**Moving the boot kick closed ONE door of six.** Review found the race alive through every other
kick: `transport.connect()` starts long before the SQLCipher block, and the `connected`, NetInfo,
AppState-resume, server-signal and AppState-background kicks all gate on `sqlOutbox` being non-null
and nothing else — and `sqlOutbox` is constructed BEFORE the hydrate, with the peer-session warm,
the identity-ack hydrate and `loadRecent(200)` (the most expensive read in boot) in between. A
handshake completing in that window ships over HTTP, with no connectivity precondition to soften
it, and reproduces MR-12 verbatim. Worse, the first fix's own comment named `socket.on('connected')`
as its fallback — which is precisely the path that reintroduced the bug.

So the gate is now explicit and shared: `runtime/messagesHydratedGate.ts`, awaited by a single
`drainOutboxWhenReady` that every kick routes through. It **fails open** on a bound — if hydration
hangs, sending must not stop with it — re-checks the epoch after waiting (a logout inside a
multi-second wait must not let a dead runtime ship on the new owner's socket), is marked on BOTH the
hydrate's success and failure paths, and is reset by `disposeLiveRuntime` so the next owner gates
again.

**The warn is BOUNDED, and that was not optional.** Measured on the crypto suite, the first cut
emitted 82 `MISS` lines — 80 of them from one real-runtime test. The cause is by design:
reactions, edits and delete-for-everyone deliberately register a `messageId` that is a synthetic
wire id with **no bubble row** (`productionRuntime`'s own comment calls the resulting status writes
"harmless no-ops"), and every accepted control envelope misses twice **per recipient leg** — one
reaction in a 20-member channel is ~38 lines, in a release build. An unbounded warn would drown the
device logs it exists to improve. Capped at 20 per process with a single "further lines suppressed"
line; the first misses on a device are the informative ones.

**Residuals.** _MR-12a:_ the artifacts are still written store-first only — the gate removes the
window that made them vanish, but any future pre-hydration writer hits the same silence (now at
least it says so). _MR-12b:_ the precise fix for the warn population is to mark control envelopes
explicitly at their send sites (a `control` flag on the pending entry and the outbox payload) and
skip the bubble writes for them; **do not** discriminate on `messageId === clientMsgId`, because a
first-attempt text send has them equal too (W14: `clientMsgId` must stay `msgId`). Worth doing when
that path is next touched. _MR-12c:_ `updateMessageRetractToken` is still unwarned, and per
`sendAcceptance` the retract token is written BEFORE the envelope id — so the EARLIEST signal of
this class remains invisible; fixing MR-12b first is a prerequisite, or it triples the noise.

**MR-4b correction:** the earlier claim that the drain's terminal downgrade "is fixed with MR-12"
is **wrong** and is withdrawn. That downgrade still tests `cur?.status === 'sending'` only and never
consults the shared acceptance rule — and it is not fixable by the ordering half at all, because if
the `sent` write missed then the artifact write missed with it and nothing persisted for the rule to
read. It is a strict consequence of MR-12a and stays open on its own.

### MR-6 — FIXED (2026-08-30). A local database hiccup is not a rejected message.

`classifyOutboxFailure` had three buckets and no arm for a LOCAL storage fault, so a SQLCipher
error — a locked or busy database, a nested transaction, disk I/O, a closed handle — fell through
to `'rejected'`, the one bucket that consumes the 10-attempt budget. Ten rejected attempts is
roughly twelve minutes of backoff, after which the row is terminal and only a tap can revive it.
The receive side has curated **exactly this set** for years (`TRANSIENT_SQL_ERROR_RE`) and leaves
the envelope on the relay for a later pass. Same process, same database, opposite policies — and
the conditions that produce these errors are precisely the ones this audit is already about (the
backup mirror on its own handle, a B-701 storm's wedged txn chain).

Fixed by **importing** the receive side's rule rather than writing a second copy — `receiveTransaction`
is dependency-free, so there is no cycle and no transport dependency in the store. A transient-SQL
failure now classifies `'server-transient'`: it reschedules with backoff and does not spend the
budget, which is what that bucket already meant for a relay saying "later".

**Second half: a delete that fails after a successful send was charged as a send failure.**
`await outbox.markDelivered(...)` sat inside the send's `try`, so a failure removing the local row
landed in the catch, went through `classifyOutboxFailure`, and burned an attempt on a message the
relay had already accepted — with repeated database trouble, all the way to a terminal red chip.
Both ship branches now wrap it. It matters more on the branch the first pass missed: a **group
key-material** row has no bubble to turn red, so a burnt budget there is invisible and ends with a
member who never receives the group key. Leaving the row is harmless — the next drain re-ships the
same `clientMsgId` and the relay's dedup memo answers with the original accept, so nothing
duplicates on the wire.

Pinned in `sqlOutboxStore.test.ts` (eight transient-SQL shapes must classify `'server-transient'`,
plus a symmetry case asserting every string the receive path spares the send path spares too) and
`queuedSendBubbleState.test.ts` (**both** post-send sites wrapped — the first cut of that scan
anchored on a bare `indexOf` and only ever checked one of the two). Mutation-proved: removing the
transient arm reds five cases; unwrapping either `markDelivered` reds the scan. One existing pin
re-pointed, not weakened: `outboxKickThrottle`'s `markDelivered … return 'ok'` window widened from
200 to 400 chars for the added try/catch, with the rule itself unchanged.

**Two corrections found by review, both landed.** The arm is gated on `status === 0`: a local
SQLCipher fault never carries an HTTP status, and a `RelayHttpError`'s _message is the server's
response body_, so an ungated test feeds server text into a SQLite regex — and because the arm must
sit above the 5xx branch to be reachable at all, ungated it also swallowed a real relay answer's
`Retry-After`. And the `markDelivered` catch now **backs the row off** (`recordAttempt({transient:
true})`): swallowing alone left `next_retry_at` untouched, so the row stayed due and re-shipped on
_every_ drain pass — the 60 s timer, every socket connect, every NetInfo up-edge — until the delete
finally worked. Past the cert reseal margin each of those passes also costs a sender-cert fetch and
a **real Double-Ratchet advance** for that peer, all invisible because the bubble already reads
`sent`. That was a shape regression introduced by the first cut of this fix.

**Residuals.** _MR-6a:_ a **404** still classifies `'rejected'` and burns the budget. The doc
previously framed this as the keys-service case; the classifier sees only a number, so it cannot
tell a keys 404 (peer unprovisioned) from a relay 404 (`relayClient` documents that as "feature not
deployed", and a captive portal answering 404 to everything looks identical) — in which case every
queued row goes terminal in ~12 min, which is itself a "fails to send" report. The real gap is that
the classifier has no notion of _which service_ answered; fixing it means carrying the origin on the
error. _MR-6b:_ the imported rule includes `SQLITE_FULL` / `database or disk is full` /
`SQLITE_IOERR`, which are **not self-clearing** the way lock contention is — and
`'server-transient'` has no cap (`soft_attempts` is an escalation index, not a budget) and the
outbox has no age pruning, so on a genuinely full disk a row now retries at the 2-minute ceiling
indefinitely, showing `retrying…` and never escalating to a tappable chip. The receive side accepts
the same posture for the same strings, but it is bounded in practice by the relay's 30-day dwell;
the send side has no such backstop. Accepted deliberately (a full disk mostly cannot get a row into
the outbox at all, since `enqueue` is itself an INSERT), recorded so the next reader does not assume
the imported set is only contention. _MR-6c:_ the client-side duplicate backstop is not really the
relay memo — that dies on a Redis restart and has a documented NX/GET expiry race. The durable one
is local: the messages PK is `(conversation_id, id)` with `id = clientMsgId`, so a duplicate arrival
collapses in SQLite regardless. _MR-6d:_ a test that partially mocks `receiveTransaction` and also
loads `sqlOutboxStore` would now get `isTransientSqlError === undefined`; none does today.

### MR-2 + MR-3 — FIXED (2026-08-30). The message survives; give it back its thread.

The asymmetry is the whole bug. **Messages are durable**: the receive txn commits them to
SQLCipher and acks the relay, so the envelope is gone from the server. **The conversation row is
not**: it lives in the zustand vault behind a 500 ms trailing debounce that RESETS on every `set()`,
and `onRehydrateStorage` REPLACES the whole map from the vault slice. Two independent ways it
disappears — the killed-app drain mints it and Android freezes the headless VM before the debounce
fires (MR-2), or an ingest that beat rehydration has its row clobbered by the wholesale replace
(MR-3). Either way `hydrateMessages` never mints one back; it only patches rows that already exist.
The thread is then invisible in the chat list and the banner's tap resolves to nothing and lands on
the home screen: **"I can see the message in the notification but not in the chat."**

Fixed as a REPAIR rather than by trying to make the debounce reliable: `repairOrphanConversationRows`
re-derives the row from the message rows that survived. Idempotent, so repeated boots cost nothing.

**It runs at exactly ONE site — inside `hydrateMessages` — and that covers both findings**, because
SQLCipher is the source of truth: the next boot re-derives whatever either failure clobbered. An
earlier cut also called it from `onRehydrateStorage` and claimed "whichever lands last heals the
other". That was wrong twice over and the call site is now deleted: `messages` is not persisted, so
it is empty there unless a prior `set()` populated it — and that same `set()` is what makes immer
auto-freeze `conversations`/`conversationOrder`, so the repair's writes would THROW. A throw inside
that callback skips zustand's `hasHydrated = true` and its finish-hydration listeners for the
process lifetime, silently disabling the Home screen's `listMine` reconcile and burning
`headlessDrain`'s 3 s wait on every wake. The tombstone cache is also unarmed that early, so the
B-594 guard would have been inert there. Dead code that could only ever misfire.

**Resurrecting the wrong thread is worse than the bug, so the repair refuses everything the live
minter refuses** — and two of those guards came from tests, not from review:

- **B-594** a deleted thread stays deleted. It consults the PLAIN `isConversationTombstoned`, never
  `suppressResurrection`: that one is the live/replay discriminator and it CLEARS the tombstone as a
  side effect outside a replay bracket, so a boot repair calling it would quietly erase the user's
  delete. Lifting is the live receive path's job.
- **B-106** an ad-hoc call group grows no chat row — and a group id with NO key material on this
  device is refused outright. The restore suppresses a call slot from the SERVER listing (name +
  `is_custom_name`), which this repair cannot see; without the key-material rule the next boot would
  re-mint the exact ghost the restore had just refused. The existing `restoreStreamingWalk` B-106
  pin caught this.
- **The restore path is skipped**, keyed on the restore's own bracket
  (`isRestoreWriteThroughSuppressed`), which wraps EVERY restore hydrate. The first cut keyed it on
  `bypassCap` and the claim "the restore path is skipped entirely" was false: the streaming BR-1
  batch paint calls `hydrateMessages(map, false)` because it wants the cap, so only the final
  one-shot hydrate was skipped and the repair ran on every painted batch. It survived by ordering
  luck alone (the deferred path stages conversation rows first); on the non-deferred path a
  placeholder minted mid-import BLOCKS the restored real row — the staged apply skips any row the
  store already holds — losing its name, members, mute, pin, TTL and unread.
- **B-124** `direct:<self>` is never a chat; and no synthetic twin is minted when the peer already
  has a server-UUID row (ChatScreen already unions both slots).

Pinned by `orphanConversationRepair.test.ts` (14: restore-both-shapes, idempotence, every refusal,
plus scans that both hydration paths call it and that the rehydrate call runs AFTER the B-106/B-124
sweeps so nothing they removed is re-minted). Mutation-proved: disabling the tombstone guard reds
the two B-594 cases; disabling the twin guard reds the twin case. **That twin mutation initially
survived green** — the tombstone store persists through AsyncStorage and the suite re-armed its
cache from a dirty store, carrying one case's tombstone into every later one; the store is now
cleared per test.

**A repaired GROUP is rebuilt from its own group state**, not from a stub. The key-material guard
above proves `GroupState` exists, and it carries the real `name` and `members` (`partialize` strips
only `masterKeyB64`). The first cut ignored both and wrote `'Group chat'` with a single
participant — which would not merely look wrong, it would **send** wrong: the fan-out targets
`participants` (the L9 rule), nothing re-syncs a repaired row at boot (the group-key warm-up uses
`setState`, not `setGroupState`), and this fix's whole point is that the banner tap now lands in the
repaired thread. A reply there would have encrypted to one member and silently missed the rest until
the next `/conversations/mine`.

**Residuals.** _MR-2a:_ a repaired 1:1 row is the `Bravo · <hex>` placeholder until the directory
backfill or the next sync names it — the same placeholder the live minter produces (a group with no
roster in its state falls back the same way). _MR-2b:_ unread counts are not reconstructed
(`unread_count: 0`) — the thread and its messages are visible, the badge is not. _MR-2c:_ **deleting
a conversation does not purge SQLCipher** — `removeConversation` clears only the in-memory list — so
this repair made the AsyncStorage tombstone load-bearing where it previously only had to survive a
render. Its write is fire-and-forget with a swallowed catch, so a failed write now means a deleted
thread returns at the next boot. **The cheapest real hardening in this whole finding is to delete
the SQLCipher rows on delete/block** (copy the B-124 cleanup's shape) so the repair has no fuel;
that is a destructive change to the delete path and is left as its own decision. _MR-2d:_ the
tombstone is id-keyed while the repair is message-row-keyed, so deleting a peer's server-UUID row
does not stop a `direct:<peer>` slot holding rows for the same peer from being rebuilt. _MR-2e:_
`pruneCallGroupGhostRows` also drops a row by NAME (`is_custom_name` false); the repair has no
counterpart, so a row whose name is `'Call'` but whose GroupState name is not could be swept and
re-minted as a normal group. _MR-2f:_ a repaired group row newly enters the Home `listMine` prune's
blast radius (which destroys the group master key for a UUID row the server does not list) —
previously such a thread was invisible and therefore never iterated. _MR-2g:_ unlike both live
minter branches, the repair has no `sender_id !== 'self'` condition — deliberate, so a thread whose
only surviving rows are your own sends is still rebuilt.

### MR-4 — FIXED (2026-08-30). The accepted-then-failed race: one race, both symptoms.

The WS ack watchdog gives up (2.5–20 s, RTT-scaled) and starts an HTTP retry. The server's
`envelope.accepted` then lands **while that retry is in flight**: `handleAccepted` flips the bubble
to `sent`, records the envelope id, and DELETES the durable outbox row. The retry's own POST then
fails, `recordAttempt` finds no row and reports `queued: false`, and the catch stamps `failed` — over
`sent`, on a message the relay is holding. Both statuses are off-ladder, so status rank does not
protect it. The retry chip that appears then mints a **fresh wire id** (B-122) that the relay's
`(recipient, clientMsgId)` dedup cannot coalesce, so the recipient receives the message twice.
That single race produces both the founder's false "tap to retry" **and** his duplicates.

The watchdog already pre-checked "already sent?" _before_ starting the retry; nothing re-checked
after. The catch now re-reads the live row first and returns if the relay already accepted it —
placed before `recordAttempt` so an accepted send cannot burn an outbox attempt either.

The acceptance test itself moved into a shared `runtime/sendAcceptance.ts`: B-683/F4 had already
established it inline for the MSG-07 boot sweep, and a second copy at the send site is precisely
this repo's "N drifted copies of one behaviour". `wasSendAccepted` adds the status half, because
the envelope id and the status are two separate store writes and a silent miss on either must not
convince the catch that the send failed.

**Pinned by a real EXECUTING repro, not a source scan** —
`productionRuntimeDirectSend.test.ts` builds a real runtime (real X3DH, real sealed sender) and
injects the accept at the exact moment the watchdog commits to its retry, using the watchdog's own
log line as a synchronous hook (it fires after the pre-check and before the retry starts), so there
is no timer or microtask racing. Mutation-proved: with the guard removed the test reports
`Expected: "sent", Received: "failed"` — the founder's chip, reproduced. Plus `sendAcceptance.test.ts`
for the rule (all four artifacts, empty-map negatives, status half).

Two existing pins re-pointed, neither weakened: the B-683/F4 sweep scan now pins the SHARED rule and
gained a companion asserting the rule still covers all four artifacts (more coverage than the
literals gave); and the XO-5 ordering scan is now comment-stripped **for that assertion only** —
the new explanatory comment contained the quoted status literal and `indexOf` matched the prose
instead of the code, inverting the pin. That file's other slices deliberately anchor on comment
text, so the strip stays local.

**The guard is scoped to THIS attempt, and that is the whole subtlety.** The first cut asked "does
this row carry an acceptance artifact?" — which is a different question, and on the 1:1 lane a
strictly more dangerous one. Only the GROUP lane calls `resetWireArtifactsForResend`; the 1:1 retry
keeps round-1's `envelope_id`/`retract_token` on the bubble, so on every `undelivered` retry — B-122's
entire population — an artifact-only test sees round 1's proof and swallows round 2's genuine
failure. The bubble then sits at `sending` with no chip, no banner and no terminal outbox state, and
in the no-durable-queue arm the message is simply gone. **That trades a false chip for a lost
message.** So acceptance is snapshotted before the attempt ships and the guard requires it to have
_changed_ (`acceptedDuringAttempt`). The snapshot is taken OUTSIDE the retry closure on purpose: the
accept can land between the watchdog's pre-check and the retry starting, and a snapshot taken there
would already see it and conclude nothing changed — the executing repro caught exactly that.

The watchdog's own pre-check now asks the shared rule too (`wasSendAccepted`), so a row already at
`delivered`/`read` no longer triggers a pointless HTTP re-submit (and its possible `forceReconnect`,
the B-72 churn cost).

**Residuals.** _MR-4a:_ the retry lane's fresh-wire-id mint (B-122/B-683) is untouched and still
correct for its intended population (every leg genuinely dead) — this fix removes the FALSE trigger;
the remaining zero-tap duplicate path is MR-7. _MR-4b:_ the drain's terminal downgrade (the shipRow
catch — re-grep, the stamped line has moved) still tests `status === 'sending'` only, so an
accepted-but-status-missed row can still be stamped failed there. **It is NOT fixed by MR-12** — that
earlier claim is withdrawn, see the correction in the MR-12 section: if the status write missed then
the artifact write missed with it, so nothing persisted for the shared rule to read. It is a strict
consequence of MR-12a and stays open on its own. _MR-4c:_ the 1:1 retry keeping round-1 artifacts is now
DOCUMENTED rather than fixed; it also means a stale `retract_token` can pair with a round-2 envelope
id (the 1:1 twin of B-683/F2, which turns receipt probes `unknown`). Clearing them the way the group
lane does would also discard a late round-1 receipt that legitimately heals the bubble, so it needs
its own decision — not a drive-by.

**Note on the XO-5 strip:** with the comment reworded, the raw block already orders correctly, so
the comment-stripping there is belt-and-braces against a FUTURE comment rather than something
currently load-bearing.

### MR-5 — FIXED (2026-08-29). The killed lane now waits for its relay acks.

The ack that flips the sender's ✓✓ rides a 200 ms batcher, and every caller fired it
fire-and-forget (`void flushAckQueue(relay)` in `coalescedDrain`'s `finally`). The killed lane
resolved its headless task without waiting, so Android could freeze the process with the POST
unsent: the relay never learned the device held the message, the sender's tick stayed single until
the recipient opened the app — the founder's complaint verbatim — and the envelope redelivered,
which is also what feeds the duplicate lane (MR-7).

New `flushAcks()` on the runtime (`await flushAckQueue(relay)`, never throws — the queue already
swallows per-batch failures because the relay redelivers), consumed through a shared
`push/flushAcksBounded.ts`. Deliberately NOT awaited on the shared drain path: putting a network
round-trip on the chat-open path is exactly the jank B-279/B-691 fought, so the `void` there is
pinned as intentional.

**BOTH background lanes flush, because both pull.** The first cut fixed only the headless task —
but `fcmBootstrap` re-registers `setBackgroundMessageHandler` at module scope and therefore
**overrides** the headless handler whenever the app is warm, which is the lane most wakes actually
take. It pulled and never flushed: the same stuck tick, in the larger population. One shared helper
rather than two copies (this repo's most common bug shape is N drifted copies of one behaviour).

**The wait is BOUNDED (1.5 s), and that bound is load-bearing.** The ack queue can outlast any wake
budget by design — its 429 arm sleeps 10 s _inside_ the run (up to 3×) and a `batchless` relay acks
one POST per envelope. Waiting for those does not deliver them any sooner (the OS still cuts the
task off) while it _would_ push the killed lane past its 8 s notify budget, flipping a quietly
drained wake into the generic fallback banner — which, under sealed sender, carries no
`conversationId` and so **cannot be muted**. Unbounded, the fix would have traded a stuck tick for a
muted thread that dings. The killed lane also classifies and logs its `[NOTIFLAT]` probe **before**
flushing, so a slow or throwing flush can neither delay the line §7 says to read off the device nor
demote a drained wake to `'failed'`.

Pinned in `flushAcksBounded.test.ts` (bound, swallow, missing-method breadcrumb, both lanes wired,
and the bound < the notify budget), `headlessDrainNotify.test.ts` (a **deferred** flush proves the
await — a mock that resolves synchronously records the same call order either way, so an ordering
assertion alone is decorative; plus a hanging flush that must not burn the budget), and the
`relayPullReportWiring` scan pinning both halves. Mutations proven RED: `await`→`void`; flush moved
before the pull; `flushAcks` gutted; the shared path's `void` turned into an `await` (the jank
regression); the warm-lane flush deleted; the bound removed.

**Residual MR-5a:** the flush is best-effort by construction — a drain that consumes most of the
budget, or an ack queue in its 429 backoff, still ends with acks unsent; the relay redelivers and
the tick lands on the next successful ack. **MR-5b:** the AppState-`background` flush
(`productionRuntime` ~`:2147`) stays fire-and-forget — nothing awaits that handler, so awaiting
would buy nothing.

Device confirmation still owed (§7 item 1): the `[NOTIFLAT] headless drain incomplete/failed:
pulled= acked= skipped= leftOnRelay=` and `[NOTIFLAT] msg-wake outcome= … bannerPosted=` lines must
be read off the Redmi with a real stuck envelope.

### MR-19 — FIXED (2026-08-30). A banner that never drew is not a banner.

Both FCM wake lanes end with the same question: _did the user get anything for this message?_ If
not, they draw a generic fallback, which is the last thing standing between a real message and
total silence. They asked it by comparing `getMessagePostedGeneration()` — and that counter is
bumped **synchronously, before** the notifee call, and never taken back. So a display that threw,
or an in-app banner layer that was not mounted, moved the counter exactly as a successful banner
does and suppressed the fallback for the one message that produced nothing at all.

Worse, `showMessageNotif` **swallowed its own display error** (`catch { console.warn(...) }`,
returning `void`), so `post()`'s own catch could never see one either. The failure was invisible at
every layer above it.

The bump stays where it is — that placement is load-bearing and pinned: a bump moved below the
native round-trip makes the wake lanes read "nothing drew" while a banner is in flight and
**double-banner**. Instead the missing half was added:

- `showMessageNotif` now returns **whether the shade actually got it** (`Promise<boolean>`).
- The notifier counts `messageCueFailures` — bumped when a draw returns false, throws, or when the
  in-app route's `require`/notify throws (those two `catch` blocks were silent).
- `cueDeliveredSince(snapshot)` is the one question both lanes ask: _attempted AND nothing failed_.
  It first awaits the in-flight draw (bounded, 1.2 s), because a consumer that resumes from its own
  await between the bump and the native verdict would otherwise judge the draw before it had one.
  **Fails open** — the budget expiring answers the optimistic `true`: a duplicate banner is a cost
  we can pay, a wake lane parked on a native promise is not.

Two cues raced and one failed ⇒ the answer is `false` and the fallback draws. That direction is
deliberate: an extra banner is recoverable, a silenced message is the bug being fixed.

The killed lane takes the same witness (its `bannersPosted` count becomes `bannerPosted`, and the
`[NOTIFLAT]` probe string changes with it — §7 item 1 updated). MR-1's hard-won rule is untouched:
**only a posted banner may suppress**, and now "posted" means posted.

Pinned in `backgroundMessageNotifier.test.ts` (a landed banner counts; a failed display does not
_though the generation still advanced_; the bounded wait; the fail-open) and
`msgWakeWarmBannerRules.test.ts` (attempted-but-failed ⇒ the fallback draws; the snapshot is taken
BEFORE the pull). Mutations proven RED: the witness ignoring `failures`; the warm lane reverted to
the raw generation comparison.

**Residual MR-19a:** a user-**blocked notification channel** still no-ops without throwing — notifee
reports success and `drawn` is `true`. This is deliberately NOT chased through a channel-settings
probe, because the fallback it would arm draws to _the same blocked channel_ and is equally
invisible; the honest fix is a settings-screen warning, which is a product change, not this one.
**MR-19b:** `messagePostedGeneration` is now only half the contract — anything new that reads it
directly instead of `cueDeliveredSince` reintroduces this bug.

### MR-11 — FIXED (2026-08-30). A chat you are not looking at is not an open chat.

`activeConversationId` is trusted by three independent systems to mean _the user is reading this
thread right now_: the background notifier withholds its banner for it, the store withholds the
unread bump for it, and the in-app banner layer hides itself for it. So a thread that stays
"active" while the user is elsewhere is a thread that has been **silenced** — no banner, no sound,
no unread badge — and it is silenced for the conversation the user is most engaged with. This is
the most likely single explanation for "sometimes I just don't get a notification".

Two lanes left it lying, and neither was covered:

- **(a) Anything pushed OVER the chat** — contact info, settings, a call screen. `ChatScreen`
  pinned the id in a plain **mount-scoped** `useEffect`, so the chat underneath stayed active for
  as long as it stayed MOUNTED. Messages then routed "in-active-thread" → tone only → and the tone
  is globally off by founder veto, so the outcome was nothing at all.
- **(b) Pressing Home from inside a chat.** Nothing in navigation changes, so focus scoping alone
  does not cover this one — which is why `DepartmentChatScreen`, which already used
  `useFocusEffect`, had the bug too.

Both screens carried their own drifted copy of the pin/clear pair (this repo's most common bug
shape). They now share `src/hooks/useActiveConversation.ts`, which owns the whole rule: **pinned
while the screen is FOCUSED and the app is FOREGROUND, released the moment either stops being
true.** Backgrounding hands the thread back to the notifier; resuming re-pins it and clears the
unread that accumulated, because the user is looking at it again.

Details that are load-bearing and were preserved, not re-derived:

- **Fix #31's live-value cleanup guard.** A fast back-out + drill-into-another-chat can run the
  outgoing screen's cleanup AFTER the next screen pinned itself; an unconditional clear blanks the
  chat the user is now on. The hook re-reads the store at cleanup time.
- **B-691/F3's deferred first unread-clear**, opt-in per screen. Zeroing re-renders every
  conversations subscriber including the not-yet-frozen list behind the open slide, so `ChatScreen`
  still does that half at its transition gate. **Re-focusing** never defers — there is no slide, and
  the unread piled up while the user was away is exactly what must clear.
- **`'background'` only, never `'inactive'`.** iOS fires `'inactive'` for every incoming banner and
  every control-centre swipe, and the user is still on the thread.

Two adjacent behaviours were checked rather than assumed: the F-5/B-693 receipt poll keys on the
same id, and now additionally refreshes ✓✓ on **resume** (change-edge, null skipped, 5 s throttle,
single-flight — no stampede); and the synthetic→server row merge folds unread only when the
destination is not being viewed, which is now true whenever the app is away. `activeConversationId`
is NOT in the persist whitelist, so no stale id can survive a restart and silence a thread forever.

Pinned in `src/hooks/__tests__/activeConversationScope.test.tsx`: both lanes, the iOS-`'inactive'`
exclusion, resume re-pin + clear, first-vs-re-focus deferral, Fix #31, and a source scan that both
chat surfaces route through the hook and keep no private release path. Mutations proven RED:
`useFocusEffect` → `useEffect` (lane a); the `'background'` release removed (lane b).

**Trap worth recording:** the drift scan's first cut used the usual `/\/\*[\s\S]*?\*\//g` comment
stripper and reported the call MISSING from a file that plainly contains it — these screens have
`/*` inside string/regex literals, so the stripper swallowed from there to the next `*/`, taking
real code with it. The scan strips line-by-line instead.

#### MR-19 — critic round 2 (2026-08-30). Six real defects in the first cut.

The adversarial pass found that the fix **did not do one of the two things it claimed**, and that
its riskiest mechanism was pinned only decoratively. All six are fixed; the rejections are recorded
so they are not re-derived.

- **F1 (P1) — the in-app half was inert.** `notifyForegroundMessage` swallows every side effect it
  owns, so it CANNOT throw; the `catch { messageCueFailures++ }` I added could only ever fire on a
  Metro resolution failure. With no banner host mounted it returned silently at `if (!l) return`
  and was still counted as a banner the user saw — the exact bug, unfixed, while four places
  claimed otherwise. It now **returns whether a cue was delivered**, and the caller reads the
  return, not the absence of a throw. (`inActiveThread` returns true deliberately: the open
  thread's own bubble is the cue, tone or no tone.)
- **F5 (P2) — the failure counter was global.** A failed draw in conversation B answered
  conversation A's question, and the cost is not "one extra banner": the fallback is keyed to A, so
  it REPLACES A's rich card with the generic line and its `wakeFallback` arms the 10 s GLOBAL alert
  gag. Failures are now counted per conversation; `snapshotCues(conversationId)` scopes the
  question, and only a sealed-sender wake that names no conversation falls back to the global count.
- **F4 (P2) — a wedged draw leaked forever.** `pendingCues` was only cleaned in `post()`'s
  `finally`, which never runs for a promise that never settles — precisely the failure class this
  wait exists for. Every later wake then paid the full budget, and on the killed lane that is spent
  ON TOP of the 8 s drain race inside a ~10 s Doze window: the MR-5 trade, reintroduced. The wait
  now evicts what it timed out on, the default dropped 1200 → 500 ms, the killed lane passes its own
  300 ms, and a scan pins `HEADLESS_DRAIN_BUDGET_MS + HEADLESS_CUE_VERDICT_BUDGET_MS ≤ 8.5 s`
  (the same rule `flushAcksBounded` already had and this budget did not).
- **F6 (P3) — a failed draw burned the alert budget it had already spent.** `shouldAlert` runs
  BEFORE the display (its answer shapes the payload) and records on the way out, so a refused
  display consumed the message's one-sound-ever record and opened the thread's 1.5 s floor — and the
  fallback landing on the same id moments later came out SILENT. `shouldAlert` now returns an
  `undo` that the failure path calls, guarded so it only rolls back what is still its own.
- **F2/F3 (P2) — two pins were decorative.** The killed lane's half was untested (reverting it left
  the suite green), and the "bounded wait" test passed with the wait deleted, because the generation
  bump is synchronous so a draw that merely settles LATE answers `true` either way. Only a late
  FAILURE distinguishes them. Both are now real and both were RED-proven.
- **F7/F11 — a scan whose name had become false.** `'showMessageNotif is invoked ONLY inside
post()'` still passed after the call moved into the new `drawBanner()`, because that function
  happens to sit inside the window it scanned (the `lastIndexOf`-class trap again). Re-anchored on
  `drawBanner`, plus a new scan that both wake lanes call `cueDeliveredSince` and **never**
  `getMessagePostedGeneration` directly — MR-19b was a warning with no enforcement.
- Also: `getMessageCueFailures` was a dead export (removed); both catch blocks now stringify
  defensively so a nullish rejection cannot turn `void post(...)` into an unhandled rejection; and
  the H1 safety note in `headlessDrain.ts` was **revised, not left stale** — its "a generation delta
  can only ADD a banner" argument no longer covers the signal the killed lane reads.

Mutations proven RED for every one: the wait removed; the failure comparison made global; the
in-app route always claiming success; the killed lane back on the raw generation; the alert
rollback removed.

### MR-10 — FIXED (2026-08-30). The wake that duplicated, downgraded and gagged.

> **READ THE ROUND-2 SECTION BELOW FIRST.** Two of the three claims in this entry are WRONG, and
> the mechanism it describes was replaced. It is kept unedited because the corrections only make
> sense against what was originally believed.

The server fires the FCM chat wake **without consulting whether live WS delivery succeeded**
(`messenger.gateway.ts:1408` — gated only on `urgent !== false && res.wakeEligible`; `deliveredNow`
sits right there on the submit result and is never read). So for every HTTP-path send — which is
all group fan-out — a backgrounded-but-connected recipient ingests over the socket and banners
FIRST, and the wake handler runs afterwards. Three costs, compounding:

1. The handler's "did anything draw?" snapshot was taken **after** `await getMessengerRuntime(...)`,
   so it could not even see a banner drawn during its own awaits, let alone one drawn before it
   started. It concluded "nothing drew" and posted a second, generic banner.
2. That banner collapses onto the **same notifee id**, so within the 1.5 s floor it silently
   REPLACED the named MessagingStyle card with "New secure message".
3. Beyond the floor it double-sounded AND, carrying `wakeFallback`, stamped `lastWakeAlertAt` —
   **10 s of globally silent named alerts**. In a live exchange that reads exactly as
   "notifications not updating".

All three are fixed on the client:

- **Snapshot at handler ENTRY**, before the mute lookup and the runtime boot.
- **A recent-cue window.** The notifier now records WHEN a cue last landed, per conversation and
  globally, and the witness accepts "this thread was already told, just before you started" as an
  answer. Conversation-scoped 10 s when the wake names one — safe, because the fallback would land
  on the very card already showing. Unattributable (sealed-sender, sender-keyed) 3 s — there the
  evidence is only "some conversation was cued", and being wrong means a real message in a
  DIFFERENT thread gets no signal, so it covers the push-vs-socket race and nothing more. A FAILED
  draw in the thread vetoes both: that message got nothing, however recently the thread was cued.
- **No downgrade.** A generic draw landing on an id that still holds a thread re-renders that card
  from the retained messages and its last title instead of erasing it. It invents nothing — it is
  the same locally-derived text the id was already displaying — and a dismissed thread is not
  resurrected, because dismissal drops the retained thread and title together.

**The server-side fix was considered and REJECTED — do not re-propose it.** Gating `sendChatWake`
on `deliveredNow` would kill this class at the source, but this repo has already recorded that the
WS can report `'connected'` against a dead socket (Doze silently kills the fd). Then `deliveredNow`
is true, no wake fires, and the message is silent until the user opens the app — trading a
duplicate banner for a lost notification, which is the wrong direction on the exact complaint this
audit exists for.

**The B-692 10 s window itself was deliberately NOT narrowed.** CLAUDE.md records it as GLOBAL on
purpose (a sender-keyed wake banner cannot be matched to its conv-keyed upgrade under sealed
sender, so scoping resurrects the N-29 double-sound). Fixing the _arming frequency_ — which is what
items 1 and 2 above do — is the fix; the gag now only arms when a fallback genuinely draws, which
is exactly when it is justified.

Pinned in `backgroundMessageNotifier.test.ts` (a pre-snapshot cue answers the wake; the window
bounds; conversation scoping; a failed draw overriding a recent cue), `msgWakeWarmBannerRules.test.ts`
(entry snapshot ordering — before the mute lookup AND the runtime boot; the recent-cue suppression
never skips the pull) and `msgBannerDismissBadge.test.ts` (the named card survives a generic draw;
nothing to preserve stays generic; a dismissed thread is not resurrected). Mutations proven RED: the
recent-cue window removed; the entry snapshot removed; the no-downgrade branch disabled.

#### MR-11 — critic round 2 (2026-08-30). "One owner" was not true yet.

- **F1 (P2) — `ChatScreen` still held a second writer.** Its `transitionDone` effect ran
  `setActive(conversationId)` with no focus and no foreground check, and that gate opens on a
  **400 ms fallback timer** which keeps running while the app is backgrounded and after the screen
  has blurred. So it could re-pin a thread the hook had just released (silencing it again for the
  whole background period), or — worse — clobber the pin of the chat the user had already moved to,
  silencing the one they were reading. The deferred unread-clear moved INTO the hook
  (`unreadClearReady`), where it is guarded by the same two facts the pin is. `ChatScreen` no longer
  writes the id at all, and the drift scan now bans a PIN as well as a release.
- **F3 (P2) — the new `foregroundUi` gate trusted a state this repo has already recorded as
  lying.** B-356: a VM that FCM started headless reports a stale `'background'` while the user is
  looking at the screen, which is why `ChatScreen` carries its own `observedAppStateRef`. Without
  the same rule, MR-11's change made the boot window of a notification-launched app shade-banner and
  ding the chat that is on screen. The notifier now believes "backgrounded" only after an OBSERVED
  transition — the identical rule, in the identical words.
- **F5 (P3)** — the suite could not detect a leaked `AppState` listener (deleting `sub.remove()`
  left all 11 tests green). Now pinned. **F8 (P3)** — the pending-cue budget went back to 1200 ms:
  it exists to catch a slow FAILURE, and the killed lane, which is the one with a hard deadline,
  passes its own 300 ms explicitly rather than shrinking the shared default.
- **Rejected, with reasons.** **F4** (gate the focus pin on `AppState.currentState`) is the same
  trap as F3 pointing the other way: on the notification-launch lane that reading is false, so the
  guard would refuse to pin the chat the user just opened. A focused, user-navigated screen is
  foreground by construction; only a confirmed background transition releases it. **F2** (the
  store's unread guard has no foreground check of its own) — after F1 there is no window where the
  id is pinned while the user is away, except the B-356 one, where suppressing unread is CORRECT;
  putting a `react-native` import into `messengerStore` for a closed window is not worth the
  import-graph risk in the node Jest project. The fix-log claim is narrowed instead of the code
  being widened. **F7** (an in-app banner now appears over the call screen) — the receive tone is
  OFF by founder veto (`messageTone.ts:23`), so this is a silent visual banner + haptic, which is
  standard behaviour; flagged for founder sign-off rather than silently reverted. **F9** — same
  reason: with the tone off, a `false` verdict has produced no audible cue.
- **Re-pointed, not deleted:** the B-691 "exactly 5 gated effects" census (4 in the screen + the
  fifth now in the hook, both halves asserted), the B-691/F3 pins, and the subscription census
  (ChatScreen 21 → 20 — the setter is read off `getState()` instead of subscribed, one fewer
  subscription on the repo's worst-measured jank path).

### MR-9 — FIXED (2026-08-30), and one third of the filing CORRECTED.

**Correction first — the audit was partly wrong here, and the wrong part was the headline.** MR-9
states that DepartmentChatScreen "renders **only read ticks** (`:1625`) — no failed marker, no
chip", so "the dead bubble looks sent". It does not. The dept bubble has used the SHARED
`tickIcon()` since B-131, with an `alert` token, so a `'failed'` row renders `alert-circle` exactly
as ChatScreen's does (`DepartmentChatScreen.tsx` ~`:1124`). Line `:1625` is the read-receipt info
SHEET — a per-reader `check`/`check-all` list, which is read-only by design and has nothing to do
with outgoing status. A stale line number pointed the auditor at the wrong element.

What IS real, and is now fixed:

**The composer had no gate.** ChatScreen has disabled its composer on `groupSendBlockedReason`
since GF-5 landed (`groupKeyPending` → "Waiting for the group key…"). Dept chat had nothing. So on
a channel whose master key has not arrived the user types a whole post, the runtime fails closed
inside the admin lock (`productionRuntime.ts` ~`:3819`), the already-appended row flips `'failed'`,
a key resync fires and the send throws — leaving an alert, a restored draft the user re-types (the
**visible duplicate**), and a dead bubble. The gate now comes from the same one source, with the
same words, and covers **both** send lanes plus the input: the button and the keyboard submit reach
`send()` without touching the TextInput, and the key can vanish between render and tap. The
attachment lane is gated **before `readUriBytes`**, so a keyless channel no longer reads and
encrypts a 50 MB file only to fail closed after the upload.

Pinned by extending `groupSendKeyGate.test.ts` (both surfaces derive the gate from
`groupSendBlockedReason` rather than re-deriving it; the dept composer is disabled and says why;
both send lanes refuse). Mutation proven RED: `editable` forced true.

**Residual MR-9a (unchanged, and a DESIGN decision — escalate, do not build silently):** nothing
re-runs a `'failed'` bubble when the key finally arrives, on EITHER surface. The row never reached
the outbox (the throw precedes it), so the resync only helps the NEXT send. A key-arrival re-send
sweep changes B-683 semantics and needs founder sign-off. **MR-9b:** dept chat still has no
tap-to-retry affordance for a failed bubble — ChatScreen's `retrySend` re-runs the pipeline under
the same bubble id (`existingMsgId`). Porting it means extracting a shared helper rather than
copying sixty lines into a second screen (this repo's most common bug shape); worth doing, but it
is a change to a 4 000-line screen that the composer gate makes far less urgent, because the dead
bubble it recovers is now mostly not created.

### MR-7 — FIXED (2026-08-30). The duplicate that needs no user action.

MESSAGE*LOOP records M9 as PARTIAL, with a named residue: *"asymmetric rollback — a ROLLBACK undoes
the SQL write but not the Zustand append."\_ That residue is the whole duplicate chain. The receive
transaction writes the row to the store and to SQLCipher together; on a non-transient throw the
ROLLBACK takes back only the SQL half. The bubble stays on screen, the envelope is acked
`'discarded'`, the server emits `envelope.undeliverable`, and the sender's **zero-tap** auto-resend
(B-46 1:1 / B-683 §3b group) ships the message again under a fresh wire id. The recipient reads it
twice, having touched nothing.

`receiveTransaction` had `onAfterCommit` — defer an effect until the data is durable — and no
mirror. It has one now: **`onRollback`**, owner-keyed exactly like the commit queue and fired
everywhere that queue is discarded (frame rollback, inline rollback, and a watchdog disown, whose
SQL the watchdog has already rolled back). Dropped BEFORE `COMMIT` is issued, by the same reasoning
the commit queue is spliced there: a disown landing mid-air must not compensate away a transaction
that did commit. Outside a transaction it does **nothing** — the asymmetry with `onAfterCommit` is
deliberate, because running the compensation eagerly would delete the row the caller just wrote.

All four bracketed receive appends (the group and legacy inline lanes, and the two extracted-lane
adapters) now register one. Registering is only safe when the append genuinely ADDED a row, so both
facts are required and both are sampled BEFORE the append:

- `committedId === null` — `appendMessage` deliberately deduped. Nothing was added, and removing
  anything would be destroying a row that was already there.
- the id already existed — the append UPDATED a pre-existing row, which a rollback must leave
  exactly as it found it.

A fork (`committedId !== msg.id`, the content-divergent collision path) IS a new row, and is
compensated under **the id the store committed**, never the wire id. Failing to register is the safe
direction: it leaves today's behaviour rather than deleting something.

Pinned in `receiveTransaction.test.ts` (runs on rollback, not on commit, no-op outside a txn, one
throwing compensation neither strands the others nor replaces the original failure, owner-keyed
across frames, queue depth 0 after every path) and `receivePersistenceInvariants.test.ts` (all four
bracketed sites sample existence BEFORE and compensate AFTER — sampling after the append always
reads "it exists" and would disarm every one of them; plus the two data-loss refusals). Mutation
proven RED: the frame-rollback compensation removed.

**Not claimed:** this closes the RECEIVER's half. The sender still auto-resends on
`envelope.undeliverable`, which is correct behaviour for a genuinely destroyed envelope — with the
bubble now removed on rollback, the resend lands as the message's only copy instead of its second.

#### MR-10 — critic round 2 (2026-08-30). The fix was silencing real messages.

The adversarial pass established one fact that invalidates most of the entry above: **the server
never puts a `conversationId` on a chat wake.** `messenger.gateway.ts:1409` and
`envelope.controller.ts:129` both call `sendChatWake(recipient, {senderUserId})`, and
`push.service.ts` sends `conversationId: opts.conversationId ?? ''`, which the client maps to
`undefined`. Consequences, all confirmed in source:

- **The 10 s conversation-scoped window never ran.** Every real wake took the branch the entry
  itself labels a heuristic. So did the MR-19/F5 per-conversation failure scoping.
- **The "no downgrade" leg was dead code.** The named card is `bravo-msg-<conversationId>`; the
  fallback is `bravo-msg-sender:<uid>`. Different notifee ids — the duplicate is a second shade
  entry, never a replacement. Cost 2 of the three-cost analysis does not exist.
- **The 3 s global window was WIDER than the server's own 2 s burst debounce**
  (`CHAT_DEBOUNCE_SEC`), so it swallowed the trailing wake **by arithmetic**: the trailing wake
  exists precisely to cover the second message of a burst, and it arrives while the first message's
  cue is still inside the window. The failure veto could not save it either — it only sees a FAILED
  draw, and the realistic silencing paths (a throwing pull, a stashed envelope, the hydration
  guard) produce no draw at all. **A fix for "sometimes I get a duplicate" was creating "sometimes
  I get nothing."** That is the wrong direction on this audit's own headline complaint.

**The window is gone, replaced by a claim ledger: one cue, one wake.** Each delivered cue mints a
token for its sender; each wake for that sender may claim at most one. Two messages, two cues, two
wakes — each claims its own. Two messages, one cue (the second's pull failed) — the second wake
finds nothing to claim and draws its fallback, which is the guarantee this lane exists for. No
clocks are compared across machines: the wake's `sentAtMs` is the SERVER's clock and a cue time is
the DEVICE's, so any inequality between them is unsound; the only time comparison left is a token
TTL, device-local on both sides. Sender-keyed because that is the only attribution a sealed-sender
wake has. A cue drawn inside the wake's own window claims its token too, so a later wake cannot
spend the same cue twice.

**The no-downgrade re-render was REMOVED, not kept as dormant code**, and the reasoning is recorded
at the site so it is not re-derived. Beyond being unreachable it was unsafe where it _could_ fire:
`msgThreads` is retired only by `dismissMessageNotif` (read/foreground), so a banner the user
SWIPED away — or one belonging to a signed-out account — would be re-rendered with its decrypted
preview, and re-alerted, since a wake draw carries no `messageId` to spend. On a sender-keyed id,
which aggregates several conversations of one sender, the single retained title can caption one
thread's messages with another thread's name. If the server is ever changed to name the
conversation, the downgrade becomes real and those three hazards must be fixed FIRST.

Also fixed: **F11** — the witness was evaluated ahead of the `notifierRunning && !muted`
short-circuit, spending a bounded wait of Doze budget on wakes that cannot draw anything.

**MR-11 round 3, from the same pass.** **F8:** the hook's deferred unread-clear gated on
`AppState.currentState === 'background'` — the exact reading this work had just rejected as
unreliable for the pin, one screen over. On a notification cold launch it reads stale-`'background'`
while the user is reading, so the badge for the chat on screen would never clear. It now uses an
OBSERVED transition, the same rule as the notifier. **F9:** a `conversationId` change under a live
screen re-ran the deferred clear with the gate already open; it is now spent once per thread.

**Rejected with reasons.** **F6** (`isBackgrounded()`/`foregroundUi` still read the raw state) is a
PRE-EXISTING gap, not a regression of this change — before it, other conversations already
bannered in that window — and widening the confirmed-background rule to the whole notifier is a
larger behavioural change than the evidence supports. Recorded as **residual MR-10a**.
**Residual MR-10b:** the honest fix for this whole class is server-side — put the conversation on
the wake, or skip the wake when `deliveredNow` — and both need the dead-socket question answered
first (a "connected" socket under Doze can be an fd that delivers nothing).

Pins reworked accordingly: the burst case (`ONE cue answers ONE wake`) is the load-bearing one, plus
sender scoping, the in-window claim, and the failure veto. The old
"a-cue-just-before-suppresses-the-duplicate" test was **decorative** — it forced the witness's
return value, so it passed on unfixed code — and was replaced with one that pins the sender
actually being passed. The downgrade test became `DOCUMENTS B-703 MR-10`, pinning that the two ids
differ and stating what it must become if the server ever names the conversation. Mutation proven
RED: the token never spent.

### MR-8 — HALF FIXED (2026-08-30), half ESCALATED. The burn now reaches the shade.

MR-8 has two halves and they are not the same kind of problem.

**FIXED — the broader class, and the more serious one.** `removeMessage` / `clearMessages` /
`removeConversation` / the expiry sweep never dismissed a posted banner: dismissal keyed ONLY on a
`deleted_for_all` flip and on thread activation. But the disappearing-message sweeper does not
tombstone — it DELETES the row. So every TTL message that expired unread left its decrypted
**preview** sitting on the lock screen indefinitely: the one surface the burn never reached, and
exactly what disappearing messages exist to prevent.

The notifier now dismisses a conversation's banner when rows it previously held are GONE (not
tombstoned — actually absent). Placement is load-bearing: the check runs **before** the
`list.length === 0` bail, because the case that matters most is a conversation whose ONLY message
just burned, and bailing on the empty list first is precisely what left that preview on screen.
Scoped to `postedConvos` so it only cancels banners this module owns, and it accepts the same
collapse trade the retraction path already documents — a sibling message's banner can go with it,
which is the correct direction to fail in when the alternative is leaving burned plaintext on a
lock screen.

Pinned in `backgroundMessageNotifier.test.ts`: the last-message (empty-list) case, the
one-of-several case, and no dismissal for a conversation this module never bannered. Mutation
proven RED: the destruction branch disabled.

**ESCALATED — the burn TIMING.** The other half is that the receive gate admits a payload up to
`expiry + 5 min` (`EXPIRY_CLOCK_SKEW_GRACE_MS`, B-316, absorbing sender/receiver clock skew) while
the sweeper burns at `expires_at <= now` with **no** grace — so a message admitted on the strength
of that grace is destroyed within one sweeper tick, and a tap ten seconds later opens an empty
chat. The audit proposes "give the sweeper the same grace", and that is **not** a change to make
unilaterally: it delays EVERY disappearing message's burn by five minutes, which is a change to the
product's disappearing-message guarantee, and CLAUDE.md lists disappearing-message behaviour under
Security constraints with an explicit _"do not invent security behavior"_.

The likelier-correct shape is not a blanket grace either — it is to give an admitted-late message a
minimum readable lifetime (burn at `max(expires_at, arrival + floor)`), or to re-base the timer
locally at receipt, which is closer to how Signal specifies it. Both change when a message
disappears. **Founder/architecture decision, not a bug fix** — recorded as the open half of MR-8.

### MR-16 — client half FIXED (2026-08-30). A stuck tick gets another chance.

A WS-submitted 1:1 opens **no server receipt slot** — the slot is created only when
`submitEnvelope` is given an `input.receipt`, and the gateway passes none. So the sender's poll
answers `'unknown'`, and `httpReceiptReconcile` recorded that id in a memo that was **permanent for
the session**. The delivered frame is the only other route to ✓✓, and its REPLAY emit is
fire-and-forget-then-delete — so losing that one frame left the bubble at a single tick until the
app was restarted, healed only by a read receipt arriving later. That is the founder's "the double
tick doesn't work; it only shows when the other person opens the messenger", exactly.

The memo now **decays instead of latching**: an `'unknown'` cools down for 5 minutes, is retried,
and gives up after three attempts. The memo still does its original job — re-asking every 60 s
forever would burn the 100-probe budget on envelopes that genuinely have no slot — but a slot that
appears later (a redelivery, or a server that starts recording them) is now picked up instead of
being permanently unaskable. Bounded at 500 entries.

Pinned in `httpReceiptReconcile.test.ts`: skipped inside the cooldown, re-probed after it, a later
`delivered` actually settling the tick, and the latch after a bounded number of tries. Mutation
proven RED: the skip made permanent again.

**Residual MR-16a — the real fix is server-side.** The client can only re-ask; it cannot create the
slot. Opening a receipt slot for WS submits (or wiring the delivered frame's replay to a durable
ack rather than emit-then-delete) is what actually settles these ticks first time, and it is an
`apps/messenger-service` change plus a deploy. Recorded, not attempted here.

### MR-26 — ATTEMPTED and REVERTED (2026-08-30). Deliberately deferred.

The modular RNFB messaging API exists (`@react-native-firebase/messaging/lib/modular`, v21.14.0)
and the migration of the five repeatedly-called sites — `getToken`, `requestPermission`,
`onTokenRefresh`, `onMessage`, `registerDeviceForRemoteMessages` — is mechanical and typechecks
clean at baseline. It was reverted anyway.

Every FCM suite mocks `@react-native-firebase/messaging` with a **default export only**, so the
named modular functions come back `undefined` and eight suites across the notification lane went
red. Making them green means rewriting the mock in each of them — the same notification-test
harness this session has been repeatedly re-pointing, immediately before a release, in exchange for
**a deprecation warning in logcat**. That is the wrong trade.

What the work needs when it is done properly: update the messaging mock in every suite that has one
to export the modular functions alongside the default, then migrate the call sites. Leave
`setBackgroundMessageHandler` on the namespaced form regardless — it is registered at MODULE SCOPE
and its registration order is load-bearing (it overrides the headless handler whenever the app is
warm, B-703 MR-5), and one warn at module load is not worth disturbing that.

### MR-13 — FIXED (2026-08-30). The stomp that pinned a session invisible.

`configureRuntimeFromPersisted` checked "is a runtime already configured?" once, at entry — and
then everything between that check and the write is **awaits**: an AsyncStorage read, a keychain
probe, and a store-hydration wait of up to 3 s. An INTERACTIVE session can configure itself inside
that window, and on a **cold notification tap it does so by construction** — `startTapTimePull` and
MainNavigator's own configure are racing from the same user action. Same for wake-then-quick-open.

The loser of that race was the user: `backgroundBoot: true` is written over the interactive config,
and that flag makes the socket presence-invisible and sync-suppressed on purpose (B-354, so a
killed-app wake does not light the user up as "Active now"). MainNavigator does not configure
again, and no AppState path re-asserts it — so the session stays presence-`'away'` and invisible
for its entire life, healed only by a process restart. Symptom: _"my peer never shows online after
I open the app from a notification."_

The check is now repeated immediately before the write. It answers `true`, because the caller asked
whether a usable runtime is configured and one is — a better one. One guard covers both racing
callers (`headlessDrainAndNotify` and `ensureRuntimeForNotifAction`), since both funnel here.

Pinned in `headlessDrainNotify.test.ts` — the owner key reads null at entry and non-null after,
which is precisely the shape the entry-only check cannot see (the existing "already configured"
test passes with or without the fix, so it could not have caught this). Mutation proven RED: the
re-check removed.

### MR-14 — FIXED (2026-08-30). A newborn room is not an absent one.

Every UUID-keyed local conversation missing from **one** `/conversations/mine` response was removed
with its messages, its media blobs and its group master key, and its id tombstoned durably. The
envelopes had already been acked, so nothing remains to redeliver: it is permanent data loss,
triggered by a single stale list response and with no age, unread or pending guard anywhere in the
path.

The exposed population is precisely the SERVER-minted rooms — mission Ops Rooms, system channels —
because client-minted groups are dashless 32-hex and can never match `UUID_RE`. Those are also the
rooms that arrive by **fan-out** rather than by this list, so a snapshot taken before the server
committed the room, landing after its fan-out reached this device, describes a room the server has
and the response does not. That is the whole race, and it is narrow — but its outcome is
unrecoverable, which is the wrong pairing.

A ten-minute grace now stands between the match and the destructive calls. It costs one extra list
round-trip to converge on a room that really was deleted, and buys back the only case where being
wrong cannot be undone. A conversation with **no parseable creation time counts as new**: absent
evidence must not authorise an irreversible write, so the fallback is `0` (brand new), never
`Date.now()` (infinitely old).

Pinned in `homePruneGuard.test.ts` — a comment-stripped, CRLF-safe source scan (the screen mounts RN
views and pulls the whole runtime). It asserts the prune still runs and is still UUID-gated, that
the age check sits **between** the match and both destructive calls (a guard after
`removeGroupState` has already destroyed the key it was meant to protect), the unparseable-time
fallback, and the size of the grace. Mutation proven RED: the guard removed.

### MR-17 — FIXED (2026-08-30). The placeholder that never went away.

The killed-lane "Checking for new messages…" row is drawn by `fcmHeadless` and cancelled ONLY
inside that same handler. A VM Android freezes mid-drain strands it: no full app boot and no
foreground ever cancelled it, so it sat in the shade until the NEXT wake happened to repost the
same fixed id. A permanent "Checking for new messages…" is a worse lie than no row at all — the app
is open, and there is nothing left to check.

It is now retired on a WARM notifier start and on every foreground (alongside `cancelAllPosted`,
which already ran there). The HEADLESS notifier deliberately does not: it starts alongside the drain
that legitimately owns the placeholder, and cancelling there would erase the row that drain has just
drawn. Pinned all three ways in `backgroundMessageNotifier.test.ts`; mutation proven RED.

**A scan re-point worth recording.** `missionOpsRoomStaticScan`'s M3 slices the prune loop with a
**1100-character window**, and MR-14's guard pushed `removeGroupState` past the end of it — the scan
went red while the rule it owns was untouched. A character budget is not a scope: every comment
added inside that loop silently shrinks what is covered, and the fix each time is a bigger number
that pins less. It is anchored on the structure now (the `catch` that closes the effect body). Same
family as the MR-6 proximity re-point earlier in this log.

---

## 10. Where B-703 stands (2026-08-30)

**Fixed, each with mutation-proven pins and an adversarial critic pass:** MR-1 (P0), MR-2/MR-3,
MR-4, MR-5, MR-6, MR-7, MR-8 (banner half), MR-9, MR-10, MR-11, MR-12, MR-13, MR-14, MR-16 (client
half), MR-17, MR-19.

Every symptom the founder named is addressed on at least one lane: _notifications not live_ (MR-1,
MR-10, MR-11, MR-19), _the message is in the notification but not in the chat_ (MR-2/MR-3),
_tap-to-retry_ (MR-4, MR-6, MR-12), _duplicates_ (MR-7, MR-10), _the double tick_ (MR-5, MR-16),
_boot_ (MR-12, MR-13).

**Escalated — decisions, not bug fixes.** The MR-8 burn TIMING (changes the disappearing-message
guarantee; CLAUDE.md puts that under Security constraints), MR-9a (a key-arrival re-send sweep
changes B-683 semantics), and the four standing arch-gated items §8 already lists: sealed-sender
receipt identity (OM-03), the identity-regen time-bomb, the M4 call-key namespace, reaction AAD.

**Server-side, needing a deploy:** MR-16a (open a receipt slot for WS submits, or make the
delivered replay durable instead of emit-then-delete), MR-10b (name the conversation on a chat
wake, or skip the wake when `deliveredNow` — both blocked on the dead-socket question), MR-22, MR-27.

**Open client-side tail, deliberately not attempted this pass:** MR-15 (deleted-thread replay
rows + banners), MR-18 (1-row conversations re-bannering per killed wake), MR-20 (the AppState-
`'unknown'` watermark bail — a recorded B-692 F5 decision), MR-21 (flag-gated recovery lane, needs a
live trace), MR-23 (platform/permission state — device verification, not code), MR-24 (M12
direct-slot residue), MR-25 (hypotheses with no repro), MR-26 (attempted and reverted — see above).

**Still owed, and unchanged by any of this: the device pass.** `[NOTIFLAT]` and `[NOTIFHEALTH]`
have never been read off a phone. Every fix here is reasoned from source and pinned in tests; §7 is
the protocol that turns that into evidence.
