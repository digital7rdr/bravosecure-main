i rgr o non

# Departmental Chat (Dept Chat v2) — A‑to‑Z Audit, Bug Fixes & Improvement Plan

> Status: **Ready for review** · Scope: the whole "Departmental" module (channels +
> messaging, attendance, incidents) · 2026‑06‑27.
> Method: manual code read of the full surface **+** a 51‑agent adversarial cross‑audit
> (understand → hunt → verify → improve). This is a planning/remediation doc — no code
> changed by writing it.
>
> **Headline:** the channel feature is architecturally sound (true E2EE), but its
> **lazy, admin‑device‑driven provisioning + key‑distribution** is fragile in ~6 distinct
> ways that together produce every reported symptom. There are also **4 security/tenancy
> issues** and several **attendance/incident** logic bugs. Fix order is in §F.

---

## A. Why Departmental Chat exists (the purpose)

Departmental Chat is the **internal communications + operations layer for a security
agency (service‑provider org)** and the officers (CPOs) and managers it employs. It is
_not_ a customer‑facing chat. It exists so an agency can run its team inside Bravo
without a second app:

- **Channels** — team threads (e.g. _Operations_, _Intel_, _CPO Roster_, plus
  manager‑created ones) for orders, briefings, announcements, and incident coordination.
  Managers/org **post**; CPOs **read** (role‑gated). Same Signal/E2EE crypto as every
  Bravo chat — the relay never sees channel plaintext.
- **Attendance** — geofenced, optionally face‑checked clock‑in/out against assigned
  shifts, with a manager review queue for flagged check‑ins.
- **Incidents** — structured field‑incident reporting with an evidence vault and a
  manager triage FSM (submitted → received → under_review → action_assigned → resolved →
  closed).

**Roles:** the company/agency account and delegated **managers** are channel _admins_
(can post + manage membership); **CPOs** are _viewers_ (read‑only). Access to the
whole workspace is gated by **org membership**, not individual Pro
(`DeptChatAccessGuard`, `apps/auth-service/src/department/dept-chat-access.guard.ts:31`).

**Gating flags:** build‑time `EXPO_PUBLIC_DEPT_CHAT_V2` (mobile, `src/utils/constants.ts:30`)

- backend `DEPT_CHAT_V2_ENABLED` (auth‑service). Both must be on.

---

## B. How it actually works (architecture you must understand to fix it)

This is the crux — every reported bug is a symptom of this design.

### B.1 A channel is metadata; the messages are an E2EE Signal group

- `department_channels` (migration `20260603000000_pro_subscription_and_dept_channels.sql`)
  stores **metadata only**: `id, org_id, name, description, department, group_conversation_id, channel_type, access, archived_at`.
- `department_channel_members` stores `(channel_id, user_id, role[admin|viewer], role_label)`.
- **Message content is NOT in this DB.** A channel maps to a messenger **Signal group**
  via `group_conversation_id`. Posts ride the relay as sealed‑sender group envelopes via
  the same `broadcastToGroup` crypto as 1:1/group chat. (`DepartmentService` header,
  `department.service.ts:22‑31`; `conversations.service.ts:41‑42`.)

### B.2 The Signal group is **lazily provisioned by an admin's device**

`group_conversation_id` is **NULL until an admin device bootstraps it**:

1. `seedOrgWorkspace` / `createChannel` insert the channel + member rows with
   `group_conversation_id = NULL` (`department.service.ts:161,233`).
2. The first time an **admin** taps the channel, `DepartmentChannelsScreen.openChannel`
   (`src/screens/messenger/DepartmentChannelsScreen.tsx:50‑89`) runs:
   `listMembers → rt.createGroupChat(members) → departmentApi.registerGroup → re‑fetch canonical id`. `registerGroup` is **first‑writer‑wins** (`department.service.ts:88‑111`)
   to stop two admin devices forking the key (B‑35 class).
3. Until that runs, `DepartmentChatScreen` shows **"Channel not yet active"** and renders
   **no composer** (`DepartmentChatScreen.tsx:197,225‑233`).

### B.3 Membership changes are **eventually‑consistent via an intent queue**

The server holds **no group key**, so it cannot rekey. `addMember`/`removeMember`:

1. write the membership row + enqueue a `channel_membership_intents` row
   (`department.service.ts:362‑403`).
2. The **admin device** later drains them: `drainMembershipIntents()`
   (`src/modules/messenger/orgWorkspace/membershipIntents.ts`) calls
   `runtime.addGroupMember` (→ `planAddAndRekey`, seals the master key to the new member)
   / `removeGroupMember` (→ `planRemoveAndRekey`), then acks.
3. The drain runs **only on `DepartmentChannelsScreen` focus** (`DepartmentChannelsScreen.tsx:99`).

**Consequences (the bug surface):** a channel is unusable until an admin opens it; a new
member is keyless until the admin re‑opens the channels list; and group messages are
sealed **per‑recipient at send time**, so anything sent before the member was keyed in is
**never** delivered to them (no historical backfill).

---

## C. The three reported bugs — confirmed root causes & fixes

### 🐞 BUG‑1 — "After creating a new channel it takes time to activate." **(High)**

**Root cause.** Lazy provisioning (B.2). A new channel is `group_conversation_id = NULL`
and is only turned into a real E2EE group **synchronously, the first time an admin taps
it** — `createGroupChat` seals one envelope per member (network + crypto round‑trip),
then `registerGroup`, then a re‑fetch (`DepartmentChannelsScreen.tsx:50‑89`). That round
trip _is_ the lag (the row shows a provisioning spinner). It also only happens on **admin**
tap, and members only become able to decrypt once those envelopes propagate via the relay.

