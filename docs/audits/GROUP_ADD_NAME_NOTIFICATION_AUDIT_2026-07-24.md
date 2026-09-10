# Group Add-Member Approval · Unsaved-Number Display · Notification-Surface Audit — 2026-07-24

**Type:** audit only — **no src code changed.** Fixes are the founder's to schedule.
**Trigger:** founder session (2026-07-24). Two asks + a device capture:

1. **Group add → approval.** "When any member wants to add someone it should go for approval
   (added only after an admin approves)." Plus: "when a number I didn't save, it shows a **code**
   instead of a name."
2. **Notifications.** "Write all notification tests, run them, and report any failures in the .md
   (I'll fix afterwards). Also check the user can redirect from a notification to **call / answer /
   send message**."
3. **(mid-session) Group-call capture** — see §5 and the B-236 entry in `sqa.md`.

**Method:** 26-agent workflow (3 audit lanes → adversarial verify each finding → completeness
critic → 7 test writers, one file each). Every finding below was refuted-tested by a second agent;
`verdict` = the survivor. Line numbers rot (this repo grows ~140%/8wk) — **re-grep the symbol.**

**Bug numbers assigned:** **B-221 … B-236** (see `sqa.md` for the table row). Latest prior was B-184.

**Gates run this session:** `messenger-crypto` **294 suites / 2902 tests green, run twice** (flake
rule, identical) — includes the 7 new suites. `tsc` **47 = baseline**, no new-file errors. The 7
new test suites are GREEN because each broken behavior is pinned as a `DOCUMENTS PENDING(...)` test
of the _current_ behavior with a comment stating what the assertion must become on fix (CLAUDE.md
bug-regression contract — a bug is not fixed until a RED-first test would catch it, and we never
land a red test for a bug we are not fixing this session).

---

## 1. Group add-member permission model (asks #1)

### Current model — verified end-to-end

Adds are **admin-only at every authoritative layer**, and in the E2EE layer "admin" means **exactly
the group creator** (`makeNewGroup` marks only the owner `admin:true`; **no promote action exists**
in the wire union).

| Layer                | Enforcement                                                                                            | Evidence                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client send gate     | `addGroupMember` throws `NOT_ADMIN` for a non-admin                                                    | `productionRuntime.ts` `addGroupMember` (~:4754, throw ~:4766) — in force since `a88e9de` (2026-05-24)                                                                                                     |
| Receiver admission   | `applyAdminAction` **silently no-ops** any non-admin add/remove/rekey/rename + `atEpoch===epoch` guard | `packages/messenger-core/src/groups/groupClient.ts:483-489`. The `senderIsMember/senderIsAdmin` block in `applyGroupAdmin.ts:386-392` is **telemetry only** — computed _after_ the reducer already dropped |
| Server roster        | `POST /conversations/:id/members` → `requireAdmin` (403 for non-admins)                                | `apps/auth-service/src/conversations/conversations.service.ts` `addMember` (~:168, guard ~:328); dept channels `department.service.ts:396`                                                                 |
| Local-derived groups | non-UUID sha256 group ids **never touch the server**                                                   | `pendingRosterIntents.ts:46-50` `isServerBackedConversationId` — so for founder-created groups enforcement is **100% client E2EE**                                                                         |

**The live screenshot ("Corné Breytenbach UAE added Member 613949", no approval step) is this model
working as coded.** The receive-side system bubble is appended only when the add _applied_
(`applyGroupAdmin.ts:428`), so the actor held `admin:true` on observers' devices — i.e. Corné is
that group's **creator / sole E2EE admin**. **No bypass exists:** there is no path for a non-member
or removed member to add anyone (that security class was searched and found closed).

### The gaps

- **B-221 (P1, ARCH-GATED) — no request/approval mechanism exists anywhere.** `GroupAdminAction`
  is `create | add | remove | rekey | rename | leave | key-request` — no request/approve/pending
  variant (`packages/messenger-core/src/groups/types.ts:99`). Repo-wide greps for
  `approval|join_request|pending_member|membership_request` across `src/`, both `apps/*/src`, and
  `packages/messenger-core/src` return **zero** group-membership hits (all matches are booking/KYC/
  attendance). The two "pending" stores are **not** approval: `pendingAdminActionStore.ts` is an
  out-of-epoch-order replay stash (max 3 attempts, auto-replayed); `conversation_membership_intents`
  (RS-02) is a **post-authorization** key-distribution seam — the intent is enqueued only _after_
  `requireAdmin` passed, and `drainConversationIntents` auto-executes every row fire-and-forget on
  MessengerHome focus with **no human step**. Every authorized add is therefore one uninterruptible
  `add@E → rekey@E+1 → master-key-delivery` sequence.

- **B-222 (P2) — the Add UI is shown to every member and dead-ends at a runtime alert.**
  `ChatInfoScreen.tsx:228` hardcodes `isAdmin = isGroup`, so **every** group member sees "Add
  member", taps through to `NewChatScreen`, and hits a runtime `Alert` (`NewChatScreen.tsx:259/:310`)
  when the send gate throws `NOT_ADMIN`. The **real** `isGroupAdmin` flag (`ChatInfoScreen.tsx:233`)
  gates only _removal_ (`:851`). **This is exactly where the approval request entry point belongs.**

### Where an approval flow would hook (design only — DO NOT IMPLEMENT WITHOUT ARCH SIGN-OFF)

> Group master-key distribution is a **CLAUDE.md stop-condition.** The security-critical constraint:
> **the rekey and master-key delivery must happen only at approval time**, never when the request is
> raised — otherwise the invitee holds the group master key before any admin approved.

1. **Client UI (B-222 fix):** branch `ChatInfoScreen` on the _real_ `isGroupAdmin`. Admin keeps the
   picker; non-admin gets a "request to add" composer.
2. **Transport:**
   - **Local (non-UUID) groups** have no server roster, so the request must ride the E2EE admin lane
     as a **new inert action** (e.g. `{type:'add-request', member, atEpoch}`) modeled on
     `key-request` inertness — it **must be a pure no-op in `applyAdminAction`** so a forged/replayed
     request can never mutate state; surface it as pending UI only on the admin's device.
   - **Server-backed (UUID) conversations:** extend `conversation_membership_intents` with a
     `state='awaiting_approval'` and allow a non-admin POST that _only records_ the request. ⚠️ the
     current drain would auto-execute any pending row — the state machine **must** distinguish
     _requested_ vs _approved_ before `listMembershipIntents` returns it.
3. **Rekey timing (security-critical):** only at **approval** does the approving admin's device run
   the existing `addGroupMember` so the add broadcast + `rekey@E+1` + `reshareGroupKeyState`
   (`productionRuntime.ts:~4949`, the invitee's first sight of the master key) all fire _then_.
4. **Authority (B-221/P3 sub-issue):** E2EE state has **one** admin (the creator; no promote
   action) while the **server** roster can promote — so a server-promoted admin's approval would
   fail `NOT_ADMIN` in the E2EE layer, and such intents already churn forever in
   `drainConversationIntents`. The design must **pick its authority**: either route approvals to the
   E2EE owner, or spec a signed `promote` action first. Fold this decision into the B-221 design.

---

## 2. Unsaved number shows a code instead of a name (asks #1, part 2)

"Member 613949" is `resolveMemberName`'s last-resort `` `Member ${userId.slice(0,6)}` ``
(`groupEventMessage.ts:48`). The founder wants WhatsApp parity: an unsaved contact shows their
**phone number**, never an opaque code. The audit found the code-fallback on **9 surfaces** and two
distinct root causes.

- **B-223 (P1) — the live one.** The group "added/removed/left" system bubble **bakes**
  `Member <6hex>` into the _persisted_ message content (`groupEventMessage.ts:48,74`). It consults
  neither `directoryNames`/`groupMemberNames` nor contacts before falling back, and — being stored
  content — it is **never backfilled** when the name later arrives. That is the exact
  "Member 613949" text.
- **B-224 (P1) — the root cause behind most surfaces.** `/conversations/mine` **already delivers
  every member's registered `displayName`**, and the client **discards it for group members**
  (`MessengerHomeScreen.tsx:~211`). Wiring that payload into `directoryNames` would fix the majority
  of the surfaces below at the source.
- **B-225 (P1, ARCH-GATED) — no phone source for arbitrary co-member userIds.** The client never
  holds a phone number for a co-member it didn't discover through its own contacts (`DEV_CONTACTS` +
  registration discovery only). Showing a phone number WhatsApp-style would require the server to
  expose phone numbers keyed by userId — **sealed-sender metadata protection is a stop-condition**,
  so this needs architecture review, not a client patch. **Practical near-term:** B-224 (show the
  registered _display name_) covers the real complaint for every registered user; the raw _phone
  number_ fallback for the truly-unknown case is the arch-gated part.
- **B-226 (P2/P3 umbrella) — raw-userId / `Bravo · <hex>` placeholder codes leak on 7 more
  surfaces.** Each falls back to `userId.slice(0,8)` (or the full id) with no backfill trigger:

  | Sub | Sev | Surface                                          | Fallback                                                                                                       | File                               |
  | --- | --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
  | a   | P2  | ChatInfo member list                             | `userId.slice(0,8)`; phone column reads `DEV_CONTACTS` only — ignores the `directoryNames` it itself populates | `ChatInfoScreen.tsx:86`            |
  | b   | P2  | Incoming-call CallKit / lock-screen label        | `userId.slice(0,8)`, one-shot, never backfilled                                                                | `MainNavigator.tsx:527`            |
  | c   | P2  | MessengerHome row title                          | full raw userId / conv id; `Bravo · <hex>` placeholders surface as titles                                      | `MessengerHomeScreen.tsx:695`      |
  | d   | P2  | Message-notification title / group banner sender | can be the `Bravo · <hex>` placeholder; group sender ignores `directoryNames`                                  | `backgroundMessageNotifier.ts:227` |
  | e   | P3  | Group typing label                               | `id.slice(0,8)`; nothing on the typing path backfills                                                          | `chatScreenLogic.ts:118`           |
  | f   | P3  | Group "Read by" modal                            | `id.slice(0,8)`, no backfill                                                                                   | `ChatScreen.tsx:1686`              |
  | g   | P3  | Group bubble sender label                        | `senderId.slice(0,8)`; `phoneE164` never used as an intermediate fallback                                      | `ChatScreen.tsx:2609`              |

  **Common fix shape:** a single name-resolution helper `directoryName(id) ?? phoneE164(id) ??
Member/shortId`, fed by the B-224 payload, called from all 7 sites — and B-223 must resolve at
  _render_ time (or re-resolve on backfill) rather than baking the string.

---

## 3. Notification-surface inventory

Eight producers (5 messenger, 3 non-messenger listed for completeness). Full per-type table with
producers, channels, tap handlers and action buttons is in the workflow result; summary:

| Notification                                                             | Producer                                                                                                  | Tap / actions                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Incoming-call ring** `bravo-call-<id>`                                 | `callNotification.showIncomingCallNotif` ← fcm voip-wake / headless; parallel Telecom via `callKitBridge` | Body/full-screen → `fcmBootstrap.handle()` call branch → `CallScreen{autoAccept:false}`; **Answer** → `autoAccept:true` + latch; **Decline** → `call.hangup{declined}` or durable enqueue; Telecom Answer/End/mute mirrored |
| **Message banner** `bravo-msg-<conv>`                                    | `showMessageNotif` ← `backgroundMessageNotifier.post` (warm, M16 post-commit) / fcm fallback / headless   | Body → `Chat{conversationId,name,isGroup,initial:false}`; **Reply** (RemoteInput) warm=`sendText`, killed=enqueue+"will send"; **Mark read**                                                                                |
| **Missed-call** `bravo-missed-<id>`                                      | `showMissedCallNotif` ← fcm call-cancel / headless / `callDispatcher` WS                                  | Tap → `handleMissedCallTap` → caller 1:1 `Chat` (else `CallsLog`); call-back via ChatScreen header buttons                                                                                                                  |
| **Server-wake** (booking/agent/mission/SOS/dispatch/incident)            | `serverWakeNotifications.showServerWakeNotification`                                                      | `routeServerWakeTap` kind→screen map; **NON-MESSENGER, out of scope**                                                                                                                                                       |
| **Ongoing-call FGS**                                                     | native `CallForegroundService.kt`                                                                         | **Hang up** action → `callForegroundService.ts` hangup                                                                                                                                                                      |
| CallKeep/Telecom FGS · Mission-tracking FGS · iOS banner/VoIP (skeleton) | —                                                                                                         | informational / out of scope / iOS lane inert (no PushKit cert)                                                                                                                                                             |

### Redirect paths (the founder's three)

| Path                                               | Status                               | Note                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) message notif → chat → send**                | ✅ **works**                         | `Chat{conversationId,name,isGroup,initial:false}` (B-54/B-85 fixes present); ChatScreen self-heals the name and guards undefined initials                              |
| (a-degraded) killed GROUP tap, or cold launch > 8s | ⚠️ **partial**                       | killed group wake with no convId lands on MessengerHome; and the msg-wake nav wait is **8s** vs 20s on the call path (**B-227**)                                       |
| **(b) answer call from notif**                     | ⚠️ **partial** (statically complete) | NA-01 field-merge + `resolveIncomingCallRoute` restore the SDP; B-102 latch, NA-02 dead-offer watchdog all present. "Partial" = **unverifiable-static** (needs device) |
| **(c1) decline from notif**                        | ✅ **works**                         | rich + slim + durable-enqueue lanes wired; server `POST /calls/:id/decline` from the 2026-07-10 remediation                                                            |
| **(c2) missed → tap → call back**                  | ⚠️ **partial**                       | tap handler deep-links the caller thread, BUT the **warm** producers omit `fromUserId` so the tap degrades to CallsLog (**B-229**)                                     |

