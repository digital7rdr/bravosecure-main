 

# Enterprise Department Channels (Scope v2) — What It Is, and How It Fits What We Already Built

**Source:** `Bravo_Department_Channels_Enterprise_Mobile_Scope_v2.pdf` (10 pages, Developer Handover)
Copied to `docs/planning/source/` — but **`.gitignore:68` excludes `*.pdf`**, so it is local-only
and will NOT be in a fresh clone. Ask the founder before force-adding it (9.5 MB binary).

> ⚠️ **Reading this PDF: the prose and the mockups disagree, and only 18k characters are
> extractable text.** Seven of the ten pages are full-page mockup images, and the plan-panel
> copy lives _inside_ those images. A text-layer extraction finds "Employee" exactly once (in
> the A7.3 instruction to remove it) and concludes the word is absent — but pages 2 and 7
> render "Employee Attendance" and "Employee Verification" in the Enterprise plan panels.
> **Read the rendered pages, not just the text layer**, or you will confidently cite an
> absence that isn't there. This cost a full review round.
> **Written:** 2026-08-03
> **Repo state when written:** `main` @ `787fd3d`

This document is written in plain English on purpose. It answers three questions:

1. **What is this thing trying to build?**
2. **How much of it do we already have?**
3. **What's the step-by-step way to finish it without breaking Messenger?**

---

## Part 1 — The vision, in one page

### The simple version

Right now Bravo Secure is a **secure messenger for people**. This scope turns it into a
**secure messenger for companies**.

Think of it like the difference between **WhatsApp** and **Slack**.

- WhatsApp: you add friends, you make groups, everyone is equal.
- Slack: a company owns the space, an admin decides who gets in, channels are arranged by
  department, and some channels you can read but not post in.

That's the jump. A company ("Enterprise") signs up, an **Admin** builds the structure, and
**Members** ask to join and only see what they're allowed to see.

### The four things a company gets

The PDF is strict that this build has **exactly four modules** — nothing else:

| Module                  | What it's for, in plain words                                      |
| ----------------------- | ------------------------------------------------------------------ |
| **Department Channels** | Work chat rooms, organised like a company org chart                |
| **Attendance**          | Who's on shift, who's late, who's on leave — rosters and check-ins |
| **Incidents**           | Report a problem, track it until it's resolved                     |
| **Vault**               | Company files, locked behind permissions and MFA                   |

Meetings and Events are **deferred** — the PDF says don't even leave hidden stubs for them.

### The one rule that matters most

> **The server decides everything. The app just draws it.**

Every page of the PDF repeats this. Hiding a button is not security. If a Member shouldn't
see a channel, the server must never send that channel — not its name, not its member count,
not even the fact that it exists. The PDF calls this "hidden metadata is filtered by the
server, not merely hidden by the client."

This matters for us because it's a **backend-heavy scope**. Most of the remaining work is in
`apps/auth-service`, not in React Native.

### The second rule that matters most

> **Department Channels must never look like a Messenger group.**

The PDF says this twice (A1 and M1). Under the hood a channel _is_ an encrypted Signal group
— that's how our E2EE works and that's fine. But the **user must never experience it as
"just a group chat."** It's a workspace with its own home screen, its own hierarchy, and its
own rules.

Good news: we already built it that way. See Part 3 — the workspace is a separate navigator
with its own tabs, not a group thread.

### What it looks like when it's finished

Picture a security company with 400 staff.

**The boss (Admin)** opens Bravo. They don't see a chat list — they see a **control room**:
12 people late this morning, 3 open incidents, 5 people waiting to be let into the workspace.
They tap "Approve" on a new guard who scanned a referral link at induction. They publish next
month's roster to 60 people in one action. They post a notice to `#broadcast` that every
single employee sees and nobody can reply to.

**The guard (Member)** opens the same app. They see **their own day**: next shift at 18:00 at
the Sandton site, a toggle to go On Shift (which records where they were when they tapped it),
their two open incident reports, and the four channels they're allowed into. They cannot see
the Board channel. They cannot see that a Board channel exists. They cannot see how many
people are in it.

**The same app, the same encryption, two completely different worlds** — and the difference is
decided entirely by the server.

### Why this is worth building

- It changes **who pays**. One employee paying for a messenger is a small sale. A company
  paying per-seat for attendance, incidents, channels and a file vault is a much bigger one.
- It **uses what we already have**. Attendance, incidents, channels and vault screens are
  already built. This scope mostly adds _structure and permissions_ on top.
- It's **hard to copy**. Plenty of apps do team chat. Very few do team chat where the server
  can't read the messages. That's our moat, and this scope sells it to businesses.

### What it is NOT

Worth being clear, because scope creep here is expensive:

- **Not a desktop product.** Phone only. The PDF says desktop is out of scope entirely.
- **Not Meetings or Events.** Deferred — and the PDF explicitly forbids leaving hidden stubs.
- **Not a redesign.** The Vault keeps its current design. The dark obsidian look stays. We are
  adding structure, not restyling.
- **Not five levels.** Exactly four. This is a hard limit, best enforced in the database.

---

## Part 2 — The two journeys

### The Admin journey (frames A1–A11)

The person who runs the company workspace.

```
Welcome  →  Pick Enterprise plan  →  Make account  →  "I'm an Admin"
   →  Build the workspace (name, logo, first channel, invite other admins)
   →  Land on Admin Home
        ├── Attendance   (shifts, roster, day status, corrections)
        ├── Incidents    (queue, assign, escalate, resolve)
        ├── Channels     (create/rename/archive, set who sees what)
        ├── Vault        (company files)
        └── Approvals    (approve/decline people asking to join)
```

**The important catch (A4):** choosing "Admin" on a screen does **not** make you an admin.
It just picks which road you walk down. Real authority only comes from the backend — you
either founded the Enterprise, accepted an Admin invite, or were promoted later. The PDF is
blunt: _"Never rely on hidden UI controls as the security boundary."_

### The Member journey (frames M1–M11B)

The employee.

```
Welcome  →  Pick Enterprise plan  →  Make account  →  "I'm a Member"
   →  Open a referral link / enter a code  →  Submit request
   →  WAIT (see nothing at all)  →  Admin approves
   →  Land on Member Home
        ├── My Attendance  (my shifts, On Shift / Off Shift toggle)
        ├── My Incidents   (report one, track mine)
        ├── Channels       (only what I'm allowed to see)
        └── Vault          (only files shared with me)
```

**The important catch (M11A):** while pending, the Member sees **absolutely nothing** — not
a channel list, not a member count, not the company structure. Pending means blank.

---

## Part 3 — How the screens connect

Every route name below is **real** — taken from `src/navigation/DepartmentalNavigator.tsx`.
Nothing here is invented.

### 3.1 — How you get in

The Enterprise workspace is **not** a tab on the main app. It's a whole navigator that lives
_inside_ Messenger:

```
App
 └── MainNavigator
      └── MessengerTab  →  MessengerNavigator
                            ├── MessengerHome        ← normal chat list
                            ├── DepartmentChannels   ← the entry card
                            └── Departmental         ← THE WORKSPACE  (line 187)
                                 └── DepartmentalNavigator
```

**In plain words:** you open Messenger, tap the Department Channels card, and you land in a
completely different world with its own bottom tabs. That's exactly what the PDF wants when
it says _"Department Channels must never be hidden inside Messenger Groups"_ — it isn't a
group, it's its own place.

> ⚠️ **A trap that already bit us once.** `DepartmentChannels` is registered in
> `MessengerNavigator` but **not** in `AgentNavigator`. A service-provider account sitting in
> the Agent shell had no such route in the mounted tree, so `navigate()` bubbled to the root
> and was **silently dropped** — "the card does not open." That's why
> `src/navigation/departmentalEntry.ts` exists: `findNavigatorWithRoute()` walks the navigator
> and all its ancestors and picks the first one that actually has the route.
> **Rule: never hard-code a route name from a screen that more than one navigator hosts.**
> Any new Enterprise entry point must use that helper.

### 3.2 — The workspace itself (what exists today)

`DepartmentalNavigator` is a **bottom-tab navigator with five tabs**, each holding its own
stack:

```
DepartmentalNavigator  (bottom tabs)
│
├── Home       → DepartmentalHomeScreen        ← frames A6 / M6 (the 4 cards)
│
├── Channels   → DepartmentChannels            ← frame M8  (the list)
│                  ├── DepartmentChat          ← frame M9  (the thread; NO call buttons)
│                  │      └── ChannelMembers
│                  └── ManageChannels          ← frame A9  (admin only)
│                         ├── ChannelEditor
│                         └── ChannelMembers
│
├── Attend     → Attendance                    ← frames A7 / M7
│                  ├── MyAttendance            (member view)
│                  ├── VerifyAttendance  →  AttendanceResult
│                  ├── AdminAttendance         (admin view)
│                  │      └── ShiftManagement  →  ShiftEditor      ← frame A7.1
│                  └── DayStatus                                   ← frame A7.3
│
├── Incident   → MyIncidents                   ← frames A8 / M10
│                  ├── MyIncidentDetail
│                  ├── ReportIncidentCategory → ReportIncidentDetails → IncidentSubmitted
│                  └── IncidentQueue  →  IncidentDetail             (admin)
│
└── Vault      → MessengerHome (FilesScreen)   ← frames A10 / M11B
                   ├── VaultLock  →  VaultScreen
                   ├── VaultNewPin / VaultForgot / VaultOTPVerify
                   └── FileVaultPurchase
```

