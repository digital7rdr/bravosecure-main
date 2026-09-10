# UI Screenshot Review & Corrections — Implementation Plan (Rev 4)

> **Source of truth:** `Bravo_UI_Screenshot_Review_and_Corrections.pdf` (15 Aug 2026) — 12 corrections
>
> - a 17-line acceptance checklist (its §13).
>   **Rev 4 supersedes all earlier revisions.** Revs 1–3 went through three review rounds with an
>   architecture critic and an adversarial edge-case hunter. Every finding is folded in below; the ones
>   I checked and **rejected** are recorded in §11 so they are not re-raised, and the places where a
>   reviewer and I disagreed are resolved in-line with the evidence.
>   **Companion loops:** `LOOP.md`, `DESIGN_REVIEW_LOOP.md`, `sqa.md`, and — because
>   `MessengerHomeScreen.tsx` is on its trigger list — `docs/runbooks/MESSAGE_LOOP.md`.

---

## 0a. BUILD STATUS (updated as it ships)

| #   | Item                                                                           | Code    | Tests                                                       | Notes                                                                |
| --- | ------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| —   | DB + server (`is_lateral`, 4-hop walk, announcement rules, `workspace_tenant`) | ✅      | 11 suites / 319 · **10 mutations RED**                      | Migration `20260816000000` written, **not yet applied**              |
| 01  | User-name identity on the Workspace Hub                                        | ✅      | 8                                                           |                                                                      |
| 02  | Global Announcements list removed                                              | ✅      | in `departmentDirectoryRender`                              | Renderer-only, as Rev 3 decided. **Purge migration not yet written** |
| 03  | Colour coding, branch lines, dropdowns                                         | ✅      | `channelTreeModel` 20 + scan guards 7 · **4 mutations RED** |                                                                      |
| 04  | Lateral channels at every level                                                | ✅      | server 5 · editor 6 · admin 3 · **10 mutations RED**        |                                                                      |
| 05  | Delete Channel on the Edit screen                                              | ✅      | 5 · **3 mutations RED**                                     |                                                                      |
| 06  | Branch line + selective display                                                | ✅      | with item 03                                                |                                                                      |
| 07  | Bottom nav Home·Channels·Vault·Messenger·News                                  | ✅      | 21                                                          | `unmountOnBlur`, shrink-to-fit labels                                |
| 08  | Emergency Calls in Calls Log                                                   | —       | —                                                           | **DEFERRED by the founder (F4)**                                     |
| 09  | Incident Reporting opens on the report screen                                  | ✅      | 5 suites updated                                            | Nested `state:` payload for the detail deep link                     |
| 10  | Add Member from Bravo Contacts                                                 | ✅      | picker shared with InviteMember                             |                                                                      |
| 11  | 11b (obsolete screen) ✅ · 11a (back nav) ⏸                                    | partial |                                                             | 11a needs the device repro FIRST (§3.10)                             |
| 12  | Clipped Messenger buttons                                                      | ✅      | 7 · **5 mutations RED**                                     |                                                                      |

**Retired:** `OrgChannelTreeScreen` + both route registrations + param entries + its test
(assertions carried into `channelTreeModel.test.ts`).
**Gates at time of writing:** app 155/2119 · crypto 447/4628 (×3) · auth-service 11/319 ·
typecheck 45 (= baseline) · ops-console 0 · lint 0 errors · knip clean.

**Still to do:** the purge migration (§4.3), applying both migrations, `sqa.md` B-numbers, and the
§7.3 device pass.

---

## 0. Founder decisions (2026-08-15) — these are settled, do not re-open

| #      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                | Effect                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **F1** | **Org root = L1.** The organisation channel row (SASFA / GSSG / EDGE Group) is the L1 coloured row; the workspace name is header chrome.                                                                                                                                                                                                                                                                                                                | Fits the existing `level BETWEEN 0 AND 3` CHECK. **No depth change**, the "no fifth level" locked rule is untouched. |
| **F2** | **Purge `#broadcast` only, fully guarded**, and abort loudly on any hazard. The four legacy default channels stay.                                                                                                                                                                                                                                                                                                                                      | §4.3. Admins remove the rest per-channel with item 05's Delete.                                                      |
| **F3** | ~~**Chevron expands; the row name opens the chat.**~~ **SUPERSEDED 2026-08-19 by G1** — the founder reversed it ("the drop down must not only be on the little arrow, it must be when you click on the whole card/button"). The WHOLE CARD toggles a level that has children; see `UI_CORRECTIONS_2026-08-19_FOLLOWUP.md`. F3's _reasoning_ still stands and is why G2 adds an explicit open button rather than repeating §2.6's two withdrawn designs. | Zero doors lost, then and now.                                                                                       |
| **F4** | **Item 08 (Emergency Calls in the Calls Log) is DEFERRED** — "leave it for now, I will discuss these later."                                                                                                                                                                                                                                                                                                                                            | Out of this pass. Findings preserved in §10 so the next session does not re-derive them.                             |

**Scope is therefore 11 items, not 12.**

---

## 1. Item inventory

| #   | PDF title                                       | Kind | Status                                                                                                                  |
| --- | ----------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 01  | Workspace identity = user name                  | Code | `WorkspaceHubScreen` shows no personal identity at all today.                                                           |
| 02  | Remove global Announcements/Broadcast list      | Both | Server already stopped seeding for workspaces; the **client still renders** the section and **legacy rows** remain.     |
| 03  | Colour coding, branch lines, dropdowns          | Code | Not implemented.                                                                                                        |
| 04  | Lateral channels at every level                 | Both | **Concept does not exist** — grep confirms zero product uses of "lateral" in `src/` or `apps/`. Needs schema + trigger. |
| 05  | Delete Channel on the Edit screen               | Code | Server + `deletable` already plumbed; only the button is missing.                                                       |
| 06  | Branch line + selective display                 | Code | Same work item as 03.                                                                                                   |
| 07  | Bottom nav = Home·Channels·Vault·Messenger·News | Code | Today Home + Messenger.                                                                                                 |
| 08  | Emergency Calls in Calls Log                    | —    | **DEFERRED (F4).**                                                                                                      |
| 09  | Remove the Incident Queue intermediate screen   | Code | Harder than it looks — see §3.8.                                                                                        |
| 10  | Add Member from Bravo Contacts                  | Code | Email + phone already work; only the contacts lane is missing.                                                          |
| 11  | Back nav + remove the obsolete Channels screen  | Code | 11b falls out of item 03. 11a needs a device repro first.                                                               |
| 12  | Clipped Messenger top-right buttons             | Code | Flex overflow in the header.                                                                                            |

---

## 2. Architecture

### 2.1 — Tier = walk depth, displayed as `L{depth+1}`; **capability gates stay on `level`**

Founder decision F1. The organisation root row is L1.

**The rule that Rev 1 got wrong and that must not be re-broken:** display tier and capability are
**two different numbers**.

- **Display** uses walk depth, so a legacy **level-1** root and a new **level-0** root both render
  `L1`. (`createChannel`'s own comment records that both shapes exist permanently and re-parenting
  is DB-blocked.)
- **Capability** — "can this node take a sub-level?" — uses the **stored `level`**, because that is
  what the server enforces (`parent.level >= 3` → `max_channel_depth_reached`) and what
  `ChannelEditorScreen`'s parent filter already uses (`(c.level ?? 1) < 3`).

Rev 1 said "hide `+ Add sub-level` at tier 4". On a legacy level-1-rooted workspace a **tier-3**
node is already `level 3`, so that renders a button whose every tap 400s. **Gate on
`row.level >= 3`, never on the rendered tier.**

**Stated limitation (PDF checklist line 4):** a legacy level-1-rooted workspace can only ever
represent **three** tiers. Re-parenting is hard-blocked, so this is permanent without a re-level
migration. Recorded in §9 as a follow-up, not silently accepted.

### 2.2 — Lateral channels: `is_lateral`, and the six things Rev 1 missed

A lateral inherits its parent's `level` instead of `parent + 1`. That part of Rev 1 stands — with
four corrections.

#### D-1 (BLOCKER, found independently by both reviewers) — the 3-hop ancestor walk breaks

Two places bound the ancestor walk at three hops, **both justified by `level` being capped at 3**:

- `department.service.ts` — the `a1/a2/a3` JOINs and the `av.v1/v2/v3` reachability LATERAL, with
  the comment _"Bounded to 3 hops because c.level is CHECKed 0..3, so a row has at most three
  ancestors"_.
- `organisationTree.ts` — `const MAX_DEPTH = 3`, consumed by `nestsUnderAnotherBucketRow`.

With a lateral, that sentence is **false**: `L1(level 0) → L2(1) → L3(2) → L4(3) → lateral(3)` puts
the lateral **four** hops from the root. Consequences, both real:

- `visible_ancestor_id` cannot resolve to the L1 root → a member of the lateral and the root but not
  the middle gets a **synthetic orphan** instead of their own organisation.
- `root_id` returns L2's id, not the root's → two laterals under one root split into two groups that
  each claim to be a root.
- Client-side `nestsUnderAnotherBucketRow` never reaches the root → the lateral is emitted at top
  level **and** inside the ancestor's subtree = a **duplicate render**, the exact bug
  `directoryBuckets` exists to kill.

**Fix:** add `a4` + `av.v4` to the SQL walk, extend the `visible_ancestor_id` / `root_id` CASEs, and
set `MAX_DEPTH = 4`. The bound is sufficient: roots are capped at level 0/1
(`root_channel_level_invalid`), every structural hop increments `level` which is CHECKed ≤ 3, and a
lateral adds exactly one non-incrementing hop and is a leaf (D-2) — so 4 ancestors, maximum. Both
reviewers tried to construct a 5-hop shape and could not.

