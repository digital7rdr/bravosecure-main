# Unsaved-Contact Notifications, Missing Notifications, and the Workspace Hub

**Date:** 2026-08-09 · **Reported by:** founder · **Status:** Rev 2 (critic round 1 applied) → fixes land same session
**Bugs:** B-411 (unsaved sender shows internal code), B-412 (notifications sometimes never arrive),
B-413 (workspace invite dead-end — "another admin invites me, I can't join")
**Feature:** F-WSHUB — Discord/Slack-style workspace list page

All file:line references verified against main @ `4db66b6a` + the current working tree on 2026-08-09.

---

## 1. B-411 — Incoming message from an unsaved number shows an internal code

### 1a. Symptom

A message from someone not in your phone contacts shows a notification titled with the internal
placeholder — e.g. **`Bravo · a1b2c3d4`** — instead of the person's name. Wanted behavior:

| Sender state                              | Notification title       |
| ----------------------------------------- | ------------------------ |
| Saved in device contacts                  | `John Doe`               |
| Not saved, Bravo profile name known       | `John Doe · Unsaved`     |
| Not saved, only their phone number known  | `+8801711…` (the number) |
| Nothing known yet (first-contact instant) | `New message` (generic)  |

Internal identifiers (`Bravo · <8hex>`, bare `userId.slice(0,8)`) must never reach a
notification — **or any other user-facing surface** (chat list, chat header — see §1e).

Reachability note (honest scoping): the "phone number" row is reachable only for chats that
started from a by-number search or a discovered contact whose address-book entry was later
deleted — an **inbound stranger's phone is never known** (the profile endpoint deliberately
returns no phones — `packages/messenger-core/src/transport/usersClient.ts:24-28`), so a
killed-app banner for a first-ever contact is the generic row, upgrading to
`Name · Unsaved` once the app has been opened once.

### 1b. Root cause (verified)

There is no "user code" feature — the code the founder sees is the **placeholder conversation
name** leaking into notification titles:

1. The placeholder is minted when a stranger first messages you (or calls you cold):
   - `src/modules/messenger/store/messengerStore.ts:546-563` — `directPlaceholderConversation()`
     → `` name: `Bravo · ${peerId.slice(0, 8)}` `` (callers: `callDispatcher.ts:175`,
     `MainNavigator.tsx:737-750`)
   - `messengerStore.ts:882-903` — inline shadow-create on first inbound envelope (same format)
2. Every notification lane titles the banner from `conversations[cid].name` (the persisted vault):
   - Store notifier (warm): `src/modules/messenger/push/backgroundMessageNotifier.ts:247-309`
   - Killed/headless: `src/modules/messenger/push/fcmHeadless.ts:214,220` — titles come from
     **`mutedLookup.ts`** resolvers (`resolveConversationMeta` `:174-186`,
     `resolveDirectConversation` `:141-158`), which read the persisted vault
   - Warm-background fallback: `src/modules/messenger/push/fcmBootstrap.ts:2174-2191` (same
     two mutedLookup resolvers)
   - Single display call: `src/modules/messenger/push/callNotification.ts:304,319,333`
     (`showMessageNotif`, `title: p.title || 'New secure message'`)
3. The upgrade sweeps that replace the placeholder with a real name only run while the app is
   open. `useRegisteredNames.ts:38-70` DOES persist its result (it writes `conv.name`), so a
   row whose sweep ever ran shows a real name even killed — **B-411 reproduces for rows whose
   sweep never ran** (message arrives while killed, user taps away before Home mounts, or the
   profile fetch failed). The session `directoryNames` map is deliberately not persisted
   (`messengerStore.ts:1745-1818` partialize), so the killed lane cannot consult it.
4. `backgroundMessageNotifier.ts:262` already special-cases the `Bravo · ` prefix (B-226) and
   falls back to the session `directoryNames` — but it never tags "Unsaved", and when
   `directoryNames` is cold it re-emits the placeholder.