**How Home connects to everything else:** `DepartmentalHomeScreen` doesn't own content — it's
a launchpad. Its four cards deep-link straight into the tabs
(`navigation.navigate('Channels')`, `navigate('Vault')`, and so on), and it shows live counts
(open incidents, today's shift chip) pulled on focus.

**How Admin and Member share screens:** they mostly _don't_ get different screens — they get
different **destinations from the same tab**. `DepartmentalHomeScreen.tsx:45` computes
`isManager` once, then:

| Tab      | Member lands on      | Admin lands on    |
| -------- | -------------------- | ----------------- |
| Attend   | `MyAttendance`       | `AdminAttendance` |
| Incident | `MyIncidents`        | `IncidentQueue`   |
| Channels | `DepartmentChannels` | `ManageChannels`  |

That's a good pattern and the new work should follow it rather than building parallel screens.

### 3.3 — The flow the PDF wants (and where the new screens slot in)

Everything marked **`NEW`** does not exist yet.

**Admin path — from nothing to a running workspace:**

```
Splash → Onboarding            (exists, AuthNavigator)
   ↓
PricingScreen                  (exists — must hide "Professional")   ← A2
   ↓
Register                       (exists)                              ← A3
   ↓
SelectRole              NEW    "Admin or Member?"                    ← A4
   ↓  (Admin)
CreateWorkspace         NEW    name, logo, country, timezone         ← A5
   ↓                           + invite admins by phone / email
   ↓                           + create first Main channel
   ↓                           + auto-create #broadcast
   ↓
Departmental → Home            (EXISTS — DepartmentalHomeScreen)     ← A6
   │
   ├── Channels → ManageChannels (exists) → ChannelEditor (exists)
   │                └── needs: parent/level picker, 4th post mode
   │
   ├── Attend → AdminAttendance (exists)
   │                ├── ShiftManagement → ShiftEditor  (exists)      ← A7.1
   │                ├── MonthlyRoster        NEW                     ← A7.2
   │                ├── DayStatus            (exists)                ← A7.3
   │                └── AttendanceCorrections NEW                    ← A7.4
   │
   ├── Incident → IncidentQueue → IncidentDetail  (exists)           ← A8
   │
   ├── Vault → FilesScreen (exists, needs org scoping)               ← A10
   │
   └── Approvals            NEW    join requests inbox               ← A11
                                   → Approve / Decline
```

**Member path — from nothing to working:**

```
Splash → Onboarding → PricingScreen → Register       (all exist)   ← M1–M3
   ↓
SelectRole              NEW                                        ← M4
   ↓  (Member)
JoinWorkspace           NEW    open referral link / enter code     ← M5
   ↓                           confirm name, mobile, email
   ↓                           → Submit Request
   ↓
ApprovalStatus          NEW    PENDING = a blank wall.             ← M11A
   ↓                           No channels, no counts, no metadata.
   ↓  (Admin approves — push notification arrives)
   ↓
Departmental → Home            (EXISTS)                            ← M6
   ├── Attend   → MyAttendance      (exists — On/Off Shift toggle) ← M7
   ├── Channels → DepartmentChannels (exists — needs 4-level grouping) ← M8
   │                 └── DepartmentChat (exists)                   ← M9
   ├── Incident → MyIncidents / ReportIncident… (exists)           ← M10
   └── Vault    → FilesScreen (exists, needs org scoping)          ← M11B
```

### 3.4 — The one connection that carries the whole feature

```
Member taps referral link
        ↓
   JoinWorkspace  NEW   ──────►  creates a PENDING record on the server
        ↓                              ↓
   ApprovalStatus NEW           push notification to Admin
   (shows nothing)                     ↓
        ↑                        Approvals  NEW
        │                              ↓
        │                    Approve ──┴── Decline
        │                        ↓            ↓
        └──── push notification ─┘      stays blank forever
                   ↓
        Member's Home unlocks with the
        channels of the team they were referred into
```

If this loop works, the product works. Everything else is screens that already exist.

Two rules the PDF is strict about here:

- **First decision wins.** If two Admins act at once, the second gets a conflict message —
  never a silent overwrite.
- **Pending means blank.** Filter on the server. A pending Member must not receive channel
  names, member counts, or even the fact that a channel exists.

### 3.5 — The navigation conflict to resolve

The PDF says (four separate times) _"Primary bottom navigation is always Home and Messenger
only."_

Our `DepartmentalNavigator` currently has **five** tabs: Home, Channels, Attend, Incident,
Vault (`DepartmentalNavigator.tsx:163–167`).

These can be reconciled — page 10 of the PDF also says _"internal tabs remain contextual"_ —
so the likely reading is: the **app-level** bar is Home + Messenger, while the workspace's own
tabs are "internal" and allowed. But it's ambiguous enough that it's listed as a founder
question in Part 9. **Don't rebuild the tab bar until that's answered** — it's a large change
that touches other Bravo products.

---

## Part 4 — What we already have

This is the good news, and it's a lot. We are **not** starting from zero.

### Already built and working

`src/screens/deptchat/` already contains 26 files:

| PDF frame                    | We already have                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------- |
| **A6 / M6** Home Dashboard   | `DepartmentalHomeScreen.tsx` — already has the exact four cards                   |
| **A7** Admin Attendance      | `AdminAttendanceScreen.tsx`                                                       |
| **A7.1** Manage Shifts       | `ShiftManagementScreen.tsx` + `ShiftEditorScreen.tsx`                             |
| **A7.3** Set Day Status      | `DayStatusScreen.tsx`                                                             |
| **A8** Admin Incidents       | `IncidentQueueScreen.tsx` + `IncidentDetailScreen.tsx`                            |
| **A9** Manage Channels       | `ManageChannelsScreen.tsx`, `ChannelEditorScreen.tsx`, `ChannelMembersScreen.tsx` |
| **M7** My Attendance         | `MyAttendanceScreen.tsx` + `VerifyAttendanceScreen.tsx`                           |
| **M8** Visible Channels      | `DepartmentChannelsScreen.tsx`                                                    |
| **M9** Inside Channel Chat   | `DepartmentChatScreen.tsx` — its own screen, no call buttons                      |
| **M10** Member Incidents     | `MyIncidentsScreen.tsx`, `ReportIncident*`, `IncidentSubmittedScreen.tsx`         |
| **A1–A3 / M1–M3** onboarding | Splash / Onboarding / Register already exist in`AuthNavigator`                    |

Backend modules that already exist in `apps/auth-service/src/`: `attendance`, `incident`,
`department`, `org`, `subscription`.

**The server-side enforcement layer already exists too** — this matters more than it sounds,
because "enforced server-side" is the PDF's central demand:

- `apps/auth-service/src/department/dept-chat-access.guard.ts` — a dept-chat access guard
- `apps/auth-service/src/org/org-manager.guard.ts` — the org tenancy guard
- `supabase/migrations/20260603100000_enable_rls_deny_by_default.sql` — row-level security is
  already **deny-by-default**

So for permissions we are **extending guards that exist**, not building a permission system
from zero. That meaningfully lowers the risk on the hardest requirement in the PDF.

The `enterprise` subscription tier **already exists** (`PricingScreen.tsx:27` — tiers are
`lite`, `pro`, `enterprise`).

`DepartmentalHomeScreen.tsx:45` already splits Admin vs Member with `isManager`.

**Rough estimate: about 60% of the screens in this PDF already exist in some form.**

### The single most useful thing we already got right

`DepartmentalHomeScreen` already shows exactly the four cards the PDF asks for
(Attendance, Incidents, Channels, Vault) and already switches labels by role
("Attendance" vs "My attendance", "Incidents" vs "Report incident"). Frames A6 and M6
are essentially **done**.

---

## Part 5 — What's missing

Here's the honest gap list, ordered by how hard it is.

### 🔴 Gap 1 — The four-level hierarchy (this is the big one)

**What the PDF wants:** exactly four levels — Enterprise → Main → Sub → Sub-sub. No fifth.

**What we have:** a completely **flat** list.

`supabase/migrations/20260603000000_pro_subscription_and_dept_channels.sql:25` defines
`department_channels` with **no `parent_id` and no `level`**. The `department` column is just
a free-text label like `'Operations'` — it's a sticker on the channel, not a real tree.

**Analogy:** right now our channels are like files dumped loose in one folder, with the
department name written on each one in marker pen. The PDF wants actual nested folders.

This is the deepest change because it touches the database, the list APIs, the permission
checks, and every screen that draws a channel list.

### 🔴 Gap 2 — Join requests and approvals (A11, M5, M11A)

There is **no** "ask to join → Admin approves/declines" flow for Department Channels at all.

We do have referral/invite code tables — `20260725140000_provider_referral_codes.sql` and
`20260725170000_provider_invite_codes.sql` — but those are for the **agency/CPO** side of the
product, a different feature. They're a useful _pattern_ to copy, not something to reuse
directly.

Missing pieces: the referral link that remembers which team you came from, the pending
record, the Admin approval inbox, Approve/Decline, and the "first decision wins, second Admin
gets a conflict message" rule.

### 🔴 Gap 3 — Enterprise Vault vs personal Vault (A10, M11B)

`VaultScreen.tsx` has **no org scoping at all** — it's purely personal files today.

The PDF wants company files kept **separate** from the user's personal Messenger Vault, with
permissions inherited from the channel/incident the file belongs to, plus an MFA gate.

Good news: the PDF explicitly says _"Use the existing Bravo Vault design and core behaviour
without redesign."_ So this is a **scoping** job, not a redesign job.

### 🟠 Gap 4 — Monthly Roster (A7.2) and Attendance Corrections (A7.4)

We have day-by-day shift creation. The PDF says that's **not enough** — full calendar-month
planning is _mandatory_, with Draft / Published / Amended / Archived states, copy day/week/
month, templates, and conflict flagging before publish.

Corrections (A7.4) don't exist at all. The rule there is strict: **never overwrite the
original record** — keep before/after forever, with who changed it, when (server time) and
why.

### 🟠 Gap 5 — The onboarding route (A2, A4, A5 / M2, M4, M5)

We have a Register screen and a Pricing screen, but not the specific Enterprise route:
plan → role choice → build-workspace-or-join. Also, the PDF says the **Professional plan must
not appear** anywhere in this flow (our `PricingScreen` currently shows all three tiers).

### 🟡 Gap 6 — Channel modes: we have 3, the PDF wants 4

Today (`20260629000002_channel_types.sql:17`) `access` is:
`'standard' | 'read_only' | 'restricted'`

The PDF wants four _communication_ modes: **Open Chat, Read-only, Announcement-only,
Admin-only**.

Note these are two different ideas that we currently mash into one column:

- **who can SEE it** (visible / hidden / restricted)
- **who can POST in it** (everyone / admins only / nobody)

The PDF treats them separately: _"Visible does not automatically grant posting, upload or
management rights."_ We'll need to split this into two columns.

### 🟡 Gap 7 — Mandatory `#broadcast` at every level

Every level must automatically get a `#broadcast` channel that **cannot be deleted** and where
Members **cannot post, reply or call**. We don't create these at all today.

### 🟡 Gap 8 — Bottom navigation must be Home + Messenger only

The PDF repeats this on four separate pages. Our `MainNavigator.tsx` currently has more tabs
(`MessengerTab`, `Secure`, `ProfileTab`, Jobs…). This needs a **workspace-scoped** tab bar —
which is a UX decision, because those other tabs belong to other Bravo products.

### ✅ Not a gap — the "no call button" rule is already satisfied

**PDF frames A9 and M9 both say: "No phone/call button appears in Department Channel chat;
calls remain in Messenger."**

We already comply. Department Channels do **not** reuse the normal `ChatScreen` — they have
their own dedicated screen, `src/screens/messenger/DepartmentChatScreen.tsx`, registered as
the `DepartmentChat` route (`DepartmentalNavigator.tsx:87`). That screen has **no call
affordance at all** — no phone icon, no video icon, no `launchCall`.

(The normal `ChatScreen.tsx:1719–1725` does render call buttons unconditionally, but that
screen is never used for a Department Channel, so the rule holds.)

**Keep it that way.** If anyone ever "unifies" `DepartmentChatScreen` into `ChatScreen` to
reduce duplication, the call buttons come back and this rule silently breaks. Worth a source
scan test to pin it.

---

## Part 6 — The step-by-step plan

Ordered so that each phase is shippable on its own and nothing breaks Messenger.

### Phase 0 — Free wins (a day or two)

Do these first because they're cheap.

**STATUS: ✅ DONE** (after a failed first attempt — see the build log).

1. **Rename any leftover "Employee" / "CPO" labels to "Member"** (A7.3) — across
   `deptNoun.ts`, `DayStatusScreen`, `EmployeesScreen` and `DepartmentChannelsScreen`,
   **and the server write path**.
2. **Pin the "no call button in channel chat" rule with a source-scan test**, so a future
   refactor that merges `DepartmentChatScreen` into `ChatScreen` can't silently break it.

> **Process note — do not repeat this.** The first pass changed only `deptNoun.ts`, then
> _edited this item down to say only `deptNoun.ts`_ and marked the phase done. Narrowing the
> acceptance criteria to match the diff is not completion. The original wording (which named
> `EmployeesScreen.tsx`) has been restored above, and the phase was only re-marked done once
> the wider work actually landed.

> **Item removed from Phase 0 → moved to Phase 6.** The original plan said "hide Professional
> from the Enterprise onboarding route — a filter on `PricingScreen`." That was wrong.
> `src/screens/settings/PricingScreen.tsx` is the **Settings → Pricing** screen where any user
> manages their own plan; it is not an onboarding screen. Filtering it would break plan
> management for every user in the app. The screen the PDF's A2/M2 rule actually governs
> (the Enterprise plan step _during onboarding_) **does not exist yet** — so the rule can only
> be satisfied when that screen is built, in Phase 6.

#### Phase 0 build log

| What                                                             | File                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Enterprise noun → Member                                         | `src/screens/deptchat/deptNoun.ts`                                        |
| Fixed a consumer that string-compared the noun                   | `src/screens/deptchat/DayStatusScreen.tsx`                                |
| Hardcoded`CPO` section heading → live noun                       | `src/screens/deptchat/DayStatusScreen.tsx`                                |
| 7 visible Employee strings → role-bound noun                     | `src/screens/deptchat/EmployeesScreen.tsx`                                |
| Second helper`deptEmployeeNoun` (role-bound, never CPO)          | `src/screens/deptchat/deptNoun.ts`                                        |
| M8 empty-state copy + CTA → live noun                            | `src/screens/messenger/DepartmentChannelsScreen.tsx`                      |
| Stop PERSISTING the derived noun                                 | `src/screens/deptchat/ChannelMembersScreen.tsx`                           |
| Server stopped stamping`'CPO'` on Enterprise tenants             | `apps/auth-service/src/department/department.service.ts`                  |
| Clear already-frozen labels                                      | `supabase/migrations/20260803000000_deptchat_role_label_derived_noun.sql` |
| Noun value, no-comparison + no-hardcoded-literal scans           | `src/screens/deptchat/__tests__/deptNoun.test.ts`                         |
| A9/M9 no-call-affordance pin (all navigators + import allowlist) | `src/modules/messenger/__tests__/deptChannelNoCallAffordance.test.ts`     |

**The persisted-noun trap (found in adversarial review, round 2).** Renaming the noun was not
enough, because the noun was being **written into the database**. `ChannelMembersScreen` passed
`deptMemberNoun()` as `role_label`, and the roster renders `m.role_label ?? <live noun>` — the
**stored string wins**. So an Enterprise roster would have shown `Employee` and `Member` side
by side forever, split by when each member happened to be added. Worse, the server's
`seedChannelMembers` hardcoded `'CPO'` for **every** tenant, so Enterprise workspaces were
already reading "CPO" before this scope started.

The fix is structural rather than cosmetic: `role_label` is documented as a _custom_ badge
("CPO Surveillance"), so neither side stores the derived noun any more — both write `NULL` and
every client derives its own label at render. A one-line migration clears the values already
frozen in, matching only the bare nouns so real custom badges survive.

**The non-obvious part.** `DayStatusScreen.tsx:80` did
`deptMemberNoun() === 'Employee' ? 'an employee' : 'a CPO'`. Renaming the noun to `Member`
made that comparison silently false, so an Enterprise admin would have been told to
_"Pick a CPO"_ — the exact audience the rename was for. This is the repo's recurring
**changed-shared-symbol** bug class: when a shared value changes, the bug lands in its
_consumers_. Every assertion here is **mutation-proven** — each one was made to fail on
purpose before being trusted:

| Mutation                                                         | Expected |
| ---------------------------------------------------------------- | -------- |
| Revert the noun to`Employee`                                     | RED      |
| Restore the`=== 'Employee'` comparison                           | RED      |
| Restore the hardcoded`<SectionLabel>CPO</SectionLabel>`          | RED      |
| Restore the double-quoted`<ObHeader title="Employees">`          | RED      |
| Inject`launchCall` into `DepartmentChatScreen`                   | RED      |
| Repoint**either** `DepartmentChat` registration at `ChatScreen`  | RED      |
| **Alias** the import: `DepartmentChatScreen from '…/ChatScreen'` | RED      |
| Extract a`SharedChatHeader` sibling holding the call button      | RED      |
| Plant that header at`@/modules/messenger/ui/` instead            | RED      |
| Hide the call behind a`.ts` helper + a non-phone icon            | RED      |
| Point`EmployeesScreen` at `deptMemberNoun`                       | RED      |

**Two nouns, not one (round 3).** Round 2 over-reached: it pointed `EmployeesScreen` at
`deptMemberNoun`, which returns **`CPOs`** on a provider tenant — and that screen filters
`member_role === 'employee'` and buckets CPO/manager rows separately as _"managed from your
provider roster — untouched here"_. So an agency would have seen the header **"CPOs"** on the
one screen that excludes CPOs. Before the change "Employees" was _correct_ there; round 2
inverted which tenant was wrong, breaking the very "rule 7: provider untouched" it cited.

There are therefore two helpers, and the distinction is the point:

| Helper             | Means                                           | Enterprise | Provider   |
| ------------------ | ----------------------------------------------- | ---------- | ---------- |
| `deptMemberNoun`   | the tenant's dept-workspace staff               | `Member`   | `CPO`      |
| `deptEmployeeNoun` | rows whose`member_role` is literally `employee` | `Member`   | `Employee` |

Also: never `.toLowerCase()` either result — `deptMemberNoun` can return the acronym `CPOs`,
which renders as "cpos". A test now bans it.

**What the A9/M9 pin taught us (4 review rounds, 4 escapes).** Each round the test was fixed
and each time the _next_ attack walked past it, always the same way — **the pin enumerated a
narrower surface than the code actually uses**:

| Round | Escape                                                      | Because the pin assumed…                      |
| ----- | ----------------------------------------------------------- | --------------------------------------------- |
| 1     | Repoint the other navigator's registration                  | …one navigator registered the route           |
| 2     | Alias the import:`DepartmentChatScreen from '…/ChatScreen'` | …the identifier proved the binding            |
| 3     | Plant the header at`@/modules/messenger/ui/`                | …only`./` and `@screens/` imports existed     |
| 4     | Wrap the call in a`.ts` helper, draw a `headset` icon       | …a call button lives in the file that renders |

The durable lesson: **the `launchCall` token is the only real boundary.** The icon denylist is
decorative (round 4 walked past it with `headset`), and the import-path ban is a `.tsx`-only
heuristic — it must not apply to `.ts`, because `authStore.ts` legitimately imports five
`webrtc/*` modules for sign-out teardown and would false-positive. A test that cries wolf is
how the next person learns to weaken it.

That row about repointing a registration is the one that matters most: the first version of
the affordance test pinned
only `DepartmentalNavigator`, so repointing the **`MessengerNavigator`** copy at `ChatScreen`
left all tests green. `DepartmentChat` is registered **twice**, and a single-file pin
reproduced the repo's own duplicate-copy bug class _inside the test written to prevent it_.
The scan now globs every navigator and asserts the registration count is ≥ 2.

**Note on scope discipline:** `member_role === 'employee'` in `EmployeesScreen` and the
`Employees` **route name** were deliberately left alone. They are a server data value and a
navigation identifier — renaming either breaks the roster filter or silently drops the tap
(the documented `departmentalEntry` failure). The literal scan excludes both explicitly.

**Open founder question raised by this step:** the service-provider branch of `deptNoun.ts`
still returns `CPO`. A7.3 says "remove remaining Employee **or CPO** labels", but the repo has
a standing "rule 7: provider untouched". So: when an **agency** uses Department Channels,
should its staff read "Member" or stay "CPO"? Left as `CPO` pending your call — see Part 9.

### Phase 1 — The hierarchy (the foundation)

**STATUS: ✅ BUILT** — see the build log at the end of this section.

Everything else leans on this, so it goes first.

**Database (additive, idempotent — matches how our migrations are already written):**

```sql
ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS parent_id UUID
    REFERENCES public.department_channels(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS level SMALLINT NOT NULL DEFAULT 1
    CHECK (level BETWEEN 0 AND 3);
```

- `level 0` = Enterprise root, `1` = Main, `2` = Sub, `3` = Sub-sub.
- The `CHECK` is what enforces "no fifth level" — in the database, not in the app.
- **Existing channels keep working**: they default to `level 1` (Main) and just need an
  Enterprise root created above them. Zero behaviour change on day one, same as how
  `20260629000002` was written.
- Use `ON DELETE RESTRICT`, not `CASCADE` — the PDF says archive is preferred and permanent
  deletion must be blocked when records need retention.

**Then:** update `listChannels` to return the tree, and update `DepartmentChannelsScreen` +
`ManageChannelsScreen` to group by level.

**Watch out:** the PDF says "no artificial channel-count limit; large lists use paging and
lazy loading." Don't fetch the whole tree at once.

> **Explicitly DEFERRED out of Phase 1 → Phase 6** (recorded so they are not silently dropped):
>
> - **Paging / lazy loading.** None of the three list queries has `LIMIT`/`OFFSET`/a cursor.
>   This was Phase 1's own "watch out" and it is not done. Not a blocker at current channel
>   counts, but it is an unticked acceptance item, not an oversight.
> - **Visible-DEPTH projection.** `listChannels` now withholds a `parent_id` the caller cannot
>   see, but `level` is still raw — so a member of a standard sub-channel under a _restricted_
>   parent gets `{parent_id: null, level: 2}` and the row renders under "Sub-channels" with
>   nothing above it. The identifier is withheld; the depth is not. Naively gating `level` is
>   wrong (a level-3 whose level-2 parent is visible but whose level-1 grandparent is not
>   cannot simply be renumbered), so this belongs with the visibility semantics in **Phase 2**.
> - **ops-console has no hierarchy.** `apps/ops-console/src/lib/api.ts` `DepartmentChannelRow`
>   carries neither `parent_id` nor `level` (nor `channel_type`/`access` — pre-existing), and
>   the departments page renders a flat table. `listChannelsForOps` now returns the columns and
>   orders by level, so the ops screen's row order changes with no consumer for the data.
>   Harmless while every row is level 1; wire it up with the Phase 6 console work.

#### Phase 1 build log

| What                                                                                               | File                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `parent_id` + `level`, depth CHECK, derive trigger                                                 | `supabase/migrations/20260803010000_dept_channel_hierarchy.sql`          |
| **All THREE** read sites return the tree; create validates parent; archive/delete refuse to orphan | `apps/auth-service/src/department/department.service.ts`                 |
| **Parent picker** — the producer for `parent_id`                                                   | `src/screens/deptchat/ChannelEditorScreen.tsx`                           |
| A9 level indentation + level noun                                                                  | `src/screens/deptchat/ManageChannelsScreen.tsx`                          |
| `parent_id` accepted on create (create-only)                                                       | `apps/auth-service/src/department/dto/channel.dto.ts`                    |
| Client DTO + create signature                                                                      | `src/services/api.ts`                                                    |
| M8 level grouping (progressive)                                                                    | `src/screens/messenger/DepartmentChannelsScreen.tsx`                     |
| Service validation tests (7)                                                                       | `apps/auth-service/src/department/department.hierarchy.spec.ts`          |
| DB-invariant source scan (9)                                                                       | `apps/auth-service/src/department/department.hierarchyMigration.spec.ts` |
| M8 grouping pin (5)                                                                                | `src/screens/deptchat/__tests__/channelHierarchyGrouping.test.ts`        |

**Level is derived, never asserted.** A DB trigger computes `level = parent.level + 1`, and
the `CHECK (level BETWEEN 0 AND 3)` then rejects a fifth level. This ordering matters: the
CHECK alone bounds depth but cannot see the parent, so a caller could still insert a level-1
child under a level-3 parent and flatten the tree while passing the constraint. There is
deliberately **no `level` field on the create DTO** — the caller cannot state its own depth.

The trigger also refuses a **cross-org parent**, which would otherwise be a tenancy leak
(page 10 rule 2). The service repeats that check only to return a clean 400 instead of a raw
Postgres 500 — the trigger is the guarantee, the service is the error message.

**Re-parenting is BLOCKED, deliberately.** The trigger is `FOR EACH ROW`, so moving a node
re-levels only that node — its descendants keep stale levels, silently producing a fifth level
with no error anywhere. Nothing in Phase 1 moves a channel, so the trigger refuses the
operation outright. When a move UI is built, replace the guard with a recursive descendant
re-level **inside the same transaction**; do not simply delete it. `parent_id` is likewise
absent from `ChannelInput`, so `configureChannel` cannot even attempt a move.

**A UI judgement call you may want to overrule.** Frame M8 says group across four levels, but
today the list groups by channel _type_ (Board / Department / Incident). Switching outright
would collapse every current org's list into a single "Main channels" block — a real
regression traded for a feature they have not built yet. So level sections appear **only once
a hierarchy exists**; until then the existing type grouping is untouched, and the type stays
readable per row via its glyph either way. If you would rather see level sections immediately,
it is a one-line change.

Every rule above was **mutation-proven RED**: widen the depth CHECK to 4, switch the FK to
`ON DELETE CASCADE`, remove the re-parent block, stop deriving `level`, drop the cross-org
check, drop the depth check, strip `parent_id`/`level` from `listChannels`, add a fifth level
to the client, delete the no-hierarchy arm, or inline the `?? 1` default — each one turns a
named assertion red.

> **Mutation-testing gotcha, learned here:** one mutation first reported GREEN and looked like
> a test hole. It wasn't — the `perl` substitution never matched (whitespace), so the code was
> never actually mutated. **Always confirm the mutation applied before believing a green.**
> (The inverse also bit us: a genuinely RED mutation looked green because the `grep` filter
> didn't match jest's output format. Verify both the mutation AND the result.)

#### The lesson Phase 1 kept re-teaching

The same defect class appeared **four times** in this phase, in four different disguises. Each
time, a rule was enforced over a narrower surface than the code actually has:

| Round | The narrowing                                   | What escaped                                    |
| ----- | ----------------------------------------------- | ----------------------------------------------- |
| 1     | "both read sites" — there are**three**          | A9's`listOrgChannels` got no hierarchy          |
| 2     | guarded`archiveChannel`, not `unarchiveChannel` | archive→archive→unarchive orphans a child       |
| 2     | test block named`archive / delete`              | the missing side wasn't even asked about        |
| 3     | `treeOrder` applied to `active`, not `archived` | archived list drew a false tree                 |
| 4     | banned one*spelling* of re-deriving depth       | `depth = (c.level ?? 1) - 1` reassigns the prop |

The fix that finally holds is **structural rather than enumerative**: `Row` now _requires_ a
`depth` prop produced by the `treeOrder` walk, so a caller that skips the ordering has no depth
to pass and **cannot render an indented list at all**. The invariant is enforced by the type
instead of by a comment — and its test asserts the coupling (every `<Row>` gets a walk-derived
depth, every list feeding one is `treeOrder`ed) rather than naming today's two lists, which
would have rebuilt the very narrowing it exists to catch.

Round 4 caught the class one level deeper still: the _pin_ banned one **spelling** of the
defect (`manageLevelOf(c) - 1`), and `depth` is a mutable parameter, so `depth = (c.level ?? 1) - 1`
reassigned the prop and discarded the whole guarantee with the signature untouched. The pin now
bans **assignment to `depth`**, which closes every spelling at once.

> **The one-sentence lesson, worth more than any individual fix here:**
> **an enumerative guard is a list of the cases you thought of; a structural guard covers the
> ones you didn't.**
>
> Phase 2 is two enumeration traps by nature — every read site that branches on `access`, and
> every level that must have a `#broadcast` _including ones created later_. Find the coupling
> first.

### Phase 2 — Split visibility from posting rights

**STATUS: 🔨 IN PROGRESS.**

> ## 🎨 FOUNDER RULE — the UI must match the PDF mockups
>
> Stated 2026-08-03 and it applies to **every remaining phase**: where a frame has a mockup,
> build what the mockup shows rather than an equivalent of our own.
>
> **First consequence — this REVERSES a Phase 1 decision.** Phase 1 shipped "progressive
> disclosure" on M8 (keep the old Board/Department/Incident type sections until an org actually
> built a hierarchy). The M8 mockup shows level sections **unconditionally**, headed
> `LEVEL 1 — BOARD` … `LEVEL 4 — TEAM / SUB-CHANNELS`, with a member count on every row. M8 now
> does that, always. The conditional is gone deliberately — its test says so, so nobody
> reintroduces it as an optimisation.
> (The mockup numbers levels 1-4 for humans; the DB stores 0-3.)