### Known-bug status in the current tree (verified)

**Fixed:** B-53, B-54, B-62, B-63, B-64, B-65, B-66*, B-67, B-69, B-70, NA-01, NA-02.
**Partial:** B-55 (bell sync), B-56 (smoothness cluster). **Open:** B-68 (process dies holding call
FGS mid-video-call). *B-66 has a residual — the incoming-call ring card is still legacy blue (**B-232**).

---

## 4. Notification tests written (7 suites) + the failures they pin

All 7 are GREEN. Where a behavior is broken, the test **pins the current behavior** under
`DOCUMENTS PENDING(<slug>)` with the flip-instruction in a comment. **10 pins across 6 bugs**, plus
4 clean suites' worth of correct-behavior regression locks (`pushNavigateParamSweep` needed **zero**
pins — the core B-54/B-85 param contract is healthy and now behaviorally locked).

| Bug       | Sev | Pin slug                                                 | Suite                     | What it pins → what it must become                                                                                                                                                                                                                                                                           |
| --------- | --- | -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B-227** | P2  | `msg-wake-8s-nav-window`                                 | `notifTapNavContract`     | msg-wake body-tap waits **8s** then `navigate()`s a non-ready ref (silent no-op) → cold launch >8s (P1-BR-2 measured 10–25s) drops the Chat deep-link. **Fix:** 20s + post-loop `isReady()` re-check like the call path                                                                                      |
| **B-228** | P2  | `rich-decline-cold-cache`                                | `callNotifActionContract` | rich notifee **Decline** with empty in-memory cache = "dismiss only" → caller **rings out 45s**, even though `data.fromUserId` is present. **Fix:** fall back to `data.fromUserId`, send hangup / enqueue                                                                                                    |
| **B-229** | P2  | `warm-call-missed-fromuserid` + `warm-hangup-fromuserid` | `missedCallCallbackLane`  | `callDispatcher` `call.missed` (~:227) **and** hangup-while-ringing (~:326) call `showMissedCallNotif` **without `fromUserId`** (in scope both times) → missed-call tap can never deep-link the caller thread (degrades to CallsLog). **Fix:** pass `fromUserId`                                             |
| **B-230** | P3  | `missed-call-blind-navigate`                             | `notifTapNavContract`     | `handleMissedCallTap` navigates on a dead ref after its 20s window expires un-ready (lacks the post-loop bail `navigateToIncomingCall` has). **Fix:** re-check `isReady()` + bail/defer                                                                                                                      |
| **B-231** | P3  | `killed-badge-gap`                                       | `msgWakeWarmBannerRules`  | all three FCM-lane message draws omit `badgeCount` (only `backgroundMessageNotifier.post` passes it) → launcher badge goes stale when killed/notifier-down. **Fix:** headless-readable unread mirror, _or_ formally accept the N-17 omit-when-unknown trade-off                                              |
| **B-232** | P3  | `ring-card-legacy-blue`                                  | `callNotifActionContract` | incoming-call ring card hardcodes `#1E88FF` while every sibling site uses `NOTIF_ACCENT #5B8DEF` (B-66 residual, G8 design-system deviation). **Fix:** `NOTIF_ACCENT`                                                                                                                                        |
| **B-233** | P3  | `slim-missed-dismiss-id`                                 | `missedCallCallbackLane`  | slim bundle handler's missed-call tap calls `dismissCallNotif(callId)` → cancels `bravo-call-<id>` (gone), never `bravo-missed-<id>`. Harmless **only** because `showMissedCallNotif` keeps default `autoCancel` (a companion static test pins that precondition). **Fix:** recognise `kind==='missed-call'` |
| **B-234** | P3  | `wake-notifee-data-string-cast`                          | `serverWakeTapRouting`    | AGENT_WAKE_META display hands the raw payload to notifee via bare `as Record<string,string>`; a nested-object value (real on the iOS lane) **rejects the whole banner** inside the try/catch → nothing draws. **Fix:** string-filter the payload like the call-cancel path                                   |
| **B-235** | P3  | `burst-bound-mass-reset`                                 | `msgBannerDismissBadge`   | `shouldAlert` `clear()`s the whole 500-entry map at the bound → every in-flight 10s burst window forgotten → a just-alerted id re-alerts (heads-up+sound) inside its window. **Fix:** evict expired/oldest, never `clear()` wholesale                                                                        |