**Why it happens (plain English):** this is an end-to-end-encrypted messenger. The server
deliberately does not know or send who a message is from in a readable form — the push that
wakes your phone carries no sender name at all
(`apps/messenger-service/src/push/push.service.ts:752-774`, data-only payload; the gateway
comment at `apps/messenger-service/src/gateway/messenger.gateway.ts:1285-1286` states this
contract). So the phone must look the name up locally. It has three books to look in: your
device contacts, the sender's Bravo profile name, and — if both are missing — a placeholder
it invented. The bug is that the placeholder was designed as an internal bookmark ("go fetch
the real name later"), but the notification code shows the bookmark itself, and the
killed-app path can't run the "fetch" step.

### 1c. Fix design — one resolver + one STICKY persisted flag

The precedence documented at `useRegisteredNames.ts:15-18` (custom name > address-book name >
registered profile name > placeholder) stays exactly as-is; we make the _provenance_ of the
current name explicit, persisted, and **survivable across row rebuilds**, then render from it
consistently.

**1c.1 — The flag, and why it must be sticky in the store.**
New field `name_source?: 'custom' | 'contact' | 'profile' | 'placeholder'` on
`LocalConversation` (`src/modules/messenger/store/types.ts`, beside `is_custom_name`).

`upsertConversation` (`messengerStore.ts:654-665`) is a **full replace, not a merge** (B-247
comment; `groupConversationUpsert.ts:23-26` exists because this already clobbered local-only
fields once). Sites like the `/conversations/mine` sync
(`MessengerHomeScreen.tsx:265-282`) rebuild rows from an explicit field list on every Home
focus — any flag stamped by a sweep would be wiped within one Home visit and, because the
name is no longer a placeholder, never re-stamped. Therefore:

- **Stickiness rule inside `upsertConversation`** (the B-247 `rosterUserIds` precedent):
  when the incoming row carries no `name_source`, keep `prev.name_source` **only if
  `next.name === prev.name`**; if the name changed with no flag, clear the flag (unknown
  provenance must not inherit a stale tag). An incoming explicit flag always wins.
  **Blind spot to pin, not solve:** a future writer that spreads an old row and renames
  without restamping (`{...fresh, name: x}` — the `useRegisteredNames.ts:67` shape) carries
  the stale flag in explicitly; every current writer is covered by the census below, so pin
  the census with a comment on the `name_source` field in `types.ts` telling writer N+1 the
  rule.
- **The `:265-282` sync also silently drops `phoneE164` and `is_custom_name` today** (a
  pre-existing bug in the same class — a custom-named chat loses its protection flag on
  every Home focus until the next sweep). The sync's field list carries all three forward.

**1c.2 — Writer census (complete, from a grep of every non-test `upsertConversation(` +
direct `name` write):**

| Writer                                                                                                                                                                         | Stamp                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directPlaceholderConversation()` helper (`messengerStore.ts:546-563`) — stamp **in the helper**, covering both callers (`callDispatcher.ts:175`, `MainNavigator.tsx:737-750`) | `'placeholder'`                                                                                                                                                               |
| Inline shadow-create (`messengerStore.ts:882-903`)                                                                                                                             | `'placeholder'`                                                                                                                                                               |
| `useDiscoveredContacts.ts:201-215` address-book patch                                                                                                                          | `'contact'`                                                                                                                                                                   |
| `useRegisteredNames.ts:67` registered-name upgrade                                                                                                                             | `'profile'`                                                                                                                                                                   |
| `NewChatScreen.tsx:210` (picker row, address-book label) and `:366` (discovered row)                                                                                           | `'contact'`                                                                                                                                                                   |
| `NewChatScreen.tsx:448` (by-number search hit — the _outbound_ unsaved case; unstamped it never gets the tag)                                                                  | `'profile'`                                                                                                                                                                   |
| `ChatInfoScreen.tsx:422` `openMemberChat` (direct row seeded from a group-member name — which can be a SAVED contact's label via the member-resolution chain)                  | **no flag** (a `'profile'` stamp here could tag a saved friend — fail-safe violation; stickiness preserves any prior flag)                                                    |
| `/conversations/mine` sync (`MessengerHomeScreen.tsx:265-282`)                                                                                                                 | per-branch: `existing?.name` wins → **no flag** (stickiness keeps the old one); `displayName` branch on a new row → `'profile'`; `'Direct chat'`/`'Group'` generics → no flag |
| `restoreMessages.ts:854` (backup restore)                                                                                                                                      | no flag — old backups predate it; the fail-safe (below) renders them plain                                                                                                    |
| Group-side writers (`productionRuntime.ts:4933,5100`, `runtime.ts:848,867`, `DepartmentChatScreen.tsx:809`, `groupConversationUpsert.ts:37,90`, `applyGroupRename.ts:59`)      | untouched — "Unsaved" is a 1:1 concept; safe because of the stickiness rule                                                                                                   |

There is **no 1:1 rename UI today** (`is_custom_name` is written only by
`applyGroupRename.ts:59`), so no `'custom'` stamp site exists yet; the resolver still honors
`'custom'` and `is_custom_name` for legacy/future rows.

**1c.3 — The resolver** — new `src/modules/messenger/contacts/notifTitle.ts`:
`resolveNotifTitle({name, name_source, is_custom_name, phoneE164, peerUserId, directoryName?})
→ {title, isUnsaved}`. **Evaluation order matters — pattern-match before flag, flag before
fallback** (pre-migration rows have no flag; checking "missing flag → plain name" first would
re-render the hex):

1. `isPlaceholderName(name, peerUserId)` (regardless of flag) → live `directoryName` with
   ` · Unsaved` if available, else `phoneE164`, else generic `'New message'`. The hex never
   leaves the store.
2. `name_source === 'profile'` → `${name} · Unsaved`.
3. `'custom' | 'contact'` (or `is_custom_name`) → plain name.
4. No flag → plain name. **Fail-safe direction: never mislabel a saved contact as
   "Unsaved"** — a missed tag on one banner is cheaper than a wrong tag on a friend. The
   sweeps stamp flags within one Home mount.

Known honesty window: a number saved _outside_ Bravo (directly in the phone's contacts app)
keeps a `'profile'` flag — and the tag — until the next discovery sweep re-stamps it. Stated
here so it isn't filed as a bug.

**1c.4 — Wiring.** All four Android lanes route their title AND the MessagingStyle person
name (`callNotification.ts:304/319`) through the resolver:

- `backgroundMessageNotifier.ts` — has the live store; passes `directoryNames` in.
- `fcmHeadless.ts` + `fcmBootstrap.ts` warm fallback — via **`mutedLookup.ts`**, whose return
  shapes must widen to carry `name_source` + `phoneE164` + `peer.userId` from the persisted
  vault (`:141-158`, `:174-186`). `mutedLookup.ts` is a MESSAGE_LOOP §0 trigger file — the
  §5 caller-completeness sweep runs over both resolvers' callers.
- The P2-6 no-title fallback (`fcmBootstrap.ts:2233-2235`) already posts generic — compliant.
- Group banners keep the existing per-sender chain (`groupMemberNames` → `directoryNames` →
  `'Member'`) — the group name is the title; no per-line tag.

**1c.5 — Vault-safety facts** (so nobody re-derives them): the messenger persist config has
**no `version`/`migrate`** (`messengerStore.ts:1735-1745`) — an optional field is
upgrade-safe; `partialize` spreads whole rows (`:1779-1794`), so `name_source` and
`phoneE164` persist with zero migration machinery.

### 1d. Regression tests

- `notifTitle.test.ts` — the resolver table incl. order (placeholder-before-flag),
  missing-flag fail-safe, no-hex-ever invariant.
- Extend `backgroundMessageNotifier.test.ts` + `fcmHeadlessRouting.test.ts` /
  `msgWakeWarmBannerRules.test.ts` fixtures: a `Bravo · deadbeef` conversation must banner
  from directory/phone/generic — assert `Bravo · ` and `slice(0,8)`-shaped titles absent from
  every `showMessageNotif` call.
- Stickiness unit test on `upsertConversation` (flag survives a flagless same-name rebuild;
  cleared on a flagless rename; explicit flag wins).
- Source-scan (line-anchored per `src/__tests__/sourceScanSafety.test.ts`'s stripper rules;
  CRLF-safe): notification lanes must not pass a raw `conv.name`/`resolved.name` into a title
  without `resolveNotifTitle`.

### 1e. In-app surfaces (same "no internal codes" rule)

`MessengerHomeScreen.tsx:1006-1008/1056-1058` currently render `c.name ?? directoryNames ??
phoneE164 ?? slice(0,8)` — a stored placeholder is truthy, so **the code renders in-app
today** too. Fix: chat-list rows and the ChatScreen header run the same resolver for the
_name_ (placeholder → directory/phone → `'Bravo user'` last resort, replacing every
`slice(0,8)` fallback at `ChatScreen.tsx:3242-3280`, `MessengerHomeScreen.tsx:1007/1057`,
`ChatInfoScreen.tsx:101`). In-app surfaces show the name **without** the `· Unsaved` suffix —
the in-app unsaved signal is the ChatInfo chip (existing) + the ChatScreen save banner (§2);
a tag on every list row is noise.

**Call banners are in scope (critic R2-1):** the killed-app ring, missed-call, and
stale→missed notifications resolve their caller label via
`mutedLookup.resolveDirectPeerName` (`fcmHeadless.ts:53-57,102-106,119` →
`mutedLookup.ts:165-167`), which returns the **persisted conversation name — the
`Bravo · <hex>` placeholder for exactly the rows B-411 is about**. `'Bravo contact'` is only
the no-row fallback. `resolveDirectPeerName` routes through the resolver too (name-only, no
suffix — consistent with this section). The warm-path caller label / CallKit label
(sqa B-226, `MainNavigator.tsx:527`) stays out of scope this session — named here so the
de-scope is explicit, not accidental.

**iOS caveat:** the killed-app iOS banner is a **constant** `Bravo Secure / New secure
message` composed server-side (`push.service.ts:795-824`, OR-3) because iOS data-only pushes
can't run JS. Named iOS killed-state banners need a Notification Service Extension — out of
scope. iOS warm lanes (JS alive) go through the same resolver and DO get correct names.
Android gets all lanes.

---

## 2. Item 2 — "Save contact" like WhatsApp

### 2a. What already exists (do not rebuild)

- `src/modules/messenger/contacts/savedContacts.ts` — `getSavedState(phoneE164)`
  (`'saved' | 'not-saved' | 'unknown'`, never prompts, last-9-digit tail matching, rationale
  comment `:24-27`) and `presentSaveContact({displayName, phoneE164})` → the **system contact
  form** via expo-contacts `presentFormAsync` (already calls `invalidateSavedContacts()`
  internally; `expo-contacts ~15.0.11` installed; READ/WRITE_CONTACTS in the manifest).
- `ChatInfoScreen.tsx:838-854` — "Not in contacts · Save" chip wired to it (group-member
  variant `:400-413`).

### 2b. Gap + fix

1. **ChatScreen banner (the WhatsApp-parity surface):** for a direct conversation, when live
   `getSavedState(conv.phoneE164) === 'not-saved'` (same trigger the ChatInfo chip uses at
   `:844` — NOT the `name_source` flag, which can be stale), show a one-line inline banner:
   _"`<name>` isn't in your contacts — **Add**"_ → `presentSaveContact`.
2. **Post-save (the actual mechanism, no "immediately" over-promise):** when the sheet
   resolves, re-check `getSavedState`; on `'saved'` → upsert `{...conv, name_source:
'contact'}` **keeping the current display name** (the user may have edited the label in
   the system sheet; we can't read the final label without a full re-query). Effects: the
   banner disappears now, notifications drop the ` · Unsaved` tag now; the display label
   syncs to the actual address-book label on the next discovery sweep (Home mount —
   `useDiscoveredContacts` is mounted on Home/NewChat/InviteMember, not ChatScreen).
3. **Honest constraint (privacy architecture, not a bug):** for a stranger whose number we
   never had there is nothing to save — the profile endpoint never exposes phones
   (`usersClient.ts:24-28`; `types.ts:223-227`). No number → no banner. Those chats show
   `Name · Unsaved` in notifications until the number is learned out-of-band.
4. `savedState === 'unknown'` (permission denied) renders nothing — same rule as ChatInfo.

---

## 3. Item 3 — Notification-consistency audit (all lanes, one naming rule)

| Lane                               | Entry                                                             | Title after fix                                     |
| ---------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Killed / Doze (headless VM)        | `fcmHeadless.ts:155-249`                                          | `resolveNotifTitle` over widened `mutedLookup` meta |
| Warm background — store notifier   | `backgroundMessageNotifier.ts:192-325`                            | `resolveNotifTitle` (live store + `directoryNames`) |
| Warm background — notifier down    | `fcmBootstrap.ts:2135-2242`                                       | `resolveNotifTitle` over widened `mutedLookup` meta |
| Warm background — P2-6 last resort | `fcmBootstrap.ts:2233-2235`                                       | generic `New secure message` (unchanged, compliant) |
| Foreground                         | `fcmBootstrap.ts:489-509` (in `:435-518`) — pull nudge, no banner | n/a — in-app UI shows the same resolved name (§1e)  |
| Lock screen / notification center  | same notifee post as the lanes above                              | inherits — no separate path                         |
| iOS killed                         | server constant alert (`push.service.ts:818`)                     | unchanged — needs NSE, out of scope (§1e)           |

Notification id (`bravo-msg-<conversationId>`, `callNotification.ts:270`), channels
(`bravo-messages`), burst/alert-once (`:132-152`), badge/summary (`:191-216`) are untouched —
title/person-name composition only, so B-48/N-29/N-14 behavior can't regress.

The `senderName` param accepted by the server's `sendChatWake` remains a dead param (N-15) —
we do **not** start shipping names in pushes; that leaks social-graph metadata to the relay
and violates the sealed-sender posture (security stop-condition; zero server push changes).

---

## 4. B-412 — "Sometimes the notification doesn't come"

A **class**, not one bug. Members, status, and what this session adds:

| #   | Cause                                                           | Status                                                                                                                                                                                                                                                                       | Evidence anchor                                             |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Server reaped the push token ~15 min after app kill             | **FIXED + deployed 2026-06-30** (tombstone model)                                                                                                                                                                                                                            | `push.service.ts` GC; memory: killed-app-push-token-reaping |
| 2   | Push-permission denied / `bravo-messages` channel blocked       | **Banner EXISTS** (`NotificationPermissionBanner.tsx:31-38` checks both; mounted `MessengerHomeScreen.tsx:640`). Residuals: Android-only bail (`:20`), fails-open on error (`:39-41`), one merged message for two causes, ring channel unchecked, dismissal resets per mount | NOTIFICATION_AUDIT §N-31                                    |
| 3   | OEM battery optimization (MIUI/BlueStacks autostart)            | Mitigation exists (`push/batteryOptimization.ts`, fail-soft getters); user-setting dependent                                                                                                                                                                                 | B-48 follow-up                                              |
| 4   | Server-side debounce ate rapid-fire wakes                       | **Shrunk 6→2 s + trailing wake; DEPLOYED 2026-08-01** (`CHAT_DEBOUNCE_SEC`, `push.service.ts:146`; trailing `:854-874`)                                                                                                                                                      | B-352 A1 / B-354                                            |
| 5   | Headless drain bails in the killed VM                           | Instrumented — `[NOTIFLAT]` warns at all five bails (`headlessDrain.ts:102-131`); fallback banner still posts                                                                                                                                                                | B-352 B1                                                    |
| 6   | FCM `collapseKey msg-wake:<conv>` folds a burst into one banner | **By design** — can _look_ like missed notifications                                                                                                                                                                                                                         | `push.service.ts:752-774`                                   |
| 7   | Logout/takeover tombstone silences the device until next login  | By design (security)                                                                                                                                                                                                                                                         | auth tombstones                                             |

**What ships now (low-risk, diagnostic-first — every previously _measured_ cause already has
a fix; guessing has repeatedly been wrong here, B-279):**

1. **`[NOTIFHEALTH]` boot probe** — one release-visible `console.warn` on MainNavigator mount:
   POST_NOTIFICATIONS state, `bravo-messages` channel enabled/blocked, minutes since last
   successful `/push/register` assert, battery-exemption state. Style precedents `[NOTIFLAT]`
   / `[LAGDIAG]`. **Constraint:** it lives under `src/modules/messenger/push/` so
   `logAudit.test.ts:20-40` scans it — the probe text must avoid the banned vocabulary
   (`signature`, `decrypt`, `plaintext`, `.content`); battery/permission/channel/token words
   are safe.
2. **Capture procedure** for the next repro: note send time; recipient-side
   `adb logcat -d | grep -E "NOTIFHEALTH|NOTIFLAT|fcm|bravo-messages"` + the relay's
   `push.chat.delivered sub=<user> sent=` line. The pair discriminates causes 2/3/5. A relay
   `sent=1/1` does NOT prove a banner rendered (B-336 lesson) — always read the device side.

---

## 5. B-413 — "Another admin invited me and I can't join" (Departmental workspace)

### 5a. What's actually happening (verified)

**Designed-in, three layers deep — not an accidental regression** — plus one genuine defect
that makes it feel broken:

1. **The design:** one active org per user, systemwide.
   - `supabase/migrations/20260622110000_antifraud_integrity.sql:29-31` — unique index
     `org_members_one_active_agency`: at most ONE active membership per user.
   - `supabase/migrations/20260804010000_enterprise_workspaces.sql:33-42` —
     `org_workspaces.owner_user_id` is the **primary key**; the owner IS the org id.
   - `apps/auth-service/src/department/enterprise-join.service.ts:1065-1069` — accept throws
     `workspace_owner_cannot_join`; duplicated in the single membership writer
     `grantMembership` (`:628-632`), whose comment names the cost openly (lapsed owner can't
     join ANY org until a workspace-deletion path exists — "blueprint §12 follow-up (8)").
     The "splitting their identity" rationale is at `:616` and `:1061`; the guard's
     own-org-precedence statement is `apps/auth-service/src/org/org-manager.guard.ts:96-133`.
   - Client copy the founder hit: `src/screens/deptchat/inviteAccept.ts:48-51`.
2. **The genuine defect — the dangling Accept:** `myInvites`
   (`enterprise-join.service.ts:953-986`) promises in its docstring (`:945-951`) to exclude
   "any cohort whose accept cannot succeed", but its `NOT EXISTS` (`:977-982`) only checks
   `org_members` — never `org_workspaces`. A workspace owner sees the invite card with a live
   Accept (`ApprovalStatusScreen.tsx:152-187`) that is guaranteed to 409. Same hole in
   `resolveReferralLink` (`:204-235`) → `JoinWorkspaceScreen` renders "Join {org}" for an
   owner. **A third surface has the same dangling CTA:** `DepartmentChannelsScreen.tsx:355-357`
   sets `hasInvite = invites.length > 0` and drives a "You've been invited — tap to join" CTA
   (`:130-137`).

**Why it was built this way (plain English):** the one-org rule is an anti-fraud constraint
(the migration is literally named `antifraud_integrity`) and an identity simplifier — the
backend answers "which org does this caller mean?" from identity alone (guard precedence;
`/auth/me`'s single `org` object from a `LATERAL … LIMIT 1` collapse,
`apps/auth-service/src/auth/account-kind.ts:141-151,186-190`). No request names a workspace.
Two orgs on one account makes "which org?" ambiguous everywhere at once.

### 5b. Fix — Phase A (this session)

1. **Server — honest invites, no phantom CTA:** `myInvites` returns each row with
   `acceptable: boolean, blocked_reason?: 'workspace_owner_cannot_join'` (same
   `org_workspaces` EXISTS the accept uses). `resolveReferralLink` gains the caller's
   identity (`claims.sub` is available — the route is JWT-guarded; the service signature
   changes) and returns the same reason instead of `valid: true`.
   **Dismissal reality-check (critic finding):** there is NO invitee-facing decline endpoint
   and NO status column to flip (invites are variant rows of `enterprise_referral_links` —
   `supabase/migrations/20260808010000_enterprise_member_invites.sql:3-17`; status is derived
   from `accepted_at/revoked_at/expires_at`, `enterprise-join.service.ts:871-874`). Phase A
   therefore does **not** promise dismissal. The no-nag rule is honored by placement instead:
   - CTA surfaces count **only acceptable invites**: `ApprovalStatusScreen` **filters
     blocked rows out entirely** (no card of any kind — the hub is their one home);
     `DepartmentChannelsScreen.tsx:355` becomes `invites.some(i => i.acceptable)`.
   - Blocked rows are _listed_ only in the Workspace Hub (§6) as informational rows with the
     reason copy — a list entry in a deliberately-visited page, not a nagging CTA. **They
     must not feed any badge/count/attention affordance on the hub entry points** (a badge is
     a nag with extra steps). They self-clear on invite expiry: `createMemberInvite`'s INSERT
     computes `NOW() + days` clamped 1–90, default 7 (`enterprise-join.service.ts:756-763`) —
     member-invite rows can never have `expires_at IS NULL`, so the NULL-tolerant arm in
     `myInvites`' WHERE (`:974`) cannot keep one alive forever (don't "fix" that arm; legacy
     NULL-expiry referral links can't leak in — they lack the invited-contact fields the
     query matches on, `:975-976`).
2. **Shape-compat:** adding fields breaks no parser — `ApprovalStatusScreen.tsx:73` assigns
   the array wholesale and reads named fields. Types widen at
   `enterprise-join.service.ts:953-956`, `src/services/api.ts:2019-2022`,
   `ApprovalStatusScreen.tsx:40-43`, `JoinWorkspaceScreen.tsx:53-64` (+ its `:79-80` error
   collapse gains the `reason`).
3. **Doc/test hygiene:** the now-false docstring at `:945-951` and the
   `ApprovalStatusScreen.tsx:147-151` "no client-side status gate" comment are updated; the
   source-pin test `enterpriseJoin.spec.ts:1210-1230` slices on `'async myInvites('` …
   `'async acceptInvite('` with six regexes — the SQL edit must keep those anchors satisfied
   (adjust the spec deliberately if an assertion legitimately changes).

### 5c. Fix — Phase B (REQUIRES FOUNDER SIGN-OFF — reverses a deliberate anti-fraud rule)

To actually let a workspace owner join another workspace (the Discord/Slack model):

- Remove both `workspace_owner_cannot_join` refusals (`:628-632`, `:1065-1069`). The
  anti-fraud index is untouched — an owner joining org B creates their first and only
  `org_members` row; ownership lives in a different table.
- `/auth/me` gains an **additive** `workspaces: [{org_id, name, role}]` array. The legacy
  single `org` object must stay stable for owners — today the om-row would win the
  derivation chain (`account-kind.ts:186`, a TS `??` chain) and **real SQL COALESCEs flip
  `org_is_workspace` (`:135`) and `org_name` (`:152`) too** — the owner's whole app silently
  re-labels to the joined org. The derivation must prefer own-workspace for owners
  (currently a provable no-op: the refusals guarantee owners have no membership rows).
  `recheckMembership` must carry every new `/auth/me` field (B-394..B-403 lesson).
- Dept member reads must become org-scopable: `listChannels`
  (`department.service.ts:155-235`) is keyed on `department_channel_members.user_id` with
  **no org filter** — a cross-org join would interleave both workspaces' channels. Add
  `org_user_id` to the projection + an optional validated org filter.
- Client: an `activeWorkspace` context (id + role) set by the hub;
  `DepartmentalNavigator.tsx:72-76` `useIsManager` derives from the active workspace's role,
  not global `is_org_manager` — otherwise an owner browsing org B gets manager chrome pointed
  at org A's data.

Phase B is scoped and buildable, but flipping an anti-fraud business rule is a product
decision — it ships only on explicit founder approval.

---

## 6. F-WSHUB — the workspace list page (Discord/Slack style)

**Ships in Phase A** (works on today's single-org model, future-proof for Phase B):

- **New screen `WorkspaceHubScreen`** (route `WorkspaceHub` on `MessengerNavigator`, beside
  `Departmental` at `MessengerNavigator.tsx:236-240`), listing:
  1. **Your workspace** — `owns_workspace` / `enterpriseApi.myWorkspace()` (`api.ts:1959-1961`)
     → enter as owner/manager.
  2. **Member of** — `user.org` when `org_is_workspace` and not own → enter as member.
     **Verified viable today:** no client-side `DeptChatAccessGuard`, no ownership gate on the
     route (registered unconditionally), `EXPO_PUBLIC_DEPT_CHAT_V2` gates only CPO/agent
     entry points, and `entitlements.ts:60-64` `isOrgAffiliated`'s third arm covers members.
  3. **Invitations** — `enterpriseApi.myInvites()`: acceptable → "Join {org}" (reusing
     `ApprovalStatusScreen`'s accept flow **including its `code: null` fork** — email-matched
     invites carry no code and need the "Enter invite code" arm, `api.ts:2014-2022`,
     `ApprovalStatusScreen.tsx:163-183`); blocked → informational row with reason (§5b).
  4. Empty state → "Create a workspace" → existing `EnterpriseSetupScreen`.
- **Entering a workspace uses the `departmentalEntry` resolvers, not a bare
  `navigate('Departmental')`** — `departmentalEntry.ts:124-127` warns a bare navigate only
  lands on Home for a cold mount.
- **Entry points (incl. the actual primary door):**
  - `ProfileDrawerModal.tsx:108-141` "Departmental Chat" row (reached from
    `MessengerHomeScreen.tsx:861`) — becomes "Workspaces" → `WorkspaceHub` when the user has
    any workspace **affiliation** (`owns_workspace` / `org_is_workspace` — data the drawer
    already has; it makes no `myInvites` fetch and shouldn't grow one); falls through to the
    existing setup/join flow otherwise. Invite-only users still reach the hub via
    `ApprovalStatusScreen` / the invite notification path.
  - Departmental home header (workspace name → hub).
  - `EnterpriseSetupScreen.tsx:50-52` redirect gate — today it checks **ownership only**
    (`myWorkspace()` truthiness); it now routes owners through the hub.
- **Auth-lane fix required for tile 2 (critic finding):** `authStore.ts:407-409`
  (`completeAuth`) and `:450-452` (`biometricSignIn`) pass `owns_workspace` but **drop
  `org_is_workspace`** (`toUser()` defaults it false, `:154-157`) — until the first
  `recheckMembership()` tick, a member's hub tile would render empty. Both lanes carry the
  field (the `:753-764` recheck already does, with a comment warning about exactly this).
- **No new server endpoint** — three existing calls compose the page.
- Under today's constraint the list holds at most one enterable workspace + invites — still
  the honest UX for "where do my workspaces live?", gives invites a visible home, and Phase B
  drops multi-entries into a page that already exists.
- Design-system: obsidian `#07090D` / cobalt `#5B8DEF` per `DESIGN_REVIEW_LOOP.md` G8.

---

## 7. Implementation order + gates

1. §1 `name_source` stickiness in `upsertConversation` + stamp sites + resolver + mutedLookup
   widening + lane wiring + §1e in-app fallbacks + tests. Messenger gate:
   `npx jest --selectProjects messenger-crypto` **twice** (flake rule) + app-project
   `npx jest --selectProjects app --testPathPattern "screens/messenger"`. MESSAGE_LOOP §5
   caller-completeness sweep over every widened/shared symbol (`mutedLookup` resolvers,
   `upsertConversation` callers — census in §1c.2).
2. §2 ChatScreen save-banner (+ app-project screen tests).
3. §4 `[NOTIFHEALTH]` probe (logAudit-safe vocabulary) — verify `logAudit.test.ts` +
   `addCallAuditPins.test.ts` stay green.
4. §5b invite honesty (server + 3 client surfaces) + §6 hub screen + the two authStore lanes.
   Backend gates: `enterpriseJoin.spec.ts` + touched specs, `nest build`.
   **Deploy step (required for device verification):** auth-service to staging is MANUAL —
   CI deploy never fires (`CONTABO_SSH_KEY` missing; standing memory). Tar-over-ssh + docker
   compose build/up, per the B-354 procedure. Without it the founder's device test runs old
   server code and the blocked-invite card never appears.
5. `npm run typecheck` (mobile baseline ≤ 47); ops-console untouched.
6. Self-diff against the pre-session baseline (`scratchpad/baseline-status.txt` separates this
   session's diff from the ~35 pre-existing uncommitted Audit-Rev2 files) + CLAUDE.md
   change-safety rule 8 sweep.

**Out of scope, stated explicitly:** iOS killed-lane named banners (needs NSE), shipping
sender names in push payloads (security stop-condition), invitee invite-dismiss endpoint
(needs schema; §5b placement rule covers the nag concern), any weakening of
sealed-sender/verify paths. ~~Phase B owner-join (founder decision)~~ — **APPROVED and
implemented same session, see §9.**

---

## 9. Phase B — IMPLEMENTED (founder-approved 2026-08-09, "do it")

Same dual-agent loop as Phase A (adversarial critic + edge-case hunter, revise until AGREE).
What §5c specified, with two reviewer-driven refinements:

- **Server:** both `workspace_owner_cannot_join` refusals removed (grantMembership +
  acceptInvite); myInvites/resolveReferralLink owner arms removed (the
  `already_active_in_another_org` mirror stays); `/auth/me` gains the additive
  `workspaces: [{org_id, name, role}]` array; `listChannels` gains `org_id` in the
  projection + a validated optional `orgId` filter.
- **Refinement 1 (critic round 0, judged on merits): the FOUR-ARM primary-org precedence**
  instead of §5c's blanket "prefer own-workspace for owners": managed org > AGENCY
  membership > own active workspace > WORKSPACE membership — because the LOW-5 persona
  (agency crew member owning a personal workspace) is reachable TODAY via the org-cpo
  hiring lane and must keep resolving to the agency. Identical to the old chain for every
  pre-existing persona except member-then-created-own, whose flip to their own workspace is
  the intended Discord semantic (pinned + documented in account-kind.ts).
- **Refinement 2 (critic MAJOR-1/2): `contextManagerRole` —** manager chrome inside a
  context workspace arms only for its owner or a manager who owns no active workspace,
  mirroring OrgManagerGuard Path 1b exactly. Without this, an owner invited as MANAGER of
  workspace B got manager chrome whose every API call silently read/wrote org A under B's
  name. ONE shared predicate (activeWorkspace.ts), consumed by the navigator, Home, and the
  channels directory.
- **Client:** session-only `activeWorkspace` context (hub-set, signOut-cleared,
  reconciled against the live workspaces array on recheck); hub renders the workspaces
  array with per-tile unread pills (closes cross-workspace discoverability) + a
  "Your organisation" row (the agency escape hatch) + honest lapsed/suspended cards
  (`[]` ≠ `undefined`); dept surfaces scoped via `scopeChannelsToActiveWorkspace` /
  `activeWorkspaceOrgParam` (messenger-list filters + the vault-refusal registry
  DELIBERATELY unscoped); `acceptInviteFlow` points the context at the joined workspace
  for all three accept surfaces.
- **Skew:** every new client path degrades to today's behavior against a pre-Phase-B
  server (no workspaces array → legacy hub tiles entering primary-org mode; no org_id →
  fail-open scoping; owner accept → the retained 409 copy).

Review record: critic round 1 = REVISE (3 MAJOR — wrong-org manager chrome ×2 surfaces,
sticky-context lockout/dead-end; 4 MINOR); edge hunter round 1 = 6 BROKEN (discoverability,
[]/undefined conflation, accept-lands-wrong-workspace ×3 surfaces, A8 persona, orgId 500,
latent badge staleness). All fixed; round-2 verdicts recorded in sqa.md.

---

## 8. Post-implementation review round (adversarial critic + edge-case agent) — outcomes

Fixed from the review (all landed same session):

- **Critic MAJOR-1:** `openMemberChat` no longer persists the display fallback — an
  unresolvable member seeds the healable `Bravo · <hex>` + `'placeholder'` shape; the pretty
  label rides the route param only (pinned in `b404NotifLaneScan`).
- **Edge #1:** `[NOTIFHEALTH]` waits (bounded, 30 s poll) for the register flip before
  logging, so `reg=NO` means a real failure, not a race with the fire-and-forget register.
- **Edge #2 / critic MINOR-2:** ChatScreen's raw route-`name` consumers ("Replying to …",
  1:1 quoted attribution, PeerOfflineBanner) now use the resolved header name.
- **Edge #3:** the hub reads ownership from **server truth** (`myWorkspace()`
  unconditionally, flag only as pre-render) — kills the stale-flag setup↔hub dead cycle.