⚠️ **The bound is emergent and unenforced.** It follows from three rules in three files, and it
re-breaks with the _identical silent symptom_ (synthetic orphan + duplicate render, no error) if
anyone later relaxes the lateral-leaf rule, ships agency laterals (§10), or runs Q4's re-level
migration. Two cheap guards, both required: an **integration test** that builds the deepest legal
chain plus a lateral and asserts `root_id` is the real root; and a comment in **both** files stating
the bound and what invalidates it.

⚠️ **Spec fallout Rev 2 did not name.** `channelTreeFields.spec.ts` goes red in at least five places,
including a test literally named _"the ancestor walk is bounded to three hops"_, a hop-count pin
(_"three, not six"_), a `['a1','a2','a3']` loop, and the **`root_id` disclosure pin**
`COALESCE(a3.id, a2.id, a1.id)`. The new form is `COALESCE(a4.id, a3.id, a2.id, a1.id)` — **a4
first; the order is silent if wrong**. The count pins move to 4; they are **not** loosened or
deleted (R3 class). The `"Bounded to 3 hops"` SQL comment must be corrected or it asserts a
falsehood.

⚠️ **Cost:** a 4th `LEFT JOIN` plus a 4th correlated `EXISTS` per row, on a query that already does
three of each plus a `member_count` subquery, over up to 500 rows, on every focus. `EXPLAIN` on a
realistic tenant before shipping.

#### D-2 — the three trigger invariants (unchanged from Rev 1, still required)

1. **A lateral must be a LEAF** — `lateral_channel_cannot_have_children`. Without it, a lateral chain
   adds unbounded real depth while `level` never moves, and the depth CHECK becomes decorative.
   Also what makes D-1's "one extra hop" bound sound.
2. **A lateral must have a parent** — `lateral_channel_needs_parent`.
3. **`is_lateral` is frozen on UPDATE.** ⚠️ Rev 1's §5 E19 said this "refuses"; the existing `level`
   freeze **silently coerces** (`NEW.level := OLD.level`). Pick one and pin it: **coerce**, matching
   the neighbouring rule, and the migration spec asserts the coercion, not a `RAISE`.

#### D-3 — laterals COUNT as children; archive refuses, bottom-up _(Rev 2 got this wrong)_

**Rev 2 said laterals must be excluded from `activeChildCount` and cascade-archived with their
parent. That was an error and is reverted.** Recording it because the reasoning matters:

- **The premise was false.** A lateral is a leaf (D-2), so `activeChildCount(lateral) === 0` and it
  archives fine on its own. The parent is _not_ "permanently un-archivable" — the admin archives the
  lateral, then the parent. That is bottom-up, which is the documented design.
- **The prescribed fix is the one thing the code explicitly forbids.** `archiveChannel`'s comment:
  _"REFUSE rather than cascade, deliberately. Cascading would archive channels the manager never
  selected (and unarchive would then have to guess which ones to bring back)."_
- **The broadcast carve-out does not transfer.** Its stated justification is _replaceability_ —
  _"Safe because the uniqueness index ignores archived rows, so `ensureBroadcastForLevel` can mint a
  fresh one when the level is next used."_ Nothing re-mints a `#Managers` channel. And
  `unarchiveChannel` is `WHERE id = $1` only — there is **no cascade-unarchive anywhere**, so a
  cascade would bury admin-named channels, with their members, history and E2EE group, behind a
  manual per-row recovery in an ARCHIVED section that does not even render inside stage 2.

**Therefore:** laterals count in `activeChildCount`. Archive refuses with
`channel_has_active_sub_channels`. No cascade, no residue, and the archive/create race is not
widened. **Zero server change** on the archive path.

The **delete** side is real but pre-existing: `has_children` has no archive filter, so a node that
ever held any child is un-deletable. That is today's behaviour for every child type and is already
documented in the code. Item 05 only needs honest copy naming archived children (§3.5).

#### D-4 — one lateral concept per tenant, not a union

Rev 1 defined `isLateralRow = is_lateral || is_broadcast`. Rejected: the two would then have
**opposite lifecycles** (a broadcast-lateral is cascade-archived and ignored by the child count; an
`is_lateral` one blocked the archive) — two identical-looking neutral cards behaving differently.

**Instead, separate by tenant:**

- **Workspace:** laterals are `is_lateral` only. After the F2 purge there are no broadcast rows, so
  there is exactly one rule.