#### What Phase 2 discovery found — the split is worse than the plan assumed

Two findings, both from reading before writing:

1. **`standard` and `read_only` are behaviourally IDENTICAL today.** Posting is gated by the
   member row's `role` (`admin` posts, `viewer` cannot), and `seedChannelMembers` gave _every_
   non-manager `viewer` regardless of `access`. So `read_only` was a **display badge that
   changed nothing** — we did not have three posting modes, we had one ("managers post").
   `open` is therefore a genuinely new capability, not a re-labelling.

2. ⚠️ **Posting is enforced CLIENT-SIDE.** `DepartmentChatScreen` refuses to send when
   `myRole !== 'admin'`. The relay _cannot_ enforce it: channel posts are sealed-sender group
   envelopes and `messenger-service` has no knowledge of department roles **by design**. A
   member holding the group key is restrained by the client and by key distribution, not by the
   transport. That is in tension with the PDF's "never rely on hidden UI controls as the
   security boundary" — but closing it means teaching the relay about channel roles, which is a
   **CLAUDE.md stop-condition** (group messaging / relay semantics). Flagged, not silently
   "fixed". **Founder/architecture decision required.**

#### The coupling, found before building (per the Phase 1 lesson)

`access` was answering two questions. Each question now has exactly one function that may
answer it, and a test bans branching on either column anywhere else:

| Question                                    | The only function allowed to answer it              |
| ------------------------------------------- | --------------------------------------------------- |
| Who gets a membership row (VISIBILITY)      | `DepartmentService.seedsManagersOnly(access, type)` |
| What role a member is seeded with (POSTING) | `DepartmentService.memberRoleFor(postMode)`         |

`post_mode` defaults to `read_only` — exactly today's behaviour — so every existing channel is
unchanged, the same additive discipline as Phase 1.

#### `#broadcast` — enforced in the DB, not in a handler

A `BEFORE DELETE` trigger raises `broadcast_channel_cannot_be_deleted`, and a second trigger
forces `post_mode = 'announcement'` on any `is_broadcast` row. Both are triggers rather than
service `if`s for the reason this scope keeps re-learning: a service check is one code path
among several (deleteChannel, a future bulk purge, a script), which is the enumeration trap.

**`#broadcast` is ONE PER LEVEL — decided, not assumed.** A9 and page 10 rule 1 both say "at
every hierarchy **level**", and A5 says "initial #broadcast **structure**" (singular). Decisively,
the per-node reading is _structurally impossible_: a `#broadcast` child of a level-3 Sub-sub
channel would be level 4, which the Phase 1 CHECK rejects — the two rules cannot both hold under
per-node. Founder confirmed 2026-08-03.

**Read-only enforcement — client-side send AND receive, deliberately not the relay.**
Founder-approved 2026-08-03. The PDF demands it ("Read-only and #broadcast channels **prevent**
Member messages"; "never rely on hidden UI controls as the security boundary"), but the relay
_cannot_ do it: posts are **sealed-sender** envelopes, so the relay does not know who sent one —
that is the entire point of sealed sender, and teaching it channel roles is a CLAUDE.md
stop-condition. (Signal solves this with zkgroup anonymous credentials; we have none.)

So enforcement runs at **both ends of the client** instead of only the sending end:
`DepartmentChatScreen` refuses to send when the local role is `viewer`, **and** discards received
messages whose sender is not in the channel's poster set. A modified client can still put
ciphertext on the relay, but no honest recipient renders it — which delivers the PDF's observable
promise without touching relay semantics. It **fails open** when the roster is unknown (offline,
first paint): hiding real messages because a fetch failed is a worse bug than briefly showing one.
The limitation is real and is recorded here rather than papered over.

#### Phase 2 build log

| What                                                                                            | File                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `post_mode` + `is_broadcast`, CHECK, per-level unique index, non-delete + announcement triggers | `supabase/migrations/20260803020000_dept_channel_post_mode.sql`    |
| The two coupling helpers, `ensureBroadcastForLevel`, re-seed on mode change                     | `apps/auth-service/src/department/department.service.ts`           |
| `post_mode` on create + configure (never `is_broadcast`)                                        | `apps/auth-service/src/department/dto/channel.dto.ts`              |
| M8 level sections + member counts (PDF mockup)                                                  | `src/screens/messenger/DepartmentChannelsScreen.tsx`               |
| Receive-side rejection                                                                          | `src/screens/messenger/DepartmentChatScreen.tsx`                   |
| ACCESS options carry both fields, in the mockup's wording                                       | `src/screens/deptchat/ChannelEditorScreen.tsx`                     |
| Coupling + `#broadcast` invariants (8)                                                          | `apps/auth-service/src/department/channelAccessInvariants.spec.ts` |

#### Two CRITICALs found in adversarial review — both silent privilege escalation

**1. Saving any existing channel promoted every member to poster.** The ACCESS table is
**non-injective**: Standard and Read only both store `access='standard'` and differ only in
`post_mode`. The editor could not _read_ `post_mode` (it was absent from the route param and
from `pick()`), so selecting the option by `access` alone always matched the first entry —
Standard, i.e. `post_mode:'open'`. Every pre-Phase-2 channel is `access='standard'` with the new
column's default `read_only`, so opening one and pressing Save — **a rename, anything** — re-sent
`open` and the server re-seeded every non-manager as `'admin'`. "Read only" had become
_unrepresentable on read_: Phase 2 made a round-trip lossy that worked before it. Fixed by
carrying `post_mode` through the param and resolving the option from the **(access, post_mode)
pair**.

**2. The trigger guarded the rule column; the service wrote the enforcement column from the
request.** A `#broadcast` is pinned to `announcement` by the DB trigger — but `configureChannel`
re-seeded roles from `input.post_mode`. Send `open` and the row stayed a correct broadcast while
every member's `role` became `'admin'`: members posting in the one channel page 10 rule 1 forbids,
with the receive-side filter failing open too because everyone was then in the poster set. Roles
are now re-seeded from the `UPDATE … RETURNING post_mode` value.

**And "non-deletable" guarded the wrong verb.** The migration's `BEFORE DELETE` trigger covers
`deleteChannel`, which is creator-only and rarely reached. **Archive** is the removal every
manager actually has, and `listChannels` filters `archived_at IS NULL` — so archiving the
`#broadcast` made it vanish from every dashboard with nothing to recreate it. Archive is now
guarded server-side and the button is hidden for a broadcast.

**A regression the archive guard itself caused.** A per-LEVEL `#broadcast` is parented to some
branch node, so it counted as that node's active child — and it cannot be archived. The two
guards together made the **first branch root of every org permanently un-archivable and
un-deletable**, fired by the first sub-channel anyone creates. The child count now ignores
broadcasts, and a broadcast archives _with_ its parent rather than dangling. That in turn makes
a 23505 reachable again (archive P → create at that level → unarchive the old broadcast), so
`unarchiveChannel` translates it.

**The same re-merge, on the client, where the server scan could not see it.** `channelStateMeta`
derived its "Read only" badge from `access === 'read_only'` — and Phase 2 made that value
**unwritable**, since Standard and Read only both store `'standard'`. So the badge went dead in
the phase built to make read-only real, and a legacy row lost its badge the first time anyone
pressed Save. Same for the Departmental Home announcement fallback. Both now read `post_mode`,
keeping `access === 'read_only'` only as a pre-Phase-2 fallback.

**A bug Phase 2 would have shipped.** `configureChannel`'s tighten path found members to rekey
out with `WHERE role = 'viewer'`. Once `post_mode: 'open'` seeds ordinary members as `'admin'`,
that query matches **nobody** — so tightening an open channel to restricted would have left every
member holding the group key, which is precisely the rekey seam that block exists to close. Who
to remove is a _visibility_ question, so it is now resolved from org membership and can never key
off the posting column. The invariant test asserts it **inside the tighten block**, because a
whole-file assertion stayed green (the same clause also appears in the new re-seed query).

Add a second column so "can see" and "can post" stop being the same thing:

```sql
ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS post_mode TEXT NOT NULL DEFAULT 'open'
    CHECK (post_mode IN ('open', 'read_only', 'announcement', 'admin_only'));
```

Keep the existing `access` column for **visibility** and let `post_mode` handle **posting**.
That way nothing that reads `access` today breaks.

Then auto-create the non-deletable `#broadcast` channel at each level with
`post_mode = 'announcement'`.

### Phase 3 — Join requests and approvals

**STATUS: 🔨 IN REVIEW** — round 1 found three CRITICALs and six MAJORs; round 2 fixes are in.

> **The doc said "✅ BUILT" while the loop could not be entered, could not notify, and did not
> grant the referred team.** That was wrong, and it is exactly the failure mode this document
> warns about elsewhere: declaring done from a green suite. The status line stays honest until
> the reviewer agrees.

#### The structural decision — and the precise reason for it

M11A: _"Pending means no Enterprise content or metadata is visible."_
A11: _"Pending applicants receive no Department Channels, Attendance, Incident or Vault access."_

The tempting reading is "add a pending check to every module" — channels, attendance, incidents,
vault, search, notifications. That is an **enumeration trap**: a list of the modules we thought
of, and the next one added leaks silently.

So a join request lives in its **own table** and creates **no `org_members` row**. Approval is
what creates it.

> ⚠️ **State the reason precisely, because a weaker one licenses the shortcut that breaks it.**
> It is NOT "every reader filters on `status = 'active'`" — that is **false**. Twelve of the ~39
> `org_members` reads in auth-service don't filter on status at all (correctly: an admin roster
> must show suspended and removed members).
>
> The real reason is stronger: **there is no row, so every read returns nothing whether it
> filters or not** — today's modules and tomorrow's alike. If anyone later "simplifies" this by
> storing pending as `org_members(status='pending')`, those twelve unfiltered reads become live
> leaks. A CHECK constraint now makes that **impossible to write**, not merely discouraged.

Two corrections to earlier reasoning in this doc, both caught in review:

- **`entitlements.ts` is the CLIENT store** — its own comment says _"display-only; the server is
  the real gate."_ Citing it as a load-bearing gate was a category error against the PDF's
  filter-server-side rule. The real server pair is `dept-chat-access.guard.ts` and
  `org-manager.guard.ts`.
- **The dept-chat guard is a MODULE gate, not a TENANCY gate.** Path 3 admits an active
  Enterprise-tier individual with _no membership row at all_ — and a pending joiner is very often
  exactly that person, since they had to pick a plan to reach M5. What protects the _target_ org
  is **org-id resolution**: with no membership row their org resolves to themselves, so they see
  their own empty workspace, never the Enterprise they applied to.

#### Phase 3 build log

| What                                                                     | File                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Tables, idempotency index, `org_members.status` CHECK                    | `supabase/migrations/20260803030000_enterprise_join_requests.sql` |
| Link mint/resolve, submit, inbox, decide                                 | `apps/auth-service/src/department/enterprise-join.service.ts`     |
| Applicant + admin routes (deliberately NOT behind `DeptChatAccessGuard`) | `apps/auth-service/src/department/enterprise-join.controller.ts`  |
| Bodies — no team field on the applicant DTO                              | `apps/auth-service/src/department/dto/join.dto.ts`                |
| M5 Join Workspace                                                        | `src/screens/deptchat/JoinWorkspaceScreen.tsx`                    |
| M11A Approval Result                                                     | `src/screens/deptchat/ApprovalStatusScreen.tsx`                   |
| A11 Approvals inbox                                                      | `src/screens/deptchat/ApprovalsScreen.tsx`                        |
| Service + structural invariants (16)                                     | `apps/auth-service/src/department/enterpriseJoin.spec.ts`         |
| Client invariants (18)                                                   | `src/screens/deptchat/__tests__/joinApprovalFlow.test.ts`         |
| Entry point for a non-entitled code-holder                               | `src/screens/messenger/GroupsScreen.tsx`                          |

**R5-1 — the defect five rounds of source scans could not see.** Both entry CTAs rendered
inside `if (!entitled)` in `DepartmentChannelsScreen`, but the only screen that navigates here
(`GroupsScreen`) navigated _only_ when `entitlements.hasDeptChannels` was **true**. Arriving
required `true`; rendering required `false`. Mutually exclusive — so both CTAs were unreachable
by **every** user, while a scan for `findNavigatorWithRoute(...)` passed the whole time because
the strings were right there in the file. It was worst for exactly the persona this phase is
for: `hasDeptChannels = isOrgAffiliated || tier === 'enterprise'`, so a tier-only Enterprise
individual with no membership row got `true` from _buying the plan_ and never saw the door.

Fixed by loading `myJoinRequest()` before the entitled guard, extracting `JoinCta` gated on
`isOrgAffiliated` (not the tier-satisfiable flag), rendering it in **both** branches, and
routing `GroupsScreen`'s non-entitled branch to the gate before falling back to the paywall.

_A token in a file is not a reachable decision, and this decision spanned two files_ — so the
pin is cross-file and asserts the decision site, not a helper name. (Its own first version named
`findNavigatorWithRoute` and went stale the moment the call moved to the shared resolver — the
same mistake it exists to catch.)

**And what the self-diff caught in the fix itself.** Routing the locked card to the gate
_removed_ the in-app purchase path: the card used to raise the upgrade dialog on tap, and the
gate screen offered only _"Ask your organisation admin for access."_ So M1A — Enterprise being
purchasable in-app — became unreachable from the feature that advertises it. The gate now owns
that door (`View Enterprise plans` → `openPricing`), pinned alongside the reachability
assertions. Neither the 934-test app project nor any of the five review rounds would have found
this; enumerating the consumers of the behaviour the change _deleted_ did.

#### Round 6 — the reviewer found R5-1 recurring one level down, and three more

**R6-1 (blocking).** The entitled-branch CTA landed _inside_ the `channels.length > 0` list
branch. A tier-only Enterprise individual holds no membership rows, so `listChannels` returns
nothing and they sit in the **empty** branch permanently — reading _"Your org admin creates
department channels from the Ops console"_ with no door. Present in the file, rendered in a
branch the persona never enters: the same defect as R5-1, one level down, and the round-5 pin
passed it. The CTA is now hoisted above the loading/empty/list fork.

**R6-2 (blocking) — no admin could reach the approvals inbox at all.** `Approvals`,
`JoinWorkspace` and `ApprovalStatus` were registered **only** in `MessengerNavigator`, but every
approver persona — agency owner _and_ promoted org manager (`resolveRoute.ts:60`) — is routed
into `AgentNavigator`, which does not mount it. So the loop terminated at _"pending"_ forever:
the Home card fell through to _"not available here yet"_ for every admin, and the admin's own
"join requested" notification was a silent dead tap. All three routes are now registered on the
Departmental shell's Channels stack, and a shared `openJoinFlowScreen` resolver handles the
three cases (direct · **tab hop** · enter-the-shell) — the tab hop matters because
`DepartmentalHomeScreen` is the Home _tab_, so those routes sit on a **sibling** stack that
`findNavigatorWithRoute` cannot see; it walks up only.

**R6-3.** `JoinCta`'s handler was `if (host) { navigate }` with **no else** — a silent dead tap
in the Agent and CPO shells. Same for the two other call sites. All now go through the resolver,
which reports instead of dropping.

**R6-4 — my M1A restoration was itself dead where it mattered.** `openPricing` dispatches
`Main → SecureTab → Pricing`, and `Pricing` lives only in `BookingNavigator`, reached through
`SecureTab`, which exists only in the client tab shell. In the Agent/CPO shells the nested
payload goes unhandled — so the button I added to _replace_ a working dialog was a no-op for
exactly the personas that end up there. `openPricing` now resolves against the mounted tree and
says so when the route is absent. **Note this changes behaviour for four unrelated callers**
(`FileViewer`, `entitlementGate`, `FilesScreen` ×2): their cloud-vault upgrade prompts were
silently dead in those shells too, and now explain themselves. Strictly better, but it is a
change beyond Phase 3's own surface and is called out rather than absorbed.

**The pin became a render test.** The reviewer mutation-proved the round-5 scan: inverting
`JoinCta`'s guard to `if (!isOrgAffiliated) return null` — which makes the CTA render _only_ for
people already in an org, i.e. never for an applicant — kept **18/18 green**. A count of
occurrences cannot tell you whether a persona reaches the branch those occurrences live in. So
`src/screens/messenger/__tests__/joinCtaReachability.test.tsx` now **mounts** the screen in each
persona's state and asserts what the user is looking at. It kills both mutations (R5-1: 5 of 6
fail; R6-1: 2 of 6 fail).

Building it re-taught the invented-payload lesson: the first version mocked
`listChannels` as `{channels}` instead of the real `{data: {channels}}` envelope, so the
"channels present" case was silently rendering the **empty** branch while passing. It now
asserts a list-branch marker so that failure mode cannot recur, and the `useMessengerStore` mock
applies the selector (returning a bare object put an object inside a `<Text>` and tore the list
down).

#### Round 7 — the sibling case, and a render test that was still lying

**R7-1 (blocking).** The _applicant's own_ approve/decline notification was still a dead tap.
They are a **client** account, so their Activity Centre is `BookingNavigator`'s, under
`SecureTab` — while the three join routes live under the **sibling** `MessengerTab`.
`findNavigatorWithRoute` walks **up only**, so it structurally cannot see a sibling: every
candidate missed and the loop's own closing notification alerted _"not available here"_.

Fixed with a fourth candidate in `openJoinFlowScreen` — a **mounted-tree search** for
`MessengerTab`, then a root dispatch. That search is the same one R6-4 needed for `Pricing`, so
it now lives once in `navigationRef.ts` as `mountedTreeHasRoute` rather than becoming a second
drifted copy of the repo's most common bug shape. RED-first proven: disabling the candidate
fails the client-shell case and nothing else.

**The render test was still lying.** The reviewer hid the CTA behind `!inDepartmentalShell` and
got **26/26 green** — because the test mounted **one fixed navigator shape** in which
`isInDepartmentalShell` was always false. That mutation hides the CTA from every Agent/CPO-shell
user: the exact hosts R6-2 was about. A reachability test pinned to a single topology is not a
reachability test. It now runs every persona case under **both** topologies, **presses** the CTA
(visibility is not function), and anchors the "renders nothing" case on a positive marker so it
cannot pass while the screen is still loading.

Mutation ledger — all three defects that source scans let through now go red:

| Mutation                                                | Render test       | Source scan   |
| ------------------------------------------------------- | ----------------- | ------------- |
| A — R5-1 guard inverted (CTA only for existing members) | **14 of 16 fail** | 20/20 pass ❌ |
| B — R6-1 CTA only in the populated-list branch          | **4 of 16 fail**  | 20/20 pass ❌ |
| C — R7 CTA hidden inside the departmental shell         | **3 of 16 fail**  | 20/20 pass ❌ |

**R7-2.** `myJoinRequest` returns the latest request whatever its status, so it answers
`'approved'` forever. The guard tested `!joinStatus`, so everyone who joined by code kept a
permanent _"View your request status"_ button — on the surface they use daily, and on the exact
branch meant to render nothing. Now `joinStatus !== 'pending'`; a non-affiliated applicant still
sees a declined/approved outcome.

Also landed: the candidate **order** is pinned (tab hop before shell re-entry — re-entering a
mounted shell stacks a duplicate, the Issue 19 "reads as a dead tap" failure), the mounted-tree
search has its own suite (`mountedTreeSearch.test.ts`, including the lazy-tab false-negative
guard), and the padding of the two newly dual-mounted screens follows the house
`inDepartmentalShell ? 0 : insets.bottom` pattern instead of double-padding inside the tab shell.

**R7-3 — deferred to Phase 6 with a reason, and a warning.** `JoinWorkspace` accepts `{code}`
but nothing passes it: there is no deep-link route, push route, or `linking` config anywhere in
the app. M5's stated primary entry ("open directly from an invitation or a Member-shared link")
therefore does not exist. Manual code entry closes the loop, so this is not blocking — and deep
linking is Phase 6's navigation work.

**The warning matters more than the deferral:** `openJoinFlowScreen` carries **no params** —
every branch calls `navigateVia(target, route)` with none. So adding a `linking` config alone
will _not_ wire this: the code would be silently dropped on three of the five branches. The
param has to be threaded through the resolver first. That note now lives in the resolver's own
docblock, where the next person to touch it will actually read it.

#### Round 8 — two more mutations survived, both proving the same thing

**R8-1 (blocking) — the entitled-branch CTA was visible but never pressed.** The press test
mounted `hasDeptChannels: false` for both presses, so it only ever exercised the **gate**-branch
instance. Breaking the _entitled_ one (`navigation={undefined as never}`) left **36/36 green**
while the R6-1 persona tapped "I have an invite code" in the directory and got _"Not available
here"_. Asserting one instance visible and a **different** instance functional is the
visibility-is-not-function trap wearing the costume of a fix. Every rendered instance is now
pressed in every branch it can appear in, and `expect.anything()` is load-bearing — it does not
match `undefined`, so a dropped prop fails instead of passing vacuously.

**R8-2 (blocking) — the test re-implemented the function it was guarding.** `departmentalEntry.test.ts`
mocked `../navigationRef` and wrote its own `mountedTreeHasRoute` inside the factory. Deleting the
sibling recursion from the **real** function left that file **100% green — including its own R7-1
sibling case** — while `mountedTreeSearch.test.ts` went red. The repo's duplicate-copy bug class,
aimed at its own regression test. The seam moved one level down: stub `createNavigationContainerRef`,
keep the module real. (`requireActual` on `../navigationRef` cannot work — the real function closes
over the real module-level ref, which is never ready under node.)

**R8-5.** Inside a departmental shell hosted by MessengerNavigator, the ancestor walk found
`Approvals` **outside** the shell and pushed it full-screen over the workspace, losing the tab
bar — contradicting the resolver's own contract. The tab hop now outranks a direct hit when
`isInDepartmentalShell(nav)`; outside the shell `direct` still wins.

**R8-4 — the house had TWO shell predicates with different semantics.** `isInDepartmentalShell`
walked all ancestors; `useInDepartmentalShell` was a single-level `getParent()` probe — literally
the pattern the former's docblock says it replaces. Both were correct at every current mount
point, so it was latent, not broken. Collapsed to one. Widening the hook is only safe because
**exactly one** navigator registers the `Attend` sentinel, and 12 screens' safe-area padding now
depends on that — so uniqueness is pinned, not just presence: a second `Attend` would silently
cost those screens their inset with nothing else failing.

