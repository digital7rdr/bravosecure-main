# Bravo Channels vs2 — Client Review Fix Plan (2026-08-10) — Rev 10 (FINAL — approved to build)

**Source:** `Bravo Channels vs2.pdf` — "Bravo Enterprise App Review | 9 August 2026" (client), 18 items.
**Baseline:** `main` @ `839c4724`. Current-state evidence gathered 2026-08-10 by four parallel
code-survey agents reading source (every claim below carries file:line).
**Companion docs:** `ENTERPRISE_SCOPE_V2_BUILD_STATUS.md` (verified build status),
`ENTERPRISE_DEPT_CHANNELS_SCOPE_V2_FIT.md` (scope-v1 plan).
**Review protocol:** critic-agent review → revise → re-review until consensus, plus a dedicated
edge-case agent, BEFORE any code. Each implementation phase repeats that loop on the code.
**Rev 2 (2026-08-10):** folds in critic round-1 findings F1–F14 (verdict REVISE, 6 MAJOR) and
edge-case round-1 findings (24: 6 NO / 18 PARTIAL).
**Rev 3 (2026-08-10):** folded in edge-case round-2 (14: W1–W5, N1–N9).
**Rev 4 (2026-08-10):** folds in critic round-2 (1 BLOCKER, 6 MAJOR, 13 MINOR). Rev 4 is a
**simplification** — round 2 proved two Rev-3 mechanisms were more complex than the problem:

- The ancestor-based branch-scope rebase **cannot work** (B-1): a manager's scope is free-text
  `org_members.department` with no FK to channels, and item 7 nulls the very column the walk
  would compare against. Replaced by the one-line fallback Rev 3 already carried — `department`
  derived invisibly from the root organisation on create. **This deletes the P2↔P3 coupling.**