- **Agency:** untouched. Broadcasts keep today's exact placement and lifecycle; laterals are **not
  offered** (server refuses with `lateral_channel_not_supported_for_agency`, mirroring the existing
  `root_channel_not_supported_for_agency` gate — Rev 1 had no such gate, and without it a lateral
  corrupts `ensureBroadcastForLevel`'s level arithmetic).

#### D-5 — after the purge, nothing can create a broadcast; the PDF requires one per level

`channel.dto.ts` deliberately has **no** `is_broadcast` field ("created by the server's
`ensureBroadcastForLevel`, never asserted by a caller"), that function is agency-only, and the
editor cannot reach `post_mode: 'announcement'`. So F2 would leave workspaces with zero
announcement channels and no way to make one — while PDF §04 lists `#broadcast` as a lateral at
every level.

**Fix, and it needs no new column:** add an **"Announcements"** option to `ChannelEditorScreen`'s
`ACCESS` table, available on **laterals only**, that sends `post_mode: 'announcement'`. The admin
names it whatever they like — the PDF's own rule. Ships **before** the purge.

The DB layer is already legal (verified): no CHECK ties `announcement` to `is_broadcast`;
`dept_channel_broadcast_mode` only _forces_ the mode on broadcasts, it does not restrict it;
`memberRoleFor('announcement')` returns `'viewer'`, so `seedChannelMembers` gives non-managers
viewer and the `myRole === 'admin'` write gate closes the composer, send, reply and reactions.

**Five client/server gaps that must ship with it — Rev 2 named none of them:**

1. **The editor resolver silently demotes it.** `ChannelEditorScreen`'s option resolver ends
   `return pm === 'open' ? 'standard' : 'read_only'`, so an existing announcement lateral resolves
   to **Read only** and every Save — including a bare rename — re-sends `post_mode: 'read_only'`.
   That is verbatim the bug its own docblock says was already fixed once. Add an `announcement` arm
   **before** the fallback, widen the option-key type to a local union (`ChannelAccessDto` has only
   three members, so a 4th key does not typecheck), and pin the round-trip **RED-first**.
2. **`pick()` does not carry `is_lateral`**, so on the _edit_ path the editor cannot tell a lateral
   from a level node — it can offer neither this option nor §3.4's placement line. Add it to `pick()`
   and to `MessengerStackParamList['ChannelEditor']['channel']`.
3. **`assertBroadcastPostingAllowed` is `is_broadcast`-keyed**, so an admin could promote a plain
   employee to poster in an announcement channel — which PDF page 10 rule 1 forbids. Key it on
   `post_mode === 'announcement'` too.
4. **`mintRefusalFor` is `is_broadcast`-keyed**, so an announcement lateral would be offerable as an
   invite _team_. Same fix.
5. **The badge renders muted grey.** `channelStateMeta` gives `is_broadcast` → `Broadcast` in
   `OB.amber`, but `post_mode === 'announcement'` → `Announce` in **`OB.textMute`** — the same tone
   as _Archived_. The founder's flagship channel type would look inactive. Give it the amber tone.

**Mutability, stated not fixed:** `dept_channel_broadcast_mode` pins the mode only on broadcasts, so
an announcement lateral _can_ later be edited into an open chat. A `#broadcast` cannot. Accepted —
it is an admin-only action on an admin-created channel, and the alternative is a new trigger.

#### D-6 — production silently strips `lateral`, creating permanently-wrong rows

`main.ts` sets `forbidNonWhitelisted: process.env.STRICT_VALIDATION === 'true'` — **`true` in
staging, default `false` in prod**, deliberately, so in-flight builds don't break. Rev 1's deploy
rationale ("a client first would get a 400") is therefore **staging-only**. In prod the field is
whitelisted away, the row is created as a **structural child**, and it is unfixable: `is_lateral` is
frozen and re-parenting is blocked.

**Fix — two parts, because a read-side gate cannot authorise a write.**

1. **Server-side echo (the guarantee).** `createChannel` already returns
   `{id, name, channel_type, access, level, post_mode}` — add `is_lateral`. The client verifies it
   came back `true` and, if not, surfaces an honest failure and offers delete-and-retry. This is the
   only part that survives a **rolling deploy**, where a read can hit a new instance and the
   subsequent write an old one — defeating any read-side gate.
2. **Client presence gate (the affordance).** Hide `+ Add lateral channel` until the response proves
   the server speaks the protocol. **Write the predicate literally:**
   `rows.some(r => r.is_lateral !== undefined)` — a new `serverKnowsLaterals(rows)` beside
   `serverKnowsHierarchy`, fed by the **admin** response. Two traps: the truthiness reading
   (`=== true`) is a **permanent deadlock** — no laterals exist, so the affordance never renders, so
   none can ever be created; and there must be **no `length === 0` escape hatch** (the
   `serverKnowsHierarchy` _call site_ has one for the clean-workspace case, which here would fail
   the gate open against an old server).

### 2.3 — No `is_lateral` backfill (unchanged)

Existing rows stay structural. An UPDATE setting `is_lateral` re-derives `level := parent + 0`,
dropping the row a tier and risking a collision with the partial unique index
`dept_channels_one_broadcast_per_level (org_id, level) WHERE is_broadcast AND archived_at IS NULL`.

### 2.4 — Broadcast placement: **`placeRow` is NOT changed** _(reversed again in Rev 3)_

> **UPDATE 2026-08-19 (G4).** The founder asked again, on the ADMIN screenshot this time:
> "Announcements should be within the organization itself. To avoid announcing to wrong
> organization/association." `placeRow` is STILL not changed — the agency argument below is
> still correct. Instead `nestParentedBroadcasts` re-places a PARENTED broadcast at the two
> workspace-tenant tree call sites only, and the stage-1 section now lists only the rows that
> cannot be placed. See `UI_CORRECTIONS_2026-08-19_FOLLOWUP.md` §W2 and B-569/B-573/B-576.

Rev 1 and Rev 2 changed `placeRow` so a **parented** broadcast becomes a `child`. **Reverted.** The
justification was "it makes broadcasts appear under their level for agencies" — and no agency
surface consumes `placeRow`:

- the invite picker strips broadcasts _before_ every tree call (`!r.is_broadcast && !r.archived`);
- `ManageChannelsScreen`'s `orgFirst` is false for agencies, so they take the `treeOrder` branch,
  which reads `parent_id` directly;
- §3.3 keeps the `LEVELS` branch for agencies, which groups by `c.level` and never calls `placeRow`.

So the change had no live agency benefit, and it carried a real cost: an agency's per-level
broadcast is parented to _whichever node happened to be the parent of the first channel created at
that level_, while every active member is seeded into it — so re-placing it as a child gives members
of other branches a masked parent and demotes their guaranteed announcements door to a
"(not shown)" rung.

**Instead, item 02 is achieved purely in the renderer:** on the **workspace** tenant the
`announcements` bucket is rendered as **unlabelled neutral rows at the root of the tree** — no
`ANNOUNCEMENTS` heading, which is the founder's actual ask — and on the **agency** tenant nothing
changes at all. `organisationTree.ts` keeps all nine `is_broadcast` decision sites exactly as they
are. Smallest possible diff and no door lost in any tenant. (The file still gains the new
`buildChannelTree` — see §2.7, whose `collapseChildless` parameter is the one real risk in it — but
no _existing_ helper changes behaviour.)

**Parentless** broadcasts are the common legacy shape (`seedOrgWorkspace` and the backfill's
`level <= 1` arm both produce them), and `ManageChannelsScreen`'s stage-1 block is documented as
_"the only door to `ChannelEditor`"_ for them. That block **stays until the F2 purge is verified
applied**, and its removal is gated on the row count (§8).

### 2.5 — One inline collapsible tree; `OrgChannelTreeScreen` retired

Render model (F1 + F3):

```
Channels · GSSG                                   ← workspace name = header chrome
 L1  # GSSG                                 ▼      COLOURED   tap name = open chat
  ├ # announcements                    [5]  >      neutral    admin-named lateral
  └ L2  # UAE                               ▼      COLOURED
      ├ # general                      [2]  >      neutral
      └ L3  # Abu Dhabi                     ▼      COLOURED
          └ L4  # Team 1                    >      COLOURED (collapsed)
```

Two things the diagram is _not_ saying. The lateral is **admin-named** — post-purge a workspace has
no `#broadcast` row, and an announcement channel is a lateral with `post_mode: 'announcement'` whose
name the admin chose (D-5). And the L1→L4 chain shown needs a **level-0** root; a legacy
level-1-rooted workspace tops out at L3 (§2.1, Q3).

**Retirement consumer list — Rev 1's was incomplete.** Five consumers, not two:
`DepartmentChannelsScreen` ×2 navigates, `DepartmentalNavigator` registration,
`MessengerNavigator` registration, `navigation/types.ts` ×2 entries,
`enterpriseOnboarding.test.ts` (a per-shell `it.each` requiring **both** `name="OrgChannelTree"`
and the import), `departmentDirectoryRender.test.tsx` (asserts the navigate), and
`orgChannelTree.test.tsx` itself.

⚠️ `DepartmentChannelsScreen` uses `useNavigation<any>()`, so **typecheck cannot prove the navigates
are gone.** Deleting the param-list entries produces no error at the call sites. A grep is the gate.

Deep-link safety **verified**: `OrgChannelTree` appears in no `MessengerTarget` union and none of the
three route sets in `messengerDeepLink.ts`.

### 2.6 — Level-row interaction (founder decision F3) — **SUPERSEDED, see G1/G2**

> The bullet list below describes what shipped on 15 Aug. Since 2026-08-19 the WHOLE CARD
> toggles an expandable level; the chevron keeps the same action as a second target, and the
> chat door moved to the pencil (admin) / a dedicated open button (member). The two withdrawn
> designs recorded here are still withdrawn — G2 does NOT re-home the level's own thread.

- **Trailing chevron** = its own ≥44 dp button: expand/collapse. `chevron-down` expanded,
  `chevron-right` collapsed. `accessibilityLabel` states the tier and state.
- **Row name area** = opens that level's chat, exactly as today, including the "Not yet active" /
  provisioning path via the shared `useOpenDepartmentChannel`.
- **Laterals** = neutral card, whole row opens the chat.

This dissolves Rev 1's D-3/D-4-era problems: no own-thread row, no clutter, no dependence on
`group_conversation_id`, and no change to eager provisioning.

### 2.7 — Totality, uniqueness, and `collapseChildless` is a PARAMETER

Rev 1 cited `directoryBucketsAreTotal` as the precedent. That test asserts
`rows.filter(r => !seen.has(r.id))` over a **Set** — it proves "at least once" and is **structurally
blind to duplicates**, which is exactly what D-1 produces.

The new test asserts **exactly once**: a count map over the rendered node list, every input row
`=== 1`.

⚠️ **`buildChannelTree(rows, {collapseChildless})` — the option is REQUIRED, and Rev 3 omitting it
was a blocker.** `directoryBuckets` hardcodes `organisationRootsOf(rows, {collapseChildless: true})`,
and that helper's docblock is explicit:

> _"**Admin surfaces MUST pass false** (the default): a freshly created organisation is childless by
> definition, so collapsing it would make it **invisible in the admin org list**, and the admin could
> never drill in to add its first child. **The create flow would dead-end on its first use.**"_

`ChannelTree` is shared by the member directory and Manage Channels stage 2, so a `buildChannelTree`
that simply wraps `directoryBuckets` gives `mode:'admin'` the member's collapsing rule and
reproduces that documented dead-end on the flagship new screen. **`true` for member, `false` for
admin**, threaded through, with a §2.7 fixture: _"admin, one childless organisation, it renders."_
(`manageChannelsOrgScoped.test.tsx` covers the empty-workspace create path but not "already has one
organisation, gains a second".)

### 2.8 — Level colours (measured)

One 4-entry tuple in `_obsidian.tsx`, nowhere else. Contrast measured against `#07090D`:

| Tier | Token         | Value     | Contrast    | Source                   |
| ---- | ------------- | --------- | ----------- | ------------------------ |
| L1   | `OB.level[0]` | `#E2C893` | **12.26:1** | existing `OB.amber`      |
| L2   | `OB.level[1]` | `#7FD8CB` | **11.94:1** | **new** (teal)           |
| L3   | `OB.level[2]` | `#A9C5FF` | **11.50:1** | existing `OB.accentSoft` |
| L4   | `OB.level[3]` | `#CB9BF5` | **9.06:1**  | **new** (purple)         |

Hue separation 131° / 49° / 52°. All ≥ 4.5:1 body and ≥ 3:1 UI. Colour is never the only signal —
the `Ln` pill text, indent and connector all carry the tier (matters for deuteranopia, where L2→L3→L4
are the tight pairs).

⚠️ **Noted collision:** `OB.amber` already means Broadcast/Managers/Private in `channelStateMeta`,
and `OB.accent` is the primary-action colour. The tier pill is therefore visually distinct from a
state badge (different shape, always prefixed `Ln`, always leading the row) so one row can carry both
without ambiguity. Verify on device.

⚠️ `ManageChannelsScreen`'s badge does raw hex-alpha concat (`st.color + '4D'`), which is **unsafe
for rgba strings**. The tier tokens are hex, so this is safe today — do not make a tier token rgba.

### 2.9 — Branch connectors and indent

Per-row connectors, not a continuous rail (variable row height at fontScale 1.3 makes a rail drift).

⚠️ Rev 1 said "reuse the existing number" — there are **two**: `OrgChannelTreeScreen` uses
`paddingLeft: 12 + depth * 16` (12 dp base) and `ManageChannelsScreen` uses `marginLeft: depth * 16`
(no base). **Decision: `12 + depth * 16`**, one base, stated here. Logical `Start` properties for RTL.
`ManageChannelsScreen`'s `Row` docblock does the 320 dp / fontScale-1.3 arithmetic against the _old_
base — update it in the same commit or it documents a number the code no longer uses.

⚠️ **Naming trap.** `channelHierarchyGrouping.test.ts` bans `\bc\.level\b` outside the `levelOf`
helper, and both existing row shapes destructure as `{c, depth}`. §2.1's capability gate reads
`level` — so name the row variable `row`/`node` in `ChannelTree.tsx`, or adding the file to that
scan list (R11) trips the ban on the very line the gate needs.

### 2.10 — Collapse state

Session-local `Set<string>` in screen state. Default: L1 rows expanded, L2+ collapsed. Not persisted.

---

## 3. Per-item build plan

### 3.1 — Item 01 · user identity on the Workspace Hub

Identity block above `YOUR WORKSPACES`: avatar + `user.full_name` + "N workspaces".
⚠️ `full_name` is typed **non-optional**, so a `full_name → email → …` chain is unreachable past the
first term — handle the empty-string case instead.
⚠️ Do **not** hand-roll initials: `ProfileDrawerModal`'s copy is **inline, not exported**, and two
exported helpers already exist (`utils/helpers.ts getInitials`, `agentFlowHelpers.ts pickInitials`).
Use one; adding an 11th copy is the named duplicate-copy class.
⚠️ PDF checklist line 1 says the _heading_ shows the user name. Rev 1 unilaterally kept the header as
"Workspaces". **Recorded as an open question (§9 Q1)**, built as the body block for now.

### 3.2 — Item 02 · remove the global Announcements list

Client only, and small (§2.4): `organisationTree.ts` is **not touched**. On the workspace tenant the
`ANNOUNCEMENTS` heading in `DepartmentChannelsScreen` goes away and its rows render as unlabelled
neutral cards at the root of the tree; the agency tenant is untouched.
`ManageChannelsScreen`'s stage-1 block is removed **only after** the purge row count is verified
(§8 step 6).

⚠️ **Tenant gate problem (must fix first).** `listChannels` returns `{channels}` only — it has **no**
`workspace_tenant` field, so the member screen uses the **user-level** `useIsWorkspaceTenant()`,
which is true for anybody with any workspace affiliation. That is documented as edge A3 and is why
`workspace_tenant` was added to the _other_ endpoint. The dual persona (agency manager who also
joined a workspace) viewing their **agency** would lose ANNOUNCEMENTS and get the workspace tree.
**Project `workspace_tenant` from `listChannels` too**, and gate on it.

### 3.3 — Items 03 + 06 + 11b · the tree

New `src/screens/deptchat/ChannelTree.tsx`, shared by the member directory and Manage Channels
stage 2. New `buildChannelTree(rows)` in `organisationTree.ts`.

⚠️ **The tree gate is `isWorkspace` ALONE — not `isWorkspace && hasHierarchy`.** Rev 2's
`!isWorkspace` wording left the most common workspace shape undefined, and the default reading would
have re-rendered the exact screen the founder complained about. Two large populations have
`hasHierarchy === false` on a workspace:

- every pre-hierarchy workspace (`hasHierarchy`'s own docblock: _"EVERY EXISTING WORKSPACE IS FLAT…
  a pile of parentless level-1 rows"_), and
- every workspace with one organisation and no sub-levels (a lone parentless root fails the
  predicate).

Under `isWorkspace && hasHierarchy` those fall to the `LEVELS` branch — `LEVEL 2 — MAIN`, which **is
the PDF §11 screenshot** and the screen item 11b exists to delete.

**So:** workspace ⇒ always the tree. A flat workspace renders as N root-level neutral rows with
nothing expandable, which is correct and is what removes the obsolete screen. `hasHierarchy` then
only governs whether anything is expandable. Agencies (`!isWorkspace`) keep the `LEVELS` branch
untouched.

⚠️ **The gate needs an old-server fallback, spelled the same way in §3.2 and §3.3.** The value is the
server-authoritative `workspace_tenant`, but neither section said what happens when the field is
**absent**. `ManageChannelsScreen` already solves the identical problem as `serverTenant ?? userTenant`,
and its docblock records the safety property: the server answer can only narrow true→false, which is
the direction that protects the agency.

**But the fallback DIRECTION matters and `?? userTenant` picks the unsafe one.** §3.2's whole point
is that the user-level flag is wrong for the dual persona (edge A3) — and `??` re-admits it in the
two states where the server value is absent: the first render before `listChannels` resolves, and an
old server. In both, an agency manager who also joined a workspace would get the workspace tree on
their **agency**.

**So: while `serverTenant` is `undefined`, render the existing loading state — neither branch.** On a
genuinely old server that never sends the field, fall back to `LEVELS` (the branch that changes
nothing), not to the tree. One expression, spelled the same way in §3.2 and §3.3.

⚠️ **A flat workspace draws from THREE buckets, and the order must be stated.** `chats` (parentless
childless leaves, which `collapseChildless: true` keeps out of `organisations`), `otherChannels`, and
the unlabelled `announcements` rows from §2.4. Render order: `chats` → `otherChannels` →
`announcements`, and the §2.7 uniqueness fixture must cover this shape. Note the admin side sees the
_same_ workspace differently (`collapseChildless: false` promotes those leaves to organisations with
tier pills) — that is intended, and is why §2.7 makes the option explicit.

⚠️ **Old server (no `parent_hidden`):** parentless rows route to `orphanUnderSyntheticRoot` and land
in `otherChannels`, so they render as flat neutral rows with **no tier pills** — correct, since
there is no tier to claim. Stated because Rev 1's E4 covered it and the gate change made E4 stale.

⚠️ **`ChannelTree.tsx` must be added to `channelHierarchyGrouping.test.ts`'s closed six-file scan
list.** That file pins `levelOf`, the `c.level`-outside-the-helper ban, `member_count`,
`iconForType`, and that the first `channelStateMeta({` carries `post_mode:`. Move the code without
moving the file into the list and **every one of those guards silently retires** while the remaining
assertions go red "for the right reason" and get updated. Textbook vacuous pin.

⚠️ **`organisationTreeSingleSource.test.ts` bans** `parent_hidden` branching and
`filter(...visible_ancestor_id...)` across all of `src/screens` except `organisationTree.ts`.
`ChannelTree` must call `needsHiddenRung`, never read the raw field.

⚠️ **Error handling is a bug to fix, not preserve.** Rev 1 said "preserve the error-strip-over-rows
rule" — `DepartmentChannelsScreen` has no such rule: it is takeover-always and its catch **blanks the
list first**, so a focus-refetch blip wipes the directory. Adopt `ManageChannelsScreen`'s
strip-over-rows pattern instead.

⚠️ **Payload ceiling — REQUIRED, not an open question.** The server pages at 500 with a
`next_cursor` the client **discards**. Laterals multiply row count _by design_ (a 200-node org × 3
laterals = 800 rows), so shipping item 04 without this is a silent branch-loss: whole subtrees
vanish with no error. **Consume `next_cursor`** in `departmentApi.listChannels` and loop until null.
Rev 2 parked this in §9; it is a shipping blocker.

⚠️ **Org switch does not refetch.** `load`'s deps are `[entitled]` and the workspace scope is read
non-reactively at call time. The B-95 remount only covers a switch made _from the Hub_. Add the
active org id to the dep list.

⚠️ **Two orgs, no context.** `scopeChannelsToActiveWorkspace` is fail-open and the context is set only
by a Hub tile, so a drawer/CPO/notification entry can render **two** organisation roots under one
workspace header. Render one header per root in that case.

### 3.4 — Item 04 · lateral channels

DB: `is_lateral` column + trigger (§4.1). Server: `lateral?: boolean` on `CreateChannelDto`, the
three refusals, the agency gate (D-4), the `parent.level >= 3` skip for laterals, and `is_lateral` in
both projections. Client: the two admin affordances, the `is_lateral`-observed gate (D-6), the
"Announcements" access option for laterals (D-5).

⚠️ `+ Add lateral channel` on a **restricted root** hits `restricted_root_cannot_take_children` —
already in the editor's copy map, but the affordance must be hidden or the copy surfaced.
⚠️ `ManageChannelsScreen`'s `treeOrder` is a **second** tree walk indenting by `parent_id` alone; a
lateral would be drawn one step deeper — the opposite of the founder's rule. It must consult
`is_lateral`.
⚠️ `ORDER BY c.level ASC` no longer guarantees "a parent precedes its children" (a lateral shares its
parent's level, tie-broken by `created_at DESC`). The comment asserting that invariant must be
corrected; the client's stranded-row path already absorbs it.

### 3.5 — Item 05 · Delete on the Edit Channel screen

Destructive row under `Archive channel`, gated on `editing.deletable` (already plumbed). Honest copy
when not deletable, naming **archived** children too (D-3). Archive stays — the PDF says Delete must
not replace it. The existing `ChannelMembers` door stays.

### 3.6 — Item 07 · five-tab bar

⚠️ **The order pin is in a file Rev 1 never named.** `departmentalNavigator.test.ts` asserts
`expect(tabs).toEqual(['Home','Channels','Attend','Incident','Vault'])` — exact, ordered. Its regex
requires a **single space** after `<Tab.Screen`, which is why the multi-line `Messenger` declaration
is already invisible to it. **Declaring `News` multi-line would leave this green while the order is
wrong** — so declare it single-line and update the expectation.

⚠️ **News IS mounted in-shell** — Rev 2 flipped to a `tabPress` exit and that was wrong.

The exit does not work: `Departmental` is mounted in **three** shells (`MessengerNavigator`,
`AgentNavigator`, `CpoNavigator`) but `NewsHub` is registered in **MessengerNavigator only**.
`messengerDeepLink`'s agency arm ends `return {name: 'MessengerHome'}`, so an agency user tapping
News lands on the **chat list**; the CPO shell has no `NewsHub` either. That is precisely the B-414
class the resolver exists to prevent, recreated. And the PDF calls these five _"persistent"_
destinations — an exit is not persistent.

**The duplicate-registration objection is void:** `VaultScreen`, `VaultLock`, `FileVaultPurchase`,
`MessengerSettings` and `BackupSetup` are **already registered in both `MessengerNavigator` and
`DepartmentalNavigator`'s Vault tab**, with `Departmental` mounted inside `MessengerNavigator`.
Duplicate route names in one ancestor chain are the established, shipped pattern in this exact
navigator; inner-first resolution is what makes it work.

**Decision: mount `NewsNavigator` as a real tab.** Works identically in all three host shells, no
resolver dependency.

⚠️ **`freezeOnBlur` is NOT the mitigation — Rev 3 said it was, and that is wrong.** It is
`react-freeze`: it suspends **re-rendering** of a blurred subtree. It does not unmount, so **no
`useEffect` cleanup runs**. Verified against `IntelFeedScreen`:

- the clock `setInterval(…, 1000)` has `[]` deps and `clearInterval` **on unmount only** — the
  callback keeps firing on the JS thread every second; only the render is suppressed;
- `Animated.loop(…, {duration: 60000, useNativeDriver: true})` stops **on unmount only**, and a
  native-driver animation runs on the UI thread, outside React's control entirely;
- the Leaflet `WebView` is _deliberately_ kept resident — _"once the map tab has been visited we keep
  the WebView mounted (hidden) so tab switches don't re-boot Leaflet + refetch the CDN basemap."_

Today those costs are bounded by the **navigator type**, not by any freeze: News lives on a native
stack, so popping back **unmounts** it and all three cleanups run. As a tab it mounts on first focus
and is never unmounted — all three would run for the whole workspace session, against CLAUDE.md's
open JS-thread lag investigation.

**Use `options={{unmountOnBlur: true}}` on the News tab**, which restores exactly today's semantics
(mount on focus, unmount on blur, cleanups run). It is a new pattern in this repo, so state the
reason in the code. Cost: Leaflet re-boots per tab visit — acceptable, and `mapVisited`'s comment is
about the screen's _internal_ tab switches, which it still covers. (The surgical alternative —
focus-gating the three offenders with `useIsFocused()` — is better long-term but touches a screen
outside this scope.)

Also: bottom-tabs `lazy` defaults to **true**, so News is not mounted at all until first tapped —
the single largest mitigation. State it so nobody sets `lazy: false` for perceived snappiness.

Two more, both re-opened by moving News in-shell (Rev 2 closed them as "moot" when News was an exit,
and Rev 3 flipping back did not restore them):

- **`NewsHubScreen`'s unconditional back chevron** (`goBackOnce(navigation)`) becomes a tab root with
  nothing to pop, so it bubbles a `GO_BACK` to the tab router. Same `canGoBack()` gate as the
  Channels chevron — the identical defect one line away in the same section.
- **`FULLSCREEN_ROUTES` contains no News route**, so the tab bar draws over them, and the News
  screens use raw `useSafeAreaInsets()` rather than the `useReportBottomTabBar` contract that exists
  to prevent the double inset. `NewsHub`'s 120 dp pad may absorb it; `NewsFeed` / `NewsArticle` /
  `IntelFeed` are unverified → §7.3 item 13.

✅ **Route-enumeration check: DONE, clean.** Every navigate under `src/screens/news/` targets a route
inside `NewsNavigator` (`NewsHub` → `NewsPreferences` / `NewsFeed` / `IntelFeed`; `NewsFeed` →
`NewsPreferences`); everything else is `goBackOnce`. **No News screen navigates to a root-shell-only
route**, so in-shell mounting is safe in all three host shells. Worth knowing anyway:
`NewsHubScreen` types itself against `MessengerStackParamList`, so typecheck would _not_ have caught
a violation — re-run this grep if the News screens change.

Loose end, out of scope: `NewsAdsScreen.tsx` has **zero references anywhere** in `src/` — it is
registered by no navigator. Dead code; flagged, not removed by this pass.

⚠️ `unmountOnBlur` is a React Navigation **v6** bottom-tabs option and is **removed in v7**. Leave a
comment at the call site so an upgrade re-homes it rather than silently dropping it.

Also: add the `News` key to `TAB_ICONS` (missing → `help-circle-outline` + raw route name).
**Do NOT add `News` to `TAB_LEAVES`** — Rev 2 said to, wrongly. That allowlist exempts leaves that
are _nested into_; `Messenger` is deliberately absent for the same reason, and the file's docblock
warns _"an allowlist without one becomes a place to silence the test"_.

⚠️ 5 labels at 320 dp = **(320 − 16)/5 = 60.8 dp** (the row has `paddingHorizontal: 8`), with
`fontSize 10` uppercase, `letterSpacing 0.4`, `numberOfLines={1}` and **no** `flexShrink` or
`adjustsFontSizeToFit`. "MESSENGER" and "CHANNELS" will ellipsize at fontScale 1.3 —
**deterministically, not "needs a device"**. Shorten to `MSGR`/`CHANS`, or add
`adjustsFontSizeToFit` + `minimumFontScale`. Decided in §9 **Q2**.

⚠️ Making Channels a visible tab turns `DepartmentChannelsScreen`'s unconditional back chevron into
"leave the workspace". It renders its own header, not `ObHeader`, so it is **outside** the BB-7
double-tap guard. Gate it on `canGoBack()`.

### 3.7 — _(item 08 deferred — see §10)_

### 3.8 — Item 09 · Incident Reporting opens on the report screen

⚠️ **Rev 1's mechanism does not work.** Two reasons:

1. **`initialRouteName` only decides the COLD root.** The Incident stack is a persistent tab stack;
   `nestedNavigationInitialFlag.test.ts` already records this ("Done deliberately leaves that stack
   on My Reports and a bare navigate would re-enter there"). Second and later visits land wherever
   the stack was left.
2. **Rev 1 then re-pointed the manager's Home card at `IncidentQueue`** — i.e. the primary manager
   door still opens the screen the founder asked to stop seeing.

**Revised:** the Incident **entry action** resets the stack to `ReportIncidentCategory` (an explicit
navigate with `initial: false` to the report screen from every Home/quick-link door), the tab root
becomes `ReportIncidentCategory` for both roles, and the manager reaches the queue from a
**"Review incidents"** row on the report screen — not from the primary card.

⚠️ **Push/bell back-target regression, and Rev 2's remedy was not expressible.**
`messengerDeepLink` builds `{screen:'Incident', params:{screen: target, initial:false}}`. A
`{screen, initial:false}` payload can only seed `[initialRouteName, target]` — so "seed
`IncidentQueue` explicitly" cannot be written that way; the naive edit navigates to the queue and
**drops the deep link**. Today a manager's `IncidentDetail` tap has the queue underneath; after the
root change, back lands on the report grid.

**Mechanism:** for the `IncidentDetail` lane only, emit a nested **`state`** payload seeding
`[IncidentQueue, IncidentDetail]` instead of `{screen, initial:false}`. It must be pinned, because
`nestedNavigationInitialFlag.test.ts` reasons about the `initial` flag and a `state` payload is a
different shape. On a **warm** stack seeding is inert either way — accepted and stated.
Two producers: `fcmBootstrap`, `ActivityCenterScreen`.

⚠️ Breaks `departmentalNavigator.test.ts` (×2 assertions) and `enterpriseOnboarding.test.ts` — Rev 1
named `navigatorConfig.test.ts` and `deptChannelNotifRoute.test.ts`, **neither of which mentions
Incident at all**.

⚠️ PDF checklist line 13 says the queue is "removed"; the body says "removed from the **active user
flow**". We keep it reachable. **Stated deviation**, not silent.

### 3.9 — Item 10 · Bravo Contacts in Add Member

⚠️ **Rev 1 cited the wrong precedent.** `InviteMemberScreen` — in this same deptchat shell — already
ships this exact picker (`useDiscoveredContacts` with `enabled: pickerOpen`, `filterContacts`,
`pickRow → setPhone(m.phoneE164)`, a Modal at the bottom of the file). **Extract and reuse it**;
building from `NewChatScreen` would create a second deptchat copy.

⚠️ **The picker can dead-end on its own matches.** `addEmployee` resolves
`LOWER(email) = LOWER($1) OR phone_e164 = $1` — an **exact string** match, with **no user-id lane**.
A re-derived E.164 that differs by formatting 404s `user_not_found` for a contact the picker just
proved is a Bravo user (the B-154 double-prefix class). Either pass the `userId` (server change) or
pass through the same normalizer the discovery used.

⚠️ Four refusal paths the picker will hit routinely and Rev 1 tested none of:
`provider_account_cannot_be_employee`, `already_a_member`, `cannot_enroll_yourself`,
`member_exists_use_roster_status`.

⚠️ `DiscoveredRow` carries **no email**, so an email-only contact is unreachable by this lane — but
PDF method (2) already works via the existing field. Say so rather than implying a gap.

### 3.10 — Item 11a · back navigation

⚠️ **Rev 1's `backBehavior="history"` is rejected.** `ObHeader` wires a bare `onBack` on ~26 deptchat
screens with only a 600 ms double-tap guard, and an unhandled `GO_BACK` **bubbles to the parent
navigator**. Under `firstRoute` the tab router absorbs it to Home; under `history` it pops tab-focus
history and then **ejects the user out of the workspace entirely** — reachable from inside any of
those 26 screens. It also makes leaving take up to 5 presses instead of a deterministic 2.

**Revised approach: measure first, then fix the specific path.** §7.3 reproduces the founder's exact
route before any `backBehavior` change. The likely correct fix is narrower — the entry that pushes
the Departmental shell over the standalone Channels screen — not a global router-behaviour flip.

### 3.11 — Item 12 · header clipping

Load-bearing: `flex: 1, minWidth: 0` on `headerLeft`; `flex: 1, minWidth: 0` on the title column;
`numberOfLines={1}` on `headerTitle`.

⚠️ Rev 1 listed two **no-ops**: Yoga already defaults `flexShrink` to 0, so adding it to
`headerActions`/`iconPill` changes nothing — and asserting them would pin a placebo.
⚠️ `numberOfLines` is a **JSX prop**, invisible to a style-shape assertion.
⚠️ Both header branches share the same style objects — one edit, not two.
⚠️ Neither Rev 1 nor the fix accounts for `insets.right`.
⚠️ **Diagnose on device before editing** (§7.3): the plan's flex reading is consistent but unproven
against the actual screenshot.

---

## 4. Database & backend

### 4.1 — `20260816000000_dept_channel_lateral.sql`

⚠️ **14-digit filename** — Rev 1 used 13. Every one of the 138 existing migrations is 14, and the
migration spec orders by string comparison.

Contents: the `is_lateral` column, the replaced `dept_channel_set_level()` (existing body verbatim
plus D-2's three rules and the `+ CASE WHEN NEW.is_lateral THEN 0 ELSE 1 END` derivation), a partial
index, and `SET search_path` (none of the three `dept_channel_*` functions is covered by the
search-path hardening migration).

**Everything else stays byte-identical**: root bound, both cross-org guards, re-parent block,
`ON DELETE RESTRICT`, `level BETWEEN 0 AND 3`.

Obligations:

- add the filename to `ALLOWED_REPLACEMENTS` in `department.hierarchyMigration.spec.ts` **and**
  re-assert every invariant against the new body. Adding the filename alone is the failure mode that
  spec's comment warns about.
- ⚠️ **and deal with the OLD body's twelve assertions.** That spec reads
  `MIGRATION = 20260803010000_…` and pins the derivation, the root bound, both cross-org guards, the
  re-parent block, the level freeze and the DROP-before-CREATE ordering **against a function body
  that will no longer exist in the database**. Left alone, all twelve stay green while describing
  dead SQL — and a later edit to the _new_ file that drops the cross-org check would leave every one
  of them passing. This is precisely the repo's own "security suites had pinned DEAD code" incident.
  **Re-point `MIGRATION` at the newest replacement** (keeping `THIS_MIGRATION` as the separate
  ban-scan anchor), or mark the old `describe` block "superseded body — historical" and mirror it in
  full against the new file.
  ⚠️ Note the failure mode precisely: those assertions do **not** go red. `THIS_MIGRATION` pins the
  old filename and `sql()` reads only that file, so they stay **green against a body the database no
  longer runs**. Nothing will tell you if this step is skipped — which is what makes it load-bearing
  rather than housekeeping.
- **write the down migration.** Reverting to `parent + 1` bricks every lateral: the trigger
  re-derives on **every** UPDATE of a parented row, so a lateral under a level-3 parent computes 4,
  the CHECK rejects it, and the row becomes permanently un-renamable/un-archivable/un-provisionable —
  exactly the state the original migration added a self-healing UPDATE to prevent. The revert needs
  the mirror UPDATE.

### 4.2 — ⚠️ The integration harness DOES NOT RUN. Verify against staging instead.

**Rev 3 said the trigger's behaviour was "executable" in `test/integration/` and that leaving it to
a source scan was negligent "with a working DB sitting in the repo". That is FALSE, and it was my
error for accepting a reviewer's claim without checking it.**

Verified: `@testcontainers/postgresql` is **neither a dependency of `apps/auth-service/package.json`
nor installed**. So `bootIntegrationDb()` throws on its dynamic `require`, sets `bootError`,
`shouldSkipIntegration()` returns true, and **every `describeIfDb` in the project collapses to
`describe.skip`**. `channelTree.itest.ts` says so in its own header — _"THIS FILE HAS NEVER
EXECUTED"_ — and names a second blocker too (`20260416000000` references an `auth` schema nothing
creates).

Consequences, all of them:

- **Do not add lateral tests there.** They would never run, and would read as coverage — the exact
  "a mock that lies" class this repo has been burned by.
- **`npm run test:integration` is NOT a gate** (removed from §7.1). It passes by skipping.
- **R3-9 is moot**: the harness cannot replay the purge migration, because it never boots. The
  relative row-count assertion stays anyway — it is correct on its own merits and costs nothing.
- **The trigger's only real verification is the staging database.** Apply
  `20260816000000` to staging and run the verification queries in its own footer (every lateral
  shares its parent's level; no row has a lateral parent), plus the deepest-legal-chain probe that
  D-1's 4-hop bound depends on. That is §7.3 item 6, and it is now load-bearing rather than
  confirmatory.

Making the harness real (add the dependency, stub the `auth` schema) is worth doing and is **out of
scope here** — it is its own piece of work, and doing it badly under this diff would produce exactly
the false confidence the paragraph above describes.

### 4.3 — `20260817000000_purge_legacy_workspace_broadcasts.sql` (founder decision F2)

**This migration aborts rather than proceeds on any hazard.** Pre-flight, in one transaction:

**Transaction shape — exactly one mechanism, not two.** The file opens `\set ON_ERROR_STOP on`,
then an explicit `BEGIN; … COMMIT;`, and is applied with a **plain `psql -f`**.

⚠️ **Do NOT also pass `--single-transaction`.** It wraps the file in psql's own BEGIN/COMMIT, so the
explicit `COMMIT;` inside would **end psql's outer transaction early** and everything after it would
run auto-committed — re-opening the exact partial-apply hazard this shape exists to close, in a file
that looks protected. `ON_ERROR_STOP` is not optional either: without it psql plows past a failed
guard and the guards stop being guards.

**Target rows are taken `FOR UPDATE` before the guards run**, which closes the rekey-intent TOCTOU.
The two reviewers disagreed here and the disagreement is resolved in favour of "it works":
`removeMember` inserts into `channel_membership_intents`, whose `channel_id` is an FK to
`department_channels`, and since PostgreSQL 9.3 an FK check acquires **`FOR KEY SHARE`** on the
referenced parent row. `FOR KEY SHARE` **conflicts with `FOR UPDATE`**, so the concurrent insert
blocks until the migration commits. Recorded because "the lock is a placebo" is a plausible-sounding
claim that would otherwise be re-raised.

**The row-count assertion must be RELATIVE** (`deleted = the number of targets this run counted`),
never a hardcoded snapshot number. `test/integration/harness.ts` replays the whole migrations
directory, so this file executes on **every** `npm run test:integration` — with zero targets, which
must pass, not abort.

| Guard                                                                | Scope — **live state only**                              | Why                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending rekey intent                                                 | `state = 'pending'`                                      | `channel_membership_intents.channel_id` is `ON DELETE CASCADE`; that migration's header: _"without the rekey a removed CPO keeps the master key and can decrypt <=30d relay dwell"_. A **CLAUDE.md stop-condition**.                                  |
| Bound invite                                                         | `accepted_at IS NULL AND expires_at > NOW()`             | Both `team_channel_id` FKs are `ON DELETE SET NULL`, and `resolveSeedScopeInTx` returns `{kind:'orgWide'}` when channel **and** parent are null — a parentless broadcast has both, so a pending **team invite escalates to a whole-workspace grant**. |
| Bound join request                                                   | `status = 'pending'`                                     | Same FK, same escalation.                                                                                                                                                                                                                             |
| Any child                                                            | all, archived included                                   | The self-FK is `ON DELETE RESTRICT`. Rev 1 inferred safety from a **service-level** guard; there is no DB constraint, so one legacy row aborts the DELETE with an opaque 23503.                                                                       |
| `archived_at IS NULL`                                                | —                                                        | An intentionally-archived (recoverable) broadcast must not be destroyed.                                                                                                                                                                              |
| Target org has a live announcement channel                           | **`RAISE NOTICE` only — NOT an abort**                   | See the warning below.                                                                                                                                                                                                                                |
| Deleted row count matches **the count of targets this run selected** | relative, never a hardcoded number                       | A migration that can no-op silently is this repo's `ensureBroadcastForLevel` bug class — but `harness.ts` replays this file on every integration run with zero targets, which must pass.                                                              |
| Workspace tenant only                                                | `EXISTS (org_workspaces WHERE owner_user_id = c.org_id)` | The canonical discriminator — matches the service, the delete trigger and `20260808050000`.                                                                                                                                                           |

⚠️ **Scoping to live state is not cosmetic.** Unscoped, the first two guards abort on state nobody
can clear: a `#broadcast` seeds **every** active org member, so every member removal ever performed
left an intent on it, and intents drain only via an admin _device_ — a reinstalled admin device
leaves them `pending` forever with no UI to clear them. Likewise expired/declined invites hold the
FK indefinitely. Unscoped guards would abort on every workspace and the cleanup would never ship.

⚠️ **The announcement-channel check must NOT abort — Rev 3 had it as one, and that never converges.**
It conflates two different assertions: §8 gate 4 is a **capability** check ("this build can create an
announcement lateral"); a per-org `NOT EXISTS` is a **data** check ("this org has already created
one"). On day 1 no org has, because the feature is new — so it would abort for **every** workspace,
and §8's "step 7 ships only when zero orgs aborted" would mean step 7 never ships.

There is also a shape where it is permanently unsatisfiable: D-5's option is laterals-only, a lateral
needs a parent, and `createChannel` refuses a child of a restricted root
(`restricted_root_cannot_take_children`). A legacy workspace whose channels are all **restricted
parentless roots** could never create one. (`restricted_root_not_allowed` only blocks _new_ restricted
roots; legacy ones exist.)

So it is a **`RAISE NOTICE` per-org report** — "these orgs will have no announcement channel after
the purge" — and the founder decides whether to chase them. F2 was "delete the legacy broadcasts",
not "require a replacement first".

**Every abort prints a remediation lane**, not just a refusal — which org, which channel, which
guard, and what to do. An abort with no exit is a cleanup that never happens.

Run **off-peak**.

**Cohort note, deliberate not accidental:** `20260805010000` manufactured `org_workspaces` rows for
Enterprise individuals who owned channels. They satisfy the predicate and their `#broadcast` will be
deleted. That is correct — they _are_ single-tenant workspaces — but it is stated so it is not
discovered later.

**Also amend `20260805000000`'s `missing` CTE** with the `NOT EXISTS (org_workspaces)` clause its own
header already prescribes. A DO-NOT-RE-RUN comment in a different file is not a guard.

**Device residue (not fixable in SQL, must be stated):** `deptGroupByChannel` / `deptConversationIds`
are persisted and never pruned, and drive push routing and mute lookup. A ghost pointer survives on
devices indefinitely.

### 4.4 — Compat matrix (both directions)

| Client | Server | Read                                                                | **Write**                                                                                                                                                                                                                                |
| ------ | ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new    | old    | `is_lateral` undefined → all rows structural. Safe.                 | ⚠️ **`lateral` silently stripped in prod → permanently-wrong row.** Primary mitigation is D-6's **server echo** on create (the only part that survives a rolling deploy); the client presence gate is the affordance, not the guarantee. |
| old    | new    | Laterals render as ordinary children — wrong tier, still reachable. | No lateral sent. Safe.                                                                                                                                                                                                                   |

---

## 5. Edge cases

Rev 1's E1–E46 stand except where corrected below. New cases from the adversarial pass are folded
into §2–§4 where they change the design; the residue is here.

**Corrected from Rev 1:**

| E#  | Correction                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------- |
| E4  | **Superseded by §3.3.** The member gate is now `isWorkspace` alone (`serverTenant ?? userTenant`); `hasHierarchy` governs only expandability; the admin screen keeps `serverKnowsHierarchy                                                                                                                    |     | channels.length === 0`. Old server → flat neutral rows, no tier pills. |
| E9  | Not "in principle" — walk depth 5 is the **ordinary** case with laterals. See D-1.                                                                                                                                                                                                                            |
| E13 | Add: an **active child under an archived parent** is reachable (create-lateral / archive-parent interleave). Also `ManageChannelsScreen`'s ARCHIVED section is gated `!orgId && !loadError`, so any load error hides it entirely.                                                                             |
| E19 | The freeze **coerces silently**, it does not refuse. D-2.                                                                                                                                                                                                                                                     |
| E20 | ⚠️ **Rev 2 inverted this and Rev 3 reverted it — the answer is Rev 1's.** Laterals **COUNT** in `activeChildCount`; archive **refuses** (`channel_has_active_sub_channels`); the admin archives the lateral first, then the parent. **No cascade** — see D-3 and §11. Zero server change on the archive path. |
| E23 | Under D-4 there is no `is_broadcast` lateral on a workspace, so _that_ ambiguity disappears — but D-5 creates **announcement** laterals, which stay pickable as an invite team until D-5 item 4 lands. The two must ship together. Agencies unchanged.                                                        |
| E26 | Understated: the device-side pointers are persisted and never pruned, and drive push routing + mute lookup. Add the rekey-intent and invite-escalation hazards.                                                                                                                                               |
| E28 | "Impossible" is true only for company **agents**; `20260805010000` created a different cohort. §4.3.                                                                                                                                                                                                          |
| E29 | **Superseded.** With the `placeRow` change reverted (§2.4), _all_ broadcasts — parented and parentless — stay in the `announcements` bucket. On a workspace they render as unlabelled root rows; on an agency, unchanged. No door lost either way.                                                            |
| E32 | Arithmetic, not a device question: 60.8 dp per tab, deterministic ellipsis at fontScale 1.3. §3.6.                                                                                                                                                                                                            |
| E42 | Only true when the switch comes from a Hub tile; every other entry leaves the context null and nothing remounts. §3.3.                                                                                                                                                                                        |
| E44 | There is no strip rule on this screen to preserve — it is takeover-always and blanks the list. Adopt the Manage pattern. §3.3.                                                                                                                                                                                |
| E46 | Two different indent bases exist. Decision: `12 + depth * 16`. §2.9.                                                                                                                                                                                                                                          |

**New, still open:** the broadcast glyph already disagrees across three screens (`#` vs
`bullhorn-variant-outline`) — the single renderer must pick one. `UnreadPill`'s root node is pinned
to `LinearGradient` by its test, so rows must render it directly, not wrapped.

---

## 6. Regression risk register

R1–R10 from Rev 1 stand, with three additions:

| Risk                                                                  | Pin                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **R11** A source-scan guard silently retires when code moves file     | Add `ChannelTree.tsx` to `channelHierarchyGrouping.test.ts`'s scan list **in the same commit** that creates it. |
| **R12** A security invariant is destroyed by a data migration         | §4.3's abort-on-hazard pre-flight. Rekey intents and invite scope are CLAUDE.md stop-conditions.                |
| **R13** Prod and staging fail differently, so staging cannot catch it | D-6's **server echo** on `createChannel` (primary — survives a rolling deploy), plus the client presence gate.  |

---

## 7. Gates

### 7.1 — Automated

```bash
npx jest --selectProjects messenger-crypto                       # TWICE (B-126 flake rule)
npx jest --selectProjects app --testPathPattern "screens/messenger"
npx jest --selectProjects app --testPathPattern "screens/deptchat"
npx jest --selectProjects app --testPathPattern "navigation"
npx jest --selectProjects app --testPathPattern "sourceScanSafety"
npm test                                                          # change-safety rule 4
npm run deadcode                                                  # hasSubtree/DrillInRow go dead
cd apps/auth-service && npm test -- department
# NOT `npm run test:integration` — the harness cannot boot (§4.2); it passes by
# skipping every suite, so listing it as a gate would be a lie.
npm run typecheck && npm run lint
```

**Baseline captured at `main@f4842c7393e3`, all green:** deptchat 33 suites/610 · navigation 22/274 ·
messenger screens 36/446 (4 skipped) · auth-service department 11/308 · **typecheck 45 errors**
(ceiling 47, ratchet down-only).

### 7.2 — Bug-regression contract

Every fix lands with a test that was **RED first** (mutation-proved by reverting the fix), under a
normal name. `DOCUMENTS B-NNN` is reserved for bugs we are **not** fixing. Assign B-numbers and
append all 11 items to `sqa.md` (Rev 1 omitted both).

### 7.3 — Device pass — **three items run BEFORE their fix**

1. **Item 11a repro first.** Reproduce the founder's exact path and capture where back lands, before
   any change. Then the exit-path matrix: {hardware back, `ObHeader` chevron} × {each tab} ×
   {entered from MessengerHome / AgentDashboard / CpoTabs / cold `navigate('Departmental')` / Hub}.
2. **Item 12 diagnose first** — confirm the clipping is flex overflow and not a safe-area problem.
3. **Purge verified by row count**, before and after, under the real deploy role — not "the section
   is gone" (an old client hides an empty section anyway).
4. Tree at 320 dp and fontScale 1.3, all four tiers, plus a colour-blind simulation.
5. Five tab labels at 320 dp / fontScale 1.3.
6. Lateral at the deepest tier on the migrated staging DB, viewed by a member who is in the lateral
   and the root but **not** the middle (the D-1 case).
7. Manager incident push landing, cold **and** warm, plus its back target.
8. Delete from the Edit Channel screen, including the refusal copy on a parent with children.
9. Add a member from Bravo Contacts, including at least two refusal paths.
10. Tree mount cost at 200+ rows via `dumpsys gfxinfo` (CLAUDE.md lag protocol).
11. **Archive → unarchive round-trip** on a level node with laterals. D-3 is reverted so archive must
    _refuse_ until the laterals are archived first — verify it refuses, and that unarchive restores.
12. **A FLAT workspace** — parentless level-1 channels, no hierarchy — and a workspace with one
    organisation and no children. This is the most common shape and the PDF §11 screenshot; every
    other item assumes a built tree.
13. **News from each of the three host shells** (Messenger, Agent, CPO), including back behaviour.
14. **An announcement lateral end-to-end**: a viewer cannot post/react/reply, the badge is amber not
    grey, it survives a rename without demoting, and it does **not** appear in the invite team picker.
15. **An agency regression pass** — Channels and Manage Channels on an agency org, unchanged.
16. **The dual persona (A3)** — agency manager who also joined a workspace, on _both_ orgs: the
    ANNOUNCEMENTS section, the tree-vs-LEVELS branch, and the editor's lateral affordances.
17. **Post-purge device residue** — with a stale `deptGroupByChannel` pointer, does a push still
    route to the deleted channel, and does a ghost row appear?
18. **A down-migration rehearsal** on staging (§4.1 requires one; its failure mode is bricked rows).
19. **The `Channels` tab back chevron** after the `canGoBack()` gate, from all five entry paths.
20. **Item 01** — empty `full_name`, a 40-character name, and a user in zero workspaces.

---

## 8. Rollout order

> ### ⚠️ MIGRATION FIRST. Rev 1 and Rev 2 both had this backwards, and it is an outage.
>
> Both earlier revisions shipped auth-service before the `is_lateral` migration. But the service
> **`SELECT`s `c.is_lateral`** in `listChannels` _and_ `listOrgChannels` — against a table without
> the column that is **`42703 undefined_column`, i.e. a 500 on every call**: the member directory,
> Manage Channels, the home dashboard, the vault shelf, the ops departments table, the invite
> picker, and `createChannel`. The whole Department Channels module, down, in staging **and** prod.
>
> Rev 1 even wrote the correct analysis and drew the wrong conclusion, calling migration-first
> "harmless". It is better than harmless — it is **provably a no-op**: every row defaults
> `is_lateral = FALSE`, so `parent_level + CASE WHEN FALSE THEN 0 ELSE 1 END ≡ parent_level + 1`,
> the old service never writes the column, and neither new refusal can fire.
>
> The confusion was conflating two different orderings: the **DTO** concern (client vs server) is
> genuinely server-first; the **column** concern (service vs DB) is migration-first. They are not
> the same axis.

**Staging**

```
1. migration 20260816000000 (lateral) + integration tests               ← FIRST. Provably a no-op.
2. auth-service: is_lateral accept/project + echo on create,
   workspace_tenant on listChannels, the lateral refusals + agency gate,
   the announcement-mode server rules (D-5 items 3+4)
3. APK #1: items 01,03,04,05,06,07,09,10,11,12 + the D-5 editor fixes
   + the D-6 gate                                                        → device pass (§7.3)
4. GATE: a workspace can create an announcement lateral                  ← blocks step 5
5. SNAPSHOT + migration 20260817000000 (guarded purge; plain `psql -f`,
   ON_ERROR_STOP + explicit BEGIN/COMMIT — NOT --single-transaction, see §4.3)
6. GATE: purge row count matches the snapshot                            ← blocks step 7
7. APK #2: remove ManageChannelsScreen's stage-1 ANNOUNCEMENTS block
```

**Production — the same seven steps, in the same order, with the same two gates.** Rev 2 collapsed
production to "auth-service → migrations → APK", which ran the purge **before** the client that can
create its replacement — defeating gate 4 — and had only one APK when step 7 needs a second.

Gates 4 and 6 are **blocking**, not checkpoints. Gate 4 is a **capability** check ("this build can
create an announcement lateral") — it is deliberately _not_ a per-org data assertion; see §4.3 for
why that version deadlocks the rollout.

⚠️ **Item 07 ships in APK #1 with item 11a unfixed.** `backBehavior` stays `firstRoute` pending
measurement (§3.10), so back from any tab goes to Home — and with Channels, Vault and News newly
tappable that is a _more_ visible behaviour, not less. Stated deliberately: do not fix it blind;
§7.3 item 1 is the instrument.

**Aborted-purge branch.** If the purge aborts for an org, that org keeps its broadcasts — so step 7
must **not** ship for it. Because step 7 is a client change and cannot be per-org, the rule is:
**step 7 ships only when zero orgs aborted.** Otherwise remediate (drain the intent, expire the
invite, resolve the child) and re-run step 5. Without this, an aborted production purge leaves live
broadcast rows with **no admin door** — §2.4 records that the block being removed is their only one.

---

## 9. Open questions

| Q      | Question                                                                                                                                                                                                                                                          | Recommendation                                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q1** | PDF checklist line 1 says the workspace **heading** shows the user name. Body block, or the header title too?                                                                                                                                                     | Body block (a 40-char name clips in a 1-line header).                                                                                                                                                                                                                                            |
| **Q2** | Five tab labels ellipsize at 320 dp / fontScale 1.3. Shorten the labels, or auto-shrink the text?                                                                                                                                                                 | Auto-shrink (`adjustsFontSizeToFit` + `minimumFontScale`); keeps the founder's words.                                                                                                                                                                                                            |
| **Q3** | Legacy level-1-rooted workspaces can only represent **three** tiers (§2.1). Accept, or scope a re-level migration?                                                                                                                                                | Accept now; re-level is a separate, riskier migration.                                                                                                                                                                                                                                           |
| **Q4** | An announcement lateral can be edited back into an open chat; a `#broadcast` could not (D-5). Accept, or add a pin?                                                                                                                                               | Accept — admin-only action on an admin-created channel.                                                                                                                                                                                                                                          |
| **Q5** | `ManageChannelsScreen`'s `LEVEL_NOUN` shows a fixed Enterprise/Main/Sub/Sub-sub vocabulary that the new `Ln` pill contradicts on the same row (a legacy level-1 root renders pill "L1" beside subtitle "Main"). PDF checklist line 9 says admins name the levels. | Drop the noun from the subtitle; the pill already states the tier. **Enumerate its test consumers first** — `channelHierarchyGrouping` pins the `LEVEL_NOUN` accessibility strings, and `deptNoun` / `enterpriseTerminology` are in the same suite. Full admin-named levels are a later feature. |

---

## 10. Deferred / out of scope

**Item 08 — Emergency Calls in the Calls Log — DEFERRED by the founder (F4).** Findings preserved so
the next session does not re-derive them:

- Real `tel:` sites are **three**: `VBGEmergencyScreen`, `VBGHomeScreen`, and
  `NoDetailScreen` (unsanitised). `NextOfKinModal` is **not** a fourth — it funnels into
  `VBGHomeScreen.dial` by design.
- **VBG panic is disabled** (`VBG_PANIC_ENABLED = false`, founder 2026-08-01) — a recorder there is
  dead code.
- **SOS raises an alert; it places no call.** Logging it as "Emergency call placed" would be a false
  record in a security app's call log. SOS history already exists server-side and is surfaced by
  `ProtectionHistoryScreen`.
- `CallsLogScreen` rows are a live projection of the message store, and every field of `CallLog` is
  WebRTC-derived; both the row tap and the call button go through `launchCall({conversationId})`. An
  emergency row has no `conversationId`, so a merge needs a discriminated union and an explicit
  no-op tap — not "merge into the row list".
- That screen is on the **legacy palette** (`@theme/index`, hard-coded hexes) and imports nothing
  from `_obsidian`, so `OB.alert` is the wrong token. `CallsLog` is also not registered in the agency
  shell.

Also out of scope: persisted collapse state; re-parenting / moving channels; converting existing
leaves to laterals; agency-tenant laterals; ops-console parity (**verified unnecessary** — zero
references to `department_channels` or `listChannels`); `sqa.md` B-83.

---

## 11. Rejected findings (do not re-raise)

| Claim                                                                                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "RLS `FORCE` makes the purge silently delete 0 rows" (raised by **both** reviewers)                                  | **Rejected.** The RLS migration's own header states the backend connects as `postgres` with `rolbypassrls = true`, which bypasses RLS _regardless_ of `FORCE`; migrations run as that role. The row-count assertion is adopted anyway as cheap insurance.                                                                                                                                                                                                                                                        |
| "Prior plan already defined lateral channels, so reuse it"                                                           | **Rejected.** `BRAVO_CHANNELS_VS2_PLAN_2026-08-10.md:711` defines lateral as a _"create-with-same-parent shortcut, no new semantics"_ — a different concept, and grep proves it was **never built**. The mockups indent laterals _under_ their level with the parent's branch line.                                                                                                                                                                                                                              |
| "Mounting News in-shell duplicates five route names in one ancestor chain" (Rev 2's reason for switching to an exit) | **Rejected.** `VaultScreen`, `VaultLock`, `FileVaultPurchase`, `MessengerSettings` and `BackupSetup` are **already** registered in both `MessengerNavigator` and `DepartmentalNavigator`'s Vault tab, with `Departmental` mounted inside `MessengerNavigator`. It is the established shipped pattern here. The _substantive_ objection (timers + WebView running all session) is real and is fixed with **`unmountOnBlur`** — `freezeOnBlur`, which Rev 3 proposed, suspends rendering only and runs no cleanup. |
| "A lateral makes its parent permanently un-archivable" (Rev 2 D-3)                                                   | **Rejected.** A lateral is a leaf, so its own child count is 0 — the admin archives it, then the parent. Bottom-up is the documented design (_"REFUSE rather than cascade, deliberately"_). Rev 2's cascade remedy would have buried admin-named channels with no cascade-unarchive to recover them.                                                                                                                                                                                                             |
| "Add `News` to `TAB_LEAVES`" (Rev 2 §3.6)                                                                            | **Rejected.** That allowlist exempts leaves that are _nested into_; `Messenger` is deliberately absent for the same reason, and the file warns _"an allowlist without one becomes a place to silence the test"_.                                                                                                                                                                                                                                                                                                 |

---

## Revision log

| Rev | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-08-15 | First draft from the PDF + 14 source files, 4 migrations, 3 pinning specs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | 2026-08-15 | Founder decisions F1–F4 (item 08 deferred). Folded in both review passes: 7 blockers (D-1…D-6 + the tier/capability split), ~20 majors, 40 new edge cases. Rejected 2 findings with evidence (§11). News tab changed from in-shell to exit; `backBehavior` flip withdrawn pending measurement; item 09 mechanism rewritten; purge made abort-on-hazard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | 2026-08-15 | Round-3 review. **Four blockers fixed:** the "live announcement channel" purge guard downgraded from abort to `RAISE NOTICE` (as an abort it fired for every workspace on day 1 and deadlocked steps 5–7, and one legal data shape made it permanent); `buildChannelTree` gains an explicit `collapseChildless` parameter (wrapping `directoryBuckets` would have dead-ended the admin create flow — a failure the codebase documents by name); the purge's transaction shape fixed to `BEGIN;…COMMIT;` + `ON_ERROR_STOP` + plain `psql -f` (combining it with `--single-transaction` ends the outer transaction early and re-opens the partial-apply hazard); and §5 E20 rewritten, which still instructed the reverted cascade. `freezeOnBlur` replaced with `unmountOnBlur` (it suspends rendering only — no cleanup, no effect on a native-driver loop or a deliberately-resident WebView). Row-count assertion made relative for harness replay. `hierarchyMigration.spec` re-pointing added. Reviewer disagreement on `FOR UPDATE` resolved in favour of "it works" (FK insert takes `FOR KEY SHARE`, which conflicts). Six stale cross-references fixed. |
| 3   | 2026-08-15 | Round-2 review of both agents. **Deploy order fixed — Rev 1 and Rev 2 both shipped a service that `SELECT`s `is_lateral` before the migration adding it: a 500 on every channels call.** D-3 cascade **reverted** (premise false; remedy forbidden by the code). §2.4 `placeRow` change **reverted** (no live agency consumer; item 02 is now renderer-only). Tree gate corrected to `isWorkspace` alone (Rev 2's `!isWorkspace` stranded the flat workspace — the PDF §11 screen). News restored to in-shell with `freezeOnBlur` (the exit fails in 2 of 3 shells; the duplicate-name objection is void — Vault already does it). D-5 gained five required client/server fixes. D-6 gained a server-side echo. Purge guards scoped to live state, made transactional, `FOR UPDATE`, remediation lanes. 500-row cap promoted from question to blocker. 10 more device checks. 4 more rejected findings (§11).                                                                                                                                                                                                                                                   |

</content>