**R8-3 / R8-6.** A rejecting `myJoinRequest` is now pinned (it is fetched _before_ the entitled
guard, so an unguarded rejection would strand **every member of every org** on "Loading
channels…" from an endpoint unrelated to channels), and `openPricing` finally has its own suite
covering the dispatch payload, the alert branch and the not-ready no-op.

Full mutation ledger — five defects, none visible to a source scan:

| Mutation                              | Render / unit test                                               | Source scan   |
| ------------------------------------- | ---------------------------------------------------------------- | ------------- |
| A — R5-1 guard inverted               | 14 of 16 fail                                                    | 20/20 pass ❌ |
| B — R6-1 CTA only in list branch      | 4 of 16 fail                                                     | 20/20 pass ❌ |
| C — R7 CTA hidden inside the shell    | 3 of 16 fail                                                     | 20/20 pass ❌ |
| D — `myJoinRequest` try/catch removed | 2 of 32 fail                                                     | 20/20 pass ❌ |
| E — entitled CTA's navigation dropped | 12 of 32 fail                                                    | 20/20 pass ❌ |
| F — sibling recursion deleted         | 3 of 6 fail (`mountedTreeSearch`), 1 of 28 (`departmentalEntry`) | n/a           |

#### Round 9 — two REAL defects in shipped code, not test gaps

**R9-2 (blocking) — the approvals inbox turned the Channels tab into a permanent dead end.**
React Navigation overrides a child navigator's `initialRouteName` with the nested screen whenever
`params.initial !== false`. The Channels stack is lazy, so an admin whose **first** entry to the
workspace was the Home-tab "Approvals" card rooted that stack at the inbox with **no history**:
back fell out of the stack, and "Department Channels" then landed on the approvals inbox for the
life of the shell — a dead end `openDepartmentChannels` cannot repair, because its own shell
branch carries no inner screen. The reviewer proved it with a real `TabRouter`/`StackRouter`
harness modelling the v6 lazy-tab defaults. Fixed with `initial: false` on all three nesting
branches; the flag is now documented as load-bearing in the resolver and asserted at every site,
including a negative assertion that no branch nests a screen without it.

This **pre-dated R8-5** — it was live for the Agent host from R6-2 onward. R8-5 widened its
blast radius rather than causing it.

**R9-3 (blocking) — the team picker was dead.** `mint` was `useCallback(…, [minting])` while
reading `teamId`, so picking a team re-rendered without recreating the callback and the **first**
code minted after a pick went out **teamless** — and the picker is then replaced by the code card,
so the admin cannot correct it without revoking. That killed the whole chain the picker exists to
make real: M5's "the link records the exact originating team", A11's per-request team, M11A's
team copy, the inbox branch filter, and the `teamChannelId` that places the approved member.
`eslint react-hooks/exhaustive-deps` had been flagging it.

The pin `expect(src).toMatch(/team_channel_id: teamId/)` was green throughout — **the token was
at the decision site and only the VALUE was stale.** A scan reads text; only running the
component sees a stale closure. New `approvalsMintTeam.test.tsx` drives the real interaction
(pick → Create) and asserts the payload, including a two-pick case, since a single pick could
pass by luck.

**R9-1 — the gate's OTHER control was never pressed.** Gating "View Enterprise plans" on
`isOrgAffiliated` (false for every persona that reaches the gate) hid the only in-app route to
buying Enterprise, and left **62/62 green**. R6-1 one level down, on the sibling control. Now
pressed. **R9-4** added the org-affiliated-and-pending row, which is reachable rather than
exotic: an agency owner, or a member of org A, can sit pending against org B.

Also fixed from round 9: the asymmetric post-commit notify (`decideJoinRequest`'s was the only
one not `.catch`-wrapped), a truncated comment in `activitySync.ts`, and the gate is now a
`ScrollView` — it stacked an 84dp icon + title + body + 3 bullets + 2 CTAs + a hint in a centred
`flex: 1` block, so at `fontScale ≥ 1.3` on a short device the bottom controls clipped with no
way to scroll to them. A render test structurally cannot see that.

**Two process notes worth keeping.** A mutation that breaks JSX reports _"57 of 57 passed"_ —
36 tests that never ran, which reads exactly like a survival: **compare the TOTAL, not just the
failure count**. And chaining two mutations against one file made the second `apply` overwrite
the first's `.bak`, so the revert silently left the file mutated; the restored-baseline count is
what caught it. Always re-assert the baseline after reverting.

#### Round 10 — the `initial: false` rule was violated three more times, and a type that lied

**R10-1 (blocking).** Fixing the resolver did not close the class. Three more nested navigations
lacked `initial: false`, each re-rooting a lazy child stack:

| Site                                       | What it cost                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openPricing`                              | `SecureTab` is lazy in the messenger product, so BookingNavigator's first mount rooted at **Pricing** — and R9-1 had just made this the only in-app route to buying Enterprise. Worse, `openPricing.test.ts` had pinned the defective payload **as the contract**. |
| `DepartmentalHomeScreen` announcement card | Enter the workspace on any tab but Channels, tap it, and the Channels stack roots at the chat thread — the channels directory then unreachable for the life of the shell.                                                                                          |
| `DepartmentalHomeScreen` incident card     | Overrides a **role-branched** root, so a member's "My reports" becomes unreachable and `popToTop()` returns them to the category picker instead.                                                                                                                   |

The repo already stated this rule verbatim in `navigatorConfig.test.ts` — it simply had not been
applied here.

**And the one branch carrying the R7-1 bug had no payload assertion.** The sibling test checked
only `toHaveBeenCalledTimes(1)`, so dispatching to the _wrong screen_ survived every behavioural
test. Now the payload is inspected, exactly like `openPricing`'s.

**R10-2 (blocking) — a prop type that was structurally insufficient for its own use.**
`JoinCta` declared `navigation: {navigate}`, but its only use is `openJoinFlowScreen`, which
RESOLVES via `getParent`/`getState` — both optional on `RouteAwareNavigation`. So passing
`{navigate: navigation.navigate}` typechecked **at the exact baseline** while making every
candidate miss, turning the CTA into an Alert in the Agent and CPO shells: the R6-2/R6-3 dead tap
again, and invisible to the render test because the resolver is mocked there.

Fixed at the **type layer**, not the test layer: a new `ResolvableNavigation` requires the two
accessors at the resolver's entry point. That immediately surfaced a **second** instance —
`ActivityCenterScreen` hand-narrowed its nav to `{goBack, navigate}`, declaring away the very
capability the resolver needs. The mutation now fails to **compile** (48 vs baseline 47), which
is a better gate than any test.

**`seedApprovedMemberChannels`'s `teamChannelId` was a DEAD parameter** — read once in the
signature, never again. The referred team needs no special case: `createReferralLink` refuses a
managers-only channel at mint, so a valid team is by construction an ordinary seedable channel the
loop already covers, and a team-specific branch would only re-create the danger the seed exists to
avoid. Removed, with the reasoning recorded so nobody "restores" it. The spec test named
_"APPROVE seeds the referred team"_ could not tell the difference — its fixture held exactly one
channel, whose id was the team. It now carries a second channel with a different `post_mode`,
which also pins the per-channel role mapping.

Also closed: an **archived** team could still be promised by M5 while the seed excludes archived
channels — `AND c.archived_at IS NULL` now on all five team-resolving joins, so an archived team
reads as "no specific team" everywhere; and the A11 code card now names the team a live code
targets (it showed the code alone, so a rehydrated link's team was invisible and "New code"
silently re-minted against an empty picker).

| Round-10 mutation                                 | Caught by                 |
| ------------------------------------------------- | ------------------------- |
| A — nav prop narrowed to `{navigate}`             | **typecheck**, 48 vs 47   |
| F — sibling branch dispatches to the wrong screen | payload assertion, 1 fail |
| P — `openPricing` drops `initial: false`          | payload assertion, 1 fail |
| B — picker offers archived/broadcast channels     | negative fixture, 1 fail  |

#### Round 11 — my own archived-team fix disarmed a security check

**R11-3 (blocking) — the worst self-inflicted bug of the phase.** Round 10's archived-team fix
put `AND c.archived_at IS NULL` on the **JOIN**. That also nulled `team_access` / `team_type` —
and those feed the fail-closed managers-only refusal. So **archiving a restricted channel made
its links submittable again**: the exact hole the refusal exists to close, opened by a fix for a
cosmetic problem. It also left two lanes disagreeing:

- `listPendingRequests` tested the **raw** `r.team_channel_id IS NULL` while its join excluded
  archived rows, so an archived-team request was neither routed nor unrouted — it **vanished
  from every scoped manager's inbox**.
- `decideJoinRequest` resolved the channel with **no** archive check, so a manager scoped to that
  branch could not **see** a request but could still **decide** it.

The rule is now: **degrade the NAME, never the SAFETY CHECK.** The join resolves unconditionally;
only display fields are gated by `CASE WHEN c.archived_at IS NULL`. Both branch predicates use
one identical expression that folds every unresolvable team (none / deleted / archived) into
"unrouted", which belongs in every manager's inbox. Pinned by a test that extracts the predicate
from **both** queries and asserts they match the same shape — two literals are precisely how they
drifted.

**R11-1 (blocking) — the round-10 `initial: false` fixes were unpinned**, proven by a mutation
that survived the **whole app project at an identical total**. Enumerating call sites had now
failed three times, so the rule is enforced by a repo-wide scan
(`nestedNavigationInitialFlag.test.ts`) with a documented allowlist: tab leaves, stack roots, and
ten **pre-existing** offenders outside Phase 3 recorded rather than silently absorbed. The scan
strips comments, parses the enclosing object (a flag inside a nested `params` does not count),
and guards itself against matching nothing. It also states what it **cannot** see —
`openJoinFlowScreen` nests a _variable_ route, invisible to a literal scan — and asserts that the
dedicated cover for those branches still exists.

**R11-2 (blocking) — the type fix was on 1 of 3 resolvers.** `openDepartmentChannels` and
`openAttendance` still took the tolerant `RouteAwareNavigation`, so the R10-2 shape compiled
cleanly for them. Both now take `ResolvableNavigation`; verified zero-cost (typecheck unchanged
at 46).

**R11-5 — expired links rehydrated as live.** The rehydrate filtered on `revoked` alone, though
`expires_at` was already on the DTO and both server read paths require it. On day 8 an admin saw
a dead code under _"Share this code … It expires in 7 days"_ and handed it out. **R11-6** — the
shell branch of `openDepartmentChannels` was a bare tab switch, so with a deep Channels stack it
landed on the last-opened **chat thread** instead of the directory it advertises.

| Round-11 mutation                                | Caught by                   |
| ------------------------------------------------ | --------------------------- |
| M1b/M2 — the two `initial: false` fixes stripped | repo-wide scan, 2 fail each |
| M3 — archived-team `CASE` gating stripped (×4)   | shared-rule pin, 1 fail     |
| M3b — branch rule back to the raw column         | shared-rule pin, 2 fail     |
| M4 — resolver caller's nav narrowed              | 1 fail **and** a type error |
| M7 — rehydrate adopts a dead link                | 2 fail                      |
| M8 — shell branch back to a bare tab switch      | 1 fail                      |

#### Round 12 — pinning the DATA proved nothing about whether the CHECK still fires

**R12 (blocking) — eight rules survived mutation.** Every branch-scope and fail-closed rule in
this phase was pinned by scanning two SQL string literals. Everything _around_ them had no
coverage: the controller wiring, the TypeScript refusals that consume the columns round 11
restored, the notify fan-out, and the submit-side department derivation.

The worst was at the **wiring**: changing the controller to pass `null` instead of
`mgr.department` disarms the forced branch filter entirely — a scoped manager would read every
branch's applicant name, phone, email and message — and the whole suite stayed green. That is
R11-3's own lesson one layer up: restoring the data a check needs, and pinning the data, says
nothing about whether the check still runs. Eight behavioural tests now cover it, each
mutation-proven.

**Two of my own test mistakes, both instructive:**

- **A test that passed for the wrong reason.** The write-path refusal test stubbed only the link
  lookup, so with the refusal deleted the mock chain ran dry, the insert returned `undefined`,
  and the method threw `join_request_create_failed` — still a `BadRequestException`, so
  `rejects.toThrow(BadRequestException)` passed and the mutation survived. Now it asserts the
  **reason**, and leaves a working happy path underneath so deleting the refusal makes the call
  _succeed_ rather than fail differently.
- **A leaked mock queue made the suite order-dependent.** `jest.clearAllMocks()` clears recorded
  calls but **not** a queued `mockResolvedValueOnce` chain, so a test that throws before
  consuming its queue leaks the remainder into the next test. Fixed with an explicit
  `mockReset()`, matching what the harness already did for the tx handle.

**The nested-navigation scan was blind to the repo's own helper.** Its context filter named
`navigate(` but not `navigateVia(` — which _every_ resolver branch uses — so three of the four
sites in the file the scan names as its anchor were invisible, and a brand-new unflagged nesting
added there survived the full app project. Fixed and re-proven with exactly that mutation.
`KNOWN_PREEXISTING` also contained a **fictional row** (`messengerDeepLink.ts -> CallScreen`,
which nests a variable route and already threads the flag): it put a non-existent finding in
front of the founder, and a length-only assertion made the dead row a reserved slot a future
offender could be swapped into. The list is now derived from the scanner, nine real rows, with
each row asserted to correspond to a real site. `STACK_ROOTS` was also exempting by **global
screen name** on a justification that is false for `AgentNavigator` (which registers
`MessengerHome` on a stack rooted at `AgentTypeSelect`); it is now scoped per host.

**Two things the reviewer verified and I am recording rather than fixing:**

1. **Notify-vs-inbox agree at SUBMIT time only.** `team_department` is sampled once when the
   request is created; the inbox predicate is evaluated at read time. Archiving a routed team
   _after_ submission makes the request visible to managers who were never notified; un-archiving
   makes the notification a dead link for the managers who were. Correct in every steady state,
   racy only across an archive flip mid-request.
2. **Approval routing uses `department_channels.department` (free text), not the Phase-1
   `parent_id`/`level` hierarchy** that A11 describes. A code comment claimed this was "logged in
   the plan doc" and it was not — it is now. Aligning the two is a Phase 6 navigation/hierarchy
   item, not a Phase 3 obligation.

#### Round 13 — the reviewer found no live Phase 3 defect

Thirteenth round, and the first where every mutation aimed at **shipped Phase 3 behaviour**
either failed correctly or was confirmed as defence-in-depth. What remained was test coverage
and one undocumented scope decision. All of it is now closed:

- **`listReferralLinks` had no tenancy pin** — the one service method the tenancy block missed,
  while its own docblock claimed "each is now pinned at its own decision site". A referral code
  is, in this service's words, the sole capability needed to read another Enterprise's name and
  team _and_ to inject a row into its admin inbox, so an unscoped list would be a join vector,
  not just a metadata read. The query was always correct; nothing asserted it.
- **The scan's own comment claimed coverage it did not have.** It said it covered the
  `(navigationRef.navigate as …)(…)` cast form; the regex did not match it, and a dangerous
  unflagged nesting using that shape survived the **full app project**. A false coverage claim is
  worse than no comment. The filter now matches `navigate…(` within a short window (direct,
  `navigateVia`, and cast), which surfaced **three more** real sites — the incoming-call deep
  links. Those are _deliberately_ flagless (there is nothing to go back to from a call that
  arrived while the app was killed, and both files carry explicit `canGoBack() === false`
  fallbacks, B-319), so they are recorded in their own category rather than mixed into the
  backlog. The test now also **states its own blind spot**: a navigate aliased to a local helper
  declared far above its use is still invisible.
- **Three more rules pinned** — the active-manager half of the fan-out predicate (only the
  department half was covered), the org scope on the conflict/404 lookup (otherwise a
  409-vs-404 existence oracle over another org's request ids), and a dead slice bound in
  `joinApprovalFlow.test.ts` whose upper limit was always `-1` because `strip` removes the very
  comment it searched for — it discriminated only by luck.
- **R13-2 — notifications are INBOX-ONLY, and that is now written down.** `notifyJoin` records
  the durable Activity Centre row but publishes no FCM wake (the push bridge's `eventClass` union
  has no `'enterprise'` member). An admin not in the app learns of a request when they next open
  it. The loop is still completable — M11A is state-driven and both screens refetch on focus — so
  this is delivery **latency**, not correctness. Recorded because the frame is named
  "Approvals / **Notifications**" and the service docblock could otherwise be read as promising a
  wake that does not exist. Adding one is a scoped follow-up.
- Cosmetic: the code card showed a hard-coded _"It expires in 7 days"_ on a rehydrated link whose
  real remaining life is usually shorter. It now computes it.

**Pre-existing backlog handed to the founder, not absorbed:** twelve unflagged nested navigations
outside Phase 3 (`MainNavigator`, `DashboardScreen`, `ProfileScreen`, `ProfileDrawerModal`,
`backupBoot`), each of which re-roots a lazy stack. All in files unmodified by this work. The
scan lists them explicitly so they cannot quietly become invisible.

**A pre-existing pin caught the first attempt at the fix**, which is the system working:
`deptChatEntryPoints.test.ts` forbids either entry screen hard-coding a shell-specific route
name, and the first version hand-rolled `findNavigatorWithRoute` + `.navigate('DepartmentChannels')`
instead of using the shared `openDepartmentChannels` resolver (Issues 18/19).

**Three rules that are enforced structurally rather than by a check:**

1. **"The applicant cannot change the requested department or team."** The team is read from the
   _link_, server-side. There is no team field on the DTO, none on the API method, and no picker
   on the screen — so a future edit cannot start honouring one.
2. **"First decision wins; the second Admin receives a conflict state."** A single conditional
   `UPDATE … WHERE status = 'pending' RETURNING …` judged on whether a row came back — never
   read-then-write, which would let both admins read `pending` and both proceed. The second admin
   gets a 409 the UI renders as _"Already decided"_, because that is the system working, not a
   fault.
3. **"Expired or revoked links show a safe message without exposing organisation data."** An
   invalid code returns a bare `{valid:false}` — no org name, no team, no indication the code ever
   existed. A network failure is rendered identically, so the error itself cannot become an oracle.

**Why the join routes are on their own controller:** `DepartmentController` is
`@UseGuards(JwtAuthGuard, DeptChatAccessGuard)` at class level, and that guard admits only people
who already belong to an org. Putting the join routes there would make it impossible to ask to
join — the feature. The applicant routes take `JwtAuthGuard` only; the admin routes add
`OrgManagerGuard` (page 10 rule 2: _"Members never … approve join requests"_).

New table + endpoints + two screens (the Member's request screen, the Admin's approval inbox).

Copy the shape of `provider_referral_codes` — it already solves revocable tokens and
"which team did this person come from."

Key rules to build in from the start:

- Pending users get **nothing** — filter server-side, not client-side.
- **First decision wins.** If two Admins both hit Approve/Decline, the second one gets a
  conflict state, not a silent overwrite.
- Links must be **revocable** and must expire.

### Phase 4 — Enterprise Vault

Add org + channel scoping to the existing Vault. Do **not** redesign the UI — the PDF
explicitly forbids that. Two "shelves" in the same cupboard: personal files and company files,
never mixed.

#### What the code actually is, and why that decides the design

Read before building, because the obvious reading of "add org scoping to the Vault" leads
straight into an architecture stop-condition:

- **The Vault is device-local.** `VaultFile` — including `keyB64`, the per-file AES-256 key —
  lives in a Zustand store persisted to AsyncStorage under `bravo-vault-v1`. There is **no
  server-side registry of vault files at all**.
- **The server only mints presigned URLs**, and its entire access-control model is the object-key
  prefix: `vault/<callerUserId>/<uuid>`. `createDownloadUrl` refuses any key outside the caller's
  own prefix — that is the L15 IDOR fix.

So "company files, shared across an org" cannot be done by adding an `org_id` column. Taken
literally it would require a server-side file registry, **cross-user sharing of per-file keys**,
and — if the bytes were kept in the vault bucket — relaxing `createDownloadUrl` so one user can
presign another's object, which would re-open the IDOR the prefix check exists to close.

**CORRECTION (review round 1).** An earlier version of this note claimed that alternative was
_impossible_ because it would hit three stop conditions. That is wrong, and this repo disproves
it: `incident.service.ts` already implements exactly that pattern, architecture-approved — an
`incident_attachments` registry with opaque org-scoped storage keys, an
`incident_attachment_keys` table holding the per-file key sealed **to each recipient device**,
and server-side submitter-or-manager authz. It never touches `createDownloadUrl`, for the same
reason channel attachments don't: the bytes live in **media** storage, not the vault bucket.

So the honest framing is not "the alternative was impossible" but "**the channel view reuses
machinery that already exists and needs no new key distribution**". That is a real advantage, and
it is enough — but it means the gaps below are _deferrals_, not absences.

**That work is not necessary, because the mechanism already exists.** Channel attachments are
ordinary messages: `media_object_key` / `media_key` / `media_iv` travel **inside the encrypted
envelope**, so every member of a department channel already holds the key to every file posted
in it, distributed by the existing group-key machinery. The PDF says company-file permissions are
_"inherited from the channel/incident the file belongs to"_ — which is a description of exactly
this, not of a new store.

**So Phase 4 is a READ/scoping job, as the plan said — but the company shelf is a view over
channel attachments, not a second copy of the vault.** Consequences:

- No new key distribution, no new crypto, no change to `createDownloadUrl` or the MFA gate.
- Permissions are inherited **structurally**: you can only decrypt a company file if you hold the
  channel's group key, which you only hold if you are a member. There is no filter to forget.
- The personal shelf is untouched — the existing device-local vault, exactly as today.

**The invariant to pin** (and the shape the reviewer warned about after Phase 3: _"it will be
tempting to pin it by scanning the vault service for an `org_id` filter — that will pass the
moment a second read path exists"_): every path that yields a **company** file reference resolves
it from a channel the user is a member of, and the two shelves are **never merged into one
list**. Assert that at each decision site, not as a token in a file.

#### Phase 4 build log

| What                                                                 | File                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Company-shelf derivation (pure, membership-scoped)                   | `src/modules/messenger/vault/companyShelf.ts`                     |
| The only way a screen gets company files (owns the membership fetch) | `src/modules/messenger/vault/useCompanyShelf.ts`                  |
| Shelf switch + company list; personal path untouched                 | `src/screens/messenger/VaultScreen.tsx`                           |
| Scope + never-mixed invariants (15)                                  | `src/modules/messenger/__tests__/companyShelfScope.test.ts`       |
| Render-level separation + no-redesign (8)                            | `src/screens/messenger/__tests__/vaultShelfSeparation.test.tsx`   |
| Fail-closed membership (7)                                           | `src/screens/messenger/__tests__/companyShelfFailClosed.test.tsx` |

**No crypto changed, and none needed to.** The company shelf is a view over channel
attachments, whose per-file keys already travel inside the group-encrypted envelope. So
`createDownloadUrl`, the vault MFA gate, and key distribution are all untouched — see the
analysis above for why the literal reading of "add org scoping to the Vault" would have hit
three stop conditions at once.

**Three structural defences, not filters:**

1. The derivation iterates the **membership list** (`listChannels`), never the message map, so a
   conversation the user is not a member of has no path into the output.
2. The membership fetch lives in the hook, so a screen cannot widen the input.
3. `CompanyFile` and `VaultFile` are **different types** — merging the two lists is a type error,
   not a silent behaviour change.

**Mutation ledger** — every way the shelves could mix or widen:

| Mutation                                                                  | Caught by                           |
| ------------------------------------------------------------------------- | ----------------------------------- |
| S1 — derive from the raw message map instead of the channel list          | scope suite, 3 fail + 4 render fail |
| S2 — render company files on the personal shelf too                       | render suite, 3 fail                |
| S3 — the personal empty state renders on the company shelf                | render suite, 1 fail                |
| S4 — serve a cached list when membership can't be confirmed               | fail-closed suite, 1 fail           |
| S5 — show the shelf switch to a non-org account (a redesign for everyone) | render suite, 1 fail                |

**Two of my own test gaps, both found by mutation rather than review:** S3 could not be seen
while the fixture's personal vault was non-empty (the empty state never rendered at all), and S4
could not be seen with a single fetch — "cleared the list" and "never populated it" look
identical on a fresh mount. The fail-closed suite now fires a **second focus** on the same mount,
which is the real scenario: a member who had files and then loses membership.

**On MFA, stated rather than faked.** The PDF calls company files "locked behind permissions and
MFA". The permissions are real and structural. The MFA that applies is the **vault unlock
guarding the whole screen**, not a fresh per-file proof — the vault's per-file MFA is bound to
`VaultService` download URLs and these are not vault objects. A per-file prompt here, while the
identical bytes sit one tap away in the channel thread, would be ceremony rather than a boundary;
routing channel media through the vault MFA lane would be a change to the download-URL issuance
flow, which is an architecture stop-condition.

#### Phase 4 review round 1 — three blockers, two of them mine

**B1 — "Move to Vault" copied a company file into the personal shelf.** Two taps broke the
phase's headline rule. I had assumed that omitting `vaultSourceKey` suppressed the viewer's vault
actions and wrote a comment saying so; it does not — `FileViewer` falls back to `msg:<id>`, so
the action bar rendered anyway. The copy would then live permanently outside the channel's
permission inheritance: it survives removal from the channel and is not membership-scoped.
**B2** — "Delete" on a company file called `removeFromVault('msg:<id>')`, matched nothing, and
told the user the file had been removed from the device.

Fixed with an explicit `allowVaultActions` prop (default `true`, so no other caller changes),
driven by **which shelf opened the viewer** rather than by inspecting the file. Share stays —
reading out a file you can already open is the same capability the channel thread gives you.

**Why my tests could not see it:** the render suite stubbed `FileViewer` to `() => null`. A stub
cannot see what the real component decides. It now mirrors the real bar's own condition and
records the props, so both halves of the decision are pinned.

**B3 — I scoped the wrong screen.** Inside the workspace the Vault tab lands on **FilesScreen**
(registered as `MessengerHome` so VaultLock's back-exit resolves), which the plan doc itself names
three times as the A10/M11B surface. Its rows come from `selectMediaMessages` — every
conversation on the device — so the _first_ screen of the company Vault listed the user's DMs and
personal groups beside company files, while the compliant shelf sat two screens deeper behind the
PIN. FilesScreen now scopes to the same membership answer when mounted inside the shell, and
keeps its full personal scope outside it.

**The design justification was wrong, and is corrected above.** I claimed a server-side registry
with cross-user keys would hit three stop conditions; `incident.service.ts` already implements
exactly that pattern, architecture-approved. The channel view is still the right call — it needs
no new key distribution — but the gaps below are **deferrals, not absences**.

Also fixed: the membership fetch is now gated on `isOrgAffiliated` (every personal account was
issuing `GET /department/channels` per focus for a shelf they can never see), `useCompanyShelf`
and `FilesScreen` share **one** membership source rather than two derivations, and both lint
errors are gone. Typecheck is **43** — four under baseline, having fixed the loose `name: string`
icon types in two screens.

**Deferred, with reasons — not silently absent:**

| Gap                                                                                   | Why deferred                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Incident evidence** is not on the shelf, though the PDF says "channel/**incident**" | A real gap. The `incidentApi` lane already exists, so this is additive; it needs its own scope rule (submitter-or-manager, not channel membership) and belongs in its own change rather than bolted onto the channel view.                                                     |
| The shelf is a **200-message window**, not a file index (`MAX_HYDRATE_PER_CONVO`)     | A file posted 250 messages ago is invisible until the user scrolls back. SQLCipher stores `media_object_key` and the store already has a cross-conversation query precedent, so this is fixable without changing the design — but it is a store-layer change, not a Vault one. |
| **A10 "Admin Vault" is not admin-scoped** — an admin sees the same shelf as a member  | May be correct under permission inheritance. Founder question, not an assumption to make silently.                                                                                                                                                                             |

#### Phase 4 review round 2 — I fixed one of four doors

**The blocker: `allowVaultActions` defaults to `true`, so safety was opt-in, and only the Vault
screen's Company shelf opted in.** Three other surfaces still offered "Move to Vault" on a
company file — the Files row shield, the Files batch lane, and the chat viewer — and B3's fix had
made it _sharper_, because the workspace Vault tab now showed company rows exclusively, each
carrying the affordance this phase exists to forbid. Worse, outside the shell the ordinary Files
browser lists company files beside DMs with the same shields, so the copy path was reachable
regardless of shell — falsifying my own comment that "there is no merged list to get the filter
wrong on".

**Hiding buttons is an enumeration; a new surface re-opens it.** So the rule moved to the one
place every path ends: **`moveBytesToVault` is the single writer into the personal vault**, and it
now refuses when the source conversation is a department channel. Provenance is a **required**
`conversationId: string | null` parameter — the compiler then enumerated all four call sites for
me, and a local pick has to say `null` rather than inherit a default.

**The refusal reads the WIDE local map (`deptGroupByChannel`), not the narrow server list.** That
map is persisted and never pruned, so it over-approximates current membership — which is the safe
direction for a refusal: refusing a stale department conversation costs nothing, while missing one
leaks a copy that outlives the user's membership. Showing files still uses the narrow server list.
Two different questions, two deliberately different sources.

Also closed this round: the **upload button** rendered on the Company shelf while always writing
to the personal vault (a fourth mixing path on the very screen the first fix was made); the header
said "Personal Vault" over company files and the banner promised "a fresh MFA proof" the company
path deliberately does not perform (the audit-S1 overclaim class this screen's own comments warn
about); `useCompanyConversationIds` — the second read path, feeding FilesScreen — had **no direct
coverage**; and `useCompanyShelf` was unmemoised while subscribing to the whole message map,
reinstating the exact perf regression FilesScreen documents removing.

| Round-2 mutation                                | Caught by             |
| ----------------------------------------------- | --------------------- |
| C1 — delete the choke-point refusal             | refusal suite, 4 fail |
| C2 — match the map's keys instead of its values | refusal suite, 5 fail |

**Correctly dead:** re-adding `vaultSourceKey` to the company viewer file no longer matters —
`allowVaultActions` is the real UI suppression, and the vault itself now refuses regardless.

#### Phase 4 review round 3 — the choke point was never reached, and my "superset" was a subset

**R3-B1 — an OPTIONAL field re-introduced the silent default the required parameter existed to
kill.** `moveBytesToVault`'s `conversationId` is required, so the compiler enumerated its four
call sites — but `ViewableFile.conversationId` was **optional**, and the compiler cannot enumerate
_builders_ of an optional field. `AttachmentFileViewer` simply dropped it (its own
`AttachmentViewTarget.conversationId` is required and both callers pass a real one), then
`FileViewer` did `?? null`. Net: from the department chat and the workspace Vault tab, B1 was live
again — open a company file, Move to Vault, copied. `ChatScreen` had the same hole, and dept
conversations reach it because notification taps route every message to `Chat`.

Fixed by making `ViewableFile.conversationId` **required (`string | null`)**. The compiler then
listed all five builders, including VaultScreen's own three — so the company shelf now supplies
real provenance and `allowVaultActions` is no longer the only guard on the screen whose UI flag
regressed in round 2.

**R3-B2 — I claimed `deptGroupByChannel` was a superset of the user's channels. It is a subset.**
Its only other writer is DepartmentChatScreen's focus effect, so a channel enters the map only
once _this device has opened that thread_. "Never pruned" is about removal and says nothing about
never added. After a reinstall-and-restore the messages come back and the map does not — so every
company file was vault-movable until each channel had been opened once. Worse, the two halves
disagreed on one screen: the row was _shown_ because the server's `group_conversation_id` matched,
while the shield on it was _allowed_ because the local map was empty.

Fixed by **healing the map from the server answer** on the first channel-list fetch — one source
of truth rather than a second registry, and persistent, so the reinstall case closes permanently.
A residual window remains (before that first fetch lands) and is now documented by a test that
says so rather than a test that blessed it as correct.

**N11 reversed, and made structural.** The suppression now lives inside `FileViewer`, derived from
the file: any file whose conversation is a department channel loses Move and Delete for _every_
caller. Relying on the explicit prop is what left three of four surfaces open, and Delete does not
merely fail on a company file — it _lies_, reporting a removal that never happened.

| Round-3 mutation                                    | Caught by                             |
| --------------------------------------------------- | ------------------------------------- |
| Drop `conversationId` from any ViewableFile builder | **typecheck** — the field is required |
| C1 — delete the choke-point refusal                 | refusal suite, 4 fail                 |
| C2 — match the map's keys instead of its values     | refusal suite, 5 fail                 |
| Skip the map heal / heal with a wrong id            | fail-closed suite, 3 new cases        |

**Two limits stated rather than claimed away** (both from this round's review): **Forward** can
re-share a company file into a DM, and the DM copy is legitimately personal — the choke point
cannot see that, so "the rule cannot be forgotten" is true of the vault write path, not of
re-sharing. And `CompanyFile` is _structurally assignable_ to `VaultFile`, so the "merging them is
a type error" claim in the module docblock was an overclaim; the real guarantees are the separate
lists and the choke point.

#### Phase 4 review round 4 — my heal broke B-206, and "required" pinned the wrong thing

**R4-B1 (critical, self-inflicted).** Round 3's "heal the map from the server" **disarmed B-206's
history migration.** `DepartmentChatScreen` uses `deptGroupByChannel[channelId] !== gid` as the
trigger for its remap, and deliberately records the new mapping only _after_ migrating so an
interruption retries. My heal wrote the new id **without** migrating, permanently satisfying that
guard — so a member's whole thread history would stay orphaned under the old conversation id.
That is the "thread looks wiped" symptom B-206 exists to fix, and it is exactly CLAUDE.md
change-safety rule 8: I rewrote state without enumerating its consumers.

Fixed by **separating the two questions**:

| Structure                              | Question it answers                                      | Behaviour                                              |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `deptGroupByChannel`                   | "which conversation is this channel's _current_ thread?" | a POINTER — B-206 overwrites it. Untouched by Phase 4. |
| `deptConversationIds` (new, persisted) | "was this conversation ever departmental?"               | purely ADDITIVE, never pruned. What the refusal reads. |

That also makes the refusal correct across a remap: files still filed under the OLD id stay
refused, where reading the pointer map alone would have un-refused all of them the moment the
remap ran. And the "never pruned, so it over-approximates" justification — which round 4 correctly
called out as false of the pointer map — is now true of the structure it describes.

**R4-B2 — round 3's headline fix had zero coverage.** Deleting `!isCompanyFile` from
`showVaultActions` was green on _both_ full projects, because every suite mocks `FileViewer` or
`AttachmentFileViewer` away. New `fileViewerCompanySuppression.test.tsx` mounts the **real**
component — the same "a stub cannot see what the real component decides" lesson that hid B1 in
round 1, one level down.

**R4-B3 — "required" pins existence, not correctness.** `null` is a legal value of
`string | null`, so making `ViewableFile.conversationId` required only forced builders to _state_
something; changing one to `conversationId: null` stayed green and typechecked. New
`attachmentViewerProvenance.test.tsx` asserts the **value**.

Also closed: losing org affiliation while the Company shelf was open left the user stranded —
switch gone, header still "Company Vault", company list still rendering, no route back (the shelf
is now derived, so it collapses); and the entitlement branch of the fail-closed rule got the same
second-focus treatment the network branch already had.

| Round-4 mutation                            | Caught by                              |
| ------------------------------------------- | -------------------------------------- |
| M1 — drop the automatic company suppression | real-viewer suite, 1 fail              |
| M2 — a builder states `null` provenance     | provenance suite, 2 fail               |
| M3 — non-org branch stops clearing          | fail-closed suite, 1 fail              |
| B-206 ordering (heal before migrate)        | removed at the root — the heal is gone |

#### Phase 4 review round 5 — the registry was snapshotted but never restored

**R5-B1 (blocking).** `deptConversationIds` was written into `vaultByOwner` on an account switch
and **never read back**. Two consequences, and the second is the one that mattered: the incoming
owner inherited the previous owner's ids and accumulated more on every switch, _and_ any id living
only in the registry — the OLD conversation after a B-206 remap, or a channel recorded from the
server but never opened on this device — was dropped from live state. The vault then stopped
refusing those files: the exact leak the registry exists to prevent, reintroduced by switching
account. One line at the restore site, pinned by two owner-switch tests next to the existing
B-206 pin that made the asymmetry visible in the first place.

**R5-B2 (blocking) — R4-B3's lesson was applied at one of five sites.** `conversationId: null`
survived at all four _forwards into_ `moveBytesToVault`, and two of them have **no second guard at
all**: the Files row shield and the select-all batch lane. Inside the workspace shell FilesScreen
shows company rows exclusively, so those two lines were the only thing between a select-all and a
personal copy of every company file. New `vaultProvenanceForwarding.test.ts` drives the batch lane
behaviourally (including a mixed selection, which a constant cannot satisfy, and the rule that a
refused company file fails only itself rather than aborting the batch) and pins the other three at
their decision sites.

**R5-B3** — the derived shelf from round 4 had no coverage; a fresh mount always starts on
Personal, so it needed the switch-then-revoke-then-rerender shape. **N1** — the `vaultOps` JSDoc
still described the pointer map three lines above a body comment saying the opposite; corrected.

| Round-5 mutation                                | Caught by                |
| ----------------------------------------------- | ------------------------ |
| R1 — registry not restored on owner switch      | remap suite, 1 fail      |
| R2 — batch lane forwards `null`                 | forwarding suite, 4 fail |
| R3 — row shield forwards `null`                 | forwarding suite, 1 fail |
| R4 — shelf not derived                          | separation suite, 1 fail |
| R5/R6 — FileViewer / VaultScreen forward `null` | 1 fail each              |

**Still deferred, unchanged:** incident evidence, the 200-message hydration window, A10
admin-scoping. **New, and it deserves a bug number rather than a deferral line:** `FilesScreen`'s
`bucketFor` has no `video` branch while `selectMediaMessages` deliberately includes video
(MSG-13), so a video posted in a department channel is **invisible on the workspace Vault tab
while VaultScreen's Company shelf lists it** — two Phase 4 surfaces disagreeing about the same
scope. Pre-existing, surfaced by this phase.

#### Phase 4 review round 6 — no security holes left; the N3 fix was half-applied

Round 6 confirmed the choke point and both registry sources hold, and killed 24 further
mutations. What it found was **completeness**, not leakage.

**R6-B1 — I hid the row shield and left the batch lane.** Same dead affordance, and it costs
more: `runBatchVaultMove` **resolves bytes first** (download + AES-decrypt per file) and only then
hits the refusal, so an all-company selection downloaded everything to report _"0 of N moved"_.
Inside the workspace shell that is the whole list. The batch action is now hidden when nothing in
the selection could move; a **mixed** selection keeps it and the company rows fail individually.
**R6-B2** — the promo card still said _"Tap the shield on any row"_, on a screen where no row has
one: the consumer of the affordance I had just deleted, which is exactly what change-safety rule 8
asks about.

**N4 — the Company shelf's type tabs gave positive feedback for a no-op.** The
All/Images/Documents/Audio row rendered but `companyFiles` never read `activeTab`, so tapping
"Images" moved the underline and changed nothing. They now filter. Also on that screen: the busy
banner claimed _"Encrypting and transferring"_ during a company **download**, and `docIconFor` had
no image/video branch, so every photo — the most common channel attachment — rendered as a generic
grey file row.

**The residual window was wider than the note claimed, and is now much narrower.** The refusal
registry was armed only by opening a channel thread or the Vault/Files surfaces — but a channel
notification deep-links to **ChatScreen**, which arms neither. So for a member newly added to a
channel, the _default first contact_ with a company file was on the one screen where the check was
guaranteed blind. `MessengerHomeScreen` already fetches exactly those ids on every focus (to hide
dept channels from the chat list) and discarded them; it now records them. **No extra request.**

**Coverage gaps closed:** there are **five** forwards into the choke point, not four — `ChatScreen`
is a live company-file path and was unpinned; both `AttachmentViewTarget` builders now assert the
real value; the **cold-boot** legs of the registry (`partialize` / `onRehydrateStorage`) had no
coverage at all, the same snapshot-vs-restore asymmetry as R5-B1 on a different leg; and the
`type: 'file'` + video-mime shape needed a **bucket** assertion, since a broken video branch still
renders the row under `docs`.

| Round-6 mutation                                    | Caught by   |
| --------------------------------------------------- | ----------- |
| B1 — batch Vault on an all-company selection        | 1 fail      |
| B2 — promo instructs an impossible action           | 1 fail      |
| N4 — Company tabs stop filtering                    | 1 fail      |
| M9 — video-mime file mis-buckets                    | 1 fail      |
| M17/M18 — registry dropped from persist / rehydrate | 1 fail each |

**Three more invented-fixture traps in my own tests**, all of the same family: `haptics.selection`
(the real surface is `tap/select/impact/heavy`, so long-press threw), a missing
`navigation.addListener` (selection mode registers a `beforeRemove` listener — which is _why_ the
batch lane had no coverage at all), and querying `BatchAction` by text when it exposes its label
via `accessibilityLabel`.

#### Phase 4 review round 7 — my residual-window fix never ran in the flow it was written for

**R7-B1 (blocking).** Round 6 armed the refusal registry from `MessengerHomeScreen`'s focus
effect. It never fires in the flow it was written for: the Chat deep link passes `initial: false`
**so MessengerHome is seeded BENEATH the pushed Chat** — mounted, never focused, so the focus
effect never runs. In the Agent shell `MessengerHome` is a sibling route that never mounts at all.
The cold notification tap — the exact "default first contact" the fix targeted — still landed on
ChatScreen with the registry blind.

Moved to `MainNavigator`'s owner-set effect: **one point all three shells and the cold deep-link
share**, running before any shell mounts. Best-effort, and a dept-API failure (expected for every
non-org account) cannot surface or block boot.

**R7-B3 (blocking) — my new gates read the display source, not the refusal source.** The shield,
promo and batch gates all ask the _refusal's_ question ("can this move?") but read
`companyConvIds` — the **narrow server list that fails closed to empty** — while
`moveBytesToVault` and `FileViewer` read the **wide additive registry**. Outside the shell they
disagreed in the worst direction: on first paint, and permanently whenever `listChannels` fails,
every company row got its shield back and an all-company selection got the batch Vault action
back. No leak — the choke point still refuses — but it restored exactly the download-then-refuse
cost R6-B1 removed, and made a row and the viewer it opens disagree about the same file.

**The rule is now explicit in the code:** two sources, two questions. Narrow (server membership,
fail-closed) decides what to **show**; wide (additive registry, never pruned) decides what may
**move**.

**R7-B2** — the batch gate's `.some` → `.every` survived, because my "mixed selection" test
long-pressed only the personal row, which satisfies both. A genuinely mixed selection now pins it:
under `.every` a user could not vault their own file merely because a company file was also
selected. **R7-B4** — N4 was half-applied: the section count and the empty state still read the
**unfiltered** list, so the Images tab could read "Company · 5" over one row and a tab with no
matches rendered a header above nothing. One derived list now drives all three.

**The `listCompanyFiles` JSDoc overclaim is fixed** — it lists every company file _within the
store's 200-message hydration window_, not "every company file the caller can open". Phase 4 has
now corrected that class four times (the AES banner, the MFA claim, the type-safety claim, this).
**M26 (memo deps) deliberately left alone**: the deps are correct and load-bearing; dropping them
would keep a list built under the previous membership answer. If the churn ever matters the fix
belongs in the hook, not the screen.

| Round-7 mutation                     | Caught by |
| ------------------------------------ | --------- |
| B1 — boot arming removed             | 1 fail    |
| B2 — batch gate `some` → `every`     | 1 fail    |
| B3 — gates read the narrow list      | 1 fail    |
| B4 — count reads the unfiltered list | 1 fail    |

**Recorded for Phase 6:** the Company shelf and the registry arming both ride `isOrgAffiliated`,
while the module rides `hasDeptChannels`. Today the divergent persona has no channels so nothing
breaks — but when Phase 6 mints an Enterprise workspace **owner** who is neither an agency account
nor an active org member, both the shelf and the vault refusal go dark for the person who owns the
workspace. Phase 6 owns that fix; Phase 4 chose the gate.

#### Phase 4 review round 8 — the security contract closed; the residue cleaned up

Round 8 ran 28 mutations and found **nothing blocking**: the choke point, both registry sources,
the fail-closed membership, the derived shelf and all five provenance forwards held. What remained
was residue, now closed:

**R8-1 — my gate re-derived the refusal's question with a narrower source than the refusal.**
`canMoveToVault` read `deptConversationIds` directly, while `isDepartmentConversation` _also_ falls
back to the `deptGroupByChannel` pointer map — which is exactly the population that fallback exists
for (an install upgraded from before the registry). On that install every company row showed a
shield the choke point would refuse, and disagreed with the viewer it opens. Same shape as R7-B3,
one axis over. There is now **one predicate**: the gate subscribes for reactivity and delegates.

**M48 — a scan that pinned text, not behaviour.** Inverting the arming guard to
`if (!ch.group_conversation_id)` kept every asserted token and recorded nothing. The arming is now
an extracted `armDeptConversationRegistry()` driven behaviourally (records each channel; records
nothing without a conversation; a 403 is swallowed and **clears nothing** — the registry is
persisted and additive, so clearing on failure would un-refuse every file the device already knew).
The MainNavigator scan now only asserts the call site, which is all a scan should.

**M49** — the rows-memo scope deps were unpinned and a render test structurally cannot see them
(the fixtures return a fresh array each call, so the memo always recomputes). Pinned by scanning
the deps array. **M50** — the icon branches had no test, and my first attempt asserted the token
file-wide, which passed via `categorize`'s identical check: **the "assert the decision site, not
the token" trap, in my own test.** Now sliced to `docIconFor`'s body.

**The duplicated arming is kept, with an honest comment.** `MessengerHomeScreen` still records —
it is free (that fetch already happens) and is a genuine mid-session refresh — but its comment
claimed to close the first-contact hole, which R7-B1 disproved. It now says _refresh_ and points at
MainNavigator, so nobody deletes the boot arming on its strength.

| Round-8 mutation                            | Caught by |
| ------------------------------------------- | --------- |
| A1 — gate re-derives with the narrow source | 1 fail    |
| A3 — arming clears the registry on failure  | 1 fail    |
| A4 — rows memo drops the scope deps         | 1 fail    |
| A5 — `docIconFor` loses its image branch    | 1 fail    |

**One more process note.** A python heredoc turned `\n` into a literal newline inside a JS string,
so a suite failed to **parse** — and the run reported _"54 passed, 54 total"_, a smaller TOTAL that
reads exactly like a clean baseline. Comparing the total against the previous 71 is what caught it.
That is the third time this phase that comparing totals rather than failures mattered.

**Recorded, not fixed:** Delete is suppressed in the viewer for a company file but still offered in
the Files batch lane. They are not the same action — the viewer's Delete calls
`removeFromVault('msg:<id>')` (a no-op that lies) _plus_ `removeMessage`, while the batch lane
calls the real `removeMessage`, which the department chat itself also offers. Bundling Delete under
the vault-action gate removed a working capability because its vault half lied; defensible, and
written down rather than left implicit.

#### Phase 4 review round 9 — the security contract holds; round 8's headline pin did not exist

Round 9 ran **33 mutations** across the whole Phase 4 surface. **29 were caught, 4 survived, and
every survivor was a missing PIN rather than an open door** — none of them lets a company file
reach the personal vault. All four are now pinned and mutation-proven RED-first.

**R9-1 — the mutation round 8 recorded as proving R8-1 does not fail.** R8-1's whole point was
that the affordance gate and the refusal must be ONE predicate. But `filesScreenCompanyScope`
mocks `isDepartmentConversation` as `id => !!deptConversationIds[id]` — so **under that fixture
the shared predicate and the narrow registry are literally the same function**, and no render
assertion can separate them. Re-deriving `canMoveToVault` from `deptConversationIds` survived the
entire app project. What the real predicate adds is the `deptGroupByChannel` fallback, which is
the _entire_ population R8-1 exists for (an install upgraded from before the registry).

Round 8's recorded "A1 — 1 fail" was almost certainly the **R7-B3** mutation (reading the narrow
_server_ list, `companyConvIds`), which a real test does catch — a different bug, already pinned.
Two adjacent narrowings, one test, and the wrong one credited. Not a leak: `moveBytesToVault`
still refuses, so the cost is the download-then-refuse waste R6-B1 removed plus a row disagreeing
with the viewer it opens. Now pinned by a scan **sliced to `canMoveToVault`'s own line**, which
also asserts the two sources it has already regressed to are absent from the decision site.

**R9-2 — the gate's two reactivity subscriptions were unpinned.** The predicate reads
`getState()`, so the _answer_ is always current; the _screen_ only re-renders when a subscribed
value changes. Deleting either `useMessengerStore(s => s.deptConversationIds)` or
`… s.deptGroupByChannel)` left every test green while a mounted Files tab kept stale shields.
A render fixture structurally cannot see this — it never mutates the store after mount, and this
suite's store mock is a plain selector function.

**R9-3 — M49's sibling, in the hook.** Round 8 pinned the _FilesScreen_ rows memo deps by source
scan and never did the same for `useCompanyShelf`'s own memos. Dropping `channels` from either
survived — and their fixture is blind for the same structural reason M49 was, one level worse:
the store mock **rebuilds its state object on every call**, so `messages` changes identity each
render and the memo recomputes whatever the deps say. This is the one Phase 4 staleness with a
confidentiality edge — the shelf would keep serving the list derived under the PREVIOUS
membership answer — so a removed member goes on seeing company files until some unrelated input
changes. Both hooks now pinned.

**A false CATCH is as dangerous as a false green, and I produced one this round.** The first A1
used `useMessengerStore.getState()`, which the fixture mocks as a selector-only function: every
test died with `TypeError: getState is not a function` and the harness dutifully reported
**"CAUGHT (12 app)"**. Twelve failures, zero discrimination. _The mutation must be written in a
form the fixture can execute_ — otherwise you are testing the mock's shape, not the assertion.
This is the same family as the invented-fixture traps of rounds 6 and 8, inverted.

| Round-9 result                          | Count                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caught                                  | 29 of 33                                                                                                                                                                                                                    |
| Survived → now pinned + re-proven       | A1 (R8-1 gate), N4/N5 (reactivity legs), C17 (`useCompanyShelf` memo deps)                                                                                                                                                  |
| Near-miss                               | C19 (`useCompanyConversationIds` memo deps) was already caught by one behavioural test; pinned by scan too, since its sibling was not                                                                                       |
| Security-contract mutations, all caught | choke point off · registry leg off · pointer-map leg off · scope widened to all conversations · membership fails open · shell scoping off · all 5 provenance forwards nulled · viewer suppression off · boot arming removed |

**The security contract, end to end.** `vaultStore.addFile` has exactly **one** non-test caller —
`moveBytesToVault` (verified across `src/`, `packages/`, `apps/ops-console/src`) — and it refuses
before the PIN/MFA ceremony, so the refusal cannot be worn down by retrying. The shelves are
built from **disjoint inputs** (`listCompanyFiles` never reads the vault store; the vault store
knows nothing about conversations) and rendered in **mutually exclusive branches**, never
concatenated. So a personal file cannot reach the company shelf unless the _server_ returns a
channel whose `group_conversation_id` is a DM — outside the client's trust boundary and
unreachable from user action.

**Three ways a company file can still become a personal copy, all inherent and all recorded:**

1. **Forward it into a DM** — makes a legitimately personal copy the choke point cannot
   distinguish. Recorded since round 4; a limit of the design, not a defect in it.
2. **Share it out to the OS and re-import it** through the document picker — arrives as
   `conversationId: null`, a genuine local pick. Same class as (1).
3. **The arming race.** `deptConversationIds` is persisted and additive, but on the _first_ boot
   after a fresh install or restore it is empty until `armDeptConversationRegistry()`'s network
   call resolves. A cold notification tap into ChatScreen inside that window (~one RTT) would
   find the registry blind. Narrow — it needs the channel's messages already hydrated on a device
   that has never armed — and it is **inherent to a device-local registry**: closing it properly
   means the server telling the client which conversations are departmental _before_ it serves a
   file, which is Phase 6/server work, not a Phase 4 patch.

None of these is new, and none is blocking. **Phase 4's security contract is closed.**

#### Phase 4 review round 9 — DONE, and one pin that never existed

**Verdict: Phase 4 is done.** 33 mutations, 29 caught; all four survivors were missing _pins_, not
open doors, and all four are now pinned.

**R9-1 — round 8's headline mutation was mis-credited, and I should not have believed it.**
`filesScreenCompanyScope` mocks `isDepartmentConversation` as `id => !!deptConversationIds[id]` —
under that fixture **the shared predicate and the narrow registry are literally the same
function**, so no render assertion can separate them. Re-deriving `canMoveToVault` from
`deptConversationIds` survives the whole app project. The "A1 — 1 fail" I recorded was almost
certainly the _R7-B3_ mutation (reading the narrow **server** list), which a real test does catch.
Two adjacent narrowings, one test, the wrong one credited.

**A fixture that mocks the predicate under test cannot discriminate it.** That is the single most
expensive lesson of these nine rounds, and it came from my own test.

The reviewer also produced a **false CATCH** worth recording: a mutation written with
`useMessengerStore.getState()` against a selector-only fixture threw 12 `TypeError`s and read as
"CAUGHT (12 failures)". Twelve failures, zero discrimination. **A mutation must be written in a
form the fixture can execute, or you are testing the mock's shape.**

Also pinned this round: the two reactivity subscriptions (deletable in silence — a mounted Files
tab then keeps stale shields), and `useCompanyShelf`'s **own** memo deps, which round 8 missed by
pinning only FilesScreen's. That last one is the only staleness with a confidentiality edge: a
removed member keeps seeing company files.

**Security contract, confirmed end to end.** `vaultStore.addFile` has exactly **one** non-test
caller — `moveBytesToVault` — which refuses before the PIN/MFA ceremony. Choke point off, both
predicate legs off, scope widened, membership failing open, shell scoping off, all five provenance
forwards nulled, viewer suppression off, boot arming removed: **every one caught.** The shelves are
built from disjoint inputs and rendered in mutually exclusive branches, never concatenated.

**Three residual paths, inherent and recorded:** forward-into-a-DM; share-out then re-import as a
local pick; and the **arming race** on the very first boot after a fresh install (registry empty
until the network call resolves — closing it properly is server work).

Final gates: app **1079 / 1083** (4 skipped), typecheck **43** vs baseline 47, lint clean, no stray
backups. messenger-crypto's failing suite **moved every run** (`freeSpacePrecheck` →
`callAudioSessionArbitration` → `backupFlags`) — the documented B-126 flake, none of it Phase 4.

---

### Carry-forward into Phase 5 — what actually went wrong, nine rounds running

These are not generic tips; each one cost a round in Phase 3 or 4.

1. **A fixture that mocks the predicate under test cannot discriminate it.** Phase 5 has
   `canEditDay` / `isPublished` / `isLocked`. The moment a screen suite mocks one, the mock _is_
   the definition and every narrowing of the real one survives. Pin the decision site by scan,
   sliced to the function body — not the token file-wide (that trap fired twice).
2. **Memo deps are invisible to fixtures that rebuild state each call.** A month calendar is heavy
   memoisation over (month, roster version, draft/publish). If the fixture returns fresh objects
   per render the memo always recomputes and _every_ deps mutation survives. Scan the deps arrays.
3. **Reactivity-only subscriptions have no behavioural signature.** Draft → publish is exactly that
   shape.
4. **"Two sources, two questions" — decide it explicitly, in the code.** Phase 4 got this wrong
   twice. Phase 5's pair is the _published server roster_ vs the _local draft_; they will disagree
   on first paint and on fetch failure. Write down which answers "what do I show" and which answers
   "what may I edit".
5. **Enumerate consumers before rewriting state** (change-safety rule 8). My round-2 heal of
   `deptGroupByChannel` disarmed B-206's migration trigger. Corrections are append-only history —
   same shape. Writing a "current value" that another feature uses as a _trigger_ is the trap.
6. **Compare TOTALS, not failure counts.** A suite that fails to parse reports a _smaller_ total
   that reads exactly like a clean baseline. Hit three times across Phases 3–4.
7. **The Phase-5 equivalent of "pending means blank".** A _draft_ month and an _empty/unpublished_
   month render identically unless something deliberately distinguishes them — likewise "correction
   submitted" vs "no correction made". The founder-visible symptom is **"I published it and nothing
   happened."** Give each state its own geometry _before_ building the calendar.
8. **Check which entitlement flag gates the roster first.** The recorded `isOrgAffiliated` vs
   `hasDeptChannels` divergence means an Enterprise workspace **owner** who is neither an agency
   account nor an active org member goes dark. The roster will ride the same flags.

### Phase 5 — Roster and Corrections

The biggest pure-UI build in the scope (a real month calendar with draft/publish states).
Corrections need an append-only history table — we already have this pattern; my notes record
that `ops_audit` is append-only, so copy it.

#### Phase 5 build log — server first

| What                                                  | File                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Roster months, shift linkage, append-only corrections | `supabase/migrations/20260804000000_roster_months_and_corrections.sql` |
| State machine, conflict detection, corrections        | `apps/auth-service/src/attendance/roster.service.ts`                   |
| Manager-only routes                                   | `apps/auth-service/src/attendance/roster.controller.ts`                |
| DTOs that accept no time, org or branch               | `apps/auth-service/src/attendance/dto/roster.dto.ts`                   |
| Invariants (29)                                       | `apps/auth-service/src/attendance/roster.spec.ts`                      |

**The two rules the PDF makes mandatory, and how each is enforced structurally:**

1. **A draft is invisible to the team.** Not by a filter every future reader must remember — there
   is simply **no member-facing route** on the roster controller. A member sees the _result_ of a
   published month through the existing attendance reads; the planning state has no path to them.
2. **A correction never overwrites the original.** Enforced in the **database**, not application
   code: a `BEFORE UPDATE OR DELETE` trigger raises on `attendance_corrections`. Every other guard
   in this phase lives in TypeScript, which a second writer can bypass — but an UPDATE here
   destroys the evidence the table exists to hold, and no later audit could tell it had happened.

#### Phase 5 review rounds 2-3 — what the reviewer broke, and what it cost

Rounds 2 and 3 changed the shape of this phase twice. Recorded because in both cases the
FIRST fix was worse than the bug.

**Round 2 — the state machine wrapped an empty box.** Nothing wrote `cpo_shifts.roster_month_id`,
so `findConflicts` matched zero rows and every month published a confident "0 conflicts". I
linked the two write sites. **My own self-diff then caught that the fix auto-CREATED the month
as a draft — and `myTodayShift` is also the CLOCK-IN gate, so every ad-hoc shift in an org that
had never opened the planner would have become invisible AND impossible to clock in against.**
Changed to resolve an EXISTING month only.

**Round 3 — the reviewer killed the link idea entirely, correctly.** Keying the conflict check on
`roster_month_id` is _defeatable by write order_: a shift created before the month row exists is
unlinked forever and nothing backfills it — and "shifts already exist, THEN the manager opens the
planner" is the normal sequence for every org already running. It was the same empty box wearing a
different hat. **A calendar month is a time range, so the query now asks the question in time**
(`start_at < month + 1 month AND end_at > month`, either side). No link, no backfill, no ordering
dependency, works on day one.

**The one that would have caused real harm.** Hiding draft-roster shifts from members removed the
only way to clock in against them — but `AttendanceRollupService.sweepOnce` did not know that. It
would have written a **permanent `absent` HR record** for every CPO assigned inside a draft month,
within minutes of the window closing, for a shift they were never allowed to see. **My visibility
fix is what armed it.** Same LEFT JOIN + publish predicate now guards the sweep.

Every one of those three is the same shape, and it is the shape to look for next phase:
**a consumer of state I changed, one hop further out than I looked.**

| Round-3 fix                            | Where                          | Why it was not cosmetic                               |
| -------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Rollup roster gate                     | `attendance-rollup.service.ts` | permanent wrong HR record                             |
| Conflicts scoped by time, not link     | `roster.service.ts`            | check was defeatable by write order                   |
| Branch scope on BOTH sides of the pair | `roster.service.ts`            | sibling-branch names/windows leaked                   |
| `roster_month_id = $10`, no COALESCE   | `attendance.service.ts`        | a moved shift kept its old month                      |
| `DeptChatV2Guard` on the controller    | `roster.controller.ts`         | routes were live ahead of the UI                      |
| `cpo_user_id` actually written         | `roster.service.ts`            | the column justifying the dropped FK was NULL forever |
| `listCorrections` LEFT JOIN            | `roster.service.ts`            | `setDayStatus` DELETEs sessions -> trail unreadable   |
| `attendance_status` validated          | `roster.service.ts`            | unvalidated value into an APPEND-ONLY table           |

**A test that pins a bug in place.** `roster.spec.ts` asserted
`@UseGuards(JwtAuthGuard, OrgManagerGuard)` with a literal closing paren, which made adding
`DeptChatV2Guard` impossible without going red. Guard assertions now check membership and relative
order, never an argument list.

**Mutation ledger: 17 entries, all RED.** Two harness findings worth carrying forward:

- Deleting the ownership check produced `Tests: 0 total` — the suite no longer **compiles**,
  because `owned` becomes nullable. My harness scored that as GREEN, i.e. "the test is
  decorative", which would have led me to weaken a guard the **type system** was already
  enforcing. A compile failure is the strongest possible RED; score it that way.
- An obsolete mutation was DELETED rather than left as a standing `HARNESS BUG` row. A ledger with
  a permanent known-broken line trains the eye to skip the ledger.

**A ledger only proves what it enumerates.** The rollup, the COALESCE and the unwritten
`cpo_user_id` all shipped _past_ a nine-entry all-green ledger. Nine green mutations say nothing
about the ninety not written.

#### Phase 5 round 4 — the hole three rounds missed

The reviewer found a **live tenancy hole** that both of us had walked past three times.

`sh.department IS NULL OR sh.department = $3` _reads_ as branch-scoped and is not. A day-status
session — leave, sick_leave, off_duty, absent — carries **no `shift_id`** (`setDayStatus` inserts
none), and so does every legacy clock-in. So `sh` never matches, the `IS NULL` arm is TRUE, and the
branch test is OR-ed away. **Any branch-scoped manager could read AND CORRECT any other branch's
sick-leave records** — the most sensitive rows in the table.

Two tests asserted `/sh\.department = \$3/` and stayed green the whole time. **A token can be
present while being disjoined into irrelevance.** That is the same failure mode as the Phase 3
`postMode` scan, and it is why the assertions now check an EXCLUSION
(`not.toMatch(/sh\.department IS NULL/)`), not a presence.

The fix resolves the branch through the CPO when there is no shift, and — the part that matters —
puts the rule in **one** place (`BRANCH_VIA_MEMBER_JOIN` + `BRANCH_SCOPE_PREDICATE`), because the
defect existed precisely because the rule was written twice. Round 4 was the first round where the
fix was to make the rule **un-repeatable** rather than to repeat it correctly.

**The shape of all four rounds, stated once:** the scoping was correct for the thing being looked
at and absent **one join further out** — the rollup, the conflict pair, the shift-less session.
Every one of them shipped past an all-green mutation ledger. _A ledger only proves what it
enumerates._

#### Phase 5 sign-off — DONE (server slice), and what "done" excludes

Signed off by the adversarial reviewer at round 4. Gates: auth-service `tsc` **0 errors**;
**109 suites / 2060 passed**; attendance **112 passed**; mutation ledger **21/21 RED**.

**In scope and done:** A7.2's month state machine and time-scoped conflict detection, A7.4's
append-only trail, and the tenancy/visibility invariants around both.
**NOT done, by the plan:** the calendar UI, roster templates, copy day/week/month, and the
effective-value read.

#### Phase 5 carry-forward — FIVE conditions, not backlog items

1. **A correction is recorded but changes nothing any reader sees.** `effectiveSession` has no
   caller — `orgSummary`, `pendingQueue`, `exportSessions` (the CSV) and `myShifts` all still
   return the **uncorrected** value. Wiring them is Phase 6.
2. **`editShift` / `reviewSession` / `setDayStatus` still overwrite the session.** This is a
   **Phase 6 ENTRY blocker, not a backlog item**: once real corrections exist, an `editShift`
   between two of them silently rewrites the base of the fold, so the next correction's `before`
   becomes a value never recorded anywhere.
3. ~~**`getMonth` writes on a GET**~~ — **CLOSED 2026-08-07**: verb split (`readMonth` GET-only
   - `POST month/ensure`; publish/archive REQUIRE an opened month). See
     `ENTERPRISE_SCOPE_V2_BUILD_STATUS.md` and the VERB SPLIT block in `roster.spec.ts`.
4. **Timezone.** `$2::date + INTERVAL '1 month'` yields a `timestamp` compared against
   `timestamptz`, so the month boundary resolves in the DB session's TimeZone. Correct only while
   that is UTC, which matches `resolveRosterMonthId`. When per-org timezones land, that comparison
   and `monthKey` must move **together**.
5. **Branch-scoped correction of shift-less sessions resolves the branch through
   `org_members.department`.** Where that is unset, those records are correctable only by an
   _unscoped_ manager — **fail-closed by design**. Populate `org_members.department` before relying
   on branch-scoped correction, or the founder-visible symptom is "I can't correct my own team's
   leave" with a non-obvious cause.

**Pre-flag-flip action (10 minutes, still open).** _Nothing in this repo ever executes this SQL_ —
every test mocks `DatabaseService`. `ON CONFLICT (org_user_id, COALESCE(department, ''), month)`
relies on Postgres inferring an expression index; a `42P10` would ship **green** and 500 on the
very first month open. Run the migration and exercise `POST /attendance/roster/month/ensure`
(`ensureMonth` — since the 2026-08-07 verb split the SOLE `ON CONFLICT` path) + `recordCorrection` once against
a real Postgres before the flag flips.

**Two decisions someone will report as bugs — they are deliberate:**

- An 'Ops' member working a 'Logistics' shift has that session attributed to **Logistics**, so
  their own Ops manager cannot correct it. The record belongs to where the work happened.
- `om.status` is **not** filtered in the branch join. The composite PK gives exactly one row per
  person per org, so it reads as "current or last-known branch" — the right attribution for a
  historical record. Adding `AND om.status = 'active'` would make a departed employee's entire
  history invisible to every branch manager.
- The two branch predicates **deliberately differ**: corrections treat a NULL `$3` as "unscoped
  manager sees all"; `findConflicts` treats NULL as a **bucket**, not a wildcard, because there it
  identifies which roster is being planned. A "consistency" cleanup that harmonises them
  reintroduces a bug at one end.

**One test is intentionally brittle.** The status drift gate asserts `toBe(8)` exactly. Adding a
legitimate 9th status is _supposed_ to fail it — that is the moment the three copies
(`CORRECTABLE_STATUSES`, `AttendanceStatus`, the column CHECK) can drift. Loosening it to `>= 8`
to make a run green kills the gate.

**Design decisions worth the words:**

- **`published` and `amended` are different facts, not a boolean.** A CPO who already read last
  week's plan needs to know it _changed_. Collapsing them gives the founder-visible failure "I
  republished and nobody noticed". An amendment **preserves** the original publish stamp
  (`COALESCE`, not assignment) so "first published on" never silently becomes "last amended on".
- **Draft ≠ empty** — the Phase 3/4 geometry lesson applied up front. `ensureMonth` (POST-only
  since the 2026-08-07 verb split; the GET may return null) always returns a
  row, created on demand as a draft, so the calendar can render "DRAFT · not visible to your team"
  instead of an empty grid. That is the difference between "I published it and nothing happened"
  and a screen that tells you why.
- **Conflict detection is interval overlap** (`a.start < b.end AND b.start < a.end`), the only form
  that catches a 22:00–06:00 shift running into the next morning's. Comparing dates or start times
  alone misses it. Each clashing pair is reported once, archived shifts are excluded, and the
  self-join is org-scoped on **both** sides — one side alone lets another org's shift raise a
  phantom clash.
- **Conflicts are returned, not thrown.** The check doing its job is not an error, so publish
  returns the clashes for the UI to show. `force` exists because a real roster sometimes has a
  deliberate double-booking — and it is written to the audit rather than silently permitted.
- **The correction's `before` comes from the server and its time from the database.** A
  client-supplied before-image would let the audit trail be written to say whatever the caller
  wanted; A7.4 says "when (**server** time)", so the INSERT does not name the column at all and the
  DEFAULT `NOW()` supplies it.

**Mutation ledger** — nine mutations, all caught:

| Mutation                                              | Caught by |
| ----------------------------------------------------- | --------- |
| P1 — overwrite the session instead of appending       | 2 fail    |
| P2 — take `before` from the client                    | 1 fail    |
| P3 — reason no longer required                        | 1 fail    |
| P4 — overlap becomes an exact-time match              | 1 fail    |
| P5 — re-publish no longer amends                      | 1 fail    |
| P6 — the amendment overwrites the first publish stamp | 1 fail    |
| P7 — publish despite conflicts, silently              | 1 fail    |
| P8 — controller hands the service a null branch       | 1 fail    |
| P9 — conflict self-join loses one org scope           | 1 fail    |

**P8 survived my first attempt**, and it is the Phase 3 bug verbatim: correct SQL, controller
passing `null`. My pin asserted `not.toMatch(/,\s*null\)/)`, which the realistic mutation
(`department: null,` — an object field, ending in a comma) walks straight past. **Anchoring on
punctuation instead of the decision is the same mistake the test exists to catch.** It now counts
the real forwards and bans the field being nulled in any form.

**Not built yet, and stated rather than implied:** copy day/week/month, roster templates, and the
month-calendar UI itself. The state machine and the corrections trail are the parts the PDF calls
mandatory and the parts where the invariants live; the calendar is the presentation of them.

### Phase 6 — Onboarding route + navigation

Wire the Enterprise plan → role → create-or-join path, and scope the bottom nav down to
Home + Messenger while inside a workspace.

**Carried in from Phase 0** (deferred here, not dropped):

1. **Hide the Professional plan from the Enterprise onboarding route** (A2/M2). This is the
   A2 screen's job — _not_ `PricingScreen`, which is Settings→Pricing. Filtering that one
   strands existing Pro subscribers with no current-plan row and no downgrade path.
2. **`tierMatrix.ts:30` says "Employee Attendance Tracking".** The PDF's prose calls the
   module plain **"Attendance"** (page 1 LOCKED RULES and frame A2 both), though the plan-panel
   mockup images on pages 2 and 7 do render "Employee Attendance" / "Employee Verification".
   The A2 screen owns the plan feature list, so rename it there when that screen is built.
3. ⚠️ **A real ambiguity for the founder.** A4 says Professional, Meetings and Events must not
   appear **"in this build"**; A2 says Professional must not appear **"in this flow"**. Those
   are different scopes — "this build" would mean removing Professional from Settings→Pricing
   app-wide, which breaks live Pro subscribers. Do not resolve this silently; put it in front
   of the founder alongside Part 9 Q3.

---

## Part 7 — How it fits our existing design

**Good news: the PDF's visual language is already our visual language.**

The mockups are dark navy/obsidian with cobalt accents — that's our current
**obsidian `#07090D` / cobalt `#5B8DEF`** system (see `DESIGN_REVIEW_LOOP.md` gate G8).
`src/screens/deptchat/_obsidian.tsx` already holds the shared dept-chat design tokens
(`OB`, `ObHeader`, `SectionLabel`, `Card`).

**So: build every new screen out of `_obsidian.tsx` primitives.** Don't invent new components,
and don't drift back to the legacy Command-Navy palette.

Other fit notes:

- **Keyboard:** any new screen with a text input must use `useKeyboardLayout` — hand-rolled
  keyboard avoidance is banned repo-wide and enforced by a test.
- **Encryption:** channels stay Signal groups. The `group_conversation_id` linkage already
  works and **must not change** — group key distribution is a locked, architecture-approved
  area.
- **The org model already matches.** `department_channels.org_id` references `users(id)`,
  and our Service-Provider architecture already treats the company agent as the org. The
  Enterprise workspace can sit on the same foundation.

---

## Part 8 — Risks and things to watch

| Risk                                                        | Why it matters                                                                                                                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This is mostly a backend job**                            | Every "server-side enforced" line is auth-service work. Don't scope this as a UI sprint. (Mitigated:`dept-chat-access.guard.ts`, `org-manager.guard.ts` and deny-by-default RLS already exist to extend.) |
| **Hierarchy changes touch permission checks**               | Getting "lower Admins can't manage parent branches" wrong is a**tenancy leak** between companies. Test this hardest.                                                                                      |
| **Channels are Signal groups**                              | Any change to channel membership triggers a**group rekey**. Adding hierarchy must not accidentally rekey everything.                                                                                      |
| **`test:crypto` flakes ~50%**                               | One red run is not evidence — run it twice. (B-126)                                                                                                                                                       |
| **We have a live parallel session on `sqa.md` bug numbers** | Fetch before picking new B-numbers; there's already a known B-352..B-354 collision.                                                                                                                       |
| **Deploys are manual**                                      | CI`deploy-staging.yml` never fires (missing `CONTABO_SSH_KEY`). Backend changes need a manual sync.                                                                                                       |

---

## Part 9 — Questions for the founder

These genuinely change the build, so they're worth answering before Phase 1 starts:

1. **Is the Enterprise workspace a new org, or the same org as the existing Service Provider
   company?** Our `org_id` points at `users(id)` and the agency company is already an org. If
   they're the same thing, we save a lot of work. If they're separate, we need a new tenancy
   boundary.
2. **What happens to the ~existing flat channels on live accounts?** My recommendation: they
   become "Main" (level 1) under an auto-created Enterprise root, so nothing visibly changes
   for current users.
3. **Bottom nav "Home + Messenger only" — does that replace the whole app's tab bar, or only
   while inside an Enterprise workspace?** The PDF is phone-scoped and workspace-scoped, so I'd
   assume workspace-only — but this affects other Bravo products, so it's your call.
4. **Does an Enterprise Admin need to be a paying Enterprise subscriber, or can they be
   invited without a subscription?** A5 allows inviting admins by phone and email, which
   implies invited admins don't each need to pay.
5. **When an AGENCY (service provider) uses Department Channels, are its staff "Members" or
   "CPOs"?** _(Raised by Phase 0.)_ Frame A7.3 says remove remaining **Employee or CPO**
   labels, but the repo has a standing "rule 7: provider untouched". I changed the Enterprise
   branch to `Member` and deliberately left the provider branch as `CPO`, because flipping it
   changes wording for live agency accounts. One line in `src/screens/deptchat/deptNoun.ts`
   either way — say the word and it changes.

---

## Appendix — Full frame-by-frame status

| Frame   | Name                        | Status     | Where                                     |
| ------- | --------------------------- | ---------- | ----------------------------------------- |
| A1 / M1 | Welcome / Service Selection | ✅ Exists  | `AuthNavigator` (Splash, Onboarding)      |
| A2 / M2 | Enterprise Plan             | 🟠 Partial | `PricingScreen.tsx` — must hide Pro       |
| A3 / M3 | Create Secure Account       | ✅ Exists  | auth Register                             |
| A4 / M4 | Select Role                 | 🔴 Missing | new screen                                |
| A5      | Create Org Workspace        | 🟠 Partial | `org` backend exists; UI mostly new       |
| M5      | Join / Referral Request     | 🔴 Missing | new                                       |
| M11A    | Approval Result             | 🔴 Missing | new                                       |
| A6 / M6 | Home Dashboard              | ✅ Exists  | `DepartmentalHomeScreen.tsx`              |
| A7      | Admin Attendance            | ✅ Exists  | `AdminAttendanceScreen.tsx`               |
| A7.1    | Manage Shifts               | ✅ Exists  | `ShiftManagementScreen.tsx`               |
| A7.2    | Monthly Roster              | 🔴 Missing | new — biggest UI build                    |
| A7.3    | Set Day Status              | ✅ Exists  | `DayStatusScreen.tsx`                     |
| A7.4    | Attendance Corrections      | 🔴 Missing | new + append-only history                 |
| A8      | Admin Incidents             | ✅ Exists  | `IncidentQueueScreen.tsx`                 |
| A9      | Admin Dept Channels         | ✅ Exists  | hierarchy landed Phase 1 (level-indented) |
| A10     | Admin Vault                 | 🔴 Missing | `VaultScreen.tsx` is personal-only        |
| A11     | Approvals / Notifications   | 🔴 Missing | new                                       |
| M7      | My Attendance               | ✅ Exists  | `MyAttendanceScreen.tsx`                  |
| M8      | Visible Channel Dashboard   | ✅ Exists  | level sections landed Phase 1             |
| M9      | Inside Channel Chat         | ✅ Exists  | `DepartmentChatScreen.tsx` — no call btns |
| M10     | Member Incidents            | ✅ Exists  | `MyIncidentsScreen.tsx` + report flow     |
| M11B    | Member Vault                | 🔴 Missing | needs org scoping                         |

**Tally:** 11 exist · 4 partial · 8 missing.

---

## Phase 6 — Enterprise onboarding route + navigation decision

### Phase 6 ENTRY BLOCKER — cleared before any Phase 6 work

Phase 5 signed off with `editShift` / `reviewSession` / `setDayStatus` still overwriting a
session directly, recorded as an **entry** blocker rather than backlog. It is now closed.

The corruption it caused is worth stating exactly, because "two mechanisms write the same field"
undersells it. `recordCorrection` folds the correction chain **over** the session row to decide
what the record said before, and **the chain wins**:

```
c1:        absent -> present     chain now says 'present'
editShift: -> 'late'             the ROW says 'late'; nothing records it
c2:        before = 'present'    <- a lie. It said 'late'.
```

That corrupts the single thing A7.4 exists to guarantee, in an **append-only** table where it can
never be repaired. All three paths now call `assertNotUnderCorrection` and throw
`session_under_correction`. `setDayStatus` needed extra care: it upserts by **DELETING** the day's
marker, so the prior markers are read **first** and the delete is refused — deleting a corrected
marker strands its trail, which is precisely the failure the missing foreign key was justified by.

**Refuse, not reconcile.** Making those paths record corrections themselves is a real feature and
belongs with the correction UI. Refusing is honest, fail-closed, and zero-regression today: no
client can create a correction yet, so no session in production has one.

### The navigation decision (Gap 8) — REACHABLE is not SHOWN

The PDF states on **four separate pages** that the workspace bottom navigation is
**Home + Messenger only**, and its A6/M6 frames reach Channels, Attendance, Incidents and Vault
from the **Home dashboard**. The shell had five tabs.

**The decision: separate what the bar RENDERS from what the navigator REGISTERS.**

The obvious implementation — delete the four `Tab.Screen`s — would have broken **nine live
`navigation.navigate('Channels' | 'Attend' | 'Incident' | 'Vault')` call sites**, including the
Home dashboard's own cards, to satisfy a _presentation_ rule. So the routes stay registered and
carry `options={HIDDEN_TAB}` (`{tabBarButton: () => null}`, defined **once** so the four cannot
drift apart).

`ObsidianTabBar` had to change for this to be possible at all: it mapped `state.routes`
unconditionally, so setting `tabBarButton` did nothing and the **only** way to shrink the bar was
to unregister the route. It now honours React Navigation's own convention inside the per-route map.

**Messenger is an EXIT, not a screen.** Its `tabPress` is intercepted (`preventDefault`, then
`getParent()?.navigate('MessengerHome')`) — `getParent()` rather than a root dispatch because this
shell is mounted in more than one place.

**The stand-in highlight.** With a hidden tab active, no rendered item would be focused and the bar
would highlight nothing — "where am I?". Home stands in as their parent while one is open. It is
gated on `focusedIsHidden`, so it is **inert** for `MainNavigator` and `CpoNavigator`, which share
this bar and hide nothing.

> **Self-diff.** `ObsidianTabBar` has three consumers. A grep of all of `src/` found **no** other
> `tabBarButton` usage anywhere, so neither other navigator changes behaviour.

**Gates:** mobile `tsc` 43 vs baseline 47 · navigation 13 suites / 134 passed ·
`screens/(messenger|deptchat)` 34 suites / 452 passed · Phase 6 mutation ledger **9/9 RED**.

> **A test that caught itself.** The first version anchored the "guard is inside the map"
> assertion on `indexOf('options.tabBarButton')`. Adding the stand-in made that token appear
> _above_ the map, so the ordering assertion silently inverted and went red for the wrong reason.
> Anchored on the guard's full shape now. Same class as every other decorative-assertion finding
> in this program: **assert the decision site, not a token that happens to be near it.**

### Phases 1 and 2 — DONE (retroactive review, 2026-08-04)

Reviewed retroactively because they were built BEFORE the fix→review loop existed; Phases 3–6 got
it and these two did not. Both came back **DONE**.

**The premise turned out to be wrong in an interesting way.** These were framed as the risky ones,
and the review found the opposite: the Phase 1 trigger comments document a five-level escape
someone had already found and closed, `createChannel` already refuses a `P1 → B2 → N` archive
interaction, and the Phase 2 role re-seed already reads back the **stored** `post_mode` rather than
the requested one. The lens that later found the rollup and the admin gap was being applied here
before it had a name. What these phases lack is not scepticism — it is **execution against a real
database**.

#### Verified, not assumed

- **Tenancy: no cross-org reach.** `listChannels` joins THROUGH `department_channel_members`
  (`WHERE m.user_id = $1`), so cross-org rows are structurally unreachable — never joined in, not
  filtered out. `parent_id` is withheld per-row unless the caller is a member of the parent.
- **`listChannelsForOps` has no org filter — and correctly so:** `/ops/*` is behind
  `AdminGuard` (HQ staff), a deliberate superuser view. Verified the guard rather than assuming it.
- **The derive-trigger + CHECK ordering holds.** No flatten-or-exceed path via INSERT or UPDATE:
  the trigger fires on every update and freezes `level` to `OLD.level`; re-parenting is refused
  outright because a `FOR EACH ROW` trigger would re-level the moved node and leave descendants
  stale.
- **`#broadcast` cannot be posted to, deleted, or stranded by a mode change.** The re-seed reading
  back the stored `post_mode` is what makes the last one true.

#### Fixed in this pass

| Fix                                                   | Why it mattered                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ops `ORDER BY` reverted to `created_at DESC`**      | Phase 1 changed it to level-first, but the ops page is a FLAT table with no depth column — so the only visible effect was an HQ operator's row order silently changing, **for a consumer that does not exist**. The columns still ship; whoever builds the hierarchy view changes the order together with the UI that explains it.                                                 |
| **The cross-org move guard now fires from BOTH ends** | It tested `NEW.parent_id IS NOT NULL` only — so moving a ROOT that HAS children was silent, leaving those children in the old org pointing at a parent that had left it. Same forbidden state, opposite side. DDL-only (nothing writes `org_id`), but _a guard that is asymmetric in a way its own name does not admit is worse than no guard, because the next reader trusts it._ |
| **Trigger firing order recorded**                     | Postgres fires BEFORE ROW triggers ALPHABETICALLY, so Phase 2's `broadcast_mode` runs before Phase 1's `set_level`. Immaterial today (disjoint columns) — but a future trigger needing the DERIVED level must sort after `set_level`, and the only lever is its name.                                                                                                              |
| **The non-delete trigger's scope stated precisely**   | "Covers every writer at once" is true of every writer _of DELETE_. Two things sit outside it and the claim read broader: a two-step `is_broadcast = false` then DELETE (DDL-only), and **archive**, which is guarded in the service — the enumeration trap this very migration argues against, applied to the verb the PDF calls _preferred_.                                      |

Ledger **2/2 RED**. Gates: auth-service `tsc` 0 errors, **2092 passed**; department suites 127;
app `(channelHierarchy|deptchat|navigation)` 26 suites / 359 passed.

#### Phase 1/2 carry-forward

1. **Visible-depth projection — the algorithm, so nobody re-derives the dead end.** Do NOT renumber
   by raw `level`. Compute **visible depth = the number of the caller's VISIBLE ancestors**, a
   recursive CTE over the visible set the `parent_id` CASE already computes per row. The
   counterexample resolves cleanly: a level-3 whose level-2 parent is visible but whose level-1
   grandparent is not → the level-2 gets depth 0 and the level-3 depth 1, rendering as a root with
   one child. **Not a leak** (everything is org-scoped through the membership join; all `level: 2`
   reveals intra-org is "an ancestor exists you cannot see") — it is a _rendering_ defect: today
   such a row renders under "Sub-channels" with nothing above it.
2. **Move the archive guard into the database**, expressing the direct-vs-cascade distinction — a
   child `#broadcast` IS archived when its parent is, on purpose, so it is not a flat refusal.
3. **Paging.** No correctness defect at any current channel count, but the PDF names it and
   `listChannels` sits on the workspace boot path — and this repo has a documented boot-starvation
   class (B-155). The existing `ORDER BY level, created_at` is already a keyset cursor's shape.
4. **ops-console hierarchy consumer** — `DepartmentChannelRow` still carries neither field.

> **The one thing not to ship without.** Every Phase 1/2 invariant that matters lives in the
> DATABASE — two triggers, a CHECK, a partial unique index, an FK with RESTRICT — and **no unit
> test with a mocked db can execute any of them**. All of it is pinned by source scans only. Run
> both migrations against a real Postgres once and exercise four things: the five-level recipe, the
> cross-org parent insert, the `#broadcast` DELETE, and a second `#broadcast` at the same level.
> Minutes of work, and the only evidence the triggers fire at all. Same standing item as Phase 5's
> `ON CONFLICT`.

### Phase 6 — DONE (signed off round 4)

**Gates:** auth-service `tsc` **0 errors**, **110 suites / 2090 passed** · mobile `tsc` 43 vs
baseline 47 · app suites 57 / 668 passed · ledgers **12/12 + 10/10 + 10/10 RED**.

#### The onboarding route (A2/M2, A4/M4, A5)

`EnterpriseSetupScreen` (the create-or-join fork) and `CreateWorkspaceScreen`, registered in
**both** shells that mount `JoinWorkspace` — registering the fork where its sibling is not is the
Phase-3 defect class ("a screen in 2 shells, a route in 1 → navigate silently DROPPED").

**A2/M2 is satisfied STRUCTURALLY**: the fork shows no plan tiers at all, so there is no list for
a later edit to re-widen. The test asserts the absence of `pendingTier` / `plansForProduct` /
`tierMatrix` / `Professional` — not one string.

#### The workspace owner — TWO founder decisions

**1. Not a service provider (2026-08-04).** The only existing way to own an org was
`POST /agents type='company'`, which flips `users.role` to `service_provider` and routes the
account into the provider home and the job marketplace. An Enterprise company running internal
department channels is not a security-services agency, so `POST /org/workspace` mints an owner
without that role grant.

**2. Creating a workspace REQUIRES an active Enterprise subscription (2026-08-04).** Without it
the route was a self-serve way past the paid gate — `owns_workspace` is checked FIRST in the
client's `isOrgAffiliated`, so one call unlocked the whole Enterprise surface for any
authenticated user, permanently.

#### The three gaps decision 1 created, and where each was found

| Gap                                  | Symptom                                                                                                                 | Found by                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `isOrgAffiliated`                    | the owner cannot ENTER the workspace they just created                                                                  | predicted, fixed in build |
| `is_org_manager` / `OrgManagerGuard` | the owner enters but cannot ADMINISTER — 403 on the roster surface, channel management, **and the join-approval inbox** | reviewer, round 3         |
| `endCpoAccess`                       | an unrelated org revoking a CPO membership **destroys the owner's whole session**                                       | reviewer, round 3         |

All three are the same shape, and it is the shape of this entire program:
**the fix was correct at the layer being examined and absent one layer out.**
Five instances across Phases 5–6 — the rollup behind `myTodayShift`, the pair behind the month,
the shift-less session behind the shift, the disputing member behind the manager, and
`is_org_manager` behind `isOrgAffiliated`.

> **The habit that ends it, and the one thing here worth carrying to phases nobody reviews:**
> before writing a fix, ask **"what else decides this same thing?"** — not "who reads this?".
> Run that sweep BEFORE the code. For the guard arm it found `resolveIsOrgManager` and two client
> deciders in one grep; both client sites read the server flag, so one server fix covered them.

#### ONE active-enterprise rule, not six

The formula existed in **six** places — `owns_workspace`, `is_owner`, `is_enterprise`,
`OrgManagerGuard` Path 1b, `WorkspaceService`'s create gate, and `effectiveTierOf`. The sharpest
instance was inside ONE function: Path 1b inlined the SQL while Path 3, twelve lines below, called
`effectiveTierOf`.

Nothing had drifted. The trigger is a tier change — a grace period, an `enterprise_trial`, a rename
of `pro_active_until` — where the natural edit is `effectiveTierOf` and the five SQL copies keep
the old rule. Consolidated into `activeEnterpriseSql(alias)` next to its TypeScript twin, pinned by
a scan asserting `subscription_tier = 'enterprise'` appears **only** there. **A unit test cannot see
copy N+1; a scan fails on the copy not yet written.**

#### Two defects I shipped and caught myself

- **A false comment on the lapse rule.** Path 1b claimed "no lapse test needed, a lapsed owner
  falls through to Path 3" — false: Path 1b returns _before_ Path 3. A lapsed owner would have kept
  full admin forever, against a decision the founder had just made. All three sites (guard,
  `is_owner`, `owns_workspace`) now lapse together, so client and server agree.
- **A decorative test on the newest code — third occurrence.** The mutation deleting
  `if (asOwner) { … return true; }` came back GREEN: the scan asserted the owner QUERY exists, and
  deleting the block leaves the query. Replaced with a behavioural test that runs `canActivate`.
  **The newest part of a fix keeps getting the weakest test, because the test is written at the
  same moment as the code and ends up shaped like the implementation instead of the requirement.**

#### Phase 6 carry-forward (none blocking)

1. **Render coverage** for the fork and post-create navigation. Highest-value case:
   `recheckMembership` swallows a transient 401, so ask _"does it still navigate when the refresh
   failed?"_ — landing in a workspace the client does not yet believe you own.
2. `navigate('Messenger')` type-checks and would render the blank stub — make it a
   redirect-on-focus stub next time that file is open.
3. The Home-card assertion proves a string, not reachability. Home is now the **sole** path to four
   modules, so assert the cards render and are pressable.

Still standing from Phase 5: **N4 is a ship-gate for the correction UI**; and the migration +
`ON CONFLICT` exercised once against a real Postgres before flag-flip (**no test in this repo
executes that SQL** — note the verb split narrowed where a 42P10 would first fire: no longer the
calendar's initial GET but the explicit ensure/publish/archive POSTs, i.e. rarer but
higher-stakes; the manual probe matters MORE now, not less). ~~`getMonth`'s verb~~ — CLOSED
2026-08-07 (verb split, see `ENTERPRISE_SCOPE_V2_BUILD_STATUS.md`).