### Also surfaced by the writers/critic (triage, not pinned as bugs)

- `handleMissedCallTap`'s CallsLog fallback navigation omits `initial:false` (both Chat deep-links
  have it) — cosmetic nav-stack nuance.
- `fcmBootstrap.ts` has its **own** duplicate `ensureMessagesChannel` `createChannel` (BS-MSG1)
  alongside `callNotification.ts`'s — two sources for one channel config, drift risk.
- `showIncomingCallNotif`'s `timeoutAfter` is a hardcoded `45_000`, **not** a reference to
  `incomingRingtone.RING_TIMEOUT_MS` — card auto-dismiss vs native ringtone auto-stop can drift.
- Slim-handler group decline defaults `roomId` to `callId` when `data.roomId` absent — only the
  roomId-present path is pinned; worth a look from the call-lane owner.
- `dismissMessageNotif`'s single try/catch wraps the whole sequential cancel loop, so one rejecting
  `cancelNotification` aborts the remaining cancels (member sender-keyed banners could leak on a
  partial failure) — robustness, needs fault injection to test.

**New test files (all under `src/modules/messenger/__tests__/`):** `notifTapNavContract.test.ts`
(15), `callNotifActionContract.test.ts` (20), `msgWakeWarmBannerRules.test.ts` (15),
`missedCallCallbackLane.test.ts` (17), `serverWakeTapRouting.test.ts` (15),
`pushNavigateParamSweep.test.ts` (18), `msgBannerDismissBadge.test.ts` (15). **115 tests total.**
All are static source scans or mock-isolated unit tests (the push modules transitively import
react-native/firebase and cannot load raw in the node `messenger-crypto` project) — comment-stripped,
CRLF-safe, per the repo's static-scan conventions.

