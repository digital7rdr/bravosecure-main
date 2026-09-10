# Bravo Channels vs2 — Critical Review + Edge Cases + Call Investigations (2026-08-13)

**Source:** `Bravo Channels vs2.pdf` — "Bravo Enterprise App Review | 9 August 2026" (client, 18 items).
**Baseline verified against:** `main` @ `832651e8` (current working tree; every line ref re-grepped today, not copied from the plan doc).
**Method:** four parallel read-only agents — (1) item-by-item code verification, (2) adversarial edge-case
hunt, (3) Lite-booking Ops Room group-call trace, (4) VoIP symptom investigation — findings merged here.
**Companion docs:** `docs/planning/BRAVO_CHANNELS_VS2_PLAN_2026-08-10.md` (design history, 7 review rounds),
`sqa.md` (bug log). **This document proposes fixes in prose only — no code was changed.**

---

## Verdict at a glance

| Part                             | Result                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18 PDF items                     | **18/18 implemented** in current code. 0 missing. 3 carry _documented deliberate deviations_ (items 9, 18, 2/8 — see Part 1 notes).                                                                                                                                             |
| Edge cases                       | **4 Major + 5 Minor gaps** found, all in the _seams between_ items (push-tap org context, tenant flag on the agency surface, unreachable Delete). No Critical. The historically-shipped-broken classes (empty states, rendering totality, keyboard) probed **clean** this time. |
| Lite-booking Ops Room group call | **Works in code for all three roles both directions** (client / agency / CPO) as of the B-414→B-433 chain — but **zero end-to-end device verification**, and key-delivery timing is a real availability gate.                                                                   |
| VoIP symptoms                    | Echo + volume asymmetry are **already root-caused and fixed on an unmerged branch** (`origin/fix/calling-b419-b427`, device-measured). Freeze = the open JS-thread stall class. "Verifying ID" freeze = **BiometricGate, a new unlogged bug candidate**, not the call stack.    |

---

# Part 1 — Item-by-item verification (the 18 PDF asks)

Every item was checked against its FULL requirement in current source. "IMPLEMENTED" below means the
client's ask is satisfied; "deviation" means the shipped behaviour intentionally differs from the PDF's
literal wording, with the rationale recorded in the repo at the cited site.