**Fix.**

1. **Provision eagerly at create time** on the creating admin's device: right after
   `departmentApi.createChannel` succeeds (in `ChannelEditorScreen`), call
   `rt.createGroupChat` + `departmentApi.registerGroup` before leaving the screen, with a
   clear "Setting up encryption…" state. The channel is then already active when anyone
   opens it.
2. Keep the tap‑time provisioning as a **fallback/self‑heal**, but make it **idempotent +
   retried** and surface failures (see BUG‑1b / A‑1).
3. Add a server **`provisioned` boolean** already exposed by `listChannelsForOps`
   (`department.service.ts:140`) to the member `listChannels` shape so the list can show
   "Activating…" vs "Active" honestly instead of "Not yet active" forever.

### 🐞 BUG‑2 — "I added a CPO and sent a message, but they see nothing on the thread." **(Critical)**

**Root cause — a chain of three defects:**

1. **No rekey is triggered when you add a member.** `ChannelMembersScreen.add`
   (`src/screens/deptchat/ChannelMembersScreen.tsx:62‑78`) calls `departmentApi.addMember`
   then only `load()` (reloads the member _list_). It **never calls
   `drainMembershipIntents()`**. So the `add` intent just sits in the queue.
2. **The drain only runs later, on the channels‑list screen.** The new member is keyed in
   only when the admin next focuses `DepartmentChannelsScreen` (`:99`). If the admin stays
   in the channel and posts, that post is sealed to the **old** member set → the new CPO
   never gets it. And `drainMembershipIntents` **skips** intents whose channel isn't
   provisioned yet (`membershipIntents.ts:39‑42`), so on a not‑yet‑active channel the new
   member waits indefinitely.
3. **No historical backfill.** Group messages are sealed per‑recipient at send time; the
   relay does not re‑fan‑out history. Even after the rekey lands, the CPO only ever sees
   messages sent **after** they were keyed in — the earlier post is gone for them.

(Plus `deviceId: 1` is hardcoded in the rekey, `membershipIntents.ts:55` — breaks any
non‑device‑1 member once multi‑device ships.)

**Fix.**

1. **Drain immediately after add.** In `ChannelMembersScreen.add`, after a successful
   `addMember`, call `drainMembershipIntents()` (best‑effort) so the rekey broadcasts at
   once. Provision the channel first if needed (call the same bootstrap as `openChannel`).
2. **Backfill recent history to the new member.** On `addGroupMember`, have the admin
   device re‑seal the last _N_ (e.g. 50) decrypted messages it holds to the new member as
   a one‑time catch‑up (stays within E2EE — the admin already holds the plaintext and the
   new member is now an authorised recipient). Gate behind channel `access` so a restricted
   channel never backfills to a non‑manager.
3. **Make the receiver's self‑heal fire.** Ensure the new member's `DepartmentChatScreen`
   self‑heal (`requestGroupKeyResync`, `DepartmentChatScreen.tsx:145‑152`) can run even when
   they only have channel metadata — register the group id in `messengerStore.groups` on
   first channel open so the resync has a target.
4. Replace the `deviceId: 1` hardcode with the member's real signal device id from
   `auth_devices` (already available via the per‑device keys work).

### 🐞 BUG‑3 — "On the default thread (before I make any new one) I can't even send." **(High)**

**Root cause.** The seeded default channels (_Operations/Intel/CPO Roster_,
`department.service.ts:155‑185`) also have `group_conversation_id = NULL`. They activate
only when the admin opens them. Two failure modes:

1. If the org has **no other active members yet** (no CPOs added), `createGroupChat`'s
   minimum‑2‑members rule fails, the error is **swallowed** (`DepartmentChannelsScreen.tsx:75‑77`),
   and the screen navigates with a null group → "not yet active" → **no composer**.
2. The org account is seeded as **admin** so it _should_ be able to post — but if the user
   opening the default channel is a CPO (viewer), `myRole !== 'admin'` blocks the composer
   by design (`DepartmentChatScreen.tsx:166,300`).

**Fix.**

1. **Allow a solo (admin‑only) channel to provision** (a channel with just the org should
   still get a Signal group so the admin can post and later add members), or defer with a
   clear "Add a member to activate this channel" empty state instead of a dead composer.
2. **Stop swallowing provisioning errors** (A‑1) — surface "Couldn't set up this channel:
   <reason></reason>" with a Retry, so a failure is visible, not a permanent silent dead end.
3. Eagerly provision default channels in the same create‑time flow as BUG‑1.

---

## D. Full bug register (confirmed by a 51‑agent cross‑audit + manual review)

Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low. "✓BUG‑n" = also one of the three
reported symptoms.

### D.1 Provisioning & activation (root of "channel not active" / "slow to activate")