- **Edge #4:** the B-18 synthetic→UUID merge folds the synthetic row's higher-precedence
  identity (`'contact'`/`'custom'` name + flag + `phoneE164`) into the canonical row, so a
  saved friend is never transiently re-tagged Unsaved by the sync.
- **Edge #6 + critic MINOR-5:** save banner has an in-flight guard, a catch, and a
  focus-time `getSavedState` re-check (save via ChatInfo's chip clears it without remount).
- **Edge #7:** `acceptable` now also mirrors the one-active-org refusal
  (`already_active_in_another_org`) in `myInvites` and — invite rows only, cross-org only —
  in `resolveReferralLink` (referral rows stay resolvable: cross-org _pending_ is
  legitimate). Client copy added in the hub + JoinWorkspaceScreen.
- **Critic MINOR-3:** a by-number hit with no display name stamps no flag (bare phone
  renders plain, untagged).
- **Critic MINOR-4 / edge E9:** phantom `WorkspaceHub` declarations dropped from the
  Agent/CPO param lists (route exists only where a navigator registers it).
- Home-row avatar initials derive from the resolved label, not the raw name.

Accepted residuals (deliberate, documented — do not re-file as bugs):

- **Pre-upgrade unsaved chats whose registered name already landed stay untagged** (edge
  #5): no sweep re-stamps `'profile'` on a non-placeholder row, and doing so would race the
  address-book sweep into exactly the wrong-tag-on-a-saved-friend failure the fail-safe
  forbids. The tag applies to all placeholder rows and everything created from now on.
- **A saved contact literally named `Bravo · X` in the address book** renders as directory
  name/phone instead of that label (edge B4): pattern-before-flag is load-bearing for every
  pre-flag vault row; the trade was reviewed and accepted twice.
- **`headerDisplayName` reads the session directory non-reactively** (critic MINOR-6): a
  mid-screen directory landing repaints on the next row change; transient 'Bravo user' in
  between. Accepted.
- **Version skew:** all three `acceptable` gates are `!== false`, so a
  not-yet-redeployed server yields today's behavior (never all-blocked). The §7 manual
  auth-service deploy remains REQUIRED for the blocked-reason UX to appear.