---

## 5. Group-call device capture (mid-session) → B-236

Founder connected a Pixel 6a (v1.0.131/vc159) and reproduced the group "no sound" complaint. Full
native WebRTC/audio timeline captured to `bravo_groupcall_log_110924.txt` (repo root, 18 min, 3
calls). **JS logs do not reach logcat in this release build (routed to Firebase) and the SFrame
native module is silent — the native audio layer is what was read.** Full analysis + the pending
confirmation step (Bluetooth-off retest, cut short when the cable was unplugged) is in the **B-236**
entry in `sqa.md`. Headline: **every call's audio was routed to a connected Bluetooth device
(Stone 620 / realme Buds), and `setSpeakerphoneOn(true)` did not override the active SCO route** —
the likely "no sound" root cause on the founder's device, plus a suspected dead in-call speaker
toggle. Confirmation pending.

---

## 6. What is NOT done

- **No fixes applied.** Every B-221…B-236 is investigation/pinned-only, per the founder's "I'll fix
  afterwards."
- **B-221 / B-225** are **architecture-gated** (group master-key distribution; sealed-sender phone
  metadata) — flagged for sign-off, **not** to be implemented unilaterally.
- **Redirect path (b) answer-from-notification** is statically complete but **device-unverified**;
  (a-degraded) and (c2) are the two real partials (B-227, B-229).
- **B-236** needs the Bluetooth-off retest to confirm.