- The `{authority}` helper mode dissolves (M-1/M-3): `listChannels` already computes parent
  visibility (`department.service.ts:193-196`); surfacing it as a `parent_hidden` DTO flag
  closes the root-rule hole, removes the mode's main axis, and makes N4's "restricted rung" a
  derived fact instead of a level-gap heuristic.
  **Rev 5 (2026-08-10):** folds in critic round-3 (2 BLOCKER, 3 MAJOR, 6 MINOR) and edge-case
  round-4 (6 gaps + 5 probed-clean records). Both blockers were incompleteness in Rev 4's own
  simplifications: `parent_hidden` needed a companion `visible_ancestor_id` (a boolean cannot say
  WHICH organisation an orphan sits under, and multi-root is the whole premise), and the derived
  `department` fixed only the channel side of a two-sided string comparison — the manager side is
  still typed by hand, so fresh organisations would have re-broken scoped invites. Finding volume
  per round: 24 → 14 → 13 → 6, converging.
  **Rev 6 (2026-08-10):** folds in critic round-4 (2 BLOCKER, 3 MAJOR, 3 MINOR). Both blockers sat
  on one seam — what the branch-scope string IS, who writes it, and what else reads it — and both
  are closed by **withdrawing** Rev 5's branch-picker: `org_members.department` turns out to be the
  scope key for attendance (13 handlers) and incidents as well as invites, so changing what admins
  write into it needs its own caller sweep, and it buys nothing the derivation doesn't already
  give. The channel side now derives through ONE resolver (`root.department ?? root.name`) that
  returns the value admins already type — including for the seeded legacy roots whose name and
  department differ (`Team Roster`→`Roster`), which a name-keyed rule would have refused outright.
  The picker becomes a founder question.
  **Rev 7 (2026-08-10):** folds in edge-case round-5 (9 gaps, three clusters). The headline: the
  DERIVATION is withdrawn too. Round 5 showed four of its nine findings, including a security
  hole, all fall out of one choice — keying a permission boundary on a display name (root names
  have no uniqueness constraint, so two organisations called "Security" share one scope). Item 7
  now changes ONE line in `assertMintableTeam` instead: a team with no branch is mintable by any
  manager, which is the rule this very file already applies four times over
  (`COALESCE(... , $2) = $2` → "unrouted belongs in every manager's inbox"). No derivation, no
  uniqueness guard, no rename sync across four subsystems, no transaction `configureChannel`
  lacks, no mid-tree rule, no tenant gate. Cluster (a) — E1/E2/E3/E4/E9 — closes by deletion.
  Also: the zero-organisations rendering rule becomes total rather than guarding one producer,
  and the seed marker moves inside the transaction because the happy path (a clean organisation's
  first employee) legitimately seeds zero rows. Rev 7 additionally folds the three critic round-5
  findings that survived the derivation's deletion: the invite picker's greying rule gets a real
  wire (`mintable_by_me`, server-computed), the form change is tenant-gated so the agency lane is
  untouched, and item 7's lead-in becomes an explicit record of the two withdrawn designs.
  **Rev 8 (2026-08-10):** critic round 6 **verified the Rev-7 design against source and found it
  sound** — the four `COALESCE` predicates really do mean "unrouted belongs to every manager", and
  the widening cannot reach anything new because a scoped manager can already mint a teamless
  invite that seeds org-wide. Rev 8 fixes the sweep, not the design: §3 still carried the
  withdrawn derivation as a live "Decision" (BLOCKER — the section a P2 implementer reads was
  instructing the design round 5 killed); the named edit site was the wrong function, and editing
  it literally would have started branch-refusing referral-link mints in a lane nobody reviewed;
  and `mintable_by_me` had three disagreeing definitions, now one shared helper with a
  source-scan test. Plus five citation/mechanism corrections.
  **Rev 9 (2026-08-10):** folds in edge-case round 6 (10 gaps + 4 probed-clean). The one that
  changes what we tell the founder: **§10.11 was asking about the smallest of four consequences.**
  The "unrouted belongs to every manager" convention governs four predicates, not one, so once
  items 5+12 leave new channels branchless a scoped manager can also read, revoke and DECIDE
  other branches' invites and join requests — three of those follow from the client's own ask,
  not from our line. §10.11 now states all four and points at the work that would restore the
  boundary. Also fixed: the rendering table needed an explicit precedence rule or it would have
  swallowed every genuine root (zero organisations for everyone); the synthetic header needed its
  own grouping key or two hidden organisations merge into one false parent; the restricted guard's
  `parent_id IS NULL` predicate matches EVERY channel in every existing workspace and would have
  permanently blocked managers-only channels there; the seed flag belongs on the join-request row,
  since the other lane never claims a link; "cleared on success" needed defining against a loop
  that swallows its own failures; and the client tenant signal that looked right is wrong for the
  agency-member-who-owns-a-workspace persona.
  **Rev 10 (2026-08-10) — FINAL.** Critic round 7 closed the loop: all round-6 items verified in
  the body, every mechanism re-checked against source (`root_id` resolvable in the bounded walk;
  the restricted predicate is byte-for-byte `archiveChannel`'s existing child query; `acceptInvite`
  really does write the join-request row inside its tx, on both arms). Two one-line majors folded:
  the rendering rule is now a single **five-case** switch (the three-row version put a spurious
  "(not shown)" rung under every ordinary parent and, via the compat fallback, would have emptied
  the ADMIN organisation list — dead-ending item 8's create flow on its first use), and the client
  tenant predicate reverts to `owns_workspace || org_is_workspace` because the session-only
  workspace context is undefined on the notification-tap path that reaches the editor. Plus four
  precision fixes and a corrected attribution in §10.11 — the widening comes from item 7's form
  change, not items 5+12, and it is a change of degree, since a blank department field already
  produces a matching channel today. **Verdict: fold and ship; no further review round.** Finding
  volume across seven rounds: 24 → 14 → 13 → 6 → 9 → 10 → 6.
  See §11 review log.

---

## 0. The 18 asks, condensed (traceable to the PDF)

| #   | Area       | Ask (condensed)                                                                                                                                                                                                                                                    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Onboarding | Replace "company" with "organisation" on the Enterprise fork screen (and same-flow strings)                                                                                                                                                                        |
| 2   | Onboarding | Invite member: hierarchical picker — pick organisation (SASFA/CORTAC/GSSG), drill into country → team (Fort Hunter); record the full path; place member with correct channel access + role                                                                         |
| 3   | Onboarding | Keyboard must never cover what you're typing on the Invite member form (role controls stay visible)                                                                                                                                                                |
| 4   | Onboarding | Remove the one-organisation-per-account restriction; org switcher; per-org scoped visibility (channels, permissions, attendance, incidents)                                                                                                                        |
| 5   | Channels   | Do NOT auto-create default channels (Broadcast, Team Roster, Operations, General, Announcements) — new org starts clean                                                                                                                                            |
| 6   | Channels   | Manage Channels must be findable: blue "Manage Channels" button on the channels screen (admin-only); cog stays as secondary. Directory drill-down: only after selecting a main channel do you see Sub / Sub-sub                                                    |
| 7   | Channels   | Simplify New Channel form: remove description/department field, fixed parent list, Type options. "Name of channel" placeholder + Top level indicator + Access (Standard/Read only/Restricted) directly below                                                       |
| 8   | Channels   | Create Channels flow: select an organisation (or create new organisation) → per-org channel dashboard showing the full hierarchy with connector lines; create main/sub/lateral channels; Save / Delete / Add Members (role assign) / Archive                       |
| 9   | Channels   | The HOME tab button must return to the organisation dashboard (it currently leaves you on Department Channels)                                                                                                                                                     |
| 10  | Channels   | Remove the Broadcast/Announcements card from the top of the org dashboard                                                                                                                                                                                          |
| 11  | Channels   | Channel message box ≈ WhatsApp size/behaviour                                                                                                                                                                                                                      |
| 12  | Channels   | Same as 5 at every level — nothing auto-added beneath a main channel                                                                                                                                                                                               |
| 13  | Attendance | One combined attendance dashboard (shifts + day status + roster + corrections, publish, conflicts); user must be shown how to add a member to a shift                                                                                                              |
| 14  | Attendance | "Emergency leave" label overflows its card — all status names must fit at every screen size                                                                                                                                                                        |
| 15  | Incident   | The category grid is the FIRST screen on entering Incident Report                                                                                                                                                                                                  |
| 16  | Incident   | Incident push must name the organisation + reporter, deep-link to the review screen, and never say "CPO"                                                                                                                                                           |
| 17  | Home       | Admin can hide Attendance and Incidents from the home screen; rename the "Departmental" header to "Channels"                                                                                                                                                       |
| 18  | App-wide   | Profile drawer: rename "Departmental Chat" → "Channels", move it under SWITCH DASHBOARD; every dashboard switch gets an "Are you sure you wish to leave X?" (Yes/No); remove "Choose Dashboard" completely; internal messenger entry inside a dashboard never asks |

---

## 1. Phase map (implementation order)

| Phase                              | Items                       | Risk          | Why this order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — Copy + small UI fixes         | 1, 9, 10, 11, 14, 17-rename | Low           | Independent, shippable immediately                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P2 — Invite flow                   | 2, 3                        | Medium        | Self-contained screen + one server seam (scoped seeding). **Delivers the shared organisation-grouping helper P3 consumes (critic F11)**                                                                                                                                                                                                                                                                                                                                                                         |
| P3 — Channel structure             | **5, 12, 6, 8, 7**          | High          | One coherent redesign of directory/manage/create; **workspace-tenant-gated throughout (critic F3)**. **Item 7 is LAST and lands in the same commit as item 8 (critic M-5)** — 7 deletes the PARENT radio list, today's only parent selector, so shipping it before the tree leaves the app able to create top-level channels only. **One-way P2 coupling:** item 7 changes the mint predicate that P2's `mintable_by_me` helper computes — same predicate, one helper, both land in item 7's commit (§4 item 7) |
| P4 — Attendance dashboard          | 13                          | Medium        | Screen refactor, no data-model change                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P5 — Incident entry + notification | 15, 16                      | Medium        | Route order + push payload/deep-link (B-414-sensitive)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P6 — Org settings + drawer         | 17-hide, 18                 | Medium        | New org-settings surface + product-switch confirms; **touches MainNavigator → B-414 co-land rule applies (critic F4)**                                                                                                                                                                                                                                                                                                                                                                                          |
| P7 — Multi-organisation membership | 4                           | **Very high** | Architectural; last, own design section (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Each phase = implement → critic agent (review ⇄ fix to consensus) → edge-case agent → gates →
self-diff (CLAUDE.md rule 8). P1–P6 independently shippable; P7 ships alone.

---

## 2. Phase P1 — copy + small UI fixes

### Item 1 — "organisation" wording

**Current:** `EnterpriseSetupScreen.tsx:103-106` — "You are setting up your **company**…" and
`:119-122` — "Your **company** already uses Bravo…". Same-flow: `WorkspaceHubScreen.tsx:372` —
"Create your **company's** secure workspace…". `CreateWorkspaceScreen` already organisation-worded.
**Fix:** replace the three strings; keep the two cards and the create-makes-you-Admin /
join-needs-invite explanations. Also `IncidentDetailScreen.tsx:97` "company admin" →
"organisation admin".
**Deliberately untouched (flagged, §10.4):** Vault "Company" shelf label (`VaultScreen.tsx:42,432`,
`FilesScreen.tsx:859`, `vaultOps.ts:149`) — load-bearing security distinction with own tests.
`ProfileCompletionScreen.tsx:104` already dual-worded. `RoleSelectionScreen.tsx:185` is the
Operator-Partner arm (genuinely a security company).
**Test:** extend `enterpriseOnboarding.test.ts` with a comment-stripped, CRLF-safe source scan:
no `company` in the fork screen's user-visible strings.

### Item 9 — HOME tab press swallowed inside a module — root cause CONFIRMED

**Cause (deterministic, verified by critic — no device diagnosis needed):**
`ObsidianTabBar.tsx:87-89` aliases `focused = standInKey === route.key` for the stand-in item,
and `:107` skips `navigate` on `!focused`. With `standInTab="Home"`
(`DepartmentalNavigator.tsx:249`), a Home press while any hidden tab (Channels/Attend/Incident/
Vault) is focused is ALWAYS swallowed. (`Home` is a bare screen, not a stack —
`DepartmentalNavigator.tsx:255` — so the stale-stack alternative cannot apply.)
**Fix:** in `ObsidianTabBar`, a press on the stand-in item while a hidden route is focused
navigates to the stand-in tab unconditionally; a press while GENUINELY focused stays a no-op.
**Plus (edge P1-1):** the abandoned hidden tab's stack must be reset to its root on that press —
otherwise the user re-enters `Channels` via the dashboard card
(`DepartmentalHomeScreen.tsx:292`, bare `navigate('Channels')`) and lands back inside the same
deep `DepartmentChat`, re-reporting the bug. Reset-to-root is the decided behaviour; pin it in
the unit test.
**Prerequisite — draft loss (edge W1, ships BEFORE the reset):** `DepartmentChatScreen.tsx:299`
holds its composer text in bare `useState` with **zero** `drafts[` writes, unlike `ChatScreen`
(MI-06 persists to `messengerStore.drafts[conversationId]`, `:216-220`, `:3461`, `:3540`). The
reset unmounts `DepartmentChat` (Channels stack, `DepartmentalNavigator.tsx:108`) and would
silently eat a half-typed channel message — an action that is safe in a 1:1 chat. Land MI-06
draft persistence on `DepartmentChatScreen` (reuse `messengerStore.drafts`) in the same phase,
before the reset. The other hidden tabs are safe (incident wizard autosaves,
`ReportIncidentDetailsScreen.tsx:64-88`; Vault reset legitimately re-arms the MFA gate).
**Regression scope (verified complete):** CpoNavigator passes no `standInTab`
(`CpoNavigator.tsx:98`); MainNavigator uses a different bar (`MainNavigator.tsx:126`). Assert
non-stand-in bars keep today's behaviour.

### Item 10 — remove the Broadcast card from the org dashboard

**Current:** `DepartmentalHomeScreen.tsx:193-225` (render), `:79-89` (selection), `:69-71`
(unread), styles `:396-404`.
**Consumers verified (critic F7):** every `announce` reader is inside `DepartmentalHomeScreen.tsx`
(state `:64`, unread, selection, render, styles); `DepartmentChatScreen.tsx:1361` is an unrelated
local. Deleting the card also kills the app's only `channel_type === 'board'` existence
assumption — a P3 prerequisite satisfied here.
**Fix:** delete card render + `announce` state + `announceUnread` + dead styles.
**Test:** DepartmentalHome render test update; site-anchored source scan (card gone).

### Item 11 — WhatsApp-sized channel composer

**Current:** `DepartmentChatScreen.tsx:1358-1366` TextInput; `inputPill` `minHeight:38,
maxHeight:116` (`:1720-1724`); `input` `fontSize:14, maxHeight:110` (`:1725`).
**Fix:** match the main messenger `ChatScreen` composer metrics (read its current values at
implementation time): larger base height, fontSize ~15.5-16, grow to ~6 lines, controls
bottom-aligned. Keep `bottomPad(8)` (B-184) untouched.
**Gate:** `src/screens/messenger/**` → full messenger gate (crypto ×2 + app messenger screens).

### Item 14 — "Emergency leave" overflows its card

**Current:** `DayStatusScreen.tsx:423-429` — `statCell` fixed `width:'47.5%'`, row-direction;
`statText` has no `flex:1`/`minWidth:0`/`numberOfLines`; label (`_obsidian.tsx:245`) exceeds the
remainder on ≤360dp; `scaleTextStyles` scales font but not width.
**Fix:** label container `{flex:1, minWidth:0}`, `statText` `flexShrink:1`, `numberOfLines={2}`
(wrap, don't truncate). Verify at fontScale 1.3 + 320dp.
**Test:** style-shape unit test; device pass in phase sign-off.

### Item 17 (rename half) — "Departmental" header → "Channels"

**Current:** `DepartmentalHomeScreen.tsx:133-143` title "Departmental"; **and `{orgName} ·
Department` appears TWICE below it — `:171` and `:176`** (the non-hub fallback branch; edge N9 +
critic m-1) — renaming only the title leaves "Channels" above "Acme · Department".
**Fix:** title "Channels"; BOTH subtitles reworded in the same sweep; update any test/a11y label
asserting the old title. **Test = a source scan for the string's absence**, not a render
assertion on one branch (a render test only exercises whichever branch the fixture takes).
Hide-half is P6.

---

## 3. Phase P2 — invite flow

### Item 2 — hierarchical team picker + path-correct placement

**Current client:** `InviteMemberScreen.tsx:61-64` fetches `listManagedChannels()`, renders a
flat radio list (`:245-260`); `parent_id`/`level` fetched, ignored. Payload (`:137-144`) already
carries `team_channel_id`.
**Current server:** `createMemberInvite` (`enterprise-join.service.ts:711-835`) validates via
`assertMintableTeam` (`:112-128`). On accept, `seedApprovedMemberChannels` (`:1228-1285`)
deliberately ignores the chosen team and seeds EVERY eligible channel (docstring `:1218-1227`).

**Fix — client (two-stage tree, per mock):**

1. Stage 1 "ORGANISATION THEY JOIN": organisation rows from the **shared grouping helper**
   (see below), chevrons. **Empty state (edge P2-3):** "No organisations yet — invite with no
   specific team, or create channels first" + CTA to the create dashboard.
2. Stage 2 "TEAM THEY JOIN": selected org pinned + selectable; children expand/collapse with
   connector lines; radio at any node. Breadcrumb (SASFA → RSA → Fort Hunter) on the confirm
   card — path derived from `parent_id` ancestry, no new wire field.
3. Escape hatch relabelled **"Whole workspace (all organisations)"** (edge P2-5 — org-wide seed
   becomes a cross-organisation grant once multiple roots exist; copy must say so). Contract
   unchanged. **The same state has a second copy (edge N8):** `ApprovalsScreen.tsx:239` renders
   the admin's read-back as `'No specific team'` — export ONE constant from the helper module
   and consume it at both sites, or the admin picks "Whole workspace" and Approvals calls it
   "No specific team". (Verified: no test pins either string, so the relabel is test-safe.)
4. **Branch-scoped managers — the server must SAY which nodes are mintable (round-5 critic
   MAJOR-2; this is a P2 blocker if skipped).** The intent is to grey out nodes the minter
   cannot mint into. **The client has no way to compute that today:** `/auth/me` does not carry
   `org_members.department` (verified field-by-field, `api.ts:294-333`), `ManagedChannelDto`
   carries the channel's department but nothing about the caller (`:1919-1938`), and
   `listOrgChannels(orgUserId)` is not branch-filtered. Today the rule surfaces only
   post-submit, as the mapped `team_channel_outside_your_branch` alert
   (`InviteMemberScreen.tsx:152`). And the obvious shortcut is banned by §7's own rule
   (`/auth/me` NOT touched — the B-394 field-parity trap).
   **Decision: emit a per-row `mintable_by_me boolean` from `listOrgChannels`.**
   `OrgManagerGuard` resolves `req.orgManager.department` on every path — `null` for an
   unscoped owner or company account (`org-manager.guard.ts:77`, `:113`) and the scoped value
   on the delegated-manager path (`:118-131`). A null manager department means every row is
   mintable, mirroring the existing null short-circuit at `:743`.
   **Definition (round-6 MAJOR — three statements disagreed before this).** `mintable_by_me` is
   the FULL server refusal, branch rule included: org match, not archived, not
   `seedsManagersOnly`, and the branch comparison. **One exported helper computes it, consumed
   by BOTH `createMemberInvite:743` and the `listOrgChannels` projection**, with a source-scan
   test banning a second copy — "the two can never drift" has to be secured by a shared symbol,
   not asserted, because two expressions in two files is this repo's most-shipped bug class.
   Item 7 changes that predicate, so **the helper and item 7's relaxation land in one commit**.
   **Scope the claim to per-ROW refusals (round-6 G10):** `mintable_by_me` cannot express
   `scoped_manager_cannot_grant_admin` (`:738-740`), which refuses ANY manager-role invite from
   a scoped minter regardless of row — a spec saying it "matches the server's own refusal on
   every row" is unsatisfiable, and with role=manager selected every row would flag mintable
   and every submit would 403. The field means "mintable for an EMPLOYEE invite"; the client
   greys by role separately.
   **The client's rule is `disabled = mintable_by_me === false || c.is_broadcast`** — the
   broadcast exclusion is the ONE thing the server does not encode (`assertMintableTeam` has no
   `is_broadcast` guard, and a `#broadcast` row is `access:'standard'`, `type:'board'`,
   `department NULL` per `department.service.ts:638`, so post-relaxation the server would
   consider it mintable). Absent field → **not** greyed, i.e. today's behaviour; the precedent
   is `manageable?: boolean` (`api.ts:1906-1910`). Server-first, and the spec asserts the
   EMITTED value on a fixture — `listOrgChannels:902` returns through the same inferred
   `db.q<T>` cast, so an unemitted field typechecks clean and reads `undefined` on every row.
   The post-submit refusal remains the real boundary.
5. **`params.channelId` pre-select survives (edge P2-6):** pre-select + auto-expand that node in
   stage 2; keep the drop-if-unmintable guard (`:66-70`).

**The shared organisation-grouping helper (critic F2 + F11 — a P2 deliverable P3 consumes).**
Rev 3 makes its contract explicit, because round 2 proved a single unparameterised rule produces
a _different and wrong_ tree at each of its two call sites:

```ts
organisationRootsOf(channels, opts?: {collapseChildless?: boolean})  // default false = admin shape
```

- **Server change first — surface the fact instead of inferring it (critic M-1).** `listChannels`
  already computes parent visibility: `department.service.ts:193-196` emits
  `CASE WHEN EXISTS(member of parent) THEN c.parent_id ELSE NULL END`. Add **TWO** fields to
  that DTO:
  - `parent_hidden boolean` — `c.parent_id IS NOT NULL AND NOT EXISTS(...)`.
  - `visible_ancestor_id uuid | null` — the nearest ancestor the CALLER IS A MEMBER OF, bounded
    ≤3 hops (the same bound the accept-time walk uses). **Required, not optional (round-3
    BLOCKER-1):** `parent_hidden` alone says a hidden parent exists but not _which_ visible root
    the row belongs under, and nothing else in the row can disambiguate — `org_id` is the
    workspace tenant, identical for SASFA/CORTAC/GSSG. Without it the "nest the orphan under its
    nearest visible ancestor" rule below only works in a single-root workspace, and multi-root
    is the entire premise of items 2/6/8. No new disclosure: the caller is a member of that
    ancestor by construction.
    Then a root is simply **`!parent_id && !parent_hidden && !is_broadcast`** — no level
    arithmetic; nesting keys on `visible_ancestor_id`; "Other channels" fires only when it is null.
    Rev 3's `level <= 1` guard was a proxy that **does not hold**: a member of a level-1 Main who
    is not a member of its level-0 root receives `level:1, parent_id:null` and would pass it,
    rendering every Main channel as a separate "organisation" — the flat pile items 2/6 exist to
    kill. This is not a new disclosure (it reveals strictly less than the "path rung" below, and
    BUILD_STATUS classes depth projection as a rendering defect, not a leak).
- **No source/authority mode is needed at all (round-3 MINOR-6).** With the two fields on the
  row the rule is mode-free. `listOrgChannels` (`:902-913`, the admin source) simply does not
  emit them, and **absent reads as false** — which is correct, since it returns true `parent_id`
  for every row. Rev 3's `authority:'admin'|'member'` and Rev 4's `parentIds` both dissolve.
  This also removes the trap edge round-3 #8 identified: an org admin browsing the MEMBER
  directory is still projected (`listChannels` masks for everyone, membership-only, no admin
  bypass — `:225-227`), and a viewer-shaped param invited passing `'admin'` there.
  **Keep the test case anyway: admin user + `listChannels` fixture → still projected.**
- **An admin legitimately sees two different trees** — the directory shows channels they belong
  to; the manage dashboard shows the whole org. Say so in the code comment, or someone will
  "fix" it.
- **`collapseChildless` is for MEMBER surfaces only (edge N6):** "parentless leaf renders as a
  chat row" is a member-directory affordance. Admin surfaces pass `false` — otherwise a freshly
  created organisation (childless by definition) is not an organisation, never appears in the
  admin org-select, and the admin can never drill in to add its first child: the create flow
  dead-ends on its first use.
- **Group first, disable second (edge N2):** the mintable exclusions (`archived`, `restricted`,
  `incident`, `is_broadcast` — today `InviteMemberScreen.tsx:62-64`) are applied AFTER grouping,
  as a disabled/greyed state — never as a pre-filter. Filtering first deletes a Restricted org
  root and promotes its country children to stage-1 "organisations" (RSA, Kenya as peers of
  SASFA) — reproducing exactly the flat mess item 2 exists to fix, from the plan's own rule.
- One module, exported; P3's directory and admin dashboard import it. Duplicate-copy regression
  test = a source scan for a second copy of the grouping formula — **but the real gate is a
  round-trip property test (critic M-3)**: for any admin fixture `rows` and visible subset `S`,
  `organisationRootsOf(rows) ∩ S` must equal `organisationRootsOf(project(rows, S))`, where
  `project` applies the `:193-196` masking AND fills the two new fields. This is the gate that
  catches the admin and member views diverging.
- **The fields can be added and never emitted, silently (round-3 MINOR-8):** `listChannels`
  fills `ChannelSummary` through a raw `db.q<T>` cast (`:164`), so adding `parent_hidden` /
  `visible_ancestor_id` to the interface WITHOUT the SQL columns typechecks clean and yields
  `undefined` on every row. **The server spec must assert the EMITTED value on a fixture**, not
  the type.
- **Compat — server-first for these fields (round-3 MINOR-7):** new app + old server → both
  absent → falsy → every projected orphan would render as an organisation (the flat pile items
  2/6 exist to kill). Client fallback: a row with null `parent_id` and no `parent_hidden` field
  present at all routes to "Other channels", never to the root list.

**Fix — server (behaviour change):** invite carries `team_channel_id` → accept-time seeding is
path-scoped: (a) ancestor chain root→selected, (b) selected channel's subtree, (c) `#broadcast`
channels **only where the broadcast's own ancestor chain lies inside the seeded set** (edge
P2-4 — a level's broadcast can be parented under a different main; never seed a broadcast the
member can't see the parent of). No team → today's org-wide seed. Same rule in join-request
`approve()`. Managers-only skip (`:1262`) and `addMember`-only writes (rekey intents) stay.
**Accept-time fallback (edge P2-1; direction from N5; mechanics rebuilt by critic M-2 + edge
round-3 #9–#12).** Team archived or missing at accept → seed the **nearest surviving ancestor's
CHAIN**, not org-wide. Org-wide only when the invite carried no team at all. Reason: a scoped
manager's invite is bound to their branch at mint (`enterprise-join.service.ts:741-746`) but
accept re-checks only that the minter is still an active manager (`:1103-1111`) — so
"archived team → org-wide" turns an ordinary admin archive into a silent promotion of a scoped
grant into a full cross-branch one. Six mechanics the review rounds forced:

1. **"Surviving" is defined** as `archived_at IS NULL` **AND** not `seedsManagersOnly`
   (`department.service.ts:483-485`). Without the second clause the walk stops at a restricted
   ancestor, the seed loop then `continue`s past it (`:1263`) with no error and no log, and the
   employee lands in the zero-channel workspace this rule exists to prevent (edge #12). The walk
   **keeps climbing** past managers-only rungs; it does not discover them at seed time.
2. **Chain only, never the ancestor's subtree** (edge #11). Substituting the ancestor as
   "selected" would seed its whole subtree — Fort Hunter archived under RSA would grant Fort
   Bravo and Fort Charlie, teams the invite never expressed. Same direction as the over-grant
   N5 killed, just smaller.
3. **Resolve the ancestor INSIDE the transaction, BEFORE the claim UPDATE** (edge #9 — this is
   the finding that makes the rule implementable at all). Today the claim UPDATE
   (`:1139-1145`), `grantMembership` (`:1170`) and COMMIT (`:1173`) all precede
   `seedApprovedMemberChannels(...).catch(warn)` (`:1177-1181`), which the file itself documents
   as best-effort — _"EVERYTHING AFTER THE COMMIT IS BEST-EFFORT"_ (`:578-593`). A throw there
   does **not** fail the accept: the client gets 200, the member sits in the org with zero
   channels, and `accepted_at` is set so the link is not re-claimable. Resolving pre-claim uses
   the rollback property the file already documents at `:1167-1168` ("the claim reopens and the
   invite survives").
4. **A hard-deleted team never reaches this rule** (edge #10) — `team_channel_id` is
   `ON DELETE SET NULL` (`20260803030000_enterprise_join_requests.sql:71`) and deleting a leaf
   is permitted (`ON DELETE RESTRICT` guards parents only), so at accept it is byte-identical to
   "minted with no team" → routed to org-wide: the scoped→cross-branch promotion arriving through
   the delete door. **Persist a non-FK breadcrumb at mint** (`team_parent_id`) so the chain is
   still resolvable. (`team_department` cannot serve — it is a LEFT-JOIN alias, itself
   archive-gated to NULL at `:1074`.)
5. **Walk mechanics:** `parent_id` is `ON DELETE RESTRICT`, archive is a soft `archived_at`, so
   every ancestor row is always present and the chain is always resolvable in-tx. Depth is
   `CHECK (level BETWEEN 0 AND 3)`, so specify a **bounded ≤3-hop parent walk** — no
   `WITH RECURSIVE` exists anywhere in this repo, and an implementer reaching for one would be
   inventing a precedent.
6. **Rewrite the docstring in the same commit** (critic M-2): `:1208-1227` currently reads
   _"TAKES NO `teamChannelId`, deliberately — do not 'restore' one. It used to, and the
   parameter was DEAD."_ This phase makes it live again; leave that text standing and the next
   reviewer reverts the feature as a regression.
7. **The TRIGGER must be the survival predicate, not "archived or missing" (edge round-4 G5).**
   `configureChannel` can tighten a team to `restricted` AFTER the invite is minted
   (`department.service.ts:752`+); `assertMintableTeam` only checks at mint. So at accept the
   team is neither archived nor missing, the fallback never fires, and the seed loop `continue`s
   past the now-restricted team — the member gets ancestors but not their actual team. If the
   invited team WAS the organisation root, the chain is `[root]` alone → **zero channels seeded,
   HTTP 200, `accepted_at` set, link unclaimable**: exactly the state mechanic 3 exists to
   prevent, reached with no DB error at all. Trigger = `archived OR missing OR seedsManagersOnly`.
8. **Seed-pending flag, set INSIDE the transaction and cleared on success (round-5 E7/E8).**
   Rev 6 said "zero rows seeded → warn + repairable marker". Two defects:
   - **Zero rows is the NORMAL, correct outcome for the first employee of a clean
     organisation** (E7) — items 5+12 make new workspaces seed ZERO channels, so
     `seedApprovedMemberChannels` legitimately has nothing to loop over. As written every such
     accept would warn, and an implementer who fuses this bullet with the "refuse the accept"
     line four lines below would **refuse the very first employee of every new organisation** —
     the flagship item-8 flow. The real assertion is "zero seeded **while eligible candidates
     existed**" (the loop already knows the candidate count). No-team + no-channels is success.
   - **A marker written post-commit is swallowed by the very `.catch` it compensates for**
     (E8) — that block is contractually best-effort (`:1176-1181`). So set a nullable
     `seed_pending_at` inside the transaction and have the seeder CLEAR it on success, which
     inverts the failure mode: silence leaves the flag set instead of losing the signal.
   - **The column goes on `enterprise_join_requests`, NOT `enterprise_referral_links`
     (round-6 G7).** There are TWO seeding lanes: `acceptInvite:1179` (whose tx claims the link)
     and `decideJoinRequest:592` (whose tx claims the join request and never touches the link).
     The join-request link is an OPEN multi-use row serving N applicants and is never claimed
     (`submitJoinRequest:290-298` resolves it with `invited_phone IS NULL`), so a flag there
     would be per-link rather than per-person and racy across concurrent approvals — and the
     approval lane is the one whose seeding failure the file documents most loudly
     (`:578-593`). Both lanes already write the join-request row inside their own transaction
     (`acceptInvite` inserts or updates it at `:1150-1166`), so ONE column covers both.
   - **Define "success" against a loop that swallows its own failures (round-6 G8).**
     `seedApprovedMemberChannels:1276-1284` catches every per-channel `addMember` failure, warns,
     and continues, then returns normally — so a naive "clear at the end" clears the flag when 4
     of 5 channels failed, i.e. exactly the partial-seed state the marker exists to record.
     Success = **zero per-channel failures AND at least one row seeded when eligible candidates
     existed**; the loop already has both counters. **Stamp it on BOTH accept arms** — the
     UPDATE-to-`approved` at `:1150-1156` and the INSERT at `:1157-1164` — and since
     `seedApprovedMemberChannels` receives no request id, the seeder clears on
     `(org_user_id, applicant_user_id, status='approved')`.
   - **Name a reader that can actually see it.** Not the Approvals surface (it lists PENDING
     requests, and these are settled) and not `listMemberInvites` (`LIMIT 100`, ordered
     open-first at `:903-905`, so settled rows fall off first in any busy org). A small
     manager-facing repair endpoint keyed on the flag. An unread column is the same silence in
     a new place — the trap this bullet exists to avoid.
     Whole chain unusable → refuse the accept (pre-claim, so the invite survives) with a re-invite
     message. Never land the member in a zero-channel workspace silently.
     **Probed and settled — do not re-open (edge round-4):** the pre-claim walk adds no lock-hold
     time (the claim UPDATE at `:1133-1145` is the tx's first write; no advisory lock or `FOR UPDATE`
     precedes it), and concurrent accepts by one user still serialize on
     `org_members_one_active_agency` → 23505 → rollback → claim reopens (`:1167-1168`).
     **Path-scoped seeding manufactures orphans as its NORMAL outcome (edge N4).** The managers-only
     skip stays (`seedApprovedMemberChannels:1262`), so a path like SASFA → RSA(restricted) → Fort
     Hunter seeds root + leaf and skips the middle; `listChannels:193-196` then NULLs the leaf's
     parent. On first launch the invited member would see the organisation as an empty childless row
     with their actual team dumped in "Other channels" — the hierarchy the invite just established,
     invisible on the one screen item 2 is about. **Fix:** with `parent_hidden` on the DTO the tree
     nests the projected orphan under its nearest VISIBLE ancestor (`visible_ancestor_id`) and
     renders one non-tappable placeholder rung between them. **Label it neutrally — "(not shown)",
     never "(restricted)"** (edge round-3 #13). **Record the REAL reason (edge round-4, probed):**
     not "archived vs restricted are indistinguishable" — an archived middle rung is actually
     unreachable (`archiveChannel` refuses on any active non-broadcast child; `createChannel` rejects
     an archived parent; `unarchiveChannel` mirrors the guard at `:858-865`). The real reason is that
     the rung may simply be one **this member was never seeded into**, which is not a statement about
     access at all. Write that down or the next reviewer "corrects" the label back.
     **Precedence when there is NO visible ancestor — make the RENDERING rule total (G4, corrected by
     round-5 E5/E6).** Three-way, not two:
     **ONE TOTAL SWITCH, FIVE CASES (round-6 G3, corrected by round-7 MAJOR-1).** Earlier revisions
     wrote this as a three-row table plus a precedence sentence; that still misfired, because
     "every row the root rule rejected" swallows ordinary children (whose `visible_ancestor_id` IS
     their `parent_id`, so they'd render with a spurious "(not shown)" rung under every normal
     parent) and broadcasts. Evaluate in order:
     | # | row shape | renders as |
     |---|---|---|
     | 1 | `is_broadcast` | today's broadcast treatment — never enters this switch |
     | 2 | `parent_id` present (visible) | nested normally under it, **no rung** |
     | 3 | `!parent_id && !parent_hidden` | an ORGANISATION (or, under `collapseChildless`, a chat row) |
     | 4 | `parent_hidden` **and** `visible_ancestor_id` non-null | nested under that ancestor, one "(not shown)" rung between |
     | 5 | `parent_hidden` **and** no visible ancestor | grouped under a **synthetic non-tappable header**, keyed by `root_id` (below) |
     "Other channels" is case 5's header when more than one `root_id` is present — there is no sixth
     state.
     **`listOrgChannels` must emit the fields explicitly (round-7 MAJOR-1b):** `FALSE AS
parent_hidden, NULL::uuid AS visible_ancestor_id` (`:902-913` returns raw `c.parent_id` and
     neither field today). Without that, the admin source's genuine roots are `parent_id` null with
     the field ABSENT, and the compat fallback below — "absent → Other channels, never the root
     list" — would empty the admin organisation list and dead-end item 8's create flow on first use
     (N6 re-entered by another door). With the explicit emission, **absent** means only "old
     server", which is what the fallback is for.

**The synthetic header needs its own grouping key (round-6 G5).** Rows in that middle branch
have `visible_ancestor_id` null by definition, so they carry no discriminator — and a member
holding channels under two different hidden roots would get them merged under ONE header,
asserting a parent relationship that is false. That is worse than the bucket it replaced, and
it is reachable today via item 8's per-node "Add Members", which places a member under a node
without seeding its ancestors. **So emit `root_id uuid` (the topmost ancestor's id, regardless
of visibility) on the same DTO** and group by it. An opaque id discloses nothing renderable —
the member already knows a hidden root exists from `parent_hidden` — and it is what makes the
header honest. Label it generically ("Other organisations" when more than one key is present).
Making the rendering total is what actually closes the class (E6): a restricted root is only ONE
producer of the zero-organisations state — an `incident`-type root, a legacy pre-guard root, and
the edit path below all reach it too, because `seedsManagersOnly` is
`restricted || channel_type === 'incident'` (`department.service.ts:481-485`) and both the P2
walk and the seed loop deliberately climb past such rungs.
**Also guard the producer, on the SERVER, on BOTH verbs (E5) — but NOT on `parent_id IS NULL`
alone (round-6 G6).** Every channel in every EXISTING workspace is parentless: `seedOrgWorkspace`'s
INSERT names no `parent_id` (`department.service.ts:440-445`), so all four seeded rows are
parentless level-1, as §4 itself notes. A bare `parent_id IS NULL` predicate would forbid
Restricted on all of them and on every top-level channel an admin has ever made — including
_tightening_ an existing one, which is today's only route to a managers-only channel — and
since re-parenting is refused by the trigger, those channels could never become managers-only
again. The harm E5 names requires the row to HAVE children; a childless top-level channel
orphans nobody. **Predicate: `parent_id IS NULL AND EXISTS (active non-broadcast child)`**
(workspace tenant), in `createChannel` **and** `configureChannel`. Reuse `archiveChannel`'s
existing child-count query — it is byte-for-byte the same shape
(`parent_id = $1 AND archived_at IS NULL AND NOT is_broadcast`), and writing a second copy is
the duplicate-copy class. **Bounded residue, recorded:** `createChannel` has no
restricted-PARENT guard, so _childless root → set Restricted → add a child_ still reaches E5's
shape in two steps; the now-total rendering switch (case 5) is what contains it. And
hide/disable the Restricted card when the parent row reads "Top level". A create-only guard
leaves a worse back door than the case it fixes: tightening standard→restricted on an existing
root runs `removeMember` with rekey intents for every non-manager
(`department.service.ts:679-706`), so two taps in the editor retroactively strip the whole
workforce out of the root and give every one of them a directory with no organisations in it.
**One prerequisite for the configure-side half (round-6 MINOR):** `configureChannel:660` reads
its row via `assertManagesChannel:917-928`, whose SELECT returns `org_id, channel_type, access,
name, post_mode, is_broadcast` — **no `parent_id`**, so it cannot tell a root from a child.
Add `parent_id` to that shared helper's SELECT (additive) and read it from `current`.
**Two SQL lines to pin (round-5 probe, split by round-7):** the `visible_ancestor_id` walk
carries `archived_at IS NULL`, matching the row list — an archived ancestor would be a dangling
pointer and the orphan would vanish entirely (neither root, nor nested, nor bucketed).
Unreachable today thanks to the archive guards, so a spec line rather than a live defect.
**The `root_id` walk must NOT carry that filter** — `root_id` is the topmost ancestor
_regardless of visibility_, and archive-filtering it would null the grouping key for exactly the
rows case 5 exists to group.
**Known residue (accepted, documented):** the minter-still-active check
(`enterprise-join.service.ts:1101-1111`) does not re-check a still-active manager's _changed_
branch scope — pre-existing; path-scoped seeding amplifies it slightly; logged as a follow-up,
not fixed here.
**Role placement:** already correct (`invited_role` employee/manager); labels only.

**Branch scope: P2 changes NOTHING here.** The rule stays exactly as it is today — the manager's
`org_members.department` compared by string equality against the channel's, at
`enterprise-join.service.ts:743-745`. **See §4 item 7 for what P3 does to it** (short version:
neither side of the comparison moves; a channel with no branch simply becomes mintable by any
manager, matching the four `COALESCE(…, $n) = $n` predicates already in that file). Three
designs were proposed across review rounds and all three were withdrawn — an ancestor-chain
rebase, a manager-side picker, and a server-derived channel department. §4 item 7 records why
each died; do not re-propose them from here.
**Tests:** helper unit tests — the round-trip property test, **admin user + projected fixture**,
parentless leaf vs projected orphan, orphan nested by `visible_ancestor_id` vs "Other channels"
when it is null, disabled-not-filtered restricted root, childless fresh organisation visible to
admin; tree render; server spec — `parent_hidden` + `visible_ancestor_id` EMISSION on a fixture,
path-scoped seed (leaf → path + subtree + in-set broadcasts, NOT sibling fort), no-team
unchanged, archived-team → nearest surviving ancestor CHAIN, managers-only ancestor skipped
while climbing, deleted-team breadcrumb, whole-chain-dead → pre-claim refusal with the invite
still claimable; `mintable_by_me` emission (see item 4 — optional field, absent means not
greyed, assert the EMITTED value on a fixture); mutation-prove the scoping.
**Existing tests this phase must RE-ANCHOR, not delete (edge N7):**
`src/screens/deptchat/__tests__/approvalsMintTeam.test.tsx:126-171` drives
`findByLabelText('Join team {name}')` in four tests — including the archived/broadcast/
restricted/incident ABSENCE test, which anchors first on a positive `Join team TEAM_A`; if
TEAM_A is no longer reachable in stage 1 the positive anchor fails and the four absence
assertions silently never run. Keep `Join team {name}` as the leaf a11y label.
`src/screens/deptchat/__tests__/joinApprovalFlow.test.ts:302` source-scans
`InviteMemberScreen.tsx` for the literal `c.access !== 'restricted' && c.channel_type !==
'incident'` — the exact expression this phase moves into the helper; re-point the scan at the
helper module AND assert `InviteMemberScreen` imports it. CLAUDE.md forbids deleting either.
**Compat:** old app + new server → flat pick is a valid `team_channel_id`, gets path-scoped
seeding (closer to admin intent — acceptable). New app + old server → org-wide seed (degrade).

### Item 3 — keyboard never covers the form

**Current (corrected per critic F8):** `InviteMemberScreen.tsx:37-40` already uses the blessed
`useKeyboardLayout().overlap` — no banned pattern. The actual defects: no pinned CTA and no
scroll-into-view; the ROLE radios + branch field + CTA sit at the bottom of a plain `ScrollView`
(`:181-184`) and get covered.
**Fix:** adopt `KeyboardAvoidingScreen` (`src/components/KeyboardAvoidingScreen.tsx:52-78`) —
body scrolls, CTA in the `footer` slot; scroll-into-view on focus for the branch-scope input.
**Shell-awareness — teach the helper ONCE (critic F8, tightened by m-11):** the screen currently
re-implements the hook's own `bottomPad` locally (`const bottomPad = (gap = 0) => (overlap > 0 ?
overlap : restBottom) + gap`), zeroing the resting inset inside the Departmental shell because
the tab bar reserves it. Reproducing that local copy in the footer slot would be the
duplicate-copy class again. Teach `KeyboardAvoidingScreen` about the Departmental shell once,
and have the screen consume the hook's `bottomPad`/`safeBottom`.
**Note:** B-277 (frozen 5dp IME on some edge-to-edge devices) is a platform issue to verify on
the device matrix, not a reason to hand-roll listeners.
**Tests:** `keyboardContract` scan stays green; render test (CTA in footer slot).

---

## 4. Phase P3 — channel structure (5, 12, 6, 8, 7 — subsections are in build order)

**Tenant rule (critic F3, governs the whole phase):** every behaviour change in P3 is
**workspace-tenant-gated**. **For the SEEDING half no DB lookup is needed (critic m-6):**
`seedOrgWorkspace` already takes `tenant: 'agency' | 'workspace'`
(`department.service.ts:419-421`; `workspace.service.ts:136` passes `'workspace'`,
`agent.service.ts:2227` defaults agency) — just empty the workspace arm. Reserve the
`org_id IN org_workspaces` discriminator for `createChannel`, archive, and the delete trigger. The agency tenant keeps today's
directory, seeding (`agent.service.ts:2227` — the second `seedOrgWorkspace` caller, agency set
`department.service.ts:396-403`), broadcast protections, and editor. **The level-0 `ensureBroadcastForLevel` trap is latent today and P3 turns it live (critic
m-5):** nothing writes `level = 0` yet, so `:631`'s existence check cannot currently mismatch —
but the INSERT at `:636-641` never states `level` and leans on the trigger, so a level-0 caller
inserts a row that lands at level 1, collides with `dept_channels_one_broadcast_per_level`, is
swallowed by `ON CONFLICT DO NOTHING`, and no-ops forever. **It REMAINS latent (round-3
MINOR-9 corrects Rev 4's claim):** the workspace arm drops the auto-broadcast entirely and the
agency arm has no `root:true` producer, so no level-0 caller exists after P3 either. Keep the
guard spec anyway — pin it so a future level-0 caller cannot regress into it. Add an agency-tenant render regression to the test list.
**Tenant-gate soundness (edge P3-5):** the discriminator is sound only if one `users.id` cannot
be both tenants — an agency company account cannot create a workspace
(`workspace.service.ts:81-85`); **verify the reverse** (a workspace owner minted as a company
agent via `POST /agents`) and add the refusal if missing, BEFORE keying behaviour on
`org_workspaces`.

### Items 5 + 12 — no default channels, at any level

**Current:** `seedOrgWorkspace` (`department.service.ts:419-456`) seeds
`WORKSPACE_DEFAULT_CHANNELS` (`:410-417`) + level-1 `#broadcast` (`:454`) on workspace create
(`workspace.service.ts:134-139`). Every `createChannel` auto-creates that level's `#broadcast`
(`:603` → `ensureBroadcastForLevel :624-653`).
**Fix (workspace tenant only):**

- Workspace create seeds **zero** channels (idempotency guard stays; agency arm untouched).
- Drop the auto-`#broadcast` on `createChannel`.
- Existing workspaces: channels left in place; `#broadcast` becomes archivable/deletable for
  workspace tenants — relax `dept_channel_block_broadcast_delete_trg`
  (`20260803020000:70-83`, citation corrected per critic F14) and the archive guard
  (`department.service.ts:806`; `deleteChannel` has no service-side guard — trigger is the
  boundary, verified) with an `org_workspaces` tenant check. **Supersedes the locked scope-v1
  "non-deletable #broadcast" rule — the vs2 PDF crosses those channels out; record the
  supersession in the FIT doc.**
- **One deploy unit (edge P3-4):** the trigger/archive relax and the create-gate land in ONE
  migration+deploy — shipping the relax first lets `ensureBroadcastForLevel` resurrect a
  freshly-archived broadcast on the next same-level create (`:629-643`; the `:866-871` 23505
  comment documents the loop). Spec: archive broadcast → create channel at that level → no new
  broadcast (workspace tenant).
- Client: announce card dies in P1; update the five-channel comment at
  `DepartmentChannelsScreen.tsx:389-393`. **New-app/old-server:** don't promise "starts clean"
  in client copy until the server is live (server-first deploy covers order; copy stays
  neutral).
  **Tests:** workspace-create seeds 0; agency-create seeds agency set (pin); workspace
  createChannel → no broadcast sibling; no-resurrect spec; migration spec on the tenant gate.
  **Two existing specs go RED and must be RE-ANCHORED, never deleted (round-3 MAJOR-4 — the same
  class §3 handles as N7):** `apps/auth-service/src/department/channelAccessInvariants.spec.ts:262-266`
  and `department.broadcastBackfill.spec.ts:180-193` both assert `ensureBroadcastForLevel` is
  called from BOTH `createChannel` and `seedOrgWorkspace`. Re-anchor each to the AGENCY arm —
  assert the call survives on the agency path and is tenant-gated off the workspace path.

### Items 6 + 8 — organisation-first directory + Create Channels dashboard

**Current:** `DepartmentChannelsScreen.tsx:649-669` flat per-level sections; cog is the only
management route (`:535-538`); `ManageChannelsScreen` flat-indented list → editor/members (all
endpoints exist, `department.controller.ts:89-196`).
**Model:** "organisation" (channels sense) = per the **shared P2 helper** (§3). Refinements
(critic F2 + edge P3-1/P3-2, corrected by N6 and critic M-1):

- **Root rule:** `!parent_id && !parent_hidden && !is_broadcast` — the server-emitted
  `parent_hidden` flag, not level arithmetic, is what separates a real root from a projected
  orphan (see §3).
- **Placement of a projected orphan — build it from §3's THREE-way table and its precedence
  rule (round-6 G4; the earlier two-way text here was superseded and would have dropped the
  synthetic-header branch entirely).** Summary: the root rule claims its rows first; then
  `visible_ancestor_id` non-null → nested with a "(not shown)" rung; null but `parent_hidden`
  true → synthetic header grouped by `root_id`; null and not hidden → "Other channels". §3 is
  the single source for this — do not restate the branches here, point at it.
- **Progressive rule — MEMBER surfaces only:** a root WITH visible children → organisation row
  (drill-in); a parentless LEAF → plain chat row (legacy flat workspaces keep one-tap chats —
  no five-"organisations" regression). **Do not cite `DepartmentChannelsScreen.tsx:638-648` as
  precedent (critic m-3)** — that comment describes a `hasHierarchy` guard the code does not
  implement (`:649` maps `LEVELS` unconditionally; BUILD_STATUS §5 already lists it as stale
  doc drift). The progressive rule stands on its own merits. **Admin surfaces never collapse**
  — a childless
  organisation is still an organisation, or the create flow dead-ends on its first use (N6).
- **Is an organisation root postable? (§10.8)** A root carries its own group, so tapping one as
  a chat row is structurally valid — but `post_mode` defaults `'read_only'`, so `memberRoleFor`
  gives members `viewer` (`department.service.ts:505-506, 560`): they would open an empty
  un-postable thread. **Build assumption pending the answer: roots are STRUCTURAL ONLY** (tap =
  drill in, never chat) — screen 2's "chat rows → `DepartmentChat`" applies to non-root nodes.
  Stated so the screen is buildable before §10.8 comes back.
- `#broadcast` rows are never organisations and never invite-pickable (the client-side mintable
  filter carries into the helper).
- **Orphan bucket (edge P3-2):** the table's third row only — rendered below the organisation
  list, so a member whose channels are all mid-tree (the M8 projection gap) never sees an empty
  directory.
- **Member empty-state copy (edge P3-3):** reword the false "Ops console" line (`:616`) →
  "Your organisation admin hasn't created channels yet."
- New roots: "+ Create new organisation" → server `root: true` → INSERT level 0 (**verified
  DB-feasible by critic** — the trigger accepts parentless level 0, `20260803010000:128-136`;
  DTO gains an optional boolean, not a raw level). **`restricted` is REFUSED on a root** (§3
  G4): a root nobody can see gives every member `parent_hidden` Mains with no visible ancestor,
  i.e. zero organisations in their directory. Item 7's ACCESS tri-state carries the same
  exception — Standard / Read only only when the parent row reads "Top level" — and the server
  enforces it (a client-only rule would be reachable by editing a root to restricted afterwards,
  so the refusal lives in `createChannel` AND `configureChannel`).
- **Depth asymmetry recorded (critic F6):** existing workspaces' organisations are level-1
  roots → their trees top out at Org→Main→Sub (3 usable tiers) while fresh level-0 orgs get 4;
  re-parenting is hard-blocked (`channel_reparenting_not_supported`, `20260803010000:124-126`).
  Founder question §10.6: accept, or scope a re-level migration (with the trigger's prescribed
  recursive re-derivation) as follow-up. Tree labels must be RELATIVE to the root
  (`LEVEL_NOUN` at `ManageChannelsScreen.tsx:174` indexes absolute level — fix in the redesign).
  **Screens (workspace tenant; agency keeps current):**

1. `DepartmentChannelsScreen` (in `src/screens/messenger/`): stats row stays; body =
   organisation list (aggregate unread summed client-side via the reducer at `:244-247`,
   consumed `:630`) + parentless-leaf chat rows + "Other channels" bucket + admin-only blue
   `Manage Channels` button; cog secondary.
2. New `OrgChannelTreeScreen` ("SASFA Channels"): expandable membership-filtered tree,
   connector lines; chat rows → `DepartmentChat`. Pure re-grouping of `listChannels` data — no
   new exposure.
3. `ManageChannelsScreen` → **Create Channels** (`collapseChildless: false` — childless
   organisations listed, unmintable nodes disabled not hidden): org select + "+ Create new organisation" →
   per-org admin tree (incl. restricted/archived from `listManagedChannels`); per-node ⋮ →
   Edit / Add Members (role assign) / Archive / Delete; "+ Create lateral channel" under
   operational nodes; "+ Create channel" at org scope — both push the simplified editor with
   the parent param. "Lateral" = create-with-same-parent shortcut, no new semantics. Hide
   create on nodes at the depth cap (`max_channel_depth_reached` is the server boundary).
   **Tests:** helper reuse scan (no second grouping copy); render tests ×3 (incl. legacy-flat
   workspace fixture and agency-tenant regression); nav param tests; server `root: true` spec;
   `deptChannelNoCallAffordance` stays green; M8 orphan-bucket test.
   **Messenger gate applies.**

### Item 7 — simplify the New Channel form (LAST — same commit as item 8)

**Current:** `ChannelEditorScreen.tsx` — NAME (`e.g. Operations`), DEPARTMENT (`e.g. Intel`),
PARENT radio list, TYPE segment, ACCESS radios (`:216-298`); ACCESS→`(access, post_mode)` pairs
(`:46-56`, non-injective resolution `:78-86` — do not touch, it fixed a silent privilege
escalation).
**Fix:** create form = NAME (`Name of channel`) → read-only parent row ("Top level" / "Under
{parent}", parent arrives as a route param from the tree) → ACCESS (same tri-state mapping).
DEPARTMENT and TYPE leave the FORM; `channel_type` defaults `'department'`.
**`department` leaves the FORM and NEITHER side of the comparison moves (critic B-1 → round-4
BLOCKER-1 → round-5 E1–E4).** The history matters, because two plausible designs were tried and
withdrawn and neither should be re-proposed:

- **Rev 5 — move the manager side** (free-text branch field → picker over organisation roots).
  Withdrawn: `org_members.department` is the scope key for attendance and incidents too, and
  `attendance.service.ts:632-651` states outright that _"no team entity exists, the branch string
  IS the team"_ — `expandDepartmentMembers` turns it into a shift roster, so repointing it would
  empty scoped managers' shift expansion, not merely narrow a filter.
- **Rev 6 — move the channel side** (derive `department` from the root). Withdrawn: root names
  carry no uniqueness constraint, so the derived key is not unique per root — two seeded roots
  already both key to `General` (`department.service.ts:413-414`) — turning a permission
  boundary into a display-string coincidence, and rename/mid-tree/transaction problems followed
  behind it.
  What ships instead is one line in the CHECK. Five parts:

0. **The manager side does NOT move (round-4 BLOCKER-1 — this is the simplification that closes
   it).** Rev 5 proposed swapping the invite form's free-text branch field for a picker over
   organisation roots. **Dropped.** `org_members.department` is a scope key for THREE domains,
   not one: attendance (`attendance.service.ts:384,395`
   `COALESCE(sh.department, om.department) = $3`, threaded through 13 handlers from
   `attendance.controller.ts:67-244`, and `:200` stamps it onto shifts a scoped manager
   creates), incidents (`incident.service.ts:74-79` manager fan-out, `:175`, `:220`), and the
   join/invite lanes. Repointing what admins write into that column would silently redefine
   attendance and incident filtering for every scoped manager — they would match only rows whose
   free-text department equals an organisation-root name, i.e. none — and that needs the same
   §5 caller-completeness sweep §4 explicitly parks with the rejected `scope_channel_id`
   alternative. **It is also unnecessary:** today BOTH sides are free text typed by the same
   admin into two forms, matching only when they type consistently. Deriving the channel side
   from a resolver that returns the value admins already type keeps that reliability exactly as
   it is — no better, no worse, and no new lanes touched. A picker is a genuine improvement and
   is recorded as a follow-up (§10.11); if built, it must DISPLAY the root's name but WRITE the
   scope key below.
1. **Do not derive anything. Fix the CHECK instead — one line, and it is the convention this
   file already uses (round-5 E1–E4, E9).**
   Rev 6 derived the channel side from the root (`root.department ?? root.name`). Round 5
   showed that road keeps forking, and one of its forks is a security hole:
   - **E1 — root names are not unique.** No `UNIQUE (org_id, name)` exists
     (`20260603000000_pro_subscription_and_dept_channels.sql:25-45`) and `createChannel` has no
     dup-name guard. Two organisations named "Security" → a manager scoped to "Security" mints
     into BOTH. A permission boundary defeated by a display string.
   - **E2 — rename fixes one operand and staleness moves to the other.** Re-deriving channels
     leaves `org_members.department` on the old string; syncing THAT instead breaks
     attendance/roster/corrections, because `cpo_shifts.department` still holds the old value
     (`attendance.service.ts:384,395`, `roster.service.ts:189-190,526-534`).
   - **E3/E4** — "re-derive the subtree" is ambiguous for a mid-tree rename, and
     `configureChannel` (`department.service.ts:655-793`) has NO transaction, so a partial
     subtree rewrite would manufacture exactly the permanent scope drift the rule exists to
     prevent.
     **The fix:** leave `department` alone — the create form simply stops sending it, so new
     channels carry NULL, precisely as they do today whenever an admin leaves the optional field
     blank. Then relax the comparison so a **NULL** channel department is mintable by any manager:
     `if (team.department != null && team.department !== managerDepartment) refuse`.
     **The edit site is `createMemberInvite` (~`:741-744` — re-grep, these drift), NOT
     `assertMintableTeam` (round-6 MAJOR).**
     `assertMintableTeam` (`:112-128`) holds no department comparison and takes no
     `managerDepartment` — it only RETURNS `{department}`. Threading the scope into it would also
     capture its other caller, `createReferralLink:136`, which performs no branch check today, and
     would silently start branch-refusing referral-link mints — a lane nothing in this plan
     analysed. `assertMintableTeam` keeps its signature; `createReferralLink` stays unbranched,
     deliberately.
     **Why this is the right shape, not a shortcut:** the same file already encodes exactly this
     rule four times — `COALESCE(CASE WHEN c.archived_at IS NULL THEN c.department END, $2) = $2`
     (`:493-495`, `:540-544`, `:899-901`, `:925-929`), documented as _"folds all three
     unresolvable cases into 'unrouted', which belongs in every manager's inbox"_. A team with no
     branch is not another branch's team; refusing it was the outlier. This also deletes the
     round-4 MAJOR (no `COALESCE` narrowing, since nothing becomes populated), needs no
     uniqueness constraint, no rename sync, no transaction, no mid-tree rule, and no tenant gate
     on a formula that no longer exists (E9).
     **The one deliberate widening — record it, §10.12:** a branch-scoped manager may now mint
     into unscoped teams. Bounded and explicit; the alternative (leave the refusal, remove the
     field) means scoped managers cannot be given ANY new team after this ships.
     **G2's rename problem disappears with the derivation** — there is no derived value to go
     stale, and `org_members.department` keeps matching whatever it matched before. (Recorded so
     the rename re-derivation is not re-proposed: it would have needed a uniqueness guard, a
     cross-subsystem sync, a transaction `configureChannel` does not have, and a mid-tree rule.)
2. **Semantics + the TENANT GATE (round-5 critic MAJOR-3).** Nothing about the manager side,
   the attendance lane, the incident lane, or `org_members.department` changes. Legacy channels
   keep their typed departments and existing scope behaviour; new WORKSPACE channels are
   unscoped and mintable by any manager. §3 item 4's greying rule ships unchanged.
   **Both halves are workspace-tenant-only.** `ChannelEditorScreen` is ONE screen for both
   tenants (`MessengerNavigator.tsx:250`, `DepartmentalNavigator.tsx:127`) and
   `POST /department/channels` is reachable by any agency org through `OrgManagerGuard`, while
   agency orgs actively use typed departments ('Operations', 'Intel') for real branch scope. So
   the agency editor KEEPS its DEPARTMENT field, and the NULL-is-mintable relaxation is gated to
   the workspace tenant so the agency permission surface is untouched.
   **Server `createChannel` needs NO change** (round-6 MINOR): `:592` already stores
   `input.department ?? null` unconditionally, so omitting the key yields NULL. **The fork is
   client-side only** — do not add a tenant branch to that hot path.
   **How the server reads the tenant for the relaxation:** fold the discriminator into
   `assertMintableTeam`'s EXISTING select as
   `EXISTS(SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = c.org_id) AS
is_workspace` — one round trip, and it preserves the positional `mockResolvedValueOnce`
   ordering that `enterpriseJoin.spec.ts:913-919` and the "Mint read order" comment at `:921-922`
   depend on. A separate probe would turn those green specs red for no design reason.
   `undefined → agency → today's strict rule`. (The accept-path pins at `:1085-1097` / `:1261-1273`
   ban `org_workspaces` reads in `acceptInvite` and `resolveReferralLink`; the MINT path is not
   covered by them — stated so nobody assumes otherwise.)
   **How the CLIENT reads it — and the field that looks right is WRONG here (round-6 G9).**
   `org_is_workspace` resolves the user's PRIMARY org and deliberately prefers an agency
   membership over a personally-owned workspace (`account-kind.ts:161-167`), while
   `OrgManagerGuard` Path 1b resolves an active workspace owner to their OWN workspace before
   the delegated-manager path (`org-manager.guard.ts:78-115`). For an agency crew member who
   also owns a workspace the two disagree **by design** — and since `listManagedChannels` takes
   no org param (`department.controller.ts:83-87`), the manage tree they are editing is always
   the guard-resolved one. Using `org_is_workspace` alone hands that persona the AGENCY form
   while the server takes the workspace arm: they type a DEPARTMENT, and the new workspace
   channel is born branch-scoped — the precise state item 7 exists to prevent.
   **Predicate: `user.owns_workspace === true || user.org_is_workspace === true`, as ONE
   exported helper (round-7 MAJOR-2).** Rev 9 briefly used `getActiveWorkspace() != null` —
   wrong, because that context is session-only and set ONLY by a Workspace Hub tile; its own
   docstring says every pre-existing entry point (drawer, CPO shells, notification taps) is
   untouched by construction, and `fcmBootstrap.ts:1276` lands people straight in the dept shell
   with no hub context, from which item 6's new Manage Channels button reaches the editor.
   `owns_workspace` is the right partner because it is the SAME lapse-gated expression the guard
   uses on Path 1b (`account-kind.ts:159-160` vs the guard's `activeEnterpriseSql`), the parity
   documented at `activeWorkspace.ts:80-87`.
   **Better still, and worth one line: have the server say it.** `listManagedChannels` takes no
   org param (`department.controller.ts:83-87`), so the tree being edited is ALWAYS the
   guard-resolved org — emit the tenant flag on that response. No client predicate can mirror
   guard Path 2, whose `SELECT … FROM org_members WHERE member_role='manager' AND
status='active'` has no `ORDER BY`/`LIMIT` and is nondeterministic for a manager in two orgs.
   And explicitly: `useInDepartmentalShell` is NOT the signal — it is a navigation-shell probe
   (`_obsidian.tsx:32-42`) that `ChannelEditorScreen.tsx:14` already imports, and workspace users
   reach the editor through `MessengerNavigator.tsx:250` too.
3. **The editor must still not CLEAR a legacy value (G3, unchanged):** `''` is an explicit-clear
   sentinel (`department.service.ts:745-751`), so the editor sends **no `department` key on
   either verb**. An existing channel's typed department survives every edit; only the create
   form stops setting one.
4. **Spec:** workspace create → payload carries no `department`, row is NULL, a branch-scoped
   manager mints it; a legacy workspace channel with `department = 'Roster'` still refuses a
   manager scoped elsewhere (unchanged); editing that legacy channel's name or access leaves
   `Roster` intact; **agency `createChannel` with `department: 'Intel'` still stores `'Intel'`
   and an out-of-branch agency manager is still refused** (the tenant gate, both halves);
   `mintable_by_me` matches the server's per-row refusal for an EMPLOYEE invite on every row
   (role-level refusals are separate — see item 4).
   **Ships in the SAME COMMIT as item 8 (critic M-5):** item 7 deletes the PARENT radio list
   (`ChannelEditorScreen.tsx:229-254`), today's only parent selector, and its replacement is item
   8's tree passing the parent as a route param. Alone, item 7 leaves the app able to create
   top-level channels only.
   **Caller sweep done (edge round-4, probed clean):** `ChannelEditor` is pushed from exactly three
   sites, all inside the screen item 8 replaces — `ManageChannelsScreen.tsx:84`, `:95` (edit) and
   `:108` (create, `{}`). No notification or deep-link lane reaches it, so the same-commit rule is
   sufficient. **Two chores belong in that commit:** add the new `parent` param to BOTH
   `types.ts:115-125` and the Departmental alias at `types.ts:524`; and delete the now-dead
   create-only parent-fetch effect plus its `parents` state (`ChannelEditorScreen.tsx:~94-117`),
   or `listManagedChannels` keeps firing on every create for nothing.
   **Consequence recorded (critic F9):** removing TYPE removes the client's only producer of
   `channel_type:'incident'` (managers-only via `seedsManagersOnly`,
   `department.service.ts:483-485`) — incident-type channels become uncreatable from the app.
   Recommendation: accept (Restricted covers managers-only visibility); founder question §10.5.
   Server keeps supporting the type (no DTO change).
   **Tests:** reduced-form render; payload (type omitted → default, **no `department` key on either
   verb**); the `assertMintableTeam` NULL-is-mintable change, mutation-proved; a legacy branded
   team still refuses an out-of-branch manager; a legacy channel's department survives a rename and
   an access edit; restricted-refused-on-root (server, BOTH verbs, incl. the tighten path);
   agency-tenant case; edit-form regression (rename/access/archive/members keep working).

---

## 5. Phase P4 — attendance dashboard (item 13)

**Current:** `AdminAttendanceScreen.tsx` card menu → four sibling screens
(`DepartmentalNavigator.tsx:156-161`); only add-member-to-shift flow is inside
`ShiftEditorScreen` (`:415+`); dead-end empty states (`DayStatusScreen.tsx:310`,
`ShiftEditorScreen.tsx:423`).
**Fix:**

1. `AdminAttendanceScreen` → segmented one-screen dashboard (Shifts · Day status · Roster ·
   Corrections) hosting the four bodies. Mechanics: extract each body into a component consumed
   by BOTH the segment host and the existing routes (routes stay registered — deep links
   `navigate('Corrections', {session})` from the pending queue (`:227`) and
   `MonthlyRosterScreen.tsx:307/332` keep working). Pending-review queue stays below the host.
   **Two commits:** pure-move extraction first (no behaviour), then the segment host — keeps
   the self-diff reviewable.
2. Guidance (the client's "shown how to add a member to a shift"): when shifts have zero
   assignees (or roster empty), render a guidance card with CTAs → Shifts segment / Employees;
   kill both dead-end empty states with CTAs.
   **No data-model/endpoint changes.**
   **Tests:** segment host render (4 segments, right bodies); deep-link regression (prefilled
   Corrections); empty-state CTA tests.
   **Edge-case round found no additional gaps for P4.**

---

## 6. Phase P5 — incident entry + notification (15, 16)

### Item 15 — category grid first

**Current:** member root is `MyIncidents` (`DepartmentalNavigator.tsx:172`).
**Fix:** member root → `ReportIncidentCategory`; "My reports" header action on the category
screen → `MyIncidents` (stays registered). Manager root unchanged. Update
`DepartmentalHomeScreen.tsx:277-287` (member quick action → `navigate('Incident')`).
**Done-landing decided (edge P5-3):** `IncidentSubmittedScreen` "Done" currently `popToTop()`
(`:63`) while its copy promises "follow its status in your submitted reports" (`:41-43`) — with
the new root that lands on a fresh wizard. Done → explicit `MyIncidents`. Update the `:281-284`
popToTop comment.
**Tests:** initial-route per role; Done-lands-on-MyIncidents test.

### Item 16 — a real notification: org + reporter + deep link, no "CPO"

**Current:** server sends `{kind:'incident-submitted', ref, severity}`
(`booking-push-bridge.service.ts:396-401`); client copy static — "A CPO filed an incident."
(`serverWakeNotifications.ts:117`, `activitySync.ts:44`); tap lands managers on the Channels
directory (`fcmBootstrap.ts:1273-1276`); **the durable inbox row carries no incident id**
(`booking-push-bridge.service.ts:92-97`) and the Redis detail blob lives ~5 min (`:70-75`).
**Fix — server:** payload gains `incidentId`, `orgName`, `reporterName`.
`reporterName` fallback server-side when display name is null/empty/hex → omit the field
(edge P5-2). **Extend the durable inbox row** (`notifications.record`) with `incidentId`
(nullable) so the bell/inbox tap and the killed->5min lane can deep-link (edge P5-1 / critic
F10b — without this the flagship behaviour works only in the fresh-delivery lane). Recipient
selection unchanged — note precisely (critic F10): fan-out is all active managers + owner,
**department-scoped when the incident carries one** (`incident.service.ts:74-82`); pin the
scoped behaviour in the bridge spec. logAudit vocabulary check on any new log lines.
**Fix — client:** compose from payload with fallbacks: payload present →
`"{orgName}: incident reported"` / `"Reported by {reporterName}. Tap to review."`; reporterName
absent → generic "An incident was reported. Tap to review."; **blob-fetch miss treated
identically to old-server** (edge P5-1) — the compose path must not assume the rich fields
exist. Same treatment in `activitySync.ts`.
**Tap routing:** manager target = incident detail (takes `params.incidentId` and fetches —
verified `IncidentDetailScreen.tsx:30,44`) via the shell-resolver pattern (B-414 — never a bare
route name), fallback `IncidentQueue` when `incidentId` missing. **Do not regress the
`incident-status` submitter path (critic F10c):** same candidates table serves the submitter —
CPO → `CpoMission` stays; enterprise workspace member's correct target is `MyIncidentDetail`
(fix in the same table edit). BOOKING project runs (B-414 rule); any `MainNavigator` change
co-lands `notifHealthProbe`+`fcmBootstrap`.
**Compat:** old client + new server → static copy minus nothing (old copy persists until APK;
note in report). New client + old server → generic copy + queue fallback.
**Tests:** bridge spec (payload fields, dept-scoped fan-out, durable row incidentId); compose
fallback matrix unit test; tap-routing asserts incident target + submitter path preserved;
mutation-prove the deep link (drop incidentId → queue).

---

## 7. Phase P6 — org settings + drawer (17-hide, 18)

### Item 17 (hide half) — per-org module hiding

**Current:** no org-level settings storage exists (verified); `org_workspaces` =
owner/name/created_at; `permitted_modules` is per-MANAGER, consumed only by
`AgentDashboardScreen.tsx:538-541` — wrong shape.
**Fix:**

- Migration: `org_workspace_settings` (PK `org_user_id` FK → org_workspaces, `hidden_modules
text[] NOT NULL DEFAULT '{}'`, `updated_at`, `updated_by`); values validated in service
  (`attendance`, `incidents`).
- Server: `GET /org/workspace/settings` (member-readable) + `PATCH` (OrgManagerGuard; audit
  `workspace.settings.update` with explicit before/after — the spec asserts audit args
  explicitly, 2026-08-04 lesson).
- Client: admin settings sheet on the "Channels" home; **ONE filter helper consumed by all
  FOUR advertising surfaces (edge P6-2):** quick-action grid, alert tiles, the member
  "Today's attendance" card (`DepartmentalHomeScreen.tsx:228-239`), and the
  `DepartmentChannelsScreen` "Attendance & Incidents" row (`:545-563`). Members get the same
  filter. Routes stay registered (hidden ≠ removed — deep links/notifications must not crash).
- **No cache layer at all — fold the fetch into the existing on-focus load (critic m-7,
  simplifying W4).** `DepartmentalHomeScreen.tsx:77-78` already reloads org-scoped data on every
  focus; add `hidden_modules` to that load and hold it in screen state. Org-keying and
  staleness both fall out of the per-focus reload, and **fail-open falls out of
  `undefined → visible`** — three mechanisms (org-keyed cache + TTL + fail-open) for a cosmetic
  home-screen toggle was over-built. Pin fail-open in the render test.
  **Key on the org id the RESPONSE echoes, not the request param (edge round-3 #6):**
  `activeWorkspaceOrgParam()` returns `undefined` before a hub selection
  (`activeWorkspace.ts:67-70`), which is the majority path (drawer, CPO shells, notification
  taps are untouched by construction, `:9-11`) — so a request-keyed store collapses to one
  shared bucket and the anti-cross-org rule silently doesn't hold where it matters most.
  **State plainly: hiding is presentation, never a permission** — the server keeps enforcing
  access regardless (see §10.10; the client has an explicit locked rule on this axis).
  Agency tenants (no `org_workspaces` row) → fail open, no settings sheet.
- **Operational contradiction guard (edge P6-3):** the settings sheet warns when hiding
  attendance while active shifts exist in the current/next period (members lose their check-in
  door and start reading absent). **Caveat to state (edge round-3 #7):** the attendance calls
  on this screen are NOT org-scoped — `attendanceApi.myShifts()` / `myTodayShift()` (`:73-74`)
  and `orgSummary()` (`:90`) take no org param, unlike the channels load at `:77-78`. So the
  warning (and the member "Today's attendance" card the filter hides) reads the PRIMARY org
  while `hidden_modules` is keyed to the active workspace. Either org-scope those calls in P6
  or state the limitation — do not let the mismatch ship unnamed.
- `/auth/me` NOT touched (fetch where used — avoids the B-394 field-parity trap).
- **P7 note (critic F12):** this endpoint is a new single-org resolution site — pre-listed in
  §9's table.
  **Tests:** service spec (validation, audit args, guard); dashboard render with hidden modules
  (all four surfaces); member-sees-same; fail-open pin; active-shifts warning.

### Item 18 — drawer rename/move + switch confirms + remove Choose Dashboard

**Current:** `ProfileDrawerModal.tsx` is ONE component for both shells — client rows
`:172-178`, **provider rows `[My Profile, deptRow]` `:170-171` with "Return to Dashboard"
instead of the switch section (`:224-238`)**; switch = store write (`switchProduct`,
`productStore.ts:94-98`; product tree keyed on `activeProduct` → switch unmounts everything);
confirms exist only for same-product-with-stack (`SwitchDashboardSection.tsx:187-203`) and
dirty booking draft (`:210-229`); "Choose Dashboard" row `:252-263` → `requestGate()`; the
hardware-back handler is TWO branches — B-352 `returnProduct` restore THEN `requestGate()`
(`MainNavigator.tsx:398-408`), pinned by `navigatorConfig.test.ts:98-102`.
**Fix:**

1. **Rename + move — client branch only (critic F1 / edge P6-4):** the client drawer's row
   moves inside SWITCH DASHBOARD after the three products (keep ENTERPRISE pill, entitlement
   dimming, resolver logic). **The provider branch KEEPS its row in place** — `deptRow` is the
   provider drawer's only workspace door and providers have no switch section. Provider-drawer
   render test added.
   **The row is a ternary, not one label (edge W3):** `ProfileDrawerModal.tsx:155-168` renders
   **"Workspaces"** → `openWorkspaceHub` for the affiliated user (`owns_workspace ||
org_is_workspace`) and "Departmental Chat" → `openDeptChat` otherwise. Rename **only the
   unaffiliated arm** to "Channels"; the hub arm keeps "Workspaces" (renaming it would mislabel
   an organisations/invites/join hub AND collide with item 17's "Channels" header one screen
   away). Recorded as §10.9 in case the client wants one label everywhere.
2. **Leave-confirms:** shared `confirmLeaveDashboard(currentLabel, onYes)` on the B-88
   `@utils/alert` wrapper: `Are you sure you wish to leave "{current}"?` Yes/No. Wired at the
   switch section's cross-product path and the client "Channels" row. Dirty-booking dialog
   CHAINS (draft dialog wins; no double prompt).
   **Wire the confirm to `deptRow.go`, NOT to the label (edge round-3 #4):** the row is a
   ternary and only the unaffiliated arm is called "Channels"; wiring by label leaves the
   workspace-affiliated user — most of the enterprise audience — leaving with no confirm from
   the same physical row. **But note what that row actually does (edge round-4 G6):** BOTH arms
   resolve INSIDE the current product (`ProfileDrawerModal.tsx:123-126` / `:137-152`); neither
   calls `switchProduct` and `key={activeProduct}` never changes. So "Are you sure you wish to
   leave Secure Services?" would fire on a move that does not leave it — and it contradicts the
   exemption invoked one paragraph below for the Departmental Messenger tab. **Folded into
   §10.7 rather than decided here**; if kept, the copy must name the destination instead of
   claiming a departure.
   **Active call (edge P6-7 / W2, rebuilt by edge round-3 #1–#3):**
   - **Do NOT write a new helper — `hasLiveCall()` already exists**
     (`src/modules/messenger/runtime/callResumeGuard.ts:24-40`): it reads BOTH registries,
     already filters terminal states, and its docstring already carries the type-only-import
     justification. A second copy is this repo's most-shipped bug class. Consume it; alias the
     name at the call site if it reads wrong.
   - Terminal-state filtering is **not optional**: every controller transition including
     `ended`/`failed` is mirrored into the slot (`useCall.ts:574`), so a naive
     `getActiveCall() !== null` fires "you're on a call with Bob" after Bob hung up.
     `hasLiveCall` encodes this; that is the second reason to use it.
   - **An inbound GROUP ring is in neither registry and does NOT survive the switch**
     (edge #3): `setActiveGroupCall` is first written at `useGroupCall.ts:1526` — i.e. after
     Accept — while 1:1 registers during the ring (`useCall.ts:881`). `IncomingGroupCallScreen`
     is a stack child under `key={activeProduct}` with no overlay counterpart, so a product
     switch destroys an Ops Room ring silently (the B-414 lane, reproduced by the fix meant to
     cover it). Include the ring in the check (subscribe to the ring dispatcher or seed the
     registry at ring time) and say plainly in that confirm that the ring will be lost.
   - **Minimize BEFORE switching, don't block (critic M-4):** `FloatingCallOverlay` is mounted
     at `App.tsx:74-80` outside `RootNavigator`, so a _minimized_ call survives
     `key={activeProduct}`. But the group overlay renders only `if (groupActive?.isMinimized)`
     (`:122`) and the B-64 orphan rescue (`:148-156`) is 1:1-only — a full-screen group call
     therefore strands with no End button and no return path. On confirm-Yes with a live call:
     `setMinimized(true)` / `setGroupCallMinimized(true)` **then** `switchProduct(p)`. Also
     route `restore()`'s bare `navigate('CallScreen', …)` (`:185`) through the B-414 shell
     resolver — `CallScreen` is registered only in Messenger/Agent stacks, so after a switch to
     `secure`/`vbg` it is silently dropped. **The GROUP `restore()` is worse and must be fixed
     in the same commit (edge round-4 G1):** `FloatingCallOverlay.tsx:353-368` calls
     `setGroupCallMinimized(false)` **before** a bare `navigate('GroupCallScreen', …)`, and
     `GroupCallScreen` is registered only in `MessengerNavigator.tsx:113` /
     `AgentNavigator.tsx:303`. So the plan's own device case fails today: the tap hides the
     overlay, the navigate is dropped in `secure`/`vbg`, and the user has a live group call with
     no End button and no way back. Route `:355` through the resolver too, AND reorder it to
     mirror the 1:1 path, which deliberately dispatches BEFORE clearing the flag for exactly
     this reason (see the "P3 — CONFIRM navigation dispatched before hiding the overlay"
     comment at `:176-186`). **Re-grep before editing:** `:355` is the flag clear, the bare
     navigate is at `:359` (round-5 nit) — and these line numbers go stale fast. Until both
     land, blocking the switch for group calls is the honest fallback. Device case: group call
     → switch → overlay visible in Secure → tap restores.
   - **Why the explicit minimize call is required at all** (probed, record it): reaching the
     switch section requires popping the call screen, whose `beforeRemove` already minimizes
     (`CallScreen.tsx:546-590`, `GroupCallScreen.tsx:1543-1565`) — so at confirm time the flag
     is usually already true and the call is an idempotent re-notify
     (`callRegistry.ts:128-130`). It is still required because `switchProduct` is a plain store
     write and the `key={activeProduct}` remount is a raw React unmount that does **not**
     dispatch `beforeRemove`.
     **The Departmental Messenger-tab exit gets NO confirm (critic F5):** the client's own note
     exempts "messenger entry inside a dashboard", and the Home-header exit chevron
     (`DepartmentalHomeScreen.tsx:136`) leaves without confirm either — a tab-only confirm would
     be inconsistent. Founder question §10.7 records the alternative reading.
     **But the exit itself is broken in the CPO shell (edge P6-5):** `getParent()?.navigate(
'MessengerHome')` (`DepartmentalNavigator.tsx:274-283`) resolves in Messenger/Agent shells
     and is silently dropped in `CpoNavigator` (no `MessengerHome` in its root stack —
     `CpoNavigator.tsx:76-88`) — the B-414 class. Route the exit through the shell resolver in
     this phase regardless of the confirm decision.
3. **Remove "Choose Dashboard" (critic F4 / edge P6-6):** delete the row
   **`SwitchDashboardSection.tsx:252-263`** (critic m-4 — not `ProfileDrawerModal`; `openGate`
   is at `:99-102`). In the
   hardware-back handler keep the `returnProduct` branch VERBATIM; replace only the final
   `requestGate()` fallback with `return false` (default back = background the app). REWRITE
   the `navigatorConfig.test.ts:98-102` pin: assert returnProduct survives + requestGate gone
   (never delete the pin). `ProductGateScreen` STAYS for boot (`!activeProduct`) — first login
   must pick a surface (§10.3). Verified: the switch section remains reachable from all three
   products (ProfileScreen + drawer hosts), so no stuck state.
   **After this change `requestGate` has ZERO callers (critic m-9)** — its only two are
   `MainNavigator.tsx:407` (being replaced) and the deleted row; boot renders the gate from
   `!activeProduct || gateVisible` (`:1026`) and never calls it. So a "no caller outside the boot
   path" scan would be vacuous. **Decide explicitly and record it:** keep `requestGate`/
   `gateVisible` as dead-but-pinned store API (recommended — the boot gate still reads
   `gateVisible`, and a future re-entry point is cheap) or delete both and rewrite all three pins:
   `navigatorConfig.test.ts:105-107`, `productStore.test.ts:19-23` and `:44-54` (B-95).
   **Re-anchor, don't edit in place (critic m-10):** `navigatorConfig.test.ts:96` matches
   `/hardwareBackPress[\s\S]{0,800}/` and `requestGate()` sits ~612 chars in — deleting it makes
   `:102`'s `toBeLessThan(-1)` fail with a misleading ORDERING message, and adding comment text
   slides assertions out of the window for unrelated reasons. Anchor on the effect body, or widen
   and assert absence explicitly.
   **Tests:** drawer render per branch (client: row in switch section, no Choose Dashboard;
   provider: row present — and note providers reach neither the switch section nor the gate,
   critic m-13, so the provider test asserts exactly that); confirm-flow (Yes switches, No stays,
   draft no-double-prompt, live-call branch, group-ring branch); hardware-back B-352 regression;
   B-88 sweep green.
   **B-414 co-land rule applies (MainNavigator touched): `notifHealthProbe` + `fcmBootstrap`
   consistency in the same commit.**

---

## 8. Cross-phase gates (every phase)

1. Targeted suites first, then broad; messenger gate (crypto ×2 **plus** `--selectProjects app
--testPathPattern "screens/messenger"`) whenever `src/screens/messenger/**` or
   `src/modules/messenger/**` is touched. **Corrected phase list (critic M-6):** `P1 item 9`
   (its W1 draft-persistence prerequisite edits `DepartmentChatScreen`), **`P1 item 11`**,
   **`P3`**, **`P5`**, and **`P6 item 17-hide`** (it filters the "Attendance & Incidents" row in
   `DepartmentChannelsScreen.tsx:545-563`) — both of those screens live in
   `src/screens/messenger/`, NOT `src/screens/deptchat/`, and `ObsidianTabBar` is in
   `src/navigation/`. **Plus `P6 item 18` (round-3 MAJOR-5):** the group-ring work added by edge
   round-3 #3 touches `src/modules/messenger/runtime/groupCallRegistry.ts` and
   `src/modules/messenger/webrtc/useGroupCall.ts` — both inside the gated tree; M-6's list was
   written before that landed. BOOKING project for notification/nav changes (P5, P6 — B-414).
2. `npm run typecheck` ≤ baseline 47 (count errors, not exit codes); auth-service `npm test` +
   `npm run build` for server phases (P2, P3, P5, P6, P7).
3. Bug-regression contract: every fix's test RED first (mutation-prove by reverting).
4. Source-scan rules: CRLF-safe, line-anchored comment strip, site-anchored.
5. Self-diff (rule 8): enumerate consumers of anything deleted/moved before shipping.
6. Design: obsidian `#07090D` / cobalt `#5B8DEF`; DESIGN_REVIEW_LOOP audit for redesigned
   screens (P3 directory/tree, P4 dashboard).
7. Server-first deploy; APK decisions founder-held.

---

## 9. Phase P7 — multi-organisation membership (item 4) — architecture

**The restriction is structural:** partial unique index `org_members_one_active_agency
ON org_members (member_user_id) WHERE status='active'`
(`20260622110000_antifraud_integrity.sql:29-31`), surfaced as 23505 →
`already_active_in_another_org` (`enterprise-join.service.ts:687-693`), pre-checked at
`:247-254` + `:999-1003` (citations critic-verified exact).

**Design decision (needs founder sign-off, §10.1):** scope the invariant to what it protects:

```sql
CREATE UNIQUE INDEX org_members_one_active_cpo
  ON public.org_members (member_user_id)
  WHERE status = 'active' AND member_role = 'cpo';
CREATE UNIQUE INDEX org_members_one_per_org
  ON public.org_members (member_user_id, org_user_id);
```

CPO employment stays exclusive; workspace membership (`employee`/`manager`) becomes multi.
**Pre-flight (critic F13):** `grantMembership` reactivates rather than inserting
(`:653-676`) so (member, org) _should_ be unique — but nothing enforces it; the staging
rehearsal runs a duplicate-pair probe BEFORE `CREATE UNIQUE INDEX` (a historical dup fails the
migration hard). Open design point: one user as manager at TWO agencies — does
routing/`managed_org` become context-scoped too? Resolve in the P7 design round.

**Existing scaffolding:** `workspaces[]` on /auth/me (`account-kind.ts:271-280`, capped 2 only
by construction); `WorkspaceHubScreen` switcher; `activeWorkspace` store
(`scopeChannelsToActiveWorkspace`, `activeWorkspaceOrgParam`); `listChannels ?orgId`.

**Context-scoping table (each site gets a verdict in the P7 design review):**
| Site | Today | P7 treatment |
|------|-------|--------------|
| `account-kind.ts:187-197` LATERAL `LIMIT 1` | N→1 | keep as "primary" default + uncap `workspaces[]` |
| `account-kind.ts:203-224` four-arm precedence | one org | default org; explicit context overrides |
| `org-manager.guard.ts:118-133` Path 2 | THE manager org | `X-Org-Context` header validated against membership; single-membership fallback for old apps |
| `dept-chat-access.guard.ts:46-52` | one active org | same |
| `attendance.service.ts` resolveOrg (oldest) | one org | context-scoped; oldest fallback |
| `incident.service.ts:89` resolveOrg | one org | same |
| **`/org/workspace/settings` (NEW in P6 — critic F12)** | caller's org | context-scoped from birth: build it context-ready in P6 |
| `cpo-assignment.service.ts:249,270`, `org-cpo.service.ts:296`, `agent.service.ts:981` | CPO lanes | UNCHANGED — cpo rows stay exclusive |
| `inviteAccept.ts:14-19` client | "at most one membership" | switcher-aware; point context at the joined org |

**Client:** WorkspaceHub lists all memberships; `activeWorkspace` supplies the org context —
**stamped onto each request at CREATION, not per-attempt (edge P7-2)** — a queued/retried
request must not fire with a post-switch org header.
**Push lane (edge P7-1 — corrects a Rev-1 claim):** the enterprise wake blobs deliberately
carry ONLY the kind (`booking-push-bridge.service.ts:408-414`) and the Approvals tap has no org
context (`fcmBootstrap.ts:1277-1291`) — P7 adds `org_user_id` to enterprise wake blobs +
tap-time context targeting, or a two-org manager taps org-B's request and reads org-A's list.
**E2EE:** unchanged — per-channel Signal groups; `channel_membership_intents` org-agnostic.
**Sequencing (B-416 fork-barrier discipline):** index swap first (code still enforcing one-org
via pre-checks) → relax pre-checks behind a server flag → client switcher UX → flip. Old app +
multi-org account: resolves the four-arm primary org, functions single-org.
**Own migration rehearsal** against the Supabase staging DB (bravo-staging-auth `$DATABASE_URL`
— NOT the local pg container) + own device matrix. Ships alone.

---

## 10. Open questions for the founder (non-blocking for P1–P6)

1. **P7 scope:** confirm — CPO employment stays one-agency-exclusive; workspace memberships
   become multi.
2. **Existing workspaces' default channels:** leave + make `#broadcast` archivable
   (recommended) vs cleanup migration.
3. **Boot dashboard picker:** we remove the drawer row + Android-back gate but keep the
   FIRST-LOGIN picker. Confirm, or name a default dashboard for fresh accounts.
4. **Vault "Company" label:** rename to "Organisation" too, or keep (recommended: keep —
   security distinction with own tests).
5. **Incident-type channels (critic F9):** simplified create form removes the only client way
   to create `incident`-type channels. Recommend: accept (Restricted covers managers-only);
   server keeps the type.
6. **Depth asymmetry (critic F6):** existing workspaces top out one tier shallower than fresh
   level-0 organisations; re-parenting is DB-blocked. Accept (recommended), or scope a
   re-level migration as follow-up.
7. **Leave-confirm scope (critic F5 + edge round-4 G6):** which moves count as "leaving a
   dashboard"? Our reading: a genuine product switch (Messenger ⇄ Secure ⇄ VBG) confirms; the
   Departmental Messenger tab does NOT (the client's own "internal messenger" exemption, and
   the Home-header exit doesn't either); **and the drawer's Channels/Workspaces row does not
   actually leave the product at all** — it resolves inside it — so a "leave X?" prompt there
   would be false. Confirm, or tell us you want a prompt on every one of the four named
   surfaces regardless.
8. **Are organisation roots chat surfaces? (§4 items 6+8):** a root carries its own group but
   defaults to `read_only`, so a member tapping one opens an empty un-postable thread.
   Recommend: roots are structural only (tap = drill in, never chat) — this is already the
   stated build assumption so P3 is not blocked; confirm or reverse it.
9. **One label or two in the drawer? (edge W3 + round-3 #5):** the row shows "Workspaces" to a
   user who HAS a workspace and "Departmental Chat" to one who doesn't. We rename only the
   second to "Channels". **Worth knowing before you answer:** the arm we rename is also the
   dimmed/locked one (`dimmed: !entitlements.hasDeptChannels`), so as recommended the item-18
   rename is effectively invisible to every user who actually has a workspace. Confirm, or say
   whether "Channels" should appear in both places (it would collide with item 17's screen
   title one tap away).
10. **Is hiding a module presentation-only? (critic m-12):** we implement item 17 as a
    home-screen filter — routes stay registered, deep links and notifications still open the
    module, the server keeps enforcing access. That reads as the ask ("hide from the home
    screen"), but the client's own locked rule, repeated on every PDF page, is that "role,
    scope, visibility and every protected operation are enforced server-side… hidden metadata
    is filtered by the server, not merely hidden by the client". Confirm presentation-only, or
    say hiding must actually disable the module for the organisation.
11. **Branch-scoped managers become largely unscoped in the invite/approval lane — read this one
    carefully (round-5 E1–E4, scope corrected by round-6 G2).** Earlier revisions framed this as
    "a scoped manager may now mint into unscoped teams". That undersold it. The cause is not the
    one-line mint change; it is **items 5+12**: once new workspace channels carry no branch, the
    "unrouted belongs to every manager" convention — which already governs **four** other
    predicates — starts matching everything. **Precise attribution (round-7):** what makes a
    channel branchless is **item 7 removing the DEPARTMENT field from the create form** — also
    the client's own ask — amplified by items 5+12, which delete the last rows that carried a
    branch. And it is a widening of DEGREE, not of kind: an admin who leaves that optional field
    blank today already produces a channel all four predicates match
    (`ChannelEditorScreen.tsx:132` sends `department.trim() || null`). Post-P3 a branch-scoped
    manager can, for channels created after the change:
    - see every branch's outstanding invites, contact phone/email included
      (`listMemberInvites:899-901`);
    - **revoke** them (`revokeMemberInvite:919-929`);
    - **approve or decline** any branch's join request (`listPendingRequests:493-495`,
      `decideJoinRequest:540-544` — whose docstring exists precisely to stop this);
    - and, with item 7's line, mint into them (`createMemberInvite:743-745`).
      Three of those four follow from the form change the client asked for; only the fourth is
      ours. **In effect, a branch-scoped manager created after P3 is a label without a
      boundary.** Two facts still argue for approving: a scoped manager can ALREADY mint a
      _teamless_ invite that seeds the member **org-wide** (`:735-737`, deliberate), so no single
      grant gets wider; and the alternative leaves scoped managers unable to be given any new team
      at all. But this is a real reduction in an access boundary and it is the founder's call, not
      ours. **If you want branch scope to keep meaning something,** channels must carry a branch —
      which is the deferred work in §10.12, and it should then be scheduled WITH this batch rather
      than after it.
12. **Branch picker instead of free text? (round-4 BLOCKER-1, deferred):** the invite form's
    branch-scope field is free text an admin types, matched by exact string equality against a
    channel's department. A picker over organisation roots would make mistyping impossible —
    but that column is also the scope key for attendance (13 handlers) and incidents, so
    changing what admins write into it needs its own caller sweep. Deferred as a follow-up,
    NOT done in this batch. Say if you want it prioritised. **Related, and worth pricing at the
    same time:** organisation root NAMES are not unique (no `UNIQUE (org_id, name)`,
    `20260603000000:25-45`), which is harmless while scope stays on legacy typed values but
    would be a real boundary hole for any future name-keyed scoping.

---

## 11. Review log

| Round | Agent           | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Amendments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Critic          | REVISE (6 MAJOR F1–F6, 8 minor F7–F14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | All folded into Rev 2: provider-drawer row kept (F1); grouping rule = parentless ∧ !is_broadcast + progressive leaf rule (F2); P3 workspace-tenant-gated + agency regression (F3); hardware-back keeps returnProduct, pin rewritten (F4); no confirm on Departmental Messenger tab → §10.7 (F5); depth asymmetry → §10.6 + relative labels (F6); announce consumers stated (F7); item-3 characterization corrected + shell-aware footer (F8); incident-type loss recorded → §10.5 (F9); durable-row incidentId + submitter path + dept-scoped fan-out (F10); helper is a P2 deliverable (F11); settings endpoint pre-listed in P7 table (F12); duplicate-pair probe (F13); citation fix (F14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 1     | Edge-case       | GAPS (24: 6 NO / 18 PARTIAL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | All folded: stack-reset on HOME (P1-1); archived-team accept fallback, branch greying, stage-1 empty state, in-set broadcast seeding, escape-hatch relabel, channelId pre-select (P2-1..6); progressive org rule, orphan bucket, empty-state copy, one-deploy coupling, tenant reverse-funnel probe (P3-1..5); durable-lane deep link, reporter-name fallback, Done→MyIncidents (P5-1..3); fail-open settings, four-surface helper, active-shifts warning, provider drawer, CPO-shell exit resolver, back-handler branch, active-call confirm (P6-1..7); wake-blob org id, context-at-creation (P7-1..2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2     | Edge-case       | GAPS (14: W1–W5 weaker-than-logged, N1–N9 new)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | All folded into Rev 3: DepartmentChat draft persistence lands before the HOME reset (W1); `hasActiveCall()` over BOTH call registries + don't block the switch, the call survives it (W2); drawer row is a ternary — rename only the unaffiliated arm, §10.9 (W3); settings cache org-keyed + bounded + "hiding is presentation, not permission" (W4); root rule keeps the absolute level term so orphans ≠ roots (W5); helper takes `{authority}` because its two inputs project `parent_id` differently (N1); group-then-disable, never filter-then-group (N2); **item 7's `department` removal gated on the P2 branch-scope rebase — otherwise scoped managers can invite nobody** (N3); restricted-rung rendering so a path-scoped member still sees their hierarchy (N4); archived-team fallback = nearest surviving ancestor, refuse rather than over-grant (N5); admin surfaces never collapse childless organisations, or the create flow dead-ends (N6); two existing test suites re-anchored not deleted (N7); escape-hatch label exported as one constant, Approvals reads it too (N8); `{orgName} · Department` subtitle joins the rename sweep (N9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2     | Critic          | **REVISE** (1 BLOCKER, 6 MAJOR, 13 MINOR); verified all six round-1 MAJORs are in the body, not log-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Folded into Rev 4: ancestor rebase replaced by derived `department`, P2↔P3 coupling deleted (B-1); `parent_hidden` DTO flag replaces the level proxy (M-1); `seedApprovedMemberChannels` docstring rewrite + "surviving" defined + bounded 3-hop walk (M-2); round-trip property test (M-3); minimize-before-switch + group-overlay strand + `restore()` routed through the shell resolver (M-4); P3 reordered to 5,12,6,8,7 with 7 landing beside 8 (M-5); messenger-gate phase list corrected, both screens are in `src/screens/messenger/` (M-6); m-1 duplicate subtitle; m-2/m-4 citation fixes; m-3 stale-precedent removed; m-5 latent level-0 trap; m-6 tenant param already exists; m-7 cache dropped for the existing on-focus load; m-8 rung derived; m-9 `requestGate` zero-callers decision; m-10 pin re-anchoring; m-11 teach the keyboard helper once; m-12 → §10.10; m-13 provider reachability stated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3     | Edge-case       | GAPS (13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Folded into Rev 4: consume the EXISTING `hasLiveCall()` rather than writing a twin (#1) and inherit its terminal-state filter (#2); group RING is in neither registry and does not survive the switch (#3); confirm wired to `deptRow.go` not the label (#4); renamed arm is the dimmed one → §10.9 (#5); key settings on the response's org id, not the request param (#6); attendance calls are not org-scoped — state or fix (#7); flag renamed to the data-source shape `parentIds` + admin-on-projected test (#8); **ancestor resolution moves INSIDE the tx before the claim UPDATE — post-commit seeding cannot fail an accept** (#9); hard-deleted team needs a mint-time breadcrumb (#10); fallback seeds the chain only, never the ancestor's subtree (#11); the walk climbs past managers-only rungs instead of dying at seed time (#12); neutral "(not shown)" rung — archived and restricted are indistinguishable (#13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3     | Critic          | **REVISE** (2 BLOCKER, 3 MAJOR, 6 MINOR); confirmed B-1 + M-1..M-6 + all 13 minors + all 13 edge-round-3 items are in the body, and code-verified `hasLiveCall`, the tenant param, the DTO's single consumer, and createChannel's existing parent SELECT                                                                                                                                                                                                                                                                                                                                                                                                   | Folded into Rev 5: `visible_ancestor_id` added beside `parent_hidden` — a boolean cannot tell the tree WHICH root an orphan belongs under, and multi-root is the premise of items 2/6/8 (BLOCKER-1); derived `department` completed on BOTH sides — formula stated, branch scope redefined as organisation-root scope, invite branch field becomes a picker over roots, spec added (BLOCKER-2); §4 retitled and item 7 moved below items 6+8 (MAJOR-3); two `ensureBroadcastForLevel` specs re-anchored to the agency arm, never deleted (MAJOR-4); P6 item 18 added to the messenger gate (MAJOR-5); `parentIds` param deleted as now-vestigial (MINOR-6); server-first compat for the new fields (MINOR-7); emitted-value spec, not a type assertion (MINOR-8); level-0 trap corrected to "remains latent, pin it" (MINOR-9); stale "admin authority mode" and W5 citations dropped (MINOR-10/11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4     | Edge-case       | GAPS (6) + 5 probed-clean records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Folded into Rev 5: group `restore()` routed through the resolver AND reordered to dispatch before clearing the flag (G1); derived `department` sources the root's NAME, re-derived on rename (G2); the editor sends no `department` key — `''` is a CLEAR sentinel (G3); precedence stated for no-visible-ancestor, and `restricted` forbidden on new organisation roots (G4); fallback trigger widened to the survival predicate + post-seed zero-rows marker (G5); the drawer row's confirm folded into §10.7 because that row never leaves the product (G6). Probed-clean recorded so they are not re-opened: `parent_hidden` on top-level rows, archived-parent unreachability (which corrects the "(not shown)" label's stated rationale), no lock-hold cost in the pre-claim walk, minimize-before-switch coherence and why the explicit call is still needed, and the three-site `ChannelEditor` caller sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4     | Critic          | **REVISE** (2 BLOCKER, 3 MAJOR, 3 MINOR); confirmed all round-3 items + G1–G6 in the body; judged P1/P4/P5/P6 and P3's 5+12/6+8 implementable cold, P2 + item 7 not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Folded into Rev 6: the branch-picker **withdrawn** — `org_members.department` is a three-domain scope key (attendance 13 handlers, incidents, invites) and repointing it needs its own sweep it doesn't earn (BLOCKER-1); one `rootScopeKey(root) = root.department ?? root.name` resolver replaces the name-keyed rule that would have refused every mint in existing workspaces (`Team Roster`→`Roster`) and would have minted unholdable scopes from null-department parents — no backfill, since a backfill would break managers already scoped to the legacy value (BLOCKER-2); the `COALESCE`-unrouted narrowing recorded as intended + pinned at its four sites (MAJOR); §4 rewritten to carry `visible_ancestor_id`, both placement branches, and the no-restricted-root rule it was contradicting (MAJOR); "no P2 coupling" restored to true now that item 7 no longer edits the invite screen (MAJOR); helper options bag optional, stale N1 citation dropped, roots-are-structural stated as the build assumption pending §10.8 (MINOR ×3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5     | Edge-case       | GAPS (9) in three clusters + `visible_ancestor_id` verified well-formed, terminating, and non-redundant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Folded into Rev 7. **Cluster (a) — scope keyed on a display string — closed by DELETING the derivation** (E1 root names have no uniqueness constraint → a manager scoped to "Security" mints into two organisations; E2 rename fixes one operand and the obvious repair breaks attendance/roster via `cpo_shifts.department`; E3 mid-tree rename fractures scope; E4 `configureChannel` has no transaction, so a partial subtree rewrite manufactures permanent drift; E9 the formula needed a tenant gate it never had). Item 7 now changes one line in `assertMintableTeam`, matching the file's four existing `COALESCE`-unrouted predicates; the widening is founder question §10.11. **Cluster (b):** the rendering rule becomes three-way and total — synthetic organisation header when `parent_hidden` is true with no visible ancestor — because a restricted root is only one producer (E6), and the restricted guard moves to the SERVER on BOTH verbs since tightening an existing root runs `removeMember` on every non-manager and strips the workforce retroactively (E5). **Cluster (c):** the zero-rows assertion becomes "zero seeded while eligible candidates existed" — a clean organisation's first employee legitimately seeds zero, and fusing that bullet with the refuse-the-accept rule would have refused the flagship flow (E7) — and the marker becomes a `seed_pending_at` set INSIDE the accept tx and cleared by the seeder, since a post-commit marker is swallowed by the `.catch` it exists to compensate for (E8). Plus the G1 line-number nit (`:359` is the navigate). Probed-clean recorded: both new DTO fields load-bearing, direct-child redundancy benign, nesting terminates, rename safe against the level/reparent triggers, and the walk must carry `archived_at IS NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5     | Critic          | **REVISE** (4 MAJOR, 4 MINOR) — reviewed Rev 6, so its formula findings (MAJOR-3/4 + three MINORs) were overtaken by Rev 7's deletion of the derivation. It independently CONFIRMED the round-4 withdrawal was right, with stronger evidence than we had: `attendance.service.ts:632-651` states "no team entity exists, the branch string IS the team", and `expandDepartmentMembers` turns it into a shift roster — so the picker would have emptied scoped managers' shift expansion, not merely narrowed a filter. Also grep-confirmed attendance and incidents never read `department_channels.department`, so "the other lanes don't change" is true | Three findings survive into Rev 7 and are folded: the item-7 lead-in still argued that the SHIPPED design was the failure to avoid — rewritten as an explicit history of the two withdrawn designs so neither is re-proposed (MAJOR-1); **the greying rule had no wire** — `/auth/me`, `ManagedChannelDto` and `listOrgChannels` all lack the caller's own scope, so the client cannot compute it; resolved by emitting a server-computed per-row `mintable_by_me` from the guard that already holds `req.orgManager.department` (MAJOR-2, a P2 blocker if skipped); and the form change is now tenant-gated in both halves — the agency editor keeps its DEPARTMENT field and the NULL-is-mintable relaxation does not touch the agency permission surface (MAJOR-3's surviving half). §10.8 citation drift fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6     | Critic          | **REVISE** (1 BLOCKER, 2 MAJOR, 6 MINOR) — but **verified the Rev-7 design sound against source**: all four `COALESCE(…,$n)=$n` predicates confirmed, `assertMintableTeam`'s full guard set enumerated (no escalation path), and decisively — a scoped manager can ALREADY mint a teamless invite that seeds org-wide (`:735-737`), so the widening grants a strict subset of what exists. Also confirmed `listOrgChannels` has exactly one production caller, and `enterpriseJoin.spec.ts:913-919` stays green                                                                                                                                            | Folded into Rev 8: §3 still carried the withdrawn derivation as a live "Decision" with a matching test — replaced by a pointer to §4 item 7, since §3 is the section a P2 implementer reads (BLOCKER); the edit site is `createMemberInvite:743-745`, not `assertMintableTeam` — the literal instruction would have branch-refused `createReferralLink:136`, an unreviewed lane (MAJOR); `mintable_by_me` had three disagreeing definitions and an unsatisfiable spec — now ONE exported helper shared with the mint check plus a source-scan test, client rule `mintable_by_me === false \|\| is_broadcast`, absent → not greyed, emitted-value fixture (MAJOR). Minors: guard department is null on Paths 1/1b (`:77`, `:113`) → every row mintable; server-first + `db.q<T>` compat restated for the new field; tenant discriminator folded into the existing SELECT to preserve mock ordering; client tenant signal NAMED (`owns_workspace \|\| org_is_workspace`, parity documented at `activeWorkspace.ts:80-87`); `createChannel` needs no server fork; `assertManagesChannel` must SELECT `parent_id` for the configure-side restricted guard; §10.11 gains the two facts that should actually decide it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6     | Edge-case       | GAPS (10) + 4 probed-clean. Reviewed Rev 7, so G1 was already closed by Rev 8's edit-site fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Folded into Rev 9. **G2 is the one that changes a founder question:** the widening spans FOUR predicates (list/decide/list-invites/revoke), not just mint, so post-P3 a scoped manager can read, revoke and decide other branches' invites and join requests — three of the four caused by items 5+12 rather than by our line. §10.11 rewritten to state all four and to point at §10.12 as the work that restores the boundary. **G3/G4/G5 — the rendering rule:** an explicit precedence rule added (the root rule claims its rows BEFORE the table, else every genuine root falls into "Other channels" and the directory shows zero organisations), §4's superseded two-way text replaced by a pointer, and `root_id` added as the synthetic header's grouping key so two hidden organisations cannot merge under one false parent. **G6:** the restricted guard's `parent_id IS NULL` predicate matches every channel in every existing workspace (all seeded rows are parentless) and would have permanently blocked managers-only channels there, since re-parenting is trigger-refused → predicate now requires an active non-broadcast child. **G7:** `seed_pending_at` moves to `enterprise_join_requests` — the approval lane never claims a link row, and the shared open link would be per-link and racy. **G8:** "success" defined as zero per-channel failures AND ≥1 seeded, with a real reader named (neither Approvals nor the `LIMIT 100` invite list can see settled rows). **G9:** the client tenant signal `org_is_workspace` prefers an agency membership while the guard prefers an owned workspace — wrong for exactly the persona it matters for; predicate now `getActiveWorkspace() != null \|\| org_is_workspace`, and `useInDepartmentalShell` explicitly ruled out. **G10:** `mintable_by_me` scoped to per-row EMPLOYEE refusals, since the manager-role refusal is role-level and would have made the spec unsatisfiable. Probed clean: the mint relaxation does NOT leak into seeding scope (branch is never re-checked at accept and the grant is a strict subset of today's), a lingering flag breaks no other reader, paging cannot break ancestor nesting, and the pathological nesting shape arises only from the superseded §4 text |
| 7     | Critic          | **REVISE → fold and ship** (2 MAJOR, 4 MINOR, all one-line; "no new fronts, no re-review needed after folding"). Verified every round-6 item in the body and re-checked each Rev-9 mechanism against source: `root_id` resolvable in ≤3 hops (level CHECK + RESTRICT + reparent refusal); the restricted predicate is byte-for-byte `archiveChannel`'s existing child query; `acceptInvite` writes the join-request row inside its tx on BOTH arms (`:1150-1156` UPDATE, `:1157-1164` INSERT); all four `COALESCE` sites confirmed                                                                                                                         | Folded into Rev 10: the rendering rule becomes a single FIVE-case switch — the three-row+precedence form put a spurious "(not shown)" rung under every ordinary parent and, combined with the compat fallback, would have emptied the ADMIN organisation list and dead-ended item 8's create flow on first use, so `listOrgChannels` now emits `FALSE AS parent_hidden, NULL::uuid AS visible_ancestor_id` explicitly and "absent" means only old-server (MAJOR-1); the client tenant predicate reverts to `owns_workspace \|\| org_is_workspace` — `getActiveWorkspace()` is session-only and undefined on the notification-tap path that reaches the editor, and `owns_workspace` is the same lapse-gated expression as guard Path 1b — plus a note that the server should just say it, since no client predicate can mirror the nondeterministic Path 2 (MAJOR-2). Minors: §10.11 attribution corrected to item 7's form change (a widening of DEGREE — a blank field already produces a matching channel today), the `root_id` walk must NOT carry the archived filter the ancestor walk does, `seed_pending_at` stamped on both accept arms and cleared on `(org_user_id, applicant_user_id, status='approved')`, and the restricted guard reuses `archiveChannel`'s child query with its two-step residue recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| —     | **PLAN CLOSED** | Rev 10 approved to build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Seven rounds, 82 findings, 3 designs proposed and withdrawn. Implementation starts at P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 12. Implementation log

### P1 batch A — items 1, 9, 10, 14, 17-rename (2026-08-10)

Shipped: the two fork-screen strings plus the two same-flow ones the review found
(`WorkspaceHubScreen`, `IncidentDetailScreen`); the stand-in tab press; the Broadcast card
and all its state/styles; the day-status label fit; and the rename across the dashboard title,
BOTH `· Department` subtitles, and the channels directory header + subtitle.
**Root cause of item 9, confirmed in code:** `ObsidianTabBar` aliases `focused` onto the
stand-in while a hidden route is active, so the press guard treated HOME as already focused
and swallowed it — HOME was dead from everywhere inside the workspace.

**Review:** critic REVISE (1 functional gap — item 1 at half scope; 3 items with no
regression test; 1 gate traded down) + edge-case GAPS(14). All folded. Both agents
independently confirmed the tab-bar change is correct across all three consumers and that
item 10's deletion is consumer-clean (the dropped `listChannels` call was a pure read with no
provisioning or hydration side effect).

**Tests added, each mutation-proved individually** (a batch mutation script matched the wrong
site and produced a false green — the CLAUDE.md hazard, caught by verifying the mutation
applied): item 1 word-scan across four screens, item 10 surface-anchored absence
(`bullhorn`/`ANNOUNCEMENTS`, not a setter name), item 14 style shape, item 17 title +
subtitle absence, and four tab-bar press cases including the hidden-stand-in and
no-stand-in configs.

**Re-anchored, never deleted:** `channelHierarchyGrouping` (site floor 3→2; the access-only
rule flipped to a flat absence after the first replacement was proved vacuous),
`nestedNavigationInitialFlag` (roll-call minus the removed site), `enterpriseTerminology`
(canary moved off the renamed title), `joinCtaReachability` (its marker relied on the header
NOT being "Channels" — now `Unread`).

**Also fixed, same class, found by the sweep:** the three attendance action buttons overflow
at fontScale ≥1.15 on 320dp; day-status cells go one-up below 350dp because two-up cannot fit
"Emergency leave" at 1.3. QA plan DCN-06 corrected and DCN-27 retired — both instructed
testers to verify the card this batch removes.

**Carried into batch B (edge G1, verify before building):** `DepartmentChatScreen` sets
`tabBarStyle:{display:'none'}`, so there is no HOME button at all while a channel thread is
open. The client's most natural re-test of item 9 therefore still shows no Home button — and
the deferred stack-reset's draft-persistence prerequisite exists to protect a composer in
exactly the state from which HOME cannot be pressed. Re-check that premise first.

**Gates:** app 1492 · messenger screens 327 · crypto ×2 (run 2 clean 4289/4289; run 1 had zero
failing tests — B-126 flake) · booking 647 · tsc 42 ≤ 47 · lint 0 errors.
**Owed:** device pass at 320dp / fontScale 1.3, and the founder questions in §10.

### P1 batch B — item 11, and item 9's follow-on (2026-08-10)

**The W1 / MI-06 draft-persistence prerequisite is formally WITHDRAWN.** Premise verified in
code: `DepartmentChatScreen.tsx:217-221` sets `tabBarStyle:{display:'none'}` on the parent TAB
route, `ObsidianTabBar.tsx:52-62` returns null on it, and because the option lives on the tab
route it also holds under anything pushed above the chat and is cleared only on unmount (by
which point the draft is gone anyway). HOME is therefore unreachable while a live composer
draft exists. Channel drafts still not surviving unmount is a real gap next to 1:1 chat, but it
is not the client's ask and not a blocker — logged, not built.

**The stack reset was built, reviewed, and REVERTED — the most important outcome of this
batch.** Edge review proved the safety argument covered only the chat screen: HOME _is_
pressable from Attend / Incident / Vault and from the non-chat Channels forms, none of which
hide the bar and none of which has a `beforeRemove` guard. `popToTop` would have silently
discarded a hand-picked 62-day day-status batch (`DayStatusScreen`, cap 62), a geofence a
manager had physically walked to capture (`ShiftEditorScreen`), a mandatory audited correction
reason, and the invite/join/channel-editor forms — one tap, no confirmation, no recovery. It
was also incomplete: it popped only the module you were in, while the Messenger tab and the
Home header chevron reset nothing, so the re-entry complaint it targeted survived anyway.
**Decision: keep batch A's press fix (which is the client's actual ask) and drop the reset.**
If "re-entering a module resumes where I left it" is ever reported, fix it on the ENTRY side —
each Home card naming its module root, the R11-6 precedent in `departmentalEntry.ts` — which
covers all three exits and discards nothing the user is still holding.

**Item 11 shipped**, then corrected twice by review: the composer ROW is centred (an earlier
revision flipped it to `flex-end` on a mis-citation — `inputWrap` is ChatScreen's PILL; its row
`inputBar` is centred, so B-197's row rule was right all along and is RESTORED, not retired);
only the pill is `flex-end`. The growth cap is now DERIVED (`COMPOSER_MAX_LINES × lineHeight`)
because a literal dp cap is scaled by neither `scaleTextStyles` nor the OS font scale and
sliced the last line in half at fontScale 1.3 — the same defect the item is about. Net B-197
supersession is therefore ONE assertion (`minHeight: 38`), not two.

**Also fixed by review:** the emoji control was an 18dp touch target with no hitSlop, and the
test that claimed to guard the ≥44dp rule was a file-wide `toMatch(/hitSlop/)` satisfied by any
one control — now a count over all four. Both scans over `DepartmentChatScreen` moved to the
line-anchored stripper (`sourceScanSafety` KNOWN_HAZARDS: the greedy form eats ~116 lines via a
wildcard MIME literal). Item 11's pins moved into `deptComposerMetrics.test.ts` so they run
inside the messenger gate. The hidden-`standInTab` guard is now a `__DEV__` warn with an
asserted test — the filter alone was provably inert and its first test passed with the code
reverted.

**Open, deliberately not fixed here:** the incident draft does not persist captured `coords`,
and a location-only step-2 visit saves nothing at all (the non-empty guard ignores coords) — a
pre-existing evidentiary-correctness bug worth its own fix. Cross-composer parity: 1:1 chat
still has the older, smaller box; the client's "WhatsApp-sized" complaint arguably applies
there too — founder call.

**Gates:** app 1496 · messenger screens 330 · crypto ×2 both clean (4289/4289) · booking 647 ·
tsc 42 ≤ 47 · lint 0 errors.

### P1 batch C — items 3 and 15 (2026-08-10)

Taken out of phase order deliberately: both are self-contained and neither depends on the §10
founder questions, unlike the rest of P2/P3.

**Item 3** — the invite form moved to `KeyboardAvoidingScreen` with the CTA in the footer slot.
The shell gained an optional `footerGap`, so the inset arithmetic lives in ONE place instead of
being copied into the screen; it composes `keyboardOverlap` with `useBottomInset().bottomPad`,
which also fixes a latent double-count the old local formula had in the CPO shell (it keyed on
"am I in the Departmental shell?" when the real question is "is a tab bar below me?").
Verified by review across all three mounts. Bonus: the CTA now sits OUTSIDE the ScrollView, so
it fires on the first tap with the keyboard open instead of the tap being eaten as a dismiss.

**Item 15** — the member's Incident root is the category grid. Three knock-ons the review
caught, each a real defect:

- The grid is now the ROOT, so it never unmounts and the finished report's category/severity
  stayed selected — the next report would have been silently pre-categorised. Reset added, and
  then NARROWED to fire only after a submit (`markIncidentSubmitted` / `consumeIncidentSubmitted`),
  because clearing on every focus also wiped the selection when a user backed out of step 2 to
  change it.
- "Done" popped to a root that is now a blank new report, while the screen's own copy says to
  follow the report in your submitted reports → pops, then opens My Reports.
- Dropping the Home card's nested-screen param was WRONG in both directions: the R11-1 scan
  went red, and behaviourally Done deliberately leaves that stack on My Reports, so "Log an
  incident" would have opened the reports list. Restored WITH `initial: false` — inert for the
  member root, but the rule is repo-wide and carving out a "provably inert" exception is how
  blanket invariants rot. (My own tab-bar comment in batch B documents exactly this hazard;
  I contradicted it one file away.)
- "My reports" needed a home — a row above the category grid, or members lose their history.

**Also fixed by review:** both incident screens now type against `DeptIncidentStackParamList`
(the stack that actually hosts them) instead of a hand-rolled intersection over the Agent list,
and my "dual-mounted" comments were simply false; the Done pin asserted the ordered pair after
the first version stayed green with `popToTop()` deleted; `footerGap` guards `null`/`false` as
well as `undefined`; the contact-picker sheet takes `bottomPad(16)` (it was under-padding by
~48dp on 3-button Android — it is a sheet inside a Modal, which covers the bar); and four stale
**P0** QA rows (DCN-07, INC-01, INC-17) that would have had a tester logging false bugs.

**Open, recorded:** the `incident-status` push targets the REPORTER but routes to the channels
directory — pre-existing, and item 16 (P5) is where it gets fixed. Android hardware-back from
IncidentSubmitted still pops to the grid, so the "Done lands on My Reports" promise is
button-only.

**Gates:** app 1500 · messenger screens 330 · booking 647 · tsc 42 ≤ 47 · lint 0 errors ·
crypto: runs 1 and 4 clean 4289/4289, runs 2 and 3 failed with DIFFERENT counts (19, then 3) —
moving failures with no file of mine in that project, i.e. the B-126 flake.

### P5 item 16 — incident notification (2026-08-10) · MIGRATION + DEPLOYED

**Shipped:** the banner now reads "{org}: incident reported / Reported by {name}. Tap to
review." and the tap opens the incident. Server: `incidentSubmitted` carries
`incidentId`/`orgName`/`reporterName` (blanks omitted); `incidentStatusChanged` carries the id;
a nullable `notifications.incident_id` column so the DURABLE lane can route, not just the
5-minute Redis blob. Client: the banner is composed per event with a fallback to neutral copy,
and "A CPO filed an incident" is gone from both the push and the in-app bell — the client's
explicit ask, since not every organisation has CPOs.
**Migration** `20260810120000_notifications_incident_id.sql` applied to the staging Supabase DB
(column verified) BEFORE the service deploy — mandatory ordering, because the INSERT now names
the column for every notification kind, so a service running ahead of the migration silences
the entire durable bell lane app-wide.

**THE LESSON OF THIS BATCH — I shipped item 16 broken, twice over, and the suite was green.**
Review found two independently fatal defects in code that was already deployed:

1. **The naming query selected `users.full_name`. That column does not exist** (it is
   `display_name`). Postgres raised 42703 on every submit, a bare `catch {}` swallowed it with
   no log, and every banner fell back to generic copy — the headline requirement dead in 100%
   of cases. Invisible because **no test in this repo executes SQL** (the 2026-08-04
   mocked-audit blind spot, again) and the new client tests feed the names in directly. Now
   fixed to the canonical `COALESCE(w.name, o.display_name)`, the catch logs, the service
   finally has a Logger, and a comment-stripped SOURCE SCAN pins the column names — mutation-
   proved by restoring `full_name` and watching it go red.
2. **The tap could not work for managers or CPOs.** I routed through a new
   `departmentalEntry` ladder, but those walk `getParent()` from the object they are handed,
   and a push hands them the container REF — no parent, root state only. Every branch except
   the client-only `MessengerTab` one was unreachable, so the two personas the feature exists
   for got a silent dead tap, and for a CPO it was a REGRESSION (the old `CpoMission` candidate
   did land somewhere). This is the B-258 class the `messengerDeepLink` table was written to
   kill — and the `as never` cast erased the `ResolvableNavigation` contract that would have
   made it a compile error. Fixed by adding incident targets to that per-shell table
   (agency/CPO → `Departmental → Incident → leaf`; client keeps the MessengerTab hop), deleting
   the unusable ladder, and adding the four shell tests it never had.

**Also fixed from the same review:** the submitter is now excluded from the fan-out (a solo
agent was pushing to themselves, and once the names worked the banner would have read "Lerato
M: incident reported / Reported by Lerato M"); the cold-start poll waits for the destination,
not just `isReady()` (which flips true while the Auth tree is still mounted); and the routing
log is a `warn`, because `transform-remove-console` strips `log` from release builds and this
lane's failures are otherwise undiagnosable on device.

**Round 2 of the same review found four more, all folded:**

- **The id-less fallback sent MANAGERS to the member's own-reports list** — a permanently empty
  screen, on the path that fires whenever the 5-minute blob is missed (killed app, Doze, Redis
  down, old server). Now branches on AUDIENCE first: `incident-submitted` → `IncidentQueue`
  without an id, `IncidentDetail` with one; `incident-status` → `MyIncidents`.
- **The durable chain is now COMPLETE.** `incident_id` was write-only: the HTTP mapper, the
  client DTO, the store row and the bell's tap handler each dropped it, so the migration bought
  nothing. All four hops wired, with a four-part test that mutation-proves the mapper hop —
  the one that dropped it first.
- The submitter-exclusion change (unplanned, and it silently gives a solo agent no notification
  at all) is now pinned by tests rather than riding along unasserted.
- The routing log reports the RETURN VALUE: the readiness loop can time out and fall through,
  and `transform-remove-console` strips `log` from release builds, so a `warn` carrying
  `routed=false` is the only on-device evidence this lane can leave.

### P4 item 13 — the one attendance dashboard (2026-08-10)

**DELIBERATE DEVIATION FROM §5, disclosed:** the plan called for extracting each screen's body
into a shared component (~1,900 lines across five files). Instead each of the four screens took
an optional `embedded` prop that suppresses its own StatusBar/AmbientBg/ObHeader/safe-area
padding, and `AdminAttendance` renders the selected one inline under a segmented bar
(Review · Shifts · Day status · Roster · Corrections; Review first, so the screen still opens
where it always did). Same user-facing result, a fraction of the churn, and the standalone
routes keep working — which matters because the pending queue deep-links Corrections with a
session. **Second deviation:** the queue became the first SEGMENT rather than sitting below the
host, because a `flex: 1` embedded body cannot share a scroll container with it.

**Review found 9 + 14 findings; the ones that were real bugs:**

- **The Corrections editor was a one-way door when embedded.** `closeEditor`'s only caller was
  the ObHeader the segment suppresses — open the wrong session and there was no back, no
  cancel, and (as the Attend stack's initial route) nothing to swipe back to. This is exactly
  what change-safety rule 8 is for: I checked who consumed the deleted _routes_ but not who
  consumed the deleted _header_.
- **Day status' save called `goBack()`** — embedded that bubbles to the tab navigator and drops
  the manager on the workspace Home dashboard, with no success message anywhere.
- **The roster CTA could not close its own loop.** Both roster-dependent screens loaded with
  `useEffect`, and the tab never unmounts — so after adding a member the admin returned to the
  same "no members yet" empty state and the same button. Now `useFocusEffect`.
- **`openEmployees` re-opened R8-5:** `Employees` is ALSO registered on MessengerNavigator, an
  ancestor of the shell on the client/CPO entry paths, so a direct-first walk pushed the roster
  full-screen OVER the workspace — and only on some entry paths. Tab hop now wins inside the
  shell, mirroring `openJoinFlowScreen`.
- **The client's literal sentence was unaddressed.** "Shown how to add a member TO A SHIFT" —
  a shift with nobody on it silently blocks every check-in and said so only as the neutral
  metadata "0 assigned". It now states the consequence and points at the fix.
- Plus: embedded roots painted over the host backdrop; `maxHeight: 52` clipped the segment bar
  at fontScale ≥1.3; two later segments were unreachable at 320dp; the host's stats and header
  pill froze across segment switches; the roster's day-tap still navigated out of the
  dashboard; the segment pills had no accessibility label (found by writing the render test).

**Tests:** a real RENDER test (`attendanceDashboard.test.tsx`) — the reviewers were right that a
source scan cannot tell a working segment bar from a typo'd one; mutation-proved by wiring a
segment to a bad key. Plus four behavioural `openEmployees` cases mutation-proved against the
R8-5 ordering. The existing scan was re-anchored twice (it pinned the deleted cards, then my own
later prop changes).

**Gates:** app 1522 · booking 647 · tsc 42 ≤ 47 · lint 0 errors. QA plan rows updated (they
still told testers to tap the four deleted cards).
**Open:** in-progress form state is discarded on a segment switch — acceptable when these were
routes you deliberately left, more surprising now that switching is one tap. Recorded, not
fixed.

**Still open, recorded honestly:** the live wake row says "Reported by X" while a server-
backfilled row of the same event shows the generic copy — a user can see both. And `logAudit`'s
ban list carries no PII patterns, so nothing would stop a future `console.log(data)` in this
lane from printing a reporter's name; adding `reporterName`/`orgName` to that list is cheap
insurance. Privacy posture itself verified sound: the FCM wire still carries only
`{userId, eventClass, eventId}`, and the names live solely in the recipient-bound Redis blob
and the JWT-gated hydration route.

**Gates:** auth-service 2524 · app 1500 · booking 647 · messenger deep-link 58 · tsc 42 ≤ 47 ·
staging health 200, 0 errors, compiled bundle verified to contain the corrected query.
**Deploy note:** `~/bravo/auth-service` is a STALE tree (missing whole modules); the real build
context is `~/bravo/apps/auth-service`. One file was written to the stale one before that was
discovered — inert (no compose file builds from it) but present.

### P2 item 2 — hierarchical team picker (2026-08-11) — server + helper + screen

Built in three batches, then revised through two full critic + edge-case rounds.

**P2-a, server.** `listChannels` now emits `parent_hidden`, `visible_ancestor_id` and
`root_id`. Three `LEFT JOIN` ancestor hops (`a1/a2/a3` — `level` is CHECKed 0..3, so three is
the whole tree and no recursive CTE is invented), plus two `LEFT JOIN LATERAL`s: `av` answers
"is this hop reachable" (live **and** a member) once per hop, and `tf` derives the walk so the
projection can gate on its result. `listOrgChannels(orgUserId, managerDepartment)` adds
`mintable_by_me` and emits the tree fields explicitly as `false/null/null`.
`DepartmentService.mintRefusalFor` is the one mint predicate, consumed by both the throwing
caller and the projection.

**P2-b, `src/screens/deptchat/organisationTree.ts`.** The shared grouping rule: the 5-case
`placeRow` switch, `organisationRootsOf`, `childrenOf`, `subtreeOf`, `ancestorPathOf`,
`hasHierarchy`, `mintDisabled`, and the shared copy constants. Its gate is the round-trip
property test — `organisationRootsOf(rows) ∩ visible === organisationRootsOf(project(rows))`
over nine structurally distinct subsets — because the failure this helper exists to prevent
(admin and member views disagreeing about what an organisation is) cannot be seen by asserting
either view alone.

**P2-c, `InviteMemberScreen`.** Stage 1 organisations → stage 2 that organisation's subtree,
breadcrumb on the confirm card, `Whole workspace (all organisations)` as the escape hatch.

**Deliberate deviations from this plan, with reasons.**

1. **A flat workspace skips stage 1 entirely.** Every existing workspace IS flat
   (`seedOrgWorkspace` writes no `parent_id`), and a two-stage picker over a pile of one-item
   organisations is strictly worse than the radio list it replaces. The tree appears only where
   a tree exists.
2. **ARCHIVED rows are pre-filtered, against "group first, disable second".** That rule needs
   the dropped row to have LIVE children; an archived row cannot have any (archive refuses
   while an active non-broadcast child exists, create refuses an archived parent), so it is
   always a leaf among live rows and dropping it orphans nobody. Restricted and incident rows
   are still grouped-then-greyed, which is what the rule was actually written for.
3. **`mintRefusalFor` also rejects `#broadcast`** (`team_channel_is_broadcast`, new code, client
   copy added). The plan parked this exclusion client-side; that left the server accepting a
   broadcast as a `team_channel_id` for any direct caller, and made the field's claim to be the
   full refusal untrue.

**Defects found by review and fixed in this batch (three rounds, two reviewers each).**

- **BLOCKER, security.** `root_id` was emitted unconditionally, handing a caller whose parent is
  VISIBLE the uuid of an invisible ancestor — the exact leak the `parent_id` mask closes,
  reopened one hop up. Now gated to the only case that consumes it.
- **Compat blocker.** `hasHierarchy` keyed off `parent_id`, which the PRE-vs2 server already
  emits, while `placeRow` keys off `parent_hidden`, which it does not. Old server + a real
  hierarchy told an admin "No organisations yet" and left the whole-workspace grant as their
  only option. Both now key off the same field.
- The `parent_id` mask was membership-filtered but not archive-filtered while the walk was
  both, so a row under an archived-but-member parent rendered nowhere. One shared predicate now.
- `assertMintableTeam`'s `managerDepartment` defaulted to null — a fail-open that let
  `createReferralLink` skip the branch check by omission. Now required and passed explicitly.
  **The referral lane's permission gap is unchanged and deliberate; it is §10.11's decision.**
- Three tests that could not fail: a `root_id` archive assertion whose slice began after the
  point a filter would be written; an RNTL press on a disabled element (a no-op, so it proved
  nothing); and a subtree test that only ever drilled into the FIRST organisation, so
  `subtreeOf(rows, orgId) → subtreeOf(rows, orgs[0].id)` survived the whole suite.
- A comment that stated the OPPOSITE of its assertion (item 7's post-relaxation semantics above
  a pre-relaxation `expect`), which would have had the next reader either skip item 7 or widen
  a permission boundary to match the prose.

**`test/integration/channelTree.itest.ts` is NEW and HAS NEVER RUN** — Docker was unavailable on
this machine. It exists because the mocked-DB specs can only assert SQL _text_, and the one
defect that mattered most here (the `root_id` disclosure) is invisible to text assertions. This
repo has already shipped a query naming a column that does not exist, past a green suite, for
exactly this reason. **Run `npm run test:integration` in `apps/auth-service` on a Docker-capable
machine before trusting this query.**

**Gates:** auth-service 139 suites / 2548 tests green · app deptchat 24 suites / 431 green ·
tsc 42 ≤ 47 · every new assertion mutation-proved individually (13 mutations; the two that
survived are recorded above and were fixed).
**Not done in this batch:** item 7's relaxation (P3, and it will flip one pinned assertion in
`mintableTeamSingleSource.spec.ts`), and all of P2-d — path-scoped seeding, the `team_parent_id`
breadcrumb, `seed_pending_at`, and the restricted-root producer guard. The server seam is NOT
closed yet.

### P2-d — path-scoped accept-time seeding (2026-08-11) · MIGRATION APPLIED

Accepting an invite seeded the joiner into EVERY eligible channel in the workspace and
discarded the team the admin picked — which made the picker built in P2-c decorative, and
with more than one organisation per workspace made every join a cross-organisation grant.

**`apps/auth-service/src/department/seed-path.ts` (NEW)** — `resolveSeedScope(rows, teamId,
teamParentId)`, a PURE function returning `orgWide | scoped{ids, fellBackTo} | dead`. Scope =
the team, its ancestor chain, its whole subtree, and any `#broadcast` whose own chain lies
inside the set. Pure on purpose: the rule is four interacting graph decisions, and expressed
in SQL it would be untestable here (no unit test in this project executes SQL — the blind spot
that shipped a live defect two weeks ago).

**The fallback.** Trigger is SURVIVAL — `archived OR missing OR seedsManagersOnly` — not
"archived or missing". `configureChannel` can tighten a team to restricted AFTER the invite is
minted and mintability is only checked at mint, so without the third clause the fallback never
fires and the seed loop silently skips the team the person was invited to. The walk climbs PAST
managers-only rungs rather than stopping on one, and seeds the surviving ancestor's CHAIN only
— never its subtree, which would grant sibling teams the invite never expressed. A wholly dead
chain REFUSES the accept rather than admitting a member who can see nothing.

**`team_parent_id`, and the bug it nearly didn't fix.** `team_channel_id` is
`ON DELETE SET NULL`, so a deleted team arrives as `teamId === null` — identical to "no team
was ever chosen". My first version returned `orgWide` on `!teamId` before ever consulting the
breadcrumb, which would have made the whole column inert: written at mint, read at accept,
changing nothing, with every deleted team quietly becoming a whole-workspace grant. The gate is
now `!teamId && !teamParentId`, pinned by its own test.

**Both lanes resolve INSIDE the transaction.** `acceptInvite` before its claim; `decideJoinRequest`
after its claim but still in-tx — the rule needs the ROLLBACK, not the ordering, and the claim's
own `RETURNING` already carries the team, so that placement costs no extra query. A throw rolls
the claim back either way, which is what keeps the invite usable after a re-issue.

**`seed_pending_at`** is stamped in-tx on both approval arms and CLEARED by the seeder only on a
complete seed (zero per-channel failures AND, when candidates existed, at least one row seeded).
The loop swallows per-channel failures and returns normally, so a naive clear-at-the-end would
clear the flag after 4 of 5 channels failed — the exact partial state the marker records. Read
by `GET /enterprise/seed-pending`, branch-scoped: an unread column is the same silence in a new
place.

**Producer guard (E5), both steps.** `configureChannel` refuses tightening a ROOT WITH ACTIVE
CHILDREN to managers-only (two taps in the editor otherwise strip the whole workforce out of the
organisation root and leave each of them with a directory containing no organisation);
`createChannel` refuses a child under an already-restricted ROOT, which is the same end state
reached in two moves. Scoped to roots WITH children deliberately — every channel in every
pre-hierarchy workspace is parentless, so a bare `parent_id IS NULL` predicate would forbid
Restricted on all of them and, since re-parenting is trigger-refused, permanently. The child
count is the SHARED `activeChildCount` helper, because the archive guard asks the identical
question.

**DELIBERATE BEHAVIOUR CHANGE the founder should know about.** In an existing FLAT workspace
(all four seeded channels parentless), an invite naming one team now seeds THAT team plus
covered broadcasts — not all four. That is the client's ask ("the invite places them in the team
they join"), and the admin who wants the old behaviour picks the escape hatch, which P2-c
renamed to say exactly what it grants. But it changes what every existing workspace does on the
next join, so it is recorded here rather than buried.

**Client copy added** for the new refusal on both surfaces: `ApprovalsScreen` (admin approving)
and `inviteAccept` (joiner redeeming). Without it a deterministic 409 reads as "check your
connection" and the user retries forever.

**Migration `20260811100000_invite_path_scoped_seeding.sql` — APPLIED to staging** (both columns
verified present). Additive and nullable; the code must not deploy ahead of it.
**Gates:** auth-service 140 suites / 2571 tests · app deptchat 25 / 456 · booking 647 · tsc 42 ≤ 47.
Five mutations of the scoping rule each killed tests (breadcrumb ignored, fallback over-granting
the subtree, survival weakened to existence, dead-chain silently org-wide, broadcasts always
riding along).

#### P2-d review round 1 + staging deploy (2026-08-11)

Two reviewers on the first P2-d commit: **one blocker, five majors, one deploy hazard.**

- **THE BLOCKER — I shipped this repo's signature defect after naming it in my own commit
  message.** `resolveSeedScope` guarded `!teamId && !teamParentId`; `resolveSeedScopeInTx`, its
  only real caller, still guarded `!teamChannelId` alone. `team_channel_id` is
  `ON DELETE SET NULL`, so a deleted team reaches the caller as null with only the breadcrumb —
  and the caller returned org-wide before the pure function was ever entered. The migration, the
  column and both mint-site writes were **inert on the exact lane they were built for.** Right at
  the layer examined, absent one layer out.
- **Archived rows are walk SCAFFOLDING.** The in-tx read filtered them out, which makes an
  archived ancestor untraversable rather than merely unseedable — the climb hits `undefined`,
  stops, and reports a dead chain while a live grandparent sits directly above it. Two ordinary
  taps reach it.
- **`#broadcast` is LEVEL-scoped, not branch-scoped.** The chain test read as the careful choice
  and was measurably wrong: one broadcast exists per level for the whole org, parented under
  whichever node created the first channel at that level. Two members at the same level received
  DIFFERENT announcement channels by creation order, so half an organisation silently stopped
  receiving org-wide announcements.
- **`unarchiveChannel` was the third door** into "restricted root with active children" — a rule
  enforced on two of its three doors is not enforced.
- **Manager invites** were judged by the EMPLOYEE survival rule, producing a false `dead`.
- **`seed_pending_at` could never be cleared** — a listing with no verb, and neither accept lane
  is replayable. Added `POST /enterprise/seed-pending/:userId/reseed`.
- **The migration header lied** ("a server running ahead of this migration behaves as it does
  today"). Code-first returns 42703 on invites, referral-links, accept, approve AND decline —
  onboarding fully down. Rewritten as MIGRATION FIRST, MANDATORY.

**Root cause of the blocker: the invite lane had ZERO service-level coverage.** Every existing
`acceptInvite` test left `team_channel_id` null and took the org-wide early return, so the scoped
path was exercised only through a pure function its real caller bypassed. Four service cases
added, plus two for the unarchive door; two seed-path cases flipped for the broadcast rule.

**DEPLOYED AND VERIFIED on staging** (`a36ae425`), migration-first:

- migration applied, both columns confirmed present;
- running container carries `addOrgBroadcasts` and `reseedMember` and **no** `addCoveredBroadcasts`
  (the replaced rule) — i.e. the post-review build, not the first commit;
- both new routes present in the Nest boot map (`GET /enterprise/seed-pending`,
  `POST /enterprise/seed-pending/:userId/reseed`), 412 routes total, health `healthy`, no errors.

**Still owed:** an APK for the client copy (devices on vc260 show the generic "check your
connection" for `team_channel_unavailable_reinvite`), the flat-workspace picker warning
(edge E1), a client consumer for the seed-pending list, and `ChannelEditorScreen` copy for the two
new refusal codes (it currently renders the raw snake_case string).

### P3 server + item 7's form (2026-08-11) — `74f81025`, `f14b0086` · NOT DEPLOYED

Items 5, 12, 7 and item 8's `root: true`. A new workspace starts clean, nothing is auto-added
beneath a main channel, the create form drops DEPARTMENT/TYPE, and "+ Create new organisation"
mints a real level-0 root. **Every change is workspace-tenant-gated**; the agency tenant is
untouched, because agency `department` values are the live scope key for attendance (13 handlers)
and the incident fan-out.

**The branch-scope question (§10.11) was decided, not deferred.** Item 7 relaxes "a branchless
channel is mintable by any manager" — **workspace only**. The alternative leaves scoped managers
unable to be given ANY new team once the DEPARTMENT field goes. It is the convention the
join/invite file already encodes six times over ("unrouted belongs in every manager's inbox").
The three designs that would have preserved a strict boundary stay withdrawn — see item 7 above
for why each is unsafe; do not re-propose them.

**Defects found by review (two reviewers, one round) and fixed in `f14b0086`:**

- **Three bypasses of the restricted-root rule.** The refusal was keyed on the DTO flag
  (`input.root`), so omitting one boolean produced a parentless restricted root — and every
  existing workspace organisation IS a parentless root. `root: true` itself was not tenant-gated,
  letting an agency mint level-0 rows. And `configureChannel` had no such refusal at all, while
  `createChannel`'s comment claimed it did: a childless organisation could be tightened in two
  taps into something invisible that can never take children.
- **The level-0 broadcast trap went live and was fixed at both ends.** `ensureBroadcastForLevel`'s
  INSERT never stated `level`, so a level-0 call landed at level 1, collided with the per-level
  unique index, was swallowed by `ON CONFLICT DO NOTHING` and no-opped forever — silently. The
  plan called it latent "because no level-0 producer exists"; that was a CLIENT-side claim.
- **My own re-anchored scans were vacuous.** Both sliced on `private async isWorkspaceTenant`
  after the method was made public: `indexOf` → -1, `slice(start, -1)` → the rest of the file.
  Deleting the seed-path call left them green. Every slice in those files now proves itself.
- **The F5 backfill would resurrect a deliberately-deleted #broadcast** on its next manual run.
  Its SQL is unchanged (it is applied; editing it would desync file from database) — the control
  is a DO-NOT-RE-RUN header plus the exclusion clause to add if it is ever re-run.

**⚠️ DEPLOY ORDER, and why this is not deployed yet.** Server-first would re-create the exact
"blank list on first login" symptom that put the seeding call there on 2026-08-05: the server
makes new workspaces empty while items 6/8's directory and dashboard do not exist yet. Ship the
P3 client WITH the server. Within that, **auth-service first, then migration 20260811160000** —
the reverse lets the old unconditional `ensureBroadcastForLevel` resurrect a freshly-deleted
broadcast. `deleteChannel` now translates the trigger's P0001 to a 409 so the window degrades to
a refusal rather than a 500.

**Still owed for P3:** items 6 and 8's screens (`DepartmentChannelsScreen` organisation list +
`Manage Channels` button, new `OrgChannelTreeScreen`, `ManageChannelsScreen` → Create Channels),
the member empty-state copy (edge P3-3), and a dual-tenant probe before deploy:
`SELECT owner_user_id FROM org_workspaces w JOIN agents a ON a.user_id = w.owner_user_id AND a.type='company';`
— expect zero rows (the exclusivity hole was live until this batch closed it).

### P3 client screens + DEPLOY (2026-08-11) — `34995ed9`…`729e01bb` · **DEPLOYED**

Items 6 and 8's screens landed (`OrgChannelTreeScreen`, the two-stage
`ManageChannelsScreen`, the bucketed directory + Manage Channels button), which lifted the
"ship the P3 client WITH the server" gate. Deploy ran in the documented order:

1. **Pre-deploy probes.** Dual-tenant exclusivity `count = 0` (the hole is closed);
   `level = 0` rows `= 0` (nothing pre-existing collides with the new organisation roots);
   broadcasts exist at levels 1/2/3 only. `enterprise_referral_links.team_parent_id` and
   `enterprise_join_requests.seed_pending_at` both present, confirming P2-d is applied.
2. **auth-service FIRST** — source synced from `HEAD` via `git archive`, image rebuilt,
   container recreated, `/health` 200, and the P3 markers verified in the RUNNING
   `dist/` (not just the source tree, which was 5 hours stale).
3. **Migration `20260811160000` second**, and verified by reading the function body back:
   `dept_channel_block_broadcast_delete` now exempts `org_workspaces` owners only.

⚠️ **Probing the staging DB.** `psql` does NOT exist inside `bravo-staging-auth`; the client
lives in `bravo-staging-pg`, whose OWN database is not the one the app uses. The working
form pipes the auth container's `DATABASE_URL` into the pg container's client, and the URL
must be expanded INSIDE the container (`sh -c` + escaped `$PGURL`) or it silently resolves
to an empty string and psql falls back to a local socket as user `root`. The dept-channel
invite tables are `admin_invites` / `enterprise_*` — there is no
`department_channel_invites`, and probing that name reports "not applied" for a migration
that is.

**Review: three rounds, two reviewers each.** Round 1 found the closed-loop `hasHierarchy`
gate, a non-total `directoryBuckets` and an unreachable ARCHIVED list. Round 2 found two
blockers both reviewers named independently:

- **The organisation row had no door.** `isRoot = depth === 0` disabled the top row as
  "structural". None of the three shapes that reach that position are — a `root: true`
  organisation defaults to access `standard` → post_mode `open` and is eagerly provisioned;
  a legacy Main that grows one child lands there; so does a masked mid-tree row. Department
  channels are hidden from the conversation lists, so this screen was their LAST door, and
  its unread kept feeding the header chip while the thread was unreachable.
- **`#broadcast` was unmanageable on a workspace.** `placeRow` classifies broadcasts first,
  so they are in NEITHER stage — and this screen is the only door to `ChannelEditor` in the
  app. The server capability shipped the same day with no client door.

Plus: the second door dropped the first door's entire pre-flight (hydration wait, admin
provisioning, owner key-recovery, `isOwner`) — now one `useOpenDepartmentChannel`; an old
server hid every channel from a workspace admin (`serverKnowsHierarchy`, which lives in
`organisationTree` because a screen-local copy is a second opinion about the tree fields);
unread vanished on the nested path; three unguarded `data.channels` dereferences.

**A widened source scan found a pre-existing gap.** The postMode scan globbed only `.tsx`,
so when the navigate sites moved into `openDepartmentChannel.ts` it went from 3 sites to
ZERO — only its anti-vacuity floor caught that. Widened to `.ts`, it also surfaced
`openConversation.ts`, which has navigated to `DepartmentChat` without `postMode` the whole
time. That one is structurally unable to pass it (it resolves from a store pointer row, not
the channel DTO) and is safe because `DepartmentChatScreen` fails CLOSED on an absent mode
— so it is a NAMED exemption with that fail-closed behaviour asserted, not a silent skip.

**Still owed:** device pass, an APK, and items 17b / 18 / 4.

### Item 17b + item 18 + B-391c (2026-08-11) — **17b DEPLOYED**, device pass OWED

**17 of 18 client items done.** Item 4 (multi-organisation membership) is the only one
left and is blocked on a founder decision, not effort — see §9.

**Deployed for 17b, migration FIRST this time** (the reverse of the broadcast order): the
table is inert without the code, whereas deploying the code first would 500 the new
endpoint on a missing relation. `20260811190000_org_workspace_settings` applied, then
auth-service rebuilt from HEAD. Verified live: the FK points at `users`, an AGENCY org row
is accepted (probe inserted and deleted — that insert was structurally impossible under
the original schema), RLS on, both routes answer 401 unauthenticated, clean boot log.
Staging had 15 workspaces and 11 active agencies at deploy time; the FK fix is what lets
those 11 use the feature at all.

**The 17b review found the feature was dead for agencies while being fully offered to
them.** `assertManagerOrg` mirrored `OrgManagerGuard`'s arms except the FIRST — the active
company agent — and the PK/FK pointed at `org_workspaces`, which `createWorkspace`
explicitly refuses a company agent. Agency owner → permanent 403; its delegated manager →
unhandled 500 from a raw FK violation. Also: GET and PATCH resolved the caller's org
_differently_, so an employee of A who manages B loaded A's toggles and saved them onto B;
the owner arm dropped the guard's lapse check; a department-scoped manager could make an
org-wide change; and a failed load in the sheet rendered "everything shown" with Save
enabled, so one tap un-hid both modules org-wide.

⚠️ **A spec I wrote would have gone red in CI** — `fs.globSync` is Node 22+, CI pins Node
20, and it passed locally only because this machine runs v24. The house pattern for a tree
sweep is `git ls-files` (`sourceScanSafety.test.ts`). Check the Node floor before using a
new `node:fs` API in a spec.

> ⚠️ **DEVICE PASS OWED — nothing below has run on hardware.** No device was reachable at
> deploy time (BlueStacks not running, no phone attached), so this is unverified, not
> passed:
>
> 1. **Car Bluetooth (B-391c)** — needs a real car. Three causes have now been fixed on
>    this one symptom with zero in-car testing. Capture both `startSco:` and
>    `[RNCallKeepModule] setting audio route: Bluetooth`, and exercise an engine-restart
>    mid-call, which is the drop B-391c specifically fixes.
> 2. **Three navigation lanes that went LIVE this session** and had never once executed:
>    a department channel tapped from Messenger Home / Groups / Links; ActivityCenter's
>    incident rows; the workspace Messenger exit on all three shells.
> 3. **Item 18** — drawer row moved/renamed, switch confirmations, back-at-root exits, and
>    a group call restored after a product switch (it previously had no End button).
> 4. **Item 17b** — hide each module and confirm all four surfaces drop it, that a push
>    into a hidden module still opens, and that an agency admin can now save.