| #   | Ask (condensed)                                                                         | Verdict                                              | Key evidence (current tree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "company" → "organisation" on the fork screen + flow                                    | **IMPLEMENTED**                                      | `EnterpriseSetupScreen.tsx:90,104,120,129`; `WorkspaceHubScreen.tsx:222-223,363,383`; `IncidentDetailScreen.tsx:97`; pinned by `enterpriseOnboarding.test.ts:258`                                                                                                                                                                                                                                                                                                                                              |
| 2   | Hierarchical invite picker, full path recorded, path-correct placement                  | **IMPLEMENTED**                                      | Two-stage picker `InviteMemberScreen.tsx:67,149,470`; breadcrumb via `ancestorPathOf` `:172-182`; per-row `mintable_by_me` from ONE server predicate (`department.service.ts:639-699,1244,1309`, pinned by `mintableTeamSingleSource.spec.ts`); path-scoped seeding `apps/auth-service/src/department/seed-path.ts:117-146` + both accept lanes in `enterprise-join.service.ts` + migration `20260811100000_invite_path_scoped_seeding.sql`                                                                    |
| 3   | Keyboard never covers the invite form                                                   | **IMPLEMENTED**                                      | `InviteMemberScreen.tsx:335-338` wraps in `KeyboardAvoidingScreen`, CTA in pinned footer (B-184 rule)                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Multi-organisation membership + switcher + per-org scoping                              | **IMPLEMENTED** (recorded limitation)                | Migration `20260812090000_multi_org_membership.sql:57` drops the one-org constraint (CPO employment stays exclusive by design `:61-63`); switcher `WorkspaceHubScreen.tsx:144-209`; `X-Org-Context` narrows-never-grants (`api.ts:39-104`, `org-context.ts:21-90`, specs). **Self-reads (my shifts / my reports) stay cross-org but employer-labelled** — a recorded founder-visible decision (`crossOrgLabel.ts`), pending context persistence                                                                |
| 5   | No auto-created default channels on new workspace                                       | **IMPLEMENTED**                                      | `department.service.ts:524-537` seeds `[]` for the workspace tenant; `:557-562` skips `#broadcast`; agency arm untouched; legacy `#broadcast` made removable (`20260811160000_workspace_broadcast_removable.sql`)                                                                                                                                                                                                                                                                                              |
| 6   | Blue Manage Channels button + org-first drill-down                                      | **IMPLEMENTED**                                      | Cobalt CTA `DepartmentChannelsScreen.tsx:595-608` (admin-only), cog secondary `:497,904`; sub/sub-sub only after entering a root (`:632-656` → `OrgChannelTreeScreen.tsx:255-258` with `└` connectors)                                                                                                                                                                                                                                                                                                         |
| 7   | Simplified New Channel form + Access below                                              | **IMPLEMENTED**                                      | `ChannelEditorScreen.tsx:267` "Name of channel"; description/type/parent-radio absent on the workspace tenant (`:280-360`); "Top level" placement fact `:292-312`; Access `:51-55,378-389`; server relaxation "branchless = mintable by any manager, workspace only" `department.service.ts:669-698`                                                                                                                                                                                                           |
| 8   | Create Channels flow (org select → dashboard → save/delete/members/archive)             | **IMPLEMENTED** (see edge A4)                        | `ManageChannelsScreen.tsx:201-229` (stage 1 + "Create new organisation"), `:278-319` (full hierarchy, create at any node); Save/Archive/Members in `ChannelEditorScreen.tsx:396-419`; role assign `ChannelMembersScreen.tsx:131-136,205-211`; Delete exists (`:147,234`) **but is unreachable from this dashboard — edge finding A4**                                                                                                                                                                          |
| 9   | HOME returns to the dashboard                                                           | **IMPLEMENTED** (2 sub-items deliberately withdrawn) | Swallow fix `ObsidianTabBar.tsx:144-176` + `obsidianTabBarFocus.test.tsx`. Reset-to-root REVERTED after review (it destroyed unsaved day-status batches / walked geofences — rationale at `ObsidianTabBar.tsx:156-170`); entry-side pop instead (`departmentalEntry.ts:150-159`). Draft persistence withdrawn on a verified premise (chat hides the tab bar, HOME unreachable with a draft open)                                                                                                               |
| 10  | Broadcast card removed from dashboard                                                   | **IMPLEMENTED**                                      | `DepartmentalHomeScreen.tsx:186-187`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | WhatsApp-sized channel composer                                                         | **IMPLEMENTED**                                      | `DepartmentChatScreen.tsx:1639-1643` (6-line growth, font-scale-safe), `:1763-1773` (`minHeight:46`, `fontSize:15.5`, bottom-aligned controls); pinned by `deptComposerMetrics.test.ts`. Note: the 1:1 messenger box is _smaller_; parity there was left as a founder call (plan §12)                                                                                                                                                                                                                          |
| 12  | No auto-`#broadcast` beneath a main channel                                             | **IMPLEMENTED**                                      | `department.service.ts:881-887` (createChannel) + `:560-562` (seeding), workspace-tenant-gated; agency keeps per-level broadcasts                                                                                                                                                                                                                                                                                                                                                                              |
| 13  | One combined attendance dashboard + add-member guidance                                 | **IMPLEMENTED**                                      | `AdminAttendanceScreen.tsx:24-33,137-170` (Review/Shifts/Day status/Roster/Corrections segments); publish + conflicts `MonthlyRosterScreen.tsx:45-73`; empty-roster CTA ladder `DayStatusScreen.tsx:325-334`, `ShiftEditorScreen.tsx:436`                                                                                                                                                                                                                                                                      |
| 14  | "Emergency leave" fits its card                                                         | **IMPLEMENTED**                                      | `DayStatusScreen.tsx:453-459` (one-up cells on small phones, `flex:1`/`minWidth:0`), `numberOfLines={2}` wrap `:244`                                                                                                                                                                                                                                                                                                                                                                                           |
| 15  | Category grid FIRST on entering Incident Report                                         | **IMPLEMENTED**                                      | `DepartmentalNavigator.tsx:190` (member `initialRouteName='ReportIncidentCategory'`); warm-stack landing pinned at `enterpriseOnboarding.test.ts:353-357`                                                                                                                                                                                                                                                                                                                                                      |
| 16  | Incident push: org + reporter, deep-link, never "CPO"                                   | **IMPLEMENTED** (see edge A1)                        | Naming query uses real columns (`incident.service.ts:180-206` — the `users.full_name` defect is fixed and documented); blob `booking-push-bridge.service.ts:410-425`; banner copy `serverWakeNotifications.ts:117-120,310-317`; deep link `fcmBootstrap.ts:1273-1320`. **Single-org managers: works. Multi-org managers: the tap can dead-end — edge finding A1**                                                                                                                                              |
| 17a | "Departmental" header → "Channels"                                                      | **IMPLEMENTED**                                      | `DepartmentalHomeScreen.tsx:136`; absence scan covers BOTH subtitle arms (`enterpriseOnboarding.test.ts:359-366`)                                                                                                                                                                                                                                                                                                                                                                                              |
| 17b | Admin hides Attendance/Incidents per org                                                | **IMPLEMENTED** (device pass owed)                   | Migration `20260811190000_org_workspace_settings.sql` (`hidden_modules`, presentation-never-permission contract); server `workspace.controller.ts:80,99`; client rule `hiddenModules.ts:42-77` (fails open); toggle UI `ModuleVisibilitySheet.tsx`; honored on all four advertising surfaces; 3 pinning suites                                                                                                                                                                                                 |
| 18  | Drawer rename/move, switch confirms, no Choose Dashboard, internal messenger never asks | **IMPLEMENTED** (wording deviation)                  | Rename+move `ProfileDrawerModal.tsx:157-174,251-282`; ONE shared confirm helper `alert.ts:166-179` used by the cross-product switch and the drawer row; **wording is "Go to {destination}?" not "Are you sure you wish to leave X?"** — recorded rationale at `alert.ts:156-161` (the drawer row never leaves the current product, so "leave" would be false there); "Choose Dashboard" removed (`SwitchDashboardSection.tsx:354-358` + test); internal messenger exempt (`DepartmentalNavigator.tsx:476-486`) |