| ID   | Sev | Issue                                                                                                                                                                                                                                                                                                                                                         | Fix                                                                                              |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1‑a | 🟠  | `createChannel` writes metadata only; the Signal group is never provisioned at create — `group_conversation_id` stays NULL (`department.service.ts:233`). ✓BUG‑1                                                                                                                                                                                              | Eager‑provision on create (creating admin's device).                                             |
| D1‑b | 🟠  | Manager create/manage flow has**no** provisioning path; activation only happens by leaving Manage and tapping the row in the separate channel hub.                                                                                                                                                                                                            | Provision from the create flow / a background task.                                              |
| D1‑c | 🟠  | Viewers/CPOs can**never** activate a channel; it stays "not active" indefinitely unless an admin happens to open it (no server/background fallback).                                                                                                                                                                                                          | Server/background auto‑provision (E.1).                                                          |
| D1‑d | 🔴  | `createGroupChat` throws when **no member is reachable** (`delivered===0`), and `openChannel` calls `registerGroup` **after** it — so a default channel whose seeded CPOs have no Signal keys yet is **never registered** and **re‑forks a new master key on every open** → permanently unsendable.                                                           | Register the group id**before/independently** of fan‑out success; allow a 0‑delivered provision. |
| D1‑e | 🔴  | `registerGroup` adoption mismatch: when a 2nd admin races, `openChannel` navigates with the **canonical (adopted)** id, but the local store holds the **orphan** group under the locally‑minted id → composer shows (`notProvisioned` false) yet every send throws (`convo[canonical]` undefined, master key missing) (`DepartmentChannelsScreen.tsx:62‑74`). | Adopt = re‑key the local group to the canonical id, or re‑hydrate before navigating.             |
| D1‑f | 🟠  | `openChannel` **swallows** provisioning errors and navigates anyway (`DepartmentChannelsScreen.tsx:75‑77`) → permanent silent "not yet active".                                                                                                                                                                                                               | Surface error + Retry; don't enter a dead channel.                                               |
| D1‑g | 🟡  | `openChannel` doesn't update the local list row with the freshly registered `group_conversation_id` → row shows "Not yet active"/null badge until the next focus refetch.                                                                                                                                                                                     | Patch the local row on success.                                                                  |
| D1‑h | 🟡  | `DepartmentChatScreen` freezes `groupConversationId` from route params and never re‑checks provisioning on focus → "Channel not yet active" sticks even after an admin provisions it.                                                                                                                                                                         | Re‑read channel on focus (or subscribe to store).                                                |
| D1‑i | 🟡  | Misleading state badge: hub/manage list show**ACTIVE/Admin** on channels that are **not** provisioned (badge contradicts the "Not yet active" text) (`DepartmentChannelsScreen.tsx:234‑248`).                                                                                                                                                                 | Derive badge from`group_conversation_id` too.                                                    |

### D.2 Membership & key distribution (root of "added member sees nothing") ✓BUG‑2

| ID   | Sev | Issue                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                    |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D2‑a | 🔴  | Member rekey (`drainMembershipIntents`) fires **only when an admin focuses the Channels list** — even the manager who _adds_ the member doesn't trigger it (`ChannelMembersScreen.tsx:62‑78`) → "added but sees no messages" indefinitely.                                                                                         | Drain on add; broaden triggers (E.1.2).                                                                |
| D2‑b | 🔴  | **Add→send race:** drain is fire‑and‑forget; a message sent before the rekey completes is **never** fanned out to the new member and is permanently unreachable.                                                                                                                                                                   | Provision+key‑before‑post; backfill.                                                                   |
| D2‑c | 🟠  | No message‑history backfill (forward‑secrecy by design) → an existing channel's thread is**empty** for a new member until someone posts again after keying.                                                                                                                                                                        | Re‑seal recent N messages on key‑grant (gated by access).                                              |
| D2‑d | 🟠  | New member's key‑resync self‑heal**silently no‑ops**: it has the `groupConversationId` from REST but **no local conversation row**, so it has no participants to request the key from (`DepartmentChatScreen.tsx:145‑152`).                                                                                                        | Hydrate a local conversation/participant row for dept groups on first open.                            |
| D2‑e | 🟠  | Drain on a device with**no local group state** throws "unknown group" and the add‑intent **stalls indefinitely** (`membershipIntents.ts`).                                                                                                                                                                                         | Skip‑and‑defer cleanly; only the provisioning device should drain, or hydrate first.                   |
| D2‑f | 🟠  | **Non‑owner** admin draining the add‑intent leaves the new CPO permanently keyless — RC2 reshare is **owner‑gated**, yet the drain runs on **any** admin device.                                                                                                                                                                   | Route rekey/reshare intents to the group**owner** device (E.1.3).                                      |
| D2‑g | 🟡  | Add‑intents on a**not‑yet‑provisioned** channel are enqueued with NULL group and **skipped forever** (`membershipIntents.ts:39‑42`); after provisioning, the same intents target members **already** in the initial group → `addGroupMember` throws "already a member", never acked → **infinite retry churn** on every list load. | Settle no‑op intents (already‑in/out) as done; don't enqueue for members included in initial creation. |
| D2‑h | 🟡  | `deviceId: 1` hardcoded in rekey (`membershipIntents.ts:55`) — breaks any non‑device‑1 member.                                                                                                                                                                                                                                     | Use real`signal_device_id`.                                                                            |

### D.3 Send path / conversation sync (🔴 the deepest one) ✓BUG‑2/3

| ID   | Sev | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                             |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3‑a | 🔴  | Dept‑channel groups are**never written to `conversations`/`conversation_members`**, so they never appear in `/conversations/mine`. The send fan‑out reads recipients **solely** from local `convo.participants` (`productionRuntime.ts:1757`) → on fresh login / reinstall / 2nd admin device, send throws _"group has no other participants — may not be synced from /conversations/mine yet"_ — a sync that will **never** happen for dept groups. | Either mirror dept membership into`conversation_members` (so `/conversations/mine` hydrates), **or** resolve send recipients from the **department roster** (`departmentApi.listMembers`) instead of only `convo.participants`. |
| D3‑b | 🟠  | First post right after activation (or for a 2nd admin) can fail because recipients come from participant sync, not dept members.                                                                                                                                                                                                                                                                                                                     | Same as D3‑a.                                                                                                                                                                                                                   |
| D3‑c | 🟠  | Default channels seeded with an**empty roster** (only the org account) can't bootstrap (`createGroupChat` needs ≥1 other) → "not yet active" → composer hidden → admin **can't send**. ✓BUG‑3                                                                                                                                                                                                                                                        | Allow solo/admin‑only provisioning, or a clear "add a member to activate" state.                                                                                                                                                |

### D.4 Security & tenancy (🔴 prioritise)

| ID   | Sev | Issue                                                                                                                                                                                                                             | Fix                                                                                     |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| D4‑a | 🔴  | `addMember` has **no org/tenant scoping** on the target — any channel admin can add an arbitrary cross‑org / non‑org user and rekey them into the E2EE group, bypassing `DeptChatAccessGuard` (`department.service.ts:362`).      | Verify the target is an**active org_member of the channel's org** before insert+intent. |
| D4‑b | 🟠  | `registerGroup` is first‑writer‑wins, **irreversible, unvalidated** — any channel admin can permanently **brick** a channel by registering a bogus/foreign group id (no reset path) (`department.service.ts:88‑111`).             | Validate the caller actually created that group; add an admin reset/re‑provision path.  |
| D4‑c | 🟠  | `DeptChatAccessGuard` + `OrgManagerGuard` grant access to any `agents.type='company'` row with **no active/status check** → a suspended/deactivated company keeps dept‑chat + manager access (`dept-chat-access.guard.ts:37‑41`). | Add an account‑active check.                                                            |
| D4‑d | 🟠  | TOCTOU in`configureChannel` tighten leaves a CPO viewer in a now‑restricted/incident channel still holding the master key (`department.service.ts:254‑291`).                                                                      | Lock the channel row for the tighten transaction; verify removals before flip.          |
| D4‑e | 🟡  | No request‑body validation on`addMember`/`removeMember`/`registerGroup` (unvalidated inline types).                                                                                                                               | Add DTOs +`class-validator`.                                                            |

### D.5 Realtime / UI freshness (the perceived "lag")

| ID   | Sev | Issue                                                                                                                                                                                  | Fix                                                             |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D5‑a | 🟠  | Channel directory + provisioning state**never refresh live** (no WS/push/poll) and the list has **no pull‑to‑refresh** — the primary root of the _perceived_ "takes time to activate". | Push "channel updated" nudge + pull‑to‑refresh + focus refetch. |
| D5‑b | 🟡  | `DepartmentChannelsScreen` **double‑fires** `load()` on mount (`useFocusEffect` **and** `useEffect`, `:109‑110`) → two concurrent, unguarded `drainMembershipIntents` passes (racey).  | Single load path + an in‑flight guard on the drain.             |

### D.6 Attendance

| ID   | Sev | Issue                                                                                                                                                                          | Fix                                                                                  |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| D6‑a | 🟠  | `editShift` always flips status to `'edited'`, **orphaning a still‑open shift** → the CPO can no longer clock out (and can double clock‑in) (`attendance.service.ts:299‑318`). | Preserve`open` when only editing an open shift; only close on a `clock_out_at` edit. |
| D6‑b | 🟠  | Rejecting a Pending‑Review check‑in leaves`attendance_status` stuck at `pending_review` forever (no terminal state) (`attendance.service.ts:447‑456`).                         | On reject, derive a terminal status (e.g.`absent`/flagged) per policy.               |
| D6‑c | 🟡  | Auto‑absent rollup marks a CPO`absent` even when a manager set `leave`/`sick_leave`/`off_duty` that day (`attendance-rollup.service.ts`).                                      | Skip days with a manager day‑status marker.                                          |
| D6‑d | 🟡  | `myTodayShift` bounds "today" with `date_trunc('day', NOW())` in **server/UTC** tz → mis‑gates check‑in for non‑UTC orgs at day boundaries (`attendance.service.ts:398‑409`).  | Use the org/shift timezone.                                                          |
| D6‑e | ⚪  | Camera‑denied check‑in recorded as`review_reason='face_mismatch'` instead of an "unavailable/denied" reason.                                                                   | Add a distinct reason.                                                               |
| D6‑f | ⚪  | `setDayStatus` has no per‑CPO‑per‑day uniqueness → duplicate markers possible.                                                                                                 | Upsert on`(cpo_user_id, date)`.                                                      |

### D.7 Incidents & channel config

| ID   | Sev | Issue                                                                                                                                                                                            | Fix                                         |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| D7‑a | 🟠  | Incident**assign** writes **no `incident_events` row and no status change** → assignment never appears in the timeline, and is allowed on **any** status incl. `closed` (`incident.service.ts`). | Gate on status via the FSM; write an event. |
| D7‑b | 🟡  | `configureChannel` **loosen** path (restricted/incident → standard) never **re‑seeds** the rekeyed‑out CPOs → channel stays managers‑only after loosening.                                       | Re‑seed members on loosen.                  |
| D7‑c | ⚪  | Editing a channel can't**clear** `department` (COALESCE keeps the old value when null is sent) (`department.service.ts:293‑302`).                                                                | Use a sentinel / explicit null handling.    |

> By‑design (not bugs, but make them unmistakable in UI): CPO **viewers cannot post**;
> restricted/incident channels are hidden from CPOs by **membership seeding** (no client hide).

---

## E. Improvements to make Dept Chat robust (so no new bugs, fewer old ones)

### E.1 Reliability / robustness (fix the class, not just the instances)

1. **Eager, idempotent provisioning service** (client module) — one function that, given a
   channel, ensures `(group exists) ∧ (registered with the canonical id) ∧ (all current members keyed)`, safe to call repeatedly, with retry + a per‑channel lock. Call it on
   create, on first open, on app focus, and after every membership change. Kills D1‑a..g,
   D2‑b, D3‑c at once.
2. **Resolve send recipients from the department roster, not `convo.participants`** — the
   single highest‑leverage fix (kills D3‑a/b). Either mirror dept membership into
   `conversation_members` so `/conversations/mine` hydrates dept groups, or have the runtime
   resolve a dept group's recipients from `departmentApi.listMembers`.
3. **Route membership‑rekey/reshare intents to the group OWNER device** (kills D2‑f) — RC2
   reshare is owner‑gated, so a non‑owner admin's drain can't deliver the key.
4. **Broaden the intent drain triggers** — after add/remove, on app foreground, on
   reconnect, and on a low‑frequency timer — with an in‑flight guard (kills D2‑a, D5‑b);
   plus **dead‑lettering + add/remove coalescing** and **settling no‑op intents** (kills
   D2‑g).
5. **Server provisioning‑claim lock** — prevents orphan groups on concurrent first‑open
   (kills D1‑e at the source).
6. **History backfill on key‑grant** + **make the receiver self‑heal work** by hydrating a
   local conversation row for dept groups on first open (kills D2‑c, D2‑d).
7. **Push a non‑content "channel updated" nudge** + pull‑to‑refresh so viewers don't sit on
   a stale "not active" state (kills D5‑a).
8. **Delivery / "keyed‑in" confirmation + durable send outbox UI** — surface per‑member key
   state and per‑message Sending…/Failed↻, so "they can't see it" is diagnosable, never silent.
9. **Provisioning/keying observability to the ops console** — plaintext‑free (respect
   `logAudit`) counters for unprovisioned channels + stale add‑intents.

### E.2 New functionality for a real internal‑comms tool

| Feature                                       | Why                                    | Notes                                                              |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| **Read receipts / "seen by"**                 | managers need to know orders were read | server marks (`last_read_at` already reserved, migration `:55`)    |
| **Threaded replies**                          | incident/op threads get noisy          | thread root id on the message envelope                             |
| **Reactions / ack** (👍/✅)                   | quick "acknowledged" without noise     | rides the E2EE body                                                |
| **Pinned messages**                           | keep the SOP/briefing at top           | already have channel`description`; add per‑message pin             |
| **Per‑channel mute / notification level**     | reduce alert fatigue                   | client‑side + push topic                                           |
| **Search within a channel**                   | find an order later                    | local encrypted‑store search only (never server)                   |
| **Typing & presence**                         | situational awareness                  | reuse messenger presence gateway                                   |
| **Membership audit trail in‑channel**         | "X added Y", "Z left"                  | system messages from intents                                       |
| **Attachment send from the channel composer** | share photos/PDF briefs                | reuse media vault + per‑file key                                   |
| **Announcements channel type**                | one‑way broadcast board                | `channel_type='board'` already exists — wire a board‑only composer |

(`@mentions` + `📣 announcement` posts already exist — `DepartmentChatScreen.tsx:40‑60`.)

---

## F. Implementation log — 2026‑06‑27 (APK v1.0.79 / vc103)

Branch `fix/deptchat-audit`. Auth‑service deployed to Contabo staging (`bravo‑staging‑auth`); APK built standalone (`gradlew assembleRelease`, staging env + `DEPT_CHAT_V2=true`) and installed on device `043dd12e3dad`.

### F.1 Fixes shipped

| ID           | Bug / feature                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                                                                                             | Files                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1‑a         | New channel "takes time to activate"                                                                   | **Eager provision** — `ChannelEditorScreen.save` fires `ensureChannelProvisioned` right after `createChannel` (no longer waits for first open)                                                                                                                                                                                                                                                                                  | `ChannelEditorScreen.tsx`, `provisionChannel.ts`                                                             |
| D1‑f/g, D3‑c | Provisioning swallowed errors → silent "not yet active"; no path from create flow                      | Centralised,**honest** `ensureChannelProvisioned` returning `ok / already / needs_members / failed`; first‑open fallback surfaces real cause                                                                                                                                                                                                                                                                                    | `provisionChannel.ts`, `DepartmentChannelsScreen.tsx`                                                        |
| —            | **"production mode requires explicit peer address"** on default channels (CPO Roster/Intel/Operations) | Root cause =**orphaned channel** (server has `group_conversation_id`, device lost the master key; `sendText` falls to the 1:1 path). **Owner reactivation**: `resetGroup` (clears server linkage, creator/owner‑gated) → mint a fresh Signal group (`createGroupChat` re‑keys current members) → re‑register. Gated on `groupConversationId && !hasKey && isOwner`, behind a consent Alert ("earlier messages stay unreadable") | `department.service.ts` (`resetGroup`), `department.controller.ts`, `DepartmentChannelsScreen.tsx`, `api.ts` |
| D2‑a         | Added member sees nothing on the thread                                                                | **Drain‑on‑add** — `ChannelMembersScreen.add` calls `drainMembershipIntents()` so the new member is added to the Signal group + rekeyed immediately, not on the admin's next list visit                                                                                                                                                                                                                                         | `ChannelMembersScreen.tsx`                                                                                   |
| E.2          | Add member as**view‑only or post**                                                                     | `addMember` role (viewer/admin) + in‑thread **toggle access** (`updateMemberRole`, metadata‑only, no rekey)                                                                                                                                                                                                                                                                                                                     | `department.service.ts`, `ChannelMembersScreen.tsx`, `api.ts`                                                |
| E.2          | **See members + access in‑thread**                                                                     | Admin‑only**Members** button in the chat header → `ChannelMembersScreen` (avatar, role, "can post / read only", access toggle, remove)                                                                                                                                                                                                                                                                                          | `DepartmentChatScreen.tsx`, `ChannelMembersScreen.tsx`, `navigation/types.ts`                                |
| E.2          | **Delete thread — creator only**                                                                       | `deleteChannel` (created_by‑gated cascade) + creator‑only "Delete channel" footer (`isOwner`)                                                                                                                                                                                                                                                                                                                                   | `department.service.ts`, `department.controller.ts`, `ChannelMembersScreen.tsx`, `api.ts`                    |
| D4‑a         | `addMember` cross‑tenant                                                                               | **Tenant scope** — reject adding a user not in the channel's org (`member_not_in_org`), org account exempted                                                                                                                                                                                                                                                                                                                    | `department.service.ts`                                                                                      |

### F.2 Verification

- **Backend** — `department.service.spec.ts` 25/25 green; auth tsc 0; image rebuilt; `/ready` 200; all new routes mapped (`PATCH …/members/:userId/role`, `DELETE …/channels/:id`, `POST …/channels/:id/reset-group`).
- **Client** — mobile tsc **47 ≤ 49** baseline (zero errors in changed files); lint clean (2 pre‑existing `any` warnings, within limit); APK vc103 built + `adb install` OK + launched.
- **Device (member side, `arifultex28`)** — DEPT_CHAT_V2 live; opens the **Operations** default channel; correct **read‑only "You are a viewer"** state; no "explicit peer address" in logcat on the viewer path.

### F.3 Remaining limitations (not blocking)

1. **Agency‑side flows** (owner reactivation, add‑member→deliver, creator‑delete) are code/unit/deploy‑verified but **not yet end‑to‑end device‑verified** — they need the agency account logged in (ideally a 2nd device while the CPO stays on this one). Hand‑off test script provided.
2. **Non‑owner on an orphaned channel** still hits the in‑chat error with no in‑app recovery (only the owner is the key source). Proper fix = a viewer‑side **key‑request self‑heal** to the owner (follow‑up, larger change).
3. **History backfill (D2‑c)** — a newly‑added member receives posts from join‑point forward only (sealed‑sender has no replay). Separate feature.
4. **Role is a UI affordance, not a crypto boundary** (pre‑existing dept‑chat property) — a "viewer" already holds the group key; the composer is hidden client‑side. Out of scope for this batch.

---

## F. A‑to‑Z remediation plan (ordered, safe, test‑first)

> Rule: **write the failing test first, fix, then re‑run the suite.** No fix may raise the
> tsc baseline or break `messenger-crypto`/`booking` projects. Each step is independently
> shippable.

**P0 — make a message reach members at all (the reported bugs + the deepest cause)**

1. **Send recipients from the dept roster / mirror into `conversation_members`** (D3‑a/b).
   Test: a 2nd admin / fresh‑login admin can post and all members receive it.
2. **Register the group _before_ fan‑out + handle 0‑delivered + fix adoption** (D1‑d, D1‑e,
   D1‑f). Test: provisioning a channel whose members have no keys still registers a stable
   `group_conversation_id`; a raced 2nd‑open adopts the canonical id and can send.
3. **Eager idempotent provisioning at create + first open** (D1‑a/b/c, D3‑c). Test: a new
   or default channel is `provisioned` before anyone opens it; a solo/admin‑only channel
   provisions.
4. **Drain‑on‑add, owner‑routed, with no‑op settling** (D2‑a/e/f/g) + **history backfill**
   (D2‑c) + **self‑heal hydration** (D2‑d). Test: add a CPO, post **without** revisiting the
   list → the CPO sees the message **and** recent history; intents never churn.

**P0 — security/tenancy (ship with the above)** 5. **Tenant‑scope `addMember`** to active org members of the channel's org (D4‑a). 6. **Account‑active check** in `DeptChatAccessGuard`/`OrgManagerGuard` (D4‑c); **validate +
reset path** for `registerGroup` (D4‑b); **DTO validation** (D4‑e); **tighten‑txn** (D4‑d).

**P1 — reliability + honesty** 7. Surface provisioning failures + Retry, distinct list/badge states, focus re‑check
(D1‑f..i, D5‑a/b). Real `signal_device_id` (D2‑h, multi‑device‑gated).

**P1 — attendance/incident correctness** 8. `editShift` open‑shift preservation (D6‑a); reject terminal status (D6‑b); rollup respects
day‑status (D6‑c); tz‑correct `myTodayShift` (D6‑d); incident‑assign FSM+event (D7‑a);
loosen re‑seed (D7‑b); minor: D6‑e/f, D7‑c.

**P2 — robustness then features** 9. Provisioning service, scheduled drain, observability, receipts/outbox UI (E.1) → then
new features (E.2) by priority.

**Security stop‑conditions (do not violate):** the server must never hold a group master
key; rekey stays member‑to‑member; restricted/incident visibility stays enforced by
membership seeding; no plaintext/keys in logs (`logAudit`). Any change touching sealed‑
sender, group‑key distribution, or rekey/epoch must be checked against the System
Architecture Documentation first.

---

## G. How to verify end‑to‑end (3 accounts, one or two devices)

1. **Provisioning:** as a manager, create a channel → it shows **Active** immediately
   (eager provision), not "Not yet active".
2. **Default channel send (BUG‑3):** fresh org, no CPOs → open _Operations_ → either post
   succeeds (solo provision) or a clear "Add a member to activate" state — never a dead
   composer.
3. **Add‑member delivery (BUG‑2):** manager adds CPO → **without revisiting the list**,
   post a message → log in as the CPO → the message **and** recent history appear on the
   thread.
4. **Remove‑member:** remove the CPO → they lose access on their next open (rekeyed out).
5. **Regression:** `npm run test:crypto`, `npm test -- --selectProjects=booking`,
   `npm run typecheck` (≤ baseline), `cd apps/auth-service && npm test` (department +
   attendance + incident specs), then a manual 1:1 and group‑chat smoke (shared runtime).

---

_Appendix — key files:_ `src/screens/messenger/DepartmentChannelsScreen.tsx`,
`DepartmentChatScreen.tsx`; `src/screens/deptchat/{ChannelEditorScreen,ChannelMembersScreen, ManageChannelsScreen,useDeptUnread}.tsx`; `src/modules/messenger/orgWorkspace/membershipIntents.ts`;
`apps/auth-service/src/department/{department.service,dept-chat-access.guard}.ts`,
`conversations/conversations.service.ts`, `attendance/attendance.service.ts`,
`incident/incident-fsm.ts`; migrations `20260603000000_pro_subscription_and_dept_channels.sql`,
`20260629000002_channel_types.sql`.

---

## H. Implementation log — 2026‑06‑30 (this session)

> Method: each item implemented test‑first / test‑backed, then verified. Gates green throughout:
> mobile `tsc` **47 ≤ 49**, lint clean (only pre‑existing `any` warnings), auth‑service `tsc` **0**,
> `npm run test:crypto` **1125/1125**, auth specs all green. New SQL validated against the live
> schema via read‑only `EXPLAIN`. No security stop‑condition was improvised.

### H.1 Fixed + verified

| ID   | Fix                                                                                                                                                                                                                                                                                                                                                                                    | Files                                                  | Test                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------- |
| D6‑a | `editShift` only closes (`status='edited'`) on a `clock_out_at` edit; editing an open shift's clock‑in preserves `'open'` (CPO can still clock out, open‑guard holds)                                                                                                                                                                                                                  | `attendance.service.ts`                                | `attendance.service.spec` |
| D6‑b | Reject drives `attendance_status` to terminal `'absent'` (leaves the `pending_review` bucket in reporting)                                                                                                                                                                                                                                                                             | `attendance.service.ts`                                | ✓                         |
| D6‑c | Auto‑absent rollup skips a CPO with a manager day‑status marker (leave/sick/off_duty/absent) for the shift's date                                                                                                                                                                                                                                                                      | `attendance-rollup.service.ts`                         | EXPLAIN‑validated         |
| D6‑d | `myTodayShift` bounds "today" by a tz‑independent forward lead window (`NOW()+12h`) instead of `date_trunc('day', NOW())` (UTC)                                                                                                                                                                                                                                                        | `attendance.service.ts`                                | ✓                         |
| D6‑e | **Backend ready** — distinct `camera_unavailable` review reason (`deriveCheckIn` + `ReviewReason`). ⚠️ Migration `20260630000000_attendance_review_reason_camera.sql` **written but NOT applied** (auto‑mode blocked the live apply — needs explicit authorization). Client unwired + DTO field withheld until the CHECK is live, so the code path is inert (no CHECK‑violation risk). | `attendance.service.ts`, migration                     | `deriveCheckIn` test      |
| D6‑f | `setDayStatus` upserts (delete‑then‑insert in a txn) → one marker per CPO per day                                                                                                                                                                                                                                                                                                      | `attendance.service.ts`                                | ✓                         |
| D7‑a | Incident `assign` runs in a txn with `FOR UPDATE`, rejects terminal (resolved/closed) status, and writes an `incident_events` timeline row                                                                                                                                                                                                                                             | `incident.service.ts`                                  | `incident.service.spec`   |
| D7‑b | `configureChannel` **loosen** branch re‑seeds CPO viewers via `addMember` (add+rekey intent), so a loosened channel isn't stuck managers‑only                                                                                                                                                                                                                                          | `department.service.ts`                                | `department.service.spec` |
| D7‑c | `department` clears via an explicit‑empty‑string sentinel (`CASE` instead of `COALESCE`); `ConfigureChannelDto.department` relaxed to allow `''`                                                                                                                                                                                                                                       | `department.service.ts`, `dto/channel.dto.ts`          | ✓                         |
| D4‑c | `DeptChatAccessGuard` + `OrgManagerGuard` company path now requires `status='ACTIVE'` → a suspended company loses access                                                                                                                                                                                                                                                               | `dept-chat-access.guard.ts`, `org-manager.guard.ts`    | `org-manager.guard.spec`  |
| D4‑e | Validated DTOs (`RegisterGroupDto`/`AddMemberDto`/`UpdateMemberRoleDto`) on the membership/group endpoints (global ValidationPipe enforces)                                                                                                                                                                                                                                            | `department.controller.ts`, `dto/channel.dto.ts`       | tsc                       |
| D1‑h | `DepartmentChatScreen` tracks the group id in local state + re‑reads the channel on focus → "not yet active" clears the instant an admin provisions                                                                                                                                                                                                                                    | `DepartmentChatScreen.tsx`                             | —                         |
| D1‑i | Channel row badge shows `INACTIVE` for an un‑provisioned channel (was ACTIVE/ADMIN, contradicting the "Not yet active" preview)                                                                                                                                                                                                                                                        | `DepartmentChannelsScreen.tsx`                         | —                         |
| D5‑b | Single load path (dropped the redundant `useEffect`; `useFocusEffect` already fires on mount) + an in‑flight guard coalescing concurrent `drainMembershipIntents`                                                                                                                                                                                                                      | `DepartmentChannelsScreen.tsx`, `membershipIntents.ts` | `membershipIntents.test`  |
| D2‑e | Drain defers cleanly (skip, never ack) on `unknown group` — a non‑provisioning device leaves the intent for the device that holds the group state                                                                                                                                                                                                                                      | `membershipIntents.ts`                                 | `membershipIntents.test`  |
| D2‑g | Drain settles idempotent no‑op intents (`already a member` / `is not a member`) by acking them → no infinite churn                                                                                                                                                                                                                                                                     | `membershipIntents.ts`                                 | `membershipIntents.test`  |

> The intent‑lifecycle fixes (D2‑e/g) change **only** ack/skip/retry decisions — the rekey
> operations (`addGroupMember`/`removeGroupMember`) are untouched, so no key material, epoch, or
> recipient set is altered.

### H.2 Send/key path — implemented (gates green; **3‑device smoke recommended** before flip)

These touch the **security stop‑conditions** (group‑key distribution / sealed‑sender recipient set),
so each was implemented to UPHOLD the documented invariants (server never holds the master key;
rekey stays member‑to‑member; recipients come from server‑authoritative membership) and verified by
`tsc` + `npm run test:crypto` (1125/1125). Final device smoke is the standing pattern for crypto.

| ID              | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Files                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **D3‑a/b (🔴)** | On opening a dept thread, **hydrate `convo.participants` from the server‑authoritative `departmentApi.listMembers`** (keyed by the exact group id). Dept groups are never in `/conversations/mine`, so fresh‑login / 2nd‑admin had empty participants → the fan‑out threw "no other participants". listMembers IS authoritative (upholds the `productionRuntime.ts:1753‑1763` invariant); **metadata only — never touches the master key** (which lives in `store.groups`). | `DepartmentChatScreen.tsx`                                  |
| **D2‑d**        | The same hydration gives the receiver self‑heal (`requestGroupKeyResync`) a local conversation + participants to request the key from (it previously no‑oped with 0 participants). Resync runs **after** hydration.                                                                                                                                                                                                                                                         | `DepartmentChatScreen.tsx`                                  |
| **D1‑d (🔴)**   | `createGroupChat({allowZeroDelivered:true})` — a 0‑delivered provision (members have no Signal keys yet) now **returns + registers a stable group id** instead of throwing before `registerGroup` (which re‑forged a fresh master key every open). Local state is kept; members are keyed later via add‑intents / self‑heal. Default `false` → 1:1 group create unchanged.                                                                                                  | `runtime.ts`, `productionRuntime.ts`, `provisionChannel.ts` |
| **D2‑b**        | `ChannelMembersScreen.add` now **awaits** `drainMembershipIntents()` (row stays busy) so the new member's rekey lands before the admin can post — a post sent before it would never reach them (no sealed‑sender replay).                                                                                                                                                                                                                                                   | `ChannelMembersScreen.tsx`                                  |

### H.3 Addressed via other fixes / by‑design (no separate change needed)

- **D2‑f** — closed by **D2‑e**: an admin device without the group state hits `unknown group` and now
  **skips (never acks)**, so the intent waits for the key‑holding device — a non‑owner can no longer
  leave a CPO permanently keyless. (Routing intents to `created_by` was rejected: the channel creator
  is not guaranteed to be the master‑key holder, so it could starve draining.)
- **D1‑e** — the raced‑adoption send‑throw symptom is covered by **D3‑a/D2‑d** (the canonical convo
  gets hydrated participants) + the existing adopt‑canonical‑id‑for‑navigation + self‑heal resync. The
  orphan local fork stays under the minted id that is never navigated to (harmless).
- **D4‑b** — `registerGroup` is already **admin‑gated** (`only_admin_can_register_group`) and the owner
  **reset/re‑provision** path exists. Cryptographic proof that the caller minted a salt‑derived id
  isn't feasible server‑side (the server never sees the key); admin‑gate + reset is the mitigation.
- **D2‑h** — `deviceId: 1` is **intentional single‑device**, NOT a live bug; revisit when multi‑device ships.

### H.4 Remaining follow‑ups (by‑design / deploy, not bugs)

- **D2‑c** — history backfill: a newly‑keyed member sees posts from join‑point forward (sealed‑sender
  has no replay = forward secrecy by design). Re‑sealing recent N to a new member is an **enhancement**,
  not a bug; scope it separately (access‑gated).
- **D4‑d (PARTIAL)** — verify‑removals‑before‑flip is done; full row‑lock serialization of the tighten
  txn needs threading a tx through `addMember`/`removeMember` (a broader transactional refactor).
- **D6‑e** — ✅ CLOSED 2026‑07‑02: migration applied; `face_unavailable` added to `ClockInDto`
  (whitelist‑pipe regression test), `VerifyAttendanceScreen` sends it on camera denial, and
  `reviewReasonLabel` renders `camera_unavailable`. Wired end‑to‑end.