### The three deliberate deviations, and whether to accept them

1. **Item 9 — no stack reset, no draft persistence.** ACCEPT. The client's actual ask (a working HOME
   press) is delivered; the reset was reviewed and reverted because it silently destroyed a hand-picked
   62-day day-status batch and a walked geofence. Re-adding it would re-introduce a data-loss bug to
   satisfy a sentence the client never wrote.
2. **Item 18 — confirm wording.** ACCEPT, but **flag to the client**: the PDF asks for the literal
   sentence "Are you sure you wish to leave X?". The shipped "Go to {destination}?" is more truthful on
   the drawer row (which doesn't leave anything). If the client insists on their wording, change ONLY the
   string in `confirmSwitchDashboard` — it is the single shared helper, so one edit covers every door;
   do NOT re-introduce per-site copies (the repo's most-shipped bug class).
3. **Items 2/8 — connector lines.** PARTIAL-ACCEPT. The member directory tree draws `└` connectors; the
   invite picker and admin dashboard use truthful indentation. If the client pushes back, reuse the
   member tree's existing connector renderer on the other two surfaces — do not write a second connector
   implementation (duplicate-copy class).

---

# Part 2 — Edge-case findings (adversarial agent)

No Critical found: no cross-org WRITE path exists (the write-side header refusal in `org-context.ts:55-90`
and the ModuleVisibilitySheet response-echo check both hold). The gaps are all read-path or reachability.

## Major

### A1. Incident push tap dead-ends for a multi-org manager (items 16 × 4)

**What breaks:** a manager of two orgs gets "Acme: incident reported", taps it, and lands on an empty /
"not found" incident screen whenever Acme is not their sticky/default org context. From a killed app it
fails on every tap for the non-default org (the context is session-only, null at boot).
**Mechanism:** the wake blob carries `incidentId`/`orgName`/`reporterName` but **no org id**
(`booking-push-bridge.service.ts:410-426`); no push-tap path ever sets the active workspace; the fetch is
stamped with the _sticky_ `X-Org-Context`; `detail()` filters `WHERE id = $1 AND org_user_id = $2` → not
found → `IncidentDetailScreen.tsx:51-53` swallows into `setReport(null)`.
**This was known:** the plan's own P7-1 line (`BRAVO_CHANNELS_VS2_PLAN_2026-08-10.md:1200-1203`)
prescribed carrying `org_user_id` in enterprise wake blobs + tap-time context targeting. It was not shipped.
**How to fix without breaking anything (no code here, just the contract):**

- Server: add the org user-id to the enterprise wake blobs (incident + join/approval kinds). Additive
  field — old apps ignore it, so it is compat-safe. Do NOT rename or repurpose existing blob fields
  (the B-411 name_source lesson: push consumers are spread across fcmBootstrap + serverWakeNotifications).
- Client: at TAP time (both the foreground handler and the killed-app cold-boot lane in `fcmBootstrap.ts`),
  if the blob names an org the user is a member of, set the active workspace context BEFORE navigating.
  Route through the existing `setActiveWorkspace` — do not invent a second context writer.
  Guard: if the org id is absent (old server) or no longer a membership, fall back to today's behaviour
  (sticky context) so nothing regresses for single-org users.
- The same fix must cover BOTH lanes: the id-carrying deep link AND the id-less `IncidentQueue` fallback
  (`fcmBootstrap.ts:1313-1319`), or the fallback still lands on the wrong org's queue.
- Regression watch: `X-Org-Context` must remain a narrowing request, never a grant — setting the context
  client-side is safe precisely because the server re-validates membership (`org-context.ts`). Do not
  bypass the interceptor by hand-stamping a header on one request; that creates a second header-writing
  site (duplicate-copy class) and misses the 401-retry path.
- Test: the repo's own convention — a behavioural test on the tap handler with a two-membership fixture,
  asserting the context write precedes navigation; mutation-prove it (delete the context write → red).

### A2. Enterprise join/approval wakes read the wrong org's list (same mechanism as A1)

`enterprise.join.requested` blobs carry only `kind` (`booking-push-bridge.service.ts:455-458`); the tap
opens Approvals stamped with the sticky org. A two-org admin tapping org-B's "join request waiting" reads
org-A's (likely empty) inbox. **Fix: same contract as A1** — same blob field, same tap-time targeting,
same fallback. Land A1+A2 together; they are one bug with two doors.

### A3. User-level tenant flag leaks the workspace UI onto the AGENCY admin surface (items 7/8 × 4)

**What breaks:** an agency company/manager who ALSO owns or joined any Enterprise workspace opens their
**agency's** Manage Channels and gets the workspace-shaped UI: flat agency channels rendered as
"organisation" cards, the "New channel" footer gone, and — worst — the ChannelEditor **drops the
DEPARTMENT and TYPE fields** (`ChannelEditorScreen.tsx:159,280-288,347`), so new agency channels are
created with `department = null`. In an agency, `department` is the live branch-scope key for attendance
(13 handlers), incidents, and invite minting — and a null department also makes the channel mintable by
every manager under the item-7 relaxation.
**Mechanism:** `isWorkspaceTenant` is true for ANY workspace affiliation (`workspaceTenant.ts:51-53`) and
is never narrowed to the org actually being administered; meanwhile the admin list emits
`parent_hidden:false` for every tenant (`department.service.ts:1304-1308`), so the workspace branch
always engages (`ManageChannelsScreen.tsx:114-115`).
**How to fix without breaking anything:**

- Make the tenant a fact about the ORG ON SCREEN, not the user: have `listManagedChannels` echo a per-org
  tenant discriminator (the server already knows it — `org_workspaces` membership is the existing
  discriminator named in the plan's F3 rule). Additive DTO field; absent → fall back to today's
  user-level flag so old-server behaviour is unchanged.
- Client: key `isWorkspace` in `ManageChannelsScreen` / `ChannelEditorScreen` off that echoed fact for
  the org being viewed. Do NOT try to fix it by narrowing `workspaceTenant.ts` heuristics client-side —
  the user-level signal is genuinely ambiguous for the dual-persona case (this exact persona broke the
  Rev-9 tenant predicate too; the repo already learned this the hard way).
- Regression watch: the workspace lanes of items 5/7/8/12 must keep their behaviour — the tenant gate is
  load-bearing in `createChannel`, archive, delete, and the editor form. Run the deptchat suites plus an
  agency-tenant render fixture (the plan §4 already demands an agency-tenant regression test; extend it
  with the dual-persona fixture: agency manager + one workspace membership).

### A4. "Delete" is unreachable from the manage dashboard (item 8)

**What breaks:** the PDF explicitly asks for Delete on the manage flow. The item-8 path
(ManageChannels → ChannelEditor → Members) navigates `ChannelMembers` **without `isOwner`**
(`ChannelEditorScreen.tsx:404`), and Delete renders only under `isOwner`
(`ChannelMembersScreen.tsx:227-238`) — so even the workspace owner never sees Delete on the admin path.
The only door that passes `isOwner` is the chat header (`DepartmentChatScreen.tsx:1042`). Separately, the
server restricts delete to `created_by` (`department.service.ts:1642-1649`), so an owner cannot delete a
delegated-manager-created channel even where the button shows — surfacing a raw-ish
`only_creator_can_delete` alert.
**How to fix without breaking anything:**

- Do not widen the client's `isOwner` guess — compute deletability on the SERVER and echo it per row
  (a `deletable`/`manageable`-style optional DTO flag; the precedent is `manageable?: boolean` in
  `api.ts`). The client then shows Delete when the server says so. Absent field → today's behaviour.
- Decide the actual authority rule first (this is a product decision, one sentence for the founder):
  should the workspace OWNER be able to delete any channel, or only the creator? If the answer is
  "owner too", relax the server check to owner-or-creator **on the workspace tenant only** — the agency
  arm's `created_by` rule predates this review and has its own consumers.
- This is the "capability with no door" shape that already shipped once in this campaign (`#broadcast`
  delete had no client door — see the P3 session record). Route the fix through ONE door decision:
  either pass the server-echoed fact through BOTH doors (editor and chat header), or deliberately keep
  one door and document it.
- Map `only_creator_can_delete` to human copy in the same pass — it is user-visible today.

## Minor

### A5. VBG Home "Secure Services" tile switches product with no confirm (item 18)

`VBGHomeScreen.tsx:338-345` calls `switchProduct('secure', …)` directly — no `confirmSwitchDashboard`,
no `minimiseLiveCall`. The drawer's identical switch confirms. **Fix:** wrap this tile in the same shared
helper + minimise-first path the drawer uses. One-line-class change; the only regression risk is a double
prompt if the tile ever routes through the drawer path later — assert one dialog per press in the test.

### A6. Provider drawer never confirms (workspace row + "Return to Dashboard") (item 18)

`ProfileDrawerModal.tsx:184-185,222,243` — the provider drawer's rows switch surface silently while the
client drawer's identical rows confirm. Possibly intended (plan Q7 was left open); **decide once with the
founder, then make both drawers consistent through the one shared helper.** Do not add a second confirm
implementation.

### A7. Two same-name organisations are indistinguishable (item 4)

Hub tiles, invite picker stage 1, and ManageChannels stage 1 all show only the root `name` — names carry
no uniqueness constraint (the Rev-7 security argument hinged on exactly that fact). **Fix:** add a
secondary disambiguator line (owner name or member count) rendered ONLY on same-name collisions, computed
in the shared grouping helper so all three surfaces get it at once.

### A8. Manager-role radio never pre-greys for a scoped minter (item 2)

The team rows grey via `mintable_by_me`, but ROLE offers "Manager" to a branch-scoped manager and only
refuses at submit (`scoped_manager_cannot_grant_admin`, mapped copy at `InviteMemberScreen.tsx:291`).
Honest but late. **Fix:** surface the scoped-minter fact on the role card. Note the plan's own G10 record:
`mintable_by_me` deliberately cannot express this (it is per-row; the manager-role refusal is per-minter) —
so this needs its own single-purpose signal, not an overload of `mintable_by_me`.

### A9. Cross-workspace channel push: thread opens, the directory behind it disowns it (items 4/6)

A dept-message tap opens the thread by `channelId` (works), but Back lands in a directory belt-filtered to
the sticky org (`activeWorkspace.ts:60-64`) that does not contain the thread just read. Adjacent to the
accepted hub-dot design; the A1/A2 tap-time context targeting would resolve this seam for free — fold it
into that fix's test matrix rather than fixing separately.

## Probed and found HANDLED (evidence — trust earned)

Zero-channel workspace across all surfaces (`InviteMemberScreen.tsx:424-443`,
`ManageChannelsScreen.tsx:99-115`, `DepartmentChannelsScreen.tsx:548-586`); fresh org's first employee
zero-seed (`enterprise-join.service.ts:1583-1608` — `legitimatelyEmpty`); invite accepted after team
archived/deleted (`:225-243,521-581`); restricted/archived/broadcast picker rows
(`organisationTree.ts:325-329`); unmintable pre-select dropped visibly (`InviteMemberScreen.tsx:88-104`);
HOME swallow incl. other tab bars (only DepartmentalNavigator hides tabs); hardware back in manage stage 2;
removed/suspended member mid-session (two-strike EjectedNotice, `DepartmentalNavigator.tsx:279-356`);
org-switch stale stacks (B-95 held-frame, `:359-387`); 401-retry never re-stamps a post-switch org header;
header-as-grant refused server-side (`org-context.ts:55-90`); five-case rendering switch total incl.
old-server compat (`organisationTree.ts:121-141,185-215,414-490`); org vanishing mid-drill; module-hiding
fail-open + response-echo keying (`hiddenModules.ts:42-77`); item 14 at 320dp/fontScale 1.3; empty-roster
CTA ladder; composer font-scale cap; keyboard on invite form + sheet; incident copy blanks/no-"CPO";
wizard-first landing with warm stack; Choose-Dashboard removal, double-prompt suppression, live-call
minimise-first, pending-ring cost stated; internal-messenger exemption on both exits; hub degenerate
states; mid-flight race token on the tree screen; non-member admin 403 rendered as error; Approvals
reachable from every shell hosting Home.

---

# Part 3 — Lite-booking Ops Room: does group calling work?

**Question:** the booking flow creates a messaging group (Ops Room) joining client ↔ agency ↔ assigned
CPO(s). Does group calling work from it?

**Answer: yes in current code, for all three roles, initiating and receiving — as of the
B-414 / B-416+B-417 / B-428..B-433 fix chain. But almost none of it is device-verified, and the one
structural precondition is E2EE key delivery.**

## What the Ops Room is

- Created at crew-assign on the auto-dispatch path (`org-mission.service.ts:549-556`); a REAL server
  `conversations` row of type `group` (`system-messenger.service.ts:160-217`), back-referenced from
  `missions.comms_channel_id` and `lite_bookings.conversation_id`.
- Members seated idempotently: **client + agency company account + all crew CPOs + active org managers**
  (`org-mission.service.ts:594-603`), each with a group-key add-intent enqueued.
- The E2EE group key is never server-distributed: an agency **owner or delegated manager** device drains
  the intents and reshapes the group key (`dispatchRoomIntents.ts:63-95`, B-416 predicate incl. the B-417
  `owns_agency` arm, server-side atomic claim at `:103-125`).

## Per-role status (code evidence)

| Role   | Initiate                                                                                                                                                  | Receive                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client | ✅ ChatScreen header call buttons (`ChatScreen.tsx:1787,1790` → `launchCall.ts:311-392`); Ops Room routes to plain `Chat` (`openConversation.ts:106-126`) | ✅ shell resolver knows the client path (`messengerDeepLink.ts:173-196`)                                                                                                     |
| Agency | ✅ same ChatScreen on AgentNavigator root, or the LiveTracker dock shim (`AgentLiveTrackerScreen.tsx:707-734`)                                            | ✅ call screens registered in the agency root stack (`AgentNavigator.tsx:303-304`); WS ring handler is shell-generic (`MainNavigator.tsx:858-994`)                           |
| CPO    | ✅ ChatScreen inside CpoComms; role gate blocks only agent 1:1 calls, groups allowed (`callRoleGate.ts:20-29`)                                            | ✅ CpoComms mounts MessengerNavigator with the call screens (`CpoNavigator.tsx:103`); killed-app FCM/VoIP wake routes through the same resolver (`fcmBootstrap.ts:866,1832`) |

The ring set is a five-source union (`ringSet.ts:50-66`) and since the Ops Room is a seated server
conversation, the server source alone names every participant even on a cold device. Removed/departed
members are narrowed out at ring time (B-433, `launchCall.ts:130-134`). Ring-vs-join keys on real room
occupancy (B-428, `launchCall.ts:363-382`), so a second caller still rings the rest. The relay fan-out is
roomId-generic — nothing excludes mission rooms (`messenger.gateway.ts:2097-2260`).

The code explicitly handles the mission-room shape where the HOST does not own the group — a CPO/client
hosting a call in an agency-owned Ops Room self-heals by requesting a key re-share instead of aborting
(`useGroupCall.ts:1818-1848`); a keyless joiner waits 25s with an active resync, then fails closed
(`:1849-1918`).

## Gaps / risks

1. **MEDIUM — key delivery is the real availability gate.** A participant can be _rung_ keyless but
   cannot _join_ until an agency owner/manager device has drained their add-intent (or a key-holder
   answers the 25s in-call resync). Whole agency side offline → client↔CPO calls dead-end at
   "no key ⇒ no media". By-design fail-closed; still the most likely "the call doesn't work" report.
2. **MEDIUM — logged, unfixed (B-416 follow-ups, sqa.md ~:16468-16476):** intent dedup treats `done` as
   terminal, so a CPO removed-then-re-added to a mission is **seated but keyless** (rings, then fails the
   25s wait); the pre-mint key-request targets only the client, not crew.
3. **LOW — B-428 grace-window residue (sqa.md ~:15282-15285):** a non-host who rang cannot cancel the
   rings they sent (`sfu.ring.cancel` is host-only) — stale ringing screens up to 30s.
4. **LOW — B-417 "3b twin":** a delegated agency manager who also owns an Enterprise workspace drains
   uselessly (fail-safe, no rescue) — narrows who can rescue a keyless room.

## What is NOT device-verified

sqa.md's own records: B-414 device passes owed (foreground WS ring on CPO + agency devices, parked-ring
handoff, tracker-initiated call); B-416/417 4-device matrix owed; B-428..B-433 — "nothing here has been
exercised on a device". **The closing evidence would be one live booking's Ops Room with three devices:
each role initiates once (audio + video), each role receives once.** Until that runs, the honest status is
"works in code, regression-pinned, unproven on hardware".

---

# Part 4 — VoIP call symptoms (freeze, echo, volume, slow connect, "verifying ID")

**Headline: an unmerged remote branch `origin/fix/calling-b419-b427` (commit `a7768d1a`) already contains
device-measured root causes AND fixes for the echo and volume symptoms** (claimed bug numbers B-419..B-427
are reserved in sqa.md with no entries on main; measurements on a Pixel 6a). Every root cause it names is
still live on `main` (verified). **First action for this whole symptom cluster: review/merge that branch**
— its iOS half is explicitly unverified, so gate the decision on whether the Android half can land alone.

## 4.1 Voice re-bound back (echo)

- **Root cause 1 (live on main): the waveform's second microphone.** Voice calls, while
  connected/unmuted/foreground, open a full `expo-av Audio.Recording` NEXT to the WebRTC capture to
  animate 11 waveform bars, polling every 100ms, torn down/reopened on every mute toggle and AppState
  flip (`CallScreen.tsx:2325-2393`). The second recorder arrives with a different audio source; the audio
  policy re-picks the input path, and (Pixel 6a evidence) the HAL binds AEC/NS per input stream — the
  reshuffle can strip echo cancellation off the live call (branch B-419). Device log proof pattern:
  `AcousticEchoCanceler: was enabled … is now: disabled`.
- **Root cause 2 (live on main): no audio-device-module option is set** — the device advertises a
  hardware canceller, libwebrtc disables its own AEC3, and the vendor DSP canceller (tuned for the
  handset path) cannot converge on speaker/Bluetooth echo tails (branch B-420).
- Already fixed on main: B-276 (headphone echo — force-speaker flag vs route) and the BS-CALL-ECHO
  constraint-shape regression (the `audio: true` bare constraint is deliberate — do not "improve" it).
- **Fix guidance (no code):** merge the branch's Android half after review, or re-implement its two
  moves: (a) stop opening a second recorder during calls — drive the waveform from the WebRTC track's
  own level API instead; (b) install an audio-device-module configuration that keeps software AEC3
  available off the handset path. Do NOT touch the getUserMedia constraint shape (BS-CALL-ECHO history).
  Verify on device with the branch's own probes: count concurrent `WebRtcAudioRecordExternal:
startRecording` clients and watch the `AcousticEchoCanceler` enable/disable lines.

## 4.2 Ringtone soft, voice very hard

- **Root cause: two unrelated volume sliders.** The in-app foreground ringtone is a custom WAV played
  via expo-av (`bravoTones.ts:73-77,141`) — expo-av plays on **STREAM_MUSIC**, following the _media_
  slider, with ducking enabled; call voice rides **STREAM_VOICE_CALL**, whose per-output-device index
  Android _remembers_ (users crank it after earlier too-quiet calls — the branch's B-425 evidence).
  Media slider low + remembered call volume high = exactly this report. The background/killed native
  ring (`BravoRingtoneModule.kt:70-73`) correctly uses `USAGE_NOTIFICATION_RINGTONE` — only the
  foreground in-app player is on the wrong stream.
- Secondary: the synthesized 800+1000Hz WAV is inherently less loud-perceived than a device ringtone;
  and on speaker, B-420's disabled AEC3 also removes the processing that would tame the render path.
- **Fix guidance:** route the foreground in-app ring onto the ringer stream (or the branch's approach:
  a call-volume floor ~70% at session start, `callVolumeFloor` on the unmerged branch). Whichever way:
  keep the NA-06 native/in-app ring ownership handoff intact (`bindInAppRingOwnership`), and keep the
  deliberate deferral of the audio session until accept (`CallScreen.tsx:1213-1225` — starting it while
  ringing is what used to make the ringtone quiet/earpiece-routed; do not regress that).

## 4.3 VoIP call freeze

- Everything ICE/answer-shaped from the B-272..274 era is fixed on main (ICE queued before remote
  description `callController.ts:155-200`; outbound gate `:202-232`; watchdogs; `have-local-offer`
  rollback `:1253-1300`; getUserMedia bounded 15s).
- **The one confirmed OPEN mechanism is the JS-thread stall class (B-279/B-285)** — root cause still
  unnamed; single JS-queue messages of 4–6s measured by two independent sources. A blocked JS thread
  freezes the entire call (signalling, ICE handlers, UI) because the call stack is JS-driven. The
  CLAUDE.md lag section's next lead (per-send SQLCipher write + `notifyBackupDirty` Merkle cost) stands;
  do not re-propose the eight measured dead ends.
- Secondary residual: a re-queued inbound ICE candidate after a failed `addIce` is only drained on the
  next `setRemoteDescription` — mid-call none may come, silently losing candidates until an ICE restart
  notices (`callController.ts:361-379`). Low probability, real.
- Un-device-verified surface: the whole B-428..B-433 group-entry rewrite (2026-08-13) — any NEW
  freeze-on-connect in group calls is most likely there.
- **Fix guidance:** for the stall class, instrument before theorizing — the per-send probe list in
  CLAUDE.md ("what IS still open"), on a release build, `[LAGDIAG]` correlation. For the ICE re-queue:
  add a bounded re-drain (retry once after a short delay while the connection is live) rather than
  re-architecting; assert no behaviour change on the happy path.

## 4.4 Slow to connect

- The setup chain is strictly SERIAL: biometric/session gate → runtime build → WS handshake (+ JWT
  refresh if B-352's fix isn't on the running build) → TURN fetch (hard 6s ceiling, STUN-only fallback —
  `CallScreen.tsx:612-694`) → getUserMedia (≤15s) → offer auth (may fetch a sender cert, hundreds of ms)
  → offer send (retries across WS reconnect up to 40s). Each stage bounded; they stack.
- B-342 (ring at step 3c, media bounded) is fixed. B-352's fast-handshake fix directly shortens call
  setup too — but it still owes device verification and its server A1 deploy.
- The "7× getUserMedia" is settled as NOT A BUG (BlueStacks camera HAL never comes up; real devices
  recover in 156–689ms — sqa.md ~:15248-15269). **Never diagnose call media on emulators.**
- **Fix guidance:** measure before changing — the `[CALLDIAG]` step warns are release-visible; timestamp
  deltas between relay `[CALL] OFFER` receipt and client state transitions localize the slow stage.
  The known blind spot: most 1:1-path traces are still `console.log` (stripped in release). Promoting
  the key 1:1 transitions to tagged `console.warn` (the B-357 `[KEYDIAG]` pattern; remember the logAudit
  ban on the word "signature" — use "sig") is the cheapest high-value change, and is prerequisite to
  diagnosing the founder's device reports at all.

## 4.5 Freeze at "verifying ID" — NOT the call stack; new bug candidate

- The literal string is **"Verifying identity…" in `BiometricGate.tsx:180`** (the app-unlock gate), with
  a sibling "Verifying session…" boot overlay (`navigation/index.tsx:83`). Nothing in the call modules
  renders a "verifying" state. No sqa.md entry covers a hang here — **unlogged bug candidate; assign a
  B-number on first device repro.**
- **Cleanest wedge mechanism found:** `LocalAuthentication.authenticateAsync` has NO timeout
  (`BiometricGate.tsx:72-77`); if the native prompt never resolves, status stays 'prompting' forever.
  Worse, the re-entrancy guard (`authenticating.current`, `:56`) makes the foreground-relock retry a
  silent no-op while an earlier call is wedged — status parks on 'checking', **and the retry button only
  renders on status 'failed'** (`:177-183`), so the user has no affordance at all.
- Call interaction: a cold boot from an incoming-call notification with Biometric Lock on must pass this
  gate while the 45s ring TTL burns — a hang here silently eats the call, which may be why it presents
  as a "call" symptom.
- **Fix guidance:** (a) bound the authenticate promise with a watchdog that flips status to 'failed'
  (which already renders the retry button) — never auto-bypass the gate (security stop-condition: this
  is a biometric gate; weakening it needs architecture approval, a TIMEOUT-to-retry does not weaken it);
  (b) make the relock path safe against an in-flight prompt (supersede or queue, don't silently drop);
  (c) add a release-visible `console.warn` on entry/exit of the prompt — the file currently logs
  NOTHING on any path, which is why this freeze has been invisible in every device log so far.
- Diagnostic to confirm on device: freeze with system logcat showing `BiometricPrompt` activity, app
  emitting nothing, and `[LAGDIAG]` watchdog QUIET (JS thread idle) = the wedged promise, not a stall.

---

# Part 5 — Consolidated device-verification debt

Code-complete but unproven on hardware (the founder rule: not "fixed" until the marker is seen in a
post-install device log):

| Area                | What's owed                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Item 4 / 17b / 18   | Device pass (recorded in the item-4 session close). ⚠️ Do not create the first multi-org test account before a build that sends `X-Org-Context` is installed.                                          |
| Ops Room group call | Full 3-device, 3-role matrix (each role initiates + receives, audio + video) on a REAL booking — B-414, B-416/417, B-428..433 all owe passes. Real hardware only (emulator camera HAL false-negative). |
| B-352               | Device verify + messenger-service A1 deploy check.                                                                                                                                                     |
| B-419..B-427 branch | Merge decision + iOS half verification.                                                                                                                                                                |
| BiometricGate wedge | Repro + B-number + fix per 4.5.                                                                                                                                                                        |

# Part 6 — Recommended order of attack

1. **Merge-review `origin/fix/calling-b419-b427`** (echo + volume, already device-measured) — decide the
   iOS-half question; this closes two of the five founder call complaints at once.
2. **A1+A2 push-tap org targeting** (the plan's own unshipped P7-1) — one contract, three symptoms
   (incident tap, approvals tap, A9's directory seam).
3. **A3 tenant-flag scoping** — quiet data-shape corruption risk on the agency lane (null-department
   channels); cheap to fix server-echoed, dangerous to leave.
4. **BiometricGate watchdog + logging** (4.5) — new bug candidate, plausibly the founder's "verifying ID"
   freeze, invisible in logs until instrumented.
5. **A4 Delete reachability** — needs one founder decision (owner vs creator authority) first.
6. **Ops Room 3-device call matrix** — pure QA session, no code; converts "works in code" into "works".
7. Minors A5–A8 batched with the next item-18/item-2 touch.
